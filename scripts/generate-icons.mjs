// Generates the SnapShare PNG icons without external dependencies.
// Logo: indigo rounded square, white "shutter" ring with a share-arrow notch.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const r = size * 0.22;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      // rounded-rect coverage
      const dx = Math.max(r - cx, 0, cx - (size - r));
      const dy = Math.max(r - cy, 0, cy - (size - r));
      const inside = Math.hypot(dx, dy) <= r;
      if (!inside) continue;
      const t = (cx + cy) / (2 * size);
      let R = Math.round(79 + (124 - 79) * t), G = Math.round(70 + (58 - 70) * t), B = Math.round(229 + (237 - 229) * t);
      const d = Math.hypot(cx - size / 2, cy - size / 2) / size;
      if (d > 0.2 && d < 0.32) { R = G = B = 255; }
      if (d <= 0.12) { R = G = B = 255; }
      const i = (y * size + x) * 4;
      px[i] = R; px[i + 1] = G; px[i + 2] = B; px[i + 3] = 255;
    }
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const outs = [resolve(root, 'extension/public/icons'), resolve(root, 'web/public')];
for (const dir of outs) mkdirSync(dir, { recursive: true });
for (const s of [16, 32, 48, 128]) writeFileSync(resolve(outs[0], `icon${s}.png`), render(s));
writeFileSync(resolve(outs[1], 'icon.png'), render(256));
console.log('icons written');
