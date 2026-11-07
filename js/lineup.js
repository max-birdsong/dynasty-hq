// Scoring, lineup optimisation and per-week team projections.

export const SLOT_ELIG = {
  QB: ['QB'], RB: ['RB'], WR: ['WR'], TE: ['TE'], K: ['K'], DEF: ['DEF'],
  FLEX: ['RB', 'WR', 'TE'], WRRB_FLEX: ['RB', 'WR'], REC_FLEX: ['WR', 'TE'], SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  DL: ['DL', 'DE', 'DT'], LB: ['LB'], DB: ['DB', 'CB', 'S'], IDP_FLEX: ['DL', 'DE', 'DT', 'LB', 'DB', 'CB', 'S'],
};
const ORDER = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DL', 'LB', 'DB', 'REC_FLEX', 'WRRB_FLEX', 'FLEX', 'IDP_FLEX', 'SUPER_FLEX'];

export function startSlots(rosterPositions) {
  return rosterPositions.filter(s => SLOT_ELIG[s]).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
}

export function neededPositions(rosterPositions) {
  const s = new Set();
  for (const slot of startSlots(rosterPositions)) for (const p of SLOT_ELIG[slot]) if (['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].includes(p)) s.add(p);
  return [...s];
}

// Fantasy points from a projected stat line using the league's scoring settings
export function scoreStats(stats, scoring, pos) {
  if (!stats) return 0;
  let pts = 0, used = false;
  for (const [k, v] of Object.entries(stats)) {
    const w = scoring[k];
    if (w && typeof v === 'number') { pts += w * v; used = true; }
  }
  const rec = stats.rec || 0;
  if (pos === 'TE' && scoring.bonus_rec_te && stats.bonus_rec_te == null) pts += scoring.bonus_rec_te * rec;
  if (pos === 'RB' && scoring.bonus_rec_rb && stats.bonus_rec_rb == null) pts += scoring.bonus_rec_rb * rec;
  if (pos === 'WR' && scoring.bonus_rec_wr && stats.bonus_rec_wr == null) pts += scoring.bonus_rec_wr * rec;
  if (!used && stats.pts_ppr != null) pts = stats.pts_ppr;
  return pts;
}

// Greedy optimal lineup. pts: id -> points, posOf: id -> primary eligible positions
export function bestLineup(ids, pts, posOf, slots) {
  const avail = ids.filter(id => (pts[id] || 0) > 0).sort((a, b) => (pts[b] || 0) - (pts[a] || 0));
  const used = new Set(); let total = 0; const lineup = [];
  for (const slot of slots) {
    const el = SLOT_ELIG[slot];
    const pick = avail.find(id => !used.has(id) && posOf(id).some(p => el.includes(p)));
    if (pick) { used.add(pick); total += pts[pick] || 0; lineup.push([slot, pick]); }
    else lineup.push([slot, null]);
  }
  return { total, lineup, starters: used };
}
