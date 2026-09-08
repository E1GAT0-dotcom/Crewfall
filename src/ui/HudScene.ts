// Heads-up display drawn on top of the Play scene: room name, key hints, the Tab map and F3 debug text.
// Runs as its own scene so it is not affected by the world camera.

import Phaser from 'phaser';
import { describeGoal } from '../bots/brain';
import type { GameMap } from '../sim/map';
import { playerRegionName, unitRegionName } from '../sim/sim';
import type { PlayScene } from '../game/PlayScene';

const PLAY_SCENE_KEY = 'Play';

const STYLE = {
  font: 'system-ui, Segoe UI, sans-serif',
  mono: 'Consolas, Menlo, monospace',
  panel: 0x0b0d12,
  panelAlpha: 0.75,
  text: '#e6ebf5',
  dim: '#8f9ab5',
  mapRoom: 0x4a5368,
  mapCorridor: 0x353c4c,
  mapWall: 0x7c869e,
  mapLabel: '#c8d0e0',
  player: 0x2fd3e6,
  button: 0xd2372f,
};

export class HudScene extends Phaser.Scene {
  static readonly KEY = 'Hud';

  private play!: PlayScene;
  private map!: GameMap;
  private roomLabel!: Phaser.GameObjects.Text;
  private promptText!: Phaser.GameObjects.Text;
  private hintText!: Phaser.GameObjects.Text;
  private debugText!: Phaser.GameObjects.Text;
  private debugOn = false;
  private tabMap!: Phaser.GameObjects.Container;
  private tabMapPlayer!: Phaser.GameObjects.Arc;
  private tabMapScale = 1;
  private tabMapOrigin = { x: 0, y: 0 };
  private keys!: { TAB: Phaser.Input.Keyboard.Key; F3: Phaser.Input.Keyboard.Key };

  constructor() {
    super(HudScene.KEY);
  }

  create(): void {
    this.play = this.scene.get(PLAY_SCENE_KEY) as PlayScene;
    this.map = this.play.gameMap;

    const keyboard = this.input.keyboard;
    if (!keyboard) throw new Error('Keyboard input is not available.');
    this.keys = keyboard.addKeys('TAB,F3') as HudScene['keys'];

    this.roomLabel = this.add
      .text(16, 12, '', { fontFamily: STYLE.font, fontSize: '26px', fontStyle: 'bold', color: STYLE.text })
      .setShadow(0, 2, '#000000', 4, false, true)
      .setDepth(10);

    const lobby = this.play.simMode === 'lobby';
    this.hintText = this.add
      .text(
        this.scale.width / 2,
        this.scale.height - 14,
        lobby
          ? 'Walk to the SETTINGS computer or the START pad and press E.    WASD / arrows: move    F3: debug'
          : 'WASD / arrows: move    E: use    Tab (hold): map    F3: debug',
        { fontFamily: STYLE.font, fontSize: '15px', color: STYLE.dim },
      )
      .setOrigin(0.5, 1)
      .setDepth(10);

    this.promptText = this.add
      .text(this.scale.width / 2, this.scale.height - 48, '', {
        fontFamily: STYLE.font,
        fontSize: '20px',
        fontStyle: 'bold',
        color: STYLE.text,
        backgroundColor: 'rgba(11,13,18,0.75)',
        padding: { x: 14, y: 6 },
      })
      .setOrigin(0.5, 1)
      .setDepth(10)
      .setVisible(false);

    this.debugText = this.add
      .text(this.scale.width - 16, 12, '', {
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
    const region = playerRegionName(state, this.map) ?? '';
    if (this.roomLabel.text !== region) this.roomLabel.setText(region);

    const prompt = this.play.isPanelOpen ? null : this.play.prompt;
    if (prompt) {
      if (this.promptText.text !== prompt) this.promptText.setText(prompt);
      this.promptText.setVisible(true);
    } else {
      this.promptText.setVisible(false);
    }
    if (this.play.isPanelOpen) return;

    if (Phaser.Input.Keyboard.JustDown(this.keys.F3)) {
      this.debugOn = !this.debugOn;
      this.debugText.setVisible(this.debugOn);
      this.play.setDebugVisible(this.debugOn);
    }
    if (this.debugOn) this.debugText.setText(this.debugLines(region));

    const showMap = this.keys.TAB.isDown && this.play.simMode === 'game';
    if (showMap !== this.tabMap.visible) this.tabMap.setVisible(showMap);
    if (showMap) {
      const p = state.units[0];
      if (p) this.tabMapPlayer.setPosition(this.tabMapOrigin.x + p.x * this.tabMapScale, this.tabMapOrigin.y + p.y * this.tabMapScale);
    }
  }

  private debugLines(region: string): string {
    const s = this.play.state;
    const ts = this.map.tileSize;
    const p = s.units[0];
    const tx = p ? Math.floor(p.x / ts) : 0;
    const ty = p ? Math.floor(p.y / ts) : 0;
    const nav = this.map.nav;
    let edgeCount = 0;
    for (const list of nav.edges) edgeCount += list.length;
    const lines = [
      `fps ${Math.round(this.game.loop.actualFps)}   tick ${s.tick}   seed ${s.seed}   ${s.mode}`,
      `you: ${p?.name} (${p?.role})   pos ${Math.round(p?.x ?? 0)}, ${Math.round(p?.y ?? 0)}   tile ${tx}, ${ty}   ${region}`,
      `crew tasks ${s.crewTasks.done}/${s.crewTasks.total}   nav ${nav.nodes.length} nodes, ${edgeCount / 2} edges`,
      '',
    ];
    for (const bot of s.bots) {
      const u = s.units[bot.unitId];
      if (!u) continue;
      const role = u.role === 'impostor' ? 'IMP ' : 'crew';
      lines.push(`${u.name.padEnd(6)} ${role}  ${unitRegionName(u, this.map).padEnd(11)} ${describeGoal(bot)}`);
    }
    return lines.join('\n');
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

    this.tabMapPlayer = this.add.circle(0, 0, Math.max(4, cell * 0.6), STYLE.player).setStrokeStyle(2, 0xffffff, 0.9);

    this.tabMap = this.add.container(0, 0, [backdrop, picture, ...labels, title, this.tabMapPlayer]).setDepth(30).setVisible(false);
  }
}
