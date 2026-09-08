import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../config/game.json';
import { loadMap } from '../src/sim/map';
import { defaultSettings } from '../src/sim/settings';
import { createGame, NO_INPUT, stepSim, unitRegionName } from '../src/sim/sim';
import { visionRadiusPx } from '../src/sim/vision';
import { parseStoredSettings, serializeSettings } from '../src/ui/settingsStore';

const read = (f: string) => JSON.parse(readFileSync(new URL(`../assets/maps/${f}`, import.meta.url), 'utf8'));
const lobby = loadMap(read('lobby.json'));
const kestrel = loadMap(read('kestrel.json'));

describe('lobby map', () => {
  it('loads with a computer and a start pad, no button, and enough spawn tiles', () => {
    expect(lobby.name).toBe('Lobby');
    expect(lobby.playable).toBe(false);
    expect(lobby.button).toBeNull();
    expect(lobby.objects.map((o) => o.type).sort()).toEqual(['computer', 'start']);
    expect(lobby.spawns.length).toBeGreaterThanOrEqual(15);
    for (const s of lobby.spawns) expect(lobby.regionAt(s[0], s[1])?.name).toBe('Lobby');
    const computer = lobby.objects.find((o) => o.type === 'computer')!;
    expect(lobby.tileAt(computer.pos[0], computer.pos[1])).toBe('object');
    expect(lobby.isWalkable(computer.pos[0], computer.pos[1])).toBe(false);
  });

  it('Kestrel is playable and has no lobby objects', () => {
    expect(kestrel.playable).toBe(true);
    expect(kestrel.objects).toEqual([]);
    expect(kestrel.button).not.toBeNull();
  });

  it('lobby mode: everyone is crew with no tasks, and bots still mill about', () => {
    const s = createGame(lobby, { ...defaultSettings(), players: 8 }, 5, config, 'lobby');
    expect(s.mode).toBe('lobby');
    expect(s.units.length).toBe(8);
    expect(s.units.every((u) => u.role === 'crew' && u.tasks.length === 0)).toBe(true);
    expect(s.crewTasks).toEqual({ done: 0, total: 0 });
    const start = s.units.map((u) => [u.x, u.y]);
    for (let i = 0; i < config.tickRate * 15; i++) stepSim(s, NO_INPUT, lobby, config);
    const moved = s.units.filter((u, i) => u.x !== start[i]![0] || u.y !== start[i]![1]);
    expect(moved.length).toBeGreaterThan(3);
    for (const u of s.units) expect(unitRegionName(u, lobby)).toBe('Lobby');
  });
});

describe('vision radius', () => {
  it('scales with role and settings', () => {
    const base = config.vision.baseRadiusTiles * config.tileSize;
    const s = defaultSettings();
    expect(visionRadiusPx('crew', s, config)).toBeCloseTo(base);
    expect(visionRadiusPx('impostor', s, config)).toBeCloseTo(base * 1.5);
    expect(visionRadiusPx('crew', { ...s, crewVision: 2 }, config)).toBeCloseTo(base * 2);
    expect(visionRadiusPx('impostor', { ...s, impostorVision: 0.5 }, config)).toBeCloseTo(base * 0.5);
  });
});

describe('remembered settings', () => {
  it('missing or broken storage gives the defaults', () => {
    expect(parseStoredSettings(null)).toEqual({ settings: defaultSettings(), seedText: '' });
    expect(parseStoredSettings('not json')).toEqual({ settings: defaultSettings(), seedText: '' });
    expect(parseStoredSettings('42')).toEqual({ settings: defaultSettings(), seedText: '' });
  });

  it('round-trips, ignores wrong types and unknown keys, and fills in missing ones', () => {
    const stored = { settings: { ...defaultSettings(), playerName: 'Greg', players: 6, crewVision: 1.5 }, seedText: '777' };
    expect(parseStoredSettings(serializeSettings(stored))).toEqual(stored);
    const odd = parseStoredSettings(JSON.stringify({ settings: { playerName: 5, players: '9', bogus: true, impostors: 1 }, seedText: 12 }));
    expect(odd.settings.playerName).toBe('You');
    expect(odd.settings.players).toBe(10);
    expect(odd.settings.impostors).toBe(1);
    expect(odd.seedText).toBe('');
    expect('bogus' in odd.settings).toBe(false);
  });
});
