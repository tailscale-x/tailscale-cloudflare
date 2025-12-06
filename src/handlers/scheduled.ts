import type { ValidatedEnv } from '../utils/env'
import { createTailscaleMachineSyncService } from '../utils/client-factory'
import { createLogger } from '../utils/logger'

const logger = createLogger()

/**
 * Handles scheduled cron jobs for full DNS synchronization
 */
export async function handleScheduled(
	event: ScheduledEvent,
	env: ValidatedEnv,
	ctx: ExecutionContext
): Promise<void> {
	try {
		logger.info(`Cron job triggered: ${event.cron}`)

		// Initialize DNS sync service
		const tailscaleMachineSync = createTailscaleMachineSyncService(env)

		// Perform full sync
		await tailscaleMachineSync.syncAllMachines()
		logger.info('Cron job completed successfully')
	} catch (error) {
		logger.error('Cron job error:', error)
		throw error
	}
}
