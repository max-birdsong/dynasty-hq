// Builds the full model for every league: rosters, picks, FC + TAT values, projections, simulation, power rankings.
import * as api from './api.js';
import { state, settings, nick, latestTat, recordHistory } from './state.js';
import { parseLines, tierValues, valueRows, normName } from './tatparse.js';
import { startSlots, neededPositions, scoreStats, bestLineup } from './lineup.js';
import { simulate, DEFAULT_PARAMS } from './sim.js';
import { calibrate } from './calib.js';
import { pool, sum } from './util.js';

export const M = { ready: false, leagues: [], players: {}, season: null, week: 1, errors: [], projSource: 'sleeper' };
const ORD = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: '5th' };
const INJ_OUT = new Set(['IR', 'PUP', 'Sus', 'NA', 'DNR', 'COV']);

export const isPick = k => k.startsWith('k:');
export const pid = k => k.slice(2);

// ---------------- loading ----------------
export async function loadAll(progress = () => {}) {
  M.errors = [];
  progress('Sleeper state');
  const st = await api.nflState();
  M.season = st.league_season || st.season;
  M.week = st.season_type === 'regular' ? Math.max(1, st.week || 1) : st.season_type === 'post' ? 18 : 1;
  M.seasonType = st.season_type;

  progress('Finding your leagues');
  const me = await api.userByName(settings().username);
  if (!me) throw new Error(`Sleeper user "${settings().username}" not found`);
  M.me = me;
  const leagues = (await api.userLeagues(me.user_id, M.season)).filter(l => !settings().hidden.includes(l.league_id));

  progress('Player database');
  M.players = await api.players();

  progress('FantasyCalc values');
  const formats = new Map();
  for (const l of leagues) {
    const f = fmtOf(l);
    if (!formats.has(f.key)) formats.set(f.key, f);
  }
  formats.set('12-2-1', { key: '12-2-1', numTeams: 12, numQbs: 2, ppr: 1 }); // Sanderson's own format
  M.fc = {};
  await pool([...formats.values()], 3, async f => {
    try { M.fc[f.key] = indexFc(await api.fcValues(f.numTeams, f.numQbs, f.ppr)); }
    catch (e) { M.errors.push('FantasyCalc ' + f.key + ': ' + e.message); M.fc[f.key] = indexFc([]); }
  });

  progress('Projections');
  await loadProjections(leagues);

  progress('League data');
  M.leagues = (await pool(leagues, 3, l => buildLeague(l).catch(e => { M.errors.push(l.name + ': ' + e.message); return null; }))).filter(Boolean);
  M.leagues.sort((a, b) => a.nick.localeCompare(b.nick));

  applyTat();
  progress('Calibrating simulator on your leagues');
  const sources = M.leagues.map(L => ({ id: L.id, season: L.season, scoring: L.scoring, slots: L.slots, pastMatchups: L.pastMatchups, proj: M.projPast, current: true }));
  progress('Loading last season for calibration');
  try { sources.push(...await previousSeasons(M.leagues)); } catch (e) { console.warn('previous seasons', e); }
  M.calib = calibrate(sources, M.players, posOf);
  progress('Simulating seasons');
  for (const L of M.leagues) runSim(L);
  for (const L of M.leagues) { computePower(L); snapshotHistory(L); }
  await mergeSnapshots().catch(() => {});
  M.ready = true;
  M.loadedAt = new Date();
  return M;
}

function fmtOf(l) {
  const sf = (l.roster_positions || []).includes('SUPER_FLEX') || (l.roster_positions || []).filter(p => p === 'QB').length > 1;
  const ppr = l.scoring_settings?.rec ?? 1;
  const numTeams = l.total_rosters || l.settings?.num_teams || 12;
  return { key: `${numTeams}-${sf ? 2 : 1}-${ppr}`, numTeams, numQbs: sf ? 2 : 1, ppr };
}

function indexFc(arr) {
  const byId = new Map(), picks = new Map(), byName = new Map();
  for (const x of arr || []) {
    const p = x.player || {};
    if (p.position === 'PICK') { picks.set(p.name, x.value); continue; }
    const rec = { value: x.value, name: p.name, pos: p.position, age: p.maybeAge, team: p.maybeTeam, trend: x.trend30Day, rank: x.overallRank, redraft: x.redraftValue };
    if (p.sleeperId) byId.set(String(p.sleeperId), rec);
    byName.set(normName(p.name) + '|' + p.position, p.sleeperId ? String(p.sleeperId) : null);
  }
  return { byId, picks, byName };
}

