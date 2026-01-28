// IP Classification Utility

import type { TailscaleDevice } from '../types/tailscale'
import ipRangeCheck from 'ip-range-check'

/**
 * Check if an IP address matches any of the provided CIDR ranges
 * Returns true if the IP is within any of the ranges, false otherwise
 */
export function classifyIP(ip: string, cidrRanges: string[]): boolean {
	// Check if IPv4
	if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
		// Not IPv4, return false for now
		return false
	}

	// Check ranges in order - return true on first match
	for (const range of cidrRanges) {
		if (ipRangeCheck(ip, range)) {
			return true
		}
	}

	return false
}

/**
 * Extract IP addresses from endpoint strings (IP:PORT format)
 */
export function extractIPsFromEndpoints(endpoints: string[]): string[] {
	const ips: string[] = []

	for (const endpoint of endpoints) {
		// Extract IP from IP:PORT format
		const match = endpoint.match(/^(\d+\.\d+\.\d+\.\d+):\d+$/)
		if (match) {
			ips.push(match[1]!)
		}
	}

	return ips
}


