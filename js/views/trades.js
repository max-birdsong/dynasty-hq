import { M, leagueById, teamAssets, asset, isPick } from '../model.js';
import { state, logTrade, updateTrade, deleteTrade, settings, save, rawRules, setRules, rulesOf } from '../state.js';
import { evalTrade, simDelta, suggest, tradeValue, calcEdge, calcValue } from '../trade.js';
import { teamPlan } from '../plan.js';
import { loadTrades, tradeSides, pickIndex } from '../owners.js';
import { h, fmt, sgn, pct, toast, sleep, f1, lineChart } from '../util.js';
import { curves, seasons, total } from '../equity.js';
import { preferredCalc } from '../affinity.js';
import { pAccept, reasons, learnedFrom } from '../accept.js';
import { loadBuzz, buzzLine, takesFor } from '../buzz.js';
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
      kpi(h('span', { class: r.tatGain >= 0 ? 'pos' : 'neg', title: sgn(r.tatGain) + ' Sanderson points' }, f1(L, r.tatGain)), 'Sanderson gain (you)'),
      kpi(delta(m), `FC for ${partner.owner}` + (r.fc.adjA || r.fc.adjB ? ` (adj ${fmt(r.fc.adjA || r.fc.adjB)})` : '')),
      r.me ? kpi(h('span', {}, delta(r.me.rosAfter - r.me.rosBefore, 1), ' / ', delta(r.me.poAfter - r.me.poBefore, 1)), 'Your pts/wk: now / playoffs') : '',
      r.them ? kpi(h('span', {}, delta(r.them.rosAfter - r.them.rosBefore, 1), ' / ', delta(r.them.poAfter - r.them.poBefore, 1)), `${partner.owner} pts/wk`) : ''),
    h('div', { class: 'small muted', style: { marginTop: '4px' } }, h('b', {}, r.mixLabel), ` · picks ${sgn(r.mix.picks)}, this season ${sgn(r.mix.now)}, future years ${sgn(r.mix.future)}`),
    r.type && r.type.id !== 'other' ? h('div', { class: 'small', style: { marginTop: '4px' } }, h('b', {}, r.type.label), r.type.tip ? ': ' + r.type.tip : '') : '',
    h('div', { class: 'flags' },
      r.flags.some(f => !f.info) ? r.flags.filter(f => !f.info).map(f => h('div', { class: 'flag ' + (f.bad ? 'bad' : f.warn ? 'warnf' : '') }, (f.bad ? '✕ ' : f.warn ? '⚠️ ' : '• ') + f.msg)) : h('div', { class: 'flag ok' }, '✓ Fits the partner and your lineup rules'),
      r.flags.filter(f => f.info).map(f => h('div', { class: 'flag' }, f.msg)),
      marketVerdicts(L, r, partner),
      buzzBox(r),
      acceptLine(L, r, partner),
      r.memory.same ? h('div', { class: 'flag ' + (['rejected', 'ignored', 'withdrawn'].includes(r.memory.same.status) ? 'bad' : '') }, `You sent this exact offer on ${new Date(r.memory.same.created).toLocaleDateString()}: ${r.memory.same.status}`) : '',
      r.memory.overlap.filter(o => o !== r.memory.same).slice(0, 3).map(o => h('div', { class: 'flag' }, `Earlier ask for ${o.getNames.join(' + ')} (${new Date(o.created).toLocaleDateString()}): ${o.status}`))),
    h('div', { class: 'row', style: { marginTop: '10px' } },
      !showSim && r.me ? h('button', { class: 'btn ghost small', onclick: async e => { e.target.disabled = true; simBox.replaceChildren(h('span', { class: 'muted small' }, 'Simulating…')); await sleep(20); const d = simDelta(L, r); d.L = L; d.r = r; simBox.replaceChildren(simTable(d, partner)); e.target.disabled = false; } }, 'Simulate playoff / title impact') : '',
      h('button', { class: 'btn small', onclick: () => { logTrade(toLog(r)); toast('Logged as sent'); } }, 'Log as sent')),
    simBox);
  // in the calculator, re-simulate the season automatically whenever the trade changes
  if (showSim && r.me) {
    simBox.replaceChildren(h('div', { class: 'muted small', style: { marginTop: '10px' } }, 'Simulating the season with and without this trade…'));
    clearTimeout(evalPanel._t);
    evalPanel._t = setTimeout(() => { if (!simBox.isConnected) return; const d = simDelta(L, r); d.L = L; d.r = r; d.value = tradeValue(L, r, d); simBox.replaceChildren(simTable(d, partner)); }, 250);
  }
  return el;
}

