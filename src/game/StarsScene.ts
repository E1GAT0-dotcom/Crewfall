// The star background: three layers of stars streaming past at different speeds, as if the pod or
// the ship is travelling. Runs as its own scene underneath the lobby and the match, so it never
// restarts when they do. Purely visual; nothing in the simulation depends on it.

import Phaser from 'phaser';
import gameConfig from '../../config/game.json';

interface StarLayer {
  readonly speed: number;
  readonly alpha: number;
  readonly scale: number;
  /** Length of each star in pixels; fast layers get streaks. */
  readonly streak: number;
}

const TEXTURE_SIZE = 512;
const STARS_PER_TEXTURE = 90;

export class StarsScene extends Phaser.Scene {
  static readonly KEY = 'Stars';

  private layers: { sprite: Phaser.GameObjects.TileSprite; speed: number }[] = [];

  constructor() {
    super(StarsScene.KEY);
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#05070c');
    const layers = gameConfig.stars.layers as readonly StarLayer[];
    layers.forEach((layer, i) => {
      const key = `stars-${i}`;
      if (!this.textures.exists(key)) this.makeStarTexture(key, layer.streak, 1000 + i * 77);
      const sprite = this.add
        .tileSprite(0, 0, this.scale.width, this.scale.height, key)
        .setOrigin(0)
        .setAlpha(layer.alpha)
        .setTileScale(layer.scale);
      this.layers.push({ sprite, speed: layer.speed });
    });
  }

  override update(_time: number, deltaMs: number): void {
    for (const l of this.layers) l.sprite.tilePositionY -= (l.speed * deltaMs) / 1000 / l.sprite.tileScaleY;
  }

  /** Random dots (and short vertical streaks) on a transparent square. A fixed seed keeps it identical every run. */
  private makeStarTexture(key: string, streak: number, seed: number): void {
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    let s = seed;
    const rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    for (let i = 0; i < STARS_PER_TEXTURE; i++) {
      const x = Math.floor(rnd() * TEXTURE_SIZE);
      const y = Math.floor(rnd() * TEXTURE_SIZE);
      const bright = 0.5 + rnd() * 0.5;
      const tint = rnd() < 0.15 ? 0xbfd8ff : rnd() < 0.1 ? 0xffe6c2 : 0xffffff;
      g.fillStyle(tint, bright);
      if (streak > 1) g.fillRect(x, y, 1, streak);
      else g.fillRect(x, y, 1, 1);
    }
    g.generateTexture(key, TEXTURE_SIZE, TEXTURE_SIZE);
    g.destroy();
  }
}
