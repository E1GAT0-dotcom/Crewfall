// Debug drawing of the walking graph (F3): a dot per node, a line per edge.
// Drawn once into a texture the size of the map, so toggling it costs nothing per frame.

import Phaser from 'phaser';
import type { GameMap } from '../sim/map';

const NODE_COLOUR = 0x59d98c;
const EDGE_COLOUR = 0x2f8f5a;

export class NavGraphView {
  private readonly image: Phaser.GameObjects.Image;

  constructor(scene: Phaser.Scene, map: GameMap) {
    const key = `navgraph:${map.name}`;
    if (!scene.textures.exists(key)) {
      const ts = map.tileSize;
      const half = ts / 2;
      const g = scene.make.graphics({ x: 0, y: 0 }, false);
      g.lineStyle(1, EDGE_COLOUR, 0.8);
      for (const n of map.nav.nodes) {
        for (const e of map.nav.edges[n.id] ?? []) {
          if (e.to < n.id) continue; // each undirected edge once
          const m = map.nav.nodes[e.to];
          if (!m) continue;
          g.lineBetween(n.x * ts + half, n.y * ts + half, m.x * ts + half, m.y * ts + half);
        }
      }
      g.fillStyle(NODE_COLOUR, 1);
      for (const n of map.nav.nodes) g.fillCircle(n.x * ts + half, n.y * ts + half, 2);
      g.generateTexture(key, map.width * ts, map.height * ts);
      g.destroy();
    }
    this.image = scene.add.image(0, 0, key).setOrigin(0, 0).setDepth(5).setAlpha(0.9).setVisible(false);
  }

  setVisible(visible: boolean): void {
    this.image.setVisible(visible);
  }
}
