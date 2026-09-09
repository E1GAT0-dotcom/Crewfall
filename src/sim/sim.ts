// The fixed-tick simulation. Pure TypeScript, no Phaser.
//
// Holds every unit (the player and the bots), their roles and task lists, and advances the world
// one tick at a time. Deterministic: the same map, settings, seed and sequence of player inputs
// always produce the same states. Bot decisions live in src/bots and are called from here.

import namesJson from '../../config/names.json';
import colorsJson from '../../config/colors.json';
import { createBotState, stepBot, type BotState } from '../bots/brain';
import type { GameMap } from './map';
import { moveWithCollision, normalizeDirection, type Vec2 } from './movement';
import { Rng } from './rng';
import type { GameSettings } from './settings';
import { buildTaskList, chooseCommonTypes, countStages, type Task, type TaskStage } from './tasks';

export type Role = 'crew' | 'impostor';

/** 'lobby': everyone is crew with no tasks, bots just mill about. 'game': a real match. */
export type SimMode = 'lobby' | 'game';

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
  };
}

/** What the player is pressing this tick: each axis is -1, 0 or 1. */
export interface PlayerInput {
  readonly dx: number;
  readonly dy: number;
}

export const NO_INPUT: PlayerInput = { dx: 0, dy: 0 };

export interface Unit {
  readonly id: number;
  readonly name: string;
  readonly colorId: string;
  readonly role: Role;
  readonly isPlayer: boolean;
  alive: boolean;
  /** Centre of the unit in world pixels. */
  x: number;
  y: number;
  /** 1 = facing right, -1 = facing left. Kept while standing still. */
  facing: 1 | -1;
  moving: boolean;
  /** Real tasks for crew; a fake list for impostors (never counted). */
  tasks: Task[];
}

export interface SimState {
  readonly mode: SimMode;
  readonly seed: number;
  readonly settings: GameSettings;
  readonly rng: Rng;
  tick: number;
  units: Unit[];
  bots: BotState[];
  /** Crew task progress for the task bar. */
  crewTasks: { done: number; total: number };
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

  const units: Unit[] = [];
  for (let id = 0; id < count; id++) {
    const spawn = map.spawns[spawnOrder[id % spawnOrder.length] as number] as readonly [number, number];
    units.push({
      id,
      name: id === PLAYER_ID ? settings.playerName : (names[id - 1] as string),
      colorId: id === PLAYER_ID ? settings.playerColor : (colorIds[id - 1] as string),
      role: impostorIds.has(id) ? 'impostor' : 'crew',
      isPlayer: id === PLAYER_ID,
      alive: true,
      x: spawn[0] * map.tileSize + half,
      y: spawn[1] * map.tileSize + half,
      facing: 1,
      moving: false,
      tasks: mode === 'lobby' ? [] : buildTaskList(map, rng, commonTypes, counts, id),
    });
  }
  const bots = units.filter((u) => !u.isPlayer).map((u) => createBotState(u.id, rng, config));
  const state: SimState = {
    mode,
    seed,
    settings,
    rng,
    tick: 0,
    units,
    bots,
    crewTasks: { done: 0, total: 0 },
  };
  state.crewTasks = crewTaskProgress(state);
  return state;
}

/** Advances the world by exactly one tick. Mutates and returns the same state. */
export function stepSim(state: SimState, input: PlayerInput, map: GameMap, config: SimConfig): SimState {
  state.tick++;
  const speed = unitSpeedPxPerTick(state, config);
  const player = state.units[PLAYER_ID] as Unit;
  moveUnit(player, clamp1(input.dx), clamp1(input.dy), speed, map, config);
  for (const bot of state.bots) {
    const unit = state.units[bot.unitId] as Unit;
    stepBot(bot, unit, state, map, config);
  }
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
