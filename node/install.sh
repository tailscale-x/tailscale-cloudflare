#!/bin/sh
set -eu

role=''
worker=''
email=''
image=''
skip_pull=false
while [ "$#" -gt 0 ]; do
    case "$1" in
        --role|--worker|--email|--image)
            [ "$#" -ge 2 ] || exit 2
            case "$1" in --role) role=$2;; --worker) worker=$2;; --email) email=$2;; --image) image=$2;; esac
            shift 2;;
        --skip-pull) skip_pull=true; shift;;
        --help|-h) echo 'Usage: install.sh --role gateway|router [--worker HTTPS_URL] [--email ADDRESS] [--image IMAGE] [--skip-pull]'; exit 0;;
        *) exit 2;;
    esac
done
case "$role" in gateway|router) ;; *) echo 'Set --role gateway or router' >&2; exit 2;; esac
container="tailscale-cloudflare-$role"
base="${XDG_DATA_HOME:-$HOME/.local/share}/$container"
settings="$base/settings"
if [ -z "$image" ]; then
    image='ghcr.io/tailscale-x/tailscale-cloudflare-caddy:v0.2.1'
fi
saved() { [ -f "$settings" ] && sed -n "s/^$1=//p" "$settings" | head -1 || true; }
[ -n "$worker" ] || worker=$(saved WORKER_URL)
[ -n "$email" ] || email=$(saved ACME_EMAIL)
if [ -r /dev/tty ] && [ -t 1 ]; then
    printf 'Worker HTTPS URL [%s]: ' "$worker" > /dev/tty
    IFS= read -r answer < /dev/tty
    worker=${answer:-$worker}
    if [ "$role" = gateway ]; then
        printf 'Certificate contact email [%s]: ' "$email" > /dev/tty
        IFS= read -r answer < /dev/tty
        email=${answer:-$email}
    fi
fi
case "$worker" in https://*) ;; *) echo 'Worker must use HTTPS' >&2; exit 2;; esac
if [ "$role" = gateway ]; then case "$email" in ?*@?*.*) ;; *) echo 'Invalid certificate email' >&2; exit 2;; esac; fi
case "$image" in ''|*[!a-zA-Z0-9._/:@-]*) echo 'Invalid image' >&2; exit 2;; esac

if ! command -v docker >/dev/null 2>&1; then curl -fsSL https://get.docker.com | sh; fi
if ! id -nG "$(id -un)" | tr ' ' '\n' | grep -qx docker; then sudo usermod -aG docker "$(id -un)"; fi
if docker info >/dev/null 2>&1; then docker_cmd() { docker "$@"; }
elif sudo -n docker info >/dev/null 2>&1; then docker_cmd() { sudo docker "$@"; }
else echo 'Docker unavailable; open a fresh login after joining the docker group' >&2; exit 1; fi

umask 077
mkdir -p "$base/enroll"
state_volume="${container}_state"
if [ "$skip_pull" = true ]; then docker_cmd image inspect "$image" >/dev/null; else docker_cmd pull "$image"; fi
docker_cmd volume create "$state_volume" >/dev/null
if [ "$role" = gateway ]; then docker_cmd volume create "${container}_caddy_data" >/dev/null; fi
if [ ! -f "$base/enroll/code" ] && ! docker_cmd run --rm --entrypoint test -v "$state_volume:/state" "$image" -f /state/identity.json >/dev/null 2>&1; then
    [ -r /dev/tty ] || { echo 'Enrollment code must be entered on a terminal' >&2; exit 2; }
    printf 'Enrollment code: ' > /dev/tty
    stty -echo < /dev/tty
    trap 'stty echo < /dev/tty' 0 1 2 3 15
    IFS= read -r code < /dev/tty
    stty echo < /dev/tty
    trap - 0 1 2 3 15
    printf '\n' > /dev/tty
    [ -n "$code" ] || exit 2
    printf '%s' "$code" > "$base/enroll/code"
    unset code
fi

backup="${container}-backup"
docker_cmd rm -f "$backup" >/dev/null 2>&1 || true
if docker_cmd container inspect "$container" >/dev/null 2>&1; then
    docker_cmd stop "$container" >/dev/null
    docker_cmd rename "$container" "$backup"
fi
restore() {
    docker_cmd rm -f "$container" >/dev/null 2>&1 || true
    if docker_cmd container inspect "$backup" >/dev/null 2>&1; then docker_cmd rename "$backup" "$container"; docker_cmd start "$container" >/dev/null; fi
}

if [ "$role" = gateway ]; then
    if ! docker_cmd run -d --name "$container" --restart unless-stopped --dns 9.9.9.9 \
        -p 80:80/tcp -p 443:443/tcp \
        -v "$state_volume:/state" -v "${container}_caddy_data:/data" \
        --mount "type=bind,src=$base/enroll,dst=/run/enroll" \
        -e "WORKER_URL=$worker" -e "ACME_EMAIL=$email" "$image" gateway >/dev/null; then restore; exit 1; fi
else
    ingress='tailscale-cloudflare-ingress'
    docker_cmd network inspect "$ingress" >/dev/null 2>&1 || docker_cmd network create "$ingress" >/dev/null
    if ! docker_cmd run -d --name "$container" --restart unless-stopped \
        --network "$ingress" -v "$state_volume:/state" \
        --mount "type=bind,src=$base/enroll,dst=/run/enroll" \
        --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
        -e "WORKER_URL=$worker" -e "INGRESS_NETWORK=$ingress" "$image" router >/dev/null; then restore; exit 1; fi
fi

ready=false
for attempt in $(seq 1 60); do
    if docker_cmd exec "$container" wget -q -O /dev/null http://127.0.0.1:2019/config/ >/dev/null 2>&1; then ready=true; break; fi
    if [ "$(docker_cmd inspect --format '{{.State.Running}}' "$container")" != true ]; then break; fi
    sleep 2
done
if [ "$ready" != true ]; then docker_cmd logs --tail 40 "$container" >&2 || true; restore; echo 'Node failed to start; prior container restored' >&2; exit 1; fi
docker_cmd rm -f "$backup" >/dev/null 2>&1 || true
printf 'WORKER_URL=%s\nACME_EMAIL=%s\nIMAGE=%s\n' "$worker" "$email" "$image" > "$settings"
echo "$role is running. State is persisted in $state_volume."
