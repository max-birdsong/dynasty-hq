// Waiver farm: find, stash, harvest, consolidate, audit. Across every league at once.
import { M, startersNow } from '../model.js';
import * as api from '../api.js';
import { scanLeague, indexTeams } from '../waiverscan.js';
import { ledger, consolidations, stash, faabModel, audit, realPrice, buyers } from '../farm.js';
import { calculator } from './trades.js';
import { h, f1, sleep, fmt, pool, toast } from '../util.js';
import { settings, save } from '../state.js';
import { posB, empty, modeTag } from '../components.js';

const TABS = [['queue', 'Claim queue'], ['find', 'Find'], ['stash', 'Stash'], ['harvest', 'Harvest'], ['consolidate', 'Consolidate'], ['audit', 'Roster audit']];
const BLURB = {
  queue: 'Your claims, ready to enter: per league, who to add, who to drop and what to bid. Check them off as you go.',
  find: 'Free agents worth a roster spot now: injury openings, r/DynastyFF buzz, backup RBs and QBs, risers.',
  stash: 'Backups to grab before the injury: chance the starter misses time this season × what the backup would be worth as the starter.',
  harvest: 'Players you picked up this season: what they cost, what they’re worth now, when to sell, and who will pay.',
  consolidate: 'Turn piles of 3rds and 4ths into one better pick. Each deal keeps the partner ahead on FantasyCalc.',
  audit: 'Roster spots doing nothing: cut them for lottery tickets, and use open taxi spots.',
};
let filter = 'All', tab = 'queue', ctxP = null, ctxAt = 0;

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
    pane.replaceChildren(await ({ queue, find, stash: stashTab, harvest, consolidate, audit: auditTab })[tab](c));
  } catch (e) { pane.replaceChildren(h('div', { class: 'err-box' }, 'Something went wrong: ' + e.message)); console.error(e); }
}

const card = (...kids) => h('div', { class: 'panel', style: { padding: '10px 14px', marginBottom: '8px' } }, ...kids);
const bidTxt = (c, L, v, hot) => { const m = c.faab[L.id]?.suggest(v, hot, c.left[L.id] ?? undefined); return m ? ` · bid ~$${m.bid}` : ''; };
const leagueChip = (c, x, extra = '') => h('a', { class: 'pill', style: { marginRight: '6px', display: 'inline-block', marginBottom: '4px' }, href: `https://sleeper.com/leagues/${x.L.id}/players`, target: '_blank', rel: 'noopener' },
  x.L.nick, h('span', { class: 'muted' }, extra + (c.left[x.L.id] != null ? ` · $${c.left[x.L.id]} left` : '')));
const openCalc = (L, rid, give, get) => { const box = document.getElementById('app'); box.replaceChildren(h('div', {}, h('a', { href: '#/waivers/x/' + tab }, '← back'), calculator(L, rid, { give, get }))); };

// ---------- Find ----------
async function scanAll(c) {
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
  return { all, job };
}

