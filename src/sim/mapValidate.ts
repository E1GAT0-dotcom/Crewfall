// Design-rule checks for a loaded map (SPEC.md 6.2). Returns plain-language problems.
// An empty list means the map follows every rule. Pure TypeScript.

import type { GameMap, Region, TilePos } from './map';

export function validateMap(map: GameMap): string[] {
  const problems: string[] = [];
  const add = (p: string) => problems.push(p);
  const at = ([x, y]: TilePos) => `(${x}, ${y})`;

  // --- spawn room and button ---
  const buttonRegion = neighbouringRoom(map, map.button);
  if (!buttonRegion) add(`The emergency button at ${at(map.button)} is not inside a room.`);
  if (map.spawns.length < map.playerCap) {
    add(`Only ${map.spawns.length} spawn tiles "S" but playerCap is ${map.playerCap}. Every player needs a spawn tile.`);
  }
  for (const s of map.spawns) {
    const r = map.regionAt(s[0], s[1]);
    if (!r || r.kind !== 'room') add(`Spawn tile at ${at(s)} is not inside a room.`);
    else if (buttonRegion && r.id !== buttonRegion.id) add(`Spawn tile at ${at(s)} is in ${r.name} but the button is in ${buttonRegion.name}. Everyone spawns in the button room.`);
  }

  // --- rooms ---
  const rooms = map.rooms;
  for (const r of rooms) {
    if (r.tileCount === 0) add(`Room "${r.name}" has no floor tiles inside its rect.`);
  }
  const deadEnds = rooms.filter((r) => r.deadEnd);
  if (deadEnds.length < 1 || deadEnds.length > 2) {
    add(`SPEC 6.2 wants 1-2 dead-end rooms; ${deadEnds.length} are marked deadEnd.`);
  }

  // --- everything walkable is one connected piece ---
  const nav = map.nav;
  if (nav.nodes.length > 0) {
    const seen = new Uint8Array(nav.nodes.length);
    const stack = [0];
    seen[0] = 1;
    let count = 0;
    while (stack.length > 0) {
      const n = stack.pop() as number;
      count++;
      for (const e of nav.edges[n] as readonly { to: number }[]) {
        if (!seen[e.to]) {
          seen[e.to] = 1;
          stack.push(e.to);
        }
      }
    }
    if (count !== nav.nodes.length) {
      const orphan = nav.nodes.find((n) => !seen[n.id]);
      add(`Some floor is cut off from the rest: ${nav.nodes.length - count} tiles cannot be reached, for example (${orphan?.x}, ${orphan?.y}).`);
    }
  }

  // --- two routes between every pair of non-dead-end rooms ---
  const adjacency = regionAdjacency(map);
  const loopRooms = rooms.filter((r) => !r.deadEnd);
  for (const r of deadEnds) {
    const links = adjacency.get(r.id) ?? new Set<number>();
    if (links.size === 0) add(`Dead-end room "${r.name}" has no way in at all.`);
  }
  for (const removed of map.regions) {
    const remaining = loopRooms.filter((r) => r.id !== removed.id);
    if (remaining.length < 2) continue;
    const reached = reachable(adjacency, (remaining[0] as Region).id, removed.id);
    const missing = remaining.filter((r) => !reached.has(r.id));
    if (missing.length > 0) {
      const names = missing.map((r) => r.name).join(', ');
      add(`Only one route: closing off "${removed.name}" cuts ${names} off from ${(remaining[0] as Region).name}. Non-dead-end rooms need two distinct routes (SPEC 6.2).`);
    }
  }

  // --- task spots ---
  const taskIds = new Set<string>();
  const roomsWithTasks = new Set<string>();
  for (const t of map.tasks) {
    if (taskIds.has(t.id)) add(`Two task spots share the id "${t.id}".`);
    taskIds.add(t.id);
    checkSpot(map, `Task spot "${t.id}"`, t.pos, t.room, add);
    roomsWithTasks.add(t.room);
  }
  for (const r of rooms) {
    if (!roomsWithTasks.has(r.name)) add(`Room "${r.name}" has no task spot. Every room needs at least one (SPEC 6.2).`);
  }

  // --- vents ---
  const ventIds = new Set<string>();
  const networks = new Map<number, string[]>();
  for (const v of map.vents) {
    if (ventIds.has(v.id)) add(`Two vents share the id "${v.id}".`);
    ventIds.add(v.id);
    checkSpot(map, `Vent "${v.id}"`, v.pos, v.room, add);
    const list = networks.get(v.network) ?? [];
    list.push(v.room);
    networks.set(v.network, list);
  }
  if (networks.size < 2 || networks.size > 4) add(`SPEC 6.2 wants 2-4 vent networks; found ${networks.size}.`);
  for (const [net, roomNames] of networks) {
    if (roomNames.length < 2 || roomNames.length > 3) add(`Vent network ${net} has ${roomNames.length} vents; SPEC 6.2 wants 2-3.`);
    if (new Set(roomNames).size !== roomNames.length) add(`Vent network ${net} has two vents in the same room.`);
  }

  // --- sabotage panels ---
  const sab = map.sabotage;
  if (sab.lights.length < 1) add('Lights sabotage needs at least one panel.');
  if (sab.reactor.length !== 2) add(`Reactor sabotage needs exactly 2 panels; found ${sab.reactor.length}.`);
  if (sab.o2.length !== 2) add(`O2 sabotage needs exactly 2 panels; found ${sab.o2.length}.`);
  else if (sab.o2[0]?.room === sab.o2[1]?.room) add('The two O2 panels must be in different rooms (SPEC 6.2).');
  if (sab.comms.length < 1) add('Comms sabotage needs at least one panel.');
  for (const kind of ['lights', 'reactor', 'o2', 'comms'] as const) {
    sab[kind].forEach((p, i) => checkSpot(map, `${kind} panel ${i + 1}`, p.pos, p.room, add));
  }

  // --- doors ---
  for (const d of map.doors) {
    const room = map.regionByName(d.room);
    if (!room || room.kind !== 'room') {
      add(`Door group names room "${d.room}" which does not exist.`);
      continue;
    }
    if (d.tiles.length === 0) add(`Door group for "${d.room}" has no tiles.`);
    for (const t of d.tiles) {
      if (!map.isWalkable(t[0], t[1])) add(`Door tile ${at(t)} for "${d.room}" is not a floor tile.`);
      else if (!touchesRoom(map, t, room)) add(`Door tile ${at(t)} for "${d.room}" does not touch that room.`);
    }
  }

  return problems;
}

