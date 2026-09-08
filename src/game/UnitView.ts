// One unit on screen: a tinted grayscale base sprite with a fixed-colour detail sprite on top,
// and the unit's name floating above.

import Phaser from 'phaser';
import { unitSheet } from './assets';
import type { Unit } from '../sim/sim';

export class UnitView {
  readonly container: Phaser.GameObjects.Container;
  private readonly base: Phaser.GameObjects.Sprite;
  private readonly detail: Phaser.GameObjects.Sprite;
  private readonly label: Phaser.GameObjects.Text;
  private currentAnim: 'idle' | 'walk' = 'idle';

  /**
   * @param frameOriginY where in the 64 px frame the unit's collision centre sits (0..1).
   *   The placeholder body is centred around 30/64 with feet reaching 53/64; 0.6 puts the
   *   collision circle on the lower body so the unit's feet stop at walls, not its visor.
   */
  constructor(scene: Phaser.Scene, colour: number, name: string, frameOriginY = 0.6) {
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

  private play(anim: 'idle' | 'walk'): void {
    if (this.currentAnim === anim && this.base.anims.isPlaying) return;
    this.currentAnim = anim;
    this.base.play(unitSheet('base', anim), true);
    this.detail.play(unitSheet('detail', anim), true);
  }
}