async function find(c) {
  const { all, job } = await scanAll(c);
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
          h('div', { class: 'small', style: { textAlign: 'right' } }, r.v ? h('span', {}, h('span', { class: 'muted' }, 'market '), h('b', {}, f1(r.L, r.v, false))) : h('span', { class: 'muted' }, 'no market value yet'), r.price ? h('span', { class: 'muted' }, ` · ${r.price}`) : '',
            r.L.tatMap?.get(r.id) ? h('div', { class: 'muted' }, `Sanderson ${f1(r.L, r.L.tatMap.get(r.id), false)}`) : '')),
        h('div', { class: 'row', style: { gap: '4px', margin: '6px 0' } }, r.tags.map(t => h('span', { class: 'tag' + (t.endsWith('next man up') || t === 'r/DynastyFF news' ? ' bad' : '') }, t))),
        r.buzz?.posts?.length ? h('div', { class: 'small', style: { marginBottom: '4px' } }, r.buzz.posts.slice(0, 2).map(p => h('a', { href: p.link, target: '_blank', rel: 'noopener', style: { display: 'block' } }, '💬 ' + p.title.slice(0, 90)))) : '',
        h('div', { class: 'small' }, h('span', { class: 'muted' }, `Free in ${r.leagues.length}: `),
          r.leagues.sort((a, b) => b.gain - a.gain).map(x => leagueChip(c, x, (x.drop ? ` · drop ${x.drop.name.split(' ').slice(-1)[0]}` : '') + bidTxt(c, x.L, x.v, x.hurt || x.buzz?.news)))))))
        : empty(filter === 'All' ? 'Nothing worth a roster spot right now.' : 'Nothing in this group right now.'),
      h('p', { class: 'muted small' }, (job?.updated ? `r/DynastyFF last checked ${new Date(job.updated).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}. ` : '') +
        'Drop = your lowest-value player who isn’t starting, on IR or taxi. Bid = this league’s going rate per point of value × his value (1.5× for injury openings and news), capped at a quarter of your FAAB left.'));
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
  const live = [], soldAll = [];
  for (const L of c.mine) {
    const rows = await ledger(L).catch(e => { console.error(e); return []; });
    total.adds += rows.length; total.sold += rows.filter(r => r.status === 'sold').length;
    const first = L.fc.picks.get(`${+L.season + 1} 1st`) || 3000;
    total.got += rows.filter(r => r.status === 'sold').reduce((s, r) => s + (r.gotFc || 0) / first, 0);
    total.held += rows.filter(r => r.status === 'rostered').reduce((s, r) => s + r.now / first, 0);
    for (const r of rows) { if (r.status === 'rostered' && r.now > 0) live.push({ L, r }); if (r.status === 'sold') soldAll.push({ L, r }); }
  }
  // real prices, weighted to the last few days, for everything you could sell
  await pool(live, 6, async x => { x.p = await realPrice(x.L, x.r.pid).catch(() => null); });
  const order = { sell: 0, steady: 1, hold: 2 };
  live.sort((a, b) => (order[a.p?.action] ?? 3) - (order[b.p?.action] ?? 3) || (b.p?.price || b.r.now) - (a.p?.price || a.r.now));
  // sell now = a real price, a moving or busy market, and a contender in that league with a reason to pay
  // asks are priced at his real-trade price: if he goes for a 4th, ask for a 4th
  for (const x of live) x.bs = x.p?.worth ? buyers(x.L, x.r.pid, x.p.price) : [];
  const sell = live.filter(x => x.p?.action === 'sell' && x.bs.length), rest = live.filter(x => !(x.p?.action === 'sell' && x.bs.length));
  for (const x of rest) if (x.p?.action === 'sell') x.p = { ...x.p, why: x.p.why.split(':')[0] + ': but no contender here needs him; offer him in the league chat' };
  const priceTxt = p => p?.n ? `≈ ${p.label}` : `no real trades in ${p?.days || 10} days: nobody is buying him`;
  const nick = p => p?.nickname ? h('span', { class: 'pill', title: 'Set this as his nickname in Sleeper so league mates see the price', style: { marginLeft: '6px', cursor: 'pointer' }, onclick: () => navigator.clipboard?.writeText(p.nickname).then(() => toast('Copied: paste it as his nickname in Sleeper')) }, `🏷 "${p.nickname}"`) : '';
  const asks = (L, r, bs) => bs.map(b => h('a', { href: 'javascript:void 0', class: 'pill', style: { marginRight: '6px', display: 'inline-block' }, title: b.why, onclick: () => openCalc(L, b.t.rid, ['p:' + r.pid], [b.ask.key]) }, `${b.t.owner}'s ${b.ask.short || b.ask.name}`, h('span', { class: 'muted' }, ` · ${b.why}`)));
  const card = ({ L, r, p, bs }) => {
    return h('div', { class: 'panel', style: { marginBottom: '8px' } },
      h('div', { class: 'row spread' },
        h('div', {}, posB(r.pos), h('b', {}, ' ' + r.name), h('span', { class: 'muted small' }, ` · ${L.nick} · added ${new Date(r.added).toLocaleDateString([], { month: 'short', day: 'numeric' })}${r.bid ? ` for $${r.bid}` : ''}`)),
        h('div', {}, h('b', {}, priceTxt(p)))),
      p?.why ? h('div', { class: 'small pos', style: { marginTop: '4px' } }, '📈 ', p.why) : '',
      p?.common?.length ? h('div', { class: 'small', style: { marginTop: '4px' } }, h('span', { class: 'muted' }, 'Last 5 days, alone he went for: '), p.common.map(([k, n]) => `${k}${n > 1 ? ` (×${n})` : ''}`).join(' · ')) : '',
      bs.length ? h('div', { class: 'small', style: { marginTop: '6px' } }, h('span', { class: 'muted' }, 'Ask: '),
        bs.map(b => h('a', { href: 'javascript:void 0', class: 'pill', style: { marginRight: '6px', display: 'inline-block' }, title: b.why, onclick: () => openCalc(L, b.t.rid, ['p:' + r.pid], [b.ask.key]) },
          `${b.t.owner}'s ${b.ask.short || b.ask.name}`, h('span', { class: 'muted' }, ` · ${b.why}`))))
        : h('div', { class: 'small muted', style: { marginTop: '6px' } }, 'No contender in this league with a need at his position right now: shop him in the league chat or wait for an injury.'));
  };
  box.append(h('div', { class: 'kpis', style: { marginBottom: '12px' } },
    kpi(new Set(sell.map(x => x.r.pid)).size, 'players to sell now'), kpi(total.sold, 'sold this season'), kpi(fmt(total.got, 2) + ' 1sts', 'harvested (value today)'), kpi(fmt(total.held, 2) + ' 1sts', 'still on your rosters')));
  // one card per player: the market is the same everywhere, the buyers differ by league
  const groups = new Map(); for (const x of sell) (groups.get(x.r.pid) || groups.set(x.r.pid, []).get(x.r.pid)).push(x);
  const groupCard = xs => {
    const { r, p } = xs[0];
    return h('div', { class: 'panel', style: { marginBottom: '8px' } },
      h('div', { class: 'row spread' }, h('div', {}, posB(r.pos), h('b', {}, ' ' + r.name), h('span', { class: 'muted small' }, ` · yours in ${xs.length} league${xs.length > 1 ? 's' : ''}`)), h('div', {}, h('b', {}, priceTxt(p)), nick(p))),
      h('div', { class: 'small pos', style: { marginTop: '4px' } }, '📈 ', p.why),
      p.common?.length ? h('div', { class: 'small', style: { marginTop: '4px' } }, h('span', { class: 'muted' }, 'Last 5 days, alone he went for: '), p.common.map(([k, n]) => `${k}${n > 1 ? ` (×${n})` : ''}`).join(' · ')) : '',
      ...xs.map(({ L, bs }) => h('div', { class: 'small', style: { marginTop: '6px' } }, h('b', {}, L.nick + ': '), h('span', { class: 'muted' }, 'ask '),
        asks(L, r, bs))));
  };
  box.append(h('h2', {}, 'Sell now'), ...(groups.size ? [...groups.values()].map(groupCard) : [empty('Nothing to sell right now: none of your pickups that fetch a 4th or more has a moving market and a buyer this week.')]));
  if (rest.length) box.append(h('h2', { style: { marginTop: '16px' } }, 'Holding'),
    h('div', { class: 'panel' }, ...rest.map(({ L, r, p, bs }) => h('div', { class: 'small', style: { padding: '5px 0', borderTop: '1px solid var(--line)' } },
      h('div', { class: 'row spread' }, h('div', {}, posB(r.pos), ' ', h('b', {}, r.name), h('span', { class: 'muted' }, ` · ${L.nick}`)), h('div', {}, priceTxt(p), nick(p))),
      p?.why ? h('div', { class: 'muted' }, p.why) : '',
      bs?.length ? h('div', {}, h('span', { class: 'muted' }, 'If you want to move him, ask: '), asks(L, r, bs)) : ''))));
  if (soldAll.length) box.append(h('p', { class: 'small muted', style: { marginTop: '12px' } }, 'Harvested: ', soldAll.map(({ L, r }) => `${r.name} → ${r.got.join(' + ')} (${L.nick})`).join(' · ')));
  box.append(h('p', { class: 'muted small' }, 'Prices come from real trades in FantasyCalc\'s database (all leagues, your league\'s format), each at his value that day, weighted heavily to the last few days (half-life 2 days, nothing older than 3 weeks). "Sell now" = his price moved 15%+ in the last 3 days or trading is busy. The ask is a contender\'s best 2nd–4th at or just under his real price; click it to open the trade in the calculator.'));
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
      h('div', { class: 'small' }, h('span', { class: 'muted' }, `they gain ${f1(L, d.fcGive - d.fcGet)} on FC · you ${d.tatLoss > 0 ? 'give up' : 'gain'} ${f1(L, Math.abs(d.tatLoss), false)} on paper `),
        h('button', { class: 'btn ghost small', onclick: () => openCalc(L, d.t.rid, d.give.map(a => a.key), [d.get.key]) }, 'Open'))))));
  }
  return out.length ? h('div', {}, out, h('p', { class: 'muted small' }, 'Uses FantasyCalc’s 2-for-1 rule: the side getting the single better pick is credited for the roster spot it saves, so a pile of small picks is worth less than its sum. Moving up costs a premium because the hit rate climbs steeply near the top. Rebuilders are listed first; they like volume.'))
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

