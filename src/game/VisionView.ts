// Darkness beyond what the player can see. A dark sheet covers the screen; a hole shaped like the
// player's view (a circle cut by walls) is punched through it with a geometry mask.

import Phaser from 'phaser';
import type { GameMap } from '../sim/map';
import { seeThrough } from '../sim/vision';

const RAYS = 200;
const STEP_PX = 6;
const DARK_ALPHA = 0.94;
const DEBUG_ALPHA = 0.55;

export class VisionView {
  private readonly darkness: Phaser.GameObjects.Rectangle;
  private readonly hole: Phaser.GameObjects.Graphics;
  private readonly map: GameMap;
  private readonly points: Phaser.Math.Vector2[] = [];

  constructor(scene: Phaser.Scene, map: GameMap) {
    this.map = map;
    this.darkness = scene.add.rectangle(0, 0, scene.scale.width, scene.scale.height, 0x05070c, DARK_ALPHA).setOrigin(0).setScrollFactor(0).setDepth(40);
    this.hole = scene.make.graphics({ x: 0, y: 0 }, false);
    const mask = this.hole.createGeometryMask();
    mask.invertAlpha = true;
    this.darkness.setMask(mask);
    for (let i = 0; i < RAYS; i++) this.points.push(new Phaser.Math.Vector2());
  }

  /** Recomputes the visible shape around (x, y) out to radius pixels, stopping at walls. */
  update(x: number, y: number, radius: number, debug: boolean): void {
    this.darkness.setAlpha(debug ? DEBUG_ALPHA : DARK_ALPHA);
    const ts = this.map.tileSize;
    for (let i = 0; i < RAYS; i++) {
      const a = (i / RAYS) * Math.PI * 2;
      const dx = Math.cos(a) * STEP_PX;
      const dy = Math.sin(a) * STEP_PX;
      let px = x;
      let py = y;
      let travelled = 0;
      while (travelled < radius) {
        const nx = px + dx;
        const ny = py + dy;
        if (!seeThrough(this.map, Math.floor(nx / ts), Math.floor(ny / ts))) break;
        px = nx;
        py = ny;
        travelled += STEP_PX;
      }
      (this.points[i] as Phaser.Math.Vector2).set(px, py);
    }
    this.hole.clear();
    this.hole.fillStyle(0xffffff, 1);
    this.hole.fillPoints(this.points, true, true);
  }

  setVisible(visible: boolean): void {
    this.darkness.setVisible(visible);
  }

  destroy(): void {
    this.darkness.destroy();
    this.hole.destroy();
  }
}
