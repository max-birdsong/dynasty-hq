// Daily: other trade calculators via Dynasty Daddy's open API, saved to data/calcs.json for the site's
// "Market verdicts". Markets: 0 = KeepTradeCut (Dynasty Daddy's default; 0-9,999 scale), 1 = FantasyCalc,
// 2 = DynastyProcess (both confirmed against their own data).
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
  return out;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const c = await fetchCalcs();
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/calcs.json', JSON.stringify({ updated: new Date().toISOString(), ...c }));
  console.log('calcs:', Object.entries(c).map(([k, v]) => `${k} ${Object.keys(v.sf).length} players, ${Object.keys(v.picks.sf).length} picks`).join('; '));
}
