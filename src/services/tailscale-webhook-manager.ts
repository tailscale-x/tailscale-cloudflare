// Webhook Manager Service

import type { TailscaleClient } from './tailscale-client'
import type { TailscaleWebhook, TailscaleWebhookEventType } from '../types/tailscale'
import { createLogger } from '../utils/logger'
import type { ParsedSettings } from '../types/settings'
import { TailscaleClient as TailscaleClientClass, REQUIRED_WEBHOOK_SUBSCRIPTIONS } from './tailscale-client'
import { setSetting } from '../utils/kv-storage'

const logger = createLogger()

export interface WebhookManagerConfig {
	tailscaleClient: TailscaleClient
	workerUrl: string
	requiredSubscriptions: TailscaleWebhookEventType[]
}

export interface WebhookManagerResult {
	webhook: TailscaleWebhook | null
	created: boolean
	updated: boolean
	secret?: string
	message: string
}

/**
 * Manages Tailscale webhook creation and verification
 */
export class WebhookManager {
	private tailscaleClient: TailscaleClient
	private workerUrl: string
	private requiredSubscriptions: TailscaleWebhookEventType[]

	constructor(config: WebhookManagerConfig) {
		this.tailscaleClient = config.tailscaleClient
		this.workerUrl = config.workerUrl
		this.requiredSubscriptions = config.requiredSubscriptions
	}

	/**
	 * Ensures a webhook exists for the worker URL with the required subscriptions
	 * Returns the webhook and whether it was created or updated
	 */
	async ensureWebhook(): Promise<WebhookManagerResult> {
		try {
			// Normalize worker URL (remove trailing slash, ensure /webhook path)
			const normalizedUrl = this.normalizeWebhookUrl(this.workerUrl)
			logger.info(`Ensuring webhook exists for URL: ${normalizedUrl}`)

			// List all existing webhooks
			const existingWebhooks = await this.tailscaleClient.listWebhooks()
			logger.info(`Found ${existingWebhooks.length} existing webhooks`)

			// Find webhook matching our URL
			const matchingWebhook = existingWebhooks.find(
				(webhook) => this.normalizeWebhookUrl(webhook.endpointUrl) === normalizedUrl
			)

			if (matchingWebhook) {
				logger.info(`Found existing webhook ${matchingWebhook.endpointId} for URL: ${normalizedUrl}`)

				// Check if subscriptions need to be updated
				const currentSubs = new Set(matchingWebhook.subscriptions || [])
				const requiredSubs = new Set(this.requiredSubscriptions)
				const needsUpdate = !this.requiredSubscriptions.every((sub) => currentSubs.has(sub))

				if (needsUpdate) {
					logger.info(
						`Updating webhook ${matchingWebhook.endpointId} subscriptions from [${Array.from(currentSubs).join(', ')}] to [${Array.from(requiredSubs).join(', ')}]`
					)
					const updated = await this.tailscaleClient.updateWebhook(matchingWebhook.endpointId, {
						subscriptions: this.requiredSubscriptions,
					})
					return {
						webhook: updated,
						created: false,
						updated: true,
						message: `Webhook ${matchingWebhook.endpointId} updated with required subscriptions`,
					}
				}

				return {
					webhook: matchingWebhook,
					created: false,
					updated: false,
					message: `Webhook ${matchingWebhook.endpointId} already exists and is up to date`,
				}
			}

			// Create new webhook
			logger.info(`Creating new webhook for URL: ${normalizedUrl}`)
			const newWebhook = await this.tailscaleClient.createWebhook({
				endpointUrl: normalizedUrl,
				subscriptions: this.requiredSubscriptions,
			})

			if (!newWebhook.secret) {
				logger.warn(`Webhook ${newWebhook.endpointId} created but secret was not returned`)
			} else {
				logger.info(`Webhook ${newWebhook.endpointId} created with secret (length: ${newWebhook.secret.length})`)
			}

			return {
				webhook: newWebhook,
				created: true,
				updated: false,
				secret: newWebhook.secret,
				message: `Webhook ${newWebhook.endpointId} created successfully. Secret will be automatically stored in KV.`,
			}
		} catch (error) {
			logger.error('Error ensuring webhook:', error)
			throw error
		}
	}

	/**
	 * Normalizes webhook URL for comparison
	 * - Removes trailing slashes
	 * - Ensures /webhook path is present
	 */
	private normalizeWebhookUrl(url: string): string {
		let normalized = url.trim()
		// Remove trailing slash
		normalized = normalized.replace(/\/$/, '')
		// Ensure /webhook path
		if (!normalized.endsWith('/webhook')) {
			normalized = `${normalized}/webhook`
		}
		return normalized
	}
}

/**
 * Result of webhook setup with KV storage
 */
export interface WebhookSetupResult {
	result: WebhookManagerResult
	secretStored: boolean
}

/**
 * Sets up and verifies a Tailscale webhook, storing the secret in KV if provided
 * This is a convenience function that handles the full webhook setup flow
 */
export async function setupWebhookWithKv(
	settings: ParsedSettings,
	kv: KVNamespace,
	webhookUrl: string,
	ownerId: string
): Promise<WebhookSetupResult> {
	logger.info(`Setting up Tailscale webhook for: ${webhookUrl}`)

	const tailscaleClient = new TailscaleClientClass({
		apiKey: settings.TAILSCALE_API_KEY,
		tailnet: settings.TAILSCALE_TAILNET,
		lanCidrRanges: settings.LAN_CIDR_RANGES,
	})

	const webhookManager = new WebhookManager({
		tailscaleClient,
		workerUrl: webhookUrl,
		requiredSubscriptions: REQUIRED_WEBHOOK_SUBSCRIPTIONS,
	})

	const result = await webhookManager.ensureWebhook()
	logger.info(`Webhook setup: ${result.message}`)

	// Store webhook secret in KV if provided
	let secretStored = false
	if (result.secret) {
		await setSetting(kv, ownerId, 'webhookSecret', result.secret)
		logger.info('Webhook secret stored in KV')
		secretStored = true
	} else if (result.created) {
		logger.warn(
			'⚠️  NEW WEBHOOK CREATED: Secret was not returned. You may need to manually retrieve it from Tailscale Admin Console.'
		)
	}

	return {
		result,
		secretStored,
	}
}

