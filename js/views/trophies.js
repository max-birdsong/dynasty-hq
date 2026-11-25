// Trophy room: every season you've played in every league (through Sleeper's previous_league_id chain),
// a trophy shelf, an honest "mirror" (luck, lineup setting, playoff conversion, value trend) and a money ledger.
import { M } from '../model.js';
import { state, settings, save } from '../state.js';
import { h, fmt, sgn, pct, cls, pool } from '../util.js';
import { cachedJson } from '../db.js';

const SL = 'https://api.sleeper.app/v1';
const DAY = 86400e3;
const get = (url, done) => cachedJson(url, done ? 365 * DAY : 6 * 3600e3).catch(() => null);
const ord = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
const money = n => (n < 0 ? '−$' : '$') + fmt(Math.abs(n));

let cache = null;   // seasons are expensive to gather; keep them for the session

// One season of one league, from your point of view
async function seasonOf(lg, meId, current) {
  const done = lg.status === 'complete';
  const [ros, br] = await Promise.all([get(`${SL}/league/${lg.league_id}/rosters`, done), done ? get(`${SL}/league/${lg.league_id}/winners_bracket`, true) : null]);
  if (!ros) return null;
  const mine = ros.find(r => r.owner_id === meId || (r.co_owners || []).includes(meId));
  if (!mine) return null;
  const s = r => r.settings || {};
  const pf = r => (s(r).fpts || 0) + (s(r).fpts_decimal || 0) / 100;
  const pa = r => (s(r).fpts_against || 0) + (s(r).fpts_against_decimal || 0) / 100;
  const pp = r => (s(r).ppts || 0) + (s(r).ppts_decimal || 0) / 100;
  const n = ros.length;
  const standings = [...ros].sort((a, b) => (s(b).wins || 0) - (s(a).wins || 0) || pf(b) - pf(a));
  const pfOrder = [...ros].sort((a, b) => pf(b) - pf(a));
  const rid = mine.roster_id, me = s(mine);
  const games = (me.wins || 0) + (me.losses || 0) + (me.ties || 0);
  // expected wins from scoring alone: where your points ranked, as a share of the league you'd beat in a typical week
  const pfRank = pfOrder.indexOf(mine) + 1;
  const xWins = games * (n - pfRank) / Math.max(1, n - 1);
  let finish = standings.indexOf(mine) + 1, playoffs = false, place = null;
  if (br?.length) {
    playoffs = br.some(m => m.t1 === rid || m.t2 === rid);
    const pm = br.find(m => m.p && (m.w === rid || m.l === rid));
    if (pm) place = pm.w === rid ? pm.p : pm.p + 1;
    else if (playoffs) place = Math.min(lg.settings?.playoff_teams || 6, n);
    if (place) finish = place;
  }
  const champ = br?.find(m => m.p === 1);
  return {
    season: lg.season, leagueId: lg.league_id, done, n, rid,
    wins: me.wins || 0, losses: me.losses || 0, ties: me.ties || 0, games,
    pf: pf(mine), pa: pa(mine), ppts: pp(mine), pfRank, xWins,
    seed: standings.indexOf(mine) + 1, finish, playoffs, place,
    title: !!champ && champ.w === rid, final: !!champ && (champ.w === rid || champ.l === rid),
    current,
  };
}

async function gather() {
  if (cache) return cache;
  const meId = M.me.user_id;
  const out = [];
  await pool(M.leagues.filter(L => L.me), 3, async L => {
    const seasons = [];
    const cur = await seasonOf(L.lg, meId, true).catch(() => null);
    if (cur) seasons.push(cur);
    let id = L.lg.previous_league_id;
    for (let k = 0; k < 12 && id && id !== '0'; k++) {
      const lg = await get(`${SL}/league/${id}`, true);
      if (!lg) break;
      const sz = await seasonOf(lg, meId, false).catch(() => null);
      if (sz) seasons.push(sz);
      id = lg.previous_league_id;
    }
    out.push({ L, nick: L.nick, seasons: seasons.sort((a, b) => b.season - a.season) });
  });
  cache = out.sort((a, b) => a.nick.localeCompare(b.nick));
  return cache;
}

