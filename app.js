'use strict';

// ============================================================
// Constants
// ============================================================
const HALF_MIN = 25;
const GAME_MIN = 2 * HALF_MIN;
const ON_FIELD = 7;
const ROSTER_SIZE = 11;
const MIN_SUBS = 1, MAX_SUBS = 6;
const STORAGE_KEY = 'gametime.v1';

// ============================================================
// State
// ============================================================
const DEFAULT_NAMES = ['Alvi', 'Kamryn', 'Ezra', 'Mason', 'Milan', 'Anthony', 'Ronaldo', 'Cameron', 'Daniel', 'Donavan', 'Mateo'];

function defaultState() {
  return {
    roster: Array.from({ length: ROSTER_SIZE }, (_, i) => ({
      id: 'p' + i, name: DEFAULT_NAMES[i] || 'Player ' + (i + 1), gk: false, present: true,
    })),
    v: 2,
    subsPerHalf: 3,
    starters: [],     // ids the coach wants on at kickoff (optional, up to 7)
    startGk: null,    // starting keeper (optional; must be a starter)
    useCarryOver: true,
    carryOver: {},   // id -> minutes above/below fair share, summed over season
    history: [],     // [{ date, minutes: {id: min} }]
    game: null,
  };
}

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      const st = Object.assign(defaultState(), saved);
      // v2: keeper flag defaults to off; clear the old all-on default
      if (!saved.v) { st.roster.forEach(p => { p.gk = false; }); st.v = 2; }
      return st;
    }
  } catch (e) { /* ignore */ }
  return defaultState();
}
function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
}

// ============================================================
// Block / schedule math
// ============================================================
const blockLen = S => HALF_MIN / (S + 1);          // minutes per block
const blockCount = S => 2 * (S + 1);
const blockStart = (S, b) => b * blockLen(S);
function blockAt(S, elapsedMin) {
  return Math.min(blockCount(S) - 1, Math.floor(elapsedMin / blockLen(S) + 1e-9));
}
// sub times within one half, in minutes from the start of that half
function subTimesInHalf(S) {
  const L = blockLen(S);
  return Array.from({ length: S }, (_, k) => (k + 1) * L);
}
// water break snapped to the nearest scheduled sub time in the half
function waterBreakInHalf(S) {
  const target = HALF_MIN / 2;
  return subTimesInHalf(S).reduce((best, t) =>
    Math.abs(t - target) < Math.abs(best - target) ? t : best);
}
function fairTarget(presentCount) {
  return presentCount > 0 ? (GAME_MIN * ON_FIELD) / presentCount : 0;
}

function fmtClock(min) {
  const total = Math.max(0, Math.round(min * 60));
  const m = Math.floor(total / 60), s = total % 60;
  return m + ':' + String(s).padStart(2, '0');
}
function fmtMin(min) { return fmtClock(min); }

// ============================================================
// Rotation planner
//   ids        – present player ids, in roster order
//   S          – subs per half
//   minutes    – { id: minutes already credited (actual played + carry-over) }
//   fromBlock  – first block to plan
//   onField    – Set of ids currently on (for churn tie-break)
//   gk         – current keeper (mid-game replans)
//   h1gk, h2gk – keeper planned for each half (null = choose)
//   starters   – ids the coach wants on the field at kickoff (block 0 only; up to 7)
//   played     – ids that have already played this game (mid-game replans)
//   gkEligible – Set of ids willing to keep
// Returns { blocks: [{ index, half, start, end, on, gk, bench }], projected, h1gk, h2gk }
//
// Keepers play a whole half. The second-half keeper is chosen up front; once they have
// had one stint in the first half they carry a virtual credit so the greedy benches them
// enough to make room for their full second half (letting them play first keeps the first
// sub a full line change). One extra handoff is allowed if a keeper would otherwise end
// up a full block ahead of the player they displace.
// ============================================================
function planFrom({ ids, S, minutes, fromBlock = 0, onField, gk = null, h1gk = null, h2gk = null, starters = [], played = [], gkEligible }) {
  const B = blockCount(S), L = blockLen(S);
  const n = ids.length;
  const mins = {};
  ids.forEach(id => { mins[id] = minutes[id] || 0; });
  const order = new Map(ids.map((id, i) => [id, i]));
  let eligible = new Set([...(gkEligible || [])].filter(id => ids.includes(id)));
  if (eligible.size === 0) eligible = new Set(ids);

  // Coach-picked starters only apply at kickoff; they also act as the "already on" set
  // so the planner prefers them for block 0 and prefers a non-starter as second-half keeper.
  const kickoff = fromBlock === 0 ? starters.filter(id => ids.includes(id)).slice(0, ON_FIELD) : [];
  let on = new Set([...(onField || kickoff)].filter(id => ids.includes(id)));
  let curGk = ids.includes(gk) ? gk : null;
  let firstGk = ids.includes(h1gk) ? h1gk : (fromBlock <= S ? curGk : null);
  let secondGk = ids.includes(h2gk) ? h2gk : (fromBlock > S ? curGk : null);
  const keepers = new Set([firstGk, secondGk, curGk].filter(Boolean));
  const MAX_KEEPERS = 3;
  const blocks = [];

  const lowestEligible = (exclude, preferBench, from = ids) => [...from]
    .filter(id => eligible.has(id) && !exclude.includes(id))
    .sort((a, c) => mins[a] - mins[c] || (preferBench ? on.has(a) - on.has(c) : 0) || order.get(a) - order.get(c))[0] || null;

  // Pick first-half keeper (block 0 only) and second-half keeper before planning.
  if (fromBlock === 0 && !firstGk) firstGk = (kickoff.length && lowestEligible([], false, kickoff)) || lowestEligible([], false);
  if (fromBlock <= S && !secondGk) secondGk = lowestEligible([firstGk], true) || firstGk;
  keepers.add(firstGk); keepers.add(secondGk);

  // Virtual credit for the second-half keeper during first-half planning: the minutes
  // everyone else will get in the first half minus what the keeper should get.
  const target = (GAME_MIN * ON_FIELD) / n;
  const othersH1 = n > 2 ? (HALF_MIN * ON_FIELD - HALF_MIN - (target - HALF_MIN)) / (n - 2) : 0;
  const h2Credit = Math.max(0, othersH1 - (target - HALF_MIN));
  const seen = new Set([...played, ...on].filter(id => ids.includes(id)));

  for (let b = fromBlock; b < B; b++) {
    const half = b <= S ? 1 : 2;
    const firstOfHalf = b === 0 || b === S + 1;
    const credit = id => (half === 1 && id === secondGk && secondGk !== firstGk && seen.has(id) ? h2Credit : 0);
    const key = id => Math.round((mins[id] + credit(id)) * 2) / 2; // tie within 30s
    // On ties, prefer players coming off the bench so each sub round is a full line change
    // (the whole bench comes on). At kickoff the tie-break favours the coach's starters instead.
    const fresh = (a, c) => (b === 0 ? on.has(c) - on.has(a) : on.has(a) - on.has(c));
    const sorted = [...ids].sort((a, c) =>
      key(a) - key(c) || fresh(a, c) || order.get(a) - order.get(c));
    let lineup = sorted.slice(0, ON_FIELD);
    const locked = new Set(b === 0 ? kickoff : []);
    if (locked.size) lineup = [...kickoff, ...sorted.filter(id => !locked.has(id))].slice(0, ON_FIELD);

    const force = id => {
      if (!id || lineup.includes(id)) return;
      const drop = [...lineup].reverse().find(x => x !== id && !locked.has(x)) || [...lineup].reverse().find(x => x !== id);
      lineup = lineup.filter(x => x !== drop).concat(id);
    };

    let nextGk = null;
    const eligibleIn = () => lineup.filter(id => eligible.has(id));
    if (b === 0) {
      force(firstGk); nextGk = firstGk;
    } else if (b === S + 1) {
      if (secondGk && ids.includes(secondGk)) { force(secondGk); nextGk = secondGk; }
      else {
        let pool = eligibleIn().filter(id => !keepers.has(id));
        if (!pool.length) pool = eligibleIn();
        nextGk = pool[0] || null;
        if (!nextGk) { const e = lowestEligible([], false); force(e); nextGk = e; }
        secondGk = nextGk;
      }
    } else if (curGk && lineup.includes(curGk)) {
      nextGk = curGk;
    } else if (curGk) {
      // Keeper stays on for the half unless that leaves them a full block ahead of the
      // player they'd displace — then hand off once to an extra keeper.
      const alt = eligibleIn().filter(id => !keepers.has(id));
      const last = lineup[lineup.length - 1];
      const ahead = key(curGk) >= key(last) + L - 1e-6;
      if (alt.length && ahead && keepers.size < MAX_KEEPERS) nextGk = alt[0];
      else { force(curGk); nextGk = curGk; }
    } else {
      // Mid-half replan with no keeper on record.
      nextGk = eligibleIn()[0] || null;
      if (!nextGk) { const e = lowestEligible([], false); force(e); nextGk = e; }
    }
    if (nextGk) keepers.add(nextGk);

    lineup = sorted.filter(id => lineup.includes(id)); // keep min-order
    blocks.push({
      index: b, half, start: b * L, end: (b + 1) * L,
      on: lineup, gk: nextGk, bench: ids.filter(id => !lineup.includes(id)),
    });
    lineup.forEach(id => { mins[id] += L; seen.add(id); });
    on = new Set(lineup);
    curGk = nextGk;
  }
  return { blocks, projected: mins, h1gk: firstGk, h2gk: secondGk };
}

