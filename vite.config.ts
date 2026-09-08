import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// Vite serves the game during development and bundles it for a build.
// The game is fully offline: nothing here fetches from the network at runtime.
export default defineConfig({
  // Everything under assets/ is served as-is from the site root, e.g. /maps/kestrel.json.
  publicDir: 'assets',
  server: {
    port: Number(process.env.PORT) || 5173,
    strictPort: false,
    host: '127.0.0.1',
  },
  resolve: {
    alias: {
      '@sim': fileURLToPath(new URL('./src/sim', import.meta.url)),
      '@bots': fileURLToPath(new URL('./src/bots', import.meta.url)),
      '@chat': fileURLToPath(new URL('./src/chat', import.meta.url)),
      '@game': fileURLToPath(new URL('./src/game', import.meta.url)),
      '@ui': fileURLToPath(new URL('./src/ui', import.meta.url)),
      '@config': fileURLToPath(new URL('./config', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    // Pure logic (sim, bots, chat) runs in Node with no browser.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
