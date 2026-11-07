import { M, leagueById, teamAssets, asset, isPick } from '../model.js';
import { state, logTrade, updateTrade, deleteTrade, settings, save } from '../state.js';
import { evalTrade, simDelta, suggest, tradeValue } from '../trade.js';
import { teamPlan } from '../plan.js';
import { loadTrades, tradeSides, pickIndex } from '../owners.js';
import { h, fmt, sgn, pct, toast, sleep } from '../util.js';
import { modeTag, posB, assetLine, empty, delta } from '../components.js';

const STATUSES = ['sent', 'accepted', 'rejected', 'countered', 'ignored', 'withdrawn'];

export default function tradesView(id, partnerRid, sub) {
  const root = h('div');
  const myLeagues = M.leagues.filter(L => L.me);
  const L = leagueById(id) || myLeagues[0];
  if (!L) return empty('No leagues.');
  const tab = sub || (partnerRid ? 'calc' : 'suggest');
  root.append(h('div', { class: 'row', style: { marginBottom: '10px', gap: '6px' } },
    myLeagues.map(x => h('a', { href: `#/trades/${x.id}`, class: 'tag' + (x.id === L.id ? ' push' : '') }, x.nick))));
  const tabs = [['suggest', 'Suggestions'], ['calc', 'Calculator'], ['log', `Trade log (${state().trades.filter(t => t.status === 'sent').length} open)`]];
  const p = partnerRid || L.teams.find(t => !t.isMe)?.rid;
  root.append(h('div', { class: 'tabs' }, tabs.map(([k, l]) => h('button', { class: k === tab ? 'on' : '', onclick: () => location.hash = `#/trades/${L.id}/${p}/${k}` }, l))));
  if (tab === 'calc') root.append(calculator(L, +p));
  if (tab === 'suggest') root.append(suggestions(L));
  if (tab === 'log') root.append(logView());
  return root;
}

// ---------------- calculator ----------------
export function calculator(L, partnerRid, preset = null) {
  const wrap = h('div');
  const partners = L.teams.filter(t => !t.isMe);
  let partner = L.byRid[partnerRid] || partners[0];
  const give = new Set(preset?.give || []), get = new Set(preset?.get || []);
  const sel = h('select', { onchange: e => { partner = L.byRid[e.target.value]; get.clear(); draw(); } },
    partners.map(t => h('option', { value: t.rid, selected: t.rid === partner.rid }, `${t.owner} (${t.wins}-${t.losses})`)));
  const result = h('div');
  const pickers = h('div', { class: 'sides' });
  function picker(team, set, title) {
    const q = h('input', { placeholder: 'Filter…', style: { width: '100%', marginBottom: '6px' } });
    const list = h('div', { class: 'picker' });
    const items = teamAssets(L, team).sort((a, b) => b.fc - a.fc);
    const fill = () => list.replaceChildren(...items.filter(a => !q.value || a.name.toLowerCase().includes(q.value.toLowerCase())).map(a => {
      const cb = h('input', { type: 'checkbox', checked: set.has(a.key), onchange: e => { e.target.checked ? set.add(a.key) : set.delete(a.key); evaluate(); } });
      return h('label', {}, cb, posB(a.pos), h('span', {}, a.name, a.age ? h('span', { class: 'muted small' }, ' ' + a.age.toFixed(1)) : ''), h('span', { class: 'v' }, `${fmt(a.fc)} / ${fmt(a.tat)}`));
    }));
    q.oninput = fill; fill();
    return h('div', {}, h('h3', {}, title), h('div', { class: 'muted small', style: { marginBottom: '4px' } }, 'FC / TAT'), q, list);
  }
  function draw() {
    pickers.replaceChildren(picker(L.me, give, 'You send'), picker(partner, get, `${partner.owner} sends`));
    evaluate();
  }
  function evaluate() {
    if (!give.size && !get.size) { result.replaceChildren(empty('Tick players or picks on both sides.')); return; }
    const r = evalTrade(L, partner, [...give], [...get]);
    result.replaceChildren(evalPanel(r, { showSim: true }));
  }
  wrap.append(h('div', { class: 'panel' }, h('div', { class: 'row', style: { marginBottom: '12px' } }, h('b', {}, 'Partner'), sel, modeTag(partner.mode)), pickers), h('div', { class: 'panel' }, result));
  draw();
  return wrap;
}

