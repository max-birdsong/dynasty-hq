import { M, leagueById, teamAssets, startersNow, playerWeekPts } from '../model.js';
import { state } from '../state.js';
import { h, fmt, pct, sgn, lineChart, PALETTE } from '../util.js';
import { table, adviceTag, modeTag, pctBar, posB, empty } from '../components.js';

export default function leagueView(id, tab = 'power') {
  if (!id) {
    const first = M.leagues.find(L => L.me);
    if (first) { location.replace('#/league/' + first.id); return h('div'); }
    return empty('No leagues found.');
  }
  const L = leagueById(id);
  if (!L) return empty('League not found.');
  const root = h('div');
  root.append(h('div', { class: 'row', style: { marginBottom: '10px', gap: '6px' } },
    M.leagues.filter(x => x.me).map(x => h('a', { href: `#/league/${x.id}/${tab}`, class: 'tag' + (x.id === id ? ' push' : '') }, x.nick))));
  const me = L.me;
  root.append(h('div', { class: 'panel' },
    h('div', { class: 'row spread' }, h('div', {}, h('h1', {}, L.nick), h('div', { class: 'muted small' }, `${L.name} · ${L.teams.length} teams · ${L.fmt.numQbs === 2 ? 'Superflex' : '1QB'}` +
      (L.scoring.bonus_rec_te ? ` · TEP ${L.scoring.bonus_rec_te}` : '') + (L.median ? ' · median game' : '') + ` · playoffs wk ${L.playoffStart} (${L.playoffTeams} teams)`)),
      me ? adviceTag(me.advice) : ''),
    me ? h('div', { class: 'kpis', style: { marginTop: '12px' } },
      kpi(`${me.wins}-${me.losses}`, 'record'), kpi(pct(me.playoff), 'playoff odds'), kpi(pct(me.title), 'title odds'),
      kpi(`#${me.fcTotalRank}`, 'FantasyCalc'), kpi(`#${me.tatTotalRank}`, 'Sanderson'), kpi(`${fmt(me.ros, 1)} (#${me.rosRank})`, 'proj pts/wk')) : '',
    me ? h('p', { class: 'muted small', style: { marginBottom: 0 } }, me.advice.text) : ''));

  const tabs = [['power', 'Power rankings'], ['roster', 'My roster'], ['history', 'History'], ['picks', 'Picks']];
  root.append(h('div', { class: 'tabs' }, tabs.map(([k, l]) => h('button', { class: k === tab ? 'on' : '', onclick: () => location.hash = `#/league/${id}/${k}` }, l))));
  const body = h('div', { class: 'panel' });
  root.append(body);
  if (tab === 'power') body.append(power(L));
  if (tab === 'roster') body.append(roster(L));
  if (tab === 'history') body.append(history(L));
  if (tab === 'picks') body.append(picks(L));
  return root;
}

const kpi = (v, l) => h('div', { class: 'kpi' }, h('b', {}, v), h('span', {}, l));

function power(L) {
  const rows = L.teams.map(t => ({ ...t, t }));
  return table([
    { key: 'owner', label: 'Team', n: false, fmt: (v, r) => h('span', {}, v, r.t.isMe ? '' : h('a', { href: `#/owners/${L.id}/${r.t.ownerId}`, class: 'small', style: { marginLeft: '6px' } }, 'profile')) },
    { key: 'winPct', label: 'W-L', n: true, fmt: (v, r) => `${r.wins}-${r.losses}` },
    { key: 'fpts', label: 'PF', n: true, fmt: v => fmt(v) },
    { key: 'ros', label: 'Lineup/wk', n: true, fmt: (v, r) => `${fmt(v, 1)} (${r.rosRank})` },
    { key: 'po', label: 'Playoff wks', n: true, fmt: (v, r) => `${fmt(v, 1)} (${r.poRank})`, title: 'Projected starters, fantasy playoff weeks' },
    { key: 'playoff', label: 'Playoff', n: true, fmt: v => pctBar(v) },
    { key: 'title', label: 'Title', n: true, fmt: v => pctBar(v) },
    { key: 'fcTotal', label: 'FC value', n: true, fmt: (v, r) => `${fmt(v)} (${r.fcTotalRank})` },
    { key: 'tatTotal', label: 'TAT value', n: true, fmt: (v, r) => `${fmt(v)} (${r.tatTotalRank})` },
    { key: 'pickFc', label: 'Picks', n: true, fmt: v => fmt(v) },
    { key: 'coreAge', label: 'Core age', n: true, fmt: v => fmt(v, 1), title: 'Value-weighted age of top 15 players' },
    { key: 'mode', label: 'Mode', n: false, fmt: v => modeTag(v) },
  ], rows, { sortKey: 'tatTotal', rowClass: r => r.isMe ? 'me' : '' });
}

