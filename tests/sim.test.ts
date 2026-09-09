import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../config/game.json';
import { loadMap } from '../src/sim/map';
import { defaultSettings } from '../src/sim/settings';
import { createGame, NO_INPUT, player, playerRegionName, stepSim, unitRegionName, type PlayerInput, type SimState } from '../src/sim/sim';
import { countStages, taskComplete } from '../src/sim/tasks';

const map = loadMap(JSON.parse(readFileSync(new URL('../assets/maps/kestrel.json', import.meta.url), 'utf8')));
const TS = map.tileSize;
const pxPerTick = (config.player.speedTilesPerSec * TS) / config.tickRate;

/** A game where the player stands still and every bot is elsewhere, for movement tests. */
function newGame(seed = 1, players = 10): SimState {
  return createGame(map, { ...defaultSettings(), players }, seed, config);
}

/** Steps the game; in a meeting the player votes skip so bot-only games keep moving. */
function run(state: SimState, input: PlayerInput, ticks: number): SimState {
  for (let i = 0; i < ticks; i++) stepSim(state, state.phase === 'meeting' ? { ...input, voteFor: 'skip' } : input, map, config);
  return state;
}

describe('game setup', () => {
  it('creates the right number of units, roles, names and colours', () => {
    const s = newGame(7, 10);
    expect(s.units.length).toBe(10);
    expect(s.units.filter((u) => u.role === 'impostor').length).toBe(2);
    expect(s.units[0]?.isPlayer).toBe(true);
    expect(s.units[0]?.name).toBe('You');
    expect(s.units[0]?.colorId).toBe('cyan');
    const names = s.units.map((u) => u.name);
    expect(new Set(names).size).toBe(10);
    const initials = s.units.slice(1).map((u) => u.name[0]);
    expect(new Set(initials).size).toBe(9);
    const colours = s.units.map((u) => u.colorId);
    expect(new Set(colours).size).toBe(10);
    expect(s.bots.length).toBe(9);
  });

  it('respects the players and impostors settings and caps', () => {
    const small = createGame(map, { ...defaultSettings(), players: 5, impostors: 1 }, 3, config);
    expect(small.units.length).toBe(5);
    expect(small.units.filter((u) => u.role === 'impostor').length).toBe(1);
    const tooMany = createGame(map, { ...defaultSettings(), players: 99, impostors: 9 }, 3, config);
    expect(tooMany.units.length).toBe(map.playerCap);
    expect(tooMany.units.filter((u) => u.role === 'impostor').length).toBe(map.impostors.max);
  });

  it('gives every unit a task list and counts only crew tasks for the task bar', () => {
    const s = newGame(11);
    for (const u of s.units) {
      expect(u.tasks.length).toBe(1 + 1 + 2);
      expect(u.tasks.filter((t) => t.kind === 'common').length).toBe(1);
      expect(u.tasks.filter((t) => t.kind === 'long').length).toBe(1);
      expect(u.tasks.filter((t) => t.kind === 'short').length).toBe(2);
    }
    const commonType = s.units[0]?.tasks.find((t) => t.kind === 'common')?.type;
    for (const u of s.units) expect(u.tasks.find((t) => t.kind === 'common')?.type).toBe(commonType);
    let expectedTotal = 0;
    for (const u of s.units) if (u.role === 'crew') expectedTotal += countStages(u.tasks).total;
    expect(s.crewTasks).toEqual({ done: 0, total: expectedTotal });
    expect(expectedTotal).toBeGreaterThan(0);
  });

  it('the player is sometimes an impostor, roughly at the expected rate', () => {
    let impostor = 0;
    for (let seed = 0; seed < 200; seed++) if (createGame(map, defaultSettings(), seed, config).units[0]?.role === 'impostor') impostor++;
    expect(impostor).toBeGreaterThan(20); // expected about 40 of 200
    expect(impostor).toBeLessThan(70);
  });

  it('spawns everyone on a spawn tile in Cafeteria', () => {
    const s = newGame(5);
    for (const u of s.units) {
      expect(unitRegionName(u, map)).toBe('Cafeteria');
      const onSpawn = map.spawns.some(([sx, sy]) => sx * TS + TS / 2 === u.x && sy * TS + TS / 2 === u.y);
      expect(onSpawn).toBe(true);
    }
  });
});

