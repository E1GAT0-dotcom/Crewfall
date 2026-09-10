// What a bot says in a meeting (SPEC 9.9). Pure TypeScript, seeded.
//
// A bot speaks only from what it has: an unanswered question or accusation aimed at it, a
// contradiction it recorded, a suspect above its threshold (the strongest evidence picks the
// wording), a claim it can back up, or, failing all that, an opener, an unprompted alibi, a follow,
// a question to someone who has said nothing, or a skip. Every line that asserts a fact also
// becomes a claim, so the other bots can check it.

import { accusationTarget, buildAlibi, strongestEvidence } from '../bots/decisions';
import { alibiWindow, corroborates, type Claim } from '../bots/claims';
import type { BotState } from '../bots/brain';
import { clock } from '../bots/memory';
import { personality } from '../bots/personality';
import { topSuspect } from '../bots/suspicion';
import type { GameMap } from '../sim/map';
import type { MeetingState } from '../sim/meeting';
import type { SimConfig, SimState, Unit } from '../sim/sim';
import { pickVoiceLine, type Slots, type VoiceIntent } from './templates';

export type NewClaim = Omit<Claim, 'id' | 'tick' | 'meetingIndex'>;

export interface VoiceLine {
  readonly intent: VoiceIntent;
  readonly text: string;
  /** A fact asserted by the line, to broadcast. */
  readonly claim?: NewClaim;
  /** A question aimed at someone, who should answer. */
  readonly questionTo?: number;
  /** Plain-language note for F3 on why this line was chosen. */
  readonly why: string;
}

/** Per-meeting conversation memory (SPEC 9.9 "conversation state"). Lives on the meeting. */
export interface Conversation {
  accusations: { accuserId: number; targetId: number; tick: number; answered: boolean; deflected: boolean }[];
  questions: { askerId: number; targetId: number; tick: number; answered: boolean }[];
  /** Intents each unit has used this meeting. */
  spoken: Record<number, VoiceIntent[]>;
  alibiGiven: Record<number, boolean>;
  /** Targets each bot has already accused this meeting. */
  accusedBy: Record<number, number[]>;
  /** Claims each bot has already backed or contradicted aloud. */
  reactedClaims: Record<number, number[]>;
  reactedToResult: boolean;
}

export function createConversation(): Conversation {
  return { accusations: [], questions: [], spoken: {}, alibiGiven: {}, accusedBy: {}, reactedClaims: {}, reactedToResult: false };
}

/** How badly this bot needs the floor: answering beats accusing beats small talk. */
export function urgency(bot: BotState, unit: Unit, state: SimState, m: MeetingState): number {
  const c = m.convo;
  let u = 0;
  if (c.questions.some((q) => q.targetId === unit.id && !q.answered)) u += 10;
  if (c.accusations.some((a) => a.targetId === unit.id && !a.answered)) u += 10;
  if (unvoicedContradiction(bot, state, m)) u += 4;
  const target = accusationTarget(bot, unit, state);
  if (target && !(c.accusedBy[unit.id] ?? []).includes(target.id)) u += 3;
  return u;
}