// Swap list between two consecutive block lineups
function diffLineups(prevOn, prevGk, next) {
  const prev = new Set(prevOn);
  const nextSet = new Set(next.on);
  return {
    off: [...prev].filter(id => !nextSet.has(id)),
    on: next.on.filter(id => !prev.has(id)),
    gk: next.gk !== prevGk ? next.gk : null,
  };
}

// ============================================================
// Helpers on state
// ============================================================
const byId = id => state.roster.find(p => p.id === id);
const nameOf = id => (window.__nameOverride ? window.__nameOverride(id) : (byId(id) || { name: '?' }).name);
const presentIds = () => state.roster.filter(p => p.present).map(p => p.id);
const gkEligibleSet = () => new Set(state.roster.filter(p => p.gk).map(p => p.id));
// Carry-over is "minutes above fair share" — players who are ahead start with a head start
// in the planner's tally so they get lower priority this game.
const seedMinutes = ids => {
  const m = {};
  ids.forEach(id => { m[id] = state.useCarryOver ? (state.carryOver[id] || 0) : 0; });
  return m;
};
// Starters/keeper choices only count for players who are present
const activeStarters = () => state.starters.filter(id => byId(id) && byId(id).present).slice(0, ON_FIELD);
const activeStartGk = () => (activeStarters().includes(state.startGk) && byId(state.startGk).gk) ? state.startGk : null;
// Planner inputs for a fresh game from the setup screen
function kickoffPlanInputs() {
  const ids = presentIds();
  return {
    ids, S: state.subsPerHalf, minutes: seedMinutes(ids),
    starters: activeStarters(), h1gk: activeStartGk(), gkEligible: gkEligibleSet(),
  };
}

// ============================================================
// Game engine
// ============================================================
function newGame() {
  const ids = presentIds();
  const players = {};
  ids.forEach(id => { players[id] = { playedMs: 0, onField: false, onSinceMs: 0, availMs: 0, inSinceMs: 0 }; });
  const g = {
    phase: 'h1',            // h1 | halftime | h2 | done
    running: false,
    elapsedMs: 0,
    runningSince: null,
    subsPerHalf: state.subsPerHalf,
    players, gk: null, h1gk: null, h2gk: null,
    lastAlertBlock: 0,
    pending: null,
    selected: null,
    startedAt: Date.now(),
  };
  state.game = g;
  // Initial lineup from the planner (honours coach-picked starters)
  const plan = planFrom(kickoffPlanInputs());
  const first = plan.blocks[0];
  first.on.forEach(id => { players[id].onField = true; players[id].onSinceMs = 0; });
  g.gk = first.gk; g.h1gk = plan.h1gk; g.h2gk = plan.h2gk;
  g.plan = plan.blocks.map(b => ({ index: b.index, on: b.on, gk: b.gk }));
  g.log = [];
  logLineup();
  save();
}

// Append the current lineup to the game log (skipped if unchanged from the last entry)
function logLineup() {
  const g = state.game;
  if (!g) return;
  const on = Object.keys(g.players).filter(id => g.players[id].onField).sort();
  const last = g.log[g.log.length - 1];
  if (last && last.gk === g.gk && last.on.join() === on.join()) return;
  g.log.push({ t: Math.round(elapsedMin() * 100) / 100, on, gk: g.gk });
}

function elapsedMs() {
  const g = state.game;
  if (!g) return 0;
  let ms = g.elapsedMs + (g.running ? Date.now() - g.runningSince : 0);
  return Math.min(ms, GAME_MIN * 60000);
}
const elapsedMin = () => elapsedMs() / 60000;

function playedMs(id) {
  const g = state.game, p = g.players[id];
  if (!p) return 0;
  return p.playedMs + (p.onField ? elapsedMs() - p.onSinceMs : 0);
}
const playedMin = id => playedMs(id) / 60000;

// Minutes a player was available to play (present and not injured/out)
function availableMin(id) {
  const p = state.game.players[id];
  if (!p) return 0;
  return (p.availMs + (p.inSinceMs != null ? elapsedMs() - p.inSinceMs : 0)) / 60000;
}

// Each player's fair share of the field minutes actually played, weighted by availability
function fairShares() {
  const g = state.game;
  const ids = Object.keys(g.players);
  const avail = {}; let sumAvail = 0, sumPlayed = 0;
  ids.forEach(id => { avail[id] = availableMin(id); sumAvail += avail[id]; sumPlayed += playedMin(id); });
  const shares = {};
  ids.forEach(id => { shares[id] = sumAvail > 0 ? sumPlayed * avail[id] / sumAvail : 0; });
  return shares;
}

function setOnField(id, on) {
  const g = state.game, p = g.players[id];
  if (!p || p.onField === on) return;
  const now = elapsedMs();
  if (on) { p.onField = true; p.onSinceMs = now; }
  else { p.playedMs += now - p.onSinceMs; p.onField = false; if (g.gk === id) g.gk = null; }
}

function startClock() {
  const g = state.game;
  if (g.running) return;
  if (g.phase === 'halftime') g.phase = 'h2';
  g.running = true; g.runningSince = Date.now();
  requestWakeLock();
  save();
}
function pauseClock() {
  const g = state.game;
  if (!g.running) return;
  g.elapsedMs += Date.now() - g.runningSince;
  g.running = false; g.runningSince = null;
  save();
}

// Called every tick: handle halftime, full time, and block boundaries
function tick() {
  const g = state.game;
  if (!g || g.phase === 'done') return;
  const S = g.subsPerHalf;
  const min = elapsedMin();

  if (g.phase === 'h1' && min >= HALF_MIN - 1e-9) {
    pauseClock(); g.elapsedMs = HALF_MIN * 60000; g.phase = 'halftime';
    g.lastAlertBlock = S + 1;
    alertUser();
    suggestForBlock(S + 1, 'Halftime');
    save();
  } else if (g.phase === 'h2' && min >= GAME_MIN - 1e-9) {
    pauseClock(); g.elapsedMs = GAME_MIN * 60000; g.phase = 'done';
    alertUser();
    save();
    showSummary();
    return;
  }

  const b = blockAt(S, elapsedMin());
  if (g.running && b > g.lastAlertBlock) {
    g.lastAlertBlock = b;
    alertUser();
    suggestForBlock(b, 'Sub time');
    save();
  }
}

const playedIds = ids => ids.filter(id => playedMs(id) > 0);

function currentMinutes() {
  const g = state.game;
  const ids = Object.keys(g.players);
  const seed = seedMinutes(ids);
  const m = {};
  ids.forEach(id => { m[id] = seed[id] + playedMin(id); });
  return m;
}

// Coach override for the upcoming sub: { block, off: [ids], on: [ids] }. Only valid for
// that block; ids that have since changed sides are dropped.
function validOverride(target, onField, ids) {
  const ov = state.game.nextOverride;
  if (!ov || ov.block !== target) return null;
  return {
    off: ov.off.filter(id => onField.includes(id)),
    on: ov.on.filter(id => ids.includes(id) && !onField.includes(id)),
  };
}