describe('player movement', () => {
  it('moves at the configured speed and counts ticks', () => {
    const s = newGame();
    const before = { ...player(s) };
    stepSim(s, { dx: 1, dy: 0 }, map, config);
    expect(s.tick).toBe(1);
    const p = player(s);
    expect(p.x).toBeCloseTo(before.x + pxPerTick);
    expect(p.y).toBe(before.y);
    expect(p.moving).toBe(true);
    expect(p.facing).toBe(1);
  });

  it('diagonal movement is not faster than straight movement', () => {
    const s = newGame();
    const before = { ...player(s) };
    stepSim(s, { dx: 1, dy: -1 }, map, config);
    const p = player(s);
    expect(Math.hypot(p.x - before.x, p.y - before.y)).toBeCloseTo(pxPerTick);
  });

  it('speed setting scales walking speed', () => {
    const s = createGame(map, { ...defaultSettings(), playerSpeed: 2 }, 1, config);
    const before = { ...player(s) };
    stepSim(s, { dx: 1, dy: 0 }, map, config);
    expect(player(s).x).toBeCloseTo(before.x + pxPerTick * 2);
  });

  it('keeps facing left after stopping, and reports not moving', () => {
    const s = newGame();
    run(s, { dx: -1, dy: 0 }, 3);
    expect(player(s).facing).toBe(-1);
    stepSim(s, NO_INPUT, map, config);
    expect(player(s).facing).toBe(-1);
    expect(player(s).moving).toBe(false);
  });

  it('walks out of Cafeteria into a corridor and on into Admin', () => {
    const s = newGame(2);
    // Put the player on the spawn tile straight below the button so "down" leads through the opening.
    const p = player(s);
    p.x = 31 * TS + TS / 2;
    p.y = 30 * TS + TS / 2;
    expect(playerRegionName(s, map)).toBe('Cafeteria');
    run(s, { dx: 0, dy: 1 }, Math.round(config.tickRate * 1.5));
    expect(playerRegionName(s, map)).toMatch(/^Corridor \d+$/);
    run(s, { dx: 0, dy: 1 }, config.tickRate * 2);
    expect(playerRegionName(s, map)).toBe('Admin');
  });

  it('stops at a wall and reports not moving', () => {
    const s = newGame();
    run(s, { dx: 0, dy: -1 }, config.tickRate * 5);
    const before = { ...player(s) };
    stepSim(s, { dx: 0, dy: -1 }, map, config);
    expect(player(s).y).toBe(before.y);
    expect(player(s).moving).toBe(false);
    expect(playerRegionName(s, map)).toBe('Cafeteria');
  });
});

describe('determinism', () => {
  it('the same seed and inputs give the same game, bots included', () => {
    const script: PlayerInput[] = [];
    for (let i = 0; i < 600; i++) script.push({ dx: ((i * 7) % 3) - 1, dy: ((i * 5) % 3) - 1 });
    const play = () => {
      const s = newGame(42);
      for (const input of script) stepSim(s, input, map, config);
      return s;
    };
    const a = play();
    const b = play();
    expect(a.units).toEqual(b.units);
    expect(a.bots).toEqual(b.bots);
    expect(a.crewTasks).toEqual(b.crewTasks);
  });

  it('different seeds give different games', () => {
    const a = run(newGame(1), NO_INPUT, 300);
    const b = run(newGame(2), NO_INPUT, 300);
    expect(a.units.map((u) => [u.name, u.x, u.y])).not.toEqual(b.units.map((u) => [u.name, u.x, u.y]));
  });
});

