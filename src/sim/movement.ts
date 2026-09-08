// Movement and wall collision. Pure TypeScript, no Phaser.
//
// A unit is a circle (centre x, y in pixels; radius r). Walls are the map's non-walkable tiles.
// Movement is resolved one axis at a time: move along x, push out of any wall; then y. This is
// the classic approach for tile maps and gives natural sliding along walls.

import type { GameMap } from './map';

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/** Turns raw key state into a unit-length direction so diagonals are not faster. */
export function normalizeDirection(dx: number, dy: number): Vec2 {
  const len = Math.hypot(dx, dy);
  if (len === 0) return { x: 0, y: 0 };
  return { x: dx / len, y: dy / len };
}

/** True if a circle at (cx, cy) with radius r overlaps any non-walkable tile. */
export function circleHitsWall(map: GameMap, cx: number, cy: number, r: number): boolean {
  const ts = map.tileSize;
  const x0 = Math.floor((cx - r) / ts);
  const x1 = Math.floor((cx + r) / ts);
  const y0 = Math.floor((cy - r) / ts);
  const y1 = Math.floor((cy + r) / ts);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (map.isWalkable(tx, ty)) continue;
      if (circleOverlapsTile(cx, cy, r, tx * ts, ty * ts, ts)) return true;
    }
  }
  return false;
}

function circleOverlapsTile(cx: number, cy: number, r: number, tileX: number, tileY: number, ts: number): boolean {
  const nearestX = Math.max(tileX, Math.min(cx, tileX + ts));
  const nearestY = Math.max(tileY, Math.min(cy, tileY + ts));
  const dx = cx - nearestX;
  const dy = cy - nearestY;
  return dx * dx + dy * dy < r * r;
}

/**
 * Moves the circle by (dx, dy) pixels, stopping at walls on each axis separately.
 * Returns the new centre. Never lets the circle end up inside a wall it was not already in.
 */
export function moveWithCollision(map: GameMap, from: Vec2, dx: number, dy: number, r: number): Vec2 {
  let x = from.x;
  let y = from.y;
  x = sweepAxis(map, x, y, r, dx, true);
  y = sweepAxis(map, x, y, r, dy, false);
  return { x, y };
}

/**
 * Slides along one axis in sub-steps no larger than the radius, so fast movement cannot tunnel
 * through a thin wall. Stops at the last free position before contact.
 */
function sweepAxis(map: GameMap, x: number, y: number, r: number, delta: number, horizontal: boolean): number {
  if (delta === 0) return horizontal ? x : y;
  const maxStep = Math.max(1, r * 0.5);
  const steps = Math.ceil(Math.abs(delta) / maxStep);
  const start = horizontal ? x : y;
  const hits = (p: number) => (horizontal ? circleHitsWall(map, p, y, r) : circleHitsWall(map, x, p, r));
  let pos = start;
  for (let i = 1; i <= steps; i++) {
    const next = start + (delta * i) / steps;
    if (hits(next)) {
      // Creep the remaining distance in 1 px increments so the unit rests flush against the wall.
      const dir = Math.sign(delta);
      let creep = pos;
      for (let px = 0; px < Math.abs(next - pos); px++) {
        if (hits(creep + dir)) break;
        creep += dir;
      }
      return creep;
    }
    pos = next;
  }
  return start + delta; // no wall touched: land exactly where asked, no rounding drift
}
