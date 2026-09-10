// Plays a whole game with no player and no screen: the player's seat is taken by a bot.
// Used by the balance simulator (npm run sim) and by tests. Pure TypeScript.

import { assignPersonalities } from '../bots/personality';
import { createBotState } from '../bots/brain';
import type { GameMap } from './map';
import { Rng } from './rng';
import type { GameSettings } from './settings';
import { createGame, stepSim, NO_INPUT, type SimConfig, type SimState } from './sim';
import type { Outcome } from './win';

export interface GameResult {
  readonly seed: number;
  readonly outcome: Outcome | null;
  /** Game length in seconds of simulated time. */
  readonly seconds: number;
  readonly meetings: number;
  readonly kills: number;
  /** Ejections that removed an impostor / any ejection. */
  readonly ejections: number;
  readonly impostorEjections: number;
  /** True if the game hit the time cap without an ending. */
  readonly timedOut: boolean;
  readonly playerRole: 'crew' | 'impostor';
}

/** Turns the player's unit into a bot with its own personality, so the lobby is all bots. */
export function makeAllBots(state: SimState): void {
  const player = state.units[0];
  if (!player || state.bots.some((b) => b.unitId === 0)) return;
  (player as { isPlayer: boolean }).isPlayer = false;
  const rng = new Rng(state.seed ^ 0x51ed);
  const personalityId = assignPersonalities(1, rng)[0] as string;
  state.bots.unshift(createBotState(0, state.rng, state.config, personalityId));
}

/** Plays one all-bot game from a seed until it ends or the time cap is reached. */
export function playBotGame(map: GameMap, settings: GameSettings, seed: number, config: SimConfig, maxMinutes = 25): GameResult {
  const state = createGame(map, settings, seed, config);
  makeAllBots(state);
  const playerRole = state.units[0]!.role;
  let kills = 0;
  let ejections = 0;
  let impostorEjections = 0;
  const maxTicks = maxMinutes * 60 * config.tickRate;
  while (state.phase !== 'ended' && state.tick < maxTicks) {
    stepSim(state, NO_INPUT, map, config);
    for (const ev of state.events) {
      if (ev.kind === 'kill') kills++;
      if (ev.kind === 'ejected' && ev.unitId !== null) {
        ejections++;
        if (state.units[ev.unitId]?.role === 'impostor') impostorEjections++;
      }
    }
  }
  return {
    seed,
    outcome: state.outcome,
    seconds: Math.round(state.tick / config.tickRate),
    meetings: state.meetingsHeld,
    kills,
    ejections,
    impostorEjections,
    timedOut: state.phase !== 'ended',
    playerRole,
  };
}

export interface Summary {
  readonly games: number;
  readonly crewWins: number;
  readonly impostorWins: number;
  readonly timeouts: number;
  readonly crewWinRate: number;
  readonly byReason: Record<string, number>;
  readonly avgSeconds: number;
  readonly avgMeetings: number;
  readonly avgKills: number;
  readonly ejectionAccuracy: number | null;
}

export function summarize(results: readonly GameResult[]): Summary {
  const finished = results.filter((r) => !r.timedOut);
  const crewWins = results.filter((r) => r.outcome?.winner === 'crew').length;
  const impostorWins = results.filter((r) => r.outcome?.winner === 'impostor').length;
  const byReason: Record<string, number> = {};
  for (const r of results) {
    const key = r.outcome ? `${r.outcome.winner}:${r.outcome.reason}` : 'timeout';
    byReason[key] = (byReason[key] ?? 0) + 1;
  }
  const avg = (f: (r: GameResult) => number) => (results.length ? results.reduce((a, r) => a + f(r), 0) / results.length : 0);
  const ejections = results.reduce((a, r) => a + r.ejections, 0);
  const good = results.reduce((a, r) => a + r.impostorEjections, 0);
  return {
    games: results.length,
    crewWins,
    impostorWins,
    timeouts: results.length - finished.length,
    crewWinRate: finished.length ? crewWins / finished.length : 0,
    byReason,
    avgSeconds: avg((r) => r.seconds),
    avgMeetings: avg((r) => r.meetings),
    avgKills: avg((r) => r.kills),
    ejectionAccuracy: ejections > 0 ? good / ejections : null,
  };
}