// Keeper for a manually built lineup: planned half keeper if on, else current keeper if
// still on, else the lowest-minute eligible player in the lineup.
function pickGk(target, lineup, gk, minutes) {
  const g = state.game, S = g.subsPerHalf;
  if (target === S + 1 && lineup.includes(g.h2gk)) return g.h2gk;
  if (gk && lineup.includes(gk)) return gk;
  let elig = lineup.filter(id => gkEligibleSet().has(id));
  if (!elig.length) elig = lineup;
  return elig.sort((a, c) => minutes[a] - minutes[c])[0] || null;
}

// The sub to make at the start of `target`, given the lineup and credited minutes at that
// moment. Honours a coach override; otherwise asks the planner.
function subForBlock(target, ids, onField, gk, minutes) {
  const g = state.game, S = g.subsPerHalf;
  const ov = validOverride(target, onField, ids);
  if (ov) {
    const on2 = onField.filter(id => !ov.off.includes(id)).concat(ov.on);
    const gk2 = pickGk(target, on2, gk, minutes);
    const block = { index: target, half: target <= S ? 1 : 2, start: blockStart(S, target), end: blockStart(S, target + 1), on: on2, gk: gk2, bench: ids.filter(id => !on2.includes(id)) };
    return { block, diff: { off: ov.off, on: ov.on, gk: gk2 !== gk ? gk2 : null }, manual: true, plan: null };
  }
  const plan = planFrom({
    ids, S, minutes, fromBlock: target, onField, gk, h1gk: g.h1gk, h2gk: g.h2gk, played: playedIds(ids), gkEligible: gkEligibleSet(),
  });
  if (!plan.blocks.length) return null;
  return { block: plan.blocks[0], diff: diffLineups(onField, gk, plan.blocks[0]), manual: false, plan };
}

function suggestForBlock(b, title) {
  const g = state.game;
  const ids = presentIds().filter(id => g.players[id]);
  const onField = ids.filter(id => g.players[id].onField);
  const sub = subForBlock(b, ids, onField, g.gk, currentMinutes());
  if (!sub) return;
  if (sub.plan) g.h2gk = sub.plan.h2gk;
  const d = sub.diff;
  if (!d.off.length && !d.on.length && !d.gk) {
    g.pending = { title, off: [], on: [], gk: null, note: 'No change needed. The lineup is already balanced.', block: b };
  } else {
    g.pending = { title, off: d.off, on: d.on, gk: d.gk, manual: sub.manual, block: b };
  }
  if (g.nextOverride && g.nextOverride.block <= b) g.nextOverride = null;
  g.editNext = false;
}

function applyPending() {
  const g = state.game, p = g.pending;
  if (!p) return;
  p.off.forEach(id => setOnField(id, false));
  p.on.forEach(id => setOnField(id, true));
  if (p.gk) g.gk = p.gk;
  if (g.phase === 'h1' && g.gk) g.h1gk = g.gk;
  g.pending = null; g.selected = null;
  logLineup();
  save();
}

function adHocSuggestion() {
  const g = state.game;
  const ids = presentIds().filter(id => g.players[id]);
  const bench = ids.filter(id => !g.players[id].onField).sort((a, c) => playedMin(a) - playedMin(c));
  const field = ids.filter(id => g.players[id].onField && id !== g.gk).sort((a, c) => playedMin(c) - playedMin(a));
  if (!bench.length) return { title: 'No subs available', off: [], on: [], gk: null, note: 'Everyone here is already on the field.' };
  if (!field.length) return null;
  const inId = bench[0], outId = field[0];
  if (playedMin(inId) >= playedMin(outId) - 0.25) {
    return { title: 'Already balanced', off: [], on: [], gk: null, note: 'The bench has as many minutes as the field. Wait for the next scheduled sub.' };
  }
  return { title: 'Suggested sub', off: [outId], on: [inId], gk: null };
}

function endGame() {
  const g = state.game;
  pauseClock();
  g.phase = 'done';
  save();
  showSummary();
}

function finalMinutes() {
  const g = state.game;
  const m = {};
  Object.keys(g.players).forEach(id => { m[id] = playedMin(id); });
  return m;
}

function saveToSeason() {
  const g = state.game;
  const minutes = finalMinutes();
  const shares = fairShares();
  const ids = Object.keys(minutes);
  const avail = {}, names = {};
  ids.forEach(id => { avail[id] = availableMin(id); names[id] = nameOf(id); });
  state.history.push({
    id: 'g' + Date.now(),
    date: new Date().toISOString().slice(0, 10),
    subsPerHalf: g.subsPerHalf,
    players: ids, names, minutes, shares, avail,
    h1gk: g.h1gk, h2gk: g.h2gk,
    plan: g.plan || [], log: g.log || [],
  });
  recomputeCarryOver();
  state.game = null;
  state.starters = []; state.startGk = null; // starters are a per-game choice
  save();
}

// Carry-over is always derived from saved games so deleting one stays consistent
function recomputeCarryOver() {
  const c = {};
  state.history.forEach(h => {
    Object.keys(h.minutes).forEach(id => { c[id] = (c[id] || 0) + (h.minutes[id] - (h.shares[id] || 0)); });
  });
  state.carryOver = c;
}

// ============================================================
// Alerts & wake lock
// ============================================================
let audioCtx = null;
function primeAudio() {
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch (e) { /* ignore */ }
}
function alertUser() {
  try { navigator.vibrate && navigator.vibrate([300, 120, 300, 120, 300]); } catch (e) { /* ignore */ }
  try {
    if (!audioCtx) return;
    const t = audioCtx.currentTime;
    [0, 0.25, 0.5].forEach(off => {
      const o = audioCtx.createOscillator(), gain = audioCtx.createGain();
      o.frequency.value = 880; o.connect(gain); gain.connect(audioCtx.destination);
      gain.gain.setValueAtTime(0.4, t + off); gain.gain.exponentialRampToValueAtTime(0.001, t + off + 0.2);
      o.start(t + off); o.stop(t + off + 0.2);
    });
  } catch (e) { /* ignore */ }
}
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (e) { wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.game && state.game.running) requestWakeLock();
});

// ============================================================
// UI: views
// ============================================================
const $ = id => document.getElementById(id);
const views = ['setup', 'game', 'summary', 'season', 'gamedetail'];
function show(view) {
  views.forEach(v => { $('view-' + v).hidden = v !== view; });
  window.scrollTo(0, 0);
}

// ---------- Setup ----------
function renderSetup() {
  const ids = presentIds();
  const S = state.subsPerHalf;
  const n = ids.length, subs = Math.max(0, n - ON_FIELD);
  $('attendance-summary').textContent = n + ' here, ' + subs + ' sub' + (subs === 1 ? '' : 's') +
    (n >= ON_FIELD ? ', about ' + fmtMin(fairTarget(n)) + ' each' : '');
  const gkCount = state.roster.filter(p => p.present && p.gk).length;
  $('gk-hint').textContent = gkCount === 0 ? 'No keepers marked, so anyone here may be put in goal.' :
    gkCount === 1 ? 'Only one keeper marked. They will be in goal all game.' : '';

  const ul = $('roster');
  ul.innerHTML = '';
  state.roster.forEach(p => {
    const li = document.createElement('li');
    li.className = p.present ? '' : 'absent';
    li.innerHTML =
      '<button class="tag present-tag ' + (p.present ? 'on' : '') + '" data-act="present" data-id="' + p.id + '">' + (p.present ? 'IN' : 'OUT') + '</button>' +
      '<span class="name" data-act="present" data-id="' + p.id + '">' + esc(p.name) + '</span>' +
      '<button class="tag ' + (p.gk ? 'on' : '') + '" data-act="gk" data-id="' + p.id + '">GK</button>' +
      '<button class="edit" data-act="edit" data-id="' + p.id + '" aria-label="Rename">✎</button>';
    ul.appendChild(li);
  });

  $('subs-value').textContent = S;
  $('subs-minus').disabled = S <= MIN_SUBS;
  $('subs-plus').disabled = S >= MAX_SUBS;
  const times = subTimesInHalf(S);
  const water = waterBreakInHalf(S);
  $('subs-schedule').textContent = 'Subs at ' + times.map(t => fmtClock(t) + (t === water ? ' (water break)' : '')).join(', ') +
    ' in each half. Shifts of ' + fmtClock(blockLen(S)) + '.';
  renderStarters();

  if (n >= ON_FIELD) {
    const plan = planFrom(kickoffPlanInputs());
    const seed = seedMinutes(ids);
    const game = ids.map(id => plan.projected[id] - seed[id]);
    const lo = Math.min(...game), hi = Math.max(...game);
    $('subs-fairness').textContent = subs === 0
      ? 'No subs — everyone plays the full game; keeper rotates at halftime.'
      : 'Everyone plays ' + fmtMin(lo) + '–' + fmtMin(hi) + ' this game (gap of ' + fmtClock(hi - lo) + ').' +
        (hi - lo > blockLen(S) + 0.01 ? ' The gap is wider because earlier games are being balanced.' : '');
  } else {
    $('subs-fairness').textContent = '';
  }
  $('use-carry').checked = state.useCarryOver;

  const ok = n >= ON_FIELD;
  $('btn-start').disabled = !ok;
  $('btn-plan').disabled = !ok;
  $('start-msg').textContent = ok ? '' : 'Need at least ' + ON_FIELD + ' players present (' + n + ' marked in).';
  if (!$('plan-card').hidden) renderPlan();
}

