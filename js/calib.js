// Calibrates the simulator on what has actually happened in your leagues this season.
// For every team-week played so far: projected best lineup (Sleeper's projections for that week, the roster that
// week, the league's scoring) vs the points actually scored. Pooled across all leagues, then split into
//   bias      - do projections run high or low overall
//   sdWeek    - week-to-week noise (pure luck, does not carry over)
//   sdSeason  - error that persists for a team all season (roster mis-rated, bad lineup setting, ...)
// A team's own record of beating/missing projections only counts in proportion to how much of the error
// turns out to persist (empirical Bayes shrinkage), so a team that's merely been unlucky is not penalised.
import { scoreStats, bestLineup } from './lineup.js';
import { DEFAULT_PARAMS } from './sim.js';

const phi = x => 0.5 * (1 + erf(x / Math.SQRT2));
function erf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }

export function calibrate(leagues, projPast, players, posOf, { minN = 150 } = {}) {
  const rows = [];   // {key, L, rid, w, proj, actual, r}
  const games = [];  // pairs for accuracy check
  for (const L of leagues) {
    for (const [w, arr] of Object.entries(L.pastMatchups || {})) {
      const proj = projPast[w];
      if (!proj) continue;
      const byMatch = {};
      for (const m of arr) {
        if (!m.players?.length || !(m.points > 0)) continue;
        const pts = {};
        for (const id of m.players) pts[id] = scoreStats(proj[id], L.scoring, players[id]?.position);
        const p = bestLineup(m.players, pts, posOf, L.slots).total;
        if (p < 40) continue;
        const r = Math.max(-0.8, Math.min(1.5, m.points / p - 1));
        const row = { key: L.id + ':' + m.roster_id, L, rid: m.roster_id, w: +w, proj: p, actual: m.points, r };
        rows.push(row);
        if (m.matchup_id != null) (byMatch[m.matchup_id] ||= []).push(row);
      }
      for (const g of Object.values(byMatch)) if (g.length === 2) games.push(g);
    }
  }
  const N = rows.length;
  if (N < minN) return { ok: false, n: N, params: { ...DEFAULT_PARAMS }, teamAdj: {}, note: `Only ${N} team-weeks so far; using default spreads until there are ${minN}.` };

  const bias = rows.reduce((s, x) => s + x.r, 0) / N;
  const groups = new Map();
  for (const x of rows) { if (!groups.has(x.key)) groups.set(x.key, []); groups.get(x.key).push(x); }
  const G = groups.size;
  let ssw = 0, ssb = 0, sumN2 = 0;
  const gm = new Map();
  for (const [k, g] of groups) {
    const m = g.reduce((s, x) => s + x.r, 0) / g.length;
    gm.set(k, { n: g.length, mean: m, proj: g.reduce((s, x) => s + x.proj, 0) / g.length, actual: g.reduce((s, x) => s + x.actual, 0) / g.length });
    for (const x of g) ssw += (x.r - m) ** 2;
    ssb += g.length * (m - bias) ** 2; sumN2 += g.length ** 2;
  }
  const msw = ssw / Math.max(1, N - G);
  const msb = ssb / Math.max(1, G - 1);
  const n0 = (N - sumN2 / N) / Math.max(1, G - 1);
  const varSeason = Math.max(0, (msb - msw) / n0);
  const sdWeek = Math.sqrt(msw), sdSeason = Math.sqrt(varSeason);

  // ---- shape and scale of the weekly noise ----
  // Fit how the spread grows with the projection: sd(points) = c * proj^gamma (gamma 1 = proportional, 0 = same for everyone)
  const pts = rows.map(x => ({ x, e: x.actual - x.proj * (1 + bias) }));
  const sorted = [...pts].sort((a, b) => a.x.proj - b.x.proj);
  const nb = 6, bins6 = [];
  for (let i = 0; i < nb; i++) {
    const g = sorted.slice(Math.floor(i * N / nb), Math.floor((i + 1) * N / nb));
    if (g.length < 10) continue;
    const m = g.reduce((s, p) => s + p.e, 0) / g.length;
    bins6.push({ proj: g.reduce((s, p) => s + p.x.proj, 0) / g.length, rms: Math.sqrt(g.reduce((s, p) => s + (p.e - m) ** 2, 0) / (g.length - 1)) });
  }
  let gamma = 1, c = sdWeek;
  if (bins6.length >= 3) {
    const X = bins6.map(b => Math.log(b.proj)), Y = bins6.map(b => Math.log(b.rms));
    const mx = X.reduce((a, b) => a + b) / X.length, my = Y.reduce((a, b) => a + b) / Y.length;
    const sxy = X.reduce((s, x, i) => s + (x - mx) * (Y[i] - my), 0), sxx = X.reduce((s, x) => s + (x - mx) ** 2, 0);
    gamma = Math.max(0, Math.min(1.3, sxx ? sxy / sxx : 1));
    c = Math.exp(my - gamma * mx);
  }
  // Standardised residuals, with each team's own average removed (that part is season-long, handled separately).
  // The simulator resamples these, so it reproduces the real shape of good and bad weeks (skew, fat tails).
  const byTeam = new Map();
  for (const p of pts) { const z = p.e / (c * p.x.proj ** gamma); if (!byTeam.has(p.x.key)) byTeam.set(p.x.key, []); byTeam.get(p.x.key).push(z); }
  let zs = [];
  for (const g of byTeam.values()) { if (g.length < 2) continue; const m = g.reduce((a, b) => a + b) / g.length, k = Math.sqrt(g.length / (g.length - 1)); for (const z of g) zs.push((z - m) * k); }
  const zm = zs.reduce((a, b) => a + b, 0) / zs.length, zsd = Math.sqrt(zs.reduce((s, z) => s + (z - zm) ** 2, 0) / (zs.length - 1));
  zs = zs.map(z => (z - zm) / zsd);
  const zsorted = [...zs].sort((a, b) => a - b), q = p => zsorted[Math.floor(p * (zsorted.length - 1))];
  const skew = zs.reduce((s, z) => s + z ** 3, 0) / zs.length;
  const shape = { gamma, c, bins: bins6, skew, p05: q(0.05), p95: q(0.95), p01: q(0.01), p99: q(0.99), n: zs.length };

  const teamAdj = {};
  for (const [k, s] of gm) {
    const shrink = varSeason / (varSeason + msw / s.n);
    teamAdj[k] = { ...s, shrink, adj: shrink * (s.mean - bias) };
  }

  // how well did the model call games so far? (win probability from projections + measured spreads)
  const sdTot = Math.sqrt(msw + varSeason);
  let brier = 0; const bins = [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 1.01]].map(([lo, hi]) => ({ lo, hi, n: 0, wins: 0, p: 0 }));
  for (const [a, b] of games) {
    const ma = a.proj * (1 + bias), mb = b.proj * (1 + bias);
    const pA = phi((ma - mb) / Math.sqrt((a.proj * sdTot) ** 2 + (b.proj * sdTot) ** 2));
    const aWon = a.actual > b.actual ? 1 : 0;
    brier += (pA - aWon) ** 2;
    const fav = pA >= 0.5 ? pA : 1 - pA, favWon = pA >= 0.5 ? aWon : 1 - aWon;
    const bin = bins.find(x => fav >= x.lo && fav < x.hi); if (bin) { bin.n++; bin.wins += favWon; bin.p += fav; }
  }
  brier = games.length ? brier / games.length : null;
  bins.forEach(b => { b.p = b.n ? b.p / b.n : null; b.rate = b.n ? b.wins / b.n : null; });
  const favRight = games.length ? bins.reduce((s, b) => s + b.wins, 0) / games.length : null;

  return {
    ok: true, n: N, teams: G, games: games.length, weeks: [...new Set(rows.map(x => x.w))].length,
    params: { ...DEFAULT_PARAMS, bias, sdWeek, sdSeason, noise: { c, gamma, z: zs } },
    shape,
    teamAdj, brier, bins, favRight,
    meanAbsErr: rows.reduce((s, x) => s + Math.abs(x.actual - x.proj * (1 + bias)), 0) / N,
  };
}
