// Chance a partner accepts an offer. Logistic model with sensible starting weights, then learned from your own
// offer log (accepted vs rejected / ignored / withdrawn): Sleeper never shows rejected offers, so your log is the
// only data that can teach it. Each logged offer stores the features below at the time you sent it.
import { M } from './model.js';
import { state } from './state.js';
import { behaviour, preferredCalc, stance } from './affinity.js';
import { calcEdge } from './trade.js';

// starting weights: an even offer on his calculator to an active owner ≈ 25-30%, +10% for him ≈ 45-50%,
// -10% ≈ 10%, a dormant owner ≈ a quarter of that
export const PRIOR = { bias: -0.9, edge: 9, goal: 0.6, fav: -0.5, pieces: -0.12, active: 0.4, dormant: -1.5, rejectedBefore: -0.8 };
const KEYS = Object.keys(PRIOR);
const sig = x => 1 / (1 + Math.exp(-x));

export function features(L, partner, r) {
  const pc = preferredCalc(partner.ownerId);
  const edge = pc && pc !== 'fc' && M.calcs?.[pc] ? calcEdge(L, r.give, r.get, pc) : (r.fc ? r.fc.partnerMargin / Math.max(1, r.fc.A, r.fc.B) : 0);
  const bh = behaviour(partner.ownerId);
  const lbl = bh[0]?.label || '';
  // past no's from this owner: full weight in this league, half weight in your other shared leagues
  const no = t => ['rejected', 'ignored', 'withdrawn'].includes(t.status);
  const prev = state().trades.filter(t => no(t) && (t.partnerOwnerId === partner.ownerId || (t.leagueId === L.id && t.partnerRid === partner.rid)))
    .reduce((s, t) => s + (t.leagueId === L.id ? 1 : 0.5), 0);
  return {
    bias: 1,
    edge: Math.max(-0.4, Math.min(0.4, edge)),
    goal: r.theirGoal || (r.them && r.them.rosAfter > r.them.rosBefore + 2 && partner.mode === 'contend') ? 1 : 0,
    fav: r.get.filter(a => a.id && (stance(partner.ownerId, a.id, L.id)?.likes || 0) >= 2).length,
    pieces: r.give.length + r.get.length,
    active: /active/i.test(lbl) ? 1 : 0,
    dormant: lbl === 'Dormant' ? 1 : 0,
    rejectedBefore: Math.min(2, prev),
  };
}

// weights: prior, pulled toward your logged outcomes once there are a few (MAP logistic regression, prior sd 1)
let cache = null;
export function weights() {
  const data = state().trades.filter(t => t.features && ['accepted', 'rejected', 'ignored', 'withdrawn'].includes(t.status));
  const key = data.map(t => t.id + t.status).join();
  if (cache?.key === key) return cache.w;
  const w = { ...PRIOR };
  if (data.length >= 5) {
    for (let it = 0; it < 300; it++) {
      const g = Object.fromEntries(KEYS.map(k => [k, -(w[k] - PRIOR[k])])); // prior pull
      for (const t of data) { const y = t.status === 'accepted' ? 1 : 0, p = sig(KEYS.reduce((s, k) => s + w[k] * (t.features[k] || 0), 0)); for (const k of KEYS) g[k] += (y - p) * (t.features[k] || 0); }
      for (const k of KEYS) w[k] += 0.05 * g[k];
    }
  }
  cache = { key, w, n: data.length };
  return w;
}
export const learnedFrom = () => (weights(), cache?.n || 0);

export function pAccept(L, partner, r) {
  const f = features(L, partner, r), w = weights();
  const p = sig(KEYS.reduce((s, k) => s + w[k] * (f[k] || 0), 0));
  return { p, f };
}

// plain-English reasons, biggest first
export function reasons(f) {
  const w = weights(), out = [];
  if (f.edge) out.push([w.edge * f.edge, `${Math.abs(Math.round(f.edge * 100))}% ${f.edge >= 0 ? 'in his favour' : 'against him'} on his calculator`]);
  if (f.goal) out.push([w.goal, 'meets a need of his']);
  if (f.fav) out.push([w.fav * f.fav, `asks for ${f.fav} player${f.fav > 1 ? 's' : ''} he's attached to`]);
  if (f.dormant) out.push([w.dormant, 'he’s been inactive']);
  else if (f.active) out.push([w.active, 'he trades a lot']);
  if (f.rejectedBefore) out.push([w.rejectedBefore * f.rejectedBefore, `he turned down your offers before (${f.rejectedBefore % 1 ? f.rejectedBefore.toFixed(1) : f.rejectedBefore}, other leagues count half)`]);
  if (f.pieces >= 5) out.push([w.pieces * f.pieces, `${f.pieces} pieces is a lot to process`]);
  return out.sort((a, b) => Math.abs(b[0]) - Math.abs(a[0])).map(([v, s]) => (v >= 0 ? '+ ' : '− ') + s);
}
