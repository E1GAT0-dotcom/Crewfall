// Heads-up display drawn on top of the Play scene: room name, role and task list, task bar, key
// prompts, the Tab map and the F3 debug text. The meeting screen itself is src/ui/MeetingPanel.ts.
// Runs as its own scene so it is not affected by the world camera.

import Phaser from 'phaser';
import { describeGoal } from '../bots/brain';
import { clock, describeSighting, recentSightings } from '../bots/memory';
import { describeSocial } from '../bots/suspicion';
import type { GameMap } from '../sim/map';
import { COLORS, playerRegionName, unitRegionName, type SimState, type Unit } from '../sim/sim';
import { nextStage, TASK_LABELS } from '../sim/tasks';
import type { PlayScene } from '../game/PlayScene';

const PLAY_SCENE_KEY = 'Play';

const STYLE = {
  font: 'system-ui, Segoe UI, sans-serif',
  mono: 'Consolas, Menlo, monospace',
  panel: 0x0b0d12,
  panelAlpha: 0.75,
  text: '#e6ebf5',
  dim: '#8f9ab5',
  done: '#5c6579',
  crew: '#5ee6f5',
  impostor: '#ff6b6b',
  mapRoom: 0x4a5368,
  mapCorridor: 0x353c4c,
  mapWall: 0x7c869e,
  mapLabel: '#c8d0e0',
  player: 0x2fd3e6,
  button: 0xd2372f,
  barBack: 0x1a1e2a,
  barFill: 0x3ccf6a,
};

export class HudScene extends Phaser.Scene {
  static readonly KEY = 'Hud';

  private play!: PlayScene;
  private map!: GameMap;
  private roomLabel!: Phaser.GameObjects.Text;
  private roleLabel!: Phaser.GameObjects.Text;
  private taskList!: Phaser.GameObjects.Text;
  private killLabel!: Phaser.GameObjects.Text;
  private promptText!: Phaser.GameObjects.Text;
  private hintText!: Phaser.GameObjects.Text;
  private taskBar!: Phaser.GameObjects.Graphics;
  private taskBarText!: Phaser.GameObjects.Text;
  private shownTaskProgress = { done: 0, total: 0 };
  private debugText!: Phaser.GameObjects.Text;
  private debugOn = false;
  private tabMap!: Phaser.GameObjects.Container;
  private tabMapPlayer!: Phaser.GameObjects.Arc;
  private tabMapTasks!: Phaser.GameObjects.Graphics;
  private tabMapScale = 1;
  private tabMapOrigin = { x: 0, y: 0 };
  private keys!: { TAB: Phaser.Input.Keyboard.Key; F3: Phaser.Input.Keyboard.Key; ESC: Phaser.Input.Keyboard.Key };
  private numberKeys: Phaser.Input.Keyboard.Key[] = [];
  /** Bot index shown in the F3 inspector, or -1. */
  private inspected = -1;

  constructor() {
    super(HudScene.KEY);
  }

  create(): void {
    this.play = this.scene.get(PLAY_SCENE_KEY) as PlayScene;
    this.map = this.play.gameMap;
    const lobby = this.play.simMode === 'lobby';
    const W = this.scale.width;
    const H = this.scale.height;

    const keyboard = this.input.keyboard;
    if (!keyboard) throw new Error('Keyboard input is not available.');
    this.keys = keyboard.addKeys('TAB,F3,ESC') as HudScene['keys'];
    this.numberKeys = ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'ZERO'].map((k) => keyboard.addKey(k));

    this.roomLabel = this.add
      .text(16, 12, '', { fontFamily: STYLE.font, fontSize: '26px', fontStyle: 'bold', color: STYLE.text })
      .setShadow(0, 2, '#000000', 4, false, true)
      .setDepth(10);
    this.roleLabel = this.add
      .text(16, 46, '', { fontFamily: STYLE.font, fontSize: '15px', fontStyle: 'bold', color: STYLE.crew })
      .setShadow(0, 1, '#000000', 3, false, true)
      .setDepth(10);
    this.taskList = this.add
      .text(16, 72, '', { fontFamily: STYLE.font, fontSize: '14px', color: STYLE.text, backgroundColor: 'rgba(11,13,18,0.6)', padding: { x: 8, y: 6 }, lineSpacing: 3 })
      .setDepth(10)
      .setVisible(!lobby);
    this.killLabel = this.add
      .text(W - 16, 12, '', { fontFamily: STYLE.font, fontSize: '18px', fontStyle: 'bold', color: STYLE.impostor })
      .setOrigin(1, 0)
      .setShadow(0, 1, '#000000', 3, false, true)
      .setDepth(10);

