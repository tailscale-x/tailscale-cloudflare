
import { describe, it, expect } from 'vitest'
import { generateRecordsFromTask } from './dns-records'
import type { GenerationTask, NamedCIDRList } from '../types/task-based-settings'
import type { TailscaleDevice } from '../types/tailscale'

describe('generateRecordsFromTask - SRV Target', () => {
    const mockDevice: TailscaleDevice = {
        id: 'node-1',
        name: 'test-device.tailscale.com',
        addresses: ['100.64.0.1'],
        tags: ['tag:server'],
        user: 'user1',
        keyExpiry: '2099-01-01T00:00:00Z',
        os: 'linux',
        hostname: 'test-device'
    }

    const baseTask: GenerationTask = {
        id: 'task-1',
        name: 'Test Task',
        enabled: true,
        machineSelector: {
            field: 'name',
            pattern: 'test-device'
        },
        recordTemplates: []
    }

    it('should default SRV target to record name when srvTarget is missing', () => {
        const task: GenerationTask = {
            ...baseTask,
            recordTemplates: [{
                recordType: 'A',
                name: 'app',
                value: '1.2.3.4',
                srvPrefix: '_http._tcp',
                // srvTarget missing
            }]
        }

        const result = generateRecordsFromTask(task, [mockDevice])

        const srvRecord = result.records.find(r => r.type === 'SRV')
        expect(srvRecord).toBeDefined()
        expect(srvRecord?.content).toBe('app') // Defaults to record name
        expect(srvRecord?.name).toBe('_http._tcp.app')
    })

    it('should use srvTarget when provided', () => {
        const task: GenerationTask = {
            ...baseTask,
            recordTemplates: [{
                recordType: 'A',
                name: 'app',
                value: '1.2.3.4',
                srvPrefix: '_http._tcp',
                srvTarget: 'custom.target.com'
            }]
        }

        const result = generateRecordsFromTask(task, [mockDevice])

        const srvRecord = result.records.find(r => r.type === 'SRV')
        expect(srvRecord).toBeDefined()
        expect(srvRecord?.content).toBe('custom.target.com')
        expect(srvRecord?.name).toBe('_http._tcp.app')
    })

    it('should interpolate variables in srvTarget', () => {
        const task: GenerationTask = {
            ...baseTask,
            recordTemplates: [{
                recordType: 'A',
                name: 'app-{{machineName}}',
                value: '1.2.3.4',
                srvPrefix: '_http._tcp',
                srvTarget: '{{machineName}}.internal'
            }]
        }

        const result = generateRecordsFromTask(task, [mockDevice])

        const srvRecord = result.records.find(r => r.type === 'SRV')
        expect(srvRecord).toBeDefined()
        expect(srvRecord?.content).toBe('test-device.internal')
        expect(srvRecord?.name).toBe('_http._tcp.app-test-device')
    })
})
