import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadMap } from '../src/sim/map';
import { findPath, pathLength } from '../src/sim/pathfinding';
import { Rng, seedFromText } from '../src/sim/rng';
import { clampSettings, defaultSettings } from '../src/sim/settings';
import { buildTaskList, chooseCommonTypes, TASK_TYPES } from '../src/sim/tasks';
import { canSee, lineOfSight } from '../src/sim/vision';

const map = loadMap(JSON.parse(readFileSync(new URL('../assets/maps/kestrel.json', import.meta.url), 'utf8')));
const TS = map.tileSize;
const centre = (tx: number, ty: number) => [tx * TS + TS / 2, ty * TS + TS / 2] as const;

describe('seeded random numbers', () => {
  it('same seed, same sequence; different seed, different sequence', () => {
    const a = new Rng(123);
    const b = new Rng(123);
    const c = new Rng(124);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    const seqC = Array.from({ length: 20 }, () => c.next());
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
  });

  it('stays in range and is roughly uniform', () => {
    const rng = new Rng(9);
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 20000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      buckets[Math.floor(v * 10)]++;
    }
    for (const b of buckets) expect(b).toBeGreaterThan(1600);
    for (let i = 0; i < 1000; i++) {
      const n = rng.int(3, 7);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(7);
    }
  });

  it('shuffle keeps every item exactly once', () => {
    const rng = new Rng(5);
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = rng.shuffle(items);
    expect(out.slice().sort((a, b) => a - b)).toEqual(items);
    expect(items).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); // original untouched
  });

  it('turns text into a stable seed', () => {
    expect(seedFromText('12345')).toBe(12345);
    expect(seedFromText('kestrel')).toBe(seedFromText('kestrel'));
    expect(seedFromText('kestrel')).not.toBe(seedFromText('kestrle'));
  });
});

describe('path-finding', () => {
  it('finds a path between distant rooms that stays on floor and never cuts corners', () => {
    const path = findPath(map, [30, 4], [52, 55]); // Navigation to Reactor
    expect(path).not.toBeNull();
    const p = path!;
    expect(p[0]).toEqual([30, 4]);
    expect(p[p.length - 1]).toEqual([52, 55]);
    for (let i = 0; i < p.length; i++) {
      const [x, y] = p[i]!;
      expect(map.isWalkable(x, y)).toBe(true);
      if (i > 0) {
        const [px, py] = p[i - 1]!;
        const dx = x - px;
        const dy = y - py;
        expect(Math.max(Math.abs(dx), Math.abs(dy))).toBe(1);
        if (dx !== 0 && dy !== 0) {
          expect(map.isWalkable(px + dx, py)).toBe(true);
          expect(map.isWalkable(px, py + dy)).toBe(true);
        }
      }
    }
  });

  it('takes the short way round, not a long detour', () => {
    // Comms to Cafeteria is a straight corridor: about 18 tiles.
    const path = findPath(map, [10, 28], [26, 28])!;
    expect(pathLength(path)).toBeLessThan(18);
    expect(pathLength(path)).toBeGreaterThanOrEqual(16);
  });

  it('returns null for unreachable or non-floor tiles, and a single step for start = goal', () => {
    expect(findPath(map, [0, 0], [30, 28])).toBeNull();
    expect(findPath(map, [31, 28], [30, 28])).toBeNull(); // the button tile
    expect(findPath(map, [30, 28], [30, 28])).toEqual([[30, 28]]);
  });
});

describe('line of sight', () => {
  it('sees along an open corridor and across a room', () => {
    const [ax, ay] = centre(15, 14);
    const [bx, by] = centre(48, 14);
    expect(lineOfSight(map, ax, ay, bx, by)).toBe(true);
    const [cx, cy] = centre(24, 23);
    const [dx, dy] = centre(39, 34);
    expect(lineOfSight(map, cx, cy, dx, dy)).toBe(true);
  });

  it('is blocked by walls between rooms', () => {
    const [ax, ay] = centre(8, 15); // Weapons
    const [bx, by] = centre(8, 28); // Comms, directly below with wall and corridor between
    // The corridor between Weapons and Comms is at x 8..10, so this line is actually open: check a walled pair instead.
    expect(lineOfSight(map, ax, ay, bx, by)).toBe(true);
    const [cx, cy] = centre(5, 15); // Weapons, left side
    const [dx, dy] = centre(5, 28); // Comms, left side: solid wall at row 20..24 for x = 5
    expect(lineOfSight(map, cx, cy, dx, dy)).toBe(false);
  });

  it('canSee respects the radius', () => {
    const [ax, ay] = centre(15, 14);
    const [bx, by] = centre(48, 14);
    expect(canSee(map, ax, ay, 5 * TS, bx, by)).toBe(false);
    expect(canSee(map, ax, ay, 40 * TS, bx, by)).toBe(true);
    expect(canSee(map, ax, ay, 2 * TS, ax + TS, ay)).toBe(true);
  });
});

describe('task lists', () => {
  it('builds the requested counts with a shared common type', () => {
    const rng = new Rng(3);
    const common = chooseCommonTypes(rng, 1);
    expect(common.length).toBe(1);
    expect(TASK_TYPES.common).toContain(common[0]);
    const tasks = buildTaskList(map, rng, common, { common: 1, long: 2, short: 3 }, 0);
    expect(tasks.length).toBe(6);
    expect(tasks.filter((t) => t.kind === 'long').map((t) => t.type).sort()).toEqual(['fuel_engines', 'upload_data']);
    for (const t of tasks) {
      expect(t.stages.length).toBeGreaterThan(0);
      for (const s of t.stages) expect(map.tasks.some((spot) => spot.id === s.spotId)).toBe(true);
    }
    const wiring = tasks.find((t) => t.type === 'fix_wiring');
    if (wiring) {
      expect(wiring.stages.length).toBe(3);
      const rooms = wiring.stages.map((s) => map.tasks.find((spot) => spot.id === s.spotId)?.room);
      expect(new Set(rooms).size).toBe(3);
    }
    const twoStage = tasks.filter((t) => t.kind === 'long');
    for (const t of twoStage) {
      expect(map.tasks.find((s) => s.id === t.stages[0]?.spotId)?.stage).toBe(1);
      expect(map.tasks.find((s) => s.id === t.stages[1]?.spotId)?.stage).toBe(2);
    }
  });

  it('repeats types when more tasks are asked for than there are types', () => {
    const tasks = buildTaskList(map, new Rng(8), [], { common: 0, long: 0, short: 5 }, 1);
    expect(tasks.length).toBe(5);
  });
});

describe('settings', () => {
  it('clamps to the spec ranges and map caps', () => {
    const s = clampSettings({ ...defaultSettings(), players: 50, impostors: 9, killCooldownSec: 5, playerName: '   ' }, { playerCap: 10, impostorMax: 2 });
    expect(s.players).toBe(10);
    expect(s.impostors).toBe(2);
    expect(s.killCooldownSec).toBe(10);
    expect(s.playerName).toBe('You');
    const tiny = clampSettings({ ...defaultSettings(), players: 4, impostors: 2 }, { playerCap: 10, impostorMax: 2 });
    expect(tiny.impostors).toBe(1);
  });
});
