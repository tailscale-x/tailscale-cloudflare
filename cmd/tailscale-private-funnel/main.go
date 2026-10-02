package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"
	"github.com/tailscale-x/tailscale-private-funnel/internal/app"
)

var version = "dev"

func main() {
	root := &cobra.Command{
		Use:   "tailscale-private-funnel",
		Short: "Private funnel gateway, router, and control service",
	}
	root.AddCommand(modeCommand("control"), modeCommand("gateway"), modeCommand("router"), versionCommand())
	if err := root.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func modeCommand(mode string) *cobra.Command {
	var opts app.Options
	cmd := &cobra.Command{Use: mode, Short: mode + " mode"}
	join := &cobra.Command{Use: "join", Short: "join this node to the tailnet", RunE: func(cmd *cobra.Command, _ []string) error {
		return app.Join(context.Background(), mode, opts)
	}}
	join.Flags().StringVar(&opts.Hostname, "hostname", "", "Tailscale hostname (defaults to the machine hostname)")
	join.Flags().StringVar(&opts.AuthKeyFile, "auth-key-file", "", "file containing a Tailscale auth key")
	join.Flags().BoolVar(&opts.AuthKeyStdin, "auth-key-stdin", false, "read the Tailscale auth key from stdin")
	join.Flags().BoolVar(&opts.NonInteractive, "non-interactive", false, "fail instead of launching the control TUI")
	join.Flags().StringVar(&opts.StateDir, "state-dir", "", "persistent tsnet state directory")
	join.Flags().StringVar(&opts.DataDir, "data-dir", "", "persistent application data directory")
	join.Flags().StringVar(&opts.ManagementURL, "management-url", "", "tailnet URL of the control service")
	join.Flags().StringVar(&opts.BootstrapURL, "bootstrap-url", "", "non-tailnet enrollment bootstrap URL")
	join.Flags().StringVar(&opts.EnrollmentID, "enrollment-id", "", "revocable control enrollment ID")
	join.Flags().StringVar(&opts.EnrollmentCode, "enrollment-code", "", "enrollment code")
	join.Flags().StringVar(&opts.LoginServer, "login-server", "https://controlplane.tailscale.com", "Tailscale control server")
	join.Flags().BoolVar(&opts.AcceptDNS, "accept-dns", true, "accept Tailscale DNS settings")
	join.Flags().StringSliceVar(&opts.Tags, "advertise-tags", nil, "tags to advertise")
	cmd.AddCommand(join)
	serve := &cobra.Command{Use: "serve", Short: "run the selected mode", RunE: func(cmd *cobra.Command, _ []string) error {
		return app.Serve(context.Background(), mode, opts)
	}}
	serve.Flags().StringVar(&opts.Hostname, "hostname", "", "Tailscale hostname (defaults to the machine hostname)")
	serve.Flags().StringVar(&opts.StateDir, "state-dir", "", "persistent tsnet state directory")
	serve.Flags().StringVar(&opts.DataDir, "data-dir", "", "persistent application data directory")
	serve.Flags().StringVar(&opts.ManagementURL, "management-url", "", "tailnet URL of the control service")
	serve.Flags().StringVar(&opts.Listen, "listen", "", "listen address")
	serve.Flags().StringVar(&opts.BootstrapListen, "bootstrap-listen", "", "optional non-tailnet listener for enrollment bootstrap")
	serve.Flags().StringVar(&opts.CertEmail, "cert-email", "", "ACME certificate contact email")
	serve.Flags().StringVar(&opts.GatewayHostname, "gateway-hostname", "", "gateway DNS hostname for router reports")
	serve.Flags().StringVar(&opts.TailscaleIP, "tailscale-ip", "", "router Tailscale IPv4 for reports")
	serve.Flags().StringVar(&opts.IngressNetwork, "ingress-network", "", "dedicated Docker ingress network")
	cmd.AddCommand(serve)
	status := &cobra.Command{Use: "status", Short: "show local node status", RunE: func(cmd *cobra.Command, _ []string) error {
		return app.Status(mode, opts)
	}}
	status.Flags().StringVar(&opts.StateDir, "state-dir", "", "persistent tsnet state directory")
	status.Flags().StringVar(&opts.DataDir, "data-dir", "", "persistent application data directory")
	cmd.AddCommand(status)
	reset := &cobra.Command{Use: "reset", Short: "remove local state", RunE: func(cmd *cobra.Command, _ []string) error {
		return app.Reset(mode, opts)
	}}
	reset.Flags().StringVar(&opts.StateDir, "state-dir", "", "persistent tsnet state directory")
	reset.Flags().StringVar(&opts.DataDir, "data-dir", "", "persistent application data directory")
	reset.Flags().BoolVar(&opts.Force, "force", false, "skip confirmation")
	cmd.AddCommand(reset)
	return cmd
}

func versionCommand() *cobra.Command {
	return &cobra.Command{Use: "version", Run: func(cmd *cobra.Command, _ []string) { fmt.Println(version) }}
}

func init() {
	if d, err := os.UserConfigDir(); err == nil {
		_ = filepath.Join(d, "tailscale-private-funnel")
	}
}
