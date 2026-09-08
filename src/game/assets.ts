// Manifest shapes and the helpers that turn logical names into Phaser keys.
// Game code never mentions a file name: it asks the manifests.

export interface SpriteSheetEntry {
  readonly file: string;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly frames: number;
  readonly frameRate: number;
}

export interface SpritesManifest {
  readonly sheets: Readonly<Record<string, SpriteSheetEntry>>;
}

export interface MapsManifestEntry {
  readonly id: string;
  readonly name: string;
  readonly file: string;
}

export interface MapsManifest {
  readonly maps: readonly MapsManifestEntry[];
}

/** Files under assets/ are served from the site root (see vite.config.ts publicDir). */
export function assetUrl(relativeToAssets: string): string {
  return `/${relativeToAssets.replace(/^\/+/, '')}`;
}

export const MANIFEST_KEYS = {
  maps: 'manifest:maps',
  sprites: 'manifest:sprites',
} as const;

export function mapKey(id: string): string {
  return `map:${id}`;
}

/** Texture key for a sheet, e.g. "unit.base.walk". Animation key is the same string. */
export function sheetKey(logicalName: string): string {
  return logicalName;
}

/** Unit animations are named "unit.<layer>.<anim>". */
export function unitSheet(layer: 'base' | 'detail', anim: 'idle' | 'walk'): string {
  return `unit.${layer}.${anim}`;
}
