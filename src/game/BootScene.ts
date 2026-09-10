// The loading screen. Loads the manifests, then everything they point at, showing "loaded X/Y" over
// the star background with a few units drifting past, then opens the lobby (Greg, 2026-09-09).
// The total adjusts itself: it is the number of files the manifests name, so a new map, sprite
// sheet or sound is counted the moment it is listed.

import Phaser from 'phaser';
import gameConfig from '../../config/game.json';
import { loadMap, type GameMap } from '../sim/map';
import { COLORS } from '../sim/sim';
import { assetUrl, MANIFEST_KEYS, mapKey, sheetKey, unitSheet, type MapsManifest, type SpritesManifest } from './assets';
import { PlayScene, type PlaySceneData } from './PlayScene';
import { StarsScene } from './StarsScene';
import { loadStoredSettings } from '../ui/settingsStore';

const LOBBY_MAP_ID = 'lobby';
const DEFAULT_MATCH_MAP_ID = 'kestrel';
const FLOATERS = 8;

interface Floater {
  base: Phaser.GameObjects.Sprite;
  detail: Phaser.GameObjects.Sprite;
  vx: number;
  vy: number;
  bob: number;
}

export class BootScene extends Phaser.Scene {
  private title!: Phaser.GameObjects.Text;
  private status!: Phaser.GameObjects.Text;
  private bar!: Phaser.GameObjects.Graphics;
  private loaded = 0;
  private total = 0;
  private startedAt = 0;
  private floaters: Floater[] = [];
  private failed = false;

  constructor() {
    super('Boot');
  }

