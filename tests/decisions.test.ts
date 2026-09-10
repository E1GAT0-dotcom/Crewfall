import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../config/game.json';
import { broadcastClaim } from '../src/bots/claims';
import { accusationTarget, buildAlibi, myRoomAt, myRoute } from '../src/bots/decisions';
import { assignPersonalities, difficultyTable, PERSONALITIES, personality } from '../src/bots/personality';
import { addEvidence, suspicionOf } from '../src/bots/suspicion';
import { currentMajority, decideVote, reconsiderVote } from '../src/bots/voting';
import { loadMap } from '../src/sim/map';
import { startMeeting } from '../src/sim/meeting';
import { Rng } from '../src/sim/rng';
import { defaultSettings, type GameSettings } from '../src/sim/settings';
import { createGame, NO_INPUT, stepSim, type SimState, type Unit } from '../src/sim/sim';

const map = loadMap(JSON.parse(readFileSync(new URL('../assets/maps/kestrel.json', import.meta.url), 'utf8')));
const TS = map.tileSize;
const RATE = config.tickRate;
const at = (u: Unit, tx: number, ty: number) => {
  u.x = tx * TS + TS / 2;
  u.y = ty * TS + TS / 2;
};
const botOf = (s: SimState, u: Unit) => s.bots.find((b) => b.unitId === u.id)!;
const tick = (s: SimState, n = 1) => {
  for (let i = 0; i < n; i++) stepSim(s, NO_INPUT, map, config);
};

function game(seed = 1, over: Partial<GameSettings> = {}): SimState {
  return createGame(map, { ...defaultSettings(), players: 8, impostors: 2, ...over }, seed, config);
}

/** Bots frozen in Electrical, no tasks, impostors unable to kill: tests move who they want. */
function stillGame(seed = 1, over: Partial<GameSettings> = {}): { s: SimState; crew: Unit[]; imps: Unit[] } {
  const s = game(seed, over);
  for (const b of s.bots) {
    const u = s.units[b.unitId]!;
    u.tasks = [];
    b.frozen = true;
    at(u, 5, 56);
  }
  at(s.units[0]!, 5, 56);
  for (const u of s.units) if (u.role === 'impostor') u.killCooldownTicks = 1e9;
  const bots = s.bots.map((b) => s.units[b.unitId]!);
  return { s, crew: bots.filter((u) => u.role === 'crew'), imps: bots.filter((u) => u.role === 'impostor') };
}

function setPersonality(s: SimState, u: Unit, id: string): void {
  (botOf(s, u) as { personality: string }).personality = id;
}

describe('personalities', () => {
  it('the six from the spec exist with their dials', () => {
    expect(PERSONALITIES.map((p) => p.id).sort()).toEqual(['aggressive', 'analyst', 'follower', 'joker', 'nervous', 'quiet']);
    expect(personality('aggressive').accuseThreshold).toBe(35);
    expect(personality('quiet').accuseThreshold).toBe(65);
    expect(personality('follower').followMajority).toBeGreaterThan(personality('analyst').followMajority);
    expect(personality('nervous').reportDelaySec).toBe(3);
    expect(personality('aggressive').reportDelaySec).toBe(0);
  });

  it('are dealt as a mix and deterministically', () => {
    const a = assignPersonalities(9, new Rng(4));
    const b = assignPersonalities(9, new Rng(4));
    expect(a).toEqual(b);
    expect(new Set(a.slice(0, 6)).size).toBe(6);
    const s = game(3);
    expect(s.bots.every((bot) => PERSONALITIES.some((p) => p.id === bot.personality))).toBe(true);
    expect(new Set(s.bots.map((bot) => bot.personality)).size).toBeGreaterThanOrEqual(5);
  });

  it('the difficulty table has the spec rows', () => {
    expect(difficultyTable('easy').killCaution).toBe('onlyAlone');
    expect(difficultyTable('normal').crossCheckClaims).toBeGreaterThan(difficultyTable('easy').crossCheckClaims);
    expect(difficultyTable('hard').selfReportChance).toBeGreaterThan(0);
    expect(difficultyTable('hard').memorySpanMeetings).toBeNull();
  });
});