function simTable(d, partner) {
  const P = x => Math.round(x * 100);
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
  const me = d.me, L = d.L;
  const ch = (k, lbl) => { const b = P(me[0][k]), a = P(me[1][k]); return b === a ? null : `${lbl} ${b}% → ${a}%`; };
  const v = d.value;
  const odd = [ch('title', 'title'), Math.abs(me[1].bye - me[0].bye) >= 0.03 ? ch('bye', 'bye') : null, ch('playoff', 'playoffs')].filter(Boolean);
  const dB = me[1].bye - me[0].bye;
  return h('div', { style: { marginTop: '12px' } },
    h('div', { class: 'verdict' },
      v ? h('div', { class: 'big' }, h('span', { class: v.total >= 0 ? 'pos' : 'neg' }, `Worth ${f1(L, v.total)}`), h('span', { class: 'muted small', title: 'Sanderson points' }, ` (${sgn(v.total)})`)) : '',
      h('div', { class: 'small' }, v ? `Long-term ${f1(L, v.tat)} · this season ${f1(L, v.now)}` : '', odd.length ? (v ? ': ' : '') + odd.join(', ') : (v ? ': odds unchanged' : 'Odds unchanged'),
        v?.pickShift && Math.abs(v.pickShift) >= 50 ? ` (draft slot ${f1(L, v.pickShift)})` : '',
        dB >= 0.03 ? h('div', { class: 'pos' }, "Raises your bye odds: Sanderson's best reason to buy.") : dB <= -0.03 ? h('div', { class: 'neg' }, 'Costs you bye equity.') : '')),
    h('div', { class: 'sides', style: { marginTop: '10px' } }, team('You', d.me), team(partner.owner, d.them)),
    h('p', { class: 'small muted', style: { marginTop: '6px' } }, 'Grey = now, coloured = after. Both seasons use the same luck; changes of 1% or less are noise.'),
    d.r ? equityPreview(L, d, partner) : '');
}

const kpi = (v, l) => h('div', { class: 'kpi' }, h('b', {}, v), h('span', {}, l));

export function toLog(r) {
  return {
    leagueId: r.L.id, leagueNick: r.L.nick, partnerOwnerId: r.partner.ownerId, partnerName: r.partner.owner, partnerRid: r.partner.rid,
    give: r.giveKeys, get: r.getKeys, giveNames: r.give.map(a => a.name), getNames: r.get.map(a => a.name),
    fcMargin: Math.round(r.fc.partnerMargin), tatGain: Math.round(r.tatGain),
    // what the acceptance model saw when you sent it, so it can learn from the outcome
    ...(() => { try { const a = pAccept(r.L, r.partner, r); return { features: a.f, pAccept: +a.p.toFixed(3) }; } catch { return {}; } })(),
    // how the offer looked to him on each calculator, so his answer can confirm or overrule which one he uses
    ...(() => { try { const ce = {}; for (const k of ['ktc', 'fc', 'dp', 'fp']) { const e = calcEdge(r.L, r.give, r.get, k); if (Number.isFinite(e) && (k === 'fc' || M.calcs?.[k])) ce[k] = +e.toFixed(3); } return { calcEdges: ce }; } catch { return {}; } })(),
  };
}

