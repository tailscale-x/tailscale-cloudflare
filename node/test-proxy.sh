#!/bin/sh
set -eu
image=${1:-tailscale-caddy-unified:dev}
network="caddy-proxy-check-$$"
proxy="caddy-proxy-check-$$"
one="caddy-one-check-$$"
two="caddy-two-check-$$"
outside="caddy-outside-check-$$"
cleanup() {
    docker stop "$proxy" "$one" "$two" "$outside" >/dev/null 2>&1 || true
    docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
docker network create "$network" >/dev/null
docker run --rm -d --name "$one" --network "$network" \
    --label 'caddy=http://one.example.com:8080' \
    --label 'caddy.reverse_proxy={{upstreams 3000}}' \
    busybox:1.37 sh -c 'mkdir /www; echo one > /www/index.html; httpd -f -p 3000 -h /www' >/dev/null
docker run --rm -d --name "$two" --network "$network" \
    --label 'caddy=http://two.example.com:8080' \
    --label 'caddy.reverse_proxy={{upstreams 4000}}' \
    busybox:1.37 sh -c 'mkdir /www; echo two > /www/index.html; httpd -f -p 4000 -h /www' >/dev/null
docker run --rm -d --name "$outside" \
    --label 'caddy=http://outside.example.com:8080' \
    --label 'caddy.reverse_proxy={{upstreams 5000}}' \
    busybox:1.37 sh -c 'mkdir /www; echo outside > /www/index.html; httpd -f -p 5000 -h /www' >/dev/null
docker run --rm -d --name "$proxy" --network "$network" \
    -v /var/run/docker.sock:/var/run/docker.sock --entrypoint caddy "$image" \
    docker-proxy --ingress-networks "$network" >/dev/null
ready=false
for attempt in $(seq 1 30); do
    first=$(docker exec "$proxy" wget -q -O - --header 'Host: one.example.com' http://127.0.0.1:8080/ 2>/dev/null || true)
    second=$(docker exec "$proxy" wget -q -O - --header 'Host: two.example.com' http://127.0.0.1:8080/ 2>/dev/null || true)
    if [ "$first" = one ] && [ "$second" = two ]; then ready=true; break; fi
    sleep 1
done
[ "$ready" = true ] || { docker logs "$proxy" >&2; exit 1; }
config=$(docker exec "$proxy" cat /root/.config/caddy/Caddyfile.autosave)
printf '%s\n' "$config" | grep -q 'reverse_proxy .*:3000'
printf '%s\n' "$config" | grep -q 'reverse_proxy .*:4000'
printf '%s\n' "$config" | grep -A1 'outside.example.com' | grep -qx '[[:space:]]*reverse_proxy'
if docker exec "$proxy" wget -q -O - --header 'Host: outside.example.com' http://127.0.0.1:8080/ >/dev/null 2>&1; then
    echo 'Outside-network service unexpectedly reachable' >&2
    exit 1
fi
