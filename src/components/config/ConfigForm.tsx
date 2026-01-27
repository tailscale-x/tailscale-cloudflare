'use client';

import { useState, useTransition, type FormEvent, type ChangeEvent } from 'react';
import { FormInput, FormSection, Message } from './FormComponents';
import { saveConfigAction } from '../../actions';

interface Settings {
    TAILSCALE_API_KEY?: string;
    TAILSCALE_TAILNET?: string;
    CLOUDFLARE_API_TOKEN?: string;
    DOMAIN_FOR_TAILSCALE_ENDPOINT?: string;
    DOMAIN_FOR_WAN_ENDPOINT?: string;
    DOMAIN_FOR_LAN_ENDPOINT?: string;
    LAN_CIDR_RANGES?: string[];
    TAILSCALE_TAG_LAN_REGEX?: string;
    TAILSCALE_TAG_TAILSCALE_REGEX?: string;
    TAILSCALE_TAG_WAN_NO_PROXY_REGEX?: string;
    TAILSCALE_TAG_WAN_PROXY_REGEX?: string;
}

interface ConfigFormProps {
    initialSettings: Partial<Settings>;
}

export function ConfigForm({ initialSettings }: ConfigFormProps) {
    const [formData, setFormData] = useState({
        TAILSCALE_API_KEY: initialSettings.TAILSCALE_API_KEY || '',
        TAILSCALE_TAILNET: initialSettings.TAILSCALE_TAILNET || '',
        CLOUDFLARE_API_TOKEN: initialSettings.CLOUDFLARE_API_TOKEN || '',
        DOMAIN_FOR_TAILSCALE_ENDPOINT: initialSettings.DOMAIN_FOR_TAILSCALE_ENDPOINT || '',
        DOMAIN_FOR_WAN_ENDPOINT: initialSettings.DOMAIN_FOR_WAN_ENDPOINT || '',
        DOMAIN_FOR_LAN_ENDPOINT: initialSettings.DOMAIN_FOR_LAN_ENDPOINT || '',
        LAN_CIDR_RANGES: Array.isArray(initialSettings.LAN_CIDR_RANGES)
            ? initialSettings.LAN_CIDR_RANGES.join(', ')
            : '',
        TAILSCALE_TAG_LAN_REGEX: initialSettings.TAILSCALE_TAG_LAN_REGEX || '',
        TAILSCALE_TAG_TAILSCALE_REGEX: initialSettings.TAILSCALE_TAG_TAILSCALE_REGEX || '',
        TAILSCALE_TAG_WAN_NO_PROXY_REGEX: initialSettings.TAILSCALE_TAG_WAN_NO_PROXY_REGEX || '',
        TAILSCALE_TAG_WAN_PROXY_REGEX: initialSettings.TAILSCALE_TAG_WAN_PROXY_REGEX || '',
    });

    const [isPending, startTransition] = useTransition();
    const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle');
    const [message, setMessage] = useState('');

    const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
        setFormData((prev) => ({
            ...prev,
            [e.target.name]: e.target.value,
        }));
    };

    const handleSubmit = async (e: FormEvent) => {
        e.preventDefault();
        setMessage('');

        startTransition(async () => {
            const result = await saveConfigAction({
                ...formData,
                LAN_CIDR_RANGES: formData.LAN_CIDR_RANGES.split(',').map((s) => s.trim()).filter(Boolean),
            });

            if (result.success) {
                setStatus('success');
                setMessage(result.message || 'Settings saved successfully!');
            } else {
                setStatus('error');
                setMessage(result.error || 'Failed to save settings');
            }
        });
    };

    return (
        <form onSubmit={handleSubmit}>
            <FormSection title="API Credentials">
                <FormInput
                    label="Tailscale API Key"
                    name="TAILSCALE_API_KEY"
                    type="password"
                    value={formData.TAILSCALE_API_KEY}
                    onChange={handleChange}
                    required={!initialSettings.TAILSCALE_API_KEY}
                    helpText={
                        <>
                            Get from:{' '}
                            <a href="https://login.tailscale.com/admin/settings/keys" target="_blank" rel="noopener noreferrer">
                                Tailscale Admin Console
                            </a>
                            . Starts with <code>tskey-api-</code>
                        </>
                    }
                />
                <FormInput
                    label="Tailscale Tailnet"
                    name="TAILSCALE_TAILNET"
                    value={formData.TAILSCALE_TAILNET}
                    onChange={handleChange}
                    required
                    helpText="Your Tailscale tailnet identifier (e.g., 'example.tailscale.com')"
                />
                <FormInput
                    label="Cloudflare API Token"
                    name="CLOUDFLARE_API_TOKEN"
                    type="password"
                    value={formData.CLOUDFLARE_API_TOKEN}
                    onChange={handleChange}
                    required={!initialSettings.CLOUDFLARE_API_TOKEN}
                    helpText={
                        <>
                            Get from:{' '}
                            <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noopener noreferrer">
                                Cloudflare Dashboard
                            </a>
                            . Create token with Zone → DNS → Edit permissions.
                        </>
                    }
                />
            </FormSection>

            <FormSection
                title="Domain Configuration"
                description="Configure the domains where DNS records will be created."
            >
                <FormInput
                    label="Domain for Tailscale Endpoint"
                    name="DOMAIN_FOR_TAILSCALE_ENDPOINT"
                    value={formData.DOMAIN_FOR_TAILSCALE_ENDPOINT}
                    onChange={handleChange}
                    required
                    helpText="Domain where Tailscale IP records will be created (e.g., 'ts.example.com')"
                />
                <FormInput
                    label="Domain for WAN Endpoint"
                    name="DOMAIN_FOR_WAN_ENDPOINT"
                    value={formData.DOMAIN_FOR_WAN_ENDPOINT}
                    onChange={handleChange}
                    required
                    helpText="Domain where WAN (public IP) records will be created (e.g., 'wan.example.com')"
                />
                <FormInput
                    label="Domain for LAN Endpoint"
                    name="DOMAIN_FOR_LAN_ENDPOINT"
                    value={formData.DOMAIN_FOR_LAN_ENDPOINT}
                    onChange={handleChange}
                    required
                    helpText="Domain where LAN (private IP) records will be created (e.g., 'lan.example.com')"
                />
            </FormSection>

            <FormSection title="Network Configuration">
                <FormInput
                    label="LAN CIDR Ranges"
                    name="LAN_CIDR_RANGES"
                    value={formData.LAN_CIDR_RANGES}
                    onChange={handleChange}
                    required
                    placeholder="10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16"
                    helpText={
                        <>
                            Comma-separated CIDR ranges. <strong>Order matters</strong>: first matching range is chosen.
                        </>
                    }
                />
            </FormSection>

            <FormSection
                title="Tag Filtering (Regex Patterns)"
                description="Use regular expressions to determine which devices get DNS records."
            >
                <FormInput
                    label="LAN Tag Regex"
                    name="TAILSCALE_TAG_LAN_REGEX"
                    value={formData.TAILSCALE_TAG_LAN_REGEX}
                    onChange={handleChange}
                    required
                    placeholder="^tag:lan"
                    helpText={<>Devices matching this pattern get LAN records. Example: <code>^tag:lan</code></>}
                />
                <FormInput
                    label="Tailscale Tag Regex"
                    name="TAILSCALE_TAG_TAILSCALE_REGEX"
                    value={formData.TAILSCALE_TAG_TAILSCALE_REGEX}
                    onChange={handleChange}
                    required
                    placeholder="^tag:ts"
                    helpText={<>Devices matching this pattern get Tailscale records. Example: <code>^tag:ts</code></>}
                />
                <FormInput
                    label="WAN No-Proxy Tag Regex"
                    name="TAILSCALE_TAG_WAN_NO_PROXY_REGEX"
                    value={formData.TAILSCALE_TAG_WAN_NO_PROXY_REGEX}
                    onChange={handleChange}
                    required
                    placeholder="^tag:wan"
                    helpText={<>WAN records with Cloudflare proxy <strong>disabled</strong>.</>}
                />
                <FormInput
                    label="WAN Proxy Tag Regex"
                    name="TAILSCALE_TAG_WAN_PROXY_REGEX"
                    value={formData.TAILSCALE_TAG_WAN_PROXY_REGEX}
                    onChange={handleChange}
                    required
                    placeholder="^tag:proxy"
                    helpText={<>WAN records with Cloudflare proxy <strong>enabled</strong>.</>}
                />
            </FormSection>

            <button type="submit" disabled={isPending}>
                {isPending ? 'Saving...' : 'Save Configuration'}
            </button>

            {(status === 'success' || status === 'error') && (
                <Message type={status} message={message} />
            )}
        </form>
    );
}
