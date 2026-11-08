// Weekly owner scan (GitHub Actions): goes through EVERY dynasty league each of your opponents is in (Sleeper's
// public API lists any user's leagues), and saves data/owners.json:
//  - portfolio: players they roster in several of their leagues ("owns him in 5 of 12 leagues")
//  - buying / selling lately: players they traded for / away or added / dropped in the last 90 days
//  - valuation tendencies: overvalues / undervalues picks, QBs, RBs, WRs, TEs, from trades at time-of-trade values
import fs from 'node:fs';
import { makeValuer } from '../js/valuer.js';

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
    return { L, valuer: dp ? makeValuer(dp, L) : null };
  })();
  return fcCache[k];
}

// 3. rosters + transactions in each league
const O = {};
const slot = o => O[o] || (O[o] = { own: {}, buy: {}, sell: {}, tend: {} });
const tslot = (o, c) => { const t = slot(o).tend; return t[c] || (t[c] = []); };
const cls = a => a.pick ? 'picks' : pos(a.id) || '?';
const ORD = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: '5th' };
await pool([...leagueInfo.keys()], 8, async lid => {
  const l = leagueInfo.get(lid), who = leagueOwners.get(lid);
  const ros = await get(`${SL}/league/${lid}/rosters`) || [];
  const ridOwner = new Map(ros.map(r => [r.roster_id, r.owner_id]));
  for (const r of ros) if (who.has(r.owner_id)) for (const p of r.players || []) slot(r.owner_id).own[p] = (slot(r.owner_id).own[p] || 0) + 1;
  const { L, valuer } = await fcFor(l);
  const val = (a, t) => {
    if (a.pick) return (valuer && valuer.pick(+a.season, a.round, t)) || L.fc.picks.get(`${a.season} ${ORD[a.round]}`) || 0;
    return (valuer && valuer.player(a.id, t)) || L.fc.byId.get(a.id)?.value || 0;
  };
  for (let w = 1; w <= week; w++) {
    for (const t of await get(`${SL}/league/${lid}/transactions/${w}`) || []) {
      if (t.status !== 'complete') continue;
      const when = t.status_updated || t.created, recent = Date.now() - when < RECENT;
      if (recent && ['trade', 'waiver', 'free_agent'].includes(t.type)) {
        for (const [p, rid] of Object.entries(t.adds || {})) { const o = ridOwner.get(+rid); if (who.has(o)) slot(o).buy[p] = (slot(o).buy[p] || 0) + 1; }
        for (const [p, rid] of Object.entries(t.drops || {})) { const o = ridOwner.get(+rid); if (who.has(o) && t.type === 'trade') slot(o).sell[p] = (slot(o).sell[p] || 0) + 1; }
      }
      if (t.type !== 'trade') continue;
      // tendencies: only the side that conceded value reveals a preference
      for (const rid of t.roster_ids || []) {
        const o = ridOwner.get(+rid); if (!who.has(o)) continue;
        const got = [...Object.entries(t.adds || {}).filter(([, r]) => +r === +rid).map(([id]) => ({ id })), ...(t.draft_picks || []).filter(d => d.owner_id === +rid).map(d => ({ pick: true, season: d.season, round: d.round }))];
        const gave = [...Object.entries(t.drops || {}).filter(([, r]) => +r === +rid).map(([id]) => ({ id })), ...(t.draft_picks || []).filter(d => d.previous_owner_id === +rid).map(d => ({ pick: true, season: d.season, round: d.round }))];
        const G = got.reduce((s, a) => s + val(a, when), 0), V = gave.reduce((s, a) => s + val(a, when), 0);
        if (Math.max(G, V) < 800 || !G || !V) continue;
        const main = (arr, tot) => { const by = {}; for (const a of arr) by[cls(a)] = (by[cls(a)] || 0) + val(a, when); const [c, v] = Object.entries(by).sort((x, y) => y[1] - x[1])[0] || []; return v >= 0.6 * tot ? c : null; };
        const cin = main(got, G), cout = main(gave, V), conceded = G < V * 0.95;
        if (cin && cin !== cout) tslot(o, cin).push(conceded ? V / G - 1 : 0);
        if (cout && cout !== cin) tslot(o, cout).push(conceded ? G / V - 1 : 0);
      }
    }
  }
});

// 4. compact output
const out = {};
for (const [o, d] of Object.entries(O)) {
  const top = (m, min) => Object.entries(m).filter(([, n]) => n >= min).sort((a, b) => b[1] - a[1]).slice(0, 40);
  const tend = {};
  for (const [c, xs] of Object.entries(d.tend)) { const ys = xs.map(x => Math.max(-0.6, Math.min(0.6, x))); tend[c] = { v: +(ys.reduce((a, b) => a + b, 0) / ys.length).toFixed(3), n: ys.length }; }
  out[o] = { n: nLeagues[o] || 0, own: Object.fromEntries(top(d.own, 2)), buy: Object.fromEntries(top(d.buy, 1)), sell: Object.fromEntries(top(d.sell, 1)), tend };
}
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/owners.json', JSON.stringify({ updated: new Date().toISOString(), season, owners: out }));
console.log(`owners.json: ${Object.keys(out).length} owners, ${calls} API calls`);
