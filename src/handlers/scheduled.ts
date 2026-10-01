import { env } from 'cloudflare:workers';
import type { Env } from '../types/env';
import { TaskBasedDNSService } from '../services/task-based-dns-service';
import { createLogger } from '../utils/logger';
import { getSettings, validateTaskBasedSettings } from '../utils/kv-storage';

const logger = createLogger();

/**
 * Handles scheduled cron jobs for full DNS synchronization
 */
export async function handleScheduled(event: ScheduledEvent): Promise<void> {
	try {
		const cfEnv = env as Env;
		logger.info(`Cron job triggered: ${event.cron}`);

		const ownerId = cfEnv.DNS_RECORD_OWNER_ID;

		// Load settings manually since we are not in HTTP context
		const rawSettings = await getSettings(cfEnv.CONFIG_KV, ownerId);
		const settings = validateTaskBasedSettings(rawSettings);

		// Perform full DNS sync
		await TaskBasedDNSService.performSync(settings, ownerId, false, {
			clientId: cfEnv.TAILSCALE_OAUTH_CLIENT_ID ?? '',
			clientSecret: cfEnv.TAILSCALE_OAUTH_CLIENT_SECRET ?? '',
		});
		logger.info('Cron job completed successfully');
	} catch (error) {
		logger.error('Cron job error:', error);
		throw error;
	}
}
