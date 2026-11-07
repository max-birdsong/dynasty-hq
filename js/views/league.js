import { M, leagueById, teamAssets, startersNow, playerWeekPts, simParams } from '../model.js';
import { state } from '../state.js';
import { h, fmt, pct, sgn, lineChart, PALETTE } from '../util.js';
import { table, adviceTag, modeTag, pctBar, posB, empty } from '../components.js';
import { planPanel } from './trades.js';

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
      kpi(`${me.wins}-${me.losses}`, 'record'), kpi(pct(me.playoff), 'playoff odds'), kpi(pct(me.bye), 'bye odds'), kpi(pct(me.title), 'title odds'),
      kpi(`#${me.fcTotalRank}`, 'FantasyCalc'), kpi(`#${me.tatTotalRank}`, 'Sanderson'), kpi(`${fmt(me.ros, 1)} (#${me.rosRank})`, 'proj pts/wk')) : '',
    ''));
  if (me) root.append(planPanel(L));

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
    { key: 'expWins', label: 'Proj W', n: true, fmt: v => fmt(v, 1), title: 'Average final wins across simulated seasons' },
    { key: 'playoff', label: 'Playoff', n: true, fmt: v => pctBar(v) },
    { key: 'bye', label: 'Bye', n: true, fmt: v => pct(v) },
    { key: 'title', label: 'Title', n: true, fmt: v => pctBar(v) },
    { key: 'fcTotal', label: 'FC value', n: true, fmt: (v, r) => `${fmt(v)} (${r.fcTotalRank})` },
    { key: 'tatTotal', label: 'TAT value', n: true, fmt: (v, r) => `${fmt(v)} (${r.tatTotalRank})` },
    { key: 'pickFc', label: 'Picks', n: true, fmt: v => fmt(v) },
    { key: 'mixF', label: 'Picks · Now · Future', n: true, sort: r => r.mix.future / r.mix.total, title: "Sanderson's three currencies: share of buying power in picks, this season's production, and future years (EYR)", fmt: (v, r) => { const m = r.mix, p = x => Math.round(100 * x / m.total); return h('span', { class: 'mono small' }, `${p(m.picks)} · ${p(m.now)} · `, h('span', { class: p(m.future) >= 65 ? 'warn' : '' }, p(m.future))); } },
    { key: 'eff', label: 'Efficiency', n: true, sort: r => r.tatTotalRank - r.titleRank, title: 'Roster efficiency: title-odds rank vs buying-power rank. Positive = getting more title equity than your value suggests.', fmt: (v, r) => { const d = r.tatTotalRank - r.titleRank; return h('span', { class: d > 1 ? 'pos' : d < -1 ? 'neg' : '' }, (d > 0 ? '+' : '') + d); } },
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
    const own = L.slotDist?.[t.rid];
    const r = { owner: t.owner, isMe: t.isMe, total: t.picks.length, slot: L.draftSlot?.[t.rid], top3: own ? (own[1] || 0) + (own[2] || 0) + (own[3] || 0) : null,
      holder: L.teams.find(x => x.picks.includes(`k:${+L.season + 1}:1:${t.rid}`))?.owner };
    for (const y of yrs) for (let rd = 1; rd <= Math.min(L.draftRounds, 3); rd++) r[`${y}-${rd}`] = t.picks.filter(k => k.startsWith(`k:${y}:${rd}:`)).length;
    r.value = t.pickFc;
    return r;
  });
  const cols = [{ key: 'owner', label: 'Team', n: false }, { key: 'slot', label: `Their ${+L.season + 1} 1st: proj slot`, n: true, sort: r => -r.slot, fmt: v => v ? '#' + v.toFixed(1) : '–' },
    { key: 'top3', label: 'Top 3', n: true, fmt: v => pct(v) }, { key: 'holder', label: 'Owned by', n: false, fmt: (v, r) => v === r.owner ? 'own' : (v || '–') }];
  for (const y of yrs) for (let rd = 1; rd <= Math.min(L.draftRounds, 3); rd++) cols.push({ key: `${y}-${rd}`, label: `${y} ${ORD[rd]}`, n: true, fmt: v => h('span', { class: v > 1 ? 'pos' : v === 0 ? 'neg' : '' }, v) });
  cols.push({ key: 'total', label: 'All', n: true }, { key: 'value', label: 'FC value', n: true, fmt: v => fmt(v) });
  return h('div', {}, h('div', { class: 'muted small', style: { marginBottom: '8px' } }, `Projected slot comes from the simulated seasons: non-playoff teams pick first by ${L.draftOrder === 'record' ? 'record' : 'reverse max PF'}, then playoff teams by how far they get. Change the draft-order rule per league in Settings.`),
    table(cols, rows, { sortKey: 'value', rowClass: r => r.isMe ? 'me' : '' }));
}

