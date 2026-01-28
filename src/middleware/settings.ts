import type { Context, Next } from 'hono'
import type { Env } from '../types/env'
import type { TaskBasedSettings } from '../types/task-based-settings'
import { getSettings, validateTaskBasedSettings } from '../utils/kv-storage'
import { createLogger } from '../utils/logger'
import { ConfigurationError } from '../utils/errors'

const logger = createLogger()

export type SettingsVariables = {
    settings: TaskBasedSettings
    settingsError?: Error // Available if settings failed validation but we proceeded (e.g. for config UI)
}

export async function settingsMiddleware<
    T extends {
        Bindings: Env
        Variables?: Record<string, unknown>
    }
>(
    c: Context<T & { Variables: T['Variables'] & SettingsVariables }>,
    next: Next
) {
    // Default owner ID
    const ownerId = c.env.DNS_RECORD_OWNER_ID || 'default'

    try {
        const rawSettings = await getSettings(c.env.CONFIG_KV, ownerId)
        const parsedSettings = validateTaskBasedSettings(rawSettings)
        c.set('settings', parsedSettings)
        await next()
    } catch (error) {
        // If we are accessing the config UI, we want to allow proceeding even if settings are invalid
        // so the user can fix them.
        if (c.req.path.startsWith('/config') || c.req.path === '/api/config') {
            logger.warn('Settings validation failed, but proceeding for config UI', error)
            c.set('settingsError', error instanceof Error ? error : new Error(String(error)))
            await next()
            return
        }

        logger.error('Settings validation failed:', error)
        return c.json(
            {
                error: 'Configuration error',
                message: error instanceof Error ? error.message : String(error),
                details: error instanceof ConfigurationError ? error.message : undefined
            },
            500
        )
    }
}

