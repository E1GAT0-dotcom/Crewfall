import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../config/game.json';
import { perceive } from '../src/bots/memory';
import { tickSocial } from '../src/bots/suspicion';
import { chooseLine } from '../src/chat/voice';
import { canKill, findKillTarget, tryKill } from '../src/sim/actions';
import { loadMap } from '../src/sim/map';
import { startMeeting } from '../src/sim/meeting';
import { defaultSettings, type GameSettings } from '../src/sim/settings';
import { createGame, NO_INPUT, player, stepSim, type SimState, type Unit } from '../src/sim/sim';
import { hopToVent, tryEnterVent, tryExitVent, tryVentHop, ventById, ventInDirection, ventInReach, ventNeighbours } from '../src/sim/vents';

const map = loadMap(JSON.parse(readFileSync(new URL('../assets/maps/kestrel.json', import.meta.url), 'utf8')));
const TS = map.tileSize;
const RATE = config.tickRate;
const at = (u: Unit, tx: number, ty: number) => {
  u.x = tx * TS + TS / 2;
  u.y = ty * TS + TS / 2;
};
const botOf = (s: SimState, u: Unit) => s.bots.find((b) => b.unitId === u.id)!;
const tick = (s: SimState, n = 1, input = NO_INPUT) => {
  for (let i = 0; i < n; i++) stepSim(s, input, map, config);
};

const REACTOR_VENT = ventById(map, 'vent_reactor')!; // (58, 56), network 1 with Electrical (5, 56) and Admin (35, 45)

function game(seed: number, over: Partial<GameSettings> = {}): SimState {
  return createGame(map, { ...defaultSettings(), players: 8, impostors: 2, discussionSec: 10, votingSec: 30, ...over }, seed, config);
}

/** Everyone frozen in Navigation with no tasks; impostors cannot kill. Tests move who they want. */
function stillGame(seed = 1, over: Partial<GameSettings> = {}): { s: SimState; imp: Unit; crew: Unit[] } {
  const s = game(seed, over);
  for (const b of s.bots) {
    b.frozen = true;
    s.units[b.unitId]!.tasks = [];
  }
  for (const u of s.units) {
    if (u.role === 'impostor') u.killCooldownTicks = 1e9;
    at(u, 31, 4);
  }
  const imp = s.units.find((u) => u.role === 'impostor' && !u.isPlayer)!;
  const crew = s.units.filter((u) => u.role === 'crew' && !u.isPlayer);
  return { s, imp, crew };
}

function playerAsImpostor(seedStart: number, over: Partial<GameSettings> = {}): SimState {
  for (let seed = seedStart; seed < seedStart + 80; seed++) {
    const s = game(seed, over);
    if (player(s).role === 'impostor') return s;
  }
  throw new Error('no seed with an impostor player');
}

describe('vents in the map', () => {
  it('every vent sits on a floor tile inside its room, and networks link two or three rooms', () => {
    expect(map.vents.length).toBeGreaterThan(0);
    for (const v of map.vents) {
      expect(map.isWalkable(v.pos[0], v.pos[1]), v.id).toBe(true);
      expect(map.regionAt(v.pos[0], v.pos[1])?.name, v.id).toBe(v.room);
      const others = ventNeighbours(map, v);
      expect(others.length, v.id).toBeGreaterThanOrEqual(1);
      expect(others.every((o) => o.network === v.network && o.id !== v.id)).toBe(true);
    }
  });
});

describe('climbing in and out', () => {
  it('only a living impostor next to a vent can climb in; it lands on the grate, hidden', () => {
    const { s, imp, crew } = stillGame(1);
    expect(tryEnterVent(s, imp, map, config)).toBe(false); // nowhere near a vent
    at(crew[0]!, 57, 56);
    expect(ventInReach(crew[0]!, map, config)?.id).toBe('vent_reactor');
    expect(tryEnterVent(s, crew[0]!, map, config)).toBe(false); // crew never vent
    at(imp, 57, 56);
    expect(tryEnterVent(s, imp, map, config)).toBe(true);
    expect(imp.inVent).toBe('vent_reactor');
    expect([imp.x, imp.y]).toEqual([58 * TS + TS / 2, 56 * TS + TS / 2]);
    expect(s.events).toContainEqual({ kind: 'ventEnter', unitId: imp.id, ventId: 'vent_reactor', x: imp.x, y: imp.y });
    expect(tryEnterVent(s, imp, map, config)).toBe(false); // already inside
    expect(tryExitVent(s, imp, map)).toBe(true);
    expect(imp.inVent).toBeNull();
    expect(s.events.at(-1)).toEqual({ kind: 'ventExit', unitId: imp.id, ventId: 'vent_reactor', x: imp.x, y: imp.y });
    imp.alive = false;
    expect(tryEnterVent(s, imp, map, config)).toBe(false);
  });

  it('inside a vent you cannot kill, be targeted, report or call a meeting', () => {
    const { s, imp, crew } = stillGame(2);
    const victim = crew[0]!;
    at(imp, 58, 56);
    at(victim, 58, 57);
    imp.killCooldownTicks = 0;
    expect(canKill(s, imp, victim, config)).toBe(true);
    tryEnterVent(s, imp, map, config);
    expect(canKill(s, imp, victim, config)).toBe(false);
    expect(findKillTarget(s, imp, config)).toBeNull();
    expect(tryKill(s, imp, victim, config)).toBe(false);
    expect(victim.alive).toBe(true);
  });
});

