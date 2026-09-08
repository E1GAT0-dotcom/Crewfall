import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadMap } from '../src/sim/map';
import { circleHitsWall, moveWithCollision, normalizeDirection } from '../src/sim/movement';

const map = loadMap(JSON.parse(readFileSync(new URL('../assets/maps/kestrel.json', import.meta.url), 'utf8')));
const TS = map.tileSize;
const R = 11;
const centre = (tx: number, ty: number) => ({ x: tx * TS + TS / 2, y: ty * TS + TS / 2 });

describe('normalizeDirection', () => {
  it('keeps diagonals the same speed as straight lines', () => {
    const d = normalizeDirection(1, 1);
    expect(Math.hypot(d.x, d.y)).toBeCloseTo(1);
    expect(normalizeDirection(0, 0)).toEqual({ x: 0, y: 0 });
    expect(normalizeDirection(-1, 0)).toEqual({ x: -1, y: 0 });
  });
});

describe('wall collision', () => {
  it('a unit in open floor touches nothing', () => {
    const p = centre(31, 26); // a Cafeteria spawn tile
    expect(circleHitsWall(map, p.x, p.y, R)).toBe(false);
  });

  it('a unit overlapping a wall is detected', () => {
    // Cafeteria's left wall is column 23 at rows 23..34.
    const p = centre(24, 25);
    expect(circleHitsWall(map, p.x - TS / 2, p.y, R)).toBe(true);
  });

  it('walking into a wall stops flush against it, never inside it', () => {
    const start = centre(24, 25); // leftmost Cafeteria tile, wall to the left
    const end = moveWithCollision(map, start, -200, 0, R);
    expect(end.y).toBe(start.y);
    // Wall's right edge is at x = 24 * TS. The unit's left edge must sit at or after it.
    expect(end.x - R).toBeGreaterThanOrEqual(24 * TS);
    expect(end.x - R).toBeLessThan(24 * TS + 2);
    expect(circleHitsWall(map, end.x, end.y, R)).toBe(false);
  });

  it('slides along a wall when moving diagonally into it', () => {
    const start = centre(24, 25);
    const end = moveWithCollision(map, start, -50, 40, R);
    expect(end.y).toBeCloseTo(start.y + 40);
    expect(end.x - R).toBeGreaterThanOrEqual(24 * TS);
  });

  it('cannot tunnel through a wall with a huge step', () => {
    const start = centre(24, 25);
    const end = moveWithCollision(map, start, -5000, 0, R);
    expect(end.x).toBeGreaterThan(24 * TS);
  });

  it('cannot cut through the corner of a doorway', () => {
    // Cafeteria's bottom opening is columns 30..32 at row 34, corridor below at rows 35..39.
    // Standing at the corner tile (29, 34) beside the opening and pushing down-right must not pass through wall (29, 35).
    const start = centre(29, 34);
    const end = moveWithCollision(map, start, 0, 40, R);
    expect(end.y + R).toBeLessThanOrEqual(35 * TS);
  });

  it('moves freely through open corridor', () => {
    const start = centre(20, 28); // Comms <-> Cafeteria corridor, middle row
    const end = moveWithCollision(map, start, 96, 0, R);
    expect(end).toEqual({ x: start.x + 96, y: start.y });
  });
});