// ---------------- projections ----------------
async function loadProjections(leagues) {
  const pos = new Set();
  for (const l of leagues) neededPositions(l.roster_positions || []).forEach(p => pos.add(p));
  const positions = [...pos];
  M.positions = positions;
  M.lastWeek = 17;
  M.proj = {};
  const weeks = [];
  for (let w = M.week; w <= M.lastWeek; w++) weeks.push(w);
  const res = await pool(weeks, 4, w => api.weekProjections(M.season, w, positions));
  weeks.forEach((w, i) => { if (res[i]) M.proj[w] = res[i]; });
  M.projSource = Object.keys(M.proj).length ? 'sleeper' : 'average';
  // projections for weeks already played, used to calibrate the simulator
  M.projPast = {};
  const past = []; for (let w = 1; w < M.week; w++) past.push(w);
  const pr = await pool(past, 4, w => api.weekProjections(M.season, w, positions, 30 * 86400e3).catch(() => null));
  past.forEach((w, i) => { if (pr[i]) M.projPast[w] = pr[i]; });
}

function posOf(id) {
  const p = M.players[id];
  if (!p) return [];
  return p.fantasy_positions?.length ? p.fantasy_positions : [p.position];
}

// Last season's leagues (linked through previous_league_id): far more data for calibrating the simulator,
// and full 14-week regular seasons, which matter most for measuring season-long error. Cached for a year.
async function previousSeasons(leagues) {
  const YEAR = 365 * 86400e3;
  const prevSeason = +M.season - 1;
  const prevs = leagues.map(L => L.lg.previous_league_id).filter(id => id && id !== '0');
  if (!prevs.length) return [];
  const lgs = (await pool(prevs, 3, id => api.league(id).catch(() => null))).filter(Boolean);
  const maxWeek = Math.max(...lgs.map(l => (l.settings?.playoff_week_start || 15) - 1));
  const weeks = Array.from({ length: maxWeek }, (_, i) => i + 1);
  const projArr = await pool(weeks, 4, w => api.weekProjections(prevSeason, w, M.positions, YEAR).catch(() => null));
  const proj = {}; weeks.forEach((w, i) => { if (projArr[i]) proj[w] = projArr[i]; });
  if (!Object.keys(proj).length) return [];
  const out = [];
  for (const l of lgs) {
    const n = (l.settings?.playoff_week_start || 15) - 1;
    const ws = Array.from({ length: n }, (_, i) => i + 1);
    const mus = await pool(ws, 4, w => api.matchups(l.league_id, w, true).catch(() => []));
    const pastMatchups = {}; ws.forEach((w, i) => { if (mus[i]?.length) pastMatchups[w] = mus[i]; });
    out.push({ id: l.league_id, season: String(prevSeason), scoring: l.scoring_settings || {}, slots: startSlots(l.roster_positions || []), pastMatchups, proj, current: false });
  }
  return out;
}

