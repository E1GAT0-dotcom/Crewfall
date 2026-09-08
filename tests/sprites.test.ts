import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ASSETS = new URL('../assets/', import.meta.url);

interface Sheet {
  file: string;
  frameWidth: number;
  frameHeight: number;
  frames: number;
  frameRate: number;
}

/** Reads width and height from a PNG header without any image library. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  signature.forEach((b, i) => expect(bytes[i]).toBe(b));
  expect(bytes.toString('ascii', 12, 16)).toBe('IHDR');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('sprite manifest', () => {
  const manifest = JSON.parse(readFileSync(new URL('sprites/manifest.json', ASSETS), 'utf8')) as { sheets: Record<string, Sheet> };

  it('has both layers for idle and walk (SPEC 11.1, Phase 1 subset)', () => {
    for (const name of ['unit.base.idle', 'unit.detail.idle', 'unit.base.walk', 'unit.detail.walk']) {
      expect(manifest.sheets[name], name).toBeDefined();
    }
    expect(manifest.sheets['unit.base.idle']?.frames).toBe(4);
    expect(manifest.sheets['unit.base.walk']?.frames).toBe(8);
  });

  it('every sheet file exists and its size matches the frame count', () => {
    for (const [name, sheet] of Object.entries(manifest.sheets)) {
      const url = new URL(sheet.file, ASSETS);
      expect(existsSync(url), `${name}: ${sheet.file} missing (run npm run gen-sprites)`).toBe(true);
      const size = pngSize(readFileSync(url));
      expect(size.width, `${name} width`).toBe(sheet.frameWidth * sheet.frames);
      expect(size.height, `${name} height`).toBe(sheet.frameHeight);
      expect(sheet.frameWidth).toBe(64);
      expect(sheet.frameHeight).toBe(64);
      expect(sheet.frameRate).toBeGreaterThan(0);
    }
  });

  it('base and detail layers of the same animation have identical frame counts', () => {
    for (const anim of ['idle', 'walk']) {
      expect(manifest.sheets[`unit.base.${anim}`]?.frames).toBe(manifest.sheets[`unit.detail.${anim}`]?.frames);
    }
  });
});
