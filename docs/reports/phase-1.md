# Phase 1 report — Skeleton

Date: 2026-09-07. Written for Greg.

## Summary
Phase 1 is built and self-tested. Everything on the SPEC.md §14 Phase 1 list exists: the project
tooling, `play.bat`, the folder layout, the Kestrel map as an editable data file with rooms, spawn
and walking graph, a placeholder unit in the two-layer sprite format, WASD/arrow walking with wall
collision and a following camera, the Tab map, and the F3 overlay with frame rate, position, room
name and the walking graph. Phase 2 does not start until you have play-tested and said so.

## What was built, step by step
1. **Tooling.** TypeScript, Vite, Phaser 3, Vitest. `play.bat` installs packages on first run (needs
   the internet once) and then starts the game and opens a browser tab. `npm test` runs all tests.
2. **The Kestrel map.** `assets/maps/kestrel.json` is a text picture of the ship plus lists of rooms,
   vents, sabotage panels, doors and task spots. 12 rooms in a figure-eight with Navigation and
   Reactor as dead ends, 4 vent networks, all 8 task types placed, every room with a task spot.
   The loader builds the walking graph; a rule checker explains any layout mistake in plain English.
3. **Walking.** A placeholder unit (squat pod, wide visor, two feet; gray body tinted to the player
   colour) walks at a fixed 30 ticks per second with smooth drawing in between. It stops flush at
   walls, slides along them, and cannot cut door corners or pass through anything.
4. **HUD.** Room or corridor name top-left, key hints at the bottom, the full ship under Tab, and
   the F3 panel plus walking-graph drawing.
5. **Docs.** STATUS, DECISIONS, HOW-TO-PLAY, CONVENTIONS, README and this report.

## How it was tested
- 36 automated tests: map loading, every SPEC §6.2 layout rule (and that the checker catches
  deliberate mistakes), walking-graph reachability and corner rules, collision, sliding, no
  tunnelling, speed, determinism (300 scripted inputs replayed twice give identical results), room
  transitions, and the sprite manifest against the real image files.
- In the browser: scripted walks confirmed the unit moves exactly the expected distance and stops
  at the exact pixel the maths predicts; screenshots confirmed the drawing, camera, room label,
  Tab map and F3 overlay. A soak stepped the game through 5.7 simulated minutes of random key
  presses with zero errors.
- `play.bat` was launched the way a double-click launches it and the server came up in under half
  a second.

## Decisions made without asking (all in docs/DECISIONS.md)
Map file is a text picture; corridors are auto-numbered and shown by number; the button tile
blocks walking; doors are the corridor tiles outside a room, and Cafeteria, Navigation and Admin
have no doors; walking graph is one node per tile; placeholder unit has idle and walk only;
tunable numbers live in `config/game.json`.

## Known limitations (by design)
No vision circle yet (Phase 2). Seed and vision radii missing from F3 (Phase 2). Vents, panels,
doors and task spots are in the data but not drawn or usable yet.

## What I need from you
1. The play-test from SPEC.md §14 Phase 1: double-click `play.bat`, walk into every room with
   WASD and with arrows without passing through a wall, watch the room name change, hold Tab for
   the map, press F3 for the overlay, and check the browser console (F12 → Console) stays free of
   red after a few minutes.
2. Feedback on walking speed and the look of the placeholder unit, both cheap to change now.
3. A rename for "Kestrel" or "Crewfall" if you want one before more things reference them.
4. Approval to start Phase 2, which begins in plan mode.
