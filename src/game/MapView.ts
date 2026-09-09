// Draws the ship: floor and wall tiles, room name labels and the emergency button.
// Placeholder visuals. All geometry comes from the loaded GameMap; nothing is hardcoded.

import Phaser from 'phaser';
import type { GameMap } from '../sim/map';

/**
 * Tile pictures. Walls come in four looks so the ship reads like a top-down room seen slightly from
 * the front (Greg, 2026-09-08): a wall with floor below it shows its tall front face; a wall with
 * floor above it is a low ledge; a wall beside floor is a thin edge; the rest is solid hull.
 */
const TILE_INDEX = {
  roomFloor: 0,
  corridorFloor: 1,
  wallFace: 2,
  wallLedge: 3,
  wallSide: 4,
  wallSolid: 5,
} as const;

const COLORS = {
  roomFloor: 0x3a4152,
  roomGrid: 0x424a5c,
  corridorFloor: 0x2f3542,
  corridorGrid: 0x363d4b,
  wallFace: 0x2b3245,
  wallFaceDark: 0x1f2534,
  wallTop: 0x6b7590,
  wallSolid: 0x1a1e2a,
  console: 0x1a1e2a,
  consoleScreen: 0xffc857,
  void: 0x0b0d12,
  label: '#9aa4bd',
  button: 0xd2372f,
  buttonRim: 0x5a1b17,
};

export class MapView {
  readonly layer: Phaser.Tilemaps.TilemapLayer;
  readonly widthPx: number;
  readonly heightPx: number;