// ---------------- leagues ----------------
async function buildLeague(lg) {
  const id = lg.league_id;
  const [ros, us, tp] = await Promise.all([api.rosters(id), api.users(id), api.tradedPicks(id)]);
  const f = fmtOf(lg);
  const L = {
    id, lg, name: lg.name, nick: nick(id, lg.name), season: lg.season, fmt: f, fc: M.fc[f.key] || indexFc([]),
    numTeams: ros.length, slots: startSlots(lg.roster_positions || []), scoring: lg.scoring_settings || {},
    playoffStart: lg.settings?.playoff_week_start || 15, playoffTeams: lg.settings?.playoff_teams || 6,
    median: lg.settings?.league_average_match === 1, draftRounds: lg.settings?.draft_rounds || 4,
    draftOrder: settings().draftOrder?.[id] || 'maxpf',
    tradeDeadline: lg.settings?.trade_deadline, tp,
  };
  const uById = Object.fromEntries(us.map(u => [u.user_id, u]));
  L.users = uById;
  L.teams = ros.map(r => {
    const u = uById[r.owner_id] || {};
    const s = r.settings || {};
    return {
      rid: r.roster_id, ownerId: r.owner_id, coOwners: r.co_owners || [],
      owner: u.display_name || 'Orphan', teamName: u.metadata?.team_name || u.display_name || 'Team ' + r.roster_id,
      avatar: u.avatar, players: (r.players || []).map(String), reserve: r.reserve || [], taxi: r.taxi || [],
      wins: s.wins || 0, losses: s.losses || 0, ties: s.ties || 0,
      fpts: (s.fpts || 0) + (s.fpts_decimal || 0) / 100, fptsAgainst: (s.fpts_against || 0) + (s.fpts_against_decimal || 0) / 100,
      ppts: (s.ppts || 0) + (s.ppts_decimal || 0) / 100,
      isMe: r.owner_id === M.me.user_id || (r.co_owners || []).includes(M.me.user_id),
    };
  });
  L.byRid = Object.fromEntries(L.teams.map(t => [t.rid, t]));
  L.me = L.teams.find(t => t.isMe);

  // draft picks currently owned
  const yrs = pickYears(L);
  L.pickYears = yrs;
  for (const t of L.teams) t.picks = [];
  for (const y of yrs) for (let rd = 1; rd <= L.draftRounds; rd++) for (const t of L.teams) {
    const tr = tp.find(x => String(x.season) === String(y) && x.round === rd && x.roster_id === t.rid);
    const owner = tr ? tr.owner_id : t.rid;
    L.byRid[owner]?.picks.push(`k:${y}:${rd}:${t.rid}`);
  }

  // schedule + past weekly scores
  const weeks = [];
  for (let w = 1; w < L.playoffStart; w++) weeks.push(w);
  const mus = await pool(weeks, 4, w => api.matchups(id, w, w < M.week - 1).catch(() => []));
  L.schedule = {}; L.pastPts = {}; L.pastMatchups = {};
  weeks.forEach((w, i) => {
    const arr = mus[i] || [];
    if (w >= M.week) {
      const g = {};
      for (const m of arr) if (m.matchup_id != null) (g[m.matchup_id] ||= []).push(m.roster_id);
      L.schedule[w] = Object.values(g).map(p => [p[0], p[1] ?? null]);
    } else {
      L.pastMatchups[w] = arr;
      for (const m of arr) for (const [pl, pts] of Object.entries(m.players_points || {})) {
        (L.pastPts[pl] ||= []).push(pts);
      }
    }
  });
  L.regWeeks = weeks.filter(w => w >= M.week);
  computeWeekly(L);
  return L;
}

function pickYears(L) {
  const s = +L.season;
  const yrs = new Set([s + 1, s + 2]);
  for (const x of L.tp) if (+x.season > s) yrs.add(+x.season);
  if (L.lg.status === 'pre_draft' || L.lg.status === 'drafting') yrs.add(s);
  return [...yrs].sort().filter(y => y <= s + 3);
}

// points per player per week for this league
export function playerWeekPts(L, id, w) {
  const p = M.players[id];
  if (!p) return 0;
  const proj = M.proj[w];
  if (proj) return scoreStats(proj[id], L.scoring, p.position);
  if (INJ_OUT.has(p.injury_status) || (w === M.week && p.injury_status === 'Out')) return 0;
  const a = L.pastPts[id];
  return a && a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
}

export function teamWeekly(L, ids) {
  const out = {};
  for (let w = M.week; w <= M.lastWeek; w++) {
    const pts = {};
    for (const id of ids) pts[id] = playerWeekPts(L, id, w);
    out[w] = bestLineup(ids, pts, posOf, L.slots).total;
  }
  return out;
}

// For the injury model, per week: the players who matter (starters plus the best bench options), their projected
// points, each starter's value over his replacement, and the healthy lineup total.
export function teamInj(L, ids) {
  const out = {};
  const k = L.slots.length + 6;
  for (let w = M.week; w <= M.lastWeek; w++) {
    const pts = {};
    for (const id of ids) pts[id] = playerWeekPts(L, id, w);
    const cand = ids.filter(id => pts[id] > 0).sort((a, b) => pts[b] - pts[a]).slice(0, k);
    const best = bestLineup(cand, pts, posOf, L.slots);
    const drops = {}, pos = {};
    for (const id of cand) pos[id] = M.players[id]?.position || 'WR';
    for (const s of best.starters) drops[s] = Math.max(0, best.total - bestLineup(cand.filter(x => x !== s), pts, posOf, L.slots).total);
    out[w] = { cand, pts, pos, starters: best.starters, drops, total: best.total };
  }
  return out;
}

