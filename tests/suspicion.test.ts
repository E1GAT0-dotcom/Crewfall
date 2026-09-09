import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../config/game.json';
import { broadcastClaim } from '../src/bots/claims';
import { perceive } from '../src/bots/memory';
import { addEvidence, createSocial, onAccusation, onEjectionResult, onMeetingStart, SUSPICION, suspicionOf, tickSocial, topSuspect, trustIn } from '../src/bots/suspicion';
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

function stillGame(seed = 1, over: Partial<GameSettings> = {}): { s: SimState; crew: Unit[]; imps: Unit[] } {
  const s = createGame(map, { ...defaultSettings(), players: 8, impostors: 2, difficulty: 'hard', ...over }, seed, config);
  for (const b of s.bots) {
    const u = s.units[b.unitId]!;
    u.tasks = [];
    b.frozen = true;
    at(u, 5, 56); // Electrical corner: far from everything
  }
  at(s.units[0]!, 5, 56);
  for (const u of s.units) if (u.role === 'impostor') u.killCooldownTicks = 1e9;
  const bots = s.bots.map((b) => s.units[b.unitId]!);
  return { s, crew: bots.filter((u) => u.role === 'crew'), imps: bots.filter((u) => u.role === 'impostor') };
}

const botOf = (s: SimState, u: Unit) => s.bots.find((b) => b.unitId === u.id)!;
const tick = (s: SimState, n = 1) => {
  for (let i = 0; i < n; i++) stepSim(s, NO_INPUT, map, config);
};

describe('the suspicion model', () => {
  it('starts at zero suspicion and half trust, and clamps to 0-100', () => {
    const social = createSocial();
    expect(suspicionOf(social, 3)).toBe(0);
    expect(trustIn(social, 3)).toBe(SUSPICION.trust.start);
    addEvidence(social, 3, 'contradiction', 'x', 1);
    addEvidence(social, 3, 'contradiction', 'x', 2);
    addEvidence(social, 3, 'contradiction', 'x', 3);
    expect(suspicionOf(social, 3)).toBe(100);
    addEvidence(social, 3, 'withMeDuringKill', 'x', 4);
    addEvidence(social, 3, 'withMeDuringKill', 'x', 5);
    addEvidence(social, 3, 'withMeDuringKill', 'x', 6);
    expect(suspicionOf(social, 3)).toBe(0);
    expect(social.evidence.length).toBe(6);
    expect(social.evidence[0]).toMatchObject({ targetId: 3, kind: 'contradiction', change: SUSPICION.weights.contradiction, reason: 'x' });
  });

  it('a witnessed kill is certain: 100 forever, unmoved by decay or clearing', () => {
    const social = createSocial();
    addEvidence(social, 2, 'witnessedKill', 'saw it', 10);
    expect(suspicionOf(social, 2)).toBe(100);
    addEvidence(social, 2, 'decayPerMeeting', 'time', 20);
    addEvidence(social, 2, 'withMeDuringKill', 'alibi', 30);
    addEvidence(social, 2, 'visualTask', 'task', 40);
    expect(suspicionOf(social, 2)).toBe(100);
    expect(social.certain[2]).toBe(true);
    expect(social.cleared[2]).toBeUndefined();
  });

  it('a visual task clears a target for good (until a kill is witnessed)', () => {
    const social = createSocial();
    addEvidence(social, 4, 'leftBodyRoom', 'x', 1);
    addEvidence(social, 4, 'visualTask', 'saw asteroids', 2);
    expect(suspicionOf(social, 4)).toBe(0);
    addEvidence(social, 4, 'contradiction', 'x', 3);
    expect(suspicionOf(social, 4)).toBe(0);
    addEvidence(social, 4, 'witnessedKill', 'saw it', 4);
    expect(suspicionOf(social, 4)).toBe(100);
  });

  it('topSuspect ignores the dead and self', () => {
    const { s, crew } = stillGame(2);
    const me = crew[0]!;
    const social = botOf(s, me).social;
    addEvidence(social, crew[1]!.id, 'contradiction', 'x', 1);
    addEvidence(social, crew[2]!.id, 'leftBodyRoom', 'x', 1);
    expect(topSuspect(social, s, me.id)?.id).toBe(crew[1]!.id);
    crew[1]!.alive = false;
    expect(topSuspect(social, s, me.id)?.id).toBe(crew[2]!.id);
    addEvidence(social, me.id, 'contradiction', 'x', 1);
    expect(topSuspect(social, s, me.id)?.id).toBe(crew[2]!.id);
  });

  it('the weights come from the config file', () => {
    const social = createSocial();
    addEvidence(social, 1, 'leftBodyRoom', 'x', 1);
    expect(suspicionOf(social, 1)).toBe(SUSPICION.weights.leftBodyRoom);
    addEvidence(social, 1, 'accusedByTrustedBot', 'x', 1, 0.5);
    expect(suspicionOf(social, 1)).toBe(SUSPICION.weights.leftBodyRoom + SUSPICION.weights.accusedByTrustedBot * 0.5);
  });
});

