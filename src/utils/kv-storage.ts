import { z } from 'zod'
import { createLogger } from './logger'
import { ConfigurationError } from './errors'
import { taskBasedSettingsSchema, TaskBasedSettings } from '../types/task-based-settings'

const logger = createLogger()

/**
 * Keys that should never be returned to the browser in plaintext
 */
export const SENSITIVE_KEYS: (keyof TaskBasedSettings)[] = [
	'TAILSCALE_API_KEY',
	'CLOUDFLARE_API_TOKEN',
	'webhookSecret'
]

/**
 * Mask a secret value with a fake value of the same length
 */
export function maskSecret(value: string | undefined): string {
	if (!value) return ''
	return '*'.repeat(value.length)
}

/**
 * Check if a value is a masked secret
 */
export function isMasked(value: string | undefined): boolean {
	if (!value) return false
	return value.length > 0 && /^\*+$/.test(value)
}


/**
 * Get the settings key for a given owner ID
 */
function getSettingsKey(ownerId: string): string {
	return `${ownerId}/settings`
}

/**
 * Get all settings from KV
 */
export async function getSettings(kv: KVNamespace, ownerId: string): Promise<Partial<TaskBasedSettings>> {
	try {
		const key = getSettingsKey(ownerId)
		const data = await kv.get(key)
		if (data) {
			const settings = JSON.parse(data) as TaskBasedSettings
			logger.debug(`Retrieved settings from KV for owner: ${ownerId}`)
			return settings
		}
		return {}
	} catch (error) {
		logger.error(`Error retrieving settings from KV for owner ${ownerId}:`, error)
		return {}
	}
}

/**
 * Store all settings in KV
 */
export async function storeSettings(kv: KVNamespace, ownerId: string, settings: Partial<TaskBasedSettings>): Promise<void> {
	try {
		const key = getSettingsKey(ownerId)
		const data = JSON.stringify(settings)
		await kv.put(key, data)
		logger.info(`Stored settings in KV for owner: ${ownerId}`)
	} catch (error) {
		logger.error(`Error storing settings in KV for owner ${ownerId}:`, error)
		throw error
	}
}

/**
 * Update specific setting fields in KV (merges with existing settings)
 */
export async function updateSettings(
	kv: KVNamespace,
	ownerId: string,
	updates: Partial<TaskBasedSettings>
): Promise<void> {
	try {
		// Get existing settings
		const existing = await getSettings(kv, ownerId)

		// Merge with updates
		const merged: Partial<TaskBasedSettings> = {
			...existing,
			...updates,
		}

		// Store merged settings
		await storeSettings(kv, ownerId, merged)
		logger.debug(`Updated settings in KV for owner: ${ownerId}`, updates)
	} catch (error) {
		logger.error(`Error updating settings in KV for owner ${ownerId}:`, error)
		throw error
	}
}

/**
 * Get a specific setting field from KV
 */
export async function getSetting<K extends keyof TaskBasedSettings>(
	kv: KVNamespace,
	ownerId: string,
	key: K
): Promise<TaskBasedSettings[K] | null> {
	const settings = await getSettings(kv, ownerId)
	return settings[key] ?? null
}

/**
 * Set a specific setting field in KV
 */
export async function setSetting<K extends keyof TaskBasedSettings>(
	kv: KVNamespace,
	ownerId: string,
	key: K,
	value: TaskBasedSettings[K]
): Promise<void> {
	await updateSettings(kv, ownerId, { [key]: value } as Partial<TaskBasedSettings>)
}

// ============================================================================
// Task-Based Settings Support
// ============================================================================

/**
 * Validate task-based settings
 */
export function validateTaskBasedSettings(settings: unknown): TaskBasedSettings {
	try {
		const parsed = taskBasedSettingsSchema.parse(settings)
		return parsed
	} catch (error) {
		if (error instanceof z.ZodError) {
			const errors = error.issues.map((issue) => {
				const path = issue.path.join('.')
				return `${path}: ${issue.message}`
			}).join('\n')
			const validationError = new ConfigurationError(`Task-based settings validation failed:\n${errors}`)
			logger.error('Task-based settings validation failed:', validationError)
			throw validationError
		}
		throw error
	}
}

/**
 * Mask sensitive fields in task-based settings for UI display
 */
export function maskTaskBasedSettings(settings: Partial<TaskBasedSettings>): Partial<TaskBasedSettings> {
	const masked = { ...settings }

	for (const key of SENSITIVE_KEYS) {
		if (masked[key]) {
			masked[key] = maskSecret(masked[key] as string) as any
		}
	}

	return masked
}