function renderStarters() {
  const ids = presentIds();
  const chosen = activeStarters();
  const gkId = activeStartGk();
  const card = $('starters-card');
  if (ids.length < ON_FIELD) { card.hidden = true; return; }
  card.hidden = false;
  $('starters-summary').textContent = chosen.length ? chosen.length + '/' + ON_FIELD + ' picked' +
    (chosen.length < ON_FIELD ? ' · rest chosen automatically' : '') : 'auto';
  // What the plan would do on its own, and whether the coach's picks bench anyone who is owed minutes
  const auto = planFrom(Object.assign(kickoffPlanInputs(), { starters: [], h1gk: null })).blocks[0].on;
  const seed = seedMinutes(ids);
  const owed = ids.filter(id => seed[id] < -0.5 && !chosen.includes(id)).sort((a, c) => seed[a] - seed[c]);
  const note = $('starters-note');
  if (!chosen.length) {
    note.textContent = 'The plan will start ' + auto.map(nameOf).join(', ') + '.' +
      (state.useCarryOver && ids.some(id => seed[id] < -0.5) ? ' Players owed minutes from earlier games go first.' : '');
    note.classList.remove('warn-text');
  } else if (chosen.length >= ON_FIELD && owed.length && state.useCarryOver) {
    note.textContent = owed.map(nameOf).join(', ') + ' ' + (owed.length === 1 ? 'is' : 'are') + ' owed minutes from earlier games but not starting.';
    note.classList.add('warn-text');
  } else {
    note.textContent = 'Starters are cleared after each game.';
    note.classList.remove('warn-text');
  }
  $('starters').innerHTML = ids.map(id => {
    const isStarter = chosen.includes(id);
    return '<button class="chip ' + (isStarter ? 'on' : '') + (gkId === id ? ' gk' : '') + '" data-starter="' + id + '"' +
      (!isStarter && chosen.length >= ON_FIELD ? ' disabled' : '') + '>' +
      esc(nameOf(id)) + (gkId === id ? ' · GK' : '') + '</button>';
  }).join('');
  const sel = $('start-gk');
  const eligibleStarters = chosen.filter(id => byId(id).gk);
  sel.innerHTML = '<option value="">Auto</option>' + eligibleStarters.map(id =>
    '<option value="' + id + '"' + (gkId === id ? ' selected' : '') + '>' + esc(nameOf(id)) + '</option>').join('');
  sel.disabled = eligibleStarters.length === 0;
}

// Shared renderers for a list of plan blocks (setup preview and in-game forecast)
function blockLabel(b, S) {
  const inHalf = b.start - (b.half === 2 ? HALF_MIN : 0);
  return { inHalf, when: b.index === S + 1 ? 'Halftime' : 'H' + b.half + ' ' + fmtClock(inHalf) };
}
function planGridHtml(ids, blocks, S, totals, currentIndex) {
  const water = waterBreakInHalf(S);
  let html = '<tr><th></th>';
  blocks.forEach(b => {
    const { inHalf } = blockLabel(b, S);
    html += '<th class="' + (b.index === S + 1 ? 'half-start ' : '') + (b.index === currentIndex ? 'now' : '') + '">' +
      (b.index === 0 ? 'H1 ' : b.index === S + 1 ? 'H2 ' : '') + fmtClock(inHalf) +
      (Math.abs(inHalf - water) < 1e-6 ? ' 💧' : '') + '</th>';
  });
  html += '<th>Total</th></tr>';
  ids.forEach(id => {
    html += '<tr><td class="player">' + esc(nameOf(id)) + '</td>';
    blocks.forEach(b => {
      const cls = (b.index === S + 1 ? 'half-start ' : '') + (b.index === currentIndex ? 'now ' : '') +
        (b.gk === id ? 'gk' : b.on.includes(id) ? 'on' : '');
      html += '<td class="' + cls + '">' + (b.gk === id ? 'GK' : b.on.includes(id) ? '●' : '') + '</td>';
    });
    html += '<td class="total">' + fmtMin(totals[id]) + '</td></tr>';
  });
  return html;
}
function swapLineHtml(d) {
  const parts = [];
  if (d.off.length) parts.push('<span class="off">Off</span> ' + d.off.map(nameOf).map(esc).join(', '));
  if (d.on.length) parts.push('<span class="on">On</span> ' + d.on.map(nameOf).map(esc).join(', '));
  if (d.gk) parts.push('GK → ' + esc(nameOf(d.gk)));
  return parts.join('  ') || 'no change';
}
// The red/green sub board panels for a swap, plus a footer line for keeper / warnings
function boardPanelsHtml(d, extra) {
  const list = ids => ids.length ? ids.map(id => '<li>' + esc(nameOf(id)) + '</li>').join('') : '<li class="none">nobody</li>';
  let foot = '';
  if (d.gk) foot += '<span class="gkline"><b>GK</b>' + esc(nameOf(d.gk)) + '</span>';
  if (extra) foot += extra;
  return '<div class="board-panels">' +
    '<div class="board-panel off"><h4>OFF</h4><ul>' + list(d.off) + '</ul></div>' +
    '<div class="board-panel on"><h4>ON</h4><ul>' + list(d.on) + '</ul></div></div>' +
    (foot ? '<div class="board-foot">' + foot + '</div>' : '');
}
function planSwapsHtml(blocks, S) {
  const water = waterBreakInHalf(S);
  let html = '<li><b>Keepers:</b> ' + [...new Set(blocks.map(b => b.gk))].map(nameOf).map(esc).join(' → ') + '</li>';
  for (let i = 1; i < blocks.length; i++) {
    const prev = blocks[i - 1], b = blocks[i];
    const { inHalf, when } = blockLabel(b, S);
    html += '<li><b>' + when + '</b>' + (Math.abs(inHalf - water) < 1e-6 ? ' 💧' : '') + ' — ' +
      swapLineHtml(diffLineups(prev.on, prev.gk, b)) + '</li>';
  }
  return html;
}

function renderPlan() {
  const ids = presentIds();
  const S = state.subsPerHalf;
  if (ids.length < ON_FIELD) { $('plan-card').hidden = true; return; }
  const seed = seedMinutes(ids);
  const plan = planFrom(kickoffPlanInputs());
  const totals = {};
  ids.forEach(id => { totals[id] = plan.projected[id] - seed[id]; });
  $('plan-grid').innerHTML = planGridHtml(ids, plan.blocks, S, totals, -1);
  $('plan-swaps').innerHTML = planSwapsHtml(plan.blocks, S);
  $('plan-summary').textContent = blockCount(S) + ' shifts of ' + fmtClock(blockLen(S));
  $('plan-card').hidden = false;
}

