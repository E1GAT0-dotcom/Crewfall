// The social model (SPEC 9.7): suspicion 0-100 and trust 0-1 that each bot holds about everyone
// else, moved only by evidence the bot actually has. Every change is logged with a plain-language
// reason, so F3 and "why I voted" can explain any decision. Pure TypeScript, seeded where random.

import suspicionJson from '../../config/suspicion.json';
import type { GameMap } from '../sim/map';
import type { SimConfig, SimState, Unit } from '../sim/sim';
import type { Claim, Contradiction } from './claims';
import { clock, recall, sightingsOf, type BotMemory, type Sighting } from './memory';

export const SUSPICION = suspicionJson;

export type EvidenceKind = keyof typeof suspicionJson.weights;

export interface EvidenceRecord {
  readonly tick: number;
  readonly targetId: number;
  readonly kind: EvidenceKind;
  /** The change applied (0 when locked), or the lock that was set. */
  readonly change: number | 'certain' | 'cleared';
  readonly reason: string;
  /** Structured bits of the reason, for choosing chat wording. */
  readonly detail?: { room?: string; tick?: number; otherRoom?: string };
}

export interface SocialModel {
  suspicion: Record<number, number>;
  trust: Record<number, number>;
  /** Targets locked at 100 (witnessed kill or vent). */
  certain: Record<number, boolean>;
  /** Targets locked at 0 (seen doing a visual task). */
  cleared: Record<number, boolean>;
  evidence: EvidenceRecord[];
  /** How many witnessed kills / vent uses have already been turned into evidence. */
  killsProcessed: number;
  ventsProcessed: number;
  /** Last tick each target was flagged for shadowing, for the rearm delay. */
  shadowFlaggedTick: Record<number, number>;
  /** Filled by the voting logic (step 3). */
  lastVoteReason: string | null;
}

export function createSocial(): SocialModel {
  return { suspicion: {}, trust: {}, certain: {}, cleared: {}, evidence: [], killsProcessed: 0, ventsProcessed: 0, shadowFlaggedTick: {}, lastVoteReason: null };
}

export function suspicionOf(social: SocialModel, targetId: number): number {
  return social.suspicion[targetId] ?? 0;
}

export function trustIn(social: SocialModel, otherId: number): number {
  return social.trust[otherId] ?? SUSPICION.trust.start;
}

/** Applies one piece of evidence and logs it. Locks (certain / cleared) win over ordinary changes. */
export function addEvidence(social: SocialModel, targetId: number, kind: EvidenceKind, reason: string, tick: number, scale = 1, detail?: { room?: string; tick?: number; otherRoom?: string }): void {
  const weight = SUSPICION.weights[kind] as number | 'certain' | 'cleared';
  let change: number | 'certain' | 'cleared';
  if (weight === 'certain') {
    social.certain[targetId] = true;
    social.suspicion[targetId] = 100;
    change = 'certain';
  } else if (weight === 'cleared') {
    if (social.certain[targetId]) return; // a witnessed kill is not undone by a task
    social.cleared[targetId] = true;
    social.suspicion[targetId] = 0;
    change = 'cleared';
  } else {
    if (social.certain[targetId] || social.cleared[targetId]) change = 0;
    else {
      change = weight * scale;
      social.suspicion[targetId] = clamp(suspicionOf(social, targetId) + change, 0, 100);
    }
  }
  social.evidence.push(detail ? { tick, targetId, kind, change, reason, detail } : { tick, targetId, kind, change, reason });
  if (social.evidence.length > SUSPICION.evidenceLogMax) social.evidence.splice(0, social.evidence.length - SUSPICION.evidenceLogMax);
}

export function adjustTrust(social: SocialModel, otherId: number, delta: number): void {
  social.trust[otherId] = clamp(trustIn(social, otherId) + delta, 0, 1);
}

/** The living unit this bot suspects most, or null if nobody stands out above zero. */
export function topSuspect(social: SocialModel, state: SimState, selfId: number): { id: number; score: number } | null {
  let best: { id: number; score: number } | null = null;
  for (const u of state.units) {
    if (u.id === selfId || !u.alive) continue;
    const score = suspicionOf(social, u.id);
    if (score > 0 && (!best || score > best.score)) best = { id: u.id, score };
  }
  return best;
}

// ---------- during play ----------

