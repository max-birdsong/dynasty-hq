// Macro strategy per league: Sanderson's rule (top half of league value competes, bottom half tears down for a
// quick rebuild, the middle is a trap), read from current TAT and FantasyCalc ranks, next to your own call.
// Your call always wins; the rule's read is there to flag when the numbers have moved enough to rethink it.
import { M, teamAssets } from './model.js';
import { settings, save } from './state.js';
import { h, odds } from './util.js';
import { table } from './components.js';

export const CALLS = {
  compete: { label: 'Compete', cls: 'contend', side: 1 },
  push: { label: 'Borderline: push', cls: 'push', side: 1 },
  teardown: { label: 'Tear down', cls: 'rebuild', side: -1 },
  tank: { label: 'Long tank', cls: 'tank', side: -1 },
};

// the plan agreed in Nov 2026; used until you set a call on the site
const DEFAULT_MACRO = {
  Gang: { call: 'compete', year: 2027, note: 'Most valuable roster in the league. Turn picks into producers this offseason.' },
  Fortress: { call: 'compete' }, Mongol: { call: 'compete' }, NF: { call: 'compete' }, Euro: { call: 'compete' }, Boys: { call: 'compete' },
  R2L: { call: 'push', year: 2027, note: '6th by TAT, 3rd by FantasyCalc. Push.' },
  UKDL: { call: 'teardown', note: 'Borderline at 6th, 8th by FantasyCalc and sliding. Lean tear down.' },
  FJ: { call: 'teardown', note: 'Play out 2026 while the title odds are real, then tear down properly.' },
  Molon: { call: 'teardown', note: "Don't own the next 1st, so losing gains nothing. Sell vets for other teams' picks." },
  MP: { call: 'tank', year: 2028, note: "Linear draft, no lottery. Stay low in 2027: take the best player at your own pick, swap bbarraco's and jorear's 2027 1sts for 2028 1sts from weak teams, sell Kraft, Reed and anyone 26+ by the 2027 deadline. Keep Odunze, McMillan, Caleb. 2028 offseason: picks into RBs and a QB2, contend 2028-2030." },
};

export const myCall = L => settings().macro?.[L.id] || DEFAULT_MACRO[L.nick] || null;

function coreAge(L, t) {
  const top = teamAssets(L, t).filter(a => !a.pick && a.age).sort((a, b) => (b.tat || b.fc) - (a.tat || a.fc)).slice(0, 8);
  const w = top.reduce((s, a) => s + (a.tat || a.fc), 0);
  return w ? top.reduce((s, a) => s + a.age * (a.tat || a.fc), 0) / w : null;
}

export function ruleRead(L) {
  const t = L.me; if (!t) return null;
  const n = L.teams.length, half = n / 2;
  const tr = t.tatTotalRank, fr = t.fcTotalRank, r = tr || fr;
  const ny = +L.season + 1;
  const ownNext = t.picks.includes(`k:${ny}:1:${t.rid}`), ownAfter = t.picks.includes(`k:${ny + 1}:1:${t.rid}`);
  const age = coreAge(L, t);
  const call = r <= half - 1 ? 'compete' : r > half + 1 ? 'teardown' : 'borderline';
  const why = [];
  why.push(`${tr ? 'TAT' : 'FC'} #${r} of ${n}` + (tr && fr ? `, FC #${fr}` : ''));
  if (call === 'borderline') why.push('right at the middle: pick a direction and commit');
  if (call !== 'compete') {
    if ((t.title ?? 0) >= 0.12) why.push(`${odds(t.title)} title odds now, so play this season out first`);
    if (!ownNext) why.push(`you don't own your ${ny} 1st, so losing gains nothing; sell vets for other teams' picks`);
    else why.push(`own ${ny} 1st` + (ownAfter ? ` and ${ny + 1} 1st` : '') + (L.draftOrder === 'record' ? ', draft goes by record so losing pays' : ', draft goes by max PF so shedding points pays'));
  }
  if (call !== 'teardown' && age) {
    if (age >= 27) why.push(`core is old (avg ${age.toFixed(1)}): win within 1-2 years`);
    else if (age <= 24.5) why.push(`young core (avg ${age.toFixed(1)}): the window opens later`);
  }
  return { call, r, tr, fr, n, age, ownNext, ownAfter, why };
}

