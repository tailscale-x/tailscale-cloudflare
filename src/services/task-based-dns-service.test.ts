import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TaskBasedDNSService } from './task-based-dns-service'
import type { TaskBasedSettings } from '../types/task-based-settings'
import type { TailscaleDevice } from '../types/tailscale'
import type { RecordResponse } from 'cloudflare/resources/dns/records'

describe('TaskBasedDNSService', () => {
    let mockTailscaleClient: any
    let mockCloudflareClient: any
    let settings: TaskBasedSettings

    beforeEach(() => {
        mockTailscaleClient = {
            getDevices: vi.fn(),
            classifyEndpoints: vi.fn(),
        }
        mockCloudflareClient = {
            getExistingRecordsByComment: vi.fn(),
            batchDeleteAndCreate: vi.fn(),
            getZoneIdFromDomain: vi.fn().mockResolvedValue('zone123'),
        }

        settings = {
            TAILSCALE_API_KEY: 'tskey-api-test',
            CLOUDFLARE_API_TOKEN: 'cloudflare-token-test-12345678901234567890',
            TAILSCALE_TAILNET: 'test.tailnet',
            namedCIDRLists: [],
            generationTasks: [
                {
                    id: 'task1',
                    name: 'Test Task',
                    enabled: true,
                    machineSelector: { field: 'name', pattern: '*' },
                    recordTemplates: [
                        { recordType: 'A', name: '{{machineName}}.ext', value: '{{tailscaleIP}}' }
                    ]
                }
            ]
        }
    })

    describe('getRecordKey', () => {
        it('should generate identical keys for identical A records', () => {
            const service = new TaskBasedDNSService(settings, 'owner1', {
                cloudflareClient: mockCloudflareClient,
                tailscaleClient: mockTailscaleClient
            })

            const record1 = { type: 'A', name: 'test.com', content: '1.1.1.1' }
            const record2 = { type: 'A', name: 'test.com', content: '1.1.1.1' }

            expect((service as any).getRecordKey(record1)).toBe((service as any).getRecordKey(record2))
        })

        it('should generate different keys for A records with different content', () => {
            const service = new TaskBasedDNSService(settings, 'owner1', {
                cloudflareClient: mockCloudflareClient,
                tailscaleClient: mockTailscaleClient
            })

            const record1 = { type: 'A', name: 'test.com', content: '1.1.1.1' }
            const record2 = { type: 'A', name: 'test.com', content: '1.1.1.2' }

            expect((service as any).getRecordKey(record1)).not.toBe((service as any).getRecordKey(record2))
        })

        it('should handle SRV record keys correctly', () => {
            const service = new TaskBasedDNSService(settings, 'owner1', {
                cloudflareClient: mockCloudflareClient,
                tailscaleClient: mockTailscaleClient
            })

            const record1 = {
                type: 'SRV',
                name: 'test.com',
                data: { service: '_http', proto: '_tcp', priority: 1, weight: 1, port: 80, target: 'ext.com' }
            }
            const record2 = {
                type: 'SRV',
                name: 'test.com',
                data: { service: '_http', proto: '_tcp', priority: 1, weight: 1, port: 80, target: 'ext.com' }
            }
            const record3 = {
                type: 'SRV',
                name: 'test.com',
                data: { service: '_http', proto: '_tcp', priority: 1, weight: 1, port: 81, target: 'ext.com' }
            }

            expect((service as any).getRecordKey(record1)).toBe((service as any).getRecordKey(record2))
            expect((service as any).getRecordKey(record1)).not.toBe((service as any).getRecordKey(record3))
        })
    })

    describe('recordsToMap', () => {
        it('should identify duplicates and return a clean map', () => {
            const service = new TaskBasedDNSService(settings, 'owner1', {
                cloudflareClient: mockCloudflareClient,
                tailscaleClient: mockTailscaleClient
            })

            const records: any[] = [
                { id: '1', type: 'A', name: 'test.com', content: '1.1.1.1' },
                { id: '2', type: 'A', name: 'test.com', content: '1.1.1.1' }, // Duplicate
                { id: '3', type: 'A', name: 'other.com', content: '2.2.2.2' }
            ]

            const { recordMap, duplicates } = (service as any).recordsToMap(records)

            expect(recordMap.size).toBe(2)
            expect(duplicates.length).toBe(1)
            expect(duplicates[0].id).toBe('2')
        })
    })

    describe('performDiff', () => {
        it('should correctly identify records to create and delete', () => {
            const service = new TaskBasedDNSService(settings, 'owner1', {
                cloudflareClient: mockCloudflareClient,
                tailscaleClient: mockTailscaleClient
            })

            const expectedRecords: any[] = [
                { type: 'A', name: 'keep.com', content: '1.1.1.1', comment: 'cf-ts-dns:owner1:keep' },
                { type: 'A', name: 'new.com', content: '2.2.2.2', comment: 'cf-ts-dns:owner1:new' }
            ]
            const expectedKeys = new Set(expectedRecords.map(r => (service as any).getRecordKey(r)))

            const existingRecords = new Map<string, any>()
            const keepRecord = { id: 'k1', type: 'A', name: 'keep.com', content: '1.1.1.1', comment: 'cf-ts-dns:owner1:keep' }
            const staleRecord = { id: 's1', type: 'A', name: 'stale.com', content: '3.3.3.3', comment: 'cf-ts-dns:owner1:stale' }

            existingRecords.set((service as any).getRecordKey(keepRecord), keepRecord)
            existingRecords.set((service as any).getRecordKey(staleRecord), staleRecord)

            const cloudflareDuplicates: any[] = [
                { id: 'd1', type: 'A', name: 'dup.com', content: '4.4.4.4', comment: 'cf-ts-dns:owner1:dup' }
            ]

            const { toCreate, toDelete } = (service as any).performDiff(
                expectedRecords,
                expectedKeys,
                existingRecords,
                cloudflareDuplicates
            )

            expect(toCreate.length).toBe(1)
            expect(toCreate[0].name).toBe('new.com')

            expect(toDelete.length).toBe(2) // 1 stale + 1 duplicate
            const deleteIds = toDelete.map((r: any) => r.id)
            expect(deleteIds).toContain('s1')
            expect(deleteIds).toContain('d1')
        })
    })

    describe('associatedSrv', () => {
        it('should generate an associated SRV record when enabled', () => {
            const service = new TaskBasedDNSService(settings, 'owner1', {
                cloudflareClient: mockCloudflareClient,
                tailscaleClient: mockTailscaleClient
            })

            const task: any = {
                id: 'task-srv',
                name: 'Test Task SRV',
                enabled: true,
                machineSelector: { field: 'name', pattern: 'web-server' },
                recordTemplates: [
                    {
                        recordType: 'A',
                        name: '{{machineName}}',
                        value: '{{tailscaleIP}}',
                        srvPrefix: '_web._tcp',
                        port: 8080,
                        priority: 5,
                        weight: 5
                    }
                ]
            }

            const device: any = {
                id: '1',
                name: 'web-server',
                hostname: 'web-server',
                addresses: ['100.64.0.1'],
                tags: []
            }

            const { records } = (service as any).generateRecordsFromTask(task, [device])

            expect(records.length).toBe(2)

            // Check A record
            const aRecord = records.find((r: any) => r.type === 'A')
            expect(aRecord).toBeDefined()
            expect(aRecord.name).toBe('web-server')

            // Check SRV record
            const srvRecord = records.find((r: any) => r.type === 'SRV')
            expect(srvRecord).toBeDefined()
            expect(srvRecord.name).toBe('_web._tcp.web-server')
            expect(srvRecord.data.port).toBe(8080)
            expect(srvRecord.data.priority).toBe(5)
            expect(srvRecord.data.weight).toBe(5)
            expect(srvRecord.data.target).toBe('web-server')
        })
    })
})
