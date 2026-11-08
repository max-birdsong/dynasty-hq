import { M, leagueById } from '../model.js';
import { state, noteOf, setNote, rulesOf, rawRules, setRules } from '../state.js';
import { profiles, pickIndex } from '../owners.js';
import { h, fmt, sgn, f1, toast } from '../util.js';
import { loadAffinity, portfolio, tendencies, behaviour } from '../affinity.js';
import { modeTag, posB, empty, table } from '../components.js';

export default async function ownersView(id, ownerId) {
  if (!id) { const f = M.leagues.find(L => L.me); if (f) { location.replace('#/owners/' + f.id); return h('div'); } return empty('No leagues.'); }
  const L = leagueById(id);
  const root = h('div');
  root.append(h('div', { class: 'row', style: { marginBottom: '10px', gap: '6px' } },
    M.leagues.filter(x => x.me).map(x => h('a', { href: `#/owners/${x.id}`, class: 'tag' + (x.id === id ? ' push' : '') }, x.nick))));
  if (!L) return root;
  const P = await profiles(L);
  await Promise.race([loadAffinity(), new Promise(r => setTimeout(r, 6000))]).catch(() => {});
  const pi = await pickIndex(L).catch(() => null);
  if (pi?.index) root.append(h('div', { class: 'panel' }, h('h2', {}, 'How this league prices picks'),
    h('p', { class: 'small', style: { margin: 0 } }, pi.index ? `In ${pi.n} trades of picks for players, the players sent back were worth ${Math.round(pi.index * 100)}% of the picks' market value at the time. ${pi.index > 1.1 ? 'Picks fetch a premium here: a good league to sell picks in.' : pi.index < 0.9 ? 'Picks go cheap here: a good league to buy picks in.' : 'Picks trade close to market here.'} Suggestions use this when pricing picks.` : `Only ${pi.n} pick-for-player trades so far, not enough to tell how this league prices picks.`)));
  // league-wide trade record leaderboard
  const recStr = r => r && r.n ? `${r.w}-${r.l}${r.e ? '-' + r.e : ''}` : '–';
  const pctStr = r => r && r.n ? ` (${Math.round(r.pct * 100)}%)` : '';
  const avgCell = r => r && r.n ? h('span', { class: r.avg >= 0 ? 'pos' : 'neg' }, sgn(r.avg)) : '–';
  const lb = P.filter(p => p.trades.length).map(p => ({ owner: p.team.owner, isMe: p.team.isMe, n: p.trades.length, then: p.fcThenRec, now: p.fcRecNow, tat: p.tatRec, tatThen: p.tatThenRec, style: p.style, oid: p.team.ownerId }));
  if (lb.length >= 3) root.append(h('div', { class: 'panel' }, h('h2', {}, 'Who wins their trades?'),
    h('div', { class: 'muted small', style: { marginBottom: '8px' } }, "Every completed trade this season and last. \"At the time\" uses market values from the week of the trade (DynastyProcess weekly history, put on the FantasyCalc scale), so later injuries and breakouts don't count. \"Today\" is hindsight. W-L-E = won / lost / even (within 5% of the deal); avg = value gained per trade."),
    table([
      { key: 'owner', label: 'Owner', n: false, fmt: (v, r) => r.isMe ? h('b', {}, v) : h('a', { href: `#/owners/${L.id}/${r.oid}` }, v) },
      { key: 'n', label: 'Trades', n: true },
      { key: 'tp', label: 'Market at the time', n: true, sort: r => r.then?.pct, fmt: (v, r) => recStr(r.then) + pctStr(r.then) },
      { key: 'ta', label: 'avg', n: true, sort: r => r.then?.avg, fmt: (v, r) => avgCell(r.then) },
      { key: 'np', label: 'FC today', n: true, sort: r => r.now?.pct, fmt: (v, r) => recStr(r.now) + pctStr(r.now) },
      { key: 'tatp', label: 'TAT today', n: true, sort: r => r.tat?.pct, fmt: (v, r) => recStr(r.tat) + pctStr(r.tat) },
      { key: 'tata', label: 'avg', n: true, sort: r => r.tat?.avg, fmt: (v, r) => avgCell(r.tat) },
      { key: 'ttp', label: 'TAT at the time', n: true, sort: r => r.tatThen?.pct, title: 'Only trades made after your first TAT upload', fmt: (v, r) => recStr(r.tatThen) + pctStr(r.tatThen) },
      { key: 'style', label: 'Style', n: false, fmt: v => v ? h('span', { class: 'tag' + (v === 'Easy mark' ? ' good' : v === 'Shark' ? ' bad' : '') }, v) : h('span', { class: 'muted small' }, 'too few trades') },
    ], lb, { sortKey: 'ta', rowClass: r => r.isMe ? 'me' : '' })));
  const S = state();
  const cards = h('div', { class: 'cards' });
  const order = [...P].sort((a, b) => (b.team.ownerId === ownerId) - (a.team.ownerId === ownerId) || (a.team.isMe - b.team.isMe) || b.trades.length - a.trades.length);
  for (const p of order) cards.append(card(L, p, S));
  root.append(cards);
  if (ownerId) setTimeout(() => document.getElementById('o-' + ownerId)?.scrollIntoView({ behavior: 'smooth' }), 50);
  return root;
}

