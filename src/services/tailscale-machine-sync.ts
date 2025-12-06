// Tailscale Machine Sync Service

import type { TailscaleDevice, ClassifiedIPs } from '../types/tailscale'
import type {
	RecordResponse,
	ARecordParam,
} from 'cloudflare/resources/dns/records'
import { TailscaleClient } from './tailscale'
import { CloudflareClient } from './cloudflare'
import { createLogger } from '../utils/logger'
import { classifyIP } from '../utils/ip-classifier'

const logger = createLogger()

export interface TailscaleMachineSyncConfig {
	tailscaleClient: TailscaleClient
	cloudflareClient: CloudflareClient
	tsDomain: string
	wanDomain: string
	lanDomain: string
	ownerId: string
	tagFilterRegex: RegExp
	proxyTagRegex: RegExp
	lanCidrRanges: string[]
}

/**
 * Result of DNS synchronization operation
 */
export interface SyncResult {
	added: ARecordParam[]
	deleted: Array<Pick<RecordResponse, 'id' | 'name' | 'type' | 'content'>>
	summary: {
		addedCount: number
		deletedCount: number
		totalDevices: number
		filteredDevices: number
	}
}

export class TailscaleMachineSyncService {
	// Constants for DNS record comment format
	private static readonly HERITAGE = 'cf-ts-dns'
	private static readonly DEFAULT_TTL = 3600
	private static readonly BATCH_SIZE = 200

	private tailscaleClient: TailscaleClient
	private cloudflareClient: CloudflareClient
	private tsDomain: string
	private wanDomain: string
	private lanDomain: string
	private ownerId: string
	private tagFilterRegex: RegExp
	private proxyTagRegex: RegExp
	private lanCidrRanges: string[]

	constructor(config: TailscaleMachineSyncConfig) {
		this.tailscaleClient = config.tailscaleClient
		this.cloudflareClient = config.cloudflareClient
		this.tsDomain = config.tsDomain
		this.wanDomain = config.wanDomain
		this.lanDomain = config.lanDomain
		this.ownerId = config.ownerId
		// Regex objects are already compiled by Zod validation
		this.tagFilterRegex = config.tagFilterRegex
		this.proxyTagRegex = config.proxyTagRegex
		this.lanCidrRanges = config.lanCidrRanges
	}

	/**
	 * Extract machine name from device
	 */
	private getMachineName(device: TailscaleDevice): string | null {
		// device.name is the full hostname, e.g. "pangolin.tailfe8c.ts.net"
		// we want the machine name, e.g. "pangolin"
		return device.name?.split('.').shift() || null
	}

	/**
	 * Check if device should be included based on tag filter regex
	 * A device is included if any of its tags match the regex pattern
	 */
	private shouldIncludeDevice(device: TailscaleDevice): boolean {
		const machineName = this.getMachineName(device) || device.id
		
		// If device has no tags, exclude it
		if (!device.tags || device.tags.length === 0) {
			logger.info(`Device ${machineName} excluded: no tags (filter regex: ${this.tagFilterRegex.source})`)
			return false
		}

		// Check if any tag matches the regex
		const matches = device.tags.some(tag => this.tagFilterRegex.test(tag))
		if (!matches) {
			logger.info(`Device ${machineName} excluded: no tags match filter regex ${this.tagFilterRegex.source} (device tags: ${device.tags.join(', ')})`)
		}
		return matches
	}

	/**
	 * Check if device should have Cloudflare proxy enabled based on tag regex
	 * A device is proxied if any of its tags match the proxy regex pattern
	 */
	private shouldProxyDevice(device: TailscaleDevice): boolean {
		const machineName = this.getMachineName(device) || device.id
		
		// If device has no tags, don't proxy
		if (!device.tags || device.tags.length === 0) {
			logger.info(`Device ${machineName} proxy disabled: no tags (proxy regex: ${this.proxyTagRegex.source})`)
			return false
		}

		// Check if any tag matches the proxy regex
		const matches = device.tags.some(tag => this.proxyTagRegex.test(tag))
		if (!matches) {
			logger.info(`Device ${machineName} proxy disabled: no tags match proxy regex ${this.proxyTagRegex.source} (device tags: ${device.tags.join(', ')})`)
		}
		return matches
	}

	/**
	 * Generate record key for map lookups
	 * For A records, include content to handle multiple records with same name (round-robin)
	 */
	private getRecordKey(type: string, name: string, content?: string): string {
		if (type === 'A' && content) {
			return `${type}:${name}:${content}`
		}
		return `${type}:${name}`
	}