/** Each tick: turn newly witnessed kills into certainty, and notice anyone shadowing me. */
export function tickSocial(social: SocialModel, memory: BotMemory, me: Unit, state: SimState, map: GameMap, config: SimConfig): void {
  const rate = config.tickRate;
  for (; social.killsProcessed < memory.kills.length; social.killsProcessed++) {
    const k = memory.kills[social.killsProcessed]!;
    const killer = state.units[k.killerId]?.name ?? '?';
    const victim = state.units[k.victimId]?.name ?? '?';
    addEvidence(social, k.killerId, 'witnessedKill', `I saw ${killer} kill ${victim} in ${k.room} at ${clock(k.tick, rate)}`, state.tick, 1, { room: k.room, tick: k.tick });
  }
  for (; social.ventsProcessed < memory.vents.length; social.ventsProcessed++) {
    const v = memory.vents[social.ventsProcessed]!;
    const who = state.units[v.unitId]?.name ?? '?';
    const how = v.action === 'enter' ? 'climb into' : 'climb out of';
    addEvidence(social, v.unitId, 'sawVent', `I saw ${who} ${how} a vent in ${v.room} at ${clock(v.tick, rate)}`, state.tick, 1, { room: v.room, tick: v.tick });
  }
  const w = SUSPICION.windows;
  const shadowTicks = Math.round(w.shadowSec * rate);
  const rearm = Math.round(w.shadowRearmSec * rate);
  for (const s of Object.values(memory.open)) {
    const run = s.nearMe[s.nearMe.length - 1];
    if (!run || run.to !== state.tick) continue;
    if (run.to - run.from + 1 < shadowTicks) continue;
    const last = social.shadowFlaggedTick[s.subjectId];
    if (last !== undefined && state.tick - last < rearm) continue;
    // Standing together at a task is not shadowing; only being followed around is.
    if (s.taskTicks > shadowTicks / 2) continue;
    social.shadowFlaggedTick[s.subjectId] = state.tick;
    const name = state.units[s.subjectId]?.name ?? '?';
    addEvidence(social, s.subjectId, 'shadowing', `${name} has been shadowing me for ${Math.round((run.to - run.from + 1) / rate)} s`, state.tick);
  }
  void map;
}

// ---------- at a meeting ----------

/** Meeting start: decay, then (for a body report) weigh what everyone was seen doing around the death. */
export function onMeetingStart(state: SimState, map: GameMap, config: SimConfig): void {
  const m = state.meeting;
  if (!m) return;
  const rate = config.tickRate;
  const w = SUSPICION.windows;
  const victim = m.bodyOf !== null ? state.units[m.bodyOf] : null;
  const reporter = state.units[m.calledBy];
  const bodyRoom = m.bodyRoom;

  for (const bot of state.bots) {
    const me = state.units[bot.unitId];
    if (!me || !me.alive) continue;
    const social = bot.social;
    const memory = bot.memory;

    // Non-certain suspicion fades a little every meeting.
    for (const key of Object.keys(social.suspicion)) {
      const id = Number(key);
      if (social.certain[id] || social.cleared[id] || suspicionOf(social, id) <= 0) continue;
      addEvidence(social, id, 'decayPerMeeting', 'time passed without new evidence', state.tick);
    }

    if (!victim || m.reason !== 'body') continue;
    const reportTick = m.startedTick;
    const deathTick = victim.deathTick ?? reportTick;

    // Self-report: the reporter found the body awfully conveniently.
    if (reporter && reporter.id !== me.id && reporter.alive) {
      addEvidence(social, reporter.id, 'selfReport', `${reporter.name} reported ${victim.name}'s body themselves`, state.tick);
    }

    // Who was last seen with the victim?
    const victimSightings = sightingsOf(memory, victim.id, 0, reportTick).filter((s) => s.endTick <= reportTick);
    const lastSeen = victimSightings[0];
    if (lastSeen && reportTick - lastSeen.endTick <= w.lastSeenWithSec * rate) {
      const room = recall(me.id, lastSeen, lastSeen.rooms[lastSeen.rooms.length - 1]!.room, state.settings.difficulty, map, config).room;
      for (const cid of lastSeen.companions) {
        if (cid === me.id) continue;
        const c = state.units[cid];
        if (!c || !c.alive) continue;
        addEvidence(social, cid, 'lastSeenWithVictim', `${c.name} was the last one I saw with ${victim.name}, in ${room} at ${clock(lastSeen.endTick, rate)}`, state.tick, 1, { room, tick: lastSeen.endTick });
      }
    }

    for (const target of state.units) {
      if (target.id === me.id || !target.alive) continue;
      // Seen leaving the body's room shortly before the report.
      if (bodyRoom) {
        const from = reportTick - Math.round(w.bodyRoomLeaveSec * rate);
        for (const s of sightingsOf(memory, target.id, from, reportTick)) {
          const leaveTick = leftRoomAt(me.id, s, bodyRoom, state, map, config);
          if (leaveTick !== null && leaveTick >= from && leaveTick <= reportTick) {
            addEvidence(social, target.id, 'leftBodyRoom', `${target.name} left ${bodyRoom} at ${clock(leaveTick, rate)}, ${Math.round((reportTick - leaveTick) / rate)} s before the report`, state.tick, 1, { room: bodyRoom, tick: leaveTick });
            break;
          }
        }
      }
      // Continuously with me around the moment of the kill: could not have done it.
      const slack = Math.round(w.killSlackSec * rate);
      const ws = Math.max(0, deathTick - slack);
      const we = Math.min(reportTick, deathTick + slack);
      if (we > ws && withMeThroughout(memory, target.id, ws, we)) {
        addEvidence(social, target.id, 'withMeDuringKill', `${target.name} was with me when ${victim.name} died`, state.tick);
      }
    }
  }
}

