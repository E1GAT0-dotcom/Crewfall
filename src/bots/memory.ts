// Perception and memory (SPEC 9.3, 9.4). Pure TypeScript, seeded.
//
// Every tick a living bot looks at everything in its sight and keeps a log of "sightings": one
// entry per unbroken stretch of seeing one unit, with the rooms that unit passed through, who was
// with it, whether it stood at a task spot or near a body. Kills witnessed and bodies seen are
// logged too. Nothing here decides anything; it only records what the bot could actually see.
// Recall (what the bot remembers later) applies the difficulty's accuracy: an easy bot may
// misremember the room as a neighbouring one or the time by a few seconds, always the same way
// for the same sighting, so its story stays consistent.

import brainsJson from '../../config/brains.json';
import type { Body } from '../sim/actions';
import type { GameMap, Region } from '../sim/map';
import { regionAdjacency } from '../sim/mapValidate';
import type { Difficulty } from '../sim/settings';
import type { SimConfig, SimState, Unit } from '../sim/sim';
import { unitTile } from '../sim/sim';
import { canSee, visionRadiusPx } from '../sim/vision';
import type { Contradiction } from './claims';

export const BRAINS = brainsJson;

export interface RoomVisit {
  readonly tick: number;
  readonly room: string;
}

export interface Sighting {
  readonly id: number;
  readonly subjectId: number;
  readonly startTick: number;
  endTick: number;
  /** Rooms the subject was seen in, in order; the first is where the stretch began. */
  readonly rooms: RoomVisit[];
  /** Ids of units seen close to the subject at any point during the stretch. */
  readonly companions: number[];
  /** Ticks during which the subject was seen with nobody nearby. */
  aloneTicks: number;
  /** Ticks the subject stood still at a task spot. */
  taskTicks: number;
  /** Task spot id the subject was last seen standing at, if any. */
  taskSpotId: string | null;
  /** True if the subject was seen standing near a body. */
  nearBody: boolean;
  /** Room the subject seemed to be heading for when last seen in a corridor, if any. */
  headingRoom: string | null;
  /** Stretches of ticks during which the subject was within arm's reach of me. */
  readonly nearMe: { from: number; to: number }[];
}

export interface KillWitness {
  readonly tick: number;
  readonly killerId: number;
  readonly victimId: number;
  readonly room: string;
}

export interface BodySighting {
  readonly tick: number;
  readonly victimId: number;
  readonly room: string;
}

export interface BotMemory {
  sightings: Sighting[];
  /** Open stretches, by subject id. */
  open: Record<number, Sighting>;
  kills: KillWitness[];
  bodies: BodySighting[];
  /** Claims by others that clash with my own sightings. */
  contradictions: Contradiction[];
  /** My own room history (tick of each change), for alibis. */
  myRooms: RoomVisit[];
  /** Kills I made (impostors only), for building lies. */
  myKills: { tick: number; victimId: number; room: string }[];
  nextSightingId: number;
  /** Tick at which each meeting started, oldest first; used for the memory span. */
  meetingStarts: number[];
}

export function createMemory(): BotMemory {
  return { sightings: [], open: {}, kills: [], bodies: [], contradictions: [], myRooms: [], myKills: [], nextSightingId: 1, meetingStarts: [] };
}

interface DifficultyBrains {
  memoryAccuracy: number;
  memorySpanMeetings: number | null;
}

export function difficultyBrains(d: Difficulty): DifficultyBrains {
  return BRAINS.difficulty[d];
}

let adjacencyCache: { map: GameMap; adj: Map<number, Set<number>> } | null = null;
function adjacencyOf(map: GameMap): Map<number, Set<number>> {
  if (!adjacencyCache || adjacencyCache.map !== map) adjacencyCache = { map, adj: regionAdjacency(map) };
  return adjacencyCache.adj;
}

