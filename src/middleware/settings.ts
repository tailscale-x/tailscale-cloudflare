import type { Context, Next } from 'hono'
import type { Env } from '../types/env'
import type { ParsedSettings } from '../types/settings'
import { getSettings, validateSettings } from '../utils/kv-storage'
import { createLogger } from '../utils/logger'
import { ConfigurationError } from '../utils/errors'

const logger = createLogger()

export type SettingsVariables = {
    settings: ParsedSettings
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
        const parsedSettings = validateSettings(rawSettings)
        c.set('settings', parsedSettings)
        await next()
    } catch (error) {
        // If we are accessing the config UI, we want to allow proceeding even if settings are invalid
        // so the user can fix them.
        if (c.req.path.startsWith('/config') || c.req.path === '/api/config') {
            logger.warn('Settings validation failed, but proceeding for config UI', error)
            // We can't set 'settings' to ParsedSettings if it failed. 
            // Ideally 'settings' would be optional or nullable in the type?
            // But existing code expects ValidatedEnv (which we rename to Settings) to be present.
            // We will handle this by casing in the config handler.
            // Here we just set the error.
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
