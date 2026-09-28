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

// 1-2-3-1: the seven slots on the field, and the position groups players pick from.
// Wide slots double as back and wing (2/11 left, 2/7 right), so both map to one group.
// x/y are percentages of the pitch box, attacking upwards
const SLOTS = [
  { id: 'GK', label: 'GK', pos: 'GK', x: 50, y: 88 },
  { id: 'LCB', label: 'LCB', pos: 'CB', x: 27, y: 66 },
  { id: 'RCB', label: 'RCB', pos: 'CB', x: 73, y: 66 },
  { id: 'LW', label: 'LB/LW', pos: 'W', x: 16, y: 40 },
  { id: 'CM', label: 'CM', pos: 'CM', x: 50, y: 42 },
  { id: 'RW', label: 'RB/RW', pos: 'W', x: 84, y: 40 },
  { id: 'ST', label: 'ST', pos: 'ST', x: 50, y: 13 },
];
const POS = [
  { id: 'GK', label: 'GK', num: '1', name: 'Goalkeeper' },
  { id: 'CB', label: 'CB', num: '4/5', name: 'Center back' },
  { id: 'W', label: 'W', num: '7/11', name: 'Wing (back or winger)' },
  { id: 'CM', label: 'CM', num: '8', name: 'Center mid' },
  { id: 'ST', label: 'ST', num: '9', name: 'Striker' },
];
const slotById = id => SLOTS.find(s => s.id === id);
const posLabel = id => (POS.find(p => p.id === id) || { label: id }).label;

// ============================================================
// State
// ============================================================
const DEFAULT_NAMES = ['Alvi', 'Kamryn', 'Ezra', 'Mason', 'Milan', 'Anthony', 'Ronaldo', 'Cameron', 'Daniel', 'Donavan', 'Mateo'];
// Preferred positions from the coach's team sheet, best first
const DEFAULT_PREFS = {
  Alvi: ['ST', 'W'], Kamryn: ['ST', 'CM'], Ezra: ['GK', 'CB', 'ST'], Mason: ['CM', 'CB'],
  Milan: ['CM', 'W'], Anthony: ['GK'], Ronaldo: ['CB', 'CM'], Cameron: ['GK', 'W', 'ST'],
  Daniel: ['CM', 'W'], Donavan: ['CM', 'W'], Mateo: ['W', 'ST'],
};

