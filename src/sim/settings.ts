// Game settings (SPEC 12) and their allowed ranges. Pure TypeScript.
// The lobby computer edits a GameSettings object; the simulation reads it at game start.

import defaultsJson from '../../config/defaults.json';

export type Difficulty = 'easy' | 'normal' | 'hard';
export type KillDistance = 'short' | 'medium' | 'long';
export type TaskBarUpdates = 'always' | 'meetings' | 'never';

export interface GameSettings {
  map: string;
  players: number;
  impostors: number;
  difficulty: Difficulty;
  playerName: string;
  playerColor: string;
  killCooldownSec: number;
  killDistance: KillDistance;
  emergencyMeetings: number;
  discussionSec: number;
  votingSec: number;
  anonymousVotes: boolean;
  confirmEjects: boolean;
  playerSpeed: number;
  crewVision: number;
  impostorVision: number;
  commonTasks: number;
  longTasks: number;
  shortTasks: number;
  taskBarUpdates: TaskBarUpdates;
  visualTasks: boolean;
}

/** Kill distance in tiles, centre to centre (DECISIONS 2026-09-07). */
export const KILL_DISTANCE_TILES: Record<KillDistance, number> = { short: 1.25, medium: 2, long: 3 };

export function defaultSettings(): GameSettings {
  const d = defaultsJson;
  return {
    map: d.map,
    players: d.players,
    impostors: d.impostors,
    difficulty: d.difficulty as Difficulty,
    playerName: d.playerName,
    playerColor: d.playerColor,
    killCooldownSec: d.killCooldownSec,
    killDistance: d.killDistance as KillDistance,
    emergencyMeetings: d.emergencyMeetings,
    discussionSec: d.discussionSec,
    votingSec: d.votingSec,
    anonymousVotes: d.anonymousVotes,
    confirmEjects: d.confirmEjects,
    playerSpeed: d.playerSpeed,
    crewVision: d.crewVision,
    impostorVision: d.impostorVision,
    commonTasks: d.commonTasks,
    longTasks: d.longTasks,
    shortTasks: d.shortTasks,
    taskBarUpdates: d.taskBarUpdates as TaskBarUpdates,
    visualTasks: d.visualTasks,
  };
}

/** Numeric ranges from SPEC 12. Map-dependent caps (players, impostors) are applied by clampSettings. */
export const SETTING_RANGES = {
  players: { min: 4, max: 15, step: 1 },
  impostors: { min: 1, max: 3, step: 1 },
  killCooldownSec: { min: 10, max: 60, step: 5 },
  emergencyMeetings: { min: 0, max: 3, step: 1 },
  discussionSec: { min: 0, max: 60, step: 5 },
  votingSec: { min: 15, max: 120, step: 5 },
  playerSpeed: { min: 0.5, max: 2.0, step: 0.25 },
  crewVision: { min: 0.5, max: 2.0, step: 0.25 },
  impostorVision: { min: 0.5, max: 3.0, step: 0.25 },
  commonTasks: { min: 0, max: 2, step: 1 },
  longTasks: { min: 0, max: 3, step: 1 },
  shortTasks: { min: 0, max: 5, step: 1 },
} as const;

export type NumericSettingKey = keyof typeof SETTING_RANGES;

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Forces every value into its allowed range for the given map caps. Returns a new object. */
export function clampSettings(s: GameSettings, mapCaps: { playerCap: number; impostorMax: number }): GameSettings {
  const out: GameSettings = { ...s };
  for (const key of Object.keys(SETTING_RANGES) as NumericSettingKey[]) {
    const r = SETTING_RANGES[key];
    out[key] = clamp(Number.isFinite(out[key]) ? out[key] : defaultSettings()[key], r.min, r.max);
  }
  out.players = clamp(out.players, SETTING_RANGES.players.min, mapCaps.playerCap);
  out.impostors = clamp(out.impostors, 1, Math.min(mapCaps.impostorMax, Math.floor((out.players - 1) / 2)));
  out.playerName = out.playerName.trim().slice(0, 12) || 'You';
  return out;
}
