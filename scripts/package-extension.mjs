// Packages extension/dist into release/snapshare-extension-<version>.zip for Chrome Web Store upload.
// Dependency-free ZIP writer (deflate). Refuses to package E2E test builds.
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'extension', 'dist');
if (!existsSync(join(dist, 'manifest.json'))) {
  console.error('extension/dist/manifest.json not found. Run: npm run build -w extension');
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
if (manifest.name.includes('E2E') || manifest.host_permissions?.includes('<all_urls>')) {
  console.error('Refusing to package a test build (E2E / <all_urls>).');
  process.exit(1);
}
if (!manifest.oauth2?.client_id || manifest.oauth2.client_id.startsWith('REPLACE_')) {
  console.warn('WARNING: no Google OAuth client id in this build (VITE_GOOGLE_CLIENT_ID). Capture/edit/record work; Google Drive sign-in will not.');
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));

const locals = [];
const centrals = [];
let offset = 0;
for (const file of walk(dist).filter((f) => !f.endsWith('.map'))) {
  const name = Buffer.from(relative(dist, file).split('\\').join('/'));
  const data = readFileSync(file);
  const comp = deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(0, 10);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  locals.push(local, name, comp);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(0, 12);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(comp.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(offset, 42);
  centrals.push(central, name);
  offset += 30 + name.length + comp.length;
}
const cd = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(centrals.length / 2, 8);
end.writeUInt16LE(centrals.length / 2, 10);
end.writeUInt32LE(cd.length, 12);
end.writeUInt32LE(offset, 16);
mkdirSync(join(root, 'release'), { recursive: true });
const out = join(root, 'release', `snapshare-extension-${manifest.version}.zip`);
writeFileSync(out, Buffer.concat([...locals, cd, end]));
console.log(`Wrote ${relative(root, out)} (${centrals.length / 2} files)`);
