// One-off probe: what does Sleeper expose publicly about trade blocks?
import fs from 'node:fs';
const SL = 'https://api.sleeper.app/v1';
const get = async u => { try { const r = await fetch(u); const t = await r.text(); return { status: r.status, body: t.slice(0, 20000) }; } catch (e) { return { status: 0, body: String(e) }; } };
const me = JSON.parse((await get(`${SL}/user/boximax`)).body);
const st = JSON.parse((await get(`${SL}/state/nfl`)).body);
const leagues = JSON.parse((await get(`${SL}/user/${me.user_id}/leagues/nfl/${st.league_season}`)).body);
const out = { leagueKeys: {}, rosterMetaKeys: {}, rosterKeys: {}, userMetaKeys: {}, endpoints: {} };
const id = leagues.find(l => l.name.startsWith('The Boys'))?.league_id || leagues[0].league_id;
for (const l of leagues) {
  Object.keys(l).forEach(k => out.leagueKeys[k] = 1);
  Object.keys(l.metadata || {}).forEach(k => out.leagueKeys['metadata.' + k] = 1);
  const ros = JSON.parse((await get(`${SL}/league/${l.league_id}/rosters`)).body);
  for (const r of ros) { Object.keys(r).forEach(k => out.rosterKeys[k] = 1); Object.keys(r.metadata || {}).forEach(k => out.rosterMetaKeys[k.replace(/\d+/g, '#')] = (out.rosterMetaKeys[k.replace(/\d+/g, '#')] || 0) + 1); }
  const us = JSON.parse((await get(`${SL}/league/${l.league_id}/users`)).body);
  for (const u of us) Object.keys(u.metadata || {}).forEach(k => out.userMetaKeys[k.replace(/\d+/g, '#')] = 1);
}
for (const p of ['trade_block', 'tradeblock', 'trading_block', 'trades', 'activity', 'messages', 'transactions/1']) {
  const r = await get(`${SL}/league/${id}/${p}`); out.endpoints[p] = { status: r.status, sample: r.body.slice(0, 300) };
}
const ros = JSON.parse((await get(`${SL}/league/${id}/rosters`)).body);
out.sampleRosterMeta = ros.map(r => r.metadata);
const gq = await fetch('https://sleeper.com/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationName: 'x', query: `query x { league_trade_block(league_id: "${id}") { player_id } }`, variables: {} }) }).then(async r => ({ status: r.status, body: (await r.text()).slice(0, 500) })).catch(e => ({ status: 0, body: String(e) }));
out.graphql = gq;
fs.mkdirSync('data/debug', { recursive: true });
fs.writeFileSync('data/debug/probe.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out).slice(0, 3000));
