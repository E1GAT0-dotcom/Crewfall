// The lobby computer's settings panel. Plain HTML laid over the game canvas, built from a list of
// setting definitions so adding a setting is one line. Phaser's keyboard is paused while it is open
// so typing a name does not walk the player around.

import { COLORS } from '../sim/sim';
import { clampSettings, SETTING_RANGES, type GameSettings, type NumericSettingKey } from '../sim/settings';
import { randomSeed } from '../sim/rng';

type Row =
  | { key: NumericSettingKey; label: string; kind: 'number'; suffix?: string; help?: string }
  | { key: 'difficulty' | 'killDistance' | 'taskBarUpdates'; label: string; kind: 'choice'; options: readonly string[]; help?: string }
  | { key: 'anonymousVotes' | 'confirmEjects' | 'visualTasks'; label: string; kind: 'toggle'; help?: string };

const ROWS: readonly Row[] = [
  { key: 'players', label: 'Players', kind: 'number', help: 'You plus the bots.' },
  { key: 'impostors', label: 'Impostors', kind: 'number' },
  { key: 'difficulty', label: 'Bot difficulty', kind: 'choice', options: ['easy', 'normal', 'hard'], help: 'Used from Phase 3.' },
  { key: 'killCooldownSec', label: 'Kill cooldown', kind: 'number', suffix: 's' },
  { key: 'killDistance', label: 'Kill distance', kind: 'choice', options: ['short', 'medium', 'long'] },
  { key: 'emergencyMeetings', label: 'Emergency meetings', kind: 'number', help: 'Per player, per game.' },
  { key: 'discussionSec', label: 'Discussion time', kind: 'number', suffix: 's' },
  { key: 'votingSec', label: 'Voting time', kind: 'number', suffix: 's' },
  { key: 'anonymousVotes', label: 'Anonymous votes', kind: 'toggle' },
  { key: 'confirmEjects', label: 'Confirm ejects', kind: 'toggle', help: 'Say whether the ejected one was an impostor.' },
  { key: 'playerSpeed', label: 'Walking speed', kind: 'number', suffix: 'x' },
  { key: 'crewVision', label: 'Crew vision', kind: 'number', suffix: 'x', help: 'How far crew can see.' },
  { key: 'impostorVision', label: 'Impostor vision', kind: 'number', suffix: 'x' },
  { key: 'commonTasks', label: 'Common tasks', kind: 'number' },
  { key: 'longTasks', label: 'Long tasks', kind: 'number' },
  { key: 'shortTasks', label: 'Short tasks', kind: 'number' },
  { key: 'taskBarUpdates', label: 'Task bar updates', kind: 'choice', options: ['always', 'meetings', 'never'] },
  { key: 'visualTasks', label: 'Visual tasks', kind: 'toggle', help: 'Used from Phase 5.' },
];

export interface SettingsPanelResult {
  settings: GameSettings;
  seedText: string;
}

export class SettingsPanel {
  private readonly root: HTMLElement;
  private readonly caps: { playerCap: number; impostorMax: number };
  private settings!: GameSettings;
  private seedText = '';
  private onClose: ((result: SettingsPanelResult) => void) | null = null;

