// Sleeper + FantasyCalc API clients (both public, no login needed).
import { cachedJson, cget, cset } from './db.js';
import { pool } from './util.js';

const SL = 'https://api.sleeper.app/v1';
const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3;

export const nflState = () => cachedJson(`${SL}/state/nfl`, 30 * MIN);
export const userByName = name => cachedJson(`${SL}/user/${name}`, 30 * DAY);
export const userLeagues = (uid, season) => cachedJson(`${SL}/user/${uid}/leagues/nfl/${season}`, 6 * HOUR);
export const league = id => cachedJson(`${SL}/league/${id}`, 6 * HOUR);
export const rosters = id => cachedJson(`${SL}/league/${id}/rosters`, 20 * MIN);
export const users = id => cachedJson(`${SL}/league/${id}/users`, DAY);
export const tradedPicks = id => cachedJson(`${SL}/league/${id}/traded_picks`, HOUR);
export const matchups = (id, wk, past) => cachedJson(`${SL}/league/${id}/matchups/${wk}`, past ? 30 * DAY : 30 * MIN);
export const transactions = (id, wk, past) => cachedJson(`${SL}/league/${id}/transactions/${wk}`, past ? 365 * DAY : 30 * MIN);
export const players = () => cachedJson(`${SL}/players/nfl`, DAY, { key: 'players-nfl' });

// FantasyCalc dynasty values for a league format
export function fcValues(numTeams = 12, numQbs = 2, ppr = 1) {
  const url = `https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=${numQbs}&numTeams=${numTeams}&ppr=${ppr}`;
  return cachedJson(url, 6 * HOUR);
}

// Weekly projections from Sleeper (undocumented endpoint). Returns null if blocked.
export async function weekProjections(season, week, positions) {
  const key = `proj-${season}-${week}-${positions.join('')}`;
  const hit = await cget(key, 6 * HOUR);
  if (hit) return hit;
  const qs = positions.map(p => `position[]=${p}`).join('&');
  for (const base of ['https://api.sleeper.app/projections/nfl', 'https://api.sleeper.com/projections/nfl']) {
    try {
      const r = await fetch(`${base}/${season}/${week}?season_type=regular&${qs}`);
      if (!r.ok) continue;
      const arr = await r.json();
      const slim = {};
      for (const x of arr) if (x.player_id && x.stats) slim[x.player_id] = x.stats;
      await cset(key, slim);
      return slim;
    } catch {}
  }
  return (await cget(key)) || null;
}

// All trades in a league (this season + previous season via previous_league_id)
export async function leagueTrades(lg, currentWeek) {
  const out = [];
  const seasons = [{ id: lg.league_id, past: false, season: lg.season }];
  if (lg.previous_league_id && lg.previous_league_id !== '0') seasons.push({ id: lg.previous_league_id, past: true, season: String(+lg.season - 1) });
  for (const s of seasons) {
    const weeks = Array.from({ length: s.past ? 18 : Math.max(1, Math.min(18, currentWeek)) }, (_, i) => i + 1);
    const res = await pool(weeks, 4, w => transactions(s.id, w, s.past || w < currentWeek - 1).catch(() => []));
    let prevRosters = null;
    if (s.past) prevRosters = await rosters(s.id).catch(() => []);
    for (const arr of res) for (const t of arr || []) {
      if (t.type !== 'trade' || t.status !== 'complete') continue;
      // map roster ids of previous season to owner ids so profiles follow the person
      if (prevRosters) t._owners = Object.fromEntries(prevRosters.map(r => [r.roster_id, r.owner_id]));
      t._season = s.season; out.push(t);
    }
  }
  return out.sort((a, b) => b.created - a.created);
}
