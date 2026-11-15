// Game day: contenders whose set lineup has a dead slot (empty, bye, out) that one of your bench players can fill
// before his game kicks off. Only contenders care about this week's points, so only they are listed.
import { M, asset, playerWeekPts } from './model.js';
import * as api from './api.js';
import { cachedJson } from './db.js';
import { SLOT_ELIG } from './lineup.js';
import { realPrice } from './farm.js';
import { pool } from './util.js';

const DEAD = new Set(['Out', 'IR', 'PUP', 'Sus', 'Suspended', 'NA', 'DNR', 'COV', 'Doubtful']);
const ORD = ['1st', '2nd', '3rd', '4th', '5th'];
const ESPN_FIX = { WSH: 'WAS', JAC: 'JAX', LA: 'LAR' };
const MIN = 60e3;

// kickoff and state per NFL team this week (ESPN's public scoreboard); null if unreachable
async function games() {
  try {
    const r = await fetch('https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard', { cache: 'no-store' });
    if (!r.ok) return null;
    const j = await r.json(), out = {};
    for (const e of j.events || []) {
      const c = e.competitions?.[0]; if (!c) continue;
      for (const t of c.competitors || []) {
        const ab = t.team?.abbreviation; if (!ab) continue;
        out[ESPN_FIX[ab] || ab] = { kick: Date.parse(c.date || e.date), state: e.status?.type?.state || 'pre' };
      }
    }
    return out;
  } catch { return null; }
}

export async function gameDay(leagues) {
  const w = M.week, G = await games();
  if (G && !Object.values(G).some(g => g.state === 'pre')) return { rows: [], done: true };
  // injuries move on game day (inactives ~90 min before kickoff): use a fresher player list than the daily cache
  const fresh = await cachedJson('https://api.sleeper.app/v1/players/nfl', 2 * 3600e3, { key: 'players-nfl' }).catch(() => null) || M.players;
  const P = id => fresh[id] || M.players[id] || {};
  const game = id => G ? (G[P(id).team] || null) : undefined; // null = bye / no game; undefined = unknown
  const playable = id => { const g = game(id); return g === undefined ? true : !!g && g.state === 'pre'; };
  const pts = (L, id) => DEAD.has(P(id).injury_status) ? 0 : playerWeekPts(L, id, w);
  const out = [];
  await pool(leagues, 3, async L => {
    const [lg, mus] = await Promise.all([api.league(L.id), cachedJson(`https://api.sleeper.app/v1/league/${L.id}/matchups/${w}`, 5 * MIN).catch(() => [])]);
    const slotsRaw = (lg.roster_positions || []).filter(s => SLOT_ELIG[s]);
    const byRid = new Map((mus || []).map(m => [m.roster_id, m]));
    const rostered = new Set(L.teams.flatMap(t => t.players));
    const meM = byRid.get(L.me.rid);
    if (!meM?.starters) return; // without your set lineup we can't tell bench from starters
    const myStarters = new Set((meM?.starters || []).map(String));
    const ny = +L.season + 1, first = L.fc.picks.get(`${ny} 1st`) || 3000;
    // your bench players who can still play this week (not too valuable to be a game-day sale)
    const bench = L.me.players.filter(id => !myStarters.has(id) && !(L.me.reserve || []).map(String).includes(id) && playable(id) && pts(L, id) > 0
      && (asset(L, 'p:' + id).fc || 0) <= 0.6 * first);
    if (!bench.length) return;
    // best free agent per slot type, so we never ask a price for something he can pick up for free
    const fas = Object.keys(M.proj[w] || {}).filter(id => !rostered.has(id) && playable(id));
    const faBest = slot => Math.max(0, ...fas.filter(id => SLOT_ELIG[slot].includes(P(id).position)).map(id => pts(L, id)));
    const faCache = {};
    for (const t of L.teams) {
      if (t.isMe) continue;
      const contending = t.mode === 'contend' || (t.playoff ?? 0) >= 0.35;
      if (!contending) continue;
      const m = byRid.get(t.rid); if (!m?.starters) continue;
      const st = m.starters.map(String), stSet = new Set(st);
      st.forEach((sid, i) => {
        const slot = slotsRaw[i]; if (!slot) return;
        const empty = !sid || sid === '0';
        const g = empty ? undefined : game(sid);
        if (!empty && g && g.state !== 'pre') return; // already played or playing
        const dead = empty || g === null || DEAD.has(P(sid).injury_status) || pts(L, sid) <= 0;
        if (!dead) return;
        const why = empty ? `empty ${slot}` : g === null ? `${P(sid).last_name} on bye` : `${P(sid).last_name} ${P(sid).injury_status || 'not playing'}`;
        const elig = SLOT_ELIG[slot];
        const theirs = Math.max(0, ...t.players.filter(id => !stSet.has(id) && elig.includes(P(id).position) && playable(id)).map(id => pts(L, id)));
        const fa = faCache[slot] ??= faBest(slot);
        const alt = Math.max(theirs, fa);
        for (const id of bench) {
          if (!elig.includes(P(id).position)) continue;
          const mine = pts(L, id), gain = mine - alt;
          if (gain < 3) continue;
          out.push({ L, t, slot, why, pid: id, mine, alt, gain, fa, theirs, kick: game(id)?.kick || null });
        }
      });
    }
  });
  // one row per (league, team, player); keep his biggest hole
  const seen = new Map();
  for (const o of out.sort((a, b) => b.gain - a.gain)) { const k = `${o.L.id}|${o.t.rid}|${o.pid}`; if (!seen.has(k)) seen.set(k, o); }
  const rows = [...seen.values()];
  // price: what he really goes for (round), else FantasyCalc; at least a 4th, since he needs it today
  await pool(rows, 6, async o => {
    const p = await realPrice(o.L, o.pid).catch(() => null);
    const v = p?.price || asset(o.L, 'p:' + o.pid).fc || 0, ny = +o.L.season + 1;
    const rds = [1, 2, 3, 4].map(r => [r, o.L.fc.picks.get(`${ny} ${ORD[r - 1]}`) || 0]).filter(x => x[1] > 0);
    let round = p?.round || (rds.length && v ? rds.reduce((b, x) => Math.abs(Math.log(x[1] / v)) < Math.abs(Math.log(b[1] / v)) ? x : b)[0] : 4);
    const maxR = Math.max(...o.t.picks.map(k => +k.split(':')[2]).filter(Boolean), 0);
    if (round > 4) round = 4;
    let ask = o.t.picks.filter(k => +k.split(':')[2] === round).sort((a, b) => +a.split(':')[1] - +b.split(':')[1])[0];
    // he doesn't own that round: next round down, nearest year
    for (let r = round + 1; !ask && r <= maxR; r++) ask = o.t.picks.filter(k => +k.split(':')[2] === r).sort((a, b) => +a.split(':')[1] - +b.split(':')[1])[0];
    o.price = p; o.round = round; o.ask = ask ? asset(o.L, ask) : null;
  });
  return { rows: rows.filter(o => o.ask).sort((a, b) => (b.gain * (b.t.playoff ?? 0.5)) - (a.gain * (a.t.playoff ?? 0.5))), scoreboard: !!G };
}
