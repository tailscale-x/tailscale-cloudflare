'use client'

import { useState } from 'react'
import type { SharedCredentials } from '../../types/shared-credentials'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Section } from '../common/Section'
import { FormField } from '../common/FormField'

interface CredentialsFormProps {
    initialCredentials?: Partial<SharedCredentials>
    onSave: (credentials: SharedCredentials) => Promise<{ success: boolean; error?: string }>
}

export function CredentialsForm({ initialCredentials = {}, onSave }: CredentialsFormProps) {
    const [credentials, setCredentials] = useState<SharedCredentials>({
        TAILSCALE_API_KEY: initialCredentials.TAILSCALE_API_KEY || '',
        TAILSCALE_TAILNET: initialCredentials.TAILSCALE_TAILNET || '',
        CLOUDFLARE_API_TOKEN: initialCredentials.CLOUDFLARE_API_TOKEN || '',
    })

    const [isSaving, setIsSaving] = useState(false)
    const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setIsSaving(true)
        setSaveMessage(null)

        try {
            const result = await onSave(credentials)

            if (result.success) {
                setSaveMessage({ type: 'success', text: 'Credentials saved successfully!' })
            } else {
                setSaveMessage({ type: 'error', text: result.error || 'Failed to save credentials' })
            }
        } catch (error) {
            setSaveMessage({
                type: 'error',
                text: error instanceof Error ? error.message : 'An error occurred',
            })
        } finally {
            setIsSaving(false)
        }
    }

    return (
        <form onSubmit={handleSubmit} className="max-w-3xl space-y-6">
            <Section title="Tailscale API Credentials" description="Required to fetch device information from your Tailscale network.">
                <div className="space-y-4">
                    <FormField
                        label="API Key"
                        name="tailscale-api-key"
                        type="password"
                        value={credentials.TAILSCALE_API_KEY}
                        onChange={(e) => setCredentials({ ...credentials, TAILSCALE_API_KEY: e.target.value })}
                        placeholder="tskey-api-..."
                        required
                        helpText={
                            <>
                                Get your API key from{' '}
                                <a
                                    href="https://login.tailscale.com/admin/settings/keys"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-primary hover:underline"
                                >
                                    Tailscale Admin Console
                                </a>
                            </>
                        }
                    />

                    <FormField
                        label="Tailnet"
                        name="tailscale-tailnet"
                        value={credentials.TAILSCALE_TAILNET}
                        onChange={(e) => setCredentials({ ...credentials, TAILSCALE_TAILNET: e.target.value })}
                        placeholder="example.com or user@example.com"
                        required
                        helpText="Your Tailscale network name (tailnet)"
                    />
                </div>
            </Section>

            <Section title="Cloudflare API Credentials" description="Required to create and manage DNS records in your Cloudflare zone.">
                <FormField
                    label="API Token"
                    name="cloudflare-api-token"
                    type="password"
                    value={credentials.CLOUDFLARE_API_TOKEN}
                    onChange={(e) => setCredentials({ ...credentials, CLOUDFLARE_API_TOKEN: e.target.value })}
                    placeholder="Your Cloudflare API Token"
                    required
                    helpText={
                        <>
                            Create a token with DNS:Edit permissions from{' '}
                            <a
                                href="https://dash.cloudflare.com/profile/api-tokens"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-primary hover:underline"
                            >
                                Cloudflare Dashboard
                            </a>
                            . Zone ID is automatically detected from your domain names.
                        </>
                    }
                />
            </Section>

            {saveMessage && (
                <Alert variant={saveMessage.type === 'success' ? 'default' : 'destructive'}>
                    <AlertDescription>{saveMessage.text}</AlertDescription>
                </Alert>
            )}

            <div className="flex justify-start pt-4">
                <Button type="submit" disabled={isSaving} size="lg">
                    {isSaving ? 'Saving...' : 'Save Credentials'}
                </Button>
            </div>
        </form>
    )
}
