// Sight rules. Pure TypeScript.
//
// "Vision" (SPEC 4.5, as clarified by Greg 2026-09-08) is how far out the camera is zoomed: a crew
// member at 1.0x sees one screen's worth of ship around them; an impostor at 1.5x sees more. With
// the lights on, walls do not hide anything that is on screen. When the lights are sabotaged
// (Phase 4) sight shrinks to a small lit shape that walls do block; lineOfSight below is for that.
// Bots use exactly the same rules as the player.

import type { GameMap } from './map';

export interface VisionSettings {
  readonly crewVision: number;
  readonly impostorVision: number;
}

export interface VisionConfig {
  readonly canvas: { readonly width: number; readonly height: number };
  readonly vision: { readonly zoomAtOneX: number; readonly lobbyZoom: number };
}

/** Camera zoom for a role: a bigger view-distance setting means more zoomed out. */
export function cameraZoom(role: 'crew' | 'impostor', settings: VisionSettings, config: VisionConfig): number {
  const factor = role === 'impostor' ? settings.impostorVision : settings.crewVision;
  return config.vision.zoomAtOneX / factor;
}

/**
 * How far a unit can see, in pixels: half the screen diagonal at that unit's zoom, so a bot sees
 * exactly what a player with the same role would have on screen.
 */
export function visionRadiusPx(role: 'crew' | 'impostor', settings: VisionSettings, config: VisionConfig): number {
  const zoom = cameraZoom(role, settings, config);
  return Math.hypot(config.canvas.width, config.canvas.height) / 2 / zoom;
}

/** True if a point is within radius of the viewer. With the lights out, walls must not be in the way. */
export function canSee(map: GameMap, viewerX: number, viewerY: number, radius: number, x: number, y: number, lightsOut = false): boolean {
  const dx = x - viewerX;
  const dy = y - viewerY;
  if (dx * dx + dy * dy > radius * radius) return false;
  return lightsOut ? lineOfSight(map, viewerX, viewerY, x, y) : true;
}

/**
 * True if a straight line from (x0, y0) to (x1, y1), in world pixels, crosses only see-through tiles.
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
  return kind === 'floor' || kind === 'button' || kind === 'object';
}
