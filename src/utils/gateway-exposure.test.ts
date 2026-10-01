import { describe, expect, it, vi } from 'vitest'
import type { GenerationTask, TaskBasedSettings } from '../types/task-based-settings'
import type { TailscaleDevice } from '../types/tailscale'
import { generateGatewayExposureRecords } from './gateway-exposure'
import { TaskBasedDNSService } from '../services/task-based-dns-service'

const task: GenerationTask = {
    id: 'gateway', name: 'Gateway exposure', enabled: true,
    machineSelector: { field: 'name', pattern: '/^app-/' },
    recordTemplates: [],
    gatewayExposure: {
        gatewayMachineName: 'caddy-gateway-vps',
        gatewayHostname: 'gateway.example.com',
        publicHostnameTemplate: '{{machineName}}.example.com',
        backendHostnameTemplate: '{{machineName}}.ts.example.com',
        backendPort: 8080,
    },
}
const backend: TailscaleDevice = {
    id: 'backend-1', name: 'app-one.tailnet.ts.net', addresses: ['100.64.1.2'],
}
const gateway = (endpoints: string[]): TailscaleDevice => ({
    id: 'gateway-1', name: 'caddy-gateway-vps.tailnet.ts.net',
    clientConnectivity: { endpoints }, addresses: ['100.64.1.1'],
})

describe('gateway exposure records', () => {
    it('creates DNS-only gateway, alias, SRV, and tailnet backend records', () => {
        const result = generateGatewayExposureRecords(task, [gateway(['203.0.114.4:41641', '192.168.1.2:41641']), backend], [], 'owner1')
        expect(result.errors).toEqual([])
        expect(result.records).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'A', name: 'gateway.example.com', content: '203.0.114.4', proxied: false }),
            expect.objectContaining({ type: 'A', name: 'app-one.ts.example.com', content: '100.64.1.2', proxied: false }),
            expect.objectContaining({ type: 'CNAME', name: 'app-one.example.com', content: 'gateway.example.com', proxied: false }),
            expect.objectContaining({ type: 'SRV', name: '_gateway._tcp.app-one.example.com', content: 'app-one.ts.example.com', port: 8080, proxied: false }),
        ]))
    })

    it.each<[string[]]>([[[]], [['203.0.114.4:41641', '203.0.115.5:41641']]])('retains gateway A on missing or ambiguous public endpoints', endpoints => {
        const result = generateGatewayExposureRecords(task, [gateway(endpoints), backend], [], 'owner1')
        expect(result.errors).toHaveLength(1)
        expect(result.preserveGatewayA).toBe('gateway.example.com')
        expect(result.records.some(record => record.type === 'A' && record.name === 'gateway.example.com')).toBe(false)
    })

    it('does not delete the last gateway A or another owner’s records on a partial sync', async () => {
        const settings: TaskBasedSettings = {
            CLOUDFLARE_API_TOKEN: 'test', TAILSCALE_TAILNET: 'test',
            namedCIDRLists: [], generationTasks: [task],
        }
        const cloudflare = {
            getExistingRecordsByComment: vi.fn().mockResolvedValue([
                { id: 'gateway-old', type: 'A', name: 'gateway.example.com', content: '203.0.114.4', comment: 'cf-ts-dns:owner1:caddy-gateway-vps', proxied: false },
                { id: 'foreign', type: 'A', name: 'foreign.example.com', content: '8.8.8.8', comment: 'cf-ts-dns:owner2:other' },
            ]),
            batchDeleteAndCreate: vi.fn().mockResolvedValue(undefined),
        }
        const tailscale = { getDevices: vi.fn().mockResolvedValue([gateway([]), backend]) }
        const service = new TaskBasedDNSService(settings, 'owner1', { cloudflareClient: cloudflare as any, tailscaleClient: tailscale as any })
        const result = await service.syncAllMachines(true)
        expect(result.errors).toHaveLength(1)
        expect(result.deleted).toEqual([])
        expect(result.managed.map(record => record.id)).toEqual(['gateway-old'])
        expect(cloudflare.getExistingRecordsByComment).toHaveBeenCalledWith('cf-ts-dns:owner1:')
    })

    it('replaces a changed gateway IP and deletes only this owner’s stale records', async () => {
        const settings: TaskBasedSettings = {
            CLOUDFLARE_API_TOKEN: 'test', TAILSCALE_TAILNET: 'test',
            namedCIDRLists: [], generationTasks: [task],
        }
        const cloudflare = {
            getExistingRecordsByComment: vi.fn().mockResolvedValue([
                { id: 'gateway-old', type: 'A', name: 'gateway.example.com', content: '203.0.114.4', comment: 'cf-ts-dns:owner1:caddy-gateway-vps' },
                { id: 'stale-own', type: 'A', name: 'stale.example.com', content: '100.64.1.9', comment: 'cf-ts-dns:owner1:old-backend' },
                { id: 'foreign', type: 'A', name: 'foreign.example.com', content: '8.8.8.8', comment: 'cf-ts-dns:owner2:other' },
            ]),
            batchDeleteAndCreate: vi.fn().mockResolvedValue(undefined),
        }
        const tailscale = { getDevices: vi.fn().mockResolvedValue([gateway(['203.0.115.5:41641']), backend]) }
        const service = new TaskBasedDNSService(settings, 'owner1', { cloudflareClient: cloudflare as any, tailscaleClient: tailscale as any })
        const result = await service.syncAllMachines()
        expect(result.errors).toEqual([])
        expect(result.deleted.map(record => record.id).sort()).toEqual(['gateway-old', 'stale-own'])
        expect(result.added).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'A', name: 'gateway.example.com', content: '203.0.115.5', proxied: false }),
        ]))
        expect(cloudflare.batchDeleteAndCreate).toHaveBeenCalledOnce()
    })
})
