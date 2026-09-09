// Win conditions (SPEC 4.3). Pure TypeScript.
//   Crew wins:     all tasks complete, or no impostor left alive.
//   Impostor wins: living impostors >= living crew (sabotage countdowns arrive in Phase 4).

import type { SimState } from './sim';

export type Winner = 'crew' | 'impostor';
export type WinReason = 'tasks' | 'ejected' | 'numbers' | 'sabotage';

export interface Outcome {
  readonly winner: Winner;
  readonly reason: WinReason;
  readonly endedTick: number;
}

/** The outcome if the game is over as things stand, or null if play goes on. */
export function evaluateWin(state: SimState): Outcome | null {
  const livingCrew = state.units.filter((u) => u.alive && u.role === 'crew').length;
  const livingImpostors = state.units.filter((u) => u.alive && u.role === 'impostor').length;
  if (livingImpostors === 0) return { winner: 'crew', reason: 'ejected', endedTick: state.tick };
  if (state.crewTasks.total > 0 && state.crewTasks.done >= state.crewTasks.total) return { winner: 'crew', reason: 'tasks', endedTick: state.tick };
  if (livingImpostors >= livingCrew) return { winner: 'impostor', reason: 'numbers', endedTick: state.tick };
  return null;
}

/** Ends the game if a win condition holds. Returns true if it did. */
export function checkWin(state: SimState): boolean {
  if (state.phase === 'ended' || state.mode !== 'game') return false;
  const outcome = evaluateWin(state);
  if (!outcome) return false;
  state.phase = 'ended';
  state.outcome = outcome;
  state.meeting = null;
  state.playerTask = null;
  for (const u of state.units) u.moving = false;
  state.events.push({ kind: 'gameOver', winner: outcome.winner, reason: outcome.reason });
  return true;
}

/** Did the player's side win? */
export function playerWon(state: SimState): boolean | null {
  if (!state.outcome) return null;
  const player = state.units[0];
  if (!player) return null;
  return state.outcome.winner === player.role;
}

export function describeOutcome(state: SimState): string {
  const o = state.outcome;
  if (!o) return '';
  switch (o.reason) {
    case 'tasks':
      return 'The crew finished every task.';
    case 'ejected':
      return 'Every impostor was voted out.';
    case 'numbers':
      return 'The impostors matched the crew in numbers.';
    case 'sabotage':
      return 'A sabotage ran out.';
  }
}
