import { ipKeyGenerator } from 'express-rate-limit';

// Who a request comes from, for rate limits and bot bans. The visitor is identified by the address Cloudflare saw
// (CF-Connecting-IP — Cloudflare sets it itself and overwrites anything the client sent). The limiters used to key
// on whatever the platform derived from X-Forwarded-For, which a client can set freely: measured live, sending
// "X-Forwarded-For: 1.2.3.4" started a fresh bucket, so every limit — including the 5-attempt login limit — could
// be bypassed by changing that header. (An IPv6 address is reduced to its /56 so one household cannot rotate through
// addresses to dodge a limit.)
export const clientKey = (req) => ipKeyGenerator(String(req.headers['cf-connecting-ip'] || req.ip || 'unknown').split(',')[0].trim());
