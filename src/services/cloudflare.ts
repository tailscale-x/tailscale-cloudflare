// Cloudflare DNS API Client

import Cloudflare from 'cloudflare'
import type {
	RecordResponse,
	ARecordParam,
	AAAARecordParam,
	CNAMERecordParam,
	TXTRecordParam,
	RecordBatchParams,
	RecordListParams,
} from 'cloudflare/resources/dns/records'
import { MemoizeExpiring } from 'typescript-memoize'
import { createLogger } from '../utils/logger'
import { ApiError } from '../utils/errors'

const logger = createLogger()
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

export interface CloudflareClientConfig {
	apiToken: string
}

export class CloudflareClient {
	private client: Cloudflare

	constructor(config: CloudflareClientConfig) {
		this.client = new Cloudflare({
			apiToken: config.apiToken,
		})
	}

	/**
	 * Check if a zone name is a postfix match for a domain
	 * Example: "example.com" matches "ts.example.com" (postfix match)
	 */
	private isZonePostfixMatch(domain: string, zoneName: string): boolean {
		const domainLower = domain.toLowerCase().replace(/\.$/, '') // Remove trailing dot
		const zoneLower = zoneName.toLowerCase().replace(/\.$/, '')

		// Exact match
		if (domainLower === zoneLower) {
			return true
		}

		// Postfix match: zone name must be a suffix of domain
		// e.g., "example.com" is a postfix of "ts.example.com"
		return domainLower.endsWith('.' + zoneLower)
	}

	/**
	 * Normalize domain for consistent cache keys
	 */
	private normalizeDomain(domain: string): string {
		return domain.trim().replace(/\.$/, '').toLowerCase()
	}

	/**
	 * Fetch zones with TTL cache to avoid repeated listings
	 */
	@MemoizeExpiring(CACHE_TTL_MS)
	private async getZones(): Promise<{ id: string; name: string }[]> {
		// Fetch fresh data
		const zones: { id: string; name: string }[] = []
		for await (const zone of this.client.zones.list()) {
			zones.push({ id: zone.id, name: zone.name })
		}

		return zones
	}

	/**
	 * Get zone ID from a domain name (with TTL cache)
	 */
	@MemoizeExpiring(CACHE_TTL_MS)
	private async getZoneIdFromDomain(domain: string): Promise<string> {
		if (!domain || domain.trim() === '') {
			throw new ApiError(
				`Invalid domain: ${domain}`,
				'Cloudflare',
				400
			)
		}

		const normalizedDomain = this.normalizeDomain(domain)
		logger.info(`Looking up zone ID for domain: ${normalizedDomain}`)

		try {
			// Use cached zones list and find the best postfix match
			// Prefer longer (more specific) matches
			let foundZone: { id: string; name: string; length: number } | null = null

			for (const zone of await this.getZones()) {
				if (this.isZonePostfixMatch(normalizedDomain, zone.name)) {
					// Prefer the longest matching zone (most specific)
					if (!foundZone || zone.name.length > foundZone.length) {
						foundZone = { id: zone.id, name: zone.name, length: zone.name.length }
					}
				}
			}

			if (!foundZone) {
				throw new ApiError(
					`Zone not found for domain: ${normalizedDomain}. Please ensure the domain is added to your Cloudflare account.`,
					'Cloudflare',
					404
				)
			}

			logger.info(`Found zone ID: ${foundZone.id} for domain: ${foundZone.name} (matched ${normalizedDomain})`)

			return foundZone.id
		} catch (error) {
			if (error instanceof ApiError) {
				throw error
			}
			logger.error('Error looking up zone ID:', error)
			throw new ApiError(
				`Failed to lookup zone ID: ${error instanceof Error ? error.message : String(error)}`,
				'Cloudflare',
				500
			)
		}
	}

	/**
	 * Get existing DNS records filtered by comment (exact ownership prefix match)
	 * Searches for records that start with a specific ownership comment pattern across all zones
	 * This allows server-side filtering without needing client-side validation
	 */
	async getExistingRecordsByComment(commentPrefix: string): Promise<RecordResponse[]> {
		const records: RecordResponse[] = []

		// Search across all zones
		for (const zone of await this.getZones()) {
			const params: RecordListParams = {
				zone_id: zone.id,
				per_page: 1000, // Max per page
				comment: {
					startswith: commentPrefix, // Case-insensitive prefix match
				},
			}

			// Iterate over items directly (auto-pagination)
			for await (const record of this.client.dns.records.list(params)) {
				records.push(record)
			}
		}

		logger.info(`Retrieved ${records.length} managed DNS records from Cloudflare across all zones`)
		return records
	}

