import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../config/game.json';
import { fillTemplate, pickLine, templatesFor } from '../src/chat/templates';
import { loadMap } from '../src/sim/map';
import { startMeeting, tallyVotes, type Vote } from '../src/sim/meeting';
import { Rng } from '../src/sim/rng';
import { defaultSettings, type GameSettings } from '../src/sim/settings';
import { createGame, NO_INPUT, player, stepSim, type SimState, type Unit } from '../src/sim/sim';

const map = loadMap(JSON.parse(readFileSync(new URL('../assets/maps/kestrel.json', import.meta.url), 'utf8')));
const RATE = config.tickRate;

function meetingGame(over: Partial<GameSettings> = {}, seed = 5): SimState {
  const s = createGame(map, { ...defaultSettings(), players: 8, impostors: 2, ...over }, seed, config);
  startMeeting(s, player(s), 'button', null, map, config);
  return s;
}

function stepTo(s: SimState, ticks: number, input = NO_INPUT): void {
  for (let i = 0; i < ticks; i++) stepSim(s, input, map, config);
}

describe('meeting flow', () => {
  it('goes discussion -> voting -> result -> play on the settings timers', () => {
    const s = meetingGame({ discussionSec: 10, votingSec: 20 });
    expect(s.phase).toBe('meeting');
    expect(s.meeting?.stage).toBe('discussion');
    stepTo(s, 10 * RATE - 1);
    expect(s.meeting?.stage).toBe('discussion');
    stepTo(s, 1);
    expect(s.meeting?.stage).toBe('voting');
    // The player never votes, so voting runs its full length.
    stepTo(s, 20 * RATE);
    expect(s.meeting?.stage).toBe('result');
    expect(s.meeting?.result).not.toBeNull();
    stepTo(s, Math.round(config.meeting.resultSec * RATE));
    expect(s.phase).toBe('play');
    expect(s.meeting).toBeNull();
  });

  it('skips discussion when its time is zero, and ends voting early once everyone alive has voted', () => {
    const s = meetingGame({ discussionSec: 0, votingSec: 60 });
    expect(s.meeting?.stage).toBe('voting');
    stepTo(s, 1, { ...NO_INPUT, voteFor: 'skip' });
    // Bots vote somewhere inside the window; well before 60 s everyone has voted.
    let resultAt = -1;
    for (let i = 0; i < 60 * RATE && resultAt < 0; i++) {
      stepSim(s, NO_INPUT, map, config);
      if (s.meeting?.stage === 'result') resultAt = i;
    }
    expect(resultAt).toBeGreaterThan(0);
    expect(resultAt).toBeLessThan(58 * RATE);
    const living = s.units.filter((u) => u.alive);
    for (const u of living) expect(s.meeting?.votes[u.id], u.name).toBeDefined();
  });

  it('the player can vote, change the vote, and cannot vote for the dead, self, or outside voting', () => {
    const s = meetingGame({ discussionSec: 5, votingSec: 30 });
    const p = player(s);
    const other = s.units.find((u) => !u.isPlayer && u.alive)!;
    stepTo(s, 1, { ...NO_INPUT, voteFor: other.id }); // still discussion: ignored
    expect(s.meeting?.votes[p.id]).toBeUndefined();
    stepTo(s, 5 * RATE);
    expect(s.meeting?.stage).toBe('voting');
    stepTo(s, 1, { ...NO_INPUT, voteFor: p.id });
    expect(s.meeting?.votes[p.id]).toBeUndefined();
    stepTo(s, 1, { ...NO_INPUT, voteFor: other.id });
    expect(s.meeting?.votes[p.id]).toBe(other.id);
    stepTo(s, 1, { ...NO_INPUT, voteFor: 'skip' });
    expect(s.meeting?.votes[p.id]).toBe('skip');
    const dead = s.units.find((u) => !u.isPlayer && u.id !== other.id)!;
    dead.alive = false;
    stepTo(s, 1, { ...NO_INPUT, voteFor: dead.id });
    expect(s.meeting?.votes[p.id]).toBe('skip');
  });

  it('dead units neither vote nor speak; the player can chat while alive', () => {
    const s = meetingGame({ discussionSec: 5, votingSec: 20 });
    const deadBot = s.units.find((u) => !u.isPlayer)!;
    deadBot.alive = false;
    stepTo(s, 1, { ...NO_INPUT, chatText: '  hello everyone  ' });
    expect(s.meeting?.chat.at(-1)).toMatchObject({ unitId: 0, text: 'hello everyone' });
    stepTo(s, 20 * RATE); // 5 s discussion + 15 s of voting: still in the meeting
    expect(s.meeting?.stage).toBe('voting');
    expect(s.meeting?.votes[deadBot.id]).toBeUndefined();
    expect(s.meeting?.chat.some((c) => c.unitId === deadBot.id)).toBe(false);
    player(s).alive = false;
    const before = s.meeting?.chat.length ?? 0;
    stepTo(s, 1, { ...NO_INPUT, chatText: 'ghost talk' });
    expect(s.meeting?.chat.length).toBe(before);
  });
});