export function evalPanel(r, { showSim = false, compact = false } = {}) {
  const { L, partner } = r;
  const m = r.fc.partnerMargin;
  const el = h('div');
  const simBox = h('div');
  el.append(
    compact ? '' : h('div', { class: 'sides', style: { marginBottom: '12px' } },
      h('div', {}, h('h3', {}, 'You send'), h('div', { class: 'assets' }, r.give.map(a => assetLine(a)))),
      h('div', {}, h('h3', {}, 'You get'), h('div', { class: 'assets' }, r.get.map(a => assetLine(a))))),
    h('div', { class: 'kpis' },
      kpi(delta(r.tatGain), 'Sanderson gain (you)'),
      kpi(delta(m), `FC for ${partner.owner}` + (r.fc.adjA || r.fc.adjB ? ` (adj ${fmt(r.fc.adjA || r.fc.adjB)})` : '')),
      r.me ? kpi(h('span', {}, delta(r.me.rosAfter - r.me.rosBefore, 1), ' / ', delta(r.me.poAfter - r.me.poBefore, 1)), 'Your pts/wk: now / playoffs') : '',
      r.them ? kpi(h('span', {}, delta(r.them.rosAfter - r.them.rosBefore, 1), ' / ', delta(r.them.poAfter - r.them.poBefore, 1)), `${partner.owner} pts/wk`) : ''),
    h('div', { class: 'small muted', style: { marginTop: '4px' } }, h('b', {}, r.mixLabel), ` · picks ${sgn(r.mix.picks)}, this season ${sgn(r.mix.now)}, future years ${sgn(r.mix.future)}`),
    r.type && r.type.id !== 'other' ? h('div', { class: 'small', style: { marginTop: '4px' } }, h('b', {}, r.type.label), r.type.tip ? ': ' + r.type.tip : '') : '',
    h('div', { class: 'flags' },
      r.flags.length ? r.flags.map(f => h('div', { class: 'flag ' + (f.bad ? 'bad' : f.warn ? 'warnf' : '') }, (f.bad ? '✕ ' : f.warn ? '⚠️ ' : '• ') + f.msg)) : h('div', { class: 'flag ok' }, '✓ Fits the partner and your lineup rules'),
      r.memory.same ? h('div', { class: 'flag ' + (['rejected', 'ignored', 'withdrawn'].includes(r.memory.same.status) ? 'bad' : '') }, `You sent this exact offer on ${new Date(r.memory.same.created).toLocaleDateString()}: ${r.memory.same.status}`) : '',
      r.memory.overlap.filter(o => o !== r.memory.same).slice(0, 3).map(o => h('div', { class: 'flag' }, `Earlier ask for ${o.getNames.join(' + ')} (${new Date(o.created).toLocaleDateString()}): ${o.status}`))),
    h('div', { class: 'row', style: { marginTop: '10px' } },
      !showSim && r.me ? h('button', { class: 'btn ghost small', onclick: async e => { e.target.disabled = true; simBox.replaceChildren(h('span', { class: 'muted small' }, 'Simulating…')); await sleep(20); const d = simDelta(L, r); simBox.replaceChildren(simTable(d, partner)); e.target.disabled = false; } }, 'Simulate playoff / title impact') : '',
      h('button', { class: 'btn small', onclick: () => { logTrade(toLog(r)); toast('Logged as sent'); } }, 'Log as sent')),
    simBox);
  // in the calculator, re-simulate the season automatically whenever the trade changes
  if (showSim && r.me) {
    simBox.replaceChildren(h('div', { class: 'muted small', style: { marginTop: '10px' } }, 'Simulating the season with and without this trade…'));
    clearTimeout(evalPanel._t);
    evalPanel._t = setTimeout(() => { if (!simBox.isConnected) return; const d = simDelta(L, r); d.value = tradeValue(L, r, d); simBox.replaceChildren(simTable(d, partner)); }, 250);
  }
  return el;
}

