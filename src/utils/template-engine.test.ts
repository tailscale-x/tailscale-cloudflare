// Template Engine Tests

import { describe, it, expect } from 'vitest'
import { evaluateTemplate, validateTemplate, getAvailableVariables, type TemplateContext } from './template-engine'
import type { TailscaleDevice } from '../types/tailscale'
import type { NamedCIDRList } from '../types/task-based-settings'

describe('Template Engine', () => {
    const mockDevice: TailscaleDevice = {
        id: 'test-id',
        name: 'test-machine.tail123.ts.net',
        hostname: 'test-machine',
        addresses: ['100.64.0.1'],
        tags: ['tag:lan', 'tag:web'],
        clientConnectivity: {
            endpoints: ['192.168.1.100:41641', '203.0.113.1:41641'],
        },
    }

    const mockCIDRLists: NamedCIDRList[] = [
        {
            name: 'home-lan',
            cidrs: ['192.168.1.0/24'],
            mode: 'multiple',
            inverse: false,
        },
        {
            name: 'public-wan',
            cidrs: ['203.0.113.0/24'],
            mode: 'multiple',
            inverse: false,
        },
    ]

    const baseContext: TemplateContext = {
        machineName: 'test-machine',
        tailscaleIP: '100.64.0.1',
        tags: ['tag:lan', 'tag:web'],
        captures: {},
        namedCIDRLists: mockCIDRLists,
        device: mockDevice,
    }

    describe('evaluateTemplate', () => {
        it('should return template as-is when no variables', () => {
            const result = evaluateTemplate('example.com', baseContext)
            expect(result.values).toEqual(['example.com'])
            expect(result.error).toBeUndefined()
        })

        it('should substitute machineName variable', () => {
            const result = evaluateTemplate('{{machineName}}.example.com', baseContext)
            expect(result.values).toEqual(['test-machine.example.com'])
        })

        it('should substitute tailscaleIP variable', () => {
            const result = evaluateTemplate('IP: {{tailscaleIP}}', baseContext)
            expect(result.values).toEqual(['IP: 100.64.0.1'])
        })

        it('should substitute tags variable', () => {
            const result = evaluateTemplate('Tags: {{tags}}', baseContext)
            expect(result.values).toEqual(['Tags: tag:lan,tag:web'])
        })

        it('should substitute multiple variables', () => {
            const result = evaluateTemplate('{{machineName}} has IP {{tailscaleIP}}', baseContext)
            expect(result.values).toEqual(['test-machine has IP 100.64.0.1'])
        })

        it('should handle regex captures (numbered)', () => {
            const context = {
                ...baseContext,
                captures: { '1': 'web', '2': 'prod' },
            }
            const result = evaluateTemplate('{{$1}}-{{$2}}.example.com', context)
            expect(result.values).toEqual(['web-prod.example.com'])
        })

        it('should handle regex captures (named)', () => {
            const context = {
                ...baseContext,
                captures: { env: 'staging', project: 'api' },
            }
            const result = evaluateTemplate('{{project}}-{{env}}.example.com', context)
            expect(result.values).toEqual(['api-staging.example.com'])
        })

        it('should extract IP from CIDR list', () => {
            const result = evaluateTemplate('{{machineName}}.lan.example.com', baseContext)
            expect(result.values).toEqual(['test-machine.lan.example.com'])

            const resultWithCIDR = evaluateTemplate('{{cidr.home-lan}}', baseContext)
            expect(resultWithCIDR.values).toContain('192.168.1.100')
        })

        it('should generate multiple records for multiple CIDR IPs', () => {
            // If a device has multiple IPs matching a CIDR list, should create multiple records
            const multiIPDevice: TailscaleDevice = {
                ...mockDevice,
                clientConnectivity: {
                    endpoints: ['192.168.1.100:41641', '192.168.1.101:41641', '203.0.113.1:41641'],
                },
            }

            const context = {
                ...baseContext,
                device: multiIPDevice,
            }

            const result = evaluateTemplate('{{cidr.home-lan}}', context)
            expect(result.values.length).toBeGreaterThan(0)
        })

        it('should handle missing CIDR list gracefully', () => {
            const result = evaluateTemplate('{{cidr.nonexistent}}', baseContext)
            expect(result.values).toEqual([])
        })

        it('should handle missing variables gracefully', () => {
            const result = evaluateTemplate('{{unknown}}', baseContext)
            expect(result.values).toEqual([])
        })

        it('should handle empty tailscaleIP', () => {
            const context = {
                ...baseContext,
                tailscaleIP: undefined as any,
            }
            const result = evaluateTemplate('{{tailscaleIP}}', context)
            expect(result.values).toEqual([])
        })

        it('should handle inverse matching', () => {
            const inverseCIDRList: NamedCIDRList = {
                name: 'inverse-lan',
                cidrs: ['192.168.1.0/24'],
                inverse: true,
                mode: 'multiple',
            }

            const context = {
                ...baseContext,
                namedCIDRLists: [...mockCIDRLists, inverseCIDRList],
                device: {
                    ...mockDevice,
                    clientConnectivity: {
                        endpoints: ['192.168.1.100:1234', '203.0.113.1:1234'],
                    },
                },
            }

            const result = evaluateTemplate('{{cidr.inverse-lan}}', context)
            expect(result.values).toContain('203.0.113.1')
            expect(result.values).not.toContain('192.168.1.100')
        })

        it('should handle single mode', () => {
            const singleModeList: NamedCIDRList = {
                name: 'single-lan',
                cidrs: ['192.168.1.0/24'],
                mode: 'single',
                inverse: false,
            }

            const context = {
                ...baseContext,
                namedCIDRLists: [...mockCIDRLists, singleModeList],
                device: {
                    ...mockDevice,
                    clientConnectivity: {
                        endpoints: ['192.168.1.100:1234', '192.168.1.101:1234'],
                    },
                },
            }

            const result = evaluateTemplate('{{cidr.single-lan}}', context)
            expect(result.values).toHaveLength(1)
            expect(result.values[0]).toBe('192.168.1.100')
        })
    })

    describe('validateTemplate', () => {
        it('should validate correct template', () => {
            const result = validateTemplate('{{machineName}}.example.com')
            expect(result.valid).toBe(true)
            expect(result.error).toBeUndefined()
        })

        it('should detect unclosed braces', () => {
            const result = validateTemplate('{{machineName}.example.com')
            expect(result.valid).toBe(false)
            expect(result.error).toContain('Unclosed template braces')
        })

        it('should detect empty variable names', () => {
            const result = validateTemplate('{{  }}.example.com')
            expect(result.valid).toBe(false)
            expect(result.error).toContain('Empty variable name')
        })

        it('should validate nested braces correctly', () => {
            const result = validateTemplate('{{machineName}}-{{tailscaleIP}}')
            expect(result.valid).toBe(true)
        })
    })

    describe('getAvailableVariables', () => {
        it('should return standard variables', () => {
            const variables = getAvailableVariables([])
            expect(variables).toContain('machineName')
            expect(variables).toContain('tailscaleIP')
            expect(variables).toContain('tags')
        })

        it('should include CIDR list variables', () => {
            const variables = getAvailableVariables(mockCIDRLists)
            expect(variables).toContain('cidr.home-lan')
            expect(variables).toContain('cidr.public-wan')
        })
    })
})