describe('moving along the network', () => {
  it('a direction press picks the connected vent that way; other networks are never reachable', () => {
    const { s, imp } = stillGame(3);
    at(imp, 58, 56);
    tryEnterVent(s, imp, map, config);
    // From Reactor: Electrical is straight left, Admin is up and to the left, nothing lies right or down.
    expect(ventInDirection(map, REACTOR_VENT, -1, 0)?.id).toBe('vent_electrical');
    expect(ventInDirection(map, REACTOR_VENT, 0, -1)?.id).toBe('vent_admin');
    expect(ventInDirection(map, REACTOR_VENT, 1, 0)).toBeNull();
    expect(ventInDirection(map, REACTOR_VENT, 0, 1)).toBeNull();
    expect(tryVentHop(s, imp, 1, 0, map)).toBe(false);
    expect(imp.inVent).toBe('vent_reactor');
    expect(tryVentHop(s, imp, -1, 0, map)).toBe(true);
    expect(imp.inVent).toBe('vent_electrical');
    expect([imp.x, imp.y]).toEqual([5 * TS + TS / 2, 56 * TS + TS / 2]);
    expect(s.events.at(-1)).toEqual({ kind: 'ventHop', unitId: imp.id, fromVentId: 'vent_reactor', toVentId: 'vent_electrical' });
    // A vent on another network is refused outright.
    expect(hopToVent(s, imp, ventById(map, 'vent_medbay')!, map)).toBe(false);
    expect(imp.inVent).toBe('vent_electrical');
    // Every vent reachable by pressing keys stays on network 1.
    for (let i = 0; i < 20; i++) {
      tryVentHop(s, imp, i % 2 ? 1 : -1, i % 3 ? -1 : 1, map);
      expect(ventById(map, imp.inVent!)!.network).toBe(1);
    }
  });

  it('the player does it with the vent key and direction presses', () => {
    const s = playerAsImpostor(100);
    for (const b of s.bots) b.frozen = true;
    const p = player(s);
    at(p, 57, 56);
    tick(s, 1, { ...NO_INPUT, ventPressed: true });
    expect(p.inVent).toBe('vent_reactor');
    tick(s, 1, { dx: -1, dy: 0 }); // walking keys do nothing inside
    expect(p.inVent).toBe('vent_reactor');
    expect(p.moving).toBe(false);
    tick(s, 1, { dx: 0, dy: 0, ventDx: -1, ventDy: 0 });
    expect(p.inVent).toBe('vent_electrical');
    tick(s, 1, { ...NO_INPUT, ventPressed: true });
    expect(p.inVent).toBeNull();
    expect([Math.floor(p.x / TS), Math.floor(p.y / TS)]).toEqual([5, 56]);
    tick(s, 1, { dx: 1, dy: 0 });
    expect(p.moving).toBe(true);
  });

  it('a crew player pressing the vent key at a vent does nothing', () => {
    const s = game(5);
    if (player(s).role !== 'crew') return;
    const p = player(s);
    at(p, 57, 56);
    tick(s, 1, { ...NO_INPUT, ventPressed: true });
    expect(p.inVent).toBeNull();
  });
});