// ---------------- suggestions ----------------
// ---------- win equity curve: this season and the next three, before vs after ----------
function equityPreview(L, d, partner) {
  const r = d.r, me = L.me;
  const gk = new Set(r.give.map(a => a.key)), tk = new Set(r.get.map(a => a.key));
  const mine = teamAssets(L, me), theirs = teamAssets(L, partner);
  const before = curves(L), after = curves(L,
    { [me.rid]: [...mine.filter(a => !gk.has(a.key)), ...r.get], [partner.rid]: [...theirs.filter(a => !tk.has(a.key)), ...r.give] },
    { [me.rid]: d.me[1].title, [partner.rid]: d.them[1].title });
  const yrs = seasons(L), pts = c => c.map((v, i) => [yrs[i], v]);
  const tB = total(before[me.rid]), tA = total(after[me.rid]), pB = total(before[partner.rid]), pA = total(after[partner.rid]);
  return h('div', { style: { marginTop: '14px' } },
    h('div', { class: 'small' }, h('b', {}, 'Win equity, this season + next 3: '), `you ${tB.toFixed(2)} → `, h('b', { class: tA >= tB ? 'pos' : 'neg' }, tA.toFixed(2)), ` expected titles (${tA - tB >= 0 ? '+' : ''}${(tA - tB).toFixed(2)}) · ${partner.owner} ${pB.toFixed(2)} → ${pA.toFixed(2)}`),
    lineChart([
      { name: 'You now', color: '#9aa4b2', width: 1.5, points: pts(before[me.rid]) },
      { name: 'You after', color: '#2563eb', width: 3, points: pts(after[me.rid]) },
      { name: `${partner.owner} after`, color: '#f59e0b', width: 2, points: pts(after[partner.rid]) },
    ], { h: 170, yFmt: v => Math.round(v * 100) + '%', yMin: 0 }),
    h('p', { class: 'small muted' }, 'This season from the simulator; later seasons from each roster’s projected points (players aged with real production curves, picks as rookies) run through the same simulator. The total is the sum: expected titles over the four seasons.'));
}

// ---------- chance he accepts ----------
function acceptLine(L, r, partner) {
  const box = h('div', { style: { marginTop: '10px' } });
  loadCalcs().then(c => {
    M.calcs ||= c;
    const { p, f } = pAccept(L, partner, r), n = learnedFrom();
    box.replaceChildren(h('div', {}, h('b', {}, `Chance ${partner.owner} accepts: ~${Math.round(p * 100)}%`),
      h('span', { class: 'muted small' }, n >= 5 ? ` (tuned on ${n} of your logged offers)` : ' (starting estimate: log your offers and outcomes to tune it)')),
      h('ul', { class: 'small', style: { margin: '4px 0 0', paddingLeft: '18px' } }, reasons(f).map(x => h('li', {}, x))));
  });
  return box;
}

// ---------- market verdicts: the trade on each calculator ----------
let calcsP = null;
const loadCalcs = () => calcsP || (calcsP = fetch('data/calcs.json', { cache: 'no-cache' }).then(x => x.ok ? x.json() : null).catch(() => null));
const ORD_N = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: '5th' };
// what the podcasts are saying about the players in this deal (last 30 days)
function buzzBox(r) {
  const box = h('div', { class: 'small', style: { marginTop: '8px' } });
  loadBuzz().then(B => {
    if (!B) return;
    const rows = [...r.give.map(a => [a, 'you send']), ...r.get.map(a => [a, 'you get'])].filter(([a]) => a.id).map(([a, side]) => {
      const line = buzzLine(B, a.id); if (!line) return null;
      const t = takesFor(B, a.id)[0];
      return h('div', {}, h('b', {}, a.name.split(' (')[0]), ` (${side}): ${line}. Latest: “${t.quote}” (${t.show}) `, h('a', { href: '#/buzz' }, 'all takes'));
    }).filter(Boolean);
    if (rows.length) box.replaceChildren(h('b', {}, 'Podcast buzz'), ...rows);
  });
  return box;
}

