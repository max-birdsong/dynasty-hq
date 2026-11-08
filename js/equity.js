// Win equity curves: each team's title chances this season and the next three.
// This season comes from the simulator. Later seasons are projected: every asset's value is aged forward (players
// lose value at the rate players of that position and age actually have, picks turn into rookies), and title chances follow each team's share of
// league value to the power alpha (the same relationship used to price a title, fitted from your leagues).
import { M, teamAssets, titleAlpha, keepRate as keep, studLine } from './model.js';

export const YEARS = 3;
// a stud keeps the stud aging rate while his projected market value stays above the league's stud line
function aged(a, k, line = Infinity) {
  if (a.pick) return a.tat || a.fc || 0; // a pick becomes a rookie of about the same value
  const v = a.tat || a.fc || 0, age = a.age || 26;
  let f = 1;
  for (let i = 0; i < k; i++) f *= keep(a.pos, age + i, (a.fc || 0) * f >= line);
  return v * f;
}

// projected value of a set of assets, k seasons from now
export const valueIn = (assets, k, line) => assets.reduce((s, a) => s + aged(a, k, line), 0);

// curves for every team; `swap` replaces a team's assets (for trade previews): { rid: assets[] }
export function curves(L, swap = {}, now = {}) {
  const alpha = titleAlpha(), n = L.teams.length, line = studLine(L);
  const assets = Object.fromEntries(L.teams.map(t => [t.rid, swap[t.rid] || teamAssets(L, t)]));
  const out = Object.fromEntries(L.teams.map(t => [t.rid, [now[t.rid] ?? t.title ?? 0]]));
  for (let k = 1; k <= YEARS; k++) {
    const w = L.teams.map(t => Math.pow(Math.max(1, valueIn(assets[t.rid], k, line)), alpha));
    const tot = w.reduce((a, b) => a + b, 0);
    // the further out, the less anyone knows (injuries, breakouts, trades): shrink toward an average team
    const lam = Math.min(0.6, 0.15 * k);
    L.teams.forEach((t, i) => out[t.rid].push((1 - lam) * w[i] / tot + lam / n));
  }
  return out; // rid -> [this season, +1, +2, +3]
}

export const total = c => c.reduce((a, b) => a + b, 0);
export const seasons = L => Array.from({ length: YEARS + 1 }, (_, k) => +L.season + k);
void M;
