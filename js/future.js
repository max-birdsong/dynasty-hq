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
//  3. Market value is added for players up to 28: value carries what the market expects of a player beyond his points
//     so far (a rookie worth three 1sts vs one worth a late 1st), and it moves when his stock moves. Fitted on
//     DynastyProcess values 2019-2024 against the next three seasons' points; out of sample it cut the error for
//     young players three years out by ~10%. (Fitted on ~630 player-seasons of rosterable players: broad strokes.)
//  4. Outcomes, not averages: each simulated future draws every player's result from how players like him actually
//     turned out (busts, stars, everything between), a boom stays a boom across the years, and picks draw from what
//     rookies drafted at that rank actually did. Each team's best lineup is rebuilt from the draws, so depth covers busts.
//  5. Each draw's lineups run through the same season simulator as this season (0-0 start, a generic schedule).
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
export const YEAR_SD = 0.05; // roster churn (trades, waivers) per year ahead; player outcomes are drawn below
// expected PPR points per team-week h years ahead (missed games count as 0), one smooth model per horizon (Poisson
// regression, no jumps between age groups): exp(b0 + b1 ln(aged ppg + 1) + b2 QB*ln(aged ppg + 1) + b3 (age-26)
// + b4 (age-26)^2/10 + QB/RB/TE terms + b8 ln(DP value) + b9 ln(DP value)*(age-26)/5), value for RB/WR/TE only.
// Out of sample it matches a model split by age group, and the value terms cut the error 3-9%. Note how little this
// season's points alone carry (b1 ~0.3 for RB/WR/TE): the market value says more about next year than the box score.
const POIS = {"1": [-0.3979, 0.31, 0.4829, 0.0042, -0.0006, 0.747, -0.0362, -0.0251, 0.2394, 0.0029], "2": [-1.1036, 0.126, 0.7122, 0.0085, -0.013, 1.2523, -0.068, 0.0564, 0.3731, -0.0125], "3": [-2.94, 0.1295, 0.9252, -0.0215, 0.0075, 2.3596, -0.1832, 0.2492, 0.5719, -0.0131]};
const RATIO = {"young1": [0.069, 0.331, 0.464, 0.581, 0.671, 0.781, 0.861, 0.921, 0.946, 0.984, 1.05, 1.103, 1.191, 1.281, 1.366, 1.444, 1.511, 1.576, 1.707], "prime1": [0.085, 0.335, 0.47, 0.607, 0.71, 0.807, 0.873, 0.92, 0.967, 1.025, 1.065, 1.121, 1.164, 1.203, 1.265, 1.351, 1.448, 1.55, 1.715], "old1": [0.367, 0.433, 0.538, 0.646, 0.737, 0.801, 0.834, 0.93, 0.945, 0.966, 1.13, 1.171, 1.223, 1.252, 1.31, 1.456, 1.506, 1.559, 1.686], "young2": [0.01, 0.17, 0.417, 0.489, 0.607, 0.676, 0.774, 0.87, 0.933, 1.008, 1.101, 1.167, 1.242, 1.303, 1.412, 1.496, 1.613, 1.73, 1.919], "prime2": [0.0, 0.171, 0.356, 0.482, 0.591, 0.665, 0.758, 0.824, 0.912, 0.974, 1.052, 1.134, 1.225, 1.295, 1.346, 1.425, 1.486, 1.659, 1.815], "old2": [0.0, 0.142, 0.454, 0.566, 0.716, 0.763, 0.875, 0.997, 1.052, 1.115, 1.159, 1.198, 1.241, 1.326, 1.437, 1.529, 1.651, 1.783, 1.925], "young3": [0.0, 0.077, 0.266, 0.381, 0.538, 0.69, 0.797, 0.85, 0.914, 0.958, 1.062, 1.126, 1.291, 1.323, 1.414, 1.534, 1.749, 1.868, 2.117], "prime3": [0.0, 0.0, 0.0, 0.113, 0.258, 0.421, 0.591, 0.699, 0.844, 0.929, 1.026, 1.058, 1.151, 1.24, 1.386, 1.536, 1.645, 1.906, 2.247], "old3": [0.0, 0.0, 0.213, 0.372, 0.518, 0.766, 0.837, 0.949, 1.053, 1.095, 1.18, 1.223, 1.28, 1.369, 1.412, 1.712, 1.973, 2.187, 2.523]};
// rookies: 19 quantiles of total PPR points per week over years 1-3, and how that splits over the three years
const ROOKIE_Q = {"3": {"tot": [16.9, 21.8, 24.7, 28.9, 29.6, 30.0, 31.0, 33.2, 35.3, 35.9, 36.4, 37.8, 40.1, 41.6, 43.8, 44.6, 48.7, 51.2, 56.9], "share": [0.325, 0.347, 0.328]}, "6": {"tot": [7.9, 9.6, 10.4, 13.3, 14.7, 16.3, 17.7, 19.7, 21.4, 22.9, 24.7, 26.2, 27.8, 36.7, 38.4, 41.3, 42.3, 46.7, 52.6], "share": [0.288, 0.348, 0.363]}, "12": {"tot": [2.5, 5.7, 6.9, 10.0, 10.8, 15.1, 16.7, 18.0, 18.2, 21.6, 22.6, 24.8, 27.3, 31.1, 34.7, 38.0, 39.0, 41.4, 44.5], "share": [0.303, 0.381, 0.316]}, "24": {"tot": [0.5, 2.6, 4.3, 5.2, 6.1, 7.5, 9.4, 11.1, 13.7, 14.6, 16.3, 19.4, 21.0, 21.8, 23.3, 25.8, 29.9, 33.8, 36.8], "share": [0.291, 0.367, 0.342]}, "36": {"tot": [0.1, 0.3, 0.9, 1.4, 2.9, 3.4, 4.6, 5.7, 7.2, 8.9, 9.7, 11.1, 12.5, 15.9, 17.4, 20.5, 25.9, 28.7, 36.9], "share": [0.293, 0.368, 0.339]}, "60": {"tot": [0.0, 0.0, 0.1, 0.2, 0.6, 1.1, 1.3, 1.8, 2.5, 3.1, 3.9, 4.9, 5.8, 7.2, 9.6, 11.1, 16.2, 19.1, 24.2], "share": [0.285, 0.368, 0.347]}};

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
export function levels(L) {
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
  const factor = Object.fromEntries(Object.keys(lg).map(p => [p, pp[p] > 0 ? lg[p] / pp[p] : null]));
  L._lvl = { lvl, factor, rookieFactor: allPp > 0 ? allLg / allPp : 1 };
  return L._lvl;
}
const fcOf = (L, id) => L.fc?.byId?.get(String(id))?.value ?? 0;

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

