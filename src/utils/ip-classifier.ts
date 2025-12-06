// IP Classification Utility

import type { ClassifiedIPs, TailscaleDevice } from '../types/tailscale'
import ipRangeCheck from 'ip-range-check'

/**
 * Classify a single IP as LAN or WAN
 * Checks if the IP matches any of the provided LAN CIDR ranges.
 */
export function classifyIP(ip: string, lanCidrRanges: string[]): 'lan' | 'wan' {
	// Check if IPv4
	if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
		// Not IPv4, treat as WAN for now
		return 'wan'
	}
	
	// Check ranges in order - return 'lan' on first match to respect ordering
	for (const range of lanCidrRanges) {
		if (ipRangeCheck(ip, range)) {
			return 'lan'
		}
	}
	
	return 'wan'
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
			ips.push(match[1])
		}
	}
	
	return ips
}

/**
 * Get IPs classified by type from a device
 * 
 * IMPORTANT: lanCidrRanges must not be empty. If empty, all IPs will be misclassified as WAN.
 * 
 * LAN IP selection: When multiple endpoints match different ranges, the endpoint matching the 
 * first range in the ordered list is chosen. This allows prioritizing specific ranges by ordering.
 */
export function getIPsByType(
	device: TailscaleDevice,
	lanCidrRanges: string[]
): ClassifiedIPs {
	const result: ClassifiedIPs = {}
	
	// Validate that lanCidrRanges is not empty (should never happen if env validation works)
	if (!lanCidrRanges || lanCidrRanges.length === 0) {
		throw new Error('lanCidrRanges cannot be empty - LAN_CIDR_RANGES environment variable is required')
	}
	
	// Get Tailscale IP from addresses (typically 100.x.y.z)
	if (device.addresses && device.addresses.length > 0) {
		const tailscaleIPs = device.addresses.filter(addr => {
			// Tailscale IPs are typically in 100.x.y.z range
			return addr.startsWith('100.') || addr.startsWith('fd7a:')
		})
		if (tailscaleIPs.length > 0) {
			result.tailscaleIP = tailscaleIPs[0]
		}
	}
	
	// Extract IPs from endpoints
	const endpoints = device.clientConnectivity?.endpoints || []
	const endpointIPs = extractIPsFromEndpoints(endpoints)
	
	// Find LAN IP by checking ranges in order - the endpoint matching the first range is chosen
	// This ensures that when multiple endpoints match different ranges, priority is given to the first range
	let lanIPFound = false
	for (const range of lanCidrRanges) {
		for (const ip of endpointIPs) {
			if (ipRangeCheck(ip, range)) {
				result.lanIP = ip
				lanIPFound = true
				break
			}
		}
		if (lanIPFound) {
			break
		}
	}
	
	// Classify remaining endpoint IPs as WAN (excluding the selected LAN IP)
	const wanIPs: string[] = []
	for (const ip of endpointIPs) {
		// Skip the selected LAN IP
		if (result.lanIP && ip === result.lanIP) {
			continue
		}
		// Classify as WAN if not in any LAN range
		if (classifyIP(ip, lanCidrRanges) === 'wan') {
			wanIPs.push(ip)
		}
	}
	
	// Support multiple WAN IPs for round-robin
	if (wanIPs.length > 0) {
		result.wanIPs = wanIPs
	}
	
	return result
}
