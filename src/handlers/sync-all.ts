import type { Context } from 'hono'
import type { AppContext } from '../types/app'
import { createTailscaleMachineSyncService } from '../utils/client-factory'
import { createLogger } from '../utils/logger'

const logger = createLogger()

/**
 * Handles GET /syncAll endpoint for manual full DNS synchronization
 */
export async function handleSyncAll(
	c: Context<AppContext>
): Promise<Response> {
	try {
		const env = c.get('validatedEnv')
		
		// Initialize DNS sync service
		const tailscaleMachineSync = createTailscaleMachineSyncService(env)

		// Perform full sync
		const result = await tailscaleMachineSync.syncAllMachines()
		
		logger.info('Full DNS synchronization completed successfully')
		return c.json({ 
			success: true, 
			message: 'Full DNS synchronization completed successfully',
			added: result.added,
			deleted: result.deleted,
			summary: result.summary,
		})
	} catch (error) {
		logger.error('SyncAll error:', error)
		return c.json(
			{
				error: 'Internal server error',
				message: error instanceof Error ? error.message : String(error),
			},
			500
		)
	}
}

