// The fixed-tick simulation. Pure TypeScript, no Phaser.
//
// Holds every unit (the player and the bots), their roles and task lists, bodies, the current
// phase (play or meeting), and advances the world one tick at a time. Deterministic: the same map,
// settings, seed and sequence of player inputs always produce the same states. Bot decisions live
// in src/bots and are called from here; the rules for kills, reports, meetings and tasks live in
// src/sim/actions.ts.

import namesJson from '../../config/names.json';
import colorsJson from '../../config/colors.json';
import { createBotState, stepBot, type BotState } from '../bots/brain';
import type { Claim } from '../bots/claims';
import { perceive } from '../bots/memory';
import { tickSocial } from '../bots/suspicion';
import { assignPersonalities } from '../bots/personality';
import { findKillTarget, tryCallMeeting, tryKill, tryReport, updatePlayerTask, type Body, type SimEvent } from './actions';
import { stepMeeting, type MeetingState, type Vote } from './meeting';
import { checkWin, type Outcome } from './win';
import type { GameMap } from './map';
import { moveWithCollision, normalizeDirection, type Vec2 } from './movement';
import { Rng } from './rng';
import type { GameSettings } from './settings';
import { buildTaskList, chooseCommonTypes, countStages, type Task, type TaskStage } from './tasks';
import { tryEnterVent, tryExitVent, tryVentHop } from './vents';

export type Role = 'crew' | 'impostor';

/** 'lobby': everyone is crew with no tasks, bots just mill about. 'game': a real match. */
export type SimMode = 'lobby' | 'game';

export type Phase = 'play' | 'meeting' | 'ended';

export interface SimConfig {
  readonly tickRate: number;
  readonly tileSize: number;
  readonly canvas: { readonly width: number; readonly height: number };
  readonly vision: { readonly zoomAtOneX: number; readonly lobbyZoom: number };
  readonly player: {
    readonly speedTilesPerSec: number;
    readonly colliderRadiusPx: number;
  };
  readonly tasks: {
    readonly durationSec: Readonly<Record<string, number>>;
    readonly botJitter: number;
  };
  readonly rules: {
    readonly initialKillCooldownSec: number;
    readonly reportRangeTiles: number;
    readonly useRangeTiles: number;
    readonly taskRangeTiles: number;
    readonly playerTaskSpeed: number;
    readonly ventRangeTiles: number;
  };
  readonly bots: {
    readonly waypointTolerancePx: number;
    /** [min, max] seconds. */
    readonly wanderIdleSec: readonly number[];
    readonly stuckTicks: number;
    readonly feel: {
      readonly speedRange: readonly number[];
      readonly speedWobble: number;
      readonly pauseEverySec: readonly number[];
      readonly pauseSec: readonly number[];
      readonly lookAroundChance: number;
      readonly afterTaskPauseSec: readonly number[];
      readonly startDelaySec: readonly number[];
      readonly detourChance: number;
      readonly driftPx: number;
      readonly turnSmoothing: number;
      readonly taskDistanceScaleTiles: number;
    };
    readonly report: { readonly delaySec: readonly number[] };
    readonly kill: { readonly hesitateSec: readonly number[]; readonly repathSec: number };
  };
  readonly meeting: {
    readonly resultSec: number;
    readonly botChat: {
      readonly gapSec: readonly number[];
      readonly replyDelaySec: readonly number[];
      readonly maxMessagesPerBot: number;
      readonly firstMessageDelaySec: readonly number[];
    };
    readonly botVote: { readonly skipChance: number; readonly voteWindow: readonly number[] };
  };
}

