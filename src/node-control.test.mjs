import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { NodeRegistry } from './node-control.mjs';

globalThis.crypto ??= webcrypto;
const encode = value => Buffer.from(value).toString('base64url');

class MemoryKV {
  values = new Map();
  async get(key, type) { const value = this.values.get(key); return value && type === 'json' ? JSON.parse(value) : value ?? null; }
  async put(key, value) { this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
  async list({ prefix }) { return { keys: [...this.values.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })), list_complete: true }; }
}

function operation(registry, name, body) {
  return registry.fetch(new Request(`https://node-registry.internal/${name}`, { method: 'POST', body: JSON.stringify(body) }));
}

test('enrollment exchanges a code and accepts only signed, fresh reports', async () => {
  const originalFetch = globalThis.fetch;
  const kv = new MemoryKV();
  await kv.put('owner/settings', JSON.stringify({ TAILSCALE_TAILNET: 'example.com' }));
  const env = { CONFIG_KV: kv, DNS_RECORD_OWNER_ID: 'owner', TAILSCALE_OAUTH_CLIENT_ID: 'test', TAILSCALE_OAUTH_CLIENT_SECRET: 'test' };
  globalThis.fetch = async url => {
    const path = String(url);
    if (path.endsWith('/oauth/token')) return Response.json({ access_token: 'test-token' });
    if (path.endsWith('/keys')) return Response.json({ id: 'key-1', key: 'tskey-test-one-use' });
    throw Error(`Unexpected Tailscale API path ${path}`);
  };
  try {
    const registry = new NodeRegistry(env);
    const issue = await operation(registry, 'issue', { role: 'router', machineName: 'test-router', tags: ['tag:server'] });
    assert.equal(issue.status, 200);
    const { code } = await issue.json();
    const signing = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const exchange = await crypto.subtle.generateKey('X25519', true, ['deriveBits']);
    const enrolled = await operation(registry, 'redeem', { code,
      signingPublicKey: encode(await crypto.subtle.exportKey('raw', signing.publicKey)),
      exchangePublicKey: encode(await crypto.subtle.exportKey('raw', exchange.publicKey)),
    });
    assert.equal(enrolled.status, 200);
    const { nodeId, ciphertext } = await enrolled.json();
    assert.ok(ciphertext);
    assert.equal((await operation(registry, 'redeem', { code, signingPublicKey: encode(await crypto.subtle.exportKey('raw', signing.publicKey)), exchangePublicKey: encode(await crypto.subtle.exportKey('raw', exchange.publicKey)) })).status, 409);
    const body = JSON.stringify({ exposures: [{ hostname: 'app.example.com', port: 8080 }] });
    const timestamp = Date.now();
    const signature = encode(await crypto.subtle.sign('Ed25519', signing.privateKey, new TextEncoder().encode(`${timestamp}\n${body}`)));
    const report = () => registry.fetch(new Request('https://node-registry.internal/report', { method: 'POST', body,
      headers: { 'X-Node-ID': nodeId, 'X-Node-Timestamp': String(timestamp), 'X-Node-Signature': signature } }));
    assert.equal((await report()).status, 200);
    assert.equal((await report()).status, 401);
    const snapshot = await registry.snapshot();
    assert.deepEqual((await snapshot.json()).nodes[0].exposures, [{ hostname: 'app.example.com', port: 8080 }]);
  } finally { globalThis.fetch = originalFetch; }
});
