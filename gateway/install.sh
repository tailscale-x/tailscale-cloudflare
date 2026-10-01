#!/bin/sh
# Install or update the versioned, single-image gateway with Docker.
set -eu

image_default='ghcr.io/tailscale-x/tailscale-cloudflare-caddy:v0.1.0'
container='tailscale-cloudflare-gateway'
base="${XDG_DATA_HOME:-$HOME/.local/share}/tailscale-cloudflare-gateway"
config="${XDG_CONFIG_HOME:-$HOME/.config}/tailscale-cloudflare-gateway/settings"
image=''
hostname=''
email=''
reuse_state=false
skip_pull=false

usage() {
    echo 'Usage: install.sh [--image IMAGE] [--hostname NAME] [--email ADDRESS] [--reuse-state] [--skip-pull]'
    echo 'Run with no options for interactive setup. Use --image with a previous tag to roll back.'
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --image|--hostname|--email)
            [ "$#" -ge 2 ] || { usage >&2; exit 2; }
            case "$1" in --image) image=$2;; --hostname) hostname=$2;; --email) email=$2;; esac
            shift 2;;
        --reuse-state) reuse_state=true; shift;;
        --skip-pull) skip_pull=true; shift;;
        --help|-h) usage; exit 0;;
        *) usage >&2; exit 2;;
    esac
done

saved() {
    [ -f "$config" ] || return 0
    sed -n "s/^$1=//p" "$config" | head -n 1
}
[ -n "$image" ] || image=$(saved IMAGE)
[ -n "$hostname" ] || hostname=$(saved TS_HOSTNAME)
[ -n "$email" ] || email=$(saved ACME_EMAIL)
[ -n "$image" ] || image=$image_default

prompt() {
    label=$1
    current=$2
    if [ ! -t 1 ] || [ ! -r /dev/tty ]; then
        [ -n "$current" ] || { echo "$label is required in noninteractive mode" >&2; exit 2; }
        printf '%s' "$current"
        return
    fi
    printf '%s [%s]: ' "$label" "$current" > /dev/tty
    IFS= read -r answer < /dev/tty
    printf '%s' "${answer:-$current}"
}

hostname=$(prompt 'Gateway Tailscale machine name' "$hostname")
email=$(prompt 'Certificate contact email' "$email")
case "$hostname" in ''|*[!a-zA-Z0-9-]*) echo 'Invalid machine name' >&2; exit 2;; esac
case "$email" in ?*@?*.*) ;; *) echo 'Invalid certificate email' >&2; exit 2;; esac
case "$image" in *[!a-zA-Z0-9._/:@-]*|'') echo 'Invalid image name' >&2; exit 2;; esac

if ! command -v docker >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com | sh
    sudo usermod -aG docker "$(id -un)"
fi
if docker info >/dev/null 2>&1; then
    docker_cmd() { docker "$@"; }
elif sudo -n docker info >/dev/null 2>&1; then
    docker_cmd() { sudo docker "$@"; }
else
    echo 'Docker is unavailable. Log in again after joining the docker group.' >&2
    exit 1
fi

mkdir -p "$base/secrets" "$(dirname "$config")"
chmod 700 "$base" "$base/secrets" "$(dirname "$config")"
join_file="$base/secrets/tailscale_auth_key"
if [ "$reuse_state" != true ]; then
    if [ -t 1 ] && [ -r /dev/tty ]; then
        printf 'One-use Tailscale join key (Enter to reuse saved node state): ' > /dev/tty
        stty -echo < /dev/tty
        trap 'stty echo < /dev/tty' 0 1 2 3 15
        IFS= read -r join_key < /dev/tty
        stty echo < /dev/tty
        trap - 0 1 2 3 15
        printf '\n' > /dev/tty
        if [ -n "$join_key" ]; then
            umask 077
            printf '%s' "$join_key" > "$join_file"
            unset join_key
        fi
    fi
fi

if [ "$skip_pull" = true ]; then
    echo "Using preloaded $image"
    docker_cmd image inspect "$image" >/dev/null
else
    echo "Pulling $image"
    docker_cmd pull "$image"
fi
for volume in tailscale_state caddy_data caddy_config; do
    docker_cmd volume create "tailscale-cloudflare-gateway_$volume" >/dev/null
done

previous=''
if docker_cmd container inspect "$container" >/dev/null 2>&1; then
    previous="${container}-backup"
    docker_cmd rm -f "$previous" >/dev/null 2>&1 || true
    docker_cmd stop "$container" >/dev/null
    docker_cmd rename "$container" "$previous"
fi
legacy_ts='tailscale-cloudflare-gateway-tailscale-1'
legacy_caddy='tailscale-cloudflare-gateway-caddy-1'
for old in "$legacy_caddy" "$legacy_ts"; do
    if docker_cmd container inspect "$old" >/dev/null 2>&1; then docker_cmd stop "$old" >/dev/null; fi
done

restore() {
    docker_cmd rm -f "$container" >/dev/null 2>&1 || true
    if [ -n "$previous" ]; then
        docker_cmd rename "$previous" "$container"
        docker_cmd start "$container" >/dev/null
    else
        for old in "$legacy_ts" "$legacy_caddy"; do
            if docker_cmd container inspect "$old" >/dev/null 2>&1; then docker_cmd start "$old" >/dev/null; fi
        done
    fi
}

if ! docker_cmd run -d --name "$container" --hostname "$hostname" --restart unless-stopped \
    --cap-add NET_ADMIN --cap-add NET_RAW --device /dev/net/tun:/dev/net/tun \
    -p 80:80/tcp -p 443:443/tcp \
    -v tailscale-cloudflare-gateway_tailscale_state:/var/lib/tailscale \
    -v tailscale-cloudflare-gateway_caddy_data:/data \
    -v tailscale-cloudflare-gateway_caddy_config:/config \
    --mount "type=bind,src=$base/secrets,dst=/run/secrets,readonly" \
    -e "TS_HOSTNAME=$hostname" -e "ACME_EMAIL=$email" "$image" >/dev/null; then
    restore
    echo 'Gateway container could not start; previous container restored.' >&2
    exit 1
fi

ready=false
for attempt in $(seq 1 60); do
    if docker_cmd exec "$container" tailscale ip -4 2>/dev/null | grep -q .; then ready=true; break; fi
    sleep 2
done
if [ "$ready" != true ]; then
    restore
    echo 'Gateway did not join; previous container restored. The join key remains for diagnosis.' >&2
    exit 1
fi

rm -f "$join_file"
if [ -n "$previous" ]; then docker_cmd rm -f "$previous" >/dev/null; fi
umask 077
printf 'IMAGE=%s\nTS_HOSTNAME=%s\nACME_EMAIL=%s\n' "$image" "$hostname" "$email" > "$config"
echo 'Gateway is running. Tailscale identity and Caddy data are in persistent Docker volumes.'
