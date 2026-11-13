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
export function buyers(L, id, price, round) {
  const p = M.players[id] || {}, pos = p.position, v = price || fcv(L, id);
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
    // the best pick of theirs at or just under what he's going for (real trades now, else FantasyCalc)
    const picks = t.picks.filter(k => +k.split(':')[2] >= 2).map(k => pk(L, k)).filter(a => a.fc && a.fc <= v * (price ? 1.05 : 0.97)).sort((a, b) => b.fc - a.fc);
    // with a real price in hand, ask for exactly that: the round he goes for, the nearest year (no 2029 3rds standing
    // in for a 2027 4th)
    const byRound = round ? t.picks.filter(k => +k.split(':')[2] === round).map(k => pk(L, k)).filter(a => a.fc).sort((a, b) => +a.key.split(':')[1] - +b.key.split(':')[1]) : [];
    const ask = byRound[0] || picks[0];
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

// ---------- what people actually pay for him right now: FantasyCalc's real trades ----------
// Waiver value moves in days, so the last few days count most: each trade is weighted by how recent it is (half-life
// 2 days, nothing older than 3 weeks), always at his value as of that trade's day (no hindsight). Compares the last
// 3 days with the 2 weeks before for the trend, and counts trades per day for the buzz. "Alone" = only piece on his side.
const HALF_LIFE = 2;
// in season a player's market is days old at most: only the last 10 days count (3 weeks in the offseason)
const windowDays = () => { const m = new Date().getMonth(); return (m >= 8 || m <= 0) ? 10 : 21; };
const DAYMS = 864e5;
function pickLabel(L, v) {
  const ny = +L.season + 1, rounds = ['1st', '2nd', '3rd', '4th'].map(r => [`${ny} ${r}`, L.fc.picks.get(`${ny} ${r}`) || 0]).filter(x => x[1] > 0);
  for (let i = 0; i < rounds.length; i++) {
    const [k, pv] = rounds[i], nx = rounds[i + 1];
    if (v >= pv) return i === 0 && v > pv * 1.15 ? `more than a ${k}` : `a ${k}`;
    if (nx && v >= nx[1]) { const span = pv - nx[1]; return v - nx[1] < span / 3 ? `a ${nx[0]}` : v > pv - span / 3 ? `a ${k}` : `between a ${k} and a ${nx[0].split(' ')[1]}`; }
  }
  return rounds.length ? `less than a ${rounds[rounds.length - 1][0]}` : '';
}
export async function realPrice(L, pid) {
  const rec = L.fc.byId.get(String(pid));
  if (!rec?.fcId) return null;
  const d = await api.fcTrades(rec.fcId, L.fmt.numTeams, L.fmt.numQbs, L.fmt.ppr).catch(() => null);
  const now = Date.now(), cut = now - windowDays() * DAYMS;
  const day = s => { const [m, dd, y] = s.split('/'); return Date.UTC(+y, +m - 1, +dd); };
  const clean = s => String(s || '').replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim();
  const T = (d?.impliedValues || []).map(x => ({ ...x, side1: clean(x.side1), side2: clean(x.side2), t: day(x.date) })).filter(x => x.t >= cut && x.value > 0).sort((a, b) => b.t - a.t);
  if (!T.length) return { n: 0, days: windowDays() };
  const age = x => Math.max(0, (now - x.t) / DAYMS);
  // recency-weighted median
  const ws = T.map(x => [x.value, Math.pow(0.5, age(x) / HALF_LIFE)]).sort((a, b) => a[0] - b[0]);
  const W = ws.reduce((s, x) => s + x[1], 0); let acc = 0, price = ws[ws.length - 1][0];
  for (const [v, w] of ws) { acc += w; if (acc >= W / 2) { price = v; break; } }
  const med = xs => { const v = xs.map(x => x.value).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
  // FantasyCalc returns at most 1000 trades, newest last: for a busy player that may cover only a few days, so the
  // "before" window is cut to what the list actually covers
  const all = d?.impliedValues || [], oldest = all.length ? day(all[0].date) : now, covered = (now - oldest) / DAYMS;
  const last3 = T.filter(x => age(x) <= 3.5), before = T.filter(x => age(x) > 3.5 && age(x) <= 17.5);
  const beforeDays = Math.max(0, Math.min(17.5, covered) - 3.5);
  const m3 = med(last3), m0 = beforeDays >= 3 && before.length >= 5 ? med(before) : null;
  const trend = m3 && m0 && last3.length >= 5 ? m3 / m0 - 1 : null;
  const perDay3 = last3.length / 3.5, perDay0 = beforeDays >= 3 ? before.length / beforeDays : null;
  // what he fetched alone in the last 5 days: the most common packages
  const alone = T.filter(x => !x.side1.includes(',') && age(x) <= 5.5);
  const counts = new Map(); for (const x of alone) counts.set(x.side2, (counts.get(x.side2) || 0) + 1);
  const common = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  // what to do. Only players who fetch something real (about a 4th or more) are worth the trouble of a trade
  const floor = 0.8 * (L.fc.picks.get(`${+L.season + 1} 4th`) || 500);
  let action, why;
  const hot = perDay0 != null && last3.length >= 10 && perDay3 >= 2 * Math.max(0.5, perDay0);
  if (trend != null && trend >= 0.15) { action = 'sell'; why = `price up ${Math.round(trend * 100)}% in 3 days${hot ? `, ${last3.length} trades (hot)` : ''}: sell into it, waiver spikes fade`; }
  else if (trend != null && trend <= -0.15) { action = 'sell'; why = `price down ${Math.round(-trend * 100)}% in 3 days: the market is cooling, sell before it drops further`; }
  else if (hot) { action = 'sell'; why = `${last3.length} trades in 3 days, ${Math.round(perDay3 / Math.max(0.5, perDay0))}x the usual pace: buyers are active now`; }
  else if (!last3.length) { action = 'hold'; why = 'no trades in the last 3 days: quiet market'; }
  if (price < floor) { action = 'hold'; why = `goes for less than a 4th${last3.length ? ` (${last3.length} trades in 3 days)` : ''}: keep as depth or cut when you need the spot`; }
  else { action = 'steady'; why = `steady (${last3.length} trades in 3 days)`; }
  const ny = +L.season + 1, rds = [1, 2, 3, 4].map(r => [r, L.fc.picks.get(`${ny} ${['1st', '2nd', '3rd', '4th'][r - 1]}`) || 0]).filter(x => x[1] > 0);
  const near = rds.length ? rds.reduce((b, x) => Math.abs(Math.log(x[1] / price)) < Math.abs(Math.log(b[1] / price)) ? x : b) : null;
  const nickname = near && price >= floor ? `${['1st', '2nd', '3rd', '4th'][near[0] - 1]} rounder` : null;
  return { round: near && price >= floor ? near[0] : null, n: T.length, n3: last3.length, days: windowDays(), price, label: pickLabel(L, price), trend, hot, action, why, common, recent: T.slice(0, 4), worth: price >= floor, nickname };
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
        // real owners only package one round up: picks two rounds below count for little, three or more for
        // nothing (nobody gives a 1st for a stack of 4ths), and the package needs a pick from the round right below
        const gap = a => +a.key.split(':')[2] - +r;
        if (!g.some(a => gap(a) === 1)) continue;
        const counts = a => gap(a) === 1 ? 1 : gap(a) === 2 ? 0.3 : 0;
        // FantasyCalc's own 2-for-1 rule: the side getting the single better asset gets credit for the roster spot,
        // so a pile of small picks is worth less than its sum
        const sides = fcSides(g.map(a => a.fc * counts(a) * (pi?.index || 1)), [big.fc]);
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
  // what this league pays per point of market value, from past winning claims. Value is taken on the day of the
  // claim (most pickups fizzle, so today's value would make the league look far richer than it is), $0 wins count,
  // low-value claims are skipped, the top and bottom 10% are trimmed, and we use the median.
  const dp = await loadDp().catch(() => null), valuer = dp ? makeValuer(dp, L) : null;
  const pairs = [];
  for (const m of mv) {
    if (m.type !== 'waiver' || m.bid == null) continue;
    const v = (valuer && valuer.player(m.pid, m.t)) || fcv(L, m.pid);
    if (v >= 300) pairs.push(m.bid / v);
  }
  pairs.sort((a, b) => a - b);
  const cut = Math.floor(pairs.length * 0.1), core = pairs.slice(cut, pairs.length - cut);
  const rate = core.length ? core[Math.floor(core.length / 2)] : null;
  return {
    budget,
    // bid scaled to the player's value at this league's going rate, more for injury openings / news, and never
    // more than a quarter of what you have left (40% for urgent claims): the season is long
    suggest(v, hot = false, left = budget) {
      if (rate == null || pairs.length < 3) return null;
      const raw = Math.round(rate * v * (hot ? 1.5 : 1));
      return { bid: Math.max(1, Math.min(raw, Math.floor(left * (hot ? 0.4 : 0.25)))), n: pairs.length, raw, per1st: Math.round(rate * (L.fc.picks.get(`${+L.season + 1} 1st`) || 3000)) };
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
