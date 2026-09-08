// Entry point: creates the Phaser game and hands off to the Boot scene.

import Phaser from 'phaser';
import gameConfig from '../config/game.json';
import { BootScene } from './game/BootScene';
import { PlayScene } from './game/PlayScene';

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: gameConfig.canvas.width,
  height: gameConfig.canvas.height,
  backgroundColor: '#0b0d12',
  pixelArt: true,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [BootScene, PlayScene],
});

// Debug handle for the browser console and automated checks (e.g. crewfall.game.step(...) to
// advance frames by hand). Harmless in play; the game is offline and has no accounts.
declare global {
  interface Window {
    crewfall: { game: Phaser.Game };
  }
}
window.crewfall = { game };
