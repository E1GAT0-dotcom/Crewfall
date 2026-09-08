// The fixed-tick simulation. Pure TypeScript, no Phaser.
//
// Phase 1 scope: one player unit walking around the map. Later phases add bots, tasks,
// kills, meetings and win conditions here. Everything is deterministic: the same map, config
// and sequence of inputs always produce the same states.

import type { GameMap } from './map';
import { moveWithCollision, normalizeDirection, type Vec2 } from './movement';

export interface SimConfig {
  readonly tickRate: number;
  readonly tileSize: number;
  readonly player: {
    readonly speedTilesPerSec: number;
    readonly colliderRadiusPx: number;
  };
}

/** What the player is pressing this tick: each axis is -1, 0 or 1. */
export interface PlayerInput {
  readonly dx: number;
  readonly dy: number;
}

export const NO_INPUT: PlayerInput = { dx: 0, dy: 0 };

export interface UnitState {
  /** Centre of the unit in world pixels. */
  readonly x: number;
  readonly y: number;
  /** 1 = facing right, -1 = facing left. Kept while standing still. */
  readonly facing: 1 | -1;
  readonly moving: boolean;
}

export interface SimState {
  readonly tick: number;
  readonly player: UnitState;
}

/** Puts the player on the first spawn tile, centred. */
export function createSim(map: GameMap, spawnIndex = 0): SimState {
  const spawn = map.spawns[spawnIndex] ?? map.spawns[0];
  if (!spawn) throw new Error(`Map "${map.name}" has no spawn tiles.`);
  const half = map.tileSize / 2;
  return {
    tick: 0,
    player: { x: spawn[0] * map.tileSize + half, y: spawn[1] * map.tileSize + half, facing: 1, moving: false },
  };
}

/** Advances the world by exactly one tick. */
export function stepSim(state: SimState, input: PlayerInput, map: GameMap, config: SimConfig): SimState {
  const dir = normalizeDirection(clamp1(input.dx), clamp1(input.dy));
  const speedPxPerTick = (config.player.speedTilesPerSec * config.tileSize) / config.tickRate;
  const from: Vec2 = { x: state.player.x, y: state.player.y };
  const to = moveWithCollision(map, from, dir.x * speedPxPerTick, dir.y * speedPxPerTick, config.player.colliderRadiusPx);
  const moving = to.x !== from.x || to.y !== from.y;
  const facing: 1 | -1 = dir.x > 0 ? 1 : dir.x < 0 ? -1 : state.player.facing;
  return {
    tick: state.tick + 1,
    player: { x: to.x, y: to.y, facing, moving },
  };
}

/** Which room or corridor the player is standing in, or null if somehow off the floor. */
export function playerRegionName(state: SimState, map: GameMap): string | null {
  const tx = Math.floor(state.player.x / map.tileSize);
  const ty = Math.floor(state.player.y / map.tileSize);
  return map.regionAt(tx, ty)?.name ?? null;
}

function clamp1(v: number): number {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}
