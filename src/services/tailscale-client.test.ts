import { afterEach, describe, expect, it, vi } from 'vitest'
import { TailscaleClient } from './tailscale-client'

const client = () => new TailscaleClient({ clientId: 'client', clientSecret: 'secret', tailnet: '-' })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

describe('Tailscale OAuth client', () => {
    it('uses a renewed token for device reads', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(json({ access_token: 'first', expires_in: 1 }))
            .mockResolvedValueOnce(json({ devices: [{ id: 'one' }] }))
            .mockResolvedValueOnce(json({ access_token: 'second', expires_in: 3600 }))
            .mockResolvedValueOnce(json({ devices: [{ id: 'two' }] }))
        vi.stubGlobal('fetch', fetchMock)
        const ts = client()
        expect((await ts.getDevices())[0]?.id).toBe('one')
        expect((await ts.getDevices())[0]?.id).toBe('two')
        expect(fetchMock.mock.calls[3]?.[1]?.headers.Authorization).toBe('Bearer second')
    })

    it('creates a non-reusable, non-ephemeral one-day key and revokes it', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(json({ access_token: 'token', expires_in: 3600 }))
            .mockResolvedValueOnce(json({ id: 'key-id', key: 'tskey-auth-value', expires: 'tomorrow' }))
            .mockResolvedValueOnce(new Response(null, { status: 204 }))
        vi.stubGlobal('fetch', fetchMock)
        const ts = client()
        const created = await ts.createAuthKey(['tag:gateway'], 'Gateway test')
        expect(created.id).toBe('key-id')
        const createRequest = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body)
        expect(createRequest).toMatchObject({ expirySeconds: 86400, capabilities: { devices: { create: {
            reusable: false, ephemeral: false, preauthorized: false, tags: ['tag:gateway'],
        } } } })
        await ts.revokeAuthKey(created.id)
        expect(fetchMock.mock.calls[2]?.[1]?.method).toBe('DELETE')
    })
})
