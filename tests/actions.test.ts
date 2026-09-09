import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../config/game.json';
import { bodiesInReach, canKill, endMeeting, findKillTarget, reachableStage, stageDurationTicks, tryCallMeeting, tryKill, tryReport, updatePlayerTask } from '../src/sim/actions';
import { loadMap } from '../src/sim/map';
import { defaultSettings, KILL_DISTANCE_TILES } from '../src/sim/settings';
import { createGame, NO_INPUT, player, stepSim, type SimState, type Unit } from '../src/sim/sim';
import { nextStage } from '../src/sim/tasks';

const map = loadMap(JSON.parse(readFileSync(new URL('../assets/maps/kestrel.json', import.meta.url), 'utf8')));
const TS = map.tileSize;

/** A game with a known layout: find one impostor and one crew bot, park everyone far apart. */
function setup(seed = 3): { s: SimState; imp: Unit; crew: Unit } {
  const s = createGame(map, { ...defaultSettings(), players: 10, impostors: 2 }, seed, config);
  const imp = s.units.find((u) => u.role === 'impostor' && !u.isPlayer)!;
  const crew = s.units.find((u) => u.role === 'crew' && !u.isPlayer)!;
  // Everyone to Navigation except our pair, who go to Reactor.
  for (const u of s.units) {
    u.x = 31 * TS + TS / 2;
    u.y = 4 * TS + TS / 2;
  }
  imp.x = 52 * TS;
  imp.y = 54 * TS;
  crew.x = 52 * TS + 20;
  crew.y = 54 * TS;
  return { s, imp, crew };
}

describe('kills', () => {
  it('need an impostor, a ready cooldown, a living crew target in range, and play phase', () => {
    const { s, imp, crew } = setup();
    expect(imp.killCooldownTicks).toBe(config.rules.initialKillCooldownSec * config.tickRate);
    expect(canKill(s, imp, crew, config)).toBe(false); // cooldown running
    imp.killCooldownTicks = 0;
    expect(canKill(s, imp, crew, config)).toBe(true);
    expect(canKill(s, crew, imp, config)).toBe(false); // crew cannot kill
    crew.x = imp.x + KILL_DISTANCE_TILES.short * TS + 5;
    expect(canKill(s, imp, crew, config)).toBe(false); // out of range
    crew.x = imp.x + 20;
    s.phase = 'meeting';
    expect(canKill(s, imp, crew, config)).toBe(false);
  });

  it('leave a body where the victim stood, hop the killer there, and restart the cooldown', () => {
    const { s, imp, crew } = setup();
    imp.killCooldownTicks = 0;
    const victimPos = { x: crew.x, y: crew.y };
    expect(findKillTarget(s, imp, config)?.id).toBe(crew.id);
    expect(tryKill(s, imp, crew, config)).toBe(true);
    expect(crew.alive).toBe(false);
    expect(crew.deathTick).toBe(s.tick);
    expect(s.bodies).toEqual([{ unitId: crew.id, x: victimPos.x, y: victimPos.y, tick: s.tick }]);
    expect(imp.x).toBe(victimPos.x);
    expect(imp.killCooldownTicks).toBe(defaultSettings().killCooldownSec * config.tickRate);
    expect(s.events).toContainEqual({ kind: 'kill', killerId: imp.id, victimId: crew.id, x: victimPos.x, y: victimPos.y });
    expect(tryKill(s, imp, crew, config)).toBe(false); // already dead
  });

  it('kill distance setting changes the range', () => {
    const { s, imp, crew } = setup();
    imp.killCooldownTicks = 0;
    crew.x = imp.x + 2.5 * TS;
    expect(canKill(s, imp, crew, config)).toBe(false);
    (s.settings as { killDistance: string }).killDistance = 'long';
    expect(canKill(s, imp, crew, config)).toBe(true);
  });

  it('the player kills with Q only as an impostor with a target in range', () => {
    let s: SimState | null = null;
    for (let seed = 0; seed < 50 && !s; seed++) {
      const g = createGame(map, defaultSettings(), seed, config);
      if (player(g).role === 'impostor') s = g;
    }
    expect(s).not.toBeNull();
    const g = s as SimState;
    const p = player(g);
    const victim = g.units.find((u) => u.role === 'crew')!;
    victim.x = p.x + 10;
    victim.y = p.y;
    stepSim(g, { ...NO_INPUT, killPressed: true }, map, config);
    expect(victim.alive).toBe(true); // cooldown still running at the start
    p.killCooldownTicks = 0;
    victim.x = p.x + 10;
    victim.y = p.y;
    stepSim(g, { ...NO_INPUT, killPressed: true }, map, config);
    expect(victim.alive).toBe(false);
    expect(g.bodies.length).toBe(1);
  });
});