/** A spot must be a floor tile, and its declared room must be the room it is actually in. */
function checkSpot(map: GameMap, label: string, pos: TilePos, room: string, add: (p: string) => void) {
  if (!map.isWalkable(pos[0], pos[1])) {
    add(`${label} at (${pos[0]}, ${pos[1]}) is not on a floor tile.`);
    return;
  }
  const actual = map.regionAt(pos[0], pos[1]);
  if (!actual || actual.name !== room) {
    add(`${label} says it is in "${room}" but its tile (${pos[0]}, ${pos[1]}) is in "${actual?.name ?? 'nothing'}".`);
  }
}

function touchesRoom(map: GameMap, [x, y]: TilePos, room: Region): boolean {
  return ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).some(([dx, dy]) => map.regionAt(x + dx, y + dy)?.id === room.id);
}

/** For a non-walkable marker like the button: the room of any walkable neighbour. */
function neighbouringRoom(map: GameMap, [x, y]: TilePos): Region | null {
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const r = map.regionAt(x + dx, y + dy);
    if (r && r.kind === 'room') return r;
  }
  return null;
}

/** Which regions touch which: two regions are linked if a floor tile of one is beside a floor tile of the other. */
export function regionAdjacency(map: GameMap): Map<number, Set<number>> {
  const adj = new Map<number, Set<number>>();
  for (const r of map.regions) adj.set(r.id, new Set());
  for (const n of map.nav.nodes) {
    for (const e of map.nav.edges[n.id] as readonly { to: number }[]) {
      const other = map.nav.nodes[e.to] as { region: number };
      if (other.region !== n.region) {
        adj.get(n.region)?.add(other.region);
        adj.get(other.region)?.add(n.region);
      }
    }
  }
  return adj;
}

function reachable(adj: Map<number, Set<number>>, from: number, blocked: number): Set<number> {
  const seen = new Set<number>([from]);
  const stack = [from];
  while (stack.length > 0) {
    const cur = stack.pop() as number;
    for (const next of adj.get(cur) ?? []) {
      if (next === blocked || seen.has(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  return seen;
}
