// Win equity in future seasons, from projected points rather than market value.
// A player's market value falls faster than his points: when he ages a year, a whole future season drops out of what
// buyers pay for. For "can this roster win the title in 2027" what counts is 2027 points, so each future season is
// built from projected points, the same way as this season:
//  1. Each player's current level (points per game in this league's scoring: Sleeper's projections for his healthy
//     weeks blended with what he has scored this season).
//  2. Aged with production curves measured from every NFL season 2010-2025 (nflverse): how points per game change
//     with age among players who keep playing (selected on the two-year average, so no regression-to-the-mean bias),
//     times how much of the next season fantasy-relevant players of that age actually play (injury, benching,
//     retirement), relative to a player in his prime.
//  3. Picks become rookies, scoring what rookies drafted at that rank in their class scored in years 1-3.
//  4. Each team's best lineup each season goes into the same season simulator as this season (0-0 start, a generic
//     schedule), with extra season-level uncertainty per year ahead: in the same data a year-ahead projection of a
//     player's points misses by ~53%, about 15-18% for a whole lineup.
import { M, teamAssets, simParams } from './model.js';
import { bestLineup, scoreStats } from './lineup.js';
import { simulate } from './sim.js';

const PPG = {
  QB: { 21: 1.099, 22: 1.051, 23: 1.011, 24: 0.972, 25: 0.968, 26: 0.999, 27: 0.997, 28: 0.998, 29: 1.004, 30: 0.979, 31: 0.976, 32: 0.973, 33: 0.951, 34: 0.946, 35: 0.959, 36: 0.95 },
  RB: { 21: 1.126, 22: 1.109, 23: 1.025, 24: 0.965, 25: 0.961, 26: 0.957, 27: 0.917, 28: 0.879, 29: 0.858, 30: 0.843, 31: 0.857 },
  WR: { 21: 1.163, 22: 1.108, 23: 1.056, 24: 1.025, 25: 0.99, 26: 0.954, 27: 0.934, 28: 0.912, 29: 0.902, 30: 0.899, 31: 0.86, 32: 0.838, 33: 0.83 },
  TE: { 21: 1.239, 22: 1.154, 23: 1.109, 24: 1.054, 25: 0.983, 26: 0.943, 27: 0.939, 28: 0.947, 29: 0.942, 30: 0.918, 31: 0.898, 32: 0.9, 33: 0.9 },
};
const AVAIL = {
  QB: { 21: 0.791, 22: 0.763, 23: 0.719, 24: 0.667, 25: 0.647, 26: 0.689, 27: 0.687, 28: 0.642, 29: 0.659, 30: 0.713, 31: 0.712, 32: 0.686, 33: 0.669, 34: 0.671, 35: 0.721, 36: 0.693, 37: 0.56 },
  RB: { 21: 0.725, 22: 0.726, 23: 0.718, 24: 0.712, 25: 0.714, 26: 0.713, 27: 0.683, 28: 0.618, 29: 0.587, 30: 0.592, 31: 0.535, 32: 0.533 },
  WR: { 21: 0.814, 22: 0.784, 23: 0.755, 24: 0.753, 25: 0.774, 26: 0.776, 27: 0.746, 28: 0.722, 29: 0.706, 30: 0.681, 31: 0.683, 32: 0.678, 33: 0.642 },
  TE: { 21: 0.661, 22: 0.659, 23: 0.713, 24: 0.759, 25: 0.768, 26: 0.765, 27: 0.763, 28: 0.735, 29: 0.695, 30: 0.684, 31: 0.688, 32: 0.69, 33: 0.69 },
};
// expected full-PPR points per team-week of a rookie by his rank among QB/RB/WR/TE picks in his NFL draft class,
// seasons 1-3 (0 for the weeks he doesn't play or play much)
const ROOKIE = [[3, { 1: 13.67, 2: 13.36, 3: 11.81 }], [6, { 1: 9.32, 2: 10.61, 3: 9.56 }], [12, { 1: 8.64, 2: 9.51, 3: 7.28 }],
  [24, { 1: 5.47, 2: 6.39, 3: 5.6 }], [36, { 1: 4.05, 2: 4.9, 3: 4.04 }], [99, { 1: 2.26, 2: 2.62, 3: 2.27 }]];
export const YEAR_SD = 0.15; // extra season-level uncertainty for each year ahead (team level)

const at = (t, age) => { const ks = Object.keys(t).map(Number), a = Math.min(Math.max(...ks), Math.max(Math.min(...ks), Math.floor(age))); return t[a]; };
const REF = Object.fromEntries(Object.entries(AVAIL).map(([p, t]) => [p, [24, 25, 26, 27, 28].reduce((s, a) => s + (t[a] ?? 0), 0) / 5]));
// share of a player's current scoring he is expected to deliver k seasons from now
export function prodKeep(pos, age, k) {
  if (!PPG[pos]) return k ? 0.8 ** k : 1;
  let f = 1;
  for (let i = 0; i < k; i++) f *= at(PPG[pos], age + i) * Math.min(1, at(AVAIL[pos], age + i) / REF[pos]);
  return f;
}

const PPR = { pass_yd: 0.04, pass_td: 4, pass_int: -2, pass_2pt: 2, rush_yd: 0.1, rush_td: 6, rush_2pt: 2, rec: 1, rec_yd: 0.1, rec_td: 6, rec_2pt: 2, fum_lost: -2 };
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

