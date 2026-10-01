#!/bin/sh
set -eu

mkdir -p /var/lib/tailscale /var/run/tailscale
tailscaled --statedir=/var/lib/tailscale --socket=/var/run/tailscale/tailscaled.sock --tun=tailscale0 &
daemon_pid=$!
trap 'kill "$daemon_pid" 2>/dev/null || true' EXIT TERM INT

ready=0
for attempt in $(seq 1 30); do
    if tailscale status --json >/dev/null 2>&1; then ready=1; break; fi
    sleep 1
done
if [ "$ready" -ne 1 ]; then echo 'tailscaled did not start' >&2; exit 1; fi

if ! tailscale ip -4 | grep -q .; then
    if [ ! -s /run/secrets/tailscale_auth_key ]; then
        echo 'No active Tailscale state or one-use join key found' >&2
        exit 1
    fi
    tailscale up --auth-key=file:/run/secrets/tailscale_auth_key --hostname="${TS_HOSTNAME:?Set TS_HOSTNAME}" --accept-dns=false
fi

tailscale ip -4 | grep -q . || { echo 'Tailscale did not acquire an IPv4 address' >&2; exit 1; }
echo 'Tailscale ready; starting Caddy'
caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
caddy_pid=$!
trap 'kill "$caddy_pid" "$daemon_pid" 2>/dev/null || true; wait "$caddy_pid" 2>/dev/null || true' EXIT TERM INT
wait "$caddy_pid"
