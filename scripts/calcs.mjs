// Daily: other trade calculators via Dynasty Daddy's open API, saved to data/calcs.json for the site's
// "Market verdicts". Markets: 0 = KeepTradeCut (Dynasty Daddy's default; 0-9,999 scale), 1 = FantasyCalc,
// 2 = DynastyProcess (both confirmed against their own data). Plus FantasyPros' monthly chart (fetchFP).
import fs from 'node:fs';
export const MARKETS = { ktc: 0, fc: 1, dp: 2 };
export async function fetchCalcs() {
  const out = {};
  for (const [k, m] of Object.entries(MARKETS)) {
    const r = await fetch(`https://dynasty-daddy.com/api/v1/player/all/today?market=${m}`, { headers: { 'user-agent': 'dynasty-hq (personal)' } });
    if (!r.ok) { console.log(k, r.status); continue; }
    const a = await r.json(), sf = {}, one = {}, psf = {}, pone = {};
    for (const p of a) {
      const isPick = /^\d{4} (Early|Mid|Late) \d(st|nd|rd|th)$/.test(p.full_name || '');
      if (isPick) { if (p.sf_trade_value) psf[p.full_name] = p.sf_trade_value; if (p.trade_value) pone[p.full_name] = p.trade_value; continue; }
      if (!p.sleeper_id) continue;
      if (p.sf_trade_value) sf[p.sleeper_id] = Math.round(p.sf_trade_value);
      if (p.trade_value) one[p.sleeper_id] = Math.round(p.trade_value);
    }
    out[k] = { sf, one, picks: { sf: psf, one: pone } };
  }
  try { const fp = await fetchFP(); if (fp) out.fp = fp; } catch (e) { console.log('fp failed:', e.message); }
  return out;
}