// ---------- money (stored in settings so every device sees it) ----------
const ledger = () => (settings().money ||= {});
function netOf(nick, seasons) {
  const m = ledger()[nick] || {};
  let paid = 0, won = 0;
  for (const s of seasons) {
    const e = m.seasons?.[s.season] || {};
    paid += e.paid != null && e.paid !== '' ? +e.paid : +(m.buyIn || 0);
    won += +(e.won || 0);
  }
  return { paid, won, net: won - paid, set: m.buyIn != null && m.buyIn !== '' || Object.keys(m.seasons || {}).length > 0 };
}
function setMoney(nick, season, key, val) {
  const m = (ledger()[nick] ||= { seasons: {} });
  m.seasons ||= {};
  const v = val === '' ? '' : Math.max(0, +val || 0);
  if (season == null) m.buyIn = v; else (m.seasons[season] ||= {})[key] = v;
  save({ settingsChanged: true });
}

// value rank this season, first snapshot vs latest
function valueTrend(L) {
  const hist = state().history[L.id] || {};
  const weeks = Object.keys(hist).map(Number).sort((a, b) => a - b);
  const rankAt = w => {
    const e = hist[w]; if (!e?.teams || e.me == null) return null;
    const arr = Object.entries(e.teams).sort((a, b) => (b[1].fc || 0) - (a[1].fc || 0));
    const i = arr.findIndex(([rid]) => String(rid) === String(e.me));
    return i < 0 ? null : i + 1;
  };
  const first = weeks.length ? rankAt(weeks[0]) : null, last = weeks.length ? rankAt(weeks.at(-1)) : null;
  const nowRank = [...L.teams].sort((a, b) => b.fcTotal - a.fcTotal).indexOf(L.me) + 1;
  return { first, last: last || nowRank, from: weeks[0], to: weeks.at(-1) };
}

export default async function trophiesView() {
  const root = h('div');
  root.append(h('h1', {}, 'Trophy Room'), h('div', { class: 'muted small', style: { marginBottom: '14px' } }, 'Every season you’ve played, pulled from Sleeper. The trophies, the honest numbers behind them, and whether this hobby is paying for itself.'));
  const body = h('div', {}, h('div', { class: 'loading' }, h('div', { class: 'spinner' }), h('div', {}, 'Digging through old seasons…')));
  root.append(body);
  gather().then(data => body.replaceChildren(render(data))).catch(e => body.replaceChildren(h('div', { class: 'err-box' }, 'Could not load league history: ' + e.message)));
  return root;
}

