// How bots vote (SPEC 9.11), with a written reason for F3. Pure TypeScript, seeded.
//   Crew: top suspect at or above the personality's threshold, else skip; followers go with the
//         crowd; analysts refuse weak evidence in the first meeting.
//   Impostor: never the partner; if the crowd is on me, my loudest accuser; otherwise join a
//         majority on a crew member, skip when the crew is thin, else a random crew member.
//   Anyone may change their vote once if new evidence arrives in chat.

import type { BotState } from './brain';
import { accusersOf } from './decisions';
import { personality } from './personality';
import { suspicionOf, topSuspect } from './suspicion';
import type { MeetingState, Vote } from '../sim/meeting';
import type { SimState, Unit } from '../sim/sim';

export interface VoteDecision {
  readonly vote: Vote;
  readonly reason: string;
}

/** The living target with the most votes so far, if at least two people agree. */
export function currentMajority(m: MeetingState, state: SimState): { id: number; count: number } | null {
  const counts = new Map<number, number>();
  for (const v of Object.values(m.votes)) if (v !== 'skip') counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: { id: number; count: number } | null = null;
  for (const [id, count] of counts) {
    if (!state.units[id]?.alive) continue;
    if (!best || count > best.count) best = { id, count };
  }
  return best && best.count >= 2 ? best : null;
}

export function decideVote(bot: BotState, unit: Unit, state: SimState): VoteDecision {
  const m = state.meeting;
  if (!m) return { vote: 'skip', reason: 'no meeting' };
  const p = personality(bot.personality);
  const name = (id: number) => state.units[id]?.name ?? '?';
  const majority = currentMajority(m, state);

  if (unit.role === 'impostor') {
    const partners = new Set(state.units.filter((u) => u.role === 'impostor' && u.id !== unit.id).map((u) => u.id));
    const livingCrew = state.units.filter((u) => u.alive && u.role === 'crew').length;
    const livingImps = state.units.filter((u) => u.alive && u.role === 'impostor').length;
    if (majority && majority.id === unit.id) {
      const loudest = accusersOf(state, unit.id, state.meetingsHeld).find((a) => state.units[a.id]?.alive && !partners.has(a.id));
      if (loudest) return { vote: loudest.id, reason: `the crowd is on me, so I vote my loudest accuser ${name(loudest.id)}` };
      const voter = Object.entries(m.votes).find(([, v]) => v === unit.id)?.[0];
      if (voter && !partners.has(Number(voter))) return { vote: Number(voter), reason: `the crowd is on me, so I vote back at ${name(Number(voter))}` };
    }
    if (majority && !partners.has(majority.id) && majority.id !== unit.id) {
      return { vote: majority.id, reason: `joining the majority on ${name(majority.id)} (${majority.count} votes) to blend in` };
    }
    // On hard, a doomed partner is not worth going down with: pile on if the crowd is already there.
    if (majority && partners.has(majority.id) && state.settings.difficulty === 'hard' && majority.count >= Math.ceil((livingCrew + livingImps) / 2)) {
      return { vote: majority.id, reason: `${name(majority.id)} is doomed; voting with the crowd keeps me clean` };
    }
    if (livingCrew <= livingImps + 2) return { vote: 'skip', reason: 'the crew is thin; a skip keeps the game going my way' };
    const crew = state.units.filter((u) => u.alive && u.role === 'crew' && u.id !== unit.id);
    if (crew.length === 0) return { vote: 'skip', reason: 'nobody to vote for' };
    const pick = state.rng.pick(crew);
    return { vote: pick.id, reason: `nothing points anywhere, so I vote ${pick.name} to keep the crew busy` };
  }

  const top = topSuspect(bot.social, state, unit.id);
  if (top && top.score >= p.voteThreshold) {
    if (state.meetingsHeld <= 1 && p.earlyMeetingCaution > 0 && top.score < p.earlyMeetingCaution) {
      return { vote: 'skip', reason: `first meeting and ${name(top.id)} is only at ${Math.round(top.score)}; not enough to vote on` };
    }
    const why = [...bot.social.evidence].reverse().find((e) => e.targetId === top.id && (e.change === 'certain' || (typeof e.change === 'number' && e.change > 0)));
    return { vote: top.id, reason: `${name(top.id)} at ${Math.round(top.score)}${why ? ': ' + why.reason : ''}` };
  }
  if (majority && majority.id !== unit.id && state.rng.chance(p.followMajority)) {
    return { vote: majority.id, reason: `my own top (${top ? `${name(top.id)} ${Math.round(top.score)}` : 'nobody'}) is below ${p.voteThreshold}, so I follow the majority on ${name(majority.id)}` };
  }
  return { vote: 'skip', reason: top ? `nobody above ${p.voteThreshold} (top: ${name(top.id)} ${Math.round(top.score)})` : 'no evidence against anyone' };
}

/**
 * After voting, a bot may switch once if a new top suspect has clearly overtaken its earlier pick.
 * Returns the new decision or null.
 */
export function reconsiderVote(bot: BotState, unit: Unit, state: SimState, current: Vote): VoteDecision | null {
  if (bot.voteChanged || unit.role === 'impostor') return null;
  const p = personality(bot.personality);
  const top = topSuspect(bot.social, state, unit.id);
  if (!top || top.id === current) return null;
  const currentScore = current === 'skip' ? 0 : suspicionOf(bot.social, current);
  if (top.score >= p.voteThreshold + 10 && top.score > currentScore + 15) {
    return { vote: top.id, reason: `changed my vote: ${state.units[top.id]?.name} jumped to ${Math.round(top.score)} during the meeting` };
  }
  return null;
}
