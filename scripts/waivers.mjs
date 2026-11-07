// Daily waiver watch (GitHub Actions): scans every league for free agents worth a roster spot, saves
// data/waivers.json, and comments new finds on the "Waiver watch" issue so GitHub emails you.
import fs from 'node:fs';
import { scanLeague, indexTeams } from '../js/waiverscan.js';
import { buzz, norm } from './reddit.mjs';

const USER = process.env.SLEEPER_USER || 'boximax';
const SL = 'https://api.sleeper.app/v1';
const SITE = process.env.SITE_URL || 'https://max-birdsong.github.io/dynasty-hq/';
const NICK = {
  '1351209049420468224': 'NF', '1334750787229716480': 'MP', '1327948373461827584': 'Euro', '1326405013299290112': 'Molon',
  '1324589670528450560': 'Mongol', '1324465605297852416': 'Fortress', '1322204500529799168': 'Gang', '1314997123053285376': 'FJ',
  '1314991202088546304': 'R2L', '1312568291490824192': 'UKDL', '1312560768964644864': 'Boys',
};
const get = async u => { const r = await fetch(u); if (!r.ok) throw new Error(`${r.status} ${u}`); return r.json(); };

const st = await get(`${SL}/state/nfl`);
const season = st.league_season || st.season;
const me = await get(`${SL}/user/${USER}`);
const leagues = await get(`${SL}/user/${me.user_id}/leagues/nfl/${season}`);
const players = await get(`${SL}/players/nfl`);
const trending = new Map((await get(`${SL}/players/nfl/trending/add?lookback_hours=48&limit=200`).catch(() => [])).map(x => [String(x.player_id), x.count]));
const names = new Map();
for (const [id, p] of Object.entries(players)) if (p?.active && p.team && ['QB', 'RB', 'WR', 'TE'].includes(p.position) && p.first_name && p.last_name) names.set(norm(`${p.first_name} ${p.last_name}`), id);
const env = { players, byTeamPos: indexTeams(players), trending, buzz: await buzz(names) };

const fcCache = {};
async function fc(n, q, ppr) {
  const k = `${n}-${q}-${ppr}`;
  if (!fcCache[k]) {
    const arr = await get(`https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=${q}&numTeams=${n}&ppr=${ppr}`);
    const byId = new Map(), picks = new Map();
    for (const x of arr) { if (x.player.position === 'PICK') picks.set(x.player.name, x.value); else if (x.player.sleeperId) byId.set(String(x.player.sleeperId), { value: x.value, trend: x.trend30Day }); }
    fcCache[k] = { byId, picks };
  }
  return fcCache[k];
}

const finds = [];
for (const lg of leagues) {
  const ros = await get(`${SL}/league/${lg.league_id}/rosters`);
  const mine = ros.find(r => r.owner_id === me.user_id);
  if (!mine) continue;
  const sf = (lg.roster_positions || []).includes('SUPER_FLEX');
  const V = await fc(ros.length, sf ? 2 : 1, lg.scoring_settings?.rec ?? 1);
  const myIds = (mine.players || []).map(String);
  // no projections here: protect as many of my most valuable players as there are starting slots
  const nStart = (lg.roster_positions || []).filter(p => !['BN', 'IR', 'TAXI'].includes(p)).length;
  const top = [...myIds].sort((a, b) => (V.byId.get(b)?.value || 0) - (V.byId.get(a)?.value || 0)).slice(0, nStart);
  const protect = new Set([...top, ...(mine.reserve || []).map(String), ...(mine.taxi || []).map(String)]);
  const nick = NICK[lg.league_id] || lg.name.split(/\s+/).slice(0, 2).join(' ');
  const res = scanLeague({ id: lg.league_id, nick, ny: +season + 1, sf, rostered: new Set(ros.flatMap(r => (r.players || []).map(String))), mine: myIds, protect,
    fc: id => V.byId.get(id), pick: n => V.picks.get(n) }, env);
  const base = V.picks.get(`${+season + 1} 1st`) || 3000;
  for (const r of res) finds.push({ lid: lg.league_id, nick, id: r.id, name: r.name, pos: r.pos, team: r.team, v: r.v, firsts: +(r.v / base).toFixed(2), price: r.price, tags: r.tags, hurt: r.hurt, score: Math.round(r.score), drop: r.drop?.name || null, buzz: r.buzz || null });
}

