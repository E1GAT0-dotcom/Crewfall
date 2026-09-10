// One unit on screen: a tinted grayscale base sprite with a fixed-colour detail sprite on top,
// and the unit's name floating above. Also used for bodies (the "dead" frame) and ghosts (faded).

import Phaser from 'phaser';
import { unitSheet } from './assets';
import type { Unit } from '../sim/sim';

type Anim = 'idle' | 'walk' | 'dead';

const GHOST_ALPHA = 0.45;

export class UnitView {
  readonly container: Phaser.GameObjects.Container;
  private readonly base: Phaser.GameObjects.Sprite;
  private readonly detail: Phaser.GameObjects.Sprite;
  private readonly label: Phaser.GameObjects.Text;
  private currentAnim: Anim | null = null;
  private ghost = false;
  private inVent = false;
  private readonly scene: Phaser.Scene;

  /**
   * @param frameOriginY where in the 64 px frame the unit's collision centre sits (0..1).
   *   The placeholder body is centred around 30/64 with feet reaching 53/64; 0.6 puts the
   *   collision circle on the lower body so the unit's feet stop at walls, not its visor.
   */
  constructor(scene: Phaser.Scene, colour: number, name: string, frameOriginY = 0.6) {
    this.scene = scene;
    this.base = scene.add.sprite(0, 0, unitSheet('base', 'idle')).setOrigin(0.5, frameOriginY).setTint(colour);
    this.detail = scene.add.sprite(0, 0, unitSheet('detail', 'idle')).setOrigin(0.5, frameOriginY);
    this.label = scene.add
      .text(0, -46, name, { fontFamily: 'system-ui, Segoe UI, sans-serif', fontSize: '13px', fontStyle: 'bold', color: '#ffffff' })
      .setOrigin(0.5, 1)
      .setShadow(0, 1, '#000000', 3, false, true);
    this.container = scene.add.container(0, 0, [this.base, this.detail, this.label]).setDepth(10);
    this.play('idle');
  }

  /** Positions the unit at an interpolated world point and matches its animation to its state. */
  apply(x: number, y: number, state: Pick<Unit, 'facing' | 'moving'>): void {
    this.container.setPosition(Math.round(x), Math.round(y));
    // Units lower on screen draw in front of units higher up.
    this.container.setDepth(10 + y / 100000);
    this.base.setFlipX(state.facing < 0);
    this.detail.setFlipX(state.facing < 0);
    this.play(state.moving ? 'walk' : 'idle');
  }

  /** Ghosts are drawn faded (only other ghosts can see them; the scene decides visibility). */
  setGhost(ghost: boolean): void {
    if (this.ghost === ghost) return;
    this.ghost = ghost;
    this.container.setAlpha(ghost ? GHOST_ALPHA : 1);
  }

  /**
   * In a vent the unit shrinks into the grate (placeholder for the Phase 7 climb animation). Only
   * the unit's own player sees this; everyone else sees nothing at all.
   */
  setInVent(inVent: boolean): void {
    if (this.inVent === inVent) return;
    this.inVent = inVent;
    const scale = inVent ? 0.45 : 1;
    this.scene.tweens.killTweensOf([this.base, this.detail]);
    this.scene.tweens.add({ targets: [this.base, this.detail], scaleX: scale, scaleY: scale, alpha: inVent ? 0.6 : 1, duration: 180, ease: 'Quad.easeOut' });
    this.label.setAlpha(inVent ? 0.5 : 1);
  }

  /** Shows the body frame at a fixed spot. */
  showAsBody(x: number, y: number): void {
    this.container.setPosition(Math.round(x), Math.round(y));
    this.container.setDepth(9);
    this.play('dead');
  }

  setVisible(visible: boolean): void {
    this.container.setVisible(visible);
  }

  destroy(): void {
    this.container.destroy(true);
  }

  private play(anim: Anim): void {
    if (this.currentAnim === anim && this.base.anims.isPlaying) return;
    this.currentAnim = anim;
    this.base.play(unitSheet('base', anim), true);
    this.detail.play(unitSheet('detail', anim), true);
  }
}