function render(data) {
  const wrap = h('div', { class: 'grid' });
  const all = data.flatMap(d => d.seasons.map(s => ({ ...s, nick: d.nick })));
  const done = all.filter(s => s.done);
  const W = all.reduce((a, s) => a + s.wins, 0), Lo = all.reduce((a, s) => a + s.losses, 0), T = all.reduce((a, s) => a + s.ties, 0);
  const titles = done.filter(s => s.title), finals = done.filter(s => s.final), po = done.filter(s => s.playoffs);
  const avgFinish = done.length ? done.reduce((a, s) => a + s.finish, 0) / done.length : null;
  const money$ = data.map(d => netOf(d.nick, d.seasons));
  const anyMoney = money$.some(m => m.set);
  const net = money$.reduce((a, m) => a + m.net, 0);

  // ---- headline numbers ----
  wrap.append(h('div', { class: 'kpis' },
    kpi(titles.length, 'Titles', titles.length ? '🏆'.repeat(Math.min(titles.length, 5)) : ''),
    kpi(`${finals.length}`, 'Finals reached'),
    kpi(`${po.length}/${done.length}`, 'Playoff trips', done.length ? pct(po.length / done.length) : ''),
    kpi(`${W}-${Lo}${T ? '-' + T : ''}`, 'All-time record', pct((W + T / 2) / Math.max(1, W + Lo + T))),
    kpi(avgFinish ? avgFinish.toFixed(1) : '–', 'Average finish'),
    kpi(anyMoney ? h('span', { class: cls(net) }, money(net)) : '–', 'Money, all time', anyMoney ? '' : 'add buy-ins below')));

  // ---- trophy shelf ----
  const medals = done.filter(s => s.place && s.place <= 3).sort((a, b) => a.place - b.place || b.season - a.season);
  wrap.append(h('div', { class: 'card' }, h('h3', {}, 'The shelf'),
    medals.length ? h('div', { class: 'row', style: { gap: '14px', flexWrap: 'wrap' } }, medals.map(s =>
      h('div', { style: { textAlign: 'center', minWidth: '84px' }, title: `${s.wins}-${s.losses}, ${fmt(s.pf)} PF` },
        h('div', { style: { fontSize: s.place === 1 ? '40px' : '30px', lineHeight: 1.1 } }, ['🏆', '🥈', '🥉'][s.place - 1]),
        h('div', { class: 'small' }, h('b', {}, s.nick)), h('div', { class: 'small muted' }, s.season))))
      : h('div', { class: 'muted' }, 'No hardware yet. Plenty of seasons left.')));

  // ---- the mirror ----
  wrap.append(mirror(data, done));

  // ---- league by league ----
  const open = new Set();
  const tbl = h('div', { class: 'tablewrap' });
  const draw = () => {
    const rows = data.map((d, i) => {
      const ds = d.seasons.filter(s => s.done), cur = d.seasons.find(s => s.current);
      const w = d.seasons.reduce((a, s) => a + s.wins, 0), l = d.seasons.reduce((a, s) => a + s.losses, 0);
      const eff = ds.filter(s => s.ppts > 0);
      const effV = eff.length ? eff.reduce((a, s) => a + s.pf / s.ppts, 0) / eff.length : null;
      const best = ds.length ? Math.min(...ds.map(s => s.finish)) : null;
      const vt = valueTrend(d.L);
      const m = money$[i];
      const main = h('tr', { class: 'click', onclick: () => { open.has(d.nick) ? open.delete(d.nick) : open.add(d.nick); draw(); } },
        h('td', {}, (open.has(d.nick) ? '▾ ' : '▸ '), h('b', {}, d.nick)),
        h('td', { class: 'n' }, d.seasons.length),
        h('td', { class: 'n' }, `${w}-${l}`),
        h('td', { class: 'n' }, `${ds.filter(s => s.playoffs).length}/${ds.length}`),
        h('td', { class: 'n' }, '🏆'.repeat(ds.filter(s => s.title).length) || '–'),
        h('td', { class: 'n' }, best ? ord(best) : '–'),
        h('td', { class: 'n' }, ds.length ? (ds.reduce((a, s) => a + s.finish, 0) / ds.length).toFixed(1) : '–'),
        h('td', { class: 'n' }, effV ? pct(effV) : '–'),
        h('td', { class: 'n' }, cur ? `${cur.wins}-${cur.losses}` : '–', d.L.me ? h('span', { class: 'muted small' }, ` · title ${pct(d.L.me.title)}`) : ''),
        h('td', { class: 'n', title: vt.first ? `Dynasty value rank week ${vt.from}: ${ord(vt.first)}, now ${ord(vt.last)}` : '' },
          ord(vt.last), vt.first && vt.first !== vt.last ? h('span', { class: (vt.first > vt.last ? 'pos' : 'neg') + ' small' }, vt.first > vt.last ? ` ▲${vt.first - vt.last}` : ` ▼${vt.last - vt.first}`) : ''),
        h('td', { class: 'n' }, m.set ? h('span', { class: cls(m.net) }, money(m.net)) : h('span', { class: 'muted' }, '–')));
      const kids = open.has(d.nick) ? d.seasons.map(s => h('tr', { class: s.title ? 'me' : '' },
        h('td', { style: { paddingLeft: '28px' } }, s.season, s.current ? h('span', { class: 'muted small' }, ' (now)') : ''),
        h('td', { class: 'n muted small' }, `${s.n} teams`),
        h('td', { class: 'n' }, `${s.wins}-${s.losses}${s.ties ? '-' + s.ties : ''}`),
        h('td', { class: 'n' }, s.current ? '…' : s.playoffs ? `${ord(s.seed)} seed` : h('span', { class: 'muted' }, 'missed')),
        h('td', { class: 'n' }, s.title ? '🏆' : s.place === 2 ? '🥈' : s.place === 3 ? '🥉' : ''),
        h('td', { class: 'n' }, s.current ? '…' : ord(s.finish)),
        h('td', { class: 'n small', title: 'Points-for rank' }, `PF ${ord(s.pfRank)}`),
        h('td', { class: 'n' }, s.ppts ? pct(s.pf / s.ppts) : '–'),
        h('td', { class: 'n small' }, luckLabel(s.wins + s.ties / 2 - s.xWins)),
        h('td', {}, ''),
        h('td', { class: 'n' }, moneyCell(d.nick, s)))) : [];
      return [main, ...kids];
    });
    tbl.replaceChildren(h('table', {},
      h('thead', {}, h('tr', {}, ['League', 'Seasons', 'Record', 'Playoffs', 'Titles', 'Best', 'Avg finish', 'Lineup IQ', 'This year', 'Value rank', 'Net $']
        .map((x, i) => h('th', { class: i ? 'n' : '', title: { 'Lineup IQ': 'Points you scored as a share of the most you could have scored with your roster', 'Value rank': 'Where your roster ranks in dynasty value (FantasyCalc) now, and the change since the first snapshot this season' }[x] || '' }, x)))),
      h('tbody', {}, rows.flat())));
  };
  draw();
  wrap.append(h('div', { class: 'card' }, h('h3', {}, 'League by league'), h('div', { class: 'muted small', style: { marginBottom: '6px' } }, 'Tap a league for every season. In the season rows, the luck column compares your wins with what your points would usually earn, and the money column takes that year’s winnings (blank buy-in uses the league default).'), tbl));

  // ---- money ledger ----
  wrap.append(ledgerCard(data, money$, draw));
  return wrap;
}

