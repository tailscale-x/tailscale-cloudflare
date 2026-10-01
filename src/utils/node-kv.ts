import type { ManagedNode } from './router-exposure'

export async function loadManagedNodes(kv: KVNamespace, ownerId: string): Promise<ManagedNode[]> {
    const prefix = `${ownerId}/node-registry/node:`
    const nodes: ManagedNode[] = []
    let cursor: string | undefined
    do {
        const page = await kv.list({ prefix, ...(cursor ? { cursor } : {}) })
        for (const key of page.keys) {
            const node = await kv.get<ManagedNode>(key.name, 'json')
            if (node) nodes.push(node)
        }
        cursor = page.list_complete ? undefined : page.cursor
    } while (cursor)
    return nodes
}
