// Meetings: discussion, voting, the result, and the return to play (SPEC 4.4, 9.9, 9.11, 10).
// Pure TypeScript. Bot chat and votes here are the Phase 2 placeholders (generic lines, random
// votes); Phase 3 replaces the choices but keeps this flow and these data shapes.

import { alibiWindow, broadcastClaim } from '../bots/claims';
import type { BotState } from '../bots/brain';
import { closeAllSightings, pruneForMeeting } from '../bots/memory';
import { personality } from '../bots/personality';
import { decideVote, reconsiderVote } from '../bots/voting';
import { onEjectionResult, onMeetingStart } from '../bots/suspicion';
import { parsePlayerMessage } from '../chat/parser';
import { pickVoiceLine } from '../chat/templates';
import { chooseLine, createConversation, reactionLine, shrugLine, urgency, type Conversation, type VoiceLine } from '../chat/voice';
import type { GameMap } from './map';
import { unitRegionName, type PlayerInput, type SimConfig, type SimState, type Unit } from './sim';

/** The map of the meeting in progress, so chat helpers can check claims against it. */
let currentMap: GameMap | null = null;

export type MeetingReason = 'body' | 'button';
export type MeetingStage = 'discussion' | 'voting' | 'result';
export type Vote = number | 'skip';

export interface ChatMessage {
  readonly tick: number;
  readonly unitId: number;
  readonly text: string;
  /** The bot's intent behind the line (undefined for the player). */
  readonly intent?: string;
}

export interface MeetingResult {
  /** Who was ejected, or null for a skip or a tie. */
  readonly ejectedId: number | null;
  readonly tie: boolean;
  /** Only filled when the "confirm ejects" setting is on and someone was ejected. */
  readonly wasImpostor: boolean | null;
  /** Votes per target id (as a string key) plus "skip". */
  readonly tally: Readonly<Record<string, number>>;
}

export interface MeetingState {
  readonly calledBy: number;
  readonly reason: MeetingReason;
  /** Whose body was reported, or null for the emergency button. */
  readonly bodyOf: number | null;
  /** Room the body lay in, or null. */
  readonly bodyRoom: string | null;
  readonly startedTick: number;
  stage: MeetingStage;
  /** Tick at which the current stage ends. */
  stageEndsTick: number;
  /** Voter id -> vote. Only living units vote. */
  votes: Record<number, Vote>;
  chat: ChatMessage[];
  result: MeetingResult | null;
  /** Where everyone was when the meeting started, for alibis. */
  roomsAtStart: Record<number, string>;
  // --- bot scheduling (Phase 2) ---
  botVoteTicks: Record<number, number>;
  nextBotChatTick: number;
  botMessagesSent: Record<number, number>;
  usedTemplates: string[];
  pendingReplies: { tick: number; botId: number; toName: string; kind: 'shrug' | 'turn' }[];
  /** Who accused whom, who asked whom, who has spoken (SPEC 9.9 conversation state). */
  convo: Conversation;
  /** Ticks at which result-stage reactions are due. */
  reactionTicks: number[];
  /** What the parser made of the player's last line, for F3. */
  lastPlayerParse: string | null;
  /** Tick of the last bot line, so bot lines keep the minimum gap (SPEC 9.9). */
  lastBotLineTick: number;
}

export type MeetingEvent =
  | { kind: 'meetingStart'; calledBy: number; reason: MeetingReason; bodyOf: number | null }
  | { kind: 'meetingStage'; stage: MeetingStage }
  | { kind: 'chat'; unitId: number }
  | { kind: 'vote'; unitId: number }
  | { kind: 'ejected'; unitId: number | null; wasImpostor: boolean | null }
  | { kind: 'meetingEnd' };

