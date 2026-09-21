#!/usr/bin/env node
/**
 * Generates the PWA icon set as real PNGs.
 *
 * iOS requires a PNG for apple-touch-icon (it will not use an SVG), so rather
 * than pulling in a rasteriser dependency this writes the PNGs directly:
 * a rounded gradient square with a music note, encoded with zlib.
 *
 *   node scripts/generate-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
const SIZES = [180, 192, 512];

/* -- tiny PNG encoder ------------------------------------------------------ */

function crc32(buf) {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let b = 0; b < 8; b++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(width, height, rgba) {
  // Each scanline is prefixed with a filter byte (0 = None).
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -- drawing --------------------------------------------------------------- */

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Signed distance to a rounded rectangle, used for the squircle mask. */
function roundedRectAlpha(x, y, w, h, radius) {
  const dx = Math.max(Math.abs(x - w / 2) - (w / 2 - radius), 0);
  const dy = Math.max(Math.abs(y - h / 2) - (h / 2 - radius), 0);
  const distance = Math.hypot(dx, dy) - radius;
  // 1px of smoothing gives a clean edge without a real antialiasing pass.
  return clamp01(0.5 - distance);
}

/** Coverage of a filled ellipse, antialiased. */
function ellipseAlpha(x, y, cx, cy, rx, ry, rotation = 0) {
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const px = (x - cx) * cos + (y - cy) * sin;
  const py = -(x - cx) * sin + (y - cy) * cos;
  const d = Math.hypot(px / rx, py / ry);
  return clamp01((1 - d) * Math.min(rx, ry) + 0.5);
}

/** Coverage of an axis-aligned rounded bar. */
function barAlpha(x, y, left, top, w, h, radius) {
  return roundedRectAlpha(x - left, y - top, w, h, radius);
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const s = (v) => (v * size) / 512; // author at 512 and scale down

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;

      // Diagonal gradient, matching the app's accent.
      const t = clamp01((x / size + y / size) / 2);
      let r = lerp(255, 123, t);
      let g = lerp(55, 47, t);
      let b = lerp(95, 247, t);

      // Music note in white, drawn as two note heads, a stem and a beam.
      const note =
        Math.max(
          ellipseAlpha(x, y, s(186), s(356), s(62), s(48), -0.32),
          ellipseAlpha(x, y, s(338), s(318), s(62), s(48), -0.32),
          barAlpha(x, y, s(236), s(150), s(26), s(212), s(13)),
          barAlpha(x, y, s(388), s(112), s(26), s(212), s(13)),
          // Beam joining the two stems.
          (() => {
            const top = s(112) + ((x - s(236)) / (s(414) - s(236))) * s(0);
            return barAlpha(x, y, s(236), top, s(178), s(54), s(16));
          })(),
        );

      if (note > 0) {
        r = lerp(r, 255, note);
        g = lerp(g, 255, note);
        b = lerp(b, 255, note);
      }

      const alpha = roundedRectAlpha(x, y, size, size, s(114));

      rgba[i] = Math.round(r);
      rgba[i + 1] = Math.round(g);
      rgba[i + 2] = Math.round(b);
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, size, rgba);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const path = join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(path, drawIcon(size));
  console.log(`wrote ${path}`);
}

// Maskable variant: same art, no rounding, so Android can crop it to any shape.
const maskable = (() => {
  const size = 512;
  const rgba = Buffer.alloc(size * size * 4);
  const base = drawIcon(size);
  void base;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const t = clamp01((x / size + y / size) / 2);
      const s = (v) => v;
      const note = Math.max(
        ellipseAlpha(x, y, s(186), s(356), s(62), s(48), -0.32),
        ellipseAlpha(x, y, s(338), s(318), s(62), s(48), -0.32),
        barAlpha(x, y, s(236), s(150), s(26), s(212), s(13)),
        barAlpha(x, y, s(388), s(112), s(26), s(212), s(13)),
        barAlpha(x, y, s(236), s(112), s(178), s(54), s(16)),
      );
      rgba[i] = Math.round(lerp(lerp(255, 123, t), 255, note));
      rgba[i + 1] = Math.round(lerp(lerp(55, 47, t), 255, note));
      rgba[i + 2] = Math.round(lerp(lerp(95, 247, t), 255, note));
      rgba[i + 3] = 255;
    }
  }
  return encodePng(size, size, rgba);
})();
writeFileSync(join(OUT_DIR, 'icon-maskable-512.png'), maskable);
console.log(`wrote ${join(OUT_DIR, 'icon-maskable-512.png')}`);
