package app

type Options struct {
	Hostname         string
	AuthKeyFile      string
	AuthKeyStdin     bool
	NonInteractive   bool
	StateDir         string
	DataDir          string
	ManagementURL    string
	BootstrapURL     string
	EnrollmentID     string
	EnrollmentCode   string
	LoginServer      string
	AcceptDNS        bool
	Tags             []string
	Listen           string
	BootstrapListen  string
	CertEmail        string
	GatewayHostname  string
	TailscaleIP      string
	IngressNetwork   string
	Force            bool
	InteractiveLogin bool
}
