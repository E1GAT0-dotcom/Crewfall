import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../config/game.json';
import { addClaim, broadcastClaim, corroborates, findContradiction, type Claim } from '../src/bots/claims';
import { BRAINS, closeAllSightings, createMemory, perceive, pruneForMeeting, recall, recentSightings, sightingsOf, type Sighting } from '../src/bots/memory';
import { tryKill } from '../src/sim/actions';
import { loadMap } from '../src/sim/map';
import { startMeeting } from '../src/sim/meeting';
import { defaultSettings, type GameSettings } from '../src/sim/settings';
import { createGame, NO_INPUT, stepSim, type SimState, type Unit } from '../src/sim/sim';

const map = loadMap(JSON.parse(readFileSync(new URL('../assets/maps/kestrel.json', import.meta.url), 'utf8')));
const TS = map.tileSize;
const RATE = config.tickRate;
const at = (u: Unit, tx: number, ty: number) => {
  u.x = tx * TS + TS / 2;
  u.y = ty * TS + TS / 2;
};

/** A game where nobody moves on their own: bots have no tasks and sit still, so tests control positions. */
function stillGame(seed = 1, over: Partial<GameSettings> = {}): { s: SimState; bots: Unit[] } {
  const s = createGame(map, { ...defaultSettings(), players: 8, impostors: 2, ...over }, seed, config);
  for (const b of s.bots) {
    const u = s.units[b.unitId]!;
    u.tasks = [];
    b.frozen = true; // never moves or acts
    at(u, 31, 4); // everyone in Navigation
  }
  for (const u of s.units) if (u.role === 'impostor') u.killCooldownTicks = 1e9;
  // Crew bots first: crew see half a screen, impostors half again as far, and tests park units by crew range.
  const bots = s.bots.map((b) => s.units[b.unitId]!).sort((a, b) => Number(a.role === 'impostor') - Number(b.role === 'impostor'));
  return { s, bots };
}

function tick(s: SimState, n = 1): void {
  for (let i = 0; i < n; i++) stepSim(s, NO_INPUT, map, config);
}