    this.taskBar = this.add.graphics().setDepth(10);
    this.taskBarText = this.add
      .text(W / 2, 14, '', { fontFamily: STYLE.font, fontSize: '13px', fontStyle: 'bold', color: STYLE.text })
      .setOrigin(0.5, 0)
      .setShadow(0, 1, '#000000', 2, false, true)
      .setDepth(11);

    this.hintText = this.add
      .text(
        W / 2,
        H - 14,
        lobby
          ? 'Walk to the SETTINGS computer or the START pad and press E.    WASD / arrows: move    F3: debug'
          : 'WASD / arrows: move    E: use / hold to do a task    R: report    Q: kill (impostor)    Tab: map    F3: debug    Esc: lobby',
        { fontFamily: STYLE.font, fontSize: '14px', color: STYLE.dim },
      )
      .setOrigin(0.5, 1)
      .setDepth(10);

    this.promptText = this.add
      .text(W / 2, H - 48, '', {
        fontFamily: STYLE.font,
        fontSize: '20px',
        fontStyle: 'bold',
        color: STYLE.text,
        backgroundColor: 'rgba(11,13,18,0.75)',
        padding: { x: 14, y: 6 },
        align: 'center',
      })
      .setOrigin(0.5, 1)
      .setDepth(10)
      .setVisible(false);

    this.debugText = this.add
      .text(W - 16, 44, '', {
        fontFamily: STYLE.mono,
        fontSize: '14px',
        color: STYLE.text,
        backgroundColor: 'rgba(11,13,18,0.8)',
        padding: { x: 10, y: 8 },
        align: 'left',
      })
      .setOrigin(1, 0)
      .setDepth(20)
      .setVisible(false);