// what he told you, as filters suggestions respect: players (him, everywhere) and picks / pause (this league)
function rulesBox(L, t) {
  const box = h('div', { class: 'small', style: { marginTop: '6px' } });
  const DUR = [['14', '2 weeks'], ['30', '1 month'], ['0', 'until I remove it']];
  const draw = () => {
    const raw = rawRules(t.ownerId), P = raw.players || {}, G = raw.leagues?.[L.id] || {};
    const save = (part, patch) => {
      const cur = part === 'players' ? P : G;
      const n = { durKey: '30', until: Date.now() + 30 * 864e5, ...cur, ...patch };
      setRules(t.ownerId, part === 'players' ? { ...raw, players: n } : { ...raw, leagues: { ...(raw.leagues || {}), [L.id]: n } });
      draw();
    };
    const dur = part => { const cur = part === 'players' ? P : G; return h('select', { onchange: e => { const d = +e.target.value; save(part, { durKey: e.target.value, until: d ? Date.now() + d * 864e5 : null }); } },
      DUR.map(([v, l]) => h('option', { value: v, selected: (cur.durKey || '30') === v }, l))); };
    const expired = x => x.until && Date.now() > x.until;
    const mine = L.me.players.map(String).filter(id => M.players[id]).map(id => ({ id, label: M.players[id].full_name }));
    const dl = h('datalist', { id: 'np-' + t.ownerId }, mine.map(x => h('option', { value: x.label })));
    const np = expired(P) ? [] : (P.noPlayers || []);
    box.replaceChildren(
      h('div', { class: 'muted', style: { marginBottom: '4px' } }, 'What he told you (suggestions follow these):'),
      h('div', { class: 'row', style: { gap: '4px', flexWrap: 'wrap', alignItems: 'center' } }, h('b', {}, 'Not interested in'), ' (any league): ',
        ...np.map(id => h('span', { class: 'tag' }, M.players[id]?.full_name || id, ' ', h('a', { href: 'javascript:void 0', onclick: () => save('players', { noPlayers: np.filter(x => x !== id) }) }, '×'))),
        h('input', { list: 'np-' + t.ownerId, placeholder: 'one of your players…', style: { width: '170px' }, onchange: e => { const x = mine.find(m => m.label === e.target.value); if (x) save('players', { noPlayers: [...new Set([...np, x.id])] }); } }), dl,
        np.length ? h('span', {}, ' for ', dur('players')) : ''),
      h('div', { class: 'row', style: { gap: '12px', marginTop: '4px', flexWrap: 'wrap', alignItems: 'center' } }, h('b', {}, `In ${L.nick}:`),
        ...[['noFirsts', 'won’t trade his 1sts'], ['noPicks', 'won’t trade any of his picks'], ['paused', 'not trading right now']].map(([k, l]) =>
          h('label', {}, h('input', { type: 'checkbox', checked: !expired(G) && !!G[k], onchange: e => save('league', { [k]: e.target.checked }) }), ' ' + l)),
        (G.noFirsts || G.noPicks || G.paused) && !expired(G) ? h('span', {}, 'for ', dur('league')) : ''));
  };
  draw();
  return box;
}

