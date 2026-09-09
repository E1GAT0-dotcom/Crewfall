# Phase 2 report — Core loop

Date: 2026-09-08. Written for Greg.

## Summary
Phase 2 is built and self-tested. A full game can be played from the lobby to an ending: settings
at the lobby computer, a match on Kestrel with up to ten units, tasks done by holding E, kills,
bodies, reporting, the emergency button, meetings with chat and voting, ejection, and all four
non-sabotage endings with a win/lose screen. Bots walk, work, kill when unwatched, report bodies,
make small talk in meetings and vote at random; their real brains are Phase 3. Every game replays
exactly from its seed.

## What changed against the plan
- **Vision is camera zoom, not a lit circle** (Greg, 2026-09-08). The darkness code is kept for the
  lights sabotage in Phase 4.
- **The settings screen became an in-world lobby** with a computer and a start pad (Greg). This
  pulled most of SPEC §12 forward from Phase 7.
- **Bots walk like people** after Greg's first play-test: pauses, hesitation, staggered starts,
  own speeds, rounded corners, spread-out task choice.
- **The lobby is a pod with a starfield** behind it and behind the ship (Greg).

## Step by step
1. Seeded random numbers; units with names, colours, roles and task lists; path-finding; bots
   doing tasks; F3 per-bot goals and paths.
2. View distance as zoom; the pod lobby with the settings computer, start pad and remembered
   settings; the starfield.
3. Player tasks with a progress ring, the task bar, kills with cooldown, bodies with a dead sprite,
   reporting, the emergency button, ghosts, impostor bots that hunt and crew bots that report.
4. The meeting screen: tiles, timer, discussion and voting, chat with bot replies, vote counting
   with skip and ties, the ejection reveal, return to the ship.
5. Endings, the win/lose screen with Play again and Lobby, whole-game determinism tests.

## How it was tested
- 106 automated tests: map and walking rules from Phase 1, random numbers, path-finding, sight,
  task lists, settings, game setup, bot feel, bot kills and reports, kill and report and button
  rules, hold-E tasks, every meeting rule (timers, votes, tally, ejection, chat pacing, replies,
  bot vote rules), every ending, and a whole bot game replayed twice from one seed to identical
  positions, kills, meetings and outcome.
- In the browser after each step: scripted runs of the exact flow (lobby, settings, start, walk,
  kill, report, meeting, vote, result, ending, play again, lobby) with screenshots and a clean
  console.

## Decisions made without asking (all in docs/DECISIONS.md)
The settings and meeting screens are HTML over the canvas; one scene serves lobby and match; low
objects do not block sight; kill range short is 1.25 tiles; task durations live in the config
file; ghosts are faded sprites that collide like the living; the killer hops onto the victim's
spot; impostor bots only kill when nobody could see (which depends on view distance); holding E
stops you walking; Esc returns to the lobby; Phase 2 bot chat and votes are deliberately generic;
the result stays up 5 seconds; Play again uses a new random seed unless the seed box is filled.

## Known limitations (by design)
No sabotage, vents, doors or minigames yet. Bots have no memory or suspicion, so meetings are small
talk and random votes. The eject animation, kill animation and ghost art are Phase 7.

## What I need from you
1. The Phase 2 done test from SPEC §14: play 3 games as crew and 1 as impostor and reach every
   ending (crew by tasks, crew by voting out the impostors, impostors by numbers) with no red in
   the browser console (F12, Console). The seed on the end screen lets me replay anything odd.
2. Feel notes: walking and view distance, meeting pacing, the settings panel, the end screen.
3. Approval to start Phase 3, the bot brains. It begins in plan mode.
