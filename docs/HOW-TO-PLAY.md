# How to play Crewfall

*(Skeleton. Filled in as each system is built; completed in Phase 7.)*

## Starting the game
Double-click `play.bat`. A browser tab opens with a loading screen (stars, a counter of assets loaded,
units drifting past) and then the lobby.

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
| E or Space | Use: settings computer, start pad, emergency button. Hold to do a task |
| R | Report a body you are standing next to |
| Q | Kill (impostors only, when the cooldown is ready and someone is in reach) |
| V | Climb into a vent you are standing next to, or out of the one you are in (impostors only) |
| WASD / arrows (in a vent) | Hop to the next connected vent in that direction |
| Enter | In a meeting: focus the chat box, then send |
| Esc | Back to the lobby (in a match) |
| Tab (hold) | Show the full map (in a match) |
| F3 | Debug overlay on/off. With it on, press 1–9 to inspect a bot (its memory), 0 to close |

## Seeing
View distance is how far out the camera is zoomed. Crew see one screen of ship around them at 1.0x;
impostors see more at 1.5x (both are settings). Bots see exactly as far as a player of their role
would: what they cannot see, they do not know. When the lights are sabotaged (Phase 4) crew see only
a small lit area that walls block.

## What you see
The name of the room you are in shows at the top-left. Hallways are called "Corridor 1", "Corridor 2"
and so on. Hold Tab for the ship map; the cyan dot is you. F3 shows technical details and draws
the walking graph that bots will use to find their way.

## Editing the map
Open `assets/maps/kestrel.json` in any text editor. The `tiles` section is a picture of the ship,
one character per floor tile (`#` wall, `.` floor). The `_help` lines at the top explain the rest.
After editing, run `npm test` in a command window in the project folder: it lists any rule the map
now breaks, in plain language. Then relaunch `play.bat`.

## Tasks
Your tasks are listed top-left with the room each one is in. Walk to the spot and hold E; a ring
fills up around you. Let go or walk away and it resets. The bar at the top shows how many of the
crew's tasks are done. Impostors get a fake list that never counts.

## Kills, bodies and reporting
Impostors press Q to kill someone in reach; the cooldown (top right) restarts after each kill.
A body stays where it fell. Anyone alive standing next to a body can press R to report it, or
press E at the red emergency button in Cafeteria to call a meeting. Bots do the same: crew bots
report bodies they see; impostor bots kill when nobody could be watching.

## Vents (impostors)
The dark grates on the floor are vents. Stand next to one and press V to climb in: you shrink into
the grate and nobody can see you. Vents come in small networks; press a direction to hop to the
connected vent that way (hold Tab to see the vents and their links), and V again to climb out.
Inside a vent you cannot kill, report or do anything else. Be careful: any bot that sees you climb
in or out knows for certain you are an impostor and will say so at the next meeting. Impostor bots
use vents the same way, usually right after a kill, so a crewmate who watches the grates can catch
one.

## Ghosts
When you die you become a ghost: you can still walk around and finish your tasks, which still
count for the crew. Only other ghosts can see you.

## Meetings
A report or the emergency button opens the meeting. Everyone alive appears as a tile. First comes
discussion (chat only), then voting: click a tile, then Confirm, or press Skip. You can change your
vote until the timer ends; voting ends early when everyone has voted. The most votes is ejected;
a tie, or more skips than votes for anyone, ejects nobody. With "confirm ejects" on you are told
whether the ejected player was an impostor. Type in the box on the right and press Enter to talk.
Dead players can read but not talk or vote.

## Talking to the bots
Bots understand plain typed sentences. Things that work:
- Accuse: "it's Trix", "Trix vented", "vote trix", "red is sus", "Trix killed them".
- Say where you were: "i was in medbay", or just "medbay".
- Say who you were with: "i was with Pru", "Pru was with me".
- Say what you saw: "i saw Bix in electrical", "Bix was in storage".
- Ask someone: "where were you Eve?", or just "Eve?".
- Give up: "skip", "no info".
When a bot says it saw someone kill or vent, the other bots believe it far more than a plain
accusation: two such witnesses will get someone voted out.
Names and colours can be shortened ("tri", "pur") and typos of one letter are forgiven. A bot you
question or accuse answers within a few seconds, in its own personality. Bots remember what you
claim and will call you out if it clashes with what they saw. Anything they cannot understand gets
a shrug and changes nothing. With F3 on, the debug panel shows how your last line was read.

## How a game ends
The crew wins when every crew task is done or every impostor has been voted out. The impostors win
when they equal the crew in numbers. Voting out the last impostor ends the game on the spot. The end
screen shows who the impostors were and why the game ended; Play again starts a new game with the
same settings, Lobby takes you back to the pod.
