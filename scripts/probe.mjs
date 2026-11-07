// One-off probe: what does Sleeper expose publicly about trade blocks?
import fs from 'node:fs';
const SL = 'https://api.sleeper.app/v1';
const get = async u => { try { const r = await fetch(u); const t = await r.text(); return { status: r.status, body: t }; } catch (e) { return { status: 0, body: String(e) }; } };
const json = async u => { const r = await get(u); try { return JSON.parse(r.body); } catch { return null; } };
const me = (await json(`${SL}/user/boximax`)) || [];
const st = (await json(`${SL}/state/nfl`)) || [];
const leagues = (await json(`${SL}/user/${me.user_id}/leagues/nfl/${st.league_season}`)) || [];
const out = { leagueKeys: {}, rosterMetaKeys: {}, rosterKeys: {}, userMetaKeys: {}, endpoints: {} };
const id = leagues.find(l => l.name.startsWith('The Boys'))?.league_id || leagues[0].league_id;
for (const l of leagues) {
  Object.keys(l).forEach(k => out.leagueKeys[k] = 1);
  Object.keys(l.metadata || {}).forEach(k => out.leagueKeys['metadata.' + k] = 1);
  const ros = (await json(`${SL}/league/${l.league_id}/rosters`)) || [];
  for (const r of ros) { Object.keys(r).forEach(k => out.rosterKeys[k] = 1); Object.keys(r.metadata || {}).forEach(k => out.rosterMetaKeys[k.replace(/\d+/g, '#')] = (out.rosterMetaKeys[k.replace(/\d+/g, '#')] || 0) + 1); }
  const us = (await json(`${SL}/league/${l.league_id}/users`)) || [];
  for (const u of us) Object.keys(u.metadata || {}).forEach(k => out.userMetaKeys[k.replace(/\d+/g, '#')] = 1);
}
for (const p of ['trade_block', 'tradeblock', 'trading_block', 'trades', 'activity', 'messages', 'transactions/1']) {
  const r = await get(`${SL}/league/${id}/${p}`); out.endpoints[p] = { status: r.status, sample: r.body.slice(0, 300) };
}
const ros = (await json(`${SL}/league/${id}/rosters`)) || [];
out.sampleRosterMeta = ros.map(r => r.metadata);
const gq = await fetch('https://sleeper.com/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationName: 'x', query: `query x { league_trade_block(league_id: "${id}") { player_id } }`, variables: {} }) }).then(async r => ({ status: r.status, body: (await r.text()).slice(0, 500) })).catch(e => ({ status: 0, body: String(e) }));
out.graphql = gq;
fs.mkdirSync('data/debug', { recursive: true });
fs.writeFileSync('data/debug/probe.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out).slice(0, 3000));
