'use client'

import { useState, useEffect } from 'react'
import { Link } from 'waku'
import { getTaskBasedConfigAction, taskBasedSyncStatusAction, taskBasedManualSyncAction } from '../actions'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { CheckCircle2, AlertTriangle, RefreshCw } from 'lucide-react'

interface SyncResult {
    added: any[]
    deleted: any[]
    managed: any[]
    summary: {
        addedCount: number
        deletedCount: number
        totalDevices: number
        matchedDevices: number
    }
}

export function StatusPageContent() {
    const [status, setStatus] = useState<SyncResult | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [syncing, setSyncing] = useState(false)

    const fetchStatus = async () => {
        setLoading(true)
        setError(null)
        try {
            const result = await taskBasedSyncStatusAction()
            if (result.success && result.sync) {
                setStatus(result.sync)
            } else {
                setError(result.error || 'Failed to fetch status')
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An unknown error occurred')
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        let mounted = true

        async function loadStatus() {
            try {
                const res = await taskBasedSyncStatusAction()
                if (mounted && res.success && res.sync) {
                    setStatus(res.sync)
                    setLoading(false)
                }
            } catch (err) {
                console.error('Failed to load sync status:', err)
                setLoading(false)
            }
        }

        loadStatus()

        return () => {
            mounted = false
        }
    }, [])

    const handleSync = async () => {
        setSyncing(true)
        try {
            const result = await taskBasedManualSyncAction()
            if (result.success) {
                await fetchStatus()
            } else {
                setError(result.error || 'Sync failed')
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An unknown error occurred during sync')
        } finally {
            setSyncing(false)
        }
    }

    if (loading && !status) {
        return <div className="p-8 text-center text-muted-foreground">Loading status...</div>
    }

    if (error) {
        return (
            <div className="p-8 space-y-4">
                <Alert variant="destructive">
                    <AlertDescription>
                        <strong>Error: </strong>
                        {error}
                    </AlertDescription>
                </Alert>
                <div className="flex gap-4">
                    <Button onClick={fetchStatus}>Retry</Button>
                    <Button variant="outline" asChild>
                        <Link to="/">Back to Home</Link>
                    </Button>
                </div>
            </div>
        )
    }

    const isSynced = status && status.added.length === 0 && status.deleted.length === 0

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight">Sync Status</h1>
                    <p className="mt-2 text-muted-foreground">Current synchronization state between Tailscale and Cloudflare.</p>
                </div>
                <Button variant="ghost" asChild>
                    <Link to="/">← Back to Home</Link>
                </Button>
            </div>

            {/* Status Card */}
            <Card className={isSynced ? 'border-green-200 bg-green-50 dark:bg-green-950' : 'border-yellow-200 bg-yellow-50 dark:bg-yellow-950'}>
                <CardContent className="pt-6">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4">
                            <div
                                className={`flex h-12 w-12 items-center justify-center rounded-full ${isSynced ? 'bg-green-100 text-green-600 dark:bg-green-900' : 'bg-yellow-100 text-yellow-600 dark:bg-yellow-900'
                                    }`}
                            >
                                {isSynced ? <CheckCircle2 className="h-6 w-6" /> : <AlertTriangle className="h-6 w-6" />}
                            </div>
                            <div>
                                <h2 className={`text-lg font-medium ${isSynced ? 'text-green-800 dark:text-green-100' : 'text-yellow-800 dark:text-yellow-100'}`}>
                                    {isSynced ? 'System is Synced' : 'Sync Required'}
                                </h2>
                                <p className={`text-sm ${isSynced ? 'text-green-600 dark:text-green-200' : 'text-yellow-600 dark:text-yellow-200'}`}>
                                    {isSynced
                                        ? 'All Tailscale devices are correctly reflected in Cloudflare DNS.'
                                        : `${status?.added.length || 0} records to add, ${status?.deleted.length || 0} records to delete.`}
                                </p>
                            </div>
                        </div>
                        {!isSynced && (
                            <Button onClick={handleSync} disabled={syncing} variant="default">
                                {syncing ? (
                                    <>
                                        <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                                        Syncing...
                                    </>
                                ) : (
                                    'Sync Now'
                                )}
                            </Button>
                        )}
                    </div>
                </CardContent>
            </Card>

            {/* Changes Detail */}
            {!isSynced && status && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {status.added.length > 0 && (
                        <Card>
                            <CardHeader>
                                <CardTitle>To Be Added</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <ul className="divide-y max-h-60 overflow-y-auto">
                                    {status.added.map((record, idx) => (
                                        <li key={idx} className="py-3">
                                            <div className="flex items-center justify-between">
                                                <p className="text-sm font-medium text-primary truncate">{record.name}</p>
                                                <Badge variant="secondary">{record.type}</Badge>
                                            </div>
                                            <div className="mt-1 flex items-center justify-between text-sm text-muted-foreground">
                                                <span className="font-mono text-xs">{record.content}</span>
                                                {record.proxied && <Badge variant="outline" className="ml-2 text-orange-600 border-orange-200">Proxied</Badge>}
                                            </div>
                                        </li>
                                    ))}
                                </ul>
                            </CardContent>
                        </Card>
                    )}

                    {status.deleted.length > 0 && (
                        <Card>
                            <CardHeader>
                                <CardTitle>To Be Deleted</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <ul className="divide-y max-h-60 overflow-y-auto">
                                    {status.deleted.map((record, idx) => (
                                        <li key={idx} className="py-3">
                                            <div className="flex items-center justify-between">
                                                <p className="text-sm font-medium truncate">{record.name}</p>
                                                <Badge variant="outline">{record.type}</Badge>
                                            </div>
                                            <p className="mt-1 text-sm text-muted-foreground font-mono text-xs">{record.content}</p>
                                        </li>
                                    ))}
                                </ul>
                            </CardContent>
                        </Card>
                    )}
                </div>
            )}

            {/* Managed Records Table */}
            <Card>
                <CardHeader>
                    <div className="flex items-center justify-between">
                        <div>
                            <CardTitle>Managed Domains</CardTitle>
                            <CardDescription>Total: {status?.managed?.length || 0} records</CardDescription>
                        </div>
                        <Button onClick={fetchStatus} variant="ghost" size="sm">
                            Refresh List
                        </Button>
                    </div>
                </CardHeader>
                <CardContent>
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b">
                                    <th className="text-left p-3 font-medium">Name</th>
                                    <th className="text-left p-3 font-medium">Type</th>
                                    <th className="text-left p-3 font-medium">Content</th>
                                    <th className="text-left p-3 font-medium">Details</th>
                                </tr>
                            </thead>
                            <tbody>
                                {status?.managed && status.managed.length > 0 ? (
                                    status.managed.map((record, idx) => (
                                        <tr key={idx} className="border-b hover:bg-muted/50 transition-colors">
                                            <td className="p-3 font-medium">{record.name}</td>
                                            <td className="p-3">
                                                <Badge variant="secondary">{record.type}</Badge>
                                            </td>
                                            <td className="p-3 font-mono text-xs">{record.content}</td>
                                            <td className="p-3">
                                                {record.proxied && (
                                                    <Badge variant="outline" className="text-orange-600 border-orange-200">
                                                        Proxied
                                                    </Badge>
                                                )}
                                            </td>
                                        </tr>
                                    ))
                                ) : (
                                    <tr>
                                        <td colSpan={4} className="p-12 text-center text-muted-foreground">
                                            No managed records found.
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </CardContent>
            </Card>
        </div>
    )
}
