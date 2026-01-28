export const Footer = () => {
  return (
    <footer className="p-6 lg:fixed lg:bottom-0 lg:left-0 text-gray-500 text-sm">
      <div className="flex gap-2 items-center">
        <span>Tailscale Cloudflare DNS Sync</span>
        <span>•</span>
        <a
          href="https://github.com/tailscale-x/tailscale-cloudflare"
          target="_blank"
          rel="noreferrer"
          className="hover:underline"
        >
          View on GitHub
        </a>
      </div>
    </footer>
  );
};
