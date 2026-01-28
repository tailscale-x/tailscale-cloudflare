import { env } from 'cloudflare:workers';
import type { Env } from '../types/env';
import { getTaskBasedConfigAction, saveTaskBasedConfigAction, getTailscaleDevicesAction } from '../actions';
import { TaskBasedConfigForm } from '../components/config/TaskBasedConfigForm';

export default async function TaskBasedConfigPage() {
    const cfEnv = env as Env;

    // Load current task-based configuration
    const configResult = await getTaskBasedConfigAction();
    // Load devices for autocomplete
    const devicesResult = await getTailscaleDevicesAction();
    const devices = devicesResult.success ? devicesResult.devices : [];

    if (!configResult.success) {
        return (
            <div className="config-container">
                <title>Task-Based Configuration - Tailscale Cloudflare DNS Sync</title>
                <meta name="description" content="Configure your task-based DNS generation" />

                <h1>Task-Based DNS Generation</h1>
                <div className="error-message">
                    <strong>Error loading configuration:</strong>
                    <p>{configResult.error}</p>
                </div>
            </div>
        );
    }

    return (
        <div className="container mx-auto px-4 py-8">
            <title>Task-Based Configuration - Tailscale Cloudflare DNS Sync</title>
            <meta name="description" content="Configure your task-based DNS generation" />

            <div className="mb-8">
                <h1 className="text-3xl font-bold tracking-tight mb-2">Task-Based DNS Generation</h1>
                <p className="text-muted-foreground">
                    Configure flexible DNS record generation using named CIDR lists, machine selectors, and templates.
                </p>
            </div>

            <TaskBasedConfigForm
                initialSettings={configResult.settings || {}}
                onSave={saveTaskBasedConfigAction}
                devices={devices || []}
            />
        </div>
    );
}

export const getConfig = async () => {
    return {
        render: 'dynamic',
    } as const;
};
