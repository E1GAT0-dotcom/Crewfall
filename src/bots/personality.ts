// Personalities (SPEC 9.8) and the difficulty table (SPEC 9.12), read from config. Pure TypeScript.

import brainsJson from '../../config/brains.json';
import personalitiesJson from '../../config/personalities.json';
import type { Rng } from '../sim/rng';
import type { Difficulty } from '../sim/settings';

export type WhenAccused = 'counter' | 'route' | 'defer' | 'short' | 'overexplain' | 'joke';

export interface Personality {
  readonly id: string;
  readonly name: string;
  readonly messagesPerMeeting: number;
  readonly followMajority: number;
  readonly accuseThreshold: number;
  readonly voteThreshold: number;
  readonly reportDelaySec: number;
  readonly lookAroundFirst: boolean;
  readonly buddyChance: number;
  readonly whenAccused: WhenAccused;
  readonly playerAccusationScale: number;
  readonly killHesitationScale: number;
  readonly earlyMeetingCaution: number;
}

export const PERSONALITIES: readonly Personality[] = personalitiesJson.personalities as Personality[];

export function personality(id: string): Personality {
  const p = PERSONALITIES.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown personality "${id}".`);
  return p;
}

/** Deals personalities out so a game gets a mix: shuffle the table and cycle through it. */
export function assignPersonalities(count: number, rng: Rng): string[] {
  const order = rng.shuffle(PERSONALITIES.map((p) => p.id));
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    if (i % order.length === 0 && i > 0) {
      const again = rng.shuffle(order);
      order.splice(0, order.length, ...again);
    }
    out.push(order[i % order.length] as string);
  }
  return out;
}

export type ImpostorFaking = 'sloppy' | 'good' | 'perfect';
export type KillCaution = 'onlyAlone' | 'normal' | 'tracksWitnesses';
export type PlayerTargeting = 'random' | 'normal' | 'prioritize';

export interface DifficultyTable {
  readonly memoryAccuracy: number;
  readonly memorySpanMeetings: number | null;
  readonly impostorFaking: ImpostorFaking;
  readonly killCaution: KillCaution;
  /** Chance a bot bothers to check a claim against its memory. */
  readonly crossCheckClaims: number;
  readonly playerTargeting: PlayerTargeting;
  /** Chance a hard impostor reports its own kill. */
  readonly selfReportChance: number;
  /** Chance an easy impostor fakes a visual task anyway (SPEC 9.6). */
  readonly fakeVisualTaskChance: number;
}

export function difficultyTable(d: Difficulty): DifficultyTable {
  return brainsJson.difficulty[d] as DifficultyTable;
}
