// Bot brain. Pure TypeScript, no Phaser.
//
// Architecture (SPEC 9.2): Perception (memory.ts) -> Memory -> Social model (suspicion.ts) ->
// Decision (this file, decisions.ts, voting.ts) -> Voice (meeting.ts + chat templates).
// This file is the decision layer for movement and actions:
//   crew:     do tasks; buddy up sometimes; report bodies (with a personality delay and a look
//             around); walk away from a lone top suspect; press the button on certain evidence.
//   impostor: fake tasks (never visual ones unless sloppy); pick targets that are alone and
//             unwatched by the difficulty's rule; hesitate by personality; walk off after a kill;
//             on hard, sometimes self-report and avoid being alone with the player.
//
// "Feel" rules (Greg, 2026-09-07): bots must not walk like robots. So each bot has its own walking
// speed with a little wobble, rounds corners instead of following tile centres exactly, drifts
// sideways a bit, pauses now and then (sometimes looking around), hesitates after finishing a task,
// leaves spawn at its own time, and occasionally wanders off to look at a room before working.
// Task choice is weighted by distance rather than strictly nearest. Every random choice comes from
// the game's seeded Rng, so it all replays exactly.

import brainsJson from '../../config/brains.json';
import { bodiesInReach, canKill, distance, nearButton, tryCallMeeting, tryKill, tryReport, type Body } from '../sim/actions';
import type { GameMap, TilePos } from '../sim/map';
import { findPath } from '../sim/pathfinding';
import type { Rng } from '../sim/rng';
import { completeStage, moveUnit, unitSpeedPxPerTick, unitTile, type SimConfig, type SimState, type Unit } from '../sim/sim';
import { nextStage, TASK_LABELS, VISUAL_TASKS, type Task } from '../sim/tasks';
import { canSee, visionRadiusPx } from '../sim/vision';
import { hopToVent, tryEnterVent, tryExitVent, ventById, ventCentre, ventInReach, ventNeighbours } from '../sim/vents';
import type { Alibi } from './decisions';
import { accusersOf } from './decisions';
import { createMemory, type BotMemory } from './memory';
import { difficultyTable, personality } from './personality';
import { createSocial, suspicionOf, topSuspect, type SocialModel } from './suspicion';

const CREW = brainsJson.crew;
const IMPOSTOR = brainsJson.impostor;

export type BotGoal =
  | { kind: 'idle' }
  | { kind: 'task'; taskId: string; spotId: string; label: string }
  | { kind: 'wander'; target: TilePos; label: string }
  | { kind: 'report'; bodyOf: number; label: string }
  | { kind: 'hunt'; targetId: number; label: string }
  | { kind: 'follow'; targetId: number; untilTick: number; label: string }
  | { kind: 'flee'; fromId: number; target: TilePos; label: string }
  | { kind: 'button'; label: string }
  /** Impostor: walking to a vent, then hiding inside until the coast is clear (SPEC 9.6). */
  | { kind: 'vent'; ventId: string; stage: 'walking' | 'inside'; waitedTicks: number; label: string };

/** Per-bot movement character, rolled once per game. */
export interface BotQuirks {
  /** Fraction of full walking speed this bot prefers. */
  readonly speed: number;
}