/** What the player is doing this tick. Axes are -1, 0 or 1; the rest are key states. */
export interface PlayerInput {
  readonly dx: number;
  readonly dy: number;
  /** Use key held down (doing a task). */
  readonly useHeld?: boolean;
  /** Use key just pressed (button, objects). */
  readonly usePressed?: boolean;
  readonly killPressed?: boolean;
  readonly reportPressed?: boolean;
  /** Vent key just pressed: climb into a vent in reach, or out of the one you are in. */
  readonly ventPressed?: boolean;
  /** Inside a vent: a direction just pressed, to hop to the next vent that way (-1, 0 or 1 each). */
  readonly ventDx?: number;
  readonly ventDy?: number;
  /** Meeting: a vote to cast this tick (a unit id or 'skip'). */
  readonly voteFor?: Vote;
  /** Meeting: a chat line to send this tick. */
  readonly chatText?: string;
  /** Enter was pressed this frame (the scene uses it to focus the chat box). Ignored by the simulation. */
  readonly continueKey?: boolean;
}

export const NO_INPUT: PlayerInput = { dx: 0, dy: 0 };

export interface Unit {
  readonly id: number;
  readonly name: string;
  readonly colorId: string;
  readonly role: Role;
  readonly isPlayer: boolean;
  alive: boolean;
  /** True if voted out at a meeting (no body is left). */
  ejected: boolean;
  /** Tick of death, or null while alive. */
  deathTick: number | null;
  /** Centre of the unit in world pixels. */
  x: number;
  y: number;
  /** 1 = facing right, -1 = facing left. Kept while standing still. */
  facing: 1 | -1;
  moving: boolean;
  /** Real tasks for crew; a fake list for impostors (never counted). */
  tasks: Task[];
  /** Ticks until this impostor may kill again. Always 0 for crew. */
  killCooldownTicks: number;
  /** Emergency meetings this unit may still call. */
  meetingsLeft: number;
  /** Id of the vent this unit is hiding in, or null. Only impostors ever vent. */
  inVent: string | null;
}

export interface PlayerTaskProgress {
  readonly taskId: string;
  readonly spotId: string;
  readonly ticks: number;
  readonly needed: number;
}

export interface SimState {
  readonly mode: SimMode;
  readonly seed: number;
  readonly settings: GameSettings;
  readonly rng: Rng;
  /** The numbers the game runs on, kept so headless tools can add bots later. */
  readonly config: SimConfig;
  tick: number;
  phase: Phase;
  units: Unit[];
  bots: BotState[];
  bodies: Body[];
  meeting: MeetingState | null;
  meetingsHeld: number;
  /** Set once the game is over. */
  outcome: Outcome | null;
  /** Everything asserted in meetings, public to all bots (SPEC 9.4). */
  claims: Claim[];
  /** The player's hold-to-do task progress, if any. */
  playerTask: PlayerTaskProgress | null;
  /** Crew task progress for the task bar. */
  crewTasks: { done: number; total: number };
  /** What happened this tick, for sound and effects. Cleared at the start of every tick. */
  events: SimEvent[];
}

const PLAYER_ID = 0;

interface ColorEntry {
  id: string;
  name: string;
  tint: string;
  text: string;
}

export const COLORS: readonly ColorEntry[] = colorsJson.colors;