// across every league you share with this owner: who he owns a lot of, buys and sells
function portfolioLine(t) {
  if (t.isMe) return '';
  const pf = portfolio(t.ownerId), td = tendencies(t.ownerId), bh = behaviour(t.ownerId);
  if ((!pf || (!pf.core.length && !pf.buying.length && !pf.selling.length)) && !td.length && !bh.length) return '';
  const nmS = r => r.name.split(' ').slice(-1)[0];
  return h('div', { class: 'small', style: { marginTop: '6px' } },
    bh.length || td.length ? h('div', { class: 'row', style: { gap: '4px', marginBottom: '4px' } },
      bh.map(x => h('span', { class: 'tag ' + (x.kind === 'bad' ? 'bad' : x.kind === 'good' ? 'push' : ''), title: x.why, style: { cursor: 'pointer' }, onclick: () => toast(x.why) }, x.label)),
      td.map(x => h('span', { class: 'tag ' + (x.v > 0 ? 'push' : 'tank'), title: x.detail, style: { cursor: 'pointer' }, onclick: () => toast(`${x.label}: ${x.detail}`) }, x.label))) : '',
    !pf ? '' : pf.core.length ? h('div', {}, h('b', {}, pf.all ? `Owns a lot of (all ${pf.n} of his leagues): ` : 'Owns a lot of: '), pf.core.map(r => `${nmS(r)} ${pf.all ? r.label : '×' + r.own}`).join(', '), pf.all ? h('span', { class: 'muted', title: 'd = drafted, t = traded for, w = waivers, −n = traded away' }, ' · d drafted, t traded for, w waivers, − traded away') : '') : '',
    !pf ? '' : pf.buying.length ? h('div', {}, h('b', { class: 'pos' }, 'Buying lately: '), pf.buying.map(nmS).join(', ')) : '',
    !pf ? '' : pf.selling.length ? h('div', {}, h('b', { class: 'neg' }, 'Selling lately: '), pf.selling.map(nmS).join(', ')) : '');
}