function defaultState() {
  return {
    roster: Array.from({ length: ROSTER_SIZE }, (_, i) => {
      const name = DEFAULT_NAMES[i] || 'Player ' + (i + 1);
      const prefs = DEFAULT_PREFS[name] || [];
      return { id: 'p' + i, name, prefs, gk: prefs.includes('GK'), present: true };
    }),
    v: 4,
    subsPerHalf: 3,
    plans: [],          // saved game plans
    activePlanId: null, // the plan to use for the next game
    draft: null,        // the plan currently being edited
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
      // v3: preferred positions. Seed from the team sheet where the name matches.
      if (st.v < 3) {
        st.roster.forEach(p => {
          if (!p.prefs) p.prefs = (DEFAULT_PREFS[p.name] || []).slice();
          if (p.gk && !p.prefs.includes('GK')) p.prefs.unshift('GK');
        });
        st.v = 3;
      }
      if (st.v < 4) { st.plans = st.plans || []; st.activePlanId = null; st.draft = null; st.v = 4; }
      st.roster.forEach(p => { p.prefs = p.prefs || []; p.gk = p.prefs.includes('GK'); });
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
// A schedule is the list of times each block starts, always beginning at 0:00 and always
// including halftime. Blocks need not be equal length — the coach can set their own times.
const evenTimes = S => {
  const L = HALF_MIN / (S + 1), out = [];
  for (let i = 1; i < 2 * (S + 1); i++) out.push(Math.round(i * L * 60) / 60);
  return out.filter(t => Math.abs(t - HALF_MIN) > 1e-6);
};
function schedule(times) {
  const at = new Map();
  const put = t => {
    const k = Math.round(t * 60) / 60;
    if (k >= 0 && k < GAME_MIN - 0.25) at.set(k, k);     // no block shorter than 15s at the end
  };
  put(0); put(HALF_MIN);
  (times || []).forEach(put);
  return [...at.values()].sort((a, c) => a - c);
};
const blockCount = sch => sch.length;
const blockStart = (sch, b) => sch[b];
const blockEnd = (sch, b) => (b + 1 < sch.length ? sch[b + 1] : GAME_MIN);
const blockLen = (sch, b) => blockEnd(sch, b) - blockStart(sch, b);
function blockAt(sch, min) {
  let i = 0;
  while (i + 1 < sch.length && sch[i + 1] <= min + 1e-9) i++;
  return i;
}
const halfIndex = sch => sch.findIndex(t => Math.abs(t - HALF_MIN) < 1e-6);
// The custom sub times of a plan (everything but 0:00 and halftime)
const timesOf = pl => (pl && pl.times) ? pl.times.slice() : evenTimes((pl && pl.subsPerHalf) || 3);
const schedOf = pl => schedule(timesOf(pl));
// water break snapped to the nearest scheduled sub time in the half
// Water breaks are at fixed times — halfway through each half — and do not move with
// the sub schedule. A block boundary that happens to land on one is marked.
const WATER_TIMES = [HALF_MIN / 2, HALF_MIN + HALF_MIN / 2];
const isWaterBlock = start => WATER_TIMES.some(w => Math.abs(start - w) < 1e-6);

function fairTarget(presentCount) {
  return presentCount > 0 ? (GAME_MIN * ON_FIELD) / presentCount : 0;
}

function fmtClock(min) {
  const total = Math.max(0, Math.round(min * 60));
  const m = Math.floor(total / 60), s = total % 60;
  return m + ':' + String(s).padStart(2, '0');
}
function fmtMin(min) { return fmtClock(min); }
// Game time runs straight through: the second half starts at 25:00, not back at 0:00
const atClock = min => fmtClock(min);

// ============================================================
// Slot assignment
// Gives each player on the field one of the seven slots. A position the player is marked
// for always beats one they are not; among those, time already spent in each position
// spreads them around, and keeping last block's slot breaks the remaining ties.
// Exact via DP over the 2^7 sets of filled slots.
// ============================================================
const OFF_PREF = 60;       // a position the player is not marked for
const NO_PREF = 30;        // player has no positions marked, so every slot is equal
const POS_TIME_W = 0.25;   // per minute already played in that position, to spread them around
const STAY_BONUS = 2;      // keeping the same slot as last block

function assignSlots({ on, gk, prefsOf, posMins, prev, fixed }) {
  const n = on.length, nS = SLOTS.length;
  if (!n) return {};
  const pref = id => (prefsOf ? prefsOf(id) : null) || [];
  const pinned = fixed || {};
  const pinnedOf = {};
  Object.keys(pinned).forEach(sid => { pinnedOf[pinned[sid]] = sid; });
  const cost = on.map(id => SLOTS.map(sl => {
    if (pinnedOf[id] || pinned[sl.id]) {
      if (pinnedOf[id] === sl.id) return -2000;
      if (pinnedOf[id] || pinned[sl.id]) return 2000;
    }
    if (gk) {
      if (sl.id === 'GK') return id === gk ? -1000 : 1000;
      if (id === gk) return 1000;
    }
    const prefs = pref(id);
    let c = prefs.includes(sl.pos) ? 0 : (prefs.length ? OFF_PREF : NO_PREF);
    c += POS_TIME_W * (((posMins || {})[id] || {})[sl.pos] || 0);
    if (prev && prev[sl.id] === id) c -= STAY_BONUS;
    return c;
  }));
  const FULL = 1 << nS;
  const bits = m => { let k = 0; while (m) { k += m & 1; m >>= 1; } return k; };
  const dp = new Float64Array(FULL).fill(Infinity);
  const from = new Int8Array(FULL).fill(-1);
  dp[0] = 0;
  for (let mask = 0; mask < FULL; mask++) {
    if (dp[mask] === Infinity) continue;
    const k = bits(mask);
    if (k >= n) continue;
    for (let i = 0; i < nS; i++) {
      if (mask & (1 << i)) continue;
      const next = mask | (1 << i), c = dp[mask] + cost[k][i];
      if (c < dp[next]) { dp[next] = c; from[next] = i; }
    }
  }
  let best = -1, bestCost = Infinity;
  for (let mask = 0; mask < FULL; mask++) {
    if (bits(mask) === n && dp[mask] < bestCost) { bestCost = dp[mask]; best = mask; }
  }
  const out = {};
  let mask = best;
  for (let k = n - 1; k >= 0 && mask > 0; k--) {
    const i = from[mask];
    if (i < 0) break;
    out[SLOTS[i].id] = on[k];
    mask &= ~(1 << i);
  }
  return out;
}
// Where a player is, given a slot map
const slotOfPlayer = (slots, id) => Object.keys(slots || {}).find(k => slots[k] === id) || null;

// ============================================================
// Rotation planner
//   ids        – present player ids, in roster order
//   sch        – block start times (schedule)
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
function planFrom({ ids, sch, minutes, fromBlock = 0, onField, gk = null, h1gk = null, h2gk = null, starters = [], played = [], gkEligible, prefsOf, posMins, prevSlots }) {
  const B = blockCount(sch), HI = halfIndex(sch);
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
  let firstGk = ids.includes(h1gk) ? h1gk : (fromBlock < HI ? curGk : null);
  let secondGk = ids.includes(h2gk) ? h2gk : (fromBlock >= HI ? curGk : null);
  const keepers = new Set([firstGk, secondGk, curGk].filter(Boolean));
  const MAX_KEEPERS = 3;
  const blocks = [];

  const lowestEligible = (exclude, preferBench, from = ids) => [...from]
    .filter(id => eligible.has(id) && !exclude.includes(id))
    .sort((a, c) => mins[a] - mins[c] || (preferBench ? on.has(a) - on.has(c) : 0) || order.get(a) - order.get(c))[0] || null;

  // Pick first-half keeper (block 0 only) and second-half keeper before planning.
  if (fromBlock === 0 && !firstGk) firstGk = (kickoff.length && lowestEligible([], false, kickoff)) || lowestEligible([], false);
  if (fromBlock < HI && !secondGk) secondGk = lowestEligible([firstGk], true) || firstGk;
  keepers.add(firstGk); keepers.add(secondGk);

  // Virtual credit for the second-half keeper during first-half planning: the minutes
  // everyone else will get in the first half minus what the keeper should get.
  const target = (GAME_MIN * ON_FIELD) / n;
  const othersH1 = n > 2 ? (HALF_MIN * ON_FIELD - HALF_MIN - (target - HALF_MIN)) / (n - 2) : 0;
  const h2Credit = Math.max(0, othersH1 - (target - HALF_MIN));
  const seen = new Set([...played, ...on].filter(id => ids.includes(id)));
  const pm = {};
  ids.forEach(id => { pm[id] = Object.assign({}, (posMins || {})[id]); });
  let lastSlots = prevSlots || null;

  for (let b = fromBlock; b < B; b++) {
    const L = blockLen(sch, b);
    const half = b < HI ? 1 : 2;
    const firstOfHalf = b === 0 || b === HI;
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
    } else if (b === HI) {
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
    const slots = assignSlots({ on: lineup, gk: nextGk, prefsOf, posMins: pm, prev: lastSlots });
    blocks.push({
      index: b, half, start: blockStart(sch, b), end: blockEnd(sch, b),
      on: lineup, gk: nextGk, bench: ids.filter(id => !lineup.includes(id)), slots,
    });
    Object.keys(slots).forEach(sid => {
      const pid = slots[sid], grp = slotById(sid).pos;
      pm[pid][grp] = (pm[pid][grp] || 0) + L;
    });
    lastSlots = slots;
    lineup.forEach(id => { mins[id] += L; seen.add(id); });
    on = new Set(lineup);
    curGk = nextGk;
  }
  return { blocks, projected: mins, projectedPos: pm, h1gk: firstGk, h2gk: secondGk };
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
const prefsOf = id => ((byId(id) || {}).prefs || []);
// Carry-over is "minutes above fair share" — players who are ahead start with a head start
// in the planner's tally so they get lower priority this game.
const seedMinutes = ids => {
  const m = {};
  ids.forEach(id => { m[id] = state.useCarryOver ? (state.carryOver[id] || 0) : 0; });
  return m;
};
// Starters/keeper choices only count for players who are present
// Planner inputs for a fresh game from the setup screen
function kickoffPlanInputs() {
  const ids = presentIds();
  return {
    ids, sch: schedule(evenTimes(state.subsPerHalf)), minutes: seedMinutes(ids),
    starters: [], h1gk: null, gkEligible: gkEligibleSet(),
    prefsOf, posMins: seasonPosMins(ids),
  };
}
// Minutes each player has spent in each position across saved games, so the plan can
// spread positions over the season the way it spreads minutes.
function seasonPosMins(ids) {
  const out = {};
  ids.forEach(id => { out[id] = {}; });
  if (!state.useCarryOver) return out;
  state.history.forEach(h => {
    Object.keys(h.posMinutes || {}).forEach(id => {
      if (!out[id]) return;
      Object.keys(h.posMinutes[id]).forEach(g => { out[id][g] = (out[id][g] || 0) + h.posMinutes[id][g]; });
    });
  });
  return out;
}

// ============================================================
// Game engine
// ============================================================
function newGame() {
  const ids = presentIds();
  const players = {};
  ids.forEach(id => { players[id] = { playedMs: 0, onField: false, onSinceMs: 0, availMs: 0, inSinceMs: 0, posMs: {}, slot: null, slotSince: null }; });
  const g = {
    phase: 'h1',            // h1 | halftime | h2 | done
    running: false,
    elapsedMs: 0,
    runningSince: null,
    subsPerHalf: (activePlan() || state).subsPerHalf,
    sch: schedOf(activePlan()),
    players, gk: null, h1gk: null, h2gk: null,
    lastAlertBlock: 0,
    pending: null,
    selected: null,
    breakLabel: null,       // 'Water break' while stopped for one
    playOn: false,          // first half running past 25:00
    ftAlerted: false,
    startedAt: Date.now(),
  };
  state.game = g;
  // Follow a saved plan when one is chosen; otherwise generate a rotation
  const saved = activePlan();
  g.followPlan = !!saved;
  const plan = planFrom(kickoffPlanInputs());
  if (saved) g.plan = saved.blocks.map(b => ({ index: b.index, slots: Object.assign({}, b.slots) }));
  const firstPlanned = saved ? plannedBlockFor(saved, 0, ids, seedMinutes(ids)) : null;
  const first = firstPlanned || plan.blocks[0];
  const firstOn = first.on || Object.values(first.slots);
  firstOn.forEach(id => { players[id].onField = true; players[id].onSinceMs = 0; });
  g.gk = first.gk || (first.slots && first.slots.GK) || null;
  g.h1gk = saved ? g.gk : plan.h1gk;
  g.h2gk = saved ? null : plan.h2gk;
  if (!saved) g.plan = plan.blocks.map(b => ({ index: b.index, on: b.on, gk: b.gk, slots: b.slots }));
  g.log = [];
  g.slots = {};
  resyncSlots(first.slots);
  logLineup();
  save();
}

// Stop the clock and label why, so the header and the game log both say "Water break"
function takeBreak(label) {
  const g = state.game;
  if (!g || g.phase === 'done') return;
  pauseClock();
  g.breakLabel = label;
  g.log.push({ t: Math.round(elapsedMin() * 100) / 100, note: label });
  save();
}
// Keep playing the first half past 25:00 (the ref hasn't blown for halftime)
function playOn() {
  const g = state.game;
  if (!g || g.phase !== 'halftime') return;
  g.phase = 'h1'; g.playOn = true; g.lastAlertBlock = g.subsPerHalf;
  g.pending = null;
  startClock();
  save();
}

// Append the current lineup to the game log (skipped if unchanged from the last entry)
function logLineup(offPlan) {
  const g = state.game;
  if (!g) return;
  const on = Object.keys(g.players).filter(id => g.players[id].onField).sort();
  const last = g.log[g.log.length - 1];
  const slots = Object.assign({}, g.slots);
  if (last && last.gk === g.gk && last.on.join() === on.join()) { if (last) last.slots = slots; return; }
  g.log.push({ t: Math.round(elapsedMin() * 100) / 100, on, gk: g.gk, slots, offPlan: !!offPlan });
}

function elapsedMs() {
  const g = state.game;
  if (!g) return 0;
  // Not capped at full time: the ref decides when the game ends, not the app
  return g.elapsedMs + (g.running ? Date.now() - g.runningSince : 0);
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

// ---- position time ----
function posMsOf(id, group) {
  const p = state.game.players[id];
  if (!p) return 0;
  let ms = (p.posMs || {})[group] || 0;
  if (p.slot && p.slotSince != null && slotById(p.slot) && slotById(p.slot).pos === group) {
    ms += elapsedMs() - p.slotSince;
  }
  return ms;
}
function posMinsNow() {
  const out = {};
  Object.keys(state.game.players).forEach(id => {
    out[id] = {};
    POS.forEach(P => { const m = posMsOf(id, P.id) / 60000; if (m > 0) out[id][P.id] = m; });
  });
  return out;
}
// Bank the time each player has spent in their current slot, then clear the slots
function commitPos() {
  const g = state.game, now = elapsedMs();
  Object.keys(g.players).forEach(id => {
    const p = g.players[id];
    p.posMs = p.posMs || {};
    if (p.slot && p.slotSince != null) {
      const grp = slotById(p.slot).pos;
      p.posMs[grp] = (p.posMs[grp] || 0) + (now - p.slotSince);
    }
    p.slot = null; p.slotSince = null;
  });
}
// Re-deal the seven slots after any lineup change, keeping players where they are when it
// makes no difference to preference or balance.
// `desired` pins players to slots — the arrangement the board just promised the coach,
// including any pairing they set by hand. Anyone not pinned is dealt as usual.
function resyncSlots(desired) {
  const g = state.game;
  if (!g) return;
  const prev = {};
  Object.keys(g.players).forEach(id => { if (g.players[id].slot) prev[g.players[id].slot] = id; });
  commitPos();
  const on = Object.keys(g.players).filter(id => g.players[id].onField);
  const fixed = {};
  Object.keys(desired || {}).forEach(sid => { if (on.includes(desired[sid])) fixed[sid] = desired[sid]; });
  const slots = assignSlots({ on, gk: g.gk, prefsOf, posMins: posMinsNow(), prev, fixed });
  const now = elapsedMs();
  g.slots = slots;
  Object.keys(slots).forEach(sid => {
    const p = g.players[slots[sid]];
    if (p) { p.slot = sid; p.slotSince = now; }
  });
}
const slotOf = id => (state.game.players[id] || {}).slot || null;
const slotLabel = id => { const sl = slotById(slotOf(id)); return sl ? sl.label : ''; };

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
  if (g.phase === 'halftime') { g.phase = 'h2'; g.playOn = false; }
  g.breakLabel = null;
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

  if (g.phase === 'h1' && !g.playOn && min >= HALF_MIN - 1e-9) {
    pauseClock(); g.elapsedMs = HALF_MIN * 60000; g.phase = 'halftime';
    g.lastAlertBlock = halfIndex(gameSched(g));
    alertUser();
    suggestForBlock(halfIndex(gameSched(g)), 'Halftime');
    save();
  } else if (g.phase === 'h2' && !g.ftAlerted && min >= GAME_MIN - 1e-9) {
    // Full time by the clock, but the game is over when the coach says so
    g.ftAlerted = true;
    alertUser();
    save();
  }

  const b = currentBlock(g);
  if (g.running && b > g.lastAlertBlock) {
    g.lastAlertBlock = b;
    alertUser();
    suggestForBlock(b, 'Sub time');
    save();
  }
}

// The block we are in. Stoppage time stays in the last block of its half rather than
// spilling into the next one.
const gameSched = g => (g && g.sch && g.sch.length ? g.sch : schedule(evenTimes((g && g.subsPerHalf) || 3)));
function currentBlock(g) {
  const sch = gameSched(g), HI = halfIndex(sch);
  const b = blockAt(sch, elapsedMin());
  if (g.phase === 'h1') return Math.min(b, HI - 1);
  if (g.phase === 'halftime') return HI;
  return Math.min(b, blockCount(sch) - 1);
}

// Where we are among the columns of "Plan from here". An off-plan sub inside a block
// adds a column, so both the position and the total grow.
function blockCounter(g) {
  const sch = gameSched(g);
  const splits = (g.log || []).filter(e =>
    e.slots && e.offPlan && e.t > blockStart(sch, blockAt(sch, e.t)) + 1e-6);
  const b = currentBlock(g);
  const before = splits.filter(e => e.t <= elapsedMin() + 1e-6).length;
  return { at: b + 1 + before, total: blockCount(sch) + splits.length };
}

const playedIds = ids => ids.filter(id => playedMs(id) > 0);
// Position minutes so far: this game plus the season, so the plan keeps spreading positions
function livePosMins(ids) {
  const season = seasonPosMins(ids), now = posMinsNow(), out = {};
  ids.forEach(id => {
    out[id] = Object.assign({}, season[id]);
    Object.keys(now[id] || {}).forEach(g => { out[id][g] = (out[id][g] || 0) + now[id][g]; });
  });
  return out;
}

function currentMinutes() {
  const g = state.game;
  const ids = Object.keys(g.players);
  const seed = seedMinutes(ids);
  const m = {};
  ids.forEach(id => { m[id] = seed[id] + playedMin(id); });
  return m;
}

// Coach override for the upcoming sub: the desired field state, { block, slots }.
// Only valid for that block; players who have since left are dropped.
function validOverride(target, ids) {
  const ov = state.game.nextOverride;
  if (!ov || ov.block !== target) return null;
  const slots = {};
  SLOTS.forEach(sl => { const pid = ov.slots[sl.id]; if (pid && ids.includes(pid)) slots[sl.id] = pid; });
  return { slots };
}
// What a desired field state means as a substitution
function diffForSlots(slots, onField, gk) {
  const on2 = Object.values(slots);
  return {
    off: onField.filter(id => !on2.includes(id)),
    on: on2.filter(id => !onField.includes(id)),
    gk: slots.GK && slots.GK !== gk ? slots.GK : null,
  };
}

// The loaded game plan's lineup for a block, with anyone unavailable replaced. Returns
// null when no plan is loaded, so the planner takes over.
function plannedBlock(target, ids, onField, minutes) {
  const g = state.game;
  if (!g.followPlan) return null;
  return plannedBlockFor({ blocks: g.plan || [] }, target, ids, minutes, g.slots);
}
function plannedBlockFor(pl, target, ids, minutes, prevSlots) {
  const src = (pl.blocks || []).find(b => b.index === target);
  if (!src || !src.slots) return null;
  const keep = {}, taken = [];
  SLOTS.forEach(sl => {
    const pid = src.slots[sl.id];
    if (pid && ids.includes(pid) && !taken.includes(pid)) { keep[sl.id] = pid; taken.push(pid); }
  });
  const want = Math.min(ON_FIELD, ids.length);
  if (taken.length < want) {
    // Fill the gaps the same way the planner would: best position fit, fewest minutes
    const spare = ids.filter(id => !taken.includes(id)).sort((a, c) => (minutes[a] || 0) - (minutes[c] || 0));
    const need = SLOTS.filter(sl => !keep[sl.id]).slice(0, want - taken.length).map(sl => sl.id);
    const fill = assignSlots({
      on: taken.concat(spare.slice(0, need.length)), gk: keep.GK || null,
      prefsOf, posMins: seasonPosMins(ids), prev: prevSlots || {}, fixed: keep,
    });
    Object.keys(fill).forEach(sid => { keep[sid] = fill[sid]; });
  }
  return { slots: keep, gk: keep.GK || null, on: Object.values(keep), fromPlan: true };
}

// Keeper for a manually built lineup: planned half keeper if on, else current keeper if
// still on, else the lowest-minute eligible player in the lineup.
function pickGk(target, lineup, gk, minutes) {
  const g = state.game;
  if (target === halfIndex(gameSched(g)) && lineup.includes(g.h2gk)) return g.h2gk;
  if (gk && lineup.includes(gk)) return gk;
  let elig = lineup.filter(id => gkEligibleSet().has(id));
  if (!elig.length) elig = lineup;
  return elig.sort((a, c) => minutes[a] - minutes[c])[0] || null;
}

// The sub to make at the start of `target`, given the lineup and credited minutes at that
// moment. Honours a coach override; otherwise asks the planner.
function subForBlock(target, ids, onField, gk, minutes) {
  const g = state.game, sch = gameSched(g);
  const manual = validOverride(target, ids) || plannedBlock(target, ids, onField, minutes);
  if (manual) {
    const slots = manual.slots;
    const on2 = Object.values(slots);
    const gk2 = slots.GK || pickGk(target, on2, gk, minutes);
    const block = { index: target, half: target < halfIndex(sch) ? 1 : 2, start: blockStart(sch, target), end: blockEnd(sch, target), on: on2, gk: gk2, bench: ids.filter(id => !on2.includes(id)), slots };
    return { block, diff: diffForSlots(slots, onField, gk), manual: true, fromPlan: !!manual.fromPlan, plan: null };
  }
  const plan = planFrom({
    ids, sch, minutes, fromBlock: target, onField, gk, h1gk: g.h1gk, h2gk: g.h2gk, played: playedIds(ids),
    gkEligible: gkEligibleSet(), prefsOf, posMins: livePosMins(ids), prevSlots: g.slots,
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
    g.pending = { title, off: [], on: [], gk: null, note: 'No change needed. The lineup is already balanced.', block: b, slots: sub.block.slots };
  } else {
    g.pending = { title, off: d.off, on: d.on, gk: d.gk, manual: sub.manual, fromPlan: sub.fromPlan, block: b, slots: sub.block.slots };
  }
  if (g.nextOverride && g.nextOverride.block <= b) g.nextOverride = null;
  g.editNext = false; g.editSel = null;
}

function applyPending() {
  const g = state.game, p = g.pending;
  if (!p) return;
  p.off.forEach(id => setOnField(id, false));
  p.on.forEach(id => setOnField(id, true));
  if (p.gk) g.gk = p.gk;
  if (g.phase === 'h1' && g.gk) g.h1gk = g.gk;
  const desired = p.slots;
  const offPlan = p.title === 'Sub now';
  g.pending = null; g.selected = null;
  resyncSlots(desired);
  logLineup(offPlan);
  save();
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
  commitPos();
  const minutes = finalMinutes();
  const shares = fairShares();
  const ids = Object.keys(minutes);
  const avail = {}, names = {}, posMinutes = {}, prefs = {};
  const pmNow = posMinsNow();
  ids.forEach(id => { avail[id] = availableMin(id); names[id] = nameOf(id); posMinutes[id] = pmNow[id] || {}; prefs[id] = prefsOf(id).slice(); });
  state.history.push({
    id: 'g' + Date.now(),
    date: new Date().toISOString().slice(0, 10),
    subsPerHalf: g.subsPerHalf,
    players: ids, names, minutes, shares, avail, posMinutes, prefs, sch: gameSched(g).slice(),
    h1gk: g.h1gk, h2gk: g.h2gk,
    plan: g.plan || [], log: g.log || [],
  });
  recomputeCarryOver();
  state.game = null;
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
// Replace innerHTML only when it differs — rebuilding identical markup every tick
// interrupts momentum scrolling on a phone.
function setHtml(el, html) {
  if (el.__html === html) return;
  el.__html = html; el.innerHTML = html;
}
const views = ['setup', 'game', 'summary', 'season', 'gamedetail', 'planner'];
function show(view) {
  views.forEach(v => { const el = $('view-' + v); if (el) el.hidden = v !== view; });
  window.scrollTo(0, 0);
}

// ============================================================
// The pitch: seven positions laid out in the 1-2-3-1, plus a bench strip.
// State is a { slotId: playerId } map — the same shape assignSlots returns — so the live
// game and the plan editor share one component.
// ============================================================
function pitchHtml(slots, opts) {
  const o = opts || {};
  const taken = Object.values(slots || {});
  const chips = SLOTS.map(sl => {
    const id = (slots || {})[sl.id];
    const sel = o.selected === sl.id;
    const cls = ['spot', sl.id === 'GK' ? 'gk' : '', sel ? 'sel' : '', id ? '' : 'empty',
      id && o.behind && o.behind[id] ? 'behind' : '',
      id && o.incoming && o.incoming.includes(id) ? 'incoming' : '',
      id && o.outgoing && o.outgoing.includes(id) ? 'outgoing' : ''].filter(Boolean).join(' ');
    const sub = id ? (o.sub ? o.sub(id) : '') : 'empty';
    const nt = id && o.note ? o.note(id) : '';
    return '<button class="' + cls + '" style="left:' + sl.x + '%;top:' + sl.y + '%" data-slot="' + sl.id + '"' +
      (o.disabled ? ' disabled' : '') + '>' +
      '<span class="pos">' + esc(sl.label) + '</span>' +
      '<span class="who">' + (id ? esc(nameOf(id)) : '—') + '</span>' +
      (sub ? '<span class="sub">' + esc(sub) + '</span>' : '') +
      '<span class="note">' + esc(nt) + '</span></button>';
  }).join('');
  const benchIds = (o.bench || []).filter(id => !taken.includes(id));
  const bench = benchIds.map(id => {
    const prefs = prefsOf(id);
    const plays = prefs.length ? prefs.map(posLabel).join(' ') : 'any';
    return '<button class="bchip' + (o.selected === 'bench:' + id ? ' sel' : '') +
      (o.behind && o.behind[id] ? ' behind' : '') +
      (o.incoming && o.incoming.includes(id) ? ' incoming' : '') + '"' +
      ' data-bench="' + id + '"' + (o.disabled ? ' disabled' : '') + '>' +
      '<span class="who">' + esc(nameOf(id)) + '</span>' +
      '<span class="bpos' + (prefs.length ? '' : ' any') + '">' + esc(plays) + '</span>' +
      (o.sub ? '<span class="sub">' + esc(o.sub(id)) + '</span>' : '') +
      '<span class="note">' + esc(o.note ? o.note(id) : '') + '</span></button>';
  }).join('');
  return '<div class="pitch">' + chips + '</div>' +
    '<div class="benchbar"><span class="blabel">Bench ' + benchIds.length + '</span>' +
    (bench || '<span class="bnone">nobody</span>') + '</div>';
}

// Draw the pitch, but rebuild it only when the lineup or the highlighting changes.
// The running minutes are written in place — replacing the whole pitch every second
// fights scrolling and swallows taps on a phone.
function paintPitch(el, slots, opts) {
  const o = opts || {};
  const key = [
    SLOTS.map(sl => sl.id + '=' + ((slots || {})[sl.id] || '')).join(','),
    (o.bench || []).map(id => id + ':' + prefsOf(id).join('')).join(','), o.selected || '', o.disabled ? 'd' : '',
    Object.keys(o.behind || {}).join(','), (o.incoming || []).join(','), (o.outgoing || []).join(','),
  ].join('|');
  if (el.dataset.pkey === key) {
    if (!o.sub) return;
    const put = (b, id) => {
      const sp = b.querySelector('.sub');
      if (sp && o.sub) { const t = o.sub(id); if (sp.textContent !== t) sp.textContent = t; }
      const np = b.querySelector('.note');
      if (np) { const t = o.note ? o.note(id) : ''; if (np.textContent !== t) np.textContent = t; }
    };
    el.querySelectorAll('[data-slot]').forEach(b => {
      const id = (slots || {})[b.dataset.slot];
      if (id) put(b, id);
    });
    el.querySelectorAll('[data-bench]').forEach(b => put(b, b.dataset.bench));
    return;
  }
  el.dataset.pkey = key;
  el.innerHTML = pitchHtml(slots, o);
}

// ---------- Setup ----------
function renderSetup() {
  renderPlans();
  const act = activePlan();
  const n = presentIds().length;
  $('btn-start').disabled = !act || n < ON_FIELD;
  $('start-msg').textContent = !act
    ? 'Pick a plan to use today, or create one.'
    : n < ON_FIELD
      ? 'Only ' + n + ' players available. Open the plan and mark at least ' + ON_FIELD + '.'
      : '';
}

// The squad: who is on the team, who is available today, and what they play.
// Lives in the plan editor, because a plan is built around it.
function renderSquad() {
  const ids = presentIds();
  const n = ids.length, subs = Math.max(0, n - ON_FIELD);
  $('attendance-summary').textContent = n + ' available, ' + subs + ' sub' + (subs === 1 ? '' : 's') +
    (n >= ON_FIELD ? ', about ' + fmtMin(fairTarget(n)) + ' each' : '');
  const gkCount = state.roster.filter(p => p.present && p.prefs.includes('GK')).length;
  const noPos = state.roster.filter(p => p.present && !p.prefs.length).map(p => p.name);
  $('gk-hint').textContent = (n < ON_FIELD ? 'Mark at least ' + ON_FIELD + ' players available. ' : '') +
    (gkCount === 0 ? 'No keepers listed, so anyone available may be put in goal. ' :
     gkCount === 1 ? 'Only one keeper listed. They will be in goal all game. ' : '') +
    (noPos.length ? 'No positions listed for ' + noPos.join(', ') + ', so they can be played anywhere.' : '');

  const ul = $('roster');
  ul.innerHTML = '';
  state.roster.forEach(p => {
    const li = document.createElement('li');
    const open = state.editRow === p.id;
    li.className = (p.present ? '' : 'absent ') + (open ? 'open' : '');
    const tags = p.prefs.length
      ? POS.filter(P => p.prefs.includes(P.id)).map(P => '<span class="ptag">' + esc(P.label) + '</span>').join('')
      : '<span class="ptag any">any</span>';
    li.innerHTML =
      '<button class="tag present-tag ' + (p.present ? 'on' : '') + '" data-act="present" data-id="' + p.id + '">' + (p.present ? 'IN' : 'OUT') + '</button>' +
      '<span class="name" data-act="present" data-id="' + p.id + '">' + esc(p.name) + '</span>' +
      (open ? '' : '<span class="ptags">' + tags + '</span>') +
      '<button class="edit" data-act="edit" data-id="' + p.id + '" aria-label="' + (open ? 'Close' : 'Edit ' + esc(p.name)) + '">' + (open ? 'Done' : '✎') + '</button>' +
      (open ? '<span class="posrow">' + POS.map(P =>
        '<button class="tag pos ' + (p.prefs.includes(P.id) ? 'on' : '') + '" data-act="pos" data-id="' + p.id +
        '" data-pos="' + P.id + '" title="' + esc(P.name) + '">' + esc(P.label) + '</button>').join('') +
        '<button class="tag rename" data-act="rename" data-id="' + p.id + '">Rename</button></span>' : '');
    ul.appendChild(li);
  });

}

function renderPlans() {
  const act = activePlan();
  $('plan-active').textContent = act ? 'using “' + act.name + '”' : 'auto';
  $('plan-list').innerHTML = state.plans.length ? state.plans.map(pl =>
    '<li data-plan="' + esc(pl.id) + '"' + (pl.id === state.activePlanId ? ' class="on"' : '') + '>' +
    '<span class="name">' + (pl.id === state.activePlanId ? '✓ ' : '') + esc(pl.name) + '</span>' +
    '<span class="muted">' + pl.blocks.length + ' blocks, ' + pl.subsPerHalf + ' subs per half, saved ' + esc(pl.savedAt) + '</span>' +
    '<button class="chev" data-open="' + esc(pl.id) + '" aria-label="Open ' + esc(pl.name) + '">›</button></li>').join('')
    : '<li class="muted">No plans yet. Tap New plan to build one.</li>';
  const fit = $('plan-fit');
  if (!act) { fit.textContent = ''; fit.classList.remove('warn-text'); return; }
  const f = planFit(act);
  const bits = [];
  if (f.missing.length) bits.push(f.missing.map(nameOf).join(', ') + (f.missing.length === 1 ? ' is' : ' are') + ' in the plan but not here — their spots get filled by whoever is available.');
  if (f.extra.length) bits.push(f.extra.map(nameOf).join(', ') + (f.extra.length === 1 ? ' is' : ' are') + ' here but not in the plan, so they only come on to cover a gap.');
  fit.textContent = bits.join(' ');
  fit.classList.toggle('warn-text', bits.length > 0);
}


// Shared renderers for a list of plan blocks (setup preview and in-game forecast)
const isHalftimeBlock = b => Math.abs(b.start - HALF_MIN) < 1e-6 && !b.played;
function blockLabel(b) {
  return { at: b.start, when: isHalftimeBlock(b) ? 'Halftime' : atClock(b.start) };
}
function planGridHtml(ids, blocks, sch, totals, currentIndex) {
  const flagged = blocks.some(b => b.now);
  const isNow = b => (flagged ? !!b.now : b.index === currentIndex);
  let html = '<tr><th></th>';
  blocks.forEach(b => {
    html += '<th class="' + (isHalftimeBlock(b) ? 'half-start ' : '') + (isNow(b) ? 'now' : '') + '">' +
      atClock(b.start) + (isHalftimeBlock(b) ? ' HT' : isWaterBlock(b.start) ? ' 💧' : '') + '</th>';
  });
  html += '<th>Total</th></tr>';
  ids.forEach(id => {
    html += '<tr><td class="player">' + esc(nameOf(id)) + '</td>';
    blocks.forEach(b => {
      const cls = (isHalftimeBlock(b) ? 'half-start ' : '') + (isNow(b) ? 'now ' : '') +
        (b.gk === id ? 'gk' : b.on.includes(id) ? 'on' : '');
      const sl = slotById(slotOfPlayer(b.slots, id));
      html += '<td class="' + cls + '">' + (b.gk === id ? 'GK' : b.on.includes(id) ? (sl ? esc(sl.label) : '●') : '') + '</td>';
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
// Pair every incoming player with the player they replace and the slot they take, so the
// coach reads one row per swap instead of matching two lists by eye.
function subPairs(d, newSlots, oldSlots) {
  const free = d.off.slice(), pairs = [];
  d.on.forEach(inId => {
    const slot = slotOfPlayer(newSlots || {}, inId);
    const held = slot ? (oldSlots || {})[slot] : null;
    const i = held ? free.indexOf(held) : -1;      // whoever was standing in that slot
    pairs.push({ on: inId, off: i >= 0 ? free.splice(i, 1)[0] : null, slot });
  });
  pairs.forEach(p => { if (!p.off && free.length) p.off = free.shift(); });
  free.forEach(id => pairs.push({ on: null, off: id, slot: null }));
  return pairs;
}
// Players who stay on but shift position
function slotMoves(newSlots, oldSlots, incoming) {
  const moves = [];
  Object.keys(newSlots || {}).forEach(sid => {
    const pid = newSlots[sid];
    if (incoming.indexOf(pid) >= 0) return;
    const was = slotOfPlayer(oldSlots || {}, pid);
    if (was && was !== sid) moves.push({ id: pid, to: sid });
  });
  return moves;
}
function boardPanelsHtml(d, extra, newSlots, oldSlots) {
  const pairs = subPairs(d, newSlots, oldSlots);
  const moves = slotMoves(newSlots, oldSlots, d.on);
  const cell = (id, side) => '<div class="sub-cell ' + side + '">' +
    (id ? esc(nameOf(id)) : '<span class="none">nobody</span>') + '</div>';
  const rail = slot => {
    const sl = slotById(slot);
    return '<div class="sub-rail">' + (sl ? '<span class="slotchip' + (sl.id === 'GK' ? ' gk' : '') + '">' + esc(sl.label) + '</span>' : '') + '</div>';
  };
  let rows = '<div class="sub-head off">Off</div><div class="sub-rail"></div><div class="sub-head on">On</div>';
  if (!pairs.length) rows += '<div class="sub-cell off"><span class="none">nobody</span></div><div class="sub-rail"></div><div class="sub-cell on"><span class="none">nobody</span></div>';
  pairs.forEach(p => { rows += cell(p.off, 'off') + rail(p.slot) + cell(p.on, 'on'); });
  let foot = '';
  if (d.gk) foot += '<span class="gkline"><b>GK</b>' + esc(nameOf(d.gk)) + '</span>';
  if (moves.length) foot += '<span class="moves">Also ' + moves.map(mv =>
    esc(nameOf(mv.id)) + ' to ' + esc(slotById(mv.to).label)).join(', ') + '</span>';
  if (extra) foot += extra;
  return '<div class="board-subs">' + rows + '</div>' +
    (foot ? '<div class="board-foot">' + foot + '</div>' : '');
}
function planSwapsHtml(blocks, sch) {
  let html = '<li><b>Keepers:</b> ' + [...new Set(blocks.map(b => b.gk))].map(nameOf).map(esc).join(' → ') + '</li>';
  for (let i = 1; i < blocks.length; i++) {
    const prev = blocks[i - 1], b = blocks[i];
    html += '<li><b>' + blockLabel(b).when + '</b>' + (isWaterBlock(b.start) ? ' 💧' : '') + ' — ' +
      swapLineHtml(diffLineups(prev.on, prev.gk, b)) + '</li>';
  }
  return html;
}

// The whole plan at a glance: one column per block
function renderPlan() {
  const d = state.draft, ids = presentIds();
  if (!d || ids.length < ON_FIELD) { $('plan-card').hidden = true; return; }
  const sch = schedOf(d), HI = halfIndex(sch);
  const blocks = d.blocks.map(b => {
    const on = Object.values(b.slots);
    return {
      index: b.index, half: b.index < HI ? 1 : 2, start: blockStart(sch, b.index), end: blockEnd(sch, b.index),
      on, gk: b.slots.GK, slots: b.slots, bench: ids.filter(id => !on.includes(id)),
    };
  });
  const totals = planMinutes(blocks, sch);
  ids.forEach(id => { totals[id] = totals[id] || 0; });
  $('plan-grid').innerHTML = planGridHtml(ids, blocks, sch, totals, -1);
  $('plan-swaps').innerHTML = planSwapsHtml(blocks, sch);
  $('plan-summary').textContent = blockCount(sch) + ' shifts';
  $('plan-card').hidden = false;
}

// Forecast the rest of the game from the current lineup: minutes are projected to the end
// of the current block, an unapplied pending sub is assumed to happen, and the planner runs
// from the next block. Result is stable within a block so callers can cache by `key`.
function liveForecast() {
  const g = state.game;
  if (!g || g.phase === 'done') return null;
  const sch = gameSched(g), B = blockCount(sch), HI = halfIndex(sch);
  const min = elapsedMin();
  const b = currentBlock(g);
  const ids = presentIds().filter(id => g.players[id]);
  let onField = ids.filter(id => g.players[id].onField);
  let gk = g.gk;
  const p = g.pending;
  if (p && (p.off.length || p.on.length || p.gk)) {
    onField = onField.filter(id => !p.off.includes(id)).concat(p.on.filter(id => ids.includes(id)));
    if (p.gk) gk = p.gk;
  }
  const ov = g.nextOverride;
  const ovKey = ov ? ov.block + ':' + SLOTS.map(sl => ov.slots[sl.id] || '-').join(',') : '';
  const key = [b, onField.join(','), gk, ids.join(','), g.h2gk, ovKey, g.followPlan ? 'p' : '',
    (g.log || []).length].join('|');
  const seed = seedMinutes(ids);
  const minutes = currentMinutes();
  const remain = Math.max(0, blockEnd(sch, b) - min);
  onField.forEach(id => { minutes[id] += remain; });
  const bStart = blockStart(sch, b);
  // Lineups this block has already seen: the one it started with, then any change made
  // since. Each becomes its own column so an unplanned sub shows up at the time it happened.
  const offPlan = (g.log || []).filter(e => e.slots && e.offPlan && e.t > bStart + 1e-6);
  const stages = [];
  if (offPlan.length) {
    const before = [...(g.log || [])].reverse().find(e => e.slots && e.t < offPlan[0].t - 1e-6);
    stages.push({ t: bStart, slots: before ? before.slots : (g.slots || {}) });
    offPlan.forEach(e => stages.push({ t: e.t, slots: e.slots }));
  } else {
    stages.push({ t: bStart, slots: g.slots || {} });
  }
  stages[stages.length - 1].slots = g.slots || {};                   // the live lineup is the last word
  const past = stages.slice(0, -1).map(st => {
    const on = Object.values(st.slots);
    return { index: b, half: b < HI ? 1 : 2, start: st.t, end: blockEnd(sch, b), on, gk: st.slots.GK, bench: ids.filter(id => !on.includes(id)), slots: st.slots, played: true };
  });
  const current = { index: b, half: b < HI ? 1 : 2, start: stages[stages.length - 1].t, end: blockEnd(sch, b), on: onField, gk, bench: ids.filter(id => !onField.includes(id)), slots: g.slots || {}, now: true };
  let blocks = past.concat([current]), next = null, projected = minutes;
  if (b + 1 < B) {
    const sub = subForBlock(b + 1, ids, onField, gk, minutes);
    next = { block: sub.block, diff: sub.diff, manual: sub.manual, fromPlan: sub.fromPlan };
    if (sub.manual) {
      // Coach's lineup for the next block, then let the planner take over from there
      const minutes2 = Object.assign({}, minutes);
      sub.block.on.forEach(id => { minutes2[id] += blockLen(sch, b + 1); });
      blocks = past.concat([current, sub.block]);
      projected = minutes2;
      if (b + 2 < B) {
        const rest = planFrom({
          ids, sch, minutes: minutes2, fromBlock: b + 2, onField: sub.block.on, gk: sub.block.gk,
          h1gk: g.h1gk, h2gk: g.h2gk, played: playedIds(ids).concat(sub.block.on), gkEligible: gkEligibleSet(),
          prefsOf, posMins: livePosMins(ids), prevSlots: sub.block.slots,
        });
        blocks = blocks.concat(rest.blocks);
        projected = rest.projected;
      }
    } else {
      blocks = past.concat([current], sub.plan.blocks);
      projected = sub.plan.projected;
    }
  }
  // Projected final minutes this game, and each player's fair share of them weighted by
  // how long they are (and will be) available. "Behind" = ends more than a block short
  // of fair even if the plan is followed — beyond what the rotation can even out.
  const totals = {}, fair = {}, behind = {};
  const left = Math.max(0, GAME_MIN - min);
  const avail = {}; let sumAvail = 0, sumTotal = 0;
  ids.forEach(id => {
    totals[id] = projected[id] - seed[id];
    avail[id] = availableMin(id) + left;
    sumAvail += avail[id]; sumTotal += totals[id];
  });
  ids.forEach(id => {
    fair[id] = sumAvail > 0 ? sumTotal * avail[id] / sumAvail : 0;
    behind[id] = totals[id] < fair[id] - blockLen(sch, b) + 1e-6;
  });
  return { key, blocks, next, totals, fair, behind, ids };
}

// ---------- Game ----------
function renderGame() {
  const g = state.game;
  if (!g) return;
  const sch = gameSched(g);
  const min = elapsedMin();
  const shownMin = g.phase === 'halftime' ? HALF_MIN : min;
  const b = currentBlock(g);
  const fullTime = g.phase === 'h2' && min >= GAME_MIN;
  const overHalf = g.phase === 'h1' && min >= HALF_MIN;

  const clock = document.querySelector('.clock');
  clock.classList.toggle('paused', !g.running && g.phase !== 'halftime');
  clock.classList.toggle('halftime', g.phase === 'halftime' || !!g.breakLabel);
  // The clock keeps counting past regulation; the pill says so
  $('clock-time').textContent = fmtClock(shownMin).padStart(5, '0');
  $('clock-half').textContent = g.phase === 'done' ? 'Final'
    : g.breakLabel ? g.breakLabel
    : g.phase === 'halftime' ? 'Halftime'
    : fullTime ? 'Full time'
    : overHalf ? '1st half +'
    : g.phase === 'h1' ? '1st half' : '2nd half';
  const col = blockCounter(g);
  $('clock-block').textContent = g.phase === 'done' ? '' : 'Block ' + col.at + '/' + col.total;

  const nextEl = $('clock-next');
  nextEl.classList.remove('soon');
  if (g.phase === 'done') {
    nextEl.textContent = 'Game over';
  } else if (g.phase === 'halftime') {
    nextEl.textContent = 'Halftime — make subs, then start the 2nd half';
  } else if (g.breakLabel) {
    nextEl.textContent = g.breakLabel + ' — clock stopped';
  } else if (fullTime || overHalf) {
    nextEl.textContent = 'Playing on — tap End game when the ref blows';
  } else {
    const nextBoundary = Math.min(blockEnd(sch, b), g.phase === 'h1' ? HALF_MIN : GAME_MIN);
    const remain = Math.max(0, nextBoundary - min);
    const label = Math.abs(nextBoundary - HALF_MIN) < 1e-6 ? 'Halftime' : Math.abs(nextBoundary - GAME_MIN) < 1e-6 ? 'Full time' : 'Next sub';
    nextEl.textContent = label + ' in ' + fmtClock(remain);
    if (remain <= 1 && g.running) nextEl.classList.add('soon');
  }

  $('timeline-fill').style.width = Math.min(100, min / GAME_MIN * 100) + '%';
  const marks = $('timeline-marks');
  if (marks.dataset.s !== sch.join(',')) {
    marks.dataset.s = sch.join(',');
    marks.innerHTML = '';
    for (let i = 1; i < blockCount(sch); i++) {
      const t = blockStart(sch, i);
      if (isWaterBlock(t)) continue;                 // drawn below, at its fixed time
      const sp = document.createElement('span');
      sp.className = Math.abs(t - HALF_MIN) < 1e-6 ? 'half' : '';
      sp.style.left = (t / GAME_MIN * 100) + '%';
      marks.appendChild(sp);
    }
    WATER_TIMES.forEach(t => {
      const sp = document.createElement('span');
      sp.className = 'water';
      sp.style.left = (t / GAME_MIN * 100) + '%';
      marks.appendChild(sp);
    });
  }

  const btn = $('btn-clock');
  btn.disabled = g.phase === 'done';
  btn.textContent = g.phase === 'halftime' ? 'Start 2nd half' : g.running ? 'Pause' : (min === 0 ? 'Start' : 'Resume');
  // Halftime offers "Play on" for a long first half; otherwise the button stops for a drink
  const brk = $('btn-break');
  brk.hidden = g.phase === 'done';
  brk.textContent = g.phase === 'halftime' ? 'Play on' : g.breakLabel ? 'Resume' : 'Water break';
  brk.disabled = false;

  const ids = presentIds().filter(id => g.players[id]);

  // Sub board lit up: it's time to sub
  const banner = $('banner');
  if (g.pending) {
    const p = g.pending;
    $('banner-title').textContent = p.title;
    const pb = p.block != null ? p.block : b;
    $('banner').querySelector('.board-strip .muted').textContent = pb === halfIndex(sch) ? 'before the 2nd half' :
      atClock(blockStart(sch, pb));
    // An edited sub can leave the wrong number on the field; never let Apply commit that
    const onNow = ids.filter(id => g.players[id].onField).length;
    const after = onNow - p.off.length + p.on.length;
    const want = Math.min(ON_FIELD, ids.length);
    const over = after !== want;
    let extra = '';
    if (p.manual && !p.fromPlan) extra += '<span class="muted">Edited by you</span>';
    if (over) extra += '<span class="warn">That leaves ' + after + ' on the field, not ' + want +
      '. Tap Edit lineup to fix it.</span>';
    setHtml($('banner-body'), p.note
      ? '<div class="board-foot">' + esc(p.note) + '</div>'
      : boardPanelsHtml({ off: p.off, on: p.on, gk: p.gk }, extra, p.slots, g.slots));
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
  const whenLabel = next ? (next.block.index === halfIndex(sch) ? 'at halftime' : 'at ' + atClock(next.block.start)) : '';
  previewEl.classList.toggle('editing', !!g.editNext);
  if (g.editNext && next) {
    const hasChange = next.diff.off.length || next.diff.on.length || next.diff.gk;
    setHtml(previewEl, '<div class="board-strip"><span>Editing lineup</span>' +
      '<span class="edit-actions"><button class="link" id="btn-edit-reset">Reset to plan</button><button class="link" id="btn-edit-done">Cancel</button></span></div>' +
      boardPanelsHtml(next.diff, problem ? '<span class="warn">' + esc(problem) + '</span>' : '', next.block.slots, g.slots) +
      '<div class="board-actions"><button class="primary" id="btn-sub-now"' + (problem || !hasChange ? ' disabled' : '') + '>Sub now</button>' +
      '<button class="secondary" id="btn-edit-stage"' + (problem || !hasChange ? ' disabled' : '') + '>Save for ' + esc(whenLabel.replace(/^at /, '')) + '</button></div>');
    previewEl.hidden = false;
  } else if (next && !g.pending && (next.diff.off.length || next.diff.on.length || next.diff.gk)) {
    setHtml(previewEl, '<div class="board-strip"><span>Next sub ' + esc(whenLabel) + '</span><span class="muted">' + (next.fromPlan ? 'from your plan' : next.manual ? 'edited by you' : 'auto') + '</span></div>' +
      boardPanelsHtml(next.diff, problem ? '<span class="warn">' + esc(problem) + '</span>' : '', next.block.slots, g.slots));
    previewEl.hidden = false;
  } else if (canEdit && !g.pending) {
    setHtml(previewEl, '<div class="board-strip"><span>Next sub ' + esc(whenLabel) + '</span><span class="muted">no change planned</span></div>');
    previewEl.hidden = false;
  } else {
    previewEl.hidden = true;
  }
  clock.classList.toggle('editing', !!g.editNext);
  if (fc && !$('live-plan-card').hidden && $('live-plan-card').dataset.key !== fc.key) {
    $('live-plan-card').dataset.key = fc.key;
    setHtml($('live-plan-grid'), fc.totals ? planGridHtml(fc.ids, fc.blocks, sch, fc.totals, fc.blocks[0].index) : '');
    setHtml($('live-plan-swaps'), fc.blocks.length > 1 ? planSwapsHtml(fc.blocks, sch) : '<li>No more subs scheduled.</li>');
  }

  const editing = !!g.editNext;
  const isBehind = id => !!(fc && fc.behind[id]);
  // Live: what is on the field now. Editing: the state the coach is building.
  const shown = editing ? editSlots() : (g.slots || {});
  const behind = {};
  ids.forEach(id => { if (isBehind(id)) behind[id] = true; });
  const incoming = editing ? Object.values(shown).filter(id => !g.players[id].onField)
    : [...nextOn];
  const outgoing = editing ? ids.filter(id => g.players[id].onField && !Object.values(shown).includes(id))
    : [...nextOff];
  const nextSlots = (g.pending && g.pending.slots) || (next && next.block.slots) || {};
  const sub = id => fmtMin(mins[id]);
  // What is about to happen to this player, shown under their running clock
  const note = id => {
    if (editing) {
      const here = slotOfPlayer(shown, id);
      if (!here) return g.players[id].onField ? 'coming off' : '';
      return g.players[id].onField ? '' : 'coming on';
    }
    const to = slotById(slotOfPlayer(nextSlots, id));
    if (nextOn.has(id)) return to ? '→ ' + to.label : 'on next';
    if (nextOff.has(id)) return 'off next';
    return '';
  };
  const benchIds = ids.filter(id => !Object.values(shown).includes(id));
  paintPitch($('pitch-wrap'), shown, {
    bench: benchIds, selected: editing ? g.editSel : null, behind, incoming, outgoing,
    sub, note, disabled: !editing && g.phase === 'done',
  });

  $('btn-edit-mode').hidden = !canEdit;
  $('btn-edit-mode').textContent = editing ? 'Done editing' : 'Edit lineup';
  $('btn-edit-mode').classList.toggle('primary', editing);
  $('btn-edit-mode').classList.toggle('secondary', !editing);
  const late = editing ? [] : unplannedAvailable();
  const lateEl = $('arrival-note');
  if (late.length) {
    setHtml(lateEl, '<div class="board-strip"><span>Not in the plan</span><span class="muted">' +
      esc(late.map(nameOf).join(', ')) + '</span></div>' +
      '<div class="board-actions"><button class="primary" id="btn-work-in-2">Work into the plan</button>' +
      '<span class="muted">or sub them on with Edit lineup</span></div>');
    lateEl.hidden = false;
  } else {
    lateEl.hidden = true;
  }
  const reb = $('btn-rebalance');
  reb.hidden = !g.followPlan || g.phase === 'done' || editing;
  const rebDone = g.rebalancedAt === (g.log || []).length;
  reb.classList.toggle('done', rebDone);
  reb.innerHTML = rebDone ? '<span class="tick">✓</span> Rebalanced' : 'Rebalance plan';
  reb.disabled = currentBlock(g) >= blockCount(sch) - 1;
  $('game-hint').textContent = editing
    ? 'Tap a position, then a bench player to put them there. Tap two positions to swap.'
    : 'Tap Edit lineup to change positions or make an unplanned sub.';
}

// Players can only be moved in edit mode; a stray tap on the sideline must not change the lineup
function onPitchTap(kind, value) {
  const g = state.game;
  if (!g || g.phase === 'done' || !g.editNext) return;
  if (kind === 'slot') tapSlot(value);
  else if (g.players[value]) tapBench(value);
}

// Apply the edited off/on right now instead of waiting for the next scheduled sub
function subNow() {
  const g = state.game;
  const fc = liveForecast();
  if (!fc || !fc.next || !fc.next.manual || overrideProblem(fc)) return;
  const d = fc.next.diff;
  const off = d.off.filter(id => g.players[id] && g.players[id].onField);
  const on = d.on.filter(id => g.players[id] && !g.players[id].onField);
  if (!off.length && !on.length && !d.gk) return;
  g.pending = { title: 'Sub now', off, on, gk: d.gk, manual: true, block: currentBlock(g), slots: fc.next.block.slots };
  applyPending();
  g.nextOverride = null;
  g.editNext = false; g.editSel = null;
  save();
  renderGame();
}

// Enter edit mode seeded with the planner's suggestion for the next block
function startEditNext() {
  const g = state.game;
  const fc = liveForecast();
  if (!fc || !fc.next) return;
  if (!g.nextOverride || g.nextOverride.block !== fc.next.block.index) {
    // Start from the field as it stands, so changing one player is one tap
    g.nextOverride = { block: fc.next.block.index, slots: Object.assign({}, g.slots) };
  }
  g.editNext = true; g.editSel = null;
  save(); renderGame();
}

// --- editing a field layout by tapping: pure helpers shared by the live pitch and the
// plan editor. Each mutates `slots` and returns the new selection. ---
function slotTap(slots, sel, slotId) {
  if (sel === slotId) return null;                      // tap again to deselect
  if (sel && SLOTS.some(sl => sl.id === sel)) {         // two positions: swap them
    const a = slots[sel], b = slots[slotId];
    if (b) slots[sel] = b; else delete slots[sel];
    if (a) slots[slotId] = a; else delete slots[slotId];
    return null;
  }
  return slotId;
}
function benchTap(slots, sel, id) {
  const here = slotOfPlayer(slots, id);
  if (here) { delete slots[here]; return here; }        // tap a player on the pitch: take them off
  const target = sel && SLOTS.some(sl => sl.id === sel)
    ? sel
    : SLOTS.map(sl => sl.id).find(sid => !slots[sid]);  // no selection: drop into an empty spot
  if (!target) return null;
  slots[target] = id;
  return null;
}

const editSlots = () => (state.game.nextOverride || {}).slots || {};
function tapSlot(slotId) {
  const g = state.game;
  if (!g.nextOverride) return;
  g.editSel = slotTap(g.nextOverride.slots, g.editSel, slotId);
  save(); renderGame();
}
function tapBench(id) {
  const g = state.game;
  if (!g.nextOverride) return;
  g.editSel = benchTap(g.nextOverride.slots, g.editSel, id);
  save(); renderGame();
}

// Spots filled vs. spots that should be filled; null when fine
function overrideProblem(fc) {
  const g = state.game;
  if (!fc || !fc.next || !fc.next.manual || fc.next.fromPlan) return null;
  const ov = g.nextOverride;
  if (!ov || ov.block !== fc.next.block.index) return null;
  const filled = Object.keys(ov.slots).filter(sid => ov.slots[sid]).length;
  const want = Math.min(ON_FIELD, fc.ids.length);
  if (filled === want) return null;
  return filled > want
    ? 'That puts ' + filled + ' on the field, not ' + want
    : (want - filled) + ' position' + (want - filled === 1 ? '' : 's') + ' still empty';
}


// ---------- Attendance modal (mid-game) ----------
function renderModal() {
  const g = state.game;
  const ul = $('modal-list');
  ul.innerHTML = '';
  state.roster.forEach(p => {
    const li = document.createElement('li');
    const status = p.present ? (g.players[p.id] && g.players[p.id].onField ? 'on field' : 'bench') : 'out';
    li.innerHTML =
      '<button class="tag present-tag ' + (p.present ? 'on' : '') + '" data-act="toggle" data-id="' + p.id + '">' + (p.present ? 'IN' : 'OUT') + '</button>' +
      '<span class="name" data-act="toggle" data-id="' + p.id + '">' + esc(p.name) + '</span>' +
      '<span class="muted">' + status + '</span>';
    ul.appendChild(li);
  });
  const late = unplannedAvailable();
  const note = $('modal-note');
  if (late.length) {
    note.innerHTML = '<p class="hint">' + esc(late.map(nameOf).join(', ')) +
      (late.length === 1 ? ' is' : ' are') + ' available but not in the rest of the plan.</p>' +
      '<button class="secondary" id="btn-work-in">Work into the plan</button>' +
      '<p class="hint">Or leave the plan alone and bring them on with Edit lineup.</p>';
    note.hidden = false;
  } else {
    note.hidden = true;
  }
}
function toggleMidGame(id) {
  const g = state.game, p = byId(id);
  p.present = !p.present;
  const now = elapsedMs();
  if (p.present) {
    if (!g.players[id]) g.players[id] = { playedMs: 0, onField: false, onSinceMs: 0, availMs: 0, inSinceMs: now, posMs: {}, slot: null, slotSince: null };
    else if (g.players[id].inSinceMs == null) g.players[id].inSinceMs = now;
  } else if (g.players[id]) {
    const gp = g.players[id];
    setOnField(id, false);
    if (gp.inSinceMs != null) { gp.availMs += now - gp.inSinceMs; gp.inSinceMs = null; }
    if (g.selected === id) g.selected = null;
  }
  g.pending = null;
  resyncSlots();
  logLineup(true);
  save();
  renderModal();
  renderGame();
}

// Available players who appear nowhere in the rest of the plan — a late arrival will sit
// on the bench all game unless the coach works them in.
function unplannedAvailable() {
  const g = state.game;
  if (!g || !g.followPlan || g.phase === 'done') return [];
  const b = currentBlock(g);
  const rest = (g.plan || []).filter(x => x.index > b);
  if (!rest.length) return [];
  const used = new Set();
  rest.forEach(x => Object.values(x.slots || {}).forEach(id => used.add(id)));
  return presentIds().filter(id => g.players[id] && !used.has(id) && !g.players[id].onField);
}

// Rebuild every block after the current one from the minutes actually played, so anyone
// available gets worked into the rotation.
function replanRemaining() {
  const g = state.game;
  if (!g) return;
  const S = g.subsPerHalf, b = currentBlock(g);
  const ids = presentIds().filter(id => g.players[id]);
  const plan = planFrom({
    ids, sch: gameSched(g), minutes: currentMinutes(), fromBlock: b + 1,
    onField: ids.filter(id => g.players[id].onField), gk: g.gk,
    h1gk: g.h1gk, h2gk: g.h2gk, played: playedIds(ids),
    gkEligible: gkEligibleSet(), prefsOf, posMins: livePosMins(ids), prevSlots: g.slots,
  });
  g.plan = (g.plan || []).filter(x => x.index <= b)
    .concat(plan.blocks.map(x => ({ index: x.index, slots: Object.assign({}, x.slots) })));
  g.arrival = null;
  g.pending = null;
  g.nextOverride = null;
  g.rebalancedAt = (g.log || []).length;   // remembered until the next off-plan change
  save();
}

// ---------- Positions ----------
function togglePos(p, posId) {
  p.prefs = p.prefs.includes(posId) ? p.prefs.filter(x => x !== posId) : p.prefs.concat(posId);
  p.gk = p.prefs.includes('GK');
  if (!p.gk && state.startGk === p.id) state.startGk = null;
}

// ---------- Game plans ----------
const activePlan = () => state.plans.find(p => p.id === state.activePlanId) || null;
const planById = id => state.plans.find(p => p.id === id) || null;

// Who a plan uses, and how today's attendance compares
function planFit(pl) {
  const inPlan = [];
  pl.blocks.forEach(b => Object.values(b.slots || {}).forEach(id => { if (!inPlan.includes(id)) inPlan.push(id); }));
  const here = presentIds();
  return {
    inPlan,
    missing: inPlan.filter(id => !here.includes(id)),   // in the plan but not here today
    extra: here.filter(id => !inPlan.includes(id)),     // here today but not in the plan
  };
}

// Minutes each player gets from a set of blocks
function planMinutes(blocks, sch) {
  const out = {};
  blocks.forEach(b => {
    const L = b.end != null && b.start != null ? b.end - b.start : blockLen(sch, b.index);
    Object.values(b.slots || {}).forEach(id => { out[id] = (out[id] || 0) + L; });
  });
  return out;
}

function newDraft(fromPlan) {
  if (fromPlan) {
    state.draft = {
      id: fromPlan.id, name: fromPlan.name, subsPerHalf: fromPlan.subsPerHalf, times: timesOf(fromPlan),
      blocks: fromPlan.blocks.map(b => ({ index: b.index, slots: Object.assign({}, b.slots) })),
      block: 0, sel: null,
    };
  } else {
    const plan = planFrom(Object.assign(kickoffPlanInputs(), { sch: schedule(evenTimes(state.subsPerHalf)) }));
    state.draft = {
      id: null, name: '', subsPerHalf: state.subsPerHalf, times: evenTimes(state.subsPerHalf),
      blocks: plan.blocks.map(b => ({ index: b.index, slots: Object.assign({}, b.slots) })),
      block: 0, sel: null,
    };
  }
  save();
}

// Re-run the planner for every block after `from`, seeded with the blocks already set
function autoFillFrom(from) {
  const d = state.draft;
  const sch = schedOf(d);
  const ids = presentIds();
  const kept = d.blocks.filter(b => b.index <= from);
  const minutes = seedMinutes(ids);
  const pm = seasonPosMins(ids);
  kept.forEach(b => Object.keys(b.slots).forEach(sid => {
    const pid = b.slots[sid];
    const L = blockLen(sch, b.index);
    minutes[pid] = (minutes[pid] || 0) + L;
    const grp = slotById(sid).pos;
    pm[pid] = pm[pid] || {}; pm[pid][grp] = (pm[pid][grp] || 0) + L;
  }));
  const last = kept[kept.length - 1];
  const rest = planFrom({
    ids, sch, minutes, fromBlock: from + 1,
    onField: Object.values(last.slots), gk: last.slots.GK,
    h1gk: kept.length ? kept[0].slots.GK : null,
    played: Object.keys(minutes).filter(id => minutes[id] > (seedMinutes(ids)[id] || 0)),
    gkEligible: gkEligibleSet(), prefsOf, posMins: pm, prevSlots: last.slots,
  });
  d.blocks = kept.concat(rest.blocks.map(b => ({ index: b.index, slots: Object.assign({}, b.slots) })));
  d.filled = from;          // which block the rest was filled from
  save();
}

// Keep every block of the plan being edited valid for who is available
function adaptDraftToSquad() {
  const d = state.draft;
  if (!d) return;
  const ids = presentIds();
  if (ids.length < ON_FIELD) return;
  // Rebuild outright when someone available has no place in the plan at all — filling the
  // gaps left by a departure can never put a returning player back on the sheet.
  const used = new Set();
  d.blocks.forEach(b => Object.values(b.slots || {}).forEach(id => used.add(id)));
  if (ids.some(id => !used.has(id))) {
    const first = d.blocks[0] ? Object.values(d.blocks[0].slots).filter(id => ids.includes(id)) : [];
    const gk0 = d.blocks[0] && ids.includes(d.blocks[0].slots.GK) ? d.blocks[0].slots.GK : null;
    const plan = planFrom(Object.assign(kickoffPlanInputs(), {
      S: d.subsPerHalf, starters: first.length === ON_FIELD ? first : [], h1gk: gk0,
    }));
    d.blocks = plan.blocks.map(b => ({ index: b.index, slots: Object.assign({}, b.slots) }));
    d.filled = null;
    save();
    return;
  }
  // Minutes accumulate block by block, so a gap left by an absent player goes to whoever
  // has had least so far. Without this every block fills with the same names and the
  // rotation collapses.
  const minutes = seedMinutes(ids);
  const L = blockLen(d.subsPerHalf);
  let prev = null;
  d.blocks = d.blocks.map(b => {
    const pb = plannedBlockFor({ blocks: [b] }, b.index, ids, minutes, prev);
    const slots = pb ? pb.slots : b.slots;
    Object.values(slots).forEach(id => { minutes[id] = (minutes[id] || 0) + L; });
    prev = slots;
    return { index: b.index, slots };
  });
  d.filled = null;
  save();
}

function renderPlanner() {
  const d = state.draft;
  if (!d) return;
  const sch = schedOf(d), HI = halfIndex(sch);
  const S = d.subsPerHalf;
  const ids = presentIds();
  renderSquad();
  $('planner-title').textContent = d.name || 'New game plan';
  $('psubs-value').textContent = S;
  $('psubs-minus').disabled = S <= MIN_SUBS;
  $('psubs-plus').disabled = S >= MAX_SUBS;
  $('psubs-schedule').textContent = 'Water breaks at ' + WATER_TIMES.map(atClock).join(' and ') +
    '. Halftime is always a sub.';
  // Each sub time can be nudged or removed; halftime and kickoff are fixed
  const custom = timesOf(d).slice().sort((a, c) => a - c);
  $('times-list').innerHTML = custom.map((t, i) =>
    '<li><span class="tlabel">' + atClock(t) + '</span>' +
    '<span class="tlen">' + fmtClock(blockLen(sch, sch.indexOf(t))) + ' shift</span>' +
    '<button class="tag" data-nudge="' + i + '" data-by="-0.25">−15s</button>' +
    '<button class="tag" data-nudge="' + i + '" data-by="0.25">+15s</button>' +
    '<button class="tag drop" data-drop="' + i + '">Remove</button></li>').join('') ||
    '<li class="muted">No subs except halftime.</li>';
  $('times-summary').textContent = custom.length + ' sub' + (custom.length === 1 ? '' : 's') +
    ' plus halftime — ' + blockCount(sch) + ' shifts';
  $('planner-tabs').innerHTML = d.blocks.map(b => {
    const at = blockStart(sch, b.index);
    return '<button class="tab' + (b.index === d.block ? ' on' : '') + (b.index === HI ? ' half' : '') +
      '" data-block="' + b.index + '">' + atClock(at) +
      (b.index === HI ? ' HT' : isWaterBlock(at) ? ' 💧' : '') + '</button>';
  }).join('');
  const cur = d.blocks.find(b => b.index === d.block) || d.blocks[0];
  const at = blockStart(sch, cur.index), to = blockEnd(sch, cur.index);
  $('planner-when').textContent = 'Block ' + (cur.index + 1) + ' of ' + d.blocks.length + ' — ' +
    atClock(at) + ' to ' + atClock(to) + ' (' + (cur.index >= HI ? '2nd half' : '1st half') + ')' +
    (cur.index === HI ? ', from halftime'
      : isWaterBlock(at) ? ', from the water break'
      : WATER_TIMES.some(w => w > at && w < to) ? ', water break at ' + atClock(WATER_TIMES.find(w => w > at && w < to))
      : '');
  const onNow = Object.values(cur.slots);
  const benchIds = ids.filter(id => !onNow.includes(id));
  paintPitch($('planner-pitch'), cur.slots, { bench: benchIds, selected: d.sel, sub: () => '' });

  const mins = planMinutes(d.blocks.map(b => ({ slots: b.slots, index: b.index })), sch);
  const vals = ids.map(id => mins[id] || 0);
  const gap = vals.length ? Math.max(...vals) - Math.min(...vals) : 0;
  $('planner-gap').textContent = 'gap ' + fmtClock(gap);
  const sorted = ids.slice().sort((a, c) => (mins[c] || 0) - (mins[a] || 0));
  $('planner-mins').innerHTML = '<tr><th>Player</th><th>Minutes</th></tr>' + sorted.map(id =>
    '<tr><td>' + esc(nameOf(id)) + '</td><td>' + fmtMin(mins[id] || 0) + '</td></tr>').join('');
  $('btn-planner-delete').hidden = !d.id;
  // Printing and sharing need a saved plan, so they appear once it has one
  ['btn-planner-print', 'btn-planner-share', 'planner-share-hint'].forEach(x => { $(x).hidden = !d.id; });
  $('btn-planner-save').disabled = presentIds().length < ON_FIELD;
  $('use-carry').checked = state.useCarryOver;
  if (!$('plan-card').hidden) renderPlan();
  // The check stays until the plan is edited again
  const fill = $('btn-planner-fill');
  const done = d.filled != null;
  fill.classList.toggle('done', done);
  fill.innerHTML = done
    ? '<span class="tick">✓</span> Filled from ' + atClock(blockStart(sch, d.filled))
    : 'Auto-fill later blocks';
  fill.disabled = d.block >= d.blocks.length - 1;
}

// Changing subs per half changes the block boundaries, so the plan is rebuilt around the
// starting lineup the coach already chose.
// Re-block the plan around a new set of sub times, keeping the starting lineup.
function reblockDraft(times) {
  const d = state.draft;
  const ids = presentIds();
  d.times = schedule(times).filter(t => t > 0 && Math.abs(t - HALF_MIN) > 1e-6);
  d.block = Math.min(d.block, schedule(d.times).length - 1);
  d.sel = null; d.filled = null;
  if (ids.length < ON_FIELD) { save(); return; }
  const first = d.blocks[0] ? Object.values(d.blocks[0].slots).filter(id => ids.includes(id)) : [];
  const gk0 = d.blocks[0] && ids.includes(d.blocks[0].slots.GK) ? d.blocks[0].slots.GK : null;
  const plan = planFrom(Object.assign(kickoffPlanInputs(), {
    sch: schedule(d.times), starters: first.length === ON_FIELD ? first : [], h1gk: gk0,
  }));
  d.blocks = plan.blocks.map(b => ({ index: b.index, slots: Object.assign({}, b.slots) }));
  save();
}
// Move one sub time by a few seconds, keeping it clear of its neighbours
function nudgeTime(i, by) {
  const d = state.draft;
  const times = timesOf(d).slice().sort((a, c) => a - c);
  if (i < 0 || i >= times.length) return;
  const others = times.filter((_, k) => k !== i).concat([0, HALF_MIN, GAME_MIN]);
  let t = Math.round((times[i] + by) * 60) / 60;
  if (t <= 0.25 || t >= GAME_MIN - 0.25) return;
  if (others.some(o => Math.abs(o - t) < 0.25)) return;    // keep shifts at least 15s long
  times[i] = t;
  reblockDraft(times);
}
function dropTime(i) {
  const times = timesOf(state.draft).slice().sort((a, c) => a - c);
  times.splice(i, 1);
  reblockDraft(times);
}
// Add a sub in the middle of the longest shift
function addTime() {
  const d = state.draft;
  const sch = schedOf(d);
  let best = 0, bestLen = 0;
  for (let i = 0; i < sch.length; i++) {
    const L = blockLen(sch, i);
    if (L > bestLen) { bestLen = L; best = i; }
  }
  if (bestLen < 0.75) return;
  const mid = Math.round((blockStart(sch, best) + bestLen / 2) * 60) / 60;
  reblockDraft(timesOf(d).concat(mid));
}

function setDraftSubs(S) {
  const d = state.draft;
  if (!d || S < MIN_SUBS || S > MAX_SUBS) return;
  const ids = presentIds();
  const first = d.blocks[0] ? Object.values(d.blocks[0].slots).filter(id => ids.includes(id)) : [];
  const gk0 = d.blocks[0] && ids.includes(d.blocks[0].slots.GK) ? d.blocks[0].slots.GK : null;
  d.subsPerHalf = S;
  d.block = 0;
  reblockDraft(evenTimes(S));
}

function savePlan() {
  const d = state.draft;
  if (!d) return;
  d.name = (d.name || '').trim() || 'Game plan ' + (state.plans.length + 1);
  const rec = {
    id: d.id || 'pl' + Date.now(), name: d.name, subsPerHalf: d.subsPerHalf, times: timesOf(d),
    playerIds: presentIds().slice(),
    blocks: d.blocks.map(b => ({ index: b.index, slots: Object.assign({}, b.slots) })),
    savedAt: new Date().toISOString().slice(0, 10),
  };
  const at = state.plans.findIndex(p => p.id === rec.id);
  if (at >= 0) state.plans[at] = rec; else state.plans.push(rec);
  d.id = rec.id;
  state.activePlanId = rec.id;
  save();
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
  const pm = posMinsNow();
  $('summary-table').innerHTML = '<tr><th>Player</th><th>vs. fair</th><th>Minutes</th></tr>' + ids.map(id => {
    const d = minutes[id] - shares[id];
    const note = partTime.includes(id) ? ' (' + fmtMin(availableMin(id)) + ' avail.)' : '';
    return '<tr><td>' + esc(nameOf(id)) + (note ? ' <span class="muted">' + esc(note.trim()) + '</span>' : '') +
      posLineHtml(pm[id], prefsOf(id)) + '</td>' +
      '<td class="' + (d < -0.5 ? 'neg' : d > 0.5 ? 'pos' : '') + '">' + (d >= 0 ? '+' : '−') + fmtClock(Math.abs(d)) + '</td>' +
      '<td>' + fmtMin(minutes[id]) + '</td></tr>';
  }).join('');
  show('summary');
}

// ---------- Season ----------
// "CM 18:45  W 12:30", biggest first
function posLineHtml(pm, prefs) {
  const keys = Object.keys(pm || {}).filter(k => pm[k] > 0.05).sort((a, c) => pm[c] - pm[a]);
  if (!keys.length) return '';
  return '<small class="posline">' + keys.map(k =>
    '<span class="' + (prefs && prefs.length && !prefs.includes(k) ? 'offpref' : '') + '">' +
    esc(posLabel(k)) + ' ' + fmtMin(pm[k]) + '</span>').join(' ') + '</small>';
}

const signed = d => (d >= 0 ? '+' : '−') + fmtClock(Math.abs(d));
const signCls = d => (d < -0.5 ? 'neg' : d > 0.5 ? 'pos' : '');

function renderSeason() {
  const games = state.history;
  const played = {}, totalMin = {};
  games.forEach(h => Object.keys(h.minutes).forEach(id => { played[id] = (played[id] || 0) + 1; totalMin[id] = (totalMin[id] || 0) + h.minutes[id]; }));
  const seasonPos = seasonPosMinsAll();
  const rows = state.roster.map(p => ({ p, d: state.carryOver[p.id] || 0 })).sort((a, c) => a.d - c.d);
  $('season-table').innerHTML = '<tr><th>Player</th><th>Games</th><th>Avg min</th><th>vs. fair</th></tr>' + rows.map(({ p, d }) =>
    '<tr><td>' + esc(p.name) + '</td><td>' + (played[p.id] || 0) + '</td>' +
    '<td>' + (played[p.id] ? fmtMin(totalMin[p.id] / played[p.id]) : '—') + '</td>' +
    '<td class="' + signCls(d) + '">' + signed(d) + '</td></tr>').join('');

  // Time by position: a column per position, red where it is not one the player is marked for
  const byPos = state.roster.map(p => {
    const pm = seasonPos[p.id] || {};
    const total = POS.reduce((a, P) => a + (pm[P.id] || 0), 0);
    return { p, pm, total };
  }).sort((a, c) => c.total - a.total);
  $('season-pos-table').innerHTML =
    '<tr><th>Player</th>' + POS.map(P => '<th>' + esc(P.label) + '</th>').join('') + '<th>Total</th></tr>' +
    byPos.map(({ p, pm, total }) =>
      '<tr><td>' + esc(p.name) + '</td>' + POS.map(P => {
        const m = pm[P.id] || 0;
        const off = m > 0.05 && p.prefs.length && !p.prefs.includes(P.id);
        return '<td class="' + (off ? 'neg' : m > 0.05 ? '' : 'zero') + '">' + (m > 0.05 ? fmtMin(m) : '—') + '</td>';
      }).join('') + '<td class="total">' + (total > 0.05 ? fmtMin(total) : '—') + '</td></tr>').join('');
  $('btn-export').disabled = !games.length;
  $('season-games').textContent = games.length + ' game' + (games.length === 1 ? '' : 's') + ' saved';
  $('game-list').innerHTML = games.length ? [...games].reverse().map((h, i) => {
    const vals = Object.values(h.minutes);
    const spread = vals.length ? Math.max(...vals) - Math.min(...vals) : 0;
    const n = games.length - i;
    return '<li data-game="' + esc(h.id || String(games.length - 1 - i)) + '"><span class="name">Game ' + n + ' · ' + esc(h.date) + '</span>' +
      '<span class="muted">' + Object.keys(h.minutes).length + ' players, ' + (h.subsPerHalf || '?') + ' subs per half, gap ' + fmtClock(spread) + '</span><span class="chev">›</span></li>';
  }).join('') : '<li class="muted">No games saved yet.</li>';
}

// ---------- CSV export ----------
const csvCell = v => {
  const t = String(v == null ? '' : v);
  return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
};
const csvMin = m => (Math.round((m || 0) * 100) / 100).toFixed(2);

// One row per player per game, then a season total per player. Minutes are decimal so
// they add up in a spreadsheet.
const CSV_HEAD = ['Game', 'Date', 'Subs per half', 'Player ID', 'Player',
  'Minutes', 'Fair share', 'Difference', 'Available'].concat(POS.map(P => P.label));

function seasonCsv() {
  const rows = [CSV_HEAD];
  state.history.forEach((h, i) => {
    const ids = h.players || Object.keys(h.minutes);
    ids.forEach(id => {
      const pm = (h.posMinutes || {})[id] || {};
      const name = (h.names || {})[id] || nameOf(id);
      rows.push([i + 1, h.date, h.subsPerHalf || '', id, name,
        csvMin(h.minutes[id]), csvMin((h.shares || {})[id]),
        csvMin(h.minutes[id] - ((h.shares || {})[id] || 0)), csvMin((h.avail || {})[id])]
        .concat(POS.map(P => csvMin(pm[P.id] || 0))));
    });
  });
  // Season totals at the end, so the file reads on its own. Import skips these rows.
  const seasonPos = seasonPosMinsAll();
  state.roster.forEach(p => {
    let mins = 0, fair = 0, avail = 0, games = 0;
    state.history.forEach(h => {
      if (h.minutes[p.id] == null) return;
      games++; mins += h.minutes[p.id]; fair += (h.shares || {})[p.id] || 0; avail += (h.avail || {})[p.id] || 0;
    });
    if (!games) return;
    rows.push(['Season total', games + ' games', '', p.id, p.name,
      csvMin(mins), csvMin(fair), csvMin(mins - fair), csvMin(avail)]
      .concat(POS.map(P => csvMin((seasonPos[p.id] || {})[P.id] || 0))));
  });
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n');
}

// --- reading a season back in ---
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const src = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c !== ''));
}

// Rebuild game history from an exported file. Season totals are derived, so those rows
// are ignored. Throws with a plain message when the file isn't one of ours.
function seasonFromCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('That file is empty.');
  const head = rows[0].map(h => h.trim());
  const col = {};
  CSV_HEAD.forEach(h => { col[h] = head.indexOf(h); });
  ['Game', 'Date', 'Player ID', 'Player', 'Minutes'].forEach(h => {
    if (col[h] < 0) throw new Error('This does not look like a Game Time export — no “' + h + '” column.');
  });
  const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const byGame = new Map();
  rows.slice(1).forEach(r => {
    const tag = (r[col.Game] || '').trim();
    if (!/^\d+$/.test(tag)) return;                     // skip the season-total rows
    if (!byGame.has(tag)) byGame.set(tag, {
      id: 'g' + tag + '-' + Date.now(), date: (r[col.Date] || '').trim(),
      subsPerHalf: num(r[col['Subs per half']]) || 3,
      players: [], names: {}, minutes: {}, shares: {}, avail: {}, posMinutes: {}, prefs: {},
      plan: [], log: [],
    });
    const g = byGame.get(tag);
    const id = (r[col['Player ID']] || '').trim() || 'p?' + g.players.length;
    if (g.players.includes(id)) return;
    g.players.push(id);
    g.names[id] = (r[col.Player] || '').trim();
    g.minutes[id] = num(r[col.Minutes]);
    g.shares[id] = col['Fair share'] >= 0 ? num(r[col['Fair share']]) : 0;
    g.avail[id] = col.Available >= 0 ? num(r[col.Available]) : GAME_MIN;
    const pm = {};
    POS.forEach(P => { const v = col[P.label] >= 0 ? num(r[col[P.label]]) : 0; if (v > 0) pm[P.id] = v; });
    g.posMinutes[id] = pm;
    g.prefs[id] = (byId(id) || {}).prefs || [];
  });
  const games = [...byGame.entries()].sort((a, c) => +a[0] - +c[0]).map(e => e[1]);
  if (!games.length) throw new Error('No games found in that file.');
  return games;
}

// Share sheet first (best on a phone), then a download, then copy-and-paste.
async function handOff(text, filename, mime, fallback) {
  try {
    const file = new File([text], filename, { type: mime });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: filename });
      return;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
  }
  try {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return;
  } catch (e) { /* fall through */ }
  fallback(text);
}

// A standalone sheet the coach can open and print: the whole grid in colour plus the
// written run of subs. Self-contained so it works from Files, Mail or a browser tab.
function planSheetHtml(pl) {
  const sch = schedOf(pl), HI = halfIndex(sch);
  const blocks = pl.blocks.map(b => {
    const slots = b.slots || {};
    const on = Object.values(slots);
    return {
      index: b.index, half: b.index < HI ? 1 : 2,
      start: blockStart(sch, b.index), end: blockEnd(sch, b.index),
      on, gk: slots.GK, slots, bench: [],
    };
  });
  const used = new Set();
  blocks.forEach(b => b.on.forEach(id => used.add(id)));
  const ids = state.roster.filter(p => used.has(p.id)).map(p => p.id);
  const totals = planMinutes(blocks, sch);
  ids.forEach(id => { totals[id] = totals[id] || 0; });
  const vals = ids.map(id => totals[id]);
  const gap = vals.length ? Math.max(...vals) - Math.min(...vals) : 0;
  const subTimes = timesOf(pl).slice().sort((a, c) => a - c);

  const css = [
    'body{font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:#000;margin:24px;}',
    'h1{font-size:26px;margin:0 0 2px;}',
    '.meta{color:#3d4a41;margin:0 0 14px;}',
    'table{border-collapse:collapse;font-size:12px;white-space:nowrap;margin-bottom:16px;}',
    'th,td{padding:5px 7px;text-align:center;border-bottom:1px solid #c9d3c8;}',
    'th{font-weight:700;color:#3d4a41;}',
    'td.player{text-align:left;font-weight:600;}',
    'td.on{background:#e3f4e8;color:#0e4f2b;font-weight:700;}',
    'td.gk{background:#fff4c2;color:#5a4400;font-weight:700;}',
    'td.total{font-weight:700;}',
    'th.half-start,td.half-start{border-left:2px solid #3d4a41;}',
    'th.now,td.now{}',
    'ol{padding-left:20px;font-size:13px;}li{margin:5px 0;}',
    'b{color:#0e4f2b;}.off{color:#d7263d;font-weight:700;}.on{color:#1e9e55;font-weight:700;}',
    '@media print{body{margin:10mm;} *{-webkit-print-color-adjust:exact;print-color-adjust:exact;}}',
  ].join('');

  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + esc(pl.name) + '</title><style>' + css + '</style></head><body>' +
    '<h1>' + esc(pl.name) + '</h1>' +
    '<p class="meta">' + ids.length + ' players · ' + blockCount(sch) + ' shifts · ' +
      subTimes.length + ' subs plus halftime · gap ' + fmtClock(gap) + '<br>' +
      'Subs at ' + (subTimes.length ? subTimes.map(atClock).join(', ') + ', ' : '') + 'halftime. ' +
      'Water breaks at ' + WATER_TIMES.map(atClock).join(' and ') + '.</p>' +
    '<table>' + planGridHtml(ids, blocks, sch, totals, -1) + '</table>' +
    '<ol>' + planSwapsHtml(blocks, sch) + '</ol>' +
    '</body></html>';
}

// --- sharing a game plan so another phone can load it ---
const slugName = n => (String(n).replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '-') || 'game-plan');
function planFile(pl) {
  const used = new Set();
  pl.blocks.forEach(b => Object.values(b.slots || {}).forEach(id => used.add(id)));
  return JSON.stringify({
    app: 'game-time', kind: 'plan', v: 1,
    plan: { name: pl.name, subsPerHalf: pl.subsPerHalf, times: timesOf(pl), blocks: pl.blocks, savedAt: pl.savedAt },
    players: [...used].map(id => {
      const p = byId(id) || {};
      return { id, name: p.name || id, prefs: (p.prefs || []).slice() };
    }),
  }, null, 2);
}

// Take a shared plan in: match its players to this phone's roster by id, then by name,
// and rename any that don't line up so the plan still reads correctly.
function importPlanFile(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { alert('That file is not a game plan.'); return false; }
  if (!data || data.kind !== 'plan' || !data.plan || !Array.isArray(data.plan.blocks)) {
    alert('That file is not a game plan.'); return false;
  }
  const map = {}, renamed = [], missing = [];
  (data.players || []).forEach(sp => {
    let mine = byId(sp.id);
    if (!mine || mine.name !== sp.name) {
      const byName = state.roster.find(p => p.name.toLowerCase() === String(sp.name).toLowerCase());
      if (byName) mine = byName;
    }
    if (mine) { map[sp.id] = mine.id; if (mine.name !== sp.name) renamed.push(sp.name + ' → ' + mine.name); }
    else missing.push(sp.name);
  });
  const blocks = data.plan.blocks.map(b => {
    const slots = {};
    Object.keys(b.slots || {}).forEach(sid => { const to = map[b.slots[sid]]; if (to) slots[sid] = to; });
    return { index: b.index, slots };
  });
  const note = (renamed.length ? '\n\nMatched by name: ' + renamed.join(', ') : '') +
    (missing.length ? '\n\nNot on your roster, their spots will be filled: ' + missing.join(', ') : '');
  if (!confirm('Add “' + (data.plan.name || 'Shared plan') + '” to your plans?' + note)) return false;
  const rec = {
    id: 'pl' + Date.now(), name: (data.plan.name || 'Shared plan').slice(0, 40),
    subsPerHalf: data.plan.subsPerHalf || 3, times: data.plan.times, playerIds: [...new Set(Object.values(map))],
    blocks, savedAt: new Date().toISOString().slice(0, 10),
  };
  state.plans.push(rec);
  state.activePlanId = rec.id;
  save(); renderSetup();
  alert('“' + rec.name + '” added and selected for today.');
  return true;
}

async function exportSeasonCsv() {
  if (!state.history.length) return;
  await handOff(seasonCsv(), 'game-time-season-' + new Date().toISOString().slice(0, 10) + '.csv',
    'text/csv', showCsvText);
}
function importSeasonCsv(text) {
  let games;
  try { games = seasonFromCsv(text); }
  catch (e) { alert(e.message); return false; }
  const players = new Set();
  games.forEach(g => g.players.forEach(id => players.add(id)));
  if (!confirm('Import ' + games.length + ' game' + (games.length === 1 ? '' : 's') + ' for ' +
      players.size + ' players?\n\nThis replaces the season history on this phone. The sub-by-sub log is not in a CSV, so imported games show totals and positions only.')) return false;
  state.history = games;
  recomputeCarryOver();
  save();
  renderSeason();
  alert('Imported ' + games.length + ' game' + (games.length === 1 ? '' : 's') + '.');
  return true;
}

function showCsvText(csv) {
  $('csv-text').value = csv;
  $('csv-modal').hidden = false;
}

// Season position totals for everyone on the roster
function seasonPosMinsAll() {
  const out = {};
  state.roster.forEach(p => { out[p.id] = {}; });
  state.history.forEach(h => {
    Object.keys(h.posMinutes || {}).forEach(id => {
      if (!out[id]) out[id] = {};
      Object.keys(h.posMinutes[id]).forEach(g => { out[id][g] = (out[id][g] || 0) + h.posMinutes[id][g]; });
    });
  });
  return out;
}

function gameByKey(key) {
  return state.history.find((h, i) => (h.id || String(i)) === key);
}

function renderGameDetail(key) {
  const h = gameByKey(key);
  if (!h) return;
  const S = h.subsPerHalf || 3;
  const sch = h.sch && h.sch.length ? h.sch : schedule(h.times || evenTimes(S));
  const HI = halfIndex(sch);
  const ids = (h.players || Object.keys(h.minutes)).slice();
  const name = id => (h.names && h.names[id]) || nameOf(id);
  const idx = state.history.indexOf(h);
  $('gd-title').textContent = 'Game ' + (idx + 1) + ' · ' + h.date;
  const vals = ids.map(id => h.minutes[id]);
  const spread = vals.length ? Math.max(...vals) - Math.min(...vals) : 0;
  const keepers = [...new Set((h.log || []).map(e => e.gk).filter(Boolean))].map(name);
  $('gd-meta').textContent = ids.length + ' players, ' + (blockCount(sch) - 1) + ' subs including halftime. Gap between most and least: ' + fmtClock(spread) + '.' +
    (keepers.length ? ' Keepers: ' + keepers.join(' → ') + '.' : '');

  // Actual lineups per block, from the log (lineup in effect at the block's midpoint)
  const log = h.log || [];
  const B = blockCount(sch);
  const blocks = [];
  for (let b = 0; b < B; b++) {
    const mid = (blockStart(sch, b) + blockEnd(sch, b)) / 2;
    const entry = [...log].reverse().find(e => e.slots && e.t <= mid + 1e-6) || log[0];
    if (!entry) break;
    blocks.push({ index: b, half: b < HI ? 1 : 2, start: blockStart(sch, b), end: blockEnd(sch, b), on: entry.on, gk: entry.gk, slots: entry.slots || {}, bench: ids.filter(id => !entry.on.includes(id)) });
  }
  window.__nameOverride = name;
  $('gd-actual-grid').innerHTML = blocks.length ? planGridHtml(ids, blocks, sch, h.minutes, -1) : '<tr><td class="muted">No lineup log for this game.</td></tr>';
  // Sub log: every lineup change with time
  $('gd-log').innerHTML = log.map((e, i) => {
    if (i === 0) return '<li><b>Kickoff</b> — ' + e.on.map(name).map(esc).join(', ') + (e.gk ? ' · GK ' + esc(name(e.gk)) : '') + '</li>';
    const prev = log[i - 1];
    const d = { off: prev.on.filter(id => !e.on.includes(id)), on: e.on.filter(id => !prev.on.includes(id)), gk: e.gk !== prev.gk ? e.gk : null };
    return '<li><b>' + (Math.abs(e.t - HALF_MIN) < 1e-6 ? 'Halftime' : atClock(e.t)) + '</b> — ' + swapLineHtml(d) + '</li>';
  }).join('') || '<li class="muted">No subs recorded.</li>';
  // Planned grid (what the app suggested before kickoff)
  const plan = (h.plan || []).map(b => {
    const slots = b.slots || {};
    const on = b.on || Object.values(slots);
    return { index: b.index, half: b.index < HI ? 1 : 2, start: blockStart(sch, b.index), end: blockEnd(sch, b.index), on, gk: b.gk || slots.GK, slots, bench: [] };
  });
  const planTotals = planMinutes(plan, sch);
  ids.forEach(id => { planTotals[id] = planTotals[id] || 0; });
  $('gd-plan-grid').innerHTML = plan.length ? planGridHtml(ids, plan, sch, planTotals, -1) : '<tr><td class="muted">No plan saved for this game.</td></tr>';
  window.__nameOverride = null;
  // Playtime table
  const sorted = ids.slice().sort((a, c) => h.minutes[c] - h.minutes[a]);
  const partTime = id => h.avail && Math.abs(h.avail[id] - GAME_MIN) > 0.5;
  $('gd-table').innerHTML = '<tr><th>Player</th><th>vs. fair</th><th>Minutes</th></tr>' + sorted.map(id => {
    const d = h.minutes[id] - (h.shares[id] || 0);
    return '<tr><td>' + esc(name(id)) + (partTime(id) ? ' <span class="muted">(' + fmtMin(h.avail[id]) + ' avail.)</span>' : '') +
      posLineHtml((h.posMinutes || {})[id], (h.prefs || {})[id]) + '</td>' +
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
  else if (t.dataset.act === 'pos') togglePos(p, t.dataset.pos);
  else if (t.dataset.act === 'edit') state.editRow = state.editRow === p.id ? null : p.id;
  else if (t.dataset.act === 'rename') {
    const name = prompt('Player name', p.name);
    if (name && name.trim()) p.name = name.trim().slice(0, 24);
  }
  save();
  // changing who's available reshapes every block of the plan being edited
  if (t.dataset.act === 'present' && state.draft) adaptDraftToSquad();
  renderPlanner();
});
$('use-carry').addEventListener('change', e => { state.useCarryOver = e.target.checked; save(); renderPlanner(); });
$('btn-plan').addEventListener('click', () => {
  if ($('plan-card').hidden) renderPlan(); else $('plan-card').hidden = true;
  $('btn-plan').textContent = $('plan-card').hidden ? 'Show whole plan' : 'Hide whole plan';
});
$('btn-start').addEventListener('click', () => {
  primeAudio();
  newGame();
  show('game');
  renderGame();
});
$('btn-season').addEventListener('click', () => { renderSeason(); show('season'); });
// ---- game plans ----
$('plan-list').addEventListener('click', e => {
  const open = e.target.closest('[data-open]');
  const li = e.target.closest('[data-plan]');
  const pl = planById(open ? open.dataset.open : li && li.dataset.plan);
  if (!pl) return;
  state.activePlanId = pl.id;
  save();
  if (open) { newDraft(pl); renderPlanner(); show('planner'); }
  else renderSetup();
});
$('btn-plan-new').addEventListener('click', () => {
  state.activePlanId = null;
  newDraft(null); renderPlanner(); show('planner');
});
$('btn-planner-back').addEventListener('click', () => { renderSetup(); show('setup'); });
$('btn-planner-rename').addEventListener('click', () => {
  const d = state.draft; if (!d) return;
  const n = prompt('Name this plan', d.name || '');
  if (n && n.trim()) { d.name = n.trim().slice(0, 40); save(); renderPlanner(); }
});
$('planner-tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-block]');
  if (!b) return;
  state.draft.block = +b.dataset.block; state.draft.sel = null;
  save(); renderPlanner();
});
$('planner-pitch').addEventListener('click', e => {
  const d = state.draft; if (!d) return;
  const cur = d.blocks.find(b => b.index === d.block);
  const spot = e.target.closest('[data-slot]');
  const chip = e.target.closest('[data-bench]');
  if (spot) d.sel = slotTap(cur.slots, d.sel, spot.dataset.slot);
  else if (chip) d.sel = benchTap(cur.slots, d.sel, chip.dataset.bench);
  else return;
  d.filled = null;
  save(); renderPlanner();
});
$('times-list').addEventListener('click', e => {
  const n = e.target.closest('[data-nudge]');
  if (n) { nudgeTime(+n.dataset.nudge, +n.dataset.by); renderPlanner(); return; }
  const d = e.target.closest('[data-drop]');
  if (d) { dropTime(+d.dataset.drop); renderPlanner(); }
});
$('btn-time-add').addEventListener('click', () => { addTime(); renderPlanner(); });
$('psubs-minus').addEventListener('click', () => { setDraftSubs(state.draft.subsPerHalf - 1); renderPlanner(); });
$('psubs-plus').addEventListener('click', () => { setDraftSubs(state.draft.subsPerHalf + 1); renderPlanner(); });
// Ask for a file, and fall back to pasting when the picker is unavailable
let pendingImport = null;
function askForFile(kind) {
  pendingImport = kind;
  const inp = $('file-input');
  inp.value = '';
  try { inp.click(); } catch (e) { openPaste(kind); }
}
function openPaste(kind) {
  pendingImport = kind;
  $('paste-title').textContent = kind === 'plan' ? 'Paste a game plan' : 'Paste season data';
  $('paste-hint').textContent = kind === 'plan'
    ? 'Paste the contents of a shared plan file.'
    : 'Paste the contents of an exported CSV.';
  $('paste-text').value = '';
  $('paste-modal').hidden = false;
}
function takeImport(text) {
  const ok = pendingImport === 'plan' ? importPlanFile(text) : importSeasonCsv(text);
  if (ok) { $('paste-modal').hidden = true; if (pendingImport === 'plan') show('setup'); }
}
$('file-input').addEventListener('change', e => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => takeImport(String(r.result));
  r.onerror = () => openPaste(pendingImport);
  r.readAsText(f);
});
$('btn-paste-go').addEventListener('click', () => {
  const v = $('paste-text').value.trim();
  if (v) takeImport(v);
});
$('btn-paste-close').addEventListener('click', () => { $('paste-modal').hidden = true; });
$('btn-plan-import').addEventListener('click', () => askForFile('plan'));
$('btn-import').addEventListener('click', () => askForFile('season'));
$('btn-planner-share').addEventListener('click', async () => {
  const pl = planById(state.draft && state.draft.id);
  if (!pl) return;
  await handOff(planFile(pl), slugName(pl.name) + '.json',
    'application/json', txt => { $('paste-title').textContent = 'Game plan'; $('paste-hint').textContent = 'Copy this and send it to the other coach.'; $('paste-text').value = txt; $('paste-modal').hidden = false; $('btn-paste-go').hidden = true; });
});
$('btn-planner-print').addEventListener('click', async () => {
  const pl = planById(state.draft && state.draft.id);
  if (!pl) return;
  const html = planSheetHtml(pl);
  const file = slugName(pl.name) + '-plan.html';
  await handOff(html, file, 'text/html', txt => {
    // Last resort: open it in a tab so it can be printed from there
    try {
      const w = window.open('', '_blank');
      if (w) { w.document.write(txt); w.document.close(); return; }
    } catch (e) { /* ignore */ }
    $('paste-title').textContent = 'Plan sheet';
    $('paste-hint').textContent = 'Copy this into a file ending in .html, then open and print it.';
    $('paste-text').value = txt;
    $('btn-paste-go').hidden = true;
    $('paste-modal').hidden = false;
  });
});
$('btn-planner-fill').addEventListener('click', () => { autoFillFrom(state.draft.block); renderPlanner(); });
$('btn-planner-save').addEventListener('click', () => { savePlan(); renderSetup(); show('setup'); });
$('btn-planner-delete').addEventListener('click', () => {
  const d = state.draft;
  if (!d || !d.id || !confirm('Delete this plan?')) return;
  state.plans = state.plans.filter(p => p.id !== d.id);
  if (state.activePlanId === d.id) state.activePlanId = null;
  state.draft = null; save(); renderSetup(); show('setup');
});
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
$('btn-export').addEventListener('click', exportSeasonCsv);
$('btn-csv-copy').addEventListener('click', async () => {
  const ta = $('csv-text');
  ta.select();
  try { await navigator.clipboard.writeText(ta.value); $('btn-csv-copy').textContent = 'Copied'; }
  catch (e) { document.execCommand && document.execCommand('copy'); $('btn-csv-copy').textContent = 'Copied'; }
  setTimeout(() => { $('btn-csv-copy').textContent = 'Copy'; }, 2000);
});
$('btn-csv-close').addEventListener('click', () => { $('csv-modal').hidden = true; });
$('btn-season-reset').addEventListener('click', () => {
  if (confirm('Clear all saved games and carry-over?')) { state.carryOver = {}; state.history = []; save(); renderSeason(); }
});

$('btn-clock').addEventListener('click', () => {
  primeAudio();
  const g = state.game;
  if (g.running) pauseClock(); else startClock();
  renderGame();
});
$('btn-break').addEventListener('click', () => {
  const g = state.game;
  if (!g) return;
  if (g.phase === 'halftime') playOn();
  else if (g.breakLabel) startClock();
  else takeBreak('Water break');
  renderGame();
});
$('btn-rebalance').addEventListener('click', () => {
  if (confirm('Even out the rest of the plan from the minutes played so far?')) { replanRemaining(); renderGame(); }
});
$('btn-end').addEventListener('click', () => { if (confirm('End the game now?')) endGame(); });
$('btn-attendance').addEventListener('click', () => { renderModal(); $('modal').hidden = false; });
$('modal-close').addEventListener('click', () => { $('modal').hidden = true; });
$('modal-list').addEventListener('click', e => {
  const t = e.target.closest('[data-act]');
  if (t) toggleMidGame(t.dataset.id);
});
$('modal-note').addEventListener('click', e => {
  if (e.target.id === 'btn-work-in') { replanRemaining(); renderModal(); renderGame(); }
});
$('arrival-note').addEventListener('click', e => {
  if (e.target.id === 'btn-work-in-2') { replanRemaining(); renderGame(); }
});
$('banner-apply').addEventListener('click', () => { applyPending(); renderGame(); });
$('banner-dismiss').addEventListener('click', () => { state.game.pending = null; save(); renderGame(); });
$('clock-preview').addEventListener('click', e => {
  const g = state.game;
  if (e.target.id === 'btn-edit-done') { g.nextOverride = null; g.editNext = false; g.editSel = null; save(); renderGame(); }
  else if (e.target.id === 'btn-edit-reset') {
    // Drop the edits first, so the forecast comes back with the plan's lineup and not our own
    g.nextOverride = null; g.editSel = null;
    const planned = liveForecast();
    startEditNext();
    if (planned && planned.next && g.nextOverride) {
      g.nextOverride.slots = Object.assign({}, planned.next.block.slots);
    }
    save(); renderGame();
  }
  else if (e.target.id === 'btn-edit-stage') { g.editNext = false; g.editSel = null; save(); renderGame(); }
  else if (e.target.id === 'btn-sub-now') subNow();
});
$('btn-edit-mode').addEventListener('click', () => {
  const g = state.game;
  if (g.editNext) { g.editNext = false; g.editSel = null; save(); renderGame(); } else startEditNext();
});
$('btn-live-plan').addEventListener('click', () => {
  const card = $('live-plan-card');
  card.hidden = !card.hidden;
  card.dataset.key = '';
  $('btn-live-plan').textContent = card.hidden ? 'Show plan' : 'Hide plan';
  renderGame();
});
$('pitch-wrap').addEventListener('click', e => {
  const spot = e.target.closest('[data-slot]');
  if (spot) { onPitchTap('slot', spot.dataset.slot); return; }
  const chip = e.target.closest('[data-bench]');
  if (chip) onPitchTap('bench', chip.dataset.bench);
});

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