describe('evidence from play', () => {
  it('a bot that sees a kill becomes certain about the killer, through the real tick', () => {
    const { s, crew, imps } = stillGame(3);
    const imp = imps[0]!;
    const victim = crew[0]!;
    const witness = crew[1]!;
    at(imp, 52, 55);
    at(victim, 53, 55);
    at(witness, 49, 52);
    imp.killCooldownTicks = 0;
    // Kill inside a tick so perception and the social tick both see the event.
    stepSim(s, NO_INPUT, map, config);
    tryKill(s, imp, victim, config);
    // Re-run this tick's perception by stepping once more? The event is cleared next tick; call the tail by hand.
    const bot = botOf(s, witness);
    // perception + social tick happen at the end of stepSim; emulate the tail of the same tick:
    perceive(bot.memory, witness, s, map, config);
    tickSocial(bot.social, bot.memory, witness, s, map, config);
    expect(suspicionOf(bot.social, imp.id)).toBe(100);
    expect(bot.social.certain[imp.id]).toBe(true);
    expect(bot.social.evidence.at(-1)?.reason).toContain(`I saw ${imp.name} kill ${victim.name} in Reactor`);
    const far = botOf(s, crew[2]!);
    expect(suspicionOf(far.social, imp.id)).toBe(0);
  });

  it('someone glued to me for 15 seconds is shadowing me, flagged once', () => {
    const { s, crew } = stillGame(4);
    const me = crew[0]!;
    const shadow = crew[1]!;
    at(me, 31, 28);
    at(shadow, 32, 28);
    const bot = botOf(s, me);
    tick(s, RATE * 14);
    expect(suspicionOf(bot.social, shadow.id)).toBe(0);
    tick(s, RATE * 2);
    expect(suspicionOf(bot.social, shadow.id)).toBe(SUSPICION.weights.shadowing);
    tick(s, RATE * 10);
    expect(suspicionOf(bot.social, shadow.id)).toBe(SUSPICION.weights.shadowing); // not again within the rearm delay
    expect(bot.social.evidence.at(-1)?.reason).toContain('shadowing me');
  });
});

describe('evidence at a body report', () => {
  /** Watcher in Cafeteria sees the victim with a companion, then the suspect leaves the body room right before the report. */
  function scene(seed: number) {
    const { s, crew, imps } = stillGame(seed);
    const me = crew[0]!;
    const victim = crew[1]!;
    const companion = crew[2]!;
    const leaver = crew[3]!;
    const alibiFriend = crew[4]!;
    at(me, 31, 28); // Cafeteria
    at(victim, 34, 30); // Cafeteria
    at(companion, 35, 30); // beside the victim
    at(leaver, 26, 24); // Cafeteria too
    at(alibiFriend, 30, 28); // right next to me
    tick(s, RATE * 10);
    // Companion walks away; leaver stays; victim dies in Cafeteria (killed by an impostor we keep out of sight).
    at(companion, 31, 4);
    tick(s, RATE * 2);
    const imp = imps[0]!;
    victim.alive = false;
    victim.deathTick = s.tick;
    s.bodies.push({ unitId: victim.id, x: victim.x, y: victim.y, tick: s.tick });
    void imp;
    tick(s, RATE * 3);
    at(leaver, 31, 37); // leaves Cafeteria into the corridor below
    tick(s, RATE * 5);
    return { s, me, victim, companion, leaver, alibiFriend };
  }

  it('leaving the body room, last seen with the victim, self-report, and a solid alibi all register with reasons', () => {
    const { s, me, victim, companion, leaver, alibiFriend } = scene(5);
    const reporter = leaver; // the leaver comes back and reports
    at(reporter, victim.x / TS, victim.y / TS);
    startMeeting(s, reporter, 'body', victim.id, map, config);
    const social = botOf(s, me).social;
    const reasons = social.evidence.map((e) => `${s.units[e.targetId]?.name}: ${e.reason}`);
    expect(suspicionOf(social, companion.id)).toBe(SUSPICION.weights.lastSeenWithVictim);
    expect(reasons.some((r) => r.includes(`${companion.name} was the last one I saw with ${victim.name}`))).toBe(true);
    expect(suspicionOf(social, leaver.id)).toBe(SUSPICION.weights.leftBodyRoom + SUSPICION.weights.selfReport);
    expect(reasons.some((r) => r.includes(`${leaver.name} left Cafeteria`))).toBe(true);
    expect(reasons.some((r) => r.includes('reported') && r.includes('themselves'))).toBe(true);
    expect(suspicionOf(social, alibiFriend.id)).toBe(0);
    expect(reasons.some((r) => r.includes(`${alibiFriend.name} was with me when ${victim.name} died`))).toBe(true);
    expect(social.evidence.find((e) => e.targetId === alibiFriend.id && e.kind === 'withMeDuringKill')?.change).toBe(SUSPICION.weights.withMeDuringKill);
  });

  it('a button meeting only decays', () => {
    const { s, crew } = stillGame(6);
    const me = crew[0]!;
    const social = botOf(s, me).social;
    addEvidence(social, crew[1]!.id, 'leftBodyRoom', 'earlier', 1);
    startMeeting(s, me, 'button', null, map, config);
    expect(suspicionOf(social, crew[1]!.id)).toBe(SUSPICION.weights.leftBodyRoom + SUSPICION.weights.decayPerMeeting);
    expect(social.evidence.at(-1)?.kind).toBe('decayPerMeeting');
  });
});

