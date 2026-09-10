// Understands what the player types in a meeting (SPEC 9.10). Pure TypeScript.
// Recognises names and colours (fuzzy, case-insensitive), room names, and a handful of intents.
// Anything else is 'unknown' and only earns a shrug.

import type { GameMap } from '../sim/map';
import { COLORS, type SimState, type Unit } from '../sim/sim';

export type PlayerIntent = 'accuse' | 'alibi' | 'question' | 'with' | 'sighting' | 'skip' | 'unknown';

export interface ParsedMessage {
  readonly intent: PlayerIntent;
  /** The unit talked about (accused, questioned, seen, or with). */
  readonly targetId: number | null;
  readonly room: string | null;
  /** Words the parser used, for F3. */
  readonly why: string;
}

const ACCUSE_WORDS = /\b(sus|vent|vented|venting|kill|killed|killer|impostor|imposter|imp|vote|did it|liar|lying|lied|fake|faking|it's|its|is it)\b/;
const SKIP_WORDS = /\b(skip|no info|nothing|idk|no idea|dunno|no clue)\b/;
const WITH_WORDS = /\bwith\b/;
const SAW_WORDS = /\b(saw|seen|see)\b/;
const ALIBI_WORDS = /\b(i was|i'm|im|i am|i've been|ive been|been|was in|was at|i went|went to|doing tasks in)\b/;
const QUESTION_WORDS = /\b(where|what were you|what are you|explain|alibi)\b/;

export function parsePlayerMessage(text: string, state: SimState, map: GameMap): ParsedMessage {
  const raw = text.trim().toLowerCase().replace(/[^a-z0-9'?\s]/g, ' ').replace(/\s+/g, ' ');
  const words = raw.replace(/\?/g, ' ').trim().split(' ').filter(Boolean);
  const player = state.units[0] as Unit;
  const mentioned = findUnits(words, state, player.id);
  const room = findRoom(words, map);
  const target = mentioned[0] ?? null;
  const asksQuestion = raw.includes('?') || QUESTION_WORDS.test(raw);
  const mentionsMe = /\b(me|i|my|myself)\b/.test(raw);

  if (target && SAW_WORDS.test(raw) && room) return { intent: 'sighting', targetId: target.id, room, why: `saw + ${target.name} + ${room}` };
  if (target && WITH_WORDS.test(raw) && (mentionsMe || !room)) return { intent: 'with', targetId: target.id, room, why: `with + ${target.name}` };
  if (target && room && /\bwas (in|at)\b/.test(raw) && !mentionsMe) return { intent: 'sighting', targetId: target.id, room, why: `${target.name} was in ${room}` };
  if (target && ACCUSE_WORDS.test(raw) && !asksQuestion) return { intent: 'accuse', targetId: target.id, room, why: `${target.name} + accusing words` };
  if (target && asksQuestion) return { intent: 'question', targetId: target.id, room, why: `question aimed at ${target.name}` };
  if (target && ACCUSE_WORDS.test(raw)) return { intent: 'accuse', targetId: target.id, room, why: `${target.name} + accusing words` };
  if (room && (ALIBI_WORDS.test(raw) || words.length <= 2)) return { intent: 'alibi', targetId: null, room, why: `room ${room}${ALIBI_WORDS.test(raw) ? ' + i was' : ' alone'}` };
  if (SKIP_WORDS.test(raw) && !target) return { intent: 'skip', targetId: null, room: null, why: 'skip words' };
  if (target && words.length <= 3) return { intent: 'question', targetId: target.id, room, why: `just a name: ${target.name}` };
  return { intent: 'unknown', targetId: null, room, why: 'no name, room or known words' };
}

/** Units named in the words, by name or colour, fuzzy. Never the player. */
export function findUnits(words: readonly string[], state: SimState, excludeId = -1): Unit[] {
  const found: Unit[] = [];
  const candidates = state.units.filter((u) => u.id !== excludeId);
  for (const w of words) {
    if (w.length < 2) continue;
    for (const u of candidates) {
      if (found.includes(u)) continue;
      const name = u.name.toLowerCase();
      const colour = COLORS.find((c) => c.id === u.colorId)?.name.toLowerCase() ?? '';
      if (matches(w, name) || (colour && matches(w, colour))) found.push(u);
    }
  }
  return found;
}

/** A room named in the words, by full name or a unique prefix of 3+ letters. */
export function findRoom(words: readonly string[], map: GameMap): string | null {
  const rooms = map.rooms.map((r) => r.name);
  for (const w of words) {
    if (w.length < 2) continue;
    const exact = rooms.find((r) => r.toLowerCase() === w);
    if (exact) return exact;
    if (w.length >= 3) {
      const prefixed = rooms.filter((r) => r.toLowerCase().startsWith(w));
      if (prefixed.length === 1) return prefixed[0] as string;
    }
    if (w === 'cafe' || w === 'caf') return rooms.find((r) => r.toLowerCase().startsWith('cafe')) ?? null;
    if (w === 'elec' || w === 'elect') return rooms.find((r) => r.toLowerCase().startsWith('elec')) ?? null;
    if (w === 'nav') return rooms.find((r) => r.toLowerCase().startsWith('nav')) ?? null;
  }
  return null;
}

/** Exact, unique-ish prefix (2+ letters, at least half the name), or one typo for names of 4+. */
function matches(word: string, name: string): boolean {
  if (word === name) return true;
  if (word.length >= 2 && word.length >= Math.ceil(name.length / 2) && name.startsWith(word)) return true;
  if (name.length >= 4 && word.length >= 4 && editDistance(word, name) <= 1) return true;
  return false;
}

function editDistance(a: string, b: string): number {
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0] as number;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = dp[j] as number;
      dp[j] = Math.min((dp[j] as number) + 1, (dp[j - 1] as number) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = temp;
    }
  }
  return dp[b.length] as number;
}
