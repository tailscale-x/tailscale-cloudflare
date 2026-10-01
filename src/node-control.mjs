const namePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const fqdnPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const tagPattern = /^tag:[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const encoder = new TextEncoder();
import { encryptAuthKey } from './enrollment-crypto.mjs';

const bytes = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const base64 = value => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const hash = async value => base64(await crypto.subtle.digest('SHA-256', encoder.encode(value)));

async function oauthToken(env) {
  if (!env.TAILSCALE_OAUTH_CLIENT_ID || !env.TAILSCALE_OAUTH_CLIENT_SECRET) throw Error('Tailscale OAuth secrets are missing');
  const response = await fetch('https://api.tailscale.com/api/v2/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.TAILSCALE_OAUTH_CLIENT_ID, client_secret: env.TAILSCALE_OAUTH_CLIENT_SECRET }),
  });
  if (!response.ok) throw Error(`Tailscale OAuth: HTTP ${response.status}`);
  return (await response.json()).access_token;
}

async function tailscale(env, tailnet, path, method, body) {
  const response = await fetch(`https://api.tailscale.com/api/v2/tailnet/${encodeURIComponent(tailnet)}/${path}`, {
    method, headers: { Authorization: `Bearer ${await oauthToken(env)}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw Error(`Tailscale ${path}: HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.status === 204 ? null : response.json();
}

class KVNodeStorage {
  constructor(kv, owner) { this.kv = kv; this.prefix = `${owner}/node-registry/`; }
  async get(key) { return this.kv.get(this.prefix + key, 'json'); }
  async put(key, value) { await this.kv.put(this.prefix + key, JSON.stringify(value), key.startsWith('code:') ? { expirationTtl: 3600 } : undefined); }
  async delete(key) { await this.kv.delete(this.prefix + key); }
  async list({ prefix }) {
    const result = new Map();
    let cursor;
    do {
      const page = await this.kv.list({ prefix: this.prefix + prefix, ...(cursor ? { cursor } : {}) });
      for (const item of page.keys) {
        const key = item.name.slice(this.prefix.length);
        const value = await this.get(key);
        if (value) result.set(key, value);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return result;
  }
}

export class NodeRegistry {
  constructor(env) { this.env = env; this.state = { storage: new KVNodeStorage(env.CONFIG_KV, env.DNS_RECORD_OWNER_ID) }; }

  async fetch(request) {
    try {
      const route = new URL(request.url).pathname;
      if (route === '/issue') return this.issue(await request.json());
      if (route === '/redeem') return this.redeem(await request.json());
      if (route === '/report') return this.report(request);
      if (route === '/revoke') return this.revoke(await request.json());
      if (route === '/snapshot') return this.snapshot();
      return json({ error: 'Unknown operation' }, 404);
    } catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, 400); }
  }

  async issue(input) {
    const { role, machineName, gatewayHostname, tags } = input;
    if (!['gateway', 'router'].includes(role) || !namePattern.test(machineName) ||
        (role === 'gateway' && !fqdnPattern.test(gatewayHostname)) ||
        !Array.isArray(tags) || tags.length < 1 || !tags.every(tag => tagPattern.test(tag))) {
      return json({ error: 'Invalid node settings' }, 400);
    }
    const settings = JSON.parse(await this.env.CONFIG_KV.get(`${this.env.DNS_RECORD_OWNER_ID}/settings`) || '{}');
    if (!settings.TAILSCALE_TAILNET) return json({ error: 'Set the tailnet on the Credentials page first' }, 503);
    const code = base64(crypto.getRandomValues(new Uint8Array(32)));
    const id = crypto.randomUUID();
    const pending = { id, role, machineName, gatewayHostname: role === 'gateway' ? gatewayHostname : undefined,
      tags: [...new Set(tags)], expiresAt: Date.now() + 60 * 60 * 1000 };
    await this.state.storage.put(`code:${await hash(code)}`, pending);
    return json({ ...pending, code });
  }

  async redeem(input) {
    if (typeof input.code !== 'string' || typeof input.signingPublicKey !== 'string' || typeof input.exchangePublicKey !== 'string' ||
        bytes(input.signingPublicKey).length !== 32 || bytes(input.exchangePublicKey).length !== 32) return json({ error: 'Invalid enrollment request' }, 400);
    const codeKey = `code:${await hash(input.code)}`;
    const pending = await this.state.storage.get(codeKey);
    if (!pending) return json({ error: 'Enrollment code expired or already used' }, 409);
    if (pending.expiresAt < Date.now()) { await this.state.storage.delete(codeKey); return json({ error: 'Enrollment code expired' }, 409); }
    // KV is eventually consistent. This prevents ordinary reuse but is not an atomic claim.
    await this.state.storage.delete(codeKey);
    const settings = JSON.parse(await this.env.CONFIG_KV.get(`${this.env.DNS_RECORD_OWNER_ID}/settings`) || '{}');
    if (!settings.TAILSCALE_TAILNET) return json({ error: 'Tailnet is not configured; create another code' }, 503);
    const created = await tailscale(this.env, settings.TAILSCALE_TAILNET, 'keys', 'POST', {
      capabilities: { devices: { create: { reusable: false, ephemeral: false, preauthorized: false, tags: pending.tags } } },
      expirySeconds: 3600, description: `${pending.role} ${pending.machineName}`,
    });
    try {
      const encrypted = await encryptAuthKey(created.key, input.exchangePublicKey);
      const node = { ...pending, signingPublicKey: input.signingPublicKey, keyId: created.id, enrolledAt: Date.now(),
        revoked: false, lastReportAt: 0, exposures: [] };
      await this.state.storage.put(`node:${node.id}`, node);
      return json({ nodeId: node.id, role: node.role, machineName: node.machineName, tags: node.tags, ...encrypted });
    } catch (error) {
      await tailscale(this.env, settings.TAILSCALE_TAILNET, `keys/${encodeURIComponent(created.id)}`, 'DELETE').catch(() => {});
      throw error;
    }
  }

  async report(request) {
    const id = request.headers.get('X-Node-ID');
    const timestamp = Number(request.headers.get('X-Node-Timestamp'));
    const signature = request.headers.get('X-Node-Signature');
    if (!id || !signature || !Number.isSafeInteger(timestamp) || Math.abs(Date.now() - timestamp) > 300000) return json({ error: 'Invalid report headers' }, 401);
    const node = await this.state.storage.get(`node:${id}`);
    if (!node || node.revoked || timestamp <= node.lastReportAt) return json({ error: 'Unknown, revoked, or replayed node' }, 401);
    const raw = await request.text();
    if (raw.length > 65536) return json({ error: 'Report too large' }, 413);
    const publicKey = await crypto.subtle.importKey('raw', bytes(node.signingPublicKey), 'Ed25519', false, ['verify']);
    if (!await crypto.subtle.verify('Ed25519', publicKey, bytes(signature), encoder.encode(`${timestamp}\n${raw}`))) return json({ error: 'Invalid signature' }, 401);
    const body = JSON.parse(raw);
    if (!Array.isArray(body.exposures) || body.exposures.length > 100 ||
        !body.exposures.every(item => fqdnPattern.test(item.hostname) && Number.isInteger(item.port) && item.port > 0 && item.port < 65536)) return json({ error: 'Invalid exposures' }, 400);
    if (node.role === 'gateway' && node.lastReportAt === 0) {
      const all = await this.state.storage.list({ prefix: 'node:' });
      for (const [key, previous] of all) {
        if (previous.id !== node.id && previous.role === 'gateway' && !previous.revoked) {
          previous.revoked = true;
          await this.state.storage.put(key, previous);
        }
      }
    }
    node.lastReportAt = timestamp;
    node.exposures = node.role === 'router' ? body.exposures : [];
    await this.state.storage.put(`node:${id}`, node);
    return json({ ok: true });
  }

  async revoke({ id }) {
    const code = await this.state.storage.list({ prefix: 'code:' });
    for (const [key, pending] of code) if (pending.id === id) { await this.state.storage.delete(key); return json({ ok: true }); }
    const node = await this.state.storage.get(`node:${id}`);
    if (!node) return json({ error: 'Node not found' }, 404);
    node.revoked = true;
    node.exposures = [];
    await this.state.storage.put(`node:${id}`, node);
    const settings = JSON.parse(await this.env.CONFIG_KV.get(`${this.env.DNS_RECORD_OWNER_ID}/settings`) || '{}');
    let deviceError;
    if (settings.TAILSCALE_TAILNET) {
      try {
        const devices = await tailscale(this.env, settings.TAILSCALE_TAILNET, 'devices?fields=all', 'GET');
        const matches = devices.devices.filter(device => device.name?.split('.')[0] === node.machineName);
        if (matches.length !== 1) throw Error(`Expected exactly one Tailscale device named ${node.machineName}; found ${matches.length}`);
        const response = await fetch(`https://api.tailscale.com/api/v2/device/${encodeURIComponent(matches[0].id)}`, {
          method: 'DELETE', headers: { Authorization: `Bearer ${await oauthToken(this.env)}` },
        });
        if (!response.ok) throw Error(`Tailscale device removal: HTTP ${response.status}`);
      } catch (error) { deviceError = String(error); }
    }
    return json({ ok: true, ...(deviceError ? { warning: `Node disabled in Worker; remove its Tailscale device manually: ${deviceError}` } : {}) });
  }

  async snapshot() {
    const nodes = await this.state.storage.list({ prefix: 'node:' });
    const pending = await this.state.storage.list({ prefix: 'code:' });
    return json({ nodes: [...nodes.values()].map(({ signingPublicKey, keyId, ...node }) => node),
      pending: [...pending.values()] });
  }
}

export async function handleNodeApi(request, env) {
  const path = new URL(request.url).pathname;
  const routes = { '/api/nodes': '/snapshot', '/api/nodes/issue': '/issue', '/api/nodes/enroll': '/redeem', '/api/nodes/report': '/report', '/api/nodes/revoke': '/revoke' };
  const route = routes[path];
  if (!route) return json({ error: 'Not found' }, 404);
  if ((route === '/snapshot' && request.method !== 'GET') || (route !== '/snapshot' && request.method !== 'POST')) return json({ error: 'Method not allowed' }, 405);
  return new NodeRegistry(env).fetch(new Request(`https://node-registry.internal${route}`, request));
}