describe('what bots see', () => {
  it('a unit in a vent is invisible, and sees nothing itself', () => {
    const { s, imp, crew } = stillGame(6);
    const watcher = crew[0]!;
    at(imp, 58, 56);
    at(watcher, 55, 56);
    tick(s, RATE);
    const mem = botOf(s, watcher).memory;
    expect(mem.open[imp.id]).toBeDefined(); // seen while standing there
    tryEnterVent(s, imp, map, config);
    tick(s, RATE);
    expect(mem.open[imp.id]).toBeUndefined(); // stretch closed: out of sight
    expect(botOf(s, imp).memory.open[watcher.id]).toBeUndefined(); // the impostor sees nothing from inside
  });

  it('a bot that sees someone climb in or out is certain they are an impostor', () => {
    const { s, imp, crew } = stillGame(7);
    const near = crew[0]!;
    const far = crew[1]!;
    at(imp, 57, 56);
    at(near, 54, 55); // Reactor, four tiles away
    at(far, 31, 4); // Navigation
    tick(s, 1);
    expect(tryEnterVent(s, imp, map, config)).toBe(true);
    // The climb happened after this tick's perception; run the watchers' perception for it by hand.
    for (const w of [near, far]) {
      perceive(botOf(s, w).memory, w, s, map, config);
      tickSocial(botOf(s, w).social, botOf(s, w).memory, w, s, map, config);
    }
    expect(botOf(s, near).memory.vents).toEqual([{ tick: s.tick, unitId: imp.id, ventId: 'vent_reactor', room: 'Reactor', action: 'enter' }]);
    expect(botOf(s, near).social.certain[imp.id]).toBe(true);
    expect(botOf(s, near).social.evidence.at(-1)?.kind).toBe('sawVent');
    expect(botOf(s, near).social.evidence.at(-1)?.reason).toContain('climb into a vent in Reactor');
    expect(botOf(s, far).memory.vents).toEqual([]);
    expect(botOf(s, far).social.certain[imp.id] ?? false).toBe(false);
    // Climbing out is seen too, by whoever is at that end.
    const admin = crew[2]!;
    at(admin, 33, 45);
    tryVentHop(s, imp, 0, -1, map);
    expect(imp.inVent).toBe('vent_admin');
    tick(s, 1);
    tryExitVent(s, imp, map);
    perceive(botOf(s, admin).memory, admin, s, map, config);
    tickSocial(botOf(s, admin).social, botOf(s, admin).memory, admin, s, map, config);
    expect(botOf(s, admin).memory.vents[0]?.action).toBe('exit');
    expect(botOf(s, admin).social.certain[imp.id]).toBe(true);
  });

  it('the witness says so in the meeting, in the vent wording', () => {
    const { s, imp, crew } = stillGame(8, { difficulty: 'hard', discussionSec: 60 });
    const near = crew[0]!;
    at(imp, 57, 56);
    at(near, 54, 55);
    tick(s, 1);
    tryEnterVent(s, imp, map, config);
    perceive(botOf(s, near).memory, near, s, map, config);
    tickSocial(botOf(s, near).social, botOf(s, near).memory, near, s, map, config);
    tryExitVent(s, imp, map);
    startMeeting(s, near, 'button', null, map, config);
    const line = chooseLine(botOf(s, near), near, s, s.meeting!, map, config);
    expect(line?.intent).toBe('accuse_vent');
    expect(line?.text).toContain(imp.name);
    expect(line?.claim?.kind).toBe('accuse');
    expect(line?.claim?.subjectId).toBe(imp.id);
  });
});

describe('scenario: venting in front of the bots (SPEC 14, Phase 4 done test)', () => {
  it('gets the player voted out at the next meeting', () => {
    const s = playerAsImpostor(200);
    const p = player(s);
    for (const b of s.bots) {
      b.frozen = true;
      s.units[b.unitId]!.tasks = [];
    }
    for (const u of s.units) if (u.role === 'impostor') u.killCooldownTicks = 1e9;
    // Two crew bots stand in Reactor and watch the player climb into the vent.
    const witnesses = s.units.filter((u) => u.role === 'crew' && !u.isPlayer).slice(0, 2);
    at(witnesses[0]!, 54, 55);
    at(witnesses[1]!, 55, 57);
    at(p, 57, 56);
    tick(s, RATE);
    tick(s, 1, { ...NO_INPUT, ventPressed: true });
    expect(p.inVent).toBe('vent_reactor');
    for (const w of witnesses) expect(botOf(s, w).social.certain[p.id]).toBe(true);
    tick(s, RATE, { ...NO_INPUT });
    tick(s, 1, { ...NO_INPUT, ventPressed: true });
    // Let everyone go: a witness heads for the emergency button.
    for (const b of s.bots) b.frozen = false;
    let seenMeeting = false;
    let chat: { unitId: number; intent: string }[] = [];
    for (let i = 0; i < RATE * 180; i++) {
      stepSim(s, NO_INPUT, map, config);
      if (s.phase === 'meeting') {
        seenMeeting = true;
        chat = s.meeting!.chat.map((c) => ({ unitId: c.unitId, intent: c.intent ?? '' }));
      } else if (seenMeeting) break;
      if (s.phase === 'ended') break;
    }
    expect(seenMeeting).toBe(true);
    expect(p.ejected).toBe(true);
    // A witness said so in the vent wording, and its claim carried the "I saw it" weight for the others.
    expect(chat.some((c) => c.intent === 'accuse_vent' && witnesses.some((w) => w.id === c.unitId))).toBe(true);
    const claim = s.claims.find((c) => c.kind === 'accuse' && c.subjectId === p.id && witnesses.some((w) => w.id === c.speakerId));
    expect(claim?.witnessed).toBe(true);
    const bystander = s.units.find((u) => u.role === 'crew' && !u.isPlayer && !witnesses.includes(u))!;
    expect(botOf(s, bystander).social.evidence.some((e) => e.targetId === p.id && e.kind === 'accusedByWitness')).toBe(true);
  });
});

