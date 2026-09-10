# Conventions

Working rules for this codebase. The design itself is in `SPEC.md`.

## Stack
TypeScript, Vite, Phaser 3, Vitest. Nothing else without a note in `docs/DECISIONS.md` saying why.

## Runtime rules
Zero network calls, zero analytics, zero external services. The game works with the internet unplugged.

## Machine and scripts
Windows 11 with Git for Windows and Node.js LTS. All npm scripts are cross-platform.
`play.bat` starts the dev server and opens the browser. `npm test` runs all tests.
`npm run sim -- --games 200 --map kestrel --difficulty normal` runs the headless balance simulator.

## Folder layout
- `src/sim/` — pure game logic (rules, timers, tasks, win conditions). **No Phaser imports here.**
- `src/bots/` — bot brains (perception, memory, suspicion, decisions, voting). **No Phaser imports here.**
- `src/chat/` — chat templates, template filling, player-input parser. Pure.
- `src/game/` — Phaser rendering, input, camera, animation.
- `src/ui/` — menus, settings, meeting screen, HUD.
- `assets/maps/`, `assets/sprites/`, `assets/sounds/` — all data-driven via manifests (SPEC.md §6, §11).
- `config/` — tunable numbers (cooldowns, suspicion weights, timers). No scattered constants.
- `docs/` — STATUS.md, DECISIONS.md, HOW-TO-PLAY.md, this file.
- `tests/` — automated tests.

## Determinism
The simulation and all bot decisions use a seeded random number generator. The same seed plus the
same player inputs must reproduce the same game. This is what makes bots testable.

## Fixed tick
The simulation runs on a fixed tick rate independent of frame rate; rendering interpolates.

## Data over code
Maps are JSON. Sprites and sounds are referenced only through their manifests. Never hardcode an
asset path in game code.

## Debug overlay (F3)
Required from Phase 1 onward and kept working in every later phase.

## Git
Commit after each meaningful step with a plain-language message. Never force-push.

## Intellectual property
Mechanics (tasks, impostors, meetings, voting, vents, sabotage) are fair game. Not allowed anywhere
in the game, code, or assets: the name of any existing game in this genre or its studio; the
"bean" character silhouette; any existing map layout room-for-room; any third-party art, sound,
or text. Characters and maps are original designs (SPEC.md §6, §11).
