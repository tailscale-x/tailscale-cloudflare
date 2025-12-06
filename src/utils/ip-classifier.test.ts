// IP Classifier Tests

import { describe, it, expect } from 'vitest'
import { classifyIP, extractIPsFromEndpoints, getIPsByType } from './ip-classifier'
import type { TailscaleDevice } from '../types/tailscale'

// Default LAN CIDR ranges for testing (RFC 1918 + Carrier-Grade NAT)
const DEFAULT_LAN_CIDR_RANGES = [
	'10.0.0.0/8',
	'172.16.0.0/12',
	'192.168.0.0/16',
	'100.64.0.0/10', // Carrier-Grade NAT
]

describe('classifyIP', () => {
	it('should classify IPs in 10.0.0.0/8 as LAN', () => {
		expect(classifyIP('10.0.0.1', DEFAULT_LAN_CIDR_RANGES)).toBe('lan')
		expect(classifyIP('10.255.255.255', DEFAULT_LAN_CIDR_RANGES)).toBe('lan')
		expect(classifyIP('10.1.2.3', DEFAULT_LAN_CIDR_RANGES)).toBe('lan')
	})

	it('should classify IPs in 172.16.0.0/12 as LAN', () => {
		expect(classifyIP('172.16.0.1', DEFAULT_LAN_CIDR_RANGES)).toBe('lan')
		expect(classifyIP('172.31.255.255', DEFAULT_LAN_CIDR_RANGES)).toBe('lan')
		expect(classifyIP('172.20.1.1', DEFAULT_LAN_CIDR_RANGES)).toBe('lan')
	})

	it('should classify IPs in 192.168.0.0/16 as LAN', () => {
		expect(classifyIP('192.168.0.1', DEFAULT_LAN_CIDR_RANGES)).toBe('lan')
		expect(classifyIP('192.168.255.255', DEFAULT_LAN_CIDR_RANGES)).toBe('lan')
		expect(classifyIP('192.168.1.100', DEFAULT_LAN_CIDR_RANGES)).toBe('lan')
	})

	it('should classify IPs in 100.64.0.0/10 as LAN', () => {
		expect(classifyIP('100.64.0.1', DEFAULT_LAN_CIDR_RANGES)).toBe('lan')
		expect(classifyIP('100.127.255.255', DEFAULT_LAN_CIDR_RANGES)).toBe('lan')
		expect(classifyIP('100.100.1.1', DEFAULT_LAN_CIDR_RANGES)).toBe('lan')
	})

	it('should classify public IPs as WAN', () => {
		expect(classifyIP('8.8.8.8', DEFAULT_LAN_CIDR_RANGES)).toBe('wan')
		expect(classifyIP('1.1.1.1', DEFAULT_LAN_CIDR_RANGES)).toBe('wan')
		expect(classifyIP('203.0.113.1', DEFAULT_LAN_CIDR_RANGES)).toBe('wan')
	})

	it('should respect custom CIDR ranges', () => {
		const customRanges = ['192.168.0.0/16', '10.0.0.0/8']
		expect(classifyIP('192.168.1.1', customRanges)).toBe('lan')
		expect(classifyIP('10.0.0.1', customRanges)).toBe('lan')
		expect(classifyIP('172.16.0.1', customRanges)).toBe('wan') // Not in custom ranges
	})

	it('should check ranges in order', () => {
		// Even though 10.0.0.0/8 is broader, if 192.168.0.0/16 comes first, it should match first
		const ranges = ['192.168.0.0/16', '10.0.0.0/8']
		expect(classifyIP('192.168.1.1', ranges)).toBe('lan')
		expect(classifyIP('10.0.0.1', ranges)).toBe('lan')
	})
})

describe('extractIPsFromEndpoints', () => {
	it('should extract IPs from endpoint strings', () => {
		const endpoints = ['192.168.1.1:12345', '10.0.0.1:54321', '8.8.8.8:80']
		const ips = extractIPsFromEndpoints(endpoints)
		expect(ips).toEqual(['192.168.1.1', '10.0.0.1', '8.8.8.8'])
	})

	it('should handle empty endpoint array', () => {
		expect(extractIPsFromEndpoints([])).toEqual([])
	})

	it('should skip invalid endpoint formats', () => {
		const endpoints = ['192.168.1.1:12345', 'invalid', '10.0.0.1:54321', 'no-port']
		const ips = extractIPsFromEndpoints(endpoints)
		expect(ips).toEqual(['192.168.1.1', '10.0.0.1'])
	})

	it('should handle IPv6 endpoints (skip for now)', () => {
		const endpoints = ['192.168.1.1:12345', '[2001:db8::1]:54321']
		const ips = extractIPsFromEndpoints(endpoints)
		// IPv6 should be skipped as current implementation only handles IPv4
		expect(ips).toEqual(['192.168.1.1'])
	})
})