function marketVerdicts(L, r, partner) {
  const box = h('div', { class: 'verdicts' });
  loadCalcs().then(c => {
    if (!c) return;
    const sf = L.fmt.numQbs === 2 ? 'sf' : 'one', n = L.numTeams;
    const pickName = a => { const [, y, rd] = a.key.split(':'); const tier = a.slot && +y === +L.season + 1 ? (a.slot <= n / 3 ? 'Early' : a.slot <= 2 * n / 3 ? 'Mid' : 'Late') : 'Mid'; return `${y} ${tier} ${ORD_N[rd] || rd + 'th'}`; };
    const pc = preferredCalc(partner.ownerId);
    const rows = [['ktc', 'KeepTradeCut'], ['fc', 'FantasyCalc'], ['dp', 'DynastyProcess'], ['fp', 'FantasyPros']].filter(([k]) => k === 'fc' || c[k]).map(([k, label]) => {
      // same math as the calculators themselves, value adjustment included (a pile of pieces < one star)
      M.calcs ||= c;
      return { k, label, d: -calcEdge(L, r.give, r.get, k) };
    });
    rows.push({ k: 'tat', label: 'Sanderson (your view)', d: (r.get.reduce((s, a) => s + (a.tat || 0), 0) - r.give.reduce((s, a) => s + (a.tat || 0), 0)) / Math.max(1, r.give.reduce((s, a) => s + (a.tat || 0), 0), r.get.reduce((s, a) => s + (a.tat || 0), 0)) });
    // one click: add the picks his calculator values most per Sanderson point they cost you, until it's fair for him
    let sweetBtn = '';
    if (pc && pc !== 'fc') {
      M.calcs ||= c;
      let edge = calcEdge(L, r.give, r.get, pc);
      if (edge < 0) {
        const pool = teamAssets(L, L.me).filter(a => a.pick && +a.key.split(':')[2] >= 2 && !r.give.some(g => g.key === a.key))
          .map(a => ({ a, cv: calcValue(L, a, pc) || 0 })).filter(x => x.cv > 0).sort((x, y) => (x.a.tat || 1) / x.cv - (y.a.tat || 1) / y.cv);
        const add = [];
        while (edge < 0 && add.length < 3 && pool.length) { add.push(pool.shift().a); edge = calcEdge(L, [...r.give, ...add], r.get, pc); }
        if (edge >= 0) sweetBtn = h('button', { class: 'btn ghost small', style: { marginTop: '6px' }, onclick: () => { const app = document.getElementById('app'); app.replaceChildren(calculator(L, partner.rid, { give: [...r.give.map(a => a.key), ...add.map(a => a.key)], get: r.get.map(a => a.key) })); } },
          `Sweeten for his calculator: add ${add.map(a => a.name.split(' (')[0]).join(' + ')}`);
      }
    }
    box.replaceChildren(h('div', { class: 'small muted', style: { margin: '10px 0 4px' } }, 'Market verdicts', pc ? ` · ${partner.owner} trades by ${rows.find(x => x.k === pc)?.label}` : ''),
      ...rows.map(x => h('div', { class: 'vrow' + (x.k === pc ? ' pref' : '') },
        h('span', { class: 'small' }, x.label),
        h('span', { class: 'vbar' }, h('i', { style: { left: `${50 + Math.max(-48, Math.min(48, x.d * 100))}%` } })),
        h('span', { class: 'small ' + (Math.abs(x.d) < 0.05 ? '' : x.d > 0 ? 'pos' : 'neg') }, Math.abs(x.d) < 0.05 ? 'Fair' : x.d > 0 ? `You +${Math.round(x.d * 100)}%` : `${partner.owner} +${Math.round(-x.d * 100)}%`))), sweetBtn);
  });
  return box;
}

