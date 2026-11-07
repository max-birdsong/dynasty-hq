// Trade evaluation (FantasyCalc + waiver adjustment, Sanderson gain, full lineup impact) and suggestion search.
import { M, asset, teamAssets, teamWeekly, teamInj, startersNow, simInput, simParams, isPick, pid } from './model.js';
import { settings, state } from './state.js';
import { simulate } from './sim.js';
import { sum } from './util.js';

// FantasyCalc-style consolidation adjustment: the side giving fewer pieces gets credit
// for the k smallest pieces on the bigger side.
export function waiverAdj(vals, k) {
  const { pct, base, scalar } = settings().adj;
  return sum([...vals].sort((a, b) => a - b).slice(0, k).map(v => Math.min(v * pct, base + v * scalar)));
}

export function fcSides(giveVals, getVals) {
  let A = sum(giveVals), B = sum(getVals), adjA = 0, adjB = 0;
  if (giveVals.length > getVals.length) { adjB = waiverAdj(giveVals, giveVals.length - getVals.length); B += adjB; }
  else if (getVals.length > giveVals.length) { adjA = waiverAdj(getVals, getVals.length - giveVals.length); A += adjA; }
  return { A, B, adjA, adjB, partnerMargin: A - B };
}

function rosterAfter(t, outKeys, inKeys) {
  const out = new Set(outKeys.filter(k => !isPick(k)).map(pid));
  return [...t.players.filter(id => !out.has(id)), ...inKeys.filter(k => !isPick(k)).map(pid)];
}
const mean = (wk, weeks) => { const v = weeks.map(w => wk[w]).filter(x => x != null); return v.length ? sum(v) / v.length : 0; };

export function lineupImpact(L, t, outKeys, inKeys) {
  const before = L.weekly[t.rid];
  const after = teamWeekly(L, rosterAfter(t, outKeys, inKeys));
  const po = []; for (let w = L.playoffStart; w <= M.lastWeek; w++) po.push(w);
  const reg = L.regWeeks.length ? L.regWeeks : po;
  return { rosBefore: mean(before, reg), rosAfter: mean(after, reg), poBefore: mean(before, po), poAfter: mean(after, po), after, ids: rosterAfter(t, outKeys, inKeys) };
}

export function evalTrade(L, partner, giveKeys, getKeys, { lineups = true } = {}) {
  const give = giveKeys.map(k => asset(L, k)), get = getKeys.map(k => asset(L, k));
  const fc = fcSides(give.map(a => a.fc), get.map(a => a.fc));
  const tatGain = sum(get.map(a => a.tat)) - sum(give.map(a => a.tat));
  const r = { L, partner, giveKeys, getKeys, give, get, fc, tatGain, flags: [] };
  if (lineups && L.me) {
    r.me = lineupImpact(L, L.me, giveKeys, getKeys);
    r.them = lineupImpact(L, partner, getKeys, giveKeys);
    // starting QB check for the partner
    const theirStart = startersNow(L, partner.players).starters;
    const qbOut = getKeys.filter(k => !isPick(k) && theirStart.has(pid(k)) && M.players[pid(k)]?.position === 'QB');
    if (qbOut.length) {
      const afterStart = startersNow(L, rosterAfter(partner, getKeys, giveKeys)).starters;
      const qbIn = giveKeys.filter(k => !isPick(k) && afterStart.has(pid(k)) && M.players[pid(k)]?.position === 'QB');
      r.takesStartingQb = qbIn.length < qbOut.length;
    }
  }
  r.flags = checkRules(L, partner, r);
  r.memory = tradeMemory(L, partner, giveKeys, getKeys);
  return r;
}

export function checkRules(L, partner, r) {
  const R = settings().rules, f = [];
  const mode = partner.mode;
  const need = mode === 'rebuild' ? R.rebuilderFcMargin * Math.max(r.fc.A, r.fc.B) : 0;
  if (r.fc.partnerMargin < need) f.push({ bad: true, msg: mode === 'rebuild' ? `Rebuilder needs a clear FC win (≥ +${Math.round(need)})` : 'Partner loses on FantasyCalc' });
  if (mode === 'rebuild') {
    for (const a of r.give) if (!a.pick && (a.age || 0) >= R.rebuildMaxAge) f.push({ bad: true, msg: `${a.name} is ${Math.floor(a.age)}: rebuilders won't want him` });
  }
  if (mode !== 'contend') for (const a of r.give) if (a.pos === 'RB' && (a.age || 0) >= R.oldRbAge) f.push({ bad: true, msg: `Old RB ${a.name} to a non-contender` });
  if (r.them && mode === 'contend' && r.them.rosAfter < r.them.rosBefore - R.contenderMaxDrop) f.push({ bad: true, msg: `Contender loses ${(r.them.rosBefore - r.them.rosAfter).toFixed(1)} pts/wk` });
  if (r.takesStartingQb && mode !== 'rebuild') f.push({ bad: true, msg: 'Takes their starting QB without one going back' });
  if (r.me && L.me && ['push', 'mid'].includes(L.me.advice?.cls)) {
    const d = Math.max(r.me.rosBefore - r.me.rosAfter, r.me.poBefore - r.me.poAfter);
    if (d > R.myMaxDrop) f.push({ bad: true, msg: `Your lineup drops ${d.toFixed(1)} pts/wk while contending` });
  }
  if (r.tatGain < 0) f.push({ bad: false, msg: 'Sanderson loss' });
  return f;
}

