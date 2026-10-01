#!/bin/sh
set -eu

cd "$(dirname "$0")"
docker compose version >/dev/null
if [ ! -f .env ]; then
    cp .env.example .env
    chmod 600 .env
    echo 'Edit .env with this gateway machine name, certificate email, and image tag, then run again.' >&2
    exit 1
fi
mkdir -p secrets
chmod 700 secrets
if [ ! -f secrets/tailscale_auth_key ]; then
    printf 'One-use Tailscale join key (Enter to reuse an existing persisted identity): ' >&2
    stty -echo
    IFS= read -r join_key
    stty echo
    printf '\n' >&2
    if [ -n "$join_key" ]; then
        umask 077
        printf '%s' "$join_key" > secrets/tailscale_auth_key
        unset join_key
    fi
fi
docker compose -f compose.yaml pull gateway
docker compose -f compose.yaml up -d gateway
for attempt in $(seq 1 60); do
    if docker compose -f compose.yaml exec -T gateway tailscale ip -4 2>/dev/null | grep -q .; then
        rm -f secrets/tailscale_auth_key
        echo 'Gateway joined the tailnet; the temporary join key was removed.'
        exit 0
    fi
    sleep 2
done
echo 'Gateway join did not complete. The key is still in secrets/tailscale_auth_key for diagnosis.' >&2
exit 1
