// Parses Sanderson (TAT) dynasty ranking PDFs/text into ranked rows with tier keys.
// Pure functions so it runs in the browser and in node tests.

export function normQuotes(s) {
  return s.replace(/[“”„″]/g, '"').replace(/[‘’]/g, "'").replace(/ /g, ' ');
}

// Convert pdf.js text items into layout-like lines (similar to `pdftotext -layout`).
export function itemsToLines(pages) {
  const lines = [];
  for (const items of pages) {
    const rows = [];
    for (const it of items) {
      if (!it.str || !it.str.trim()) continue;
      let row = rows.find(r => Math.abs(r.y - it.y) < 2.5);
      if (!row) { row = { y: it.y, items: [] }; rows.push(row); }
      row.items.push(it);
    }
    rows.sort((a, b) => b.y - a.y);
    for (const r of rows) {
      r.items.sort((a, b) => a.x - b.x);
      let out = '', end = null;
      for (const it of r.items) {
        if (end !== null) {
          const gap = it.x - end;
          const cw = Math.max(2, (it.w || it.str.length * 5) / Math.max(1, it.str.length));
          const n = gap > cw * 1.6 ? Math.max(3, Math.round(gap / cw)) : gap > cw * 0.25 ? 1 : 0;
          out += ' '.repeat(n);
        }
        out += it.str;
        end = it.x + (it.w || it.str.length * 5);
      }
      lines.push(out);
    }
  }
  return lines;
}

// Tier header -> tier key. Quoted pick tiers are checked before numeric "BASE 1" tiers.
export function tierKey(line) {
  const s = normQuotes(line).toUpperCase().replace(/\s+/g, ' ');
  const i = s.indexOf('VALUE =');
  if (i < 0) return null;
  const seg = s.slice(i, i + 60);
  if (/4 OR BELOW/.test(seg)) return 'R4';
  for (const [re, k] of [[/"LATE" ?1/, 'L1'], [/"EARLY" ?2/, 'E2'], [/"BASE" ?2/, 'B2'], [/"LATE" ?2/, 'L2'],
    [/"EARLY" ?3/, 'E3'], [/"BASE" ?3/, 'B3'], [/"LATE" ?3/, 'L3']]) if (re.test(seg)) return k;
  const m = seg.match(/VALUE = ([\d.]+) BASE 1/);
  if (m) return 'X' + parseFloat(m[1]);
  return null;
}

const ROW = /^\s*(\d{1,3})\s+(.+?)\s{2,}(QB|RB|WR|TE)\s+([A-Z]{2,3})?\s*(.*)$/;
const MOVE = /(Up|Down) \d+ Tiers?|New Add|Returning/i;

export function parseLines(lines) {
  const rows = []; let tier = null; let stop = false;
  for (const raw of lines) {
    const line = normQuotes(raw);
    if (/REMOVED FROM RANKINGS/i.test(line)) stop = true;
    if (stop) continue;
    const tk = tierKey(line);
    if (tk) { tier = tk; continue; }
    const m = line.match(ROW);
    if (m && tier) {
      const rest = m[5] || '';
      const mv = (rest.match(MOVE) || [''])[0];
      const rank = +m[1];
      if (rows.some(r => r.rank === rank)) continue;
      rows.push({ rank, name: m[2].trim(), pos: m[3], team: m[4] || '', tier, move: mv });
    }
  }
  rows.sort((a, b) => a.rank - b.rank);
  return rows;
}

// CSV fallback: columns rank,name,pos,tier  (tier = key like X2, L1, E2 ... or a number of base 1sts)
export function parseCsv(text) {
  const out = [];
  const lines = text.trim().split(/\r?\n/);
  const head = lines[0].toLowerCase().split(/[;,\t]/).map(s => s.trim());
  const ix = k => head.indexOf(k);
  for (const l of lines.slice(1)) {
    const c = l.split(/[;,\t]/).map(s => s.trim().replace(/^"|"$/g, ''));
    let t = c[ix('tier')] || '';
    if (/^[\d.]+$/.test(t)) t = 'X' + parseFloat(t);
    out.push({ rank: +c[ix('rank')], name: c[ix('name')], pos: (c[ix('pos')] || '').toUpperCase(), team: '', tier: t, move: c[ix('move')] || '' });
  }
  return out.filter(r => r.name && r.tier);
}

// Values for each tier key given a pick-value lookup (FantasyCalc pick names) and draft year.
export function tierValues(pickVal, year) {
  const g = n => pickVal(`${year} ${n}`);
  const B = g('1st');
  return k => {
    if (k[0] === 'X') return parseFloat(k.slice(1)) * B;
    return { L1: g('1st (Late)'), E2: g('2nd (Early)'), B2: g('2nd'), L2: g('2nd (Late)'), E3: g('3rd (Early)'), B3: g('3rd'), L3: g('3rd (Late)'), R4: g('4th') }[k] || 0;
  };
}

// Interpolate within tiers: top of tier sits halfway to the tier above, bottom halfway to the tier below.
export function valueRows(rows, tv) {
  const vals = [...new Set(rows.map(r => tv(r.tier)))].sort((a, b) => b - a);
  const groups = new Map();
  for (const r of rows) { const v = tv(r.tier); if (!groups.has(v)) groups.set(v, []); groups.get(v).push(r); }
  const out = new Map();
  for (const [v, g] of groups) {
    const i = vals.indexOf(v);
    const hi = i > 0 ? (vals[i - 1] + v) / 2 : v * 1.15;
    const lo = i + 1 < vals.length ? (vals[i + 1] + v) / 2 : v * 0.6;
    g.forEach((r, j) => out.set(r.rank, hi - (hi - lo) * (j + 0.5) / g.length));
  }
  return out; // rank -> value
}

export function normName(s) {
  s = (s || '').toLowerCase().trim().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
  const alias = { 'nick singleton': 'nicholas singleton', 'kenneth gainwell': 'kenny gainwell', 'demario douglas': 'demario douglas',
    'jk dobbins': 'jk dobbins', 'cj stroud': 'cj stroud', 'dj moore': 'dj moore' };
  return alias[s] || s;
}
