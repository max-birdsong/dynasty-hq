// Owner portfolios across the leagues you share: who they own a lot of, who they've been buying, who they've been
// selling. Owners get attached to players (and sour on them), and that's the cheapest edge in a negotiation.
import { M } from './model.js';
import { state } from './state.js';
import * as api from './api.js';
import { pool } from './util.js';
import { loadTrades, tradeSides } from './owners.js';
import { loadDp, makeValuer } from './history.js';

const RECENT = 90 * 864e5; // "lately" = last 90 days
let loading = null;

// M.affinity: Map(ownerId -> Map(pid -> { own: [leagueId], buy: [{lid, t, how}], sell: [{lid, t, how}] }))
export function loadAffinity() {
  if (loading) return loading;
  loading = (async () => {
    const A = new Map();
    // the weekly owner scan covers every dynasty league your opponents are in, not just yours
    M.ownersGlobal = (await fetch('data/owners.json', { cache: 'no-cache' }).then(r => r.ok ? r.json() : null).catch(() => null))?.owners || null;
    const dp = await loadDp().catch(() => null);
    // valuation tendencies: per owner, per asset class, how far from market (at the time) he buys and sells
    const T = new Map();
    const tslot = (o, c) => { const m = T.get(o) || T.set(o, {}).get(o); return m[c] || (m[c] = { buy: [], sell: [] }); };
    const slot = (o, pid) => { const m = A.get(o) || A.set(o, new Map()).get(o); return m.get(pid) || m.set(pid, { own: [], buy: [], sell: [] }).get(pid); };
    for (const L of M.leagues) {
      for (const t of L.teams) for (const pid of t.players) slot(t.ownerId, String(pid)).own.push(L.id);
      const owner = rid => L.teams.find(t => t.rid === +rid)?.ownerId;
      const trades = await loadTrades(L).catch(() => []);
      const valuer = dp ? makeValuer(dp, L) : null;
      for (const tr of trades) {
        let sides; try { sides = tradeSides(L, tr, valuer); } catch { continue; }
        for (const sd of Object.values(sides)) {
          if (!sd.ownerId) continue;
          const val = a => a.fcThen ?? a.fc ?? 0, cls = a => a.pick ? 'picks' : (a.pos || '?');
          const got = sd.got.reduce((x, a) => x + val(a), 0), gave = sd.gave.reduce((x, a) => x + val(a), 0);
          if (Math.max(got, gave) < 800 || !got || !gave) continue;
          const main = (arr, tot) => { const by = {}; for (const a of arr) by[cls(a)] = (by[cls(a)] || 0) + val(a); const [c, v] = Object.entries(by).sort((x, y) => y[1] - x[1])[0] || []; return v >= 0.6 * tot ? c : null; };
          const cin = main(sd.got, got), cout = main(sd.gave, gave);
          // only the side that conceded value reveals a preference: it paid over market for what it got (overvalues
          // that class) or took under market for what it gave (undervalues that). A fair or winning trade counts as 0.
          const conceded = got < gave * 0.95;
          if (cin && cin !== cout) tslot(sd.ownerId, cin).buy.push({ x: conceded ? gave / got - 1 : 0, lid: L.id, t: tr.created });
          if (cout && cout !== cin) tslot(sd.ownerId, cout).sell.push({ x: conceded ? got / gave - 1 : 0, lid: L.id, t: tr.created });
        }
      }
      const weeks = Array.from({ length: Math.max(1, Math.min(18, M.week)) }, (_, i) => i + 1);
      const tx = (await pool(weeks, 4, w => api.transactions(L.id, w, w < M.week - 1).catch(() => []))).flat()
        .filter(t => t && t.status === 'complete' && ['waiver', 'free_agent'].includes(t.type));
      for (const t of [...trades, ...tx]) {
        const when = t.status_updated || t.created, how = t.type === 'trade' ? 'trade' : 'waivers';
        if (Date.now() - when > RECENT) continue;
        for (const [pid, rid] of Object.entries(t.adds || {})) { const o = owner(rid); if (o) slot(o, String(pid)).buy.push({ lid: L.id, t: when, how }); }
        for (const [pid, rid] of Object.entries(t.drops || {})) { const o = owner(rid); if (o) slot(o, String(pid)).sell.push({ lid: L.id, t: when, how: how === 'trade' ? 'trade' : 'dropped' }); }
      }
    }
    M.affinity = A;
    M.tendencies = new Map([...T].map(([o, m]) => [o, Object.fromEntries(Object.entries(m).map(([c, d]) => {
      const xs = [...d.buy, ...d.sell].map(e => Math.max(-0.6, Math.min(0.6, e.x)));
      const n = xs.length, v = n ? xs.reduce((a, b) => a + b, 0) / n : 0;
      return [c, { v, n, buy: d.buy, sell: d.sell }];
    }))]));
    return A;
  })();
  return loading;
}

