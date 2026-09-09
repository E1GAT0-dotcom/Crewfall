// Chat templates: picks a line for an intent and fills its slots. Pure TypeScript, seeded.
// Phase 2 uses the generic set only; Phase 3 adds per-personality families (SPEC 9.9).

import genericJson from './templates/generic.json';
import type { Rng } from '../sim/rng';

export type Intent = 'open_body' | 'open_button' | 'alibi' | 'shrug' | 'skip' | 'reply' | 'voted';

export interface Slots {
  readonly name?: string;
  readonly room?: string;
  readonly victim?: string;
  readonly caller?: string;
  readonly other?: string;
}

const INTENTS: Readonly<Record<Intent, readonly string[]>> = genericJson.intents;

export function templatesFor(intent: Intent): readonly string[] {
  return INTENTS[intent] ?? [];
}

/** Replaces {slot} markers. Unknown or missing slots become an empty string and stray spaces are tidied. */
export function fillTemplate(template: string, slots: Slots): string {
  return template
    .replace(/\{(\w+)\}/g, (_, key: string) => (slots as Record<string, string | undefined>)[key] ?? '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Picks a line for the intent that has not been used yet (by raw template), fills it, and records it.
 * Returns null when every variant has been used or a needed slot is missing.
 */
export function pickLine(intent: Intent, slots: Slots, used: Set<string>, rng: Rng): string | null {
  const candidates = templatesFor(intent).filter((t) => !used.has(t) && hasSlots(t, slots));
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
