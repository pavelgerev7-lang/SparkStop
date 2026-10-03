// Optional fixed outgoing address for requests to provider websites.
//
// On Render the service leaves through a small, SHARED set of addresses and
// every restart can land on a different one. Some of those addresses are
// refused by the hosting of dozens of small water/heating providers (their
// firewalls keep shared blacklists fed by other Render tenants' behaviour, not
// ours): on 2026-09-24 21 providers went to 0 together right after a restart
// and came back together after another one, while the very same pages loaded
// fine from a different address (from a normal machine and from another cloud).
//
// Setting SCRAPER_PROXY_URL (http://user:password@host:port) to a small proxy
// on a server we control gives every request one stable, clean address that
// does not depend on the restart lottery. Unset, nothing changes.
//
// Providers that have EXPLICITLY refused this service (a Cloudflare challenge,
// "access limited", ...) are marked `noProxy: true` in PROVIDER_TARGETS and
// never go through the proxy: a different address must not be used to get
// around a refusal.
import axios from 'axios';
import http from 'http';
import https from 'https';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';

// Plain agents, used to force a DIRECT connection for `noProxy` targets even
// when a proxy is configured as the axios default.
export const directAgents = {
  httpAgent: new http.Agent(),
  httpsAgent: new https.Agent()
};

/** Route axios (all provider fetches) through the proxy in SCRAPER_PROXY_URL, if set. */
export function configureEgress(env = process.env) {
  const raw = (env.SCRAPER_PROXY_URL || '').trim();
  if (!raw) return { enabled: false };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (err) {
    console.warn('⚠️ [EGRESS] SCRAPER_PROXY_URL is not a valid URL — ignoring it, requests go out directly.');
    return { enabled: false };
  }
  axios.defaults.httpAgent = new HttpProxyAgent(raw);
  axios.defaults.httpsAgent = new HttpsProxyAgent(raw);
  axios.defaults.proxy = false; // the agents do the proxying; don't also apply HTTP(S)_PROXY from the environment
  console.log(`🌐 [EGRESS] Provider requests go through the proxy ${parsed.host} (credentials not logged).`);
  return { enabled: true, host: parsed.host };
}

/**
 * The address the outside world sees for this service's provider requests
 * (through the proxy when one is configured). Recorded in the health panel so
 * it is visible WHICH address the service is currently using — the thing that
 * decided whether 21 providers worked or not on 2026-09-24.
 */
export async function lookupEgressAddress() {
  try {
    const res = await axios.get('https://api.ipify.org?format=json', { timeout: 8000 });
    const ip = res.data && res.data.ip;
    return typeof ip === 'string' && /^[0-9a-f.:]{3,45}$/i.test(ip) ? ip : null;
  } catch (err) {
    return null;
  }
}

/** Undo configureEgress() — used by tests. */
export function resetEgress() {
  delete axios.defaults.httpAgent;
  delete axios.defaults.httpsAgent;
  axios.defaults.proxy = undefined;
}
