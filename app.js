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
      id: 'p' + i, name: DEFAULT_NAMES[i] || 'Player ' + (i + 1), gk: true, present: true,
    })),
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
    if (raw) return Object.assign(defaultState(), JSON.parse(raw));
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
//   gkEligible – Set of ids willing to keep
// Returns { blocks: [{ index, half, start, end, on, gk, bench }], projected, h1gk, h2gk }
//
// Keepers play a whole half. The second-half keeper is chosen up front and carries a
// virtual credit during first-half planning so the greedy benches them enough to make
// room for their full second half. One extra handoff is allowed if a keeper would
// otherwise end up a full block ahead of the player they displace.
// ============================================================
function planFrom({ ids, S, minutes, fromBlock = 0, onField, gk = null, h1gk = null, h2gk = null, starters = [], gkEligible }) {
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

  for (let b = fromBlock; b < B; b++) {
    const half = b <= S ? 1 : 2;
    const firstOfHalf = b === 0 || b === S + 1;
    const credit = id => (half === 1 && id === secondGk && secondGk !== firstGk ? h2Credit : 0);
    const key = id => Math.round((mins[id] + credit(id)) * 2) / 2; // tie within 30s
    const sorted = [...ids].sort((a, c) =>
      key(a) - key(c) || (on.has(c) - on.has(a)) || order.get(a) - order.get(c));
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
    lineup.forEach(id => { mins[id] += L; });
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
const nameOf = id => (byId(id) || { name: '?' }).name;
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
  save();
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

function currentMinutes() {
  const g = state.game;
  const ids = Object.keys(g.players);
  const seed = seedMinutes(ids);
  const m = {};
  ids.forEach(id => { m[id] = seed[id] + playedMin(id); });
  return m;
}

function suggestForBlock(b, title) {
  const g = state.game;
  const ids = presentIds().filter(id => g.players[id]);
  const plan = planFrom({
    ids, S: g.subsPerHalf, minutes: currentMinutes(), fromBlock: b,
    onField: ids.filter(id => g.players[id].onField), gk: g.gk, h1gk: g.h1gk, h2gk: g.h2gk,
    gkEligible: gkEligibleSet(),
  });
  const next = plan.blocks[0];
  if (!next) return;
  g.h2gk = plan.h2gk;
  const d = diffLineups(ids.filter(id => g.players[id].onField), g.gk, next);
  if (!d.off.length && !d.on.length && !d.gk) {
    g.pending = { title, off: [], on: [], gk: null, note: 'No change needed — lineup is already balanced.' };
  } else {
    g.pending = { title, off: d.off, on: d.on, gk: d.gk };
  }
}

function applyPending() {
  const g = state.game, p = g.pending;
  if (!p) return;
  p.off.forEach(id => setOnField(id, false));
  p.on.forEach(id => setOnField(id, true));
  if (p.gk) g.gk = p.gk;
  if (g.phase === 'h1' && g.gk) g.h1gk = g.gk;
  g.pending = null; g.selected = null;
  save();
}

function adHocSuggestion() {
  const g = state.game;
  const ids = presentIds().filter(id => g.players[id]);
  const bench = ids.filter(id => !g.players[id].onField).sort((a, c) => playedMin(a) - playedMin(c));
  const field = ids.filter(id => g.players[id].onField && id !== g.gk).sort((a, c) => playedMin(c) - playedMin(a));
  if (!bench.length) return { title: 'No subs available', off: [], on: [], gk: null, note: 'Everyone present is on the field.' };
  if (!field.length) return null;
  const inId = bench[0], outId = field[0];
  if (playedMin(inId) >= playedMin(outId) - 0.25) {
    return { title: 'Already balanced', off: [], on: [], gk: null, note: 'Bench players have as many minutes as the field. Wait for the next scheduled sub.' };
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
  const minutes = finalMinutes();
  const shares = fairShares();
  Object.keys(minutes).forEach(id => {
    state.carryOver[id] = (state.carryOver[id] || 0) + (minutes[id] - shares[id]);
  });
  state.history.push({ date: new Date().toISOString().slice(0, 10), minutes, shares });
  state.game = null;
  save();
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
const views = ['setup', 'game', 'summary', 'season'];
function show(view) {
  views.forEach(v => { $('view-' + v).hidden = v !== view; });
  window.scrollTo(0, 0);
}

// ---------- Setup ----------
function renderSetup() {
  const ids = presentIds();
  const S = state.subsPerHalf;
  const n = ids.length, subs = Math.max(0, n - ON_FIELD);
  $('attendance-summary').textContent = n + ' present · ' + subs + ' sub' + (subs === 1 ? '' : 's') +
    (n >= ON_FIELD ? ' · ~' + fmtMin(fairTarget(n)) + ' each' : '');

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
  $('subs-schedule').textContent = 'Each half: subs at ' + times.map(t => fmtClock(t) + (t === water ? ' (water)' : '')).join(', ') +
    ' · blocks of ' + fmtClock(blockLen(S));
  renderStarters();

  if (n >= ON_FIELD) {
    const plan = planFrom(kickoffPlanInputs());
    const seed = seedMinutes(ids);
    const game = ids.map(id => plan.projected[id] - seed[id]);
    const lo = Math.min(...game), hi = Math.max(...game);
    $('subs-fairness').textContent = subs === 0
      ? 'No subs — everyone plays the full game; keeper rotates at halftime.'
      : 'Projected this game: ' + fmtMin(lo) + '–' + fmtMin(hi) + ' each (gap ' + fmtClock(hi - lo) + ')' +
        (hi - lo > blockLen(S) + 0.01 ? ' — carry-over is balancing earlier games' : '');
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
  $('starters-summary').textContent = chosen.length + '/' + ON_FIELD + ' picked' +
    (chosen.length < ON_FIELD ? ' · rest chosen automatically' : '');
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

function renderPlan() {
  const ids = presentIds();
  const S = state.subsPerHalf;
  if (ids.length < ON_FIELD) { $('plan-card').hidden = true; return; }
  const seed = seedMinutes(ids);
  const plan = planFrom(kickoffPlanInputs());
  const L = blockLen(S);
  const water = waterBreakInHalf(S);

  let html = '<tr><th></th>';
  plan.blocks.forEach(b => {
    const inHalf = b.start - (b.half === 2 ? HALF_MIN : 0);
    html += '<th class="' + (b.index === S + 1 ? 'half-start' : '') + '">' +
      (b.index === 0 ? 'H1 ' : b.index === S + 1 ? 'H2 ' : '') + fmtClock(inHalf) +
      (Math.abs(inHalf - water) < 1e-6 ? ' 💧' : '') + '</th>';
  });
  html += '<th>Total</th></tr>';
  ids.forEach(id => {
    html += '<tr><td class="player">' + esc(nameOf(id)) + '</td>';
    plan.blocks.forEach(b => {
      const cls = (b.index === S + 1 ? 'half-start ' : '') + (b.gk === id ? 'gk' : b.on.includes(id) ? 'on' : '');
      html += '<td class="' + cls + '">' + (b.gk === id ? 'GK' : b.on.includes(id) ? '●' : '') + '</td>';
    });
    html += '<td class="total">' + fmtMin(plan.projected[id] - seed[id]) + '</td></tr>';
  });
  $('plan-grid').innerHTML = html;

  const ol = $('plan-swaps');
  ol.innerHTML = '';
  for (let i = 1; i < plan.blocks.length; i++) {
    const prev = plan.blocks[i - 1], b = plan.blocks[i];
    const d = diffLineups(prev.on, prev.gk, b);
    const inHalf = b.start - (b.half === 2 ? HALF_MIN : 0);
    const when = b.index === S + 1 ? 'Halftime' : 'H' + b.half + ' ' + fmtClock(inHalf);
    const parts = [];
    if (d.off.length) parts.push('<span class="off">OFF</span> ' + d.off.map(nameOf).map(esc).join(', '));
    if (d.on.length) parts.push('<b>ON</b> ' + d.on.map(nameOf).map(esc).join(', '));
    if (d.gk) parts.push('GK → ' + esc(nameOf(d.gk)));
    const li = document.createElement('li');
    li.innerHTML = '<b>' + when + '</b>' + (Math.abs(inHalf - water) < 1e-6 ? ' 💧' : '') + ' — ' + (parts.join(' · ') || 'no change');
    ol.appendChild(li);
  }
  const gkNames = [...new Set(plan.blocks.map(b => b.gk))].map(nameOf).map(esc).join(' → ');
  $('plan-summary').textContent = blockCount(S) + ' blocks of ' + fmtClock(L);
  const gkLi = document.createElement('li');
  gkLi.innerHTML = '<b>Keepers:</b> ' + gkNames;
  ol.prepend(gkLi);
  $('plan-card').hidden = false;
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

  // Banner
  const banner = $('banner');
  if (g.pending) {
    const p = g.pending;
    $('banner-title').textContent = p.title;
    const parts = [];
    if (p.off.length) parts.push('<span class="off">OFF:</span> ' + p.off.map(nameOf).map(esc).join(', '));
    if (p.on.length) parts.push('<span class="on">ON:</span> ' + p.on.map(nameOf).map(esc).join(', '));
    if (p.gk) parts.push('<b>GK:</b> ' + esc(nameOf(p.gk)));
    $('banner-body').innerHTML = p.note ? esc(p.note) : parts.join('<br>');
    $('banner-apply').hidden = !!p.note;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }

  // Player columns
  const ids = presentIds().filter(id => g.players[id]);
  const mins = {};
  ids.forEach(id => { mins[id] = playedMin(id); });
  const field = ids.filter(id => g.players[id].onField).sort((a, c) => mins[c] - mins[a]);
  const bench = ids.filter(id => !g.players[id].onField).sort((a, c) => mins[a] - mins[c]);
  const lo = Math.min(...ids.map(id => mins[id])), hi = Math.max(...ids.map(id => mins[id]));
  const cls = id => (hi - lo < 1 ? '' : mins[id] <= lo + 0.5 ? 'low' : mins[id] >= hi - 0.5 ? 'high' : '');

  $('field-count').textContent = field.length + '/' + ON_FIELD;
  $('bench-count').textContent = String(bench.length);
  $('field-list').innerHTML = field.map(id =>
    '<li data-id="' + id + '" class="' + (g.gk === id ? 'gk ' : '') + (g.selected === id ? 'selected' : '') + '">' +
    '<span class="pname">' + esc(nameOf(id)) + '</span>' +
    '<span class="pmin ' + cls(id) + '">' + fmtMin(mins[id]) + '</span>' +
    '<button class="gkbtn" data-gk="' + id + '">GK</button></li>').join('');
  $('bench-list').innerHTML = bench.map(id =>
    '<li data-id="' + id + '" class="' + (g.selected === id ? 'selected' : '') + '">' +
    '<span class="pname">' + esc(nameOf(id)) + '</span>' +
    '<span class="pmin ' + cls(id) + '">' + fmtMin(mins[id]) + '</span></li>').join('') ||
    '<li class="muted">No subs</li>';
  $('btn-suggest').disabled = bench.length === 0;
}

function onPlayerTap(id) {
  const g = state.game;
  if (!g || g.phase === 'done' || !g.players[id]) return;
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
    } else {
      g.selected = id;
    }
  }
  save();
  renderGame();
}

function setGk(id) {
  const g = state.game;
  if (!g || !g.players[id] || !g.players[id].onField) return;
  g.gk = id;
  if (g.phase === 'h1') g.h1gk = id;
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
  $('summary-stats').textContent = ids.length + ' players · fair share ' +
    (full.length ? fmtMin(shares[full[0]]) : '—') +
    (partTime.length ? ' (' + partTime.length + ' part-time, pro-rated)' : '') +
    ' · spread ' + fmtClock(spread) + ' · total ' + Math.round(total) + ' player-min';
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
function renderSeason() {
  const rows = state.roster.map(p => ({ p, d: state.carryOver[p.id] || 0 })).sort((a, c) => a.d - c.d);
  $('season-table').innerHTML = '<tr><th>Player</th><th>vs. fair share</th></tr>' + rows.map(({ p, d }) =>
    '<tr><td>' + esc(p.name) + '</td><td class="' + (d < -0.5 ? 'neg' : d > 0.5 ? 'pos' : '') + '">' +
    (d >= 0 ? '+' : '−') + fmtClock(Math.abs(d)) + '</td></tr>').join('');
  $('season-games').textContent = state.history.length + ' game' + (state.history.length === 1 ? '' : 's') + ' saved';
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
$('btn-suggest').addEventListener('click', () => { state.game.pending = adHocSuggestion(); save(); renderGame(); });
['field-list', 'bench-list'].forEach(id => $(id).addEventListener('click', e => {
  const gk = e.target.closest('[data-gk]');
  if (gk) { setGk(gk.dataset.gk); return; }
  const li = e.target.closest('[data-id]');
  if (li) onPlayerTap(li.dataset.id);
}));

$('btn-save').addEventListener('click', () => { saveToSeason(); renderSetup(); show('setup'); });
$('btn-discard').addEventListener('click', () => {
  if (confirm('Discard this game without saving?')) { state.game = null; save(); renderSetup(); show('setup'); }
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
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); });
}
