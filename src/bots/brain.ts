// Bot brain, Phase 2 version. Pure TypeScript, no Phaser.
//
// The full architecture (SPEC 9.2) is Perception -> Memory -> Social model -> Decision -> Voice.
// Phase 2 fills only the Decision layer with the simplest goals: do the next task, otherwise wander.
// Phase 3 adds perception, memory, suspicion, and real voice on top of this same state shape.
//
// Every random choice comes from the game's seeded Rng, so bot behaviour replays exactly.

import type { GameMap, TilePos } from '../sim/map';
import { findPath } from '../sim/pathfinding';
import { completeStage, moveUnit, unitSpeedPxPerTick, unitTile, type SimConfig, type SimState, type Unit } from '../sim/sim';
import { nextStage, TASK_LABELS, type Task } from '../sim/tasks';

export type BotGoal =
  | { kind: 'idle' }
  | { kind: 'task'; taskId: string; spotId: string; label: string }
  | { kind: 'wander'; target: TilePos; label: string };

export interface BotState {
  readonly unitId: number;
  goal: BotGoal;
  /** Remaining waypoints (tile positions) to the goal, walked in order. */
  path: TilePos[];
  pathIndex: number;
  /** Ticks left standing still at the goal (doing a task, or loitering). */
  waitTicks: number;
  /** Ticks in a row with no progress while trying to move; triggers a re-path. */
  stuckTicks: number;
  lastX: number;
  lastY: number;
}

export function createBotState(unitId: number): BotState {
  return { unitId, goal: { kind: 'idle' }, path: [], pathIndex: 0, waitTicks: 0, stuckTicks: 0, lastX: 0, lastY: 0 };
}

/** One tick of thinking and moving for one bot. */
export function stepBot(bot: BotState, unit: Unit, state: SimState, map: GameMap, config: SimConfig): void {
  if (bot.waitTicks > 0) {
    bot.waitTicks--;
    unit.moving = false;
    if (bot.waitTicks === 0) finishWait(bot, unit, state);
    return;
  }
  if (bot.goal.kind === 'idle') {
    chooseGoal(bot, unit, state, map, config);
    if (bot.goal.kind === 'idle') {
      unit.moving = false;
      return;
    }
  }
  followPath(bot, unit, state, map, config);
}

/** Picks the next task (nearest first, with a little randomness) or somewhere to wander. */
function chooseGoal(bot: BotState, unit: Unit, state: SimState, map: GameMap, config: SimConfig): void {
  const candidates: { task: Task; spotId: string; dist: number }[] = [];
  for (const task of unit.tasks) {
    const stage = nextStage(task);
    if (!stage) continue;
    const spot = map.tasks.find((t) => t.id === stage.spotId);
    if (!spot) continue;
    const sx = spot.pos[0] * map.tileSize + map.tileSize / 2;
    const sy = spot.pos[1] * map.tileSize + map.tileSize / 2;
    candidates.push({ task, spotId: spot.id, dist: Math.hypot(sx - unit.x, sy - unit.y) });
  }
  if (candidates.length > 0) {
    candidates.sort((a, b) => a.dist - b.dist);
    // Nearest most of the time, second-nearest sometimes: bots on the same list do not all march in step.
    const pick = candidates.length > 1 && state.rng.chance(0.3) ? (candidates[1] as (typeof candidates)[0]) : (candidates[0] as (typeof candidates)[0]);
    const spot = map.tasks.find((t) => t.id === pick.spotId);
    if (spot && setPath(bot, unit, map, spot.pos)) {
      const label = `${TASK_LABELS[pick.task.type] ?? pick.task.type} in ${spot.room}`;
      bot.goal = { kind: 'task', taskId: pick.task.id, spotId: pick.spotId, label };
      return;
    }
  }
  // Nothing left to do: wander to a random floor tile in a random room.
  for (let attempt = 0; attempt < 5; attempt++) {
    const room = state.rng.pick(map.rooms);
    if (!room.rect) continue;
    const tx = state.rng.int(room.rect.x, room.rect.x + room.rect.w - 1);
    const ty = state.rng.int(room.rect.y, room.rect.y + room.rect.h - 1);
    if (!map.isWalkable(tx, ty)) continue;
    if (setPath(bot, unit, map, [tx, ty])) {
      bot.goal = { kind: 'wander', target: [tx, ty], label: `wander to ${room.name}` };
      return;
    }
  }
  bot.goal = { kind: 'idle' };
  bot.waitTicks = config.tickRate; // try again in a second
}

