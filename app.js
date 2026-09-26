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
function planFrom({ ids, S, minutes, fromBlock = 0, onField, gk = null, h1gk = null, h2gk = null, starters = [], played = [], gkEligible, prefsOf, posMins, prevSlots }) {
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
  const pm = {};
  ids.forEach(id => { pm[id] = Object.assign({}, (posMins || {})[id]); });
  let lastSlots = prevSlots || null;

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
    const slots = assignSlots({ on: lineup, gk: nextGk, prefsOf, posMins: pm, prev: lastSlots });
    blocks.push({
      index: b, half, start: b * L, end: (b + 1) * L,
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
const activeStarters = () => state.starters.filter(id => byId(id) && byId(id).present).slice(0, ON_FIELD);
const activeStartGk = () => (activeStarters().includes(state.startGk) && byId(state.startGk).gk) ? state.startGk : null;
// Planner inputs for a fresh game from the setup screen
function kickoffPlanInputs() {
  const ids = presentIds();
  return {
    ids, S: state.subsPerHalf, minutes: seedMinutes(ids),
    starters: activeStarters(), h1gk: activeStartGk(), gkEligible: gkEligibleSet(),
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
    subsPerHalf: state.subsPerHalf,
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
function logLineup() {
  const g = state.game;
  if (!g) return;
  const on = Object.keys(g.players).filter(id => g.players[id].onField).sort();
  const last = g.log[g.log.length - 1];
  const slots = Object.assign({}, g.slots);
  if (last && last.gk === g.gk && last.on.join() === on.join()) { if (last) last.slots = slots; return; }
  g.log.push({ t: Math.round(elapsedMin() * 100) / 100, on, gk: g.gk, slots });
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
    g.lastAlertBlock = S + 1;
    alertUser();
    suggestForBlock(S + 1, 'Halftime');
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
function currentBlock(g) {
  const S = g.subsPerHalf;
  const b = blockAt(S, elapsedMin());
  if (g.phase === 'h1') return Math.min(b, S);
  if (g.phase === 'halftime') return S + 1;
  return Math.min(b, blockCount(S) - 1);
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
  const manual = validOverride(target, ids) || plannedBlock(target, ids, onField, minutes);
  if (manual) {
    const slots = manual.slots;
    const on2 = Object.values(slots);
    const gk2 = slots.GK || pickGk(target, on2, gk, minutes);
    const block = { index: target, half: target <= S ? 1 : 2, start: blockStart(S, target), end: blockStart(S, target + 1), on: on2, gk: gk2, bench: ids.filter(id => !on2.includes(id)), slots };
    return { block, diff: diffForSlots(slots, onField, gk), manual: true, fromPlan: !!manual.fromPlan, plan: null };
  }
  const plan = planFrom({
    ids, S, minutes, fromBlock: target, onField, gk, h1gk: g.h1gk, h2gk: g.h2gk, played: playedIds(ids),
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
  g.pending = null; g.selected = null;
  resyncSlots(desired);
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
  const after = ids.filter(id => g.players[id].onField && id !== outId).concat(inId);
  const slots = assignSlots({ on: after, gk: g.gk, prefsOf, posMins: livePosMins(ids), prev: g.slots });
  return { title: 'Suggested sub', off: [outId], on: [inId], gk: null, slots };
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
    players: ids, names, minutes, shares, avail, posMinutes, prefs,
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
    return '<button class="' + cls + '" style="left:' + sl.x + '%;top:' + sl.y + '%" data-slot="' + sl.id + '"' +
      (o.disabled ? ' disabled' : '') + '>' +
      '<span class="pos">' + esc(sl.label) + '</span>' +
      '<span class="who">' + (id ? esc(nameOf(id)) : '—') + '</span>' +
      (sub ? '<span class="sub">' + esc(sub) + '</span>' : '') + '</button>';
  }).join('');
  const benchIds = (o.bench || []).filter(id => !taken.includes(id));
  const bench = benchIds.map(id =>
    '<button class="bchip' + (o.selected === 'bench:' + id ? ' sel' : '') +
      (o.behind && o.behind[id] ? ' behind' : '') +
      (o.incoming && o.incoming.includes(id) ? ' incoming' : '') + '"' +
      ' data-bench="' + id + '"' + (o.disabled ? ' disabled' : '') + '>' +
      '<span class="who">' + esc(nameOf(id)) + '</span>' +
      (o.sub ? '<span class="sub">' + esc(o.sub(id)) + '</span>' : '') + '</button>').join('');
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
    (o.bench || []).join(','), o.selected || '', o.disabled ? 'd' : '',
    Object.keys(o.behind || {}).join(','), (o.incoming || []).join(','), (o.outgoing || []).join(','),
  ].join('|');
  if (el.dataset.pkey === key) {
    if (!o.sub) return;
    el.querySelectorAll('[data-slot]').forEach(b => {
      const id = (slots || {})[b.dataset.slot];
      const sp = b.querySelector('.sub');
      if (id && sp) { const t = o.sub(id); if (sp.textContent !== t) sp.textContent = t; }
    });
    el.querySelectorAll('[data-bench]').forEach(b => {
      const sp = b.querySelector('.sub');
      if (sp) { const t = o.sub(b.dataset.bench); if (sp.textContent !== t) sp.textContent = t; }
    });
    return;
  }
  el.dataset.pkey = key;
  el.innerHTML = pitchHtml(slots, o);
}

// ---------- Setup ----------
function renderSetup() {
  const ids = presentIds();
  const S = state.subsPerHalf;
  const n = ids.length, subs = Math.max(0, n - ON_FIELD);
  $('attendance-summary').textContent = n + ' here, ' + subs + ' sub' + (subs === 1 ? '' : 's') +
    (n >= ON_FIELD ? ', about ' + fmtMin(fairTarget(n)) + ' each' : '');
  const gkCount = state.roster.filter(p => p.present && p.prefs.includes('GK')).length;
  const noPos = state.roster.filter(p => p.present && !p.prefs.length).map(p => p.name);
  $('gk-hint').textContent = (gkCount === 0 ? 'No keepers listed, so anyone here may be put in goal. ' :
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

  $('subs-value').textContent = S;
  $('subs-minus').disabled = S <= MIN_SUBS;
  $('subs-plus').disabled = S >= MAX_SUBS;
  const times = subTimesInHalf(S);
  const water = waterBreakInHalf(S);
  $('subs-schedule').textContent = 'Subs at ' + times.map(t => fmtClock(t) + (t === water ? ' (water break)' : '')).join(', ') +
    ' in each half. Shifts of ' + fmtClock(blockLen(S)) + '.';
  renderPlans();
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

function renderPlans() {
  const act = activePlan();
  $('plan-active').textContent = act ? 'using “' + act.name + '”' : 'auto';
  $('plan-list').innerHTML = state.plans.length ? state.plans.map(pl =>
    '<li data-plan="' + esc(pl.id) + '"' + (pl.id === state.activePlanId ? ' class="on"' : '') + '>' +
    '<span class="name">' + esc(pl.name) + (pl.id === state.activePlanId ? ' ✓' : '') + '</span>' +
    '<span class="muted">' + pl.blocks.length + ' blocks, ' + pl.subsPerHalf + ' subs per half, saved ' + esc(pl.savedAt) + '</span>' +
    '<span class="chev">›</span></li>').join('') : '<li class="muted">No saved plans. The app will plan the rotation itself.</li>';
  const fit = $('plan-fit');
  if (!act) { fit.textContent = ''; fit.classList.remove('warn-text'); return; }
  const f = planFit(act);
  const bits = [];
  if (act.subsPerHalf !== state.subsPerHalf) bits.push('This plan uses ' + act.subsPerHalf + ' subs per half; today is set to ' + state.subsPerHalf + '.');
  if (f.missing.length) bits.push(f.missing.map(nameOf).join(', ') + (f.missing.length === 1 ? ' is' : ' are') + ' in the plan but not here — their spots get filled by whoever is available.');
  if (f.extra.length) bits.push(f.extra.map(nameOf).join(', ') + (f.extra.length === 1 ? ' is' : ' are') + ' here but not in the plan, so they only come on to cover a gap.');
  fit.textContent = bits.join(' ');
  fit.classList.toggle('warn-text', bits.length > 0);
}

function renderStarters() {
  const ids = presentIds();
  const chosen = activeStarters();
  const gkId = activeStartGk();
  const card = $('starters-card');
  if (ids.length < ON_FIELD || activePlan()) { card.hidden = true; return; }
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
  if (ids.length < ON_FIELD) { $('plan-card').hidden = true; return; }
  const act = activePlan();
  const S = act ? act.subsPerHalf : state.subsPerHalf;
  let blocks, totals;
  if (act) {
    // Show the saved plan as it will actually be played today
    const minutes = seedMinutes(ids);
    blocks = act.blocks.map(b => {
      const pb = plannedBlockFor(act, b.index, ids, minutes, null) || { slots: b.slots };
      const on = Object.values(pb.slots);
      return { index: b.index, half: b.index <= S ? 1 : 2, start: blockStart(S, b.index), end: blockStart(S, b.index + 1), on, gk: pb.slots.GK, slots: pb.slots, bench: ids.filter(id => !on.includes(id)) };
    });
    totals = planMinutes(blocks, S);
    ids.forEach(id => { totals[id] = totals[id] || 0; });
  } else {
    const seed = seedMinutes(ids);
    const plan = planFrom(kickoffPlanInputs());
    blocks = plan.blocks;
    totals = {};
    ids.forEach(id => { totals[id] = plan.projected[id] - seed[id]; });
  }
  $('plan-grid').innerHTML = planGridHtml(ids, blocks, S, totals, -1);
  $('plan-swaps').innerHTML = planSwapsHtml(blocks, S);
  $('plan-summary').textContent = (act ? act.name + ' — ' : '') + blockCount(S) + ' shifts of ' + fmtClock(blockLen(S));
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
  const key = [b, onField.join(','), gk, ids.join(','), g.h2gk, ovKey, g.followPlan ? 'p' : ''].join('|');
  const seed = seedMinutes(ids);
  const minutes = currentMinutes();
  const remain = Math.max(0, Math.min(blockStart(S, b + 1), GAME_MIN) - min);
  onField.forEach(id => { minutes[id] += remain; });
  const current = { index: b, half: b <= S ? 1 : 2, start: blockStart(S, b), end: blockStart(S, b + 1), on: onField, gk, bench: ids.filter(id => !onField.includes(id)), slots: g.slots || {} };
  let blocks = [current], next = null, projected = minutes;
  if (b + 1 < B) {
    const sub = subForBlock(b + 1, ids, onField, gk, minutes);
    next = { block: sub.block, diff: sub.diff, manual: sub.manual, fromPlan: sub.fromPlan };
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
          prefsOf, posMins: livePosMins(ids), prevSlots: sub.block.slots,
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
  const left = Math.max(0, GAME_MIN - min);
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
  const inHalf = g.phase === 'h1' ? min : g.phase === 'halftime' ? HALF_MIN : min - HALF_MIN;
  const b = currentBlock(g);
  const fullTime = g.phase === 'h2' && min >= GAME_MIN;
  const overHalf = g.phase === 'h1' && min >= HALF_MIN;

  const clock = document.querySelector('.clock');
  clock.classList.toggle('paused', !g.running && g.phase !== 'halftime');
  clock.classList.toggle('halftime', g.phase === 'halftime' || !!g.breakLabel);
  // The clock keeps counting past regulation; the pill says so
  $('clock-time').textContent = fmtClock(inHalf).padStart(5, '0');
  $('clock-half').textContent = g.phase === 'done' ? 'Final'
    : g.breakLabel ? g.breakLabel
    : g.phase === 'halftime' ? 'Halftime'
    : fullTime ? 'Full time'
    : overHalf ? '1st half +'
    : g.phase === 'h1' ? '1st half' : '2nd half';
  $('clock-block').textContent = g.phase === 'done' ? '' : 'Block ' + (b + 1) + '/' + blockCount(S);

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
    const nextBoundary = Math.min(blockStart(S, b + 1), g.phase === 'h1' ? HALF_MIN : GAME_MIN);
    const remain = Math.max(0, nextBoundary - min);
    const label = Math.abs(nextBoundary - HALF_MIN) < 1e-6 ? 'Halftime' : Math.abs(nextBoundary - GAME_MIN) < 1e-6 ? 'Full time' : 'Next sub';
    nextEl.textContent = label + ' in ' + fmtClock(remain);
    if (remain <= 1 && g.running) nextEl.classList.add('soon');
  }

  $('timeline-fill').style.width = Math.min(100, min / GAME_MIN * 100) + '%';
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
      const sp = document.createElement('span');
      sp.className = half ? 'half' : isWater ? 'water' : '';
      sp.style.left = (t / GAME_MIN * 100) + '%';
      marks.appendChild(sp);
    }
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
    $('banner').querySelector('.board-strip .muted').textContent = pb === S + 1 ? 'before the 2nd half' :
      'H' + (pb <= S ? 1 : 2) + ' ' + fmtClock(blockStart(S, pb) - (pb > S ? HALF_MIN : 0));
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
  const whenLabel = next ? (next.block.index === S + 1 ? 'at halftime' : 'at ' + fmtClock(next.block.start - (next.block.half === 2 ? HALF_MIN : 0)) + (next.block.half === 2 ? ' (2nd half)' : '')) : '';
  previewEl.classList.toggle('editing', !!g.editNext);
  if (g.editNext && next) {
    const hasChange = next.diff.off.length || next.diff.on.length || next.diff.gk;
    setHtml(previewEl, '<div class="board-strip"><span>Editing lineup</span>' +
      '<span class="edit-actions"><button class="link" id="btn-edit-reset">Use plan</button><button class="link" id="btn-edit-done">Cancel</button></span></div>' +
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
    setHtml($('live-plan-grid'), fc.totals ? planGridHtml(fc.ids, fc.blocks, S, fc.totals, fc.blocks[0].index) : '');
    setHtml($('live-plan-swaps'), fc.blocks.length > 1 ? planSwapsHtml(fc.blocks, S) : '<li>No more subs scheduled.</li>');
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
  const sub = id => {
    if (editing) {
      const here = slotOfPlayer(shown, id);
      if (!here) return g.players[id].onField ? 'coming off' : fmtMin(mins[id]);
      return g.players[id].onField ? fmtMin(mins[id]) : 'coming on';
    }
    const to = slotById(slotOfPlayer(nextSlots, id));
    if (nextOn.has(id) && to) return '→ ' + to.label;
    if (nextOff.has(id)) return 'off next';
    return fmtMin(mins[id]);
  };
  const benchIds = ids.filter(id => !Object.values(shown).includes(id));
  paintPitch($('pitch-wrap'), shown, {
    bench: benchIds, selected: editing ? g.editSel : null, behind, incoming, outgoing,
    sub, disabled: !editing && g.phase === 'done',
  });

  $('btn-edit-mode').hidden = !canEdit;
  $('btn-edit-mode').textContent = editing ? 'Done editing' : 'Edit lineup';
  $('btn-edit-mode').classList.toggle('primary', editing);
  $('btn-edit-mode').classList.toggle('secondary', !editing);
  $('btn-suggest').disabled = benchIds.length === 0 || editing;
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
  logLineup();
  save();
  renderModal();
  renderGame();
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
const planBlockLen = pl => blockLen(pl.subsPerHalf);

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
function planMinutes(blocks, S) {
  const L = blockLen(S), out = {};
  blocks.forEach(b => Object.values(b.slots || {}).forEach(id => { out[id] = (out[id] || 0) + L; }));
  return out;
}

function newDraft(fromPlan) {
  if (fromPlan) {
    state.draft = {
      id: fromPlan.id, name: fromPlan.name, subsPerHalf: fromPlan.subsPerHalf,
      blocks: fromPlan.blocks.map(b => ({ index: b.index, slots: Object.assign({}, b.slots) })),
      block: 0, sel: null,
    };
  } else {
    const plan = planFrom(kickoffPlanInputs());
    state.draft = {
      id: null, name: '', subsPerHalf: state.subsPerHalf,
      blocks: plan.blocks.map(b => ({ index: b.index, slots: Object.assign({}, b.slots) })),
      block: 0, sel: null,
    };
  }
  save();
}

// Re-run the planner for every block after `from`, seeded with the blocks already set
function autoFillFrom(from) {
  const d = state.draft;
  const S = d.subsPerHalf;
  const ids = presentIds();
  const kept = d.blocks.filter(b => b.index <= from);
  const minutes = seedMinutes(ids);
  const pm = seasonPosMins(ids);
  const L = blockLen(S);
  kept.forEach(b => Object.keys(b.slots).forEach(sid => {
    const pid = b.slots[sid];
    minutes[pid] = (minutes[pid] || 0) + L;
    const grp = slotById(sid).pos;
    pm[pid] = pm[pid] || {}; pm[pid][grp] = (pm[pid][grp] || 0) + L;
  }));
  const last = kept[kept.length - 1];
  const rest = planFrom({
    ids, S, minutes, fromBlock: from + 1,
    onField: Object.values(last.slots), gk: last.slots.GK,
    h1gk: kept.find(b => b.index <= S) ? kept[0].slots.GK : null,
    played: Object.keys(minutes).filter(id => minutes[id] > (seedMinutes(ids)[id] || 0)),
    gkEligible: gkEligibleSet(), prefsOf, posMins: pm, prevSlots: last.slots,
  });
  d.blocks = kept.concat(rest.blocks.map(b => ({ index: b.index, slots: Object.assign({}, b.slots) })));
  save();
}

function renderPlanner() {
  const d = state.draft;
  if (!d) return;
  const S = d.subsPerHalf, L = blockLen(S);
  const ids = presentIds();
  $('planner-title').textContent = d.name || 'New game plan';
  $('planner-tabs').innerHTML = d.blocks.map(b => {
    const inHalf = b.index * L - (b.index > S ? HALF_MIN : 0);
    return '<button class="tab' + (b.index === d.block ? ' on' : '') + (b.index === S + 1 ? ' half' : '') +
      '" data-block="' + b.index + '">' + (b.index === 0 ? 'H1 ' : b.index === S + 1 ? 'H2 ' : '') +
      fmtClock(inHalf) + '</button>';
  }).join('');
  const cur = d.blocks.find(b => b.index === d.block) || d.blocks[0];
  const water = waterBreakInHalf(S);
  const inHalf = cur.index * L - (cur.index > S ? HALF_MIN : 0);
  $('planner-when').textContent = 'Block ' + (cur.index + 1) + ' of ' + d.blocks.length + ' — ' +
    (cur.index > S ? '2nd half ' : '1st half ') + fmtClock(inHalf) + ' to ' + fmtClock(inHalf + L) +
    (Math.abs(inHalf - water) < 1e-6 ? ' (water break)' : '');
  const onNow = Object.values(cur.slots);
  const benchIds = ids.filter(id => !onNow.includes(id));
  paintPitch($('planner-pitch'), cur.slots, { bench: benchIds, selected: d.sel, sub: () => '' });

  const mins = planMinutes(d.blocks, S);
  const vals = ids.map(id => mins[id] || 0);
  const gap = vals.length ? Math.max(...vals) - Math.min(...vals) : 0;
  $('planner-gap').textContent = 'gap ' + fmtClock(gap);
  const sorted = ids.slice().sort((a, c) => (mins[c] || 0) - (mins[a] || 0));
  $('planner-mins').innerHTML = '<tr><th>Player</th><th>Minutes</th></tr>' + sorted.map(id =>
    '<tr><td>' + esc(nameOf(id)) + '</td><td>' + fmtMin(mins[id] || 0) + '</td></tr>').join('');
  $('btn-planner-delete').hidden = !d.id;
}

function savePlan() {
  const d = state.draft;
  if (!d) return;
  const name = (d.name || '').trim() || prompt('Name this plan', 'Game plan ' + (state.plans.length + 1));
  if (!name) return;
  d.name = name.trim().slice(0, 40);
  const rec = {
    id: d.id || 'pl' + Date.now(), name: d.name, subsPerHalf: d.subsPerHalf,
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
function seasonCsv() {
  const head = ['Game', 'Date', 'Player', 'Minutes', 'Fair share', 'Difference', 'Available']
    .concat(POS.map(P => P.label));
  const rows = [head];
  state.history.forEach((h, i) => {
    const ids = h.players || Object.keys(h.minutes);
    ids.forEach(id => {
      const pm = (h.posMinutes || {})[id] || {};
      const name = (h.names || {})[id] || nameOf(id);
      rows.push([i + 1, h.date, name, csvMin(h.minutes[id]), csvMin((h.shares || {})[id]),
        csvMin(h.minutes[id] - ((h.shares || {})[id] || 0)), csvMin((h.avail || {})[id])]
        .concat(POS.map(P => csvMin(pm[P.id] || 0))));
    });
  });
  const seasonPos = seasonPosMinsAll();
  state.roster.forEach(p => {
    let mins = 0, fair = 0, avail = 0, games = 0;
    state.history.forEach(h => {
      if (h.minutes[p.id] == null) return;
      games++; mins += h.minutes[p.id]; fair += (h.shares || {})[p.id] || 0; avail += (h.avail || {})[p.id] || 0;
    });
    if (!games) return;
    rows.push(['Season total', games + ' games', p.name, csvMin(mins), csvMin(fair), csvMin(mins - fair), csvMin(avail)]
      .concat(POS.map(P => csvMin((seasonPos[p.id] || {})[P.id] || 0))));
  });
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n');
}

async function exportSeasonCsv() {
  if (!state.history.length) return;
  const csv = seasonCsv();
  const name = 'game-time-season-' + new Date().toISOString().slice(0, 10) + '.csv';
  // Phones do best with the share sheet; fall back to a download, then to copy-and-paste
  try {
    const file = new File([csv], name, { type: 'text/csv' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Season data' });
      return;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
  }
  try {
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return;
  } catch (e) { /* fall through */ }
  showCsvText(csv);
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
    blocks.push({ index: b, half: b <= S ? 1 : 2, start: b * L, end: (b + 1) * L, on: entry.on, gk: entry.gk, slots: entry.slots || {}, bench: ids.filter(id => !entry.on.includes(id)) });
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
  const plan = (h.plan || []).map(b => ({ index: b.index, half: b.index <= S ? 1 : 2, start: b.index * L, end: (b.index + 1) * L, on: b.on, gk: b.gk, slots: b.slots || {}, bench: [] }));
  const planTotals = {};
  ids.forEach(id => { planTotals[id] = plan.filter(b => b.on.includes(id)).length * L; });
  $('gd-plan-grid').innerHTML = plan.length ? planGridHtml(ids, plan, S, planTotals, -1) : '<tr><td class="muted">No plan saved for this game.</td></tr>';
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
// ---- game plans ----
$('plan-list').addEventListener('click', e => {
  const li = e.target.closest('[data-plan]');
  if (!li) return;
  const pl = planById(li.dataset.plan);
  if (!pl) return;
  state.activePlanId = pl.id;
  newDraft(pl);
  save(); renderPlanner(); show('planner');
});
$('btn-plan-new').addEventListener('click', () => {
  if (presentIds().length < ON_FIELD) { alert('Mark at least ' + ON_FIELD + ' players here before building a plan.'); return; }
  newDraft(null); renderPlanner(); show('planner');
});
$('btn-plan-clear').addEventListener('click', () => { state.activePlanId = null; save(); renderSetup(); });
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
  save(); renderPlanner();
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
  if (e.target.id === 'btn-edit-done') { g.nextOverride = null; g.editNext = false; g.editSel = null; save(); renderGame(); }
  else if (e.target.id === 'btn-edit-reset') {
    const fc0 = liveForecast();
    g.nextOverride = null; g.editSel = null;
    startEditNext();
    if (fc0 && fc0.next) { g.nextOverride.slots = Object.assign({}, fc0.next.block.slots); save(); renderGame(); }
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
$('btn-suggest').addEventListener('click', () => { state.game.pending = adHocSuggestion(); save(); renderGame(); });
$('pitch-wrap').addEventListener('click', e => {
  const spot = e.target.closest('[data-slot]');
  if (spot) { onPitchTap('slot', spot.dataset.slot); return; }
  const chip = e.target.closest('[data-bench]');
  if (chip) onPitchTap('bench', chip.dataset.bench);
});

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
