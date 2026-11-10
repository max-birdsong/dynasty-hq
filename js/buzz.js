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
export function buzzLine(B, pid, days = 30) {
  const s = summary(B, days)[String(pid)];
  if (!s) return '';
  const parts = [];
  if (s.up) parts.push(`${s.up} buying`);
  if (s.down) parts.push(`${s.down} selling`);
  if (!parts.length) parts.push(`${s.n} mention${s.n > 1 ? 's' : ''}`);
  return `Podcasts (${days}d): ${parts.join(', ')}`;
}
