const encoder = new TextEncoder();
const bytes = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const base64 = value => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function encryptAuthKey(authKey, clientPublic) {
  const peer = await crypto.subtle.importKey('raw', bytes(clientPublic), 'X25519', false, []);
  const ephemeral = await crypto.subtle.generateKey('X25519', true, ['deriveBits']);
  const shared = await crypto.subtle.deriveBits({ name: 'X25519', public: peer }, ephemeral.privateKey, 256);
  const material = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: encoder.encode('tailscale-cloudflare-node-v1') }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, encoder.encode(authKey));
  return { ephemeralPublicKey: base64(await crypto.subtle.exportKey('raw', ephemeral.publicKey)), nonce: base64(nonce), ciphertext: base64(ciphertext) };
}
