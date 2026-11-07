// Values at the time of a trade, from DynastyProcess weekly history (data/history/dp-values.json,
// refreshed by the weekly GitHub Action). DynastyProcess values are put on today's FantasyCalc scale by rank:
// the Nth most valuable asset on that date gets today's FC value of the Nth most valuable asset.
import { M } from './model.js';

let dpP = null;
export function loadDp() {
  if (!dpP) dpP = fetch('data/history/dp-values.json', { cache: 'no-cache' }).then(r => r.ok ? r.json() : null).catch(() => null);
  return dpP;
}

const ORD = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: '5th' };

export function makeValuer(dp, L) {
  if (!dp) return null;
  const fmt = L.fmt.numQbs === 2 ? 'sf' : 'one';
  const P = dp[fmt], K = dp.picks[fmt];
  const today = [...L.fc.byId.values()].map(x => x.value).concat([...L.fc.picks.values()]).sort((a, b) => b - a);
  const sortedAt = new Map();
  const at = i => {
    if (!sortedAt.has(i)) {
      const arr = [];
      for (const v of Object.values(P)) if (v[i] > 0) arr.push(v[i]);
      for (const v of Object.values(K)) if (v[i] > 0) arr.push(v[i]);
      sortedAt.set(i, arr.sort((a, b) => b - a));
    }
    return sortedAt.get(i);
  };
  const toFc = (v, i) => {
    const arr = at(i);
    if (!arr.length || !today.length) return v;
    let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] > v) lo = m + 1; else hi = m; }
    const q = lo / arr.length; // share of assets worth more
    return today[Math.min(today.length - 1, Math.floor(q * today.length))];
  };
  const idx = ms => { const d = new Date(ms).toISOString().slice(0, 10); let i = 0; for (let k = 0; k < dp.dates.length; k++) if (dp.dates[k] <= d) i = k; return i; };
  const near = (arr, i) => { if (!arr) return 0; for (let k = 0; k <= 3; k++) { if (arr[i - k] > 0) return arr[i - k]; if (arr[i + k] > 0) return arr[i + k]; } return 0; };
  return {
    date: ms => dp.dates[idx(ms)],
    player(id, ms) { const i = idx(ms); const v = near(P[id], i); return v ? toFc(v, i) : 0; },
    pick(season, round, ms) {
      const i = idx(ms), o = ORD[round] || round + 'th';
      let v = near(K[`${season} ${o}`], i) || near(K[`${season} Mid ${o}`], i);
      if (!v) { // that draft was the upcoming class: average its individual slots
        const xs = []; for (let s = 1; s <= 12; s++) { const x = near(K[`${season} Pick ${round}.${String(s).padStart(2, '0')}`], i); if (x) xs.push(x); }
        v = xs.length ? xs.reduce((a, b) => a + b) / xs.length : 0;
      }
      return v ? toFc(v, i) : 0;
    },
  };
}
