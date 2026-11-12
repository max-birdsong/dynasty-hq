// Weekly owner scan (GitHub Actions): goes through EVERY dynasty league each of your opponents is in (Sleeper's
// public API lists any user's leagues), and saves data/owners.json:
//  - portfolio: players they roster in several of their leagues ("owns him in 5 of 12 leagues")
//  - buying / selling lately: players they traded for / away or added / dropped in the last 90 days
//  - valuation tendencies: overvalues / undervalues picks, QBs, RBs, WRs, TEs, from trades at time-of-trade values
import fs from 'node:fs';
import { makeValuer } from '../js/valuer.js';
import { fetchCalcs } from './calcs.mjs';

const USER = process.env.SLEEPER_USER || 'boximax';
const SL = 'https://api.sleeper.app/v1';
const RECENT = 90 * 864e5, MAX_LEAGUES = 40;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let calls = 0;
async function get(u, tries = 3) {
  for (let i = 0; i < tries; i++) {
    calls++;
    try { const r = await fetch(u); if (r.ok) return r.json(); if (r.status === 429) { await sleep(5000 * (i + 1)); continue; } return null; }
    catch { await sleep(1000); }
  }
  return null;
}
async function pool(items, n, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); await sleep(60); } })); return out; }

const st = await get(`${SL}/state/nfl`);
const season = st.league_season || st.season, week = Math.max(1, Math.min(18, st.week || 1));
const me = await get(`${SL}/user/${USER}`);
const mine = await get(`${SL}/user/${me.user_id}/leagues/nfl/${season}`) || [];
const players = await get(`${SL}/players/nfl`) || {};
const pos = id => players[id]?.position;
let dp = null; try { dp = JSON.parse(fs.readFileSync('data/history/dp-values.json', 'utf8')); } catch {}
const calcs = await fetchCalcs().catch(() => ({}));
const BERLIN = ms => { const d = new Date(ms); return { h: +d.toLocaleString('en-GB', { timeZone: 'Europe/Berlin', hour: 'numeric', hourCycle: 'h23' }), d: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(d.toLocaleString('en-GB', { timeZone: 'Europe/Berlin', weekday: 'short' })) }; };

// 1. everyone you play against
const owners = new Set();
for (const l of mine) for (const r of await get(`${SL}/league/${l.league_id}/rosters`) || []) for (const o of [r.owner_id, ...(r.co_owners || [])]) if (o && o !== me.user_id) owners.add(o);
console.log(`${owners.size} opponents`);

// 2. all their dynasty leagues
const leagueOwners = new Map(), leagueInfo = new Map(), nLeagues = {};
await pool([...owners], 6, async o => {
  const ls = (await get(`${SL}/user/${o}/leagues/nfl/${season}`) || []).filter(l => l.settings?.type === 2).slice(0, MAX_LEAGUES);
  nLeagues[o] = ls.length;
  for (const l of ls) { leagueInfo.set(l.league_id, l); (leagueOwners.get(l.league_id) || leagueOwners.set(l.league_id, new Set()).get(l.league_id)).add(o); }
});
console.log(`${leagueInfo.size} dynasty leagues`);

// FantasyCalc scale per format, for putting DynastyProcess history on today's values
const fcCache = {};
async function fcFor(l) {
  const sf = (l.roster_positions || []).includes('SUPER_FLEX'), n = l.total_rosters || 12, ppr = l.scoring_settings?.rec ?? 1;
  const k = `${sf ? 2 : 1}-${n}-${ppr}`;
  if (!fcCache[k]) fcCache[k] = (async () => {
    const arr = await get(`https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=${sf ? 2 : 1}&numTeams=${n}&ppr=${ppr}`) || [];
    const byId = new Map(), picks = new Map();
    for (const x of arr) { if (x.player.position === 'PICK') picks.set(x.player.name, x.value); else if (x.player.sleeperId) byId.set(String(x.player.sleeperId), { value: x.value }); }
    const L = { fmt: { numQbs: sf ? 2 : 1 }, fc: { byId, picks } };
    return { L, valuer: dp ? makeValuer(dp, L, { past: true }) : null };
  })();
  return fcCache[k];
}

