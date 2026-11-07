// Trade evaluation (FantasyCalc + waiver adjustment, Sanderson gain, full lineup impact) and suggestion search.
import { M, asset, teamAssets, teamWeekly, teamInj, startersNow, simInput, simParams, isPick, pid, expectedFromDist, mixOf } from './model.js';
import { settings, state } from './state.js';
import { simulate } from './sim.js';
import { teamPlan, winNowValue } from './plan.js';
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

// How the partner sees a next-year pick: by where today's standings say it lands, not where the simulator
// expects it to finish. A 5-3 team with a weak roster prices its 1st as a mid pick; that gap is a "diamond".
export function perceived(a, partner) {
  let v = a.pick && a.slot && a.fcLooks ? a.fcLooks : a.fc;
  // micro-market: in leagues where picks have traded above or below market, owners price them that way
  if (a.pick && partner?._pickIndex) v *= partner._pickIndex;
  return v;
}

// Sanderson's four reasons to trade. Only the first is zero-sum.
export function tradeType(L, r) {
  const p = r.partner, me = L.me;
  const players = xs => xs.filter(a => !a.pick);
  const gp = players(r.get), vp = players(r.give);
  const myNeeds = L.posNeeds?.[me.rid], theirNeeds = L.posNeeds?.[p.rid];
  // parallel timeline: one side moves value into this season, the other into future seasons
  const myNow = r.mix.now, theirNow = -r.mix.now, myFut = r.mix.future + r.mix.picks;
  if ((myNow > 300 && myFut < -300) || (myNow < -300 && myFut > 300)) return { id: 'timeline', label: 'Parallel timeline', tip: 'You move value into a different season than they do. Both can win.' };
  // parallel need: I get a position I'm short at, they get one they're short at
  if (myNeeds && theirNeeds && gp.some(a => myNeeds.holes.includes(a.pos)) && vp.some(a => theirNeeds.holes.includes(a.pos))) return { id: 'need', label: 'Parallel need', tip: 'Each side fills a hole. Both can win.' };
  // mutual benefit: consolidation by the deeper team (depth is worth less to them than a star)
  if (r.give.length > r.get.length || r.get.length > r.give.length) return { id: 'mutual', label: 'Consolidation', tip: 'One side turns depth into a better starter; the other gets depth it can use. Both can improve relative to the league.' };
  // preference: same kind of asset for same kind of asset; a bet on whose evaluation is right
  if (gp.length === 1 && vp.length === 1 && gp[0].pos === vp[0].pos && Math.abs((gp[0].age || 0) - (vp[0].age || 0)) < 2.5) return { id: 'preference', label: 'Preference (zero-sum)', tip: 'Like-for-like swap: you are betting your evaluation beats theirs. Rarely accepted; only worth it on a clear edge.' };
  return { id: 'other', label: 'Value', tip: '' };
}

