// Generates the placeholder unit sprite sheets and writes them as PNG files.
// Run with: npm run gen-sprites
//
// Output follows SPEC 11.1: 64x64 frames, two layers per animation.
//   base   - grayscale body, tinted to the player's colour by the game
//   detail - fixed colours: outline, visor, feet shading
// The final art in Phase 7 replaces these files with same-named, same-sized sheets.
//
// The placeholder unit is a squat, wide "pod": a rounded, slightly hexagonal body with a broad
// visor band across its upper half and two stubby feet. Deliberately not a tall capsule shape.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'assets', 'sprites');
const FRAME = 64;

// ---------- tiny PNG writer (RGBA, no dependencies) ----------
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- drawing helpers ----------
class Canvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = Buffer.alloc(width * height * 4);
  }
  set(x, y, [r, g, b, a = 255]) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    this.data[i] = r;
    this.data[i + 1] = g;
    this.data[i + 2] = b;
    this.data[i + 3] = a;
  }
  get(x, y) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return [0, 0, 0, 0];
    const i = (y * this.width + x) * 4;
    return [this.data[i], this.data[i + 1], this.data[i + 2], this.data[i + 3]];
  }
}

/** Squircle test: a rounded shape between a circle and a box. n=2 circle, larger n = boxier. */
const inSquircle = (x, y, cx, cy, rx, ry, n) => Math.abs((x - cx) / rx) ** n + Math.abs((y - cy) / ry) ** n <= 1;

/** Body silhouette for one frame: returns true if (x, y) is body, feet or neither. */
function unitShape(x, y, bob, leftFootDy, rightFootDy) {
  const cx = 32;
  const cy = 30 + bob;
  // Body: wide pod, flat-ish top, tapered bottom.
  const taper = 1 - Math.max(0, (y - cy) / 90); // slightly narrower toward the bottom
  if (inSquircle(x, y, cx, cy, 17 * taper, 16, 3.4)) return 'body';
  // Feet: two stubby blocks under the body, offset by the walk cycle.
  if (inSquircle(x, y, cx - 8, 49 + leftFootDy, 5, 4, 2.5)) return 'foot';
  if (inSquircle(x, y, cx + 8, 49 + rightFootDy, 5, 4, 2.5)) return 'foot';
  return null;
}

function drawFrame(base, detail, ox, bob, leftFootDy, rightFootDy) {
  const shapeAt = (x, y) => unitShape(x, y, bob, leftFootDy, rightFootDy);
  const cy = 30 + bob;
  for (let y = 0; y < FRAME; y++) {
    for (let x = 0; x < FRAME; x++) {
      const s = shapeAt(x, y);
      if (!s) continue;
      // Base layer: grayscale with simple shading (lighter top-left, darker bottom-right).
      const shade = s === 'foot' ? 150 : 205 - Math.round(Math.max(0, (x - 24) * 1.2 + (y - cy) * 1.4));
      base.set(ox + x, y, [shade, shade, shade, 255]);
    }
  }
  // Outline on the detail layer: any body/foot pixel next to an empty pixel.
  for (let y = 0; y < FRAME; y++) {
    for (let x = 0; x < FRAME; x++) {
      if (!shapeAt(x, y)) continue;
      const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !shapeAt(x + dx, y + dy));
      if (edge) detail.set(ox + x, y, [26, 30, 46, 255]);
    }
  }
  // Visor: a broad band across the upper body, with a small glint.
  for (let y = 0; y < FRAME; y++) {
    for (let x = 0; x < FRAME; x++) {
      if (shapeAt(x, y) !== 'body') continue;
      if (inSquircle(x, y, 33, cy - 6, 11, 5, 3)) {
        const glint = inSquircle(x, y, 28, cy - 8, 3, 1.5, 2);
        detail.set(ox + x, y, glint ? [236, 250, 255, 255] : [150, 220, 240, 255]);
      }
    }
  }
  // Visor rim
  for (let y = 0; y < FRAME; y++) {
    for (let x = 0; x < FRAME; x++) {
      if (shapeAt(x, y) !== 'body') continue;
      const inside = inSquircle(x, y, 33, cy - 6, 11, 5, 3);
      const inner = inSquircle(x, y, 33, cy - 6, 10, 4, 3);
      if (inside && !inner) detail.set(ox + x, y, [40, 60, 90, 255]);
    }
  }
}

