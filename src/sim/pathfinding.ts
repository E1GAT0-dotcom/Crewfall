// A* path-finding over the map's walking graph. Pure TypeScript.
// Returns a list of tile positions from start to goal (both included), or null if unreachable.

import type { GameMap, TilePos } from './map';

class MinHeap {
  private readonly ids: number[] = [];
  private readonly keys: number[] = [];

  get size(): number {
    return this.ids.length;
  }

  push(id: number, key: number): void {
    this.ids.push(id);
    this.keys.push(key);
    let i = this.ids.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if ((this.keys[parent] as number) <= key) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number {
    const top = this.ids[0] as number;
    const lastId = this.ids.pop() as number;
    const lastKey = this.keys.pop() as number;
    if (this.ids.length > 0) {
      this.ids[0] = lastId;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < this.ids.length && (this.keys[l] as number) < (this.keys[smallest] as number)) smallest = l;
        if (r < this.ids.length && (this.keys[r] as number) < (this.keys[smallest] as number)) smallest = r;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const id = this.ids[a] as number;
    const key = this.keys[a] as number;
    this.ids[a] = this.ids[b] as number;
    this.keys[a] = this.keys[b] as number;
    this.ids[b] = id;
    this.keys[b] = key;
  }
}

/** Octile distance: the exact cost of the best path on an open 8-way grid, so A* stays optimal. */
function heuristic(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
}

export function findPath(map: GameMap, from: TilePos, to: TilePos): TilePos[] | null {
  const nav = map.nav;
  const start = nav.nodeAt(from[0], from[1]);
  const goal = nav.nodeAt(to[0], to[1]);
  if (start === -1 || goal === -1) return null;
  if (start === goal) return [from];

  const n = nav.nodes.length;
  const g = new Float64Array(n).fill(Infinity);
  const cameFrom = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const goalNode = nav.nodes[goal] as { x: number; y: number };
  const open = new MinHeap();
  g[start] = 0;
  open.push(start, heuristic((nav.nodes[start] as { x: number }).x, (nav.nodes[start] as { y: number }).y, goalNode.x, goalNode.y));

  while (open.size > 0) {
    const current = open.pop();
    if (current === goal) break;
    if (closed[current]) continue;
    closed[current] = 1;
    const cx = (nav.nodes[current] as { x: number }).x;
    const cy = (nav.nodes[current] as { y: number }).y;
    void cx;
    void cy;
    for (const e of nav.edges[current] ?? []) {
      if (closed[e.to]) continue;
      const tentative = (g[current] as number) + e.length;
      if (tentative < (g[e.to] as number)) {
        g[e.to] = tentative;
        cameFrom[e.to] = current;
        const node = nav.nodes[e.to] as { x: number; y: number };
        open.push(e.to, tentative + heuristic(node.x, node.y, goalNode.x, goalNode.y));
      }
    }
  }
  if (cameFrom[goal] === -1) return null;

  const path: TilePos[] = [];
  for (let id = goal; id !== -1; id = cameFrom[id] as number) {
    const node = nav.nodes[id] as { x: number; y: number };
    path.push([node.x, node.y]);
    if (id === start) break;
  }
  path.reverse();
  return path;
}

/** Total length of a tile path in tiles. */
export function pathLength(path: readonly TilePos[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as TilePos;
    const b = path[i] as TilePos;
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return total;
}
