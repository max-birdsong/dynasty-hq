// Win equity curves: each team's title chances this season and the next three.
// This season comes from the simulator. Later seasons come from projected points (future.js): every player's scoring
// is aged with production curves measured from real NFL seasons, picks turn into rookies, and each team's best
// lineup is run through the same simulator with more uncertainty for each year ahead.
import { futureTitles } from './future.js';

export const YEARS = 3;

// curves for every team; `swap` replaces a team's assets (for trade previews): { rid: assets[] }
export function curves(L, swap = {}, now = {}) {
  const fut = futureTitles(L, YEARS, swap);
  return Object.fromEntries(L.teams.map(t => [t.rid, [now[t.rid] ?? t.title ?? 0, ...fut[t.rid]]])); // rid -> [this season, +1, +2, +3]
}

export const total = c => c.reduce((a, b) => a + b, 0);
export const seasons = L => Array.from({ length: YEARS + 1 }, (_, k) => +L.season + k);
