export class ObjectRepository<T extends Record<string, any> = Record<string, any>> {
	private entityMap: Map<string, T>
	private maxSize: number

	constructor(entities: Record<string, T> = {}) {
		this.entityMap = new Map(Object.entries(entities))
		this.maxSize = 1000
	}

	findById(id: string) {
		return this.entityMap.get(id)
	}

	findAll() {
		return Array.from(this.entityMap.values())
	}

	upsertById(id: string, entity: T) {
		this.entityMap.set(id, { ...(entity as any) })
		this.cleanup()
		return this.entityMap
	}

	deleteById(id: string) {
		return this.entityMap.delete(id)
	}

	count() {
		return this.entityMap.size
	}

	toJSON() {
		return this.findAll()
	}

	cleanup() {
		if (this.entityMap.size > this.maxSize) {
			const keys = Array.from(this.entityMap.keys())
			for (let i = 0; i < keys.length / 2; i++) {
				this.entityMap.delete(keys[i]!)
			}
		}
	}

	findByProperty<K extends keyof T>(property: K, value: T[K]) {
		const results: T[] = []
		for (const [, entity] of this.entityMap) {
			if ((entity as any)[property] === value) {
				results.push(entity)
			}
		}
		return results
	}
}
