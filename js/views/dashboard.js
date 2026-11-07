import { M, teamAssets, asset, sandersonSlotValue } from '../model.js';
import { firstsSent } from '../owners.js';
import { state, syncReady } from '../state.js';
import { h, fmt, pct, odds, sgn, f1 } from '../util.js';
import { VERDICT } from './trades.js';
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

  root.append(h('div', { class: 'row spread', style: { marginBottom: '12px' } },
    h('div', {}, h('h1', {}, `Week ${M.week}`), h('div', { class: 'muted small' },
      `updated ${M.loadedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
      S.tatSets.length ? ` · TAT: ${S.tatSets.at(-1).label}` : '',
      M.projSource === 'sleeper' ? '' : ' · season averages (projections unavailable)',
      ` · ${fmt(mine.reduce((s, L) => s + (L.me.title || 0), 0), 1)} expected titles`)),
    pending.length ? h('a', { href: '#/trades', class: 'tag push' }, `${pending.length} offer${pending.length > 1 ? 's' : ''} out`) : ''));
  const setup = [];
  if (!syncReady()) setup.push(h('span', {}, h('a', { href: '#/settings' }, 'Connect GitHub'), ' to sync laptop and phone'));
  if (!S.tatSets.length) setup.push(h('span', {}, h('a', { href: '#/values' }, 'Upload TAT rankings'), ' to turn on Sanderson values'));
  if (setup.length) root.append(h('div', { class: 'setup small' }, 'Setup: ', setup.flatMap((x, i) => i ? [' · ', x] : [x])));
  if (M.errors.length) root.append(h('div', { class: 'err-box' }, M.errors.join(' · ')));

  // one card per league: where you stand, the stance, and the one thing to know
  const hist = L => { const e = S.history[L.id] || {}; const ws = Object.keys(e).map(Number).sort((a, b) => a - b); const prev = ws.filter(w => w < M.week).at(-1); return prev != null ? e[prev]?.teams?.[e[prev].me] : null; };
  const arrow = (now, before) => before == null || Math.abs(now - before) < 0.02 ? '' : h('span', { class: now > before ? 'pos' : 'neg', title: `was ${Math.round(before * 100)}% last week` }, now > before ? ' ▲' : ' ▼');
  const stat = (v, before, l) => h('div', { class: 'stat' }, h('b', {}, odds(v), arrow(v || 0, before)), h('span', {}, l));
  const keyLine = L => { const p = L.plan; if (!p) return 'Working out the plan…'; const l = p.lines.find(x => /^Deadline/.test(x)) || p.lines.find(x => /^(If you filled|Even with|Filling |Biggest hole|You don't own)/.test(x)); return l ? l.replace(/^Deadline: [A-Z]+[.,]\s*/, '').replace(/^./, c => c.toUpperCase()) : ''; };
  root.append(h('div', { class: 'lcards' }, [...mine].sort((a, b) => (b.me.title || 0) - (a.me.title || 0)).map(L => {
    const p = L.plan, b = hist(L);
    return h('a', { class: 'lcard', href: '#/league/' + L.id },
      h('div', { class: 'row spread' }, h('b', { class: 'lname' }, L.nick), h('span', { class: 'muted small' }, `${L.me.wins}-${L.me.losses}${L.me.ties ? '-' + L.me.ties : ''}`)),
      h('div', { class: 'row', style: { gap: '6px', margin: '4px 0 8px' } }, p?.verdict ? h('span', { class: 'tag ' + (VERDICT[p.verdict] || '') }, p.verdict) : '', h('span', { class: 'small' }, p?.headline || '')),
      h('div', { class: 'stats' }, stat(L.me.playoff, b?.playoff, 'playoffs'), stat(L.me.bye, null, 'bye'), stat(L.me.title, b?.title, 'title')),
      h('div', { class: 'small muted clamp' }, keyLine(L)));
  })));

  // everything else lives in one tabbed panel
  const tabs = [];
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
    const col = (title, sub, arr) => h('div', {}, h('h3', {}, title), h('div', { class: 'muted small', style: { marginBottom: '8px' } }, sub),
      arr.length ? h('div', { class: 'assets' }, arr.map(x => h('div', { class: 'asset' },
        h('span', { class: 'nm' }, posB(x.a.pos), x.a.name, h('span', { class: 'muted small' }, ' · ' + x.leagues.join(', '))),
        h('span', { class: 'num ' + (x.gap > 0 ? 'pos' : 'neg') }, sgn(x.gap))))) : empty('Nothing yet.'));
    tabs.push(['Sell / hold', () => h('div', { class: 'grid g2' },
      col('Sell candidates', 'The market (FC) values these above Sanderson', sells),
      col('Hold or buy more', 'Sanderson values these above the market', holds))]);
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
    tabs.push(['Exposure', () => h('div', { class: 'grid g2' },
      h('div', {}, h('h3', {}, 'Players'),
        h('div', { class: 'muted small', style: { marginBottom: '8px' } }, `Share of your Sanderson value across all ${mine.length} teams. One injury to a player you own everywhere hits every league at once. Spreading out makes you less fragile.`),
        h('div', { class: 'assets' }, topP.map(x => h('div', { class: 'asset' }, h('span', { class: 'nm' }, posB(x.a.pos), x.a.name, h('span', { class: 'muted small' }, ` · ${x.lg.length} leagues`)), h('span', { class: 'num ' + (x.v / tot > 0.06 ? 'warn' : '') }, share(x.v)))))),
      h('div', {}, h('h3', {}, 'NFL teams'),
        h('div', { class: 'muted small', style: { marginBottom: '8px' } }, 'A QB injury, coaching change or bad offense hits every player you own on that team.'),
        h('div', { class: 'assets' }, topT.map(([tm, v]) => h('div', { class: 'asset' }, h('span', {}, tm), h('span', { class: 'num ' + (v / tot > 0.12 ? 'warn' : '') }, share(v)))))))]);
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
  if (diamonds.length) tabs.unshift([`💎 ${+M.season + 1} diamonds`, () => h('div', {},
    explain(`${+M.season + 1} 1sts that look mid or late from the standings, but that the simulator expects to land earlier.`, 'Weak rosters with lucky records, low max PF (draft order is reverse max PF unless set otherwise), or tough schedules ahead. Their owners price them by the standings, usually for vets who help now. Edge = worth where the simulator puts the pick minus worth where it looks like it lands.'),
    table([
      { key: 'lg', label: 'League', n: false, sort: r => r.L.nick, fmt: (v, r) => r.L.nick },
      { key: 'pick', label: 'Pick', n: false, sort: r => r.o.owner, fmt: (v, r) => `${r.o.owner}'s ${r.y} 1st` + (r.holder.rid !== r.o.rid ? ` (held by ${r.holder.owner})` : '') },
      { key: 'rec', label: 'Their record', n: false, sort: r => r.o.winPct, fmt: (v, r) => h('span', {}, `${r.o.wins}-${r.o.losses}`, r.a.fix > 0.15 ? h('span', { class: 'tag', style: { marginLeft: '6px' }, title: 'Their roster value ranks well above their lineup, so they could trade to fix it before the deadline. Edge already reduced for this.' }, 'could trade to fix') : '') },
      { key: 'looks', label: 'Looks like', n: true, sort: r => -r.a.looksSlot, fmt: (v, r) => '#' + r.a.looksSlot },
      { key: 'slot', label: 'Simulator says', n: true, sort: r => -r.a.slot, fmt: (v, r) => '#' + r.a.slot.toFixed(1) },
      { key: 'top3', label: 'Top 3', n: true, sort: r => r.a.top3, fmt: (v, r) => pct(r.a.top3) },
      { key: 'mkt', label: 'Priced as', n: true, sort: r => r.a.fcLooks, fmt: (v, r) => fmt(r.a.fcLooks) },
      { key: 'val', label: 'Worth (Sanderson)', n: true, sort: r => r.a.tat, fmt: (v, r) => fmt(r.a.tat) },
      { key: 'gap', label: 'Edge', title: 'Worth where the simulator puts it minus worth where it looks like it lands', n: true, sort: r => r.gap, fmt: (v, r) => h('span', { class: r.gap > 0 ? 'pos' : 'neg', title: sgn(r.gap) }, f1(r.L, r.gap)) },
      { key: 'go', label: '', n: false, sort: () => 0, fmt: (v, r) => h('a', { href: `#/trades/${r.L.id}/${r.holder.rid}/calc` }, 'Offer →') },
    ], diamonds.slice(0, 12), { sortKey: 'gap' }))]);

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
  if (mineRisk.length) tabs.splice(1, 0, [`⚠️ Your 1sts (${mineRisk.length})`, () => h('div', {},
    explain("Your own 1sts that are worth more than they look. Don't give them away at the price they appear to be.", 'The calculator and suggestions warn you too, and value these at the real projection.'),
    h('div', { class: 'assets' }, mineRisk.sort((x, y) => y.gap - x.gap).map(x => h('div', { class: 'asset' }, h('span', { class: 'nm' }, h('b', {}, x.L.nick), ` · ${x.a.short.split(' (')[0]}: ${x.msg}`), h('span', { class: 'pos num', title: sgn(x.gap) }, f1(x.L, x.gap))))))]);

  // the 1st after next, from teams competing now on an aging roster (loaded lazily: needs trade histories)
  tabs.push([`🔮 ${+M.season + 2} targets`, () => {
    const box = h('div', {}, h('div', { class: 'muted small' }, 'Looking through trade histories…'));
    futureTargets(mine).then(rows => box.replaceChildren(rows.length ? h('div', {},
      explain(`${+M.season + 2} 1sts to buy a year early: teams competing now on rosters that age badly.`, "Ranked highest: teams whose record is better than their points and projections say (they think they're contenders, push with picks and try to keep it going next year), and owners who've traded 1sts before. The market still prices these as ordinary 1sts."),
      table([
        { key: 'lg', label: 'League', n: false, sort: r => r.L.nick, fmt: (v, r) => r.L.nick },
        { key: 'own', label: 'Owner', n: false, sort: r => r.t.owner, fmt: (v, r) => h('a', { href: `#/owners/${r.L.id}/${r.t.ownerId}` }, r.t.owner) },
        { key: 'rec', label: 'Now', n: false, sort: r => r.t.playoff, fmt: (v, r) => `${r.t.wins}-${r.t.losses}, ${Math.round((r.t.playoff || 0) * 100)}% playoffs` },
        { key: 'why', label: 'Why', n: false, sort: r => r.score, fmt: (v, r) => h('span', {}, r.why.map(w => h('span', { class: 'tag', style: { marginRight: '4px' } }, w))) },
        { key: 'slot', label: 'Likely slot', n: true, sort: r => -r.slot, fmt: (v, r) => '#' + r.slot },
        { key: 'edge', label: 'Edge', n: true, sort: r => r.edge, fmt: (v, r) => h('span', { class: 'pos', title: sgn(r.edge) }, f1(r.L, r.edge)) },
        { key: 'go', label: '', n: false, sort: () => 0, fmt: (v, r) => h('a', { href: `#/trades/${r.L.id}/${r.t.rid}/calc` }, 'Offer →') },
      ], rows.slice(0, 12), { sortKey: 'score' })) : h('div', { class: 'muted' }, 'No clear targets right now.'))).catch(() => box.replaceChildren(h('div', { class: 'muted' }, 'Could not load trade histories.')));
    return box;
  }]);

  const ORDER = ['💎', '⚠️', '🔮', 'Sell', 'Exposure'];
  tabs.sort((a, b) => ORDER.findIndex(o => a[0].startsWith(o)) - ORDER.findIndex(o => b[0].startsWith(o)));
  if (tabs.length) {
    let cur = 0;
    const tb = h('div', { class: 'tabs' }), pane = h('div');
    const show = i => { cur = i; tb.querySelectorAll('button').forEach((b, j) => b.classList.toggle('on', j === i)); pane.replaceChildren(tabs[i][1]()); };
    tabs.forEach(([l], i) => tb.append(h('button', { onclick: () => show(i) }, l)));
    root.append(h('h2', { style: { margin: '22px 0 0' } }, 'Opportunities'), tb, h('div', { class: 'panel' }, pane));
    show(0);
  }

  return root;
}
const kpi = (v, l) => h('div', { class: 'kpi' }, h('b', {}, v), h('span', {}, l));

const explain = (lead, more) => h('div', { class: 'small', style: { marginBottom: '10px' } }, lead, ' ', h('details', { style: { display: 'inline' } }, h('summary', { class: 'muted', style: { display: 'inline', fontWeight: 400 } }, 'Why'), h('span', { class: 'muted' }, ' ' + more)));

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
