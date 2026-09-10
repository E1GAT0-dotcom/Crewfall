# Phase 3 report — Bot brains

Date: 2026-09-09. Written for Greg.

## Summary
Phase 3 is built and self-tested. Bots now see, remember, suspect, talk from evidence in six
personalities, lie plausibly as impostors, vote for reasons they can state, and explain every
decision in F3. The headless simulator plays hundreds of bot games and reports the balance;
normal sits at 51% crew wins over 200 games, inside the spec's 35–65% band.

## Step by step
1. **Eyes and memory.** Sightings as unbroken stretches (rooms, companions, alone time, task
   spots, bodies, heading), kills witnessed, bodies seen, recall accuracy and span by difficulty,
   public claims checked against private memory, contradictions with reasons.
2. **Suspicion and trust.** The SPEC 9.7 table with weights in a config file; every change logged
   with a sentence; locks for witnessed kills and visual tasks; decay each meeting.
3. **Personalities and decisions.** Six personalities as data; buddying, report delays, fear, the
   button on certain evidence; impostor target choice by difficulty, hesitation, self-reports on
   hard, lies built from the real route; voting for reasons with a one-time change.
4. **Voices and the parser.** 756 lines across 21 intents in six styles; wording chosen by the
   strongest evidence; every factual line becomes a claim; conversation state; a parser for typed
   accusations, alibis, sightings, "with", questions and skips; answers within 2–5 s; shrugs for
   nonsense.
5. **Simulator and tuning.** `npm run sim`, the fishbowl decision (kills are only noticed within
   10 tiles), easy fixed to allow kills, scenario tests, docs.

## What changed against the plan
- Alibis cover the moment of the death plus or minus 8 s and always name a room; a claim holds if
  the person was seen there at any point in the window. Live testing showed honest bots being
  contradicted before this.
- Every bot line waits for the 1.5 s gap, including answers to each other.
- At Greg's request during the phase: front-facing walls, task consoles and task markers, and the
  loading screen with the asset counter and drifting units.

## The numbers (200 games, Kestrel, 10 players, 2 impostors)
| | normal (200 games) | hard (50) | easy (50) |
|---|---|---|---|
| Crew wins | 51% | 56% | 50% |
| Kills per game | 4.0 | 4.0 | 4.0 |
| Meetings per game | 2.8 | 2.9 | 2.9 |
| Average length | 5.1 min | 5.2 min | 6.1 min |
| Ejection accuracy | 50% | 55% | 45% |

Before the easy fix, easy was 100% crew wins with 0.1 kills per game.

## How it was tested
- 173 automated tests, 54 new this phase, plus the scenario tests SPEC 9.14 asks for.
- Live meetings in the browser after each step, with the chat read back: witnesses accusing with
  "I saw it", a bot noting who left the body's room and how long before, alibis backed and
  contradicted, questions answered in character, and an impostor trying to frame someone.

## Known limitations (by design)
No sabotage, vents or minigames yet, so the vent and visual-task evidence hooks are wired but
unused. Crew wins by tasks are rare on normal now (3 of 200); most games end by ejection or
numbers, which suits a social deduction game but is worth a look in play. Easy, normal and hard sit close together in the simulator; the
differences the player feels (memory, cross-checking, self-reports, targeting) do not show in an
all-bot lobby, so difficulty is best judged in play.

## What I need from you
1. The Phase 3 done test from SPEC §14: play 5 games; check in F3 (number keys) that accusations
   match sightings; type an accusation and watch the accused bot's reply and the others' suspicion;
   judge the impostor bots' alibis. `npm run sim` output is above.
2. Your Phase 2 verdict too, if it is still pending.
3. Approval to start Phase 4, the impostor toolkit: sabotage, vents, doors, and bots' responses.
