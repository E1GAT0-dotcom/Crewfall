// The win/lose screen (SPEC 4.2 step 7): who won, why, who the impostors were, and what next.
// Plain HTML over the canvas, like the other panels.

import { COLORS, type SimState } from '../sim/sim';
import { describeOutcome, playerWon } from '../sim/win';

export class EndPanel {
  private readonly root: HTMLElement;
  private readonly onPlayAgain: () => void;
  private readonly onLobby: () => void;

  constructor(onPlayAgain: () => void, onLobby: () => void) {
    this.onPlayAgain = onPlayAgain;
    this.onLobby = onLobby;
    document.getElementById('end-panel')?.remove();
    this.root = document.createElement('div');
    this.root.id = 'end-panel';
    this.root.hidden = true;
    document.body.appendChild(this.root);
    this.root.addEventListener('keydown', (ev) => ev.stopPropagation());
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(state: SimState): void {
    this.root.innerHTML = '';
    const outcome = state.outcome;
    if (!outcome) return;
    const won = playerWon(state);
    const panel = el('div', 'ep-panel ' + (outcome.winner === 'crew' ? 'ep-crew' : 'ep-impostor'));
    panel.appendChild(el('div', 'ep-side', outcome.winner === 'crew' ? 'CREW WINS' : 'IMPOSTORS WIN'));
    panel.appendChild(el('div', 'ep-you', won === null ? '' : won ? 'You win!' : 'You lose.'));
    panel.appendChild(el('div', 'ep-reason', describeOutcome(state)));

    const impostors = state.units.filter((u) => u.role === 'impostor');
    const list = el('div', 'ep-impostors');
    list.appendChild(el('span', 'ep-label', impostors.length === 1 ? 'The impostor was' : 'The impostors were'));
    for (const u of impostors) {
      const chip = el('span', 'ep-chip');
      const dot = el('span', 'ep-dot');
      dot.style.background = COLORS.find((c) => c.id === u.colorId)?.tint ?? '#ffffff';
      chip.append(dot, el('span', '', u.name + (u.isPlayer ? ' (you)' : '')));
      list.appendChild(chip);
    }
    panel.appendChild(list);

    const stats = el('div', 'ep-stats');
    const dead = state.units.filter((u) => !u.alive).length;
    const minutes = Math.round((outcome.endedTick / 30 / 60) * 10) / 10;
    stats.textContent = `${minutes} min · ${state.meetingsHeld} meeting${state.meetingsHeld === 1 ? '' : 's'} · ${dead} dead · tasks ${state.crewTasks.done}/${state.crewTasks.total} · seed ${state.seed}`;
    panel.appendChild(stats);

    const footer = el('div', 'ep-footer');
    const lobby = button('Lobby', () => this.onLobby());
    const again = button('Play again', () => this.onPlayAgain());
    again.classList.add('ep-primary');
    footer.append(lobby, again);
    panel.appendChild(footer);
    this.root.appendChild(panel);
    this.root.hidden = false;
    again.focus();
  }

  close(): void {
    this.root.hidden = true;
  }

  destroy(): void {
    this.root.remove();
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
  b.className = 'ep-btn';
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}
