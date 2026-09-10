// Decision helpers shared by the brain, the voice and the vote (SPEC 9.5, 9.6). Pure TypeScript.
//   - buildAlibi: what a bot says about where it was (impostors lie by swapping the kill room for a
//     room they really passed through, so the lie is never wildly implausible).
//   - accusationTarget: who an impostor accuses (someone seen alone near the body's room, or its
//     loudest accuser); who a crew bot accuses (its top suspect above the personality threshold).
//   - accusersOf: who has accused a unit in meetings so far.

import type { Claim } from './claims';
import { clock, type BotMemory, type RoomVisit } from './memory';
import { personality } from './personality';
import { suspicionOf, topSuspect, type SocialModel } from './suspicion';
import type { BotState } from './brain';
import type { SimConfig, SimState, Unit } from '../sim/sim';

export interface Alibi {
  /** The room the bot will claim. */
  readonly room: string;
  /** True if the room is where the bot really was during the window. */
  readonly truthful: boolean;
  /** Plain-language note for F3. */
  readonly why: string;
}

/** Where a unit's own room log says it was at a tick, or null if unknown. */
export function myRoomAt(memory: BotMemory, tick: number): RoomVisit | null {
  let found: RoomVisit | null = null;
  for (const v of memory.myRooms) {
    if (v.tick <= tick) found = v;
    else break;
  }
  return found;
}

/** Rooms the unit passed through during a window, in order, without repeats in a row. */
export function myRoute(memory: BotMemory, fromTick: number, toTick: number): RoomVisit[] {
  const out: RoomVisit[] = [];
  const start = myRoomAt(memory, fromTick);
  if (start) out.push({ tick: fromTick, room: start.room });
  for (const v of memory.myRooms) {
    if (v.tick <= fromTick || v.tick > toTick) continue;
    if (out.length === 0 || out[out.length - 1]!.room !== v.room) out.push(v);
  }
  return out;
}

/**
 * The alibi a bot gives for the claim window. Crew tell the truth (the room they were in at the
 * moment of the death, or most recently). An impostor who killed in that window names a room from
 * its real route instead of the kill room; the same window always yields the same lie.
 */
export function buildAlibi(bot: BotState, unit: Unit, state: SimState, window: { fromTick: number; toTick: number }, config: SimConfig): Alibi {
  const memory = bot.memory;
  const m = state.meeting;
  const victim = m?.bodyOf !== null && m?.bodyOf !== undefined ? state.units[m.bodyOf] : null;
  const focusTick = Math.min(victim?.deathTick ?? window.toTick, window.toTick);
  const truthfulRoom = mostTimeRoom(memory, window.fromTick, window.toTick) ?? roomNearTick(memory, focusTick) ?? m?.roomsAtStart[unit.id] ?? '?';

  if (unit.role === 'impostor') {
    const cached = bot.alibis[`${window.fromTick}-${window.toTick}`];
    if (cached) return cached;
    const myKill = memory.myKills.find((k) => k.tick >= window.fromTick && k.tick <= window.toTick);
    let alibi: Alibi;
    if (myKill && truthfulRoom === myKill.room) {
      // Swap the kill room for a room really visited in the window, preferring the one just before or after.
      const route = myRoute(memory, window.fromTick, window.toTick).map((v) => v.room);
      const others = route.filter((r) => r !== myKill.room && !r.startsWith('Corridor'));
      const idx = route.lastIndexOf(myKill.room);
      const before = idx > 0 ? route[idx - 1] : undefined;
      const after = idx >= 0 && idx + 1 < route.length ? route[idx + 1] : undefined;
      const pick = [before, after].find((r) => r && !r.startsWith('Corridor')) ?? others[others.length - 1] ?? nearestRoomName(state, unit) ?? truthfulRoom;
      alibi = { room: pick, truthful: pick === truthfulRoom, why: `killed ${victim?.name ?? 'someone'} in ${myKill.room} at ${clock(myKill.tick, config.tickRate)}; claiming ${pick} from my real route ${route.join(' → ') || '(none)'}` };
    } else {
      alibi = { room: truthfulRoom, truthful: true, why: 'no kill of mine in this window, so the truth is safe' };
    }
    bot.alibis[`${window.fromTick}-${window.toTick}`] = alibi;
    return alibi;
  }
  return { room: truthfulRoom, truthful: true, why: `I was in ${truthfulRoom} at ${clock(focusTick, config.tickRate)}` };
}

