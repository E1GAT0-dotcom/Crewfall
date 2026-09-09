// Claims and contradictions (SPEC 9.4). Pure TypeScript.
//
// Everything said in a meeting that asserts a fact is stored as a claim: "I was in Medbay",
// "I saw Trix in Electrical", "Pru was with me". Claims are public: every living bot hears them.
// Each bot compares a claim with its own sightings; a clash is a contradiction, which is both
// evidence (SPEC 9.7) and something to say (SPEC 9.9).

import type { GameMap } from '../sim/map';
import type { Difficulty } from '../sim/settings';
import type { SimConfig, SimState } from '../sim/sim';
import { BRAINS, recall, sightingsOf, type BotMemory } from './memory';

export type ClaimKind =
  /** "I was in {room}" (about the speaker, over the claim window). */
  | 'alibi'
  /** "I saw {subject} in {room}". */
  | 'sighting'
  /** "{other} was with me" (both over the claim window). */
  | 'with'
  /** "It was {subject}" / "vote {subject}". Not checkable, but recorded. */
  | 'accuse';

export interface Claim {
  readonly id: number;
  readonly tick: number;
  readonly meetingIndex: number;
  readonly speakerId: number;
  readonly kind: ClaimKind;
  /** Who the claim is about: the speaker for alibi/with, the named unit for sighting/accuse. */
  readonly subjectId: number;
  readonly room: string | null;
  /** For 'with': the companion. */
  readonly otherId: number | null;
  /** The time the claim covers. */
  readonly fromTick: number;
  readonly toTick: number;
}

export interface Contradiction {
  readonly claimId: number;
  readonly speakerId: number;
  /** The bot's own recollection that clashes. */
  readonly sawRoom: string;
  readonly sawFrom: number;
  readonly sawTo: number;
  readonly why: string;
}

/** The window an alibi covers: the stretch before the meeting started. */
export function claimWindow(state: SimState, config: SimConfig): { fromTick: number; toTick: number } {
  const start = state.meeting?.startedTick ?? state.tick;
  return { fromTick: Math.max(0, start - Math.round(BRAINS.claims.windowSec * config.tickRate)), toTick: start };
}

/** Records a claim so every bot can check it. Returns it. */
export function addClaim(state: SimState, claim: Omit<Claim, 'id' | 'tick' | 'meetingIndex'>): Claim {
  const full: Claim = { ...claim, id: state.claims.length + 1, tick: state.tick, meetingIndex: state.meetingsHeld };
  state.claims.push(full);
  return full;
}

/**
 * Checks one claim against one bot's memory. Returns the contradiction if the bot's own (recalled)
 * sightings clash with it for long enough, otherwise null. A bot never contradicts itself.
 */
export function findContradiction(botId: number, memory: BotMemory, claim: Claim, state: SimState, map: GameMap, config: SimConfig): Contradiction | null {
  if (claim.speakerId === botId) return null;
  const difficulty: Difficulty = state.settings.difficulty;
  const minTicks = Math.round(BRAINS.claims.contradictionMinSec * config.tickRate);
  const subjectName = (id: number) => state.units[id]?.name ?? '?';

  if (claim.kind === 'alibi' || claim.kind === 'sighting') {
    if (!claim.room) return null;
    for (const s of sightingsOf(memory, claim.subjectId, claim.fromTick, claim.toTick)) {
      // Walk the subject's room visits during the overlap; any stretch in a different room long enough clashes.
      for (let i = 0; i < s.rooms.length; i++) {
        const visit = s.rooms[i]!;
        const visitEnd = i + 1 < s.rooms.length ? (s.rooms[i + 1]!.tick) : s.endTick;
        const from = Math.max(visit.tick, claim.fromTick);
        const to = Math.min(visitEnd, claim.toTick);
        if (to - from < minTicks) continue;
        const remembered = recall(botId, s, visit.room, difficulty, map, config);
        if (remembered.room === claim.room) continue;
        return {
          claimId: claim.id,
          speakerId: claim.speakerId,
          sawRoom: remembered.room,
          sawFrom: from,
          sawTo: to,
          why: claim.kind === 'alibi' ? `${subjectName(claim.speakerId)} says ${claim.room} but I saw them in ${remembered.room}` : `${subjectName(claim.speakerId)} says ${subjectName(claim.subjectId)} was in ${claim.room} but I saw ${subjectName(claim.subjectId)} in ${remembered.room}`,
        };
      }
    }
    return null;
  }

  if (claim.kind === 'with' && claim.otherId !== null) {
    // "X was with me": if I watched the speaker long enough without X near them, that clashes.
    for (const s of sightingsOf(memory, claim.speakerId, claim.fromTick, claim.toTick)) {
      const from = Math.max(s.startTick, claim.fromTick);
      const to = Math.min(s.endTick, claim.toTick);
      if (to - from < minTicks * 2) continue;
      if (s.companions.includes(claim.otherId)) continue;
      const room = s.rooms[s.rooms.length - 1]!.room;
      return {
        claimId: claim.id,
        speakerId: claim.speakerId,
        sawRoom: room,
        sawFrom: from,
        sawTo: to,
        why: `${subjectName(claim.speakerId)} says ${subjectName(claim.otherId)} was with them but I saw ${subjectName(claim.speakerId)} in ${room} without ${subjectName(claim.otherId)}`,
      };
    }
  }
  return null;
}

/** Records a claim and lets every living bot check it against its own memory. */
export function broadcastClaim(state: SimState, claim: Omit<Claim, 'id' | 'tick' | 'meetingIndex'>, map: GameMap, config: SimConfig): Claim {
  const full = addClaim(state, claim);
  for (const bot of state.bots) {
    const unit = state.units[bot.unitId];
    if (!unit || !unit.alive) continue;
    const c = findContradiction(unit.id, bot.memory, full, state, map, config);
    if (c) bot.memory.contradictions.push(c);
  }
  return full;
}

/** True when the bot's own memory backs the claim up (same room during the window). */
export function corroborates(botId: number, memory: BotMemory, claim: Claim, state: SimState, map: GameMap, config: SimConfig): boolean {
  if (claim.speakerId === botId || !claim.room) return false;
  const minTicks = Math.round(BRAINS.claims.contradictionMinSec * config.tickRate);
  for (const s of sightingsOf(memory, claim.subjectId, claim.fromTick, claim.toTick)) {
    for (let i = 0; i < s.rooms.length; i++) {
      const visit = s.rooms[i]!;
      const visitEnd = i + 1 < s.rooms.length ? (s.rooms[i + 1]!.tick) : s.endTick;
      const from = Math.max(visit.tick, claim.fromTick);
      const to = Math.min(visitEnd, claim.toTick);
      if (to - from < minTicks) continue;
      if (recall(botId, s, visit.room, state.settings.difficulty, map, config).room === claim.room) return true;
    }
  }
  return false;
}