describe('crew votes', () => {
  it('vote the top suspect above the personality threshold, with the evidence as the reason', () => {
    const { s, crew } = stillGame(5);
    const me = crew[0]!;
    const bad = crew[1]!;
    setPersonality(s, me, 'aggressive');
    startMeeting(s, s.units[0]!, 'button', null, map, config);
    const bot = botOf(s, me);
    addEvidence(bot.social, bad.id, 'leftBodyRoom', `${bad.name} left Reactor 8 s before the report`, s.tick);
    const d = decideVote(bot, me, s);
    expect(d.vote).toBe(bad.id);
    expect(d.reason).toContain(`${bad.name} at 35`);
    expect(d.reason).toContain('left Reactor');
  });

  it('skip when nobody is above the threshold, and say who came closest', () => {
    const { s, crew } = stillGame(6);
    const me = crew[0]!;
    setPersonality(s, me, 'quiet'); // votes at 50
    startMeeting(s, s.units[0]!, 'button', null, map, config);
    const bot = botOf(s, me);
    addEvidence(bot.social, crew[1]!.id, 'leftBodyRoom', 'x', s.tick);
    const d = decideVote(bot, me, s);
    expect(d.vote).toBe('skip');
    expect(d.reason).toContain(`top: ${crew[1]!.name} 35`);
  });

  it('followers go with a majority when their own suspect is weak', () => {
    const { s, crew } = stillGame(7);
    const me = crew[0]!;
    setPersonality(s, me, 'follower');
    startMeeting(s, s.units[0]!, 'button', null, map, config);
    s.meeting!.stage = 'voting';
    s.meeting!.votes = { [crew[1]!.id]: crew[3]!.id, [crew[2]!.id]: crew[3]!.id };
    expect(currentMajority(s.meeting!, s)?.id).toBe(crew[3]!.id);
    let followed = 0;
    for (let i = 0; i < 20; i++) if (decideVote(botOf(s, me), me, s).vote === crew[3]!.id) followed++;
    expect(followed).toBeGreaterThan(12);
    setPersonality(s, me, 'analyst');
    let followedAnalyst = 0;
    for (let i = 0; i < 20; i++) if (decideVote(botOf(s, me), me, s).vote === crew[3]!.id) followedAnalyst++;
    expect(followedAnalyst).toBeLessThan(followed);
  });

  it('analysts refuse weak evidence in the first meeting', () => {
    const { s, crew } = stillGame(8);
    const me = crew[0]!;
    setPersonality(s, me, 'analyst');
    startMeeting(s, s.units[0]!, 'button', null, map, config);
    const bot = botOf(s, me);
    addEvidence(bot.social, crew[1]!.id, 'contradiction', 'x', s.tick); // 40 (analyst votes at 45)
    addEvidence(bot.social, crew[1]!.id, 'selfReport', 'x', s.tick); // 50: above 45 but below the 60 early caution
    const d = decideVote(bot, me, s);
    expect(d.vote).toBe('skip');
    expect(d.reason).toContain('first meeting');
    (s as { meetingsHeld: number }).meetingsHeld = 2;
    expect(decideVote(bot, me, s).vote).toBe(crew[1]!.id);
  });

  it('a bot may change its vote once when a new top suspect jumps ahead', () => {
    const { s, crew } = stillGame(9);
    const me = crew[0]!;
    setPersonality(s, me, 'joker');
    startMeeting(s, s.units[0]!, 'button', null, map, config);
    const bot = botOf(s, me);
    expect(reconsiderVote(bot, me, s, 'skip')).toBeNull();
    addEvidence(bot.social, crew[2]!.id, 'witnessedKill', 'saw it', s.tick);
    const change = reconsiderVote(bot, me, s, 'skip');
    expect(change?.vote).toBe(crew[2]!.id);
    expect(change?.reason).toContain('changed my vote');
    bot.voteChanged = true;
    expect(reconsiderVote(bot, me, s, 'skip')).toBeNull();
  });
});

