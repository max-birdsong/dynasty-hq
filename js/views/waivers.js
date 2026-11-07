// Waiver farm: find, stash, harvest, consolidate, audit. Across every league at once.
import { M, startersNow } from '../model.js';
import * as api from '../api.js';
import { scanLeague, indexTeams } from '../waiverscan.js';
import { ledger, consolidations, stash, faabModel, audit } from '../farm.js';
import { calculator } from './trades.js';
import { h, f1, sleep, fmt } from '../util.js';
import { posB, empty, modeTag } from '../components.js';

const TABS = [['find', 'Find'], ['stash', 'Stash'], ['harvest', 'Harvest'], ['consolidate', 'Consolidate'], ['audit', 'Roster audit']];
const BLURB = {
  find: 'Free agents worth a roster spot now: injury openings, r/DynastyFF buzz, backup RBs and QBs, risers.',
  stash: 'Backups to grab before the injury: chance the starter misses time this season × what the backup would be worth as the starter.',
  harvest: 'Players you picked up this season: what they cost, what they’re worth now, when to sell, and who will pay.',
  consolidate: 'Turn piles of 3rds and 4ths into one better pick. Each deal keeps the partner ahead on FantasyCalc.',
  audit: 'Roster spots doing nothing: cut them for lottery tickets, and use open taxi spots.',
};
let filter = 'All', tab = 'find', ctxP = null, ctxAt = 0;

export default function waiversView(_, sub) {
  if (sub && BLURB[sub]) tab = sub;
  const root = h('div');
  const pane = h('div');
  root.append(h('h1', {}, 'Waiver farm'),
    h('div', { class: 'tabs' }, TABS.map(([k, l]) => h('button', { class: k === tab ? 'on' : '', onclick: () => { location.hash = '#/waivers/x/' + k; } }, l))),
    h('div', { class: 'muted small', style: { margin: '-4px 0 10px' } }, BLURB[tab]), pane);
  show(pane);
  return root;
}

// live rosters + FAAB models, shared by all tabs (refreshed after 5 minutes)
function ctx() {
  if (ctxP && Date.now() - ctxAt < 300e3) return ctxP;
  ctxAt = Date.now();
  ctxP = (async () => {
    const mine = M.leagues.filter(L => L.me), live = {}, faab = {}, left = {};
    await Promise.all(mine.map(async L => {
      const ros = await api.rostersLive(L.id).catch(() => null);
      if (ros) live[L.id] = ros;
      faab[L.id] = await faabModel(L).catch(() => null);
      const me = ros?.find(r => r.roster_id === L.me.rid);
      if (L.lg?.settings?.waiver_type === 2 && L.lg.settings.waiver_budget) left[L.id] = L.lg.settings.waiver_budget - (me?.settings?.waiver_budget_used || 0);
    }));
    return { mine, live, faab, left };
  })();
  return ctxP;
}

async function show(pane) {
  pane.replaceChildren(h('div', { class: 'loading' }, h('div', { class: 'spinner' }), 'Checking rosters in each league…'));
  try {
    const c = await ctx();
    pane.replaceChildren(await ({ find, stash: stashTab, harvest, consolidate, audit: auditTab })[tab](c));
  } catch (e) { pane.replaceChildren(h('div', { class: 'err-box' }, 'Something went wrong: ' + e.message)); console.error(e); }
}

const card = (...kids) => h('div', { class: 'panel', style: { padding: '10px 14px', marginBottom: '8px' } }, ...kids);
const bidTxt = (c, L, v, hot) => { const m = c.faab[L.id]?.suggest(v, hot); return m ? ` · bid ~$${m.bid}` : ''; };
const leagueChip = (c, x, extra = '') => h('a', { class: 'pill', style: { marginRight: '6px', display: 'inline-block', marginBottom: '4px' }, href: `https://sleeper.com/leagues/${x.L.id}/players`, target: '_blank', rel: 'noopener' },
  x.L.nick, h('span', { class: 'muted' }, extra + (c.left[x.L.id] != null ? ` · $${c.left[x.L.id]} left` : '')));
const openCalc = (L, rid, give, get) => { const box = document.getElementById('app'); box.replaceChildren(h('div', {}, h('a', { href: '#/waivers/x/' + tab }, '← back'), calculator(L, rid, { give, get }))); };

