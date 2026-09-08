# How to play Crewfall

*(Skeleton. Filled in as each system is built; completed in Phase 7.)*

## Starting the game
Double-click `play.bat`. A browser tab opens with the game.

## Controls (Phase 1)
| Key | Action |
|---|---|
| W A S D or arrow keys | Move |
| Tab (hold) | Show the full map |
| F3 | Debug overlay on/off |

## What you see
The name of the room you are in shows at the top-left. Hallways are called "Corridor 1", "Corridor 2"
and so on. Hold Tab for the ship map; the cyan dot is you. F3 shows technical details and draws
the walking graph that bots will use to find their way.

## Editing the map
Open `assets/maps/kestrel.json` in any text editor. The `tiles` section is a picture of the ship,
one character per floor tile (`#` wall, `.` floor). The `_help` lines at the top explain the rest.
After editing, run `npm test` in a command window in the project folder: it lists any rule the map
now breaks, in plain language. Then relaunch `play.bat`.
