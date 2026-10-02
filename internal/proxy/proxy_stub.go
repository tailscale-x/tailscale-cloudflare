//go:build !caddy

package proxy

import (
	"context"
	"fmt"
	"net"
)

func Start(mode, listen string, _ func(context.Context, string, string) (net.Conn, error)) error {
	return fmt.Errorf("%s runtime requires the caddy build tag", mode)
}
