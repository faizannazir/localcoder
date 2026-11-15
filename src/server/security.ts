import type { IncomingMessage } from "http";
import { createHash, timingSafeEqual } from "crypto";

/**
 * Request hardening for a server that can edit your files. Without it, any web page you visit could drive
 * http://127.0.0.1:<port> (cross-origin "simple" requests need no CORS preflight; DNS rebinding bypasses the same-origin policy).
 */
export interface SecurityOptions { token?: string; allowedOrigins: string[]; extraHosts: string[] }

export function securityFromEnv(env: NodeJS.ProcessEnv = process.env): SecurityOptions {
  const list = (v?: string) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return { token: env.LOCALCODER_API_TOKEN || undefined, allowedOrigins: list(env.LOCALCODER_ALLOWED_ORIGINS), extraHosts: list(env.LOCALCODER_ALLOWED_HOSTS) };
}

const digest = (s: string) => createHash("sha256").update(s).digest();

export function checkRequest(req: IncomingMessage, opts: SecurityOptions): { status: number; message: string } | null {
  const port = req.socket.localPort;
  const host = (req.headers.host ?? "").toLowerCase();
  const okHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, ...opts.extraHosts.map((h) => h.toLowerCase())]);
  if (!okHosts.has(host)) return { status: 403, message: "Invalid Host header (DNS-rebinding protection). Use http://127.0.0.1:<port> or http://localhost:<port>." };
  const origin = req.headers.origin;
  if (origin !== undefined && !opts.allowedOrigins.includes(origin)) return { status: 403, message: "Cross-origin browser requests are not allowed. Set LOCALCODER_ALLOWED_ORIGINS to permit a specific origin (and LOCALCODER_API_TOKEN to require a token)." };
  if (opts.token) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    if (!m || !timingSafeEqual(digest(m[1]), digest(opts.token))) return { status: 401, message: "Missing or invalid bearer token (LOCALCODER_API_TOKEN is set)." };
  }
  if (req.method === "POST" && !/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return { status: 415, message: 'POST bodies must be sent with "Content-Type: application/json".' };
  return null;
}