/** A deactivated unit: squashed body, dark cracked visor, sparks. Non-gory (SPEC 11.1). */
function drawDeadFrame(base, detail, ox) {
  const cx = 32, cy = 42;
  const shape = (x, y) => (inSquircle(x, y, cx, cy, 19, 11, 3.4) ? 'body' : null);
  for (let y = 0; y < FRAME; y++) for (let x = 0; x < FRAME; x++) {
    if (!shape(x, y)) continue;
    const shade = 175 - Math.round(Math.max(0, (x - 20) * 0.8 + (y - cy) * 1.6));
    base.set(ox + x, y, [shade, shade, shade, 255]);
  }
  for (let y = 0; y < FRAME; y++) for (let x = 0; x < FRAME; x++) {
    if (!shape(x, y)) continue;
    const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !shape(x + dx, y + dy));
    if (edge) detail.set(ox + x, y, [26, 30, 46, 255]);
  }
  // Dark visor with a crack.
  for (let y = 0; y < FRAME; y++) for (let x = 0; x < FRAME; x++) {
    if (shape(x, y) !== 'body') continue;
    if (inSquircle(x, y, 34, cy - 3, 12, 4, 3)) detail.set(ox + x, y, [40, 52, 70, 255]);
  }
  const crack = [[27, cy - 6], [28, cy - 5], [29, cy - 4], [28, cy - 3], [29, cy - 2], [30, cy - 1], [31, cy], [33, cy - 4], [34, cy - 3], [35, cy - 2]];
  for (const [x, y] of crack) detail.set(ox + x, y, [150, 190, 210, 255]);
  // Sparks.
  for (const [x, y] of [[50, cy - 12], [52, cy - 10], [12, cy - 8]]) detail.set(ox + x, y, [255, 220, 120, 255]);
  for (const [x, y] of [[51, cy - 11], [13, cy - 9]]) detail.set(ox + x, y, [255, 250, 200, 255]);
}

function makeSheet(frames, frameFn) {
  const base = new Canvas(FRAME * frames, FRAME);
  const detail = new Canvas(FRAME * frames, FRAME);
  for (let i = 0; i < frames; i++) {
    const { bob, left, right } = frameFn(i);
    drawFrame(base, detail, i * FRAME, bob, left, right);
  }
  return { base, detail };
}

const sheets = {
  idle: makeSheet(4, (i) => ({ bob: [0, -1, 0, 1][i], left: 0, right: 0 })),
  walk: makeSheet(8, (i) => {
    const phase = (i / 8) * Math.PI * 2;
    return {
      bob: Math.round(-Math.abs(Math.sin(phase)) * 2),
      left: Math.round(Math.sin(phase) * 3),
      right: Math.round(-Math.sin(phase) * 3),
    };
  }),
};

{
  const base = new Canvas(FRAME, FRAME);
  const detail = new Canvas(FRAME, FRAME);
  drawDeadFrame(base, detail, 0);
  sheets.dead = { base, detail };
}

mkdirSync(OUT_DIR, { recursive: true });
const written = [];
for (const [name, { base, detail }] of Object.entries(sheets)) {
  for (const [layer, canvas] of [['base', base], ['detail', detail]]) {
    const file = `unit_${layer}_${name}.png`;
    writeFileSync(join(OUT_DIR, file), encodePng(canvas.width, canvas.height, canvas.data));
    written.push(file);
  }
}
console.log('Wrote', written.join(', '), 'to', OUT_DIR);
