import { describe, expect, it } from 'vitest'
import { generateRouterExposureRecords, type ManagedNode } from './router-exposure'
import type { TailscaleDevice } from '../types/tailscale'

const now = 1_800_000
const gateway: ManagedNode = { id: 'gateway-id', role: 'gateway', machineName: 'gateway', gatewayHostname: 'gateway.example.com', revoked: false, lastReportAt: now, enrolledAt: 1, exposures: [] }
const router = (id: string, machineName: string, hostname: string): ManagedNode => ({
    id, role: 'router', machineName, revoked: false, lastReportAt: now, enrolledAt: 2,
    exposures: [{ hostname, port: 8080 }],
})
const device = (name: string, ip: string): TailscaleDevice => ({ id: name, name: `${name}.tail.ts.net`, addresses: [ip] })

describe('router exposure records', () => {
    it('publishes one alias and multiple SRV targets for the same hostname', () => {
        const result = generateRouterExposureRecords([gateway, router('abcdef01', 'router-a', 'app.example.com'), router('abcdef02', 'router-b', 'app.example.com')],
            [device('router-a', '100.81.1.1'), device('router-b', '100.81.1.2')], 'owner1', now)
        expect(result.errors).toEqual([])
        expect(result.records.filter(record => record.type === 'CNAME')).toHaveLength(1)
        expect(result.records.filter(record => record.type === 'SRV')).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: '_gateway._tcp.app.example.com', content: 'router-abcdef01.ts.gateway.example.com', port: 8080 }),
            expect.objectContaining({ name: '_gateway._tcp.app.example.com', content: 'router-abcdef02.ts.gateway.example.com', port: 8080 }),
        ]))
        expect(result.records.filter(record => record.type === 'A').map(record => record.content).sort()).toEqual(['100.81.1.1', '100.81.1.2'])
        expect(result.records.every(record => record.comment?.startsWith('cf-ts-dns:owner1:') && !record.proxied)).toBe(true)
    })

    it('expires reports and rejects a hostname outside the gateway zone', () => {
        const stale = router('abcdef01', 'router-a', 'app.example.com')
        stale.lastReportAt = now - 600001
        const outside = router('abcdef02', 'router-b', 'app.other.com')
        const result = generateRouterExposureRecords([gateway, stale, outside], [device('router-a', '100.81.1.1'), device('router-b', '100.81.1.2')], 'owner1', now)
        expect(result.records.filter(record => record.type === 'SRV')).toHaveLength(0)
        expect(result.errors).toEqual([expect.stringContaining('outside example.com')])
    })
})