export function evalTrade(L, partner, giveKeys, getKeys, { lineups = true } = {}) {
  const give = giveKeys.map(k => asset(L, k)), get = getKeys.map(k => asset(L, k));
  const fc = fcSides(give.map(a => a.fc), get.map(a => perceived(a, partner)));
  const tatGain = sum(get.map(a => a.tat)) - sum(give.map(a => a.tat));
  const r = { L, partner, giveKeys, getKeys, give, get, fc, tatGain, flags: [] };
  // how the trade shifts your three currencies (picks / this season's production / future years)
  const mg = mixOf(get), mv = mixOf(give);
  r.mix = { picks: mg.picks - mv.picks, now: mg.now - mv.now, future: mg.future - mv.future };
  const x = r.mix, big = Math.max(Math.abs(x.picks), Math.abs(x.now), Math.abs(x.future));
  r.mixLabel = big < 200 ? 'Balanced swap'
    : x.now > 0 && x.future < 0 && x.now >= Math.abs(x.picks) ? 'Buying points (vets)'
    : x.picks > 0 && x.picks === big ? 'Banking picks'
    : x.future > 0 && x.future === big ? 'Adding future value (EYR, fragile)'
    : x.picks < 0 && x.picks === -big ? 'Spending picks'
    : x.now < 0 && x.future > 0 ? 'Selling points for youth' : 'Mixed';
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
  r.type = tradeType(L, r);
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
  if (r.tatGain < 0) f.push({ bad: false, msg: 'Sanderson loss' });
  // don't hand out your own diamond
  for (const a of r.give) {
    if (!a.pick || a.orig !== L.me?.rid) continue;
    if (a.slot && a.looksSlot && a.slot < a.looksSlot - 1.5) f.push({ bad: false, warn: true, msg: `Careful: your ${a.short.split(' (')[0]} looks like pick #${a.looksSlot} from the standings, but the simulator has it around #${Math.round(a.slot)}. It's worth ${Math.round(a.fc).toLocaleString()}, not the ${Math.round(a.fcLooks).toLocaleString()} it looks like.` });
    if (a.futureSlot && a.futureSlot <= Math.ceil(L.teams.length / 3)) f.push({ bad: false, warn: true, msg: `Careful: once age is factored in your roster ranks ${L.teams.length - a.futureSlot + 1} of ${L.teams.length} for next year, so your ${a.short} is likely an early pick (≈#${a.futureSlot}). The market prices it as an ordinary 1st.` });
  }
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
  r._simAll = { before, after };
  return { me: [before[L.me.rid], after[L.me.rid]], them: [before[r.partner.rid], after[r.partner.rid]] };
}

// ---------------- suggestions ----------------
function combos(arr, k) {
  if (k === 1) return arr.map(x => [x]);
  const out = [];
  for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) out.push([arr[i], arr[j]]);
  return out;
}

// Total value of a trade to you, in Sanderson (TAT) points: long-term value + what it does to this season
export function tradeValue(L, r, exact = null) {
  const plan = teamPlan(L);
  let now, pickShift = 0;
  if (exact && r._simAll) {
    // title equity + how the trade moves the draft slots of every next-year 1st you'd hold afterwards
    const ny = +L.season + 1;
    const held = new Set([...L.me.picks.filter(k => !r.giveKeys.includes(k)), ...r.getKeys.filter(k => k.startsWith('k:'))]);
    for (const k of held) {
      const [, y, rd, orig] = k.split(':');
      if (+y !== ny || +rd !== 1) continue;
      pickShift += expectedFromDist(L, ny, '1st', r._simAll.after[orig].slotDist) - expectedFromDist(L, ny, '1st', r._simAll.before[orig].slotDist);
    }
    now = plan.TITLE * (exact.me[1].title - exact.me[0].title) + pickShift;
  } else now = r.me ? winNowValue(plan, r.me.rosAfter - r.me.rosBefore, r.me.poAfter - r.me.poBefore) : 0;
  // Diminishing returns on buying power (the "utility monster"): once you're well ahead of the league in value,
  // more value adds little title equity. Gains count fully up to the league's 75th percentile, less beyond it.
  const vals = L.teams.map(x => x.tatTotal).sort((a, b) => a - b);
  const p75 = vals[Math.floor(vals.length * 0.75)], med = vals[Math.floor(vals.length / 2)] || 1;
  const lead = Math.max(0, (L.me.tatTotal - p75) / med);
  const dr = r.tatGain > 0 ? Math.max(0.5, 1 - lead) : 1; // losses always count in full
  const tat = r.tatGain * dr;
  return { total: tat + now, tat, tatRaw: r.tatGain, dr, now, pickShift };
}

