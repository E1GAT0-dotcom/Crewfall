import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadMap, MapError, type MapJson } from '../src/sim/map';
import { validateMap } from '../src/sim/mapValidate';

const ASSETS = new URL('../assets/', import.meta.url);

function readJson(relative: string): unknown {
  return JSON.parse(readFileSync(new URL(relative, ASSETS), 'utf8'));
}

function kestrelJson(): MapJson {
  return readJson('maps/kestrel.json') as MapJson;
}

describe('map manifest', () => {
  it('lists Kestrel and every listed file loads', () => {
    const manifest = readJson('maps/manifest.json') as { maps: { id: string; name: string; file: string }[] };
    expect(manifest.maps.map((m) => m.id)).toContain('kestrel');
    for (const entry of manifest.maps) {
      const map = loadMap(readJson(entry.file));
      expect(map.name).toBe(entry.name);
    }
  });
});

describe('Kestrel map', () => {
  const map = loadMap(kestrelJson());

  it('has the expected size, cap and rooms', () => {
    expect(map.name).toBe('Kestrel');
    expect(map.sizeClass).toBe('medium');
    expect(map.playerCap).toBe(10);
    expect(map.impostors).toEqual({ default: 2, max: 2 });
    expect(map.tileSize).toBe(32);
    expect(map.rooms.map((r) => r.name).sort()).toEqual(
      ['Admin', 'Cafeteria', 'Comms', 'Electrical', 'Engine', 'Medbay', 'Navigation', 'O2', 'Reactor', 'Shields', 'Storage', 'Weapons'],
    );
  });

  it('follows every SPEC 6.2 design rule', () => {
    expect(validateMap(map)).toEqual([]);
  });

  it('marks Navigation and Reactor as the dead ends', () => {
    expect(map.rooms.filter((r) => r.deadEnd).map((r) => r.name).sort()).toEqual(['Navigation', 'Reactor']);
  });

  it('knows which room or corridor each tile is in', () => {
    expect(map.regionAt(31, 26)?.name).toBe('Cafeteria');
    expect(map.regionAt(8, 15)?.name).toBe('Weapons');
    expect(map.regionAt(52, 55)?.name).toBe('Reactor');
    const hallway = map.regionAt(18, 28);
    expect(hallway?.kind).toBe('corridor');
    expect(hallway?.name).toMatch(/^Corridor \d+$/);
    expect(map.regionAt(0, 0)).toBeNull();
    expect(map.regionAt(-5, 3)).toBeNull();
  });

  it('every floor tile belongs to exactly one region', () => {
    let floorTiles = 0;
    let regionTiles = 0;
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (map.isWalkable(x, y)) {
          floorTiles++;
          expect(map.regionAt(x, y)).not.toBeNull();
        } else {
          expect(map.regionAt(x, y)).toBeNull();
        }
      }
    }
    for (const r of map.regions) regionTiles += r.tileCount;
    expect(regionTiles).toBe(floorTiles);
  });

  it('walls, void and the button block walking; floor and spawn tiles allow it', () => {
    expect(map.tileAt(0, 0)).toBe('void');
    expect(map.isWalkable(0, 0)).toBe(false);
    expect(map.tileAt(26, 1)).toBe('wall');
    expect(map.isWalkable(26, 1)).toBe(false);
    expect(map.tileAt(31, 28)).toBe('button');
    expect(map.isWalkable(31, 28)).toBe(false);
    expect(map.button).toEqual([31, 28]);
    expect(map.isWalkable(31, 26)).toBe(true);
    expect(map.spawns).toContainEqual([31, 26]);
    expect(map.spawns.length).toBeGreaterThanOrEqual(map.playerCap);
    expect(map.isWalkable(-1, 5)).toBe(false);
    expect(map.isWalkable(map.width, 5)).toBe(false);
  });

  it('places every vent, panel and task spot on floor in its declared room', () => {
    for (const v of map.vents) expect(map.regionAt(v.pos[0], v.pos[1])?.name, v.id).toBe(v.room);
    for (const t of map.tasks) expect(map.regionAt(t.pos[0], t.pos[1])?.name, t.id).toBe(t.room);
    for (const list of Object.values(map.sabotage)) {
      for (const p of list) expect(map.regionAt(p.pos[0], p.pos[1])?.name).toBe(p.room);
    }
  });

  it('has task spots for all 8 task types from SPEC 7.1', () => {
    const types = new Set(map.tasks.map((t) => t.task));
    expect([...types].sort()).toEqual(
      ['align_dish', 'calibrate_power', 'clear_asteroids', 'empty_chute', 'fix_wiring', 'fuel_engines', 'swipe_card', 'upload_data'],
    );
    expect(map.tasks.filter((t) => t.task === 'fix_wiring').length).toBeGreaterThanOrEqual(3);
    expect(map.tasks.filter((t) => t.task === 'upload_data' && t.stage === 2).map((t) => t.room)).toEqual(['Admin']);
    expect(map.tasks.filter((t) => t.task === 'fuel_engines').map((t) => t.stage).sort()).toEqual([1, 2]);
  });
});