/** Freezes everyone and opens a meeting. Bodies are removed (SPEC 4.4). */
export function startMeeting(state: SimState, calledBy: Unit, reason: MeetingReason, bodyOf: number | null, map: GameMap, config: SimConfig): void {
  const roomsAtStart: Record<number, string> = {};
  for (const u of state.units) roomsAtStart[u.id] = unitRegionName(u, map);
  const discussionTicks = Math.round(state.settings.discussionSec * config.tickRate);
  const [f0, f1] = pair(config.meeting.botChat.firstMessageDelaySec, 0.8, 2.5);
  const body = bodyOf !== null ? state.bodies.find((b) => b.unitId === bodyOf) : undefined;
  const bodyRoom = body ? map.regionAt(Math.floor(body.x / map.tileSize), Math.floor(body.y / map.tileSize))?.name ?? null : null;
  const meeting: MeetingState = {
    calledBy: calledBy.id,
    reason,
    bodyOf,
    bodyRoom,
    startedTick: state.tick,
    stage: 'discussion',
    stageEndsTick: state.tick + discussionTicks,
    votes: {},
    chat: [],
    result: null,
    roomsAtStart,
    botVoteTicks: {},
    nextBotChatTick: state.tick + Math.round(state.rng.range(f0, f1) * config.tickRate),
    botMessagesSent: {},
    usedTemplates: [],
    pendingReplies: [],
    convo: createConversation(),
    reactionTicks: [],
    lastPlayerParse: null,
    lastBotLineTick: -1000,
  };
  state.phase = 'meeting';
  state.meeting = meeting;
  state.meetingsHeld++;
  state.bodies = [];
  state.playerTask = null;
  for (const u of state.units) u.moving = false;
  // Bots drop whatever they were doing; they think afresh after the meeting. Their memories close
  // the current sightings and forget anything beyond the difficulty's span.
  for (const b of state.bots) {
    closeAllSightings(b.memory, config);
    pruneForMeeting(b.memory, state.tick, state.settings.difficulty);
    b.goal = { kind: 'idle' };
    b.path = [];
    b.pathIndex = 0;
    b.waitTicks = 0;
    b.actionTicks = 0;
    b.headX = 0;
    b.headY = 0;
    b.voteChanged = false;
    b.selfReportTick = 0;
  }
  state.events.push({ kind: 'meetingStart', calledBy: calledBy.id, reason, bodyOf });
  // Now that memories are closed, every bot weighs what it saw around the death (SPEC 9.7).
  onMeetingStart(state, map, config);
  if (discussionTicks <= 0) enterVoting(state, config);
}

/** One tick of a meeting: timers, player chat and vote, bot chat and votes, the result. */
export function stepMeeting(state: SimState, input: PlayerInput, map: GameMap, config: SimConfig): void {
  const m = state.meeting;
  if (!m) return;
  currentMap = map;
  const player = state.units[0] as Unit;

  // Player chat: anyone alive may talk during discussion and voting. What they say is parsed (SPEC 9.10).
  if (input.chatText && player.alive && m.stage !== 'result') {
    const text = input.chatText.trim().slice(0, 120);
    if (text.length > 0) {
      m.chat.push({ tick: state.tick, unitId: player.id, text });
      state.events.push({ kind: 'chat', unitId: player.id });
      handlePlayerLine(state, m, player, text, map, config);
    }
  }

  if (m.stage === 'discussion') {
    botChat(state, m, config);
    if (state.tick >= m.stageEndsTick) enterVoting(state, config);
    return;
  }

  if (m.stage === 'voting') {
    if (input.voteFor !== undefined && player.alive && validVote(state, player, input.voteFor)) {
      const changed = m.votes[player.id] !== input.voteFor;
      m.votes[player.id] = input.voteFor;
      if (changed) state.events.push({ kind: 'vote', unitId: player.id });
    }
    for (const bot of state.bots) {
      const u = state.units[bot.unitId] as Unit;
      if (!u.alive) continue;
      const at = m.botVoteTicks[u.id];
      if (m.votes[u.id] === undefined) {
        if (at !== undefined && state.tick >= at) castBotVote(state, m, u, config);
      } else if (!bot.voteChanged && state.tick % Math.round(config.tickRate / 2) === 0) {
        // New evidence in chat can turn one vote, once (SPEC 9.11).
        const change = reconsiderVote(bot, u, state, m.votes[u.id] as Vote);
        if (change) {
          m.votes[u.id] = change.vote;
          bot.voteChanged = true;
          bot.social.lastVoteReason = change.reason;
          state.events.push({ kind: 'vote', unitId: u.id });
        }
      }
    }
    botChat(state, m, config);
    const living = state.units.filter((u) => u.alive);
    const everyoneVoted = living.every((u) => m.votes[u.id] !== undefined);
    if (everyoneVoted || state.tick >= m.stageEndsTick) enterResult(state, config);
    return;
  }

  if (m.stage === 'result') {
    resultReactions(state, m, config);
    if (state.tick >= m.stageEndsTick) finishMeeting(state, map, config);
  }
}

