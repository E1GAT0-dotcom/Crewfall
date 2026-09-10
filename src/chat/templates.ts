// Chat templates: picks a line for an intent and fills its slots. Pure TypeScript, seeded.
// Two sets: the Phase 2 generic lines (kept for the plain "reply" shrug) and the Phase 3 voices,
// one family of lines per personality style (SPEC 9.9).

import genericJson from './templates/generic.json';
import voiceJson from './templates/voice.json';
import type { Rng } from '../sim/rng';

export type Intent = 'open_body' | 'open_button' | 'alibi' | 'shrug' | 'skip' | 'reply' | 'voted';

export type VoiceIntent =
  | 'open_body'
  | 'open_button'
  | 'alibi'
  | 'alibi_answer'
  | 'accuse_witnessed'
  | 'accuse_left'
  | 'accuse_lastwith'
  | 'accuse_contra'
  | 'accuse_other'
  | 'corroborate'
  | 'contradict'
  | 'question'
  | 'defend'
  | 'deflect'
  | 'skip'
  | 'follow'
  | 'react_eject_right'
  | 'react_eject_wrong'
  | 'react_noeject'
  | 'reply'
  | 'voted';

export interface Slots {
  readonly name?: string;
  readonly room?: string;
  readonly other_room?: string;
  readonly victim?: string;
  readonly caller?: string;
  readonly other?: string;
  readonly accuser?: string;
  readonly time?: string;
  readonly ago?: string;
}

const INTENTS: Readonly<Record<Intent, readonly string[]>> = genericJson.intents;
const VOICES = voiceJson.intents as Readonly<Record<VoiceIntent, Readonly<Record<string, readonly string[]>>>>;

export function templatesFor(intent: Intent): readonly string[] {
  return INTENTS[intent] ?? [];
}

/** Lines for an intent in one personality style; falls back to any style if that one is missing. */
export function voiceLines(intent: VoiceIntent, style: string): readonly string[] {
  const family = VOICES[intent];
  if (!family) return [];
  return family[style] ?? Object.values(family)[0] ?? [];
}

export const VOICE_STYLES: readonly string[] = Object.keys(VOICES.alibi);

/** Replaces {slot} markers. Unknown or missing slots become an empty string and stray spaces are tidied. */
export function fillTemplate(template: string, slots: Slots): string {
  return template
    .replace(/\{(\w+)\}/g, (_, key: string) => (slots as Record<string, string | undefined>)[key] ?? '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,!?])/g, '$1')
    .trim();
}

/**
 * Picks a line for the intent that has not been used yet (by raw template), fills it, and records it.
 * Returns null when every variant has been used or a needed slot is missing.
 */
export function pickLine(intent: Intent, slots: Slots, used: Set<string>, rng: Rng): string | null {
  return pickFrom(templatesFor(intent), slots, used, rng);
}

/** Same, from a personality's voice; if that style is exhausted, borrows from another style. */
export function pickVoiceLine(intent: VoiceIntent, style: string, slots: Slots, used: Set<string>, rng: Rng): string | null {
  const own = pickFrom(voiceLines(intent, style), slots, used, rng);
  if (own) return own;
  for (const other of VOICE_STYLES) {
    if (other === style) continue;
    const borrowed = pickFrom(voiceLines(intent, other), slots, used, rng);
    if (borrowed) return borrowed;
  }
  return null;
}

function pickFrom(lines: readonly string[], slots: Slots, used: Set<string>, rng: Rng): string | null {
  const candidates = lines.filter((t) => !used.has(t) && hasSlots(t, slots));
  if (candidates.length === 0) return null;
  const template = rng.pick(candidates);
  used.add(template);
  return fillTemplate(template, slots);
}

function hasSlots(template: string, slots: Slots): boolean {
  const needed = template.match(/\{(\w+)\}/g) ?? [];
  return needed.every((m) => {
    const key = m.slice(1, -1) as keyof Slots;
    return typeof slots[key] === 'string' && (slots[key] as string).length > 0;
  });
}
