// Bot brain, Phase 2 version. Pure TypeScript, no Phaser.
//
// The full architecture (SPEC 9.2) is Perception -> Memory -> Social model -> Decision -> Voice.
// Phase 2 fills Perception (what bodies and units are in sight) and a simple Decision layer:
//   crew:     do the next task; report a body you have seen; wander when done.
//   impostor: fake tasks; when the cooldown is ready and someone is alone, hunt and kill them.
// Phase 3 adds memory, suspicion, and real voice on top of this same state shape.
//
// "Feel" rules (Greg, 2026-09-07): bots must not walk like robots. So each bot has its own walking
// speed with a little wobble, rounds corners instead of following tile centres exactly, drifts
// sideways a bit, pauses now and then (sometimes looking around), hesitates after finishing a task,
// leaves spawn at its own time, and occasionally wanders off to look at a room before working.
// Task choice is weighted by distance rather than strictly nearest, so bots do not all pile into
// the same room. Every random choice comes from the game's seeded Rng, so it all replays exactly.

import { bodiesInReach, canKill, distance, tryKill, tryReport, type Body } from '../sim/actions';
import type { GameMap, TilePos } from '../sim/map';
import { findPath } from '../sim/pathfinding';
import type { Rng } from '../sim/rng';
import { completeStage, moveUnit, unitSpeedPxPerTick, unitTile, type SimConfig, type SimState, type Unit } from '../sim/sim';
import { nextStage, TASK_LABELS, type Task } from '../sim/tasks';
import { canSee, visionRadiusPx } from '../sim/vision';

export type BotGoal =
  | { kind: 'idle' }
  | { kind: 'task'; taskId: string; spotId: string; label: string }
  | { kind: 'wander'; target: TilePos; label: string }
  | { kind: 'report'; bodyOf: number; label: string }
  | { kind: 'hunt'; targetId: number; label: string };

/** Per-bot movement character, rolled once per game. */
export interface BotQuirks {
  /** Fraction of full walking speed this bot prefers. */
  readonly speed: number;
}

export interface BotState {
  readonly unitId: number;
  readonly quirks: BotQuirks;
  goal: BotGoal;
  /** Remaining waypoints (tile positions) to the goal, walked in order. */
  path: TilePos[];
  pathIndex: number;
  /** Ticks left standing still at the goal (doing a task, or loitering). */
  waitTicks: number;
  /** Ticks left in a brief pause mid-walk or after a task. */
  pauseTicks: number;
  /** Tick at which the next mid-walk pause may happen. */
  nextPauseTick: number;
  /** Ticks left before an action (report, kill) is carried out. */
  actionTicks: number;
  /** Tick at which a hunt path is next recomputed. */
  repathTick: number;
  /** Current heading (unit vector), smoothed so turns are rounded. */
  headX: number;
  headY: number;
  /** Sideways drift off the path centre line, in pixels, and where it is heading. */
  drift: number;
  driftTarget: number;
  /** Current speed wobble factor, re-rolled every second or so. */
  wobble: number;
  /** Ticks in a row with no progress while trying to move; triggers a re-path. */
  stuckTicks: number;
  lastX: number;
  lastY: number;
}

export function createBotState(unitId: number, rng: Rng, config: SimConfig): BotState {
  const feel = config.bots.feel;
  const [s0, s1] = pair(feel.speedRange, 0.8, 1.0);
  const [d0, d1] = pair(feel.startDelaySec, 0.5, 4);
  return {
    unitId,
    quirks: { speed: rng.range(s0, s1) },
    goal: { kind: 'idle' },
    path: [],
    pathIndex: 0,
    waitTicks: 0,
    pauseTicks: Math.round(rng.range(d0, d1) * config.tickRate),
    nextPauseTick: 0,
    actionTicks: 0,
    repathTick: 0,
    headX: 0,
    headY: 0,
    drift: 0,
    driftTarget: 0,
    wobble: 1,
    stuckTicks: 0,
    lastX: 0,
    lastY: 0,
  };
}

