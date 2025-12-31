import { proto } from '../../WAProto/index.js'
import { DEFAULT_CONNECTION_CONFIG } from '../Defaults'
import type { Label } from '../Types/Label'
import type { LabelAssociation } from '../Types/LabelAssociation'
import { LabelAssociationType } from '../Types/LabelAssociation'
import type { Chat, Contact, GroupMetadata, WAMessage } from '../Types'
import { md5, toNumber } from '../Utils'
import { jidDecode, jidNormalizedUser } from '../WABinary'
import makeOrderedDictionary, { type OrderedDictionary } from './make-ordered-dictionary'
import { ObjectRepository } from './object-repository'
import KeyedDB from '@adiwajshing/keyed-db'
import { existsSync, readFileSync, writeFileSync } from 'fs'

export const waChatKey = (pin: boolean) => ({
	key: (c: Chat) =>
		(pin ? (c.pinned ? '1' : '0') : '') +
		(c.archived ? '0' : '1') +
		(c.conversationTimestamp ? c.conversationTimestamp.toString(16).padStart(8, '0') : '') +
		c.id,
	compare: (k1: string, k2: string) => k2.localeCompare(k1)
})

export const waMessageID = (m: WAMessage) => m.key.id || ''

export const waLabelAssociationKey = {
	key: (la: LabelAssociation) =>
		la.type === LabelAssociationType.Chat ? la.chatId + la.labelId : la.chatId + la.messageId + la.labelId,
	compare: (k1: string, k2: string) => k2.localeCompare(k1)
}

const makeMessagesDictionary = () => makeOrderedDictionary<WAMessage>(waMessageID)

export type InMemoryStoreConfig = {
	socket?: {
		profilePictureUrl: (jid: string) => Promise<string | undefined>
		groupMetadata: (jid: string) => Promise<GroupMetadata>
	}
	chatKey?: ReturnType<typeof waChatKey>
	labelAssociationKey?: typeof waLabelAssociationKey
	logger?: typeof DEFAULT_CONNECTION_CONFIG.logger
}

export type InMemoryStore = ReturnType<typeof makeInMemoryStore>

