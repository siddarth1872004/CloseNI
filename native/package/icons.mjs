#!/usr/bin/env node
/*
 * Makes the Windows and macOS icons from build/icon.png, the 512x512 PNG
 * scripts/make-icon.mjs rasterises from build/icon.svg.
 *
 *   node native/package/icons.mjs
 *
 * Writes native/package/closeni.ico and closeni.icns. Both are committed,
 * because CMake embeds them at build time (the .ico through closeni.rc, the
 * .icns into the bundle) and a build must not need this script to have run.
 * Rerun it after changing build/icon.png.
 *
 * No image library: the icon is pixel art on a 32-unit grid, so downscaling is
 * an area average, and both formats accept PNG payloads. Node's zlib is enough
 * to read and write those.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

// ------------------------------------------------------------------ PNG ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Decodes an 8-bit, non-interlaced greyscale, RGB or RGBA PNG to RGBA. */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const kind = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; type = data[9]; interlace = data[12];
    } else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    pos += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
  if (depth !== 8 || !channels || interlace) throw new Error(`unsupported PNG (depth ${depth}, type ${type}, interlace ${interlace})`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[y * stride + x - channels] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? px[(y - 1) * stride + x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = v & 0xff;
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = px.subarray(i * channels, (i + 1) * channels);
    const [r, g, b, a] = channels === 1 ? [s[0], s[0], s[0], 255] : channels === 2 ? [s[0], s[0], s[0], s[1]]
      : channels === 3 ? [s[0], s[1], s[2], 255] : [s[0], s[1], s[2], s[3]];
    rgba.set([r, g, b, a], i * 4);
  }
  return { width, height, rgba };
}

function chunk(kind, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(kind, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePng({ width, height, rgba }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Area-average downscale: each target pixel is the mean of the source area it covers. */
function scale(img, size) {
  if (size === img.width) return img;
  const out = Buffer.alloc(size * size * 4);
  const f = img.width / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0];
      let wsum = 0;
      for (let sy = Math.floor(y * f); sy < Math.ceil((y + 1) * f); sy++) {
        const wy = Math.min(sy + 1, (y + 1) * f) - Math.max(sy, y * f);
        for (let sx = Math.floor(x * f); sx < Math.ceil((x + 1) * f); sx++) {
          const w = wy * (Math.min(sx + 1, (x + 1) * f) - Math.max(sx, x * f));
          const i = (sy * img.width + sx) * 4;
          for (let k = 0; k < 4; k++) acc[k] += img.rgba[i + k] * w;
          wsum += w;
        }
      }
      for (let k = 0; k < 4; k++) out[(y * size + x) * 4 + k] = Math.round(acc[k] / wsum);
    }
  }
  return { width: size, height: size, rgba: out };
}

// ---------------------------------------------------------- ICO and ICNS ----

/** An .ico whose entries are PNGs (Windows Vista and later read these). */
function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    head[e] = size >= 256 ? 0 : size; head[e + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(png.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...images.map((i) => i.png)]);
}

/** An .icns of PNG entries, keyed by the OSType each pixel size uses. */
function icns(entries) {
  const parts = entries.map(([type, png]) => {
    const h = Buffer.alloc(8);
    h.write(type, 0, 'latin1'); h.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([h, png]);
  });
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(8);
  h.write('icns', 0, 'latin1'); h.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([h, body]);
}

const src = decodePng(readFileSync(join(ROOT, 'build/icon.png')));
if (src.width !== 512 || src.height !== 512) throw new Error(`build/icon.png is ${src.width}x${src.height}, expected 512x512`);
const png = {};
for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) png[size] = encodePng(scale(src, size));

writeFileSync(join(HERE, 'closeni.ico'), ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: png[size] }))));
writeFileSync(join(HERE, 'closeni.icns'), icns([
  ['icp4', png[16]], ['icp5', png[32]], ['icp6', png[64]], ['ic07', png[128]], ['ic08', png[256]], ['ic09', png[512]],
  ['ic11', png[32]], ['ic12', png[64]], ['ic13', png[256]], ['ic14', png[512]],
]));
console.log('wrote native/package/closeni.ico and closeni.icns');