describe('getIPsByType', () => {
	it('should extract Tailscale IP from addresses', () => {
		const device: TailscaleDevice = {
			id: 'test-device',
			name: 'test.tailnet.ts.net',
			addresses: ['100.64.1.1', 'fd7a:115c:a1e0::1'],
		}
		const result = getIPsByType(device, DEFAULT_LAN_CIDR_RANGES)
		expect(result.tailscaleIP).toBe('100.64.1.1')
	})

	it('should select LAN IP from endpoints', () => {
		const device: TailscaleDevice = {
			id: 'test-device',
			name: 'test.tailnet.ts.net',
			clientConnectivity: {
				endpoints: ['192.168.1.1:12345'],
			},
		}
		const result = getIPsByType(device, DEFAULT_LAN_CIDR_RANGES)
		expect(result.lanIP).toBe('192.168.1.1')
		expect(result.wanIPs).toBeUndefined()
	})

	it('should select WAN IPs from endpoints', () => {
		const device: TailscaleDevice = {
			id: 'test-device',
			name: 'test.tailnet.ts.net',
			clientConnectivity: {
				endpoints: ['8.8.8.8:12345'],
			},
		}
		const result = getIPsByType(device, DEFAULT_LAN_CIDR_RANGES)
		expect(result.lanIP).toBeUndefined()
		expect(result.wanIPs).toEqual(['8.8.8.8'])
	})

	it('should handle multiple WAN IPs for round-robin', () => {
		const device: TailscaleDevice = {
			id: 'test-device',
			name: 'test.tailnet.ts.net',
			clientConnectivity: {
				endpoints: ['8.8.8.8:12345', '1.1.1.1:54321'],
			},
		}
		const result = getIPsByType(device, DEFAULT_LAN_CIDR_RANGES)
		expect(result.wanIPs).toEqual(['8.8.8.8', '1.1.1.1'])
	})

	it('should prioritize endpoint matching first range when multiple endpoints match different ranges', () => {
		// This is the key test: when multiple endpoints match different ranges,
		// the one matching the first range should be chosen
		const device: TailscaleDevice = {
			id: 'test-device',
			name: 'test.tailnet.ts.net',
			clientConnectivity: {
				endpoints: ['10.0.0.1:12345', '192.168.1.1:54321'],
			},
		}
		// Order: 192.168 comes first, so 192.168.1.1 should be chosen even though 10.0.0.1 appears first
		const ranges = ['192.168.0.0/16', '10.0.0.0/8']
		const result = getIPsByType(device, ranges)
		expect(result.lanIP).toBe('192.168.1.1')
		expect(result.wanIPs).toBeUndefined() // 10.0.0.1 is also LAN but not selected
	})

	it('should prioritize endpoint matching first range even when it appears later in endpoint list', () => {
		const device: TailscaleDevice = {
			id: 'test-device',
			name: 'test.tailnet.ts.net',
			clientConnectivity: {
				endpoints: ['10.0.0.1:12345', '172.16.0.1:54321', '192.168.1.1:9999'],
			},
		}
		// Order: 192.168 comes first, so it should be chosen
		const ranges = ['192.168.0.0/16', '10.0.0.0/8', '172.16.0.0/12']
		const result = getIPsByType(device, ranges)
		expect(result.lanIP).toBe('192.168.1.1')
	})

	it('should select first matching endpoint when multiple endpoints match the same first range', () => {
		const device: TailscaleDevice = {
			id: 'test-device',
			name: 'test.tailnet.ts.net',
			clientConnectivity: {
				endpoints: ['192.168.1.1:12345', '192.168.1.2:54321'],
			},
		}
		const ranges = ['192.168.0.0/16', '10.0.0.0/8']
		const result = getIPsByType(device, ranges)
		// First endpoint matching the first range should be selected
		expect(result.lanIP).toBe('192.168.1.1')
	})

	it('should handle mixed LAN and WAN endpoints', () => {
		const device: TailscaleDevice = {
			id: 'test-device',
			name: 'test.tailnet.ts.net',
			clientConnectivity: {
				endpoints: ['192.168.1.1:12345', '8.8.8.8:54321', '1.1.1.1:9999'],
			},
		}
		const ranges = ['192.168.0.0/16', '10.0.0.0/8']
		const result = getIPsByType(device, ranges)
		expect(result.lanIP).toBe('192.168.1.1')
		expect(result.wanIPs).toEqual(['8.8.8.8', '1.1.1.1'])
	})

	it('should not include selected LAN IP in WAN IPs', () => {
		const device: TailscaleDevice = {
			id: 'test-device',
			name: 'test.tailnet.ts.net',
			clientConnectivity: {
				endpoints: ['192.168.1.1:12345', '8.8.8.8:54321'],
			},
		}
		const result = getIPsByType(device, DEFAULT_LAN_CIDR_RANGES)
		expect(result.lanIP).toBe('192.168.1.1')
		expect(result.wanIPs).toEqual(['8.8.8.8'])
		expect(result.wanIPs).not.toContain('192.168.1.1')
	})

	it('should handle device with no endpoints', () => {
		const device: TailscaleDevice = {
			id: 'test-device',
			name: 'test.tailnet.ts.net',
			clientConnectivity: {},
		}
		const result = getIPsByType(device, DEFAULT_LAN_CIDR_RANGES)
		expect(result.lanIP).toBeUndefined()
		expect(result.wanIPs).toBeUndefined()
	})

	it('should handle device with no clientConnectivity', () => {
		const device: TailscaleDevice = {
			id: 'test-device',
			name: 'test.tailnet.ts.net',
		}
		const result = getIPsByType(device, DEFAULT_LAN_CIDR_RANGES)
		expect(result.lanIP).toBeUndefined()
		expect(result.wanIPs).toBeUndefined()
	})

	it('should throw error when lanCidrRanges is empty', () => {
		const device: TailscaleDevice = {
			id: 'test-device',
			name: 'test.tailnet.ts.net',
			clientConnectivity: {
				endpoints: ['192.168.1.1:12345'],
			},
		}
		expect(() => getIPsByType(device, [])).toThrow('lanCidrRanges cannot be empty')
	})

	it('should work with default ranges', () => {
		const device: TailscaleDevice = {
			id: 'test-device',
			name: 'test.tailnet.ts.net',
			clientConnectivity: {
				endpoints: ['192.168.1.1:12345'],
			},
		}
		const result = getIPsByType(device, DEFAULT_LAN_CIDR_RANGES)
		expect(result.lanIP).toBe('192.168.1.1')
	})

	it('should handle complex scenario with multiple ranges and endpoints', () => {
		const device: TailscaleDevice = {
			id: 'test-device',
			name: 'test.tailnet.ts.net',
			addresses: ['100.64.1.1'],
			clientConnectivity: {
				endpoints: [
					'10.0.0.1:12345',      // Matches 10.0.0.0/8 (second in list)
					'172.16.0.1:54321',    // Matches 172.16.0.0/12 (third in list)
					'192.168.1.1:9999',   // Matches 192.168.0.0/16 (first in list) - should be chosen
					'8.8.8.8:80',          // WAN
					'1.1.1.1:443',         // WAN
				],
			},
		}
		const ranges = ['192.168.0.0/16', '10.0.0.0/8', '172.16.0.0/12']
		const result = getIPsByType(device, ranges)
		expect(result.tailscaleIP).toBe('100.64.1.1')
		expect(result.lanIP).toBe('192.168.1.1') // First range match
		expect(result.wanIPs).toEqual(['8.8.8.8', '1.1.1.1'])
		// 10.0.0.1 and 172.16.0.1 are also LAN but not selected (they match later ranges)
	})

	it('should handle case where no endpoint matches any range (all WAN)', () => {
		const device: TailscaleDevice = {
			id: 'test-device',
			name: 'test.tailnet.ts.net',
			clientConnectivity: {
				endpoints: ['8.8.8.8:12345', '1.1.1.1:54321'],
			},
		}
		const ranges = ['192.168.0.0/16', '10.0.0.0/8']
		const result = getIPsByType(device, ranges)
		expect(result.lanIP).toBeUndefined()
		expect(result.wanIPs).toEqual(['8.8.8.8', '1.1.1.1'])
	})

	it('should handle case where only second range has matches', () => {
		const device: TailscaleDevice = {
			id: 'test-device',
			name: 'test.tailnet.ts.net',
			clientConnectivity: {
				endpoints: ['10.0.0.1:12345', '172.16.0.1:54321'],
			},
		}
		const ranges = ['192.168.0.0/16', '10.0.0.0/8', '172.16.0.0/12']
		const result = getIPsByType(device, ranges)
		// 10.0.0.1 matches the second range, but since no endpoint matches first range,
		// it should be selected (first match found)
		expect(result.lanIP).toBe('10.0.0.1')
	})
})