describe('perception', () => {
  it('opens a sighting for a unit in sight, tracks its rooms, and closes it when it leaves sight', () => {
    const { s, bots } = stillGame();
    const watcher = bots[0]!;
    const subject = bots[1]!;
    const memory = s.bots.find((b) => b.unitId === watcher.id)!.memory;
    at(watcher, 31, 28); // Cafeteria
    at(subject, 33, 28); // Cafeteria, beside the watcher
    tick(s, 10);
    const open = Object.values(memory.open).find((o) => o.subjectId === subject.id)!;
    expect(open).toBeDefined();
    expect(open.rooms[0]!.room).toBe('Cafeteria');
    at(subject, 31, 42); // Admin, still on screen at 1.0x
    tick(s, 10);
    expect(open.rooms.map((r) => r.room)).toEqual(['Cafeteria', 'Corridor 8', 'Admin'].filter((r) => open.rooms.some((v) => v.room === r)));
    expect(open.rooms[open.rooms.length - 1]!.room).toBe('Admin');
    at(subject, 52, 55); // Reactor: far away, out of sight
    tick(s, 2);
    expect(memory.open[subject.id]).toBeUndefined();
    const closed = memory.sightings.find((x) => x.subjectId === subject.id)!;
    expect(closed).toBeDefined();
    expect(closed.endTick).toBeLessThan(s.tick);
    expect(closed.endTick - closed.startTick).toBeGreaterThanOrEqual(18);
  });

  it('records companions, alone time, task spots and bodies nearby', () => {
    const { s, bots } = stillGame(2);
    const [watcher, subject, friend, victim] = bots as [Unit, Unit, Unit, Unit];
    const memory = s.bots.find((b) => b.unitId === watcher.id)!.memory;
    at(watcher, 26, 26);
    at(subject, 34, 30);
    at(friend, 35, 30); // right next to the subject
    tick(s, 5);
    let sight = memory.open[subject.id]!;
    expect(sight.companions).toContain(friend.id);
    expect(sight.aloneTicks).toBe(0);
    at(friend, 31, 4); // friend leaves to Navigation
    tick(s, RATE * 4);
    sight = memory.open[subject.id]!;
    expect(sight.aloneTicks).toBeGreaterThanOrEqual(RATE * 3);
    // Standing still on the Cafeteria wiring spot counts as doing a task.
    const spot = map.tasks.find((t) => t.room === 'Cafeteria')!;
    at(subject, spot.pos[0], spot.pos[1]);
    tick(s, RATE * 2);
    sight = memory.open[subject.id]!;
    expect(sight.taskTicks).toBeGreaterThanOrEqual(RATE * 2 - 2);
    expect(sight.taskSpotId).toBe(spot.id);
    // A body beside the subject is noticed, and the body itself is logged once.
    victim.alive = false;
    s.bodies.push({ unitId: victim.id, x: subject.x + TS, y: subject.y, tick: s.tick });
    tick(s, 3);
    expect(memory.open[subject.id]!.nearBody).toBe(true);
    expect(memory.bodies.filter((b) => b.victimId === victim.id).length).toBe(1);
    expect(memory.bodies[0]!.room).toBe('Cafeteria');
  });

  it('a kill is witnessed only by bots who could see it', () => {
    const { s, bots } = stillGame(3);
    const imp = bots.find((u) => u.role === 'impostor')!;
    const victim = bots.find((u) => u.role === 'crew')!;
    const near = bots.find((u) => u.role === 'crew' && u !== victim)!;
    const far = bots.find((u) => u.role === 'crew' && u !== victim && u !== near)!;
    at(imp, 52, 55);
    at(victim, 53, 55);
    at(near, 49, 52); // Reactor too
    at(far, 31, 4); // Navigation
    imp.killCooldownTicks = 0;
    expect(tryKill(s, imp, victim, config)).toBe(true);
    tick(s, 1); // perception runs at the end of the tick... but the kill event was in the previous tick
    // The kill event lives in the tick it happened; do it inside a tick to be sure.
    const { s: s2, bots: b2 } = stillGame(3);
    const imp2 = b2.find((u) => u.role === 'impostor')!;
    const victim2 = b2.find((u) => u.role === 'crew')!;
    const near2 = b2.find((u) => u.role === 'crew' && u !== victim2)!;
    const far2 = b2.find((u) => u.role === 'crew' && u !== victim2 && u !== near2)!;
    at(imp2, 52, 55);
    at(victim2, 53, 55);
    at(near2, 49, 52);
    at(far2, 31, 4);
    imp2.killCooldownTicks = 0;
    // Let the impostor bot's own brain strike: it hunts when nobody but the victim... near2 is a witness, so force it.
    const impBot = s2.bots.find((b) => b.unitId === imp2.id)!;
    impBot.pauseTicks = 0;
    // Simplest: perform the kill inside stepSim via the player? Use the sim's kill on tick by direct call then perceive manually.
    stepSim(s2, NO_INPUT, map, config);
    tryKill(s2, imp2, victim2, config);
    for (const b of s2.bots) {
      const u = s2.units[b.unitId]!;
      if (u.alive) perceive(b.memory, u, s2, map, config);
    }
    const nearMem = s2.bots.find((b) => b.unitId === near2.id)!.memory;
    const farMem = s2.bots.find((b) => b.unitId === far2.id)!.memory;
    expect(nearMem.kills).toEqual([{ tick: s2.tick, killerId: imp2.id, victimId: victim2.id, room: 'Reactor' }]);
    expect(farMem.kills).toEqual([]);
    expect(s.bodies.length).toBe(1);
  });

  it('meetings close sightings and the memory span forgets old ones', () => {
    const { s, bots } = stillGame(4, { difficulty: 'normal' });
    const watcher = bots[0]!;
    const subject = bots[1]!;
    const memory = s.bots.find((b) => b.unitId === watcher.id)!.memory;
    at(watcher, 31, 28);
    at(subject, 33, 28);
    tick(s, RATE);
    const first = memory.open[subject.id]!;
    closeAllSightings(memory, config);
    expect(memory.open).toEqual({});
    expect(memory.sightings).toContain(first);
    pruneForMeeting(memory, 1000, 'normal');
    pruneForMeeting(memory, 2000, 'normal');
    pruneForMeeting(memory, 3000, 'normal');
    expect(memory.sightings).toContain(first); // 3 meetings: still within span 3
    pruneForMeeting(memory, 4000, 'normal');
    expect(memory.sightings).not.toContain(first); // 4th meeting: beyond span
    const hard = createMemory();
    hard.sightings.push({ ...first });
    for (let i = 1; i <= 10; i++) pruneForMeeting(hard, i * 1000, 'hard');
    expect(hard.sightings.length).toBe(1);
  });

  it('a meeting start closes and prunes every bot memory through the real flow', () => {
    const { s, bots } = stillGame(5);
    at(bots[0]!, 31, 28);
    at(bots[1]!, 33, 28);
    tick(s, RATE);
    startMeeting(s, s.units[0]!, 'button', null, map, config);
    const memory = s.bots.find((b) => b.unitId === bots[0]!.id)!.memory;
    expect(Object.keys(memory.open).length).toBe(0);
    expect(memory.meetingStarts).toEqual([s.tick]);
  });
});