function enterVoting(state: SimState, config: SimConfig): void {
  const m = state.meeting as MeetingState;
  m.stage = 'voting';
  const votingTicks = Math.max(1, Math.round(state.settings.votingSec * config.tickRate));
  m.stageEndsTick = state.tick + votingTicks;
  const [w0, w1] = pair(config.meeting.botVote.voteWindow, 0.1, 0.9);
  for (const bot of state.bots) {
    const u = state.units[bot.unitId] as Unit;
    if (!u.alive) continue;
    m.botVoteTicks[u.id] = state.tick + Math.round(state.rng.range(w0, w1) * votingTicks);
  }
  state.events.push({ kind: 'meetingStage', stage: 'voting' });
}

function enterResult(state: SimState, config: SimConfig): void {
  const m = state.meeting as MeetingState;
  m.stage = 'result';
  m.result = tallyVotes(state, m.votes);
  m.stageEndsTick = state.tick + Math.round(config.meeting.resultSec * config.tickRate);
  m.reactionTicks = [state.tick + Math.round(0.6 * config.tickRate), state.tick + Math.round(2.2 * config.tickRate)];
  state.events.push({ kind: 'meetingStage', stage: 'result' });
  state.events.push({ kind: 'ejected', unitId: m.result.ejectedId, wasImpostor: m.result.wasImpostor });
}

/** Most votes is ejected; a tie (including with skip) or a skip majority ejects nobody (SPEC 4.4). */
export function tallyVotes(state: SimState, votes: Readonly<Record<number, Vote>>): MeetingResult {
  const tally: Record<string, number> = {};
  for (const v of Object.values(votes)) {
    const key = String(v);
    tally[key] = (tally[key] ?? 0) + 1;
  }
  let best: string | null = null;
  let bestCount = 0;
  let tie = false;
  for (const [key, count] of Object.entries(tally)) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
      tie = false;
    } else if (count === bestCount && count > 0) {
      tie = true;
    }
  }
  if (best === null || tie || best === 'skip') return { ejectedId: null, tie, wasImpostor: null, tally };
  const ejectedId = Number(best);
  const unit = state.units[ejectedId];
  const wasImpostor = state.settings.confirmEjects && unit ? unit.role === 'impostor' : null;
  return { ejectedId, tie: false, wasImpostor, tally };
}

/** Applies the ejection, then sends everyone back to the ship. */
function finishMeeting(state: SimState, map: GameMap, config: SimConfig): void {
  const m = state.meeting as MeetingState;
  const ejected = m.result?.ejectedId ?? null;
  if (ejected !== null) {
    const u = state.units[ejected];
    if (u) {
      u.alive = false;
      u.ejected = true;
      u.deathTick = state.tick;
    }
    onEjectionResult(state, ejected, m.result?.wasImpostor ?? null, m.votes);
  }
  endMeeting(state, map, config);
}

/** Back to play: everyone returns to the spawn ring and kill cooldowns restart (SPEC 4.6). */
export function endMeeting(state: SimState, map: GameMap, config: SimConfig): void {
  state.phase = 'play';
  state.meeting = null;
  const half = map.tileSize / 2;
  state.units.forEach((u, i) => {
    const spawn = map.spawns[i % map.spawns.length];
    if (spawn) {
      u.x = spawn[0] * map.tileSize + half;
      u.y = spawn[1] * map.tileSize + half;
    }
    u.moving = false;
    if (u.role === 'impostor') u.killCooldownTicks = Math.round(config.rules.initialKillCooldownSec * config.tickRate);
  });
  state.events.push({ kind: 'meetingEnd' });
}

export function validVote(state: SimState, voter: Unit, vote: Vote): boolean {
  if (vote === 'skip') return true;
  const target = state.units[vote];
  return !!target && target.alive && target.id !== voter.id;
}

/** A bot votes for reasons (SPEC 9.11); the reason is kept for F3's "why I voted". */
function castBotVote(state: SimState, m: MeetingState, unit: Unit, config: SimConfig): void {
  const bot = state.bots.find((b) => b.unitId === unit.id);
  if (!bot) return;
  const decision = decideVote(bot, unit, state);
  m.votes[unit.id] = decision.vote;
  bot.social.lastVoteReason = decision.reason;
  state.events.push({ kind: 'vote', unitId: unit.id });
  announceVote(state, m, unit, bot);
}