// ---------- Claim queue ----------
// Per league: the best few adds, each paired with its own drop (lowest-value bench player first; none if a roster spot
// is open), and a FAAB bid that fits what's left. Checked-off and skipped claims are remembered (synced).
const qkey = (L, id) => `${L.id}:${id}:${M.week}`;
async function queue(c) {
  const S = settings();
  S.claims ||= {};
  for (const k of Object.keys(S.claims)) if (!k.endsWith(':' + M.week)) delete S.claims[k]; // only this week's
  const { all } = await scanAll(c);
  const byL = new Map();
  for (const r of all) (byL.get(r.L.id) || byL.set(r.L.id, []).get(r.L.id)).push(r);
  const leagues = [];
  for (const L of c.mine) {
    const ros = c.live[L.id]; if (!ros) continue;
    const me = ros.find(r => r.roster_id === L.me.rid) || {};
    const ids = (me.players || []).map(String), res = new Set((me.reserve || []).map(String)), taxi = new Set((me.taxi || []).map(String));
    const protect = new Set([...startersNow(L, ids).starters, ...res, ...taxi]);
    const spots = (L.lg?.roster_positions || []).filter(p => p !== 'IR' && p !== 'TAXI').length;
    let open = Math.max(0, spots - ids.filter(id => !res.has(id) && !taxi.has(id)).length);
    const drops = ids.filter(id => !protect.has(id)).map(id => ({ id, name: M.players[id]?.full_name || id, v: L.fc.byId.get(id)?.value || 0 })).sort((a, b) => a.v - b.v);
    const fm = c.faab[L.id];
    let left = c.left[L.id];
    const claims = [];
    for (const r of (byL.get(L.id) || []).sort((a, b) => b.score - a.score)) {
      if (claims.length >= 3) break;
      const st = S.claims[qkey(L, r.id)];
      if (st === 'skip') continue;
      const urgent = r.hurt || r.buzz?.news;
      let drop = null;
      if (open > 0) open--;
      else {
        drop = drops[0];
        if (!drop || !(urgent ? r.v >= drop.v * 0.8 : r.v > drop.v * 1.15 + 50)) continue;
        drops.shift();
      }
      let bid = null;
      if (left != null) { const m = fm?.suggest(r.v, urgent, left); bid = Math.min(left, m ? m.bid : Math.max(1, Math.floor(left * (urgent ? 0.1 : 0.02)))); left -= bid; }
      claims.push({ r, drop, bid, done: st === 'done', urgent });
    }
    if (claims.length) leagues.push({ L, claims, prio: me.settings?.waiver_position, faab: c.left[L.id], score: Math.max(...claims.map(x => x.r.score)) });
  }
  leagues.sort((a, b) => b.score - a.score);
  const box = h('div');
  const draw = () => box.replaceChildren(
    leagues.length ? h('div', {}, leagues.map(({ L, claims, prio, faab }) => h('div', { class: 'panel' },
      h('div', { class: 'row spread' }, h('h2', { style: { margin: 0 } }, L.nick),
        h('span', { class: 'small muted' }, faab != null ? `$${faab} FAAB left` + ((m => m ? ` · this league pays ~$${m.per1st} per 1st of value (${m.n} claims)` : ' · not enough past bids here: token bids')(c.faab[L.id]?.suggest(1000))) : prio ? `waiver priority #${prio}` : ''),
        h('a', { class: 'btn small', href: `https://sleeper.com/leagues/${L.id}/players`, target: '_blank', rel: 'noopener' }, 'Open in Sleeper')),
      claims.map(x => { const k = qkey(L, x.r.id); const st = S.claims[k];
        return h('div', { class: 'row spread', style: { borderTop: '1px solid var(--line)', padding: '8px 0', gap: '8px', opacity: st === 'done' ? 0.45 : 1 } },
          h('label', { class: 'row', style: { gap: '8px', cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: st === 'done', onchange: e => { S.claims[k] = e.target.checked ? 'done' : undefined; save({ settingsChanged: true }); draw(); } }),
            h('span', { class: 'small' }, x.urgent ? '🚨 ' : '', 'Add ', posB(x.r.pos), h('b', {}, x.r.name), ` (${x.r.team})`,
              x.drop ? h('span', { class: 'muted' }, ` · drop ${x.drop.name}`) : h('span', { class: 'muted' }, ' · open roster spot'),
              x.bid != null ? h('b', {}, ` · bid $${x.bid}`) : '',
              h('div', { class: 'muted' }, `${x.r.v ? `market ${f1(L, x.r.v, false)}` : 'no market value yet'}${x.r.price ? ' (' + x.r.price + ')' : ''}${L.tatMap?.get(x.r.id) ? ` · Sanderson ${f1(L, L.tatMap.get(x.r.id), false)}` : ''}${x.r.tags.length ? ' · ' + x.r.tags[0] : ''}`))),
          h('button', { class: 'btn ghost small', title: 'Skip this claim for the rest of the week', onclick: () => { S.claims[k] = 'skip'; save({ settingsChanged: true }); leagues.forEach(l => { l.claims = l.claims.filter(y => qkey(l.L, y.r.id) !== k); }); draw(); } }, 'Skip'));
      }))))
      : empty('Nothing to claim right now.'),
    h('p', { class: 'muted small' }, 'Drops: your lowest-value bench player (never starters, IR or taxi), only when the add is clearly worth more (injury openings and Reddit news get more slack). Market = what you could flip him for (FantasyCalc; ≈ the pick it would fetch); Sanderson = what he’s worth to you. Bids: this league’s going rate per point of value (from past winning bids) × his value, 1.5× for 🚨 claims, capped at a quarter of your remaining FAAB (40% for 🚨). Sleeper has no link straight to a claim, so "Open in Sleeper" opens the league’s player search.'));
  draw();
  return box;
}
