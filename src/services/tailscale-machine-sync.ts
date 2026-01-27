// Tailscale Machine Sync Service

import type { TailscaleDevice, ClassifiedIPs } from '../types/tailscale'
import type {
	RecordResponse,
	ARecordParam,
} from 'cloudflare/resources/dns/records'
import type { ParsedSettings } from '../types/settings'
import { TailscaleClient } from './tailscale-client'
import { CloudflareClient } from './cloudflare'
import { createLogger } from '../utils/logger'
import { classifyIP } from '../utils/ip-classifier'

const logger = createLogger()

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
	managed: RecordResponse[]
}

export class TailscaleMachineSyncService {
	// Constants for DNS record comment format
	private static readonly HERITAGE = 'cf-ts-dns'
	private static readonly DEFAULT_TTL = 3600
	private static readonly BATCH_SIZE = 200

	private tailscaleClient: TailscaleClient
	private cloudflareClient: CloudflareClient
	private settings: ParsedSettings
	private ownerId: string

	constructor(
		settings: ParsedSettings,
		ownerId: string,
		clients?: {
			tailscaleClient?: TailscaleClient
			cloudflareClient?: CloudflareClient
		}
	) {
		this.settings = settings
		this.ownerId = ownerId

		this.tailscaleClient = clients?.tailscaleClient || new TailscaleClient({
			apiKey: settings.TAILSCALE_API_KEY,
			tailnet: settings.TAILSCALE_TAILNET,
			lanCidrRanges: settings.LAN_CIDR_RANGES,
		})

		this.cloudflareClient = clients?.cloudflareClient || new CloudflareClient({
			apiToken: settings.CLOUDFLARE_API_TOKEN,
		})
	}

