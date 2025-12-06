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
import { createLogger } from '../utils/logger'
import { ApiError } from '../utils/errors'

const logger = createLogger()

export interface CloudflareClientConfig {
	apiToken: string
	zoneId: string
}

export class CloudflareClient {
	private client: Cloudflare
	private zoneId: string

	constructor(config: CloudflareClientConfig) {
		this.client = new Cloudflare({
			apiToken: config.apiToken,
		})
		this.zoneId = config.zoneId
	}

	/**
	 * Get existing DNS records filtered by comment (exact ownership prefix match)
	 * Searches for records that start with a specific ownership comment pattern
	 * This allows server-side filtering without needing client-side validation
	 */
	async getExistingRecordsByComment(commentPrefix: string): Promise<RecordResponse[]> {
		const params: RecordListParams = {
			zone_id: this.zoneId,
			per_page: 1000, // Max per page
			comment: {
				startswith: commentPrefix, // Case-insensitive prefix match
			},
		}

		const records: RecordResponse[] = []
		// Iterate over items directly (auto-pagination)
		for await (const record of this.client.dns.records.list(params)) {
			records.push(record)
		}

		logger.info(`Retrieved ${records.length} managed DNS records from Cloudflare`)
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

		const batchParams: RecordBatchParams = {
			zone_id: this.zoneId,
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
	 */
	async batchDeleteRecords(recordIds: string[]): Promise<void> {
		if (recordIds.length === 0) {
			return
		}

		const batchParams: RecordBatchParams = {
			zone_id: this.zoneId,
			deletes: recordIds.map(id => ({ id })),
		}

		try {
			await this.client.dns.records.batch(batchParams)
			logger.info(`Successfully deleted ${recordIds.length} DNS records`)
		} catch (error) {
			logger.error(`Failed to delete ${recordIds.length} DNS records:`, error)
			if (error instanceof ApiError) {
				throw error
			}
			throw new ApiError(
				`Failed to delete DNS records: ${error instanceof Error ? error.message : String(error)}`,
				'Cloudflare'
			)
		}
	}

	/**
	 * Batch operation: delete and create records in a single atomic operation
	 */
	async batchDeleteAndCreate(
		recordIdsToDelete: string[],
		recordsToCreate: (ARecordParam | AAAARecordParam | CNAMERecordParam | TXTRecordParam)[]
	): Promise<void> {
		// If no operations, return early
		if (recordIdsToDelete.length === 0 && recordsToCreate.length === 0) {
			return
		}

		const batchParams: RecordBatchParams = {
			zone_id: this.zoneId,
		}

		if (recordIdsToDelete.length > 0) {
			batchParams.deletes = recordIdsToDelete.map(id => ({ id }))
		}

		if (recordsToCreate.length > 0) {
			batchParams.posts = recordsToCreate
		}

		try {
			await this.client.dns.records.batch(batchParams)
			logger.info(`Batch operation completed: ${recordIdsToDelete.length} deletes, ${recordsToCreate.length} creates`)
		} catch (error) {
			logger.error(`Batch operation failed: ${recordIdsToDelete.length} deletes, ${recordsToCreate.length} creates:`, error)
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