// Real trades: every completed two-team trade in these leagues this season, with what each side gave and got, the
// values at the time, and where each team stood that week. This is what people actually accept (and so, by omission,
// what they won't): data/real-trades.json, for learning acceptance and for "what has he actually been traded for".
const REAL = [];
function standings(MW, uptoWeek) {
  const rec = {}, pf = {};
  for (let w = 1; w < uptoWeek; w++) {
    const ms = MW[w] || [], by = {};
    for (const m of ms) { pf[m.roster_id] = (pf[m.roster_id] || 0) + (m.points || 0); (by[m.matchup_id] ||= []).push(m); }
    for (const pair of Object.values(by)) if (pair.length === 2 && (pair[0].points || pair[1].points)) {
      const [a, b] = pair, r = x => (rec[x.roster_id] ||= [0, 0]);
      if (a.points > b.points) { r(a)[0]++; r(b)[1]++; } else if (b.points > a.points) { r(b)[0]++; r(a)[1]++; }
    }
  }
  return { rec, pf };
}
function realTrade(lid, l, L, val, MW, t, when, w) {
  const [ra, rb] = t.roster_ids.map(Number), n = l.total_rosters || 12;
  const { rec, pf } = standings(MW, w);
  const order = Object.keys(pf).map(Number).sort((x, y) => { const wx = (rec[x] || [0, 0]), wy = (rec[y] || [0, 0]); return (wx[0] - wx[1]) - (wy[0] - wy[1]) || pf[x] - pf[y]; }); // worst first
  const side = rid => {
    const got = [], gave = [];
    for (const [id, r] of Object.entries(t.adds || {})) if (+r === rid) got.push({ id, pos: pos(id), age: players[id]?.age || null, v: Math.round(val({ id }, when)) });
    for (const [id, r] of Object.entries(t.drops || {})) if (+r === rid && !(t.adds || {})[id]) gave.push({ id, pos: pos(id), age: players[id]?.age || null, v: Math.round(val({ id }, when)) });
    for (const d of t.draft_picks || []) {
      const a = { pick: 1, s: +d.season, r: d.round, own: d.roster_id === (d.owner_id === rid ? d.previous_owner_id : rid) ? 1 : 0, orank: order.indexOf(d.roster_id) + 1, v: Math.round(val({ pick: true, season: d.season, round: d.round }, when)) };
      if (d.owner_id === rid) got.push({ ...a, own: d.roster_id === d.previous_owner_id ? 1 : 0 });
      if (d.previous_owner_id === rid) gave.push({ ...a, own: d.roster_id === rid ? 1 : 0 });
    }
    return { rec: rec[rid] || [0, 0], rank: order.indexOf(rid) + 1, got, gave };
  };
  const A = side(ra), B = side(rb);
  if (!A.got.length || !B.got.length) return;
  const tv = [...A.got, ...B.got].every(a => a.v > 0) ? 1 : 0; // every asset valued as of that week
  REAL.push({ tv, lid, d: new Date(when).toISOString().slice(0, 10), w, n, sf: L.fmt.numQbs === 2 ? 1 : 0, a: A, b: B });
}

