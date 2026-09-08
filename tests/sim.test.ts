import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../config/game.json';
import { loadMap } from '../src/sim/map';
import { createSim, NO_INPUT, playerRegionName, stepSim, type PlayerInput, type SimState } from '../src/sim/sim';

const map = loadMap(JSON.parse(readFileSync(new URL('../assets/maps/kestrel.json', import.meta.url), 'utf8')));
const TS = map.tileSize;
const pxPerTick = (config.player.speedTilesPerSec * TS) / config.tickRate;

function run(state: SimState, input: PlayerInput, ticks: number): SimState {
  for (let i = 0; i < ticks; i++) state = stepSim(state, input, map, config);
  return state;
}

describe('simulation', () => {
  it('spawns the player centred on the first spawn tile, inside Cafeteria', () => {
    const s = createSim(map);
    const [sx, sy] = map.spawns[0] as readonly [number, number];
    expect(s.player).toEqual({ x: sx * TS + TS / 2, y: sy * TS + TS / 2, facing: 1, moving: false });
    expect(playerRegionName(s, map)).toBe('Cafeteria');
    expect(s.tick).toBe(0);
  });

  it('moves at the configured speed and counts ticks', () => {
    const s0 = createSim(map);
    const s1 = stepSim(s0, { dx: 1, dy: 0 }, map, config);
    expect(s1.tick).toBe(1);
    expect(s1.player.x).toBeCloseTo(s0.player.x + pxPerTick);
    expect(s1.player.y).toBe(s0.player.y);
    expect(s1.player.moving).toBe(true);
    expect(s1.player.facing).toBe(1);
  });

  it('diagonal movement is not faster than straight movement', () => {
    const s0 = createSim(map);
    const s1 = stepSim(s0, { dx: 1, dy: -1 }, map, config);
    const dist = Math.hypot(s1.player.x - s0.player.x, s1.player.y - s0.player.y);
    expect(dist).toBeCloseTo(pxPerTick);
  });

  it('keeps facing left after stopping, and reports not moving', () => {
    let s = createSim(map);
    s = run(s, { dx: -1, dy: 0 }, 3);
    expect(s.player.facing).toBe(-1);
    s = stepSim(s, NO_INPUT, map, config);
    expect(s.player.facing).toBe(-1);
    expect(s.player.moving).toBe(false);
  });

  it('is deterministic: the same inputs always give the same result', () => {
    const script: PlayerInput[] = [];
    for (let i = 0; i < 300; i++) {
      script.push({ dx: ((i * 7) % 3) - 1, dy: ((i * 5) % 3) - 1 });
    }
    const play = () => {
      let s = createSim(map);
      for (const input of script) s = stepSim(s, input, map, config);
      return s;
    };
    expect(play()).toEqual(play());
  });

  it('walks out of Cafeteria into a corridor and reports the change', () => {
    // From the spawn tile below the button, walk straight down through the bottom opening.
    const spawnIndex = map.spawns.findIndex(([x, y]) => x === 31 && y === 30);
    expect(spawnIndex).toBeGreaterThanOrEqual(0);
    let s = createSim(map, spawnIndex);
    expect(playerRegionName(s, map)).toBe('Cafeteria');
    s = run(s, { dx: 0, dy: 1 }, Math.round(config.tickRate * 1.5)); // 1.5 s down: about 6.75 tiles, into the corridor
    expect(playerRegionName(s, map)).toMatch(/^Corridor \d+$/);
    expect(s.player.moving).toBe(true);
    s = run(s, { dx: 0, dy: 1 }, config.tickRate * 2); // keep going: the corridor leads into Admin
    expect(playerRegionName(s, map)).toBe('Admin');
  });

  it('stops at a wall and reports not moving', () => {
    let s = createSim(map);
    s = run(s, { dx: 0, dy: -1 }, config.tickRate * 5); // walk up into Cafeteria's top wall
    const before = s.player;
    s = stepSim(s, { dx: 0, dy: -1 }, map, config);
    expect(s.player.y).toBe(before.y);
    expect(s.player.moving).toBe(false);
    expect(playerRegionName(s, map)).toBe('Cafeteria');
  });
});