function roster(L) {
  if (!L.me) return empty('You are not in this league.');
  const st = startersNow(L, L.me.players).starters;
  const rows = teamAssets(L, L.me).map(a => {
    const ros = a.pick ? null : avgPts(L, a.id);
    return { ...a, gap: a.tat - a.fc, ros, start: !a.pick && st.has(a.id) };
  });
  return h('div', {},
    h('div', { class: 'muted small', style: { marginBottom: '8px' } }, 'Gap = Sanderson minus FantasyCalc. Negative = market likes him more (sell), positive = Sanderson likes him more (hold/buy).'),
    table([
      { key: 'name', label: 'Player', n: false, fmt: (v, r) => h('span', {}, posB(r.pos), v, r.start ? h('span', { class: 'tag good', style: { marginLeft: '6px' } }, 'starter') : '', r.inj ? h('span', { class: 'neg small' }, ' ' + r.inj) : '') },
      { key: 'age', label: 'Age', n: true, fmt: v => fmt(v, 1) },
      { key: 'ros', label: 'Proj/wk', n: true, fmt: v => fmt(v, 1) },
      { key: 'fc', label: 'FC', n: true, fmt: v => fmt(v) },
      { key: 'tat', label: 'TAT', n: true, fmt: v => fmt(v) },
      { key: 'gap', label: 'Gap', n: true, fmt: v => h('span', { class: v > 0 ? 'pos' : v < 0 ? 'neg' : '' }, sgn(v)) },
      { key: 'tatRank', label: 'TAT #', n: true, sort: r => r.tatRank ? -r.tatRank : null, fmt: (v, r) => v ? h('span', {}, v, r.tatMove ? h('span', { class: /Up/.test(r.tatMove) ? 'pos small' : 'neg small' }, ' ' + r.tatMove) : '') : '–' },
      { key: 'trend', label: 'FC 30d', n: true, fmt: v => h('span', { class: v > 0 ? 'pos' : v < 0 ? 'neg' : '' }, sgn(v)) },
    ], rows, { sortKey: 'fc' }));
}

function avgPts(L, id) {
  const ws = L.regWeeks.length ? L.regWeeks : [M.week];
  return ws.reduce((s, w) => s + playerWeekPts(L, id, w), 0) / ws.length;
}

function history(L) {
  const hist = state().history[L.id] || {};
  const weeks = Object.keys(hist).map(Number).sort((a, b) => a - b);
  if (!weeks.length) return empty('History starts building from your first visit each week (and from the weekly GitHub snapshots).');
  const me = L.me;
  const lines = (k, f = v => v) => L.teams.map((t, i) => ({ name: t.owner, color: t.isMe ? '#1f6feb' : PALETTE[(i + 3) % PALETTE.length] + '88', width: t.isMe ? 3 : 1.5,
    points: weeks.map(w => [w, hist[w]?.teams?.[t.rid]?.[k]]).filter(p => p[1] != null).map(p => [p[0], f(p[1])]) }));
  return h('div', { class: 'grid g2' },
    h('div', {}, h('h3', {}, 'Your playoff and title odds'), lineChart([
      { name: 'Playoff', color: '#1f6feb', points: weeks.map(w => [w, hist[w]?.teams?.[me?.rid]?.playoff]).filter(p => p[1] != null) },
      { name: 'Title', color: '#d1562f', points: weeks.map(w => [w, hist[w]?.teams?.[me?.rid]?.title]).filter(p => p[1] != null) },
    ], { yFmt: v => pct(v), yMin: 0, yMax: 1, xLabels: x => 'W' + x })),
    h('div', {}, h('h3', {}, 'FantasyCalc value, all teams'), lineChart(lines('fc'), { xLabels: x => 'W' + x })),
    h('div', {}, h('h3', {}, 'Sanderson value, all teams'), lineChart(lines('tat'), { xLabels: x => 'W' + x })),
    h('div', {}, h('h3', {}, 'Projected starters, all teams'), lineChart(lines('ros'), { xLabels: x => 'W' + x, yFmt: v => fmt(v, 0) })));
}

function picks(L) {
  const ORD = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: '5th' };
  const yrs = L.pickYears;
  const rows = L.teams.map(t => {
    const r = { owner: t.owner, isMe: t.isMe, total: t.picks.length, slot: L.draftSlot?.[t.rid] };
    for (const y of yrs) for (let rd = 1; rd <= Math.min(L.draftRounds, 3); rd++) r[`${y}-${rd}`] = t.picks.filter(k => k.startsWith(`k:${y}:${rd}:`)).length;
    r.value = t.pickFc;
    return r;
  });
  const cols = [{ key: 'owner', label: 'Team', n: false }, { key: 'slot', label: `Proj ${+L.season + 1} slot`, n: true, sort: r => -r.slot }];
  for (const y of yrs) for (let rd = 1; rd <= Math.min(L.draftRounds, 3); rd++) cols.push({ key: `${y}-${rd}`, label: `${y} ${ORD[rd]}`, n: true, fmt: v => h('span', { class: v > 1 ? 'pos' : v === 0 ? 'neg' : '' }, v) });
  cols.push({ key: 'total', label: 'All', n: true }, { key: 'value', label: 'FC value', n: true, fmt: v => fmt(v) });
  return h('div', {}, h('div', { class: 'muted small', style: { marginBottom: '8px' } }, 'Projected draft slot comes from the simulator (worst expected record picks first).'),
    table(cols, rows, { sortKey: 'value', rowClass: r => r.isMe ? 'me' : '' }));
}
