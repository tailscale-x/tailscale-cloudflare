import type { TailscaleDevice, TailscaleDevicesResponse } from '../types/tailscale'
import { ApiError } from '../utils/errors'

export interface TailscaleClientConfig {
    clientId: string
    clientSecret: string
    tailnet: string
}

export interface CreatedAuthKey {
    id: string
    key: string
    expires: string
}

export class TailscaleClient {
    private token: { value: string; expiresAt: number } | undefined
    private readonly baseUrl = 'https://api.tailscale.com/api/v2'

    constructor(private readonly config: TailscaleClientConfig) {}

    private async accessToken(): Promise<string> {
        if (this.token && this.token.expiresAt - Date.now() > 60_000) return this.token.value
        const body = new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: this.config.clientId,
            client_secret: this.config.clientSecret,
        })
        const response = await fetch(`${this.baseUrl}/oauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        })
        if (!response.ok) throw new ApiError(`Tailscale OAuth token request failed: HTTP ${response.status}`, 'Tailscale', response.status)
        const result = await response.json() as { access_token?: string; expires_in?: number }
        if (!result.access_token) throw new Error('Tailscale OAuth response has no access token')
        this.token = { value: result.access_token, expiresAt: Date.now() + (result.expires_in ?? 3600) * 1000 }
        return this.token.value
    }

    private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
        const send = async () => fetch(`${this.baseUrl}${path}`, {
            ...init,
            headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json', ...init.headers },
        })
        let response = await send()
        if (response.status === 401) {
            this.token = undefined
            response = await send()
        }
        if (!response.ok) {
            const detail = await response.text()
            throw new ApiError(`Tailscale API error: HTTP ${response.status}: ${detail.slice(0, 500)}`, 'Tailscale', response.status)
        }
        if (response.status === 204) return undefined as T
        return response.json() as Promise<T>
    }

    private tailnetPath(suffix: string): string {
        return `/tailnet/${encodeURIComponent(this.config.tailnet)}/${suffix}`
    }

    async getDevices(): Promise<TailscaleDevice[]> {
        const result = await this.request<TailscaleDevicesResponse | TailscaleDevice[]>(this.tailnetPath('devices?fields=all'))
        return Array.isArray(result) ? result : result.devices ?? []
    }

    async createAuthKey(tags: string[], description: string): Promise<CreatedAuthKey> {
        return this.request<CreatedAuthKey>(this.tailnetPath('keys'), {
            method: 'POST',
            body: JSON.stringify({
                capabilities: { devices: { create: { reusable: false, ephemeral: false, preauthorized: false, tags } } },
                expirySeconds: 86400,
                description,
            }),
        })
    }

    async revokeAuthKey(id: string): Promise<void> {
        await this.request<void>(this.tailnetPath(`keys/${encodeURIComponent(id)}`), { method: 'DELETE' })
    }
}
