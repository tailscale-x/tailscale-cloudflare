FROM tailscale/tailscale:v1.102.4 AS tailscale

FROM caddy:2.11.4-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b

RUN apk add --no-cache iptables iproute2
COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscale
COPY --from=tailscale /usr/local/bin/tailscaled /usr/local/bin/tailscaled

COPY Caddyfile /etc/caddy/Caddyfile
COPY start.sh /usr/local/bin/gateway-start
RUN chmod 755 /usr/local/bin/gateway-start
ENTRYPOINT ["/usr/local/bin/gateway-start"]