const nick = id => M.leagues.find(L => L.id === id)?.nick || 'another league';
const nm = id => M.players[id]?.full_name || id;

// how an owner feels about a player, as short notes. likes > 0 means attached / buying, < 0 means selling.
export function stance(ownerId, pid, hereLid) {
  const g = M.ownersGlobal?.[ownerId];
  if (g) {
    // across all his dynasty leagues
    const own = g.own[pid] || 0, buy = g.buy[pid] || 0, sell = g.sell[pid] || 0;
    const notes = []; let likes = 0;
    const e = g.hist?.[pid] || {};
    const how = [e.d && `drafted him ${e.d}×`, e.t && `traded for him ${e.t}×`, e.w && `picked him up ${e.w}×`].filter(Boolean);
    const gone = [e.x && `traded him away ${e.x}×`, e.r && `cut him ${e.r}×`].filter(Boolean);
    if (own >= 2) { notes.push(`rosters him in ${own} of his ${g.n} leagues${how.length ? ` (${how.join(', ')})` : ''}`); likes += own - 1 + (e.d || 0) * 0.5 + (e.t || 0); }
    else if (how.length) notes.push(how.join(', '));
    if (gone.length) { notes.push(gone.join(', ')); likes -= (e.x || 0); }
    if (buy) { notes.push(`added him ${buy}× in the last 90 days`); likes += 2 * buy; }
    if (sell && !e.x) { notes.push(`traded him away ${sell}× lately`); likes -= 2 * sell; } else if (sell) likes -= sell;
    if (notes.length) return { likes, notes, shared: g.n };
  }
  const a = M.affinity?.get(ownerId)?.get(String(pid));
  if (!a) return null;
  const shared = M.leagues.filter(L => L.teams.some(t => t.ownerId === ownerId)).length;
  const elsewhere = a.own.filter(l => l !== hereLid);
  const notes = [];
  let likes = 0;
  if (elsewhere.length) { notes.push(`owns him in ${elsewhere.length} other league${elsewhere.length > 1 ? 's' : ''} (${elsewhere.map(nick).join(', ')})`); likes += elsewhere.length; }
  const buys = a.buy.filter(b => b.lid !== hereLid || b.how === 'trade'), sells = a.sell;
  if (buys.length) { notes.push(`bought him lately (${buys.map(b => `${nick(b.lid)} via ${b.how}`).join(', ')})`); likes += 2 * buys.length; }
  if (sells.length) { notes.push(`moved on from him lately (${sells.map(s => `${nick(s.lid)}, ${s.how}`).join(', ')})`); likes -= 2 * sells.length; }
  return notes.length ? { likes, notes, shared } : null;
}

// flags for a trade: what the partner thinks of each player moving
export function affinityFlags(L, partner, r) {
  if (!M.affinity) return [];
  const f = [];
  for (const a of r.give) if (a.id) { const s = stance(partner.ownerId, a.id, L.id); if (s) f.push({ info: true, msg: `${s.likes > 0 ? '👍' : '👎'} ${partner.owner} ${s.notes.join('; ')}: ${nm(a.id)} is ${s.likes > 0 ? 'someone he likes, a selling point' : 'someone he’s been getting rid of, expect resistance'}.` }); }
  // his leans by asset class, where this trade touches them
  const td = tendencies(partner.ownerId);
  const give = new Set(r.give.map(a => a.pick ? 'picks' : a.pos)), get = new Set(r.get.map(a => a.pick ? 'picks' : a.pos));
  for (const x of td) {
    const what = `${partner.owner} tends to ${x.v > 0 ? 'overvalue' : 'undervalue'} ${CLS[x.c]} (${x.detail})`;
    if (give.has(x.c)) f.push({ info: true, msg: `${x.v > 0 ? '👍' : '👎'} ${what}: ${x.v > 0 ? 'good that they’re in your offer' : 'he’ll discount them'}.` });
    else if (get.has(x.c)) f.push({ info: true, msg: `${x.v > 0 ? '⚠️' : '💡'} ${what}: ${x.v > 0 ? 'he’ll want more for them' : 'he may sell them cheaply'}.` });
  }
  for (const a of r.get) if (a.id) { const s = stance(partner.ownerId, a.id, L.id); if (s) f.push({ info: true, msg: `${s.likes > 0 ? '⚠️' : '💡'} ${partner.owner} ${s.notes.join('; ')}: ${s.likes > 0 ? 'expect to pay a premium for ' + nm(a.id) : 'he may let ' + nm(a.id) + ' go cheaply'}.` }); }
  return f;
}

