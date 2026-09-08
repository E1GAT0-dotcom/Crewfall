// Remembers the lobby settings between launches using the browser's own storage.
// Not a save system: nothing about a game in progress is stored (DECISIONS 2026-09-07).
// The pure parse/serialize functions are unit-tested; the storage calls are thin wrappers.

import { defaultSettings, type GameSettings } from '../sim/settings';

export const STORAGE_KEY = 'crewfall.settings.v1';

export interface StoredSettings {
  settings: GameSettings;
  /** What the player typed in the seed box. Empty means "random seed each game". */
  seedText: string;
}

/** Turns stored JSON (or null / garbage) into settings, filling anything missing from defaults. */
export function parseStoredSettings(json: string | null): StoredSettings {
  const base = defaultSettings();
  if (!json) return { settings: base, seedText: '' };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { settings: base, seedText: '' };
  }
  if (typeof raw !== 'object' || raw === null) return { settings: base, seedText: '' };
  const obj = raw as { settings?: Record<string, unknown>; seedText?: unknown };
  const merged: GameSettings = { ...base };
  const src = obj.settings ?? {};
  for (const key of Object.keys(base) as (keyof GameSettings)[]) {
    const v = src[key];
    if (v !== undefined && typeof v === typeof base[key]) (merged as unknown as Record<string, unknown>)[key] = v;
  }
  return { settings: merged, seedText: typeof obj.seedText === 'string' ? obj.seedText : '' };
}

export function serializeSettings(stored: StoredSettings): string {
  return JSON.stringify({ settings: stored.settings, seedText: stored.seedText });
}

export function loadStoredSettings(): StoredSettings {
  try {
    return parseStoredSettings(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return parseStoredSettings(null);
  }
}

export function saveStoredSettings(stored: StoredSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, serializeSettings(stored));
  } catch {
    // Storage can be unavailable (private window); the game still works, it just forgets.
  }
}