/** One tick of looking around for one living bot. Call after everyone has moved this tick. */
export function perceive(memory: BotMemory, observer: Unit, state: SimState, map: GameMap, config: SimConfig): void {
  const radius = visionRadiusPx(observer.role, state.settings, config);
  const ts = map.tileSize;
  const p = BRAINS.perception;
  const companionRange = p.companionRangeTiles * ts;
  const taskRange = p.taskSpotRangeTiles * ts;
  const bodyRange = p.bodyRangeTiles * ts;
  const seen = new Set<number>();

  // Where am I? Kept as a change log so alibis can name a room for any moment.
  const myRoom = regionOf(observer, map)?.name ?? '?';
  const lastMine = memory.myRooms[memory.myRooms.length - 1];
  if (!lastMine || lastMine.room !== myRoom) memory.myRooms.push({ tick: state.tick, room: myRoom });

  for (const subject of state.units) {
    if (subject.id === observer.id || !subject.alive) continue;
    if (!canSee(map, observer.x, observer.y, radius, subject.x, subject.y)) continue;
    seen.add(subject.id);
    const region = regionOf(subject, map);
    const room = region?.name ?? '?';
    let s = memory.open[subject.id];
    if (!s) {
      s = {
        id: memory.nextSightingId++,
        subjectId: subject.id,
        startTick: state.tick,
        endTick: state.tick,
        rooms: [{ tick: state.tick, room }],
        companions: [],
        aloneTicks: 0,
        taskTicks: 0,
        taskSpotId: null,
        nearBody: false,
        headingRoom: null,
        nearMe: [],
      };
      memory.open[subject.id] = s;
    }
    s.endTick = state.tick;
    const lastRoom = s.rooms[s.rooms.length - 1] as RoomVisit;
    if (lastRoom.room !== room) s.rooms.push({ tick: state.tick, room });

    // Who is with the subject (anyone alive within a few tiles, the observer included).
    let anyone = false;
    for (const other of state.units) {
      if (other.id === subject.id || !other.alive) continue;
      if (Math.hypot(other.x - subject.x, other.y - subject.y) <= companionRange) {
        anyone = true;
        if (!s.companions.includes(other.id)) s.companions.push(other.id);
      }
    }
    if (!anyone) s.aloneTicks++;
    if (Math.hypot(observer.x - subject.x, observer.y - subject.y) <= companionRange) {
      const run = s.nearMe[s.nearMe.length - 1];
      if (run && run.to === state.tick - 1) run.to = state.tick;
      else s.nearMe.push({ from: state.tick, to: state.tick });
    }

    // Standing still at a task spot looks like doing a task.
    if (!subject.moving) {
      const spot = map.tasks.find((t) => Math.hypot(t.pos[0] * ts + ts / 2 - subject.x, t.pos[1] * ts + ts / 2 - subject.y) <= taskRange);
      if (spot) {
        s.taskTicks++;
        s.taskSpotId = spot.id;
      }
    }
    if (state.bodies.some((b) => Math.hypot(b.x - subject.x, b.y - subject.y) <= bodyRange)) s.nearBody = true;

    // In a corridor, guess the room the subject is heading for from its facing and the corridor's neighbours.
    if (region && region.kind === 'corridor' && subject.moving) s.headingRoom = headingRoom(subject, region, map);
  }

  // Close stretches for anyone no longer in sight.
  for (const key of Object.keys(memory.open)) {
    const id = Number(key);
    if (seen.has(id)) continue;
    const s = memory.open[id] as Sighting;
    delete memory.open[id];
    if (s.endTick - s.startTick + 1 >= Math.round(p.minSightingSec * config.tickRate)) memory.sightings.push(s);
  }
  if (memory.sightings.length > p.maxSightingsPerBot) memory.sightings.splice(0, memory.sightings.length - p.maxSightingsPerBot);

  // Bodies in sight, noted once each.
  for (const b of state.bodies) {
    if (memory.bodies.some((seenBody) => seenBody.victimId === b.unitId)) continue;
    if (canSee(map, observer.x, observer.y, radius, b.x, b.y)) memory.bodies.push({ tick: state.tick, victimId: b.unitId, room: roomAtPx(b, map) });
  }

  // Kills this tick that the observer could see, close enough to notice.
  const noticeRange = Math.min(radius, p.killNoticeRangeTiles * ts);
  for (const ev of state.events) {
    if (ev.kind !== 'kill' || ev.killerId === observer.id) continue;
    if (canSee(map, observer.x, observer.y, noticeRange, ev.x, ev.y)) {
      memory.kills.push({ tick: state.tick, killerId: ev.killerId, victimId: ev.victimId, room: roomAtPx(ev, map) });
    }
  }
}

/** Closes every open stretch (a meeting freezes everyone; sightings end there). */
export function closeAllSightings(memory: BotMemory, config: SimConfig): void {
  const minTicks = Math.round(BRAINS.perception.minSightingSec * config.tickRate);
  for (const key of Object.keys(memory.open)) {
    const s = memory.open[Number(key)] as Sighting;
    if (s.endTick - s.startTick + 1 >= minTicks) memory.sightings.push(s);
  }
  memory.open = {};
}

/** At a meeting start: note it, and forget anything older than the difficulty's memory span. */
export function pruneForMeeting(memory: BotMemory, meetingStartTick: number, difficulty: Difficulty): void {
  memory.meetingStarts.push(meetingStartTick);
  const span = difficultyBrains(difficulty).memorySpanMeetings;
  if (span === null) return;
  // Keep everything since the start of the Nth most recent meeting (this one counts as the first).
  const cutoffIndex = memory.meetingStarts.length - span;
  if (cutoffIndex <= 0) return;
  const cutoff = memory.meetingStarts[cutoffIndex] as number;
  memory.sightings = memory.sightings.filter((s) => s.endTick >= cutoff);
  memory.bodies = memory.bodies.filter((b) => b.tick >= cutoff);
  // Certain evidence (a witnessed kill) is never forgotten.
}

export interface Recalled {
  readonly room: string;
  readonly startTick: number;
  readonly endTick: number;
  /** True if this recollection differs from what really happened. */
  readonly blurred: boolean;
}

/**
 * What the bot remembers of a sighting's room and time. Below 100% accuracy a stable pseudo-random
 * roll (per bot and sighting) may swap the room for a neighbouring one or shift the time, so the
 * bot always tells the same wrong story rather than a new one each time it is asked.
 */
