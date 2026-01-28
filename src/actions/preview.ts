'use server';

import { env } from 'cloudflare:workers';
import type { Env } from '../types/env';
import { getSettings } from '../utils/kv-storage';
import { createLogger } from '../utils/logger';

const logger = createLogger();

/**
 * Preview machines matching a selector
 */


/**
 * Fetch all Tailscale devices for UI autocomplete
 */
export async function getTailscaleDevicesAction() {
    try {
        const cfEnv = env as Env;
        const ownerId = cfEnv.DNS_RECORD_OWNER_ID;

        // Load settings to get Tailscale credentials
        const rawSettings = await getSettings(cfEnv.CONFIG_KV, ownerId) as any;
        const apiKey = rawSettings.TAILSCALE_API_KEY;
        const tailnet = rawSettings.TAILSCALE_TAILNET;

        if (!apiKey || !tailnet) {
            return {
                success: false,
                devices: [],
                error: 'Tailscale credentials not configured.',
            };
        }

        // Fetch Tailscale devices
        const { TailscaleClient } = await import('../services/tailscale-client');
        const tsClient = new TailscaleClient({
            apiKey,
            tailnet,
        });
        const devices = await tsClient.getDevices();

        return {
            success: true,
            devices,
        };
    } catch (error) {
        logger.error('Get devices error via Server Action:', error);
        return {
            success: false,
            devices: [],
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