describe('impostor votes', () => {
  it('never vote their partner and join a majority on a crew member', () => {
    // A seed where both impostors are bots.
    let seed = 10;
    let made = stillGame(seed);
    while (made.imps.length < 2) made = stillGame(++seed);
    const { s, crew, imps } = made;
    const [a, b] = imps as [Unit, Unit];
    startMeeting(s, s.units[0]!, 'button', null, map, config);
    s.meeting!.stage = 'voting';
    for (let i = 0; i < 30; i++) expect(decideVote(botOf(s, a), a, s).vote).not.toBe(b.id);
    s.meeting!.votes = { [crew[0]!.id]: crew[3]!.id, [crew[1]!.id]: crew[3]!.id };
    const d = decideVote(botOf(s, a), a, s);
    expect(d.vote).toBe(crew[3]!.id);
    expect(d.reason).toContain('majority');
  });

  it('vote their loudest accuser when the crowd turns on them', () => {
    const { s, crew, imps } = stillGame(11);
    const imp = imps[0]!;
    const accuser = crew[2]!;
    startMeeting(s, s.units[0]!, 'button', null, map, config);
    s.meeting!.stage = 'voting';
    const w = { fromTick: 0, toTick: s.tick };
    broadcastClaim(s, { speakerId: accuser.id, kind: 'accuse', subjectId: imp.id, room: null, otherId: null, ...w }, map, config);
    s.meeting!.votes = { [crew[0]!.id]: imp.id, [crew[1]!.id]: imp.id };
    const d = decideVote(botOf(s, imp), imp, s);
    expect(d.vote).toBe(accuser.id);
    expect(d.reason).toContain('loudest accuser');
  });

  it('skip when the crew is thin', () => {
    const { s, crew, imps } = stillGame(12);
    for (const u of crew.slice(2)) u.alive = false; // 2 crew bots + player = 3 crew vs 2 impostors
    startMeeting(s, s.units[0]!, 'button', null, map, config);
    s.meeting!.stage = 'voting';
    const d = decideVote(botOf(s, imps[0]!), imps[0]!, s);
    expect(d.vote).toBe('skip');
    expect(d.reason).toContain('thin');
  });
});

describe('alibis and accusations', () => {
  it('a bot knows its own route and where it was at a moment', () => {
    const { s, crew } = stillGame(13);
    const me = crew[0]!;
    at(me, 30, 28); // Cafeteria (31,28 is the button tile)
    tick(s, RATE * 2);
    at(me, 31, 42); // Admin
    tick(s, RATE * 2);
    at(me, 52, 55); // Reactor
    tick(s, RATE * 2);
    const mem = botOf(s, me).memory;
    expect(myRoomAt(mem, RATE * 1)?.room).toBe('Cafeteria');
    expect(myRoomAt(mem, RATE * 3)?.room).toBe('Admin');
    expect(myRoute(mem, 0, s.tick).map((v) => v.room)).toEqual(['Cafeteria', 'Admin', 'Reactor']);
  });

  it('crew tell the truth; an impostor swaps the kill room for a room it really passed, and sticks to it', () => {
    const { s, crew, imps } = stillGame(14);
    const imp = imps[0]!;
    const victim = crew[0]!;
    at(imp, 49, 40); // Storage
    tick(s, RATE * 5);
    at(imp, 52, 55); // Reactor
    tick(s, RATE * 5);
    // The kill, recorded the way stepHunt records it.
    victim.alive = false;
    victim.deathTick = s.tick;
    s.bodies.push({ unitId: victim.id, x: 52 * TS, y: 55 * TS, tick: s.tick });
    botOf(s, imp).memory.myKills.push({ tick: s.tick, victimId: victim.id, room: 'Reactor' });
    tick(s, RATE * 3);
    at(imp, 35, 54); // Engine
    tick(s, RATE * 5);
    startMeeting(s, crew[1]!, 'body', victim.id, map, config);
    const window = { fromTick: s.tick - 45 * RATE, toTick: s.tick };
    const lie = buildAlibi(botOf(s, imp), imp, s, window, config);
    expect(lie.truthful).toBe(false);
    expect(lie.room).not.toBe('Reactor');
    expect(['Storage', 'Engine']).toContain(lie.room);
    expect(lie.why).toContain('claiming');
    expect(buildAlibi(botOf(s, imp), imp, s, window, config)).toEqual(lie);
    const honest = buildAlibi(botOf(s, crew[1]!), crew[1]!, s, window, config);
    expect(honest.truthful).toBe(true);
    expect(honest.room).toBe('Electrical');
  });

  it('crew accuse their top suspect only above the personality threshold; impostors accuse their accuser', () => {
    const { s, crew, imps } = stillGame(15);
    const me = crew[0]!;
    setPersonality(s, me, 'aggressive');
    const bot = botOf(s, me);
    expect(accusationTarget(bot, me, s)).toBeNull();
    addEvidence(bot.social, crew[1]!.id, 'contradiction', `${crew[1]!.name} says Medbay but I saw them in Storage`, s.tick);
    const target = accusationTarget(bot, me, s)!;
    expect(target.id).toBe(crew[1]!.id);
    expect(target.reason).toContain('says Medbay');
    setPersonality(s, me, 'quiet'); // needs 65
    expect(accusationTarget(botOf(s, me), me, s)).toBeNull();
    const imp = imps[0]!;
    startMeeting(s, s.units[0]!, 'button', null, map, config);
    const w = { fromTick: 0, toTick: s.tick };
    broadcastClaim(s, { speakerId: crew[3]!.id, kind: 'accuse', subjectId: imp.id, room: null, otherId: null, ...w }, map, config);
    const back = accusationTarget(botOf(s, imp), imp, s)!;
    expect(back.id).toBe(crew[3]!.id);
    expect(back.reason).toContain('accusing me');
  });
});