  constructor(scene: Phaser.Scene, map: GameMap) {
    const ts = map.tileSize;
    this.widthPx = map.width * ts;
    this.heightPx = map.height * ts;

    MapView.ensureTileset(scene, ts);

    const tilemap = scene.make.tilemap({ tileWidth: ts, tileHeight: ts, width: map.width, height: map.height });
    const tileset = tilemap.addTilesetImage('tiles', 'tiles', ts, ts, 0, 0);
    if (!tileset) throw new Error('Tileset texture missing.');
    const layer = tilemap.createBlankLayer('ground', tileset);
    if (!layer) throw new Error('Could not create the ground layer.');
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const kind = map.tileAt(x, y);
        if (kind === 'void') continue; // transparent: the stars show through
        let index: number = TILE_INDEX.wallSolid;
        if (kind === 'wall') index = MapView.wallVariant(map, x, y);
        else if (kind === 'floor' || kind === 'button' || kind === 'object') {
          index = map.regionAt(x, y)?.kind === 'room' || kind !== 'floor' ? TILE_INDEX.roomFloor : TILE_INDEX.corridorFloor;
        }
        layer.putTileAt(index, x, y);
      }
    }
    layer.setDepth(0);
    this.layer = layer;

    // Room name labels, centred in each room's rectangle.
    for (const room of map.rooms) {
      if (!room.rect) continue;
      const cx = (room.rect.x + room.rect.w / 2) * ts;
      const cy = (room.rect.y + room.rect.h / 2) * ts;
      scene.add
        .text(cx, cy, room.name.toUpperCase(), {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '18px',
          fontStyle: 'bold',
          color: COLORS.label,
        })
        .setOrigin(0.5)
        .setAlpha(0.55)
        .setDepth(1);
    }

    const g = scene.add.graphics().setDepth(2);
    // Task consoles: a small panel with a screen on every task spot, so rooms show where work is.
    for (const spot of map.tasks) {
      const x = spot.pos[0] * ts;
      const y = spot.pos[1] * ts;
      g.fillStyle(COLORS.console, 1).fillRoundedRect(x + 7, y + 6, ts - 14, ts - 12, 3);
      g.fillStyle(COLORS.consoleScreen, 0.9).fillRect(x + 10, y + 9, ts - 20, 8);
      g.fillStyle(0x596279, 1).fillRect(x + 10, y + 20, 4, 3).fillRect(x + 16, y + 20, 4, 3);
    }
    // Emergency button: a red disc on its tile.
    if (map.button) {
      const [bx, by] = map.button;
      g.fillStyle(COLORS.buttonRim, 1).fillCircle(bx * ts + ts / 2, by * ts + ts / 2, ts * 0.42);
      g.fillStyle(COLORS.button, 1).fillCircle(bx * ts + ts / 2, by * ts + ts / 2, ts * 0.3);
    }
    // Usable objects (lobby computer, start pad). Placeholder drawings.
    for (const obj of map.objects) {
      const x = obj.pos[0] * ts;
      const y = obj.pos[1] * ts;
      const w = obj.size[0] * ts;
      const h = obj.size[1] * ts;
      if (obj.type === 'computer') {
        g.fillStyle(0x1a1e2a, 1).fillRoundedRect(x + 2, y + 4, w - 4, h - 6, 4);
        g.fillStyle(0x2fd3e6, 1).fillRect(x + 8, y + 9, w - 16, h - 18);
        g.fillStyle(0xd8f6fb, 0.8).fillRect(x + 12, y + 12, w - 40, 3);
        scene.add
          .text(x + w / 2, y - 6, 'SETTINGS', { fontFamily: 'system-ui, sans-serif', fontSize: '12px', fontStyle: 'bold', color: COLORS.label })
          .setOrigin(0.5, 1)
          .setDepth(2);
      } else if (obj.type === 'start') {
        g.fillStyle(0x1f7a3a, 1).fillCircle(x + w / 2, y + h / 2, Math.min(w, h) * 0.46);
        g.fillStyle(0x3ccf6a, 1).fillCircle(x + w / 2, y + h / 2, Math.min(w, h) * 0.36);
        scene.add
          .text(x + w / 2, y + h / 2, 'START', { fontFamily: 'system-ui, sans-serif', fontSize: '14px', fontStyle: 'bold', color: '#0b2a14' })
          .setOrigin(0.5)
          .setDepth(2);
      } else {
        g.fillStyle(0x596279, 1).fillRect(x + 2, y + 2, w - 4, h - 4);
      }
    }
  }

  /** Which wall look a wall tile gets, from where the floor is around it. */
  private static wallVariant(map: GameMap, x: number, y: number): number {
    const open = (tx: number, ty: number) => {
      const k = map.tileAt(tx, ty);
      return k === 'floor' || k === 'button' || k === 'object';
    };
    if (open(x, y + 1)) return TILE_INDEX.wallFace;
    if (open(x, y - 1)) return TILE_INDEX.wallLedge;
    if (open(x - 1, y) || open(x + 1, y)) return TILE_INDEX.wallSide;
    return TILE_INDEX.wallSolid;
  }

  /** Draws the placeholder tile graphics once into a texture the tilemap can use. */
  private static ensureTileset(scene: Phaser.Scene, ts: number): void {
    if (scene.textures.exists('tiles')) return;
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    const tile = (index: number, fill: number, grid: number | null) => {
      const x = index * ts;
      g.fillStyle(fill, 1).fillRect(x, 0, ts, ts);
      if (grid !== null) {
        g.lineStyle(1, grid, 1);
        g.strokeRect(x + 0.5, 0.5, ts - 1, ts - 1);
      }
    };
    tile(TILE_INDEX.roomFloor, COLORS.roomFloor, COLORS.roomGrid);
    tile(TILE_INDEX.corridorFloor, COLORS.corridorFloor, COLORS.corridorGrid);
    // Front face: light top edge, then a tall face that darkens toward the floor below it.
    {
      const x = TILE_INDEX.wallFace * ts;
      g.fillStyle(COLORS.wallFace, 1).fillRect(x, 0, ts, ts);
      g.fillStyle(COLORS.wallFaceDark, 1).fillRect(x, Math.round(ts * 0.65), ts, Math.round(ts * 0.35));
      g.fillStyle(COLORS.wallTop, 1).fillRect(x, 0, ts, Math.round(ts * 0.22));
      g.fillStyle(0x3a4358, 1).fillRect(x, Math.round(ts * 0.22), ts, 2);
    }
    // Ledge: the top surface of a low wall in front of the floor above it.
    {
      const x = TILE_INDEX.wallLedge * ts;
      g.fillStyle(COLORS.wallSolid, 1).fillRect(x, 0, ts, ts);
      g.fillStyle(COLORS.wallTop, 1).fillRect(x, 0, ts, Math.round(ts * 0.45));
      g.fillStyle(0x4d566c, 1).fillRect(x, Math.round(ts * 0.45), ts, 3);
    }
    // Side: a thin light edge down the middle of the tile.
    {
      const x = TILE_INDEX.wallSide * ts;
      g.fillStyle(COLORS.wallSolid, 1).fillRect(x, 0, ts, ts);
      g.fillStyle(COLORS.wallTop, 1).fillRect(x + Math.round(ts * 0.3), 0, Math.round(ts * 0.4), ts);
    }
    tile(TILE_INDEX.wallSolid, COLORS.wallSolid, null);
    g.generateTexture('tiles', ts * 6, ts);
    g.destroy();
  }
}