export const VERDICT = { BUY: 'push', HOLD: 'mid', CAREFUL: 'sell', RELOAD: 'tank', SELL: 'tank' };
const KEY_LINE = /^(Deadline|If you filled|Even with|Filling |You don't own|Biggest hole|Trade goals)/;
export function planPanel(L, { compact = false } = {}) {
  const p = teamPlan(L);
  if (!p) return '';
  const key = p.lines.filter(l => KEY_LINE.test(l)).map(l => l.replace(/^Deadline: [A-Z]+[.,]\s*/, '').replace(/^./, c => c.toUpperCase()));
  const rest = p.lines.filter(l => !KEY_LINE.test(l));
  return h('div', { class: 'panel plan' },
    h('div', { class: 'row', style: { gap: '8px' } }, p.verdict ? h('span', { class: 'tag ' + (VERDICT[p.verdict] || ''), title: 'Deadline stance from buying power and production (Sanderson)' }, p.verdict) : '', h('h2', { style: { margin: 0 } }, compact ? p.headline : `${L.nick}: ${p.headline}`)),
    h('ul', { class: 'small keylines' }, key.map(l => h('li', {}, l))),
    compact ? '' : h('div', { class: 'row small', style: { gap: '6px', alignItems: 'center', margin: '4px 0' } }, 'Approach here:',
      h('select', { onchange: e => { const S = settings(); S.leagueMode = { ...(S.leagueMode || {}) }; if (e.target.value) S.leagueMode[L.id] = e.target.value; else delete S.leagueMode[L.id]; save({ settingsChanged: true }); L.plan = null; window.DHQ.route(); } },
        [['', `automatic (now: ${p.tanking ? 'shedding points' : 'playing for this season'})`], ['tank', 'shed points for a better pick'], ['push', 'play for this season']].map(([v, l]) => h('option', { value: v, selected: (settings().leagueMode?.[L.id] || '') === v }, l))),
      h('span', { class: 'muted' }, 'Suggestions and goals follow this.')),
    rest.length ? h('details', {}, h('summary', { class: 'small muted' }, 'Full reasoning'), h('ul', { class: 'small', style: { margin: '6px 0 0', paddingLeft: '18px' } }, rest.map(l => h('li', {}, l)))) : '');
}

function suggestions(L) {
  const S = settings();
  const box = h('div');
  const out = h('div');
  const run = async (leagues, mode = 'value', partners = null) => {
    if (!M.calcs) M.calcs = await loadCalcs();
    await import('../affinity.js').then(a => a.loadAffinity()).catch(() => {});
    out.replaceChildren(h('div', { class: 'loading' }, h('div', { class: 'spinner' }), mode === 'title' ? 'Simulating the season for each candidate trade (about 20 seconds)…' : 'Searching trades…'));
    await sleep(30);
    let all = [];
    for (const lg of leagues) {
      // this league's own price for picks, from its trade history
      const pi = await pickIndex(lg).catch(() => null);
      lg.pickIndex = pi;
      for (const t of lg.teams) t._pickIndex = pi?.index || null;
      all = all.concat(suggest(lg, { mode, partners })); await sleep(0);
    }
    all.sort((a, b) => b.score - a.score);
    if (!all.length && mode === 'title') { out.replaceChildren(empty('No trade found that adds at least 1% title odds at an acceptable long-term price.')); return; }
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
      h('div', { class: 'muted small' }, 'Trades that serve one of your goals, ranked by value to you in generic 1sts. ', h('details', { style: { display: 'inline' } }, h('summary', { style: { display: 'inline', fontWeight: 400 } }, 'How'), ` Each suggestion is tagged with the goal it serves for you and, when there is one, for the partner. Trades that serve no goal only appear if they win decisively. Value = Sanderson value gained plus the effect on this season (a title is worth tens of 1sts, worked out from each league’s values; see the plan for the number). Treat the Sanderson-fair price as the worst acceptable deal, not the target. Offers already rejected are skipped.`))),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => run([L]) }, `Find in ${L.nick}`), h('button', { class: 'btn ghost', onclick: () => run(M.leagues.filter(x => x.me)) }, 'All leagues'), h('button', { class: 'btn ghost', title: 'Trades ranked by how much they raise your title odds, with what each costs long-term', onclick: () => run([L], 'title') }, '🏆 Biggest title swings')))),
    out);
  box.insertBefore(blockPanel(L), box.firstChild);
  { const rq = requestsPanel(L, run); if (rq) box.insertBefore(rq, box.firstChild); }
  box.insertBefore(planPanel(L, { compact: true }), box.firstChild);
  if (!state().tatSets.length) out.append(h('div', { class: 'panel' }, 'Upload Sanderson rankings on the ', h('a', { href: '#/values' }, 'Values page'), ' first. Without them every player is valued at half his FC value, so suggestions are meaningless.'));
  return box;
}

// Sleeper doesn't make trade blocks public, so they're marked by hand. Listed players are always considered,
// and the owner only needs a fair deal (no endowment premium), since they've said they want to sell.
// requests from the league chat / DMs ("looking for vets for picks"), set on owner cards
function requestsPanel(L, run) {
  const reqs = L.teams.filter(t => !t.isMe).map(t => ({ t, r: rulesOf(t.ownerId, L.id) })).filter(x => x.r?.want);
  if (!reqs.length) return null;
  const label = w => w === 'vets' ? 'vets for picks' : w === 'dump' ? 'to dump points (tanking): buy his producers with picks or injured / bench players' : w === 'youth' ? 'young players' : `a ${w}`;
  return h('div', { class: 'panel', style: { borderLeft: '3px solid var(--accent)' } }, h('h2', {}, '🎯 Requests in ' + L.nick),
    reqs.map(({ t, r }) => h('div', { class: 'row spread', style: { padding: '4px 0' } },
      h('span', { class: 'small' }, h('b', {}, t.owner), ` is looking for ${label(r.want)}`, h('span', { class: 'muted' }, ` · until ${new Date(r.untilWant).toLocaleDateString()}`)),
      h('button', { class: 'btn small', onclick: () => run([L], 'value', [t.rid]) }, 'Find trades'))));
}