describe('recall by difficulty', () => {
  const sample: Sighting = { id: 1, subjectId: 2, startTick: 1000, endTick: 1300, rooms: [{ tick: 1000, room: 'Medbay' }], companions: [], aloneTicks: 0, taskTicks: 0, taskSpotId: null, nearBody: false, headingRoom: null, nearMe: [] };

  it('hard bots remember exactly', () => {
    const r = recall(1, sample, 'Medbay', 'hard', map, config);
    expect(r).toEqual({ room: 'Medbay', startTick: 1000, endTick: 1300, blurred: false });
  });

  it('easy bots blur roughly 30% of sightings, always the same way for the same sighting', () => {
    let blurred = 0;
    for (let id = 1; id <= 300; id++) {
      const s = { ...sample, id };
      const r = recall(1, s, 'Medbay', 'easy', map, config);
      const again = recall(1, s, 'Medbay', 'easy', map, config);
      expect(again).toEqual(r);
      if (r.blurred) {
        blurred++;
        const neighbourRoom = r.room !== 'Medbay';
        const timeShift = r.startTick !== 1000;
        expect(neighbourRoom || timeShift).toBe(true);
        if (neighbourRoom) expect(['Cafeteria', 'Shields', 'Storage']).toContain(r.room); // Medbay's neighbours via corridors
        if (timeShift) expect(Math.abs(r.startTick - 1000)).toBeLessThanOrEqual(BRAINS.recall.timeBlurSec * RATE);
      }
    }
    expect(blurred / 300).toBeGreaterThan(0.18);
    expect(blurred / 300).toBeLessThan(0.45);
  });
});