/** The room (never a corridor) the bot spent the most time in during a window, or null. */
export function mostTimeRoom(memory: BotMemory, fromTick: number, toTick: number): string | null {
  const time = new Map<string, number>();
  const route = myRoute(memory, fromTick, toTick);
  for (let i = 0; i < route.length; i++) {
    const v = route[i]!;
    if (v.room.startsWith('Corridor')) continue;
    const end = i + 1 < route.length ? route[i + 1]!.tick : toTick;
    time.set(v.room, (time.get(v.room) ?? 0) + Math.max(0, end - Math.max(v.tick, fromTick)));
  }
  let best: string | null = null;
  let bestTime = 0;
  for (const [room, t] of time) if (t > bestTime) { best = room; bestTime = t; }
  return best;
}

/** The room the bot was in at a tick; if it was in a corridor, the room it had just left or was about to enter. */
export function roomNearTick(memory: BotMemory, tick: number): string | null {
  const visits = memory.myRooms;
  let index = -1;
  for (let i = 0; i < visits.length; i++) if (visits[i]!.tick <= tick) index = i;
  if (index < 0) return null;
  const here = visits[index]!;
  if (!here.room.startsWith('Corridor')) return here.room;
  for (let i = index - 1; i >= 0; i--) if (!visits[i]!.room.startsWith('Corridor')) return visits[i]!.room;
  for (let i = index + 1; i < visits.length; i++) if (!visits[i]!.room.startsWith('Corridor')) return visits[i]!.room;
  return null;
}

function nearestRoomName(state: SimState, unit: Unit): string | undefined {
  void state;
  void unit;
  return undefined;
}

/** Everyone who has accused the unit in meetings so far, most accusations first. */
export function accusersOf(state: SimState, unitId: number, sinceMeeting = 0): { id: number; count: number }[] {
  const counts = new Map<number, number>();
  for (const c of state.claims as Claim[]) {
    if (c.kind !== 'accuse' || c.subjectId !== unitId || c.meetingIndex < sinceMeeting) continue;
    counts.set(c.speakerId, (counts.get(c.speakerId) ?? 0) + 1);
  }
  return [...counts.entries()].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count);
}

/** Who a bot would point at in chat, with the reason, or null if it has nothing worth saying. */
export function accusationTarget(bot: BotState, unit: Unit, state: SimState): { id: number; reason: string } | null {
  const p = personality(bot.personality);
  if (unit.role === 'impostor') {
    // Whoever is accusing me, else whoever I saw alone near the body's room; never my partner.
    const partners = new Set(state.units.filter((u) => u.role === 'impostor').map((u) => u.id));
    const loudest = accusersOf(state, unit.id, state.meetingsHeld).find((a) => !partners.has(a.id) && state.units[a.id]?.alive);
    if (loudest) return { id: loudest.id, reason: `${state.units[loudest.id]?.name} keeps accusing me` };
    const m = state.meeting;
    if (m?.bodyRoom) {
      const near = state.units.find((u) => u.alive && !partners.has(u.id) && u.id !== unit.id && bot.memory.sightings.some((s) => s.subjectId === u.id && s.aloneTicks > 30 && s.rooms.some((r) => r.room === m.bodyRoom) && s.endTick >= m.startedTick - 60 * 30));
      if (near) return { id: near.id, reason: `I saw ${near.name} alone near ${m.bodyRoom}` };
    }
    return null;
  }
  const top = topSuspect(bot.social, state, unit.id);
  if (!top || top.score < p.accuseThreshold) return null;
  const last = [...bot.social.evidence].reverse().find((e) => e.targetId === top.id && typeof e.change !== 'number' ? true : e.targetId === top.id && (e.change as number) > 0);
  return { id: top.id, reason: last?.reason ?? `suspicion ${Math.round(top.score)}` };
}

/** The strongest single piece of evidence a bot holds against a target, for wording choices. */
export function strongestEvidence(social: SocialModel, targetId: number): { kind: string; reason: string; detail?: { room?: string; tick?: number; otherRoom?: string } } | null {
  if (social.certain[targetId]) {
    const e = social.evidence.find((x) => x.targetId === targetId && x.change === 'certain');
    return e ? { kind: e.kind, reason: e.reason, detail: e.detail } : null;
  }
  let best: { kind: string; reason: string; change: number; detail?: { room?: string; tick?: number; otherRoom?: string } } | null = null;
  for (const e of social.evidence) {
    if (e.targetId !== targetId || typeof e.change !== 'number' || e.change <= 0) continue;
    if (!best || e.change > best.change) best = { kind: e.kind, reason: e.reason, change: e.change, detail: e.detail };
  }
  return best ? { kind: best.kind, reason: best.reason, detail: best.detail } : null;
}

export function suspicionSummary(social: SocialModel, state: SimState, selfId: number): string {
  return state.units
    .filter((u) => u.id !== selfId && u.alive)
    .map((u) => `${u.name} ${Math.round(suspicionOf(social, u.id))}`)
    .join(', ');
}