  constructor(caps: { playerCap: number; impostorMax: number }) {
    this.caps = caps;
    const existing = document.getElementById('settings-panel');
    if (existing) existing.remove();
    this.root = document.createElement('div');
    this.root.id = 'settings-panel';
    this.root.hidden = true;
    document.body.appendChild(this.root);
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(settings: GameSettings, seedText: string, onClose: (result: SettingsPanelResult) => void): void {
    this.settings = { ...settings };
    this.seedText = seedText;
    this.onClose = onClose;
    this.render();
    this.root.hidden = false;
  }

  close(): void {
    if (this.root.hidden) return;
    this.root.hidden = true;
    const result = { settings: clampSettings(this.settings, this.caps), seedText: this.seedText.trim() };
    const cb = this.onClose;
    this.onClose = null;
    cb?.(result);
  }

  destroy(): void {
    this.root.remove();
  }

  private render(): void {
    const s = this.settings;
    this.root.innerHTML = '';
    const panel = el('div', 'sp-panel');
    panel.appendChild(el('h2', 'sp-title', 'Game settings'));

    // Identity: name and colour.
    const identity = el('div', 'sp-row');
    identity.appendChild(el('label', 'sp-label', 'Your name'));
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.maxLength = 12;
    nameInput.value = s.playerName;
    nameInput.className = 'sp-input';
    nameInput.addEventListener('input', () => {
      s.playerName = nameInput.value;
    });
    identity.appendChild(nameInput);
    panel.appendChild(identity);

    const colourRow = el('div', 'sp-row');
    colourRow.appendChild(el('label', 'sp-label', 'Your colour'));
    const swatches = el('div', 'sp-swatches');
    for (const c of COLORS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sp-swatch' + (c.id === s.playerColor ? ' sp-swatch-on' : '');
      b.style.background = c.tint;
      b.title = c.name;
      b.addEventListener('click', () => {
        s.playerColor = c.id;
        this.render();
      });
      swatches.appendChild(b);
    }
    colourRow.appendChild(swatches);
    panel.appendChild(colourRow);

    // Map is fixed to Kestrel until Phase 6.
    const mapRow = el('div', 'sp-row');
    mapRow.appendChild(el('label', 'sp-label', 'Map'));
    mapRow.appendChild(el('span', 'sp-value', 'Kestrel (more maps in Phase 6)'));
    panel.appendChild(mapRow);

    for (const row of ROWS) {
      const r = el('div', 'sp-row');
      const label = el('label', 'sp-label', row.label);
      if (row.help) label.title = row.help;
      r.appendChild(label);
      if (row.kind === 'number') {
        const range = SETTING_RANGES[row.key];
        let max: number = range.max;
        if (row.key === 'players') max = Math.min(max, this.caps.playerCap);
        if (row.key === 'impostors') max = Math.min(max, this.caps.impostorMax, Math.floor((s.players - 1) / 2));
        const value = el('span', 'sp-value', `${formatNumber(s[row.key])}${row.suffix ?? ''}`);
        const minus = button('−', () => {
          s[row.key] = roundTo(Math.max(range.min, s[row.key] - range.step), range.step);
          this.render();
        });
        const plus = button('+', () => {
          s[row.key] = roundTo(Math.min(max, s[row.key] + range.step), range.step);
          this.render();
        });
        minus.disabled = s[row.key] <= range.min;
        plus.disabled = s[row.key] >= max;
        r.append(minus, value, plus);
      } else if (row.kind === 'choice') {
        const group = el('div', 'sp-choices');
        for (const opt of row.options) {
          const b = button(opt, () => {
            (s as unknown as Record<string, unknown>)[row.key] = opt;
            this.render();
          });
          if (s[row.key] === opt) b.classList.add('sp-on');
          group.appendChild(b);
        }
        r.appendChild(group);
      } else {
        const b = button(s[row.key] ? 'On' : 'Off', () => {
          s[row.key] = !s[row.key];
          this.render();
        });
        if (s[row.key]) b.classList.add('sp-on');
        r.appendChild(b);
      }
      panel.appendChild(r);
    }

    // Seed.
    const seedRow = el('div', 'sp-row');
    const seedLabel = el('label', 'sp-label', 'Seed');
    seedLabel.title = 'Same seed, same game. Leave empty for a new random game each time.';
    seedRow.appendChild(seedLabel);
    const seedInput = document.createElement('input');
    seedInput.type = 'text';
    seedInput.placeholder = 'random';
    seedInput.value = this.seedText;
    seedInput.className = 'sp-input';
    seedInput.addEventListener('input', () => {
      this.seedText = seedInput.value;
    });
    seedRow.appendChild(seedInput);
    seedRow.appendChild(
      button('New random', () => {
        this.seedText = String(randomSeed());
        this.render();
      }),
    );
    seedRow.appendChild(
      button('Clear', () => {
        this.seedText = '';
        this.render();
      }),
    );
    panel.appendChild(seedRow);

    const footer = el('div', 'sp-footer');
    const done = button('Done (Esc)', () => this.close());
    done.classList.add('sp-primary');
    footer.appendChild(done);
    panel.appendChild(footer);
    this.root.appendChild(panel);

    this.root.onkeydown = (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        this.close();
      }
      ev.stopPropagation();
    };
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
  b.className = 'sp-btn';
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

function roundTo(v: number, step: number): number {
  const digits = step < 1 ? 2 : 0;
  return Number((Math.round(v / step) * step).toFixed(digits));
}

function formatNumber(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}