/**
 * The turn scheduler (SPEC 9.9): at most one bot line every gap; bots with something urgent to say
 * (an answer, a defence) get the floor first; replies to the player come at their own time.
 */
function botChat(state: SimState, m: MeetingState, config: SimConfig): void {
  const rng = state.rng;
  const [g0, g1] = pair(config.meeting.botChat.gapSec, 1.5, 3);
  const minGap = Math.round(g0 * config.tickRate);
  if (state.tick - m.lastBotLineTick < minGap) return;
  const due = m.pendingReplies.filter((r) => state.tick >= r.tick);
  if (due.length > 0) {
    m.pendingReplies = m.pendingReplies.filter((r) => state.tick < r.tick);
    const reply = due[0] as { botId: number; toName: string; kind: 'shrug' | 'turn' };
    const unit = state.units[reply.botId];
    const bot = state.bots.find((b) => b.unitId === reply.botId);
    if (unit && bot && unit.alive) {
      const line = reply.kind === 'shrug' ? shrugLine(bot, state, m, reply.toName) : chooseLine(bot, unit, state, m, currentMap as GameMap, config);
      if (line) speak(state, m, unit, bot, line, config);
    }
    return;
  }
  if (state.tick < m.nextBotChatTick) return;
  const talkers = state.bots.filter((b) => {
    const u = state.units[b.unitId];
    return u && u.alive && (m.botMessagesSent[u.id] ?? 0) < messageCap(state, u.id, config);
  });
  if (talkers.length === 0) return;
  const weights = talkers.map((b) => 1 + urgency(b, state.units[b.unitId] as Unit, state, m));
  const bot = talkers[weightedIndex(rng, weights)] as (typeof talkers)[0];
  const unit = state.units[bot.unitId] as Unit;
  const line = currentMap ? chooseLine(bot, unit, state, m, currentMap, config) : null;
  if (line) {
    speak(state, m, unit, bot, line, config);
    m.nextBotChatTick = state.tick + Math.round(rng.range(g0, g1) * config.tickRate);
  } else {
    // Nothing to say: a short beat, then someone else may try.
    m.nextBotChatTick = state.tick + Math.round(g0 * config.tickRate * 0.5);
  }
}

/** Puts a chosen line into the chat and lets its claim or question take effect. */
function speak(state: SimState, m: MeetingState, unit: Unit, bot: BotState, line: VoiceLine, config: SimConfig): void {
  m.chat.push({ tick: state.tick, unitId: unit.id, text: line.text, intent: line.intent });
  m.lastBotLineTick = state.tick;
  m.botMessagesSent[unit.id] = (m.botMessagesSent[unit.id] ?? 0) + 1;
  (m.convo.spoken[unit.id] ??= []).push(line.intent);
  bot.lastIntent = `${line.intent}: ${line.why}`;
  state.events.push({ kind: 'chat', unitId: unit.id });
  if (line.claim && currentMap) {
    const claim = broadcastClaim(state, line.claim, currentMap, config);
    if (claim.kind === 'accuse') {
      m.convo.accusations.push({ accuserId: unit.id, targetId: claim.subjectId, tick: state.tick, answered: false, deflected: false });
      const target = state.units[claim.subjectId];
      if (target && !target.isPlayer && target.alive) scheduleTurn(state, m, claim.subjectId, config);
    }
  }
  if (line.questionTo !== undefined) {
    const target = state.units[line.questionTo];
    if (target && !target.isPlayer && target.alive) scheduleTurn(state, m, line.questionTo, config);
  }
}

/** A bot gets the floor within 2-5 s (to answer a question or an accusation). */
function scheduleTurn(state: SimState, m: MeetingState, botId: number, config: SimConfig): void {
  if (m.pendingReplies.some((r) => r.botId === botId)) return;
  const [d0, d1] = pair(config.meeting.botChat.replyDelaySec, 2, 5);
  m.pendingReplies.push({ tick: state.tick + Math.round(state.rng.range(d0, d1) * config.tickRate), botId, toName: '', kind: 'turn' });
}

