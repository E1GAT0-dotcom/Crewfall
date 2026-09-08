// Map loading: turns a map JSON file into a queryable GameMap.
// Pure TypeScript. No Phaser here (docs/CONVENTIONS.md: src/sim has no rendering code).
//
// The map file format is documented in the "_help" field of assets/maps/kestrel.json.

export type TilePos = readonly [number, number];
/** 'object' is solid furniture (a console, a pad): blocks walking, not sight. */
export type TileKind = 'void' | 'wall' | 'floor' | 'button' | 'object';
export type RegionKind = 'room' | 'corridor';

/** Rectangle in tile units: x, y of the top-left tile, then width and height. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface Panel {
  readonly room: string;
  readonly pos: TilePos;
}

/** Shape of the JSON on disk. Kept loose on purpose: loadMap validates it. */
export interface MapJson {
  name: string;
  sizeClass: 'small' | 'medium' | 'large';
  playerCap: number;
  impostors: { default: number; max: number };
  tileSize: number;
  tiles: string[];
  rooms: { name: string; rect: [number, number, number, number]; deadEnd?: boolean }[];
  vents?: { id: string; room: string; pos: [number, number]; network: number }[];
  sabotage?: { lights: Panel[]; reactor: Panel[]; o2: Panel[]; comms: Panel[] };
  doors?: { room: string; tiles: [number, number][] }[];
  tasks?: { id: string; task: string; stage?: number; room: string; pos: [number, number] }[];
  objects?: { id: string; type: string; room: string; pos: [number, number]; size?: [number, number] }[];
  playable?: boolean;
}

/** Something usable in the world that is not a task, vent or panel: the lobby computer, the start pad. */
export interface MapObject {
  readonly id: string;
  readonly type: string;
  readonly room: string;
  /** Top-left tile. */
  readonly pos: TilePos;
  /** Size in tiles; defaults to 1 x 1. */
  readonly size: readonly [number, number];
}

/** A room, or a stretch of corridor between rooms. Every walkable tile belongs to exactly one. */
export interface Region {
  readonly id: number;
  readonly name: string;
  readonly kind: RegionKind;
  readonly deadEnd: boolean;
  readonly tileCount: number;
  /** Only rooms have a declared rectangle; corridors are whatever floor is left over. */
  readonly rect: Rect | null;
}

export interface Vent {
  readonly id: string;
  readonly room: string;
  readonly pos: TilePos;
  readonly network: number;
}

export interface DoorGroup {
  readonly room: string;
  readonly tiles: readonly TilePos[];
}

export interface TaskSpot {
  readonly id: string;
  readonly task: string;
  /** 1 or 2 for two-stage tasks, undefined for single-stage and wiring panels. */
  readonly stage: number | undefined;
  readonly room: string;
  readonly pos: TilePos;
}

export interface SabotagePanels {
  readonly lights: readonly Panel[];
  readonly reactor: readonly Panel[];
  readonly o2: readonly Panel[];
  readonly comms: readonly Panel[];
}

/** Walking graph. One node per walkable tile; edges to walkable neighbours. */
export interface NavNode {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly region: number;
}

export interface NavEdge {
  readonly to: number;
  /** Edge length in tiles: 1 for straight, about 1.414 for diagonal. */
  readonly length: number;
}

export interface NavGraph {
  readonly nodes: readonly NavNode[];
  /** edges[nodeId] lists that node's neighbours. */
  readonly edges: readonly (readonly NavEdge[])[];
  /** Node id at a tile, or -1 if the tile is not walkable. */
  nodeAt(x: number, y: number): number;
}

export interface GameMap {
  readonly name: string;
  readonly sizeClass: 'small' | 'medium' | 'large';
  readonly playerCap: number;
  readonly impostors: { readonly default: number; readonly max: number };
  readonly tileSize: number;
  readonly width: number;
  readonly height: number;
  readonly regions: readonly Region[];
  readonly rooms: readonly Region[];
  readonly spawns: readonly TilePos[];
  /** The emergency button tile. Playable maps have one; the lobby has none. */
  readonly button: TilePos | null;
  readonly vents: readonly Vent[];
  readonly sabotage: SabotagePanels;
  readonly doors: readonly DoorGroup[];
  readonly tasks: readonly TaskSpot[];
  readonly objects: readonly MapObject[];
  /** False for the lobby. */
  readonly playable: boolean;
  readonly nav: NavGraph;
  tileAt(x: number, y: number): TileKind;
  isWalkable(x: number, y: number): boolean;
  regionAt(x: number, y: number): Region | null;
  regionByName(name: string): Region | null;
}

