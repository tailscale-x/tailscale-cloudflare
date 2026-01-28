// Tailscale API Client

import type {
	TailscaleDevice,
	TailscaleDevicesResponse,
	TailscaleACL,
	TailscaleWebhook,
	TailscaleWebhooksResponse,
	CreateTailscaleWebhookRequest,
	UpdateTailscaleWebhookRequest,
	TailscaleWebhookEventType,
} from '../types/tailscale'

import { createLogger } from '../utils/logger'
import { ApiError } from '../utils/errors'
import { parse as parseJsonc } from 'jsonc-parser'

const logger = createLogger()

/**
 * Required webhook event subscriptions for DNS sync
 */
export const REQUIRED_WEBHOOK_SUBSCRIPTIONS: TailscaleWebhookEventType[] = [
	'nodeCreated',
	'nodeDeleted',
]

export interface TailscaleClientConfig {
	apiKey: string
	tailnet: string
}

export class TailscaleClient {
	private apiKey: string
	private tailnet: string
	private baseUrl = 'https://api.tailscale.com/api/v2'

	constructor(config: TailscaleClientConfig) {
		this.apiKey = config.apiKey
		this.tailnet = config.tailnet
	}

	private async request<T>(
		endpoint: string,
		options?: {
			jsonc?: boolean
			method?: string
			body?: unknown
		}
	): Promise<T> {
		const url = `${this.baseUrl}${endpoint}`
		const method = options?.method || 'GET'
		const headers: HeadersInit = {
			'Authorization': `Bearer ${this.apiKey}`,
			'Content-Type': 'application/json',
		}

		const fetchOptions: RequestInit = {
			method,
			headers,
		}

		if (options?.body && (method === 'POST' || method === 'PATCH')) {
			fetchOptions.body = JSON.stringify(options.body)
		}

		const response = await fetch(url, fetchOptions)

		if (!response.ok) {
			const errorText = await response.text()
			const error = new ApiError(
				`Tailscale API error: ${response.status} ${response.statusText} - ${errorText}`,
				'Tailscale',
				response.status
			)
			logger.error(`Tailscale API request failed: ${endpoint}`, error)
			throw error
		}

		// Handle empty responses (e.g., DELETE, some POST responses)
		if (response.status === 204 || response.status === 202) {
			return {} as T
		}

		// Handle JSONC (JSON with Comments) if requested
		if (options?.jsonc) {
			const jsoncText = await response.text()
			const parsed = parseJsonc(jsoncText) as T
			logger.debug(`JSONC parsed: ${JSON.stringify(parsed)}`)
			return parsed
		}

		return response.json()
	}

	/**
	 * Fetch all devices from Tailscale
	 * Requests all fields to ensure clientConnectivity (with endpoints) is included.
	 * Fields actually used: id, name, addresses, clientConnectivity.endpoints
	 */
	async getDevices(): Promise<TailscaleDevice[]> {
		// Use fields=all to get clientConnectivity.endpoints which is not in the default field set
		// Tailscale API only supports fields=all or fields=default, not comma-separated field names
		const endpoint = `/tailnet/${this.tailnet}/devices?fields=all`
		logger.info(`Fetching devices from Tailscale API: ${endpoint}`)
		const response = await this.request<TailscaleDevicesResponse | TailscaleDevice[]>(endpoint)

		// Log the full raw response for debugging
		logger.debug(`Tailscale API response (raw): ${JSON.stringify(response, null, 2)}`)

		// Handle both array response and object with devices property
		const devices = Array.isArray(response) ? response : (response.devices || [])
		logger.info(`Retrieved ${devices.length} devices from Tailscale`)

		// Log each device's structure for debugging
		for (const device of devices) {
			logger.debug(`Device ${device.id} (${device.name || 'unnamed'}): ${JSON.stringify(device, null, 2)}`)
		}

		return devices
	}



	/**
	 * Fetch ACL configuration from the tailnet
	 * Returns the ACL JSON including hosts field
	 * Note: Tailscale ACL API returns JSONC (JSON with Comments), so we need to strip comments
	 */
	async getACL(): Promise<TailscaleACL> {
		const endpoint = `/tailnet/${this.tailnet}/acl`
		logger.info(`Fetching ACL from Tailscale API: ${endpoint}`)
		const acl = await this.request<TailscaleACL>(endpoint, { jsonc: true })
		logger.info(`Retrieved ACL with ${Object.keys(acl.hosts || {}).length} host entries`)
		return acl
	}

	/**
	 * List all webhooks for the tailnet
	 */
	async listWebhooks(): Promise<TailscaleWebhook[]> {
		const endpoint = `/tailnet/${this.tailnet}/webhooks`
		logger.info(`Fetching webhooks from Tailscale API: ${endpoint}`)
		const response = await this.request<TailscaleWebhooksResponse>(endpoint)
		logger.info(`Retrieved ${response.webhooks?.length || 0} webhooks`)
		return response.webhooks || []
	}

	/**
	 * Get a specific webhook by endpoint ID
	 */
	async getWebhook(endpointId: string): Promise<TailscaleWebhook> {
		const endpoint = `/webhooks/${endpointId}`
		logger.info(`Fetching webhook ${endpointId} from Tailscale API: ${endpoint}`)
		return await this.request<TailscaleWebhook>(endpoint)
	}

	/**
	 * Create a new webhook
	 * Returns the created webhook including the secret (only available on creation)
	 */
	async createWebhook(request: CreateTailscaleWebhookRequest): Promise<TailscaleWebhook> {
		const endpoint = `/tailnet/${this.tailnet}/webhooks`
		logger.info(`Creating webhook in Tailscale API: ${endpoint}`)
		logger.debug(`Webhook request: ${JSON.stringify({ ...request, subscriptions: request.subscriptions })}`)
		const webhook = await this.request<TailscaleWebhook>(endpoint, {
			method: 'POST',
			body: request,
		})
		logger.info(`Created webhook ${webhook.endpointId} for URL: ${webhook.endpointUrl}`)
		return webhook
	}

	/**
	 * Update a webhook (e.g., subscriptions)
	 */
	async updateWebhook(endpointId: string, request: UpdateTailscaleWebhookRequest): Promise<TailscaleWebhook> {
		const endpoint = `/webhooks/${endpointId}`
		logger.info(`Updating webhook ${endpointId} in Tailscale API: ${endpoint}`)
		logger.debug(`Webhook update request: ${JSON.stringify(request)}`)
		const webhook = await this.request<TailscaleWebhook>(endpoint, {
			method: 'PATCH',
			body: request,
		})
		logger.info(`Updated webhook ${endpointId}`)
		return webhook
	}

	/**
	 * Delete a webhook
	 */
	async deleteWebhook(endpointId: string): Promise<void> {
		const endpoint = `/webhooks/${endpointId}`
		logger.info(`Deleting webhook ${endpointId} from Tailscale API: ${endpoint}`)
		await this.request<void>(endpoint, { method: 'DELETE' })
		logger.info(`Deleted webhook ${endpointId}`)
	}
}