	/**
	 * Create comment content for DNS record ownership tracking
	 * Truncates to 100 characters to comply with Cloudflare's limit
	 */
	private createRecordComment(machineName: string): string {
		const base = `${TailscaleMachineSyncService.HERITAGE}:${this.ownerId}:`
		const maxLength = 100
		
		// If base + machineName fits, return as-is
		if (base.length + machineName.length <= maxLength) {
			return `${base}${machineName}`
		}
		
		// Otherwise, truncate machineName to fit within 100 characters
		const availableLength = maxLength - base.length
		const truncatedMachineName = machineName.substring(0, Math.max(0, availableLength))
		return `${base}${truncatedMachineName}`
	}

	/**
	 * Check if record comment indicates ownership by this service
	 */
	private isOwnedRecord(comment: string | undefined): boolean {
		if (!comment) return false
		return (
			comment.includes(`${TailscaleMachineSyncService.HERITAGE}:`) &&
			comment.includes(`:${this.ownerId}:`)
		)
	}

	/**
	 * Create DNS records for a single IP and domain with ownership comment
	 * Sets proxied field: only enabled for WAN domain records (if device tags match proxy regex)
	 * TS and LAN domains are always DNS-only (proxied: false) since they use private IPs
	 * 
	 * IMPORTANT: LAN IPs should NEVER be in the WAN domain. If a LAN IP is passed with WAN domain,
	 * this indicates a classification bug. We disable proxy as a safeguard, but this should not happen.
	 * 
	 * NOTE: This method should only be called when domain is not empty (checked in buildExpectedRecords)
	 */
	private createARecordForIP(
		machineName: string,
		ip: string,
		domain: string,
		device: TailscaleDevice
	): { aRecord: ARecordParam; aKey: string } {
		// Safety check: if domain is empty, this shouldn't be called
		if (!domain) {
			throw new Error(`Cannot create DNS record: domain is empty for machine ${machineName} with IP ${ip}`)
		}
		
		const aRecordName = `${machineName}.${domain}`
		const aKey = this.getRecordKey('A', aRecordName, ip)
		
		// Check if IP is in LAN CIDR range
		const isLanIP = classifyIP(ip, this.lanCidrRanges) === 'lan'
		const isWanDomain = Boolean(this.wanDomain && domain === this.wanDomain)
		
		// Safety check: LAN IPs should NEVER be in WAN domain - this indicates a classification bug
		if (isLanIP && isWanDomain) {
			logger.warn(
				`LAN IP ${ip} detected in WAN domain for ${machineName}. This should not happen - ` +
				`check LAN_CIDR_RANGES configuration. Disabling proxy as safeguard.`
			)
		}
		
		// Only enable proxy for WAN domain records (public IPs) and only if IP is not a LAN IP
		// TS and LAN domains use private IPs, so always disable proxy
		const proxied: boolean = isWanDomain && !isLanIP && this.shouldProxyDevice(device)

		return {
			aRecord: {
				type: 'A',
				name: aRecordName,
				content: ip,
				ttl: TailscaleMachineSyncService.DEFAULT_TTL,
				comment: this.createRecordComment(machineName),
				proxied,
			},
			aKey,
		}
	}

	/**
	 * Convert records array to map keyed by type:name:content (for A records) or type:name
	 */
	private recordsToMap(records: RecordResponse[]): Map<string, RecordResponse> {
		const recordMap = new Map<string, RecordResponse>()
		for (const record of records) {
			if (record.id && record.type && record.name) {
				const key = this.getRecordKey(record.type, record.name, record.content)
				recordMap.set(key, record)
			}
		}
		return recordMap
	}


