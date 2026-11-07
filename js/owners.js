// Owner profiles: trade history, pick flow, buying/selling tendencies, positional needs.
import { M, asset, teamAssets } from './model.js';
import * as api from './api.js';
import { sum } from './util.js';

const cache = new Map();
export async function loadTrades(L) {
  if (L.trades) return L.trades;
  if (!cache.has(L.id)) cache.set(L.id, api.leagueTrades(L.lg, M.week).catch(() => []));
  L.trades = await cache.get(L.id);
  return L.trades;
}

const ORD = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: '5th' };

// Who (owner id) was each roster id in that trade's season
function ownerOfRid(L, tr, rid) {
  if (tr._owners) return tr._owners[rid];
  return L.byRid[rid]?.ownerId;
}

function pickAsset(L, p) {
  const key = `k:${p.season}:${p.round}:${p.roster_id}`;
  if (+p.season > +L.season) return asset(L, key);
  const v = L.fc.picks.get(`${p.season} ${ORD[p.round]}`) || 0; // already-used pick: show generic
  return { key, pick: true, name: `${p.season} ${ORD[p.round]} (used)`, fc: v, tat: v, pos: 'PICK' };
}

export function tradeSides(L, tr) {
  const sides = {};
  for (const rid of tr.roster_ids) sides[rid] = { rid, ownerId: ownerOfRid(L, tr, rid), got: [], gave: [] };
  for (const [pl, rid] of Object.entries(tr.adds || {})) sides[rid]?.got.push(asset(L, 'p:' + pl));
  for (const [pl, rid] of Object.entries(tr.drops || {})) sides[rid]?.gave.push(asset(L, 'p:' + pl));
  for (const p of tr.draft_picks || []) {
    const a = pickAsset(L, p);
    sides[p.owner_id]?.got.push(a); sides[p.previous_owner_id]?.gave.push(a);
  }
  for (const s of Object.values(sides)) {
    s.fcNet = sum(s.got.map(a => a.fc)) - sum(s.gave.map(a => a.fc));
    s.tatNet = sum(s.got.map(a => a.tat)) - sum(s.gave.map(a => a.tat));
  }
  return sides;
}

function posNeeds(L) {
  const slots = L.slots;
  const c = s => slots.filter(x => x === s).length;
  const n = {
    QB: c('QB') + c('SUPER_FLEX'), RB: c('RB') + Math.ceil((c('FLEX') + c('WRRB_FLEX')) / 2),
    WR: c('WR') + Math.ceil((c('FLEX') + c('WRRB_FLEX') + c('REC_FLEX')) / 2), TE: c('TE') + Math.ceil(c('REC_FLEX') / 2),
  };
  const strength = {};
  for (const t of L.teams) {
    const A = teamAssets(L, t).filter(a => !a.pick);
    strength[t.rid] = {};
    for (const pos of ['QB', 'RB', 'WR', 'TE']) {
      const xs = A.filter(a => a.pos === pos).sort((a, b) => b.fc - a.fc);
      strength[t.rid][pos] = { start: sum(xs.slice(0, n[pos]).map(a => a.fc)), depth: sum(xs.slice(n[pos], n[pos] + 2).map(a => a.fc)) };
    }
  }
  const ranks = {};
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    [...L.teams].sort((a, b) => strength[b.rid][pos].start - strength[a.rid][pos].start).forEach((t, i) => { (ranks[t.rid] ||= {})[pos] = i + 1; });
  }
  return { ranks, strength };
}

export async function profiles(L) {
  const trades = await loadTrades(L);
  const { ranks } = posNeeds(L);
  const N = L.teams.length;
  const out = [];
  for (const t of L.teams) {
    const mine = [];
    for (const tr of trades) {
      const sides = tradeSides(L, tr);
      const me = Object.values(sides).find(s => s.ownerId === t.ownerId);
      if (!me) continue;
      const others = Object.values(sides).filter(s => s !== me);
      mine.push({ tr, me, others, date: new Date(tr.created), season: tr._season });
    }
    const got = mine.flatMap(x => x.me.got), gave = mine.flatMap(x => x.me.gave);
    const ageAvg = arr => { const p = arr.filter(a => !a.pick && a.age); return p.length ? sum(p.map(a => a.age)) / p.length : null; };
    const picksIn = got.filter(a => a.pick).length, picksOut = gave.filter(a => a.pick).length;
    // current pick capital vs default
    const own = t.picks.length, def = L.pickYears.length * L.draftRounds;
    const byRound = {};
    for (const k of t.picks) { const [, y, rd] = k.split(':'); byRound[rd] = (byRound[rd] || 0) + 1; }
    const posIn = {}, posOut = {};
    got.filter(a => !a.pick).forEach(a => posIn[a.pos] = (posIn[a.pos] || 0) + 1);
    gave.filter(a => !a.pick).forEach(a => posOut[a.pos] = (posOut[a.pos] || 0) + 1);
    const partners = {};
    for (const x of mine) for (const o of x.others) { const nm = L.teams.find(tt => tt.ownerId === o.ownerId)?.owner || 'former owner'; partners[nm] = (partners[nm] || 0) + 1; }
    const tags = [];
    if (own >= def + 2) tags.push('Pick hoarder'); else if (own <= def - 2) tags.push('Spends picks');
    const aIn = ageAvg(got), aOut = ageAvg(gave);
    if (aIn && aOut && aIn < aOut - 1.5) tags.push('Buys youth'); else if (aIn && aOut && aIn > aOut + 1.5) tags.push('Buys vets');
    if (mine.length >= 6) tags.push('Active trader'); else if (mine.length === 0) tags.push('Never trades');
    const fcNet = sum(mine.map(x => x.me.fcNet)), tatNet = sum(mine.map(x => x.me.tatNet));
    if (mine.length >= 2 && tatNet - fcNet > 1500) tags.push('Thinks like Sanderson');
    if (mine.length >= 2 && fcNet < -3000) tags.push('Loses trades on FC');
    const r = ranks[t.rid];
    const needs = Object.entries(r).filter(([, v]) => v > N * 0.66).map(([k]) => k);
    const surplus = Object.entries(r).filter(([, v]) => v <= Math.max(2, Math.round(N * 0.2))).map(([k]) => k);
    out.push({ team: t, trades: mine, got, gave, aIn, aOut, picksIn, picksOut, own, def, byRound, posIn, posOut, partners, tags, fcNet, tatNet, ranks: r, needs, surplus });
  }
  return out;
}

// Same person across all leagues
export async function crossLeague(ownerId) {
  const rows = [];
  for (const L of M.leagues) {
    const t = L.teams.find(x => x.ownerId === ownerId);
    if (t) rows.push({ L, t });
  }
  return rows;
}
