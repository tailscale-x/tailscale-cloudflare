FROM caddy:2.11.4-builder AS build
WORKDIR /src
COPY node/go/ ./
RUN go test -mod=readonly ./... && CGO_ENABLED=0 go build -mod=readonly -trimpath -o /usr/bin/caddy .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /usr/bin/caddy /usr/bin/caddy
COPY gateway/Caddyfile /etc/caddy/gateway.Caddyfile
COPY router/Caddyfile /etc/caddy/router.Caddyfile
ENTRYPOINT ["/usr/bin/caddy", "node"]
