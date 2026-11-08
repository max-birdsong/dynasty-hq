// Waiver farm, harvest side: what you've grown, when to sell it, who pays, how to package the picks,
// what to stash before the injury, what to bid, and which roster spots are wasted.
import { M, asset, teamAssets, startersNow, playerWeekPts } from './model.js';
import * as api from './api.js';
import { pool } from './util.js';
import { loadTrades, pickIndex } from './owners.js';
import { loadDp, makeValuer } from './history.js';
import { OUT, depthInfo } from './waiverscan.js';
import { teamPlan } from './plan.js';
import { fcSides } from './trade.js';

const ORD = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: '5th' };
const fcv = (L, id) => L.fc.byId.get(String(id))?.value || 0;
const nm = id => M.players[id]?.full_name || id;
const pk = (L, k) => asset(L, k);

// every completed waiver / free-agent add this season, all teams
const movesCache = new Map();
export function moves(L) {
  if (!movesCache.has(L.id)) movesCache.set(L.id, (async () => {
    const weeks = Array.from({ length: Math.max(1, Math.min(18, M.week)) }, (_, i) => i + 1);
    const res = await pool(weeks, 4, w => api.transactions(L.id, w, w < M.week - 1).catch(() => []));
    const out = [];
    for (const arr of res) for (const t of arr || []) {
      if (!['waiver', 'free_agent'].includes(t.type) || t.status !== 'complete') continue;
      for (const [pid, rid] of Object.entries(t.adds || {})) out.push({ pid: String(pid), rid: +rid, bid: t.settings?.waiver_bid ?? null, t: t.status_updated || t.created, type: t.type });
    }
    return out.sort((a, b) => a.t - b.t);
  })());
  return movesCache.get(L.id);
}

// ---------- harvest board ----------
// sell signal for a player you own
export function signal(L, id) {
  const p = M.players[id] || {}, f = L.fc.byId.get(String(id));
  const d = depthInfo(M.players, byTeamPos(), p);
  const v = f?.value || 0, tr = f?.trend || 0;
  if (d?.starterOut && d.order === 2) return { kind: 'spike', why: `${d.starter.last_name} is ${d.starter.injury_status}: he's the starter now. Peak value; sell to a team that needs him.` };
  if (v > 0 && tr >= Math.max(150, v * 0.3)) return { kind: 'spike', why: `FantasyCalc +${Math.round(tr)} in 30 days. Sell into the hype.` };
  if (v > 0 && tr <= -Math.max(100, v * 0.2)) return { kind: 'fade', why: `FantasyCalc ${Math.round(tr)} in 30 days. Sell now or cut.` };
  return null;
}
let _btp = null;
function byTeamPos() { if (!_btp || _btp.src !== M.players) { const m = new Map(); for (const p of Object.values(M.players)) { if (!p?.team || !p.active) continue; const k = p.team + '|' + p.position; (m.get(k) || m.set(k, []).get(k)).push(p); } _btp = m; _btp.src = M.players; } return _btp; }

// teams that would pay for this player, and the pick to ask for (they must come out ahead on FantasyCalc)
export function buyers(L, id) {
  const p = M.players[id] || {}, pos = p.position, v = fcv(L, id);
  if (!v) return [];
  teamPlan(L); // fills L.posNeeds
  const out = [];
  for (const t of L.teams) {
    if (t.isMe) continue;
    const st = startersNow(L, t.players).starters;
    const hurt = t.players.filter(x => M.players[x]?.position === pos && OUT.has(M.players[x]?.injury_status) && fcv(L, x) > v).length;
    const hole = L.posNeeds?.[t.rid]?.holes?.includes(pos);
    const contending = t.mode === 'contend' || (t.playoff ?? 0) >= 0.35;
    if (!(hole || hurt) || !contending) continue;
    // the best pick of theirs that keeps them ahead on FantasyCalc (3% premium)
    const picks = t.picks.filter(k => +k.split(':')[2] >= 2).map(k => pk(L, k)).filter(a => a.fc && a.fc <= v * 0.97).sort((a, b) => b.fc - a.fc);
    const ask = picks[0];
    if (!ask) continue;
    out.push({ t, ask, why: [hurt ? `${pos} starter hurt` : null, hole ? `weak at ${pos}` : null, `${Math.round((t.playoff || 0) * 100)}% playoffs`].filter(Boolean).join(' · '), score: (t.playoff || 0) + (hurt ? 0.5 : 0) + ask.fc / 10000 });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3);
}

