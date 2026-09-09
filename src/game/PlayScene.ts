// The main scene. Runs the fixed-tick simulation, draws the map and every unit, follows the player.
// The same scene serves the lobby (mode 'lobby': settings computer and start pad) and a match
// (mode 'game'); starting a match restarts the scene with the match map.

import Phaser from 'phaser';
import gameConfig from '../../config/game.json';
import type { GameMap, MapObject } from '../sim/map';
import { randomSeed, seedFromText } from '../sim/rng';
import { defaultSettings, clampSettings, type GameSettings } from '../sim/settings';
import { COLORS, createGame, player as playerOf, stepSim, NO_INPUT, type PlayerInput, type SimMode, type SimState } from '../sim/sim';
import { cameraZoom, visionRadiusPx } from '../sim/vision';
import type { SpritesManifest } from './assets';
import { MapView } from './MapView';
import { NavGraphView } from './NavGraphView';
import { UnitView } from './UnitView';
import { VisionView } from './VisionView';
import { HudScene } from '../ui/HudScene';
import { SettingsPanel } from '../ui/SettingsPanel';
import { saveStoredSettings } from '../ui/settingsStore';

export interface PlaySceneData {
  mode: SimMode;
  maps: Record<string, GameMap>;
  lobbyMapId: string;
  matchMapId: string;
  sprites: SpritesManifest;
  settings?: GameSettings;
  /** What the seed box holds; empty means random. */
  seedText?: string;
  /** Fixed seed for this scene run (a match keeps the lobby's seed). */
  seed?: number;
  /** Where to put the player when the lobby is rebuilt after a settings change. */
  keepPlayerAt?: { x: number; y: number };
}

/** Keys Phaser must capture so the browser does not act on them (Tab moves focus, F3 opens search). */
const CAPTURED_KEYS = ['TAB', 'F3', 'SPACE', 'UP', 'DOWN', 'LEFT', 'RIGHT'];

const DEBUG_PATH_COLOUR = 0xffc857;
const DEBUG_VISION_COLOUR = 0x59d98c;
/** How close (in tiles) the player must be to use an object. */
const USE_RANGE_TILES = 1.6;

export class PlayScene extends Phaser.Scene {
  static readonly KEY = 'Play';

  private data_!: PlaySceneData;
  private mode: SimMode = 'lobby';
  private map!: GameMap;
  private settings!: GameSettings;
  private seedText = '';
  private seed = 0;
  private sim!: SimState;
  /** Positions at the previous tick, per unit id, for smooth drawing between ticks. */
  private prevPos: { x: number; y: number }[] = [];
  private accumulatorMs = 0;
  private readonly tickMs = 1000 / gameConfig.tickRate;

  private mapView!: MapView;
  private navView!: NavGraphView;
  private visionView!: VisionView;
  private unitViews: UnitView[] = [];
  private debugGraphics!: Phaser.GameObjects.Graphics;
  private debugOn = false;
  private settingsPanel: SettingsPanel | null = null;
  /** What pressing E would do right now, for the HUD. Null when nothing is in reach. */
  private usePrompt: string | null = null;
  private keys!: Record<'W' | 'A' | 'S' | 'D' | 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'E' | 'SPACE', Phaser.Input.Keyboard.Key>;

  constructor() {
    super(PlayScene.KEY);
  }

  init(data: PlaySceneData): void {
    this.data_ = data;
    this.mode = data.mode;
    const mapId = data.mode === 'lobby' ? data.lobbyMapId : data.matchMapId;
    const map = data.maps[mapId];
    if (!map) throw new Error(`No map loaded with id "${mapId}".`);
    this.map = map;
    const matchMap = data.maps[data.matchMapId] ?? map;
    this.settings = clampSettings(data.settings ?? defaultSettings(), { playerCap: matchMap.playerCap, impostorMax: matchMap.impostors.max });
    this.seedText = data.seedText ?? '';
    this.seed = data.seed ?? seedFromUrl() ?? (this.seedText ? seedFromText(this.seedText) : randomSeed());
    this.accumulatorMs = 0;
    this.debugOn = false;
    this.usePrompt = null;
  }

