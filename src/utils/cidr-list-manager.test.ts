import { describe, it, expect } from 'vitest'
import type { GenerationTask, NamedCIDRList } from '../types/task-based-settings'
import {
    isCIDRListInUse,
    getCIDRListUsageCount,
    getTasksUsingCIDRList,
    canDeleteCIDRList,
    matchesNamedCIDRList,
    extractFirstMatchingIP,
    extractAllMatchingIPs,
} from './cidr-list-manager'

describe('CIDR List Manager', () => {
    const mockCIDRLists: NamedCIDRList[] = [
        {
            name: 'home-lan',
            description: 'Home network',
            cidrs: ['192.168.1.0/24', '10.0.0.0/8'],
            mode: 'multiple',
            inverse: false,
        },
        {
            name: 'office-lan',
            description: 'Office network',
            cidrs: ['172.16.0.0/12'],
            mode: 'multiple',
            inverse: false,
        },
        {
            name: 'public-wan',
            description: 'Public IPs',
            cidrs: ['203.0.113.0/24'],
            mode: 'multiple',
            inverse: false,
        },
    ]

    const mockTasks: GenerationTask[] = [
        {
            id: 'task-1',
            name: 'LAN Task',
            enabled: true,
            machineSelector: { field: 'tag', pattern: 'tag:lan' },
            recordTemplates: [
                {
                    recordType: 'A',
                    name: '{{machineName}}.internal',
                    value: '{{cidr.home-lan}}',
                }
            ],
        },
        {
            id: 'task-2',
            name: 'Complex Task',
            enabled: true,
            machineSelector: { field: 'tag', pattern: 'tag:office' },
            recordTemplates: [
                {
                    recordType: 'AAAA',
                    name: '{{cidr.office-lan,public-wan}}.example.com',
                    value: '::1',
                }
            ],
        },
    ]

    describe('isCIDRListInUse', () => {
        it('should return true when CIDR list is referenced in a template', () => {
            expect(isCIDRListInUse('home-lan', mockTasks)).toBe(true)
            expect(isCIDRListInUse('office-lan', mockTasks)).toBe(true)
            expect(isCIDRListInUse('public-wan', mockTasks)).toBe(true)
        })

        it('should return false when CIDR list is not referenced', () => {
            expect(isCIDRListInUse('unused-list', mockTasks)).toBe(false)
        })

        it('should handle comma-separated list references', () => {
            expect(isCIDRListInUse('office-lan', mockTasks)).toBe(true)
            expect(isCIDRListInUse('public-wan', mockTasks)).toBe(true)
        })
    })

    describe('getCIDRListUsageCount', () => {
        it('should return correct usage count', () => {
            expect(getCIDRListUsageCount('home-lan', mockTasks)).toBe(1)
            expect(getCIDRListUsageCount('office-lan', mockTasks)).toBe(1)
        })

        it('should return 0 for unused lists', () => {
            expect(getCIDRListUsageCount('unused-list', mockTasks)).toBe(0)
        })
    })

    describe('getTasksUsingCIDRList', () => {
        it('should return tasks using the CIDR list', () => {
            const tasks = getTasksUsingCIDRList('home-lan', mockTasks)
            expect(tasks).toHaveLength(1)
            expect(tasks[0]?.id).toBe('task-1')
        })
    })

    describe('canDeleteCIDRList', () => {
        it('should return true for unused CIDR lists', () => {
            expect(canDeleteCIDRList('unused-list', mockTasks)).toEqual({ canDelete: true })
        })

        it('should return false for CIDR lists in use', () => {
            const result = canDeleteCIDRList('home-lan', mockTasks)
            expect(result.canDelete).toBe(false)
            expect(result.error).toContain('referenced by 1 task(s)')
        })
    })

    describe('matchesNamedCIDRList', () => {
        it('should match IP in first CIDR range', () => {
            expect(matchesNamedCIDRList('192.168.1.100', 'home-lan', mockCIDRLists)).toBe(true)
        })

        it('should match IP in second CIDR range', () => {
            expect(matchesNamedCIDRList('10.5.10.20', 'home-lan', mockCIDRLists)).toBe(true)
        })

        it('should match IP in office network', () => {
            expect(matchesNamedCIDRList('172.16.5.10', 'office-lan', mockCIDRLists)).toBe(true)
        })

        it('should match IP in public WAN range', () => {
            expect(matchesNamedCIDRList('203.0.113.50', 'public-wan', mockCIDRLists)).toBe(true)
        })

        it('should not match IP outside all ranges', () => {
            expect(matchesNamedCIDRList('8.8.8.8', 'home-lan', mockCIDRLists)).toBe(false)
            expect(matchesNamedCIDRList('1.1.1.1', 'public-wan', mockCIDRLists)).toBe(false)
        })

        it('should return false for non-existent CIDR list', () => {
            expect(matchesNamedCIDRList('192.168.1.100', 'non-existent', mockCIDRLists)).toBe(false)
        })

        it('should handle empty CIDR lists', () => {
            const emptyLists: NamedCIDRList[] = []
            expect(matchesNamedCIDRList('192.168.1.100', 'home-lan', emptyLists)).toBe(false)
        })
    })

    describe('extractFirstMatchingIP', () => {
        it('should extract first matching IP', () => {
            const ips = ['8.8.8.8', '192.168.1.100', '10.0.5.20']
            const result = extractFirstMatchingIP(ips, 'home-lan', mockCIDRLists)
            expect(result).toBe('192.168.1.100')
        })

        it('should prefer first CIDR range match (ordered)', () => {
            const ips = ['10.0.5.20', '192.168.1.100']
            const result = extractFirstMatchingIP(ips, 'home-lan', mockCIDRLists)
            // Should return the first match based on CIDR list order
            expect(result).toBe('192.168.1.100')
        })

        it('should return null when no IPs match', () => {
            const ips = ['8.8.8.8', '1.1.1.1']
            const result = extractFirstMatchingIP(ips, 'home-lan', mockCIDRLists)
            expect(result).toBeNull()
        })

        it('should return null for empty IP array', () => {
            const result = extractFirstMatchingIP([], 'home-lan', mockCIDRLists)
            expect(result).toBeNull()
        })

        it('should return null for non-existent CIDR list', () => {
            const ips = ['192.168.1.100']
            const result = extractFirstMatchingIP(ips, 'non-existent', mockCIDRLists)
            expect(result).toBeNull()
        })
    })

    describe('extractAllMatchingIPs', () => {
        it('should extract all matching IPs', () => {
            const ips = ['192.168.1.100', '8.8.8.8', '10.0.5.20', '1.1.1.1']
            const result = extractAllMatchingIPs(ips, 'home-lan', mockCIDRLists)
            expect(result).toHaveLength(2)
            expect(result).toContain('192.168.1.100')
            expect(result).toContain('10.0.5.20')
        })

        it('should preserve order based on CIDR list priority', () => {
            const ips = ['10.0.5.20', '192.168.1.100', '192.168.1.200']
            const result = extractAllMatchingIPs(ips, 'home-lan', mockCIDRLists)
            // First CIDR range (192.168.1.0/24) should be prioritized
            expect(result[0]).toBe('192.168.1.100')
            expect(result[1]).toBe('192.168.1.200')
            expect(result[2]).toBe('10.0.5.20')
        })

        it('should return empty array when no IPs match', () => {
            const ips = ['8.8.8.8', '1.1.1.1']
            const result = extractAllMatchingIPs(ips, 'home-lan', mockCIDRLists)
            expect(result).toEqual([])
        })

        it('should handle empty IP array', () => {
            const result = extractAllMatchingIPs([], 'home-lan', mockCIDRLists)
            expect(result).toEqual([])
        })

        it('should handle multiple CIDR ranges correctly', () => {
            const ips = ['172.16.10.5', '172.16.20.10', '8.8.8.8']
            const result = extractAllMatchingIPs(ips, 'office-lan', mockCIDRLists)
            expect(result).toHaveLength(2)
            expect(result).toContain('172.16.10.5')
            expect(result).toContain('172.16.20.10')
        })
    })
})