const band = age => age < 24.5 ? 'young' : age < 28.5 ? 'prime' : 'old';
const ppr = (L, pos) => levels(L).factor[pos] || levels(L).rookieFactor || 1;
const dpVal = id => M.calcs?.dp?.one?.[id] ?? null;
// a player's expected PPR points per week k seasons ahead (before drawing an outcome)
export function expected(L, id, pos, age, k) {
  const { lvl } = levels(L), base = (lvl[id] || 0) / ppr(L, pos), aged = base * prodKeep(pos, age, k);
  const c = POIS[Math.min(3, k)], qb = pos === 'QB' ? 1 : 0, la = Math.log(Math.max(0, aged) + 1), x = age - 26;
  const lv = qb ? 0 : Math.log(Math.max(300, dpVal(id) ?? 300));
  return Math.exp(c[0] + c[1] * la + c[2] * qb * la + c[3] * x + c[4] * x * x / 10 + c[5] * qb + c[6] * (pos === 'RB') + c[7] * (pos === 'TE') + c[8] * lv + c[9] * lv * x / 5);
}
// deterministic per (player, draw): the same draws on both sides of a trade preview
function u01(key, d) { let x = 2166136261 ^ d; for (let i = 0; i < key.length; i++) x = Math.imul(x ^ key.charCodeAt(i), 16777619); x ^= x >>> 13; x = Math.imul(x, 0x5bd1e995); x ^= x >>> 15; return (x >>> 0) / 4294967296; }
const qIdx = u => Math.min(18, Math.floor(u * 19));

