// The main scene: runs the fixed-tick simulation, draws the map and every unit, follows the player.

import Phaser from 'phaser';
import gameConfig from '../../config/game.json';
import type { GameMap } from '../sim/map';
import { randomSeed, seedFromText } from '../sim/rng';
import { defaultSettings, clampSettings, type GameSettings } from '../sim/settings';
import { COLORS, createGame, stepSim, NO_INPUT, type PlayerInput, type SimState } from '../sim/sim';
import type { SpritesManifest } from './assets';
import { MapView } from './MapView';
import { NavGraphView } from './NavGraphView';
import { UnitView } from './UnitView';
import { HudScene } from '../ui/HudScene';

export interface PlaySceneData {
  map: GameMap;
  sprites: SpritesManifest;
  settings?: GameSettings;
  seed?: number;
}

/** Keys Phaser must capture so the browser does not act on them (Tab moves focus, F3 opens search). */
const CAPTURED_KEYS = ['TAB', 'F3', 'SPACE', 'UP', 'DOWN', 'LEFT', 'RIGHT'];

const DEBUG_PATH_COLOUR = 0xffc857;

export class PlayScene extends Phaser.Scene {
  static readonly KEY = 'Play';

  private map!: GameMap;
  private settings!: GameSettings;
  private seed = 0;
  private sim!: SimState;
  /** Positions at the previous tick, per unit id, for smooth drawing between ticks. */
  private prevPos: { x: number; y: number }[] = [];
  private accumulatorMs = 0;
  private readonly tickMs = 1000 / gameConfig.tickRate;

  private mapView!: MapView;
  private navView!: NavGraphView;
  private unitViews: UnitView[] = [];
  private debugGraphics!: Phaser.GameObjects.Graphics;
  private debugOn = false;
  private keys!: Record<'W' | 'A' | 'S' | 'D' | 'UP' | 'DOWN' | 'LEFT' | 'RIGHT', Phaser.Input.Keyboard.Key>;

  constructor() {
    super(PlayScene.KEY);
  }

  init(data: PlaySceneData): void {
    this.map = data.map;
    this.settings = clampSettings(data.settings ?? defaultSettings(), { playerCap: this.map.playerCap, impostorMax: this.map.impostors.max });
    this.seed = data.seed ?? seedFromUrl() ?? randomSeed();
  }

  create(): void {
    this.mapView = new MapView(this, this.map);
    this.sim = createGame(this.map, this.settings, this.seed, gameConfig);
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
    this.keys = keyboard.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT') as PlayScene['keys'];

    const playerView = this.unitViews[0] as UnitView;
    const cam = this.cameras.main;
    cam.setBounds(0, 0, this.mapView.widthPx, this.mapView.heightPx);
    cam.setRoundPixels(true);
    cam.centerOn(playerView.container.x, playerView.container.y);
    cam.startFollow(playerView.container, true, gameConfig.camera.followLerp, gameConfig.camera.followLerp);

    this.navView = new NavGraphView(this, this.map);
    this.debugGraphics = this.add.graphics().setDepth(6).setVisible(false);
    this.scene.launch(HudScene.KEY);
  }

  override update(_time: number, deltaMs: number): void {
    // Fixed tick: the simulation always advances in equal steps no matter the frame rate.
    // If the tab was hidden and a huge delta arrives, cap it so we do not spiral trying to catch up.
    this.accumulatorMs += Math.min(deltaMs, this.tickMs * 5);
    const input = this.readInput();
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
    // Rendering interpolates between the last two ticks for smooth motion.
    const alpha = this.accumulatorMs / this.tickMs;
    for (let i = 0; i < this.sim.units.length; i++) {
      const u = this.sim.units[i];
      const p = this.prevPos[i];
      const view = this.unitViews[i];
      if (!u || !p || !view) continue;
      view.apply(Phaser.Math.Linear(p.x, u.x, alpha), Phaser.Math.Linear(p.y, u.y, alpha), u);
    }
    if (this.debugOn) this.drawDebugPaths();
  }

  /** Current simulation state, for overlays and the HUD. */
  get state(): SimState {
    return this.sim;
  }

  get gameMap(): GameMap {
    return this.map;
  }

  /** F3: walking graph and bot paths over the floor. */
  setDebugVisible(visible: boolean): void {
    this.debugOn = visible;
    this.navView.setVisible(visible);
    this.debugGraphics.setVisible(visible);
    if (!visible) this.debugGraphics.clear();
  }

  private drawDebugPaths(): void {
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
