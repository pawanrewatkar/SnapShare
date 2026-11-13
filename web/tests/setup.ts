import { randomBytes } from 'node:crypto';

process.env.APP_BASE_URL = 'https://snapshare.test';
process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key-for-tests-only';
process.env.SESSION_SECRET = 'x'.repeat(48);
process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.ALLOWED_EXTENSION_IDS = 'abcdefghijklmnopabcdefghijklmnop';
process.env.CRON_SECRET = 'cron-secret';