function computeWeekly(L) {
  L.weekly = {}; L.inj = {};
  for (const t of L.teams) { L.weekly[t.rid] = teamWeekly(L, t.players); L.inj[t.rid] = teamInj(L, t.players); }
}

export function startersNow(L, ids) {
  const w = Math.min(Math.max(M.week, 1), M.lastWeek);
  const pts = {}; for (const id of ids) pts[id] = playerWeekPts(L, id, w);
  return bestLineup(ids, pts, posOf, L.slots);
}

// ---------------- simulation ----------------
export function simInput(L, weeklyOverride = {}, injOverride = {}) {
  const adj = {};
  if (settings().sim.teamAdj && M.calib?.ok) for (const t of L.teams) adj[t.rid] = M.calib.teamAdj[L.id + ':' + t.rid]?.adj || 0;
  return {
    teams: L.teams.map(t => ({ rid: t.rid, wins: t.wins, losses: t.losses, ties: t.ties, fpts: t.fpts, ppts: t.ppts })),
    draftOrder: L.draftOrder,
    weekly: { ...L.weekly, ...weeklyOverride }, inj: { ...L.inj, ...injOverride }, adj,
    lineupFn: (ids, pts) => bestLineup(ids, pts, posOf, L.slots).total,
    schedule: L.schedule, regWeeks: L.regWeeks, firstWeek: M.week,
    playoffStart: L.playoffStart, playoffTeams: L.playoffTeams, median: L.median,
  };
}
export function simParams() {
  const s = settings().sim;
  const base = M.calib?.ok && s.useCalibration ? M.calib.params : { ...DEFAULT_PARAMS, sdWeek: s.sdWeek, sdSeason: s.sdSeason };
  // Calibration uses each week's final pre-game projections. Projecting week 15 from today is less accurate than that,
  // so add a forecast-horizon error on top of whatever season-long error the data shows.
  const horizon = s.horizonSd ?? 0.05;
  return { ...base, measuredSeason: base.sdSeason, horizon, sdSeason: Math.sqrt(base.sdSeason ** 2 + horizon ** 2), injRates: { ...DEFAULT_PARAMS.injRates, ...(s.injRates || {}) }, injRecover: s.injRecover };
}
export function runSim(L) {
  L.sim = simulate(simInput(L), { runs: settings().simRuns, params: simParams(), seed: 777 });
  assignPickSlots(L);
}

function assignPickSlots(L) {
  // projected next-year draft slot of each team's own pick, from the simulated seasons
  L.draftSlot = {}; L.slotDist = {};
  for (const t of L.teams) { L.draftSlot[t.rid] = L.sim[t.rid].slot; L.slotDist[t.rid] = L.sim[t.rid].slotDist; }
}

// Where a team's pick looks like it will land just from today's standings: what its owner and the market see
export function impliedSlot(L, rid) {
  const order = [...L.teams].sort((a, b) => (a.winPct - b.winPct) || (a.fpts - b.fpts));
  return order.findIndex(t => t.rid === +rid) + 1;
}
function tierValue(L, y, ord, s) {
  const n = L.numTeams, g = L.fc.picks.get(`${y} ${ord}`);
  return L.fc.picks.get(`${y} ${ord} (${s <= n / 3 ? 'Early' : s <= 2 * n / 3 ? 'Mid' : 'Late'})`) ?? g ?? 0;
}

// Where a team's pick the year after next is likely to land: rank teams by roster value a year from now
// (Sanderson value, discounted for age), weakest first
const ageKeep = a => (!a || a <= 26) ? 1 : Math.max(0.35, 1 - 0.12 * (a - 26));
export function futureSlot(L, rid) {
  if (!L._futOrder) {
    const s = new Map(L.teams.map(t => [t.rid, t.players.map(id => asset(L, 'p:' + id)).reduce((x, a) => x + a.tat * ageKeep(a.age), 0)]));
    L._futOrder = [...L.teams].sort((a, b) => s.get(a.rid) - s.get(b.rid)).map(t => t.rid);
  }
  return L._futOrder.indexOf(+rid) + 1;
}

