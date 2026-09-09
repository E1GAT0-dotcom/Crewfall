// Draws the ship: floor and wall tiles, room name labels and the emergency button.
// Placeholder visuals. All geometry comes from the loaded GameMap; nothing is hardcoded.

import Phaser from 'phaser';
import type { GameMap } from '../sim/map';

const TILE_INDEX = {
  roomFloor: 0,
  corridorFloor: 1,
  wall: 2,
  void: 3,
} as const;

const COLORS = {
  roomFloor: 0x3a4152,
  roomGrid: 0x424a5c,
  corridorFloor: 0x2f3542,
  corridorGrid: 0x363d4b,
  wallFace: 0x232938,
  wallTop: 0x6b7590,
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
        let index: number = TILE_INDEX.void;
        if (kind === 'wall') index = TILE_INDEX.wall;
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
    tile(TILE_INDEX.wall, COLORS.wallFace, null);
    g.fillStyle(COLORS.wallTop, 1).fillRect(TILE_INDEX.wall * ts, 0, ts, Math.round(ts * 0.3));
    tile(TILE_INDEX.void, COLORS.void, null);
    g.generateTexture('tiles', ts * 4, ts);
    g.destroy();
  }
}