export function strategyCard() {
  const mine = M.leagues.filter(L => L.me);
  const S = settings();
  const set = (L, patch) => {
    const cur = myCall(L) || {};
    const next = { ...cur, ...patch };
    S.macro = { ...(S.macro || {}) };
    if (!next.call && !next.note && !next.year) delete S.macro[L.id]; else S.macro[L.id] = next;
    save({ settingsChanged: true });
  };
  const rows = mine.map(L => {
    const rd = ruleRead(L), mc = myCall(L);
    const mySide = CALLS[mc?.call]?.side || 0, ruleSide = rd.call === 'compete' ? 1 : rd.call === 'teardown' ? -1 : 0;
    return { L, nick: L.nick, rd, mc, rank: rd.r / rd.n, clash: !!(mySide && ruleSide && mySide !== ruleSide && (mc.call !== 'tank' || rd.r <= 2)), title: L.me.title || 0 };
  });
  const tagFor = c => c === 'borderline' ? h('span', { class: 'tag mid' }, 'Borderline') : h('span', { class: 'tag ' + CALLS[c].cls }, CALLS[c].label);
  const tbl = table([
    { key: 'nick', label: 'League', n: false, fmt: (v, r) => h('a', { href: '#/league/' + r.L.id }, v) },
    { key: 'rank', label: 'Value rank', n: true, sort: r => -r.rank, fmt: (v, r) => `${r.rd.r} of ${r.rd.n}` },
    { key: 'rule', label: 'Rule says', n: false, sort: r => r.rd.call, fmt: (v, r) => h('div', {}, tagFor(r.rd.call), h('div', { class: 'muted small' }, r.rd.why.join('; '))) },
    { key: 'call', label: 'Your call', n: false, sort: r => r.mc?.call || '', fmt: (v, r) => h('div', { style: { minWidth: '210px' } },
      h('div', { class: 'row', style: { gap: '6px' } },
        h('select', { onchange: e => set(r.L, { call: e.target.value || undefined }) },
          h('option', { value: '', selected: !r.mc?.call }, 'not set'),
          Object.entries(CALLS).map(([k, c]) => h('option', { value: k, selected: r.mc?.call === k }, c.label))),
        h('input', { type: 'number', placeholder: 'window', title: 'First season you plan to contend', style: { width: '70px' }, value: r.mc?.year || '', onchange: e => set(r.L, { year: +e.target.value || undefined }) }),
        r.clash ? h('span', { class: 'tag bad', title: "Your call and the rule disagree. Fine if it's deliberate; worth a look if the numbers moved." }, 'check') : ''),
      h('textarea', { rows: 2, placeholder: 'why / the plan', style: { width: '100%', marginTop: '4px', fontSize: '12px' }, onchange: e => set(r.L, { note: e.target.value.trim() || undefined }) }, r.mc?.note || '')) },
  ], rows, { sortKey: 'rank', desc: false, rowClass: r => r.clash ? 'warnrow' : '' });
  const clashes = rows.filter(r => r.clash).length;
  return h('div', { class: 'card', style: { marginTop: '16px' } },
    h('div', { class: 'row spread' }, h('h3', {}, 'Macro strategy'), clashes ? h('span', { class: 'tag bad' }, `${clashes} to check`) : h('span', { class: 'muted small' }, 'calls match the rule')),
    h('div', { class: 'muted small', style: { marginBottom: '8px' } }, "Sanderson's rule: top half of league value competes, bottom half tears down for a quick rebuild, the middle is a trap. Rank is TAT where loaded, else FantasyCalc. Your call wins; 'check' means it disagrees with the current numbers. Re-read every February after the rookie draft."),
    tbl);
}
