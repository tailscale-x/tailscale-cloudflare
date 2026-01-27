import { env } from 'cloudflare:workers';
import type { Env } from '../types/env';
import { TailscaleMachineSyncService } from '../services/tailscale-machine-sync';
import { createLogger } from '../utils/logger';
import { setupWebhookWithKv } from '../services/tailscale-webhook-manager';
import { getSetting, getSettings, validateSettings } from '../utils/kv-storage';

const logger = createLogger();

/**
 * Handles scheduled cron jobs for full DNS synchronization
 * Also verifies and creates webhook if webhook URL is stored in KV
 */
export async function handleScheduled(event: ScheduledEvent): Promise<void> {
	try {
		const cfEnv = env as Env;
		logger.info(`Cron job triggered: ${event.cron}`);

		const ownerId = cfEnv.DNS_RECORD_OWNER_ID || 'cloudflare-tailscale-dns';

		// Load settings manually since we are not in HTTP context
		const rawSettings = await getSettings(cfEnv.CONFIG_KV, ownerId);
		const settings = validateSettings(rawSettings);

		// Verify and create webhook if webhook URL is stored in KV
		const webhookUrl = await getSetting(cfEnv.CONFIG_KV, ownerId, 'webhookUrl');
		if (webhookUrl) {
			try {
				logger.info(`Verifying Tailscale webhook configuration for: ${webhookUrl}`);
				await setupWebhookWithKv(settings, cfEnv.CONFIG_KV, webhookUrl, ownerId);
			} catch (webhookError) {
				// Log webhook error but don't fail the cron job
				logger.error('Webhook verification failed (continuing with DNS sync):', webhookError);
			}
		} else {
			logger.info(
				'Webhook URL not found in KV. Skipping webhook verification. Visit GET /webhook to set up the webhook URL.'
			);
		}

		// Perform full DNS sync
		await TailscaleMachineSyncService.performSync(settings, ownerId);
		logger.info('Cron job completed successfully');
	} catch (error) {
		logger.error('Cron job error:', error);
		throw error;
	}
}
