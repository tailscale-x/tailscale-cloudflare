// Machine Selector Tests

import { describe, it, expect } from 'vitest'
import {
    selectMachines,
    testSelector,
    validateSelector,
    getSupportedFields,
} from './machine-selector'
import type { TailscaleDevice } from '../types/tailscale'
import type { MachineSelector } from '../types/task-based-settings'

describe('Machine Selector', () => {
    const mockDevices: TailscaleDevice[] = [
        {
            id: '1',
            name: 'web-server.tail123.ts.net',
            hostname: 'web-server',
            tags: ['tag:web', 'tag:prod'],
        },
        {
            id: '2',
            name: 'db-server.tail123.ts.net',
            hostname: 'db-server',
            tags: ['tag:database', 'tag:staging'],
        },
        {
            id: '3',
            name: 'api-gateway.tail123.ts.net',
            hostname: 'api-gateway',
            tags: ['tag:api', 'tag:prod'],
        },
    ]

    describe('selectMachines', () => {
        it('should match exact tag', () => {
            const selector: MachineSelector = {
                field: 'tag',
                pattern: 'tag:web',
            }

            const result = selectMachines(mockDevices, selector)
            expect(result).toHaveLength(1)
            expect(result[0].device.id).toBe('1')
        })

        it('should match exact machine name', () => {
            const selector: MachineSelector = {
                field: 'name',
                pattern: 'db-server',
            }

            const result = selectMachines(mockDevices, selector)
            expect(result).toHaveLength(1)
            expect(result[0].device.id).toBe('2')
        })

        it('should match regex pattern on tags', () => {
            const selector: MachineSelector = {
                field: 'tag',
                pattern: '/^tag:(web|api)$/',
            }

            const result = selectMachines(mockDevices, selector)
            expect(result).toHaveLength(2)
            expect(result.map(r => r.device.id).sort()).toEqual(['1', '3'])
        })

        it('should extract numbered capture groups', () => {
            const selector: MachineSelector = {
                field: 'tag',
                pattern: '/^tag:(.+)$/',
            }

            const result = selectMachines(mockDevices, selector)
            expect(result.length).toBeGreaterThan(0)

            const webResult = result.find(r => r.device.id === '1')
            expect(webResult?.captures['1']).toMatch(/web|prod/)
        })

        it('should extract named capture groups', () => {
            const selector: MachineSelector = {
                field: 'tag',
                pattern: '/^tag:(?<env>prod|staging)$/',
            }

            const result = selectMachines(mockDevices, selector)
            expect(result.length).toBeGreaterThan(0)

            for (const match of result) {
                expect(match.captures.env).toMatch(/^(prod|staging)$/)
            }
        })

        it('should match on name field', () => {
            const selector: MachineSelector = {
                field: 'name',
                pattern: '/^(web|api)-/',
            }

            const result = selectMachines(mockDevices, selector)
            expect(result).toHaveLength(2)
        })

        it('should return empty array when no matches', () => {
            const selector: MachineSelector = {
                field: 'tag',
                pattern: 'tag:nonexistent',
            }

            const result = selectMachines(mockDevices, selector)
            expect(result).toHaveLength(0)
        })

        it('should match each device only once', () => {
            // Device with multiple tags matching pattern should only appear once
            const selector: MachineSelector = {
                field: 'tag',
                pattern: '/^tag:.*$/',
            }

            const result = selectMachines(mockDevices, selector)
            const deviceIds = result.map(r => r.device.id)
            const uniqueIds = [...new Set(deviceIds)]
            expect(deviceIds.length).toBe(uniqueIds.length)
        })
    })

    describe('testSelector', () => {
        it('should test exact match', () => {
            const selector: MachineSelector = {
                field: 'tag',
                pattern: 'tag:web',
            }

            const result = testSelector(mockDevices[0], selector)
            expect(result.matched).toBe(true)
        })

        it('should test regex match with captures', () => {
            const selector: MachineSelector = {
                field: 'tag',
                pattern: '/^tag:(?<role>\\w+)$/',
            }

            const result = testSelector(mockDevices[0], selector)
            expect(result.matched).toBe(true)
            expect(result.captures.role).toMatch(/web|prod/)
        })

        it('should return no match for non-matching device', () => {
            const selector: MachineSelector = {
                field: 'tag',
                pattern: 'tag:notfound',
            }

            const result = testSelector(mockDevices[0], selector)
            expect(result.matched).toBe(false)
        })
    })

    describe('validateSelector', () => {
        it('should validate correct exact match selector', () => {
            const selector: MachineSelector = {
                field: 'tag',
                pattern: 'tag:web',
            }

            const result = validateSelector(selector)
            expect(result.valid).toBe(true)
        })

        it('should validate correct regex selector', () => {
            const selector: MachineSelector = {
                field: 'tag',
                pattern: '/^tag:.*$/',
            }

            const result = validateSelector(selector)
            expect(result.valid).toBe(true)
        })

        it('should detect invalid regex syntax', () => {
            const selector: MachineSelector = {
                field: 'tag',
                pattern: '/^tag:(*invalid$/',
            }

            const result = validateSelector(selector)
            expect(result.valid).toBe(false)
            expect(result.error).toContain('Invalid regex syntax')
        })

        it('should detect empty field', () => {
            const selector: MachineSelector = {
                field: '',
                pattern: 'test',
            }

            const result = validateSelector(selector)
            expect(result.valid).toBe(false)
            expect(result.error).toContain('field cannot be empty')
        })

        it('should detect empty pattern', () => {
            const selector: MachineSelector = {
                field: 'tag',
                pattern: '',
            }

            const result = validateSelector(selector)
            expect(result.valid).toBe(false)
            expect(result.error).toContain('pattern cannot be empty')
        })
    })

    describe('getSupportedFields', () => {
        it('should return at least tag and name fields', () => {
            const fields = getSupportedFields()
            const fieldValues = fields.map(f => f.value)

            expect(fieldValues).toContain('tag')
            expect(fieldValues).toContain('name')
            expect(fieldValues).toContain('hostname')
        })

        it('should provide descriptions for fields', () => {
            const fields = getSupportedFields()

            for (const field of fields) {
                expect(field.value).toBeTruthy()
                expect(field.label).toBeTruthy()
                expect(field.description).toBeTruthy()
            }
        })
    })
})
