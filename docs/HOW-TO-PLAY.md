# How to play Crewfall

*(Skeleton. Filled in as each system is built; completed in Phase 7.)*

## Starting the game
Double-click `play.bat`. A browser tab opens with the game.

## The lobby
The game opens in a lobby with you and the bots. Walk to the **SETTINGS** computer and press **E**
to change the game: how many players and impostors, your name and colour, kill cooldown and
distance, meeting timers, how far crew and impostors can see, walking speed, task counts, and the
seed. Press Esc or Done to close; your choices are remembered next time. Stand on the green
**START** pad and press **E** to begin.

A seed is a number that decides everything random in a game. Leave it empty for a fresh game each
time, or type one to replay the same game (F3 shows the current seed).

## Controls
| Key | Action |
|---|---|
| W A S D or arrow keys | Move |
| E or Space | Use (settings computer, start pad) |
| Tab (hold) | Show the full map (in a match) |
| F3 | Debug overlay on/off |

## Seeing
In a match you see only a circle around you, cut off by walls. Crew and impostors see different
distances (settings). Bots follow exactly the same rule: what they cannot see, they do not know.

## What you see
The name of the room you are in shows at the top-left. Hallways are called "Corridor 1", "Corridor 2"
and so on. Hold Tab for the ship map; the cyan dot is you. F3 shows technical details and draws
the walking graph that bots will use to find their way.

## Editing the map
Open `assets/maps/kestrel.json` in any text editor. The `tiles` section is a picture of the ship,
one character per floor tile (`#` wall, `.` floor). The `_help` lines at the top explain the rest.
After editing, run `npm test` in a command window in the project folder: it lists any rule the map
now breaks, in plain language. Then relaunch `play.bat`.
