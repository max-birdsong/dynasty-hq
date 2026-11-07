// Waiver farm: unrostered players worth a spot, across every league at once.
import { M, startersNow } from '../model.js';
import * as api from '../api.js';
import { scanLeague, indexTeams } from '../waiverscan.js';
import { h, f1, sleep } from '../util.js';
import { posB, empty } from '../components.js';

let filter = 'All';
export default function waiversView() {
  const root = h('div');
  const out = h('div', { class: 'loading' }, h('div', { class: 'spinner' }), 'Checking who is unrostered in each league…');
  root.append(h('div', { class: 'row spread', style: { marginBottom: '10px' } },
    h('div', {}, h('h1', {}, 'Waivers'), h('div', { class: 'muted small' }, 'Free agents worth a roster spot: injury openings, r/DynastyFF buzz, backup RBs and QBs, risers. Pick up, flip for a 3rd or 4th when someone needs them.'))),
    out);
  run(out);
  return root;
}

async function run(out) {
  const mine = M.leagues.filter(L => L.me);
  const tr = await api.trending().catch(() => []);
  const trending = new Map((Array.isArray(tr) ? tr : []).map(x => [String(x.player_id), x.count]));
  // Reddit can't be read from the browser; the hourly GitHub job saves who's being talked about
  const job = await fetch('data/waivers.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null);
  const env = { players: M.players, byTeamPos: indexTeams(M.players), trending, buzz: job?.buzz || {} };
  if (job?.updated) out.dataset.checked = new Date(job.updated).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const all = [];
  const faab = {};
  for (const L of mine) {
    await sleep(0);
    const ros = await api.rostersLive(L.id).catch(() => null);
    if (!ros) continue;
    const rostered = new Set(ros.flatMap(r => (r.players || []).map(String)));
    const me = ros.find(r => r.roster_id === L.me.rid) || {};
    const myIds = (me.players || []).map(String);
    const protect = new Set([...startersNow(L, myIds).starters, ...(me.reserve || []).map(String), ...(me.taxi || []).map(String)]);
    const budget = L.lg?.settings?.waiver_budget;
    if (budget && L.lg?.settings?.waiver_type === 2) faab[L.id] = budget - (me.settings?.waiver_budget_used || 0);
    all.push(...scanLeague({ id: L.id, nick: L.nick, ny: +L.season + 1, sf: L.fmt.numQbs === 2, rostered, mine: myIds, protect,
      fc: id => L.fc.byId.get(id), pick: n => L.fc.picks.get(n) }, env).map(r => ({ ...r, L })));
  }
  // one row per player, listing every league where he's available
  const by = new Map();
  for (const r of all) { const g = by.get(r.id) || by.set(r.id, { ...r, leagues: [] }).get(r.id); g.leagues.push(r); g.score = Math.max(g.score, r.score); if (r.v > g.v) { g.v = r.v; g.price = r.price; g.L = r.L; } }
  const rows = [...by.values()].sort((a, b) => b.score - a.score);
  const draw = () => {
    const shown = rows.filter(r => filter === 'All' || (filter === 'Injury openings' ? r.hurt : r.pos === filter)).slice(0, 60);
    out.className = '';
    out.replaceChildren(
      h('div', { class: 'row', style: { gap: '6px', marginBottom: '10px' } }, ['All', 'Injury openings', 'RB', 'QB', 'WR', 'TE'].map(f =>
        h('button', { class: 'tag' + (f === filter ? ' push' : ''), style: { cursor: 'pointer' }, onclick: () => { filter = f; draw(); } }, f))),
      shown.length ? h('div', { class: 'assets wv' }, shown.map(r => h('div', { class: 'panel', style: { padding: '10px 14px', marginBottom: '8px' } },
        h('div', { class: 'row spread' },
          h('div', {}, posB(r.pos), h('b', {}, ' ' + r.name), h('span', { class: 'muted small' }, ` ${r.team}${r.age ? ' · ' + r.age : ''}`)),
          h('div', { class: 'small', style: { textAlign: 'right' } }, r.v ? h('b', {}, f1(r.L, r.v, false)) : h('span', { class: 'muted' }, 'no market value yet'), r.price ? h('span', { class: 'muted' }, ` · ${r.price}`) : '')),
        h('div', { class: 'row', style: { gap: '4px', margin: '6px 0' } }, r.tags.map(t => h('span', { class: 'tag' + (t.endsWith('next man up') || t === 'r/DynastyFF news' ? ' bad' : '') }, t))),
        r.buzz?.posts?.length ? h('div', { class: 'small', style: { marginBottom: '4px' } }, r.buzz.posts.slice(0, 2).map(p => h('a', { href: p.link, target: '_blank', rel: 'noopener', style: { display: 'block' } }, '💬 ' + p.title.slice(0, 90)))) : '',
        h('div', { class: 'small' }, h('span', { class: 'muted' }, `Available in ${r.leagues.length}: `),
          r.leagues.sort((a, b) => b.gain - a.gain).map(x => h('a', { class: 'pill', style: { marginRight: '6px', display: 'inline-block', marginBottom: '4px' }, href: `https://sleeper.com/leagues/${x.lid}/players`, target: '_blank', rel: 'noopener',
            title: x.drop ? `Drop ${x.drop.name} (${f1(x.L, x.drop.v, false)})` : '' },
            x.nick, x.drop ? h('span', { class: 'muted' }, ` · drop ${x.drop.name.split(' ').slice(-1)[0]}`) : '', faab[x.lid] != null ? h('span', { class: 'muted' }, ` · $${faab[x.lid]}`) : ''))))))
        : empty(filter === 'All' ? 'Nothing worth a roster spot right now.' : 'Nothing in this group right now.'),
      h('p', { class: 'muted small' }, (out.dataset.checked ? `r/DynastyFF last checked ${out.dataset.checked}. ` : '') + 'Value is FantasyCalc in generic 1sts; the price is the pick it would roughly fetch. Each league chip opens Sleeper and shows who you\'d drop (your lowest-value non-starter, never IR or taxi) and your FAAB left. A daily job also posts new finds to the "Waiver watch" issue on GitHub, so you get an email.'));
  };
  draw();
}