function kpi(v, label, sub) { return h('div', { class: 'kpi' }, h('b', {}, v), h('span', {}, label), sub ? h('div', { class: 'small muted' }, sub) : ''); }
function luckLabel(d) { return Math.abs(d) < 0.75 ? h('span', { class: 'muted' }, 'fair') : h('span', { class: d > 0 ? 'pos' : 'neg' }, `${d > 0 ? 'lucky' : 'unlucky'} ${sgn(d, 1)}W`); }
function moneyCell(nick, s) {
  const e = ledger()[nick]?.seasons?.[s.season] || {};
  return h('input', { type: 'number', min: 0, step: 1, placeholder: 'won $', value: e.won ?? '', style: { width: '80px' }, title: `Winnings in ${s.season}`, onchange: ev => setMoney(nick, s.season, 'won', ev.target.value) });
}

function ledgerCard(data, money$, redraw) {
  const totalPaid = money$.reduce((a, m) => a + m.paid, 0), totalWon = money$.reduce((a, m) => a + m.won, 0);
  const card = h('div', { class: 'card' }, h('h3', {}, 'The money'),
    h('div', { class: 'muted small', style: { marginBottom: '8px' } }, 'Set each league’s yearly buy-in. Enter winnings per season in the table above (tap a league to open its seasons). Everything syncs to your other devices.'));
  const rows = data.map((d, i) => {
    const m = money$[i];
    return h('tr', {},
      h('td', {}, h('b', {}, d.nick)),
      h('td', { class: 'n' }, h('input', { type: 'number', min: 0, step: 1, placeholder: 'buy-in $', value: ledger()[d.nick]?.buyIn ?? '', style: { width: '90px' }, onchange: e => { setMoney(d.nick, null, null, e.target.value); redraw(); } })),
      h('td', { class: 'n' }, d.seasons.length),
      h('td', { class: 'n' }, money(m.paid)),
      h('td', { class: 'n' }, money(m.won)),
      h('td', { class: 'n' }, h('b', { class: cls(m.net) }, money(m.net))),
      h('td', { class: 'n' }, m.paid ? pct(m.net / m.paid) : '–'));
  });
  card.append(h('div', { class: 'tablewrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ['League', 'Buy-in / yr', 'Seasons', 'Paid', 'Won', 'Net', 'ROI'].map((x, i) => h('th', { class: i ? 'n' : '' }, x)))),
    h('tbody', {}, rows, h('tr', { class: 'me' }, h('td', {}, 'Total'), h('td', {}), h('td', {}), h('td', { class: 'n' }, money(totalPaid)), h('td', { class: 'n' }, money(totalWon)),
      h('td', { class: 'n' }, h('b', { class: cls(totalWon - totalPaid) }, money(totalWon - totalPaid))), h('td', { class: 'n' }, totalPaid ? pct((totalWon - totalPaid) / totalPaid) : '–'))))));
  return card;
}