// ---------- Find ----------
async function find(c) {
  const tr = await api.trending().catch(() => []);
  const trending = new Map((Array.isArray(tr) ? tr : []).map(x => [String(x.player_id), x.count]));
  // Reddit can't be read from the browser; the hourly GitHub job saves who's being talked about
  const job = await fetch('data/waivers.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null);
  const env = { players: M.players, byTeamPos: indexTeams(M.players), trending, buzz: job?.buzz || {} };
  const all = [];
  for (const L of c.mine) {
    await sleep(0);
    const ros = c.live[L.id]; if (!ros) continue;
    const me = ros.find(r => r.roster_id === L.me.rid) || {};
    const myIds = (me.players || []).map(String);
    const protect = new Set([...startersNow(L, myIds).starters, ...(me.reserve || []).map(String), ...(me.taxi || []).map(String)]);
    all.push(...scanLeague({ id: L.id, nick: L.nick, ny: +L.season + 1, sf: L.fmt.numQbs === 2, rostered: new Set(ros.flatMap(r => (r.players || []).map(String))), mine: myIds, protect,
      fc: id => L.fc.byId.get(id), pick: n => L.fc.picks.get(n) }, env).map(r => ({ ...r, L })));
  }
  const by = new Map();
  for (const r of all) { const g = by.get(r.id) || by.set(r.id, { ...r, leagues: [] }).get(r.id); g.leagues.push(r); g.score = Math.max(g.score, r.score); if (r.v > g.v) { g.v = r.v; g.price = r.price; g.L = r.L; } }
  const rows = [...by.values()].sort((a, b) => b.score - a.score);
  const box = h('div');
  const draw = () => {
    const shown = rows.filter(r => filter === 'All' || (filter === 'Injury openings' ? r.hurt : r.pos === filter)).slice(0, 60);
    box.replaceChildren(
      h('div', { class: 'row', style: { gap: '6px', marginBottom: '10px' } }, ['All', 'Injury openings', 'RB', 'QB', 'WR', 'TE'].map(f =>
        h('button', { class: 'tag' + (f === filter ? ' push' : ''), style: { cursor: 'pointer' }, onclick: () => { filter = f; draw(); } }, f))),
      shown.length ? h('div', {}, shown.map(r => card(
        h('div', { class: 'row spread' },
          h('div', {}, posB(r.pos), h('b', {}, ' ' + r.name), h('span', { class: 'muted small' }, ` ${r.team}${r.age ? ' · ' + r.age : ''}`)),
          h('div', { class: 'small', style: { textAlign: 'right' } }, r.v ? h('b', {}, f1(r.L, r.v, false)) : h('span', { class: 'muted' }, 'no market value yet'), r.price ? h('span', { class: 'muted' }, ` · ${r.price}`) : '')),
        h('div', { class: 'row', style: { gap: '4px', margin: '6px 0' } }, r.tags.map(t => h('span', { class: 'tag' + (t.endsWith('next man up') || t === 'r/DynastyFF news' ? ' bad' : '') }, t))),
        r.buzz?.posts?.length ? h('div', { class: 'small', style: { marginBottom: '4px' } }, r.buzz.posts.slice(0, 2).map(p => h('a', { href: p.link, target: '_blank', rel: 'noopener', style: { display: 'block' } }, '💬 ' + p.title.slice(0, 90)))) : '',
        h('div', { class: 'small' }, h('span', { class: 'muted' }, `Free in ${r.leagues.length}: `),
          r.leagues.sort((a, b) => b.gain - a.gain).map(x => leagueChip(c, x, (x.drop ? ` · drop ${x.drop.name.split(' ').slice(-1)[0]}` : '') + bidTxt(c, x.L, x.v, x.hurt || x.buzz?.news)))))))
        : empty(filter === 'All' ? 'Nothing worth a roster spot right now.' : 'Nothing in this group right now.'),
      h('p', { class: 'muted small' }, (job?.updated ? `r/DynastyFF last checked ${new Date(job.updated).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}. ` : '') +
        'Drop = your lowest-value player who isn’t starting, on IR or taxi. Bid = what similar players have gone for in that league (80th percentile, one tier up for injury openings and news).'));
  };
  draw();
  return box;
}

// ---------- Stash ----------
async function stashTab(c) {
  const by = new Map();
  for (const L of c.mine) {
    const ros = c.live[L.id]; if (!ros) continue;
    for (const s of stash(L, new Set(ros.flatMap(r => (r.players || []).map(String))))) {
      const g = by.get(s.id) || by.set(s.id, { ...s, L, leagues: [] }).get(s.id);
      g.leagues.push({ L, v: s.v }); if (s.score > g.score) { g.score = s.score; g.L = L; g.upside = s.upside; }
    }
  }
  const rows = [...by.values()].sort((a, b) => b.score - a.score).slice(0, 25);
  if (!rows.length) return empty('No stash candidates right now.');
  return h('div', {}, rows.map(r => card(
    h('div', { class: 'row spread' },
      h('div', {}, posB(r.pos), h('b', {}, ' ' + r.name), h('span', { class: 'muted small' }, ` ${r.team} · behind ${r.starter}${r.sAge ? ` (${r.sAge})` : ''}${r.sInj ? `, ${r.sInj}` : ''}`)),
      h('div', { class: 'small', style: { textAlign: 'right' } }, h('b', {}, `${Math.round(r.risk * 100)}%`), h('span', { class: 'muted' }, ` starter misses time · worth ${f1(r.L, r.upside, false)} if he starts`))),
    h('div', { class: 'small', style: { marginTop: '6px' } }, h('span', { class: 'muted' }, `Free in ${r.leagues.length}: `), r.leagues.map(x => leagueChip(c, x, bidTxt(c, x.L, x.v, false)))))),
    h('p', { class: 'muted small' }, 'Injury chance per week: RB 5%, QB 2%, higher for starters 28+ or listed Questionable. "If he starts" is about a third of the starter’s current value: backups rarely inherit the whole job.'));
}

// ---------- Harvest ----------
async function harvest(c) {
  const box = h('div');
  let total = { adds: 0, sold: 0, got: 0, held: 0 };
  const sections = [];
  for (const L of c.mine) {
    const rows = await ledger(L).catch(e => { console.error(e); return []; });
    if (!rows.length) continue;
    total.adds += rows.length; total.sold += rows.filter(r => r.status === 'sold').length;
    total.got += rows.filter(r => r.status === 'sold').reduce((s, r) => s + (r.gotFc || 0) / (L.fc.picks.get(`${+L.season + 1} 1st`) || 3000), 0);
    total.held += rows.filter(r => r.status === 'rostered').reduce((s, r) => s + r.now / (L.fc.picks.get(`${+L.season + 1} 1st`) || 3000), 0);
    const live = rows.filter(r => r.status === 'rostered' && (r.signal || r.now > 0));
    const sold = rows.filter(r => r.status === 'sold');
    if (!live.length && !sold.length) continue;
    sections.push(h('div', { class: 'panel' }, h('h2', {}, L.nick),
      live.map(r => h('div', { style: { borderTop: '1px solid var(--line)', padding: '8px 0' } },
        h('div', { class: 'row spread' },
          h('div', {}, posB(r.pos), h('b', {}, ' ' + r.name), h('span', { class: 'muted small' }, ` added ${new Date(r.added).toLocaleDateString([], { month: 'short', day: 'numeric' })}${r.bid ? ` for $${r.bid}` : ''}`)),
          h('div', { class: 'small' }, r.then ? `${f1(L, r.then, false)} → ` : '', h('b', {}, f1(L, r.now, false)))),
        r.signal ? h('div', { class: 'small ' + (r.signal.kind === 'spike' ? 'pos' : 'neg'), style: { marginTop: '4px' } }, (r.signal.kind === 'spike' ? '📈 Sell: ' : '📉 ') + r.signal.why) : '',
        r.buyers?.length ? h('div', { class: 'small', style: { marginTop: '4px' } }, h('span', { class: 'muted' }, 'Buyers: '),
          r.buyers.map(b => h('a', { href: 'javascript:void 0', class: 'pill', style: { marginRight: '6px', display: 'inline-block' }, title: b.why, onclick: () => openCalc(L, b.t.rid, ['p:' + r.pid], [b.ask.key]) },
            `${b.t.owner}: ask their ${b.ask.short || b.ask.name}`, h('span', { class: 'muted' }, ` · ${b.why}`)))) : (r.signal?.kind === 'spike' ? h('div', { class: 'small muted' }, 'No contender with a need right now.') : ''))),
      sold.length ? h('div', { class: 'small muted', style: { borderTop: '1px solid var(--line)', paddingTop: '6px' } }, 'Harvested: ', sold.map(r => `${r.name} → ${r.got.join(' + ')}`).join(' · ')) : ''));
  }
  box.append(h('div', { class: 'kpis', style: { marginBottom: '12px' } },
    kpi(total.adds, 'players added this season'), kpi(total.sold, 'sold'), kpi(fmt(total.got, 2) + ' 1sts', 'harvested (value today)'), kpi(fmt(total.held, 2) + ' 1sts', 'still on your rosters')));
  box.append(...(sections.length ? sections : [empty('Nothing farmed yet this season.')]));
  box.append(h('p', { class: 'muted small' }, 'Value then = market at the week you added him (DynastyProcess history, FantasyCalc scale); now = FantasyCalc. Buyers are contenders with a hole or an injured starter at his position; the ask is their best 2nd–4th that still leaves them ahead on FantasyCalc. Click a buyer to open the trade in the calculator.'));
  return box;
}
const kpi = (v, l) => h('div', { class: 'kpi' }, h('b', {}, v), h('span', {}, l));

// ---------- Consolidate ----------
async function consolidate(c) {
  const out = [];
  for (const L of c.mine) {
    const deals = await consolidations(L).catch(e => { console.error(e); return []; });
    if (!deals.length) continue;
    out.push(h('div', { class: 'panel' }, h('h2', {}, L.nick), deals.map(d => h('div', { class: 'row spread', style: { borderTop: '1px solid var(--line)', padding: '8px 0', gap: '8px' } },
      h('div', { class: 'small' }, h('b', {}, d.give.map(a => a.short || a.name).join(' + ')), ' → ', h('b', {}, `${d.t.owner}'s ${d.get.short || d.get.name}`), ' ', modeTag(d.t.mode)),
      h('div', { class: 'small' }, h('span', { class: 'muted' }, `they gain ${f1(L, d.fcGive - d.get.fc)} on FC · you ${d.tatLoss > 0 ? 'give up' : 'gain'} ${f1(L, Math.abs(d.tatLoss), false)} on paper `),
        h('button', { class: 'btn ghost small', onclick: () => openCalc(L, d.t.rid, d.give.map(a => a.key), [d.get.key]) }, 'Open'))))));
  }
  return out.length ? h('div', {}, out, h('p', { class: 'muted small' }, 'You pay a small premium for moving up: one good pick is worth more than its share of value, because roster spots and draft slots are limited and the hit rate climbs steeply near the top. Rebuilders are listed first; they like volume.'))
    : empty('No packaging deals: you need at least two 2nd–4th round picks in a league.');
}

// ---------- Roster audit ----------
async function auditTab(c) {
  const out = [];
  for (const L of c.mine) {
    const me = c.live[L.id]?.find(r => r.roster_id === L.me.rid);
    const a = audit(L, me);
    if (!a.dead.length && !a.taxiOpen) continue;
    out.push(h('div', { class: 'panel' }, h('h2', {}, L.nick),
      a.dead.length ? h('div', { class: 'small' }, h('b', {}, `${a.dead.length} dead spot${a.dead.length > 1 ? 's' : ''}: `), a.dead.map(x => `${x.name} (${x.pos}${x.age ? ', ' + x.age : ''})`).join(', '),
        h('div', { class: 'muted' }, 'Near-zero value, not starting, 25 or older: cut for a backup RB or QB with upside.')) : '',
      a.taxiOpen ? h('div', { class: 'small', style: { marginTop: '6px' } }, h('b', {}, `${a.taxiOpen} open taxi spot${a.taxiOpen > 1 ? 's' : ''}`),
        a.taxiFit.length ? `: move ${a.taxiFit.map(x => x.name).join(', ')} there to free a bench spot` : ': stash young players there') : ''));
  }
  return out.length ? h('div', {}, out) : empty('Every roster spot is earning its keep.');
}
