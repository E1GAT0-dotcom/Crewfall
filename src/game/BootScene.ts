// Loads the manifests, then everything they point at, then opens the lobby.

import Phaser from 'phaser';
import { loadMap, type GameMap } from '../sim/map';
import { assetUrl, MANIFEST_KEYS, mapKey, sheetKey, type MapsManifest, type SpritesManifest } from './assets';
import { PlayScene, type PlaySceneData } from './PlayScene';
import { StarsScene } from './StarsScene';
import { loadStoredSettings } from '../ui/settingsStore';

const LOBBY_MAP_ID = 'lobby';
const DEFAULT_MATCH_MAP_ID = 'kestrel';

export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  preload(): void {
    this.load.json(MANIFEST_KEYS.maps, assetUrl('maps/manifest.json'));
    this.load.json(MANIFEST_KEYS.sprites, assetUrl('sprites/manifest.json'));
  }

  create(): void {
    const mapsManifest = this.cache.json.get(MANIFEST_KEYS.maps) as MapsManifest;
    const sprites = this.cache.json.get(MANIFEST_KEYS.sprites) as SpritesManifest;

    for (const id of [LOBBY_MAP_ID, DEFAULT_MATCH_MAP_ID]) {
      if (!mapsManifest.maps.some((m) => m.id === id)) {
        this.showError(`maps/manifest.json has no map with id "${id}".`);
        return;
      }
    }

    // Second loading pass: every map and sprite sheet named by the manifests.
    for (const entry of mapsManifest.maps) this.load.json(mapKey(entry.id), assetUrl(entry.file));
    for (const [name, sheet] of Object.entries(sprites.sheets)) {
      this.load.spritesheet(sheetKey(name), assetUrl(sheet.file), {
        frameWidth: sheet.frameWidth,
        frameHeight: sheet.frameHeight,
      });
    }
    this.load.once(Phaser.Loader.Events.COMPLETE, () => {
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
        this.anims.create({
          key: sheetKey(name),
          frames: this.anims.generateFrameNumbers(sheetKey(name), { start: 0, end: sheet.frames - 1 }),
          frameRate: sheet.frameRate,
          repeat: -1,
        });
      }
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
      this.scene.launch(StarsScene.KEY);
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