  create(): void {
    this.scene.launch(StarsScene.KEY);
    this.scene.bringToTop();
    this.startedAt = this.time.now;
    const W = this.scale.width;
    const H = this.scale.height;
    this.title = this.add
      .text(W / 2, H * 0.36, 'CREWFALL', { fontFamily: 'system-ui, Segoe UI, sans-serif', fontSize: '64px', fontStyle: 'bold', color: '#e6ebf5' })
      .setOrigin(0.5)
      .setShadow(0, 4, '#000000', 12, false, true)
      .setDepth(10);
    this.status = this.add
      .text(W / 2, H * 0.36 + 60, 'loading manifests…', { fontFamily: 'system-ui, Segoe UI, sans-serif', fontSize: '18px', color: '#8f9ab5' })
      .setOrigin(0.5)
      .setDepth(10);
    this.bar = this.add.graphics().setDepth(10);
    this.drawBar();

    // First pass: the manifests themselves. They count as assets too.
    this.total = 2;
    this.load.json(MANIFEST_KEYS.maps, assetUrl('maps/manifest.json'));
    this.load.json(MANIFEST_KEYS.sprites, assetUrl('sprites/manifest.json'));
    this.load.on(Phaser.Loader.Events.FILE_COMPLETE, this.onFileComplete, this);
    this.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, (file: Phaser.Loader.File) => {
      this.showError(`Could not load "${file.url}". Check the manifests in the assets folder.`);
    });
    this.load.once(Phaser.Loader.Events.COMPLETE, () => this.secondPass());
    this.load.start();
  }

  override update(_time: number, deltaMs: number): void {
    const W = this.scale.width;
    const H = this.scale.height;
    const dt = deltaMs / 1000;
    for (const f of this.floaters) {
      f.bob += dt;
      let x = f.base.x + f.vx * dt;
      let y = f.base.y + f.vy * dt;
      if (x < -40) x = W + 40;
      if (x > W + 40) x = -40;
      if (y < -40) y = H + 40;
      if (y > H + 40) y = -40;
      const wobble = Math.sin(f.bob * 1.7) * 4;
      f.base.setPosition(x, y + wobble);
      f.detail.setPosition(x, y + wobble);
    }
  }

  /** Second pass: every file the manifests name. Sprites first so the floaters can appear early. */
  private secondPass(): void {
    if (this.failed) return;
    const mapsManifest = this.cache.json.get(MANIFEST_KEYS.maps) as MapsManifest;
    const sprites = this.cache.json.get(MANIFEST_KEYS.sprites) as SpritesManifest;
    for (const id of [LOBBY_MAP_ID, DEFAULT_MATCH_MAP_ID]) {
      if (!mapsManifest.maps.some((m) => m.id === id)) {
        this.showError(`maps/manifest.json has no map with id "${id}".`);
        return;
      }
    }
    const sheets = Object.entries(sprites.sheets);
    this.total = 2 + sheets.length + mapsManifest.maps.length;
    this.drawBar();
    for (const [name, sheet] of sheets) {
      this.load.spritesheet(sheetKey(name), assetUrl(sheet.file), { frameWidth: sheet.frameWidth, frameHeight: sheet.frameHeight });
    }
    for (const entry of mapsManifest.maps) this.load.json(mapKey(entry.id), assetUrl(entry.file));
    this.load.once(Phaser.Loader.Events.COMPLETE, () => this.finish(mapsManifest, sprites));
    this.load.start();
  }

  private onFileComplete(key: string): void {
    this.loaded++;
    this.drawBar();
    // Once both idle sheets are in, units can drift across the screen.
    const idleBase = unitSheet('base', 'idle');
    const idleDetail = unitSheet('detail', 'idle');
    if ((key === idleBase || key === idleDetail) && this.textures.exists(idleBase) && this.textures.exists(idleDetail) && this.floaters.length === 0) {
      this.spawnFloaters();
    }
  }

  private spawnFloaters(): void {
    const sprites = this.cache.json.get(MANIFEST_KEYS.sprites) as SpritesManifest;
    const idle = sprites.sheets[unitSheet('base', 'idle')];
    for (const layer of ['base', 'detail'] as const) {
      const key = unitSheet(layer, 'idle');
      if (!this.anims.exists(key) && idle) {
        this.anims.create({ key, frames: this.anims.generateFrameNumbers(key, { start: 0, end: idle.frames - 1 }), frameRate: idle.frameRate, repeat: -1 });
      }
    }
    const W = this.scale.width;
    const H = this.scale.height;
    const colours = Phaser.Utils.Array.Shuffle([...COLORS]).slice(0, FLOATERS);
    colours.forEach((c, i) => {
      const x = Phaser.Math.Between(40, W - 40);
      const y = Phaser.Math.Between(40, H - 40);
      const speed = Phaser.Math.Between(12, 28);
      const angle = Phaser.Math.FloatBetween(0, Math.PI * 2);
      const tint = Phaser.Display.Color.HexStringToColor(c.tint).color;
      const base = this.add.sprite(x, y, unitSheet('base', 'idle')).setTint(tint).setDepth(5).setAlpha(0.9);
      const detail = this.add.sprite(x, y, unitSheet('detail', 'idle')).setDepth(5).setAlpha(0.9);
      const flip = Math.cos(angle) < 0;
      base.setFlipX(flip);
      detail.setFlipX(flip);
      base.play(unitSheet('base', 'idle'));
      detail.play(unitSheet('detail', 'idle'));
      base.anims.setProgress((i / FLOATERS) % 1);
      detail.anims.setProgress((i / FLOATERS) % 1);
      this.floaters.push({ base, detail, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, bob: i });
    });
  }

  private finish(mapsManifest: MapsManifest, sprites: SpritesManifest): void {
    if (this.failed) return;
    const maps: Record<string, GameMap> = {};
    for (const entry of mapsManifest.maps) {
      try {
        maps[entry.id] = loadMap(this.cache.json.get(mapKey(entry.id)));
      } catch (err) {
        this.showError(`Map "${entry.name}" failed to load: ${(err as Error).message}`);
        return;
      }
    }
    for (const [name, sheet] of Object.entries(sprites.sheets)) {
      if (this.anims.exists(sheetKey(name))) continue;
      this.anims.create({
        key: sheetKey(name),
        frames: this.anims.generateFrameNumbers(sheetKey(name), { start: 0, end: sheet.frames - 1 }),
        frameRate: sheet.frameRate,
        repeat: -1,
      });
    }
    this.loaded = this.total;
    this.drawBar();
    this.status.setText(`loaded ${this.loaded}/${this.total} assets`);
    // Let the screen be seen for a moment even on a fast machine.
    const elapsed = this.time.now - this.startedAt;
    const wait = Math.max(0, gameConfig.loading.minSeconds * 1000 - elapsed);
    this.time.delayedCall(wait, () => {
      const stored = loadStoredSettings();
      const data: PlaySceneData = {
        mode: 'lobby',
        maps,
        lobbyMapId: LOBBY_MAP_ID,
        matchMapId: DEFAULT_MATCH_MAP_ID,
        sprites,
        settings: stored.settings,
        seedText: stored.seedText,
      };
      this.scene.start(PlayScene.KEY, data);
    });
  }

  private drawBar(): void {
    const W = this.scale.width;
    const H = this.scale.height;
    const barW = 360;
    const barH = 14;
    const x = W / 2 - barW / 2;
    const y = H * 0.36 + 90;
    const fraction = this.total > 0 ? Math.min(1, this.loaded / this.total) : 0;
    this.bar.clear();
    this.bar.fillStyle(0x1a1e2a, 0.9).fillRoundedRect(x, y, barW, barH, 7);
    if (fraction > 0) this.bar.fillStyle(0x2fd3e6, 1).fillRoundedRect(x, y, Math.max(barH, barW * fraction), barH, 7);
    if (this.total > 2 || this.loaded > 0) this.status.setText(`loading assets ${Math.min(this.loaded, this.total)}/${this.total}`);
  }

  private showError(message: string): void {
    this.failed = true;
    console.error(message);
    this.status.setText(message).setColor('#ff8080').setWordWrapWidth(this.scale.width - 80);
  }
}