  create(): void {
    this.mapView = new MapView(this, this.map);
    this.sim = createGame(this.map, this.settings, this.seed, gameConfig, this.mode);
    const keep = this.data_.keepPlayerAt;
    if (keep && this.map.isWalkable(Math.floor(keep.x / this.map.tileSize), Math.floor(keep.y / this.map.tileSize))) {
      const p = playerOf(this.sim);
      p.x = keep.x;
      p.y = keep.y;
    }
    this.prevPos = this.sim.units.map((u) => ({ x: u.x, y: u.y }));

    this.unitViews = this.sim.units.map((u) => {
      const colour = COLORS.find((c) => c.id === u.colorId)?.tint ?? '#ffffff';
      const view = new UnitView(this, Phaser.Display.Color.HexStringToColor(colour).color, u.name);
      view.apply(u.x, u.y, u);
      return view;
    });

    const keyboard = this.input.keyboard;
    if (!keyboard) throw new Error('Keyboard input is not available.');
    keyboard.addCapture(CAPTURED_KEYS);
    this.keys = keyboard.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,E,SPACE') as PlayScene['keys'];

    const playerView = this.unitViews[0] as UnitView;
    const cam = this.cameras.main;
    // View distance is camera zoom (Greg, 2026-09-08). The lobby uses a fixed zoom that shows the whole pod.
    const zoom = this.mode === 'lobby' ? gameConfig.vision.lobbyZoom : cameraZoom(playerOf(this.sim).role, this.settings, gameConfig);
    cam.setZoom(zoom);
    // A map smaller than the view (the lobby) is centred rather than pinned to the top-left.
    const viewW = this.scale.width / zoom;
    const viewH = this.scale.height / zoom;
    const bx = Math.min(0, (this.mapView.widthPx - viewW) / 2);
    const by = Math.min(0, (this.mapView.heightPx - viewH) / 2);
    cam.setBounds(bx, by, Math.max(this.mapView.widthPx, viewW), Math.max(this.mapView.heightPx, viewH));
    cam.setRoundPixels(true);
    cam.centerOn(playerView.container.x, playerView.container.y);
    cam.startFollow(playerView.container, true, gameConfig.camera.followLerp, gameConfig.camera.followLerp);

    this.navView = new NavGraphView(this, this.map);
    this.debugGraphics = this.add.graphics().setDepth(6).setVisible(false);
    // Darkness is only for the lights sabotage (Phase 4); with the lights on the whole screen is visible.
    this.visionView = new VisionView(this, this.map);
    this.visionView.setVisible(false);

    if (this.mode === 'lobby') {
      const matchMap = this.data_.maps[this.data_.matchMapId] ?? this.map;
      this.settingsPanel = new SettingsPanel({ playerCap: matchMap.playerCap, impostorMax: matchMap.impostors.max });
    }
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.settingsPanel?.destroy();
      this.settingsPanel = null;
      this.visionView.destroy();
      this.scene.stop(HudScene.KEY);
    });

    this.scene.launch(HudScene.KEY);
  }

  override update(_time: number, deltaMs: number): void {
    const panelOpen = this.settingsPanel?.isOpen ?? false;
    // Fixed tick: the simulation always advances in equal steps no matter the frame rate.
    // If the tab was hidden and a huge delta arrives, cap it so we do not spiral trying to catch up.
    this.accumulatorMs += Math.min(deltaMs, this.tickMs * 5);
    const input = panelOpen ? NO_INPUT : this.readInput();
    while (this.accumulatorMs >= this.tickMs) {
      for (let i = 0; i < this.sim.units.length; i++) {
        const u = this.sim.units[i];
        const p = this.prevPos[i];
        if (u && p) {
          p.x = u.x;
          p.y = u.y;
        }
      }
      stepSim(this.sim, input, this.map, gameConfig);
      this.accumulatorMs -= this.tickMs;
    }
    if (!panelOpen) this.handleUse();

    // Rendering interpolates between the last two ticks for smooth motion.
    const alpha = this.accumulatorMs / this.tickMs;
    for (let i = 0; i < this.sim.units.length; i++) {
      const u = this.sim.units[i];
      const p = this.prevPos[i];
      const view = this.unitViews[i];
      if (!u || !p || !view) continue;
      view.apply(Phaser.Math.Linear(p.x, u.x, alpha), Phaser.Math.Linear(p.y, u.y, alpha), u);
    }
    if (this.debugOn) this.drawDebug();
  }

  /** Current simulation state, for overlays and the HUD. */
  get state(): SimState {
    return this.sim;
  }

  get gameMap(): GameMap {
    return this.map;
  }

  get simMode(): SimMode {
    return this.mode;
  }

  /** What the E key would do right now, or null. */
  get prompt(): string | null {
    return this.usePrompt;
  }

  get isPanelOpen(): boolean {
    return this.settingsPanel?.isOpen ?? false;
  }

  /** F3: walking graph, bot paths and vision circles over the floor. */
  setDebugVisible(visible: boolean): void {
    this.debugOn = visible;
    this.navView.setVisible(visible);
    this.debugGraphics.setVisible(visible);
    if (!visible) this.debugGraphics.clear();
  }

  private handleUse(): void {
    const player = playerOf(this.sim);
    const near = this.nearestUsableObject(player.x, player.y);
    this.usePrompt = near ? (near.type === 'computer' ? 'E: use the settings computer' : near.type === 'start' ? 'E: start the game' : `E: use ${near.type}`) : null;
    const pressed = Phaser.Input.Keyboard.JustDown(this.keys.E) || Phaser.Input.Keyboard.JustDown(this.keys.SPACE);
    if (!pressed || !near) return;
    if (near.type === 'computer') this.openSettings();
    else if (near.type === 'start') this.startMatch();
  }

  private nearestUsableObject(x: number, y: number): MapObject | null {
    const ts = this.map.tileSize;
    let best: MapObject | null = null;
    let bestDist = Infinity;
    for (const obj of this.map.objects) {
      const cx = (obj.pos[0] + obj.size[0] / 2) * ts;
      const cy = (obj.pos[1] + obj.size[1] / 2) * ts;
      // Distance from the player to the object's box edge.
      const dx = Math.max(Math.abs(x - cx) - (obj.size[0] * ts) / 2, 0);
      const dy = Math.max(Math.abs(y - cy) - (obj.size[1] * ts) / 2, 0);
      const d = Math.hypot(dx, dy);
      if (d <= USE_RANGE_TILES * ts && d < bestDist) {
        best = obj;
        bestDist = d;
      }
    }
    return best;
  }

  private openSettings(): void {
    if (!this.settingsPanel) return;
    const keyboard = this.input.keyboard;
    if (keyboard) keyboard.enabled = false;
    this.settingsPanel.open(this.settings, this.seedText, (result) => {
      if (keyboard) {
        keyboard.enabled = true;
        keyboard.resetKeys();
      }
      saveStoredSettings(result);
      const p = playerOf(this.sim);
      // Rebuild the lobby so the player count, name and colour take effect right away.
      this.scene.restart({
        ...this.data_,
        settings: result.settings,
        seedText: result.seedText,
        seed: result.seedText ? seedFromText(result.seedText) : this.seed,
        keepPlayerAt: { x: p.x, y: p.y },
      } satisfies PlaySceneData);
    });
  }

  private startMatch(): void {
    this.scene.restart({
      ...this.data_,
      mode: 'game',
      settings: this.settings,
      seedText: this.seedText,
      seed: this.seed,
      keepPlayerAt: undefined,
    } satisfies PlaySceneData);
  }

  private drawDebug(): void {
    const g = this.debugGraphics;
    const ts = this.map.tileSize;
    g.clear();
    g.lineStyle(2, DEBUG_PATH_COLOUR, 0.9);
    for (const bot of this.sim.bots) {
      const unit = this.sim.units[bot.unitId];
      if (!unit || bot.pathIndex >= bot.path.length) continue;
      g.beginPath();
      g.moveTo(unit.x, unit.y);
      for (let i = bot.pathIndex; i < bot.path.length; i++) {
        const wp = bot.path[i];
        if (wp) g.lineTo(wp[0] * ts + ts / 2, wp[1] * ts + ts / 2);
      }
      g.strokePath();
      const last = bot.path[bot.path.length - 1];
      if (last) g.fillStyle(DEBUG_PATH_COLOUR, 0.9).fillCircle(last[0] * ts + ts / 2, last[1] * ts + ts / 2, 5);
    }
    if (this.mode === 'game') {
      g.lineStyle(1, DEBUG_VISION_COLOUR, 0.7);
      for (const u of this.sim.units) g.strokeCircle(u.x, u.y, visionRadiusPx(u.role, this.settings, gameConfig));
    }
  }

  private readInput(): PlayerInput {
    const k = this.keys;
    let dx = 0;
    let dy = 0;
    if (k.A.isDown || k.LEFT.isDown) dx -= 1;
    if (k.D.isDown || k.RIGHT.isDown) dx += 1;
    if (k.W.isDown || k.UP.isDown) dy -= 1;
    if (k.S.isDown || k.DOWN.isDown) dy += 1;
    if (dx === 0 && dy === 0) return NO_INPUT;
    return { dx, dy };
  }
}

/** ?seed=123 in the address bar fixes the seed, handy for replaying a game. */
function seedFromUrl(): number | null {
  const value = new URLSearchParams(window.location.search).get('seed');
  return value ? seedFromText(value) : null;
}