describe('vote counting (SPEC 4.4)', () => {
  const s = meetingGame();
  const votes = (v: Record<number, Vote>) => tallyVotes(s, v);

  it('most votes is ejected and the confirm-ejects setting reveals the role', () => {
    const imp = s.units.find((u) => u.role === 'impostor')!;
    const r = votes({ 0: imp.id, 1: imp.id, 2: 'skip' });
    expect(r.ejectedId).toBe(imp.id);
    expect(r.tie).toBe(false);
    expect(r.wasImpostor).toBe(true);
    expect(r.tally).toEqual({ [String(imp.id)]: 2, skip: 1 });
  });

  it('a tie ejects nobody, including a tie with skip', () => {
    expect(votes({ 0: 1, 1: 2 })).toMatchObject({ ejectedId: null, tie: true });
    expect(votes({ 0: 1, 1: 'skip' })).toMatchObject({ ejectedId: null, tie: true });
  });

  it('a skip majority ejects nobody; no votes at all ejects nobody', () => {
    expect(votes({ 0: 'skip', 1: 'skip', 2: 3 })).toMatchObject({ ejectedId: null, tie: false });
    expect(votes({})).toMatchObject({ ejectedId: null, tie: false });
  });

  it('with confirm ejects off, the role is not revealed', () => {
    const q = meetingGame({ confirmEjects: false });
    const r = tallyVotes(q, { 0: 1, 2: 1 });
    expect(r.ejectedId).toBe(1);
    expect(r.wasImpostor).toBeNull();
  });
});

describe('ejection', () => {
  it('the ejected unit is dead, marked ejected, leaves no body, and everyone returns to spawn', () => {
    const s = meetingGame({ discussionSec: 0, votingSec: 30 });
    const target = s.units.find((u) => !u.isPlayer && u.alive)!;
    // Everyone votes for the target: the player now, the bots are forced.
    stepTo(s, 1, { ...NO_INPUT, voteFor: target.id });
    for (const u of s.units) if (u.alive && !u.isPlayer && u.id !== target.id) s.meeting!.votes[u.id] = target.id;
    s.meeting!.votes[target.id] = 'skip';
    stepTo(s, 1);
    expect(s.meeting?.stage).toBe('result');
    expect(s.meeting?.result?.ejectedId).toBe(target.id);
    stepTo(s, Math.round(config.meeting.resultSec * RATE) + 1);
    expect(s.phase).toBe('play');
    expect(target.alive).toBe(false);
    expect(target.ejected).toBe(true);
    expect(s.bodies).toEqual([]);
    for (const u of s.units) expect(map.spawns.some(([sx, sy]) => sx * 32 + 16 === u.x && sy * 32 + 16 === u.y), u.name).toBe(true);
  });
});