	/**
	 * Batch create DNS records
	 */
	async batchCreateRecords(
		records: (ARecordParam | AAAARecordParam | CNAMERecordParam | TXTRecordParam)[]
	): Promise<void> {
		if (records.length === 0) {
			return
		}

		// Extract zone ID from first record's name (all records should be in same zone)
		const firstRecord = records[0]
		if (!firstRecord) {
			return
		}
		const zoneId = await this.getZoneIdFromDomain(firstRecord.name)

		const batchParams: RecordBatchParams = {
			zone_id: zoneId,
			posts: records,
		}

		try {
			await this.client.dns.records.batch(batchParams)
			logger.info(`Successfully created ${records.length} DNS records`)
		} catch (error) {
			logger.error(`Failed to create ${records.length} DNS records:`, error)
			if (error instanceof ApiError) {
				throw error
			}
			throw new ApiError(
				`Failed to create DNS records: ${error instanceof Error ? error.message : String(error)}`,
				'Cloudflare'
			)
		}
	}

	/**
	 * Batch delete DNS records by IDs
	 * Records must be grouped by zone ID since batch operations require a single zone
	 */
	async batchDeleteRecords(records: RecordResponse[]): Promise<void> {
		// Delegate to unified batch delete/create handler
		await this.batchDeleteAndCreate(records, [])
	}

	/**
	 * Batch operation: delete and create records in a single atomic operation
	 * Records to delete must be grouped by zone ID since batch operations require a single zone
	 */
	async batchDeleteAndCreate(
		recordsToDelete: RecordResponse[],
		recordsToCreate: (ARecordParam | AAAARecordParam | CNAMERecordParam | TXTRecordParam)[]
	): Promise<void> {
		// If no operations, return early
		if (recordsToDelete.length === 0 && recordsToCreate.length === 0) {
			return
		}

		// Resolve zone IDs for deletes and creates, then group using native groupBy
		const deletions: { zoneId: string; id: string }[] = []
		for (const record of recordsToDelete) {
			if (!record.name || !record.id) {
				logger.warn(`Record ${record.id} missing name or id, skipping delete`)
				continue
			}
			const zoneId = await this.getZoneIdFromDomain(record.name)
			if (!zoneId) {
				logger.warn(`Zone not found for record ${record.id}, skipping delete`)
				continue
			}
			deletions.push({ zoneId, id: record.id })
		}

		const creations: { zoneId: string; record: ARecordParam | AAAARecordParam | CNAMERecordParam | TXTRecordParam }[] = []
		for (const record of recordsToCreate) {
			const zoneId = await this.getZoneIdFromDomain(record.name)
			if (zoneId) {
				creations.push({ zoneId, record })
			}
		}

		const deletesByZone = Object.groupBy(deletions, (item: { zoneId: string; id: string }) => item.zoneId)
		const createsByZone = Object.groupBy(
			creations,
			(item: { zoneId: string; record: ARecordParam | AAAARecordParam | CNAMERecordParam | TXTRecordParam }) => item.zoneId
		)

		const zoneIds = new Set([...Object.keys(deletesByZone), ...Object.keys(createsByZone)])

		// Execute batch operations per zone
		for (const zoneId of zoneIds) {
			const deleteItems = deletesByZone[zoneId] ?? []
			const createItems = createsByZone[zoneId] ?? []

			if (deleteItems.length === 0 && createItems.length === 0) {
				continue
			}

			const batchParams: RecordBatchParams = {
				zone_id: zoneId,
			}

			if (deleteItems.length > 0) {
				batchParams.deletes = deleteItems.map(item => ({ id: item.id }))
			}

			if (createItems.length > 0) {
				batchParams.posts = createItems.map(item => item.record)
			}

			try {
				await this.client.dns.records.batch(batchParams)
				logger.info(`Batch operation completed for zone ${zoneId}: ${deleteItems.length} deletes, ${createItems.length} creates`)
			} catch (error) {
				logger.error(`Batch operation failed for zone ${zoneId}: ${deleteItems.length} deletes, ${createItems.length} creates:`, error)
				if (error instanceof ApiError) {
					throw error
				}
				throw new ApiError(
					`Batch operation failed: ${error instanceof Error ? error.message : String(error)}`,
					'Cloudflare'
				)
			}
		}
	}
}