/** Picks the bot's next line, or null if it has nothing worth saying right now. */
export function chooseLine(bot: BotState, unit: Unit, state: SimState, m: MeetingState, map: GameMap, config: SimConfig): VoiceLine | null {
  const style = bot.personality;
  const p = personality(style);
  const c = m.convo;
  const rng = state.rng;
  const used = new Set(m.usedTemplates);
  const name = (id: number) => state.units[id]?.name ?? '?';
  const victim = m.bodyOf !== null ? name(m.bodyOf) : undefined;
  const window = alibiWindow(state, config);
  const focusTick = window.toTick - Math.round((window.toTick - window.fromTick) / 2);
  const alibi = buildAlibi(bot, unit, state, window, config);
  const base: Slots = { name: unit.name, victim, caller: name(m.calledBy), room: alibi.room, time: clock(focusTick, config.tickRate) };
  const alibiClaim = (): NewClaim => ({ speakerId: unit.id, kind: 'alibi', subjectId: unit.id, room: alibi.room, otherId: null, fromTick: window.fromTick, toTick: window.toTick });
  const say = (intent: VoiceIntent, slots: Slots, extra: Partial<VoiceLine>, why: string): VoiceLine | null => {
    const text = pickVoiceLine(intent, style, slots, used, rng);
    if (!text) return null;
    m.usedTemplates = [...used];
    return { intent, text, why, ...extra };
  };

  // 1. Someone asked me where I was.
  const question = c.questions.find((q) => q.targetId === unit.id && !q.answered);
  if (question) {
    question.answered = true;
    c.alibiGiven[unit.id] = true;
    return say('alibi_answer', base, { claim: alibiClaim() }, `${name(question.askerId)} asked where I was; ${alibi.why}`);
  }

  // 2. Someone accused me: answer the way my personality does.
  const accusation = c.accusations.find((a) => a.targetId === unit.id && !a.answered);
  if (accusation) {
    const accuser = name(accusation.accuserId);
    if (p.whenAccused === 'joke' && !accusation.deflected) {
      accusation.deflected = true;
      return say('deflect', { ...base, accuser }, {}, `${accuser} accused me; a joke first, the alibi next`);
    }
    accusation.answered = true;
    c.alibiGiven[unit.id] = true;
    const extra: { claim?: NewClaim } = { claim: alibiClaim() };
    if (p.whenAccused === 'counter') {
      // Aggressive: the defence is an accusation of the accuser (never a partner).
      const partner = unit.role === 'impostor' && state.units[accusation.accuserId]?.role === 'impostor';
      if (!partner) {
        extra.claim = { speakerId: unit.id, kind: 'accuse', subjectId: accusation.accuserId, room: null, otherId: null, fromTick: window.fromTick, toTick: window.toTick };
        (c.accusedBy[unit.id] ??= []).push(accusation.accuserId);
      }
    }
    return say('defend', { ...base, accuser }, extra, `${accuser} accused me; reacting as ${p.whenAccused}; ${alibi.why}`);
  }

  // 3. I caught someone lying this meeting.
  const contra = unvoicedContradiction(bot, state, m);
  if (contra) {
    (c.reactedClaims[unit.id] ??= []).push(contra.claim.id);
    const speakerName = name(contra.claim.speakerId);
    const claim: NewClaim = { speakerId: unit.id, kind: 'sighting', subjectId: contra.claim.speakerId, room: contra.sawRoom, otherId: null, fromTick: contra.claim.fromTick, toTick: contra.claim.toTick };
    return say('contradict', { ...base, other: speakerName, room: contra.claim.room ?? '', other_room: contra.sawRoom, time: clock(contra.sawFrom, config.tickRate) }, { claim }, contra.why);
  }

  // 4. I have a suspect worth naming, worded by my strongest evidence.
  const target = accusationTarget(bot, unit, state);
  if (target && !(c.accusedBy[unit.id] ?? []).includes(target.id)) {
    const strongest = strongestEvidence(bot.social, target.id);
    const detail = strongest?.detail;
    let intent: VoiceIntent = 'accuse_other';
    const slots: Slots = { ...base, other: name(target.id) };
    const withDetail: Record<string, string> = {};
    if (strongest?.kind === 'witnessedKill') {
      intent = 'accuse_witnessed';
      if (detail?.room) withDetail.room = detail.room;
      if (detail?.tick !== undefined) withDetail.time = clock(detail.tick, config.tickRate);
    } else if (strongest?.kind === 'sawVent') {
      intent = 'accuse_vent';
      if (detail?.room) withDetail.room = detail.room;
      if (detail?.tick !== undefined) withDetail.time = clock(detail.tick, config.tickRate);
    } else if (strongest?.kind === 'leftBodyRoom') {
      intent = 'accuse_left';
      if (detail?.room) withDetail.room = detail.room;
      if (detail?.tick !== undefined) {
        withDetail.time = clock(detail.tick, config.tickRate);
        withDetail.ago = `${Math.max(1, Math.round((m.startedTick - detail.tick) / config.tickRate))} s`;
      }
    } else if (strongest?.kind === 'lastSeenWithVictim') {
      intent = 'accuse_lastwith';
      if (detail?.room) withDetail.room = detail.room;
      if (detail?.tick !== undefined) withDetail.time = clock(detail.tick, config.tickRate);
    } else if (strongest?.kind === 'contradiction' && detail?.room && detail.otherRoom) {
      intent = 'accuse_contra';
      withDetail.room = detail.room;
      withDetail.other_room = detail.otherRoom;
    }
    (c.accusedBy[unit.id] ??= []).push(target.id);
    const witnessed = intent === 'accuse_witnessed' || intent === 'accuse_vent';
    const claim: NewClaim = { speakerId: unit.id, kind: 'accuse', subjectId: target.id, room: null, otherId: null, fromTick: window.fromTick, toTick: window.toTick, witnessed };
    const line = say(intent, { ...slots, ...withDetail }, { claim }, `accusing ${name(target.id)}: ${target.reason}`);
    if (line) return line;
    return say('accuse_other', slots, { claim }, `accusing ${name(target.id)}: ${target.reason}`);
  }

  // 5. Someone's alibi matches what I saw.
  for (const claim of state.claims) {
    if (claim.meetingIndex !== state.meetingsHeld || claim.kind !== 'alibi' || claim.speakerId === unit.id || !claim.room) continue;
    if ((c.reactedClaims[unit.id] ?? []).includes(claim.id)) continue;
    if (!corroborates(unit.id, bot.memory, claim, state, map, config)) continue;
    (c.reactedClaims[unit.id] ??= []).push(claim.id);
    const seen: NewClaim = { speakerId: unit.id, kind: 'sighting', subjectId: claim.speakerId, room: claim.room, otherId: null, fromTick: claim.fromTick, toTick: claim.toTick };
    return say('corroborate', { ...base, other: name(claim.speakerId), room: claim.room, time: clock(claim.fromTick, config.tickRate) }, { claim: seen }, `I saw ${name(claim.speakerId)} in ${claim.room} too`);
  }

  // 6. Nothing pressing: an opener early on...
  const spoken = c.spoken[unit.id] ?? [];
  const elapsed = state.tick - m.startedTick;
  if (spoken.length === 0 && elapsed < config.tickRate * 10 && rng.chance(0.7)) {
    return say(m.reason === 'body' ? 'open_body' : 'open_button', base, {}, 'opening the meeting');
  }
  // ...my own alibi, unprompted...
  if (m.reason === 'body' && !c.alibiGiven[unit.id] && rng.chance(0.5)) {
    c.alibiGiven[unit.id] = true;
    return say('alibi', base, { claim: alibiClaim() }, alibi.why);
  }
  // ...following someone with evidence when I have none...
  if (m.stage === 'voting') {
    const top = topSuspect(bot.social, state, unit.id);
    const lead = c.accusations.filter((a) => a.accuserId !== unit.id && a.targetId !== unit.id && state.units[a.targetId]?.alive).at(-1);
    if (lead && (!top || top.score < p.voteThreshold) && rng.chance(p.followMajority) && !spoken.includes('follow')) {
      return say('follow', { ...base, other: name(lead.targetId), accuser: name(lead.accuserId) }, {}, `no suspect of my own; going with ${name(lead.accuserId)}`);
    }
  }
  // ...asking someone who has said nothing...
  const silent = state.units.filter((u) => u.alive && u.id !== unit.id && !c.alibiGiven[u.id] && !c.questions.some((q) => q.targetId === u.id));
  if (silent.length > 0 && rng.chance(0.5) && !spoken.includes('question')) {
    silent.sort((a, b) => (bot.social.suspicion[b.id] ?? 0) - (bot.social.suspicion[a.id] ?? 0));
    const ask = silent[0] as Unit;
    c.questions.push({ askerId: unit.id, targetId: ask.id, tick: state.tick, answered: false });
    return say('question', { ...base, other: ask.name }, { questionTo: ask.id }, `${ask.name} has not said where they were`);
  }
  // ...or a skip suggestion when voting with nobody to vote for.
  if (m.stage === 'voting' && !spoken.includes('skip')) {
    const top = topSuspect(bot.social, state, unit.id);
    if ((!top || top.score < p.voteThreshold) && rng.chance(0.6)) return say('skip', base, {}, 'nobody worth voting for');
  }
  return null;
}