export default function makeInMemoryStore(config: InMemoryStoreConfig = {}) {
	const socket = config.socket
	const chatKey = config.chatKey || waChatKey(true)
	const labelAssociationKey = config.labelAssociationKey || waLabelAssociationKey
	const logger = (config.logger || DEFAULT_CONNECTION_CONFIG.logger).child({ stream: 'in-mem-store' })

	const chats = new (KeyedDB as any)(chatKey, (c: Chat) => c.id) as {
		clear: () => void
		insertIfAbsent: (...items: Chat[]) => Chat[]
		upsert: (...items: Chat[]) => void
		update: (id: string, fn: (c: Chat) => void) => Chat | undefined
		get: (id: string) => Chat | undefined
		deleteById: (id: string) => void
		all: () => Chat[]
		toJSON: () => any
		fromJSON: (j: any) => void
	}

	const messages: Record<string, OrderedDictionary<WAMessage>> = {}
	const contacts: Record<string, Contact> = {}
	const groupMetadata: Record<string, GroupMetadata> = {}
	const presences: Record<string, any> = {}
	const state: Record<string, any> = { connection: 'close' }
	const labels = new ObjectRepository<Label>()
	const labelAssociations = new (KeyedDB as any)(labelAssociationKey, labelAssociationKey.key) as {
		upsert: (item: LabelAssociation) => void
		delete: (item: LabelAssociation) => void
		toJSON: () => any
		fromJSON: (j: any) => void
	}

	const assertMessageList = (jid: string) => {
		if (!messages[jid]) {
			messages[jid] = makeMessagesDictionary()
		}
		return messages[jid]!
	}

	const contactsUpsert = (newContacts: Contact[]) => {
		const oldContacts = new Set(Object.keys(contacts))
		for (const contact of newContacts) {
			oldContacts.delete(contact.id)
			contacts[contact.id] = Object.assign(contacts[contact.id] || {}, contact)
		}
		return oldContacts
	}

	const labelsUpsert = (newLabels: Label[]) => {
		for (const label of newLabels) {
			labels.upsertById(label.id, label)
		}
	}

	const getValidContacts = () => {
		for (const contact of Object.keys(contacts)) {
			if (contact.indexOf('@') < 0) {
				delete contacts[contact]
			}
		}
		return Object.keys(contacts)
	}

	const bind = (ev: any) => {
		ev.on('connection.update', (update: any) => {
			Object.assign(state, update)
		})

		ev.on('messaging-history.set', ({ chats: newChats, contacts: newContacts, messages: newMessages, isLatest, syncType }: any) => {
			if (syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) return

			if (isLatest) {
				chats.clear()
				for (const id in messages) delete messages[id]
			}

			const chatsAdded = chats.insertIfAbsent(...(newChats || [])).length
			logger.debug({ chatsAdded }, 'synced chats')

			const oldContacts = contactsUpsert(newContacts || [])
			if (isLatest) {
				for (const jid of oldContacts) delete contacts[jid]
			}
			logger.debug({ deletedContacts: isLatest ? oldContacts.size : 0 }, 'synced contacts')

			for (const msg of newMessages || []) {
				const jid = msg.key.remoteJid
				const list = assertMessageList(jid)
				list.upsert(msg, 'prepend')
			}
			logger.debug({ messages: (newMessages || []).length }, 'synced messages')
		})

		ev.on('contacts.upsert', (newContacts: Contact[]) => {
			contactsUpsert(newContacts || [])
		})

		ev.on('contacts.update', async (updates: any[]) => {
			for (const update of updates || []) {
				let contact: Contact | undefined = contacts[update.id]
				if (!contact) {
					const validContacts = getValidContacts()
					const contactHashes = validContacts.map((contactId) => {
						const { user } = jidDecode(contactId) || { user: '' }
						return [contactId, md5(Buffer.from(user + 'WA_ADD_NOTIF', 'utf8')).toString('base64').slice(0, 3)] as const
					})
					contact = contacts[(contactHashes.find(([, b]) => b === update.id)?.[0]) || '']
				}

				if (contact) {
					if (update.imgUrl === 'changed') {
						contact.imgUrl = socket ? await socket.profilePictureUrl(contact.id) : undefined
					} else if (update.imgUrl === 'removed') {
						delete contact.imgUrl
					}
					Object.assign(contacts[contact.id], contact)
				} else {
					logger.debug({ update }, 'got update for non-existant contact')
				}
			}
		})

		ev.on('chats.upsert', (newChats: Chat[]) => {
			chats.upsert(...(newChats || []))
		})

		ev.on('chats.update', (updates: any[]) => {
			for (let update of updates || []) {
				const result = chats.update(update.id, (chat: Chat) => {
					if (update.unreadCount > 0) {
						update = { ...update, unreadCount: (chat.unreadCount || 0) + update.unreadCount }
					}
					Object.assign(chat, update)
				})
				if (!result) {
					logger.debug({ update }, 'got update for non-existant chat')
				}
			}
		})

		ev.on('labels.edit', (label: any) => {
			if (label.deleted) return labels.deleteById(label.id)
			if (labels.count() < 20) return labels.upsertById(label.id, label)
			logger.error('Labels count exceed')
		})

		ev.on('labels.association', ({ type, association }: any) => {
			switch (type) {
				case 'add':
					labelAssociations.upsert(association)
					break
				case 'remove':
					labelAssociations.delete(association)
					break
				default:
					logger.error({ type }, 'unknown label association operation')
			}
		})

		ev.on('presence.update', ({ id, presences: update }: any) => {
			presences[id] = presences[id] || {}
			Object.assign(presences[id], update)
		})

		ev.on('chats.delete', (deletions: string[]) => {
			for (const item of deletions || []) {
				if (chats.get(item)) {
					chats.deleteById(item)
				}
			}
		})

		ev.on('messages.upsert', ({ messages: newMessages, type }: any) => {
			switch (type) {
				case 'append':
				case 'notify':
					for (const msg of newMessages || []) {
						const jid = jidNormalizedUser(msg.key.remoteJid)
						const list = assertMessageList(jid)
						list.upsert(msg, 'append')
						if (type === 'notify' && !chats.get(jid)) {
							ev.emit('chats.upsert', [
								{ id: jid, conversationTimestamp: toNumber(msg.messageTimestamp), unreadCount: 1 }
							])
						}
					}
					break
			}
		})

		ev.on('messages.update', (updates: any[]) => {
			for (const { update, key } of updates || []) {
				const list = assertMessageList(jidNormalizedUser(key.remoteJid))
				if (update?.status) {
					const storedStatus = list.get(key.id)?.status
					if (storedStatus && update.status <= storedStatus) {
						delete update.status
					}
				}
				const result = list.updateAssign(key.id, update)
				if (!result) {
					logger.debug({ update, key }, 'got update for non-existant message')
				}
			}
		})

		ev.on('groups.update', (updates: GroupMetadata[]) => {
			for (const update of updates || []) {
				groupMetadata[update.id] = Object.assign(groupMetadata[update.id] || {}, update)
			}
		})

		ev.on('group-participants.update', async ({ id, participants, action }: any) => {
			const metadata = groupMetadata[id]
			if (metadata) {
				switch (action) {
					case 'add':
						metadata.participants.push(...participants.map((id: string) => ({ id })))
						break
					case 'remove':
						metadata.participants = metadata.participants.filter(p => !participants.includes(p.id))
						break
				}
			}
		})

		ev.on('labels.upsert', (newLabels: Label[]) => {
			labelsUpsert(newLabels || [])
		})

		ev.on('labels.update', (updates: any[]) => {
			for (const update of updates || []) {
				const label = labels.findById(update.id)
				if (label) Object.assign(label, update)
			}
		})
	}

	const toJSON = () => ({
		chats: chats.toJSON(),
		contacts,
		messages: Object.fromEntries(Object.entries(messages).map(([k, v]) => [k, v.toJSON()])),
		groupMetadata,
		presences,
		state,
		labels: labels.toJSON(),
		labelAssociations: labelAssociations.toJSON()
	})

	const fromJSON = (json: any) => {
		if (!json) return
		if (json.chats) chats.fromJSON(json.chats)
		if (json.contacts) Object.assign(contacts, json.contacts)
		if (json.messages) {
			for (const jid of Object.keys(json.messages)) {
				const list = assertMessageList(jid)
				list.fromJSON(json.messages[jid])
			}
		}
		if (json.groupMetadata) Object.assign(groupMetadata, json.groupMetadata)
		if (json.presences) Object.assign(presences, json.presences)
		if (json.state) Object.assign(state, json.state)
		if (Array.isArray(json.labels)) labelsUpsert(json.labels)
		if (json.labelAssociations) labelAssociations.fromJSON(json.labelAssociations)
	}

	return {
		chats,
		messages,
		contacts,
		groupMetadata,
		presences,
		state,
		labels,
		labelAssociations,
		bind,
		loadMessage: async (jid: string, id: string) => {
			const list = messages[jidNormalizedUser(jid)]
			return list?.get(id)
		},
		fetchImageUrl: async (jid: string, sock = socket) => {
			const id = jidNormalizedUser(jid)
			const contact = contacts[id]
			if (!contact) return sock?.profilePictureUrl(id)
			if (typeof contact.imgUrl === 'undefined') {
				contact.imgUrl = await sock?.profilePictureUrl(id)
			}
			return contact.imgUrl as any
		},
		fetchGroupMetadata: async (jid: string, sock = socket) => {
			const id = jidNormalizedUser(jid)
			if (!groupMetadata[id]) {
				const metadata = await sock?.groupMetadata(id)
				if (metadata) groupMetadata[id] = metadata
			}
			return groupMetadata[id]
		},
		fetchMessageReceipts: async ({ remoteJid, id }: { remoteJid: string, id: string }) => {
			const list = messages[remoteJid]
			const msg = list?.get(id)
			return (msg as any)?.userReceipt
		},
		toJSON,
		fromJSON,
		writeToFile: (path: string) => {
			writeFileSync(path, JSON.stringify(toJSON()))
		},
		readFromFile: (path: string) => {
			if (existsSync(path)) {
				logger.debug({ path }, 'reading from file')
				try {
					const jsonStr = readFileSync(path, { encoding: 'utf-8' })
					if (jsonStr.trim().length) {
						fromJSON(JSON.parse(jsonStr))
					} else {
						logger.warn({ path }, 'skipping empty json file')
					}
				} catch (err) {
					logger.warn({ path, err }, 'failed to parse json from file')
				}
			}
		}
	}
}