// Can this team still fix its lineup by trading? A team whose roster value ranks well above its lineup has the
// assets to buy starters, as long as the trade deadline hasn't passed. Returns 0 (can't) to 0.6 (very likely).
export function fixFactor(L, rid) {
  const t = L.byRid[rid];
  if (!t || t.rosRank == null || t.fcTotalRank == null) return 0;
  const dl = L.tradeDeadline;
  if (dl && M.week > dl) return 0;
  const weeksLeft = dl ? Math.max(0, dl - M.week) : 3;
  const gap = (t.rosRank - t.fcTotalRank) / L.teams.length; // value much better than lineup
  return Math.max(0, Math.min(0.6, gap * 1.5)) * Math.min(1, weeksLeft / 3);
}

// FantasyCalc value of a next-year pick given the chance of each slot
function expectedPickValue(L, y, ord, orig) {
  const n = L.numTeams, dist = L.slotDist?.[orig];
  const g = L.fc.picks.get(`${y} ${ord}`);
  const tier = s => L.fc.picks.get(`${y} ${ord} (${s <= n / 3 ? 'Early' : s <= 2 * n / 3 ? 'Mid' : 'Late'})`) ?? g ?? 0;
  if (!dist) return g ?? 0;
  let v = 0; for (let s = 1; s <= n; s++) v += (dist[s] || 0) * tier(s);
  return v;
}

// ---------------- values ----------------
export function pickName(L, key) {
  const [, y, rd, orig] = key.split(':');
  const ord = ORD[rd] || rd + 'th';
  const n = L.numTeams;
  let label = `${y} ${ord}`;
  if (+y === +L.season + 1 && L.draftSlot) {
    const slot = Math.round(L.draftSlot[orig]);
    const third = slot <= n / 3 ? 'Early' : slot <= 2 * n / 3 ? 'Mid' : 'Late';
    if (L.fc.picks.has(`${label} (${third})`)) label = `${label} (${third})`;
  }
  return label;
}

export function asset(L, key) {
  if (isPick(key)) {
    const [, y, rd, orig] = key.split(':');
    const ord = ORD[rd] || rd + 'th';
    const fcName = pickName(L, key);
    const generic = L.fc.picks.get(`${y} ${ord}`) ?? 0;
    const next = +y === +L.season + 1 && L.slotDist;
    let v = next ? expectedPickValue(L, y, ord, orig) : (L.fc.picks.get(fcName) ?? generic);
    const ot = L.byRid[orig];
    const dist = next ? L.slotDist[orig] : null;
    const top3 = dist ? (dist[1] || 0) + (dist[2] || 0) + (dist[3] || 0) : null;
    const slot = L.draftSlot?.[orig];
    const label = next && slot ? `${y} ${ord} (proj #${Math.round(slot)})` : fcName;
    const looks = next && ot?.winPct != null ? impliedSlot(L, orig) : null;
    const fcLooks = looks ? tierValue(L, y, ord, looks) : generic;
    // a strong-value team with a weak lineup may trade its way out of a bad finish: shade the projection back
    const fix = next ? fixFactor(L, orig) : 0;
    if (fix && v > fcLooks) v = v - fix * (v - fcLooks);
    // the 1st after next: market prices it generically, but a weak, aging roster makes an early pick likely
    if (+y === +L.season + 2 && +rd === 1 && L.slotDist && L.tatMap) {
      const fs = futureSlot(L, orig), base1 = L.fc.picks.get(`${+L.season + 1} 1st`) || 1;
      const share = tierValue(L, +L.season + 1, '1st', fs) / base1;
      const proj = generic * share;
      return { key, pick: true, orig: +orig, name: `${y} 1st (likely #${fs})` + (ot && !ot.isMe ? ` (${ot.owner})` : ot?.isMe ? ' (own)' : ''), short: `${y} 1st`, pos: 'PICK', fc: generic, tat: proj, fcGeneric: generic, fcLooks: generic, futureSlot: fs, age: null };
    }
    return { key, pick: true, orig: +orig, name: label + (ot && !ot.isMe ? ` (${ot.owner})` : ot?.isMe ? ' (own)' : ''), short: label, pos: 'PICK', fc: v, tat: v, fcGeneric: generic, fcLooks, looksSlot: looks, top3, fix, age: null, slot };
  }
  const id = pid(key);
  const p = M.players[id] || {};
  const f = L.fc.byId.get(id);
  const fc = f?.value || 0;
  const t = L.tatMap?.get(id);
  const tat = t != null ? t : Math.min(fc * 0.5, 600);
  return {
    key, id, name: p.full_name || f?.name || id, pos: p.position || f?.pos || '?', team: p.team || '', age: f?.age ?? p.age ?? null,
    fc, tat, tatRank: L.tatRank?.get(id) ?? null, tatMove: L.tatMove?.get(id) || '', inj: p.injury_status || '', trend: f?.trend || 0,
  };
}