function simTable(d, partner) {
  const P = x => Math.round(x * 100);
  const word = dlt => { const a = Math.abs(dlt); return a < 0.01 ? 'about the same' : a < 0.04 ? (dlt > 0 ? 'slightly better' : 'slightly worse') : a < 0.12 ? (dlt > 0 ? 'better' : 'worse') : (dlt > 0 ? 'much better' : 'much worse'); };
  const phrase = (who, [b, a]) => {
    const parts = [['make the playoffs', 'playoff'], ['win the title', 'title']].map(([lbl, k]) => {
      const dl = a[k] - b[k];
      return P(a[k]) === P(b[k]) ? `chance to ${lbl} stays at ${P(b[k])}%` : `chance to ${lbl} goes from ${P(b[k])}% to ${P(a[k])}%`;
    });
    return `${who}: ${parts.join(', and ')}.`;
  };
  // one row: label, before bar -> after bar, change
  const bar = (b, a, lbl) => {
    const dl = a - b, c = dl > 0.005 ? 'var(--pos)' : dl < -0.005 ? 'var(--neg)' : 'var(--muted)';
    return h('div', { class: 'oddrow' },
      h('span', { class: 'oddlbl' }, lbl),
      h('div', { class: 'oddbar' }, h('i', { class: 'before', style: { width: P(b) + '%' } }), h('i', { class: 'after', style: { width: P(a) + '%', background: c } })),
      h('span', { class: 'oddnum' }, `${P(b)}% → `, h('b', { style: { color: c } }, `${P(a)}%`)));
  };
  const team = (who, x) => h('div', { class: 'card' }, h('h3', {}, who),
    bar(x[0].playoff, x[1].playoff, 'Playoffs'), bar(x[0].bye, x[1].bye, 'Bye'), bar(x[0].title, x[1].title, 'Title'));
  const me = d.me, dT = me[1].title - me[0].title, dP = me[1].playoff - me[0].playoff;
  const headline0 = Math.abs(dT) >= 0.01
    ? `Your title chances get ${word(dT)}: ${P(me[0].title)}% → ${P(me[1].title)}%.`
    : `Your title chances don't really change (${P(me[0].title)}% → ${P(me[1].title)}%)` + (Math.abs(dP) >= 0.01 ? `, but your playoff chances get ${word(dP)}: ${P(me[0].playoff)}% → ${P(me[1].playoff)}%.` : '.');
  const v = d.value;
  const headline = headline0 + (v ? ` Overall worth ${sgn(v.total)} to you (long-term ${sgn(v.tat)} after this season's games are used up, this season ${sgn(v.now)}${v.pickShift && Math.abs(v.pickShift) >= 50 ? `, of which draft-slot shift ${sgn(v.pickShift)}` : ''}).` : '');
  return h('div', { style: { marginTop: '12px' } },
    h('div', { class: 'verdict' }, headline),
    h('div', { class: 'sides', style: { marginTop: '10px' } }, team('You', d.me), team(partner.owner, d.them)),
    h('p', { class: 'small muted', style: { marginTop: '8px' } }, phrase('You', d.me), ' ', phrase(partner.owner, d.them),
      ' Grey = now, coloured = after the trade. Both versions of the season use the same luck, so the difference is the trade itself; changes of 1% or less are noise.'));
}

const kpi = (v, l) => h('div', { class: 'kpi' }, h('b', {}, v), h('span', {}, l));

