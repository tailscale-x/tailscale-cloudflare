import { TailscaleClient } from '../services/tailscale-client'
import { CloudflareClient } from '../services/cloudflare'
import { TailscaleMachineSyncService, type SyncResult } from '../services/tailscale-machine-sync'
import { createLogger } from './logger'

const logger = createLogger()

/**
 * Creates and configures all necessary clients for DNS synchronization
 * Automatically looks up zone ID from domain configuration
 */
export async function createTailscaleMachineSyncService(
	tailscaleApiKey: string,
	tailscaleTailnet: string,
	cloudflareApiToken: string,
	tsDomain: string,
	wanDomain: string,
	lanDomain: string,
	ownerId: string,
	lanTagRegex: RegExp,
	tailscaleTagRegex: RegExp,
	wanNoProxyTagRegex: RegExp,
	wanProxyTagRegex: RegExp,
	lanCidrRanges: string[]
): Promise<TailscaleMachineSyncService> {
	const tailscaleClient = new TailscaleClient({
		apiKey: tailscaleApiKey,
		tailnet: tailscaleTailnet,
		lanCidrRanges,
	})

	const cloudflareClient = new CloudflareClient({
		apiToken: cloudflareApiToken,
	})

	logger.info(`Creating DNS sync service with owner ID: ${ownerId}`)
	logger.info(`LAN tag regex: ${lanTagRegex.source}`)
	logger.info(`Tailscale tag regex: ${tailscaleTagRegex.source}`)
	logger.info(`WAN no-proxy tag regex: ${wanNoProxyTagRegex.source}`)
	logger.info(`WAN proxy tag regex: ${wanProxyTagRegex.source}`)

	return new TailscaleMachineSyncService({
		tailscaleClient,
		cloudflareClient,
		tsDomain,
		wanDomain,
		lanDomain,
		ownerId,
		lanTagRegex,
		tailscaleTagRegex,
		wanNoProxyTagRegex,
		wanProxyTagRegex,
		lanCidrRanges,
	})
}

/**
 * Performs a full DNS synchronization of all machines
 * This is a convenience function that creates the service and runs syncAllMachines()
 */
export async function performDnsSync(
	tailscaleApiKey: string,
	tailscaleTailnet: string,
	cloudflareApiToken: string,
	tsDomain: string,
	wanDomain: string,
	lanDomain: string,
	ownerId: string,
	lanTagRegex: RegExp,
	tailscaleTagRegex: RegExp,
	wanNoProxyTagRegex: RegExp,
	wanProxyTagRegex: RegExp,
	lanCidrRanges: string[]
): Promise<SyncResult> {
	const tailscaleMachineSync = await createTailscaleMachineSyncService(
		tailscaleApiKey,
		tailscaleTailnet,
		cloudflareApiToken,
		tsDomain,
		wanDomain,
		lanDomain,
		ownerId,
		lanTagRegex,
		tailscaleTagRegex,
		wanNoProxyTagRegex,
		wanProxyTagRegex,
		lanCidrRanges
	)
	return await tailscaleMachineSync.syncAllMachines()
}