// an owner's portfolio for the owner card
export function portfolio(ownerId) {
  const g = M.ownersGlobal?.[ownerId];
  if (g) {
    const rows = (o, f) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([pid, n]) => ({ pid, name: nm(pid), pos: M.players[pid]?.position, own: n, label: f(n) }));
    const howShort = pid => { const e = g.hist?.[pid]; if (!e) return ''; const p = [e.d && `${e.d}d`, e.t && `${e.t}t`, e.w && `${e.w}w`, e.x && `−${e.x}`].filter(Boolean); return p.length ? ` (${p.join(' ')})` : ''; };
    return { all: true, n: g.n, core: rows(g.own, n => `${n}/${g.n}`).map(r => ({ ...r, label: r.label + howShort(r.pid) })), buying: rows(g.buy, n => n), selling: rows(g.sell, n => n) };
  }
  const m = M.affinity?.get(ownerId);
  if (!m) return null;
  const rows = [...m.entries()].map(([pid, a]) => ({ pid, name: nm(pid), pos: M.players[pid]?.position, own: a.own.length, buy: a.buy, sell: a.sell }));
  return {
    core: rows.filter(r => r.own >= 2).sort((a, b) => b.own - a.own).slice(0, 8),
    buying: rows.filter(r => r.buy.length).sort((a, b) => Math.max(...b.buy.map(x => x.t)) - Math.max(...a.buy.map(x => x.t))).slice(0, 8),
    selling: rows.filter(r => r.sell.length && !r.buy.length).sort((a, b) => Math.max(...b.sell.map(x => x.t)) - Math.max(...a.sell.map(x => x.t))).slice(0, 8),
  };
}

const CLS = { picks: 'picks', QB: 'QBs', RB: 'RBs', WR: 'WRs', TE: 'TEs' };
// "Overvalues RBs (+18% over market, 3 trades)": at least 2 trades and a 10% lean
function tendMap(ownerId) {
  const loc = M.tendencies?.get(ownerId) || {}, glo = M.ownersGlobal?.[ownerId]?.tend || {};
  const out = {};
  for (const c of new Set([...Object.keys(loc), ...Object.keys(glo)])) out[c] = (glo[c]?.n || 0) >= (loc[c]?.n || 0) ? glo[c] : loc[c];
  return out;
}
export function tendencies(ownerId) {
  const m = tendMap(ownerId);
  if (!Object.keys(m).length) return [];
  return Object.entries(m).filter(([c, d]) => CLS[c] && d.n >= 2 && Math.abs(d.v) >= 0.1)
    .map(([c, d]) => ({ c, v: d.v, n: d.n, label: `${d.v > 0 ? 'Overvalues' : 'Undervalues'} ${CLS[c]}`, detail: `${d.v > 0 ? '+' : ''}${Math.round(d.v * 100)}% vs market, ${d.n} trades` }))
    .sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
}
// how much an owner's view of an asset differs from market: shrunk toward 1 with few trades, capped at ±25%
export function biasFactor(ownerId, a) {
  const d = tendMap(ownerId)[a.pick ? 'picks' : a.pos];
  if (!d || d.n < 2) return 1;
  return 1 + Math.max(-0.25, Math.min(0.25, d.v)) * d.n / (d.n + 2);
}