export function toLog(r) {
  return {
    leagueId: r.L.id, leagueNick: r.L.nick, partnerOwnerId: r.partner.ownerId, partnerName: r.partner.owner, partnerRid: r.partner.rid,
    give: r.giveKeys, get: r.getKeys, giveNames: r.give.map(a => a.name), getNames: r.get.map(a => a.name),
    fcMargin: Math.round(r.fc.partnerMargin), tatGain: Math.round(r.tatGain),
  };
}

// ---------------- suggestions ----------------
export function planPanel(L) {
  const p = teamPlan(L);
  if (!p) return '';
  return h('div', { class: 'panel plan' }, h('div', { class: 'row spread' }, h('h2', { style: { margin: 0 } }, `${L.nick}: ${p.headline}`)),
    h('ul', { class: 'small', style: { margin: '8px 0 0', paddingLeft: '18px' } }, p.lines.map(l => h('li', {}, l))));
}

function suggestions(L) {
  const S = settings();
  const box = h('div');
  const out = h('div');
  const run = async (leagues) => {
    out.replaceChildren(h('div', { class: 'loading' }, h('div', { class: 'spinner' }), 'Searching trades…'));
    await sleep(30);
    let all = [];
    for (const lg of leagues) {
      // this league's own price for picks, from its trade history
      const pi = await pickIndex(lg).catch(() => null);
      lg.pickIndex = pi;
      for (const t of lg.teams) t._pickIndex = pi?.index || null;
      all = all.concat(suggest(lg)); await sleep(0);
    }
    all.sort((a, b) => b.score - a.score);
    if (!all.length) { out.replaceChildren(empty('No trades pass all the rules. Loosen them in Settings, add targets on the Values page, or upload newer TAT values.')); return; }
    // filter by goal
    const labels = [...new Set(all.flatMap(r => r.goals.map(g => g.label)))];
    const grid = h('div', { class: 'cards' });
    const show = f => grid.replaceChildren(...all.filter(r => !f || (f === 'Pure value' ? r.pureValue : r.goals.some(g => g.label === f))).slice(0, 40).map(r => suggestionCard(r)));
    const chips = h('div', { class: 'row', style: { margin: '0 0 12px', gap: '6px' } }, h('span', { class: 'small muted' }, 'Goal:'),
      ['All', ...labels, ...(all.some(r => r.pureValue) ? ['Pure value'] : [])].map(l => h('button', { class: 'tag', style: { cursor: 'pointer' }, onclick: e => { chips.querySelectorAll('button').forEach(b => b.classList.remove('push')); e.target.classList.add('push'); show(l === 'All' ? null : l); } }, l)));
    chips.querySelector('button').classList.add('push');
    out.replaceChildren(chips, grid); show(null);
  };
  box.append(h('div', { class: 'panel' },
    h('div', { class: 'row spread' }, h('div', {}, h('h2', { style: { margin: 0 } }, 'Suggested trades'),
      h('div', { class: 'muted small' }, `Every trade should serve a goal (Sanderson: "rankings are not a calculator"). Each suggestion is tagged with the goal it serves for you, from your plan, and for the partner when there's a reason for them too. Trades that serve no goal only appear if they win decisively. Within that, they're ranked by total value to you: Sanderson value gained plus the effect on this season (a title = ${fmt(S.titleWorth ?? 4500)} TAT). Treat the Sanderson-fair price as the worst acceptable deal, not the target. Offers already rejected are skipped.`)),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => run([L]) }, `Find in ${L.nick}`), h('button', { class: 'btn ghost', onclick: () => run(M.leagues.filter(x => x.me)) }, 'All leagues')))),
    out);
  box.insertBefore(planPanel(L), box.firstChild);
  if (!state().tatSets.length) out.append(h('div', { class: 'panel' }, 'Upload Sanderson rankings on the ', h('a', { href: '#/values' }, 'Values page'), ' first. Without them every player is valued at half his FC value, so suggestions are meaningless.'));
  return box;
}

