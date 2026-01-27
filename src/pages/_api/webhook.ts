import { env } from 'cloudflare:workers';
import type { Env } from '../../types/env';
import { getSettings, validateSettings, setSetting, getSetting } from '../../utils/kv-storage';
import { TailscaleMachineSyncService } from '../../services/tailscale-machine-sync';
import { validateWebhookSignature, extractWebhookUrlFromRequest } from '../../utils/webhook';
import { setupWebhookWithKv } from '../../services/tailscale-webhook-manager';
import { createLogger } from '../../utils/logger';
import type { TailscaleWebhookEvent } from '../../types/tailscale';

const logger = createLogger();

// Tailscale webhook receiver
export const POST = async (request: Request): Promise<Response> => {
    try {
        const cfEnv = env as Env;
        const ownerId = cfEnv.DNS_RECORD_OWNER_ID || 'cloudflare-tailscale-dns';

        // Load and validate settings
        const rawSettings = await getSettings(cfEnv.CONFIG_KV, ownerId);
        const settings = validateSettings(rawSettings);

        const body = await request.text();
        const signature = request.headers.get('X-Tailscale-Signature') || null;

        // Validate webhook signature if secret is stored in KV
        const webhookSecret = await getSetting(cfEnv.CONFIG_KV, ownerId, 'webhookSecret');
        if (webhookSecret) {
            const isValid = await validateWebhookSignature(body, signature, webhookSecret);
            if (!isValid) {
                return Response.json({ error: 'Invalid webhook signature' }, { status: 401 });
            }
        } else {
            logger.warn('Webhook secret not found in KV, skipping signature validation');
        }

        // Parse webhook event
        const event: TailscaleWebhookEvent = JSON.parse(body);

        // Always sync all machines regardless of event type
        const result = await TailscaleMachineSyncService.performSync(settings, ownerId);

        logger.info(`Webhook processed successfully: ${event.event}`);
        return Response.json({
            success: true,
            event: event.event,
            added: result.added,
            deleted: result.deleted,
            summary: result.summary,
        });
    } catch (error) {
        logger.error('POST /webhook error:', error);
        return Response.json(
            {
                error: 'Internal server error',
                message: error instanceof Error ? error.message : String(error),
            },
            { status: 500 }
        );
    }
};

export const getConfig = async () => {
    return {
        render: 'dynamic',
    } as const;
};
