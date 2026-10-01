'use server';

import { env } from 'cloudflare:workers';
import type { Env } from '../types/env';
import { getSettings } from '../utils/kv-storage';
import { TailscaleClient } from '../services/tailscale-client';
import { gatewayJoinInputSchema } from '../utils/gateway-join-input';

interface StoredJoinKey {
    id: string;
    machineName: string;
    gatewayHostname: string;
    tags: string[];
    expires: string;
}

function client(cfEnv: Env, tailnet: string): TailscaleClient {
    if (!cfEnv.TAILSCALE_OAUTH_CLIENT_ID || !cfEnv.TAILSCALE_OAUTH_CLIENT_SECRET) {
        throw new Error('Tailscale OAuth Wrangler secrets are not configured');
    }
    return new TailscaleClient({
        clientId: cfEnv.TAILSCALE_OAUTH_CLIENT_ID,
        clientSecret: cfEnv.TAILSCALE_OAUTH_CLIENT_SECRET,
        tailnet,
    });
}

function key(ownerId: string): string { return `${ownerId}/gateway-join-key`; }

export async function getGatewayProvisioningAction() {
    try {
        const cfEnv = env as Env;
        const stored = await cfEnv.CONFIG_KV.get(key(cfEnv.DNS_RECORD_OWNER_ID));
        return { success: true, gateway: stored ? JSON.parse(stored) as StoredJoinKey : null };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
}

export async function createGatewayJoinKeyAction(input: unknown) {
    try {
        const parsed = gatewayJoinInputSchema.parse(input);
        const cfEnv = env as Env;
        const settings = await getSettings(cfEnv.CONFIG_KV, cfEnv.DNS_RECORD_OWNER_ID);
        if (!settings.TAILSCALE_TAILNET) throw new Error('Set the tailnet on the Credentials page first');
        const ts = client(cfEnv, settings.TAILSCALE_TAILNET);
        const previous = await cfEnv.CONFIG_KV.get(key(cfEnv.DNS_RECORD_OWNER_ID));
        if (previous) {
            const old = JSON.parse(previous) as StoredJoinKey;
            try { await ts.revokeAuthKey(old.id); } catch (error) {
                // A one-use key disappears after it is used. Other failures must be reported.
                if (!(error instanceof Error && /HTTP 404/.test(error.message))) throw error;
            }
        }
        const created = await ts.createAuthKey([...new Set(parsed.tags)], `Gateway ${parsed.machineName}`);
        if (!created.id || !created.key) throw new Error('Tailscale returned an incomplete auth key');
        const gateway: StoredJoinKey = { id: created.id, machineName: parsed.machineName,
            gatewayHostname: parsed.gatewayHostname, tags: parsed.tags, expires: created.expires };
        try { await cfEnv.CONFIG_KV.put(key(cfEnv.DNS_RECORD_OWNER_ID), JSON.stringify(gateway)); }
        catch (error) { await ts.revokeAuthKey(created.id); throw error; }
        return { success: true, gateway, joinKey: created.key };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
}

export async function revokeGatewayJoinKeyAction() {
    try {
        const cfEnv = env as Env;
        const stored = await cfEnv.CONFIG_KV.get(key(cfEnv.DNS_RECORD_OWNER_ID));
        if (!stored) return { success: true };
        const existing = JSON.parse(stored) as StoredJoinKey;
        const settings = await getSettings(cfEnv.CONFIG_KV, cfEnv.DNS_RECORD_OWNER_ID);
        if (!settings.TAILSCALE_TAILNET) throw new Error('Tailnet is not configured');
        try { await client(cfEnv, settings.TAILSCALE_TAILNET).revokeAuthKey(existing.id); }
        catch (error) {
            if (!(error instanceof Error && /HTTP 404/.test(error.message))) throw error;
        }
        await cfEnv.CONFIG_KV.delete(key(cfEnv.DNS_RECORD_OWNER_ID));
        return { success: true };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
}