	/**
	 * Static factory method that creates service and performs sync
	 * Accepts ParsedSettings object for cleaner API
	 */
	static async performSync(settings: ParsedSettings, ownerId: string, dryRun: boolean = false): Promise<SyncResult> {
		logger.info(`Creating DNS sync service with owner ID: ${ownerId}`)
		const service = new TailscaleMachineSyncService(settings, ownerId)
		return service.syncAllMachines(dryRun)
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
	 * Check if device should have LAN record created based on tag regex
	 * A LAN record is created if any of the device's tags match the LAN regex pattern
	 */
	private shouldCreateLanRecord(device: TailscaleDevice): boolean {
		if (!device.tags || device.tags.length === 0) {
			return false
		}
		return device.tags.some(tag => this.settings.TAILSCALE_TAG_LAN_REGEX.test(tag))
	}

	/**
	 * Check if device should have Tailscale record created based on tag regex
	 * A Tailscale record is created if any of the device's tags match the Tailscale regex pattern
	 */
	private shouldCreateTailscaleRecord(device: TailscaleDevice): boolean {
		if (!device.tags || device.tags.length === 0) {
			return false
		}
		return device.tags.some(tag => this.settings.TAILSCALE_TAG_TAILSCALE_REGEX.test(tag))
	}

	/**
	 * Check if device should have WAN record created with proxy disabled based on tag regex
	 * A WAN record with proxy disabled is created if any of the device's tags match the WAN_NO_PROXY regex pattern
	 */
	private shouldCreateWanNoProxyRecord(device: TailscaleDevice): boolean {
		if (!device.tags || device.tags.length === 0) {
			return false
		}
		return device.tags.some(tag => this.settings.TAILSCALE_TAG_WAN_NO_PROXY_REGEX.test(tag))
	}

	/**
	 * Check if device should have WAN record created with proxy enabled based on tag regex
	 * A WAN record with proxy enabled is created if any of the device's tags match the WAN_PROXY regex pattern
	 */
	private shouldCreateWanProxyRecord(device: TailscaleDevice): boolean {
		if (!device.tags || device.tags.length === 0) {
			return false
		}
		return device.tags.some(tag => this.settings.TAILSCALE_TAG_WAN_PROXY_REGEX.test(tag))
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
	 * Sets proxied field based on domain type and tag regex matching:
	 * - TS and LAN domains: always DNS-only (proxied: false) since they use private IPs
	 * - WAN domain: proxied based on whether device tags match WAN_PROXY or WAN_NO_PROXY regex
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
		device: TailscaleDevice,
		proxied: boolean
	): { aRecord: ARecordParam; aKey: string } {
		// Safety check: if domain is empty, this shouldn't be called
		if (!domain) {
			throw new Error(`Cannot create DNS record: domain is empty for machine ${machineName} with IP ${ip}`)
		}

		const aRecordName = `${machineName}.${domain}`
		const aKey = this.getRecordKey('A', aRecordName, ip)

		// Check if IP is in LAN CIDR range
		const isLanIP = classifyIP(ip, this.settings.LAN_CIDR_RANGES) === 'lan'
		const isWanDomain = Boolean(this.settings.DOMAIN_FOR_WAN_ENDPOINT && domain === this.settings.DOMAIN_FOR_WAN_ENDPOINT)

		// Safety check: LAN IPs should NEVER be in WAN domain - this indicates a classification bug
		if (isLanIP && isWanDomain) {
			logger.warn(
				`LAN IP ${ip} detected in WAN domain for ${machineName}. This should not happen - ` +
				`check LAN_CIDR_RANGES configuration. Disabling proxy as safeguard.`
			)
			// Force proxy to false for safety
			proxied = false
		}

		// TS and LAN domains always have proxy disabled (private IPs)
		if (!isWanDomain) {
			proxied = false
		}

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
	 * Record creation and proxy settings are controlled by tag regex matching:
	 * - TS records: created if device tags match TAILSCALE regex
	 * - LAN records: created if device tags match LAN regex
	 * - WAN records: created if device tags match WAN_NO_PROXY or WAN_PROXY regex
	 *   - WAN_NO_PROXY: creates WAN record with proxy disabled
	 *   - WAN_PROXY: creates WAN record with proxy enabled
	 * TS and LAN domain records are always DNS-only (proxied: false)
	 * Skips creating records for empty domain configurations
	 */
	private buildExpectedRecords(machineName: string, classifiedIPs: ClassifiedIPs, device: TailscaleDevice): {
		records: ARecordParam[]
		keys: Set<string>
	} {
		const records: ARecordParam[] = []
		const keys = new Set<string>()

		// Handle Tailscale IP - only if tsDomain is configured and device tags match TAILSCALE regex
		if (classifiedIPs.tailscaleIP && this.settings.DOMAIN_FOR_TAILSCALE_ENDPOINT && this.shouldCreateTailscaleRecord(device)) {
			const { aRecord, aKey } = this.createARecordForIP(machineName, classifiedIPs.tailscaleIP, this.settings.DOMAIN_FOR_TAILSCALE_ENDPOINT, device, false)
			records.push(aRecord)
			keys.add(aKey)
		}

		// Handle WAN IPs - multiple for round-robin, only if wanDomain is configured
		// Check both WAN_NO_PROXY and WAN_PROXY regexes
		const shouldCreateWanNoProxy = this.shouldCreateWanNoProxyRecord(device)
		const shouldCreateWanProxy = this.shouldCreateWanProxyRecord(device)

		if (classifiedIPs.wanIPs && classifiedIPs.wanIPs.length > 0 && this.settings.DOMAIN_FOR_WAN_ENDPOINT && (shouldCreateWanNoProxy || shouldCreateWanProxy)) {
			// Create multiple A records with same name for round-robin
			for (const wanIP of classifiedIPs.wanIPs) {
				// Double-check classification: if this IP is actually a LAN IP, log a warning
				// This should never happen if classification is working correctly
				const isActuallyLan = classifyIP(wanIP, this.settings.LAN_CIDR_RANGES) === 'lan'
				if (isActuallyLan) {
					logger.error(
						`Classification error: IP ${wanIP} for ${machineName} was classified as WAN but matches LAN CIDR ranges. ` +
						`This indicates a bug in IP classification. LAN_CIDR_RANGES: ${this.settings.LAN_CIDR_RANGES.join(', ')}`
					)
				}

				// Determine proxy setting: prefer WAN_PROXY if both match, otherwise use WAN_NO_PROXY
				const proxied = shouldCreateWanProxy

				const { aRecord, aKey } = this.createARecordForIP(machineName, wanIP, this.settings.DOMAIN_FOR_WAN_ENDPOINT, device, proxied)
				records.push(aRecord)
				keys.add(aKey)
			}
		}

		// Handle LAN IP - single selection, only if lanDomain is configured and device tags match LAN regex
		if (classifiedIPs.lanIP && this.settings.DOMAIN_FOR_LAN_ENDPOINT && this.shouldCreateLanRecord(device)) {
			const { aRecord, aKey } = this.createARecordForIP(machineName, classifiedIPs.lanIP, this.settings.DOMAIN_FOR_LAN_ENDPOINT, device, false)
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
		recordsToDelete: RecordResponse[],
		recordsToCreate: ARecordParam[]
	): Promise<void> {
		if (recordsToDelete.length === 0 && recordsToCreate.length === 0) {
			return
		}

		// Split into batches: process deletes and creates together when possible
		let deleteIdx = 0
		let createIdx = 0

		while (deleteIdx < recordsToDelete.length || createIdx < recordsToCreate.length) {
			const remainingOps = TailscaleMachineSyncService.BATCH_SIZE
			const deleteBatch: RecordResponse[] = []
			const createBatch: ARecordParam[] = []

			// Fill batch with deletes first
			while (deleteIdx < recordsToDelete.length && deleteBatch.length + createBatch.length < remainingOps) {
				const record = recordsToDelete[deleteIdx++]
				if (record) deleteBatch.push(record)
			}

			// Then fill with creates
			while (createIdx < recordsToCreate.length && deleteBatch.length + createBatch.length < remainingOps) {
				const record = recordsToCreate[createIdx++]
				if (record) createBatch.push(record)
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
	async syncAllMachines(dryRun: boolean = false): Promise<SyncResult> {
		logger.info('Starting DNS synchronization for all machines')
		const devices = await this.tailscaleClient.getDevices()
		logger.info(`Found ${devices.length} devices from Tailscale`)

		// Filter devices: include if they match any of the record type regexes
		const filteredDevices = devices.filter(device => {
			return this.shouldCreateLanRecord(device) ||
				this.shouldCreateTailscaleRecord(device) ||
				this.shouldCreateWanNoProxyRecord(device) ||
				this.shouldCreateWanProxyRecord(device)
		})
		logger.info(`Filtered to ${filteredDevices.length} devices matching record type regexes (out of ${devices.length} total)`)

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

		// Execute: Delete and create in batches (only if not dry run)
		if (toDelete.length > 0 || toCreate.length > 0) {
			if (!dryRun) {
				logger.info(`Executing batch operations: ${toDelete.length} deletes, ${toCreate.length} creates`)
				await this.executeBatchOperations(toDelete, toCreate)
				logger.info('Batch operations completed successfully')
			} else {
				logger.info(`DRY RUN: Would execute batch operations: ${toDelete.length} deletes, ${toCreate.length} creates`)
			}
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
			managed: existingManagedRecords,
		}
	}
}

