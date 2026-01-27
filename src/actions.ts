'use server';

import { env } from 'cloudflare:workers';
import type { Env } from './types/env';
import { updateSettings, validateSettings } from './utils/kv-storage';
import { TailscaleMachineSyncService } from './services/tailscale-machine-sync';
import { createLogger } from './utils/logger';
import type { Settings } from './types/settings';

const logger = createLogger();

export async function saveConfigAction(formData: Partial<Settings>) {
    try {
        const cfEnv = env as Env;
        const ownerId = cfEnv.DNS_RECORD_OWNER_ID;

        // Validate settings (throws if invalid)
        validateSettings(formData);

        // Filter out masked values so we don't overwrite secrets with '****'
        const { isMasked } = await import('./utils/kv-storage');
        const updates = { ...formData };
        for (const key in updates) {
            const val = updates[key as keyof Settings];
            if (typeof val === 'string' && isMasked(val)) {
                delete updates[key as keyof Settings];
            }
        }

        // Update settings in KV
        await updateSettings(cfEnv.CONFIG_KV, ownerId, updates);

        logger.info('Settings updated successfully via Server Action');
        return { success: true, message: 'Settings have been successfully updated.' };
    } catch (error) {
        logger.error('Failed to update settings via Server Action:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

export async function manualSyncAction() {
    try {
        const cfEnv = env as Env;
        const ownerId = cfEnv.DNS_RECORD_OWNER_ID;

        // Load and validate settings
        const { getSettings } = await import('./utils/kv-storage');
        const rawSettings = await getSettings(cfEnv.CONFIG_KV, ownerId);
        const settings = validateSettings(rawSettings);

        // Perform full DNS sync
        const result = await TailscaleMachineSyncService.performSync(settings, ownerId);

        logger.info('Manual DNS synchronization completed successfully via Server Action');
        return {
            success: true,
            message: 'Full DNS synchronization completed successfully',
            sync: {
                added: result.added,
                deleted: result.deleted,
                summary: result.summary,
                managed: result.managed,
            },
        };
    } catch (error) {
        logger.error('Manual sync error via Server Action:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

export async function getSyncStatusAction() {
    try {
        const cfEnv = env as Env;
        const ownerId = cfEnv.DNS_RECORD_OWNER_ID;

        // Load and validate settings
        const { getSettings } = await import('./utils/kv-storage');
        const rawSettings = await getSettings(cfEnv.CONFIG_KV, ownerId);
        const settings = validateSettings(rawSettings);

        // Perform dry-run sync to get status
        const result = await TailscaleMachineSyncService.performSync(settings, ownerId, true);

        return {
            success: true,
            sync: result,
        };
    } catch (error) {
        logger.error('Get sync status error via Server Action:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
