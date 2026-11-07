export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return e;
}

export const fmt = (n, d = 0) => (n == null || isNaN(n)) ? '–' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
export const sgn = (n, d = 0) => (n == null || isNaN(n)) ? '–' : (n > 0 ? '+' : n < 0 ? '−' : '') + fmt(Math.abs(n), d);
export const pct = n => (n == null || isNaN(n)) ? '–' : Math.round(n * 100) + '%';
export const cls = (n, eps = 0) => n > eps ? 'pos' : n < -eps ? 'neg' : '';
export const sum = a => a.reduce((s, x) => s + (x || 0), 0);
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const today = () => new Date().toISOString().slice(0, 10);
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export function ageOf(p) {
  if (!p) return null;
  if (p.birth_date) return (Date.now() - new Date(p.birth_date)) / 31557600000;
  return p.age ?? null;
}

// Gaussian sample (Box-Muller)
export function randn() {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Run tasks with limited concurrency
export async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// Tiny inline SVG line chart. series: [{name, color, points:[[x,y],...]}]
export function lineChart(series, { w = 560, h: H = 180, yFmt = v => fmt(v), xLabels = null, yMin = null, yMax = null } = {}) {
  const pts = series.flatMap(s => s.points);
  if (!pts.length) return h0('div', 'muted small', 'No history yet. It builds up week by week.');
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = yMin ?? Math.min(...ys), y1 = yMax ?? Math.max(...ys);
  if (y0 === y1) { y0 -= 1; y1 += 1; }
  const L = 52, R = 10, T = 10, B = 24;
  const sx = x => L + (x1 === x0 ? (w - L - R) / 2 : (x - x0) / (x1 - x0) * (w - L - R));
  const sy = y => T + (1 - (y - y0) / (y1 - y0)) * (H - T - B);
  let svg = `<svg viewBox="0 0 ${w} ${H}" class="chart" role="img">`;
  for (let i = 0; i <= 3; i++) {
    const v = y0 + (y1 - y0) * i / 3, y = sy(v);
    svg += `<line x1="${L}" x2="${w - R}" y1="${y}" y2="${y}" class="grid"/><text x="${L - 6}" y="${y + 4}" class="axis" text-anchor="end">${yFmt(v)}</text>`;
  }
  const xt = [...new Set(xs)].sort((a, b) => a - b);
  const step = Math.ceil(xt.length / 8);
  xt.forEach((x, i) => { if (i % step === 0) svg += `<text x="${sx(x)}" y="${H - 6}" class="axis" text-anchor="middle">${xLabels ? xLabels(x) : x}</text>`; });
  for (const s of series) {
    const p = [...s.points].sort((a, b) => a[0] - b[0]);
    if (!p.length) continue;
    svg += `<polyline fill="none" stroke="${s.color}" stroke-width="${s.width || 2}" points="${p.map(q => sx(q[0]) + ',' + sy(q[1])).join(' ')}"/>`;
    for (const q of p) svg += `<circle cx="${sx(q[0])}" cy="${sy(q[1])}" r="${s.width > 2 ? 3 : 2}" fill="${s.color}"><title>${s.name}: ${yFmt(q[1])}</title></circle>`;
  }
  svg += '</svg>';
  const legend = series.length > 1 ? `<div class="legend">${series.map(s => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join('')}</div>` : '';
  return h('div', { class: 'chartwrap', html: svg + legend });
}
function h0(tag, c, t) { const e = document.createElement(tag); e.className = c; e.textContent = t; return e; }

export const PALETTE = ['#2f7dd1', '#d1562f', '#2fa36b', '#9a5bd1', '#d1a12f', '#2fb4c4', '#c43f86', '#6b7a2f', '#7d5a3c', '#4a5bd1', '#8a8a8a', '#c4c42f'];

export function toast(msg, kind = '') {
  const t = h('div', { class: 'toast ' + kind }, msg);
  document.body.append(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3200);
}