// what your waiver adds this season turned into
export async function ledger(L) {
  const [mv, trades, dp] = await Promise.all([moves(L), loadTrades(L).catch(() => []), loadDp()]);
  const valuer = makeValuer(dp, L);
  const me = L.me.rid, have = new Set(L.me.players.map(String));
  const last = new Map();
  for (const m of mv) if (m.rid === me) last.set(m.pid, m);
  const rows = [];
  for (const [pid, m] of last) {
    const then = valuer?.player(pid, m.t) || 0, now = fcv(L, pid);
    const row = { pid, name: nm(pid), pos: M.players[pid]?.position, added: m.t, bid: m.bid, then, now, status: have.has(pid) ? 'rostered' : 'gone' };
    if (!have.has(pid)) {
      // traded away? record what came back
      const tr = trades.filter(x => x._season === L.season && +x.created >= m.t && x.drops?.[pid] === me && x.adds?.[pid] !== me).sort((a, b) => a.created - b.created)[0];
      if (tr) {
        const got = [...Object.entries(tr.adds || {}).filter(([, r]) => +r === me).map(([x]) => nm(x)), ...(tr.draft_picks || []).filter(d => d.owner_id === me).map(d => `${d.season} ${ORD[d.round]}`)];
        row.status = 'sold'; row.got = got;
        row.gotFc = Object.entries(tr.adds || {}).filter(([, r]) => +r === me).reduce((s, [x]) => s + fcv(L, x), 0) + (tr.draft_picks || []).filter(d => d.owner_id === me).reduce((s, d) => s + (L.fc.picks.get(`${d.season} ${ORD[d.round]}`) || 0), 0);
      } else row.status = 'dropped';
    } else {
      row.signal = signal(L, pid);
      if (row.signal?.kind === 'spike' || now >= (L.fc.picks.get(`${+L.season + 1} 4th`) || 400)) row.buyers = buyers(L, pid);
    }
    rows.push(row);
  }
  return rows.sort((a, b) => (b.signal?.kind === 'spike') - (a.signal?.kind === 'spike') || (b.now - a.now));
}

// ---------- consolidation: several small picks into one bigger pick ----------
export async function consolidations(L) {
  const ny = +L.season + 1;
  const small = L.me.picks.filter(k => { const [, y, r] = k.split(':'); return +r >= 2 && +y <= ny + 1; }).map(k => pk(L, k)).filter(a => a.fc > 0);
  if (small.length < 2) return [];
  const pi = await pickIndex(L).catch(() => null);
  const combos = [];
  for (let i = 0; i < small.length; i++) for (let j = i + 1; j < small.length; j++) {
    combos.push([small[i], small[j]]);
    for (let k = j + 1; k < small.length; k++) combos.push([small[i], small[j], small[k]]);
  }
  const out = [];
  for (const t of L.teams) {
    if (t.isMe) continue;
    const margin = t.mode === 'rebuild' ? 0.05 : 0.03;
    for (const key of t.picks) {
      const [, y, r] = key.split(':');
      if (+y > ny + 1) continue;
      const big = pk(L, key);
      if (!big.fc) continue;
      for (const g of combos) {
        if (g.some(a => +a.key.split(':')[2] <= +r)) continue; // must actually move up a round
        // FantasyCalc's own 2-for-1 rule: the side getting the single better asset gets credit for the roster spot,
        // so a pile of small picks is worth less than its sum
        const sides = fcSides(g.map(a => a.fc * (pi?.index || 1)), [big.fc]);
        const give = sides.A;
        if (sides.partnerMargin < margin * sides.B || sides.partnerMargin > 0.25 * sides.B) continue; // they win, but not by a mile
        const tatLoss = g.reduce((s, a) => s + a.tat, 0) - big.tat;
        out.push({ t, give: g, get: big, fcGive: give, fcGet: sides.B, tatLoss, score: -tatLoss + (t.mode === 'rebuild' ? 300 : 0) - (g.length - 2) * 100 });
      }
    }
  }
  const seen = new Set();
  // one line per package (best partner for it), and each target pick once
  const seenGive = new Set();
  return out.sort((a, b) => b.score - a.score).filter(x => { const k = x.get.key, g = x.give.map(a => a.key).sort().join(); if (seen.has(k) || seenGive.has(g)) return false; seen.add(k); seenGive.add(g); return true; }).slice(0, 4);
}