function card(L, p, S) {
  const t = p.team;
  const myOffers = S.trades.filter(x => x.leagueId === L.id && x.partnerOwnerId === t.ownerId);
  const others = M.leagues.filter(x => x.id !== L.id && x.teams.some(tt => tt.ownerId === t.ownerId));
  const notes = h('textarea', { placeholder: 'Notes on this owner (shared across leagues)…', oninput: e => { clearTimeout(notes._t); notes._t = setTimeout(() => setNote(t.ownerId, e.target.value), 800); } });
  notes.value = noteOf(t.ownerId);
  const rk = p.ranks;
  const hasNote = !!noteOf(t.ownerId);
  const noteBox = h('div', { style: { marginTop: '6px', display: hasNote || rulesOf(t.ownerId, L.id) ? '' : 'none' } }, notes, t.isMe ? '' : rulesBox(L, t));
  const more = [
    h('div', { class: 'small', style: { marginBottom: '6px' } },
      h('b', {}, 'Pick capital: '), `${p.own} picks (default ${p.def}) · `, Object.entries(p.byRound).map(([r, n]) => `R${r}×${n}`).join(' '),
      h('div', { class: 'muted' }, `In trades: got ${p.picksIn} picks, sent ${p.picksOut}`)),
    p.trades.length ? h('div', { class: 'small', style: { marginBottom: '6px' } },
      h('div', { class: 'muted' }, `Record: market at the time ${p.fcThenRec.n ? `${p.fcThenRec.w}-${p.fcThenRec.l}-${p.fcThenRec.e}` : '–'} · FC today ${p.fcRecNow.w}-${p.fcRecNow.l}-${p.fcRecNow.e} · Sanderson today ${p.tatRec.w}-${p.tatRec.l}-${p.tatRec.e} (won-lost-even)`),
      p.aIn ? h('div', { class: 'muted' }, `Avg age acquired ${fmt(p.aIn, 1)} vs sent ${fmt(p.aOut, 1)}`) : '',
      Object.keys(p.posOut).length ? h('div', { class: 'muted' }, 'Sent away: ' + Object.entries(p.posOut).map(([k, v]) => `${v} ${k}`).join(', ') + ' · Got: ' + Object.entries(p.posIn).map(([k, v]) => `${v} ${k}`).join(', ')) : '',
      h('div', { class: 'assets', style: { marginTop: '6px' } }, p.trades.slice(0, 12).map(x => h('div', { style: { borderTop: '1px solid var(--line)', padding: '6px 0' } },
        h('div', { class: 'muted small' }, `${x.date.toLocaleDateString()} · with ${x.others.map(o => L.teams.find(tt => tt.ownerId === o.ownerId)?.owner || 'former owner').join(', ')}`,
          x.me.fcNetThen != null ? [' · at the time ', h('span', { class: x.me.fcNetThen >= 0 ? 'pos' : 'neg' }, sgn(x.me.fcNetThen))] : '', ' · today ', h('span', { class: x.me.fcNet >= 0 ? 'pos' : 'neg' }, sgn(x.me.fcNet))),
        h('div', { class: 'small' }, h('span', { class: 'pos' }, 'Got '), x.me.got.map(a => h('span', { style: { marginRight: '6px' } }, posB(a.pos), a.name))),
        h('div', { class: 'small' }, h('span', { class: 'neg' }, 'Gave '), x.me.gave.map(a => h('span', { style: { marginRight: '6px' } }, posB(a.pos), a.name))))))) : '',
    myOffers.length ? h('div', { class: 'small', style: { marginTop: '6px' } }, h('b', {}, 'Your offers to them'),
      myOffers.slice(0, 6).map(o => h('div', { class: 'muted' }, `${new Date(o.created).toLocaleDateString()} · ${o.giveNames.join(' + ')} for ${o.getNames.join(' + ')} → `, h('span', { class: o.status === 'accepted' ? 'pos' : o.status === 'sent' ? '' : 'neg' }, o.status)))) : '',
    others.length ? h('div', { class: 'small muted', style: { marginTop: '6px' } }, 'Also in: ', others.map(x => h('a', { href: `#/owners/${x.id}/${t.ownerId}`, style: { marginRight: '6px' } }, x.nick))) : '',
  ];
  return h('div', { class: 'card' + (t.isMe ? ' me' : ''), id: 'o-' + t.ownerId },
    h('div', { class: 'row spread' }, h('div', {}, h('h2', { style: { margin: 0 } }, t.owner), h('div', { class: 'muted small' }, `${t.wins}-${t.losses} · playoff ${Math.round((t.playoff || 0) * 100)}% · core age ${fmt(t.coreAge, 1)}`)), modeTag(t.mode)),
    h('div', { class: 'row', style: { margin: '8px 0', gap: '4px' } },
      ['QB', 'RB', 'WR', 'TE'].map(k => h('span', { class: 'pill', title: `${k} starters rank ${rk[k]} of ${L.teams.length}`, style: { color: p.needs.includes(k) ? 'var(--neg)' : p.surplus.includes(k) ? 'var(--pos)' : '' } }, `${k} ${rk[k]}`)),
      p.tags.map(x => h('span', { class: 'tag' }, x))),
    h('div', { class: 'small' }, p.needs.length ? h('span', {}, h('b', {}, 'Needs '), p.needs.join(', ')) : '', p.needs.length && p.surplus.length ? ' · ' : '', p.surplus.length ? h('span', {}, h('b', {}, 'Deep at '), p.surplus.join(', ')) : '',
      p.trades.length ? h('div', {}, `${p.trades.length} trade${p.trades.length > 1 ? 's' : ''} · net `, h('span', { class: p.fcNet >= 0 ? 'pos' : 'neg' }, f1(L, p.fcNet)), ' on FC') : h('div', { class: 'muted' }, 'No trades yet')),
    portfolioLine(t),
    h('details', { style: { marginTop: '6px' } }, h('summary', { class: 'small muted' }, 'Details'), more),
    t.isMe ? '' : h('div', { class: 'row', style: { marginTop: '8px', gap: '6px' } },
      h('a', { class: 'btn small', href: `#/trades/${L.id}/${t.rid}` }, 'Build a trade'),
      hasNote || rulesOf(t.ownerId, L.id) ? '' : h('button', { class: 'btn ghost small', onclick: e => { noteBox.style.display = ''; e.target.remove(); notes.focus(); } }, 'Add note / filters')),
    t.isMe ? '' : noteBox);
}