export interface BotState {
  readonly unitId: number;
  readonly quirks: BotQuirks;
  /** Personality id from config/personalities.json (SPEC 9.8). */
  readonly personality: string;
  /** What this bot has seen and heard (SPEC 9.3, 9.4). */
  readonly memory: BotMemory;
  /** Who this bot suspects and trusts, and why (SPEC 9.7). */
  readonly social: SocialModel;
  /** Alibis already told, by claim window, so the story never changes (SPEC 9.6 hard mode). */
  readonly alibis: Record<string, Alibi>;
  /** Tests and the debug tools can freeze a bot in place; it still sees and remembers. */
  frozen: boolean;
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
  /** Tick at which a hunt or follow path is next recomputed. */
  repathTick: number;
  /** Tick before which the bot will not buddy up again / flee again. */
  buddyCooldownUntil: number;
  fleeCooldownUntil: number;
  /** Set when a hard impostor has decided to report its own kill. */
  selfReportTick: number;
  /** True once this bot changed its vote in the current meeting. */
  voteChanged: boolean;
  /** Last chat intent used and why, for F3. */
  lastIntent: string | null;
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

export function createBotState(unitId: number, rng: Rng, config: SimConfig, personalityId = 'follower'): BotState {
  const feel = config.bots.feel;
  const [s0, s1] = pair(feel.speedRange, 0.8, 1.0);
  const [d0, d1] = pair(feel.startDelaySec, 0.5, 4);
  return {
    unitId,
    quirks: { speed: rng.range(s0, s1) },
    personality: personalityId,
    memory: createMemory(),
    social: createSocial(),
    alibis: {},
    frozen: false,
    goal: { kind: 'idle' },
    path: [],
    pathIndex: 0,
    waitTicks: 0,
    pauseTicks: Math.round(rng.range(d0, d1) * config.tickRate),
    nextPauseTick: 0,
    actionTicks: 0,
    repathTick: 0,
    buddyCooldownUntil: 0,
    fleeCooldownUntil: 0,
    selfReportTick: 0,
    voteChanged: false,
    lastIntent: null,
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
  if (state.phase !== 'play' || bot.frozen) return;

  // Things worth dropping the current goal for.
  if (unit.alive) {
    if (unit.role === 'crew') {
      if (bot.goal.kind !== 'report') noticeBodies(bot, unit, state, map, config);
      if (bot.goal.kind !== 'report' && bot.goal.kind !== 'button') considerButton(bot, unit, state, map, config);
      if (bot.goal.kind !== 'report' && bot.goal.kind !== 'button' && bot.goal.kind !== 'flee') considerFear(bot, unit, state, map, config);
    } else {
      // Somehow inside a vent without a vent goal (never expected): climb out and think again.
      if (unit.inVent !== null && bot.goal.kind !== 'vent') {
        tryExitVent(state, unit, map);
        resetBotGoal(bot);
      }
      const busy = bot.goal.kind === 'vent';
      if (!busy && bot.selfReportTick > 0 && state.tick >= bot.selfReportTick && bot.goal.kind !== 'report') selfReport(bot, unit, state, map, config);
      if (!busy && bot.goal.kind !== 'hunt' && bot.goal.kind !== 'report' && unit.killCooldownTicks <= 0) considerHunting(bot, unit, state, map, config);
      if (!busy && bot.goal.kind !== 'hunt' && bot.goal.kind !== 'report' && bot.goal.kind !== 'flee') considerAvoidingPlayer(bot, unit, state, map, config);
    }
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
    if (bot.goal.kind === 'report' && personality(bot.personality).lookAroundFirst && bot.pauseTicks % 15 === 0) unit.facing = unit.facing > 0 ? -1 : 1;
    return;
  }
  switch (bot.goal.kind) {
    case 'hunt':
      stepHunt(bot, unit, state, map, config);
      return;
    case 'report':
      stepReport(bot, unit, state, map, config);
      return;
    case 'follow':
      stepFollow(bot, unit, state, map, config);
      return;
    case 'button':
      stepButton(bot, unit, state, map, config);
      return;
    case 'vent':
      stepVent(bot, unit, state, map, config);
      return;
    case 'idle':
      chooseGoal(bot, unit, state, map, config);
      if (bot.goal.kind === 'idle') {
        unit.moving = false;
        return;
      }
      break;
    default:
      break;
  }
  followPath(bot, unit, state, map, config);
}

// ---------- perception helpers ----------

/** Everything this bot can see is within its own sight radius (same rule as the player). */
export function botSightRadius(unit: Unit, state: SimState, config: SimConfig): number {
  return visionRadiusPx(unit.role, state.settings, config);
}

function visibleBodies(unit: Unit, state: SimState, map: GameMap, config: SimConfig): Body[] {
  const radius = botSightRadius(unit, state, config);
  return state.bodies.filter((b) => canSee(map, unit.x, unit.y, radius, b.x, b.y));
}

function visibleUnits(unit: Unit, state: SimState, map: GameMap, config: SimConfig): Unit[] {
  if (unit.inVent !== null) return [];
  const radius = botSightRadius(unit, state, config);
  return state.units.filter((u) => u.id !== unit.id && u.alive && u.inVent === null && canSee(map, unit.x, unit.y, radius, u.x, u.y));
}

// ---------- crew ----------

/** A crew bot that sees a body goes to report it, after its personality's delay. */
function noticeBodies(bot: BotState, unit: Unit, state: SimState, map: GameMap, config: SimConfig): void {
  const bodies = visibleBodies(unit, state, map, config);
  if (bodies.length === 0) return;
  bodies.sort((a, b) => distance(unit, a) - distance(unit, b));
  const body = bodies[0] as Body;
  const victim = state.units[body.unitId];
  if (setPath(bot, unit, map, [Math.floor(body.x / map.tileSize), Math.floor(body.y / map.tileSize)])) {
    const p = personality(bot.personality);
    bot.goal = { kind: 'report', bodyOf: body.unitId, label: `report ${victim?.name ?? 'a'}'s body` };
    bot.waitTicks = 0;
    // A look around first (some personalities) happens before walking; the delay at the body is the personality's.
    bot.pauseTicks = p.lookAroundFirst ? Math.round(state.rng.range(0.8, 1.6) * config.tickRate) : 0;
    bot.actionTicks = Math.round((p.reportDelaySec + state.rng.range(0, 0.5)) * config.tickRate);
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

/** Certain evidence (a witnessed kill), no body in sight, a meeting left: go press the button. */
function considerButton(bot: BotState, unit: Unit, state: SimState, map: GameMap, config: SimConfig): void {
  if (!CREW.button.walkIfCertain || unit.meetingsLeft <= 0 || !map.button) return;
  const certainTarget = state.units.find((u) => u.alive && u.id !== unit.id && bot.social.certain[u.id]);
  if (!certainTarget) return;
  if (visibleBodies(unit, state, map, config).length > 0) return;
  if (setPath(bot, unit, map, buttonStandTile(map))) {
    bot.goal = { kind: 'button', label: `call a meeting about ${certainTarget.name}` };
    bot.waitTicks = 0;
    bot.pauseTicks = 0;
  }
}

function stepButton(bot: BotState, unit: Unit, state: SimState, map: GameMap, config: SimConfig): void {
  if (nearButton(unit, map, config)) {
    unit.moving = false;
    if (!tryCallMeeting(state, unit, map, config)) resetBotGoal(bot);
    return;
  }
  if (bot.pathIndex >= bot.path.length) {
    // Arrived but not close enough (crowded); nudge once more or give up.
    if (!setPath(bot, unit, map, buttonStandTile(map))) resetBotGoal(bot);
    return;
  }
  followPath(bot, unit, state, map, config);
}

function buttonStandTile(map: GameMap): TilePos {
  const [bx, by] = map.button as TilePos;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    if (map.isWalkable(bx + dx, by + dy)) return [bx + dx, by + dy];
  }
  return [bx, by];
}

/** Alone with my top suspect: walk toward company. */
function considerFear(bot: BotState, unit: Unit, state: SimState, map: GameMap, config: SimConfig): void {
  if (state.tick < bot.fleeCooldownUntil) return;
  const top = topSuspect(bot.social, state, unit.id);
  if (!top || top.score < CREW.fear.minSuspicion) return;
  const suspect = state.units[top.id];
  if (!suspect || !suspect.alive || suspect.inVent !== null) return;
  const range = CREW.fear.rangeTiles * map.tileSize;
  if (distance(unit, suspect) > range) return;
  const others = visibleUnits(unit, state, map, config).filter((u) => u.id !== suspect.id && distance(unit, u) <= range);
  if (others.length > 0) return;
  // Company: the room where I last saw the most people, other than here.
  const here = map.regionAt(...unitTile(unit, map))?.name;
  const counts = new Map<string, number>();
  for (const s of Object.values(bot.memory.open)) {
    if (s.subjectId === suspect.id) continue;
    const room = s.rooms[s.rooms.length - 1]!.room;
    if (room !== here && !room.startsWith('Corridor')) counts.set(room, (counts.get(room) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [room, count] of counts) {
    if (count > bestCount) {
      best = room;
      bestCount = count;
    }
  }
  const target = best ? map.regionByName(best) : null;
  const dest = target?.rect ? roomTile(target.rect, state.rng, map) : farthestRoomTile(suspect, state.rng, map);
  if (dest && setPath(bot, unit, map, dest)) {
    bot.goal = { kind: 'flee', fromId: suspect.id, target: dest, label: `getting away from ${suspect.name} (${Math.round(top.score)}) toward ${best ?? 'somewhere busier'}` };
    bot.fleeCooldownUntil = state.tick + Math.round(CREW.fear.cooldownSec * config.tickRate);
    bot.waitTicks = 0;
    bot.pauseTicks = 0;
  }
}

/** Buddying (SPEC 9.5): sometimes tag along with someone in sight for a while. */
function considerBuddy(bot: BotState, unit: Unit, state: SimState, map: GameMap, config: SimConfig): boolean {
  const p = personality(bot.personality);
  if (state.tick < bot.buddyCooldownUntil || !state.rng.chance(p.buddyChance * 0.5)) return false;
  const candidates = visibleUnits(unit, state, map, config).filter((u) => suspicionOf(bot.social, u.id) < p.voteThreshold);
  if (candidates.length === 0) return false;
  candidates.sort((a, b) => distance(unit, a) - distance(unit, b));
  const buddy = candidates[0] as Unit;
  if (!setPath(bot, unit, map, unitTile(buddy, map))) return false;
  const [d0, d1] = pair(CREW.buddy.durationSec, 12, 30);
  bot.goal = { kind: 'follow', targetId: buddy.id, untilTick: state.tick + Math.round(state.rng.range(d0, d1) * config.tickRate), label: `sticking with ${buddy.name}` };
  bot.repathTick = state.tick + Math.round(CREW.buddy.repathSec * config.tickRate);
  scheduleNextPause(bot, state, config);
  return true;
}

function stepFollow(bot: BotState, unit: Unit, state: SimState, map: GameMap, config: SimConfig): void {
  const goal = bot.goal as { kind: 'follow'; targetId: number; untilTick: number };
  const buddy = state.units[goal.targetId];
  const p = personality(bot.personality);
  if (!buddy || !buddy.alive || state.tick >= goal.untilTick || suspicionOf(bot.social, buddy.id) >= p.voteThreshold) {
    const [c0, c1] = pair(CREW.buddy.cooldownSec, 10, 25);
    bot.buddyCooldownUntil = state.tick + Math.round(state.rng.range(c0, c1) * config.tickRate);
    resetBotGoal(bot);
    return;
  }
  if (distance(unit, buddy) <= CREW.buddy.stayWithinTiles * map.tileSize) {
    unit.moving = false;
    bot.path = [];
    bot.pathIndex = 0;
    return;
  }
  if (state.tick >= bot.repathTick || bot.pathIndex >= bot.path.length) {
    setPath(bot, unit, map, unitTile(buddy, map));
    bot.repathTick = state.tick + Math.round(CREW.buddy.repathSec * config.tickRate);
  }
  followPath(bot, unit, state, map, config);
}

// ---------- impostor ----------

/**
 * Who could see a kill at the target's spot: every other living unit within its own sight radius.
 * An impostor bot only kills when nobody could see it (SPEC 9.6).
 */
export function witnessesOf(state: SimState, target: Unit, killer: Unit, map: GameMap, config: SimConfig): Unit[] {
  return watchersOf(state, target, brainsJson.perception.killNoticeRangeTiles, [target.id, killer.id], map, config);
}

/** Every living unit (not in a vent, not excluded) that could see a spot from where it stands. */
export function watchersOf(state: SimState, spot: { x: number; y: number }, noticeTiles: number, exceptIds: readonly number[], map: GameMap, config: SimConfig): Unit[] {
  const notice = noticeTiles * map.tileSize;
  return state.units.filter(
    (u) => u.alive && u.inVent === null && !exceptIds.includes(u.id) && canSee(map, u.x, u.y, Math.min(notice, botSightRadius(u, state, config)), spot.x, spot.y),
  );
}

function considerHunting(bot: BotState, unit: Unit, state: SimState, map: GameMap, config: SimConfig): void {
  const table = difficultyTable(state.settings.difficulty);
  const inSight = visibleUnits(unit, state, map, config);
  // Easy impostors only strike when the target is the only person anywhere near.
  if (table.killCaution === 'onlyAlone' && inSight.filter((u) => distance(unit, u) <= IMPOSTOR.easyAloneRangeTiles * map.tileSize).length > 1) return;
  const player = state.units[0] as Unit;
  const playerAccusedMe = accusersOf(state, unit.id).some((a) => a.id === player.id);
  let best: Unit | null = null;
  let bestScore = -Infinity;
  for (const u of inSight) {
    if (u.role === 'impostor') continue;
    if (witnessesOf(state, u, unit, map, config).length > 0) continue;
    // Prefer near, alone-for-a-while targets; on hard, the player when the player is onto me.
    const sighting = bot.memory.open[u.id];
    let score = -distance(unit, u) / map.tileSize;
    if (sighting && sighting.aloneTicks > config.tickRate * 3) score += 5;
    if (u.isPlayer && table.playerTargeting === 'prioritize' && playerAccusedMe) score += 20;
    if (u.isPlayer && table.playerTargeting === 'random' && state.rng.chance(0.5)) score -= 10;
    if (score > bestScore) {
      best = u;
      bestScore = score;
    }
  }
  if (!best) return;
  if (setPath(bot, unit, map, unitTile(best, map))) {
    const p = personality(bot.personality);
    bot.goal = { kind: 'hunt', targetId: best.id, label: `hunting ${best.name}` };
    bot.waitTicks = 0;
    bot.pauseTicks = 0;
    const [h0, h1] = pair(config.bots.kill.hesitateSec, 0.3, 1.2);
    bot.actionTicks = Math.round(state.rng.range(h0, h1) * p.killHesitationScale * config.tickRate);
    bot.repathTick = state.tick + Math.round(config.bots.kill.repathSec * config.tickRate);
  }
}

function stepHunt(bot: BotState, unit: Unit, state: SimState, map: GameMap, config: SimConfig): void {
  const goal = bot.goal as { kind: 'hunt'; targetId: number };
  const target = state.units[goal.targetId];
  const table = difficultyTable(state.settings.difficulty);
  // Give up if the target died, someone is watching, or the cooldown somehow restarted.
  if (!target || !target.alive || unit.killCooldownTicks > 0 || witnessesOf(state, target, unit, map, config).length > 0) {
    resetBotGoal(bot);
    return;
  }
  if (table.killCaution === 'onlyAlone' && visibleUnits(unit, state, map, config).filter((u) => distance(unit, u) <= IMPOSTOR.easyAloneRangeTiles * map.tileSize).length > 1) {
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
    bot.memory.myKills.push({ tick: state.tick, victimId: target.id, room: map.regionAt(...unitTile(unit, map))?.name ?? '?' });
    resetBotGoal(bot);
    // On hard, sometimes report it yourself; otherwise walk off somewhere else right away.
    if (table.killCaution === 'tracksWitnesses' && state.rng.chance(table.selfReportChance)) {
      const [d0, d1] = pair(IMPOSTOR.selfReportDelaySec, 3, 8);
      bot.selfReportTick = state.tick + Math.round(state.rng.range(d0, d1) * config.tickRate);
      bot.pauseTicks = Math.round(state.rng.range(0.5, 1.5) * config.tickRate);
      return;
    }
    // Vent away if there is one close by (SPEC 9.6), else walk off somewhere else.
    if (considerVentAfterKill(bot, unit, state, map, config)) return;
    chooseGoal(bot, unit, state, map, config, true);
    return;
  }
  if (state.tick >= bot.repathTick) {
    setPath(bot, unit, map, unitTile(target, map));
    bot.repathTick = state.tick + Math.round(config.bots.kill.repathSec * config.tickRate);
  }
  followPath(bot, unit, state, map, config);
}

/**
 * Right after a kill: head for a vent within reach of the body, by the difficulty's chance. Careful
 * impostors only do it when nobody could see the vent; sloppy (easy) ones do it regardless.
 */
function considerVentAfterKill(bot: BotState, unit: Unit, state: SimState, map: GameMap, config: SimConfig): boolean {
  const table = difficultyTable(state.settings.difficulty);
  if (map.vents.length === 0 || !state.rng.chance(table.ventAfterKillChance)) return false;
  const maxDist = IMPOSTOR.vent.afterKillRangeTiles * map.tileSize;
  const options = map.vents
    .map((v) => ({ v, d: distance(unit, ventCentre(v, map)) }))
    .filter((o) => o.d <= maxDist)
    .sort((a, b) => a.d - b.d);
  for (const { v } of options) {
    if (table.impostorFaking !== 'sloppy' && watchersOf(state, ventCentre(v, map), brainsJson.perception.ventNoticeRangeTiles, [unit.id], map, config).length > 0) continue;
    if (!setPath(bot, unit, map, v.pos)) continue;
    bot.goal = { kind: 'vent', ventId: v.id, stage: 'walking', waitedTicks: 0, label: `slipping into the ${v.room} vent` };
    bot.waitTicks = 0;
    bot.pauseTicks = 0;
    bot.actionTicks = 0;
    return true;
  }
  return false;
}

/** Walk to the vent, climb in, hop somewhere else on the network, wait, climb out when unwatched. */
function stepVent(bot: BotState, unit: Unit, state: SimState, map: GameMap, config: SimConfig): void {
  const goal = bot.goal as { kind: 'vent'; ventId: string; stage: 'walking' | 'inside'; waitedTicks: number; label: string };
  const table = difficultyTable(state.settings.difficulty);
  const sloppy = table.impostorFaking === 'sloppy';
  const noticeTiles = brainsJson.perception.ventNoticeRangeTiles;
  if (goal.stage === 'walking') {
    const vent = ventInReach(unit, map, config);
    if (vent && vent.id === goal.ventId) {
      unit.moving = false;
      // Careful impostors wait a moment for a watcher to leave rather than vent in front of them.
      if (!sloppy && watchersOf(state, ventCentre(vent, map), noticeTiles, [unit.id], map, config).length > 0) {
        goal.waitedTicks++;
        if (goal.waitedTicks < Math.round(IMPOSTOR.vent.maxWaitInsideSec * config.tickRate)) return;
        resetBotGoal(bot);
        chooseGoal(bot, unit, state, map, config, true);
        return;
      }
      if (!tryEnterVent(state, unit, map, config)) {
        resetBotGoal(bot);
        return;
      }
      // Hop to another vent on the network: one nobody is watching if possible, else any.
      const here = ventById(map, unit.inVent as string);
      const exits = here ? ventNeighbours(map, here) : [];
      const clear = exits.filter((v) => watchersOf(state, ventCentre(v, map), noticeTiles, [unit.id], map, config).length === 0);
      const pick = clear.length > 0 ? state.rng.pick(clear) : exits.length > 0 ? state.rng.pick(exits) : null;
      if (pick) hopToVent(state, unit, pick, map);
      const [i0, i1] = pair(IMPOSTOR.vent.insideSec, 1.5, 4);
      bot.actionTicks = Math.round(state.rng.range(i0, i1) * config.tickRate);
      goal.stage = 'inside';
      goal.waitedTicks = 0;
      goal.ventId = unit.inVent as string;
      goal.label = `hiding in the ${pick?.room ?? here?.room ?? '?'} vent`;
      return;
    }
    if (bot.pathIndex >= bot.path.length) {
      // Arrived but the vent is not in reach (crowded or blocked): give up on venting.
      resetBotGoal(bot);
      return;
    }
    followPath(bot, unit, state, map, config);
    return;
  }
  // Inside: wait out the hiding time, then climb out once nobody could see the grate.
  unit.moving = false;
  if (bot.actionTicks > 0) {
    bot.actionTicks--;
    return;
  }
  const watched = !sloppy && watchersOf(state, unit, noticeTiles, [unit.id], map, config).length > 0;
  if (watched && goal.waitedTicks < Math.round(IMPOSTOR.vent.maxWaitInsideSec * config.tickRate)) {
    goal.waitedTicks++;
    // Try another exit on the network instead of waiting the whole time here.
    if (goal.waitedTicks % config.tickRate === 0) {
      const here = ventById(map, unit.inVent as string);
      const clear = here ? ventNeighbours(map, here).filter((v) => watchersOf(state, ventCentre(v, map), noticeTiles, [unit.id], map, config).length === 0) : [];
      if (clear.length > 0) {
        const pick = state.rng.pick(clear);
        hopToVent(state, unit, pick, map);
        goal.ventId = pick.id;
        goal.label = `hiding in the ${pick.room} vent`;
      }
    }
    return;
  }
  tryExitVent(state, unit, map);
  resetBotGoal(bot);
  bot.pauseTicks = Math.round(state.rng.range(0.3, 1.0) * config.tickRate);
}

/** A hard impostor "finding" the body it just made. */
function selfReport(bot: BotState, unit: Unit, state: SimState, map: GameMap, config: SimConfig): void {
  bot.selfReportTick = 0;
  const mine = bot.memory.myKills[bot.memory.myKills.length - 1];
  const body = mine ? state.bodies.find((b) => b.unitId === mine.victimId) : undefined;
  if (!body) return;
  if (setPath(bot, unit, map, [Math.floor(body.x / map.tileSize), Math.floor(body.y / map.tileSize)])) {
    bot.goal = { kind: 'report', bodyOf: body.unitId, label: `"finding" ${state.units[body.unitId]?.name}'s body` };
    bot.waitTicks = 0;
    bot.pauseTicks = 0;
    bot.actionTicks = Math.round(state.rng.range(0.3, 1.0) * config.tickRate);
  }
}

/** Hard mode: an impostor does not linger alone with the player, who might be building a case. */
function considerAvoidingPlayer(bot: BotState, unit: Unit, state: SimState, map: GameMap, config: SimConfig): void {
  if (!IMPOSTOR.avoidPlayerAloneOnHard || state.settings.difficulty !== 'hard' || state.tick < bot.fleeCooldownUntil) return;
  if (unit.killCooldownTicks <= 0) return; // with a kill ready, being alone with the player is an opportunity, not a risk
  const player = state.units[0] as Unit;
  if (!player.alive) return;
  const range = CREW.fear.rangeTiles * map.tileSize;
  if (distance(unit, player) > range) return;
  const others = visibleUnits(unit, state, map, config).filter((u) => u.id !== player.id && distance(unit, u) <= range);
  if (others.length > 0) return;
  const dest = farthestRoomTile(player, state.rng, map);
  if (dest && setPath(bot, unit, map, dest)) {
    bot.goal = { kind: 'flee', fromId: player.id, target: dest, label: `not staying alone with ${player.name}` };
    bot.fleeCooldownUntil = state.tick + Math.round(CREW.fear.cooldownSec * config.tickRate);
    bot.waitTicks = 0;
    bot.pauseTicks = 0;
  }
}

// ---------- decision: tasks and wandering ----------

/** Picks the next task (nearer is likelier, but not certain), a buddy, or somewhere to wander. */
function chooseGoal(bot: BotState, unit: Unit, state: SimState, map: GameMap, config: SimConfig, forceWander = false): void {
  const feel = config.bots.feel;
  const rng = state.rng;
  const table = difficultyTable(state.settings.difficulty);
  const candidates: { task: Task; spotId: string; dist: number }[] = [];
  for (const task of unit.tasks) {
    const stage = nextStage(task);
    if (!stage) continue;
    // Impostors know a visual task would expose them (SPEC 9.6); sloppy ones sometimes fake it anyway.
    if (unit.role === 'impostor' && VISUAL_TASKS.has(task.type) && !(table.impostorFaking === 'sloppy' && rng.chance(table.fakeVisualTaskChance))) continue;
    const spot = map.tasks.find((t) => t.id === stage.spotId);
    if (!spot) continue;
    const sx = spot.pos[0] * map.tileSize + map.tileSize / 2;
    const sy = spot.pos[1] * map.tileSize + map.tileSize / 2;
    candidates.push({ task, spotId: spot.id, dist: Math.hypot(sx - unit.x, sy - unit.y) });
  }

  if (!forceWander && unit.role === 'crew' && unit.alive && considerBuddy(bot, unit, state, map, config)) return;

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
  // Wander to a random floor tile in a random room (nearby rooms preferred when detouring; after a
  // kill, somewhere away from where it happened).
  for (let attempt = 0; attempt < 6; attempt++) {
    const room = rng.pick(map.rooms);
    if (!room.rect) continue;
    const tx = rng.int(room.rect.x, room.rect.x + room.rect.w - 1);
    const ty = rng.int(room.rect.y, room.rect.y + room.rect.h - 1);
    if (!map.isWalkable(tx, ty)) continue;
    const far = Math.hypot(tx * map.tileSize - unit.x, ty * map.tileSize - unit.y);
    if (detour && !forceWander && far > 20 * map.tileSize) continue;
    if (forceWander && far < IMPOSTOR.fleeAfterKillTiles * map.tileSize) continue;
    if (setPath(bot, unit, map, [tx, ty])) {
      bot.goal = { kind: 'wander', target: [tx, ty], label: (forceWander ? 'moving on to ' : detour ? 'look around ' : 'wander to ') + room.name };
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

function roomTile(rect: { x: number; y: number; w: number; h: number }, rng: Rng, map: GameMap): TilePos | null {
  for (let i = 0; i < 8; i++) {
    const tx = rng.int(rect.x, rect.x + rect.w - 1);
    const ty = rng.int(rect.y, rect.y + rect.h - 1);
    if (map.isWalkable(tx, ty)) return [tx, ty];
  }
  return null;
}

/** A floor tile in the room farthest from someone. */
function farthestRoomTile(from: Unit, rng: Rng, map: GameMap): TilePos | null {
  let best: TilePos | null = null;
  let bestDist = -1;
  for (const room of map.rooms) {
    if (!room.rect) continue;
    const t = roomTile(room.rect, rng, map);
    if (!t) continue;
    const d = Math.hypot(t[0] * map.tileSize - from.x, t[1] * map.tileSize - from.y);
    if (d > bestDist) {
      best = t;
      bestDist = d;
    }
  }
  return best;
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
  const urgent = bot.goal.kind === 'hunt' || bot.goal.kind === 'report' || bot.goal.kind === 'flee' || bot.goal.kind === 'button' || bot.goal.kind === 'vent';

  // A brief pause now and then, sometimes turning to look around (not while in a hurry).
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
  switch (bot.goal.kind) {
    case 'task': {
      const goal = bot.goal;
      const task = unit.tasks.find((t) => t.id === goal.taskId);
      const base = config.tasks.durationSec[task?.type ?? ''] ?? 5;
      const jitter = 1 + state.rng.range(-config.tasks.botJitter, config.tasks.botJitter);
      bot.waitTicks = Math.max(1, Math.round(base * jitter * config.tickRate));
      return;
    }
    case 'wander':
    case 'flee': {
      const [lo, hi] = pair(config.bots.wanderIdleSec, 2, 5);
      bot.waitTicks = Math.round(state.rng.range(lo, hi) * config.tickRate);
      return;
    }
    case 'hunt':
    case 'report':
    case 'follow':
    case 'button':
    case 'vent':
      // Arrived at the last known spot; the goal's own logic takes it from here next tick.
      bot.path = [];
      bot.pathIndex = 0;
      return;
    default:
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
      return (bot.actionTicks > 0 && bot.path.length === 0 ? 'about to ' : 'going to ') + bot.goal.label + paused;
    case 'hunt':
      return bot.goal.label + (bot.actionTicks > 0 && bot.path.length === 0 ? ' (about to strike)' : '');
    case 'follow':
    case 'flee':
    case 'button':
      return bot.goal.label + paused;
    case 'vent':
      return bot.goal.label + (bot.goal.stage === 'inside' && bot.actionTicks === 0 && bot.goal.waitedTicks > 0 ? ' (waiting for the coast to clear)' : '');
  }
}