// Forecast the rest of the game from the current lineup: minutes are projected to the end
// of the current block, an unapplied pending sub is assumed to happen, and the planner runs
// from the next block. Result is stable within a block so callers can cache by `key`.
function liveForecast() {
  const g = state.game;
  if (!g || g.phase === 'done') return null;
  const S = g.subsPerHalf, B = blockCount(S);
  const min = elapsedMin();
  const b = blockAt(S, min);
  const ids = presentIds().filter(id => g.players[id]);
  let onField = ids.filter(id => g.players[id].onField);
  let gk = g.gk;
  const p = g.pending;
  if (p && (p.off.length || p.on.length || p.gk)) {
    onField = onField.filter(id => !p.off.includes(id)).concat(p.on.filter(id => ids.includes(id)));
    if (p.gk) gk = p.gk;
  }
  const ov = g.nextOverride;
  const key = [b, onField.join(','), gk, ids.join(','), g.h2gk, ov ? ov.block + ':' + ov.off.join(',') + '>' + ov.on.join(',') : ''].join('|');
  const seed = seedMinutes(ids);
  const minutes = currentMinutes();
  const remain = Math.max(0, Math.min(blockStart(S, b + 1), GAME_MIN) - min);
  onField.forEach(id => { minutes[id] += remain; });
  const current = { index: b, half: b <= S ? 1 : 2, start: blockStart(S, b), end: blockStart(S, b + 1), on: onField, gk, bench: ids.filter(id => !onField.includes(id)) };
  let blocks = [current], next = null, projected = minutes;
  if (b + 1 < B) {
    const sub = subForBlock(b + 1, ids, onField, gk, minutes);
    next = { block: sub.block, diff: sub.diff, manual: sub.manual };
    if (sub.manual) {
      // Coach's lineup for the next block, then let the planner take over from there
      const minutes2 = Object.assign({}, minutes);
      sub.block.on.forEach(id => { minutes2[id] += blockLen(S); });
      blocks = [current, sub.block];
      projected = minutes2;
      if (b + 2 < B) {
        const rest = planFrom({
          ids, S, minutes: minutes2, fromBlock: b + 2, onField: sub.block.on, gk: sub.block.gk,
          h1gk: g.h1gk, h2gk: g.h2gk, played: playedIds(ids).concat(sub.block.on), gkEligible: gkEligibleSet(),
        });
        blocks = blocks.concat(rest.blocks);
        projected = rest.projected;
      }
    } else {
      blocks = [current, ...sub.plan.blocks];
      projected = sub.plan.projected;
    }
  }
  // Projected final minutes this game, and each player's fair share of them weighted by
  // how long they are (and will be) available. "Behind" = ends more than a block short
  // of fair even if the plan is followed — beyond what the rotation can even out.
  const totals = {}, fair = {}, behind = {};
  const left = GAME_MIN - min;
  const avail = {}; let sumAvail = 0, sumTotal = 0;
  ids.forEach(id => {
    totals[id] = projected[id] - seed[id];
    avail[id] = availableMin(id) + left;
    sumAvail += avail[id]; sumTotal += totals[id];
  });
  ids.forEach(id => {
    fair[id] = sumAvail > 0 ? sumTotal * avail[id] / sumAvail : 0;
    behind[id] = totals[id] < fair[id] - blockLen(S) + 1e-6;
  });
  return { key, blocks, next, totals, fair, behind, ids };
}

