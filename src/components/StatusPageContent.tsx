'use client';

import { useState, useEffect } from 'react';
import { Link } from 'waku';
import { getSyncStatusAction, manualSyncAction } from '../actions';

interface SyncResult {
    added: any[];
    deleted: any[];
    managed: any[];
    summary: {
        addedCount: number;
        deletedCount: number;
        totalDevices: number;
        filteredDevices: number;
    };
}

export function StatusPageContent() {
    const [status, setStatus] = useState<SyncResult | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [syncing, setSyncing] = useState(false);

    const fetchStatus = async () => {
        setLoading(true);
        setError(null);
        try {
            const result = await getSyncStatusAction();
            if (result.success && result.sync) {
                setStatus(result.sync);
            } else {
                setError(result.error || 'Failed to fetch status');
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An unknown error occurred');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchStatus();
    }, []);

    const handleSync = async () => {
        setSyncing(true);
        try {
            const result = await manualSyncAction();
            if (result.success) {
                // Refresh status after sync
                await fetchStatus();
            } else {
                setError(result.error || 'Sync failed');
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An unknown error occurred during sync');
        } finally {
            setSyncing(false);
        }
    };

    if (loading && !status) {
        return <div className="p-8 text-center text-gray-600">Loading status...</div>;
    }

    if (error) {
        return (
            <div className="p-8">
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded relative" role="alert">
                    <strong className="font-bold">Error: </strong>
                    <span className="block sm:inline">{error}</span>
                </div>
                <div className="mt-4">
                    <button
                        onClick={fetchStatus}
                        className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded"
                    >
                        Retry
                    </button>
                    <Link to="/" className="ml-4 text-blue-600 hover:text-blue-800 underline">
                        Back to Home
                    </Link>
                </div>
            </div>
        );
    }

    const isSynced = status && status.added.length === 0 && status.deleted.length === 0;

    return (
        <div>
            <div className="flex items-center justify-between mb-8">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-gray-900">Sync Status</h1>
                    <p className="mt-2 text-gray-600">Current synchronization state between Tailscale and Cloudflare.</p>
                </div>
                <Link to="/" className="text-sm font-medium text-gray-500 hover:text-gray-900">
                    &larr; Back to Home
                </Link>
            </div>

            {/* Status Card */}
            <div className={`rounded-lg p-6 mb-8 border ${isSynced ? 'bg-green-50 border-green-200' : 'bg-yellow-50 border-yellow-200'}`}>
                <div className="flex items-center justify-between">
                    <div className="flex items-center">
                        <div className={`flex-shrink-0 h-12 w-12 rounded-full flex items-center justify-center ${isSynced ? 'bg-green-100 text-green-600' : 'bg-yellow-100 text-yellow-600'}`}>
                            {isSynced ? (
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                            ) : (
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                                </svg>
                            )}
                        </div>
                        <div className="ml-4">
                            <h2 className={`text-lg font-medium ${isSynced ? 'text-green-800' : 'text-yellow-800'}`}>
                                {isSynced ? 'System is Synced' : 'Sync Required'}
                            </h2>
                            <p className={`text-sm ${isSynced ? 'text-green-600' : 'text-yellow-600'}`}>
                                {isSynced
                                    ? 'All Tailscale devices are correctly reflected in Cloudflare DNS.'
                                    : `${status?.added.length || 0} records to add, ${status?.deleted.length || 0} records to delete.`}
                            </p>
                        </div>
                    </div>
                    {!isSynced && (
                        <button
                            onClick={handleSync}
                            disabled={syncing}
                            className={`px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white ${syncing ? 'bg-yellow-400 cursor-not-allowed' : 'bg-yellow-600 hover:bg-yellow-700'
                                } focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-yellow-500`}
                        >
                            {syncing ? 'Syncing...' : 'Sync Now'}
                        </button>
                    )}
                </div>
            </div>

            {/* Changes Detail (if out of sync) */}
            {!isSynced && status && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
                    {status.added.length > 0 && (
                        <div className="bg-white shadow rounded-lg overflow-hidden border border-gray-200">
                            <div className="px-4 py-5 sm:px-6 bg-gray-50 border-b border-gray-200">
                                <h3 className="text-lg leading-6 font-medium text-gray-900">To Be Added</h3>
                            </div>
                            <ul className="divide-y divide-gray-200 max-h-60 overflow-y-auto">
                                {status.added.map((record, idx) => (
                                    <li key={idx} className="px-4 py-4 sm:px-6">
                                        <div className="flex items-center justify-between">
                                            <p className="text-sm font-medium text-blue-600 truncate">{record.name}</p>
                                            <div className="ml-2 flex-shrink-0 flex">
                                                <p className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-green-100 text-green-800">
                                                    {record.type}
                                                </p>
                                            </div>
                                        </div>
                                        <div className="mt-2 text-sm text-gray-500 flex justify-between">
                                            <span>{record.content}</span>
                                            {record.proxied && <span className="text-orange-500 text-xs self-center ml-2 border border-orange-200 bg-orange-50 px-1 rounded">Proxied</span>}
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {status.deleted.length > 0 && (
                        <div className="bg-white shadow rounded-lg overflow-hidden border border-gray-200">
                            <div className="px-4 py-5 sm:px-6 bg-gray-50 border-b border-gray-200">
                                <h3 className="text-lg leading-6 font-medium text-gray-900">To Be Deleted</h3>
                            </div>
                            <ul className="divide-y divide-gray-200 max-h-60 overflow-y-auto">
                                {status.deleted.map((record, idx) => (
                                    <li key={idx} className="px-4 py-4 sm:px-6">
                                        <div className="flex items-center justify-between">
                                            <p className="text-sm font-medium text-gray-600 truncate">{record.name}</p>
                                            <div className="ml-2 flex-shrink-0 flex">
                                                <p className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-gray-100 text-gray-800">
                                                    {record.type}
                                                </p>
                                            </div>
                                        </div>
                                        <p className="mt-2 flex items-center text-sm text-gray-500">
                                            {record.content}
                                        </p>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            )}

            {/* Managed Records Table */}
            <div className="bg-white shadow rounded-lg overflow-hidden border border-gray-200">
                <div className="px-4 py-5 sm:px-6 bg-gray-50 border-b border-gray-200 flex justify-between items-center">
                    <div>
                        <h3 className="text-lg leading-6 font-medium text-gray-900">Managed Domains</h3>
                        <p className="mt-1 max-w-2xl text-sm text-gray-500">
                            Total: {status?.managed?.length || 0} records
                        </p>
                    </div>
                    <button
                        onClick={fetchStatus}
                        className="text-sm text-blue-600 hover:text-blue-900 font-medium"
                    >
                        Refresh List
                    </button>
                </div>
                <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                            <tr>
                                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                    Name
                                </th>
                                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                    Type
                                </th>
                                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                    Content
                                </th>
                                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                    Details
                                </th>
                            </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                            {status?.managed && status.managed.length > 0 ? (
                                status.managed.map((record, idx) => (
                                    <tr key={idx} className={idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                                            {record.name}
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                            <span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-blue-100 text-blue-800">
                                                {record.type}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 font-mono">
                                            {record.content}
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                            {record.proxied && (
                                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-800 mr-2">
                                                    Proxied
                                                </span>
                                            )}
                                        </td>
                                    </tr>
                                ))
                            ) : (
                                <tr>
                                    <td colSpan={4} className="px-6 py-12 text-center text-sm text-gray-500">
                                        No managed records found.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