function blockPanel(L) {
  const S = settings();
  const list = () => ((S.block ||= {})[L.id] ||= []);
  const others = L.teams.filter(t => !t.isMe).flatMap(t => t.players.map(id => ({ id: String(id), t })))
    .filter(x => M.players[x.id]).map(x => ({ ...x, label: `${M.players[x.id].full_name || x.id} (${x.t.owner})` }));
  const chips = h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } });
  const draw = () => chips.replaceChildren(...list().map(id => { const x = others.find(o => o.id === String(id));
    return h('span', { class: 'tag' }, x ? x.label : id, ' ', h('a', { href: 'javascript:void 0', title: 'Remove', onclick: () => { S.block[L.id] = list().filter(y => String(y) !== String(id)); save({ settingsChanged: true }); draw(); } }, '×')); }),
    ...(list().length ? [] : [h('span', { class: 'small muted' }, 'Nobody marked yet.')]));
  const dl = h('datalist', { id: 'blk-' + L.id }, others.map(x => h('option', { value: x.label })));
  const inp = h('input', { list: 'blk-' + L.id, placeholder: 'Type a player on someone\'s block…', style: { minWidth: '320px', maxWidth: '100%' },
    onchange: e => { const x = others.find(o => o.label === e.target.value); if (!x) return; if (!list().includes(x.id)) list().push(x.id); save({ settingsChanged: true }); e.target.value = ''; draw(); } });
  draw();
  return h('details', { class: 'panel' }, h('summary', {}, h('b', {}, `On the trade block in ${L.nick}`), h('span', { class: 'small muted' }, ` (${list().length})`)),
    h('p', { class: 'small muted' }, "Sleeper doesn't share trade blocks outside the app, so mark them here. Listed players are always considered in suggestions, and their owner only needs a fair deal, not a premium."),
    h('div', { class: 'row', style: { gap: '8px', marginBottom: '8px' } }, inp, dl), chips);
}

