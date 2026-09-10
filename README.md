# Crewfall (working title)

A single-player, browser-based social deduction game. You are one of 6–15 crew members on a ship.
One or more are impostors. Everyone else is a scripted bot with its own eyes, memory, suspicions,
and voice. Meetings are text chat: you type, the bots argue back.

Runs fully offline in Chrome or Edge on Windows. No accounts, no server, no network.

## Play
Double-click `play.bat`. The first run installs packages (needs the internet once). A browser tab
opens with the game. Close the command window to stop.

## Develop
```
npm install
npm run dev      # start the game
npm test         # run all tests
npm run typecheck
npm run sim -- --games 200 --map kestrel --difficulty normal   # balance simulator
```

## Docs
- `SPEC.md` — the full design.
- `docs/STATUS.md` — what works right now.
- `docs/HOW-TO-PLAY.md` — controls and systems.
- `docs/DECISIONS.md` — dated log of design and technical choices.
- `docs/CONVENTIONS.md` — folder layout and coding rules.