function suggestionCard(r) {
  return h('div', { class: 'card' },
    h('div', { class: 'row spread', style: { marginBottom: '8px' } }, h('div', {}, h('b', {}, r.L.nick), ' · ', r.partner.owner, ' ', modeTag(r.partner.mode)),
      h('span', { class: 'pos', style: { fontWeight: 700 }, title: 'Total value to you, in Sanderson points' }, sgn(r.value?.total ?? r.tatGain))),
    h('div', { class: 'row', style: { gap: '4px', marginBottom: '6px' } },
      (r.goals || []).map(g => h('span', { class: 'tag push' }, g.label)),
      r.pureValue ? h('span', { class: 'tag', title: 'Serves none of your goals in this league, so it only shows up because it wins decisively' }, 'Pure value') : '',
      r.theirGoal ? h('span', { class: 'tag good', title: "Why it makes sense for them" }, r.theirGoal) : '',
      r.type && r.type.id !== 'other' ? h('span', { class: 'tag', title: r.type.tip }, r.type.label) : ''),
    h('div', { class: 'small', style: { marginBottom: '8px' } },
      h('span', { class: (r.value?.tat ?? r.tatGain) >= 0 ? 'pos' : 'neg', title: "Sanderson value after this season (market value minus the production the players will use up this year). This season's production is counted in the next number instead." }, `Long-term ${sgn(r.value?.tat ?? r.tatGain)}`), r.value?.dr < 0.99 ? h('span', { class: 'muted', title: "You're already well ahead of this league in value, so more of it adds little title equity" }, ` (of ${sgn(r.value.tatRaw)}, diminishing returns)`) : '', ' + ',
      h('span', { class: (r.value?.now ?? 0) >= 0 ? 'pos' : 'neg' }, `this season ${sgn(r.value?.now ?? 0)}`),
      r.sim ? h('span', { class: 'muted' }, ` (title ${Math.round(r.sim.me[0].title * 100)}% → ${Math.round(r.sim.me[1].title * 100)}%` + (Math.abs(r.value?.pickShift || 0) >= 50 ? `, draft-slot shift ${sgn(r.value.pickShift)}` : '') + ')') : ''),
    h('div', { class: 'small muted' }, 'You send'), h('div', { class: 'assets' }, r.give.map(a => assetLine(a))),
    h('div', { class: 'small muted', style: { marginTop: '6px' } }, 'You get'), h('div', { class: 'assets' }, r.get.map(a => assetLine(a))),
    h('div', { class: 'small', style: { marginTop: '8px' } },
      `FC ${r.partner.owner} ${sgn(r.fc.partnerMargin)}`, r.me ? ` · your pts/wk ${sgn(r.me.rosAfter - r.me.rosBefore, 1)} now, ${sgn(r.me.poAfter - r.me.poBefore, 1)} playoffs` : '',
      r.them ? ` · theirs ${sgn(r.them.rosAfter - r.them.rosBefore, 1)}` : ''),
    h('div', { class: 'small muted', style: { marginTop: '4px' } }, h('b', {}, r.mixLabel), ` · picks ${sgn(r.mix.picks)}, this season ${sgn(r.mix.now)}, future years ${sgn(r.mix.future)}`),
    r.flags.filter(f => f.warn).map(f => h('div', { class: 'small warn' }, '⚠️ ' + f.msg)),
    r.memory.overlap.length ? h('div', { class: 'small warn' }, `Asked for ${r.memory.overlap[0].getNames.join(' + ')} before: ${r.memory.overlap[0].status}`) : '',
    h('div', { class: 'row', style: { marginTop: '8px' } },
      h('button', { class: 'btn ghost small', onclick: () => { const box = document.getElementById('app'); box.replaceChildren(h('div', {}, h('a', { href: `#/trades/${r.L.id}` }, '← back'), calculator(r.L, r.partner.rid, { give: r.giveKeys, get: r.getKeys }))); } }, 'Open in calculator'),
      h('button', { class: 'btn small', onclick: e => { logTrade(toLog(r)); e.target.textContent = 'Logged ✓'; e.target.disabled = true; } }, 'Log as sent')));
}

