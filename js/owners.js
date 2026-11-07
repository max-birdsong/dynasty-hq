// Owner profiles: trade history, pick flow, buying/selling tendencies, positional needs.
import { M, asset, teamAssets, tatMapFor, isPick } from './model.js';
import { state } from './state.js';
import { loadDp, makeValuer } from './history.js';
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
  // already-used pick: value it like a generic pick of the same round in the next draft (best available proxy)
  const v = L.fc.picks.get(`${p.season} ${ORD[p.round]}`) || L.fc.picks.get(`${+L.season + 1} ${ORD[p.round]}`) || 0;
  return { key, pick: true, name: `${p.season} ${ORD[p.round]} (used)`, fc: v, tat: v, pos: 'PICK' };
}

// TAT set that was current on a date (only if one had been uploaded by then)
function tatSetOn(ms) {
  const d = new Date(ms).toISOString().slice(0, 10);
  let r = null; for (const s of state().tatSets) if (s.date <= d) r = s;
  return r;
}

export function tradeSides(L, tr, valuer = null) {
  const sides = {};
  for (const rid of tr.roster_ids) sides[rid] = { rid, ownerId: ownerOfRid(L, tr, rid), got: [], gave: [] };
  for (const [pl, rid] of Object.entries(tr.adds || {})) sides[rid]?.got.push(asset(L, 'p:' + pl));
  for (const [pl, rid] of Object.entries(tr.drops || {})) sides[rid]?.gave.push(asset(L, 'p:' + pl));
  for (const p of tr.draft_picks || []) {
    const a = pickAsset(L, p);
    sides[p.owner_id]?.got.push(a); sides[p.previous_owner_id]?.gave.push(a);
  }
  // values at the time of the trade
  const set = tatSetOn(tr.created), tmap = set ? tatMapFor(L, set) : null;
  const then = new Map();
  const valueThen = a => {
    if (then.has(a.key)) return then.get(a.key);
    let fc = null, tat = null;
    if (valuer) {
      if (a.pick) { const [, y, rd] = a.key.split(':'); fc = valuer.pick(+y, +rd, tr.created); }
      else fc = valuer.player(a.id || a.key.slice(2), tr.created);
      if (tmap) tat = a.pick ? fc : (tmap.get(a.id) ?? Math.min(fc * 0.5, 600));
    }
    const o = { fc, tat }; then.set(a.key, o); return o;
  };
  for (const s of Object.values(sides)) {
    s.fcNet = sum(s.got.map(a => a.fc)) - sum(s.gave.map(a => a.fc));
    s.tatNet = sum(s.got.map(a => a.tat)) - sum(s.gave.map(a => a.tat));
    for (const a of [...s.got, ...s.gave]) { const t = valueThen(a); a.fcThen = t.fc; a.tatThen = t.tat; }
    s.fcNetThen = valuer ? sum(s.got.map(a => a.fcThen)) - sum(s.gave.map(a => a.fcThen)) : null;
    s.tatNetThen = tmap ? sum(s.got.map(a => a.tatThen)) - sum(s.gave.map(a => a.tatThen)) : null;
    s.valuedOn = valuer ? valuer.date(tr.created) : null; s.tatSet = set?.label || null;
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
  const valuer = makeValuer(await loadDp(), L);
  const { ranks } = posNeeds(L);
  const N = L.teams.length;
  const out = [];
  for (const t of L.teams) {
    const mine = [];
    for (const tr of trades) {
      const sides = tradeSides(L, tr, valuer);
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
    // trade record: a trade counts as a win/loss if the net is more than 5% of the deal (min 150), else even
    const VAL = { fcNet: 'fc', tatNet: 'tat', fcNetThen: 'fcThen', tatNetThen: 'tatThen' };
    const rec = k => {
      const r = { w: 0, l: 0, e: 0 }; const used = mine.filter(x => x.me[k] != null);
      for (const x of used) {
        const f = VAL[k];
        const size = Math.max(sum(x.me.got.map(a => a[f])), sum(x.me.gave.map(a => a[f])));
        const th = Math.max(150, 0.05 * size), v = x.me[k];
        v > th ? r.w++ : v < -th ? r.l++ : r.e++;
      }
      r.n = used.length; r.pct = r.n ? (r.w + 0.5 * r.e) / r.n : null; r.avg = r.n ? sum(used.map(x => x.me[k])) / r.n : null;
      return r;
    };
    const fcRecNow = rec('fcNet'), tatRec = rec('tatNet'), fcThenRec = rec('fcNetThen'), tatThenRec = rec('tatNetThen');
    // judge on values at the time when we have them; hindsight otherwise
    const fcRec = fcThenRec.n ? fcThenRec : fcRecNow;
    let style = null;
    if (mine.length >= 3) {
      if (fcRec.pct >= 0.6 && tatRec.pct >= 0.6) style = 'Shark';
      else if (fcRec.pct <= 0.4 && tatRec.pct <= 0.4) style = 'Easy mark';
      else if (fcRec.pct >= 0.6 && tatRec.pct < 0.5) style = 'Wins on market, not Sanderson';
      else if (tatRec.pct >= 0.6 && fcRec.pct < 0.5) style = 'Sanderson-aligned';
      else style = 'Fair trader';
      tags.push(style);
    }
    if (mine.length >= 2 && tatNet - fcNet > 1500) tags.push('Thinks like Sanderson');
    if (mine.length >= 2 && fcNet < -3000) tags.push('Loses trades on FC');
    const r = ranks[t.rid];
    const needs = Object.entries(r).filter(([, v]) => v > N * 0.66).map(([k]) => k);
    const surplus = Object.entries(r).filter(([, v]) => v <= Math.max(2, Math.round(N * 0.2))).map(([k]) => k);
    out.push({ team: t, trades: mine, got, gave, aIn, aOut, picksIn, picksOut, own, def, byRound, posIn, posOut, partners, tags, fcNet, tatNet, fcRec, fcRecNow, fcThenRec, tatRec, tatThenRec, style, ranks: r, needs, surplus });
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
