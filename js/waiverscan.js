// Waiver farming: find unrostered players worth something (or about to be), per league.
// Pure functions, no DOM: shared by the Waivers page and the daily GitHub job (scripts/waivers.mjs).
//
// The idea (from Max): pick up guys who become worth a little (mostly backup RBs and QBs), flip them for a 3rd or
// 4th, then hope the picks hit or package them up. So we look for:
//  - players the market already values above the worst player on your roster
//  - backups whose starter just got hurt (value jumps before the calculators catch up)
//  - backup RBs and QBs in general (option value: one injury away from starting)
//  - players rising fast in FantasyCalc or being added across Sleeper right now

export const OUT = new Set(['Out', 'IR', 'PUP', 'Sus', 'Doubtful', 'NFI', 'COV']);
const SKIP = new Set(['K', 'DEF', 'DL', 'LB', 'DB', 'IDP']);
const ORD = { 2: '2nd', 3: '3rd', 4: '4th' };

// starter at this player's team and position, if the player is the backup
export function depthInfo(players, byTeamPos, p) {
  if (!p?.team || !['RB', 'QB', 'TE', 'WR'].includes(p.position)) return null;
  const mates = byTeamPos.get(p.team + '|' + p.position) || [];
  const order = p.depth_chart_order;
  if (!order || order < 2) return { order: order || null };
  const starter = mates.find(m => m.depth_chart_order === 1);
  return { order, starter, starterOut: !!(starter && OUT.has(starter.injury_status)) };
}

export function indexTeams(players) {
  const m = new Map();
  for (const p of Object.values(players)) {
    if (!p?.team || !p.position || !p.active) continue;
    const k = p.team + '|' + p.position;
    (m.get(k) || m.set(k, []).get(k)).push(p);
  }
  return m;
}

// price of a value in this league's pick currency
export function pickLabel(pick, ny, v) {
  for (const rd of [2, 3, 4]) { const pv = pick(`${ny} ${ORD[rd]}`); if (pv && v >= pv * 0.85) return `≈ a ${ORD[rd]}`; }
  return '';
}

/**
 * lg: { id, nick, ny, sf, rostered: Set, mine: string[], protect: Set (my starters, IR, taxi), fc: id => {value, trend}, pick: name => value }
 * env: { players, byTeamPos, trending: Map(id => adds) }
 */
export function scanLeague(lg, env) {
  const { players, byTeamPos, trending } = env;
  const val = id => lg.fc(id)?.value || 0;
  // the player you'd cut: lowest value on the roster among non-starters (never IR, taxi or starters)
  const cut = lg.mine.filter(id => !lg.protect.has(id))
    .map(id => ({ id, name: players[id]?.full_name || (players[id] ? `${players[id].first_name} ${players[id].last_name}` : id), pos: players[id]?.position, v: val(id) }))
    .sort((a, b) => a.v - b.v)[0] || null;
  const floor = cut?.v || 0;
  const fourth = lg.pick(`${lg.ny} 4th`) || lg.pick(`${lg.ny} 3rd`) * 0.6 || 300;
  const out = [];
  for (const [id, p] of Object.entries(players)) {
    if (lg.rostered.has(id) || !p?.active || !p.team || SKIP.has(p.position) || !['QB', 'RB', 'WR', 'TE'].includes(p.position)) continue;
    const f = lg.fc(id), v = f?.value || 0, trend = f?.trend || 0;
    const d = depthInfo(players, byTeamPos, p);
    const adds = trending?.get(id) || 0;
    const tags = [];
    if (d?.starterOut && (p.position === 'RB' || p.position === 'QB' || p.position === 'TE') && d.order === 2) tags.push(`${d.starter.last_name || 'starter'} ${d.starter.injury_status}: next man up`);
    else if (d?.order === 2 && p.position === 'RB') tags.push('RB2 on depth chart');
    else if (d?.order === 2 && p.position === 'QB') tags.push(lg.sf ? 'Backup QB (superflex)' : 'Backup QB');
    if (trend >= Math.max(100, v * 0.2)) tags.push(`FC +${Math.round(trend)} in 30 days`);
    if (adds >= 1000) tags.push(`${adds >= 10000 ? Math.round(adds / 1000) + 'k' : adds.toLocaleString()} adds on Sleeper`);
    if (OUT.has(p.injury_status)) tags.push(p.injury_status);
    const hurt = tags.some(t => t.endsWith('next man up'));
    // worth a roster spot if: valued above your worst player, or a real injury opening, or hot
    const gain = v - floor;
    const interesting = (v >= fourth * 0.5 && gain > 50) || hurt || (adds >= 2000 && v > 0) || (d?.order === 2 && (p.position === 'RB' || (p.position === 'QB' && lg.sf)) && v > 0);
    if (!interesting || OUT.has(p.injury_status) && !v) continue;
    const score = gain + (hurt ? 800 : 0) + Math.min(400, adds / 50) + Math.max(0, trend) * 0.5 + (d?.order === 2 ? 100 : 0);
    out.push({ id, name: p.full_name || `${p.first_name} ${p.last_name}`, pos: p.position, team: p.team, age: p.age, v, trend, adds, tags, hurt,
      price: pickLabel(lg.pick, lg.ny, v), gain, score, drop: cut, lid: lg.id, nick: lg.nick });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 25);
}
