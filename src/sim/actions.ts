// What units can do to the world: kill, report a body, call a meeting, do a task stage.
// Pure TypeScript, shared by the player's input handling and the bot brains, so both follow
// exactly the same rules (SPEC 4.4, 4.6, 7.2).

import type { GameMap, TaskSpot } from './map';
import { startMeeting, type MeetingEvent } from './meeting';
import { KILL_DISTANCE_TILES } from './settings';
import type { SimConfig, SimState, Unit } from './sim';
import { completeStage, unitTile } from './sim';
import { nextStage, type Task, type TaskStage } from './tasks';

export interface Body {
  readonly unitId: number;
  readonly x: number;
  readonly y: number;
  readonly tick: number;
}

export type SimEvent =
  | { kind: 'kill'; killerId: number; victimId: number; x: number; y: number }
  | { kind: 'taskStage'; unitId: number; taskId: string; taskDone: boolean }
  | MeetingEvent;

export function killRangePx(state: SimState, config: SimConfig): number {
  return KILL_DISTANCE_TILES[state.settings.killDistance] * config.tileSize;
}

export function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** The living crew member nearest to the killer within kill range, or null. */
export function findKillTarget(state: SimState, killer: Unit, config: SimConfig): Unit | null {
  const range = killRangePx(state, config);
  let best: Unit | null = null;
  let bestDist = Infinity;
  for (const u of state.units) {
    if (u.id === killer.id || !u.alive || u.role === 'impostor') continue;
    const d = distance(killer, u);
    if (d <= range && d < bestDist) {
      best = u;
      bestDist = d;
    }
  }
  return best;
}

export function canKill(state: SimState, killer: Unit, victim: Unit, config: SimConfig): boolean {
  return (
    state.phase === 'play' &&
    killer.alive &&
    killer.role === 'impostor' &&
    killer.killCooldownTicks <= 0 &&
    victim.alive &&
    victim.role === 'crew' &&
    distance(killer, victim) <= killRangePx(state, config)
  );
}

/** Kills the victim if the rules allow. The killer hops onto the victim's spot; a body is left. */
export function tryKill(state: SimState, killer: Unit, victim: Unit, config: SimConfig): boolean {
  if (!canKill(state, killer, victim, config)) return false;
  victim.alive = false;
  victim.deathTick = state.tick;
  victim.moving = false;
  state.bodies.push({ unitId: victim.id, x: victim.x, y: victim.y, tick: state.tick });
  killer.x = victim.x;
  killer.y = victim.y;
  killer.killCooldownTicks = Math.round(state.settings.killCooldownSec * config.tickRate);
  if (state.playerTask && victim.isPlayer) state.playerTask = null;
  state.events.push({ kind: 'kill', killerId: killer.id, victimId: victim.id, x: victim.x, y: victim.y });
  return true;
}

export function reportRangePx(config: SimConfig): number {
  return config.rules.reportRangeTiles * config.tileSize;
}

/** Bodies within report range of the unit. */
export function bodiesInReach(state: SimState, unit: Unit, config: SimConfig): Body[] {
  const range = reportRangePx(config);
  return state.bodies.filter((b) => distance(unit, b) <= range);
}

/** Reports the nearest body in reach, starting a meeting. False if there is none or the unit may not. */
export function tryReport(state: SimState, reporter: Unit, map: GameMap, config: SimConfig): boolean {
  if (state.phase !== 'play' || !reporter.alive) return false;
  const bodies = bodiesInReach(state, reporter, config);
  if (bodies.length === 0) return false;
  bodies.sort((a, b) => distance(reporter, a) - distance(reporter, b));
  startMeeting(state, reporter, 'body', (bodies[0] as Body).unitId, map, config);
  return true;
}

/** True if the unit stands close enough to the emergency button to press it. */
export function nearButton(unit: Unit, map: GameMap, config: SimConfig): boolean {
  if (!map.button) return false;
  const bx = map.button[0] * map.tileSize + map.tileSize / 2;
  const by = map.button[1] * map.tileSize + map.tileSize / 2;
  return distance(unit, { x: bx, y: by }) <= config.rules.useRangeTiles * map.tileSize;
}

/** Calls an emergency meeting if the unit is alive, has one left, and is at the button. */
export function tryCallMeeting(state: SimState, caller: Unit, map: GameMap, config: SimConfig): boolean {
  if (state.phase !== 'play' || !caller.alive || caller.meetingsLeft <= 0 || !nearButton(caller, map, config)) return false;
  caller.meetingsLeft--;
  startMeeting(state, caller, 'button', null, map, config);
  return true;
}

export interface ReachableStage {
  readonly task: Task;
  readonly stage: TaskStage;
  readonly spot: TaskSpot;
}

/** The unit's next task stage whose spot is within reach, nearest first. */
export function reachableStage(unit: Unit, map: GameMap, config: SimConfig): ReachableStage | null {
  const range = config.rules.taskRangeTiles * map.tileSize;
  const half = map.tileSize / 2;
  let best: ReachableStage | null = null;
  let bestDist = Infinity;
  for (const task of unit.tasks) {
    const stage = nextStage(task);
    if (!stage) continue;
    const spot = map.tasks.find((t) => t.id === stage.spotId);
    if (!spot) continue;
    const d = distance(unit, { x: spot.pos[0] * map.tileSize + half, y: spot.pos[1] * map.tileSize + half });
    if (d <= range && d < bestDist) {
      best = { task, stage, spot };
      bestDist = d;
    }
  }
  return best;
}

/** Ticks of holding Use needed to finish a stage of this task type. */
export function stageDurationTicks(taskType: string, config: SimConfig): number {
  const secs = (config.tasks.durationSec[taskType] ?? 5) / (config.rules.playerTaskSpeed || 1);
  return Math.max(1, Math.round(secs * config.tickRate));
}

/**
 * Advances the player's hold-to-do task progress by one tick. Progress belongs to one stage and is
 * lost when the player stops holding or walks out of reach. Completes the stage when full.
 */
export function updatePlayerTask(state: SimState, unit: Unit, useHeld: boolean, map: GameMap, config: SimConfig): void {
  if (state.phase !== 'play') {
    state.playerTask = null;
    return;
  }
  const reach = reachableStage(unit, map, config);
  if (!useHeld || !reach) {
    state.playerTask = null;
    return;
  }
  const needed = stageDurationTicks(reach.task.type, config);
  const current = state.playerTask;
  const ticks = current && current.taskId === reach.task.id && current.spotId === reach.spot.id ? current.ticks + 1 : 1;
  if (ticks >= needed) {
    completeStage(state, unit, reach.stage);
    state.playerTask = null;
    state.events.push({ kind: 'taskStage', unitId: unit.id, taskId: reach.task.id, taskDone: nextStage(reach.task) === null });
    return;
  }
  state.playerTask = { taskId: reach.task.id, spotId: reach.spot.id, ticks, needed };
}

export function unitAtTile(unit: Unit, map: GameMap): [number, number] {
  return unitTile(unit, map);
}
