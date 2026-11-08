// Values at the time of a trade, from DynastyProcess weekly history (data/history/dp-values.json,
// refreshed by the weekly GitHub Action). DynastyProcess values are put on today's FantasyCalc scale by rank:
// the Nth most valuable asset on that date gets today's FC value of the Nth most valuable asset.
import { M } from './model.js';

let dpP = null;
export function loadDp() {
  if (!dpP) dpP = fetch('data/history/dp-values.json', { cache: 'no-cache' }).then(r => r.ok ? r.json() : null).catch(() => null);
  return dpP;
}

export { makeValuer } from './valuer.js';
