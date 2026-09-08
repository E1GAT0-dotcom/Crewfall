// Line of sight through the tile grid. Pure TypeScript.
// Used by bot perception, vision rendering and path checks. Walls block sight; floor does not.

import type { GameMap } from './map';

/**
 * True if a straight line from (x0, y0) to (x1, y1), in world pixels, crosses only walkable tiles.
 * Walks the grid one tile boundary at a time (a DDA), so it never skips a tile.
 */
export function lineOfSight(map: GameMap, x0: number, y0: number, x1: number, y1: number): boolean {
  const ts = map.tileSize;
  let tx = Math.floor(x0 / ts);
  let ty = Math.floor(y0 / ts);
  const endTx = Math.floor(x1 / ts);
  const endTy = Math.floor(y1 / ts);
  if (!seeThrough(map, tx, ty) || !seeThrough(map, endTx, endTy)) return false;

  const dx = x1 - x0;
  const dy = y1 - y0;
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  // Distance along the line to the next vertical / horizontal tile boundary, in units of the line length.
  const tDeltaX = stepX === 0 ? Infinity : Math.abs(ts / dx);
  const tDeltaY = stepY === 0 ? Infinity : Math.abs(ts / dy);
  let tMaxX = stepX === 0 ? Infinity : (stepX > 0 ? (tx + 1) * ts - x0 : x0 - tx * ts) / Math.abs(dx);
  let tMaxY = stepY === 0 ? Infinity : (stepY > 0 ? (ty + 1) * ts - y0 : y0 - ty * ts) / Math.abs(dy);

  let guard = map.width + map.height + 2;
  while ((tx !== endTx || ty !== endTy) && guard-- > 0) {
    if (tMaxX < tMaxY) {
      tx += stepX;
      tMaxX += tDeltaX;
    } else if (tMaxY < tMaxX) {
      ty += stepY;
      tMaxY += tDeltaY;
    } else {
      // Exactly through a corner: both neighbours must be open, or the corner blocks the view.
      if (!seeThrough(map, tx + stepX, ty) || !seeThrough(map, tx, ty + stepY)) return false;
      tx += stepX;
      ty += stepY;
      tMaxX += tDeltaX;
      tMaxY += tDeltaY;
    }
    if (!seeThrough(map, tx, ty)) return false;
  }
  return true;
}

/** Walls and the outside block sight. Floor and low objects like the emergency button do not. */
export function seeThrough(map: GameMap, tx: number, ty: number): boolean {
  const kind = map.tileAt(tx, ty);
  return kind === 'floor' || kind === 'button';
}

/** True if a point is within radius of the viewer and visible through walls. */
export function canSee(map: GameMap, viewerX: number, viewerY: number, radius: number, x: number, y: number): boolean {
  const dx = x - viewerX;
  const dy = y - viewerY;
  if (dx * dx + dy * dy > radius * radius) return false;
  return lineOfSight(map, viewerX, viewerY, x, y);
}