// each rostered player's healthy points per game in this league's scoring
function levels(L) {
  if (L._lvl) return L._lvl;
  const lvl = {}, weeks = Object.keys(M.proj || {}).map(Number).filter(w => w >= M.week);
  const ids = L.teams.flatMap(t => t.players);
  let lg = { QB: 0, RB: 0, WR: 0, TE: 0 }, pp = { QB: 0, RB: 0, WR: 0, TE: 0 };
  for (const id of ids) {
    const p = M.players[id]; if (!p) continue;
    const pr = weeks.map(w => scoreStats(M.proj[w]?.[id], L.scoring, p.position)).filter(x => x > 0.5);
    const past = (L.pastPts[id] || []).filter(x => x > 0);
    const a = mean(pr), b = mean(past);
    lvl[id] = pr.length && past.length >= 2 ? 0.5 * a + 0.5 * b : pr.length ? a : past.length >= 2 ? b : null;
    // this league's scoring vs full PPR, by position (for rookies, whose history is in PPR)
    if (pp[p.position] != null && weeks.length) for (const w of weeks) { const s = M.proj[w]?.[id]; if (s) { lg[p.position] += scoreStats(s, L.scoring, p.position); pp[p.position] += scoreStats(s, PPR, p.position); } }
  }
  // players with nothing to go on (hurt all year, unused rookies): read off their market value, by position
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const pts = ids.filter(id => M.players[id]?.position === pos && lvl[id] > 0).map(id => [Math.log(Math.max(50, fcOf(L, id))), Math.log(lvl[id])]);
    let A = 0, B = 0;
    if (pts.length >= 6) { const mx = mean(pts.map(x => x[0])), my = mean(pts.map(x => x[1])); B = pts.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0) / Math.max(1e-9, pts.reduce((s, [x]) => s + (x - mx) ** 2, 0)); A = my - B * mx; }
    for (const id of ids) if (M.players[id]?.position === pos && lvl[id] == null) lvl[id] = pts.length >= 6 ? Math.exp(A + B * Math.log(Math.max(50, fcOf(L, id)))) : 0;
  }
  const allLg = Object.values(lg).reduce((a, b) => a + b, 0), allPp = Object.values(pp).reduce((a, b) => a + b, 0);
  L._lvl = { lvl, rookieFactor: allPp > 0 ? allLg / allPp : 1 };
  return L._lvl;
}
const fcOf = (L, id) => L.fc?.byId?.get(String(id))?.value ?? 0;

function rookiePts(classRank, yr) {
  if (yr < 1) return 0;
  const row = ROOKIE.find(([hi]) => classRank <= hi)[1];
  return row[Math.min(3, yr)];
}

// a generic double round robin for a future season
function schedule(rids, weeks) {
  const ids = rids.length % 2 ? [...rids, null] : [...rids], n = ids.length, out = {};
  weeks.forEach((w, i) => {
    const r = i % (n - 1), rot = [ids[0], ...ids.slice(1).slice(r), ...ids.slice(1).slice(0, r)], pairs = [];
    for (let j = 0; j < n / 2; j++) { const a = rot[j], b = rot[n - 1 - j]; if (a != null && b != null) pairs.push([a, b]); else if (a != null || b != null) pairs.push([a ?? b, null]); }
    out[w] = pairs;
  });
  return out;
}

const posOfF = id => id.startsWith?.('rk:') ? ['RB', 'WR'] : (M.players[id]?.fantasy_positions?.length ? M.players[id].fantasy_positions : [M.players[id]?.position]);

// projected best-lineup points per week for a set of assets, k seasons from now
export function lineupIn(L, assets, k) {
  const { lvl, rookieFactor } = levels(L), n = L.teams.length, season = +L.season + k;
  const ids = [], pts = {};
  for (const a of assets) {
    if (a.pick) {
      const [, y, rd] = a.key.split(':');
      const yr = season - +y + 1; if (yr < 1) continue;
      const slot = a.slot || (n + 1) / 2, rank = (+rd - 1) * n + slot;
      const id = 'rk:' + a.key; ids.push(id); pts[id] = rookiePts(rank, yr) * rookieFactor;
    } else {
      const id = String(a.id); const p = M.players[id]; if (!p) continue;
      ids.push(id); pts[id] = (lvl[id] || 0) * prodKeep(p.position, (a.age || p.age || 26), k);
    }
  }
  return bestLineup(ids, pts, posOfF, L.slots).total;
}

// title odds for seasons 1..years ahead, every team; `swap` replaces a team's assets (trade previews)
export function futureTitles(L, years, swap = {}) {
  const rids = L.teams.map(t => t.rid);
  const weeks = []; for (let w = 1; w < L.playoffStart; w++) weeks.push(w);
  const sched = schedule(rids, weeks);
  const out = Object.fromEntries(rids.map(r => [r, []]));
  for (let k = 1; k <= years; k++) {
    const weekly = {};
    for (const t of L.teams) { const v = lineupIn(L, swap[t.rid] || teamAssets(L, t), k); weekly[t.rid] = Object.fromEntries([...weeks, L.playoffStart, L.playoffStart + 1, L.playoffStart + 2, L.playoffStart + 3].map(w => [w, v])); }
    const p = { ...simParams() }, h = YEAR_SD * Math.sqrt(k);
    if (p.seasonVar) p.horizon = Math.sqrt((p.horizon || 0) ** 2 + h * h); else p.sdSeason = Math.sqrt((p.sdSeason || 0.06) ** 2 + h * h);
    p.injRates = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 };
    const res = simulate({ teams: L.teams.map(t => ({ rid: t.rid, wins: 0, losses: 0, ties: 0, fpts: 0, ppts: 0 })), weekly, inj: {}, adj: {}, lineupFn: () => 0,
      schedule: sched, regWeeks: weeks, firstWeek: 1, playoffStart: L.playoffStart, playoffTeams: L.playoffTeams, median: L.median }, { runs: 1200, params: p, seed: 4242 + k });
    for (const r of rids) out[r].push(res[r].title);
  }
  return out;
}