	/**
	 * Build expected records from classified IPs
	 * Handles multiple WAN IPs for round-robin, single LAN IP selection
	 * All A records include ownership comments instead of separate TXT records
	 * Proxy is only enabled for WAN domain records (if device tags match proxy regex)
	 * TS and LAN domain records are always DNS-only (proxied: false)
	 * Skips creating records for empty domain configurations
	 */
	private buildExpectedRecords(machineName: string, classifiedIPs: ClassifiedIPs, device: TailscaleDevice): {
		records: ARecordParam[]
		keys: Set<string>
	} {
		const records: ARecordParam[] = []
		const keys = new Set<string>()

		// Handle Tailscale IP - only if tsDomain is configured
		if (classifiedIPs.tailscaleIP && this.tsDomain) {
			const { aRecord, aKey } = this.createARecordForIP(machineName, classifiedIPs.tailscaleIP, this.tsDomain, device)
			records.push(aRecord)
			keys.add(aKey)
		}

		// Handle WAN IPs - multiple for round-robin, only if wanDomain is configured
		if (classifiedIPs.wanIPs && classifiedIPs.wanIPs.length > 0 && this.wanDomain) {
			// Create multiple A records with same name for round-robin
			for (const wanIP of classifiedIPs.wanIPs) {
				// Double-check classification: if this IP is actually a LAN IP, log a warning
				// This should never happen if classification is working correctly
				const isActuallyLan = classifyIP(wanIP, this.lanCidrRanges) === 'lan'
				if (isActuallyLan) {
					logger.error(
						`Classification error: IP ${wanIP} for ${machineName} was classified as WAN but matches LAN CIDR ranges. ` +
						`This indicates a bug in IP classification. LAN_CIDR_RANGES: ${this.lanCidrRanges.join(', ')}`
					)
				}
				const { aRecord, aKey } = this.createARecordForIP(machineName, wanIP, this.wanDomain, device)
				records.push(aRecord)
				keys.add(aKey)
			}
		}

		// Handle LAN IP - single selection, only if lanDomain is configured
		if (classifiedIPs.lanIP && this.lanDomain) {
			const { aRecord, aKey } = this.createARecordForIP(machineName, classifiedIPs.lanIP, this.lanDomain, device)
			records.push(aRecord)
			keys.add(aKey)
		}

		return { records, keys }
	}

	/**
	 * Perform diff between expected and existing records
	 * Returns records to create and records to delete (no updates - delete + create instead)
	 */
	private performDiff(
		expectedRecords: ARecordParam[],
		expectedKeys: Set<string>,
		existingRecords: Map<string, RecordResponse>
	): {
		toCreate: ARecordParam[]
		toDelete: RecordResponse[]
	} {
		const toCreate: ARecordParam[] = []
		const toDelete: RecordResponse[] = []

		// Check each expected record - delete existing if content or comment changed, then create new
		for (const expectedRecord of expectedRecords) {
			const key = this.getRecordKey(expectedRecord.type, expectedRecord.name, expectedRecord.content)
			const existing = existingRecords.get(key)

			if (!existing) {
				// New record - needs to be created
				toCreate.push(expectedRecord)
			} else if (
				existing.content !== expectedRecord.content ||
				existing.comment !== expectedRecord.comment ||
				existing.proxied !== expectedRecord.proxied
			) {
				// Existing record with different content, comment, or proxied status - delete old, create new
				if (existing.id) {
					toDelete.push(existing)
				}
				toCreate.push(expectedRecord)
			}
			// If content, comment, and proxied status match, no action needed
		}

		// Find stale records (exist but not in expected set)
		// Since we use type:name:content keys for A records, this correctly handles
		// multiple A records with same name (round-robin scenario)
		for (const [key, existingRecord] of existingRecords.entries()) {
			if (!expectedKeys.has(key) && existingRecord.id) {
				// Verify ownership before marking for deletion
				if (this.shouldDeleteRecord(existingRecord)) {
					toDelete.push(existingRecord)
				}
			}
		}

		return { toCreate, toDelete }
	}

	/**
	 * Determine if a record should be deleted (checks ownership via comment)
	 */
	private shouldDeleteRecord(record: RecordResponse): boolean {
		// Check ownership via comment field (works for all record types)
		return this.isOwnedRecord(record.comment)
	}

	/**
	 * Execute batch delete and create operations, handling batch size limits
	 * Cloudflare batch API supports up to 200 operations total (deletes + creates)
	 */
	private async executeBatchOperations(
		recordIdsToDelete: string[],
		recordsToCreate: ARecordParam[]
	): Promise<void> {
		if (recordIdsToDelete.length === 0 && recordsToCreate.length === 0) {
			return
		}

		// Split into batches: process deletes and creates together when possible
		let deleteIdx = 0
		let createIdx = 0

		while (deleteIdx < recordIdsToDelete.length || createIdx < recordsToCreate.length) {
			const remainingOps = TailscaleMachineSyncService.BATCH_SIZE
			const deleteBatch: string[] = []
			const createBatch: ARecordParam[] = []

			// Fill batch with deletes first
			while (deleteIdx < recordIdsToDelete.length && deleteBatch.length + createBatch.length < remainingOps) {
				deleteBatch.push(recordIdsToDelete[deleteIdx++])
			}

			// Then fill with creates
			while (createIdx < recordsToCreate.length && deleteBatch.length + createBatch.length < remainingOps) {
				createBatch.push(recordsToCreate[createIdx++])
			}

			if (deleteBatch.length > 0 || createBatch.length > 0) {
				await this.cloudflareClient.batchDeleteAndCreate(deleteBatch, createBatch)
			}
		}
	}


