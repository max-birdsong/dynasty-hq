import { M, refreshValues } from '../model.js';
import { state, settings, save, addTatSet, deleteTatSet } from '../state.js';
import { itemsToLines, parseLines, parseCsv } from '../tatparse.js';
import { h, fmt, sgn, toast } from '../util.js';
import { table, posB, empty } from '../components.js';

const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.min.mjs';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs';

async function readPdf(file) {
  const pdfjs = await import(PDFJS);
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    pages.push(tc.items.map(i => ({ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width })));
  }
  return parseLines(itemsToLines(pages));
}

export default function valuesView() {
  const S = state(), st = settings();
  const root = h('div');
  // ---- upload ----
  const label = h('input', { placeholder: 'Label, e.g. Post-Week 8', value: '' });
  const file = h('input', { type: 'file', accept: '.pdf,.csv,.txt' });
  const msg = h('div', { class: 'small muted' });
  const upload = async () => {
    const f = file.files[0]; if (!f) return toast('Choose the TAT PDF first', 'err');
    msg.textContent = 'Reading…';
    try {
      const rows = /\.pdf$/i.test(f.name) ? await readPdf(f) : parseCsv(await f.text());
      if (rows.length < 50) throw new Error(`only found ${rows.length} players. Is this the TAT rankings PDF?`);
      const lbl = label.value || f.name.replace(/\.[^.]+$/, '').replace(/_/g, ' ');
      addTatSet(rows, lbl);
      refreshValues();
      msg.textContent = `Loaded ${rows.length} players${M.tatUnmatched?.length ? `. Couldn't match: ${M.tatUnmatched.join(', ')}` : ''}.`;
      toast('Sanderson values updated');
      setTimeout(() => window.DHQ.route(), 1200);
    } catch (e) { console.error(e); msg.textContent = 'Failed: ' + e.message; }
  };
  root.append(h('div', { class: 'panel' }, h('h2', {}, 'Sanderson (TAT) rankings'),
    h('div', { class: 'row' }, file, label, h('button', { class: 'btn', onclick: upload }, 'Upload')),
    h('div', { class: 'muted small', style: { marginTop: '6px' } }, 'Drop in the weekly TAT PDF as-is. Tiers are converted to values using each league\'s FantasyCalc pick values, interpolated within tiers. A CSV with columns rank,name,pos,tier also works.'),
    msg,
    S.tatSets.length ? h('div', { class: 'row', style: { marginTop: '10px', gap: '6px' } }, S.tatSets.map(s => h('span', { class: 'tag' }, `${s.label} (${s.date}, ${s.rows.length})`,
      h('a', { href: 'javascript:void 0', style: { marginLeft: '6px' }, onclick: () => { if (confirm('Remove ' + s.label + '?')) { deleteTatSet(s.id); refreshValues(); window.DHQ.route(); } } }, '✕')))) : ''));

  // ---- movers between the last two TAT sets ----
  if (S.tatSets.length >= 2) {
    const [a, b] = S.tatSets.slice(-2);
    const prev = new Map(a.rows.map(r => [r.name, r.rank]));
    const moves = b.rows.map(r => ({ ...r, was: prev.get(r.name), d: prev.has(r.name) ? prev.get(r.name) - r.rank : null })).filter(r => r.d != null && Math.abs(r.d) >= 4);
    const up = moves.filter(r => r.d > 0).sort((x, y) => y.d - x.d).slice(0, 12), dn = moves.filter(r => r.d < 0).sort((x, y) => x.d - y.d).slice(0, 12);
    const li = arr => h('div', { class: 'assets' }, arr.map(r => h('div', { class: 'asset' }, h('span', {}, posB(r.pos), r.name, h('span', { class: 'muted small' }, ` #${r.was} → #${r.rank}`)), h('span', { class: r.d > 0 ? 'pos' : 'neg' }, sgn(r.d)))));
    root.append(h('div', { class: 'grid g2' }, h('div', { class: 'panel' }, h('h2', {}, `Risers since ${a.label}`), li(up)), h('div', { class: 'panel' }, h('h2', {}, 'Fallers'), li(dn))));
  }

  // ---- player table (12-team SF scale) ----
  const L0 = M.leagues.find(L => L.fmt.key === '12-2-1') || M.leagues[0];
  if (!L0) return root;
  const owned = new Map();
  for (const L of M.leagues) if (L.me) for (const id of L.me.players) (owned.get(id) || owned.set(id, []).get(id)).push(L.nick);
  const fc = M.fc['12-2-1'] || L0.fc;
  const tatOf = id => L0.tatMap?.get(id);
  const ids = new Set([...fc.byId.keys(), ...(L0.tatMap ? L0.tatMap.keys() : [])]);
  const targets = new Set(st.targets.map(String)), untouch = new Set(st.untouchable.map(String));
  let rows = [...ids].map(id => {
    const f = fc.byId.get(id), p = M.players[id] || {};
    const t = tatOf(id);
    return { id, name: p.full_name || f?.name || id, pos: p.position || f?.pos, age: f?.age ?? p.age, team: p.team, fc: f?.value || 0, tat: t, gap: t != null ? t - (f?.value || 0) : null,
      rank: L0.tatRank?.get(id), move: L0.tatMove?.get(id) || '', trend: f?.trend || 0, owned: owned.get(id) || [] };
  }).filter(r => ['QB', 'RB', 'WR', 'TE'].includes(r.pos) && (r.fc > 400 || r.tat));
  const filt = { mine: false, pos: '', q: '' };
  const holder = h('div');
  const draw = () => {
    const data = rows.filter(r => (!filt.mine || r.owned.length) && (!filt.pos || r.pos === filt.pos) && (!filt.q || r.name.toLowerCase().includes(filt.q)));
    holder.replaceChildren(table([
      { key: 'star', label: '★', n: false, sort: r => targets.has(r.id) ? 1 : 0, fmt: (v, r) => h('span', { class: 'star' + (targets.has(r.id) ? ' on' : ''), title: 'Trade target', onclick: e => { e.stopPropagation(); toggle(st.targets, targets, r.id); e.target.classList.toggle('on'); } }, '★') },
      { key: 'lock', label: '🔒', n: false, sort: r => untouch.has(r.id) ? 1 : 0, fmt: (v, r) => h('span', { class: 'star' + (untouch.has(r.id) ? ' on' : ''), title: 'Untouchable (never offered)', onclick: e => { e.stopPropagation(); toggle(st.untouchable, untouch, r.id); e.target.classList.toggle('on'); } }, '🔒') },
      { key: 'name', label: 'Player', n: false, fmt: (v, r) => h('span', {}, posB(r.pos), v, h('span', { class: 'muted small' }, ' ' + (r.team || ''))) },
      { key: 'age', label: 'Age', n: true, fmt: v => fmt(v, 1) },
      { key: 'fc', label: 'FC', n: true, fmt: v => fmt(v) },
      { key: 'tat', label: 'TAT', n: true, fmt: v => fmt(v) },
      { key: 'gap', label: 'Gap', n: true, fmt: v => h('span', { class: v > 0 ? 'pos' : v < 0 ? 'neg' : '' }, sgn(v)) },
      { key: 'rank', label: 'TAT #', n: true, sort: r => r.rank ? -r.rank : null, fmt: (v, r) => v ? h('span', {}, v, r.move ? h('span', { class: /Up|New/.test(r.move) ? 'pos small' : 'neg small' }, ' ' + r.move) : '') : '–' },
      { key: 'trend', label: 'FC 30d', n: true, fmt: v => h('span', { class: v > 0 ? 'pos' : v < 0 ? 'neg' : '' }, sgn(v)) },
      { key: 'owned', label: 'You own in', n: false, sort: r => r.owned.length, fmt: v => v.join(', ') },
    ], data, { sortKey: 'fc' }));
  };
  root.append(h('div', { class: 'panel' },
    h('div', { class: 'row spread', style: { marginBottom: '10px' } }, h('h2', { style: { margin: 0 } }, 'FantasyCalc vs Sanderson'),
      h('div', { class: 'row' },
        h('input', { placeholder: 'Search player', oninput: e => { filt.q = e.target.value.toLowerCase(); draw(); } }),
        h('select', { onchange: e => { filt.pos = e.target.value; draw(); } }, ['', 'QB', 'RB', 'WR', 'TE'].map(p => h('option', { value: p }, p || 'All positions'))),
        h('label', { class: 'small' }, h('input', { type: 'checkbox', onchange: e => { filt.mine = e.target.checked; draw(); } }), ' Only my players'))),
    h('div', { class: 'muted small', style: { marginBottom: '8px' } }, 'Values on the 12-team superflex scale. ★ = trade target (suggestions prioritise them), 🔒 = never offer.'),
    holder));
  draw();
  return root;
}

function toggle(arr, set, id) {
  if (set.has(id)) { set.delete(id); arr.splice(arr.indexOf(id), 1); } else { set.add(id); arr.push(id); }
  save({ settingsChanged: true });
}