/** Drops whatever the bot was doing (used when a meeting starts). */
export function resetBotGoal(bot: BotState): void {
  bot.goal = { kind: 'idle' };
  bot.path = [];
  bot.pathIndex = 0;
  bot.waitTicks = 0;
  bot.actionTicks = 0;
  bot.headX = 0;
  bot.headY = 0;
}

/** One tick of thinking and moving for one bot. */
export function stepBot(bot: BotState, unit: Unit, state: SimState, map: GameMap, config: SimConfig): void {
  if (state.phase !== 'play') return;

  // Perception first: things worth dropping the current goal for.
  if (unit.alive) {
    if (unit.role === 'crew' && bot.goal.kind !== 'report') noticeBodies(bot, unit, state, map, config);
    if (unit.role === 'impostor' && bot.goal.kind !== 'hunt' && unit.killCooldownTicks <= 0) considerHunting(bot, unit, state, map, config);
  }

  if (bot.waitTicks > 0) {
    bot.waitTicks--;
    unit.moving = false;
    if (bot.waitTicks === 0) finishWait(bot, unit, state, config);
    return;
  }
  if (bot.pauseTicks > 0) {
    bot.pauseTicks--;
    unit.moving = false;
    return;
  }
  if (bot.goal.kind === 'hunt') {
    stepHunt(bot, unit, state, map, config);
    return;
  }
  if (bot.goal.kind === 'report') {
    stepReport(bot, unit, state, map, config);
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

// ---------- perception ----------

/** Everything this bot can see is within its own sight radius (same rule as the player). */
export function botSightRadius(unit: Unit, state: SimState, config: SimConfig): number {
  return visionRadiusPx(unit.role, state.settings, config);
}

function visibleBodies(unit: Unit, state: SimState, map: GameMap, config: SimConfig): Body[] {
  const radius = botSightRadius(unit, state, config);
  return state.bodies.filter((b) => canSee(map, unit.x, unit.y, radius, b.x, b.y));
}

/** A crew bot that sees a body goes to report it. */
function noticeBodies(bot: BotState, unit: Unit, state: SimState, map: GameMap, config: SimConfig): void {
  const bodies = visibleBodies(unit, state, map, config);
  if (bodies.length === 0) return;
  bodies.sort((a, b) => distance(unit, a) - distance(unit, b));
  const body = bodies[0] as Body;
  const victim = state.units[body.unitId];
  if (setPath(bot, unit, map, [Math.floor(body.x / map.tileSize), Math.floor(body.y / map.tileSize)])) {
    bot.goal = { kind: 'report', bodyOf: body.unitId, label: `report ${victim?.name ?? 'a'}'s body` };
    bot.waitTicks = 0;
    bot.pauseTicks = 0;
    const [d0, d1] = pair(config.bots.report.delaySec, 0.5, 2);
    bot.actionTicks = Math.round(state.rng.range(d0, d1) * config.tickRate);
  }
}

function stepReport(bot: BotState, unit: Unit, state: SimState, map: GameMap, config: SimConfig): void {
  const goal = bot.goal as { kind: 'report'; bodyOf: number };
  const body = state.bodies.find((b) => b.unitId === goal.bodyOf);
  if (!body) {
    resetBotGoal(bot);
    return;
  }
  if (bodiesInReach(state, unit, config).some((b) => b.unitId === goal.bodyOf)) {
    unit.moving = false;
    if (bot.actionTicks > 0) {
      bot.actionTicks--;
      return;
    }
    tryReport(state, unit, map, config);
    return;
  }
  followPath(bot, unit, state, map, config);
}

/**
 * Who could see a kill at the target's spot: every other living unit within its own sight radius.
 * Phase 2 rule: an impostor bot only kills when nobody could see it (SPEC 9.6).
 */
export function witnessesOf(state: SimState, target: Unit, killer: Unit, map: GameMap, config: SimConfig): Unit[] {
  return state.units.filter(
    (u) => u.alive && u.id !== target.id && u.id !== killer.id && canSee(map, u.x, u.y, botSightRadius(u, state, config), target.x, target.y),
  );
}

function considerHunting(bot: BotState, unit: Unit, state: SimState, map: GameMap, config: SimConfig): void {
  const radius = botSightRadius(unit, state, config);
  let best: Unit | null = null;
  let bestDist = Infinity;
  for (const u of state.units) {
    if (!u.alive || u.role === 'impostor' || u.id === unit.id) continue;
    if (!canSee(map, unit.x, unit.y, radius, u.x, u.y)) continue;
    if (witnessesOf(state, u, unit, map, config).length > 0) continue;
    const d = distance(unit, u);
    if (d < bestDist) {
      best = u;
      bestDist = d;
    }
  }
  if (!best) return;
  if (setPath(bot, unit, map, unitTile(best, map))) {
    bot.goal = { kind: 'hunt', targetId: best.id, label: `hunting ${best.name}` };
    bot.waitTicks = 0;
    bot.pauseTicks = 0;
    const [h0, h1] = pair(config.bots.kill.hesitateSec, 0.3, 1.2);
    bot.actionTicks = Math.round(state.rng.range(h0, h1) * config.tickRate);
    bot.repathTick = state.tick + Math.round(config.bots.kill.repathSec * config.tickRate);
  }
}

function stepHunt(bot: BotState, unit: Unit, state: SimState, map: GameMap, config: SimConfig): void {
  const goal = bot.goal as { kind: 'hunt'; targetId: number };
  const target = state.units[goal.targetId];
  // Give up if the target died, someone is watching, or the cooldown somehow restarted.
  if (!target || !target.alive || unit.killCooldownTicks > 0 || witnessesOf(state, target, unit, map, config).length > 0) {
    resetBotGoal(bot);
    return;
  }
  if (canKill(state, unit, target, config)) {
    unit.moving = false;
    if (bot.actionTicks > 0) {
      bot.actionTicks--;
      return;
    }
    tryKill(state, unit, target, config);
    resetBotGoal(bot);
    // Walk off somewhere else right away rather than standing over the body.
    chooseGoal(bot, unit, state, map, config, true);
    return;
  }
  if (state.tick >= bot.repathTick) {
    setPath(bot, unit, map, unitTile(target, map));
    bot.repathTick = state.tick + Math.round(config.bots.kill.repathSec * config.tickRate);
  }
  followPath(bot, unit, state, map, config);
}

// ---------- decision: tasks and wandering ----------

/** Picks the next task (nearer is likelier, but not certain) or somewhere to wander. */
function chooseGoal(bot: BotState, unit: Unit, state: SimState, map: GameMap, config: SimConfig, forceWander = false): void {
  const feel = config.bots.feel;
  const rng = state.rng;
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

  // Sometimes go and have a look at a room first, even with work to do.
  const detour = forceWander || (candidates.length > 0 && rng.chance(feel.detourChance));
  if (candidates.length > 0 && !detour) {
    // Weighted pick: a spot twice as far is noticeably less likely, but far spots still get chosen.
    const scale = feel.taskDistanceScaleTiles * map.tileSize;
    const weights = candidates.map((c) => 1 / Math.pow(1 + c.dist / scale, 1.5));
    const pick = candidates[weightedIndex(rng, weights)] as (typeof candidates)[0];
    const spot = map.tasks.find((t) => t.id === pick.spotId);
    if (spot && setPath(bot, unit, map, spot.pos)) {
      const label = `${TASK_LABELS[pick.task.type] ?? pick.task.type} in ${spot.room}`;
      bot.goal = { kind: 'task', taskId: pick.task.id, spotId: pick.spotId, label };
      scheduleNextPause(bot, state, config);
      return;
    }
  }
  // Wander to a random floor tile in a random room (nearby rooms preferred when detouring).
  for (let attempt = 0; attempt < 6; attempt++) {
    const room = rng.pick(map.rooms);
    if (!room.rect) continue;
    const tx = rng.int(room.rect.x, room.rect.x + room.rect.w - 1);
    const ty = rng.int(room.rect.y, room.rect.y + room.rect.h - 1);
    if (!map.isWalkable(tx, ty)) continue;
    if (detour && Math.hypot(tx * map.tileSize - unit.x, ty * map.tileSize - unit.y) > 20 * map.tileSize) continue;
    if (setPath(bot, unit, map, [tx, ty])) {
      bot.goal = { kind: 'wander', target: [tx, ty], label: (detour ? 'look around ' : 'wander to ') + room.name };
      scheduleNextPause(bot, state, config);
      return;
    }
  }
  bot.goal = { kind: 'idle' };
  bot.pauseTicks = config.tickRate; // try again in a second
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

// ---------- movement ----------

function followPath(bot: BotState, unit: Unit, state: SimState, map: GameMap, config: SimConfig): void {
  if (bot.pathIndex >= bot.path.length) {
    arrive(bot, unit, state, config);
    return;
  }
  const feel = config.bots.feel;
  const rng = state.rng;
  const ts = map.tileSize;
  const half = ts / 2;
  const urgent = bot.goal.kind === 'hunt' || bot.goal.kind === 'report';

  // A brief pause now and then, sometimes turning to look around (not while hunting or reporting).
  if (!urgent && state.tick >= bot.nextPauseTick) {
    const [p0, p1] = pair(feel.pauseSec, 0.3, 1.5);
    bot.pauseTicks = Math.round(rng.range(p0, p1) * config.tickRate);
    if (rng.chance(feel.lookAroundChance)) unit.facing = unit.facing > 0 ? -1 : 1;
    scheduleNextPause(bot, state, config);
    unit.moving = false;
    return;
  }

  // Speed wobble and sideways drift change slowly.
  if (state.tick % config.tickRate === 0) bot.wobble = 1 + rng.range(-feel.speedWobble, feel.speedWobble);
  if (state.tick % (config.tickRate * 2) === 0) bot.driftTarget = rng.range(-feel.driftPx, feel.driftPx);
  bot.drift += (bot.driftTarget - bot.drift) * 0.05;

  const wp = bot.path[bot.pathIndex] as TilePos;
  const last = bot.pathIndex === bot.path.length - 1;
  let targetX = wp[0] * ts + half;
  let targetY = wp[1] * ts + half;
  let dx = targetX - unit.x;
  let dy = targetY - unit.y;
  let dist = Math.hypot(dx, dy);
  const speed = unitSpeedPxPerTick(state, config) * (urgent ? 1 : bot.quirks.speed * bot.wobble);

  // Waypoints are passed loosely (corners get rounded); the final one is reached exactly.
  const reach = last ? Math.max(config.bots.waypointTolerancePx, speed) : ts * 0.45;
  if (dist <= reach) {
    bot.pathIndex++;
    if (bot.pathIndex >= bot.path.length) {
      if (!urgent) {
        unit.x = targetX;
        unit.y = targetY;
      }
      arrive(bot, unit, state, config);
      return;
    }
    const next = bot.path[bot.pathIndex] as TilePos;
    targetX = next[0] * ts + half;
    targetY = next[1] * ts + half;
    dx = targetX - unit.x;
    dy = targetY - unit.y;
    dist = Math.hypot(dx, dy);
  }
  if (dist === 0) return;

  // Desired direction, nudged sideways by the drift (not on the last stretch, to land on the spot).
  let wantX = dx / dist;
  let wantY = dy / dist;
  if (!last) {
    wantX += (-wantY * bot.drift) / ts;
    wantY += (wantX * bot.drift) / ts;
    const n = Math.hypot(wantX, wantY) || 1;
    wantX /= n;
    wantY /= n;
  }
  // Smooth the heading so turns are rounded rather than instant.
  if (bot.headX === 0 && bot.headY === 0) {
    bot.headX = wantX;
    bot.headY = wantY;
  } else {
    bot.headX += (wantX - bot.headX) * feel.turnSmoothing;
    bot.headY += (wantY - bot.headY) * feel.turnSmoothing;
    const n = Math.hypot(bot.headX, bot.headY) || 1;
    bot.headX /= n;
    bot.headY /= n;
  }
  moveUnit(unit, bot.headX, bot.headY, speed, map, config);

  // Stuck detection: no progress for a while means something is wrong; find a new path.
  if (Math.hypot(unit.x - bot.lastX, unit.y - bot.lastY) < 0.5) {
    bot.stuckTicks++;
    if (bot.stuckTicks >= config.bots.stuckTicks) {
      const goalTile = bot.path[bot.path.length - 1] as TilePos;
      bot.headX = 0;
      bot.headY = 0;
      if (!setPath(bot, unit, map, goalTile)) resetBotGoal(bot);
    }
  } else {
    bot.stuckTicks = 0;
  }
  bot.lastX = unit.x;
  bot.lastY = unit.y;
}

function scheduleNextPause(bot: BotState, state: SimState, config: SimConfig): void {
  const [e0, e1] = pair(config.bots.feel.pauseEverySec, 3, 10);
  bot.nextPauseTick = state.tick + Math.round(state.rng.range(e0, e1) * config.tickRate);
}

function arrive(bot: BotState, unit: Unit, state: SimState, config: SimConfig): void {
  unit.moving = false;
  bot.headX = 0;
  bot.headY = 0;
  if (bot.goal.kind === 'task') {
    const goal = bot.goal;
    const task = unit.tasks.find((t) => t.id === goal.taskId);
    const base = config.tasks.durationSec[task?.type ?? ''] ?? 5;
    const jitter = 1 + state.rng.range(-config.tasks.botJitter, config.tasks.botJitter);
    bot.waitTicks = Math.max(1, Math.round(base * jitter * config.tickRate));
  } else if (bot.goal.kind === 'wander') {
    const [lo, hi] = pair(config.bots.wanderIdleSec, 2, 5);
    bot.waitTicks = Math.round(state.rng.range(lo, hi) * config.tickRate);
  } else if (bot.goal.kind === 'hunt' || bot.goal.kind === 'report') {
    // Arrived at the last known spot; the hunt/report logic takes it from here next tick.
    bot.path = [];
    bot.pathIndex = 0;
  } else {
    bot.waitTicks = 1;
  }
}

/** Called when the wait at a goal ends: complete the task stage, hesitate, then think again. */
function finishWait(bot: BotState, unit: Unit, state: SimState, config: SimConfig): void {
  if (bot.goal.kind === 'task') {
    const goal = bot.goal;
    const task = unit.tasks.find((t) => t.id === goal.taskId);
    const stage = task ? nextStage(task) : null;
    if (task && stage && stage.spotId === goal.spotId) completeStage(state, unit, stage);
    const [a0, a1] = pair(config.bots.feel.afterTaskPauseSec, 0.5, 2.5);
    bot.pauseTicks = Math.round(state.rng.range(a0, a1) * config.tickRate);
  }
  bot.goal = { kind: 'idle' };
  bot.path = [];
  bot.pathIndex = 0;
}

function weightedIndex(rng: Rng, weights: readonly number[]): number {
  let total = 0;
  for (const w of weights) total += w;
  let r = rng.next() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i] as number;
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

function pair(range: readonly number[] | undefined, a: number, b: number): [number, number] {
  return [range?.[0] ?? a, range?.[1] ?? b];
}

/** Plain-language description for F3. */
export function describeGoal(bot: BotState): string {
  const paused = bot.pauseTicks > 0 ? ' (pausing)' : '';
  switch (bot.goal.kind) {
    case 'idle':
      return 'thinking' + paused;
    case 'task':
      return (bot.waitTicks > 0 ? 'doing ' : 'going to ') + bot.goal.label + paused;
    case 'wander':
      return (bot.waitTicks > 0 ? 'loitering after ' : '') + bot.goal.label + paused;
    case 'report':
      return (bot.actionTicks > 0 && bot.path.length === 0 ? 'about to ' : 'going to ') + bot.goal.label;
    case 'hunt':
      return bot.goal.label + (bot.actionTicks > 0 && bot.path.length === 0 ? ' (about to strike)' : '');
  }
}