// ---------- Game ----------
function renderGame() {
  const g = state.game;
  if (!g) return;
  const S = g.subsPerHalf;
  const min = elapsedMin();
  const inHalf = g.phase === 'h1' ? min : g.phase === 'halftime' ? 0 : min - HALF_MIN;
  const b = blockAt(S, min);

  const clock = document.querySelector('.clock');
  clock.classList.toggle('paused', !g.running && g.phase !== 'halftime');
  clock.classList.toggle('halftime', g.phase === 'halftime');
  $('clock-time').textContent = fmtClock(g.phase === 'halftime' ? HALF_MIN : Math.min(inHalf, HALF_MIN)).padStart(5, '0');
  $('clock-half').textContent = g.phase === 'h1' ? '1st half' : g.phase === 'halftime' ? 'Halftime' : g.phase === 'h2' ? '2nd half' : 'Full time';
  $('clock-block').textContent = g.phase === 'done' ? '' : 'Block ' + (b + 1) + '/' + blockCount(S);

  const nextEl = $('clock-next');
  nextEl.classList.remove('soon');
  if (g.phase === 'halftime') {
    nextEl.textContent = 'Halftime — make subs, then start 2nd half';
  } else if (g.phase === 'done') {
    nextEl.textContent = 'Game over';
  } else {
    const nextBoundary = Math.min(blockStart(S, b + 1), g.phase === 'h1' ? HALF_MIN : GAME_MIN);
    const remain = nextBoundary - min;
    const label = Math.abs(nextBoundary - HALF_MIN) < 1e-6 ? 'Halftime' : Math.abs(nextBoundary - GAME_MIN) < 1e-6 ? 'Full time' : 'Next sub';
    nextEl.textContent = label + ' in ' + fmtClock(remain);
    if (remain <= 1 && g.running) nextEl.classList.add('soon');
  }

  $('timeline-fill').style.width = (min / GAME_MIN * 100) + '%';
  const marks = $('timeline-marks');
  if (marks.dataset.s !== String(S)) {
    marks.dataset.s = String(S);
    marks.innerHTML = '';
    const water = waterBreakInHalf(S);
    for (let i = 1; i < blockCount(S); i++) {
      const t = blockStart(S, i);
      const half = Math.abs(t - HALF_MIN) < 1e-6;
      const inH = t - (t >= HALF_MIN ? HALF_MIN : 0);
      const isWater = !half && Math.abs(inH - water) < 1e-6;
      const s = document.createElement('span');
      s.className = half ? 'half' : isWater ? 'water' : '';
      s.style.left = (t / GAME_MIN * 100) + '%';
      marks.appendChild(s);
    }
  }

  const btn = $('btn-clock');
  btn.disabled = g.phase === 'done';
  btn.textContent = g.phase === 'halftime' ? 'Start 2nd half' : g.running ? 'Pause' : (min === 0 ? 'Start' : 'Resume');

  const ids = presentIds().filter(id => g.players[id]);

  // Sub board lit up: it's time to sub
  const banner = $('banner');
  if (g.pending) {
    const p = g.pending;
    $('banner-title').textContent = p.title;
    const pb = p.block != null ? p.block : blockAt(S, min);
    $('banner').querySelector('.board-strip .muted').textContent = pb === S + 1 ? 'before the 2nd half' :
      'H' + (pb <= S ? 1 : 2) + ' ' + fmtClock(blockStart(S, pb) - (pb > S ? HALF_MIN : 0));
    const onNow = ids.filter(id => g.players[id].onField).length;
    const after = onNow - p.off.length + p.on.length;
    const over = after > Math.min(ON_FIELD, ids.length);
    let extra = '';
    if (p.manual) extra += '<span class="muted">Edited by you</span>';
    if (over) extra += '<span class="warn">That puts ' + after + ' on the field. Dismiss and sub by hand.</span>';
    $('banner-body').innerHTML = p.note
      ? '<div class="board-foot">' + esc(p.note) + '</div>'
      : boardPanelsHtml({ off: p.off, on: p.on, gk: p.gk }, extra);
    $('banner-apply').hidden = !!p.note;
    $('banner-apply').disabled = over;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }

  // Player columns — roster order (stable) with the keeper first
  const mins = {};
  ids.forEach(id => { mins[id] = playedMin(id); });
  const field = ids.filter(id => g.players[id].onField).sort((a, c) => (c === g.gk) - (a === g.gk));
  const bench = ids.filter(id => !g.players[id].onField);

  // Next-sub preview and in-game plan (forecast is stable within a block, so cache by key)
  const fc = liveForecast();
  const next = fc && fc.next;
  // Tags on the player cards: the pending sub while one is waiting to be applied, else the next planned one
  const pendingSub = g.pending && (g.pending.off.length || g.pending.on.length) ? g.pending : null;
  const nextOff = new Set(pendingSub ? pendingSub.off : next ? next.diff.off : []);
  const nextOn = new Set(pendingSub ? pendingSub.on : next ? next.diff.on : []);
  const tagOff = pendingSub ? 'Off now' : 'Off next', tagOn = pendingSub ? 'On now' : 'On next';
  const previewEl = $('clock-preview');
  const problem = overrideProblem(fc);
  const canEdit = !!next && g.phase !== 'done';
  const whenLabel = next ? (next.block.index === S + 1 ? 'at halftime' : 'at ' + fmtClock(next.block.start - (next.block.half === 2 ? HALF_MIN : 0)) + (next.block.half === 2 ? ' (2nd half)' : '')) : '';
  previewEl.classList.toggle('editing', !!g.editNext);
  if (g.editNext && next) {
    previewEl.innerHTML = '<div class="board-strip"><span>Editing next sub</span>' +
      '<span class="edit-actions"><button class="link" id="btn-edit-reset">Use plan</button><button class="link" id="btn-edit-done">Done</button></span></div>' +
      boardPanelsHtml(next.diff, problem ? '<span class="warn">' + esc(problem) + '</span>' : '');
    previewEl.hidden = false;
  } else if (next && !g.pending && (next.diff.off.length || next.diff.on.length || next.diff.gk)) {
    previewEl.innerHTML = '<div class="board-strip"><span>Next sub ' + esc(whenLabel) + '</span><span class="muted">' + (next.manual ? 'edited by you' : 'from the plan') + '</span></div>' +
      boardPanelsHtml(next.diff, problem ? '<span class="warn">' + esc(problem) + '</span>' : '');
    previewEl.hidden = false;
  } else if (canEdit && !g.pending) {
    previewEl.innerHTML = '<div class="board-strip"><span>Next sub ' + esc(whenLabel) + '</span><span class="muted">no change planned</span></div>';
    previewEl.hidden = false;
  } else {
    previewEl.hidden = true;
  }
  clock.classList.toggle('editing', !!g.editNext);
  if (fc && !$('live-plan-card').hidden && $('live-plan-card').dataset.key !== fc.key) {
    $('live-plan-card').dataset.key = fc.key;
    $('live-plan-grid').innerHTML = fc.totals ? planGridHtml(fc.ids, fc.blocks, S, fc.totals, fc.blocks[0].index) : '';
    $('live-plan-swaps').innerHTML = fc.blocks.length > 1 ? planSwapsHtml(fc.blocks, S) : '<li>No more subs scheduled.</li>';
  }

  const tag = id => nextOff.has(id) ? '<span class="tag-next off">' + tagOff + '</span>' : nextOn.has(id) ? '<span class="tag-next on">' + tagOn + '</span>' : '';
  const isBehind = id => !!(fc && fc.behind[id]);
  const proj = id => fc ? '<small class="pproj">' + (isBehind(id) ? 'Short — on pace for ' : 'On pace for ') + fmtMin(fc.totals[id]) + '</small>' : '';
  const cls = id => (isBehind(id) ? 'behind ' : '');
  // GK badge only on players marked as keepers (everyone, if none are marked)
  const anyKeeper = state.roster.some(p => p.present && p.gk);
  const keeper = id => !anyKeeper || byId(id).gk;
  const gkBadge = (id, onField) => !keeper(id) ? '' :
    onField ? '<button class="gkbtn" data-gk="' + id + '" aria-label="Make keeper">GK</button>' : '<span class="gkbtn static">GK</span>';
  // In edit mode the card's right side becomes a next-off / next-on toggle
  const editing = !!g.editNext;
  // In edit mode the whole card is the toggle: picked cards fill red (off) or green (on)
  const pickedCls = (id, onField) => (onField ? nextOff.has(id) : nextOn.has(id)) ? (onField ? 'picked-off ' : 'picked-on ') : '';
  const toggle = (id, onField) => {
    const picked = onField ? nextOff.has(id) : nextOn.has(id);
    return '<span class="etoggle">' + (picked ? '✓' : '') + '</span>';
  };
  $('field-count').textContent = field.length + '/' + ON_FIELD;
  $('bench-count').textContent = String(bench.length);
  $('field-list').innerHTML = field.map(id =>
    '<li data-id="' + id + '" class="' + (g.gk === id ? 'gk ' : '') + (g.selected === id ? 'selected ' : '') + (editing ? 'editing ' + pickedCls(id, true) : '') + cls(id) + '">' +
    '<span class="pname">' + esc(nameOf(id)) + (editing ? '' : tag(id)) + '</span>' +
    (editing ? '<small class="pproj">' + (nextOff.has(id) ? 'Off next' : 'Stays on') + '</small>' + toggle(id, true)
             : proj(id) + '<span class="pmin">' + fmtMin(mins[id]) + '</span>' + gkBadge(id, true)) + '</li>').join('');
  $('bench-list').innerHTML = bench.map(id =>
    '<li data-id="' + id + '" class="' + (g.selected === id ? 'selected ' : '') + (editing ? 'editing ' + pickedCls(id, false) : '') + cls(id) + '">' +
    '<span class="pname">' + esc(nameOf(id)) + (editing ? '' : tag(id)) + '</span>' +
    (editing ? '<small class="pproj">' + (nextOn.has(id) ? 'On next' : 'Stays off') + '</small>' + toggle(id, false)
             : proj(id) + '<span class="pmin">' + fmtMin(mins[id]) + '</span>' + gkBadge(id, false)) + '</li>').join('') ||
    '<li class="muted">No subs</li>';
  $('btn-edit-mode').hidden = !canEdit;
  $('btn-edit-mode').textContent = editing ? 'Done editing' : 'Edit next sub';
  $('btn-edit-mode').classList.toggle('primary', editing);
  $('btn-edit-mode').classList.toggle('secondary', !editing);
  $('btn-suggest').disabled = bench.length === 0 || editing;
  $('game-hint').textContent = editing ? 'Tap a player to change who goes off or on at the next sub.'
    : 'To sub by hand: tap a bench player, then the field player they replace. Tap GK to change keeper.';
  $('btn-suggest').disabled = bench.length === 0;
}

function onPlayerTap(id) {
  const g = state.game;
  if (!g || g.phase === 'done' || !g.players[id]) return;
  if (g.editNext) { toggleNextOverride(id); return; }
  if (g.selected === null || g.selected === id) {
    g.selected = g.selected === id ? null : id;
  } else {
    const a = g.players[g.selected], bP = g.players[id];
    if (a.onField !== bP.onField) {
      const outId = a.onField ? g.selected : id;
      const inId = a.onField ? id : g.selected;
      const wasGk = g.gk === outId;
      setOnField(outId, false);
      setOnField(inId, true);
      if (wasGk) g.gk = inId;
      g.selected = null;
      g.pending = null;
      logLineup();
    } else {
      g.selected = id;
    }
  }
  save();
  renderGame();
}

// Enter edit mode seeded with the planner's suggestion for the next block
function startEditNext() {
  const g = state.game;
  const fc = liveForecast();
  if (!fc || !fc.next) return;
  if (!g.nextOverride || g.nextOverride.block !== fc.next.block.index) {
    g.nextOverride = { block: fc.next.block.index, off: [...fc.next.diff.off], on: [...fc.next.diff.on] };
  }
  g.editNext = true; g.selected = null;
  save(); renderGame();
}
function toggleNextOverride(id) {
  const g = state.game, ov = g.nextOverride;
  if (!ov) return;
  const side = g.players[id].onField ? 'off' : 'on';
  ov[side] = ov[side].includes(id) ? ov[side].filter(x => x !== id) : ov[side].concat(id);
  save(); renderGame();
}
// Field count after the next sub vs. what it should be; null when fine
function overrideProblem(fc) {
  const g = state.game;
  if (!fc || !fc.next || !fc.next.manual) return null;
  const ids = fc.ids, onNow = ids.filter(id => g.players[id].onField).length;
  const after = onNow - fc.next.diff.off.length + fc.next.diff.on.length;
  const want = Math.min(ON_FIELD, ids.length);
  if (after === want) return null;
  const d = after - want;
  return d > 0 ? 'That puts ' + after + ' on the field — mark ' + d + ' more off' : 'Only ' + after + ' on the field — mark ' + (-d) + ' more on';
}

function setGk(id) {
  const g = state.game;
  if (!g || !g.players[id] || !g.players[id].onField) return;
  g.gk = id;
  if (g.phase === 'h1') g.h1gk = id;
  logLineup();
  save();
  renderGame();
}

