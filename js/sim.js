// Monte Carlo season simulator: remaining regular season (with optional median game) + playoff bracket.
import { randn } from './util.js';

// Standard seeded bracket for n teams (byes for top seeds when n isn't a power of two)
function bracketOrder(size) {
  let order = [1];
  while (order.length < size) {
    const m = order.length * 2 + 1;
    order = order.flatMap(s => [s, m - s]);
  }
  return order;
}

/**
 * L: { teams:[{rid, wins, losses, ties, fpts}], weekly: {rid: {week: mean}}, schedule: {week: [[ridA, ridB], ...]},
 *      regWeeks:[...], playoffStart, playoffTeams, median:bool }
 */
export function simulate(L, { runs = 2000, sd = 0.18 } = {}) {
  const rids = L.teams.map(t => t.rid);
  const res = Object.fromEntries(rids.map(r => [r, { playoff: 0, title: 0, wins: 0, seed: 0, final: 0, bye: 0 }]));
  const base = Object.fromEntries(L.teams.map(t => [t.rid, t]));
  const avgMean = rid => { const w = Object.values(L.weekly[rid] || {}); return w.length ? w.reduce((a, b) => a + b, 0) / w.length : 0; };
  const mean = (rid, wk) => L.weekly[rid]?.[wk] ?? avgMean(rid);
  const draw = (rid, wk) => Math.max(0, mean(rid, wk) * (1 + sd * randn()));
  const n = Math.min(L.playoffTeams || 6, rids.length);
  const rounds = Math.ceil(Math.log2(Math.max(2, n)));
  const size = 2 ** rounds;
  const order = bracketOrder(size);

  for (let r = 0; r < runs; r++) {
    const W = {}, P = {};
    for (const rid of rids) { W[rid] = base[rid].wins + 0.5 * (base[rid].ties || 0); P[rid] = base[rid].fpts || 0; }
    for (const wk of L.regWeeks) {
      const sc = {};
      for (const rid of rids) { sc[rid] = draw(rid, wk); P[rid] += sc[rid]; }
      const pairs = L.schedule[wk];
      if (pairs && pairs.length) {
        for (const [a, b] of pairs) { if (b == null) continue; if (sc[a] > sc[b]) W[a]++; else W[b]++; }
      } else {
        const sh = [...rids].sort(() => Math.random() - 0.5);
        for (let i = 0; i + 1 < sh.length; i += 2) sc[sh[i]] > sc[sh[i + 1]] ? W[sh[i]]++ : W[sh[i + 1]]++;
      }
      if (L.median) {
        const s = Object.values(sc).sort((a, b) => a - b); const med = (s[Math.floor((s.length - 1) / 2)] + s[Math.ceil((s.length - 1) / 2)]) / 2;
        for (const rid of rids) if (sc[rid] > med) W[rid]++;
      }
    }
    const standings = [...rids].sort((a, b) => W[b] - W[a] || P[b] - P[a]);
    standings.forEach((rid, i) => { res[rid].seed += i + 1; res[rid].wins += W[rid]; });
    const seeds = standings.slice(0, n);
    seeds.forEach(rid => res[rid].playoff++);
    // bracket
    let slots = order.map(s => (s <= n ? seeds[s - 1] : null));
    if (n < size) seeds.slice(0, size - n).forEach(rid => res[rid].bye++);
    let wk = L.playoffStart || 15;
    while (slots.length > 1) {
      const next = [];
      for (let i = 0; i < slots.length; i += 2) {
        const a = slots[i], b = slots[i + 1];
        if (a == null || b == null) { next.push(a ?? b); continue; }
        next.push(draw(a, wk) >= draw(b, wk) ? a : b);
      }
      if (next.length === 2) next.forEach(rid => rid != null && res[rid].final++);
      slots = next; wk++;
    }
    if (slots[0] != null) res[slots[0]].title++;
  }
  for (const rid of rids) {
    const o = res[rid];
    o.playoff /= runs; o.title /= runs; o.wins /= runs; o.seed /= runs; o.final /= runs; o.bye /= runs;
  }
  return res;
}