// Sanderson: rankings aren't a price list; every trade should serve a goal. Your goals come from the league plan.
export function myGoals(L, plan) {
  const t = L.me, g = [];
  for (const h of plan.holes) g.push({ id: 'fix:' + h.g, label: `Fix ${h.g}` });
  if (!plan.tanking && (t.title ?? 0) >= 0.06) g.push({ id: 'points', label: 'Buy points' });
  if (plan.tanking || plan.weakLongTerm) g.push({ id: 'younger', label: 'Get younger' });
  if (plan.tanking || ((t.bye ?? 0) >= 0.5 && (t.title ?? 0) >= 0.15)) g.push({ id: 'picks', label: 'Turn players into picks' });
  if ((t.bye ?? 0) >= 0.5 && (t.title ?? 0) >= 0.15) g.push({ id: 'window', label: 'Extend the window' });
  return g;
}
export function goalsMet(L, r, goals) {
  const dReg = r.me ? r.me.rosAfter - r.me.rosBefore : 0, dPo = r.me ? r.me.poAfter - r.me.poBefore : 0;
  const ages = xs => { const p = xs.filter(a => !a.pick && a.age); return p.length ? p.reduce((s, a) => s + a.age, 0) / p.length : null; };
  const ag = ages(r.get), av = ages(r.give);
  const met = [];
  for (const g of goals) {
    if (g.id.startsWith('fix:')) { const pos = g.id.slice(4); if (r.get.some(a => a.pos === pos) && dReg > 1) met.push(g); }
    else if (g.id === 'points' && (dReg > 1.5 || dPo > 1.5)) met.push(g);
    else if (g.id === 'younger' && r.mix.future > 300 && (ag == null || av == null || ag < av - 1.5)) met.push(g);
    else if (g.id === 'picks' && r.mix.picks > 300) met.push(g);
    else if (g.id === 'window' && r.mix.future + r.mix.picks > 300 && (r.value?.now ?? 0) > -150) met.push(g);
  }
  // the partner's side: contenders want points, rebuilders want picks and youth
  const p = r.partner, theirReg = r.them ? r.them.rosAfter - r.them.rosBefore : 0;
  const theirs = p.mode === 'contend' ? (theirReg > 1 ? 'Buys them points' : null)
    : p.mode === 'rebuild' ? (-(r.mix.picks + r.mix.future) > 300 ? 'Gets them picks/youth' : null)
    : (theirReg > 1 ? 'Buys them points' : -(r.mix.picks + r.mix.future) > 300 ? 'Gets them picks/youth' : null);
  return { met, theirs };
}