describe('impostor bots and vents', () => {
  it('after a kill beside a vent, a bot slips in, comes out elsewhere on the network, and was unseen meanwhile', () => {
    let vented = 0;
    for (let seed = 300; seed < 312; seed++) {
      const { s, imp, crew } = stillGame(seed, { difficulty: 'hard' });
      const victim = crew[0]!;
      at(imp, 55, 56); // Reactor, three tiles from the vent
      at(victim, 56, 56);
      imp.killCooldownTicks = 0;
      botOf(s, imp).frozen = false;
      const events: string[] = [];
      let exitVent: string | null = null;
      for (let i = 0; i < RATE * 30 && !exitVent; i++) {
        stepSim(s, NO_INPUT, map, config);
        for (const ev of s.events) {
          if (ev.kind === 'kill' || ev.kind === 'ventEnter' || ev.kind === 'ventHop' || ev.kind === 'ventExit') events.push(ev.kind);
          if (ev.kind === 'ventExit') exitVent = ev.ventId;
        }
        if (imp.inVent !== null) {
          // No living bot can see a unit inside a vent (a dead bot's memory simply stops).
          for (const b of s.bots) if (s.units[b.unitId]!.alive) expect(b.memory.open[imp.id]).toBeUndefined();
        }
      }
      expect(events[0]).toBe('kill');
      if (!events.includes('ventEnter')) continue;
      vented++;
      expect(events).toEqual(['kill', 'ventEnter', 'ventHop', 'ventExit']);
      expect(exitVent).not.toBe('vent_reactor');
      expect(ventById(map, exitVent!)!.network).toBe(REACTOR_VENT.network);
      expect(botOf(s, imp).goal.kind).not.toBe('vent');
    }
    // The difficulty's chance is 80%, so twelve tries should vent most of the time.
    expect(vented).toBeGreaterThanOrEqual(6);
  });

  it('a careful bot does not climb out while someone could see the grate; a sloppy one does', () => {
    for (const [difficulty, expectSeen] of [['hard', false], ['easy', true]] as const) {
      let checked = 0;
      for (let seed = 400; seed < 412 && checked < 2; seed++) {
        const { s, imp, crew } = stillGame(seed, { difficulty });
        const victim = crew[0]!;
        const watcher = crew[1]!;
        at(imp, 55, 56);
        at(victim, 56, 56);
        // A crew bot watching every other vent of the network: Electrical and Admin.
        at(watcher, 7, 56);
        const watcher2 = crew[2]!;
        at(watcher2, 33, 45);
        imp.killCooldownTicks = 0;
        botOf(s, imp).frozen = false;
        let entered = false;
        let exitedTick = -1;
        for (let i = 0; i < RATE * 30 && exitedTick < 0; i++) {
          stepSim(s, NO_INPUT, map, config);
          for (const ev of s.events) {
            if (ev.kind === 'ventEnter') entered = true;
            if (ev.kind === 'ventExit') exitedTick = s.tick;
          }
        }
        if (!entered) continue;
        checked++;
        const seen = [watcher, watcher2].some((w) => botOf(s, w).memory.vents.some((v) => v.action === 'exit'));
        expect(seen, `${difficulty} seed ${seed}`).toBe(expectSeen);
        if (difficulty === 'hard') {
          // It waited out the cap inside, then came out anyway (into sight) — or found no clear exit.
          expect(exitedTick).toBeGreaterThan(0);
        }
      }
      expect(checked, difficulty).toBeGreaterThan(0);
    }
  });
});

describe('meetings and vents', () => {
  it('a meeting pulls everyone out of the vents without anyone seeing it', () => {
    const { s, imp, crew } = stillGame(9);
    at(imp, 58, 56);
    tryEnterVent(s, imp, map, config);
    at(crew[0]!, 31, 4);
    startMeeting(s, crew[0]!, 'button', null, map, config);
    expect(imp.inVent).toBeNull();
    expect(s.events.some((e) => e.kind === 'ventExit')).toBe(false);
  });
});
