// The main scene. Runs the fixed-tick simulation, draws the map and every unit, follows the player.
// The same scene serves the lobby (mode 'lobby': settings computer and start pad) and a match
// (mode 'game'); starting a match restarts the scene with the match map.

import Phaser from 'phaser';
import gameConfig from '../../config/game.json';
import { bodiesInReach, findKillTarget, nearButton, reachableStage } from '../sim/actions';
import type { GameMap, MapObject } from '../sim/map';
import { randomSeed, seedFromText } from '../sim/rng';
import { defaultSettings, clampSettings, type GameSettings } from '../sim/settings';
import { COLORS, createGame, player as playerOf, stepSim, NO_INPUT, type PlayerInput, type SimMode, type SimState } from '../sim/sim';
import { TASK_LABELS } from '../sim/tasks';
import { cameraZoom, visionRadiusPx } from '../sim/vision';
import type { SpritesManifest } from './assets';
import { MapView } from './MapView';
import { NavGraphView } from './NavGraphView';
import { UnitView } from './UnitView';
import { VisionView } from './VisionView';
import { HudScene } from '../ui/HudScene';
import { MeetingPanel } from '../ui/MeetingPanel';
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
const CAPTURED_KEYS = ['TAB', 'F3', 'SPACE', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'ENTER'];

const DEBUG_PATH_COLOUR = 0xffc857;
const DEBUG_VISION_COLOUR = 0x59d98c;
const PROGRESS_COLOUR = 0x3ccf6a;
/** How close (in tiles) the player must be to use an object. */
const USE_RANGE_TILES = 1.6;