export function suggest(L, { partners = null, limit = 30, poolSize = 16, exactTop = 10 } = {}) {
  if (!L.me) return [];
  const S = settings(), R = S.rules;
  const plan = teamPlan(L);
  const untouch = new Set(S.untouchable.map(String));
  const tg = new Set(S.targets.map(String));
  const po = []; for (let w = L.playoffStart; w <= M.lastWeek; w++) po.push(w);
  const reg = L.regWeeks.length ? L.regWeeks : po;
  const base = L.weekly[L.me.rid], bReg = mean(base, reg), bPo = mean(base, po);
  // what each single player is worth to MY lineup this season (added or removed), as a quick first pass
  const marg = new Map();
  const margOf = (a, adding) => {
    if (a.pick) return { reg: 0, po: 0 };
    const k = (adding ? '+' : '-') + a.id;
    if (!marg.has(k)) {
      const ids = adding ? [...L.me.players, a.id] : L.me.players.filter(x => x !== a.id);
      const wk = teamWeekly(L, ids);
      marg.set(k, { reg: mean(wk, reg) - bReg, po: mean(wk, po) - bPo });
    }
    return marg.get(k);
  };
  const holeGroups = new Set(plan.holes.map(x => x.g));
  const mine = teamAssets(L, L.me).filter(a => (a.fc > 250 || a.tat > 250) && !(a.id && untouch.has(a.id))).sort((a, b) => Math.max(b.fc, b.tat) - Math.max(a.fc, a.tat)).slice(0, poolSize);
  const out = [];
  for (const p of L.teams) {
    if (p.isMe || (partners && !partners.includes(p.rid))) continue;
    const all = teamAssets(L, p);
    const top = all.filter(a => a.fc > 250).sort((a, b) => b.fc - a.fc).slice(0, poolSize);
    for (const a of all) if (a.pick && a.top3 > 0.15 && !top.includes(a)) top.push(a); // possible diamond picks
    // plus players who would fill my holes right now, even if they're cheap in dynasty terms
    const fillers = all.filter(a => !a.pick && holeGroups.has(a.pos) && !top.includes(a)).map(a => ({ a, m: margOf(a, true) })).filter(x => x.m.reg > 3).sort((x, y) => y.m.reg - x.m.reg).slice(0, 5).map(x => x.a);
    const theirs = [...top, ...fillers];
    const cands = [];
    for (const gs of [1, 2]) for (const ts of [1, 2]) {
      for (const g of combos(mine, gs)) for (const t of combos(theirs, ts)) {
        const fc = fcSides(g.map(a => a.fc), t.map(a => perceived(a, p)));
        // people aren't ATMs: owners overvalue what they already have, so they need to come out a bit ahead
        const need = (p.mode === 'rebuild' ? R.rebuilderFcMargin : 0.03) * Math.max(fc.A, fc.B);
        if (fc.partnerMargin < need || fc.partnerMargin > need + 0.3 * fc.B + 400) continue;
        if (p.mode === 'rebuild' && g.some(a => !a.pick && (a.age || 0) >= R.rebuildMaxAge)) continue;
        if (p.mode !== 'contend' && g.some(a => a.pos === 'RB' && (a.age || 0) >= R.oldRbAge)) continue;
        const tat = sum(t.map(a => a.tat)) - sum(g.map(a => a.tat));
        const dReg = sum(t.map(a => margOf(a, true).reg)) + sum(g.map(a => margOf(a, false).reg));
        const dPo = sum(t.map(a => margOf(a, true).po)) + sum(g.map(a => margOf(a, false).po));
        const score = tat + winNowValue(plan, dReg, dPo) + (t.some(a => a.id && tg.has(a.id)) ? 1500 : 0) - 0.3 * Math.max(0, fc.partnerMargin - need);
        if (score < R.minTatGain * 0.5) continue;
        cands.push({ g, t, score });
      }
    }
    cands.sort((a, b) => b.score - a.score);
    let kept = 0;
    for (const c of cands.slice(0, 60)) {
      const r = evalTrade(L, p, c.g.map(a => a.key), c.t.map(a => a.key));
      if (r.flags.some(f => f.bad)) continue;
      if (r.memory.same && ['rejected', 'ignored', 'withdrawn'].includes(r.memory.same.status)) continue;
      r.value = tradeValue(L, r);
      r.score = r.value.total + (r.get.some(a => a.id && tg.has(a.id)) ? 1500 : 0);
      if (r.value.total < R.minTatGain) continue;
      out.push(r);
      if (++kept >= 4) break;
    }
  }
  // goal first: trades that serve one of your goals rank ahead; pure value grabs must win decisively
  const goals = myGoals(L, plan);
  const R2 = settings().rules;
  for (const r of out) {
    const g = goalsMet(L, r, goals);
    r.goals = g.met; r.theirGoal = g.theirs;
    r.type = tradeType(L, r);
    if (r.type.id === 'preference') r.pureValue = true;
    r.score += (r.goals.length ? R2.minTatGain : 0) + (r.theirGoal ? R2.minTatGain / 2 : 0);
    r.pureValue = r.pureValue || !r.goals.length;
  }
  for (let i = out.length - 1; i >= 0; i--) if (out[i].pureValue && out[i].value.total < 2 * R2.minTatGain) out.splice(i, 1);
  out.sort((a, b) => b.score - a.score);
  // the best few get a full season simulation, so their this-season value is exact rather than estimated
  for (const r of out.slice(0, exactTop)) {
    r.sim = simDelta(L, r, 1200);
    r.value = tradeValue(L, r, r.sim);
    r.score = r.value.total + (r.get.some(a => a.id && tg.has(a.id)) ? 1500 : 0);
  }
  // keep the list varied: each asset appears in at most two suggestions
  const used = new Map(), final = [];
  for (const r of out.sort((a, b) => b.score - a.score)) {
    if (r.value.total < R.minTatGain) continue;
    const keys = [...r.giveKeys, ...r.getKeys];
    if (keys.some(k => (used.get(k) || 0) >= 2)) continue;
    keys.forEach(k => used.set(k, (used.get(k) || 0) + 1));
    final.push(r);
    if (final.length >= limit) break;
  }
  return final;
}
