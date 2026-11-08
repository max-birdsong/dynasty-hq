// Owner portfolios across the leagues you share: who they own a lot of, who they've been buying, who they've been
// selling. Owners get attached to players (and sour on them), and that's the cheapest edge in a negotiation.
import { M } from './model.js';
import * as api from './api.js';
import { pool } from './util.js';
import { loadTrades } from './owners.js';

const RECENT = 90 * 864e5; // "lately" = last 90 days
let loading = null;

// M.affinity: Map(ownerId -> Map(pid -> { own: [leagueId], buy: [{lid, t, how}], sell: [{lid, t, how}] }))
export function loadAffinity() {
  if (loading) return loading;
  loading = (async () => {
    const A = new Map();
    const slot = (o, pid) => { const m = A.get(o) || A.set(o, new Map()).get(o); return m.get(pid) || m.set(pid, { own: [], buy: [], sell: [] }).get(pid); };
    for (const L of M.leagues) {
      for (const t of L.teams) for (const pid of t.players) slot(t.ownerId, String(pid)).own.push(L.id);
      const owner = rid => L.teams.find(t => t.rid === +rid)?.ownerId;
      const trades = await loadTrades(L).catch(() => []);
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
    return A;
  })();
  return loading;
}

const nick = id => M.leagues.find(L => L.id === id)?.nick || 'another league';
const nm = id => M.players[id]?.full_name || id;

// how an owner feels about a player, as short notes. likes > 0 means attached / buying, < 0 means selling.
export function stance(ownerId, pid, hereLid) {
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
  for (const a of r.get) if (a.id) { const s = stance(partner.ownerId, a.id, L.id); if (s) f.push({ info: true, msg: `${s.likes > 0 ? '⚠️' : '💡'} ${partner.owner} ${s.notes.join('; ')}: ${s.likes > 0 ? 'expect to pay a premium for ' + nm(a.id) : 'he may let ' + nm(a.id) + ' go cheaply'}.` }); }
  return f;
}

// an owner's portfolio for the owner card
export function portfolio(ownerId) {
  const m = M.affinity?.get(ownerId);
  if (!m) return null;
  const rows = [...m.entries()].map(([pid, a]) => ({ pid, name: nm(pid), pos: M.players[pid]?.position, own: a.own.length, buy: a.buy, sell: a.sell }));
  return {
    core: rows.filter(r => r.own >= 2).sort((a, b) => b.own - a.own).slice(0, 8),
    buying: rows.filter(r => r.buy.length).sort((a, b) => Math.max(...b.buy.map(x => x.t)) - Math.max(...a.buy.map(x => x.t))).slice(0, 8),
    selling: rows.filter(r => r.sell.length && !r.buy.length).sort((a, b) => Math.max(...b.sell.map(x => x.t)) - Math.max(...a.sell.map(x => x.t))).slice(0, 8),
  };
}
