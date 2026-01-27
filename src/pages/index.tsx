import { Link } from 'waku';
import { ManualSync } from '../components/ManualSync';

export default async function HomePage() {
  return (
    <div>
      <title>Tailscale Cloudflare DNS Sync</title>
      <meta name="description" content="Sync Tailscale devices to Cloudflare DNS" />
      <h1 className="text-4xl font-bold tracking-tight">Tailscale Cloudflare DNS Sync</h1>
      <p className="mt-4 text-lg text-gray-600">
        Automatically synchronize your Tailscale devices to Cloudflare DNS records.
      </p>
      <div className="mt-8 space-y-4">
        <Link to="/config" className="inline-block px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">
          Configure Settings
        </Link>
        <ManualSync />
      </div>
      <div className="mt-12 space-y-2 text-sm text-gray-500">
        <h2 className="font-semibold text-gray-700">API Endpoints</h2>
        <ul className="list-disc pl-5">
          <li><code>POST /webhook</code> - Tailscale webhook receiver</li>
        </ul>
      </div>
    </div>
  );
}

export const getConfig = async () => {
  return {
    render: 'static',
  } as const;
};
