// Vents (SPEC 8). Pure TypeScript, shared by the player's input and the impostor bots.
//
// A vent is a floor grate in a room. Impostors standing next to one may climb in; inside, they are
// hidden from everyone, cannot act, and may hop to any other vent of the same network (the map file
// groups vents by "network"). Climbing out puts them beside that vent. Crew never use vents.
// Every climb in and out is an event other units can witness (src/bots/memory.ts); a hop is silent.

import type { GameMap, Vent } from './map';
import type { SimConfig, SimState, Unit } from './sim';

export function ventCentre(vent: Vent, map: GameMap): { x: number; y: number } {
  const half = map.tileSize / 2;
  return { x: vent.pos[0] * map.tileSize + half, y: vent.pos[1] * map.tileSize + half };
}

export function ventById(map: GameMap, id: string): Vent | null {
  return map.vents.find((v) => v.id === id) ?? null;
}

/** The other vents a vent connects to: every vent of the same network but itself. */
export function ventNeighbours(map: GameMap, vent: Vent): Vent[] {
  return map.vents.filter((v) => v.network === vent.network && v.id !== vent.id);
}

/** The nearest vent within reach of the unit, or null. */
export function ventInReach(unit: { x: number; y: number }, map: GameMap, config: SimConfig): Vent | null {
  const range = config.rules.ventRangeTiles * map.tileSize;
  let best: Vent | null = null;
  let bestDist = Infinity;
  for (const v of map.vents) {
    const c = ventCentre(v, map);
    const d = Math.hypot(c.x - unit.x, c.y - unit.y);
    if (d <= range && d < bestDist) {
      best = v;
      bestDist = d;
    }
  }
  return best;
}

/** Only a living impostor during play may use vents. */
export function canUseVents(state: SimState, unit: Unit): boolean {
  return state.mode === 'game' && state.phase === 'play' && unit.alive && unit.role === 'impostor';
}

/** Climbs into the nearest vent in reach. The unit snaps onto the grate and disappears. */
export function tryEnterVent(state: SimState, unit: Unit, map: GameMap, config: SimConfig): boolean {
  if (!canUseVents(state, unit) || unit.inVent !== null) return false;
  const vent = ventInReach(unit, map, config);
  if (!vent) return false;
  const c = ventCentre(vent, map);
  unit.x = c.x;
  unit.y = c.y;
  unit.moving = false;
  unit.inVent = vent.id;
  if (state.playerTask && unit.isPlayer) state.playerTask = null;
  state.events.push({ kind: 'ventEnter', unitId: unit.id, ventId: vent.id, x: c.x, y: c.y });
  return true;
}

/** Climbs out of the vent the unit is in, appearing on the grate. */
export function tryExitVent(state: SimState, unit: Unit, map: GameMap): boolean {
  if (unit.inVent === null) return false;
  const vent = ventById(map, unit.inVent);
  unit.inVent = null;
  if (!vent) return true;
  const c = ventCentre(vent, map);
  unit.x = c.x;
  unit.y = c.y;
  unit.moving = false;
  state.events.push({ kind: 'ventExit', unitId: unit.id, ventId: vent.id, x: c.x, y: c.y });
  return true;
}

/**
 * The connected vent that lies most in a direction (each axis -1..1) from a vent, or null if none
 * lies even roughly that way. Pressing right picks the vent most to the right, and so on.
 */
export function ventInDirection(map: GameMap, from: Vent, dx: number, dy: number): Vent | null {
  const len = Math.hypot(dx, dy);
  if (len === 0) return null;
  const ux = dx / len;
  const uy = dy / len;
  const origin = ventCentre(from, map);
  let best: Vent | null = null;
  let bestScore = 0.2; // must be at least a little in that direction
  for (const v of ventNeighbours(map, from)) {
    const c = ventCentre(v, map);
    const vx = c.x - origin.x;
    const vy = c.y - origin.y;
    const d = Math.hypot(vx, vy) || 1;
    const score = (vx / d) * ux + (vy / d) * uy;
    if (score > bestScore) {
      best = v;
      bestScore = score;
    }
  }
  return best;
}

/** Moves a unit inside the vents to another vent of the same network. Silent: nobody can see it. */
export function hopToVent(state: SimState, unit: Unit, to: Vent, map: GameMap): boolean {
  if (unit.inVent === null || state.phase !== 'play') return false;
  const from = ventById(map, unit.inVent);
  if (!from || from.network !== to.network || from.id === to.id) return false;
  const c = ventCentre(to, map);
  unit.x = c.x;
  unit.y = c.y;
  unit.inVent = to.id;
  state.events.push({ kind: 'ventHop', unitId: unit.id, fromVentId: from.id, toVentId: to.id });
  return true;
}

/** The player's way of hopping: a direction press picks the vent that way. */
export function tryVentHop(state: SimState, unit: Unit, dx: number, dy: number, map: GameMap): boolean {
  if (unit.inVent === null) return false;
  const from = ventById(map, unit.inVent);
  if (!from) return false;
  const to = ventInDirection(map, from, dx, dy);
  return to ? hopToVent(state, unit, to, map) : false;
}
