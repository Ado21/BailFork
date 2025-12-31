export type UpsertMode = 'append' | 'prepend'

export interface OrderedDictionary<T, Id extends string = string> {
	array: T[]
	get: (id: Id) => T | undefined
	upsert: (item: T, mode: UpsertMode) => void
	update: (item: T) => boolean
	remove: (item: T) => boolean
	updateAssign: (id: Id, update: Partial<T>) => boolean
	clear: () => void
	filter: (contain: (item: T) => boolean) => void
	toJSON: () => T[]
	fromJSON: (newItems: T[]) => void
}

export default function makeOrderedDictionary<T, Id extends string = string>(
	idGetter: (item: T) => Id
): OrderedDictionary<T, Id> {
	const array: T[] = []
	const dict: Record<string, T> = {}

	const get = (id: Id) => dict[id]

	const update = (item: T) => {
		const id = idGetter(item)
		const idx = array.findIndex(i => idGetter(i) === id)
		if (idx >= 0) {
			array[idx] = item
			dict[id] = item
		}
		return false
	}

	const upsert = (item: T, mode: UpsertMode) => {
		const id = idGetter(item)
		if (get(id)) {
			update(item)
		} else {
			if (mode === 'append') {
				array.push(item)
			} else {
				array.unshift(item)
			}
			dict[id] = item
		}
	}

	const remove = (item: T) => {
		const id = idGetter(item)
		const idx = array.findIndex(i => idGetter(i) === id)
		if (idx >= 0) {
			array.splice(idx, 1)
			delete dict[id]
			return true
		}
		return false
	}

	return {
		array,
		get,
		upsert,
		update,
		remove,
		updateAssign: (id: Id, update: Partial<T>) => {
			const item = get(id)
			if (item) {
				Object.assign(item as any, update)
				delete dict[id]
				dict[idGetter(item)] = item
				return true
			}
			return false
		},
		clear: () => {
			array.splice(0, array.length)
			for (const key of Object.keys(dict)) {
				delete dict[key]
			}
		},
			filter: (contain: (item: T) => boolean) => {
				let i = 0
				while (i < array.length) {
					const item = array[i]
					// With `noUncheckedIndexedAccess`, array[i] is `T | undefined`.
					if (!item || !contain(item)) {
						if (item) {
							delete dict[idGetter(item)]
						}
						array.splice(i, 1)
					} else {
						i += 1
					}
				}
			},
		toJSON: () => array,
		fromJSON: (newItems: T[]) => {
			array.splice(0, array.length, ...newItems)
			for (const k of Object.keys(dict)) delete dict[k]
			for (const item of newItems) dict[idGetter(item)] = item
		}
	}
}
