// Loads the manifests, then everything they point at, then starts the game.

import Phaser from 'phaser';
import { loadMap, type GameMap } from '../sim/map';
import { assetUrl, MANIFEST_KEYS, mapKey, sheetKey, type MapsManifest, type SpritesManifest } from './assets';
import { PlayScene, type PlaySceneData } from './PlayScene';

const DEFAULT_MAP_ID = 'kestrel';

export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  preload(): void {
    this.load.json(MANIFEST_KEYS.maps, assetUrl('maps/manifest.json'));
    this.load.json(MANIFEST_KEYS.sprites, assetUrl('sprites/manifest.json'));
  }

  create(): void {
    const maps = this.cache.json.get(MANIFEST_KEYS.maps) as MapsManifest;
    const sprites = this.cache.json.get(MANIFEST_KEYS.sprites) as SpritesManifest;

    const mapEntry = maps.maps.find((m) => m.id === DEFAULT_MAP_ID);
    if (!mapEntry) {
      this.showError(`maps/manifest.json has no map with id "${DEFAULT_MAP_ID}".`);
      return;
    }

    // Second loading pass: the actual map and sprite sheets named by the manifests.
    this.load.json(mapKey(mapEntry.id), assetUrl(mapEntry.file));
    for (const [name, sheet] of Object.entries(sprites.sheets)) {
      this.load.spritesheet(sheetKey(name), assetUrl(sheet.file), {
        frameWidth: sheet.frameWidth,
        frameHeight: sheet.frameHeight,
      });
    }
    this.load.once(Phaser.Loader.Events.COMPLETE, () => {
      let map: GameMap;
      try {
        map = loadMap(this.cache.json.get(mapKey(mapEntry.id)));
      } catch (err) {
        this.showError(`Map "${mapEntry.name}" failed to load: ${(err as Error).message}`);
        return;
      }
      for (const [name, sheet] of Object.entries(sprites.sheets)) {
        this.anims.create({
          key: sheetKey(name),
          frames: this.anims.generateFrameNumbers(sheetKey(name), { start: 0, end: sheet.frames - 1 }),
          frameRate: sheet.frameRate,
          repeat: -1,
        });
      }
      const data: PlaySceneData = { map, sprites };
      this.scene.start(PlayScene.KEY, data);
    });
    this.load.once(Phaser.Loader.Events.FILE_LOAD_ERROR, (file: Phaser.Loader.File) => {
      this.showError(`Could not load "${file.url}". Check the manifests in the assets folder.`);
    });
    this.load.start();
  }

  private showError(message: string): void {
    console.error(message);
    this.add
      .text(this.scale.width / 2, this.scale.height / 2, message, {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '20px',
        color: '#ff8080',
        wordWrap: { width: this.scale.width - 80 },
        align: 'center',
      })
      .setOrigin(0.5);
  }
}