// 3. rosters + transactions in each league
const O = {};
const slot = o => O[o] || (O[o] = { own: {}, buy: {}, sell: {}, tend: {}, act: { last: 0, trades: 0, waivers: 0 }, when: { h: Array(24).fill(0), d: Array(7).fill(0) }, lineup: { weeks: 0, holes: 0 }, panic: { sold: 0, panic: 0 }, calc: { ktc: [], fc: [], dp: [] }, hist: {} });
// acquisition history per player: d = drafted, t = traded for, w = waivers / free agent, x = traded away, r = released
const hist = (o, p, k) => { const H = slot(o).hist; const e = H[p] || (H[p] = {}); e[k] = (e[k] || 0) + 1; };
const tslot = (o, c) => { const t = slot(o).tend; return t[c] || (t[c] = []); };
const cls = a => a.pick ? 'picks' : pos(a.id) || '?';
const ORD = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: '5th' };
await pool([...leagueInfo.keys()], 8, async lid => {
  const l = leagueInfo.get(lid), who = leagueOwners.get(lid);
  const ros = await get(`${SL}/league/${lid}/rosters`) || [];
  const ridOwner = new Map(ros.map(r => [r.roster_id, r.owner_id]));
  for (const r of ros) if (who.has(r.owner_id)) for (const p of r.players || []) slot(r.owner_id).own[p] = (slot(r.owner_id).own[p] || 0) + 1;
  const { L, valuer } = await fcFor(l);
  // values as they were when the trade happened (DynastyProcess that week or just before); 0 when unknown: never
  // today's values, which would judge a trade by what happened after it
  const val = (a, t) => {
    if (!valuer) return 0;
    return a.pick ? valuer.pick(+a.season, a.round, t) || 0 : valuer.player(a.id, t) || 0;
  };
  const sf = L.fmt.numQbs === 2;
  // lineup engagement: completed weeks with an empty or zero-point starter
  const MW = {};
  for (let w = 1; w < week; w++) {
    for (const m of (MW[w] = await get(`${SL}/league/${lid}/matchups/${w}`) || [])) {
      const o = ridOwner.get(m.roster_id); if (!who.has(o)) continue;
      const hole = (m.starters || []).some(id => id === '0' || id === 0 || id == null); // truly empty slots only
      slot(o).lineup.weeks++; if (hole) slot(o).lineup.holes++;
    }
  }
  for (let w = 1; w <= week; w++) {
    for (const t of await get(`${SL}/league/${lid}/transactions/${w}`) || []) {
      if (t.status !== 'complete') continue;
      const when = t.status_updated || t.created, recent = Date.now() - when < RECENT;
      for (const [p, rid] of Object.entries(t.adds || {})) { const o = ridOwner.get(+rid); if (who.has(o)) hist(o, p, t.type === 'trade' ? 't' : 'w'); }
      for (const [p, rid] of Object.entries(t.drops || {})) { const o = ridOwner.get(+rid); if (who.has(o)) hist(o, p, t.type === 'trade' ? 'x' : 'r'); }
      for (const rid of t.roster_ids || []) {
        const o = ridOwner.get(+rid); if (!who.has(o)) continue;
        const a = slot(o).act; a.last = Math.max(a.last, when);
        if (t.type === 'trade') {
          a.trades++;
          // when he's on Sleeper: he made the offer (created) or accepted it (status_updated)
          const tm = BERLIN(t.creator === o ? t.created : when); slot(o).when.h[tm.h]++; if (tm.d >= 0) slot(o).when.d[tm.d]++;
        } else if (t.adds && Object.values(t.adds).some(r => +r === +rid)) a.waivers++;
      }
      if (recent && ['trade', 'waiver', 'free_agent'].includes(t.type)) {
        for (const [p, rid] of Object.entries(t.adds || {})) { const o = ridOwner.get(+rid); if (who.has(o)) slot(o).buy[p] = (slot(o).buy[p] || 0) + 1; }
        for (const [p, rid] of Object.entries(t.drops || {})) { const o = ridOwner.get(+rid); if (who.has(o) && t.type === 'trade') slot(o).sell[p] = (slot(o).sell[p] || 0) + 1; }
      }
      if (t.type !== 'trade') continue;
      if ((t.roster_ids || []).length === 2) realTrade(lid, l, L, val, MW, t, when, w);
      // tendencies: only the side that conceded value reveals a preference
      for (const rid of t.roster_ids || []) {
        const o = ridOwner.get(+rid); if (!who.has(o)) continue;
        const got = [...Object.entries(t.adds || {}).filter(([, r]) => +r === +rid).map(([id]) => ({ id })), ...(t.draft_picks || []).filter(d => d.owner_id === +rid).map(d => ({ pick: true, season: d.season, round: d.round }))];
        const gave = [...Object.entries(t.drops || {}).filter(([, r]) => +r === +rid).map(([id]) => ({ id })), ...(t.draft_picks || []).filter(d => d.previous_owner_id === +rid).map(d => ({ pick: true, season: d.season, round: d.round }))];
        const G = got.reduce((s, a) => s + val(a, when), 0), V = gave.reduce((s, a) => s + val(a, when), 0);
        if (Math.max(G, V) < 800 || !G || !V || [...got, ...gave].some(a => !val(a, when))) continue; // only trades fully valued at the time
        const main = (arr, tot) => { const by = {}; for (const a of arr) by[cls(a)] = (by[cls(a)] || 0) + val(a, when); const [c, v] = Object.entries(by).sort((x, y) => y[1] - x[1])[0] || []; return v >= 0.6 * tot ? c : null; };
        const cin = main(got, G), cout = main(gave, V), conceded = G < V * 0.95;
        // panic selling: players he traded away after their value fell 20%+ in the three weeks before
        for (const a of gave) if (!a.pick && valuer) {
          const before = valuer.player(a.id, when - 21 * 864e5), at = valuer.player(a.id, when);
          if (before >= 500) { slot(o).panic.sold++; if (at < before * 0.8) slot(o).panic.panic++; }
        }
        // which calculator his recent trades look fair on: we only have today's calculator values, so only trades from
        // the last 10 days count (older ones would be judged by values that moved since)
        if (Date.now() - when < 10 * 864e5) for (const k of ['ktc', 'fc', 'dp']) {
          const c = calcs[k]; if (!c) continue;
          const v = a => a.pick ? (c.picks[sf ? 'sf' : 'one'][`${a.season} Mid ${ORD[a.round]}`] || 0) : (c[sf ? 'sf' : 'one'][a.id] || 0);
          const g2 = got.reduce((x, a) => x + v(a), 0), v2 = gave.reduce((x, a) => x + v(a), 0);
          if (Math.max(g2, v2) > 0) slot(o).calc[k].push(Math.abs(g2 - v2) / Math.max(g2, v2));
        }
        if (cin && cin !== cout) tslot(o, cin).push(conceded ? V / G - 1 : 0);
        if (cout && cout !== cin) tslot(o, cout).push(conceded ? G / V - 1 : 0);
      }
    }
  }
  // drafts this season and last (last season's league holds last year's rookie draft), and last season's moves
  const seasons = [{ lid, ridOwner }];
  if (l.previous_league_id) { const pros = await get(`${SL}/league/${l.previous_league_id}/rosters`) || []; seasons.push({ lid: l.previous_league_id, ridOwner: new Map(pros.map(r => [r.roster_id, r.owner_id])), prev: true }); }
  for (const se of seasons) {
    for (const d of await get(`${SL}/league/${se.lid}/drafts`) || []) {
      if (d.status !== 'complete') continue;
      for (const pk of await get(`${SL}/draft/${d.draft_id}/picks`) || []) if (pk.player_id && who.has(pk.picked_by)) hist(pk.picked_by, String(pk.player_id), 'd');
    }
    if (!se.prev) continue;
    for (let w = 1; w <= 18; w++) for (const t of await get(`${SL}/league/${se.lid}/transactions/${w}`) || []) {
      if (t.status !== 'complete') continue;
      for (const [p, rid] of Object.entries(t.adds || {})) { const o = se.ridOwner.get(+rid); if (who.has(o)) hist(o, p, t.type === 'trade' ? 't' : 'w'); }
      for (const [p, rid] of Object.entries(t.drops || {})) { const o = se.ridOwner.get(+rid); if (who.has(o)) hist(o, p, t.type === 'trade' ? 'x' : 'r'); }
    }
  }
});

