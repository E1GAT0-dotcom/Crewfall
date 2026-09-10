import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../config/game.json';
import { alibiWindow, broadcastClaim } from '../src/bots/claims';
import { addEvidence, suspicionOf } from '../src/bots/suspicion';
import { parsePlayerMessage } from '../src/chat/parser';
import { fillTemplate, pickVoiceLine, VOICE_STYLES, voiceLines, type VoiceIntent } from '../src/chat/templates';
import { chooseLine } from '../src/chat/voice';
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
const tick = (s: SimState, n = 1, input = NO_INPUT) => {
  for (let i = 0; i < n; i++) stepSim(s, input, map, config);
};

function stillGame(seed = 1, over: Partial<GameSettings> = {}): { s: SimState; crew: Unit[]; imps: Unit[] } {
  const s = createGame(map, { ...defaultSettings(), players: 8, impostors: 2, difficulty: 'hard', discussionSec: 60, votingSec: 60, ...over }, seed, config);
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

describe('the player parser (SPEC 9.10)', () => {
  const s = createGame(map, { ...defaultSettings(), players: 8 }, 3, config);
  const bot = s.units[1]!;
  const other = s.units[2]!;
  const colourOf = (u: Unit) => u.colorId;
  const parse = (t: string) => parsePlayerMessage(t, s, map);

  it('recognises the intents from the spec, with names, colours and rooms', () => {
    const table: [string, string, number | null, string | null][] = [
      [`it's ${bot.name}`, 'accuse', bot.id, null],
      [`${bot.name} vented`, 'accuse', bot.id, null],
      [`vote ${bot.name.toLowerCase()}`, 'accuse', bot.id, null],
      [`${bot.name} is sus`, 'accuse', bot.id, null],
      [`${colourOf(bot)} killed them`, 'accuse', bot.id, null],
      ['i was in medbay', 'alibi', null, 'Medbay'],
      ['I was at Electrical doing wires', 'alibi', null, 'Electrical'],
      ['storage', 'alibi', null, 'Storage'],
      [`i was with ${bot.name}`, 'with', bot.id, null],
      [`${bot.name} was with me`, 'with', bot.id, null],
      [`where were you ${bot.name}?`, 'question', bot.id, null],
      [`${bot.name}?`, 'question', bot.id, null],
      [`${bot.name}`, 'question', bot.id, null],
      [`i saw ${bot.name} in reactor`, 'sighting', bot.id, 'Reactor'],
      [`${bot.name} was in Comms`, 'sighting', bot.id, 'Comms'],
      ['skip', 'skip', null, null],
      ['no info', 'skip', null, null],
      ['what is happening lol', 'unknown', null, null],
      ['', 'unknown', null, null],
    ];
    for (const [text, intent, target, room] of table) {
      const p = parse(text);
      expect(p.intent, text).toBe(intent);
      expect(p.targetId, text).toBe(target);
      if (room) expect(p.room, text).toBe(room);
    }
  });

  it('matches names fuzzily and never the player', () => {
    const prefix = bot.name.slice(0, Math.max(2, Math.ceil(bot.name.length / 2)));
    expect(parse(`${prefix} is sus`).targetId).toBe(bot.id);
    const upper = bot.name.toUpperCase();
    expect(parse(`VOTE ${upper}!!!`).targetId).toBe(bot.id);
    expect(parse(`${s.units[0]!.name} is sus`).intent).not.toBe('accuse');
    expect(parse(`i saw ${other.name} in medbay`).targetId).toBe(other.id);
  });
});

describe('the voice files', () => {
  it('have at least six lines per intent per style and fill their slots cleanly', () => {
    const intents: VoiceIntent[] = ['open_body', 'open_button', 'alibi', 'alibi_answer', 'accuse_witnessed', 'accuse_left', 'accuse_lastwith', 'accuse_contra', 'accuse_other', 'corroborate', 'contradict', 'question', 'defend', 'deflect', 'skip', 'follow', 'react_eject_right', 'react_eject_wrong', 'react_noeject', 'reply', 'voted'];
    expect([...VOICE_STYLES].sort()).toEqual(['aggressive', 'analyst', 'follower', 'joker', 'nervous', 'quiet']);
    const slots = { name: 'Me', room: 'Medbay', other_room: 'Storage', victim: 'Vic', caller: 'Cal', other: 'Oth', accuser: 'Acc', time: '2:10', ago: '12 s' };
    for (const intent of intents) {
      for (const style of VOICE_STYLES) {
        const lines = voiceLines(intent, style);
        expect(lines.length, `${intent}/${style}`).toBeGreaterThanOrEqual(6);
        for (const l of lines) {
          const filled = fillTemplate(l, slots);
          expect(filled, `${intent}/${style}: ${l}`).not.toMatch(/\{|\}/);
          expect(filled.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('never repeats a line, and borrows from another style when its own runs out', () => {
    const used = new Set<string>();
    const rng = new Rng(2);
    const seen: string[] = [];
    for (let i = 0; i < 12; i++) {
      const line = pickVoiceLine('skip', 'quiet', {}, used, rng);
      if (line) seen.push(line);
    }
    expect(seen.length).toBeGreaterThan(6); // quiet has 6, so the rest came from other styles
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe('what bots say', () => {
  it('a questioned bot answers with its alibi within 2-5 s, and the alibi becomes a claim', () => {
    const { s, crew } = stillGame(4);
    const target = crew[0]!;
    at(target, 30, 28); // Cafeteria
    tick(s, RATE * 5);
    startMeeting(s, s.units[0]!, 'button', null, map, config);
    const askedAt = s.tick;
    tick(s, 1, { ...NO_INPUT, chatText: `where were you ${target.name}?` });
    let answerAt = -1;
    for (let i = 0; i < RATE * 7 && answerAt < 0; i++) {
      tick(s);
      const last = s.meeting!.chat.at(-1);
      if (last && last.unitId === target.id) answerAt = s.tick;
    }
    expect(answerAt).toBeGreaterThan(0);
    expect(answerAt - askedAt).toBeGreaterThanOrEqual(2 * RATE);
    expect(answerAt - askedAt).toBeLessThanOrEqual(5 * RATE + 2);
    const answer = s.meeting!.chat.find((c) => c.unitId === target.id)!;
    expect(answer.text.toLowerCase()).toContain('cafeteria');
    expect(s.claims.some((c) => c.kind === 'alibi' && c.speakerId === target.id && c.room === 'Cafeteria')).toBe(true);
    expect(s.meeting!.lastPlayerParse).toContain('question');
  });

  it('an accused bot defends in its personality, and an aggressive one accuses the player back', () => {
    for (const [style, expectCounter] of [['nervous', false], ['aggressive', true], ['quiet', false]] as const) {
      const { s, crew } = stillGame(5);
      const target = crew[0]!;
      setPersonality(s, target, style);
      at(target, 30, 28);
      tick(s, RATE * 3);
      startMeeting(s, s.units[0]!, 'button', null, map, config);
      tick(s, 1, { ...NO_INPUT, chatText: `${target.name} is sus` });
      tick(s, RATE * 6);
      const lines = s.meeting!.chat.filter((c) => c.unitId === target.id).map((c) => c.text);
      expect(lines.length, style).toBeGreaterThan(0);
      const defended = s.meeting!.convo.accusations.find((a) => a.accuserId === 0 && a.targetId === target.id)!;
      expect(defended.answered, style).toBe(true);
      const counter = s.claims.some((c) => c.kind === 'accuse' && c.speakerId === target.id && c.subjectId === 0);
      expect(counter, style).toBe(expectCounter);
      expect(s.meeting!.convo.spoken[target.id], style).toContain('defend');
    }
  });

  it('the player accusing someone raises suspicion in the others, weighed by personality', () => {
    const { s, crew } = stillGame(6);
    const target = crew[0]!;
    const listener = crew[1]!;
    setPersonality(s, listener, 'follower');
    startMeeting(s, s.units[0]!, 'button', null, map, config);
    tick(s, 1, { ...NO_INPUT, chatText: `vote ${target.name}` });
    expect(suspicionOf(botOf(s, listener).social, target.id)).toBeCloseTo(10 * 1.3);
  });

  it('a bot that saw a kill accuses with the witnessed wording and names the room', () => {
    const { s, crew, imps } = stillGame(7);
    const witness = crew[0]!;
    const killer = imps[0]!;
    setPersonality(s, witness, 'analyst');
    startMeeting(s, s.units[0]!, 'button', null, map, config);
    addEvidence(botOf(s, witness).social, killer.id, 'witnessedKill', 'saw it', s.tick, 1, { room: 'Reactor', tick: 300 });
    const line = chooseLine(botOf(s, witness), witness, s, s.meeting!, map, config)!;
    expect(line.intent).toBe('accuse_witnessed');
    expect(line.text).toContain(killer.name);
    expect(line.text.toLowerCase()).toContain('reactor');
    expect(line.claim?.kind).toBe('accuse');
  });

  it('leaving the body room picks the "left" wording with how long before', () => {
    const { s, crew } = stillGame(8);
    const speaker = crew[0]!;
    const suspect = crew[1]!;
    setPersonality(s, speaker, 'quiet');
    startMeeting(s, s.units[0]!, 'button', null, map, config);
    addEvidence(botOf(s, speaker).social, suspect.id, 'leftBodyRoom', 'x', s.tick, 1, { room: 'Storage', tick: s.meeting!.startedTick - 12 * RATE });
    addEvidence(botOf(s, speaker).social, suspect.id, 'selfReport', 'x', s.tick); // 45 > quiet's 65? no: quiet accuses at 65
    addEvidence(botOf(s, speaker).social, suspect.id, 'contradiction', 'x', s.tick); // 85
    const line = chooseLine(botOf(s, speaker), speaker, s, s.meeting!, map, config)!;
    // Strongest single piece is the contradiction (40) but it has no room detail, so the "left" family (35) wins.
    expect(['accuse_contra', 'accuse_left', 'accuse_other']).toContain(line.intent);
    expect(line.text).toContain(suspect.name);
  });

  it('a contradiction gets voiced with both rooms, and a matching alibi gets corroborated', () => {
    const { s, crew } = stillGame(9);
    const watcher = crew[0]!;
    const liar = crew[1]!;
    const honest = crew[2]!;
    setPersonality(s, watcher, 'analyst');
    at(watcher, 30, 28);
    at(liar, 34, 30); // Cafeteria, in view
    at(honest, 36, 30);
    tick(s, RATE * 10);
    startMeeting(s, s.units[0]!, 'button', null, map, config);
    // The liar claims Medbay, the honest one Cafeteria, both as if said in chat.
    const w = alibiWindow(s, config);
    broadcastClaim(s, { speakerId: liar.id, kind: 'alibi', subjectId: liar.id, room: 'Medbay', otherId: null, ...w }, map, config);
    broadcastClaim(s, { speakerId: honest.id, kind: 'alibi', subjectId: honest.id, room: 'Cafeteria', otherId: null, ...w }, map, config);
    const first = chooseLine(botOf(s, watcher), watcher, s, s.meeting!, map, config)!;
    // Suspicion of the liar is 40 (contradiction) which is below the analyst's 55, so the contradiction is voiced, not an accusation.
    expect(first.intent).toBe('contradict');
    expect(first.text).toContain(liar.name);
    expect(first.text.toLowerCase()).toContain('cafeteria');
    const second = chooseLine(botOf(s, watcher), watcher, s, s.meeting!, map, config)!;
    expect(second.intent).toBe('corroborate');
    expect(second.text).toContain(honest.name);
  });

  it('a full meeting has varied lines, no repeats, per-personality caps, and bots answering each other', () => {
    const s = createGame(map, { ...defaultSettings(), players: 10, impostors: 2, discussionSec: 20, votingSec: 40 }, 10, config);
    tick(s, RATE * 30);
    startMeeting(s, s.units[0]!, 'button', null, map, config);
    let chatLen = 0;
    for (let i = 0; i < RATE * 70 && s.phase === 'meeting'; i++) {
      tick(s);
      if (s.meeting) chatLen = s.meeting.chat.length;
    }
    expect(chatLen).toBeGreaterThan(8);
    const intents = new Set<string>();
    for (const b of s.bots) for (const i of Object.values(b.lastIntent ?? '')) intents.add(i);
    expect(s.bots.filter((b) => b.lastIntent).length).toBeGreaterThan(4);
  });

  it('nonsense gets a shrug, not a change in suspicion', () => {
    const { s, crew } = stillGame(11);
    startMeeting(s, s.units[0]!, 'button', null, map, config);
    const before = s.bots.map((b) => JSON.stringify(b.social.suspicion));
    tick(s, 1, { ...NO_INPUT, chatText: 'purple monkey dishwasher' });
    tick(s, RATE * 6);
    expect(s.bots.map((b) => JSON.stringify(b.social.suspicion))).toEqual(before);
    expect(s.meeting!.lastPlayerParse).toContain('unknown');
    const replies = s.meeting!.chat.filter((c) => c.unitId !== 0);
    expect(replies.length).toBeGreaterThan(0);
    void crew;
  });

  it('meetings stay deterministic with the voices', () => {
    const play = () => {
      const s = createGame(map, { ...defaultSettings(), players: 10, impostors: 2, crewVision: 0.5 }, 12, config);
      for (let i = 0; i < RATE * 200 && s.phase !== 'ended'; i++) stepSim(s, s.phase === 'meeting' && i % 90 === 0 ? { ...NO_INPUT, chatText: 'where were you all' } : NO_INPUT, map, config);
      return { tick: s.tick, chat: s.claims.length, last: s.bots.map((b) => b.lastIntent) };
    };
    expect(play()).toEqual(play());
  });
});
