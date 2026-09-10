import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../config/game.json';
import { perceive } from '../src/bots/memory';
import { tickSocial } from '../src/bots/suspicion';
import { tryKill } from '../src/sim/actions';
import { playBotGame, summarize } from '../src/sim/headless';
import { loadMap } from '../src/sim/map';
import { defaultSettings, type GameSettings } from '../src/sim/settings';
import { createGame, NO_INPUT, player, stepSim, type SimState, type Unit } from '../src/sim/sim';

const map = loadMap(JSON.parse(readFileSync(new URL('../assets/maps/kestrel.json', import.meta.url), 'utf8')));
const TS = map.tileSize;
const RATE = config.tickRate;
const at = (u: Unit, tx: number, ty: number) => {
  u.x = tx * TS + TS / 2;
  u.y = ty * TS + TS / 2;
};
const botOf = (s: SimState, u: Unit) => s.bots.find((b) => b.unitId === u.id)!;

function game(seed: number, over: Partial<GameSettings> = {}): SimState {
  return createGame(map, { ...defaultSettings(), players: 8, impostors: 2, discussionSec: 10, votingSec: 30, ...over }, seed, config);
}

/** Runs until the meeting that follows the current play ends, pressing nothing. */
function throughNextMeeting(s: SimState, input = NO_INPUT, maxSec = 120): void {
  let seenMeeting = false;
  for (let i = 0; i < RATE * maxSec; i++) {
    stepSim(s, input, map, config);
    if (s.phase === 'meeting') seenMeeting = true;
    else if (seenMeeting) return;
    if (s.phase === 'ended') return;
  }
}

describe('scenario: a witnessed kill (SPEC 9.14)', () => {
  it('bot A sees B kill C, so A accuses B in the next meeting and votes B', () => {
    const s = game(41);
    const imp = s.units.find((u) => u.role === 'impostor' && !u.isPlayer)!;
    const victim = s.units.find((u) => u.role === 'crew' && !u.isPlayer)!;
    const witness = s.units.find((u) => u.role === 'crew' && !u.isPlayer && u !== victim)!;
    for (const b of s.bots) {
      b.frozen = true;
      s.units[b.unitId]!.tasks = [];
    }
    for (const u of s.units) if (u.role === 'impostor') u.killCooldownTicks = 1e9;
    for (const u of s.units) at(u, 31, 4); // everyone in Navigation
    at(imp, 52, 55); // Reactor
    at(victim, 53, 55);
    at(witness, 50, 53); // Reactor, watching
    imp.killCooldownTicks = 0;
    stepSim(s, NO_INPUT, map, config);
    expect(tryKill(s, imp, victim, config)).toBe(true);
    // The kill happened after this tick's perception; run the witness's perception for it by hand.
    perceive(botOf(s, witness).memory, witness, s, map, config);
    tickSocial(botOf(s, witness).social, botOf(s, witness).memory, witness, s, map, config);
    expect(botOf(s, witness).social.certain[imp.id] ?? false).toBe(true);
    botOf(s, witness).frozen = false;
    throughNextMeeting(s);
    const accused = s.claims.some((c) => c.kind === 'accuse' && c.speakerId === witness.id && c.subjectId === imp.id);
    expect(accused).toBe(true);
    expect(botOf(s, witness).social.lastVoteReason).toContain(imp.name);
    expect(botOf(s, witness).social.lastVoteReason).toContain('I saw');
  });
});

describe('scenario: the player', () => {
  function playerAsImpostor(seedStart: number): SimState {
    for (let seed = seedStart; seed < seedStart + 60; seed++) {
      const s = game(seed);
      if (player(s).role === 'impostor') return s;
    }
    throw new Error('no seed with an impostor player');
  }

  it('killing in front of the bots gets the player voted out', () => {
    const s = playerAsImpostor(100);
    const p = player(s);
    p.killCooldownTicks = 0;
    const victim = s.units.find((u) => u.role === 'crew')!;
    victim.x = p.x + 10;
    victim.y = p.y;
    // Everyone is still in Cafeteria at spawn: plenty of witnesses.
    stepSim(s, { ...NO_INPUT, killPressed: true }, map, config);
    expect(victim.alive).toBe(false);
    throughNextMeeting(s);
    expect(p.alive).toBe(false);
    expect(p.ejected).toBe(true);
  });

  it('building an alibi with a bot clears the player in that bot\'s eyes', () => {
    const s = game(200);
    const p = player(s);
    const buddy = s.units.find((u) => u.role === 'crew' && !u.isPlayer)!;
    const imp = s.units.find((u) => u.role === 'impostor' && !u.isPlayer)!;
    const victim = s.units.find((u) => u.role === 'crew' && !u.isPlayer && u !== buddy)!;
    for (const b of s.bots) {
      b.frozen = true;
      s.units[b.unitId]!.tasks = [];
    }
    for (const u of s.units) if (u.role === 'impostor') u.killCooldownTicks = 1e9;
    for (const u of s.units) at(u, 31, 4);
    at(p, 8, 15); // Weapons, beside the buddy
    at(buddy, 9, 15);
    at(imp, 52, 55); // Reactor, far away
    at(victim, 53, 55);
    for (let i = 0; i < RATE * 6; i++) stepSim(s, NO_INPUT, map, config);
    imp.killCooldownTicks = 0;
    stepSim(s, NO_INPUT, map, config);
    tryKill(s, imp, victim, config);
    // Stay side by side well past the kill moment, so the alibi covers the whole window.
    for (let i = 0; i < RATE * 8; i++) stepSim(s, NO_INPUT, map, config);
    // The buddy walks over and reports (unfreeze it and put it by the body).
    at(buddy, 53, 55);
    botOf(s, buddy).frozen = false;
    let meetingAt = -1;
    for (let i = 0; i < RATE * 40 && meetingAt < 0; i++) {
      stepSim(s, NO_INPUT, map, config);
      if (s.phase === 'meeting') meetingAt = s.tick;
    }
    expect(meetingAt).toBeGreaterThan(0);
    const social = botOf(s, buddy).social;
    const cleared = social.evidence.find((e) => e.targetId === p.id && e.kind === 'withMeDuringKill');
    expect(cleared).toBeDefined();
    expect(social.suspicion[p.id] ?? 0).toBe(0);
  });
});

describe('the headless simulator', () => {
  it('plays all-bot games to an ending and summarises them', { timeout: 60000 }, () => {
    const results = [1, 2, 3].map((seed) => playBotGame(map, { ...defaultSettings(), players: 10, impostors: 2 }, seed, config, 25));
    for (const r of results) {
      expect(r.seconds).toBeGreaterThan(0);
      expect(['crew', 'impostor']).toContain(r.playerRole);
    }
    const s = summarize(results);
    expect(s.games).toBe(3);
    expect(s.crewWins + s.impostorWins + s.timeouts).toBe(3);
    expect(Object.values(s.byReason).reduce((a, b) => a + b, 0)).toBe(3);
  });

  it('is deterministic: the same seed gives the same result', { timeout: 60000 }, () => {
    const a = playBotGame(map, defaultSettings(), 9, config, 15);
    const b = playBotGame(map, defaultSettings(), 9, config, 15);
    expect(a).toEqual(b);
  });
});
