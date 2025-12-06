// Tailscale API Client

import type { TailscaleDevice, TailscaleDevicesResponse, ClassifiedIPs } from '../types/tailscale'
import { getIPsByType } from '../utils/ip-classifier'
import { createLogger } from '../utils/logger'
import { ApiError } from '../utils/errors'

const logger = createLogger()

export interface TailscaleClientConfig {
	apiKey: string
	tailnet: string
	lanCidrRanges: string[]
}

export class TailscaleClient {
	private apiKey: string
	private tailnet: string
	private baseUrl = 'https://api.tailscale.com/api/v2'
	private lanCidrRanges: string[]

	constructor(config: TailscaleClientConfig) {
		this.apiKey = config.apiKey
		this.tailnet = config.tailnet
		this.lanCidrRanges = config.lanCidrRanges
	}

	private async request<T>(endpoint: string): Promise<T> {
		const url = `${this.baseUrl}${endpoint}`
		const response = await fetch(url, {
			headers: {
				'Authorization': `Bearer ${this.apiKey}`,
				'Content-Type': 'application/json',
			},
		})

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
	 * Get a specific device by ID
	 */
	async getDeviceById(id: string): Promise<TailscaleDevice | null> {
		const devices = await this.getDevices()
		return devices.find(d => d.id === id) || null
	}

	/**
	 * Classify endpoints from a device and return IPs by type
	 */
	classifyEndpoints(device: TailscaleDevice): ClassifiedIPs {
		return getIPsByType(device, this.lanCidrRanges)
	}
}
