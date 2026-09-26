# Game Time Tracker

A phone app for youth soccer coaches that makes equal play time automatic. Works completely offline once installed — no account, no signal needed on the field.

**What it does**

- Shows the team on a pitch, in position, with live minutes on every player
- Builds a rotation plan before kickoff based on who showed up (7–11 players) and how often you want to sub
- Alerts you (buzz + beep) at every sub time with exactly who goes off and on — one tap to apply
- Rotates the goalkeeper at halftime (and to a third keeper if that keeps minutes even)
- Puts each player in a position they actually play, and spreads their time across those positions
- Save game plans in advance — who plays which position in every block — and load one on game day
- Handles late arrivals and injuries mid-game
- Remembers who was short-changed so it evens out over the season

Game format: 7 on the field in a 1-2-3-1, 2 × 25-minute halves, water break mid-half. The clock runs straight through like a real match — the second half starts at 25:00, not back at 0:00, and keeps going past 50:00 into stoppage time. The clock is yours: it stops when you tap **Water break**, pauses at halftime, and **never ends the game by itself** — it runs into stoppage time until you tap **End game**.

Positions: **GK** (1), **CB** (4/5, two slots), **W** (7/11, the two wide slots that cover both back and winger), **CM** (8), **ST** (9).

## Install on your phone

Open the app URL in your phone's browser, then:

- **iPhone (Safari):** tap the Share button → **Add to Home Screen** → Add
- **Android (Chrome):** tap the ⋮ menu → **Install app** (or **Add to Home screen**)

Launch it from the home screen icon like any app. It keeps working in airplane mode.

## Using it on game day

1. **Roster** — tap a name to toggle IN/OUT for today. Tap ✎ to rename. Under each name, toggle the positions that player can play; the plan puts them in one of those and rotates them through the rest. A player with nothing marked can be played anywhere.
2. **Game plan** (optional) — tap **New plan** to lay out every block on a pitch: tap a position, then a bench player to put them there. **Subs per half** lives here, since it sets the block boundaries; changing it re-blocks the plan and keeps your starting eleven. **Auto-fill later blocks** lets the app finish the rotation once you've set the blocks you care about. Save it, and on game day tap the plan to use it — it drives every sub alert. If someone in the plan isn't there, the app fills their spots and tells you who it moved.
3. **Starters** (optional, when no plan is loaded) — tap up to 7 players to start on the field and pick the starting keeper.
4. **Subs per half** — shown only when no plan is selected (a plan carries its own). More subs = shorter shifts, better in the heat, and tighter fairness. The schedule and expected minutes update as you change it.
5. **Show plan** (optional) — the full rotation grid; screenshot it as a backup.
6. **Start game**, then tap **Start** when the ref blows the whistle. **Water break** stops the clock and labels why; tap **Resume** to restart. At halftime you get **Start 2nd half**, or **Play on** if the ref hasn't blown yet.
7. When the phone buzzes, the board shows one row per swap — who comes off, the position, who goes on. Tap **Apply** once the kids have swapped.
8. To change the lineup, tap **Edit lineup**. Tap a position, then a bench player to put them there; tap two positions to swap them. You're setting how the field should look. Then **Sub now** to make it happen immediately, or **Save for 6:15** to hold it for the next whistle. The keeper is simply whoever stands in the GK spot. Outside edit mode tapping does nothing, so a stray tap can't disturb the lineup.
9. **Attendance** lets you add a late arrival or mark a player out (injured).
10. When the ref blows, tap **End game**, then review the summary and tap **Save to season** so next game's plan favours anyone who came up short. A player who arrives late or leaves injured gets a pro-rated fair share, so they aren't "owed" minutes they weren't there for.

Minutes in each position appear under every player's name on the game summary, and the **Season** screen has a **Time by position** table for the whole season — a column per position, red where it isn't one the player is marked for. If a player keeps landing somewhere they don't want, mark that position for more of the squad; with only two or three kids marked for a position, someone else has to fill it.

**Export CSV** on the Season screen hands off the whole record: one row per player per game (minutes, fair share, difference, minutes available, and minutes in each position), then a season total per player. On a phone it opens the share sheet so you can send it to yourself; on a computer it downloads. If neither works, the text appears on screen to copy into a spreadsheet.

## Deploy (for whoever hosts it)

Static files only — any web host works. With GitHub Pages:

1. Push to `main`
2. Repo → Settings → Pages → Source: *Deploy from a branch*, branch `main`, folder `/ (root)`
3. Share the resulting URL with the coach

To develop locally: `python3 -m http.server 8000` in this folder, then open `http://<your-computer-ip>:8000` on your phone (same Wi‑Fi). After changing any file, bump `CACHE` in `sw.js` so installed phones pick up the new version.
