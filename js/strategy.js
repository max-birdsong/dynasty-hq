// Macro strategy per league: Sanderson's rule (top half of league value competes, bottom half tears down for a
// quick rebuild, the middle is a trap), read from current TAT and FantasyCalc ranks, next to your own call.
// Your call always wins; the rule's read is there to flag when the numbers have moved enough to rethink it.
import { M, teamAssets } from './model.js';
import { settings, save } from './state.js';
import { h, odds } from './util.js';

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

function clashOf(L) {
  const rd = ruleRead(L), mc = myCall(L);
  const mySide = CALLS[mc?.call]?.side || 0, ruleSide = rd.call === 'compete' ? 1 : rd.call === 'teardown' ? -1 : 0;
  return { rd, mc, clash: !!(mySide && ruleSide && mySide !== ruleSide && (mc.call !== 'tank' || rd.r <= 2)) };
}
const ruleTag = c => c === 'borderline' ? h('span', { class: 'tag mid' }, 'Borderline') : h('span', { class: 'tag ' + CALLS[c].cls }, CALLS[c].label);

// one line for the dashboard card: your multi-year plan (or the rule's read if you haven't set one)
export function planChip(L) {
  if (!L.me) return '';
  const { rd, mc, clash } = clashOf(L);
  const tip = `Rule: ${rd.call}. ${rd.why.join('; ')}` + (mc?.note ? `\nPlan: ${mc.note}` : '');
  return h('div', { class: 'row small', title: tip, style: { gap: '6px', marginTop: '6px', flexWrap: 'wrap' } },
    h('span', { class: 'muted' }, 'Plan'),
    mc?.call ? h('span', { class: 'tag ' + CALLS[mc.call].cls }, CALLS[mc.call].label + (mc.year ? ` → ${mc.year}` : '')) : h('span', { class: 'muted' }, 'not set, rule says'), mc?.call ? '' : ruleTag(rd.call),
    clash ? h('span', { class: 'tag bad' }, 'check') : '');
}

// editor for the league page
export function strategyPanel(L) {
  if (!L.me) return '';
  const S = settings();
  const { rd, mc, clash } = clashOf(L);
  const set = patch => {
    const next = { ...(myCall(L) || {}), ...patch };
    S.macro = { ...(S.macro || {}) };
    if (!next.call && !next.note && !next.year) delete S.macro[L.id]; else S.macro[L.id] = next;
    save({ settingsChanged: true });
  };
  return h('div', { class: 'panel' },
    h('div', { class: 'row spread' }, h('h3', {}, 'Multi-year plan'), clash ? h('span', { class: 'tag bad', title: "Your call disagrees with the current value rank. Fine if deliberate." }, 'check') : ''),
    h('div', { class: 'small', style: { margin: '4px 0 8px' } }, h('span', { class: 'muted' }, "Sanderson's rule: "), ruleTag(rd.call), ' ', h('span', { class: 'muted' }, rd.why.join('; ') + '.')),
    h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } },
      h('select', { onchange: e => set({ call: e.target.value || undefined }) },
        h('option', { value: '', selected: !mc?.call }, 'Your call: not set'),
        Object.entries(CALLS).map(([k, c]) => h('option', { value: k, selected: mc?.call === k }, c.label))),
      h('input', { type: 'number', placeholder: 'contend from', title: 'First season you plan to contend', style: { width: '110px' }, value: mc?.year || '', onchange: e => set({ year: +e.target.value || undefined }) })),
    h('textarea', { rows: 3, placeholder: 'why / the plan', style: { width: '100%', boxSizing: 'border-box', marginTop: '6px', fontSize: '13px' }, onchange: e => set({ note: e.target.value.trim() || undefined }) }, mc?.note || ''));
}
