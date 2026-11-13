// Creates a stable extension key so every unpacked install has the SAME extension ID
// (required by the Chrome Extension OAuth client). Run once; commit manifest/public-key.txt.
// The private key is only needed to pack a .crx and is written to extension/keys/ (git-ignored).
import { generateKeyPairSync, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const pubPath = join(root, 'manifest', 'public-key.txt');

export function extensionIdFromPublicKey(b64) {
  const hash = createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex').slice(0, 32);
  return [...hash].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

if (!existsSync(pubPath) || process.argv.includes('--force')) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  writeFileSync(pubPath, der.toString('base64') + '\n');
  mkdirSync(join(root, 'keys'), { recursive: true });
  writeFileSync(join(root, 'keys', 'snapshare-extension-private.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
  console.log('New key generated.');
}
const id = extensionIdFromPublicKey(readFileSync(pubPath, 'utf8').trim());
console.log(`Extension ID: ${id}`);