describe('walking graph', () => {
  const map = loadMap(kestrelJson());

  it('has one node per floor tile and every node is reachable', () => {
    let floorTiles = 0;
    for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) if (map.isWalkable(x, y)) floorTiles++;
    expect(map.nav.nodes.length).toBe(floorTiles);
    const seen = new Set<number>([0]);
    const stack = [0];
    while (stack.length > 0) {
      const n = stack.pop() as number;
      for (const e of map.nav.edges[n] ?? []) {
        if (!seen.has(e.to)) {
          seen.add(e.to);
          stack.push(e.to);
        }
      }
    }
    expect(seen.size).toBe(map.nav.nodes.length);
  });

  it('never cuts a wall corner diagonally', () => {
    // Cafeteria's bottom-left floor tile is (24, 34); (23, 35) is wall. No diagonal edge may join them or
    // any other floor pair whose shared corner is walled off.
    for (const n of map.nav.nodes) {
      for (const e of map.nav.edges[n.id] ?? []) {
        const m = map.nav.nodes[e.to];
        if (!m) throw new Error('bad edge');
        const dx = m.x - n.x;
        const dy = m.y - n.y;
        expect(Math.abs(dx)).toBeLessThanOrEqual(1);
        expect(Math.abs(dy)).toBeLessThanOrEqual(1);
        if (dx !== 0 && dy !== 0) {
          expect(map.isWalkable(n.x + dx, n.y)).toBe(true);
          expect(map.isWalkable(n.x, n.y + dy)).toBe(true);
          expect(e.length).toBeCloseTo(Math.SQRT2);
        } else {
          expect(e.length).toBe(1);
        }
      }
    }
  });

  it('nodeAt agrees with the tile grid', () => {
    expect(map.nav.nodeAt(31, 26)).toBeGreaterThanOrEqual(0);
    expect(map.nav.nodeAt(31, 28)).toBe(-1);
    expect(map.nav.nodeAt(0, 0)).toBe(-1);
    const id = map.nav.nodeAt(8, 15);
    expect(map.nav.nodes[id]?.region).toBe(map.regionByName('Weapons')?.id);
  });
});

describe('map rule checker catches mistakes', () => {
  const setTile = (json: MapJson, x: number, y: number, ch: string) => {
    const row = json.tiles[y] as string;
    json.tiles[y] = row.slice(0, x) + ch + row.slice(x + 1);
  };

  it('still passes when one corridor is bricked up, because every room sits on more than one loop', () => {
    const json = kestrelJson();
    // Wall off the Comms <-> Cafeteria corridor at x = 18, all three rows.
    for (const y of [27, 28, 29]) setTile(json, 18, y, '#');
    const problems = validateMap(loadMap(json));
    expect(problems.filter((p) => p.includes('Only one route'))).toEqual([]);
  });

  it('reports a room with only one route when two corridors are bricked up', () => {
    const json = kestrelJson();
    // Wall off Weapons <-> Comms (row 22) and Comms <-> O2 (row 35). Comms is left with one way in.
    for (const x of [8, 9, 10]) setTile(json, x, 22, '#');
    for (const x of [7, 8, 9]) setTile(json, x, 35, '#');
    const problems = validateMap(loadMap(json));
    const routeProblems = problems.filter((p) => p.includes('Only one route'));
    expect(routeProblems.length).toBeGreaterThan(0);
    expect(routeProblems.some((p) => p.includes('cuts Comms off'))).toBe(true);
  });

  it('reports a room without a task spot', () => {
    const json = kestrelJson();
    json.tasks = (json.tasks ?? []).filter((t) => t.room !== 'Weapons');
    const problems = validateMap(loadMap(json));
    expect(problems).toContain('Room "Weapons" has no task spot. Every room needs at least one (SPEC 6.2).');
  });

  it('reports a task spot placed on a wall or in the wrong room', () => {
    const json = kestrelJson();
    const first = (json.tasks ?? [])[0];
    if (!first) throw new Error('no tasks');
    first.pos = [0, 0];
    const problems = validateMap(loadMap(json));
    expect(problems.some((p) => p.includes(`Task spot "${first.id}"`) && p.includes('not on a floor tile'))).toBe(true);
  });

  it('reports floor that is cut off from the rest of the ship', () => {
    const json = kestrelJson();
    setTile(json, 0, 0, '.');
    const problems = validateMap(loadMap(json));
    expect(problems.some((p) => p.includes('cut off'))).toBe(true);
  });

  it('rejects a broken file with a plain-language error', () => {
    const json = kestrelJson();
    json.tiles[3] = (json.tiles[3] as string) + '.';
    expect(() => loadMap(json)).toThrow(MapError);
    expect(() => loadMap(json)).toThrow(/row 3/);

    const bad = kestrelJson();
    setTile(bad, 5, 5, '?');
    expect(() => loadMap(bad)).toThrow(/Unknown tile character/);

    // A missing button loads (the lobby has none) but the rule checker flags it for a playable map.
    const noButton = kestrelJson();
    setTile(noButton, 31, 28, '.');
    const loaded = loadMap(noButton);
    expect(loaded.button).toBeNull();
    expect(validateMap(loaded).some((p) => p.includes('emergency button'))).toBe(true);
    const twoButtons = kestrelJson();
    setTile(twoButtons, 30, 28, 'B');
    expect(() => loadMap(twoButtons)).toThrow(/at most one/);
  });
});