/** Sets up a new game: names, colours, roles, spawn positions and task lists. */
export function createGame(map: GameMap, settings: GameSettings, seed: number, config: SimConfig, mode: SimMode = 'game'): SimState {
  const rng = new Rng(seed);
  const count = Math.max(4, Math.min(settings.players, map.playerCap, map.spawns.length));
  const impostorCount = mode === 'lobby' ? 0 : Math.max(1, Math.min(settings.impostors, map.impostors.max, Math.floor((count - 1) / 2)));

  // Roles: shuffle all ids and take the first few as impostors. The player's odds are impostors/players.
  const impostorIds = new Set(rng.shuffle(range(count)).slice(0, impostorCount));

  const names = pickBotNames(rng, count - 1, settings.playerName);
  const colorIds = pickColors(rng, count - 1, settings.playerColor);
  const commonTypes = chooseCommonTypes(rng, settings.commonTasks);
  const counts = { common: settings.commonTasks, long: settings.longTasks, short: settings.shortTasks };
  const half = map.tileSize / 2;
  const spawnOrder = rng.shuffle(range(map.spawns.length));
  const initialCooldown = Math.round(config.rules.initialKillCooldownSec * config.tickRate);

  const units: Unit[] = [];
  for (let id = 0; id < count; id++) {
    const spawn = map.spawns[spawnOrder[id % spawnOrder.length] as number] as readonly [number, number];
    const role: Role = impostorIds.has(id) ? 'impostor' : 'crew';
    units.push({
      id,
      name: id === PLAYER_ID ? settings.playerName : (names[id - 1] as string),
      colorId: id === PLAYER_ID ? settings.playerColor : (colorIds[id - 1] as string),
      role,
      isPlayer: id === PLAYER_ID,
      alive: true,
      ejected: false,
      deathTick: null,
      x: spawn[0] * map.tileSize + half,
      y: spawn[1] * map.tileSize + half,
      facing: 1,
      moving: false,
      tasks: mode === 'lobby' ? [] : buildTaskList(map, rng, commonTypes, counts, id),
      killCooldownTicks: role === 'impostor' ? initialCooldown : 0,
      meetingsLeft: mode === 'lobby' ? 0 : settings.emergencyMeetings,
      inVent: null,
    });
  }
  const personalities = assignPersonalities(count - 1, rng);
  const bots = units.filter((u) => !u.isPlayer).map((u, i) => createBotState(u.id, rng, config, personalities[i]));
  const state: SimState = {
    mode,
    seed,
    settings,
    rng,
    config,
    tick: 0,
    phase: 'play',
    units,
    bots,
    bodies: [],
    meeting: null,
    meetingsHeld: 0,
    outcome: null,
    claims: [],
    playerTask: null,
    crewTasks: { done: 0, total: 0 },
    events: [],
  };
  state.crewTasks = crewTaskProgress(state);
  return state;
}

/** Advances the world by exactly one tick. Mutates and returns the same state. */
export function stepSim(state: SimState, input: PlayerInput, map: GameMap, config: SimConfig): SimState {
  state.tick++;
  state.events = [];

  if (state.phase === 'ended') return state;
  if (state.phase === 'meeting') {
    stepMeeting(state, input, map, config);
    // Ejecting the last impostor (or the wrong person) can end the game the moment play would resume.
    if ((state.phase as Phase) === 'play') checkWin(state);
    return state;
  }

  for (const u of state.units) if (u.killCooldownTicks > 0) u.killCooldownTicks--;

  const speed = unitSpeedPxPerTick(state, config);
  const player = state.units[PLAYER_ID] as Unit;
  let climbedOut = false;
  if (player.inVent !== null) {
    // Inside a vent: no walking; the vent key climbs out, a direction press hops along the network.
    player.moving = false;
    if (input.ventPressed) climbedOut = tryExitVent(state, player, map);
    else if (input.ventDx || input.ventDy) tryVentHop(state, player, clamp1(input.ventDx ?? 0), clamp1(input.ventDy ?? 0), map);
  } else {
    moveUnit(player, clamp1(input.dx), clamp1(input.dy), speed, map, config);
  }

  if (state.mode === 'game' && player.inVent === null) {
    if (player.alive) {
      if (input.killPressed && player.role === 'impostor') {
        const target = findKillTarget(state, player, config);
        if (target) tryKill(state, player, target, config);
      }
      if (input.reportPressed) tryReport(state, player, map, config);
      if (input.usePressed && state.phase === 'play') tryCallMeeting(state, player, map, config);
      // The press that climbed out this tick must not climb straight back in.
      if (input.ventPressed && !climbedOut && state.phase === 'play') tryEnterVent(state, player, map, config);
    }
    if (state.phase === 'play') updatePlayerTask(state, player, input.useHeld === true, map, config);
  }

  for (const bot of state.bots) {
    if (state.phase !== 'play') break;
    const unit = state.units[bot.unitId] as Unit;
    stepBot(bot, unit, state, map, config);
  }
  // Perception last: bots record what they can see now that everyone has moved and acted.
  if (state.mode === 'game') {
    for (const bot of state.bots) {
      const unit = state.units[bot.unitId] as Unit;
      if (unit.alive) {
        perceive(bot.memory, unit, state, map, config);
        tickSocial(bot.social, bot.memory, unit, state, map, config);
      }
    }
  }
  if (state.phase === 'play') checkWin(state);
  return state;
}