/** When a claim has been checked against this bot's memory: contradiction raises suspicion and lowers trust; a match raises trust. */
export function onClaimChecked(social: SocialModel, claim: Claim, contradiction: Contradiction | null, corroborated: boolean, state: SimState): void {
  if (contradiction) {
    addEvidence(social, claim.speakerId, 'contradiction', contradiction.why, state.tick, 1, { room: claim.room ?? undefined, otherRoom: contradiction.sawRoom, tick: contradiction.sawFrom });
    adjustTrust(social, claim.speakerId, SUSPICION.trust.contradicted);
  } else if (corroborated) {
    adjustTrust(social, claim.speakerId, SUSPICION.trust.corroborated);
  }
}

/**
 * Someone accused someone: bots weigh it by how much they trust the accuser (the player has a fixed
 * weight). A bot saying it watched the deed (a kill, a vent) counts for far more than a hunch.
 */
export function onAccusation(social: SocialModel, meId: number, accuser: Unit, targetId: number, state: SimState, playerScale = 1, witnessed = false): void {
  if (accuser.id === meId || targetId === meId) return;
  const target = state.units[targetId];
  if (!target) return;
  if (accuser.isPlayer) {
    addEvidence(social, targetId, 'accusedByPlayer', `${accuser.name} accused ${target.name}`, state.tick, playerScale);
  } else if (witnessed) {
    const t = trustIn(social, accuser.id);
    addEvidence(social, targetId, 'accusedByWitness', `${accuser.name} says they saw ${target.name} do it (I trust ${accuser.name} ${Math.round(t * 100)}%)`, state.tick, t);
  } else {
    const t = trustIn(social, accuser.id);
    addEvidence(social, targetId, 'accusedByTrustedBot', `${accuser.name} accused ${target.name} (I trust ${accuser.name} ${Math.round(t * 100)}%)`, state.tick, t);
  }
}

/** After an ejection: a confirmed crewmate makes everyone who voted them out look worse. */
export function onEjectionResult(state: SimState, ejectedId: number, wasImpostor: boolean | null, votes: Readonly<Record<number, number | 'skip'>>): void {
  const ejected = state.units[ejectedId];
  if (!ejected) return;
  for (const bot of state.bots) {
    const me = state.units[bot.unitId];
    if (!me || !me.alive) continue;
    const social = bot.social;
    if (wasImpostor === false) {
      for (const [voterKey, v] of Object.entries(votes)) {
        const voterId = Number(voterKey);
        if (v !== ejectedId || voterId === me.id) continue;
        const voter = state.units[voterId];
        if (!voter || !voter.alive) continue;
        addEvidence(social, voterId, 'votedOutCrew', `${voter.name} voted out ${ejected.name}, who was crew`, state.tick);
      }
    }
    // The ejected one is out of play either way.
    delete social.suspicion[ejectedId];
  }
}

// ---------- F3 ----------

export function describeSocial(social: SocialModel, state: SimState, selfId: number, rate: number): string[] {
  const lines: string[] = [];
  const rows = state.units
    .filter((u) => u.id !== selfId)
    .map((u) => ({ u, s: suspicionOf(social, u.id), t: trustIn(social, u.id) }))
    .sort((a, b) => b.s - a.s);
  lines.push('suspicion: ' + rows.map((r) => `${r.u.name}${r.u.alive ? '' : '†'} ${Math.round(r.s)}${social.certain[r.u.id] ? '!' : ''}${social.cleared[r.u.id] ? '~' : ''}`).join('  '));
  lines.push('trust: ' + rows.map((r) => `${r.u.name} ${Math.round(r.t * 100)}%`).join('  '));
  const recent = social.evidence.slice(-5).reverse();
  for (const e of recent) {
    const change = typeof e.change === 'number' ? (e.change >= 0 ? '+' : '') + Math.round(e.change) : e.change.toUpperCase();
    lines.push(`  ${clock(e.tick, rate)} ${state.units[e.targetId]?.name ?? '?'} ${change}: ${e.reason}`);
  }
  return lines;
}

// ---------- helpers ----------

/** The tick at which the subject was seen leaving the given room during this sighting, or null. */
function leftRoomAt(meId: number, s: Sighting, room: string, state: SimState, map: GameMap, config: SimConfig): number | null {
  for (let i = 0; i < s.rooms.length; i++) {
    const visit = s.rooms[i]!;
    const remembered = recall(meId, s, visit.room, state.settings.difficulty, map, config).room;
    if (remembered !== room) continue;
    const next = s.rooms[i + 1];
    if (next) return next.tick;
    // Last room of the stretch: they left my sight while still in it, which is not "leaving the room".
  }
  return null;
}

/** True if one sighting of the target shows them within arm's reach of me for the whole window. */
function withMeThroughout(memory: BotMemory, targetId: number, from: number, to: number): boolean {
  for (const s of sightingsOf(memory, targetId, from, to)) {
    if (s.startTick > from || s.endTick < to) continue;
    if (s.nearMe.some((run) => run.from <= from && run.to >= to)) return true;
  }
  return false;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
