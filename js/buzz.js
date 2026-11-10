// Podcast buzz: player takes from the dynasty podcasts (data/buzz.json, built daily by scripts/podcasts.py).
// Each take is the host's own words (a short verbatim quote) with the second it was said, so you can hear it.

let P = null;
export const loadBuzz = () => P || (P = fetch('data/buzz.json', { cache: 'no-cache' }).then(r => r.ok ? r.json() : null).catch(() => null));

export const POSITIVE = new Set(['buy', 'breakout']), NEGATIVE = new Set(['sell', 'bust']);
const DAY = 864e5;

// takes for one player in the last `days`, newest first
export function takesFor(B, pid, days = 30) {
  const cut = Date.now() - days * DAY;
  return (B?.takes || []).filter(t => t.pid === String(pid) && Date.parse(t.date) >= cut).sort((a, b) => b.date.localeCompare(a.date));
}

// per player: counts by stance, net lean (shows buying minus shows selling), one vote per show and episode
export function summary(B, days = 30) {
  const cut = Date.now() - days * DAY, out = {};
  for (const t of B?.takes || []) {
    if (Date.parse(t.date) < cut) continue;
    const s = out[t.pid] ||= { pid: t.pid, n: 0, by: {}, votes: new Map(), latest: t.date };
    s.n++; s.by[t.stance] = (s.by[t.stance] || 0) + 1;
    if (t.date > s.latest) s.latest = t.date;
    const v = POSITIVE.has(t.stance) ? 1 : NEGATIVE.has(t.stance) ? -1 : 0;
    const k = t.show + '|' + t.guid; s.votes.set(k, (s.votes.get(k) || 0) + v);
  }
  for (const s of Object.values(out)) {
    let up = 0, down = 0;
    for (const v of s.votes.values()) { if (v > 0) up++; else if (v < 0) down++; }
    s.up = up; s.down = down; s.net = up - down; delete s.votes;
  }
  return out;
}

// market move over the last ~4 weeks (DynastyProcess weekly history), as a share
export function marketMove(dp, pid, weeks = 4) {
  const row = dp?.sf?.[pid] || dp?.one?.[pid];
  if (!row || row.length <= weeks) return null;
  const a = row[row.length - 1 - weeks], b = row[row.length - 1];
  return a > 0 ? (b - a) / a : null;
}

// where the podcasts and the market disagree: that's where prices are about to move
export function disagreements(B, dp, days = 30) {
  const S = summary(B, days), out = [];
  for (const s of Object.values(S)) {
    const mv = marketMove(dp, s.pid);
    if (mv == null) continue;
    if (s.net >= 2 && mv <= -0.05) out.push({ ...s, mv, kind: 'buy-low', text: `${s.up} show${s.up > 1 ? 's' : ''} buying, value down ${Math.round(-mv * 100)}% in 4 weeks` });
    else if (s.net <= -2 && mv >= 0.05) out.push({ ...s, mv, kind: 'sell-high', text: `${s.down} show${s.down > 1 ? 's' : ''} selling, value up ${Math.round(mv * 100)}% in 4 weeks` });
  }
  return out.sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
}

// one line for a player, e.g. "Podcasts (30d): 3 buying, 1 selling"
// the market's price for a player in generic 1sts (FantasyCalc, your first superflex league if you have one)
export function marketIn1sts(M, pid) {
  const L = M.leagues.find(l => l.fmt?.numQbs === 2) || M.leagues[0];
  const v = L?.fc?.byId?.get(String(pid))?.value, first = L?.fc?.picks?.get(`${+L.season + 1} 1st`);
  return v && first ? v / first : null;
}
const DIR = { pay: 'Would pay', ask: 'Wants back', cap: 'Too high at' };
export const priceLabel = t => t.price ? `${DIR[t.price_dir] || 'Price'}: ${t.price}` : '';

export function buzzLine(B, pid, days = 30) {
  const s = summary(B, days)[String(pid)];
  if (!s) return '';
  const parts = [];
  if (s.up) parts.push(`${s.up} buying`);
  if (s.down) parts.push(`${s.down} selling`);
  if (!parts.length) parts.push(`${s.n} mention${s.n > 1 ? 's' : ''}`);
  const pr = takesFor(B, pid, days).find(t => t.price);
  return `Podcasts (${days}d): ${parts.join(', ')}${pr ? ` · ${priceLabel(pr)} (${pr.show})` : ''}`;
}

// A host's price in generic 1sts, on the Sanderson pick scale (a mid 1st = 1, a mid 2nd = 0.33):
// "a 1st and a young RB" -> 1 (+ a player we can't price), "a mid 2nd" -> 0.33, "3.05" -> a 3rd, "two 1sts" -> 2
const ROUND = { 1: { early: 1.3, mid: 1, late: 0.8 }, 2: { early: 0.45, mid: 0.33, late: 0.25 }, 3: { early: 0.15, mid: 0.12, late: 0.1 }, 4: { early: 0.06, mid: 0.05, late: 0.04 } };
const NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, couple: 2, pair: 2 };
const RD = { '1st': 1, first: 1, firsts: 1, '1sts': 1, '2nd': 2, second: 2, seconds: 2, '2nds': 2, '3rd': 3, third: 3, thirds: 3, '3rds': 3, '4th': 4, fourth: 4 };
export function priceIn1sts(text) {
  if (!text) return null;
  const s = text.toLowerCase().replace(/round\s+(\d)/g, (_, d) => ['', '1st', '2nd', '3rd', '4th'][d] || _);
  let total = 0, found = false;
  // slot notation: 1.05, 2.10, 3.05
  for (const m of s.matchAll(/\b([1-4])\.(\d{2})\b/g)) {
    const rd = +m[1], slot = +m[2], tier = slot <= 4 ? 'early' : slot <= 8 ? 'mid' : 'late';
    total += ROUND[rd][tier]; found = true;
  }
  const rest = s.replace(/\b[1-4]\.\d{2}\b/g, ' ');
  for (const m of rest.matchAll(/\b(?:(a|an|one|two|three|four|couple|pair|\d)\s+(?:of\s+)?)?(?:(early|mid|late|future)\s+)?(1sts?|2nds?|3rds?|4th|firsts?|seconds?|thirds?|fourth)\b/g)) {
    const n = NUM[m[1]] ?? (+m[1] || 1), tier = m[2] === 'early' || m[2] === 'late' ? m[2] : 'mid', rd = RD[m[3]];
    if (!rd) continue;
    total += n * ROUND[rd][tier]; found = true;
  }
  if (!found) return null;
  const partial = /\b(players?|rbs?|wrs?|tes?|qbs?|guys?|young|vet|veteran|starter|receiver|running back|tight end|quarterback)\b/.test(rest);
  return { firsts: Math.round(total * 100) / 100, partial };
}