// ---------- the mirror: blunt, numbers-backed observations ----------
function mirror(data, done) {
  const lines = [];
  const add = (emoji, text) => lines.push(h('li', { style: { margin: '6px 0' } }, emoji, ' ', text));
  if (done.length) {
    // luck
    const luck = done.reduce((a, s) => a + (s.wins + s.ties / 2 - s.xWins), 0);
    const worst = [...done].sort((a, b) => (a.wins - a.xWins) - (b.wins - b.xWins))[0], best = [...done].sort((a, b) => (b.wins - b.xWins) - (a.wins - a.xWins))[0];
    add('🎲', Math.abs(luck) < 2 ? `Luck has been fair overall (${sgn(luck, 1)} wins compared with what your scoring usually earns).`
      : luck > 0 ? `You’ve been lucky: ${fmt(luck, 1)} more wins than your points usually earn. Biggest gift: ${best.nick} ${best.season} (${best.wins}-${best.losses} with the ${ord(best.pfRank)}-most points).`
      : `You’ve been unlucky: ${fmt(-luck, 1)} fewer wins than your points deserved. Worst robbery: ${worst.nick} ${worst.season} (${worst.wins}-${worst.losses} with the ${ord(worst.pfRank)}-most points).`);
    // lineup setting
    const eff = done.filter(s => s.ppts > 0);
    if (eff.length) {
      const avg = eff.reduce((a, s) => a + s.pf / s.ppts, 0) / eff.length;
      const byL = data.map(d => { const e = d.seasons.filter(s => s.done && s.ppts > 0); return e.length ? [d.nick, e.reduce((a, s) => a + s.pf / s.ppts, 0) / e.length] : null; }).filter(Boolean).sort((a, b) => a[1] - b[1]);
      add('🧠', `Lineup IQ: you score ${pct(avg)} of your best possible lineup. ${avg >= 0.88 ? 'That’s sharp.' : avg >= 0.83 ? 'Solid, some points left on the bench.' : 'Points are being left on the bench.'}${byL.length > 1 ? ` Laziest league: ${byL[0][0]} (${pct(byL[0][1])}). Sharpest: ${byL.at(-1)[0]} (${pct(byL.at(-1)[1])}).` : ''}`);
    }
    // playoff conversion
    const po = done.filter(s => s.playoffs), t = done.filter(s => s.title), f = done.filter(s => s.final);
    if (po.length) add('🎯', `Playoffs to titles: ${t.length} title${t.length === 1 ? '' : 's'} from ${po.length} playoff trip${po.length === 1 ? '' : 's'} (${pct(t.length / po.length)}). ${f.length ? `Finals record ${t.length}-${f.length - t.length}.` : 'No finals yet.'}${po.length >= 4 && t.length / po.length < 0.12 ? ' The regular season is fine; December is the problem.' : ''}`);
    // best / worst league
    const byFinish = data.map(d => { const ds = d.seasons.filter(s => s.done); return ds.length ? [d.nick, ds.reduce((a, s) => a + s.finish, 0) / ds.length, ds.length] : null; }).filter(Boolean).sort((a, b) => a[1] - b[1]);
    if (byFinish.length > 1) add('📈', `Your best league is ${byFinish[0][0]} (average finish ${byFinish[0][1].toFixed(1)}). Your worst is ${byFinish.at(-1)[0]} (${byFinish.at(-1)[1].toFixed(1)}).`);
    // droughts
    const dry = data.map(d => { const ds = d.seasons.filter(s => s.done); let n = 0; for (const s of ds) { if (s.playoffs) break; n++; } return [d.nick, n, ds.length]; }).filter(x => x[1] >= 2).sort((a, b) => b[1] - a[1]);
    if (dry.length) add('🏜️', `Playoff droughts: ${dry.map(x => `${x[0]} ${x[1] === x[2] ? `(never in ${x[1]} seasons)` : `(${x[1]} straight seasons)`}`).join(', ')}.`);
  }
  // dynasty value trend this season
  const tr = data.map(d => [d.nick, valueTrend(d.L)]).filter(([, v]) => v.first && v.last);
  const up = tr.filter(([, v]) => v.first > v.last), down = tr.filter(([, v]) => v.first < v.last);
  if (tr.length) add('🧭', `Dynasty value this season: climbing in ${up.length ? up.map(([n, v]) => `${n} (${ord(v.first)}→${ord(v.last)})`).join(', ') : 'no league'}; sliding in ${down.length ? down.map(([n, v]) => `${n} (${ord(v.first)}→${ord(v.last)})`).join(', ') : 'no league'}.`);
  // trading habits
  const T = state().trades.filter(t => t.dir !== 'in');
  const decided = T.filter(t => ['accepted', 'rejected', 'ignored', 'countered', 'withdrawn'].includes(t.status));
  const acc = T.filter(t => t.status === 'accepted');
  if (T.length) add('🤝', `Trade offers logged: ${T.length}. ${decided.length ? `${acc.length} accepted out of ${decided.length} answered (${pct(acc.length / decided.length)}).` : ''} ${decided.length >= 8 && acc.length / decided.length < 0.2 ? 'You’re asking too much: most offers die.' : decided.length >= 8 && acc.length / decided.length > 0.5 ? 'High hit rate. You might be leaving value on the table.' : ''}`);
  // expected titles this year
  const expT = M.leagues.filter(L => L.me).reduce((a, L) => a + (L.me.title || 0), 0);
  add('🔮', `This season the simulator expects ${fmt(expT, 1)} titles across your leagues.`);
  return h('div', { class: 'card' }, h('h3', {}, 'The mirror'), h('ul', { style: { margin: 0, paddingLeft: '4px', listStyle: 'none' } }, lines));
}
