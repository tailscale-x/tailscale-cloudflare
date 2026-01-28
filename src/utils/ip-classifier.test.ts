// IP Classifier Tests

import { describe, it, expect } from 'vitest'
import { classifyIP, extractIPsFromEndpoints } from './ip-classifier'

// Default LAN CIDR ranges for testing (RFC 1918 + Carrier-Grade NAT)
const DEFAULT_LAN_CIDR_RANGES = [
	'10.0.0.0/8',
	'172.16.0.0/12',
	'192.168.0.0/16',
	'100.64.0.0/10', // Carrier-Grade NAT
]

describe('classifyIP', () => {
	it('should return true for IPs in 10.0.0.0/8', () => {
		expect(classifyIP('10.0.0.1', DEFAULT_LAN_CIDR_RANGES)).toBe(true)
		expect(classifyIP('10.255.255.255', DEFAULT_LAN_CIDR_RANGES)).toBe(true)
		expect(classifyIP('10.1.2.3', DEFAULT_LAN_CIDR_RANGES)).toBe(true)
	})

	it('should return true for IPs in 172.16.0.0/12', () => {
		expect(classifyIP('172.16.0.1', DEFAULT_LAN_CIDR_RANGES)).toBe(true)
		expect(classifyIP('172.31.255.255', DEFAULT_LAN_CIDR_RANGES)).toBe(true)
		expect(classifyIP('172.20.1.1', DEFAULT_LAN_CIDR_RANGES)).toBe(true)
	})

	it('should return true for IPs in 192.168.0.0/16', () => {
		expect(classifyIP('192.168.0.1', DEFAULT_LAN_CIDR_RANGES)).toBe(true)
		expect(classifyIP('192.168.255.255', DEFAULT_LAN_CIDR_RANGES)).toBe(true)
		expect(classifyIP('192.168.1.100', DEFAULT_LAN_CIDR_RANGES)).toBe(true)
	})

	it('should return true for IPs in 100.64.0.0/10', () => {
		expect(classifyIP('100.64.0.1', DEFAULT_LAN_CIDR_RANGES)).toBe(true)
		expect(classifyIP('100.127.255.255', DEFAULT_LAN_CIDR_RANGES)).toBe(true)
		expect(classifyIP('100.100.1.1', DEFAULT_LAN_CIDR_RANGES)).toBe(true)
	})

	it('should return false for public IPs', () => {
		expect(classifyIP('8.8.8.8', DEFAULT_LAN_CIDR_RANGES)).toBe(false)
		expect(classifyIP('1.1.1.1', DEFAULT_LAN_CIDR_RANGES)).toBe(false)
		expect(classifyIP('203.0.113.1', DEFAULT_LAN_CIDR_RANGES)).toBe(false)
	})

	it('should respect custom CIDR ranges', () => {
		const customRanges = ['192.168.0.0/16', '10.0.0.0/8']
		expect(classifyIP('192.168.1.1', customRanges)).toBe(true)
		expect(classifyIP('10.0.0.1', customRanges)).toBe(true)
		expect(classifyIP('172.16.0.1', customRanges)).toBe(false) // Not in custom ranges
	})

	it('should check ranges in order', () => {
		// Even though 10.0.0.0/8 is broader, if 192.168.0.0/16 comes first, it should match first
		const ranges = ['192.168.0.0/16', '10.0.0.0/8']
		expect(classifyIP('192.168.1.1', ranges)).toBe(true)
		expect(classifyIP('10.0.0.1', ranges)).toBe(true)
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
