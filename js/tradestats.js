// Trade log stats: how your offers fare, how you answer theirs, who you trade with and how fast they reply.
import { h } from './util.js';

const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const dur = hrs => hrs == null ? '–' : hrs < 1 ? `${Math.max(1, Math.round(hrs * 60))} min` : hrs < 48 ? `${hrs < 10 ? hrs.toFixed(1) : Math.round(hrs)} h` : `${Math.round(hrs / 24)} d`;
const answered = t => ['accepted', 'rejected', 'countered'].includes(t.status) && t.statusAt;
const respHrs = t => (t.statusAt - t.created) / 3600000;

function bar(parts, total) {
  return h('div', { style: { display: 'flex', height: '8px', borderRadius: '4px', overflow: 'hidden', margin: '6px 0 4px', background: 'var(--line, #e5e5e5)' } },
    parts.filter(p => p.n).map(p => h('i', { title: `${p.label}: ${p.n}`, style: { width: (p.n / total * 100) + '%', background: p.color } })));
}
function block(title, rows, note) {
  const total = rows.reduce((s, r) => s + r.n, 0);
  return h('div', {},
    h('div', { class: 'row spread' }, h('b', {}, title), h('span', { class: 'muted small' }, `${total} offers`)),
    bar(rows, total || 1),
    h('div', { class: 'small', style: { display: 'flex', flexWrap: 'wrap', gap: '4px 12px' } }, rows.filter(r => r.n).map(r =>
      h('span', {}, h('i', { style: { display: 'inline-block', width: '8px', height: '8px', borderRadius: '2px', background: r.color, marginRight: '4px' } }), `${r.label} ${r.n} (${Math.round(r.n / (total || 1) * 100)}%)`))),
    note ? h('div', { class: 'muted small', style: { marginTop: '4px' } }, note) : '');
}

export function tradeStats(trades) {
  const mine = trades.filter(t => t.dir !== 'in'), theirs = trades.filter(t => t.dir === 'in');
  if (!trades.length) return '';
  const c = (L, s) => L.filter(t => t.status === s).length;
  const G = '#2fa36b', B = '#2f7dd1', R = '#d1562f', Y = '#d1a12f', N = '#9a9a9a';
  const mineAns = c(mine, 'accepted') + c(mine, 'rejected') + c(mine, 'countered');
  const myResp = median(theirs.filter(answered).map(respHrs)), theirResp = median(mine.filter(answered).map(respHrs));

  // partners, by owner across leagues
  const P = new Map();
  for (const t of trades) {
    const k = t.partnerOwnerId || t.partnerName; if (!k) continue;
    const p = P.get(k) || { name: (t.partnerName || '').replace(/ \+\d+$/, ''), n: 0, deals: 0, leagues: new Set(), resp: [], sentToHim: 0, accByHim: 0, expired: 0, answered: 0 };
    p.n++; p.leagues.add(t.leagueNick);
    if (t.status === 'accepted') p.deals++;
    if (t.dir !== 'in') { p.sentToHim++; if (t.status === 'accepted') p.accByHim++; if (t.status === 'ignored') p.expired++; if (answered(t)) { p.answered++; p.resp.push(respHrs(t)); } }
    P.set(k, p);
  }
  const ps = [...P.values()];
  const top = [...ps].sort((a, b) => b.n - a.n || b.deals - a.deals).slice(0, 8);
  const fast = ps.filter(p => p.resp.length >= 4).map(p => ({ ...p, med: median(p.resp) })).sort((a, b) => a.med - b.med);
  const ghosts = ps.filter(p => p.expired >= 2 && p.expired >= p.answered * 2).sort((a, b) => b.expired - a.expired).slice(0, 6);

  const tbl = h('table', {}, h('thead', {}, h('tr', {}, ['Partner', 'Offers', 'Deals', 'Your offers accepted', 'Replies in', 'Leagues'].map((x, i) => h('th', { class: i && i < 4 ? 'n' : '' }, x)))),
    h('tbody', {}, top.map(p => h('tr', {}, h('td', {}, p.name), h('td', { class: 'n' }, p.n), h('td', { class: 'n' }, p.deals),
      h('td', { class: 'n' }, p.sentToHim ? `${p.accByHim} of ${p.sentToHim}` : '–'), h('td', {}, dur(median(p.resp))), h('td', { class: 'small muted' }, [...p.leagues].join(', '))))));

  return h('div', { class: 'panel' },
    h('h3', {}, 'Trade stats'),
    h('div', { class: 'grid g2', style: { gap: '16px' } },
      block('Your offers', [
        { label: 'accepted', n: c(mine, 'accepted'), color: G }, { label: 'countered', n: c(mine, 'countered'), color: B },
        { label: 'rejected', n: c(mine, 'rejected'), color: R }, { label: 'expired', n: c(mine, 'ignored'), color: Y },
        { label: 'withdrawn', n: c(mine, 'withdrawn'), color: N }, { label: 'open', n: c(mine, 'sent'), color: '#6b7a2f' }],
        mineAns ? `Of the ${mineAns} that got an answer, ${Math.round(c(mine, 'accepted') / mineAns * 100)}% were accepted and ${Math.round(c(mine, 'countered') / mineAns * 100)}% countered. Partners reply in ${dur(theirResp)} (median).` : ''),
      block('Offers to you', [
        { label: 'accepted', n: c(theirs, 'accepted'), color: G }, { label: 'countered', n: c(theirs, 'countered'), color: B },
        { label: 'rejected', n: c(theirs, 'rejected'), color: R }, { label: 'expired', n: c(theirs, 'ignored'), color: Y },
        { label: 'withdrawn by them', n: c(theirs, 'withdrawn'), color: N }, { label: 'open', n: c(theirs, 'received'), color: '#6b7a2f' }],
        myResp != null ? `You reply in ${dur(myResp)} (median).` : '')),
    h('h3', { style: { marginTop: '16px' } }, 'Top trading partners'),
    h('div', { class: 'tablewrap' }, tbl),
    h('div', { class: 'grid g2', style: { gap: '16px', marginTop: '12px' } },
      h('div', {}, h('b', {}, 'Reply speed'), h('div', { class: 'muted small' }, 'Median time to accept, reject or counter your offers (4+ answers)'),
        fast.length ? h('div', { class: 'small', style: { marginTop: '4px' } },
          h('div', {}, 'Fastest: ', fast.slice(0, 3).map(p => `${p.name} (${dur(p.med)})`).join(', ')),
          fast.length > 3 ? h('div', {}, 'Slowest: ', fast.slice(-3).reverse().map(p => `${p.name} (${dur(p.med)})`).join(', ')) : '') : h('div', { class: 'muted small' }, 'Not enough answers yet.')),
      h('div', {}, h('b', {}, 'Let your offers expire'), h('div', { class: 'muted small' }, 'Offers to them are mostly wasted'),
        ghosts.length ? h('div', { class: 'small', style: { marginTop: '4px' } }, ghosts.map(p => `${p.name} (${p.expired} of ${p.sentToHim})`).join(', ')) : h('div', { class: 'muted small' }, 'Nobody yet.'))));
}