describe('bots', () => {
  it('walk to task spots, do tasks, and the task bar rises', () => {
    const s = newGame(9);
    run(s, NO_INPUT, config.tickRate * 90); // 90 seconds
    expect(s.crewTasks.done).toBeGreaterThan(0);
    // Every bot should have left Cafeteria at some point; check they are spread out now.
    const rooms = new Set(s.bots.map((b) => unitRegionName(s.units[b.unitId]!, map)));
    expect(rooms.size).toBeGreaterThan(1);
  });

  it('crew bots work through their tasks and impostor tasks never count', () => {
    const s = createGame(map, { ...defaultSettings(), players: 6, impostors: 1 }, 13, config);
    run(s, NO_INPUT, config.tickRate * 600); // 10 minutes, or until the game ends
    const crewBots = s.bots.map((b) => s.units[b.unitId]!).filter((u) => u.role === 'crew');
    let doneByCrewBots = 0;
    for (const u of crewBots) doneByCrewBots += countStages(u.tasks).done;
    expect(doneByCrewBots).toBeGreaterThan(0);
    // The player did nothing, so the task bar counts exactly the crew bots' stages: impostor work is ignored.
    expect(s.crewTasks.done).toBe(doneByCrewBots);
    const imp = s.units.find((u) => u.role === 'impostor')!;
    expect(countStages(imp.tasks).done).toBeGreaterThanOrEqual(0);
    // Either the crew bots finished everything they could, or the game ended first.
    const allDone = crewBots.every((u) => taskComplete === undefined || u.tasks.every(taskComplete));
    expect(allDone || s.phase === 'ended').toBe(true);
  });

  it('bots never end up inside a wall', () => {
    const s = newGame(21);
    for (let i = 0; i < config.tickRate * 60; i++) {
      stepSim(s, NO_INPUT, map, config);
      for (const u of s.units) {
        expect(map.isWalkable(Math.floor(u.x / TS), Math.floor(u.y / TS)), `${u.name} at tick ${s.tick}`).toBe(true);
      }
    }
  });
});

describe('bot feel (Greg, 2026-09-07: not robots)', () => {
  it('bots leave spawn at different times and walk at different speeds', () => {
    const s = newGame(31);
    const firstMove = new Map<number, number>();
    for (let i = 0; i < config.tickRate * 6; i++) {
      stepSim(s, NO_INPUT, map, config);
      for (const b of s.bots) if (!firstMove.has(b.unitId) && s.units[b.unitId]!.moving) firstMove.set(b.unitId, s.tick);
    }
    expect(new Set(firstMove.values()).size).toBeGreaterThan(3);
    expect(new Set(s.bots.map((b) => b.quirks.speed)).size).toBe(s.bots.length);
  });

  it('bots pause now and then while walking, and hesitate after a task', () => {
    const s = newGame(32);
    const pausedTicks = new Map<number, number>();
    for (let i = 0; i < config.tickRate * 120; i++) {
      stepSim(s, NO_INPUT, map, config);
      for (const b of s.bots) if (b.pauseTicks > 0 && b.goal.kind !== 'idle') pausedTicks.set(b.unitId, (pausedTicks.get(b.unitId) ?? 0) + 1);
    }
    for (const b of s.bots) expect(pausedTicks.get(b.unitId) ?? 0, `bot ${b.unitId}`).toBeGreaterThan(0);
    expect(s.crewTasks.done).toBeGreaterThan(0);
  });

  it('bots do not all pick the same first room', () => {
    let distinct = 0;
    for (const seed of [41, 42, 43, 44, 45]) {
      const s = newGame(seed);
      const firstRoom = new Map<number, string>();
      for (let i = 0; i < config.tickRate * 8; i++) {
        stepSim(s, NO_INPUT, map, config);
        for (const b of s.bots) if (!firstRoom.has(b.unitId) && b.goal.kind !== 'idle') firstRoom.set(b.unitId, b.goal.label.replace(/^.* (in|to|around) /, ''));
      }
      distinct += new Set(firstRoom.values()).size;
    }
    expect(distinct / 5).toBeGreaterThanOrEqual(3);
  });
});