// What happened with similar offers before
export function tradeMemory(L, partner, giveKeys, getKeys) {
  const past = state().trades.filter(t => t.leagueId === L.id && t.partnerOwnerId === partner.ownerId);
  const same = past.find(t => sameSet(t.give, giveKeys) && sameSet(t.get, getKeys));
  const overlap = past.filter(t => t.status !== 'accepted' && t.get.some(k => getKeys.includes(k)));
  return { same, overlap };
}
const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));

// Re-simulate the league with both rosters changed
export function simDelta(L, r, runs = 3000) {
  const params = simParams();
  const drops = { [L.me.rid]: teamInj(L, r.me.ids), [r.partner.rid]: teamInj(L, r.them.ids) };
  const after = simulate(simInput(L, { [L.me.rid]: r.me.after, [r.partner.rid]: r.them.after }, drops), { runs, params, seed: 12345 });
  const before = simulate(simInput(L), { runs, params, seed: 12345 });
  return { me: [before[L.me.rid], after[L.me.rid]], them: [before[r.partner.rid], after[r.partner.rid]] };
}

// ---------------- suggestions ----------------
function combos(arr, k) {
  if (k === 1) return arr.map(x => [x]);
  const out = [];
  for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) out.push([arr[i], arr[j]]);
  return out;
}

export function suggest(L, { partners = null, targets = null, maxPerPartner = 8, limit = 30, poolSize = 14 } = {}) {
  if (!L.me) return [];
  const S = settings(), R = S.rules;
  const untouch = new Set(S.untouchable.map(String));
  const tg = new Set((targets || S.targets).map(String));
  const mine = teamAssets(L, L.me).filter(a => a.fc > 250 && !(a.id && untouch.has(a.id))).sort((a, b) => b.fc - a.fc).slice(0, poolSize);
  const out = [];
  for (const p of L.teams) {
    if (p.isMe || (partners && !partners.includes(p.rid))) continue;
    const theirs = teamAssets(L, p).filter(a => a.fc > 250).sort((a, b) => b.fc - a.fc).slice(0, poolSize);
    const cands = [];
    for (const gs of [1, 2]) for (const ts of [1, 2]) {
      const G = combos(mine, gs), T = combos(theirs, ts);
      for (const g of G) for (const t of T) {
        const fc = fcSides(g.map(a => a.fc), t.map(a => a.fc));
        const tat = sum(t.map(a => a.tat)) - sum(g.map(a => a.tat));
        if (tat < R.minTatGain) continue;
        const need = p.mode === 'rebuild' ? R.rebuilderFcMargin * Math.max(fc.A, fc.B) : 0;
        if (fc.partnerMargin < need || fc.partnerMargin > need + 0.3 * fc.B + 400) continue;
        if (p.mode === 'rebuild' && g.some(a => !a.pick && (a.age || 0) >= R.rebuildMaxAge)) continue;
        if (p.mode !== 'contend' && g.some(a => a.pos === 'RB' && (a.age || 0) >= R.oldRbAge)) continue;
        const bonus = t.some(a => a.id && tg.has(a.id)) ? 1500 : 0;
        cands.push({ g, t, tat, score: tat + bonus - 0.3 * Math.max(0, fc.partnerMargin - need) });
      }
    }
    cands.sort((a, b) => b.score - a.score);
    let kept = 0;
    for (const c of cands.slice(0, 80)) {
      const r = evalTrade(L, p, c.g.map(a => a.key), c.t.map(a => a.key));
      if (r.flags.some(f => f.bad)) continue;
      if (r.memory.same && ['rejected', 'ignored', 'withdrawn'].includes(r.memory.same.status)) continue;
      r.score = c.score; out.push(r);
      if (++kept >= maxPerPartner) break;
    }
  }
  // keep the list varied: each asset appears in at most two suggestions
  const used = new Map(), final = [];
  for (const r of out.sort((a, b) => b.score - a.score)) {
    const keys = [...r.giveKeys, ...r.getKeys];
    if (keys.some(k => (used.get(k) || 0) >= 2)) continue;
    keys.forEach(k => used.set(k, (used.get(k) || 0) + 1));
    final.push(r);
    if (final.length >= limit) break;
  }
  return final;
}