describe('evidence from meetings', () => {
  it('a contradicted alibi adds suspicion and costs trust; a corroborated one earns trust', () => {
    const { s, crew } = stillGame(7);
    const me = crew[0]!;
    const speaker = crew[1]!;
    at(me, 31, 28);
    at(speaker, 34, 30);
    tick(s, RATE * 10);
    startMeeting(s, me, 'button', null, map, config);
    const social = botOf(s, me).social;
    const w = { fromTick: s.tick - RATE * 30, toTick: s.tick };
    broadcastClaim(s, { speakerId: speaker.id, kind: 'alibi', subjectId: speaker.id, room: 'Reactor', otherId: null, ...w }, map, config);
    expect(suspicionOf(social, speaker.id)).toBe(SUSPICION.weights.contradiction);
    expect(trustIn(social, speaker.id)).toBeCloseTo(SUSPICION.trust.start + SUSPICION.trust.contradicted);
    broadcastClaim(s, { speakerId: speaker.id, kind: 'alibi', subjectId: speaker.id, room: 'Cafeteria', otherId: null, ...w }, map, config);
    expect(trustIn(social, speaker.id)).toBeCloseTo(SUSPICION.trust.start + SUSPICION.trust.contradicted + SUSPICION.trust.corroborated);
  });

  it('accusations weigh by trust for bots and a fixed amount for the player', () => {
    const { s, crew } = stillGame(8);
    const me = crew[0]!;
    const accuser = crew[1]!;
    const target = crew[2]!;
    const social = botOf(s, me).social;
    onAccusation(social, me.id, accuser, target.id, s);
    expect(suspicionOf(social, target.id)).toBeCloseTo(SUSPICION.weights.accusedByTrustedBot * SUSPICION.trust.start);
    onAccusation(social, me.id, s.units[0]!, target.id, s);
    expect(suspicionOf(social, target.id)).toBeCloseTo(SUSPICION.weights.accusedByTrustedBot * SUSPICION.trust.start + SUSPICION.weights.accusedByPlayer);
    onAccusation(social, me.id, accuser, me.id, s); // accusing me does not change my view of myself
    expect(suspicionOf(social, me.id)).toBe(0);
    const w = { fromTick: 0, toTick: s.tick };
    broadcastClaim(s, { speakerId: accuser.id, kind: 'accuse', subjectId: target.id, room: null, otherId: null, ...w }, map, config);
    expect(suspicionOf(social, target.id)).toBeGreaterThan(SUSPICION.weights.accusedByTrustedBot * SUSPICION.trust.start + SUSPICION.weights.accusedByPlayer);
  });

  it('voting out a confirmed crewmate makes the voters look worse', () => {
    const { s, crew } = stillGame(9);
    const me = crew[0]!;
    const ejected = crew[1]!;
    const voter = crew[2]!;
    const social = botOf(s, me).social;
    onEjectionResult(s, ejected.id, false, { [voter.id]: ejected.id, [me.id]: ejected.id, [crew[3]!.id]: 'skip' });
    expect(suspicionOf(social, voter.id)).toBe(SUSPICION.weights.votedOutCrew);
    expect(suspicionOf(social, crew[3]!.id)).toBe(0);
    expect(suspicionOf(social, me.id)).toBe(0);
    expect(social.suspicion[ejected.id]).toBeUndefined();
    const other = createSocial();
    addEvidence(other, ejected.id, 'contradiction', 'x', 1);
    onEjectionResult(s, ejected.id, true, { [voter.id]: ejected.id });
    expect(suspicionOf(botOf(s, me).social, voter.id)).toBe(SUSPICION.weights.votedOutCrew); // an impostor ejection adds nothing
  });
});

describe('in a whole game', () => {
  it('suspicion stays deterministic and every reason is plain text', () => {
    const play = () => {
      const s = createGame(map, { ...defaultSettings(), players: 10, impostors: 2, crewVision: 0.5 }, 55, config);
      for (let i = 0; i < RATE * 240 && s.phase !== 'ended'; i++) stepSim(s, s.phase === 'meeting' ? { ...NO_INPUT, voteFor: 'skip' } : NO_INPUT, map, config);
      return s;
    };
    const a = play();
    const b = play();
    expect(a.bots.map((x) => x.social)).toEqual(b.bots.map((x) => x.social));
    let evidence = 0;
    for (const bot of a.bots) {
      for (const e of bot.social.evidence) {
        evidence++;
        expect(e.reason.length).toBeGreaterThan(5);
        expect(e.reason).not.toMatch(/undefined|NaN|\?/);
      }
    }
    expect(evidence).toBeGreaterThan(0);
  });
});
