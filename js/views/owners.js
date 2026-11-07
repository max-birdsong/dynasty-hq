import { M, leagueById } from '../model.js';
import { state, noteOf, setNote } from '../state.js';
import { profiles } from '../owners.js';
import { h, fmt, sgn } from '../util.js';
import { modeTag, posB, empty, table } from '../components.js';

export default async function ownersView(id, ownerId) {
  if (!id) { const f = M.leagues.find(L => L.me); if (f) { location.replace('#/owners/' + f.id); return h('div'); } return empty('No leagues.'); }
  const L = leagueById(id);
  const root = h('div');
  root.append(h('div', { class: 'row', style: { marginBottom: '10px', gap: '6px' } },
    M.leagues.filter(x => x.me).map(x => h('a', { href: `#/owners/${x.id}`, class: 'tag' + (x.id === id ? ' push' : '') }, x.nick))));
  if (!L) return root;
  const P = await profiles(L);
  // league-wide trade record leaderboard
  const recStr = r => r.n ? `${r.w}-${r.l}${r.e ? '-' + r.e : ''}` : '–';
  const lb = P.filter(p => p.trades.length).map(p => ({ owner: p.team.owner, isMe: p.team.isMe, n: p.trades.length, fc: p.fcRec, tat: p.tatRec, style: p.style, oid: p.team.ownerId }));
  if (lb.length) root.append(h('div', { class: 'panel' }, h('h2', {}, 'Who wins their trades?'),
    h('div', { class: 'muted small', style: { marginBottom: '8px' } }, "Every completed trade this season and last, judged at today's values. W-L-E = won / lost / even (within 5% of the deal). Avg = value gained per trade."),
    table([
      { key: 'owner', label: 'Owner', n: false, fmt: (v, r) => r.isMe ? h('b', {}, v) : h('a', { href: `#/owners/${L.id}/${r.oid}` }, v) },
      { key: 'n', label: 'Trades', n: true },
      { key: 'fcp', label: 'FC record', n: true, sort: r => r.fc.pct, fmt: (v, r) => `${recStr(r.fc)} (${Math.round(r.fc.pct * 100)}%)` },
      { key: 'fca', label: 'FC avg', n: true, sort: r => r.fc.avg, fmt: (v, r) => h('span', { class: r.fc.avg >= 0 ? 'pos' : 'neg' }, sgn(r.fc.avg)) },
      { key: 'tatp', label: 'TAT record', n: true, sort: r => r.tat.pct, fmt: (v, r) => `${recStr(r.tat)} (${Math.round(r.tat.pct * 100)}%)` },
      { key: 'tata', label: 'TAT avg', n: true, sort: r => r.tat.avg, fmt: (v, r) => h('span', { class: r.tat.avg >= 0 ? 'pos' : 'neg' }, sgn(r.tat.avg)) },
      { key: 'style', label: 'Style', n: false, fmt: v => v ? h('span', { class: 'tag' + (v === 'Easy mark' ? ' good' : v === 'Shark' ? ' bad' : '') }, v) : h('span', { class: 'muted small' }, 'too few trades') },
    ], lb, { sortKey: 'tata', rowClass: r => r.isMe ? 'me' : '' })));
  const S = state();
  root.append(h('div', { class: 'muted small', style: { marginBottom: '10px' } },
    `${L.trades.length} completed trades this season and last. Values shown are today's FantasyCalc / Sanderson values, so "net" means who has won their trades so far.`));
  const cards = h('div', { class: 'cards' });
  const order = [...P].sort((a, b) => (b.team.ownerId === ownerId) - (a.team.ownerId === ownerId) || (a.team.isMe - b.team.isMe) || b.trades.length - a.trades.length);
  for (const p of order) cards.append(card(L, p, S));
  root.append(cards);
  if (ownerId) setTimeout(() => document.getElementById('o-' + ownerId)?.scrollIntoView({ behavior: 'smooth' }), 50);
  return root;
}

