import { h, fmt, sgn, pct, cls } from './util.js';

// cols: [{key, label, n:true(numeric), fmt:(v,row)=>node|string, sort:(row)=>val, title}]
export function table(cols, rows, { rowClass, onRow, sortKey, desc = true, id } = {}) {
  let sk = sortKey, sd = desc;
  const wrap = h('div', { class: 'tablewrap' });
  const draw = () => {
    const c = cols.find(c => c.key === sk);
    const data = c ? [...rows].sort((a, b) => {
      const va = c.sort ? c.sort(a) : a[c.key], vb = c.sort ? c.sort(b) : b[c.key];
      if (va == null) return 1; if (vb == null) return -1;
      return (va > vb ? 1 : va < vb ? -1 : 0) * (sd ? -1 : 1);
    }) : rows;
    const t = h('table', { id },
      h('thead', {}, h('tr', {}, cols.map(c => h('th', { class: c.n ? 'n' : '', title: c.title || '', onclick: () => { if (sk === c.key) sd = !sd; else { sk = c.key; sd = c.n !== false; } draw(); } }, c.label + (sk === c.key ? (sd ? ' ↓' : ' ↑') : ''))))),
      h('tbody', {}, data.map(r => h('tr', { class: [rowClass?.(r), onRow ? 'click' : ''].filter(Boolean).join(' '), onclick: onRow ? () => onRow(r) : null },
        cols.map(c => { const v = c.fmt ? c.fmt(r[c.key], r) : r[c.key]; return h('td', { class: c.n ? 'n' : '' }, v instanceof Node ? v : v ?? ''); })))));
    wrap.replaceChildren(t);
  };
  draw();
  return wrap;
}

export const posB = p => h('span', { class: 'posb ' + p }, p === 'PICK' ? 'PK' : p);
export const modeTag = m => h('span', { class: 'tag ' + m }, m === 'contend' ? 'Contending' : m === 'rebuild' ? 'Rebuilding' : 'Middle');
export const adviceTag = a => a ? h('span', { class: 'tag ' + a.cls, title: a.text }, a.tag) : '';
export const delta = (v, d = 0) => h('span', { class: cls(v) }, sgn(v, d));
export const pctBar = v => h('div', { class: 'cell-bar' }, pct(v), h('div', { class: 'bar' }, h('i', { style: { width: Math.round((v || 0) * 100) + '%' } })));

export function assetLine(a, extra) {
  return h('div', { class: 'asset' },
    h('span', { class: 'nm' }, posB(a.pos), a.name, a.age ? h('span', { class: 'muted small' }, ' ' + a.age.toFixed(1)) : '', a.inj ? h('span', { class: 'neg small' }, ' ' + a.inj) : ''),
    h('span', { class: 'muted small num' }, extra ?? `FC ${fmt(a.fc)} · TAT ${fmt(a.tat)}`));
}

export function empty(msg) { return h('div', { class: 'muted', style: { padding: '20px 0' } }, msg); }
export function heat(v) {
  if (v == null) return h('td', {}, '–');
  const c = v >= 0.8 ? 'rgba(19,131,75,.25)' : v >= 0.5 ? 'rgba(19,131,75,.12)' : v >= 0.2 ? 'rgba(183,121,31,.15)' : 'rgba(194,52,27,.12)';
  return h('td', {}, h('span', { class: 'heat', style: { background: c } }, Math.round(v * 100)));
}