// ---------- Attendance modal (mid-game) ----------
function renderModal() {
  const g = state.game;
  const ul = $('modal-list');
  ul.innerHTML = '';
  state.roster.forEach(p => {
    const li = document.createElement('li');
    li.className = p.present ? '' : 'absent';
    const status = p.present ? (g.players[p.id] && g.players[p.id].onField ? 'on field' : 'bench') : 'out';
    li.innerHTML =
      '<button class="tag present-tag ' + (p.present ? 'on' : '') + '" data-act="toggle" data-id="' + p.id + '">' + (p.present ? 'IN' : 'OUT') + '</button>' +
      '<span class="name" data-act="toggle" data-id="' + p.id + '">' + esc(p.name) + '</span>' +
      '<span class="muted">' + status + '</span>';
    ul.appendChild(li);
  });
}
function toggleMidGame(id) {
  const g = state.game, p = byId(id);
  p.present = !p.present;
  const now = elapsedMs();
  if (p.present) {
    if (!g.players[id]) g.players[id] = { playedMs: 0, onField: false, onSinceMs: 0, availMs: 0, inSinceMs: now };
    else if (g.players[id].inSinceMs == null) g.players[id].inSinceMs = now;
  } else if (g.players[id]) {
    const gp = g.players[id];
    setOnField(id, false);
    if (gp.inSinceMs != null) { gp.availMs += now - gp.inSinceMs; gp.inSinceMs = null; }
    if (g.selected === id) g.selected = null;
  }
  g.pending = null;
  logLineup();
  save();
  renderModal();
  renderGame();
}

// ---------- Summary ----------
function showSummary() {
  const g = state.game;
  const minutes = finalMinutes();
  const ids = Object.keys(minutes).sort((a, c) => minutes[c] - minutes[a]);
  const vals = ids.map(id => minutes[id]);
  const total = vals.reduce((a, c) => a + c, 0);
  const shares = fairShares();
  const partTime = ids.filter(id => Math.abs(availableMin(id) - elapsedMin()) > 0.5);
  const full = ids.filter(id => !partTime.includes(id));
  const fullVals = full.map(id => minutes[id]);
  const spread = fullVals.length ? Math.max(...fullVals) - Math.min(...fullVals) : 0;
  $('summary-stats').textContent = ids.length + ' players. Fair share ' +
    (full.length ? fmtMin(shares[full[0]]) : '—') +
    (partTime.length ? ' (' + partTime.length + ' part-time, pro-rated)' : '') +
    '. Gap between most and least: ' + fmtClock(spread) + '.';
  $('summary-table').innerHTML = '<tr><th>Player</th><th>vs. fair</th><th>Minutes</th></tr>' + ids.map(id => {
    const d = minutes[id] - shares[id];
    const note = (id === g.h1gk || id === g.h2gk || id === g.gk ? ' (GK)' : '') +
      (partTime.includes(id) ? ' (' + fmtMin(availableMin(id)) + ' avail.)' : '');
    return '<tr><td>' + esc(nameOf(id)) + (note ? ' <span class="muted">' + esc(note.trim()) + '</span>' : '') + '</td>' +
      '<td class="' + (d < -0.5 ? 'neg' : d > 0.5 ? 'pos' : '') + '">' + (d >= 0 ? '+' : '−') + fmtClock(Math.abs(d)) + '</td>' +
      '<td>' + fmtMin(minutes[id]) + '</td></tr>';
  }).join('');
  show('summary');
}

// ---------- Season ----------
const signed = d => (d >= 0 ? '+' : '−') + fmtClock(Math.abs(d));
const signCls = d => (d < -0.5 ? 'neg' : d > 0.5 ? 'pos' : '');

function renderSeason() {
  const games = state.history;
  const played = {}, totalMin = {};
  games.forEach(h => Object.keys(h.minutes).forEach(id => { played[id] = (played[id] || 0) + 1; totalMin[id] = (totalMin[id] || 0) + h.minutes[id]; }));
  const rows = state.roster.map(p => ({ p, d: state.carryOver[p.id] || 0 })).sort((a, c) => a.d - c.d);
  $('season-table').innerHTML = '<tr><th>Player</th><th>Games</th><th>Avg min</th><th>vs. fair</th></tr>' + rows.map(({ p, d }) =>
    '<tr><td>' + esc(p.name) + '</td><td>' + (played[p.id] || 0) + '</td>' +
    '<td>' + (played[p.id] ? fmtMin(totalMin[p.id] / played[p.id]) : '—') + '</td>' +
    '<td class="' + signCls(d) + '">' + signed(d) + '</td></tr>').join('');
  $('season-games').textContent = games.length + ' game' + (games.length === 1 ? '' : 's') + ' saved';
  $('game-list').innerHTML = games.length ? [...games].reverse().map((h, i) => {
    const vals = Object.values(h.minutes);
    const spread = vals.length ? Math.max(...vals) - Math.min(...vals) : 0;
    const n = games.length - i;
    return '<li data-game="' + esc(h.id || String(games.length - 1 - i)) + '"><span class="name">Game ' + n + ' · ' + esc(h.date) + '</span>' +
      '<span class="muted">' + Object.keys(h.minutes).length + ' players, ' + (h.subsPerHalf || '?') + ' subs per half, gap ' + fmtClock(spread) + '</span><span class="chev">›</span></li>';
  }).join('') : '<li class="muted">No games saved yet.</li>';
}

function gameByKey(key) {
  return state.history.find((h, i) => (h.id || String(i)) === key);
}

function renderGameDetail(key) {
  const h = gameByKey(key);
  if (!h) return;
  const S = h.subsPerHalf || 3;
  const ids = (h.players || Object.keys(h.minutes)).slice();
  const name = id => (h.names && h.names[id]) || nameOf(id);
  const idx = state.history.indexOf(h);
  $('gd-title').textContent = 'Game ' + (idx + 1) + ' · ' + h.date;
  const vals = ids.map(id => h.minutes[id]);
  const spread = vals.length ? Math.max(...vals) - Math.min(...vals) : 0;
  const keepers = [...new Set((h.log || []).map(e => e.gk).filter(Boolean))].map(name);
  $('gd-meta').textContent = ids.length + ' players, ' + S + ' subs per half (shifts of ' + fmtClock(blockLen(S)) + '). Gap between most and least: ' + fmtClock(spread) + '.' +
    (keepers.length ? ' Keepers: ' + keepers.join(' → ') + '.' : '');

  // Actual lineups per block, from the log (lineup in effect at the block's midpoint)
  const log = h.log || [];
  const B = blockCount(S), L = blockLen(S);
  const blocks = [];
  for (let b = 0; b < B; b++) {
    const mid = (b + 0.5) * L;
    const entry = [...log].reverse().find(e => e.t <= mid + 1e-6) || log[0];
    if (!entry) break;
    blocks.push({ index: b, half: b <= S ? 1 : 2, start: b * L, end: (b + 1) * L, on: entry.on, gk: entry.gk, bench: ids.filter(id => !entry.on.includes(id)) });
  }
  window.__nameOverride = name;
  $('gd-actual-grid').innerHTML = blocks.length ? planGridHtml(ids, blocks, S, h.minutes, -1) : '<tr><td class="muted">No lineup log for this game.</td></tr>';
  // Sub log: every lineup change with time
  $('gd-log').innerHTML = log.map((e, i) => {
    if (i === 0) return '<li><b>Kickoff</b> — ' + e.on.map(name).map(esc).join(', ') + (e.gk ? ' · GK ' + esc(name(e.gk)) : '') + '</li>';
    const prev = log[i - 1];
    const d = { off: prev.on.filter(id => !e.on.includes(id)), on: e.on.filter(id => !prev.on.includes(id)), gk: e.gk !== prev.gk ? e.gk : null };
    const when = e.t >= HALF_MIN ? 'H2 ' + fmtClock(e.t - HALF_MIN) : 'H1 ' + fmtClock(e.t);
    return '<li><b>' + (Math.abs(e.t - HALF_MIN) < 1e-6 ? 'Halftime' : when) + '</b> — ' + swapLineHtml(d) + '</li>';
  }).join('') || '<li class="muted">No subs recorded.</li>';
  // Planned grid (what the app suggested before kickoff)
  const plan = (h.plan || []).map(b => ({ index: b.index, half: b.index <= S ? 1 : 2, start: b.index * L, end: (b.index + 1) * L, on: b.on, gk: b.gk, bench: [] }));
  const planTotals = {};
  ids.forEach(id => { planTotals[id] = plan.filter(b => b.on.includes(id)).length * L; });
  $('gd-plan-grid').innerHTML = plan.length ? planGridHtml(ids, plan, S, planTotals, -1) : '<tr><td class="muted">No plan saved for this game.</td></tr>';
  window.__nameOverride = null;
  // Playtime table
  const sorted = ids.slice().sort((a, c) => h.minutes[c] - h.minutes[a]);
  const partTime = id => h.avail && Math.abs(h.avail[id] - GAME_MIN) > 0.5;
  $('gd-table').innerHTML = '<tr><th>Player</th><th>vs. fair</th><th>Minutes</th></tr>' + sorted.map(id => {
    const d = h.minutes[id] - (h.shares[id] || 0);
    return '<tr><td>' + esc(name(id)) + (partTime(id) ? ' <span class="muted">(' + fmtMin(h.avail[id]) + ' avail.)</span>' : '') + '</td>' +
      '<td class="' + signCls(d) + '">' + signed(d) + '</td><td>' + fmtMin(h.minutes[id]) + '</td></tr>';
  }).join('');
  $('view-gamedetail').dataset.key = key;
  show('gamedetail');
}