function simTab(L) {
  const C = M.calib, P = simParams();
  const wrap = h('div');
  const pc = x => (x * 100).toFixed(1) + '%';
  wrap.append(h('h3', {}, 'How the simulator works'),
    h('p', { class: 'small' }, `Each team's weekly projection is its best lineup from Sleeper's projections, scored with this league's settings. The rest of the season and the playoffs are played out ${fmt(state().settings.simRuns)} times. In each simulated season every team gets three kinds of luck:`),
    h('ul', { class: 'small' },
      h('li', {}, h('b', {}, 'Season-long error '), `(±${pc(P.sdSeason)}): the projection is simply wrong about the team for the rest of the year. Drawn once per simulated season, so it doesn't average out. Made of what your leagues show persists (best estimate ±${pc(P.measuredSeason ?? 0)}) plus ±${pc(P.horizon ?? 0)} because forecasting weeks ahead is harder than the pre-game projections the calibration is measured on.`),
      (() => { const c = M.seedCheck; if (!c) return ''; const pc1 = x => (x * 100).toFixed(1) + '%';
        return h('li', {}, h('b', {}, 'Checked against real leagues: '), `in 900 real-money leagues with 6-team playoffs, each bye seed won the title ${pc1(c.real.bye)} of the time and each of seeds 3–6 ${pc1(c.real.non)}. Run on your ${c.leagues} leagues with that format, the model gave ${pc1(c.before.bye)} and ${pc1(c.before.non)}. ` +
          (c.k > 1.01 ? `Its playoff games were too predictable, so playoff-week luck is widened ×${c.k.toFixed(2)}, which brings it to ${pc1(c.after.bye)} and ${pc1(c.after.non)}.` : 'That matches, so nothing is adjusted.')); })(),
      h('li', {}, h('b', {}, 'Uncertainty about the model itself: '), 'the settings above are estimates from a limited sample. Each simulated season draws its own plausible values (season-long error anywhere in its measured range, the spread exponent within its error bars), so the odds account for how sure we are, not just for luck.'),
      h('li', {}, h('b', {}, 'Week-to-week luck '), P.noise ? `(about ±${pc(P.sdWeek)}): drawn fresh every week by resampling the real good and bad weeks from your leagues, so it has the same lopsided shape as real fantasy scores. Carries no information about the future.` : `(±${pc(P.sdWeek)}): drawn fresh every week from a bell curve; this part carries no information about the future.`),
      h('li', {}, h('b', {}, 'Injuries: '), `every starter and the bench players behind him can get hurt in any future week (per week: QB ${pc(P.injRates.QB)}, RB ${pc(P.injRates.RB)}, WR ${pc(P.injRates.WR)}, TE ${pc(P.injRates.TE)}) and are out ~${(1 / P.injRecover).toFixed(1)} weeks on average. One starter out costs the gap to his replacement; when several are out (or the replacement is hurt too) the lineup is rebuilt from whoever is healthy. Thin benches and stars-and-scrubs rosters get hit hardest.`)),
    h('p', { class: 'small' }, P.bias ? `Projections have run ${pc(Math.abs(P.bias))} ${P.bias < 0 ? 'high' : 'low'} on average (perfect-hindsight lineups vs real lineups), so every team is scaled by the same amount. That doesn't change who's favoured.` : ''));
  if (!C?.ok) {
    wrap.append(h('div', { class: 'err-box' }, C?.note || 'Not calibrated yet: Sleeper projections for past weeks were not available. Using default spreads.'));
    return wrap;
  }
  wrap.append(h('h3', { style: { marginTop: '16px' } }, 'Calibration from your leagues'),
    h('div', { class: 'kpis' },
      kpi(fmt(C.n), `team-weeks (${fmt(C.sources?.current)} this season, ${fmt(C.sources?.previous)} last season)`),
      kpi(pc(C.params.sdWeek), 'weekly luck (sd)'),
      kpi(`${pc(C.seasonLo)}–${pc(C.seasonHi)}`, 'season-long error, 95% range'),
      kpi(fmt(C.meanAbsErr, 1), 'avg miss, pts per team-week'),
      kpi(C.favRight != null ? pc(C.favRight) : '–', 'projected favourite won'),
      kpi(C.brier != null ? C.brier.toFixed(3) : '–', 'Brier score (coin flip = 0.250)')),
    h('p', { class: 'small muted' }, 'All your leagues, this season and last, are pooled, because how wrong projections are is a property of projections, not of any one league. Below: when the model gave the favourite X%, how often did the favourite actually win? Close numbers mean the odds are honest.'),
    h('table', { style: { maxWidth: '520px' } }, h('thead', {}, h('tr', {}, ['Model said', 'Games', 'Model avg', 'Favourite actually won'].map(x => h('th', {}, x)))),
      h('tbody', {}, C.bins.map(b => h('tr', {}, h('td', {}, `${Math.round(b.lo * 100)}–${Math.min(100, Math.round(b.hi * 100))}%`), h('td', { class: 'n' }, b.n), h('td', { class: 'n' }, b.p != null ? pc(b.p) : '–'), h('td', { class: 'n' }, b.rate != null ? pc(b.rate) : '–'))))));
  const S = C.shape;
  if (S) {
    const g = S.gamma;
    wrap.append(h('h3', { style: { marginTop: '16px' } }, 'Shape of weekly luck'),
      h('p', { class: 'small' }, `How the spread grows with a team's projection: exponent ${g.toFixed(2)} ± ${(S.gammaSE ?? 0).toFixed(2)} (1 = proportional to the projection, 0 = the same number of points for everyone). ` +
        (g > 0.8 ? 'Your leagues look close to proportional.' : g < 0.4 ? 'Strong and weak teams swing by a similar number of points, so favourites are a bit safer than a proportional model says.' : 'Somewhere in between: better teams swing more in points, but less than proportionally.')),
      h('table', { style: { maxWidth: '420px' } }, h('thead', {}, h('tr', {}, ['Projected', 'Typical swing (sd)', 'as %'].map(x => h('th', {}, x)))),
        h('tbody', {}, S.bins.map(b => h('tr', {}, h('td', { class: 'n' }, fmt(b.proj, 0)), h('td', { class: 'n' }, '±' + fmt(b.rms, 1)), h('td', { class: 'n' }, pc(b.rms / b.proj)))))),
      h('p', { class: 'small muted' }, `Shape of the ${fmt(S.n)} real weekly misses (standardised): skew ${S.skew.toFixed(2)} (0 = symmetric, positive = more big blow-up weeks than duds). ` +
        `5th–95th percentile ${S.p05.toFixed(2)} to +${S.p95.toFixed(2)} (a bell curve is −1.64 to +1.64); 1st–99th ${S.p01.toFixed(2)} to +${S.p99.toFixed(2)} (bell curve ±2.33). The simulator resamples these real misses instead of assuming a bell curve.`));
  }
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
