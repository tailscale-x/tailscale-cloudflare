import type { Context } from 'hono'
import type { AppContext } from '../types/app'
import type { TailscaleDevice, ClassifiedIPs, TailscaleACL } from '../types/tailscale'
import type { ValidatedEnv } from '../utils/env'
import { streamSSE } from 'hono/streaming'
import { TailscaleClient } from '../services/tailscale'
import { getIPsByType } from '../utils/ip-classifier'
import { createLogger } from '../utils/logger'

const logger = createLogger()

/**
 * Response structure for machines snapshot
 */
interface MachinesSnapshot {
	machines: Array<{
		device: TailscaleDevice
		classifiedIPs: ClassifiedIPs
	}>
	acl: TailscaleACL
}

/**
 * Fetches the machines snapshot (Tailscale devices and ACL)
 */
async function fetchMachinesSnapshot(env: ValidatedEnv): Promise<MachinesSnapshot> {
	const tailscaleClient = new TailscaleClient({
		apiKey: env.TAILSCALE_API_KEY,
		tailnet: env.TAILSCALE_TAILNET,
		lanCidrRanges: env.LAN_CIDR_RANGES,
	})

	logger.info('Fetching Tailscale machines snapshot')

	// Fetch all Tailscale devices
	logger.info('Fetching Tailscale devices')
	const devices = await tailscaleClient.getDevices()
	logger.info(`Retrieved ${devices.length} Tailscale devices`)

	// Process each device to classify IPs
	const tailscaleMachines = devices.map(device => {
		const classifiedIPs = getIPsByType(device, env.LAN_CIDR_RANGES)

		return {
			device,
			classifiedIPs,
		}
	})

	logger.info(`Processed ${tailscaleMachines.length} Tailscale machines`)

	// Fetch Tailscale ACL configuration
	logger.info('Fetching Tailscale ACL configuration')
	const tailscaleACL = await tailscaleClient.getACL()
	logger.info(`Retrieved ACL with ${Object.keys(tailscaleACL.hosts || {}).length} host entries`)

	return {
		machines: tailscaleMachines,
		acl: tailscaleACL,
	}
}


/**
 * Handles GET /api/config endpoint
 * Returns Server-Sent Events (SSE) stream with periodic configuration snapshots
 */
export async function handleConfig(
	c: Context<AppContext>
): Promise<Response> {
	try {
		const env = c.get('validatedEnv')
		
		// Get interval from environment (default to 30 seconds)
		let intervalMs = env.CONFIG_SSE_INTERVAL_MS 
			? parseInt(env.CONFIG_SSE_INTERVAL_MS, 10) 
			: 30000

		if (isNaN(intervalMs) || intervalMs < 1000) {
			logger.warn(`Invalid CONFIG_SSE_INTERVAL_MS value, using default 30000ms`)
			intervalMs = 30000
		}

		logger.info(`Starting SSE stream for /api/config with interval ${intervalMs}ms`)

		// Use Hono's streamSSE for Server-Sent Events
		return streamSSE(c, async (stream) => {
			let isActive = true
			let snapshotId = 0
			let intervalId: ReturnType<typeof setInterval> | null = null

			// Function to clean up resources
			const cleanup = () => {
				if (intervalId !== null) {
					clearInterval(intervalId)
					intervalId = null
					logger.info('SSE stream interval cleared')
				}
			}

			// Clean up on client disconnect
			c.req.raw.signal.addEventListener('abort', () => {
				isActive = false
				cleanup()
				logger.info('SSE stream closed by client')
			})

			// Send initial connection message
			await stream.writeSSE({
				event: 'connected',
				data: JSON.stringify({ message: 'SSE stream established' }),
				id: String(snapshotId++),
			})

			// Function to send machines snapshot
			const sendSnapshots = async () => {
				if (!isActive) return

				// Fetch machines snapshot
				fetchMachinesSnapshot(env)
					.then(result => {
						if (!isActive) return
						stream.writeSSE({
							event: 'machines-snapshot',
							data: JSON.stringify(result),
							id: String(snapshotId++),
						})
						logger.info(`Sent machines snapshot via SSE (id: ${snapshotId - 1})`)
					})
					.catch(error => {
						if (!isActive) return
						logger.error('Error fetching machines snapshot:', error)
						stream.writeSSE({
							event: 'error',
							data: JSON.stringify({
								event: 'machines-snapshot',
								message: error instanceof Error ? error.message : String(error),
							}),
							id: String(snapshotId++),
						})
					})
			}

			// Send initial snapshots immediately
			await sendSnapshots()

			// Set up periodic updates
			intervalId = setInterval(async () => {
				if (isActive) {
					await sendSnapshots()
				} else {
					cleanup()
				}
			}, intervalMs)

			// Keep the stream alive until client disconnects
			// Wait for the abort signal - this keeps the async function running
			await new Promise<void>((resolve) => {
				// If already aborted, resolve immediately
				if (c.req.raw.signal.aborted) {
					isActive = false
					cleanup()
					resolve()
					return
				}

				// Wait for abort signal
				c.req.raw.signal.addEventListener('abort', () => {
					isActive = false
					cleanup()
					resolve()
				})
			})
		})
	} catch (error) {
		logger.error('Config handler error:', error)
		return c.json(
			{
				error: 'Internal server error',
				message: error instanceof Error ? error.message : String(error),
			},
			500
		)
	}
}