// ============================================================
// Events
// ============================================================
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

$('roster').addEventListener('click', e => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const p = byId(t.dataset.id);
  if (t.dataset.act === 'present') p.present = !p.present;
  else if (t.dataset.act === 'gk') p.gk = !p.gk;
  else if (t.dataset.act === 'edit') {
    const name = prompt('Player name', p.name);
    if (name && name.trim()) p.name = name.trim().slice(0, 24);
  }
  save(); renderSetup();
});
$('starters').addEventListener('click', e => {
  const t = e.target.closest('[data-starter]');
  if (!t || t.disabled) return;
  const id = t.dataset.starter;
  if (state.starters.includes(id)) {
    state.starters = state.starters.filter(x => x !== id);
    if (state.startGk === id) state.startGk = null;
  } else if (activeStarters().length < ON_FIELD) {
    state.starters.push(id);
  }
  save(); renderSetup();
});
$('start-gk').addEventListener('change', e => { state.startGk = e.target.value || null; save(); renderSetup(); });
$('btn-starters-clear').addEventListener('click', () => { state.starters = []; state.startGk = null; save(); renderSetup(); });
// Fill the starters with the players who have had the least time this season (the planner's
// own kickoff pick), including its choice of keeper so at least one goalie starts.
$('btn-starters-suggest').addEventListener('click', () => {
  const plan = planFrom(Object.assign(kickoffPlanInputs(), { starters: [], h1gk: null }));
  const first = plan.blocks[0];
  if (!first) return;
  state.starters = first.on.slice();
  state.startGk = (byId(first.gk) && byId(first.gk).gk) ? first.gk : null;
  save(); renderSetup();
});
$('subs-minus').addEventListener('click', () => { state.subsPerHalf = Math.max(MIN_SUBS, state.subsPerHalf - 1); save(); renderSetup(); });
$('subs-plus').addEventListener('click', () => { state.subsPerHalf = Math.min(MAX_SUBS, state.subsPerHalf + 1); save(); renderSetup(); });
$('use-carry').addEventListener('change', e => { state.useCarryOver = e.target.checked; save(); renderSetup(); });
$('btn-plan').addEventListener('click', () => {
  if ($('plan-card').hidden) renderPlan(); else $('plan-card').hidden = true;
  $('btn-plan').textContent = $('plan-card').hidden ? 'Show plan' : 'Hide plan';
});
$('btn-start').addEventListener('click', () => {
  primeAudio();
  newGame();
  show('game');
  renderGame();
});
$('btn-season').addEventListener('click', () => { renderSeason(); show('season'); });
$('btn-season-back').addEventListener('click', () => { renderSetup(); show('setup'); });
$('game-list').addEventListener('click', e => {
  const li = e.target.closest('[data-game]');
  if (li) renderGameDetail(li.dataset.game);
});
$('btn-gd-back').addEventListener('click', () => { renderSeason(); show('season'); });
$('btn-gd-delete').addEventListener('click', () => {
  const h = gameByKey($('view-gamedetail').dataset.key);
  if (h && confirm('Delete this game from the season? Carry-over will be recalculated.')) {
    state.history = state.history.filter(x => x !== h);
    recomputeCarryOver(); save(); renderSeason(); show('season');
  }
});
$('btn-season-reset').addEventListener('click', () => {
  if (confirm('Clear all saved games and carry-over?')) { state.carryOver = {}; state.history = []; save(); renderSeason(); }
});

$('btn-clock').addEventListener('click', () => {
  primeAudio();
  const g = state.game;
  if (g.running) pauseClock(); else startClock();
  renderGame();
});
$('btn-end').addEventListener('click', () => { if (confirm('End the game now?')) endGame(); });
$('btn-attendance').addEventListener('click', () => { renderModal(); $('modal').hidden = false; });
$('modal-close').addEventListener('click', () => { $('modal').hidden = true; });
$('modal-list').addEventListener('click', e => {
  const t = e.target.closest('[data-act]');
  if (t) toggleMidGame(t.dataset.id);
});
$('banner-apply').addEventListener('click', () => { applyPending(); renderGame(); });
$('banner-dismiss').addEventListener('click', () => { state.game.pending = null; save(); renderGame(); });
$('clock-preview').addEventListener('click', e => {
  const g = state.game;
  if (e.target.id === 'btn-edit-done') { g.editNext = false; save(); renderGame(); }
  else if (e.target.id === 'btn-edit-reset') { g.nextOverride = null; save(); startEditNext(); }
});
$('btn-edit-mode').addEventListener('click', () => {
  const g = state.game;
  if (g.editNext) { g.editNext = false; save(); renderGame(); } else startEditNext();
});
$('btn-live-plan').addEventListener('click', () => {
  const card = $('live-plan-card');
  card.hidden = !card.hidden;
  card.dataset.key = '';
  $('btn-live-plan').textContent = card.hidden ? 'Show plan' : 'Hide plan';
  renderGame();
});
$('btn-suggest').addEventListener('click', () => { state.game.pending = adHocSuggestion(); save(); renderGame(); });
['field-list', 'bench-list'].forEach(id => $(id).addEventListener('click', e => {
  const gk = e.target.closest('[data-gk]');
  if (gk) { setGk(gk.dataset.gk); return; }
  const li = e.target.closest('[data-id]');
  if (li) onPlayerTap(li.dataset.id);
}));

$('btn-save').addEventListener('click', () => { saveToSeason(); renderSetup(); show('setup'); });
$('btn-discard').addEventListener('click', () => {
  if (confirm('Discard this game without saving?')) { state.game = null; state.starters = []; state.startGk = null; save(); renderSetup(); show('setup'); }
});

// ============================================================
// Boot
// ============================================================
setInterval(() => {
  if (state.game && state.game.phase !== 'done') {
    tick();
    if (!$('view-game').hidden) renderGame();
  }
}, 250);

if (state.game && state.game.phase === 'done') {
  showSummary();
} else if (state.game) {
  show('game'); renderGame();
  if (state.game.running) requestWakeLock();
} else {
  renderSetup(); show('setup');
}

if ('serviceWorker' in navigator) {
  if (location.search.includes('reset')) {
    // ?reset — wipe the offline cache and reload fresh (handy after an update)
    navigator.serviceWorker.getRegistrations()
      .then(rs => Promise.all(rs.map(r => r.unregister())))
      .then(() => caches.keys()).then(ks => Promise.all(ks.map(k => caches.delete(k))))
      .finally(() => { location.replace(location.pathname); });
  } else {
    window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); });
    // When an *updated* service worker takes over (not the first install), reload once so
    // the new version shows immediately instead of on the following visit
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return;
      reloaded = true; location.reload();
    });
  }
}
