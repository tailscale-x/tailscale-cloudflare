import { env } from 'cloudflare:workers';
import type { Env } from '../types/env';
import { getSettings } from '../utils/kv-storage';
import { ConfigForm } from '../components/config/ConfigForm';
import './config.css';

export default async function ConfigPage() {
    const cfEnv = env as Env;
    const ownerId = cfEnv.DNS_RECORD_OWNER_ID;

    // Load current settings (may be partial/invalid)
    const currentSettings = await getSettings(cfEnv.CONFIG_KV, ownerId);

    // Mask sensitive fields before sending to the browser
    const { maskSecret, SENSITIVE_KEYS } = await import('../utils/kv-storage');
    const maskedSettings = { ...currentSettings } as any;
    for (const key of SENSITIVE_KEYS) {
        const val = maskedSettings[key];
        if (typeof val === 'string') {
            maskedSettings[key] = maskSecret(val);
        }
    }

    return (
        <div className="config-container">
            <title>Configuration - Tailscale Cloudflare DNS Sync</title>
            <meta name="description" content="Configure your DNS synchronization settings" />

            <h1>Tailscale-Cloudflare DNS Sync Configuration</h1>
            <p className="intro">
                Configure all settings for your DNS synchronization service. All fields marked with{' '}
                <span className="required">*</span> are required.
            </p>

            <ConfigForm initialSettings={maskedSettings} />
        </div>
    );
}

export const getConfig = async () => {
    return {
        render: 'dynamic',
    } as const;
};