export function recall(botId: number, s: Sighting, room: string, difficulty: Difficulty, map: GameMap, config: SimConfig): Recalled {
  const accuracy = difficultyBrains(difficulty).memoryAccuracy;
  if (accuracy >= 1) return { room, startTick: s.startTick, endTick: s.endTick, blurred: false };
  const roll = stableRoll(botId * 7919 + s.id * 104729 + hashText(room));
  if (roll < accuracy) return { room, startTick: s.startTick, endTick: s.endTick, blurred: false };
  const second = stableRoll(botId * 31 + s.id * 17 + 5);
  if (second < 0.5) {
    const region = map.regionByName(room);
    const neighbours = region ? [...(adjacencyOf(map).get(region.id) ?? [])].map((id) => map.regions[id]).filter((r): r is Region => !!r && r.kind === 'room') : [];
    if (neighbours.length > 0) {
      const pick = neighbours[Math.floor(stableRoll(botId + s.id * 3) * neighbours.length)] as Region;
      return { room: pick.name, startTick: s.startTick, endTick: s.endTick, blurred: true };
    }
  }
  const shift = Math.round((stableRoll(botId * 3 + s.id) * 2 - 1) * BRAINS.recall.timeBlurSec * config.tickRate);
  return { room, startTick: Math.max(0, s.startTick + shift), endTick: Math.max(0, s.endTick + shift), blurred: true };
}

/** Sightings of one subject that overlap a time window, most recent first. */
export function sightingsOf(memory: BotMemory, subjectId: number, fromTick: number, toTick: number): Sighting[] {
  const all = [...memory.sightings, ...Object.values(memory.open)];
  return all.filter((s) => s.subjectId === subjectId && s.endTick >= fromTick && s.startTick <= toTick).sort((a, b) => b.endTick - a.endTick);
}

/** The most recent sightings, newest first. */
export function recentSightings(memory: BotMemory, count: number): Sighting[] {
  const all = [...memory.sightings, ...Object.values(memory.open)];
  return all.sort((a, b) => b.endTick - a.endTick).slice(0, count);
}

/** Plain-language line for F3, e.g. "Trix in Medbay 2:10-2:35 with Pru, at a task". */
export function describeSighting(s: Sighting, state: SimState, tickRate: number): string {
  const who = state.units[s.subjectId]?.name ?? '?';
  const rooms = s.rooms.map((r) => r.room);
  const path = rooms.length > 3 ? `${rooms[0]} … ${rooms[rooms.length - 1]}` : rooms.join(' → ');
  const with_ = s.companions.length > 0 ? ` with ${s.companions.map((id) => state.units[id]?.name ?? '?').join(', ')}` : '';
  const flags: string[] = [];
  if (s.taskTicks >= tickRate) flags.push('at a task');
  if (s.nearBody) flags.push('near a body');
  if (s.aloneTicks >= tickRate * 3) flags.push(s.companions.length > 0 ? 'alone for a while' : 'alone');
  if (s.headingRoom) flags.push(`→ ${s.headingRoom}`);
  return `${who} in ${path} ${clock(s.startTick, tickRate)}-${clock(s.endTick, tickRate)}${with_}${flags.length ? ', ' + flags.join(', ') : ''}`;
}

export function clock(tick: number, tickRate: number): string {
  const secs = Math.floor(tick / tickRate);
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

function regionOf(unit: Unit, map: GameMap): Region | null {
  const [tx, ty] = unitTile(unit, map);
  return map.regionAt(tx, ty);
}

function roomAtPx(p: { x: number; y: number }, map: GameMap): string {
  return map.regionAt(Math.floor(p.x / map.tileSize), Math.floor(p.y / map.tileSize))?.name ?? '?';
}

/** In a corridor: the neighbouring room most in the direction the unit faces (left/right), else the nearest. */
function headingRoom(unit: Unit, corridor: Region, map: GameMap): string | null {
  const adj = adjacencyOf(map).get(corridor.id);
  if (!adj) return null;
  let best: string | null = null;
  let bestScore = -Infinity;
  for (const id of adj) {
    const r = map.regions[id];
    if (!r || r.kind !== 'room' || !r.rect) continue;
    const cx = (r.rect.x + r.rect.w / 2) * map.tileSize;
    const cy = (r.rect.y + r.rect.h / 2) * map.tileSize;
    const dx = cx - unit.x;
    const dy = cy - unit.y;
    const dist = Math.hypot(dx, dy) || 1;
    // Facing only tells left/right; reward rooms on the facing side, then nearer ones.
    const score = (dx / dist) * unit.facing * 0.5 - dist / (map.tileSize * 40);
    if (score > bestScore) {
      bestScore = score;
      best = r.name;
    }
  }
  return best;
}

function stableRoll(n: number): number {
  let x = (n | 0) ^ 0x5bd1e995;
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d);
  x = Math.imul(x ^ (x >>> 12), 0x297a2d39);
  x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
}

function hashText(t: string): number {
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
  return h;
}

export type { Body };