describe('reporting and the emergency button', () => {
  it('reporting needs a body within 1.5 tiles and starts a meeting that removes bodies and freezes play', () => {
    const { s, imp, crew } = setup();
    imp.killCooldownTicks = 0;
    tryKill(s, imp, crew, config);
    const reporter = s.units.find((u) => u.role === 'crew' && u.alive && !u.isPlayer && u.id !== crew.id)!;
    expect(tryReport(s, reporter, map, config)).toBe(false); // far away in Navigation
    reporter.x = crew.x + TS;
    reporter.y = crew.y;
    expect(bodiesInReach(s, reporter, config).length).toBe(1);
    expect(tryReport(s, reporter, map, config)).toBe(true);
    expect(s.phase).toBe('meeting');
    expect(s.meeting).toEqual({ calledBy: reporter.id, reason: 'body', bodyOf: crew.id, startedTick: s.tick });
    expect(s.bodies).toEqual([]);
    expect(s.meetingsHeld).toBe(1);
    // Nothing moves during a meeting.
    const before = s.units.map((u) => [u.x, u.y]);
    for (let i = 0; i < 30; i++) stepSim(s, { dx: 1, dy: 0 }, map, config);
    expect(s.units.map((u) => [u.x, u.y])).toEqual(before);
  });

  it('dead units cannot report', () => {
    const { s, imp, crew } = setup();
    imp.killCooldownTicks = 0;
    tryKill(s, imp, crew, config);
    expect(tryReport(s, crew, map, config)).toBe(false);
  });

  it('the button needs a meeting left and the caller beside it; ending a meeting resets everyone', () => {
    const s = createGame(map, { ...defaultSettings(), emergencyMeetings: 1 }, 4, config);
    const p = player(s);
    expect(tryCallMeeting(s, p, map, config)).toBe(false); // spawn ring is 2 tiles away: too far
    p.x = (map.button![0] + 1) * TS + TS / 2;
    p.y = map.button![1] * TS + TS / 2;
    expect(tryCallMeeting(s, p, map, config)).toBe(true);
    expect(p.meetingsLeft).toBe(0);
    expect(s.phase).toBe('meeting');
    expect(s.meeting?.reason).toBe('button');
    const imp = s.units.find((u) => u.role === 'impostor')!;
    imp.killCooldownTicks = 3;
    endMeeting(s, map, config);
    expect(s.phase).toBe('play');
    expect(s.meeting).toBeNull();
    expect(imp.killCooldownTicks).toBe(config.rules.initialKillCooldownSec * config.tickRate);
    for (const u of s.units) expect(map.spawns.some(([sx, sy]) => sx * TS + TS / 2 === u.x && sy * TS + TS / 2 === u.y), u.name).toBe(true);
    expect(tryCallMeeting(s, p, map, config)).toBe(false); // none left
  });

  it('Enter leaves the temporary meeting placeholder (until step 4)', () => {
    const s = createGame(map, defaultSettings(), 4, config);
    const p = player(s);
    p.x = (map.button![0] + 1) * TS + TS / 2;
    p.y = map.button![1] * TS + TS / 2;
    stepSim(s, { ...NO_INPUT, usePressed: true }, map, config);
    expect(s.phase).toBe('meeting');
    stepSim(s, { ...NO_INPUT, continuePressed: true }, map, config);
    expect(s.phase).toBe('play');
  });
});

describe('player tasks by holding Use', () => {
  function atFirstStage(s: SimState): { p: Unit; needed: number } {
    const p = player(s);
    const task = p.tasks[0]!;
    const stage = nextStage(task)!;
    const spot = map.tasks.find((t) => t.id === stage.spotId)!;
    p.x = spot.pos[0] * TS + TS / 2;
    p.y = spot.pos[1] * TS + TS / 2;
    return { p, needed: stageDurationTicks(task.type, config) };
  }

  it('finds the stage in reach, fills up while held, completes, and counts for crew', () => {
    let s = createGame(map, defaultSettings(), 5, config);
    for (let seed = 6; player(s).role !== 'crew'; seed++) s = createGame(map, defaultSettings(), seed, config);
    const { p, needed } = atFirstStage(s);
    expect(reachableStage(p, map, config)?.task.id).toBe(p.tasks[0]!.id);
    const before = s.crewTasks.done;
    for (let i = 0; i < needed - 1; i++) updatePlayerTask(s, p, true, map, config);
    expect(s.playerTask?.ticks).toBe(needed - 1);
    expect(p.tasks[0]!.stages[0]!.done).toBe(false);
    updatePlayerTask(s, p, true, map, config);
    expect(p.tasks[0]!.stages[0]!.done).toBe(true);
    expect(s.playerTask).toBeNull();
    expect(s.crewTasks.done).toBe(before + 1);
    expect(s.events.some((e) => e.kind === 'taskStage')).toBe(true);
  });

  it('progress is lost when the key is released or the player walks away', () => {
    const s = createGame(map, defaultSettings(), 5, config);
    const { p } = atFirstStage(s);
    for (let i = 0; i < 10; i++) updatePlayerTask(s, p, true, map, config);
    expect(s.playerTask?.ticks).toBe(10);
    updatePlayerTask(s, p, false, map, config);
    expect(s.playerTask).toBeNull();
    for (let i = 0; i < 10; i++) updatePlayerTask(s, p, true, map, config);
    p.x += 3 * TS;
    updatePlayerTask(s, p, true, map, config);
    expect(s.playerTask).toBeNull();
  });

  it('an impostor can go through the motions but the task bar never moves', () => {
    let s = createGame(map, defaultSettings(), 0, config);
    for (let seed = 1; player(s).role !== 'impostor'; seed++) s = createGame(map, defaultSettings(), seed, config);
    const { p, needed } = atFirstStage(s);
    const before = s.crewTasks.done;
    for (let i = 0; i < needed; i++) updatePlayerTask(s, p, true, map, config);
    expect(p.tasks[0]!.stages[0]!.done).toBe(true);
    expect(s.crewTasks.done).toBe(before);
  });
});