    this.buildTabMap();
  }

  override update(): void {
    const state = this.play.state;
    const player = state.units[0] as Unit;
    const region = playerRegionName(state, this.map) ?? '';
    if (this.roomLabel.text !== region) this.roomLabel.setText(region);

    const prompt = this.play.isPanelOpen ? '' : this.play.prompts.join('\n');
    if (prompt) {
      if (this.promptText.text !== prompt) this.promptText.setText(prompt);
      this.promptText.setVisible(true);
    } else {
      this.promptText.setVisible(false);
    }
    if (this.play.isPanelOpen) return;
    if (this.play.isMeetingOpen || this.play.isEnded) return;

    if (this.play.simMode === 'game') {
      this.updateRoleAndTasks(state, player);
      this.updateTaskBar(state);
      if (Phaser.Input.Keyboard.JustDown(this.keys.ESC)) this.play.backToLobby();
    }

    if (Phaser.Input.Keyboard.JustDown(this.keys.F3)) {
      this.debugOn = !this.debugOn;
      this.debugText.setVisible(this.debugOn);
      this.play.setDebugVisible(this.debugOn);
    }
    if (this.debugOn) {
      this.numberKeys.forEach((key, i) => {
        if (Phaser.Input.Keyboard.JustDown(key)) this.inspected = i === 9 ? -1 : this.inspected === i ? -1 : i;
      });
      this.debugText.setText(this.debugLines(region));
    }

    const showMap = this.keys.TAB.isDown && this.play.simMode === 'game';
    if (showMap !== this.tabMap.visible) this.tabMap.setVisible(showMap);
    if (showMap) {
      this.tabMapPlayer.setPosition(this.tabMapOrigin.x + player.x * this.tabMapScale, this.tabMapOrigin.y + player.y * this.tabMapScale);
      this.drawTabMapTasks(player);
    }
  }

  private updateRoleAndTasks(state: SimState, player: Unit): void {
    const role = player.role === 'impostor' ? 'IMPOSTOR' : 'CREW';
    const status = player.alive ? '' : '   (dead: you are a ghost, tasks still count)';
    const roleText = `${role}${status}`;
    if (this.roleLabel.text !== roleText) this.roleLabel.setText(roleText).setColor(player.role === 'impostor' ? STYLE.impostor : STYLE.crew);

    const lines = [player.role === 'impostor' ? 'FAKE TASKS' : 'TASKS'];
    for (const task of player.tasks) {
      const done = task.stages.filter((s) => s.done).length;
      const stage = nextStage(task);
      const spot = stage ? this.map.tasks.find((t) => t.id === stage.spotId) : null;
      const where = spot ? ` — ${spot.room}` : '';
      const count = task.stages.length > 1 ? ` (${done}/${task.stages.length})` : '';
      lines.push(`${stage ? '•' : '✓'} ${TASK_LABELS[task.type] ?? task.type}${count}${where}`);
    }
    const text = lines.join('\n');
    if (this.taskList.text !== text) this.taskList.setText(text);

    if (player.role === 'impostor' && player.alive) {
      const secs = Math.ceil(player.killCooldownTicks / 30);
      const kill = player.killCooldownTicks > 0 ? `Kill in ${secs}s` : 'Kill READY (Q)';
      if (this.killLabel.text !== kill) this.killLabel.setText(kill);
      this.killLabel.setVisible(state.phase === 'play');
    } else {
      this.killLabel.setVisible(false);
    }
  }

  private updateTaskBar(state: SimState): void {
    const mode = this.play.gameSettings.taskBarUpdates;
    if (mode === 'never') {
      this.taskBar.clear();
      this.taskBarText.setVisible(false);
      return;
    }
    if (mode === 'always' || state.phase === 'meeting' || state.tick === 0) this.shownTaskProgress = { ...state.crewTasks };
    const { done, total } = this.shownTaskProgress;
    const W = this.scale.width;
    const barW = 320;
    const barH = 14;
    const x = W / 2 - barW / 2;
    const y = 36;
    this.taskBar.clear();
    this.taskBar.fillStyle(STYLE.barBack, 0.9).fillRoundedRect(x, y, barW, barH, 6);
    if (total > 0) this.taskBar.fillStyle(STYLE.barFill, 1).fillRoundedRect(x, y, Math.max(barH, (barW * done) / total), barH, 6);
    const text = `Crew tasks ${done}/${total}${mode === 'meetings' ? ' (updates at meetings)' : ''}`;
    if (this.taskBarText.text !== text) this.taskBarText.setText(text);
    this.taskBarText.setVisible(true);
  }

  private debugLines(region: string): string {
    const s = this.play.state;
    const ts = this.map.tileSize;
    const p = s.units[0] as Unit;
    const tx = Math.floor(p.x / ts);
    const ty = Math.floor(p.y / ts);
    const nav = this.map.nav;
    let edgeCount = 0;
    for (const list of nav.edges) edgeCount += list.length;
    const lines = [
      `fps ${Math.round(this.game.loop.actualFps)}   tick ${s.tick}   seed ${s.seed}   ${s.mode} / ${s.phase}`,
      `you: ${p.name} (${p.role}${p.alive ? '' : ', dead'})   pos ${Math.round(p.x)}, ${Math.round(p.y)}   tile ${tx}, ${ty}   ${region}`,
      `crew tasks ${s.crewTasks.done}/${s.crewTasks.total}   bodies ${s.bodies.length}   meetings held ${s.meetingsHeld}   nav ${nav.nodes.length} nodes, ${edgeCount / 2} edges`,
      ...(s.meeting?.lastPlayerParse ? [`your last line was read as: ${s.meeting.lastPlayerParse}`] : []),
      '',
    ];
    s.bots.forEach((bot, i) => {
      const u = s.units[bot.unitId];
      if (!u) return;
      const role = u.role === 'impostor' ? `IMP${u.killCooldownTicks > 0 ? ' ' + Math.ceil(u.killCooldownTicks / 30) + 's' : ' rdy'}` : 'crew';
      const life = u.alive ? '' : ' †';
      const mark = this.inspected === i ? '>' : ' ';
      lines.push(`${mark}${i + 1} ${(u.name + life).padEnd(8)} ${role.padEnd(7)} ${bot.personality.padEnd(10)} ${unitRegionName(u, this.map).padEnd(11)} ${describeGoal(bot)}`);
    });
    const bot = this.inspected >= 0 ? s.bots[this.inspected] : undefined;
    if (bot) {
      const u = s.units[bot.unitId];
      const mem = bot.memory;
      lines.push('', `--- ${u?.name} (press ${this.inspected + 1} again or 0 to close) ---`);
      lines.push(`sightings ${mem.sightings.length + Object.keys(mem.open).length}, kills seen ${mem.kills.length}, bodies seen ${mem.bodies.length}, contradictions ${mem.contradictions.length}`);
      for (const sight of recentSightings(mem, 5)) lines.push('  saw ' + describeSighting(sight, s, 30));
      for (const k of mem.kills) lines.push(`  WITNESSED ${s.units[k.killerId]?.name} kill ${s.units[k.victimId]?.name} in ${k.room} at ${clock(k.tick, 30)}`);
      for (const b of mem.bodies) lines.push(`  saw ${s.units[b.victimId]?.name}'s body in ${b.room} at ${clock(b.tick, 30)}`);
      for (const c of mem.contradictions.slice(-3)) lines.push('  CONTRADICTION: ' + c.why);
      lines.push(...describeSocial(bot.social, s, bot.unitId, 30));
      lines.push(`why I voted: ${bot.social.lastVoteReason ?? '(no vote yet)'}`);
      lines.push(`last line: ${bot.lastIntent ?? '(nothing said yet)'}`);
    } else if (s.mode === 'game') {
      lines.push('', 'press 1-9 to inspect a bot');
    }
    return lines.join('\n');
  }

  /** Yellow markers on the Tab map for the player's unfinished task stages. */
  private drawTabMapTasks(player: Unit): void {
    const g = this.tabMapTasks;
    g.clear();
    const cell = this.map.tileSize * this.tabMapScale;
    for (const task of player.tasks) {
      const stage = nextStage(task);
      const spot = stage ? this.map.tasks.find((s) => s.id === stage.spotId) : null;
      if (!spot) continue;
      const x = this.tabMapOrigin.x + (spot.pos[0] + 0.5) * cell;
      const y = this.tabMapOrigin.y + (spot.pos[1] + 0.5) * cell;
      g.fillStyle(0xffc857, 1).fillCircle(x, y, Math.max(3, cell * 0.5));
      g.lineStyle(1, 0x000000, 0.8).strokeCircle(x, y, Math.max(3, cell * 0.5));
    }
  }

  /** Draws the whole ship small enough to fit the screen, once, into a hidden container. */
  private buildTabMap(): void {
    const map = this.map;
    const ts = map.tileSize;
    const margin = 40;
    const maxW = this.scale.width - margin * 2;
    const maxH = this.scale.height - margin * 2;
    const scale = Math.min(maxW / (map.width * ts), maxH / (map.height * ts));
    const drawnW = map.width * ts * scale;
    const drawnH = map.height * ts * scale;
    const ox = (this.scale.width - drawnW) / 2;
    const oy = (this.scale.height - drawnH) / 2;
    this.tabMapScale = scale;
    this.tabMapOrigin = { x: ox, y: oy };

    const backdrop = this.add.rectangle(this.scale.width / 2, this.scale.height / 2, this.scale.width, this.scale.height, STYLE.panel, STYLE.panelAlpha);

    // Tiles are drawn once into a texture so showing the map costs nothing per frame.
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    const cell = ts * scale;
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const kind = map.tileAt(x, y);
        if (kind === 'void') continue;
        let colour = STYLE.mapWall;
        if (kind === 'floor') colour = map.regionAt(x, y)?.kind === 'room' ? STYLE.mapRoom : STYLE.mapCorridor;
        if (kind === 'button') colour = STYLE.button;
        g.fillStyle(colour, 1).fillRect(x * cell, y * cell, Math.ceil(cell), Math.ceil(cell));
      }
    }
    const key = `tabmap:${map.name}`;
    if (!this.textures.exists(key)) g.generateTexture(key, Math.ceil(drawnW), Math.ceil(drawnH));
    g.destroy();
    const picture = this.add.image(ox, oy, key).setOrigin(0, 0);

    const labels: Phaser.GameObjects.Text[] = [];
    for (const room of map.rooms) {
      if (!room.rect) continue;
      const cx = ox + (room.rect.x + room.rect.w / 2) * cell;
      const cy = oy + (room.rect.y + room.rect.h / 2) * cell;
      labels.push(
        this.add
          .text(cx, cy, room.name, { fontFamily: STYLE.font, fontSize: '13px', fontStyle: 'bold', color: STYLE.mapLabel })
          .setOrigin(0.5)
          .setShadow(0, 1, '#000000', 2, false, true),
      );
    }
    const title = this.add
      .text(this.scale.width / 2, oy - 8, map.name.toUpperCase(), { fontFamily: STYLE.font, fontSize: '18px', fontStyle: 'bold', color: STYLE.dim })
      .setOrigin(0.5, 1);

    const playerColour = COLORS.find((c) => c.id === this.play.state.units[0]?.colorId)?.tint ?? '#2fd3e6';
    this.tabMapPlayer = this.add.circle(0, 0, Math.max(4, cell * 0.6), Phaser.Display.Color.HexStringToColor(playerColour).color).setStrokeStyle(2, 0xffffff, 0.9);
    this.tabMapTasks = this.add.graphics();
    const legend = this.add
      .text(this.scale.width / 2, oy + drawnH + 10, 'yellow: your next task spots', { fontFamily: STYLE.font, fontSize: '13px', color: '#ffc857' })
      .setOrigin(0.5, 0);

    this.tabMap = this.add.container(0, 0, [backdrop, picture, ...labels, title, this.tabMapTasks, this.tabMapPlayer, legend]).setDepth(30).setVisible(false);
  }
}
