import { M, teamAssets } from '../model.js';
import { state, syncReady } from '../state.js';
import { h, fmt, pct, sgn } from '../util.js';
import { table, adviceTag, pctBar, posB, heat, empty } from '../components.js';

export default function dashboard() {
  const root = h('div');
  const S = state();
  const mine = M.leagues.filter(L => L.me);
  const avg = k => mine.length ? mine.reduce((s, L) => s + (L.me[k] || 0), 0) / mine.length : 0;
  const pending = S.trades.filter(t => t.status === 'sent');

  root.append(h('div', { class: 'row spread', style: { marginBottom: '14px' } },
    h('div', {}, h('h1', {}, `Week ${M.week}`), h('div', { class: 'muted small' },
      `${mine.length} leagues · as ${M.me.display_name} · updated ${M.loadedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · `,
      M.projSource === 'sleeper' ? 'Sleeper projections' : 'season averages (projections unavailable)',
      S.tatSets.length ? ` · TAT: ${S.tatSets.at(-1).label}` : ' · no TAT uploaded yet')),
  ));
  if (!syncReady()) root.append(h('div', { class: 'panel' }, h('b', {}, 'Not syncing yet. '), 'Your trade log and uploads are only on this device. ', h('a', { href: '#/settings' }, 'Connect GitHub'), ' so your laptop and phone share everything.'));
  if (M.errors.length) root.append(h('div', { class: 'err-box' }, M.errors.join(' · ')));
  if (!S.tatSets.length) root.append(h('div', { class: 'panel' }, 'Upload the latest Sanderson rankings on the ', h('a', { href: '#/values' }, 'Values page'), ' to turn on TAT values, power rankings and trade suggestions.'));

  root.append(h('div', { class: 'kpis', style: { marginBottom: '16px' } },
    kpi(mine.filter(L => (L.me.playoff || 0) >= 0.5).length + ' / ' + mine.length, 'likely playoff teams'),
    kpi(pct(avg('title')), 'avg title odds'),
    kpi(fmt(mine.reduce((s, L) => s + (L.me.title || 0), 0), 1), 'expected titles'),
    kpi(pending.length, 'trades waiting on a reply'),
  ));

  // league overview
  const rows = mine.map(L => ({ L, nick: L.nick, rec: `${L.me.wins}-${L.me.losses}${L.me.ties ? '-' + L.me.ties : ''}`, fpts: L.me.fptsRank, playoff: L.me.playoff, title: L.me.title, fc: L.me.fcTotalRank, tat: L.me.tatTotalRank, ros: L.me.rosRank, adv: L.me.advice, n: L.teams.length }));
  root.append(h('div', { class: 'panel' }, h('h2', {}, 'Your leagues'),
    table([
      { key: 'nick', label: 'League', n: false },
      { key: 'rec', label: 'Record', n: false, sort: r => r.L.me.winPct },
      { key: 'fpts', label: 'PF rk', n: true, sort: r => -r.fpts, fmt: (v, r) => `${v}/${r.n}` },
      { key: 'ros', label: 'Lineup rk', n: true, sort: r => -r.ros, fmt: (v, r) => `${v}/${r.n}`, title: 'Rest-of-season projected starters' },
      { key: 'playoff', label: 'Playoff', n: true, fmt: v => pctBar(v) },
      { key: 'title', label: 'Title', n: true, fmt: v => pctBar(v) },
      { key: 'fc', label: 'FC rk', n: true, sort: r => -r.fc, fmt: (v, r) => `${v}/${r.n}` },
      { key: 'tat', label: 'TAT rk', n: true, sort: r => -r.tat, fmt: (v, r) => `${v}/${r.n}` },
      { key: 'adv', label: 'Plan', n: false, sort: r => r.title, fmt: v => adviceTag(v) },
    ], rows, { sortKey: 'title', onRow: r => location.hash = '#/league/' + r.L.id })));

  // odds history, like the weekly tracking sheet
  const weeks = [...new Set(mine.flatMap(L => Object.keys(S.history[L.id] || {}).map(Number)))].sort((a, b) => a - b).slice(-10);
  if (weeks.length) {
    root.append(h('div', { class: 'panel' }, h('h2', {}, 'Playoff / title odds by week'),
      h('div', { class: 'tablewrap' }, h('table', { class: 'odds' },
        h('thead', {}, h('tr', {}, h('th', {}, 'League'), weeks.map(w => h('th', { colspan: 2 }, 'Wk ' + w))),
          h('tr', {}, h('th', {}, ''), weeks.map(() => [h('th', {}, 'P'), h('th', {}, 'T')]))),
        h('tbody', {}, mine.map(L => {
          const hist = S.history[L.id] || {};
          return h('tr', {}, h('td', { style: { textAlign: 'left' } }, L.nick), weeks.map(w => {
            const e = hist[w]; const t = e?.teams?.[e.me];
            return [heat(t?.playoff), heat(t?.title)];
          }));
        }))))));
  }

  // biggest Sanderson gaps on my rosters
  const seen = new Map();
  for (const L of mine) for (const a of teamAssets(L, L.me)) {
    if (a.pick || !a.fc) continue;
    const g = a.tat - a.fc;
    const o = seen.get(a.id) || { a, gap: g, leagues: [] };
    o.leagues.push(L.nick); seen.set(a.id, o);
  }
  const list = [...seen.values()];
  if (S.tatSets.length) {
    const sells = list.filter(x => x.gap < 0).sort((a, b) => a.gap - b.gap).slice(0, 10);
    const holds = list.filter(x => x.gap > 0).sort((a, b) => b.gap - a.gap).slice(0, 10);
    const col = (title, sub, arr) => h('div', { class: 'panel' }, h('h2', {}, title), h('div', { class: 'muted small', style: { marginBottom: '8px' } }, sub),
      arr.length ? h('div', { class: 'assets' }, arr.map(x => h('div', { class: 'asset' },
        h('span', { class: 'nm' }, posB(x.a.pos), x.a.name, h('span', { class: 'muted small' }, ' · ' + x.leagues.join(', '))),
        h('span', { class: 'num ' + (x.gap > 0 ? 'pos' : 'neg') }, sgn(x.gap))))) : empty('Nothing yet.'));
    root.append(h('div', { class: 'grid g2' },
      col('Sell candidates', 'Market (FC) values these players above Sanderson', sells),
      col('Hold / buy more', 'Sanderson values these above market', holds)));
  }

  if (pending.length) {
    root.append(h('div', { class: 'panel' }, h('h2', {}, 'Waiting on a reply'),
      h('div', { class: 'assets' }, pending.slice(0, 8).map(t => h('div', { class: 'asset' },
        h('span', { class: 'nm' }, h('b', {}, M.leagues.find(L => L.id === t.leagueId)?.nick || '?'), ` → ${t.partnerName}: ${t.giveNames.join(' + ')} for ${t.getNames.join(' + ')}`),
        h('span', { class: 'muted small' }, new Date(t.created).toLocaleDateString())))),
      h('div', { style: { marginTop: '8px' } }, h('a', { href: '#/trades' }, 'Open trade log →'))));
  }
  return root;
}
const kpi = (v, l) => h('div', { class: 'kpi' }, h('b', {}, v), h('span', {}, l));