describe('bots kill and report (Phase 2 simple brains)', () => {
  /** Impostor and a lone crew bot in Reactor, everyone else far away in Navigation. */
  function isolated(seed: number) {
    const s = createGame(map, { ...defaultSettings(), players: 10, impostors: 2 }, seed, config);
    const imp = s.units.find((u) => u.role === 'impostor' && !u.isPlayer)!;
    const victim = s.units.find((u) => u.role === 'crew' && !u.isPlayer)!;
    for (const u of s.units) {
      u.x = 31 * TS + TS / 2;
      u.y = 4 * TS + TS / 2;
    }
    imp.x = 50 * TS + TS / 2;
    imp.y = 54 * TS + TS / 2;
    victim.x = 56 * TS + TS / 2;
    victim.y = 54 * TS + TS / 2;
    imp.killCooldownTicks = 0;
    // Park the victim: no tasks, so it stays put (a real target would wander, which also works).
    victim.tasks = [];
    return { s, imp, victim };
  }

  it('an impostor bot hunts and kills a crew member nobody else can see', () => {
    const { s, imp, victim } = isolated(17);
    let killed = false;
    for (let i = 0; i < config.tickRate * 20 && !killed; i++) {
      stepSim(s, NO_INPUT, map, config);
      if (!victim.alive) killed = true;
    }
    expect(killed).toBe(true);
    expect(s.bodies.length).toBe(1);
    expect(imp.killCooldownTicks).toBeGreaterThan(0);
  });

  it('an impostor bot does not kill when someone else can see the target', () => {
    const { s, victim } = isolated(17);
    const witness = s.units.find((u) => u.role === 'crew' && !u.isPlayer && u.id !== victim.id)!;
    witness.x = victim.x - 4 * TS;
    witness.y = victim.y;
    witness.tasks = [];
    for (let i = 0; i < config.tickRate * 15; i++) stepSim(s, NO_INPUT, map, config);
    expect(victim.alive).toBe(true);
  });

  it('a crew bot that sees a body walks over and reports it, starting a meeting', () => {
    const { s, imp, victim } = isolated(18);
    imp.x = 31 * TS + TS / 2; // the impostor goes far away so it cannot interfere
    imp.y = 4 * TS + TS / 2;
    victim.alive = false;
    victim.deathTick = 0;
    s.bodies.push({ unitId: victim.id, x: victim.x, y: victim.y, tick: 0 });
    const reporter = s.units.find((u) => u.role === 'crew' && !u.isPlayer && u.id !== victim.id)!;
    reporter.x = victim.x - 6 * TS;
    reporter.y = victim.y;
    let meetingAt = -1;
    for (let i = 0; i < config.tickRate * 15 && meetingAt < 0; i++) {
      stepSim(s, NO_INPUT, map, config);
      if (s.phase === 'meeting') meetingAt = s.tick;
    }
    expect(meetingAt).toBeGreaterThan(0);
    expect(s.meeting?.calledBy).toBe(reporter.id);
    expect(s.meeting?.bodyOf).toBe(victim.id);
    expect(s.bodies).toEqual([]);
  });

  it('dead crew bots keep doing tasks as ghosts', () => {
    const s = createGame(map, { ...defaultSettings(), players: 6, impostors: 1 }, 19, config);
    const crewBots = s.units.filter((u) => !u.isPlayer && u.role === 'crew');
    const ghosts = crewBots.slice(0, 2);
    for (const u of ghosts) { u.alive = false; u.deathTick = 0; }
    const imp = s.units.find((u) => u.role === 'impostor')!;
    imp.killCooldownTicks = 1e9; // the impostor sits this one out
    for (let i = 0; i < config.tickRate * 240 && s.phase === 'play'; i++) stepSim(s, NO_INPUT, map, config);
    let ghostStages = 0;
    for (const u of ghosts) ghostStages += countStages(u.tasks).done;
    expect(ghostStages).toBeGreaterThan(0);
    expect(s.bodies).toEqual([]);
    expect(player(s).alive).toBe(true);
  });

  it('a whole bot game stays deterministic with kills and meetings in it', () => {
    const play = () => {
      const s = createGame(map, { ...defaultSettings(), players: 10, impostors: 2, crewVision: 0.5 }, 23, config);
      for (let i = 0; i < config.tickRate * 240; i++) stepSim(s, s.phase === 'meeting' ? { ...NO_INPUT, voteFor: 'skip' } : NO_INPUT, map, config);
      return { units: s.units.map((u) => [u.name, u.alive, Math.round(u.x), Math.round(u.y)]), meetings: s.meetingsHeld, tasks: s.crewTasks };
    };
    expect(play()).toEqual(play());
  });
});