export class MapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MapError';
  }
}

const TILE_CHARS: Record<string, TileKind> = {
  '#': 'wall',
  '.': 'floor',
  ' ': 'void',
  S: 'floor',
  B: 'button',
  O: 'object',
};

const SQRT2 = Math.SQRT2;

function fail(msg: string): never {
  throw new MapError(msg);
}

function isPos(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && Number.isInteger(v[0]) && Number.isInteger(v[1]);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Checks the raw JSON has the right shape. Throws MapError with a plain-language message. */
export function checkMapJson(raw: unknown): MapJson {
  if (!isRecord(raw)) fail('Map file is not a JSON object.');
  const m = raw;
  if (typeof m.name !== 'string' || m.name.length === 0) fail('Map needs a "name".');
  if (m.sizeClass !== 'small' && m.sizeClass !== 'medium' && m.sizeClass !== 'large') {
    fail(`Map "sizeClass" must be small, medium or large.`);
  }
  if (!Number.isInteger(m.playerCap) || (m.playerCap as number) < 4) fail('Map "playerCap" must be a whole number of at least 4.');
  if (!isRecord(m.impostors) || !Number.isInteger(m.impostors.default) || !Number.isInteger(m.impostors.max)) {
    fail('Map "impostors" needs whole-number "default" and "max".');
  }
  if (m.tileSize !== 32) fail('Map "tileSize" must be 32 (fixed by SPEC 13).');
  if (!Array.isArray(m.tiles) || m.tiles.length === 0 || !m.tiles.every((r) => typeof r === 'string')) {
    fail('Map "tiles" must be a list of text rows.');
  }
  const width = (m.tiles[0] as string).length;
  (m.tiles as string[]).forEach((row, y) => {
    if (row.length !== width) fail(`Tile row ${y} has ${row.length} characters but row 0 has ${width}. Every row must be the same length.`);
    for (let x = 0; x < row.length; x++) {
      const ch = row[x] as string;
      if (!(ch in TILE_CHARS)) fail(`Unknown tile character "${ch}" at column ${x}, row ${y}. Allowed: # . space S B O`);
    }
  });
  if (!Array.isArray(m.rooms) || m.rooms.length === 0) fail('Map needs at least one room in "rooms".');
  for (const r of m.rooms as unknown[]) {
    if (!isRecord(r) || typeof r.name !== 'string') fail('Every room needs a "name".');
    const rect = r.rect;
    if (!Array.isArray(rect) || rect.length !== 4 || !rect.every((n) => Number.isInteger(n))) {
      fail(`Room "${r.name}" needs "rect": [x, y, width, height] in whole tiles.`);
    }
    if (r.deadEnd !== undefined && typeof r.deadEnd !== 'boolean') fail(`Room "${r.name}": "deadEnd" must be true or false.`);
  }
  const posList = (list: unknown, what: string) => {
    if (!Array.isArray(list)) fail(`Map "${what}" must be a list.`);
    for (const item of list) {
      if (!isRecord(item) || typeof item.room !== 'string' || !isPos(item.pos)) {
        fail(`Every entry in "${what}" needs a "room" and a "pos": [x, y].`);
      }
    }
  };
  // The lists below are optional so a small map like the lobby can leave them out.
  m.vents ??= [];
  m.doors ??= [];
  m.tasks ??= [];
  m.objects ??= [];
  m.sabotage ??= { lights: [], reactor: [], o2: [], comms: [] };
  posList(m.vents, 'vents');
  for (const v of m.vents as Record<string, unknown>[]) {
    if (typeof v.id !== 'string' || !Number.isInteger(v.network)) fail('Every vent needs an "id" and a whole-number "network".');
  }
  if (!isRecord(m.sabotage)) fail('Map "sabotage" must have lights, reactor, o2 and comms lists.');
  for (const key of ['lights', 'reactor', 'o2', 'comms']) posList(m.sabotage[key] ?? [], `sabotage.${key}`);
  if (!Array.isArray(m.doors)) fail('Map "doors" must be a list.');
  for (const d of m.doors as unknown[]) {
    if (!isRecord(d) || typeof d.room !== 'string' || !Array.isArray(d.tiles) || !d.tiles.every(isPos)) {
      fail('Every door group needs a "room" and "tiles": a list of [x, y].');
    }
  }
  posList(m.tasks, 'tasks');
  for (const t of m.tasks as Record<string, unknown>[]) {
    if (typeof t.id !== 'string' || typeof t.task !== 'string') fail('Every task spot needs an "id" and a "task" type.');
    if (t.stage !== undefined && t.stage !== 1 && t.stage !== 2) fail(`Task spot "${t.id}": "stage" must be 1 or 2 when present.`);
  }
  posList(m.objects, 'objects');
  for (const o of m.objects as Record<string, unknown>[]) {
    if (typeof o.id !== 'string' || typeof o.type !== 'string') fail('Every object needs an "id" and a "type".');
    if (o.size !== undefined && !isPos(o.size)) fail(`Object "${o.id}": "size" must be [width, height] in tiles.`);
  }
  if (m.playable !== undefined && typeof m.playable !== 'boolean') fail('Map "playable" must be true or false.');
  return raw as unknown as MapJson;
}

/** Builds the GameMap from checked JSON. Structural problems throw MapError; design-rule problems are validateMap's job. */
export function loadMap(raw: unknown): GameMap {
  const json = checkMapJson(raw);
  const height = json.tiles.length;
  const width = json.tiles[0]?.length ?? 0;

  const kinds: TileKind[] = new Array<TileKind>(width * height);
  const spawns: TilePos[] = [];
  const buttons: TilePos[] = [];
  json.tiles.forEach((row, y) => {
    for (let x = 0; x < width; x++) {
      const ch = row[x] as string;
      kinds[y * width + x] = TILE_CHARS[ch] as TileKind;
      if (ch === 'S') spawns.push([x, y]);
      if (ch === 'B') buttons.push([x, y]);
    }
  });
  if (buttons.length > 1) fail(`Map has ${buttons.length} emergency button tiles "B"; at most one is allowed.`);
  const button = buttons[0] ?? null;

  const inBounds = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height;
  const tileAt = (x: number, y: number): TileKind => (inBounds(x, y) ? (kinds[y * width + x] as TileKind) : 'void');
  const isWalkable = (x: number, y: number) => tileAt(x, y) === 'floor';

  // Regions: rooms first (by declared rectangle), then leftover floor becomes numbered corridors.
  const regionIndex = new Int16Array(width * height).fill(-1);
  const regions: Region[] = [];
  const seenNames = new Set<string>();
  for (const r of json.rooms) {
    if (seenNames.has(r.name)) fail(`Two rooms are both named "${r.name}". Room names must be unique.`);
    seenNames.add(r.name);
    const [rx, ry, rw, rh] = r.rect;
    if (rw <= 0 || rh <= 0 || !inBounds(rx, ry) || !inBounds(rx + rw - 1, ry + rh - 1)) {
      fail(`Room "${r.name}" rect [${r.rect.join(', ')}] goes outside the tile picture (${width} x ${height}).`);
    }
    const id = regions.length;
    let tileCount = 0;
    for (let y = ry; y < ry + rh; y++) {
      for (let x = rx; x < rx + rw; x++) {
        if (!isWalkable(x, y)) continue;
        const existing = regionIndex[y * width + x] as number;
        if (existing !== -1) fail(`Room "${r.name}" overlaps room "${regions[existing]?.name}" at tile (${x}, ${y}).`);
        regionIndex[y * width + x] = id;
        tileCount++;
      }
    }
    regions.push({ id, name: r.name, kind: 'room', deadEnd: r.deadEnd === true, tileCount, rect: { x: rx, y: ry, w: rw, h: rh } });
  }
  let corridorCount = 0;
  const stack: number[] = [];
  for (let start = 0; start < width * height; start++) {
    if (kinds[start] !== 'floor' || regionIndex[start] !== -1) continue;
    corridorCount++;
    const id = regions.length;
    let tileCount = 0;
    stack.push(start);
    regionIndex[start] = id;
    while (stack.length > 0) {
      const i = stack.pop() as number;
      tileCount++;
      const x = i % width;
      const y = (i - x) / width;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (!isWalkable(nx, ny)) continue;
        const ni = ny * width + nx;
        if (regionIndex[ni] !== -1) continue;
        regionIndex[ni] = id;
        stack.push(ni);
      }
    }
    regions.push({ id, name: `Corridor ${corridorCount}`, kind: 'corridor', deadEnd: false, tileCount, rect: null });
  }
  const regionAt = (x: number, y: number): Region | null => {
    if (!inBounds(x, y)) return null;
    const id = regionIndex[y * width + x] as number;
    return id === -1 ? null : (regions[id] as Region);
  };
  const byName = new Map(regions.map((r) => [r.name, r] as const));

  const nav = buildNavGraph(width, height, isWalkable, (x, y) => regionIndex[y * width + x] as number);

  const toPos = (p: [number, number]): TilePos => [p[0], p[1]];
  const panels = (list: Panel[] | undefined): Panel[] => (list ?? []).map((p) => ({ room: p.room, pos: toPos(p.pos as [number, number]) }));
  const sabotage = json.sabotage ?? { lights: [], reactor: [], o2: [], comms: [] };

  return {
    name: json.name,
    sizeClass: json.sizeClass,
    playerCap: json.playerCap,
    impostors: { default: json.impostors.default, max: json.impostors.max },
    tileSize: json.tileSize,
    width,
    height,
    regions,
    rooms: regions.filter((r) => r.kind === 'room'),
    spawns,
    button,
    vents: (json.vents ?? []).map((v) => ({ id: v.id, room: v.room, pos: toPos(v.pos), network: v.network })),
    sabotage: {
      lights: panels(sabotage.lights),
      reactor: panels(sabotage.reactor),
      o2: panels(sabotage.o2),
      comms: panels(sabotage.comms),
    },
    doors: (json.doors ?? []).map((d) => ({ room: d.room, tiles: d.tiles.map(toPos) })),
    tasks: (json.tasks ?? []).map((t) => ({ id: t.id, task: t.task, stage: t.stage, room: t.room, pos: toPos(t.pos) })),
    objects: (json.objects ?? []).map((o) => ({ id: o.id, type: o.type, room: o.room, pos: toPos(o.pos), size: o.size ? [o.size[0], o.size[1]] : [1, 1] })),
    playable: json.playable !== false,
    nav,
    tileAt,
    isWalkable,
    regionAt,
    regionByName: (name) => byName.get(name) ?? null,
  };
}

