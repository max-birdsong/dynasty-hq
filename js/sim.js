// Monte Carlo season simulator.
// Each simulated season, every team gets:
//   - a season-long strength shock (projection error that persists all season, measured from your leagues)
//   - an independent week-to-week shock (measured from your leagues)
//   - an injury process: each projected starter can get hurt in a future week and miss a few weeks,
//     costing the gap between him and his bench replacement
// Scores = projection x (1 + bias + team adjustment + season shock + weekly shock) - injury losses.
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function bracketOrder(size) {
  let order = [1];
  while (order.length < size) { const m = order.length * 2 + 1; order = order.flatMap(s => [s, m - s]); }
  return order;
}

export const DEFAULT_PARAMS = { bias: 0, sdWeek: 0.17, sdSeason: 0.06, injRate: 0.035, injRecover: 0.35 };

/**
 * L: { teams:[{rid,wins,losses,ties,fpts}], weekly:{rid:{week:mean}}, drops:{rid:{week:[[pid,drop],...]}},
 *      adj:{rid:number}, schedule, regWeeks, playoffStart, playoffTeams, median, firstWeek }
 */
export function simulate(L, { runs = 2000, params = DEFAULT_PARAMS, seed = null } = {}) {
  // a fixed seed gives "common random numbers": before/after comparisons of a trade see the same luck
  const rand = seed == null ? Math.random : mulberry32(seed);
  const randn = () => { let u = 0, v = 0; while (!u) u = rand(); while (!v) v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const P = { ...DEFAULT_PARAMS, ...params };
  const rids = L.teams.map(t => t.rid);
  const res = Object.fromEntries(rids.map(r => [r, { playoff: 0, title: 0, wins: 0, seed: 0, final: 0, bye: 0, pts: 0 }]));
  const base = Object.fromEntries(L.teams.map(t => [t.rid, t]));
  const avgMean = {};
  for (const rid of rids) { const w = Object.values(L.weekly[rid] || {}); avgMean[rid] = w.length ? w.reduce((a, b) => a + b, 0) / w.length : 0; }
  const n = Math.min(L.playoffTeams || 6, rids.length);
  const rounds = Math.ceil(Math.log2(Math.max(2, n)));
  const size = 2 ** rounds;
  const order = bracketOrder(size);
  const lastWeek = (L.playoffStart || 15) + rounds - 1;
  const allWeeks = [...L.regWeeks]; for (let w = L.playoffStart || 15; w <= lastWeek; w++) allWeeks.push(w);
  const firstWeek = L.firstWeek ?? allWeeks[0];

  for (let r = 0; r < runs; r++) {
    // parameter uncertainty: each simulated season uses its own plausible version of the model's settings,
    // so the odds reflect how sure we are about the model, not just luck
    let sdSeason = P.sdSeason, nz = P.noise;
    if (P.seasonVar) sdSeason = Math.sqrt(Math.max(0, P.seasonVar.est + P.seasonVar.se * randn()) + (P.horizon || 0) ** 2);
    if (nz && nz.mx) {
      const g = Math.max(0, Math.min(1.3, nz.gamma + nz.gammaSE * randn()));
      nz = { ...nz, gamma: g, c: Math.exp(nz.my - g * nz.mx) * (1 + nz.relSE * randn()) };
    }
    // season-level draws
    const mult = {}, inj = {}, score = {};
    for (const rid of rids) { mult[rid] = 1 + P.bias + (L.adj?.[rid] || 0) + sdSeason * randn(); inj[rid] = new Map(); score[rid] = {}; }
    // week-by-week scores for this season (regular + playoffs), with injuries carrying over between weeks
    for (const wk of allWeeks) {
      for (const rid of rids) {
        const mu = L.weekly[rid]?.[wk] ?? avgMean[rid];
        let loss = 0;
        const drops = L.drops?.[rid]?.[wk];
        if (drops && wk > firstWeek) {
          const st = inj[rid];
          for (const [pid, d] of drops) {
            let out = st.get(pid) || false;
            out = out ? rand() > P.injRecover : rand() < P.injRate;
            st.set(pid, out);
            if (out) loss += d;
          }
        }
        const base = (mu - loss) * mult[rid];
        // weekly luck: resample real standardised residuals from your leagues (keeps skew and fat tails),
        // scaled the way the data says spread grows with the projection; normal curve if not calibrated
        const noise = nz ? nz.c * Math.pow(Math.max(1, base), nz.gamma) * nz.z[Math.floor(rand() * nz.z.length)]
          : base * P.sdWeek * randn();
        score[rid][wk] = Math.max(0, base + noise);
      }
    }
    const W = {}, PF = {};
    for (const rid of rids) { W[rid] = base[rid].wins + 0.5 * (base[rid].ties || 0); PF[rid] = base[rid].fpts || 0; }
    for (const wk of L.regWeeks) {
      const sc = {}; for (const rid of rids) { sc[rid] = score[rid][wk]; PF[rid] += sc[rid]; }
      const pairs = L.schedule[wk];
      if (pairs && pairs.length) { for (const [a, b] of pairs) { if (b == null) continue; sc[a] > sc[b] ? W[a]++ : W[b]++; } }
      else { const sh = [...rids].sort(() => rand() - 0.5); for (let i = 0; i + 1 < sh.length; i += 2) sc[sh[i]] > sc[sh[i + 1]] ? W[sh[i]]++ : W[sh[i + 1]]++; }
      if (L.median) {
        const s = Object.values(sc).sort((a, b) => a - b); const med = (s[Math.floor((s.length - 1) / 2)] + s[Math.ceil((s.length - 1) / 2)]) / 2;
        for (const rid of rids) if (sc[rid] > med) W[rid]++;
      }
    }
    const standings = [...rids].sort((a, b) => W[b] - W[a] || PF[b] - PF[a]);
    standings.forEach((rid, i) => { res[rid].seed += i + 1; res[rid].wins += W[rid]; res[rid].pts += PF[rid]; });
    const seeds = standings.slice(0, n);
    seeds.forEach(rid => res[rid].playoff++);
    let slots = order.map(s => (s <= n ? seeds[s - 1] : null));
    if (n < size) seeds.slice(0, size - n).forEach(rid => res[rid].bye++);
    let wk = L.playoffStart || 15;
    while (slots.length > 1) {
      const next = [];
      for (let i = 0; i < slots.length; i += 2) {
        const a = slots[i], b = slots[i + 1];
        if (a == null || b == null) { next.push(a ?? b); continue; }
        next.push(score[a][wk] >= score[b][wk] ? a : b);
      }
      if (next.length === 2) next.forEach(rid => rid != null && res[rid].final++);
      slots = next; wk++;
    }
    if (slots[0] != null) res[slots[0]].title++;
  }
  for (const rid of rids) for (const k of Object.keys(res[rid])) res[rid][k] /= runs;
  return res;
}
