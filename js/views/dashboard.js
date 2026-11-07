import { M, teamAssets, asset, sandersonSlotValue } from '../model.js';
import { firstsSent } from '../owners.js';
import { state, syncReady } from '../state.js';
import { h, fmt, pct, odds, sgn } from '../util.js';
import { table, adviceTag, pctBar, posB, heat, empty } from '../components.js';

let planning = false;
export default function dashboard() {
  // team plans need a few extra simulations each; work them out in the background and redraw when ready
  if (!planning && M.leagues.some(L => L.me && !L.plan)) {
    planning = true;
    (async () => {
      const { teamPlan } = await import('../plan.js');
      for (const L of M.leagues) { if (L.me && !L.plan) teamPlan(L); await new Promise(r => setTimeout(r, 0)); }
      planning = false;
      if (!location.hash || location.hash === '#/') window.DHQ.route();
    })();
  }
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
  const rows = mine.map(L => ({ L, bye: L.me.bye, nick: L.nick, rec: `${L.me.wins}-${L.me.losses}${L.me.ties ? '-' + L.me.ties : ''}`, fpts: L.me.fptsRank, playoff: L.me.playoff, title: L.me.title, fc: L.me.fcTotalRank, tat: L.me.tatTotalRank, ros: L.me.rosRank, adv: L.plan ? { tag: L.plan.headline, cls: (L.me.title ?? 0) >= 0.15 ? 'push' : L.plan.tanking ? 'tank' : L.plan.middle ? 'sell' : 'mid', text: L.plan.lines.join(' ') } : L.me.advice, n: L.teams.length }));
  root.append(h('div', { class: 'panel' }, h('h2', {}, 'Your leagues'),
    table([
      { key: 'nick', label: 'League', n: false },
      { key: 'rec', label: 'Record', n: false, sort: r => r.L.me.winPct },
      { key: 'fpts', label: 'PF rk', n: true, sort: r => -r.fpts, fmt: (v, r) => `${v}/${r.n}` },
      { key: 'ros', label: 'Lineup rk', n: true, sort: r => -r.ros, fmt: (v, r) => `${v}/${r.n}`, title: 'Rest-of-season projected starters' },
      { key: 'playoff', label: 'Playoff', n: true, fmt: v => pctBar(v) },
      { key: 'bye', label: 'Bye', n: true, fmt: v => pct(v) },
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

  // portfolio exposure: injuries and team-level shocks are "known unknowns" that hit across all your leagues at once
  if (S.tatSets.length) {
    const byP = new Map(), byTeam = new Map(); let tot = 0;
    for (const L of mine) for (const a of teamAssets(L, L.me)) {
      if (a.pick || !a.tat) continue;
      tot += a.tat;
      const o = byP.get(a.id) || { a, v: 0, lg: [] }; o.v += a.tat; o.lg.push(L.nick); byP.set(a.id, o);
      if (a.team) byTeam.set(a.team, (byTeam.get(a.team) || 0) + a.tat);
    }
    const topP = [...byP.values()].sort((x, y) => y.v - x.v).slice(0, 8);
    const topT = [...byTeam.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6);
    const share = v => (100 * v / tot).toFixed(1) + '%';
    root.append(h('div', { class: 'grid g2' },
      h('div', { class: 'panel' }, h('h2', {}, 'Your biggest exposures'),
        h('div', { class: 'muted small', style: { marginBottom: '8px' } }, `Share of your Sanderson value across all ${mine.length} teams. One injury to a player you own everywhere hits every league at once. Spreading out makes you less fragile.`),
        h('div', { class: 'assets' }, topP.map(x => h('div', { class: 'asset' }, h('span', { class: 'nm' }, posB(x.a.pos), x.a.name, h('span', { class: 'muted small' }, ` · ${x.lg.length} leagues`)), h('span', { class: 'num ' + (x.v / tot > 0.06 ? 'warn' : '') }, share(x.v)))))),
      h('div', { class: 'panel' }, h('h2', {}, 'By NFL team'),
        h('div', { class: 'muted small', style: { marginBottom: '8px' } }, 'A QB injury, coaching change or bad offense hits every player you own on that team.'),
        h('div', { class: 'assets' }, topT.map(([tm, v]) => h('div', { class: 'asset' }, h('span', {}, tm), h('span', { class: 'num ' + (v / tot > 0.12 ? 'warn' : '') }, share(v))))))));
  }

  // diamond 1sts: next year's picks the simulator says will land early, priced by the market as an ordinary 1st
  const diamonds = [];
  for (const L of mine) {
    const ny = +L.season + 1;
    for (const holder of L.teams) {
      if (holder.isMe) continue;
      for (const k of holder.picks) {
        const [, y, rd, orig] = k.split(':');
        if (+y !== ny || +rd !== 1) continue;
        const a = asset(L, k), o = L.byRid[orig];
        // only picks whose owner thinks they're mid or late: if the standings already say "top 4", he knows
        if (!a.looksSlot || a.looksSlot <= Math.ceil(L.numTeams / 3) || !a.slot) continue;
        if (a.looksSlot - a.slot < 1.5 && (a.top3 || 0) < 0.15) continue; // a real misread, not averaging noise
        // edge = what it's worth where the simulator puts it, minus what it's worth where it looks like it lands,
        // both on the same curve, so the edge is the owner's misread and not just calculators underpricing early picks
        const gap = a.tat - sandersonSlotValue(L, ny, '1st', a.looksSlot);
        if (gap < 300) continue;
        diamonds.push({ L, holder, o, a, gap, y: ny });
      }
    }
  }
  diamonds.sort((x, y) => y.gap - x.gap);
  if (diamonds.length) root.append(h('div', { class: 'panel' }, h('h2', {}, `💎 Diamond ${+M.season + 1} 1sts`),
    h('div', { class: 'muted small', style: { marginBottom: '8px' } }, `${+M.season + 1} 1sts (decided by this season) that look like mid or late picks from today's standings, but that the simulator expects to land earlier: weak rosters with lucky records, low max PF (draft order is reverse max PF unless set otherwise), or tough schedules ahead. Their owners price them by the standings, usually for vets who help now.`),
    table([
      { key: 'lg', label: 'League', n: false, sort: r => r.L.nick, fmt: (v, r) => r.L.nick },
      { key: 'pick', label: 'Pick', n: false, sort: r => r.o.owner, fmt: (v, r) => `${r.o.owner}'s ${r.y} 1st` + (r.holder.rid !== r.o.rid ? ` (held by ${r.holder.owner})` : '') },
      { key: 'rec', label: 'Their record', n: false, sort: r => r.o.winPct, fmt: (v, r) => h('span', {}, `${r.o.wins}-${r.o.losses}`, r.a.fix > 0.15 ? h('span', { class: 'tag', style: { marginLeft: '6px' }, title: 'Their roster value ranks well above their lineup, so they could trade to fix it before the deadline. Edge already reduced for this.' }, 'could trade to fix') : '') },
      { key: 'looks', label: 'Looks like', n: true, sort: r => -r.a.looksSlot, fmt: (v, r) => '#' + r.a.looksSlot },
      { key: 'slot', label: 'Simulator says', n: true, sort: r => -r.a.slot, fmt: (v, r) => '#' + r.a.slot.toFixed(1) },
      { key: 'top3', label: 'Top 3', n: true, sort: r => r.a.top3, fmt: (v, r) => pct(r.a.top3) },
      { key: 'mkt', label: 'Priced as', n: true, sort: r => r.a.fcLooks, fmt: (v, r) => fmt(r.a.fcLooks) },
      { key: 'val', label: 'Worth (Sanderson)', n: true, sort: r => r.a.tat, fmt: (v, r) => fmt(r.a.tat) },
      { key: 'gap', label: 'Edge', title: 'Worth where the simulator puts it minus worth where it looks like it lands', n: true, sort: r => r.gap, fmt: (v, r) => h('span', { class: r.gap > 0 ? 'pos' : 'neg' }, sgn(r.gap)) },
      { key: 'go', label: '', n: false, sort: () => 0, fmt: (v, r) => h('a', { href: `#/trades/${r.L.id}/${r.holder.rid}/calc` }, 'Build offer →') },
    ], diamonds.slice(0, 12), { sortKey: 'gap' })));

  // your own 1sts that are worth more than they look: don't sell them at the price they appear to be
  const mineRisk = [];
  for (const L of mine) for (const k of L.me.picks) {
    const [, y, rd, orig] = k.split(':');
    if (+rd !== 1 || +orig !== L.me.rid) continue;
    const a = asset(L, k);
    if (a.slot && a.looksSlot && a.slot < a.looksSlot - 1.5) mineRisk.push({ L, a, msg: `looks like #${a.looksSlot} from the standings, simulator says #${Math.round(a.slot)}`, gap: a.tat - a.fcLooks });
    else if (a.slot && a.tat > a.fcLooks * 1.25) mineRisk.push({ L, a, msg: `projects #${a.slot.toFixed(1)}${a.p101 > 0.2 ? ` (${odds(a.p101)} chance of the 1.01)` : ''}: worth ${Math.round(a.tat).toLocaleString()} on Sanderson's slot curve vs the ${Math.round(a.fcLooks).toLocaleString()} the market prices it at`, gap: a.tat - a.fcLooks });
    else if (a.futureSlot && a.futureSlot <= Math.ceil(L.teams.length / 3)) mineRisk.push({ L, a, msg: `your roster ranks ${L.teams.length - a.futureSlot + 1}/${L.teams.length} for next year once age is factored in`, gap: a.tat - a.fc });
  }
  if (mineRisk.length) root.append(h('div', { class: 'panel', style: { borderLeft: '3px solid var(--warn)' } }, h('h2', {}, `⚠️ Your ${+M.season + 1} 1sts worth more than they look`),
    h('div', { class: 'muted small', style: { marginBottom: '8px' } }, "Don't give these away at the price they appear to be worth. The calculator and suggestions warn you too, and they value these at the real projection."),
    h('div', { class: 'assets' }, mineRisk.sort((x, y) => y.gap - x.gap).map(x => h('div', { class: 'asset' }, h('span', { class: 'nm' }, h('b', {}, x.L.nick), ` · ${x.a.short.split(' (')[0]}: ${x.msg}`), h('span', { class: 'pos num' }, sgn(x.gap)))))));

  // future diamonds: the 1st after next, from teams competing now on an old or thin roster, whose owners give up 1sts easily
  const fut = h('div', { class: 'panel' }, h('h2', {}, `🔮 ${+M.season + 2} 1sts to target (a year early)`), h('div', { class: 'muted small' }, 'Looking through trade histories…'));
  root.append(fut);
  futureTargets(mine).then(rows => {
    if (!rows.length) { fut.remove(); return; }
    fut.replaceChildren(h('h2', {}, `🔮 ${+M.season + 2} 1sts to target (a year early)`),
      h('div', { class: 'muted small', style: { marginBottom: '8px' } }, "The best time to buy a 1st is a season early. These teams are competing now but rank low long-term once age is taken into account, so their next-next 1st is likely to land early while the market prices it as an ordinary 1st. Ranked highest: teams whose record is better than their points and projections say (they think they're contenders, push with picks and try to keep it going next year), and owners who've traded 1sts before."),
      table([
        { key: 'lg', label: 'League', n: false, sort: r => r.L.nick, fmt: (v, r) => r.L.nick },
        { key: 'own', label: 'Owner', n: false, sort: r => r.t.owner, fmt: (v, r) => h('a', { href: `#/owners/${r.L.id}/${r.t.ownerId}` }, r.t.owner) },
        { key: 'rec', label: 'Now', n: false, sort: r => r.t.playoff, fmt: (v, r) => `${r.t.wins}-${r.t.losses}, ${Math.round((r.t.playoff || 0) * 100)}% playoffs` },
        { key: 'pick', label: 'Pick', n: false, sort: r => r.key, fmt: (v, r) => r.label },
        { key: 'why', label: 'Why', n: false, sort: r => r.score, fmt: (v, r) => h('span', {}, r.why.map(w => h('span', { class: 'tag', style: { marginRight: '4px' } }, w))) },
        { key: 'slot', label: 'Likely slot', n: true, sort: r => -r.slot, fmt: (v, r) => '#' + r.slot },
        { key: 'edge', label: 'Edge', n: true, sort: r => r.edge, fmt: (v, r) => h('span', { class: 'pos' }, sgn(r.edge)) },
        { key: 'go', label: '', n: false, sort: () => 0, fmt: (v, r) => h('a', { href: `#/trades/${r.L.id}/${r.t.rid}/calc` }, 'Build offer →') },
      ], rows.slice(0, 12), { sortKey: 'score' }));
  }).catch(() => fut.remove());

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

export async function futureTargets(leagues) {
  const rows = [];
  const decay = a => (!a || a <= 26) ? 1 : Math.max(0.35, 1 - 0.12 * (a - 26)); // value a player is likely to hold a year from now
  for (const L of leagues) {
    const sent = await firstsSent(L).catch(() => ({}));
    const n = L.teams.length, y2 = +L.season + 2, y1 = +L.season + 1;
    const strength = new Map(L.teams.map(t => [t.rid, teamAssets(L, t).filter(a => !a.pick).reduce((s, a) => s + a.tat * decay(a.age), 0)]));
    const order = [...L.teams].sort((a, b) => strength.get(a.rid) - strength.get(b.rid)); // weakest next year first
    // overperformers: a record better than the team really is. They think they're contenders, buy with future picks,
    // and keep pushing next year on a roster that's getting older. Their record rank vs their points and projection.
    const rk = (f) => { const o = [...L.teams].sort((a, b) => f(b) - f(a)); return t => o.indexOf(t) + 1; };
    const recR = rk(t => t.winPct + 1e-6 * (t.fpts || 0)), pfR = rk(t => t.fpts || 0), projR = rk(t => t.ros || 0);
    for (const t of L.teams) {
      if (t.isMe) continue;
      const slot = order.indexOf(t) + 1;
      const key = `k:${y2}:1:${t.rid}`;
      const holder = L.teams.find(x => x.picks.includes(key));
      if (!holder || holder.isMe || slot > Math.ceil(n / 2)) continue;
      const competing = (t.playoff ?? 0) >= 0.4 || t.winPct >= 0.5;
      if (!competing) continue; // a rebuilder already knows his pick is valuable
      const pa = asset(L, key), edge = pa.tat - pa.fcGeneric;
      if (edge < 200) continue;
      const nSent = sent[t.ownerId] || 0;
      const real = Math.round((pfR(t) + projR(t)) / 2), luck = real - recR(t);
      const why = [];
      if (luck >= 2) why.push(`record #${recR(t)}, really #${real}`);
      why.push(`long-term rank ${n - slot + 1}/${n}`);
      if ((t.coreAge || 0) >= 27) why.push(`core age ${t.coreAge.toFixed(1)}`);
      if (nSent) why.push(`traded ${nSent} 1st${nSent > 1 ? 's' : ''}`);
      if (holder !== t) why.push(`held by ${holder.owner}`);
      const score = edge * (1 + 0.2 * Math.max(0, Math.min(5, luck))) * (1 + 0.25 * Math.min(4, nSent));
      rows.push({ L, t, key, label: `${y2} 1st`, slot, edge, why, score, luck });
    }
  }
  return rows.sort((a, b) => b.score - a.score);
}
