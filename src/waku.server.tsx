import { fsRouter } from 'waku';
import adapter from 'waku/adapters/cloudflare';
import type { Env } from './types/env';
import { handleScheduled } from './handlers/scheduled';

export default adapter(
  fsRouter(import.meta.glob('./**/*.{tsx,ts}', { base: './pages' })),
  {
    handlers: {
      // Scheduled handler for cron jobs (DNS sync)
      async scheduled(
        event: ScheduledEvent,
        _env: Env,
        _ctx: ExecutionContext,
      ): Promise<void> {
        await handleScheduled(event);
      },
    } satisfies ExportedHandler<Env>,
  },
);
