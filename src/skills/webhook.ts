import { Skill } from '../core/skills';
import { trustedActions } from '../core/trusted-actions';
import dns from 'dns';
import net from 'net';

const dnsLookupAll = dns.promises.lookup;

const isPrivateIp = (ip: string) => {
  if (!net.isIP(ip)) return false;
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
  if (ip.startsWith('169.254.')) return true;
  if (ip === '0.0.0.0') return true;
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true;
  if (ip.startsWith('fe80:')) return true;
  return false;
};

const ensureSafeUrl = async (inputUrl: string) => {
  let url: URL;
  try {
    url = new URL(inputUrl);
  } catch {
    throw new Error('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http/https URLs are allowed');
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.local')) {
    throw new Error('Localhost URLs are not allowed');
  }
  if (net.isIP(hostname) && isPrivateIp(hostname)) {
    throw new Error('Private network URLs are not allowed');
  }
  const addrs = await dnsLookupAll(hostname, { all: true });
  for (const a of addrs) {
    if (isPrivateIp(a.address)) {
      throw new Error('Resolved to private network address; blocked');
    }
  }
  return url;
};

export class WebhookSkill implements Skill {
  name = 'webhook_post';
  description = 'Send a JSON webhook to an external URL. Requires trustedActions allowlist.';
  inputSchema = {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Webhook URL (http/https)' },
      method: { type: 'string', enum: ['POST', 'PUT', 'PATCH'], description: 'HTTP method (default POST)' },
      headers: { type: 'object', description: 'Optional headers' },
      payload: { type: 'object', description: 'JSON payload to send' }
    },
    required: ['url', 'payload']
  };

  async execute(params: any): Promise<any> {
    const sessionId = params?.__sessionId;
    if (!trustedActions.isAllowed('webhook_post')) {
      return { success: false, error: 'Trusted action "webhook_post" is not allowed. Enable it in config.json trustedActions.allow.' };
    }

    const urlRaw = String(params?.url || '').trim();
    const method = String(params?.method || 'POST').toUpperCase();
    const payload = params?.payload ?? {};
    const headers = params?.headers && typeof params.headers === 'object' ? params.headers : {};

    if (!urlRaw) return { success: false, error: 'url is required' };
    if (!['POST', 'PUT', 'PATCH'].includes(method)) {
      return { success: false, error: 'method must be POST, PUT, or PATCH' };
    }

    try {
      const safeUrl = await ensureSafeUrl(urlRaw);
      const res = await fetch(safeUrl.toString(), {
        method,
        headers: {
          'content-type': 'application/json',
          ...headers
        },
        body: JSON.stringify(payload)
      });
      const text = await res.text();
      trustedActions.logRequest({
        action: 'webhook_post',
        sessionId,
        payload: { url: safeUrl.toString(), method, status: res.status },
        createdAt: Date.now()
      });
      return { success: res.ok, status: res.status, body: text };
    } catch (err: any) {
      return { success: false, error: `Webhook failed: ${err.message || err}` };
    }
  }
}