function suggestionCard(r) {
  return h('div', { class: 'card' },
    h('div', { class: 'row spread', style: { marginBottom: '8px' } }, h('div', {}, h('b', {}, r.L.nick), ' · ', r.partner.owner, ' ', modeTag(r.partner.mode)),
      r.dTitle != null && r.dTitle >= 0.01 && r.value?.tat < 0
        ? h('span', { class: 'pos', style: { fontWeight: 700 }, title: 'Change in title odds, and the long-term value it costs per +1%' }, `Title +${Math.round(r.dTitle * 100)}%`, h('span', { class: 'muted small', style: { fontWeight: 400 } }, ` · ${f1(r.L, -r.value.tat / (r.dTitle * 100), false)} per 1%`))
        : h('span', { class: 'pos', style: { fontWeight: 700 }, title: `Total value to you: ${sgn(r.value?.total ?? r.tatGain)} Sanderson points` }, f1(r.L, r.value?.total ?? r.tatGain))),
    h('div', { class: 'row', style: { gap: '4px', marginBottom: '6px' } },
      (r.goals || []).map(g => h('span', { class: 'tag push' }, g.label)),
      r.pureValue ? h('span', { class: 'tag', title: 'Serves none of your goals in this league, so it only shows up because it wins decisively' }, 'Pure value') : '',
      r.theirGoal ? h('span', { class: 'tag good', title: "Why it makes sense for them" }, r.theirGoal) : '',
      r.type && r.type.id !== 'other' ? h('span', { class: 'tag', title: r.type.tip }, r.type.label) : ''),
    h('div', { class: 'small', style: { marginBottom: '8px' } },
      h('span', { class: (r.value?.tat ?? r.tatGain) >= 0 ? 'pos' : 'neg', title: "Sanderson value after this season (market value minus the production the players will use up this year). This season's production is counted in the next number instead." }, `Long-term ${f1(r.L, r.value?.tat ?? r.tatGain)}`), r.value?.dr < 0.99 ? h('span', { class: 'muted', title: "You're already well ahead of this league in value, so more of it adds little title equity" }, ` (of ${f1(r.L, r.value.tatRaw)}, diminishing returns)`) : '', ' + ',
      h('span', { class: (r.value?.now ?? 0) >= 0 ? 'pos' : 'neg' }, `this season ${f1(r.L, r.value?.now ?? 0)}`),
      r.sim ? h('span', { class: 'muted' }, ` (title ${Math.round(r.sim.me[0].title * 100)}% → ${Math.round(r.sim.me[1].title * 100)}%` + (Math.abs(r.dBye || 0) >= 0.03 ? `, bye ${Math.round(r.sim.me[0].bye * 100)}% → ${Math.round(r.sim.me[1].bye * 100)}%` : '') + (Math.abs(r.value?.pickShift || 0) >= 50 ? `, draft slot ${f1(r.L, r.value.pickShift)}` : '') + ')') : ''),
    h('div', { class: 'small muted' }, 'You send'), h('div', { class: 'assets' }, r.give.map(a => assetLine(a))),
    h('div', { class: 'small muted', style: { marginTop: '6px' } }, 'You get'), h('div', { class: 'assets' }, r.get.map(a => assetLine(a))),
    h('div', { class: 'small', style: { marginTop: '8px' } },
      `FC ${r.partner.owner} ${sgn(r.fc.partnerMargin)}`, r.me ? ` · your pts/wk ${sgn(r.me.rosAfter - r.me.rosBefore, 1)} now, ${sgn(r.me.poAfter - r.me.poBefore, 1)} playoffs` : '',
      r.them ? ` · theirs ${sgn(r.them.rosAfter - r.them.rosBefore, 1)}` : ''),
    h('div', { class: 'small muted', style: { marginTop: '4px' } }, h('b', {}, r.mixLabel), ` · picks ${sgn(r.mix.picks)}, this season ${sgn(r.mix.now)}, future years ${sgn(r.mix.future)}`),
    r.flags.filter(f => f.warn).map(f => h('div', { class: 'small warn' }, '⚠️ ' + f.msg)),
    r.pAccept != null ? h('div', { class: 'small', style: { cursor: 'pointer' }, title: reasons(r.acceptF).join('\n'), onclick: () => toast(reasons(r.acceptF).join(' · ')) },
      h('b', {}, `~${Math.round(r.pAccept * 100)}% he accepts`), h('span', { class: 'muted' }, ' · ' + (reasons(r.acceptF)[0] || ''))) : '',
    r.calcPref ? h('div', { class: 'small pos' }, `Fair for ${r.partner.owner} on ${({ ktc: 'KeepTradeCut', dp: 'DynastyProcess', fp: 'FantasyPros' })[r.calcPref]}, the calculator he trades by` + (r.sweetened?.length ? `: sweetened with ${r.sweetened.join(' + ')}` : '') + '.') : '',
    r.flags.filter(f => f.info).map(f => h('div', { class: 'small muted' }, f.msg)),
    r.memory.overlap.length ? h('div', { class: 'small warn' }, `Asked for ${r.memory.overlap[0].getNames.join(' + ')} before: ${r.memory.overlap[0].status}`) : '',
    h('div', { class: 'row', style: { marginTop: '8px' } },
      h('button', { class: 'btn ghost small', onclick: () => { const box = document.getElementById('app'); box.replaceChildren(h('div', {}, h('a', { href: `#/trades/${r.L.id}` }, '← back'), calculator(r.L, r.partner.rid, { give: r.giveKeys, get: r.getKeys }))); } }, 'Open in calculator'),
      h('button', { class: 'btn small', onclick: e => { logTrade(toLog(r)); e.target.textContent = 'Logged ✓'; e.target.disabled = true; } }, 'Log as sent')));
}

