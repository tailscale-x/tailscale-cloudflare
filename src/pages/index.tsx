import { Link } from 'waku';
import { ManualSync } from '../components/ManualSync';

export default async function HomePage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-180px)] px-6">
      <title>Tailscale Cloudflare DNS Sync</title>
      <meta name="description" content="Sync Tailscale devices to Cloudflare DNS" />
      <div className="max-w-2xl w-full text-center">
        <h1 className="text-4xl font-bold tracking-tight">Tailscale Cloudflare DNS Sync</h1>
        <p className="mt-4 text-lg text-gray-600">
          Automatically synchronize your Tailscale devices to Cloudflare DNS records.
        </p>
        <div className="mt-8 space-y-4 flex flex-col items-center">
          <div className="flex gap-4">
            <Link to="/config-tasks" className="inline-block px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700">
              🆕 Configure Tasks
            </Link>
          </div>
          <Link to="/credentials" className="block w-fit px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-700">
            🔐 API Credentials & Settings
          </Link>
          <ManualSync />
          <Link to="/status" className="block w-fit px-4 py-2 border border-gray-300 text-gray-700 rounded hover:bg-gray-50">
            View Sync Status
          </Link>
        </div>
      </div>
    </div>
  );
}

export const getConfig = async () => {
  return {
    render: 'static',
  } as const;
};