function card(L, p, S) {
  const t = p.team;
  const myOffers = S.trades.filter(x => x.leagueId === L.id && x.partnerOwnerId === t.ownerId);
  const others = M.leagues.filter(x => x.id !== L.id && x.teams.some(tt => tt.ownerId === t.ownerId));
  const notes = h('textarea', { placeholder: 'Notes on this owner (shared across leagues)…', oninput: e => { clearTimeout(notes._t); notes._t = setTimeout(() => setNote(t.ownerId, e.target.value), 800); } });
  notes.value = noteOf(t.ownerId);
  const rk = p.ranks;
  return h('div', { class: 'card' + (t.isMe ? ' me' : ''), id: 'o-' + t.ownerId },
    h('div', { class: 'row spread' }, h('div', {}, h('h2', { style: { margin: 0 } }, t.owner), h('div', { class: 'muted small' }, `${t.wins}-${t.losses} · PF #${t.fptsRank} · playoff ${Math.round((t.playoff || 0) * 100)}% · core age ${fmt(t.coreAge, 1)}`)), modeTag(t.mode)),
    h('div', { class: 'row', style: { margin: '8px 0', gap: '6px' } }, p.tags.map(x => h('span', { class: 'tag' }, x))),
    h('div', { class: 'small', style: { marginBottom: '6px' } },
      h('b', {}, 'Position rank (starters FC): '), ['QB', 'RB', 'WR', 'TE'].map(k => h('span', { class: 'pill', style: { marginRight: '4px', color: p.needs.includes(k) ? 'var(--neg)' : p.surplus.includes(k) ? 'var(--pos)' : '' } }, `${k} ${rk[k]}`)),
      p.needs.length ? h('div', { class: 'muted' }, 'Needs: ' + p.needs.join(', ') + (p.surplus.length ? ' · Strength: ' + p.surplus.join(', ') : '')) : p.surplus.length ? h('div', { class: 'muted' }, 'Strength: ' + p.surplus.join(', ')) : ''),
    h('div', { class: 'small', style: { marginBottom: '6px' } },
      h('b', {}, 'Pick capital: '), `${p.own} picks (default ${p.def}) · `, Object.entries(p.byRound).map(([r, n]) => `R${r}×${n}`).join(' '),
      h('div', { class: 'muted' }, `In trades: got ${p.picksIn} picks, sent ${p.picksOut}`)),
    h('div', { class: 'small', style: { marginBottom: '6px' } },
      h('b', {}, `Trades: ${p.trades.length}`), p.trades.length ? [' · net FC ', h('span', { class: p.fcNet >= 0 ? 'pos' : 'neg' }, sgn(p.fcNet)), ' · net TAT ', h('span', { class: p.tatNet >= 0 ? 'pos' : 'neg' }, sgn(p.tatNet))] : '',
      p.trades.length ? h('div', { class: 'muted' }, `Record on FC ${p.fcRec.w}-${p.fcRec.l}-${p.fcRec.e} · on Sanderson ${p.tatRec.w}-${p.tatRec.l}-${p.tatRec.e} (won-lost-even)`) : '',
      p.aIn ? h('div', { class: 'muted' }, `Avg age acquired ${fmt(p.aIn, 1)} vs sent ${fmt(p.aOut, 1)}`) : '',
      Object.keys(p.posOut).length ? h('div', { class: 'muted' }, 'Sent away: ' + Object.entries(p.posOut).map(([k, v]) => `${v} ${k}`).join(', ') + ' · Got: ' + Object.entries(p.posIn).map(([k, v]) => `${v} ${k}`).join(', ')) : ''),
    p.trades.length ? h('details', {}, h('summary', { class: 'small' }, 'Trade history'),
      h('div', { class: 'assets', style: { marginTop: '6px' } }, p.trades.slice(0, 12).map(x => h('div', { style: { borderTop: '1px solid var(--line)', padding: '6px 0' } },
        h('div', { class: 'muted small' }, `${x.date.toLocaleDateString()} · with ${x.others.map(o => L.teams.find(tt => tt.ownerId === o.ownerId)?.owner || 'former owner').join(', ')}`),
        h('div', { class: 'small' }, h('span', { class: 'pos' }, 'Got '), x.me.got.map(a => h('span', { style: { marginRight: '6px' } }, posB(a.pos), a.name))),
        h('div', { class: 'small' }, h('span', { class: 'neg' }, 'Gave '), x.me.gave.map(a => h('span', { style: { marginRight: '6px' } }, posB(a.pos), a.name))))))) : '',
    myOffers.length ? h('div', { class: 'small', style: { marginTop: '6px' } }, h('b', {}, 'Your offers to them'),
      myOffers.slice(0, 6).map(o => h('div', { class: 'muted' }, `${new Date(o.created).toLocaleDateString()} · ${o.giveNames.join(' + ')} for ${o.getNames.join(' + ')} → `, h('span', { class: o.status === 'accepted' ? 'pos' : o.status === 'sent' ? '' : 'neg' }, o.status)))) : '',
    others.length ? h('div', { class: 'small muted', style: { marginTop: '6px' } }, 'Also in: ', others.map(x => h('a', { href: `#/owners/${x.id}/${t.ownerId}`, style: { marginRight: '6px' } }, x.nick))) : '',
    t.isMe ? '' : h('div', { style: { marginTop: '8px' } }, notes,
      h('a', { class: 'btn small ghost', href: `#/trades/${L.id}/${t.rid}`, style: { marginTop: '6px', display: 'inline-block' } }, 'Build a trade with ' + t.owner)));
}
