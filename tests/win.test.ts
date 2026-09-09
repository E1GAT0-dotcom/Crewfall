import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../config/game.json';
import { tryKill } from '../src/sim/actions';
import { loadMap } from '../src/sim/map';
import { startMeeting } from '../src/sim/meeting';
import { defaultSettings } from '../src/sim/settings';
import { createGame, NO_INPUT, player, stepSim, type SimState } from '../src/sim/sim';
import { checkWin, evaluateWin, playerWon } from '../src/sim/win';

const map = loadMap(JSON.parse(readFileSync(new URL('../assets/maps/kestrel.json', import.meta.url), 'utf8')));
const RATE = config.tickRate;

function game(seed = 1, players = 8, impostors = 2): SimState {
  return createGame(map, { ...defaultSettings(), players, impostors }, seed, config);
}

describe('win conditions (SPEC 4.3)', () => {
  it('nobody has won at the start', () => {
    expect(evaluateWin(game())).toBeNull();
  });

  it('crew wins when every task stage is done', () => {
    const s = game();
    for (const u of s.units) if (u.role === 'crew') for (const t of u.tasks) for (const st of t.stages) st.done = true;
    s.crewTasks = { done: s.crewTasks.total, total: s.crewTasks.total };
    expect(evaluateWin(s)).toMatchObject({ winner: 'crew', reason: 'tasks' });
  });

  it('crew wins when no impostor is left alive', () => {
    const s = game();
    for (const u of s.units) if (u.role === 'impostor') u.alive = false;
    expect(evaluateWin(s)).toMatchObject({ winner: 'crew', reason: 'ejected' });
  });

  it('impostors win when they equal the living crew', () => {
    const s = game(1, 8, 2);
    const crew = s.units.filter((u) => u.role === 'crew');
    for (const u of crew.slice(0, 3)) u.alive = false; // 3 crew left vs 2 impostors: still going
    expect(evaluateWin(s)).toBeNull();
    crew[3]!.alive = false; // 2 vs 2
    expect(evaluateWin(s)).toMatchObject({ winner: 'impostor', reason: 'numbers' });
  });

  it('checkWin freezes the game and later ticks change nothing', () => {
    const s = game();
    for (const u of s.units) if (u.role === 'impostor') u.alive = false;
    stepSim(s, { dx: 1, dy: 0 }, map, config);
    expect(s.phase).toBe('ended');
    expect(s.outcome?.winner).toBe('crew');
    expect(s.events.some((e) => e.kind === 'gameOver')).toBe(true);
    const snapshot = JSON.stringify(s.units.map((u) => [u.x, u.y, u.alive]));
    for (let i = 0; i < 60; i++) stepSim(s, { dx: 1, dy: 1, killPressed: true }, map, config);
    expect(JSON.stringify(s.units.map((u) => [u.x, u.y, u.alive]))).toBe(snapshot);
    expect(checkWin(s)).toBe(false);
  });

  it('a kill that brings the numbers level ends the game that tick', () => {
    const s = game(2, 4, 1);
    const imp = s.units.find((u) => u.role === 'impostor')!;
    const crew = s.units.filter((u) => u.role === 'crew');
    crew[0]!.alive = false; // 2 crew vs 1 impostor
    imp.killCooldownTicks = 0;
    crew[1]!.x = imp.x + 10;
    crew[1]!.y = imp.y;
    for (const u of s.units) if (u !== imp && u !== crew[1]) { u.x = 31 * 32; u.y = 4 * 32; }
    expect(tryKill(s, imp, crew[1]!, config)).toBe(true);
    stepSim(s, NO_INPUT, map, config);
    expect(s.phase).toBe('ended');
    expect(s.outcome).toMatchObject({ winner: 'impostor', reason: 'numbers' });
  });

  it('ejecting the last impostor ends the game the moment the meeting closes', () => {
    const s = game(3, 6, 1);
    const imp = s.units.find((u) => u.role === 'impostor')!;
    startMeeting(s, player(s), 'button', null, map, config);
    s.meeting!.stage = 'voting';
    s.meeting!.stageEndsTick = s.tick + 100;
    for (const u of s.units) if (u.alive) s.meeting!.votes[u.id] = imp.id;
    stepSim(s, NO_INPUT, map, config);
    expect(s.meeting?.stage).toBe('result');
    expect(s.meeting?.result?.ejectedId).toBe(imp.id);
    for (let i = 0; i <= Math.round(config.meeting.resultSec * RATE); i++) stepSim(s, NO_INPUT, map, config);
    expect(s.phase).toBe('ended');
    expect(s.outcome).toMatchObject({ winner: 'crew', reason: 'ejected' });
    expect(imp.alive).toBe(false);
    expect(imp.ejected).toBe(true);
  });

  it('playerWon follows the player role', () => {
    const s = game(4);
    for (const u of s.units) if (u.role === 'impostor') u.alive = false;
    checkWin(s);
    expect(playerWon(s)).toBe(player(s).role === 'crew');
  });
});

describe('whole games', () => {
  /** Plays a bot game with the player standing still and skipping every vote. */
  function playOut(seed: number, maxMinutes: number, over = {}) {
    const s = createGame(map, { ...defaultSettings(), players: 10, impostors: 2, crewVision: 0.5, ...over }, seed, config);
    for (let i = 0; i < maxMinutes * 60 * RATE && s.phase !== 'ended'; i++) {
      stepSim(s, s.phase === 'meeting' ? { ...NO_INPUT, voteFor: 'skip' } : NO_INPUT, map, config);
    }
    return s;
  }

  it('the same seed replays to the same outcome, kills, meetings and positions', () => {
    const a = playOut(77, 8);
    const b = playOut(77, 8);
    const digest = (s: SimState) => ({
      phase: s.phase,
      outcome: s.outcome,
      tick: s.tick,
      meetings: s.meetingsHeld,
      tasks: s.crewTasks,
      units: s.units.map((u) => [u.name, u.alive, u.ejected, Math.round(u.x), Math.round(u.y)]),
      chat: s.meeting?.chat.length ?? 0,
    });
    expect(digest(a)).toEqual(digest(b));
  });

  it('bot games reach an ending', () => {
    let ended = 0;
    for (const seed of [101, 102, 103]) {
      const s = playOut(seed, 25);
      if (s.phase === 'ended') ended++;
    }
    expect(ended).toBeGreaterThanOrEqual(2);
  });
});