// projected best-lineup points per week for a set of assets, k seasons ahead, in draw d (d < 0: averages)
export function lineupIn(L, assets, k, d = -1) {
  const { rookieFactor } = levels(L), n = L.teams.length, season = +L.season + k;
  const ids = [], pts = {};
  for (const a of assets) {
    if (a.pick) {
      const [, y, rd] = a.key.split(':');
      const yr = season - +y + 1; if (yr < 1) continue;
      const slot = a.slot || (n + 1) / 2, rank = (+rd - 1) * n + slot;
      const g = ROOKIE_Q[Object.keys(ROOKIE_Q).map(Number).find(hi => rank <= hi) ?? 60];
      const tot = d < 0 ? g.tot.reduce((x, y) => x + y, 0) / g.tot.length : g.tot[qIdx(u01(a.key, d))];
      const id = 'rk:' + a.key; ids.push(id); pts[id] = tot * g.share[Math.min(3, yr) - 1] * rookieFactor;
    } else {
      const id = String(a.id); const p = M.players[id]; if (!p) continue;
      const pos = p.position, age = a.age || p.age || 26, e = expected(L, id, pos, age, k);
      const r = d < 0 ? 1 : RATIO[band(age) + Math.min(3, k)][qIdx(u01(id, d))];
      ids.push(id); pts[id] = e * r * ppr(L, pos);
    }
  }
  return bestLineup(ids, pts, posOfF, L.slots).total;
}

export const DRAWS = 200;
// title odds for seasons 1..years ahead, every team; `swap` replaces a team's assets (trade previews)
export function futureTitles(L, years, swap = {}) {
  const plain = !Object.keys(swap).length;
  if (plain && L._futT?.years === years) return L._futT.out;
  const rids = L.teams.map(t => t.rid);
  const weeks = []; for (let w = 1; w < L.playoffStart; w++) weeks.push(w);
  const sched = schedule(rids, weeks), allW = [...weeks, L.playoffStart, L.playoffStart + 1, L.playoffStart + 2, L.playoffStart + 3];
  const out = Object.fromEntries(rids.map(r => [r, []]));
  const assets = Object.fromEntries(L.teams.map(t => [t.rid, swap[t.rid] || teamAssets(L, t)]));
  for (let k = 1; k <= years; k++) {
    const p = { ...simParams() }, h = YEAR_SD * Math.sqrt(k);
    if (p.seasonVar) p.horizon = Math.sqrt((p.horizon || 0) ** 2 + h * h); else p.sdSeason = Math.sqrt((p.sdSeason || 0.06) ** 2 + h * h);
    p.injRates = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 };
    const won = Object.fromEntries(rids.map(r => [r, 0]));
    for (let d = 0; d < DRAWS; d++) {
      const weekly = {};
      for (const r of rids) { const v = lineupIn(L, assets[r], k, d); weekly[r] = Object.fromEntries(allW.map(w => [w, v])); }
      const res = simulate({ teams: rids.map(rid => ({ rid, wins: 0, losses: 0, ties: 0, fpts: 0, ppts: 0 })), weekly, inj: {}, adj: {}, lineupFn: () => 0,
        schedule: sched, regWeeks: weeks, firstWeek: 1, playoffStart: L.playoffStart, playoffTeams: L.playoffTeams, median: L.median }, { runs: 6, params: p, seed: 4242 + 1000 * k + d });
      for (const r of rids) won[r] += res[r].title;
    }
    for (const r of rids) out[r].push(won[r] / DRAWS);
  }
  if (plain) L._futT = { years, out };
  return out;
}