// 4. compact output
const out = {};
for (const [o, d] of Object.entries(O)) {
  const top = (m, min) => Object.entries(m).filter(([, n]) => n >= min).sort((a, b) => b[1] - a[1]).slice(0, 40);
  const tend = {};
  for (const [c, xs] of Object.entries(d.tend)) { const ys = xs.map(x => Math.max(-0.6, Math.min(0.6, x))); tend[c] = { v: +(ys.reduce((a, b) => a + b, 0) / ys.length).toFixed(3), n: ys.length }; }
  const calc = Object.fromEntries(Object.entries(d.calc).filter(([, xs]) => xs.length).map(([k, xs]) => [k, { e: +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3), n: xs.length }]));
  out[o] = { n: nLeagues[o] || 0, own: Object.fromEntries(top(d.own, 2)), buy: Object.fromEntries(top(d.buy, 1)), sell: Object.fromEntries(top(d.sell, 1)), tend,
    act: d.act, when: d.when, lineup: d.lineup, panic: d.panic, calc,
    // history only where it says something: players he rosters in 2+ leagues, or ever traded for / away
    hist: Object.fromEntries(Object.entries(d.hist).filter(([p, e]) => (d.own[p] || 0) >= 2 || e.t || e.x).slice(0, 150)) };
}
fs.mkdirSync('data', { recursive: true });
// one copy of each trade (a league can be scanned via several owners: dedupe on content)
const seen = new Set(), real = REAL.filter(x => { const k = x.lid + x.d + JSON.stringify(x.a.got) + JSON.stringify(x.b.got); if (seen.has(k)) return false; seen.add(k); return true; });
fs.writeFileSync('data/real-trades.json', JSON.stringify({ updated: new Date().toISOString(), season, trades: real }));
console.log(`${real.length} real trades saved`);
fs.writeFileSync('data/owners.json', JSON.stringify({ updated: new Date().toISOString(), season, owners: out }));
console.log(`owners.json: ${Object.keys(out).length} owners, ${calls} API calls`);