export function teamAssets(L, t) {
  return [...t.players.map(id => asset(L, 'p:' + id)), ...t.picks.map(k => asset(L, k))];
}

// Map TAT rows to Sleeper ids once, then value per league (each league's own pick scale)
let byNamePosCache = null;
function matchTatRows(set) {
  M.tatMatchCache ||= new Map();
  if (M.tatMatchCache.has(set.id)) return M.tatMatchCache.get(set.id);
  const fc12 = M.fc['12-2-1'];
  if (!byNamePosCache) {
    byNamePosCache = new Map();
    for (const [id, p] of Object.entries(M.players)) {
      if (!p.full_name || !['QB', 'RB', 'WR', 'TE'].includes(p.position)) continue;
      const k = normName(p.full_name) + '|' + p.position;
      const prev = byNamePosCache.get(k);
      if (!prev || (p.team && !M.players[prev].team) || (p.active && !M.players[prev].active)) byNamePosCache.set(k, id);
    }
  }
  const ids = new Map(), unmatched = [];
  for (const r of set.rows) {
    const k = normName(r.name) + '|' + r.pos;
    const id = fc12?.byName.get(k) || byNamePosCache.get(k);
    if (id) ids.set(r.rank, String(id)); else unmatched.push(r.name);
  }
  const res = { ids, unmatched };
  M.tatMatchCache.set(set.id, res);
  return res;
}

// TAT values of any uploaded set, on this league's scale (cached)
export function tatMapFor(L, set) {
  L.tatSetCache ||= new Map();
  if (L.tatSetCache.has(set.id)) return L.tatSetCache.get(set.id);
  const { ids } = matchTatRows(set);
  const pv = n => L.fc.picks.get(n) ?? M.fc['12-2-1']?.picks.get(n) ?? 0;
  const vals = valueRows(set.rows, tierValues(pv, +L.season + 1));
  const m = new Map();
  for (const r of set.rows) { const id = ids.get(r.rank); if (id) m.set(id, vals.get(r.rank)); }
  L.tatSetCache.set(set.id, m);
  return m;
}

export function applyTat() {
  const set = latestTat();
  M.tatSet = set;
  M.tatIds = new Map();
  if (!set) { for (const L of M.leagues) { L.tatMap = null; L.tatRank = null; L.tatMove = null; } return; }
  const { ids, unmatched } = matchTatRows(set);
  M.tatIds = ids;
  M.tatUnmatched = unmatched;
  for (const L of M.leagues) valueTat(L, set);
}

function valueTat(L, set) {
  const pv = n => L.fc.picks.get(n) ?? M.fc['12-2-1']?.picks.get(n) ?? 0;
  const tv = tierValues(pv, +L.season + 1);
  const vals = valueRows(set.rows, tv);
  L.tatMap = new Map(); L.tatRank = new Map(); L.tatMove = new Map();
  for (const r of set.rows) {
    const id = M.tatIds.get(r.rank); if (!id) continue;
    L.tatMap.set(id, vals.get(r.rank)); L.tatRank.set(id, r.rank); if (r.move) L.tatMove.set(id, r.move);
  }
}

