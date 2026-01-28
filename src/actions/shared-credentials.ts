'use server';

import { env } from 'cloudflare:workers';
import type { Env } from '../types/env';
import { getSettings, storeSettings } from '../utils/kv-storage';
import { createLogger } from '../utils/logger';
import type { SharedCredentials } from '../types/shared-credentials';
import { SharedCredentialsSchema, extractSharedCredentials, SHARED_CREDENTIALS_SENSITIVE_KEYS } from '../types/shared-credentials';

const logger = createLogger();

/**
 * Get shared credentials (used by both legacy and task-based configs)
 */
export async function getSharedCredentialsAction() {
    try {
        const cfEnv = env as Env;
        const ownerId = cfEnv.DNS_RECORD_OWNER_ID;

        // Load raw settings from KV
        const rawSettings = await getSettings(cfEnv.CONFIG_KV, ownerId);

        // Extract shared credentials
        const credentials = extractSharedCredentials(rawSettings);

        // Mask sensitive fields
        const maskedCredentials: Partial<SharedCredentials> = {};
        for (const key in credentials) {
            const value = credentials[key as keyof SharedCredentials];
            if (SHARED_CREDENTIALS_SENSITIVE_KEYS.includes(key as keyof SharedCredentials) && value) {
                maskedCredentials[key as keyof SharedCredentials] = '********' as any;
            } else {
                maskedCredentials[key as keyof SharedCredentials] = value as any;
            }
        }

        return {
            success: true,
            credentials: maskedCredentials,
        };
    } catch (error) {
        logger.error('Get shared credentials error via Server Action:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Save shared credentials (updates both legacy and task-based configs)
 */
export async function saveSharedCredentialsAction(formData: Partial<SharedCredentials>) {
    try {
        const cfEnv = env as Env;
        const ownerId = cfEnv.DNS_RECORD_OWNER_ID;

        // Load existing settings
        const existingSettings = await getSettings(cfEnv.CONFIG_KV, ownerId);

        // Merge formData with existing to preserve masked values
        const mergedCredentials: SharedCredentials = {
            TAILSCALE_API_KEY:
                formData.TAILSCALE_API_KEY === '********'
                    ? existingSettings.TAILSCALE_API_KEY || ''
                    : formData.TAILSCALE_API_KEY || '',
            TAILSCALE_TAILNET: formData.TAILSCALE_TAILNET || '',
            CLOUDFLARE_API_TOKEN:
                formData.CLOUDFLARE_API_TOKEN === '********'
                    ? existingSettings.CLOUDFLARE_API_TOKEN || ''
                    : formData.CLOUDFLARE_API_TOKEN || '',
        };

        // Validate credentials
        const validationResult = SharedCredentialsSchema.safeParse(mergedCredentials);
        if (!validationResult.success) {
            const errors = validationResult.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
            return {
                success: false,
                error: `Validation failed: ${errors.join(', ')}`,
            };
        }

        // Update existing settings with new credentials
        const updatedSettings = {
            ...existingSettings,
            ...mergedCredentials,
        };

        // Save back to KV
        await storeSettings(cfEnv.CONFIG_KV, ownerId, updatedSettings);

        return {
            success: true,
        };
    } catch (error) {
        logger.error('Save shared credentials error via Server Action:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
