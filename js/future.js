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
//     young players three years out by ~10%. For older players it didn't help, so it isn't used.
//     (Fitted on ~630 player-seasons of rosterable players, so these are broad strokes.)
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
// expected PPR points per team-week h years ahead (missed games count as 0): a + b * (points per game aged with the
// curves) [+ c * ln(DP value) for RB/WR/TE up to 28]. QBs are pooled over ages (too few to split) and use no value
// term (1QB values say little about superflex QBs; their points are the steadier signal).
const COEF = {"young1": [-10.723, 0.366, 1.992], "QByoung1": [3.977, 0.591], "prime1": [-10.036, 0.353, 1.95], "QBprime1": [3.977, 0.591], "old1": [3.67, 0.556], "QBold1": [3.977, 0.591], "young2": [-16.519, 0.203, 2.941], "QByoung2": [3.05, 0.578], "prime2": [-17.844, 0.272, 2.924], "QBprime2": [3.05, 0.578], "old2": [3.819, 0.525], "QBold2": [3.05, 0.578], "young3": [-27.427, 0.154, 4.268], "QByoung3": [0.345, 0.68], "prime3": [-20.291, 0.367, 2.933], "QBprime3": [0.345, 0.68], "old3": [-0.569, 0.972], "QBold3": [0.345, 0.68]};
// what players actually delivered relative to that expectation: 19 quantiles (5%..95%), by age band and years ahead
const RATIO = {"young1": [0.127, 0.363, 0.462, 0.58, 0.692, 0.796, 0.85, 0.902, 0.944, 0.975, 1.013, 1.106, 1.195, 1.282, 1.342, 1.443, 1.524, 1.615, 1.709], "QByoung1": [0.321, 0.438, 0.512, 0.669, 0.819, 0.843, 0.894, 0.945, 0.976, 1.05, 1.107, 1.164, 1.192, 1.201, 1.262, 1.308, 1.359, 1.474, 1.563], "prime1": [0.058, 0.317, 0.471, 0.619, 0.725, 0.805, 0.857, 0.932, 0.974, 1.013, 1.078, 1.115, 1.169, 1.233, 1.294, 1.379, 1.485, 1.563, 1.743], "QBprime1": [0.321, 0.438, 0.512, 0.669, 0.819, 0.843, 0.894, 0.945, 0.976, 1.05, 1.107, 1.164, 1.192, 1.201, 1.262, 1.308, 1.359, 1.474, 1.563], "old1": [0.315, 0.419, 0.478, 0.626, 0.682, 0.723, 0.771, 0.838, 0.867, 1.025, 1.044, 1.156, 1.189, 1.23, 1.266, 1.354, 1.477, 1.615, 1.665], "QBold1": [0.321, 0.438, 0.512, 0.669, 0.819, 0.843, 0.894, 0.945, 0.976, 1.05, 1.107, 1.164, 1.192, 1.201, 1.262, 1.308, 1.359, 1.474, 1.563], "young2": [0.039, 0.206, 0.397, 0.459, 0.586, 0.675, 0.794, 0.855, 0.935, 1.007, 1.058, 1.132, 1.229, 1.305, 1.382, 1.485, 1.559, 1.715, 1.984], "QByoung2": [0.068, 0.375, 0.553, 0.647, 0.684, 0.72, 0.853, 0.874, 0.994, 1.002, 1.087, 1.196, 1.256, 1.309, 1.354, 1.412, 1.431, 1.467, 1.582], "prime2": [0.0, 0.108, 0.33, 0.467, 0.596, 0.676, 0.787, 0.851, 0.942, 1.004, 1.063, 1.133, 1.226, 1.297, 1.35, 1.456, 1.601, 1.776, 2.091], "QBprime2": [0.068, 0.375, 0.553, 0.647, 0.684, 0.72, 0.853, 0.874, 0.994, 1.002, 1.087, 1.196, 1.256, 1.309, 1.354, 1.412, 1.431, 1.467, 1.582], "old2": [0.0, 0.114, 0.413, 0.537, 0.633, 0.776, 0.817, 0.914, 0.975, 1.093, 1.129, 1.154, 1.233, 1.297, 1.383, 1.455, 1.548, 1.612, 1.871], "QBold2": [0.068, 0.375, 0.553, 0.647, 0.684, 0.72, 0.853, 0.874, 0.994, 1.002, 1.087, 1.196, 1.256, 1.309, 1.354, 1.412, 1.431, 1.467, 1.582], "young3": [0.0, 0.015, 0.235, 0.325, 0.525, 0.69, 0.789, 0.859, 0.917, 0.975, 1.09, 1.138, 1.186, 1.273, 1.357, 1.578, 1.726, 1.869, 2.122], "QByoung3": [0.05, 0.343, 0.38, 0.551, 0.659, 0.772, 0.829, 0.895, 0.972, 1.015, 1.054, 1.111, 1.171, 1.328, 1.446, 1.586, 1.647, 1.72, 1.854], "prime3": [0.0, 0.0, 0.0, 0.078, 0.178, 0.388, 0.616, 0.778, 0.859, 1.003, 1.099, 1.201, 1.261, 1.345, 1.437, 1.559, 1.785, 1.988, 2.568], "QBprime3": [0.05, 0.343, 0.38, 0.551, 0.659, 0.772, 0.829, 0.895, 0.972, 1.015, 1.054, 1.111, 1.171, 1.328, 1.446, 1.586, 1.647, 1.72, 1.854], "old3": [0.0, 0.0, 0.253, 0.328, 0.53, 0.593, 0.621, 0.678, 0.89, 0.928, 0.967, 1.052, 1.19, 1.27, 1.356, 1.432, 1.609, 1.9, 2.217], "QBold3": [0.05, 0.343, 0.38, 0.551, 0.659, 0.772, 0.829, 0.895, 0.972, 1.015, 1.054, 1.111, 1.171, 1.328, 1.446, 1.586, 1.647, 1.72, 1.854]};
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
function expected(L, id, pos, age, k) {
  const { lvl } = levels(L), base = (lvl[id] || 0) / ppr(L, pos), aged = base * prodKeep(pos, age, k);
  const bd = (pos === 'QB' ? 'QB' : '') + band(age), c = COEF[bd + Math.min(3, k)];
  const v = dpVal(id);
  let e = c[0] + c[1] * aged + (c.length > 2 ? c[2] * Math.log(Math.max(300, v ?? 300)) : 0);
  if (c.length > 2 && v == null) e = aged; // no market value: fall back to the aged points
  return Math.max(0, e);
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
      const r = d < 0 ? 1 : RATIO[(pos === 'QB' ? 'QB' : '') + band(age) + Math.min(3, k)][qIdx(u01(id, d))];
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
