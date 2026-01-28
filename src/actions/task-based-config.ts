'use server';

import { env } from 'cloudflare:workers';
import type { Env } from '../types/env';
import {
    getSettings, storeSettings,
    maskTaskBasedSettings, isMasked, validateTaskBasedSettings
} from '../utils/kv-storage';
import { TaskBasedDNSService } from '../services/task-based-dns-service';
import { createLogger } from '../utils/logger';
import { TaskBasedSettings, GenerationTask } from '../types/task-based-settings';

const logger = createLogger();

/**
 * Save task-based configuration
 */
export async function saveTaskBasedConfigAction(formData: Partial<TaskBasedSettings>) {
    try {
        const cfEnv = env as Env;
        const ownerId = cfEnv.DNS_RECORD_OWNER_ID;

        // Get existing settings to preserve values
        const existing = await getSettings(cfEnv.CONFIG_KV, ownerId);

        // Filter out masked values
        const updates = { ...formData };
        for (const key in updates) {
            const val = updates[key as keyof TaskBasedSettings];
            if (typeof val === 'string' && isMasked(val)) {
                // Preserve existing value
                if (existing[key as keyof TaskBasedSettings]) {
                    (updates as any)[key] = existing[key as keyof TaskBasedSettings];
                } else {
                    delete updates[key as keyof TaskBasedSettings];
                }
            }
        }

        // Merge with existing settings
        const merged = {
            ...existing,
            ...updates
        };

        // Validate merged settings and use the result (which includes defaults)
        const validated = validateTaskBasedSettings(merged);

        // Store settings in KV
        await storeSettings(cfEnv.CONFIG_KV, ownerId, validated);

        logger.info('Task-based settings updated successfully via Server Action');
        return { success: true };
    } catch (error) {
        logger.error('Failed to update task-based settings via Server Action:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Get task-based configuration for display in UI
 */
export async function getTaskBasedConfigAction() {
    try {
        const cfEnv = env as Env;
        const ownerId = cfEnv.DNS_RECORD_OWNER_ID;

        // Load settings from KV
        const rawSettings = await getSettings(cfEnv.CONFIG_KV, ownerId);

        // If empty, return default structure
        const settings: Partial<TaskBasedSettings> = {
            TAILSCALE_API_KEY: rawSettings.TAILSCALE_API_KEY || '',
            CLOUDFLARE_API_TOKEN: rawSettings.CLOUDFLARE_API_TOKEN || '',
            TAILSCALE_TAILNET: rawSettings.TAILSCALE_TAILNET || '',
            namedCIDRLists: rawSettings.namedCIDRLists || [],
            generationTasks: rawSettings.generationTasks || [],
            webhookUrl: rawSettings.webhookUrl || '',
            webhookSecret: rawSettings.webhookSecret || '',
        };

        // Mask sensitive fields
        const masked = maskTaskBasedSettings(settings);

        return {
            success: true,
            settings: masked,
        };
    } catch (error) {
        logger.error('Failed to get task-based config via Server Action:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Perform manual sync using task-based configuration
 */
export async function taskBasedManualSyncAction() {
    try {
        const cfEnv = env as Env;
        const ownerId = cfEnv.DNS_RECORD_OWNER_ID;

        // Load and validate settings
        const rawSettings = await getSettings(cfEnv.CONFIG_KV, ownerId);
        const settings = validateTaskBasedSettings(rawSettings);

        // Perform full DNS sync
        const result = await TaskBasedDNSService.performSync(settings, ownerId);

        logger.info('Task-based manual DNS synchronization completed successfully via Server Action');
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
        logger.error('Task-based manual sync error via Server Action:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Get sync status using task-based configuration
 */
export async function taskBasedSyncStatusAction() {
    try {
        const cfEnv = env as Env;
        const ownerId = cfEnv.DNS_RECORD_OWNER_ID;

        // Load and validate settings
        const rawSettings = await getSettings(cfEnv.CONFIG_KV, ownerId);
        const settings = validateTaskBasedSettings(rawSettings);

        // Perform dry-run sync to get status
        const result = await TaskBasedDNSService.performSync(settings, ownerId, true);

        return {
            success: true,
            sync: result,
        };
    } catch (error) {
        logger.error('Get task-based sync status error via Server Action:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Save an individual generation task
 */
export async function saveGenerationTaskAction(task: GenerationTask) {
    try {
        const cfEnv = env as Env;
        const ownerId = cfEnv.DNS_RECORD_OWNER_ID;

        // Load existing settings
        const existing = await getSettings(cfEnv.CONFIG_KV, ownerId);

        // Find existing task or append new one
        const tasks = [...(existing.generationTasks || [])];
        const existingIndex = tasks.findIndex(t => t.id === task.id);

        if (existingIndex !== -1) {
            tasks[existingIndex] = task;
        } else {
            tasks.push(task);
        }

        const updatedSettings = {
            ...existing,
            generationTasks: tasks
        };

        // Validate and use the result (which includes defaults)
        const validatedSettings = validateTaskBasedSettings(updatedSettings);

        // Store
        await storeSettings(cfEnv.CONFIG_KV, ownerId, validatedSettings);

        logger.info(`Generation task "${task.name}" saved successfully`);
        return { success: true };
    } catch (error) {
        logger.error('Failed to save generation task:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Delete an individual generation task
 */
export async function deleteGenerationTaskAction(taskId: string) {
    try {
        const cfEnv = env as Env;
        const ownerId = cfEnv.DNS_RECORD_OWNER_ID;

        // Load existing settings
        const existing = await getSettings(cfEnv.CONFIG_KV, ownerId);

        // Filter out the task
        const tasks = (existing.generationTasks || []).filter(t => t.id !== taskId);

        const updatedSettings = {
            ...existing,
            generationTasks: tasks
        };

        // Validate and use the result (which includes defaults)
        const validatedSettings = validateTaskBasedSettings(updatedSettings);

        // Store
        await storeSettings(cfEnv.CONFIG_KV, ownerId, validatedSettings);

        logger.info(`Generation task "${taskId}" deleted successfully`);
        return { success: true };
    } catch (error) {
        logger.error('Failed to delete generation task:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
