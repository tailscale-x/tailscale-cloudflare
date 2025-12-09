import type { Context } from 'hono'
import { html } from 'hono/html'
import type { AppContext } from '../types/app'
import type { Settings } from '../types/settings'
import { updateSettings } from '../utils/kv-storage'
import { createLogger } from '../utils/logger'

const logger = createLogger()

export const configHandler = async (c: Context<AppContext>) => {
    const env = c.env
    const ownerId = env.DNS_RECORD_OWNER_ID || 'cloudflare-tailscale-dns'

    // Get current settings (or partial/invalid/default) if available
    // Note: middleware might have failed to validate, but we want to show the form anyway.
    // We can fetch raw settings again if needed, or rely on what middleware passed.
    // The middleware sets 'settings' if valid, or 'settingsError' if invalid.
    // But if it's invalid, 'settings' variable might not be set.
    // So we should probably fetch it again raw to populate the form.

    // But wait, middleware sets 'settings' only if valid.
    // We need to support editing current invalid settings.
    // So let's fetch raw settings here.

    const { getSettings } = await import('../utils/kv-storage')
    const currentSettings = await getSettings(env.CONFIG_KV, ownerId) as Partial<Settings>

    if (c.req.method === 'POST') {
        try {
            const body = await c.req.parseBody()

            const newSettings: Partial<Settings> = {
                TAILSCALE_API_KEY: body['TAILSCALE_API_KEY'] as string,
                TAILSCALE_TAILNET: body['TAILSCALE_TAILNET'] as string,
                CLOUDFLARE_API_TOKEN: body['CLOUDFLARE_API_TOKEN'] as string,
                DOMAIN_FOR_TAILSCALE_ENDPOINT: body['DOMAIN_FOR_TAILSCALE_ENDPOINT'] as string,
                DOMAIN_FOR_WAN_ENDPOINT: body['DOMAIN_FOR_WAN_ENDPOINT'] as string,
                DOMAIN_FOR_LAN_ENDPOINT: body['DOMAIN_FOR_LAN_ENDPOINT'] as string,
                // Arrays need to be split
                LAN_CIDR_RANGES: (body['LAN_CIDR_RANGES'] as string)?.split(',').map(s => s.trim()).filter(Boolean),
                TAILSCALE_TAG_LAN_REGEX: body['TAILSCALE_TAG_LAN_REGEX'] as string,
                TAILSCALE_TAG_TAILSCALE_REGEX: body['TAILSCALE_TAG_TAILSCALE_REGEX'] as string,
                TAILSCALE_TAG_WAN_NO_PROXY_REGEX: body['TAILSCALE_TAG_WAN_NO_PROXY_REGEX'] as string,
                TAILSCALE_TAG_WAN_PROXY_REGEX: body['TAILSCALE_TAG_WAN_PROXY_REGEX'] as string,
            }

            // Check validation
            const { validateSettings } = await import('../utils/kv-storage')
            // This will throw if invalid
            validateSettings(newSettings)

            await updateSettings(env.CONFIG_KV, ownerId, newSettings)

            return c.json({ success: true, message: 'Settings have been successfully updated.' })
        } catch (error) {
            logger.error('Failed to update settings', error)
            return c.json(
                {
                    success: false,
                    error: error instanceof Error ? error.message : String(error)
                },
                400
            )
        }
    }

    // Render Form
    return c.render(
        <div class="container">
            <h1>Tailscale-Cloudflare DNS Sync Configuration</h1>
            <p class="intro">Configure all settings for your DNS synchronization service. All fields marked with <span class="required">*</span> are required.</p>

            <form method="post" action="/config">
                <h2>API Credentials</h2>

                <div class="form-group">
                    <label>Tailscale API Key <span class="required">*</span></label>
                    <input type="password" name="TAILSCALE_API_KEY" value={currentSettings.TAILSCALE_API_KEY || ''} required />
                    <small>Get from: <a href="https://login.tailscale.com/admin/settings/keys" target="_blank">Tailscale Admin Console</a>. Generate an API key with device read permissions. Starts with <code>tskey-api-</code></small>
                </div>

                <div class="form-group">
                    <label>Tailscale Tailnet <span class="required">*</span></label>
                    <input type="text" name="TAILSCALE_TAILNET" value={currentSettings.TAILSCALE_TAILNET || ''} required />
                    <small>Your Tailscale tailnet identifier (e.g., "example.tailscale.com" or just "example")</small>
                </div>

                <div class="form-group">
                    <label>Cloudflare API Token <span class="required">*</span></label>
                    <input type="password" name="CLOUDFLARE_API_TOKEN" value={currentSettings.CLOUDFLARE_API_TOKEN || ''} required />
                    <small>Get from: <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank">Cloudflare Dashboard</a>. Create token with: Zone → DNS → Edit permissions (minimum 40 characters)</small>
                </div>

                <h2>Domain Configuration</h2>
                <p class="section-help">Configure the domains where DNS records will be created. The root domain will be used to automatically lookup the Cloudflare Zone ID.</p>

                <div class="form-group">
                    <label>Domain for Tailscale Endpoint <span class="required">*</span></label>
                    <input type="text" name="DOMAIN_FOR_TAILSCALE_ENDPOINT" value={currentSettings.DOMAIN_FOR_TAILSCALE_ENDPOINT || ''} required />
                    <small>Domain/subdomain where Tailscale IP records will be created (e.g., "ts.example.com")</small>
                </div>

                <div class="form-group">
                    <label>Domain for WAN Endpoint <span class="required">*</span></label>
                    <input type="text" name="DOMAIN_FOR_WAN_ENDPOINT" value={currentSettings.DOMAIN_FOR_WAN_ENDPOINT || ''} required />
                    <small>Domain/subdomain where WAN (public IP) records will be created (e.g., "wan.example.com")</small>
                </div>

                <div class="form-group">
                    <label>Domain for LAN Endpoint <span class="required">*</span></label>
                    <input type="text" name="DOMAIN_FOR_LAN_ENDPOINT" value={currentSettings.DOMAIN_FOR_LAN_ENDPOINT || ''} required />
                    <small>Domain/subdomain where LAN (private IP) records will be created (e.g., "lan.example.com")</small>
                </div>

                <h2>Network Configuration</h2>

                <div class="form-group">
                    <label>LAN CIDR Ranges <span class="required">*</span></label>
                    <input type="text" name="LAN_CIDR_RANGES" value={Array.isArray(currentSettings.LAN_CIDR_RANGES) ? currentSettings.LAN_CIDR_RANGES.join(', ') : (currentSettings.LAN_CIDR_RANGES || '')} required placeholder="10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16" />
                    <small>Comma-separated list of CIDR ranges for Private-Use Networks (RFC1918). <strong>Order matters</strong>: When a device has multiple endpoints matching different ranges, the first matching range is chosen. Example: <code>10.0.0.0/8,172.16.0.0/12,192.168.0.0/16</code></small>
                </div>

                <h2>Tag Filtering (Regex Patterns)</h2>
                <p class="section-help">Use regular expressions to determine which devices get DNS records. Devices must have at least one tag matching the pattern.</p>

                <div class="form-group">
                    <label>LAN Tag Regex <span class="required">*</span></label>
                    <input type="text" name="TAILSCALE_TAG_LAN_REGEX" value={currentSettings.TAILSCALE_TAG_LAN_REGEX || ''} required placeholder="^tag:lan" />
                    <small>Devices with tags matching this pattern will have LAN domain records created. Example: <code>^tag:lan</code> (matches tags starting with "tag:lan")</small>
                </div>

                <div class="form-group">
                    <label>Tailscale Tag Regex <span class="required">*</span></label>
                    <input type="text" name="TAILSCALE_TAG_TAILSCALE_REGEX" value={currentSettings.TAILSCALE_TAG_TAILSCALE_REGEX || ''} required placeholder="^tag:ts" />
                    <small>Devices with tags matching this pattern will have Tailscale domain records created. Example: <code>^tag:ts</code></small>
                </div>

                <div class="form-group">
                    <label>WAN No-Proxy Tag Regex <span class="required">*</span></label>
                    <input type="text" name="TAILSCALE_TAG_WAN_NO_PROXY_REGEX" value={currentSettings.TAILSCALE_TAG_WAN_NO_PROXY_REGEX || ''} required placeholder="^tag:wan" />
                    <small>Devices with tags matching this pattern will have WAN records created with Cloudflare proxy <strong>disabled</strong> (orange cloud off). Example: <code>^tag:wan</code></small>
                </div>

                <div class="form-group">
                    <label>WAN Proxy Tag Regex <span class="required">*</span></label>
                    <input type="text" name="TAILSCALE_TAG_WAN_PROXY_REGEX" value={currentSettings.TAILSCALE_TAG_WAN_PROXY_REGEX || ''} required placeholder="^tag:proxy" />
                    <small>Devices with tags matching this pattern will have WAN records created with Cloudflare proxy <strong>enabled</strong> (orange cloud on). If a device matches both patterns, this takes precedence. Example: <code>^tag:proxy</code></small>
                </div>

                <h2>Optional Settings</h2>


                <button type="submit" id="submitBtn">Save Configuration</button>
            </form>

            <div id="messageContainer" style="display: none;"></div>

            <script dangerouslySetInnerHTML={{
                __html: `
                const form = document.querySelector('form');
                const submitBtn = document.getElementById('submitBtn');
                const messageContainer = document.getElementById('messageContainer');

                form.addEventListener('submit', async (e) => {
                    e.preventDefault();
                    
                    // Disable submit button and show loading state
                    submitBtn.disabled = true;
                    submitBtn.textContent = 'Saving...';
                    messageContainer.style.display = 'none';
                    
                    try {
                        const formData = new FormData(form);
                        const response = await fetch('/config', {
                            method: 'POST',
                            body: formData
                        });
                        
                        const result = await response.json();
                        
                        if (result.success) {
                            // Show success message
                            messageContainer.className = 'message success';
                            messageContainer.textContent = result.message;
                            messageContainer.style.display = 'block';
                            
                            // Scroll to message
                            messageContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                        } else {
                            // Show error message
                            messageContainer.className = 'message error';
                            messageContainer.textContent = result.error;
                            messageContainer.style.display = 'block';
                            
                            // Scroll to message
                            messageContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                        }
                    } catch (error) {
                        // Show network error
                        messageContainer.className = 'message error';
                        messageContainer.textContent = 'Network error: ' + error.message;
                        messageContainer.style.display = 'block';
                    } finally {
                        // Re-enable submit button
                        submitBtn.disabled = false;
                        submitBtn.textContent = 'Save Configuration';
                    }
                });
            `}} />

            <style>{`
        .container { 
            max-width: 900px; 
            margin: 0 auto; 
            padding: 20px; 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
        }
        h1 { 
            color: #1a1a1a; 
            margin-bottom: 10px;
        }
        h2 {
            color: #2c3e50;
            margin-top: 30px;
            margin-bottom: 15px;
            padding-bottom: 8px;
            border-bottom: 2px solid #e1e4e8;
        }
        .intro {
            color: #586069;
            margin-bottom: 30px;
            font-size: 1.05em;
        }
        .section-help {
            color: #586069;
            font-size: 0.95em;
            margin-top: -10px;
            margin-bottom: 15px;
        }
        .form-group { 
            margin-bottom: 20px; 
        }
        label { 
            display: block; 
            margin-bottom: 6px; 
            font-weight: 600;
            color: #24292e;
        }
        .required {
            color: #d73a49;
        }
        input[type="text"], 
        input[type="password"], 
        select { 
            width: 100%; 
            padding: 10px 12px; 
            border: 1px solid #d1d5da;
            border-radius: 6px;
            font-size: 14px;
            font-family: inherit;
            box-sizing: border-box;
        }
        input[type="text"]:focus,
        input[type="password"]:focus,
        select:focus {
            outline: none;
            border-color: #0366d6;
            box-shadow: 0 0 0 3px rgba(3, 102, 214, 0.1);
        }
        small { 
            display: block; 
            margin-top: 6px; 
            color: #586069;
            font-size: 13px;
            line-height: 1.5;
        }
        small a {
            color: #0366d6;
            text-decoration: none;
        }
        small a:hover {
            text-decoration: underline;
        }
        code {
            background: #f6f8fa;
            padding: 2px 6px;
            border-radius: 3px;
            font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
            font-size: 12px;
        }
        button { 
            padding: 12px 24px; 
            background: #2ea44f; 
            color: white; 
            border: none; 
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 600;
            margin-top: 10px;
        }
        button:hover { 
            background: #2c974b; 
        }
        button:disabled {
            background: #94d3a2;
            cursor: not-allowed;
        }
        .message {
            margin-top: 20px;
            padding: 15px;
            border-radius: 6px;
            font-weight: 500;
        }
        .message.success {
            color: #0f5132;
            background: #d1e7dd;
            border: 1px solid #a3cfbb;
        }
        .message.error { 
            color: #d73a49;
            background: #ffeef0;
            padding: 15px;
            border-radius: 6px;
            border: 1px solid #f97583;
        }
      `}</style>
        </div>
    )
}