// ---------- stash list: backups to grab before the injury ----------
export function stash(L, rostered) {
  const out = [], weeksLeft = Math.max(1, (L.playoffStart + 2) - M.week);
  const sf = L.fmt.numQbs === 2;
  for (const [id, p] of Object.entries(M.players)) {
    if (rostered.has(id) || !p?.active || !p.team || !(p.position === 'RB' || (sf && p.position === 'QB'))) continue;
    const d = depthInfo(M.players, byTeamPos(), p);
    if (d?.order !== 2 || !d.starter || d.starterOut) continue;
    const s = d.starter, sv = L.fc.byId.get(String(s.player_id));
    const rate = (p.position === 'RB' ? 0.05 : 0.02) * ((s.age || 0) >= 28 ? 1.3 : 1) * (s.injury_status === 'Questionable' ? 2 : 1);
    const risk = 1 - (1 - rate) ** weeksLeft;
    // what he'd be worth as the starter: a share of the starter's value (backups never get all of it)
    const upside = (sv?.redraft || sv?.value || 0) * 0.35;
    const score = risk * upside;
    if (score < 100) continue;
    out.push({ id, name: p.full_name, pos: p.position, team: p.team, starter: s.full_name || s.last_name, sAge: s.age, sInj: s.injury_status, risk, upside, score, v: fcv(L, id) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 15);
}

// ---------- FAAB: what this league actually pays ----------
export async function faabModel(L) {
  const mv = await moves(L);
  const budget = L.lg?.settings?.waiver_budget || 100;
  // what this league pays per point of market value: median of bid / value over past winning bids
  const pairs = [];
  for (const m of mv) if (m.type === 'waiver' && m.bid > 0) { const v = fcv(L, m.pid); if (v >= 100) pairs.push(m.bid / v); }
  const q = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  const rate = q(pairs, 0.6); // a bit above the median, to actually win
  return {
    budget,
    // bid scaled to the player's value at this league's going rate, more for injury openings / news, and never
    // more than a quarter of what you have left (40% for urgent claims): the season is long
    suggest(v, hot = false, left = budget) {
      if (rate == null || pairs.length < 3) return null;
      const raw = Math.round(rate * v * (hot ? 1.5 : 1));
      return { bid: Math.max(1, Math.min(raw, Math.floor(left * (hot ? 0.4 : 0.25)))), n: pairs.length, raw };
    },
  };
}

// ---------- roster audit ----------
export function audit(L, live) {
  const me = live || {};
  const ids = (me.players || L.me.players).map(String);
  const prot = new Set([...startersNow(L, ids).starters, ...(me.reserve || []).map(String), ...(me.taxi || []).map(String)]);
  const fourth = L.fc.picks.get(`${+L.season + 1} 4th`) || 400;
  const dead = ids.filter(id => !prot.has(id)).map(id => ({ id, name: nm(id), pos: M.players[id]?.position, age: M.players[id]?.age, v: fcv(L, id) }))
    .filter(x => x.v < fourth * 0.15 && (x.age || 30) >= 25).sort((a, b) => a.v - b.v);
  const taxiSlots = L.lg?.settings?.taxi_slots || 0, taxiUsed = (me.taxi || []).length;
  // bench players who'd fit the taxi squad (young enough, not starting), freeing a bench spot
  const taxiYears = L.lg?.settings?.taxi_years || 0;
  const taxiFit = taxiSlots > taxiUsed ? ids.filter(id => !prot.has(id) && (M.players[id]?.years_exp ?? 9) < taxiYears).map(id => ({ id, name: nm(id) })) : [];
  return { dead, taxiOpen: Math.max(0, taxiSlots - taxiUsed), taxiFit };
}
