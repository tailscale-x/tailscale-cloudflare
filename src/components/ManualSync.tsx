'use client';

import { useTransition, useState } from 'react';
import { taskBasedManualSyncAction } from '../actions';

export function ManualSync() {
    const [isPending, startTransition] = useTransition();
    const [result, setResult] = useState<{ success: boolean; message?: string; error?: string } | null>(null);

    const handleSync = () => {
        setResult(null);
        startTransition(async () => {
            const res = await taskBasedManualSyncAction();
            setResult(res);
        });
    };

    return (
        <div className="mt-4">
            <button
                onClick={handleSync}
                disabled={isPending}
                className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:bg-green-300 cursor-pointer"
            >
                {isPending ? 'Syncing...' : 'Sync Now'}
            </button>
            {result && (
                <p className={`mt-2 text-sm ${result.success ? 'text-green-600' : 'text-red-600'}`}>
                    {result.success ? result.message : result.error}
                </p>
            )}
        </div>
    );
}