// ---------------- log ----------------
// after a no: why? One tap sets the matching filter on his owner card, so suggestions stop offering the same thing
function whyRow(t, redraw) {
  if (!['rejected', 'countered', 'ignored'].includes(t.status) || !t.partnerOwnerId) return null;
  const raw = rawRules(t.partnerOwnerId), P = raw.players || {}, G = raw.leagues?.[t.leagueId] || {};
  const month = () => ({ durKey: '30', until: Date.now() + 30 * 864e5 });
  const nick = t.leagueNick || leagueById(t.leagueId)?.nick || 'this league';
  const setP = ids => { setRules(t.partnerOwnerId, { ...raw, players: { ...month(), ...P, noPlayers: ids } }); };
  const setK = ids => { setRules(t.partnerOwnerId, { ...raw, players: { ...month(), ...P, keepPlayers: ids } }); };
  const setG = patch => { setRules(t.partnerOwnerId, { ...raw, leagues: { ...(raw.leagues || {}), [t.leagueId]: { ...month(), ...G, ...patch } } }); };
  const chip = (on, label, fn) => h('button', { class: 'tag' + (on ? ' push' : ''), style: { cursor: 'pointer', marginRight: '6px', marginBottom: '4px' }, onclick: () => { fn(!on); const why = new Set(t.why || []); on ? why.delete(label) : why.add(label); updateTrade(t.id, { why: [...why] }); redraw(); } }, (on ? '✓ ' : '') + label);
  const np = P.noPlayers || [];
  const players = (t.give || []).filter(k => k.startsWith('p:')).map(k => k.slice(2));
  const kp = P.keepPlayers || [], his = (t.get || []).filter(k => k.startsWith('p:')).map(k => k.slice(2));
  return h('tr', {}, h('td', { colspan: 10, style: { paddingTop: 0, whiteSpace: 'normal' } }, h('span', { class: 'small muted', style: { marginRight: '6px' } }, 'Why?'),
    ...players.map((id, i) => chip(np.includes(id), `Not interested in ${t.giveNames[(t.give || []).indexOf('p:' + id)] || M.players[id]?.full_name || id}`, on => setP(on ? [...new Set([...np, id])] : np.filter(x => x !== id)))),
    ...his.map(id => chip(kp.includes(id), `Won’t trade ${t.getNames[(t.get || []).indexOf('p:' + id)] || M.players[id]?.full_name || id} away`, on => setK(on ? [...new Set([...kp, id])] : kp.filter(x => x !== id)))),
    chip(!!G.noFirsts, `Won’t trade his 1sts in ${nick}`, on => setG({ noFirsts: on })),
    chip(!!G.noPicks, `Won’t trade any picks in ${nick}`, on => setG({ noPicks: on })),
    chip(!!G.paused, `Not trading in ${nick} right now`, on => setG({ paused: on })),
    h('span', { class: 'small muted' }, ' (sets his filters for a month; change them on his owner card)')));
}

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
        h('tbody', {}, rows.flatMap(t => [h('tr', {},
          h('td', {}, new Date(t.created).toLocaleDateString()), h('td', {}, t.leagueNick || leagueById(t.leagueId)?.nick || ''), h('td', {}, t.partnerName),
          h('td', { style: { whiteSpace: 'normal', minWidth: '140px' } }, t.giveNames.join(' + ')), h('td', { style: { whiteSpace: 'normal', minWidth: '140px' } }, t.getNames.join(' + ')),
          h('td', { class: 'n ' + (t.tatGain >= 0 ? 'pos' : 'neg') }, sgn(t.tatGain)), h('td', { class: 'n' }, sgn(t.fcMargin)),
          h('td', {}, h('select', { onchange: e => { updateTrade(t.id, { status: e.target.value }); draw(); } }, STATUSES.map(s => h('option', { selected: s === t.status }, s))), t.auto ? h('span', { class: 'muted small' }, ' auto') : ''),
          h('td', {}, h('input', { value: t.notes || '', placeholder: 'note', onchange: e => updateTrade(t.id, { notes: e.target.value }) })),
          h('td', {}, h('button', { class: 'btn ghost small', onclick: () => { if (confirm('Delete this log entry?')) { deleteTrade(t.id); draw(); } } }, '✕'))),
          whyRow(t, draw)].filter(Boolean))))) : empty('No trades logged yet. Use "Log as sent" in the calculator or on a suggestion.'));
  };
  draw();
  // older entries: add how each offer looked on each calculator (today's values), so past answers count too
  loadCalcs().then(c => {
    M.calcs ||= c;
    for (const t of S.trades) {
      if (t.calcEdges || !t.give?.length) continue;
      const L = leagueById(t.leagueId); if (!L) continue;
      try {
        const give = t.give.map(k => asset(L, k)), get = t.get.map(k => asset(L, k)), ce = {};
        for (const k of ['ktc', 'fc', 'dp', 'fp']) { const e = calcEdge(L, give, get, k); if (Number.isFinite(e) && (k === 'fc' || M.calcs?.[k])) ce[k] = +e.toFixed(3); }
        updateTrade(t.id, { calcEdges: ce });
      } catch {}
    }
  });
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
