import { M, leagueById, teamAssets, startersNow, playerWeekPts, simParams } from '../model.js';
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

  const tabs = [['power', 'Power rankings'], ['roster', 'My roster'], ['history', 'History'], ['picks', 'Picks'], ['sim', 'How the odds work']];
  root.append(h('div', { class: 'tabs' }, tabs.map(([k, l]) => h('button', { class: k === tab ? 'on' : '', onclick: () => location.hash = `#/league/${id}/${k}` }, l))));
  const body = h('div', { class: 'panel' });
  root.append(body);
  if (tab === 'power') body.append(power(L));
  if (tab === 'roster') body.append(roster(L));
  if (tab === 'history') body.append(history(L));
  if (tab === 'picks') body.append(picks(L));
  if (tab === 'sim') body.append(simTab(L));
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

function simTab(L) {
  const C = M.calib, P = simParams();
  const wrap = h('div');
  const pc = x => (x * 100).toFixed(1) + '%';
  wrap.append(h('h3', {}, 'How the simulator works'),
    h('p', { class: 'small' }, `Each team's weekly projection is its best lineup from Sleeper's projections, scored with this league's settings. The rest of the season and the playoffs are played out ${fmt(state().settings.simRuns)} times. In each simulated season every team gets three kinds of luck:`),
    h('ul', { class: 'small' },
      h('li', {}, h('b', {}, 'Season-long error '), `(±${pc(P.sdSeason)}): the projection is simply wrong about the team for the rest of the year. Drawn once per simulated season, so it doesn't average out. Made of what your leagues show persists (±${pc(P.measuredSeason ?? 0)}) plus ±${pc(P.horizon ?? 0)} because forecasting weeks ahead is harder than the pre-game projections the calibration is measured on.`),
      h('li', {}, h('b', {}, 'Week-to-week luck '), `(±${pc(P.sdWeek)}): drawn fresh every week; this part carries no information about the future.`),
      h('li', {}, h('b', {}, 'Injuries: '), `each projected starter has a ${pc(P.injRate)} chance per future week of getting hurt and is out ~${(1 / P.injRecover).toFixed(1)} weeks on average, costing the points between him and his bench replacement. Stars-and-scrubs rosters get hit harder.`)),
    h('p', { class: 'small' }, P.bias ? `Projections have run ${pc(Math.abs(P.bias))} ${P.bias < 0 ? 'high' : 'low'} on average (perfect-hindsight lineups vs real lineups), so every team is scaled by the same amount. That doesn't change who's favoured.` : ''));
  if (!C?.ok) {
    wrap.append(h('div', { class: 'err-box' }, C?.note || 'Not calibrated yet: Sleeper projections for past weeks were not available. Using default spreads.'));
    return wrap;
  }
  wrap.append(h('h3', { style: { marginTop: '16px' } }, 'Calibration from your leagues'),
    h('div', { class: 'kpis' },
      kpi(fmt(C.n), `team-weeks (${C.weeks} weeks, ${C.teams} team-seasons)`),
      kpi(pc(C.params.sdWeek), 'weekly luck (sd)'),
      kpi(pc(C.params.sdSeason), 'season-long error measured (sd)'),
      kpi(fmt(C.meanAbsErr, 1), 'avg miss, pts per team-week'),
      kpi(C.favRight != null ? pc(C.favRight) : '–', 'projected favourite won'),
      kpi(C.brier != null ? C.brier.toFixed(3) : '–', 'Brier score (coin flip = 0.250)')),
    h('p', { class: 'small muted' }, 'All 11 leagues are pooled, because how wrong projections are is a property of projections, not of any one league. Below: when the model gave the favourite X%, how often did the favourite actually win? Close numbers mean the odds are honest.'),
    h('table', { style: { maxWidth: '520px' } }, h('thead', {}, h('tr', {}, ['Model said', 'Games', 'Model avg', 'Favourite actually won'].map(x => h('th', {}, x)))),
      h('tbody', {}, C.bins.map(b => h('tr', {}, h('td', {}, `${Math.round(b.lo * 100)}–${Math.min(100, Math.round(b.hi * 100))}%`), h('td', { class: 'n' }, b.n), h('td', { class: 'n' }, b.p != null ? pc(b.p) : '–'), h('td', { class: 'n' }, b.rate != null ? pc(b.rate) : '–'))))));
  const rows = L.teams.map(t => { const a = C.teamAdj[L.id + ':' + t.rid] || {}; return { owner: t.owner, isMe: t.isMe, n: a.n, proj: a.proj, actual: a.actual, diff: a.mean != null ? a.mean - C.params.bias : null, shrink: a.shrink, adj: a.adj }; });
  wrap.append(h('h3', { style: { marginTop: '16px' } }, 'Did teams beat their projections?'),
    h('p', { class: 'small muted' }, `"Applied" is how much of each team's over/under-performance the simulator carries forward. It is shrunk toward zero by how much of the error persists in the data (${pc(C.params.sdSeason)} season vs ${pc(C.params.sdWeek)} weekly), so a team that's just been unlucky isn't marked down.` + (state().settings.sim.teamAdj ? '' : ' (Currently switched off in Settings.)')),
    table([
      { key: 'owner', label: 'Team', n: false },
      { key: 'n', label: 'Weeks', n: true },
      { key: 'proj', label: 'Projected/wk', n: true, fmt: v => fmt(v, 1) },
      { key: 'actual', label: 'Actual/wk', n: true, fmt: v => fmt(v, 1) },
      { key: 'diff', label: 'vs projection', n: true, fmt: v => v == null ? '–' : h('span', { class: v > 0 ? 'pos' : 'neg' }, (v > 0 ? '+' : '') + (v * 100).toFixed(1) + '%') },
      { key: 'shrink', label: 'Weight', n: true, fmt: v => v == null ? '–' : Math.round(v * 100) + '%' },
      { key: 'adj', label: 'Applied', n: true, fmt: v => v == null ? '–' : (v > 0 ? '+' : '') + (v * 100).toFixed(1) + '%' },
    ], rows, { sortKey: 'diff', rowClass: r => r.isMe ? 'me' : '' }));
  return wrap;
}