describe('Phase 2 bot voices and votes', () => {
  it('bots talk one at a time with at least the configured gap, never repeat a line, and stay under their cap', () => {
    const s = meetingGame({ discussionSec: 15, votingSec: 60 }, 8);
    stepTo(s, 75 * RATE);
    const chat = s.meeting?.chat ?? [];
    expect(chat.length).toBeGreaterThan(3);
    const minGap = Math.round((config.meeting.botChat.gapSec[0] ?? 1.5) * RATE);
    for (let i = 1; i < chat.length; i++) expect(chat[i]!.tick - chat[i - 1]!.tick).toBeGreaterThanOrEqual(1);
    const botLines = chat.filter((c) => c.unitId !== 0 && !['voted', 'done', 'ok voted', 'locked in', 'my vote is in', 'voting now'].includes(c.text));
    for (let i = 1; i < botLines.length; i++) expect(botLines[i]!.tick - botLines[i - 1]!.tick).toBeGreaterThanOrEqual(minGap);
    const texts = chat.map((c) => c.text);
    expect(new Set(texts).size).toBe(texts.length);
    const perBot = new Map<number, number>();
    for (const c of chat) if (c.unitId !== 0) perBot.set(c.unitId, (perBot.get(c.unitId) ?? 0) + 1);
    for (const n of perBot.values()) expect(n).toBeLessThanOrEqual(config.meeting.botChat.maxMessagesPerBot + 1);
  });

  it('a bot answers the player within 2-5 seconds', () => {
    const s = meetingGame({ discussionSec: 30 }, 9);
    stepTo(s, 1, { ...NO_INPUT, chatText: 'where is everyone?' });
    const sentAt = s.tick;
    let replyAt = -1;
    for (let i = 0; i < 6 * RATE && replyAt < 0; i++) {
      stepSim(s, NO_INPUT, map, config);
      const last = s.meeting?.chat.at(-1);
      if (last && last.unitId !== 0 && s.meeting?.chat.some((c) => c.tick > sentAt && ['what?', 'ok...', 'hm', 'say what you mean', 'sure Greg', 'if you say so', 'and?', 'ok Greg'].includes(c.text))) replyAt = s.tick;
    }
    expect(replyAt).toBeGreaterThan(0);
    expect(replyAt - sentAt).toBeGreaterThanOrEqual(2 * RATE);
    expect(replyAt - sentAt).toBeLessThanOrEqual(5 * RATE + 1);
  });

  it('bots vote for living units or skip, never for themselves, and impostors never for each other', () => {
    for (const seed of [11, 12, 13, 14]) {
      const s = meetingGame({ discussionSec: 0, votingSec: 40 }, seed);
      stepTo(s, 40 * RATE);
      const votes = s.meeting?.result ? s.meeting.votes : {};
      for (const [id, v] of Object.entries(votes)) {
        const voter = s.units[Number(id)] as Unit;
        if (voter.isPlayer) continue;
        if (v === 'skip') continue;
        const target = s.units[v] as Unit;
        expect(target.alive).toBe(true);
        expect(target.id).not.toBe(voter.id);
        if (voter.role === 'impostor') expect(target.role).toBe('crew');
      }
    }
  });
});

describe('templates', () => {
  it('fill slots, tidy spaces, and never repeat within a meeting', () => {
    expect(fillTemplate('i was in {room}', { room: 'Medbay' })).toBe('i was in Medbay');
    expect(fillTemplate('{caller} where was it', {})).toBe('where was it');
    for (const intent of ['open_body', 'open_button', 'alibi', 'shrug', 'skip', 'reply'] as const) expect(templatesFor(intent).length).toBeGreaterThanOrEqual(6);
    const used = new Set<string>();
    const rng = new Rng(1);
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      const line = pickLine('shrug', {}, used, rng);
      if (line) lines.push(line);
    }
    expect(lines.length).toBe(templatesFor('shrug').length);
    expect(new Set(lines).size).toBe(lines.length);
  });
});
