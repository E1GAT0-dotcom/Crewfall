# STATUS — Crewfall (working title)

**Current phase:** Phase 1 — Skeleton (in progress)

## How to launch
Double-click `play.bat` in the project folder. A browser tab opens with the game.
Close the black command window to stop it.

## What works
- Step 1 (tooling): the project builds, tests run, `play.bat` starts the dev server.
- Step 2 (map): `assets/maps/kestrel.json` holds the Kestrel layout (12 rooms, 14 corridors, 2 dead ends,
  4 vent networks, sabotage panels, doors, 18 task spots). The loader in `src/sim/map.ts` reads it,
  builds the walking graph, and `src/sim/mapValidate.ts` checks the SPEC 6.2 rules. 18 tests pass.

## Not yet built (Phase 1)
- Walking, walls, camera (step 3)
- Room label, Tab map, F3 overlay (step 4)

## Known bugs
None yet.
