import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodeLoaderCloudflare from '@hiogawa/node-loader-cloudflare/vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'waku/config';

export default defineConfig({
  vite: {
    resolve: {
      alias: {
        'cloudflare/_shims/auto/runtime': path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          'node_modules/cloudflare/_shims/auto/runtime.mjs'
        ),
      },
      conditions: ['workerd', 'worker', 'browser'],
    },
    plugins: [
      tailwindcss(),
      react({
        babel: {
          plugins: ['babel-plugin-react-compiler'],
        },
      }),
      nodeLoaderCloudflare({
        environments: ['rsc'],
        build: true,
        // https://developers.cloudflare.com/workers/wrangler/api/#getplatformproxy
        getPlatformProxyOptions: {
          persist: {
            path: '.wrangler/state/v3',
          },
        },
      }),
    ],
  },
});
