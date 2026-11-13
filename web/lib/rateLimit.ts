import { repo } from './repo';
import { tooMany } from './http';

/** Fixed-window rate limit backed by Postgres (works across serverless instances). */
export async function enforceRateLimit(key: string, windowSeconds: number, max: number): Promise<void> {
  if (!(await repo().rateLimitHit(key, windowSeconds, max))) throw tooMany();
}