// ---------------- power rankings / modes ----------------
export function computePower(L) {
  L.plan = null; L._futOrder = null; // recomputed lazily from the fresh numbers
  const rules = settings().rules;
  const playoffWeeks = []; for (let w = L.playoffStart; w <= M.lastWeek; w++) playoffWeeks.push(w);
  for (const t of L.teams) {
    const A = teamAssets(L, t);
    t.fcTotal = sum(A.map(a => a.fc)); t.tatTotal = sum(A.map(a => a.tat));
    t.fcPlayers = sum(A.filter(a => !a.pick).map(a => a.fc));
    t.pickFc = sum(A.filter(a => a.pick).map(a => a.fc));
    const top = A.filter(a => !a.pick).sort((a, b) => b.fc - a.fc).slice(0, 15);
    const tv = sum(top.map(a => a.fc));
    t.coreAge = tv ? sum(top.map(a => (a.age || 26) * a.fc)) / tv : null;
    const wk = L.weekly[t.rid];
    const reg = L.regWeeks.map(w => wk[w]).filter(x => x != null);
    t.ros = reg.length ? sum(reg) / reg.length : avg(Object.values(wk));
    const po = playoffWeeks.map(w => wk[w]).filter(x => x != null);
    t.po = po.length ? sum(po) / po.length : t.ros;
    const s = L.sim?.[t.rid] || {};
    t.playoff = s.playoff; t.title = s.title; t.bye = s.bye; t.final = s.final; t.expWins = s.wins; t.expSeed = s.seed;
    const g = t.wins + t.losses + t.ties;
    t.winPct = g ? (t.wins + 0.5 * t.ties) / g : 0.5;
    t.mode = (t.winPct >= rules.contenderWinPct || (t.playoff ?? 0) >= 0.6) ? 'contend'
      : (t.winPct <= rules.rebuilderWinPct && (t.playoff ?? 0) < 0.3) ? 'rebuild' : 'middle';
  }
  const rank = (k) => { [...L.teams].sort((a, b) => b[k] - a[k]).forEach((t, i) => t[k + 'Rank'] = i + 1); };
  ['fcTotal', 'tatTotal', 'ros', 'po', 'fpts', 'title'].forEach(rank);
  if (L.me) L.me.advice = adviceFor(L, L.me);
}

function avg(a) { return a.length ? sum(a) / a.length : 0; }

export function adviceFor(L, t) {
  const p = t.playoff ?? 0, ti = t.title ?? 0;
  if (ti >= 0.15) return { tag: 'Push', cls: 'push', text: 'Title contender. Only move vets for equal-or-better starters; buy for the playoffs.' };
  if (p >= 0.8) return { tag: 'Contend+sell age', cls: 'mid', text: 'Playoff lock but not a favourite. Swap aging pieces for younger starters without losing points.' };
  if (p >= 0.4) return { tag: 'Middle', cls: 'mid', text: 'Stuck in the middle. Sell vets to contenders unless it costs you a playoff spot.' };
  if (p >= 0.1) return { tag: 'Sell', cls: 'sell', text: 'Sell vets to contenders now, while they still have value.' };
  return { tag: 'Tank', cls: 'tank', text: 'Tank. Sell anything older for youth/picks.' };
}

function snapshotHistory(L) {
  if (!L.me) return;
  const teams = {};
  for (const t of L.teams) teams[t.rid] = { fc: Math.round(t.fcTotal), tat: Math.round(t.tatTotal), ros: +t.ros.toFixed(1), playoff: t.playoff, title: t.title, w: t.wins, l: t.losses };
  recordHistory(L.id, M.week, { teams, me: L.me.rid });
}

// Fill weekly history from the GitHub Action snapshots (FantasyCalc totals + records) where the browser has no entry
async function mergeSnapshots() {
  const r = await fetch('data/snapshots/index.json', { cache: 'no-store' });
  if (!r.ok) return;
  const dates = (await r.json()).slice(-26);
  const hist = state().history;
  for (const d of dates) {
    const s = await fetch(`data/snapshots/${d}.json`).then(x => x.json()).catch(() => null);
    if (!s || String(s.season) !== String(M.season)) continue;
    for (const [lid, lg] of Object.entries(s.leagues)) {
      hist[lid] ||= {};
      if (hist[lid][s.week]) continue;
      const teams = {};
      for (const [rid, t] of Object.entries(lg.teams)) teams[rid] = { fc: t.fc, w: t.w, l: t.l };
      hist[lid][s.week] = { date: s.date, teams, me: lg.me, fromSnapshot: true };
    }
  }
}

// re-value everything after a TAT upload or settings change
export function refreshValues() {
  applyTat();
  for (const L of M.leagues) { assignPickSlots(L); computePower(L); snapshotHistory(L); }
}

export function leagueById(id) { return M.leagues.find(l => l.id === id); }
export { posOf, parseLines };