	/**
	 * Get all managed DNS records from Cloudflare (by finding records with our heritage comment)
	 * Uses Cloudflare API comment prefix filter for efficient server-side filtering
	 * All managed records start with: cf-ts-dns:{ownerId}:
	 * Supports multiple record types: A, AAAA, etc.
	 */
	private async getAllManagedRecords(): Promise<RecordResponse[]> {
		// Search for records starting with our exact ownership prefix in the comment
		// Comment format: cf-ts-dns:{ownerId}:{machineName}
		// Using startswith ensures exact matching without client-side filtering
		const ownershipPrefix = `${TailscaleMachineSyncService.HERITAGE}:${this.ownerId}:`
		return await this.cloudflareClient.getExistingRecordsByComment(ownershipPrefix)
	}

	/**
	 * Sync all machines from Tailscale to Cloudflare using diff detection
	 * Handles stale records by comparing existing Cloudflare records with current Tailscale devices
	 * Creates/updates records first, then deletes stale ones to avoid downtime
	 * Returns information about added and deleted records
	 */
	async syncAllMachines(): Promise<SyncResult> {
		logger.info('Starting DNS synchronization for all machines')
		const devices = await this.tailscaleClient.getDevices()
		logger.info(`Found ${devices.length} devices from Tailscale`)
		
		// Filter devices based on tag filter regex
		const filteredDevices = devices.filter(device => this.shouldIncludeDevice(device))
		logger.info(`Filtered to ${filteredDevices.length} devices matching tag filter: ${this.tagFilterRegex.source}`)
		
		// Build expected records map from current Tailscale devices
		const expectedRecordsMap = new Map<string, ARecordParam>()

		for (const device of filteredDevices) {
			const machineName = this.getMachineName(device)
			if (!machineName) {
				logger.warn(`Skipping device ${device.id} - no name or hostname`)
				continue
			}

			const classifiedIPs = this.tailscaleClient.classifyEndpoints(device)
			
			// Warn if no WAN or LAN IPs found - might indicate incorrect subnet configuration
			if ((!classifiedIPs.wanIPs || classifiedIPs.wanIPs.length === 0) && !classifiedIPs.lanIP) {
				const endpoints = device.clientConnectivity?.endpoints || []
				logger.warn(
					`Device ${machineName} (${device.id}) has no WAN or LAN IPs found. ` +
					`This might indicate that the LAN_CIDR_RANGES subnet configuration is incorrect. ` +
					`Device endpoints: ${endpoints.length > 0 ? endpoints.join(', ') : 'none'}`
				)
				// Log full device structure for debugging
				logger.debug(`Full device structure for ${machineName}: ${JSON.stringify(device, null, 2)}`)
			}
			
			const { records } = this.buildExpectedRecords(machineName, classifiedIPs, device)

			// Add to expected records map
			for (const record of records) {
				const key = this.getRecordKey(record.type, record.name, record.content)
				expectedRecordsMap.set(key, record)
			}
		}

		// Get all existing managed records
		const existingManagedRecords = await this.getAllManagedRecords()
		const existingRecordsMap = this.recordsToMap(existingManagedRecords)

		// Convert expected records map to arrays for diff
		const expectedRecords = Array.from(expectedRecordsMap.values())
		const expectedKeys = new Set(expectedRecordsMap.keys())

		// Perform diff: identify records to create and records to delete
		const { toCreate, toDelete } = this.performDiff(expectedRecords, expectedKeys, existingRecordsMap)

		// Execute: Delete and create in batches
		if (toDelete.length > 0 || toCreate.length > 0) {
			logger.info(`Executing batch operations: ${toDelete.length} deletes, ${toCreate.length} creates`)
			const recordIdsToDelete = toDelete.map(r => r.id!).filter((id): id is string => !!id)
			await this.executeBatchOperations(recordIdsToDelete, toCreate)
			logger.info('Batch operations completed successfully')
		} else {
			logger.info('No DNS changes required - all records are up to date')
		}

		return {
			added: toCreate,
			deleted: toDelete.map(r => ({
				id: r.id!,
				name: r.name,
				type: r.type,
				content: r.content || '',
			})),
			summary: {
				addedCount: toCreate.length,
				deletedCount: toDelete.length,
				totalDevices: devices.length,
				filteredDevices: filteredDevices.length,
			},
		}
	}
}

