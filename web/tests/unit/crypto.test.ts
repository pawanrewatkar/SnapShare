import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, randomToken, sha256Hex, verifyPkce } from '@/lib/crypto';
import { signMedia, verifyMediaSignature } from '@/lib/signedUrl';
import { isAllowedExtensionRedirect } from '@/lib/auth';
import { sanitizeFilename, validateUpload } from '@snapshare/shared';

const KEY = Buffer.alloc(32, 7).toString('base64');

describe('crypto', () => {
  it('generates 256-bit url-safe tokens', () => {
    const t = randomToken(32);
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken(32)).not.toBe(t);
  });
  it('round-trips AES-GCM and detects tampering', () => {
    const c = encrypt('refresh-token', KEY);
    expect(c).not.toContain('refresh-token');
    expect(decrypt(c, KEY)).toBe('refresh-token');
    const bad = c.slice(0, -2) + (c.endsWith('A') ? 'BB' : 'AA');
    expect(() => decrypt(bad, KEY)).toThrow();
    expect(() => decrypt(c, Buffer.alloc(32, 8).toString('base64'))).toThrow();
  });
  it('hashes deterministically', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('verifies PKCE S256 (RFC 7636 vector) and rejects mismatches', () => {
    expect(verifyPkce('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(true);
    expect(verifyPkce('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXX', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(false);
    expect(verifyPkce('short', 'x')).toBe(false);
  });
});

describe('signed media URLs', () => {
  it('accepts valid, rejects expired and tampered signatures', () => {
    const exp = 2_000_000_000;
    const sig = signMedia('a', 'u', exp, false, 's');
    expect(verifyMediaSignature({ assetId: 'a', userId: 'u', exp, download: false, sig }, 's', exp - 10)).toBe(true);
    expect(verifyMediaSignature({ assetId: 'a', userId: 'u', exp, download: false, sig }, 's', exp + 1)).toBe(false);
    expect(verifyMediaSignature({ assetId: 'a', userId: 'other', exp, download: false, sig }, 's', exp - 10)).toBe(false);
    expect(verifyMediaSignature({ assetId: 'a', userId: 'u', exp, download: true, sig }, 's', exp - 10)).toBe(false);
  });
});

describe('OAuth redirect allow-list', () => {
  const ids = ['abcdefghijklmnopabcdefghijklmnop'];
  it('accepts only https chromiumapp.org redirects of allowed extensions', () => {
    expect(isAllowedExtensionRedirect('https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/auth', ids)).toBe(true);
    expect(isAllowedExtensionRedirect('https://pponmlkjihgfedcbapponmlkjihgfedcba.chromiumapp.org/auth', ids)).toBe(false);
    expect(isAllowedExtensionRedirect('http://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/auth', ids)).toBe(false);
    expect(isAllowedExtensionRedirect('https://evil.com/?x=abcdefghijklmnopabcdefghijklmnop.chromiumapp.org', ids)).toBe(false);
    expect(isAllowedExtensionRedirect('https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org.evil.com/', ids)).toBe(false);
    expect(isAllowedExtensionRedirect('not a url', ids)).toBe(false);
  });
});

describe('upload validation', () => {
  it('validates type and size', () => {
    expect(validateUpload('screenshot', 'image/png', 10)).toBeNull();
    expect(validateUpload('screenshot', 'text/html', 10)).toMatch(/Unsupported/);
    expect(validateUpload('video', 'video/webm', 0)).toMatch(/empty/);
    expect(validateUpload('screenshot', 'image/png', 1e12)).toMatch(/limit/);
  });
  it('sanitizes filenames', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(sanitizeFilename('  ')).toBe('untitled');
    expect(sanitizeFilename('a'.repeat(500))).toHaveLength(200);
  });
});