/**
 * One node per walkable tile, edges to the 8 neighbours. A diagonal edge is only
 * allowed when both tiles beside it are walkable, so nothing cuts a wall corner.
 */
export function buildNavGraph(
  width: number,
  height: number,
  isWalkable: (x: number, y: number) => boolean,
  regionOf: (x: number, y: number) => number,
): NavGraph {
  const idGrid = new Int32Array(width * height).fill(-1);
  const nodes: NavNode[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isWalkable(x, y)) continue;
      idGrid[y * width + x] = nodes.length;
      nodes.push({ id: nodes.length, x, y, region: regionOf(x, y) });
    }
  }
  const edges: NavEdge[][] = nodes.map(() => []);
  for (const n of nodes) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = n.x + dx;
        const ny = n.y + dy;
        if (!isWalkable(nx, ny)) continue;
        const diagonal = dx !== 0 && dy !== 0;
        if (diagonal && !(isWalkable(n.x + dx, n.y) && isWalkable(n.x, n.y + dy))) continue;
        const to = idGrid[ny * width + nx] as number;
        (edges[n.id] as NavEdge[]).push({ to, length: diagonal ? SQRT2 : 1 });
      }
    }
  }
  return {
    nodes,
    edges,
    nodeAt: (x, y) => (x >= 0 && y >= 0 && x < width && y < height ? (idGrid[y * width + x] as number) : -1),
  };
}
