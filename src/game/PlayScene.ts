// The main scene: runs the fixed-tick simulation, draws the map and the player, follows with the camera.

import Phaser from 'phaser';
import gameConfig from '../../config/game.json';
import type { GameMap } from '../sim/map';
import { createSim, stepSim, NO_INPUT, type PlayerInput, type SimState } from '../sim/sim';
import type { SpritesManifest } from './assets';
import { MapView } from './MapView';
import { UnitView } from './UnitView';

export interface PlaySceneData {
  map: GameMap;
  sprites: SpritesManifest;
}

const PLAYER_COLOUR = 0x2fd3e6; // Cyan, the default player colour (SPEC 12)

/** Keys Phaser must capture so the browser does not act on them (Tab moves focus, F3 opens search). */
const CAPTURED_KEYS = ['TAB', 'F3', 'SPACE', 'UP', 'DOWN', 'LEFT', 'RIGHT'];

export class PlayScene extends Phaser.Scene {
  static readonly KEY = 'Play';

  private map!: GameMap;
  private sim!: SimState;
  private prevSim!: SimState;
  private accumulatorMs = 0;
  private readonly tickMs = 1000 / gameConfig.tickRate;

  private mapView!: MapView;
  private player!: UnitView;
  private keys!: Record<'W' | 'A' | 'S' | 'D' | 'UP' | 'DOWN' | 'LEFT' | 'RIGHT', Phaser.Input.Keyboard.Key>;

  constructor() {
    super(PlayScene.KEY);
  }

  init(data: PlaySceneData): void {
    this.map = data.map;
  }

  create(): void {
    this.mapView = new MapView(this, this.map);
    this.sim = createSim(this.map);
    this.prevSim = this.sim;
    this.player = new UnitView(this, PLAYER_COLOUR);

    const keyboard = this.input.keyboard;
    if (!keyboard) throw new Error('Keyboard input is not available.');
    keyboard.addCapture(CAPTURED_KEYS);
    this.keys = keyboard.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT') as PlayScene['keys'];

    const cam = this.cameras.main;
    cam.setBounds(0, 0, this.mapView.widthPx, this.mapView.heightPx);
    cam.setRoundPixels(true);
    cam.centerOn(this.sim.player.x, this.sim.player.y);
    cam.startFollow(this.player.container, true, gameConfig.camera.followLerp, gameConfig.camera.followLerp);

    this.player.apply(this.sim.player.x, this.sim.player.y, this.sim.player);
  }

  override update(_time: number, deltaMs: number): void {
    // Fixed tick: the simulation always advances in equal steps no matter the frame rate.
    // If the tab was hidden and a huge delta arrives, cap it so we do not spiral trying to catch up.
    this.accumulatorMs += Math.min(deltaMs, this.tickMs * 5);
    const input = this.readInput();
    while (this.accumulatorMs >= this.tickMs) {
      this.prevSim = this.sim;
      this.sim = stepSim(this.sim, input, this.map, gameConfig);
      this.accumulatorMs -= this.tickMs;
    }
    // Rendering interpolates between the last two ticks for smooth motion.
    const alpha = this.accumulatorMs / this.tickMs;
    const x = Phaser.Math.Linear(this.prevSim.player.x, this.sim.player.x, alpha);
    const y = Phaser.Math.Linear(this.prevSim.player.y, this.sim.player.y, alpha);
    this.player.apply(x, y, this.sim.player);
  }

  /** Current simulation state, for overlays and the HUD. */
  get state(): SimState {
    return this.sim;
  }

  get gameMap(): GameMap {
    return this.map;
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