type KeyName = 'W' | 'A' | 'S' | 'D' | 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'E' | 'SPACE' | 'Q' | 'R' | 'ENTER';

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
  private bodyViews = new Map<number, UnitView>();
  private progressRing!: Phaser.GameObjects.Graphics;
  private debugGraphics!: Phaser.GameObjects.Graphics;
  private debugOn = false;
  private settingsPanel: SettingsPanel | null = null;
  private meetingPanel: MeetingPanel | null = null;
  /** What the keys would do right now, for the HUD. */
  private prompts_: string[] = [];
  /** Input read once per frame; "just pressed" keys can only be read once. */
  private frameInput: PlayerInput = NO_INPUT;
  private keys!: Record<KeyName, Phaser.Input.Keyboard.Key>;

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
    this.prompts_ = [];
    this.bodyViews = new Map();
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
      const view = new UnitView(this, this.colourOf(u.colorId), u.name);
      view.apply(u.x, u.y, u);
      return view;
    });

    const keyboard = this.input.keyboard;
    if (!keyboard) throw new Error('Keyboard input is not available.');
    keyboard.addCapture(CAPTURED_KEYS);
    this.keys = keyboard.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,E,SPACE,Q,R,ENTER') as PlayScene['keys'];

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
    this.progressRing = this.add.graphics().setDepth(11);
    this.debugGraphics = this.add.graphics().setDepth(6).setVisible(false);
    // Darkness is only for the lights sabotage (Phase 4); with the lights on the whole screen is visible.
    this.visionView = new VisionView(this, this.map);
    this.visionView.setVisible(false);

    if (this.mode === 'lobby') {
      const matchMap = this.data_.maps[this.data_.matchMapId] ?? this.map;
      this.settingsPanel = new SettingsPanel({ playerCap: matchMap.playerCap, impostorMax: matchMap.impostors.max });
    } else {
      this.meetingPanel = new MeetingPanel(gameConfig.tickRate);
    }
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.settingsPanel?.destroy();
      this.settingsPanel = null;
      this.meetingPanel?.destroy();
      this.meetingPanel = null;
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
    let input = panelOpen ? NO_INPUT : this.readInput();
    if (this.meetingPanel?.isOpen) {
      // During a meeting the panel owns the keyboard; only its votes and chat lines reach the simulation.
      const actions = this.meetingPanel.takeActions();
      input = { dx: 0, dy: 0, voteFor: actions.voteFor, chatText: actions.chatText };
      if (this.frameInput.continueKey) this.meetingPanel.focusChat();
    }
    this.frameInput = input;
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
      this.reactToEvents();
      // A key press counts once per frame, even when several ticks run in one frame.
      input = { dx: input.dx, dy: input.dy, useHeld: input.useHeld };
      this.syncMeetingPanel();
      this.accumulatorMs -= this.tickMs;
    }
    if (!panelOpen) this.handleUse();
    this.syncMeetingPanel();
    this.computePrompts();

    // Rendering interpolates between the last two ticks for smooth motion.
    const alpha = this.accumulatorMs / this.tickMs;
    const player = playerOf(this.sim);
    for (let i = 0; i < this.sim.units.length; i++) {
      const u = this.sim.units[i];
      const p = this.prevPos[i];
      const view = this.unitViews[i];
      if (!u || !p || !view) continue;
      view.apply(Phaser.Math.Linear(p.x, u.x, alpha), Phaser.Math.Linear(p.y, u.y, alpha), u);
      view.setGhost(!u.alive);
      // Ghosts are only visible to the dead (and in F3).
      view.setVisible(u.alive || !player.alive || this.debugOn);
    }
    this.syncBodies();
    this.drawProgressRing(player);
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

  get gameSettings(): GameSettings {
    return this.settings;
  }

  /** What the keys would do right now. */
  get prompts(): readonly string[] {
    return this.prompts_;
  }

  get isPanelOpen(): boolean {
    return this.settingsPanel?.isOpen ?? false;
  }

  get isMeetingOpen(): boolean {
    return this.meetingPanel?.isOpen ?? false;
  }

  /** F3: walking graph, bot paths and sight circles over the floor. */
  setDebugVisible(visible: boolean): void {
    this.debugOn = visible;
    this.navView.setVisible(visible);
    this.debugGraphics.setVisible(visible);
    if (!visible) this.debugGraphics.clear();
  }

  /** Returns to the lobby (used by the HUD; a proper end screen arrives in step 5). */
  backToLobby(): void {
    this.scene.restart({ ...this.data_, mode: 'lobby', settings: this.settings, seedText: this.seedText, seed: undefined, keepPlayerAt: undefined } satisfies PlaySceneData);
  }

  /** Opens the meeting screen when a meeting starts, refreshes it, and closes it when play resumes. */
  private syncMeetingPanel(): void {
    const panel = this.meetingPanel;
    if (!panel) return;
    const keyboard = this.input.keyboard;
    if (this.sim.phase === 'meeting') {
      if (!panel.isOpen) {
        panel.open(this.sim);
        if (keyboard) {
          keyboard.enabled = false;
          keyboard.resetKeys();
        }
      }
      panel.update(this.sim);
    } else if (panel.isOpen) {
      panel.close();
      if (keyboard) {
        keyboard.enabled = true;
        keyboard.resetKeys();
      }
    }
  }

  private colourOf(colorId: string): number {
    const hex = COLORS.find((c) => c.id === colorId)?.tint ?? '#ffffff';
    return Phaser.Display.Color.HexStringToColor(hex).color;
  }

  private reactToEvents(): void {
    const player = playerOf(this.sim);
    for (const ev of this.sim.events) {
      if (ev.kind === 'kill') {
        if (ev.victimId === player.id) this.cameras.main.flash(500, 180, 20, 20);
        else if (ev.killerId === player.id) this.cameras.main.shake(150, 0.004);
      } else if (ev.kind === 'meetingStart') {
        this.cameras.main.flash(300, 255, 255, 255);
      }
    }
  }

  /** Keeps one body view per body in the simulation. */
  private syncBodies(): void {
    const present = new Set<number>();
    for (const body of this.sim.bodies) {
      present.add(body.unitId);
      let view = this.bodyViews.get(body.unitId);
      if (!view) {
        const unit = this.sim.units[body.unitId];
        view = new UnitView(this, this.colourOf(unit?.colorId ?? 'white'), '');
        this.bodyViews.set(body.unitId, view);
      }
      view.showAsBody(body.x, body.y);
    }
    for (const [id, view] of this.bodyViews) {
      if (!present.has(id)) {
        view.destroy();
        this.bodyViews.delete(id);
      }
    }
  }

  private drawProgressRing(player: { x: number; y: number }): void {
    const g = this.progressRing;
    g.clear();
    const t = this.sim.playerTask;
    if (!t) return;
    const view = this.unitViews[0];
    const x = view ? view.container.x : player.x;
    const y = view ? view.container.y : player.y;
    const fraction = t.ticks / t.needed;
    g.lineStyle(4, 0x0b0d12, 0.8).strokeCircle(x, y, 26);
    g.lineStyle(4, PROGRESS_COLOUR, 1);
    g.beginPath();
    g.arc(x, y, 26, -Math.PI / 2, -Math.PI / 2 + fraction * Math.PI * 2, false);
    g.strokePath();
  }

  private computePrompts(): void {
    const prompts: string[] = [];
    const player = playerOf(this.sim);
    if (this.mode === 'lobby') {
      const near = this.nearestUsableObject(player.x, player.y);
      if (near) prompts.push(near.type === 'computer' ? 'E: use the settings computer' : near.type === 'start' ? 'E: start the game' : `E: use ${near.type}`);
    } else if (this.sim.phase === 'play' && !this.isMeetingOpen) {
      if (player.alive) {
        if (player.role === 'impostor') {
          const target = findKillTarget(this.sim, player, gameConfig);
          if (target && player.killCooldownTicks <= 0) prompts.push(`Q: kill ${target.name}`);
        }
        if (bodiesInReach(this.sim, player, gameConfig).length > 0) prompts.push('R: report body');
        if (nearButton(player, this.map, gameConfig)) {
          prompts.push(player.meetingsLeft > 0 ? `E: call emergency meeting (${player.meetingsLeft} left)` : 'Emergency button: no meetings left');
        }
      }
      const stage = reachableStage(player, this.map, gameConfig);
      if (stage) prompts.push(`E (hold): ${TASK_LABELS[stage.task.type] ?? stage.task.type}`);
    }
    this.prompts_ = prompts;
  }

  private handleUse(): void {
    if (this.mode !== 'lobby') return;
    const player = playerOf(this.sim);
    const near = this.nearestUsableObject(player.x, player.y);
    if (!this.frameInput.usePressed || !near) return;
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
      g.lineStyle(1, DEBUG_VISION_COLOUR, 0.5);
      for (const u of this.sim.units) if (u.alive) g.strokeCircle(u.x, u.y, visionRadiusPx(u.role, this.settings, gameConfig));
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
    const useHeld = k.E.isDown || k.SPACE.isDown;
    const usePressed = Phaser.Input.Keyboard.JustDown(k.E) || Phaser.Input.Keyboard.JustDown(k.SPACE);
    const killPressed = Phaser.Input.Keyboard.JustDown(k.Q);
    const reportPressed = Phaser.Input.Keyboard.JustDown(k.R);
    const continueKey = Phaser.Input.Keyboard.JustDown(k.ENTER);
    // Holding a task key means standing still: you cannot walk and work at once.
    if (useHeld && this.mode === 'game' && reachableStage(playerOf(this.sim), this.map, gameConfig)) {
      dx = 0;
      dy = 0;
    }
    return { dx, dy, useHeld, usePressed, killPressed, reportPressed, continueKey };
  }
}

/** ?seed=123 in the address bar fixes the seed, handy for replaying a game. */
function seedFromUrl(): number | null {
  const value = new URLSearchParams(window.location.search).get('seed');
  return value ? seedFromText(value) : null;
}