// ---------------- log ----------------
function logView() {
  const S = state();
  const box = h('div', { class: 'panel' });
  const status = h('div', { class: 'muted small' }, 'Checking Sleeper for accepted trades…');
  const draw = () => {
    const rows = S.trades;
    const stats = STATUSES.map(s => [s, rows.filter(t => t.status === s).length]).filter(x => x[1]);
    box.replaceChildren(
      h('div', { class: 'row spread' }, h('h2', { style: { margin: 0 } }, 'Trade log'), h('div', { class: 'row' }, stats.map(([s, n]) => h('span', { class: 'tag' }, `${s} ${n}`)))),
      status,
      rows.length ? h('div', { class: 'tablewrap', style: { marginTop: '10px' } }, h('table', {},
        h('thead', {}, h('tr', {}, ['Date', 'League', 'Partner', 'You send', 'You get', 'TAT', 'FC them', 'Status', 'Notes', ''].map(x => h('th', {}, x)))),
        h('tbody', {}, rows.map(t => h('tr', {},
          h('td', {}, new Date(t.created).toLocaleDateString()), h('td', {}, t.leagueNick || leagueById(t.leagueId)?.nick || ''), h('td', {}, t.partnerName),
          h('td', { style: { whiteSpace: 'normal', minWidth: '140px' } }, t.giveNames.join(' + ')), h('td', { style: { whiteSpace: 'normal', minWidth: '140px' } }, t.getNames.join(' + ')),
          h('td', { class: 'n ' + (t.tatGain >= 0 ? 'pos' : 'neg') }, sgn(t.tatGain)), h('td', { class: 'n' }, sgn(t.fcMargin)),
          h('td', {}, h('select', { onchange: e => { updateTrade(t.id, { status: e.target.value }); draw(); } }, STATUSES.map(s => h('option', { selected: s === t.status }, s))), t.auto ? h('span', { class: 'muted small' }, ' auto') : ''),
          h('td', {}, h('input', { value: t.notes || '', placeholder: 'note', onchange: e => updateTrade(t.id, { notes: e.target.value }) })),
          h('td', {}, h('button', { class: 'btn ghost small', onclick: () => { if (confirm('Delete this log entry?')) { deleteTrade(t.id); draw(); } } }, '✕'))))))) : empty('No trades logged yet. Use "Log as sent" in the calculator or on a suggestion.'));
  };
  draw();
  detectAccepted().then(n => { status.textContent = n ? `Found ${n} accepted trade(s) on Sleeper and marked them.` : 'Open offers are checked against completed Sleeper trades every time you open this page.'; if (n) draw(); });
  return box;
}

// mark logged offers as accepted when a matching completed trade shows up on Sleeper
export async function detectAccepted() {
  const open = state().trades.filter(t => ['sent', 'countered', 'ignored'].includes(t.status));
  let n = 0;
  for (const lid of new Set(open.map(t => t.leagueId))) {
    const L = leagueById(lid); if (!L || !L.me) continue;
    const trades = await loadTrades(L);
    for (const t of open.filter(x => x.leagueId === lid)) {
      for (const tr of trades) {
        if (tr.created < t.created - 3600e3) continue;
        const sides = tradeSides(L, tr);
        const me = Object.values(sides).find(s => s.ownerId === M.me.user_id);
        if (!me) continue;
        const got = new Set(me.got.map(a => a.key)), gave = new Set(me.gave.map(a => a.key));
        const pl = k => !isPick(k);
        if (t.get.filter(pl).every(k => got.has(k)) && t.give.filter(pl).every(k => gave.has(k)) && (t.get.some(pl) || t.give.some(pl))) {
          updateTrade(t.id, { status: 'accepted', auto: true, acceptedAt: tr.created }); n++; break;
        }
      }
    }
  }
  return n;
}
