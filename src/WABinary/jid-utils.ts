export const S_WHATSAPP_NET = '@s.whatsapp.net'
export const OFFICIAL_BIZ_JID = '16505361212@c.us'
export const SERVER_JID = 'server@c.us'
export const PSA_WID = '0@c.us'
export const STORIES_JID = 'status@broadcast'
export const META_AI_JID = '13135550002@c.us'

export type JidServer =
	| 'c.us'
	| 'g.us'
	| 'broadcast'
	| 's.whatsapp.net'
	| 'call'
	| 'lid'
	| 'newsletter'
	| 'bot'
	| 'hosted'
	| 'hosted.lid'

export enum WAJIDDomains {
	WHATSAPP = 0,
	LID = 1,
	HOSTED = 128,
	HOSTED_LID = 129
}

export type JidWithDevice = {
	user: string
	device?: number
}

export type FullJid = JidWithDevice & {
	server: JidServer
	domainType?: number
}

export const getServerFromDomainType = (initialServer: string, domainType?: WAJIDDomains): JidServer => {
	switch (domainType) {
		case WAJIDDomains.LID:
			return 'lid'
		case WAJIDDomains.HOSTED:
			return 'hosted'
		case WAJIDDomains.HOSTED_LID:
			return 'hosted.lid'
		case WAJIDDomains.WHATSAPP:
		default:
			return initialServer as JidServer
	}
}

export const jidEncode = (user: string | number | null, server: JidServer, device?: number, agent?: number) => {
	return `${user || ''}${!!agent ? `_${agent}` : ''}${!!device ? `:${device}` : ''}@${server}`
}

export const jidDecode = (jid: string | undefined): FullJid | undefined => {
	// todo: investigate how to implement hosted ids in this case
	const sepIdx = typeof jid === 'string' ? jid.indexOf('@') : -1
	if (sepIdx < 0) {
		return undefined
	}

	const server = jid!.slice(sepIdx + 1)
	const userCombined = jid!.slice(0, sepIdx)

	const [userAgent, device] = userCombined.split(':')
	const [user, agent] = userAgent!.split('_')

	let domainType = WAJIDDomains.WHATSAPP
	if (server === 'lid') {
		domainType = WAJIDDomains.LID
	} else if (server === 'hosted') {
		domainType = WAJIDDomains.HOSTED
	} else if (server === 'hosted.lid') {
		domainType = WAJIDDomains.HOSTED_LID
	} else if (agent) {
		domainType = parseInt(agent)
	}

	return {
		server: server as JidServer,
		user: user!,
		domainType,
		device: device ? +device : undefined
	}
}

/** is the jid a user */
export const areJidsSameUser = (jid1: string | undefined, jid2: string | undefined) =>
	jidDecode(jid1)?.user === jidDecode(jid2)?.user
/** is the jid Meta AI */
export const isJidMetaAI = (jid: string | undefined) => jid?.endsWith('@bot')
/** is the jid a PN user */
export const isPnUser = (jid: string | undefined) => jid?.endsWith('@s.whatsapp.net')
/** is the jid a LID */
export const isLidUser = (jid: string | undefined) => jid?.endsWith('@lid')
/** is the jid a broadcast */
export const isJidBroadcast = (jid: string | undefined) => jid?.endsWith('@broadcast')
/** is the jid a group */
export const isJidGroup = (jid: string | undefined) => jid?.endsWith('@g.us')
/** is the jid the status broadcast */
export const isJidStatusBroadcast = (jid: string) => jid === 'status@broadcast'
/** is the jid a newsletter */
export const isJidNewsletter = (jid: string | undefined) => jid?.endsWith('@newsletter')
/** is the jid a hosted PN */
export const isHostedPnUser = (jid: string | undefined) => jid?.endsWith('@hosted')
/** is the jid a hosted LID */
export const isHostedLidUser = (jid: string | undefined) => jid?.endsWith('@hosted.lid')

/** is the jid any LID form (lid or hosted.lid) */
export const isAnyLidUser = (jid: string | undefined) => isLidUser(jid) || isHostedLidUser(jid)

// --- LID -> phone-number JID resolution helpers (best-effort, cached) ---
// WhatsApp sometimes delivers mentions/participants as *@lid* identifiers.
// Those are not phone-number JIDs. We keep an in-memory map populated from
// group metadata + device lists to translate LIDs back to PN JIDs.

const __LID_JID_MAP = new Map<string, string>()

const __normalizeLid = (lid: string | undefined | null) => {
  if (!lid || typeof lid !== 'string') return ''
  if (lid.includes('@')) return lid
  return `${lid}@lid`
}

/** cache a single lid -> jid mapping */
export const cacheLidToJid = (lid: string | undefined | null, jid: string | undefined | null) => {
  const lidNorm = __normalizeLid(lid)
  if (!lidNorm || !jid) return
  const decoded = jidDecode(lidNorm)
  const lidUser = decoded?.user
  const jidNorm = jidNormalizedUser(jid)
  if (!jidNorm) return
  __LID_JID_MAP.set(lidNorm, jidNorm)
  if (lidUser) __LID_JID_MAP.set(lidUser, jidNorm)
}

/** cache mappings for a group participant list */
export const cacheGroupParticipantMappings = (participants: any[] | undefined | null) => {
  if (!Array.isArray(participants)) return
  for (const p of participants) {
    if (!p) continue
    // Official baileys participants: { id, phoneNumber?, lid? }
    // Some forks use { id, jid, lid }
    cacheLidToJid(p.lid || p.id, p.phoneNumber || p.jid || p.id)
    cacheLidToJid(p.id, p.phoneNumber || p.jid || p.id)
  }
}

/** best-effort: turn *@lid* JIDs into phone-number *@s.whatsapp.net* JIDs if cached */
export const lidToJid = (jid: string | undefined | null) => {
  if (!jid) return jid
  if (!isAnyLidUser(jid)) return jid
  const lidNorm = __normalizeLid(jid)
  const decoded = jidDecode(lidNorm)
  const lidUser = decoded?.user
  const mapped = __LID_JID_MAP.get(lidNorm) || (lidUser ? __LID_JID_MAP.get(lidUser) : undefined)
  // fallback: keep server change for compatibility, but this is still not a real PN if unmapped
  return mapped || lidNorm.replace(/@hosted\.lid$/i, '@s.whatsapp.net').replace(/@lid$/i, '@s.whatsapp.net')
}

const botRegexp = /^1313555\d{4}$|^131655500\d{2}$/

export const isJidBot = (jid: string | undefined) => jid && botRegexp.test(jid.split('@')[0]!) && jid.endsWith('@c.us')

export const jidNormalizedUser = (jid: string | undefined) => {
	const result = jidDecode(jid)
	if (!result) {
		return ''
	}

	const { user, server } = result
	return jidEncode(user, server === 'c.us' ? 's.whatsapp.net' : (server as JidServer))
}

export const transferDevice = (fromJid: string, toJid: string) => {
	const fromDecoded = jidDecode(fromJid)
	const deviceId = fromDecoded?.device || 0
	const { server, user } = jidDecode(toJid)!
	return jidEncode(user, server, deviceId)
}