/** The player's line, understood (SPEC 9.10): claims are broadcast, questions and accusations get answers, nonsense gets a shrug. */
function handlePlayerLine(state: SimState, m: MeetingState, player: Unit, text: string, map: GameMap, config: SimConfig): void {
  const parsed = parsePlayerMessage(text, state, map);
  m.lastPlayerParse = `${parsed.intent} (${parsed.why})`;
  const w = { fromTick: Math.max(0, m.startedTick - Math.round(45 * config.tickRate)), toTick: m.startedTick };
  const aw = alibiWindow(state, config);
  switch (parsed.intent) {
    case 'accuse': {
      const target = parsed.targetId as number;
      broadcastClaim(state, { speakerId: player.id, kind: 'accuse', subjectId: target, room: null, otherId: null, ...w }, map, config);
      m.convo.accusations.push({ accuserId: player.id, targetId: target, tick: state.tick, answered: false, deflected: false });
      if (state.units[target]?.alive) scheduleTurn(state, m, target, config);
      return;
    }
    case 'question': {
      const target = parsed.targetId as number;
      m.convo.questions.push({ askerId: player.id, targetId: target, tick: state.tick, answered: false });
      if (state.units[target]?.alive) scheduleTurn(state, m, target, config);
      return;
    }
    case 'alibi':
      m.convo.alibiGiven[player.id] = true;
      broadcastClaim(state, { speakerId: player.id, kind: 'alibi', subjectId: player.id, room: parsed.room, otherId: null, ...aw }, map, config);
      return;
    case 'sighting':
      broadcastClaim(state, { speakerId: player.id, kind: 'sighting', subjectId: parsed.targetId as number, room: parsed.room, otherId: null, ...aw }, map, config);
      return;
    case 'with':
      broadcastClaim(state, { speakerId: player.id, kind: 'with', subjectId: player.id, room: parsed.room, otherId: parsed.targetId as number, ...aw }, map, config);
      return;
    case 'skip':
      return;
    default: {
      // A shrug from one bot within 2-5 s.
      const bots = state.units.filter((u) => u.alive && !u.isPlayer);
      if (bots.length === 0) return;
      const [d0, d1] = pair(config.meeting.botChat.replyDelaySec, 2, 5);
      m.pendingReplies.push({ tick: state.tick + Math.round(state.rng.range(d0, d1) * config.tickRate), botId: state.rng.pick(bots).id, toName: player.name, kind: 'shrug' });
    }
  }
}

/** One or two bots react to the result. */
function resultReactions(state: SimState, m: MeetingState, config: SimConfig): void {
  while (m.reactionTicks.length > 0 && state.tick >= (m.reactionTicks[0] as number)) {
    m.reactionTicks.shift();
    const bots = state.bots.filter((b) => state.units[b.unitId]?.alive && b.unitId !== m.result?.ejectedId);
    if (bots.length === 0) return;
    const bot = state.rng.pick(bots);
    const unit = state.units[bot.unitId] as Unit;
    const line = reactionLine(bot, unit, state, m);
    if (line) {
      m.chat.push({ tick: state.tick, unitId: unit.id, text: line.text, intent: line.intent });
      m.lastBotLineTick = state.tick;
      bot.lastIntent = `${line.intent}: ${line.why}`;
      state.events.push({ kind: 'chat', unitId: unit.id });
    }
  }
  void config;
}

/** The "voted" announcement, from the bot's own voice. */
function announceVote(state: SimState, m: MeetingState, unit: Unit, bot: BotState): void {
  const used = new Set(m.usedTemplates);
  const text = pickVoiceLine('voted', bot.personality, {}, used, state.rng);
  if (!text) return;
  m.usedTemplates = [...used];
  m.chat.push({ tick: state.tick, unitId: unit.id, text, intent: 'voted' });
  state.events.push({ kind: 'chat', unitId: unit.id });
}

function weightedIndex(rng: { next(): number }, weights: readonly number[]): number {
  let total = 0;
  for (const w of weights) total += w;
  let r = rng.next() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i] as number;
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

/** How many lines a bot gets per meeting: its personality's talkativeness (SPEC 9.9). */
function messageCap(state: SimState, unitId: number, config: SimConfig): number {
  const bot = state.bots.find((b) => b.unitId === unitId);
  return bot ? personality(bot.personality).messagesPerMeeting : config.meeting.botChat.maxMessagesPerBot;
}

function pair(range: readonly number[] | undefined, a: number, b: number): [number, number] {
  return [range?.[0] ?? a, range?.[1] ?? b];
}
