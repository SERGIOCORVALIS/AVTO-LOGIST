import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isProduction } from "./auth";

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function rateLimitMax(): number {
  return envInt("API_RATE_LIMIT_MAX", 120);
}

export function rateLimitWindowMs(): number {
  return envInt("API_RATE_LIMIT_WINDOW_MS", 60_000);
}

export function applySecurityHeaders(_req: FastifyRequest, reply: FastifyReply): void {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("X-DNS-Prefetch-Control", "off");
  reply.header("X-Permitted-Cross-Domain-Policies", "none");
  reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (isProduction()) {
    reply.header(
      "Strict-Transport-Security",
      "max-age=15552000; includeSubDomains"
    );
  }
}

function clientKey(req: FastifyRequest): string {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.trim()) return xf.split(",")[0]!.trim();
  return req.ip || "unknown";
}

/** Returns 429 payload if limited; otherwise undefined. */
export function consumeRateLimit(req: FastifyRequest): { retryAfterSec: number } | null {
  const max = rateLimitMax();
  const windowMs = rateLimitWindowMs();
  const now = Date.now();
  const key = clientKey(req);
  let bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > max) {
    return { retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }
  return null;
}

export function resetRateLimitForTests(): void {
  buckets.clear();
}

export function registerSecurity(app: FastifyInstance): void {
  app.addHook("onRequest", async (req, reply) => {
    if (req.method === "OPTIONS") return;
    const path = req.url.split("?")[0];
    if (path === "/health") return;
    const limited = consumeRateLimit(req);
    if (!limited) return;
    reply.header("Retry-After", String(limited.retryAfterSec));
    return reply.code(429).send({
      error: "rate_limited",
      message: "Слишком много запросов, подождите минуту",
    });
  });

  app.addHook("onSend", async (req, reply) => {
    applySecurityHeaders(req, reply);
  });
}
