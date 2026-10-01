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
