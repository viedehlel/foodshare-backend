import { Request, Response, NextFunction } from 'express';

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

// Cleanup expired buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt < now) buckets.delete(k);
}, 5 * 60_000);

export function rateLimit({
  windowMs = 15 * 60_000,
  max = 5,
  scope = 'default',
}: { windowMs?: number; max?: number; scope?: string } = {}) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = (req.ip ?? req.headers['x-forwarded-for'] ?? 'unknown').toString();
    const key = `${scope}:${ip}`;
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt < now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (bucket.count >= max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', retryAfter.toString());
      res.status(429).json({ error: 'rate_limited', retryAfter });
      return;
    }
    bucket.count += 1;
    next();
  };
}