describe('claims and contradictions', () => {
  function watched(seed: number, difficulty: 'easy' | 'normal' | 'hard' = 'hard') {
    const { s, bots } = stillGame(seed, { difficulty });
    const watcher = bots[0]!;
    const speaker = bots[1]!;
    const memory = s.bots.find((b) => b.unitId === watcher.id)!.memory;
    at(watcher, 31, 28); // Cafeteria
    at(speaker, 36, 30); // Cafeteria
    tick(s, RATE * 10);
    return { s, watcher, speaker, memory, bots };
  }

  it('an alibi naming the wrong room is contradicted; the right room is corroborated', () => {
    const { s, watcher, speaker, memory } = watched(6);
    const window = { fromTick: s.tick - RATE * 30, toTick: s.tick };
    const lie = addClaim(s, { speakerId: speaker.id, kind: 'alibi', subjectId: speaker.id, room: 'Medbay', otherId: null, ...window });
    const c = findContradiction(watcher.id, memory, lie, s, map, config)!;
    expect(c).not.toBeNull();
    expect(c.sawRoom).toBe('Cafeteria');
    expect(c.why).toContain('says Medbay');
    const truth = addClaim(s, { speakerId: speaker.id, kind: 'alibi', subjectId: speaker.id, room: 'Cafeteria', otherId: null, ...window });
    expect(findContradiction(watcher.id, memory, truth, s, map, config)).toBeNull();
    expect(corroborates(watcher.id, memory, truth, s, map, config)).toBe(true);
    expect(corroborates(watcher.id, memory, lie, s, map, config)).toBe(false);
  });

  it('a bot never contradicts its own claim, and cannot contradict what it did not see', () => {
    const { s, speaker, memory, bots } = watched(7);
    const window = { fromTick: s.tick - RATE * 30, toTick: s.tick };
    const own = addClaim(s, { speakerId: speaker.id, kind: 'alibi', subjectId: speaker.id, room: 'Medbay', otherId: null, ...window });
    expect(findContradiction(speaker.id, s.bots.find((b) => b.unitId === speaker.id)!.memory, own, s, map, config)).toBeNull();
    const farBot = bots[2]!; // still in Navigation, never saw the speaker
    const farMem = s.bots.find((b) => b.unitId === farBot.id)!.memory;
    expect(findContradiction(farBot.id, farMem, own, s, map, config)).toBeNull();
    expect(memory.sightings.length + Object.keys(memory.open).length).toBeGreaterThan(0);
  });

  it('"X was with me" is contradicted when I watched the speaker without X', () => {
    const { s, watcher, speaker, memory, bots } = watched(8);
    const absent = bots[2]!; // in Navigation the whole time
    const window = { fromTick: s.tick - RATE * 30, toTick: s.tick };
    const claim = addClaim(s, { speakerId: speaker.id, kind: 'with', subjectId: speaker.id, room: null, otherId: absent.id, ...window });
    const c = findContradiction(watcher.id, memory, claim, s, map, config)!;
    expect(c).not.toBeNull();
    expect(c.why).toContain(`without ${absent.name}`);
  });

  it('a broadcast claim reaches every living bot and only the watchers record a contradiction', () => {
    const { s, watcher, speaker, bots } = watched(9);
    // Everyone else far off in Electrical, beyond even an impostor's sight of Cafeteria.
    for (const u of bots) if (u !== watcher && u !== speaker) at(u, 5, 56);
    const window = { fromTick: s.tick - RATE * 30, toTick: s.tick };
    broadcastClaim(s, { speakerId: speaker.id, kind: 'alibi', subjectId: speaker.id, room: 'Reactor', otherId: null, ...window }, map, config);
    expect(s.claims.length).toBe(1);
    const watcherMem = s.bots.find((b) => b.unitId === watcher.id)!.memory;
    expect(watcherMem.contradictions.length).toBe(1);
    // Only bots that actually have a sighting of the speaker can contradict them.
    for (const b of s.bots) {
      if (b.unitId === speaker.id) continue;
      const sawSpeaker = sightingsOf(b.memory, speaker.id, window.fromTick, window.toTick).length > 0;
      expect(b.memory.contradictions.length, s.units[b.unitId]!.name).toBe(sawSpeaker ? 1 : 0);
    }
  });

  it('a bot alibi said in a meeting becomes a claim other bots check', () => {
    const s = createGame(map, { ...defaultSettings(), players: 8, impostors: 2, discussionSec: 60 }, 21, config);
    tick(s, RATE * 20);
    startMeeting(s, s.units[0]!, 'button', null, map, config);
    tick(s, RATE * 40);
    const alibis = s.claims.filter((c: Claim) => c.kind === 'alibi');
    expect(alibis.length).toBeGreaterThan(0);
    for (const c of alibis) {
      expect(c.room).toBe(s.meeting?.roomsAtStart[c.speakerId]);
    }
  });
});

describe('memory in a running game', () => {
  it('every bot has seen others after a minute, and games stay deterministic with memory', () => {
    const play = () => {
      const s = createGame(map, { ...defaultSettings(), players: 10, impostors: 2 }, 33, config);
      tick(s, RATE * 60);
      return s;
    };
    const a = play();
    for (const b of a.bots) {
      const u = a.units[b.unitId]!;
      if (!u.alive) continue;
      expect(b.memory.sightings.length + Object.keys(b.memory.open).length, u.name).toBeGreaterThan(0);
      expect(recentSightings(b.memory, 5).length).toBeGreaterThan(0);
    }
    const b = play();
    expect(a.bots.map((x) => x.memory)).toEqual(b.bots.map((x) => x.memory));
    const any = a.bots[0]!.memory;
    const first = [...any.sightings, ...Object.values(any.open)][0]!;
    expect(sightingsOf(any, first.subjectId, first.startTick, first.endTick).length).toBeGreaterThan(0);
  });
});
