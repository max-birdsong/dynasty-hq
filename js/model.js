// Builds the full model for every league: rosters, picks, FC + TAT values, projections, simulation, power rankings.
import * as api from './api.js';
import { state, settings, nick, latestTat, recordHistory } from './state.js';
import { parseLines, tierValues, valueRows, normName } from './tatparse.js';
import { startSlots, neededPositions, scoreStats, bestLineup } from './lineup.js';
import { simulate } from './sim.js';
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
  M.lastWeek = 17;
  M.proj = {};
  const weeks = [];
  for (let w = M.week; w <= M.lastWeek; w++) weeks.push(w);
  const res = await pool(weeks, 4, w => api.weekProjections(M.season, w, positions));
  weeks.forEach((w, i) => { if (res[i]) M.proj[w] = res[i]; });
  M.projSource = Object.keys(M.proj).length ? 'sleeper' : 'average';
}

function posOf(id) {
  const p = M.players[id];
  if (!p) return [];
  return p.fantasy_positions?.length ? p.fantasy_positions : [p.position];
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
  L.schedule = {}; L.pastPts = {};
  weeks.forEach((w, i) => {
    const arr = mus[i] || [];
    if (w >= M.week) {
      const g = {};
      for (const m of arr) if (m.matchup_id != null) (g[m.matchup_id] ||= []).push(m.roster_id);
      L.schedule[w] = Object.values(g).map(p => [p[0], p[1] ?? null]);
    } else {
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

function computeWeekly(L) {
  L.weekly = {};
  for (const t of L.teams) L.weekly[t.rid] = teamWeekly(L, t.players);
}

export function startersNow(L, ids) {
  const w = Math.min(Math.max(M.week, 1), M.lastWeek);
  const pts = {}; for (const id of ids) pts[id] = playerWeekPts(L, id, w);
  return bestLineup(ids, pts, posOf, L.slots);
}

// ---------------- simulation ----------------
export function simInput(L, weeklyOverride = {}) {
  return {
    teams: L.teams.map(t => ({ rid: t.rid, wins: t.wins, losses: t.losses, ties: t.ties, fpts: t.fpts })),
    weekly: { ...L.weekly, ...weeklyOverride }, schedule: L.schedule, regWeeks: L.regWeeks,
    playoffStart: L.playoffStart, playoffTeams: L.playoffTeams, median: L.median,
  };
}
export function runSim(L) {
  const s = settings();
  L.sim = simulate(simInput(L), { runs: s.simRuns, sd: s.simSd });
  assignPickSlots(L);
}

function assignPickSlots(L) {
  // projected draft order: worst expected record picks first
  const order = [...L.teams].sort((a, b) => (L.sim[a.rid].wins - L.sim[b.rid].wins) || (a.fpts - b.fpts));
  L.draftSlot = {};
  order.forEach((t, i) => { L.draftSlot[t.rid] = i + 1; });
}

// ---------------- values ----------------
export function pickName(L, key) {
  const [, y, rd, orig] = key.split(':');
  const ord = ORD[rd] || rd + 'th';
  const n = L.numTeams;
  let label = `${y} ${ord}`;
  if (+y === +L.season + 1 && L.draftSlot) {
    const slot = L.draftSlot[orig];
    const third = slot <= n / 3 ? 'Early' : slot <= 2 * n / 3 ? 'Mid' : 'Late';
    if (L.fc.picks.has(`${label} (${third})`)) label = `${label} (${third})`;
  }
  return label;
}

export function asset(L, key) {
  if (isPick(key)) {
    const [, y, rd, orig] = key.split(':');
    const fcName = pickName(L, key);
    const v = L.fc.picks.get(fcName) ?? L.fc.picks.get(`${y} ${ORD[rd] || rd + 'th'}`) ?? 0;
    const ot = L.byRid[orig];
    return { key, pick: true, name: fcName + (ot && !ot.isMe ? ` (${ot.owner})` : ot?.isMe ? ' (own)' : ''), short: fcName, pos: 'PICK', fc: v, tat: v, age: null, slot: L.draftSlot?.[orig] };
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
export function applyTat() {
  const set = latestTat();
  M.tatSet = set;
  M.tatIds = new Map();
  if (!set) { for (const L of M.leagues) { L.tatMap = null; L.tatRank = null; L.tatMove = null; } return; }
  const fc12 = M.fc['12-2-1'];
  const byNamePos = new Map();
  for (const [id, p] of Object.entries(M.players)) {
    if (!p.full_name || !['QB', 'RB', 'WR', 'TE'].includes(p.position)) continue;
    const k = normName(p.full_name) + '|' + p.position;
    const prev = byNamePos.get(k);
    if (!prev || (p.team && !M.players[prev].team) || (p.active && !M.players[prev].active)) byNamePos.set(k, id);
  }
  const unmatched = [];
  for (const r of set.rows) {
    const k = normName(r.name) + '|' + r.pos;
    const id = fc12?.byName.get(k) || byNamePos.get(k);
    if (id) M.tatIds.set(r.rank, String(id)); else unmatched.push(r.name);
  }
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
    t.playoff = s.playoff; t.title = s.title; t.expWins = s.wins; t.expSeed = s.seed;
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
