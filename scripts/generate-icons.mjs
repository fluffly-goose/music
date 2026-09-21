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

/** Coverage of a filled circle, antialiased. */
function discAlpha(x, y, cx, cy, r) {
  return clamp01(r - Math.hypot(x - cx, y - cy) + 0.5);
}

/**
 * Coverage of a stroked arc: a ring of radius `r` and thickness `width`,
 * drawn only within `span` radians either side of the horizontal axis, on
 * the left and right. This is the Resonance mark - a point sounding, with the
 * room answering on both sides.
 */
function arcAlpha(x, y, cx, cy, r, width, span) {
  const dx = x - cx;
  const dy = y - cy;
  const ring = Math.abs(Math.hypot(dx, dy) - r);
  if (ring > width / 2 + 1) return 0;

  const angle = Math.atan2(dy, dx);
  const onRight = Math.abs(angle) <= span;
  const onLeft = Math.abs(angle) >= Math.PI - span;
  if (!onRight && !onLeft) return 0;

  return clamp01(width / 2 - ring + 0.5);
}

/** The mark, drawn at whatever size, on a 512-unit design grid. */
function markAlpha(x, y, size) {
  const s = (v) => (v * size) / 512;
  const cx = size / 2;
  const cy = size / 2;
  const SPAN = 1.14; // radians either side of the horizontal axis

  return Math.max(
    discAlpha(x, y, cx, cy, s(55)),
    arcAlpha(x, y, cx, cy, s(144), s(34), SPAN),
    arcAlpha(x, y, cx, cy, s(224), s(30), SPAN),
  );
}

function drawIcon(size, options = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const s = (v) => (v * size) / 512;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;

      // Diagonal gradient, matching the app's accent.
      const t = clamp01((x / size + y / size) / 2);
      let r = lerp(255, 123, t);
      let g = lerp(55, 47, t);
      let b = lerp(95, 247, t);

      const mark = markAlpha(x, y, size);
      if (mark > 0) {
        r = lerp(r, 255, mark);
        g = lerp(g, 255, mark);
        b = lerp(b, 255, mark);
      }

      const alpha = options.square ? 1 : roundedRectAlpha(x, y, size, size, s(114));

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
writeFileSync(join(OUT_DIR, 'icon-maskable-512.png'), drawIcon(512, { square: true }));
console.log(`wrote ${join(OUT_DIR, 'icon-maskable-512.png')}`);
