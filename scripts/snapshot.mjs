// Weekly snapshot run by GitHub Actions: rosters, records, picks and FantasyCalc values for every league.
// Writes data/snapshots/YYYY-MM-DD.json and keeps data/snapshots/index.json up to date.
import fs from 'node:fs';
import path from 'node:path';

const USER = process.env.SLEEPER_USER || 'boximax';
const SL = 'https://api.sleeper.app/v1';
const OUT = path.join(process.cwd(), 'data', 'snapshots');
const get = async u => { const r = await fetch(u); if (!r.ok) throw new Error(`${r.status} ${u}`); return r.json(); };
const ORD = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: '5th' };

const st = await get(`${SL}/state/nfl`);
const season = st.league_season || st.season;
const me = await get(`${SL}/user/${USER}`);
const leagues = await get(`${SL}/user/${me.user_id}/leagues/nfl/${season}`);
const fcCache = {};
async function fc(n, q, ppr) {
  const k = `${n}-${q}-${ppr}`;
  if (!fcCache[k]) {
    const arr = await get(`https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=${q}&numTeams=${n}&ppr=${ppr}`);
    const byId = {}, picks = {};
    for (const x of arr) { if (x.player.position === 'PICK') picks[x.player.name] = x.value; else if (x.player.sleeperId) byId[x.player.sleeperId] = x.value; }
    fcCache[k] = { byId, picks };
  }
  return fcCache[k];
}

const snap = { date: new Date().toISOString().slice(0, 10), season, week: st.week, seasonType: st.season_type, user: USER, leagues: {} };
for (const lg of leagues) {
  const id = lg.league_id;
  const [ros, us, tp] = await Promise.all([get(`${SL}/league/${id}/rosters`), get(`${SL}/league/${id}/users`), get(`${SL}/league/${id}/traded_picks`)]);
  const sf = (lg.roster_positions || []).includes('SUPER_FLEX');
  const V = await fc(ros.length, sf ? 2 : 1, lg.scoring_settings?.rec ?? 1);
  const uname = Object.fromEntries(us.map(u => [u.user_id, u.display_name]));
  const yrs = [+lg.season + 1, +lg.season + 2];
  const rounds = lg.settings?.draft_rounds || 4;
  const picksOf = {};
  for (const y of yrs) for (let rd = 1; rd <= rounds; rd++) for (const r of ros) {
    const t = tp.find(x => +x.season === y && x.round === rd && x.roster_id === r.roster_id);
    (picksOf[t ? t.owner_id : r.roster_id] ||= []).push([y, rd, r.roster_id]);
  }
  const teams = {};
  for (const r of ros) {
    const players = (r.players || []).map(String);
    const pv = players.reduce((s, p) => s + (V.byId[p] || 0), 0);
    const kv = (picksOf[r.roster_id] || []).reduce((s, [y, rd]) => s + (V.picks[`${y} ${ORD[rd]}`] || 0), 0);
    const s = r.settings || {};
    teams[r.roster_id] = { owner: uname[r.owner_id] || 'Orphan', ownerId: r.owner_id, w: s.wins || 0, l: s.losses || 0, pf: (s.fpts || 0) + (s.fpts_decimal || 0) / 100,
      players, picks: picksOf[r.roster_id] || [], fc: Math.round(pv + kv), fcPlayers: Math.round(pv) };
  }
  const values = {};
  for (const t of Object.values(teams)) for (const p of t.players) if (V.byId[p]) values[p] = V.byId[p];
  snap.leagues[id] = { name: lg.name, teams, me: ros.find(r => r.owner_id === me.user_id)?.roster_id, values };
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, `${snap.date}.json`), JSON.stringify(snap));
const files = fs.readdirSync(OUT).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(files.map(f => f.replace('.json', ''))));
console.log(`Snapshot ${snap.date}: ${Object.keys(snap.leagues).length} leagues`);