function setPath(bot: BotState, unit: Unit, map: GameMap, to: TilePos): boolean {
  const path = findPath(map, unitTile(unit, map), to);
  if (!path) return false;
  bot.path = path;
  bot.pathIndex = path.length > 1 ? 1 : 0;
  bot.stuckTicks = 0;
  bot.lastX = unit.x;
  bot.lastY = unit.y;
  return true;
}

function followPath(bot: BotState, unit: Unit, state: SimState, map: GameMap, config: SimConfig): void {
  if (bot.pathIndex >= bot.path.length) {
    arrive(bot, unit, state, map, config);
    return;
  }
  const half = map.tileSize / 2;
  const wp = bot.path[bot.pathIndex] as TilePos;
  const targetX = wp[0] * map.tileSize + half;
  const targetY = wp[1] * map.tileSize + half;
  const dx = targetX - unit.x;
  const dy = targetY - unit.y;
  const dist = Math.hypot(dx, dy);
  const speed = unitSpeedPxPerTick(state, config);
  if (dist <= Math.max(config.bots.waypointTolerancePx, speed)) {
    // Snap onto the waypoint so the walk stays on tile centres, then take the next one.
    unit.x = targetX;
    unit.y = targetY;
    bot.pathIndex++;
    if (bot.pathIndex >= bot.path.length) arrive(bot, unit, state, map, config);
    else unit.moving = true;
    return;
  }
  moveUnit(unit, dx / dist, dy / dist, speed, map, config);

  // Stuck detection: no progress for a while means something is wrong; find a new path.
  if (Math.hypot(unit.x - bot.lastX, unit.y - bot.lastY) < 0.5) {
    bot.stuckTicks++;
    if (bot.stuckTicks >= config.bots.stuckTicks) {
      const goalTile = bot.path[bot.path.length - 1] as TilePos;
      if (!setPath(bot, unit, map, goalTile)) bot.goal = { kind: 'idle' };
    }
  } else {
    bot.stuckTicks = 0;
  }
  bot.lastX = unit.x;
  bot.lastY = unit.y;
}

function arrive(bot: BotState, unit: Unit, state: SimState, _map: GameMap, config: SimConfig): void {
  unit.moving = false;
  if (bot.goal.kind === 'task') {
    const goal = bot.goal;
    const task = unit.tasks.find((t) => t.id === goal.taskId);
    const base = config.tasks.durationSec[task?.type ?? ''] ?? 5;
    const jitter = 1 + state.rng.range(-config.tasks.botJitter, config.tasks.botJitter);
    bot.waitTicks = Math.max(1, Math.round(base * jitter * config.tickRate));
  } else if (bot.goal.kind === 'wander') {
    const lo = config.bots.wanderIdleSec[0] ?? 2;
    const hi = config.bots.wanderIdleSec[1] ?? lo;
    bot.waitTicks = Math.round(state.rng.range(lo, hi) * config.tickRate);
  } else {
    bot.waitTicks = 1;
  }
}

/** Called when the wait at a goal ends: complete the task stage, then think again next tick. */
function finishWait(bot: BotState, unit: Unit, state: SimState): void {
  if (bot.goal.kind === 'task') {
    const goal = bot.goal;
    const task = unit.tasks.find((t) => t.id === goal.taskId);
    const stage = task ? nextStage(task) : null;
    if (task && stage && stage.spotId === goal.spotId) completeStage(state, unit, stage);
  }
  bot.goal = { kind: 'idle' };
  bot.path = [];
  bot.pathIndex = 0;
}

/** Plain-language description for F3. */
export function describeGoal(bot: BotState): string {
  switch (bot.goal.kind) {
    case 'idle':
      return 'thinking';
    case 'task':
      return (bot.waitTicks > 0 ? 'doing ' : 'going to ') + bot.goal.label;
    case 'wander':
      return (bot.waitTicks > 0 ? 'loitering after ' : '') + bot.goal.label;
  }
}