// ---------- behaviour profile (from the weekly scan across all his leagues) ----------
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const CALC_NAME = { ktc: 'KeepTradeCut', fc: 'FantasyCalc', dp: 'DynastyProcess' };
export function behaviour(ownerId) {
  const g = M.ownersGlobal?.[ownerId];
  if (!g?.act) return [];
  const out = [];
  const days = (Date.now() - (g.act.last || 0)) / 864e5;
  const months = Math.max(1, (Date.now() - Date.parse(`${M.season || new Date().getFullYear()}-08-15`)) / (30 * 864e5));
  const tpm = g.act.trades / months;
  if (!g.act.last || days > 30) out.push({ kind: 'bad', label: 'Dormant', why: g.act.last ? `No moves in ${Math.round(days)} days across his ${g.n} leagues: offers may sit unanswered` : 'No moves this season' });
  else out.push({ kind: tpm >= 4 ? 'good' : '', label: tpm >= 4 ? 'Very active' : tpm >= 1 ? 'Active' : 'Quiet', why: `Last move ${days < 1 ? 'today' : Math.round(days) + 'd ago'} · ${tpm.toFixed(1)} trades/month · ${g.act.waivers} waiver adds this season (all ${g.n} leagues)` });
  // when he trades (Berlin time): best 3-hour window and top days
  const nT = g.when.h.reduce((a, b) => a + b, 0);
  if (nT >= 4) {
    let best = 0, bh = 0; for (let h = 0; h < 24; h++) { const s = g.when.h[h] + g.when.h[(h + 1) % 24] + g.when.h[(h + 2) % 24]; if (s > best) { best = s; bh = h; } }
    const topD = g.when.d.map((n, i) => [n, i]).sort((a, b) => b[0] - a[0]).filter(([n]) => n >= nT * 0.2).slice(0, 2).map(([, i]) => DAYS[i]);
    out.push({ kind: '', label: `Trades ${topD.join('/') || 'any day'} ${String(bh).padStart(2, '0')}–${String((bh + 3) % 24).padStart(2, '0')}h`, why: `${Math.round(best / nT * 100)}% of his ${nT} trades happened in that window (Berlin time). Send offers just before.` });
  }
  if (g.lineup?.weeks >= 6) {
    const r = g.lineup.holes / g.lineup.weeks;
    if (r >= 0.1) out.push({ kind: 'bad', label: 'Leaves lineup holes', why: `Empty starting slots in ${g.lineup.holes} of ${g.lineup.weeks} team-weeks: checked out in some leagues` });
  }
  if (g.panic?.sold >= 3 && g.panic.panic / g.panic.sold >= 0.3) out.push({ kind: 'good', label: 'Panic seller', why: `${g.panic.panic} of ${g.panic.sold} players he traded away had dropped 20%+ in value in the three weeks before. Buy from him right after bad news.` });
  const cs = Object.entries(g.calc || {}).filter(([, c]) => c.n >= 3).sort((a, b) => a[1].e - b[1].e);
  // your own offers to him overrule the scan: a no on an offer that was clearly good for him on calculator k, or a
  // yes on one that was bad for him on k, counts against k
  const mine = state().trades.filter(t => t.partnerOwnerId === ownerId && t.calcEdges && ['accepted', 'rejected', 'ignored', 'withdrawn'].includes(t.status));
  const against = k => mine.filter(t => { const e = t.calcEdges[k]; if (e == null) return false; return t.status === 'accepted' ? e <= -0.05 : e >= 0.05; }).length;
  const forIt = k => mine.filter(t => { const e = t.calcEdges[k]; return e != null && (t.status === 'accepted' ? e >= -0.02 : e < 0); }).length;
  let pick = cs.length >= 2 && cs[0][1].e < cs[1][1].e * 0.8 ? cs[0][0] : null;
  if (mine.length) {
    const ks = ['ktc', 'fc', 'dp'].filter(k => mine.some(t => t.calcEdges[k] != null));
    const score = k => forIt(k) - 2 * against(k) + (k === pick ? 1 : 0);
    const best = ks.sort((a, b) => score(b) - score(a))[0];
    if (pick && against(pick) > 0) pick = best && against(best) === 0 ? best : null;
    else if (!pick && best && against(best) === 0 && forIt(best) >= 2) pick = best;
  }
  if (pick) {
    const c = g.calc?.[pick], hist = mine.length ? ` Your ${mine.length} offer${mine.length > 1 ? 's' : ''} to him: ${against(pick) ? against(pick) + ' contradict it' : 'consistent with it'}.` : '';
    out.push({ kind: '', label: `Trades by ${CALC_NAME[pick]}${mine.length && against(pick) === 0 && forIt(pick) ? ' ✓' : ''}`, calc: pick,
      why: (c ? `His last ${c.n} trades were ${Math.round(c.e * 100)}% off even on ${CALC_NAME[pick]}.` : 'Based on how he answered your offers.') + hist + ' Pitch offers in those numbers.' });
  } else if (cs.length >= 2 && cs[0][1].e < cs[1][1].e * 0.8) out.push({ kind: 'bad', label: 'Calculator unclear', why: `His trades looked like ${CALC_NAME[cs[0][0]]}, but he turned down an offer that was clearly good for him there. Treat his valuations as his own.` });
  return out;
}
export const preferredCalc = ownerId => behaviour(ownerId).find(b => b.calc)?.calc || null;
