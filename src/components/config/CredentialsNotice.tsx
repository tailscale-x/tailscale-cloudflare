'use client'

import { Info } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Link } from 'waku'

export function CredentialsNotice() {
    return (
        <Alert className="mb-6">
            <Info className="h-4 w-4" />
            <AlertDescription>
                <strong>API Credentials:</strong> Manage your Tailscale and Cloudflare API credentials on the{' '}
                <Link to="/credentials" className="font-medium underline underline-offset-4 hover:text-primary">
                    Credentials Page
                </Link>
            </AlertDescription>
        </Alert>
    )
}