/** Pixels per tick for any unit at the current speed setting. */
export function unitSpeedPxPerTick(state: SimState, config: SimConfig): number {
  return (config.player.speedTilesPerSec * state.settings.playerSpeed * config.tileSize) / config.tickRate;
}

/** Moves a unit in a direction (each axis -1..1), obeying walls. Updates facing and moving. */
export function moveUnit(unit: Unit, dx: number, dy: number, speedPxPerTick: number, map: GameMap, config: SimConfig): void {
  const dir = normalizeDirection(dx, dy);
  if (dir.x === 0 && dir.y === 0) {
    unit.moving = false;
    return;
  }
  const from: Vec2 = { x: unit.x, y: unit.y };
  const to = moveWithCollision(map, from, dir.x * speedPxPerTick, dir.y * speedPxPerTick, config.player.colliderRadiusPx);
  unit.moving = to.x !== from.x || to.y !== from.y;
  unit.x = to.x;
  unit.y = to.y;
  if (dir.x > 0) unit.facing = 1;
  else if (dir.x < 0) unit.facing = -1;
}

/** Marks a task stage done and updates the task bar if the unit is crew. */
export function completeStage(state: SimState, unit: Unit, stage: TaskStage): void {
  stage.done = true;
  if (unit.role === 'crew') state.crewTasks = crewTaskProgress(state);
}

export function crewTaskProgress(state: SimState): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const u of state.units) {
    if (u.role !== 'crew') continue;
    const c = countStages(u.tasks);
    done += c.done;
    total += c.total;
  }
  return { done, total };
}

export function player(state: SimState): Unit {
  return state.units[PLAYER_ID] as Unit;
}

export function unitTile(unit: Unit, map: GameMap): [number, number] {
  return [Math.floor(unit.x / map.tileSize), Math.floor(unit.y / map.tileSize)];
}

/** Which room or corridor the player is standing in, or null if somehow off the floor. */
export function playerRegionName(state: SimState, map: GameMap): string | null {
  const [tx, ty] = unitTile(player(state), map);
  return map.regionAt(tx, ty)?.name ?? null;
}

export function unitRegionName(unit: Unit, map: GameMap): string {
  const [tx, ty] = unitTile(unit, map);
  return map.regionAt(tx, ty)?.name ?? '?';
}

export function livingUnits(state: SimState): Unit[] {
  return state.units.filter((u) => u.alive);
}

/** Bot names with distinct first letters, none equal to the player's name. */
function pickBotNames(rng: Rng, count: number, playerName: string): string[] {
  const out: string[] = [];
  const usedInitials = new Set<string>();
  const pool = rng.shuffle(namesJson.names.filter((n) => n.toLowerCase() !== playerName.trim().toLowerCase()));
  for (const name of pool) {
    const initial = (name[0] as string).toUpperCase();
    if (usedInitials.has(initial)) continue;
    usedInitials.add(initial);
    out.push(name);
    if (out.length === count) break;
  }
  // If we somehow run out of initials, fill from the pool anyway.
  for (const name of pool) {
    if (out.length === count) break;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

function pickColors(rng: Rng, count: number, playerColor: string): string[] {
  const others = COLORS.map((c) => c.id).filter((id) => id !== playerColor);
  return rng.shuffle(others).slice(0, count);
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

function clamp1(v: number): number {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}
