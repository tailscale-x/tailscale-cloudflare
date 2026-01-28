'use server';

import { env } from 'cloudflare:workers';
import type { Env } from '../types/env';
import { getSettings, storeSettings } from '../utils/kv-storage';
import { createLogger } from '../utils/logger';
import { NamedCIDRList, namedCIDRListSchema } from '../types/task-based-settings';

const logger = createLogger();

/**
 * Save an individual CIDR list
 */
export async function saveCIDRListAction(list: NamedCIDRList) {
    try {
        const cfEnv = env as Env;
        const ownerId = cfEnv.DNS_RECORD_OWNER_ID;

        // Validate the list
        namedCIDRListSchema.parse(list);

        // Get existing settings
        const existing = await getSettings(cfEnv.CONFIG_KV, ownerId);
        const namedCIDRLists = [...(existing.namedCIDRLists || [])];

        const index = namedCIDRLists.findIndex((l) => l.name === list.name);
        if (index >= 0) {
            namedCIDRLists[index] = list;
        } else {
            namedCIDRLists.push(list);
        }

        // Store updated settings
        await storeSettings(cfEnv.CONFIG_KV, ownerId, {
            ...existing,
            namedCIDRLists,
        });

        logger.info(`CIDR list "${list.name}" saved successfully`);
        return { success: true };
    } catch (error) {
        logger.error('Failed to save CIDR list:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Delete an individual CIDR list
 */
export async function deleteCIDRListAction(name: string) {
    try {
        const cfEnv = env as Env;
        const ownerId = cfEnv.DNS_RECORD_OWNER_ID;

        // Get existing settings
        const existing = await getSettings(cfEnv.CONFIG_KV, ownerId);

        // Check if in use
        const { isCIDRListInUse } = await import('../utils/cidr-list-manager');
        if (isCIDRListInUse(name, existing.generationTasks || [])) {
            return {
                success: false,
                error: `Cannot delete CIDR list "${name}" - it is currently in use by tasks.`,
            };
        }

        const namedCIDRLists = (existing.namedCIDRLists || []).filter((l) => l.name !== name);

        // Store updated settings
        await storeSettings(cfEnv.CONFIG_KV, ownerId, {
            ...existing,
            namedCIDRLists,
        });

        logger.info(`CIDR list "${name}" deleted successfully`);
        return { success: true };
    } catch (error) {
        logger.error('Failed to delete CIDR list:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