/** A line for the result stage. */
export function reactionLine(bot: BotState, unit: Unit, state: SimState, m: MeetingState): VoiceLine | null {
  const r = m.result;
  if (!r) return null;
  const used = new Set(m.usedTemplates);
  let intent: VoiceIntent = 'react_noeject';
  let other = '';
  if (r.ejectedId !== null) {
    other = state.units[r.ejectedId]?.name ?? '?';
    intent = r.wasImpostor === false ? 'react_eject_wrong' : 'react_eject_right';
    if (r.wasImpostor === null) intent = state.rng.chance(0.5) ? 'react_eject_right' : 'react_noeject';
  }
  const text = pickVoiceLine(intent, bot.personality, { other }, used, state.rng);
  if (!text) return null;
  m.usedTemplates = [...used];
  return { intent, text, why: 'reacting to the result' };
}

/** A generic shrug at something the parser could not understand (SPEC 9.10). */
export function shrugLine(bot: BotState, state: SimState, m: MeetingState, other: string): VoiceLine | null {
  const used = new Set(m.usedTemplates);
  const text = pickVoiceLine('reply', bot.personality, { other }, used, state.rng);
  if (!text) return null;
  m.usedTemplates = [...used];
  return { intent: 'reply', text, why: 'did not understand the player' };
}

function unvoicedContradiction(bot: BotState, state: SimState, m: MeetingState): { claim: Claim; sawRoom: string; sawFrom: number; why: string } | null {
  const reacted = m.convo.reactedClaims[bot.unitId] ?? [];
  for (const c of bot.memory.contradictions) {
    if (reacted.includes(c.claimId)) continue;
    const claim = state.claims.find((x) => x.id === c.claimId);
    if (!claim || claim.meetingIndex !== state.meetingsHeld || !claim.room) continue;
    if (!state.units[claim.speakerId]?.alive) continue;
    return { claim, sawRoom: c.sawRoom, sawFrom: c.sawFrom, why: c.why };
  }
  return null;
}
