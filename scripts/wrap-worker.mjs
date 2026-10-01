import { copyFile, writeFile } from 'node:fs/promises';

await copyFile('src/node-control.mjs', 'dist/server/node-control.mjs');
await copyFile('src/enrollment-crypto.mjs', 'dist/server/enrollment-crypto.mjs');
await writeFile('dist/server/serve-cloudflare.js', `
import { INTERNAL_runFetch, unstable_serverEntry as serverEntry } from './index.js';
import { handleNodeApi } from './node-control.mjs';

export default {
  ...(serverEntry.handlers ? serverEntry.handlers : {}),
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname.startsWith('/api/nodes')) {
      return handleNodeApi(request, env);
    }
    return INTERNAL_runFetch(env, request, env, ctx);
  },
};
`);