fs.mkdirSync('data', { recursive: true });
let prev = { seen: {} };
try { prev = JSON.parse(fs.readFileSync('data/waivers.json', 'utf8')); } catch {}
// "new" = not reported for this league in the last 7 days
const now = Date.now(), seen = Object.fromEntries(Object.entries(prev.seen || {}).filter(([, t]) => now - t < 7 * 864e5));
const worth = finds.filter(f => f.hurt || f.price || f.score >= 600 || f.buzz?.news || f.buzz?.n >= 2);
// new = not posted for this league in 7 days, or it just got hotter (injury opening, news on Reddit)
const keys = f => { const k = `${f.lid}:${f.id}`; return [k, ...(f.hurt ? [k + ':hurt'] : []), ...(f.buzz?.news ? [k + ':news'] : [])]; };
const fresh = worth.filter(f => keys(f).some(k => !seen[k]));
for (const f of worth) for (const k of keys(f)) seen[k] ||= now;
const buzzOut = Object.fromEntries([...env.buzz].map(([id, b]) => [id, b]));
if (fresh.length || new Date().getUTCHours() === 6 || process.env.FORCE_WRITE || process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') fs.writeFileSync('data/waivers.json', JSON.stringify({ updated: new Date().toISOString(), finds, seen, buzz: buzzOut }, null, 0));
console.log(`${finds.length} finds, ${fresh.length} new; buzz on free agents: ${finds.filter(f => f.buzz).map(f => `${f.name} (${f.nick}, ${f.buzz.n}${f.buzz.news ? ', news' : ''})`).join('; ') || 'none'}`);

// comment on the "Waiver watch" issue
const token = process.env.GITHUB_TOKEN, repo = process.env.GITHUB_REPOSITORY;
if (token && repo && fresh.length) {
  const gh = (path, opts = {}) => fetch(`https://api.github.com/repos/${repo}${path}`, { ...opts, headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', ...(opts.headers || {}) } }).then(r => r.json());
  const issues = await gh('/issues?state=open&labels=waiver-watch');
  let num = Array.isArray(issues) && issues[0]?.number;
  if (!num) num = (await gh('/issues', { method: 'POST', body: JSON.stringify({ title: 'Waiver watch', labels: ['waiver-watch'], body: `New free agents worth a roster spot get posted here daily, so GitHub emails you. Full list: ${SITE}#/waivers` }) })).number;
  const by = new Map();
  for (const f of fresh.sort((a, b) => b.score - a.score)) (by.get(f.id) || by.set(f.id, { ...f, ls: [] }).get(f.id)).ls.push(f);
  const lines = [...by.values()].slice(0, 12).map(f => `- ${f.hurt || f.buzz?.news ? '🚨 ' : ''}**${f.name}** (${f.pos} ${f.team})${f.firsts ? ` · ${f.firsts} 1sts` : ''}${f.price ? ` ${f.price}` : ''}${f.tags.length ? ` · ${f.tags.join(', ')}` : ''}\n  Free in: ${f.ls.map(x => `${x.nick}${x.drop ? ` (drop ${x.drop})` : ''}`).join(', ')}${f.buzz?.posts?.length ? `\n  Reddit: ${f.buzz.posts.slice(0, 2).map(p => `[${p.title.slice(0, 70)}](${p.link})`).join(' · ')}` : ''}`);
  await gh(`/issues/${num}/comments`, { method: 'POST', body: JSON.stringify({ body: `**${fresh.length} new waiver find${fresh.length > 1 ? 's' : ''}** (${new Date().toISOString().slice(0, 10)})\n\n${lines.join('\n')}\n\n[Open the Waivers page](${SITE}#/waivers)` }) });
  console.log(`Commented on issue #${num}`);
}