// FantasyPros' monthly Dynasty Trade Value Chart (0-100 scale). Player tables are public Datawrapper charts; the
// rookie pick tables are in the article. QBs have a 1QB and a superflex value, everyone else one value for both.
const UA = { 'user-agent': 'Mozilla/5.0 (dynasty-hq personal)' };
export const normName = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '').replace(/[^a-z]/g, '');
export function parseFPPicks(html, firstYear) {
  const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/g)].map(m => [...m[0].matchAll(/<tr[\s\S]*?<\/tr>/g)]
    .map(r => [...r[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(c => c[1].replace(/<[^>]+>/g, '').replace(/&#8211;|&ndash;/g, '–').trim()))
    .filter(r => r.length === 3 && /\d/.test(r[1])));
  const one = {}, sf = {}, ORD = ['1st', '2nd', '3rd', '4th'];
  const put = (name, a, b) => { one[name] = a; sf[name] = b; };
  const avg = (rows, f) => rows.reduce((s, r) => s + f(r), 0) / Math.max(1, rows.length);
  tables.slice(0, 2).forEach((rows, ti) => {
    const y = firstYear + ti, get = re => rows.filter(r => re.test(r[0]));
    // first round: by slot (1.01-1.12) or by ranges ("1.01 – 1.03"); weight a range by how many slots it covers
    const slots = [];
    for (const r of get(/^1\.\d\d/)) { const m = r[0].match(/1\.(\d\d)(?:\s*[–-]\s*1\.(\d\d))?/); const a = +m[1], b = +(m[2] || m[1]); for (let k = a; k <= b; k++) slots[k] = [+r[1], +r[2]]; }
    const tier = (lo, hi) => { const s = slots.slice(lo, hi + 1).filter(Boolean); return s.length ? [avg(s, x => x[0]), avg(s, x => x[1])] : null; };
    const t1 = { Early: tier(1, 4), Mid: tier(5, 8), Late: tier(9, 12) };
    const all1 = tier(1, 12);
    for (const T of ['Early', 'Mid', 'Late']) if (t1[T]) put(`${y} ${T} 1st`, ...t1[T].map(Math.round));
    if (all1 && ti > 0) put(`${y} Mid 1st`, ...all1.map(Math.round)); // future years: the market price is the average 1st
    for (let rd = 2; rd <= 4; rd++) {
      const v = T => get(new RegExp(`^${T} ${ORD[rd - 1]}`))[0];
      const e = v('Early'), m = v('Mid'), l = v('Late'), any = get(/^(All others|Round 5)/i)[0];
      const pick = (x, f) => x ? [+x[1], +x[2]] : f;
      const E = pick(e, null), Lt = pick(l, null), Md = pick(m, E && Lt ? [(E[0] + Lt[0]) / 2, (E[1] + Lt[1]) / 2] : E || Lt || (any ? [+any[1], +any[2]] : null));
      if (!Md) continue;
      put(`${y} Early ${ORD[rd - 1]}`, ...(E || Md).map(Math.round)); put(`${y} Mid ${ORD[rd - 1]}`, ...Md.map(Math.round)); put(`${y} Late ${ORD[rd - 1]}`, ...(Lt || Md).map(Math.round));
    }
  });
  // a year the chart doesn't list yet: priced like the furthest year it does
  const last = firstYear + Math.min(1, tables.length - 1);
  for (const [k, v] of Object.entries({ ...one })) if (k.startsWith(last + ' ')) { const n = k.replace(String(last), String(last + 1)); one[n] ??= v; sf[n] ??= sf[k]; }
  return { one, sf };
}
export function parseFPPlayers(csvs, sleeper) {
  const byName = new Map();
  for (const [id, p] of Object.entries(sleeper)) {
    if (!['QB', 'RB', 'WR', 'TE'].includes(p.position)) continue;
    const k = normName(p.full_name || `${p.first_name} ${p.last_name}`);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push({ id, p });
  }
  const one = {}, sf = {}; let miss = [];
  for (const csv of csvs) {
    const [head, ...rows] = csv.trim().split('\n').map(l => l.split('\t'));
    const iv = head.indexOf('Trade Value'), isf = head.indexOf('SF Value');
    for (const r of rows) {
      if (/^All Other/i.test(r[0])) continue;
      const c = byName.get(normName(r[0])) || [];
      const hit = c.find(x => x.p.team === r[2]) || c.find(x => x.p.active) || c[0];
      if (!hit) { miss.push(r[0]); continue; }
      one[hit.id] = +r[iv]; sf[hit.id] = isf >= 0 && r[isf] ? +r[isf] : +r[iv];
    }
  }
  if (miss.length) console.log('fp unmatched:', miss.join(', '));
  return { one, sf };
}
export async function fetchFP() {
  const list = await (await fetch('https://www.fantasypros.com/nfl/articles/dynasty.php', { headers: UA })).text();
  const url = (list.match(/https:\/\/www\.fantasypros\.com\/\d{4}\/\d{1,2}\/fantasy-football-rankings-dynasty-trade-value-chart-[a-z0-9-]+\//i) || [])[0];
  if (!url) { console.log('fp: no chart article found'); return null; }
  const html = await (await fetch(url, { headers: UA })).text();
  const [, yy, mm] = url.match(/\/(\d{4})\/(\d{1,2})\//);
  const firstYear = +yy + (+mm >= 5 ? 1 : 0); // after the NFL draft the rookie table is next year's class
  const ids = [...new Set((html.match(/datawrapper\.dwcdn\.net\/([A-Za-z0-9]+)\/\d+/g) || []).map(s => s.split('/')[1]))];
  const csvs = [];
  for (const id of ids) { const r = await fetch(`https://datawrapper.dwcdn.net/${id}/1/dataset.csv`, { headers: UA }); if (r.ok) csvs.push(await r.text()); }
  const sleeper = await (await fetch('https://api.sleeper.app/v1/players/nfl')).json();
  const pl = parseFPPlayers(csvs.filter(c => /Trade Value/.test(c)), sleeper);
  if (Object.keys(pl.one).length < 100) { console.log('fp: too few players', Object.keys(pl.one).length); return null; }
  return { ...pl, picks: parseFPPicks(html, firstYear), source: url };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const c = await fetchCalcs();
  // FantasyPros only changes monthly and its page may fail: keep the last good copy
  if (!c.fp) try { const old = JSON.parse(fs.readFileSync('data/calcs.json', 'utf8')); if (old.fp) c.fp = old.fp; } catch {}
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/calcs.json', JSON.stringify({ updated: new Date().toISOString(), ...c }));
  console.log('calcs:', Object.entries(c).map(([k, v]) => `${k} ${Object.keys(v.sf).length} players, ${Object.keys(v.picks.sf).length} picks`).join('; '));
}
