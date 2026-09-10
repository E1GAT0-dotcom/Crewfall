// The balance simulator (SPEC 9.13). Plays all-bot games headless and prints the numbers.
//
//   npm run sim -- --games 200 --map kestrel --difficulty normal
//   npm run sim -- --games 50 --players 8 --impostors 1 --crewVision 0.75 --seed 1000
//
// Any settings key from config/defaults.json can be passed as --key value.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import gameConfig from '../config/game.json';
import { playBotGame, summarize, type GameResult } from '../src/sim/headless';
import { loadMap } from '../src/sim/map';
import { clampSettings, defaultSettings, type GameSettings } from '../src/sim/settings';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else out[key] = 'true';
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const games = Number(args.games ?? 100);
const mapId = args.map ?? 'kestrel';
const startSeed = Number(args.seed ?? 1);
const maxMinutes = Number(args.maxMinutes ?? 25);

const manifest = JSON.parse(readFileSync(join(ROOT, 'assets', 'maps', 'manifest.json'), 'utf8')) as { maps: { id: string; file: string; playable?: boolean }[] };
const entry = manifest.maps.find((m) => m.id === mapId);
if (!entry || entry.playable === false) {
  console.error(`No playable map "${mapId}". Known: ${manifest.maps.filter((m) => m.playable !== false).map((m) => m.id).join(', ')}`);
  process.exit(1);
}
const map = loadMap(JSON.parse(readFileSync(join(ROOT, 'assets', entry.file), 'utf8')));

let settings: GameSettings = { ...defaultSettings(), map: mapId, players: map.playerCap, impostors: map.impostors.default };
for (const [key, value] of Object.entries(args)) {
  if (!(key in settings) || key === 'map') continue;
  const current = (settings as unknown as Record<string, unknown>)[key];
  (settings as unknown as Record<string, unknown>)[key] = typeof current === 'number' ? Number(value) : typeof current === 'boolean' ? value === 'true' : value;
}
settings = clampSettings(settings, { playerCap: map.playerCap, impostorMax: map.impostors.max });

console.log(`Crewfall simulator: ${games} games on ${map.name}, ${settings.players} players, ${settings.impostors} impostor(s), ${settings.difficulty}, seeds ${startSeed}-${startSeed + games - 1}`);
const results: GameResult[] = [];
const t0 = Date.now();
for (let i = 0; i < games; i++) {
  results.push(playBotGame(map, settings, startSeed + i, gameConfig, maxMinutes));
  if ((i + 1) % 10 === 0 || i === games - 1) {
    const s = summarize(results);
    process.stdout.write(`\r  ${i + 1}/${games}  crew ${(s.crewWinRate * 100).toFixed(0)}%  (${((Date.now() - t0) / 1000).toFixed(0)} s)   `);
  }
}
console.log('');
const s = summarize(results);
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
console.log('');
console.log(`Crew wins:       ${s.crewWins} (${pct(s.crewWinRate)} of finished games)`);
console.log(`Impostor wins:   ${s.impostorWins}`);
console.log(`Timed out:       ${s.timeouts} (cap ${maxMinutes} min)`);
console.log(`By reason:       ${Object.entries(s.byReason).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`Average length:  ${(s.avgSeconds / 60).toFixed(1)} min`);
console.log(`Average meetings: ${s.avgMeetings.toFixed(2)}`);
console.log(`Average kills:   ${s.avgKills.toFixed(2)}`);
console.log(`Ejection accuracy: ${s.ejectionAccuracy === null ? 'no ejections' : pct(s.ejectionAccuracy)} (impostor ejected / all ejections)`);
const band = s.crewWinRate >= 0.35 && s.crewWinRate <= 0.65;
console.log(`Target band 35-65% crew wins: ${band ? 'INSIDE' : 'OUTSIDE'}`);
