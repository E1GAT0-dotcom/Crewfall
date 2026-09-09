// The meeting screen (SPEC 10): player tiles, timer, chat, voting, result. Plain HTML over the
// canvas, refreshed from the simulation state every frame. The player's clicks and typed lines are
// queued here and fed into the simulation as input by the Play scene.

import { COLORS, type SimState, type Unit } from '../sim/sim';
import type { MeetingState, Vote } from '../sim/meeting';

export interface MeetingActions {
  voteFor?: Vote;
  chatText?: string;
}

export class MeetingPanel {
  private readonly root: HTMLElement;
  private readonly tickRate: number;
  private headline!: HTMLElement;
  private timer!: HTMLElement;
  private tiles!: HTMLElement;
  private log!: HTMLElement;
  private input!: HTMLInputElement;
  private skipBtn!: HTMLButtonElement;
  private confirmBtn!: HTMLButtonElement;
  private status!: HTMLElement;
  private resultBox!: HTMLElement;
  private tileEls = new Map<number, HTMLElement>();
  private selected: Vote | null = null;
  private pending: MeetingActions = {};
  private renderedChat = 0;
  private lastStage = '';

  constructor(tickRate: number) {
    this.tickRate = tickRate;
    document.getElementById('meeting-panel')?.remove();
    this.root = document.createElement('div');
    this.root.id = 'meeting-panel';
    this.root.hidden = true;
    document.body.appendChild(this.root);
    this.build();
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(state: SimState): void {
    this.selected = null;
    this.pending = {};
    this.renderedChat = 0;
    this.lastStage = '';
    this.log.innerHTML = '';
    this.buildTiles(state);
    this.root.hidden = false;
    this.update(state);
  }

  close(): void {
    this.root.hidden = true;
    this.input.blur();
  }

  destroy(): void {
    this.root.remove();
  }

  /** Hands over what the player did since the last call, once. */
  takeActions(): MeetingActions {
    const out = this.pending;
    this.pending = {};
    return out;
  }

  /** Enter focuses the chat box when it is not focused (SPEC 5). */
  focusChat(): void {
    if (!this.input.disabled) this.input.focus();
  }

  update(state: SimState): void {
    const m = state.meeting;
    if (!m) return;
    const player = state.units[0] as Unit;
    const caller = state.units[m.calledBy]?.name ?? 'Someone';
    const victim = m.bodyOf !== null ? state.units[m.bodyOf]?.name ?? 'someone' : null;
    setText(this.headline, m.reason === 'body' ? `${caller} reported ${victim}'s body` : `${caller} called an emergency meeting`);

    const secondsLeft = Math.max(0, Math.ceil((m.stageEndsTick - state.tick) / this.tickRate));
    const stageName = m.stage === 'discussion' ? 'Discussion' : m.stage === 'voting' ? 'Voting' : 'Result';
    setText(this.timer, m.stage === 'result' ? stageName : `${stageName}  ${secondsLeft}s`);

    if (m.stage !== this.lastStage) {
      this.lastStage = m.stage;
      this.root.dataset.stage = m.stage;
    }

    // Tiles: alive/dead, voted marker, vote markers, selection.
    const anonymous = state.settings.anonymousVotes;
    const showVotes = m.stage === 'result' || !anonymous;
    for (const u of state.units) {
      const el = this.tileEls.get(u.id);
      if (!el) continue;
      el.classList.toggle('mp-dead', !u.alive);
      el.classList.toggle('mp-selected', this.selected === u.id);
      el.classList.toggle('mp-voted', m.votes[u.id] !== undefined);
      const marks = el.querySelector('.mp-marks') as HTMLElement;
      const voters = showVotes ? Object.entries(m.votes).filter(([, v]) => v === u.id).map(([id]) => Number(id)) : [];
      const key = voters.join(',');
      if (marks.dataset.key !== key) {
        marks.dataset.key = key;
        marks.innerHTML = '';
        for (const id of voters) {
          const voter = state.units[id];
          const dot = document.createElement('span');
          dot.className = 'mp-mark';
          dot.style.background = colourOf(voter?.colorId);
          dot.title = voter?.name ?? '';
          marks.appendChild(dot);
        }
      }
    }
    const skipVoters = showVotes ? Object.entries(m.votes).filter(([, v]) => v === 'skip').length : 0;
    setText(this.skipBtn, skipVoters > 0 ? `Skip vote (${skipVoters})` : 'Skip vote');
    this.skipBtn.classList.toggle('mp-selected', this.selected === 'skip');

    // Chat log: append only what is new.
    for (; this.renderedChat < m.chat.length; this.renderedChat++) {
      const msg = m.chat[this.renderedChat];
      if (!msg) continue;
      const u = state.units[msg.unitId];
      const line = document.createElement('div');
      line.className = 'mp-line';
      const name = document.createElement('span');
      name.className = 'mp-name';
      name.textContent = u?.name ?? '?';
      name.style.color = textColourOf(u?.colorId);
      const text = document.createElement('span');
      text.textContent = ' ' + msg.text;
      line.append(name, text);
      this.log.appendChild(line);
      this.log.scrollTop = this.log.scrollHeight;
    }

    // Controls by stage and by whether the player is alive.
    const canVote = player.alive && m.stage === 'voting';
    const canChat = player.alive && m.stage !== 'result';
    this.confirmBtn.disabled = !canVote || this.selected === null;
    this.skipBtn.disabled = !canVote;
    this.input.disabled = !canChat;
    this.input.placeholder = canChat ? 'Type, Enter to send' : player.alive ? 'Chat closed' : 'Dead players can read but not type';
    const myVote = m.votes[player.id];
    if (!player.alive) setText(this.status, 'You are dead. You can watch but not vote or talk.');
    else if (m.stage === 'discussion') setText(this.status, 'Discussion: voting opens when the timer ends.');
    else if (m.stage === 'voting') setText(this.status, myVote === undefined ? 'Click a player, then Confirm. You can change your vote until time runs out.' : `Your vote: ${myVote === 'skip' ? 'skip' : state.units[myVote]?.name ?? '?'} (click to change)`);
    else setText(this.status, '');

    // Result.
    if (m.stage === 'result' && m.result) {
      const r = m.result;
      let text: string;
      if (r.ejectedId === null) text = r.tie ? 'Tie: no one was ejected.' : 'No one was ejected.';
      else {
        const name = state.units[r.ejectedId]?.name ?? '?';
        text = r.wasImpostor === null ? `${name} was ejected.` : `${name} was ejected. ${name} was ${r.wasImpostor ? '' : 'not '}an impostor.`;
      }
      setText(this.resultBox, text);
      this.resultBox.hidden = false;
    } else {
      this.resultBox.hidden = true;
    }
  }

  private build(): void {
    const panel = el('div', 'mp-panel');
    const header = el('div', 'mp-header');
    this.headline = el('div', 'mp-headline');
    this.timer = el('div', 'mp-timer');
    header.append(this.headline, this.timer);
    const body = el('div', 'mp-body');
    this.tiles = el('div', 'mp-tiles');
    const chat = el('div', 'mp-chat');
    this.log = el('div', 'mp-log');
    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.maxLength = 120;
    this.input.className = 'mp-input';
    this.input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') {
        const text = this.input.value.trim();
        if (text) this.pending.chatText = text;
        this.input.value = '';
      } else if (ev.key === 'Escape') {
        this.input.blur();
      }
    });
    chat.append(this.log, this.input);
    body.append(this.tiles, chat);
    const footer = el('div', 'mp-footer');
    this.status = el('div', 'mp-status');
    this.skipBtn = button('Skip vote', () => {
      this.selected = 'skip';
      this.pending.voteFor = 'skip';
    });
    this.confirmBtn = button('Confirm vote', () => {
      if (this.selected !== null) this.pending.voteFor = this.selected;
    });
    this.confirmBtn.classList.add('mp-primary');
    footer.append(this.status, this.skipBtn, this.confirmBtn);
    this.resultBox = el('div', 'mp-result');
    this.resultBox.hidden = true;
    panel.append(header, body, footer, this.resultBox);
    this.root.appendChild(panel);
    this.root.addEventListener('keydown', (ev) => ev.stopPropagation());
  }

  private buildTiles(state: SimState): void {
    this.tiles.innerHTML = '';
    this.tileEls.clear();
    for (const u of state.units) {
      const tile = el('div', 'mp-tile');
      const swatch = el('span', 'mp-swatch');
      swatch.style.background = colourOf(u.colorId);
      const name = el('span', 'mp-tile-name', u.name + (u.isPlayer ? ' (you)' : ''));
      const check = el('span', 'mp-check', '✓');
      const marks = el('div', 'mp-marks');
      tile.append(swatch, name, check, marks);
      tile.addEventListener('click', () => {
        if (!u.alive || u.isPlayer) return;
        this.selected = this.selected === u.id ? null : u.id;
      });
      this.tiles.appendChild(tile);
      this.tileEls.set(u.id, tile);
    }
  }
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'mp-btn';
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

function setText(e: HTMLElement | HTMLButtonElement, text: string): void {
  if (e.textContent !== text) e.textContent = text;
}

function colourOf(colorId: string | undefined): string {
  return COLORS.find((c) => c.id === colorId)?.tint ?? '#ffffff';
}

function textColourOf(colorId: string | undefined): string {
  return COLORS.find((c) => c.id === colorId)?.text ?? '#ffffff';
}
