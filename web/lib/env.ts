import { z } from 'zod';

const schema = z.object({
  APP_BASE_URL: z.string().url(),
  GOOGLE_CLIENT_ID: z.string().min(10),
  GOOGLE_CLIENT_SECRET: z.string().min(10),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'ENCRYPTION_KEY must be 32 bytes, base64-encoded'),
  ALLOWED_EXTENSION_IDS: z.string().default(''),
  CRON_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof schema>;
let cached: Env | null = null;

/** Validated server environment. Throws a descriptive error (never the values) if misconfigured. */
export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Server is not configured: ${fields}`);
  }
  cached = { ...parsed.data, APP_BASE_URL: parsed.data.APP_BASE_URL.replace(/\/+$/, '') };
  return cached;
}

export function allowedExtensionIds(): string[] {
  return env()
    .ALLOWED_EXTENSION_IDS.split(',')
    .map((s) => s.trim())
    .filter((s) => /^[a-p]{32}$/.test(s));
}

/** For tests. */
export function resetEnvCache() {
  cached = null;
}
