// Tailscale API Types

export interface TailscaleDevice {
	id: string
	name?: string // "pangolin.tailfe8c.ts.net"
	hostname?: string // "pangolin"
	tags?: string[]
	addresses?: string[] // Tailscale IP addresses
	clientConnectivity?: {
		endpoints?: string[] // Client's magicsock UDP IP:port endpoints (IPv4 or IPv6)
		[key: string]: unknown // Allow other clientConnectivity fields
	}
	authorized?: boolean
	user?: string
	created?: string
	lastSeen?: string
	expires?: string
	keyExpiryDisabled?: boolean
}

export interface TailscaleDevicesResponse {
	devices: TailscaleDevice[]
}

export interface TailscaleWebhookEvent {
	version: string
	event: 'nodeAdded' | 'nodeDeleted' | 'nodeUpdated'
	timestamp: string
	node: TailscaleDevice
}


export interface TailscaleACL {
	hosts?: Record<string, string> // Map of host aliases to IP addresses
	[key: string]: unknown // Allow other ACL fields
}

export type TailscaleWebhookEventType =
	| 'nodeCreated'
	| 'nodeNeedsApproval'
	| 'nodeApproved'
	| 'nodeKeyExpiringInOneDay'
	| 'nodeKeyExpired'
	| 'nodeDeleted'
	| 'nodeSigned'
	| 'nodeNeedsSignature'
	| 'policyUpdate'
	| 'userCreated'
	| 'userNeedsApproval'
	| 'userSuspended'
	| 'userRestored'
	| 'userDeleted'
	| 'userApproved'
	| 'userRoleUpdated'
	| 'subnetIPForwardingNotEnabled'
	| 'exitNodeIPForwardingNotEnabled'

export interface TailscaleWebhook {
	endpointId: string
	endpointUrl: string
	providerType?: 'slack' | 'mattermost' | 'googlechat' | 'discord' | ''
	creatorLoginName?: string
	created?: string
	lastModified?: string
	subscriptions: TailscaleWebhookEventType[]
	secret?: string // Only populated on creation or rotation
}

export interface TailscaleWebhooksResponse {
	webhooks: TailscaleWebhook[]
}

export interface CreateTailscaleWebhookRequest {
	endpointUrl: string
	providerType?: 'slack' | 'mattermost' | 'googlechat' | 'discord' | ''
	subscriptions: TailscaleWebhookEventType[]
}

export interface UpdateTailscaleWebhookRequest {
	subscriptions?: TailscaleWebhookEventType[]
}
