# Game Time Tracker

A phone app for youth soccer coaches that makes equal play time automatic. Works completely offline once installed — no account, no signal needed on the field.

**What it does**

- Tracks live minutes for every player, sorted so you can see who's behind at a glance
- Builds a rotation plan before kickoff based on who showed up (7–11 players) and how often you want to sub
- Alerts you (buzz + beep) at every sub time with exactly who goes off and on — one tap to apply
- Rotates the goalkeeper at halftime (and to a third keeper if that keeps minutes even)
- Handles late arrivals and injuries mid-game
- Remembers who was short-changed so it evens out over the season

Game format: 7 on the field, 2 × 25-minute halves, water break mid-half.

## Install on your phone

Open the app URL in your phone's browser, then:

- **iPhone (Safari):** tap the Share button → **Add to Home Screen** → Add
- **Android (Chrome):** tap the ⋮ menu → **Install app** (or **Add to Home screen**)

Launch it from the home screen icon like any app. It keeps working in airplane mode.

## Using it on game day

1. **Roster** — tap a name to toggle IN/OUT for today. Tap ✎ to rename. Untoggle GK for kids who shouldn't play keeper.
2. **Starters** (optional) — tap up to 7 players to start on the field and pick the starting keeper. Anyone you don't pick is filled in by the plan.
3. **Subs per half** — how many times you want to swap kids in each half. More subs = shorter shifts (better in the heat) and tighter fairness. The schedule and expected minutes update as you change it.
4. **Show plan** (optional) — the full rotation grid; screenshot it as a backup.
5. **Start game**, then tap **Start** when the ref blows the whistle. Pause for injuries etc.
6. When the phone buzzes, the banner shows who goes OFF/ON. Tap **Apply** once the kids have swapped.
7. To sub manually: tap a bench player, then the field player they replace. Tap **GK** on a field player to make them keeper.
8. **Attendance** lets you add a late arrival or mark a player out (injured).
9. At full time, review the summary and tap **Save to season** so next game's plan favours anyone who came up short. A player who arrives late or leaves injured gets a pro-rated fair share, so they aren't "owed" minutes they weren't there for.

## Deploy (for whoever hosts it)

Static files only — any web host works. With GitHub Pages:

1. Push to `main`
2. Repo → Settings → Pages → Source: *Deploy from a branch*, branch `main`, folder `/ (root)`
3. Share the resulting URL with the coach

To develop locally: `python3 -m http.server 8000` in this folder, then open `http://<your-computer-ip>:8000` on your phone (same Wi‑Fi). After changing any file, bump `CACHE` in `sw.js` so installed phones pick up the new version.