describe('behaviours in play', () => {
  it('a bot with a witnessed kill and no body in sight walks to the button and calls a meeting', () => {
    const s = game(16, { emergencyMeetings: 1 });
    const me = s.units.find((u) => !u.isPlayer && u.role === 'crew')!;
    const bad = s.units.find((u) => u.role === 'impostor')!;
    for (const b of s.bots) if (b.unitId !== me.id) b.frozen = true;
    for (const u of s.units) if (u.role === 'impostor') u.killCooldownTicks = 1e9;
    at(me, 8, 15); // Weapons
    addEvidence(botOf(s, me).social, bad.id, 'witnessedKill', 'saw it', 1);
    let meetingAt = -1;
    for (let i = 0; i < RATE * 60 && meetingAt < 0; i++) {
      stepSim(s, NO_INPUT, map, config);
      if (s.phase === 'meeting') meetingAt = s.tick;
    }
    expect(meetingAt).toBeGreaterThan(0);
    expect(s.meeting?.calledBy).toBe(me.id);
    expect(s.meeting?.reason).toBe('button');
  });

  it('a crew bot alone with its top suspect walks away from them', () => {
    const { s, crew } = stillGame(17);
    const me = crew[0]!;
    const scary = crew[1]!;
    botOf(s, me).frozen = false;
    at(me, 52, 54); // Reactor, dead end
    at(scary, 54, 54);
    addEvidence(botOf(s, me).social, scary.id, 'contradiction', 'x', 1);
    addEvidence(botOf(s, me).social, scary.id, 'selfReport', 'x', 1); // 50
    const before = Math.hypot(me.x - scary.x, me.y - scary.y);
    tick(s, RATE * 6);
    expect(botOf(s, me).goal.kind === 'flee' || Math.hypot(me.x - scary.x, me.y - scary.y) > before + 3 * TS).toBe(true);
    expect(Math.hypot(me.x - scary.x, me.y - scary.y)).toBeGreaterThan(before);
  });

  it('a buddying personality tags along with someone in sight', () => {
    const { s, crew } = stillGame(18);
    const me = crew[0]!;
    const friend = crew[1]!;
    setPersonality(s, me, 'follower');
    botOf(s, me).frozen = false;
    botOf(s, me).pauseTicks = 0;
    at(me, 26, 26); // Cafeteria
    at(friend, 38, 33); // Cafeteria, far corner
    let followed = false;
    for (let i = 0; i < RATE * 60 && !followed; i++) {
      stepSim(s, NO_INPUT, map, config);
      if (botOf(s, me).goal.kind === 'follow') followed = true;
    }
    expect(followed).toBe(true);
    tick(s, RATE * 10);
    expect(Math.hypot(me.x - friend.x, me.y - friend.y)).toBeLessThan(4 * TS);
  });

  it('easy impostors only strike when nobody else is anywhere near; normal ones when nobody could see', () => {
    const scene = (difficulty: 'easy' | 'normal') => {
      const s = game(19, { difficulty, crewVision: 0.5, impostorVision: 0.75 });
      const imp = s.units.find((u) => !u.isPlayer && u.role === 'impostor')!;
      const victim = s.units.find((u) => !u.isPlayer && u.role === 'crew')!;
      const bystander = s.units.find((u) => !u.isPlayer && u.role === 'crew' && u !== victim)!;
      for (const b of s.bots) {
        b.frozen = b.unitId !== imp.id;
        s.units[b.unitId]!.tasks = [];
      }
      for (const u of s.units) at(u, 31, 4); // everyone in Navigation
      at(imp, 50, 54); // Reactor
      at(victim, 53, 54); // Reactor
      at(bystander, 49, 40); // Storage, ~14.6 tiles from the victim: beyond crew sight at 0.5x (11.5 tiles) but within impostor sight at 0.75x (17 tiles)
      imp.killCooldownTicks = 0;
      for (let i = 0; i < RATE * 20 && victim.alive; i++) stepSim(s, NO_INPUT, map, config);
      return victim.alive;
    };
    expect(scene('easy')).toBe(true); // a bystander in sight: no kill
    expect(scene('normal')).toBe(false); // nobody could see: kill
  });

  it('hard impostors sometimes report their own kill', () => {
    let selfReports = 0;
    let kills = 0;
    for (let seed = 30; seed < 46; seed++) {
      const s = game(seed, { difficulty: 'hard', crewVision: 0.5, impostorVision: 0.75 });
      const imp = s.units.find((u) => !u.isPlayer && u.role === 'impostor')!;
      const victim = s.units.find((u) => !u.isPlayer && u.role === 'crew')!;
      for (const b of s.bots) {
        b.frozen = b.unitId !== imp.id;
        s.units[b.unitId]!.tasks = [];
      }
      for (const u of s.units) at(u, 31, 4);
      at(imp, 50, 54);
      at(victim, 53, 54);
      imp.killCooldownTicks = 0;
      for (let i = 0; i < RATE * 25 && s.phase === 'play'; i++) stepSim(s, NO_INPUT, map, config);
      if (!victim.alive) kills++;
      if (s.phase === 'meeting' && s.meeting?.calledBy === imp.id) selfReports++;
    }
    expect(kills).toBeGreaterThan(8);
    expect(selfReports).toBeGreaterThan(0);
    expect(selfReports).toBeLessThan(kills);
  });

  it('impostors skip visual tasks on normal and hard', () => {
    const s = game(20, { difficulty: 'hard' });
    const imp = s.units.find((u) => !u.isPlayer && u.role === 'impostor')!;
    const visualSpots = new Set(map.tasks.filter((t) => t.task === 'clear_asteroids' || t.task === 'empty_chute').map((t) => t.id));
    for (const u of s.units) if (u.role === 'impostor') u.killCooldownTicks = 1e9;
    let visited = false;
    for (let i = 0; i < RATE * 300 && s.phase === 'play' && !visited; i++) {
      stepSim(s, NO_INPUT, map, config);
      const g = botOf(s, imp).goal;
      if (g.kind === 'task' && visualSpots.has(g.spotId)) visited = true;
    }
    expect(visited).toBe(false);
  });

  it('personalities keep a full game deterministic', () => {
    const play = () => {
      const s = createGame(map, { ...defaultSettings(), players: 10, impostors: 2, crewVision: 0.5 }, 88, config);
      for (let i = 0; i < RATE * 240 && s.phase !== 'ended'; i++) stepSim(s, s.phase === 'meeting' ? { ...NO_INPUT, voteFor: 'skip' } : NO_INPUT, map, config);
      return { phase: s.phase, tick: s.tick, units: s.units.map((u) => [u.name, u.alive, Math.round(u.x)]), reasons: s.bots.map((b) => b.social.lastVoteReason) };
    };
    expect(play()).toEqual(play());
  });
});

describe('suspicion of the player scales by personality', () => {
  it('nervous bots weigh the player more than aggressive ones', () => {
    const { s, crew } = stillGame(21);
    const me = crew[0]!;
    const target = crew[1]!;
    startMeeting(s, s.units[0]!, 'button', null, map, config);
    const w = { fromTick: 0, toTick: s.tick };
    setPersonality(s, me, 'nervous');
    broadcastClaim(s, { speakerId: 0, kind: 'accuse', subjectId: target.id, room: null, otherId: null, ...w }, map, config);
    const nervous = suspicionOf(botOf(s, me).social, target.id);
    const { s: s2, crew: crew2 } = stillGame(21);
    const me2 = crew2[0]!;
    startMeeting(s2, s2.units[0]!, 'button', null, map, config);
    setPersonality(s2, me2, 'aggressive');
    broadcastClaim(s2, { speakerId: 0, kind: 'accuse', subjectId: crew2[1]!.id, room: null, otherId: null, ...w }, map, config);
    const aggressive = suspicionOf(botOf(s2, me2).social, crew2[1]!.id);
    expect(nervous).toBeGreaterThan(aggressive);
  });
});
