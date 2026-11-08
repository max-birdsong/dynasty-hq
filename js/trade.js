// Trade evaluation (FantasyCalc + waiver adjustment, Sanderson gain, full lineup impact) and suggestion search.
import { M, asset, teamAssets, teamWeekly, teamInj, startersNow, simInput, simParams, isPick, pid, expectedFromDist, mixOf, currencies, CAREER_END, playerWeekPts } from './model.js';
import { settings, state, rulesOf } from './state.js';
import { affinityFlags, stance, biasFactor, preferredCalc } from './affinity.js';
import { pAccept } from './accept.js';
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
  let v = a.pick && a.slot && a.fcLooks ? (a.ask ?? a.fcLooks) : a.fc;
  // micro-market: in leagues where picks have traded above or below market, owners price them that way
  if (a.pick && partner?._pickIndex) v *= partner._pickIndex;
  // and this owner's own lean (overvalues RBs, undervalues picks...), from his trade history
  if (partner?.ownerId) v *= biasFactor(partner.ownerId, a);
  return v;
}

// ---------- other calculators (KeepTradeCut, DynastyProcess via Dynasty Daddy; data/calcs.json, loaded into M.calcs) ----------
const ORD_N = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: '5th' };
export function calcPickName(L, a) {
  const [, y, rd] = a.key.split(':'), n = L.numTeams;
  const tier = a.slot && +y === +L.season + 1 ? (a.slot <= n / 3 ? 'Early' : a.slot <= 2 * n / 3 ? 'Mid' : 'Late') : 'Mid';
  return `${y} ${tier} ${ORD_N[rd] || rd + 'th'}`;
}
export function calcValue(L, a, k) {
  if (k === 'fc') return a.fc || 0;
  const c = M.calcs?.[k]; if (!c) return null;
  const f = L.fmt.numQbs === 2 ? 'sf' : 'one';
  return a.pick ? (c.picks[f][calcPickName(L, a)] || 0) : (c[f][a.id] || 0);
}
// the partner's gain on calculator k, as a share of the bigger side (positive = he wins)
// Like the calculators themselves, a pile of pieces is worth less than one star: KeepTradeCut and DynastyProcess add a
// "value adjustment" for the side getting the best player, FantasyCalc its own 2-for-1 rule. For KTC / DP we compare
// each side as (sum of value^p)^(1/p), which matches KTC's adjustment closely (e.g. Reed + Dobbins + a late 3rd,
// 7,732 summed, comes out well below Garrett Wilson's 5,783 plus his +5,148 adjustment); for FC we use its own rule.
const STUD = { ktc: 2.4, dp: 2 }; // 2.4 reproduces KTC's own verdict on a real 3-for-1 (-29% vs KTC -29%)
const sideValue = (vals, p) => Math.pow(vals.reduce((s, v) => s + Math.pow(Math.max(0, v), p), 0), 1 / p);
export function calcEdge(L, give, get, k) {
  if (k === 'fc') { const f = fcSides(give.map(a => a.fc || 0), get.map(a => a.fc || 0)); return f.partnerMargin / Math.max(1, f.A, f.B); }
  const p = STUD[k] || 2, g = sideValue(give.map(a => calcValue(L, a, k) || 0), p), t = sideValue(get.map(a => calcValue(L, a, k) || 0), p);
  return (g - t) / Math.max(1, g, t);
}

// Rebuilders want players with years left. The age cap is set for WRs and shifts with each position's career length,
// so a 29-year-old superflex QB (8 years left) is fine while a 27-year-old RB is not.
export const tooOldFor = (a, R) => !a.pick && (a.age || 0) >= R.rebuildMaxAge + ((CAREER_END[a.pos] ?? 30.5) - CAREER_END.WR);
// A team that owns its next 1st and is out of it gains from losing points (better draft slot), so it will happily
// swap a healthy starter for an injured star who'll play for them next year: the classic tank trade.
export function isTanking(L, p) {
  return p.picks.includes(`k:${+L.season + 1}:1:${p.rid}`) && (p.playoff ?? 0) < 0.15;
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
  const fc = fcSides(give.map(a => a.fc * biasFactor(partner.ownerId, a)), get.map(a => perceived(a, partner)));
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
      // only a problem if their lineup ends up with fewer starting QBs (a team with depth can spare one)
      const qbs = set => [...set].filter(id => M.players[id]?.position === 'QB').length;
      const afterStart = startersNow(L, rosterAfter(partner, getKeys, giveKeys)).starters;
      r.takesStartingQb = qbs(afterStart) < qbs(theirStart);
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
  const tankHelp = isTanking(L, partner) && r.them && r.them.rosAfter < r.them.rosBefore - 1;
  // he asked for exactly this (owner card "Looking for"): no rebuilder premium, no age objections
  const want = rulesOf(partner.ownerId, L.id)?.want;
  const asked = want === 'dump' ? (r.them ? r.them.rosAfter < r.them.rosBefore : true) : want && r.give.some(a => !a.pick) && r.give.every(a => a.pick || (want === 'vets' ? true : want === 'youth' ? (a.age || 30) <= 24 : a.pos === want));
  const need = want === 'dump' && asked ? -0.1 * Math.max(r.fc.A, r.fc.B) : mode === 'rebuild' && !tankHelp && !asked ? R.rebuilderFcMargin * Math.max(r.fc.A, r.fc.B) : 0;
  if (r.fc.partnerMargin < need) f.push({ bad: true, msg: mode === 'rebuild' && need > 0 ? `Rebuilder needs a clear FC win (≥ +${Math.round(need)})` : 'Partner loses on FantasyCalc' });
  if (mode === 'rebuild' && !asked) {
    for (const a of r.give) if (tooOldFor(a, R)) f.push({ bad: true, msg: `${a.name} is ${Math.floor(a.age)}: too few years left for a rebuilder` });
  }
  if (mode !== 'contend' && !asked) for (const a of r.give) if (a.pos === 'RB' && (a.age || 0) >= R.oldRbAge) f.push({ bad: true, msg: `Old RB ${a.name} to a non-contender` });
  if (r.them && mode === 'contend' && r.them.rosAfter < r.them.rosBefore - R.contenderMaxDrop) f.push({ bad: true, msg: `Contender loses ${(r.them.rosBefore - r.them.rosAfter).toFixed(1)} pts/wk` });
  if (r.takesStartingQb && mode !== 'rebuild' && want !== 'dump') f.push({ bad: true, msg: 'Takes their starting QB without one going back' });
  if (r.tatGain < 0) f.push({ bad: false, msg: 'Sanderson loss' });
  // don't hand out your own diamond
  for (const a of r.give) {
    if (!a.pick || a.orig !== L.me?.rid) continue;
    if (a.slot && a.looksSlot && a.slot < a.looksSlot - 1.5) f.push({ bad: false, warn: true, msg: `Careful: your ${a.short.split(' (')[0]} looks like pick #${a.looksSlot} from the standings, but the simulator has it around #${Math.round(a.slot)}. It's worth ${Math.round(a.tat).toLocaleString()} to you, not the ${Math.round(a.fcLooks).toLocaleString()} it looks like.` });
    if (a.p101 > 0.25) f.push({ bad: false, warn: true, msg: `Careful: your ${a.short.split(' (')[0]} has a ${a.p101 > 0.995 ? '>99%' : Math.round(a.p101 * 100) + '%'} chance of being the 1.01. On Sanderson's curve that's worth about ${Math.round(a.tat).toLocaleString()}, far more than any calculator's "early 1st" price.` });
    if (a.futureSlot && a.futureSlot <= Math.ceil(L.teams.length / 3)) f.push({ bad: false, warn: true, msg: `Careful: once age is factored in your roster ranks ${L.teams.length - a.futureSlot + 1} of ${L.teams.length} for next year, so your ${a.short} is likely an early pick (≈#${a.futureSlot}). The market prices it as an ordinary 1st.` });
  }
  // what he told you
  const rule = rulesOf(partner.ownerId, L.id);
  if (rule) {
    const till = u => u ? ` (noted until ${new Date(u).toLocaleDateString()})` : '';
    if (rule.paused) f.push({ bad: false, warn: true, msg: `You noted ${partner.owner} isn't trading in ${L.nick} right now${till(rule.untilLeague)}.` });
    for (const a of r.give) if (a.id && rule.noPlayers.map(String).includes(String(a.id))) f.push({ bad: false, warn: true, msg: `You noted ${partner.owner} isn't interested in ${a.name}${till(rule.untilPlayers)}.` });
    if (r.get.some(a => a.pick && (rule.noPicks || (rule.noFirsts && a.key.split(':')[2] === '1')))) f.push({ bad: false, warn: true, msg: `You noted ${partner.owner} won't trade his ${rule.noPicks ? 'picks' : '1sts'} in ${L.nick} right now${till(rule.untilLeague)}.` });
  }
  // what the partner thinks of the players moving (portfolio across shared leagues)
  f.push(...affinityFlags(L, partner, r));
  if (r.give.some(a => a.id && M.players[a.id]?.injury_status === 'IR')) f.push({ info: true, msg: 'IR players count as out for the rest of the season here (Sleeper projects them at zero). If he’s due back before the playoffs, he’s worth more to a contender than shown.' });
  // "Buying at the Deadline": protect the window and the rebuild pick
  const me = L.me, plan = L.plan;
  if (me && r.tatGain < 0) {
    const n = L.teams.length, mid = Math.ceil(n / 2);
    const after = me.tatTotal + r.tatGain;
    const rankAfter = 1 + L.teams.filter(x => x !== me && (x === partner ? x.tatTotal - r.tatGain : x.tatTotal) > after).length;
    if (me.tatTotalRank <= mid && rankAfter > mid) f.push({ bad: false, warn: true, msg: `This drops your buying power from ${me.tatTotalRank} to ${rankAfter} of ${n}. Below the middle is where spending futures for this season most often starts a rebuild early.` });
  }
  if (plan?.bp === 'low' && plan.keepFirst) for (const a of r.give) if (a.pick && a.orig === me?.rid && a.key.split(':')[2] === '1' && +a.key.split(':')[1] === plan.keepFirst) f.push({ bad: false, warn: true, msg: `Keep your ${plan.keepFirst} 1st if you can: your buying power is low, so that's likely your own high pick when the rebuild comes. Buy with nearer picks and vets instead.` });
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
  for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
    if (k === 2) out.push([arr[i], arr[j]]);
    else for (let l = j + 1; l < arr.length; l++) out.push([arr[i], arr[j], arr[l]]);
  }
  return out;
}

// Share of this season still to be played (regular season + playoffs)
function seasonLeft(L) { return Math.max(0, Math.min(1, (M.lastWeek - M.week + 1) / 17)); }
export function offseasonValue(L, a) {
  if (a.pick) return a.tat;
  return a.tat - currencies(a).now * seasonLeft(L);
}
function offseasonGain(L, r) {
  return r.get.reduce((s, a) => s + offseasonValue(L, a), 0) - r.give.reduce((s, a) => s + offseasonValue(L, a), 0);
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
  // Value to YOU, not market value (Sanderson, "Tearing Down"): a player's market price includes the rest of this
  // season's production, which he'll have used up by the off-season. That production only matters to you through
  // title odds and draft slot, which `now` already counts from the simulation. So the long-term side of the ledger
  // is each asset's value after this season: market value minus the share tied to the games left this year.
  const off = offseasonGain(L, r);
  const dr = off > 0 ? Math.max(0.5, 1 - lead) : 1; // losses always count in full
  const tat = off * dr;
  return { total: tat + now, tat, tatRaw: off, tatMarket: r.tatGain, dr, now, pickShift };
}

// Sanderson: rankings aren't a price list; every trade should serve a goal. Your goals come from the league plan.
export function myGoals(L, plan) {
  const t = L.me, g = [];
  for (const h of plan.holes) g.push({ id: 'fix:' + h.g, label: `Fix ${h.g}` });
  if (!plan.tanking && (t.title ?? 0) >= 0.06) g.push({ id: 'points', label: 'Buy points' });
  if (plan.tanking || plan.weakLongTerm) g.push({ id: 'younger', label: 'Get younger' });
  if (plan.tanking || ((t.bye ?? 0) >= 0.5 && (t.title ?? 0) >= 0.15)) g.push({ id: 'picks', label: 'Turn players into picks' });
  // extend the window: add long-term value at a minimal cost to this season's title odds (any contender)
  if (!plan.tanking && (t.title ?? 0) >= 0.06) g.push({ id: 'window', label: 'Extend the window' });
  // Sanderson's first reason to buy: it materially raises your bye odds. Only meaningful while a bye is in play.
  if (!plan.tanking && (t.playoff ?? 0) >= 0.25 && (t.bye ?? 0) >= 0.05 && (t.bye ?? 0) <= 0.8) g.push({ id: 'bye', label: 'Win a bye' });
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
    else if (g.id === 'window' && (r.value?.tat ?? r.tatGain) > 300 && (r.sim ? r.sim.me[1].title - r.sim.me[0].title >= -0.02 : (r.value?.now ?? 0) >= -0.02 * (L.plan?.TITLE || 0))) met.push(g);
  }
  // the partner's side: contenders want points, rebuilders want picks and youth
  const p = r.partner, theirReg = r.them ? r.them.rosAfter - r.them.rosBefore : 0;
  const theirs = p.mode === 'contend' ? (theirReg > 1 ? 'Buys them points' : null)
    : p.mode === 'rebuild' ? (-(r.mix.picks + r.mix.future) > 300 ? 'Gets them picks/youth' : null)
    : (theirReg > 1 ? 'Buys them points' : -(r.mix.picks + r.mix.future) > 300 ? 'Gets them picks/youth' : null);
  return { met, theirs };
}

export function suggest(L, { partners = null, limit = 30, poolSize = 16, exactTop = 10, mode = 'value' } = {}) {
  // mode 'title': rank by how much the trade moves your title odds, not by total value
  const T = mode === 'title';
  if (T) exactTop = 24;
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
    const blockIds = new Set((S.block?.[L.id] || []).map(String));
    const tanker = isTanking(L, p);
    const theirPts = new Map(); if (tanker) for (const a of all) if (!a.pick) theirPts.set(a.id, reg.reduce((s, w) => s + playerWeekPts(L, a.id, w), 0) / Math.max(1, reg.length));
    const listed = all.filter(a => a.id && blockIds.has(String(a.id)) && !top.includes(a) && !fillers.includes(a));
    let theirs = [...top, ...fillers, ...listed];
    // he asked for something in the league chat (owner card: "Looking for"): build around it, no premium needed
    const want = rulesOf(p.ownerId, L.id)?.want || null;
    const VET = { QB: 29, RB: 26, WR: 27, TE: 27.5 }, OUT_NOW = new Set(['Out', 'IR', 'PUP', 'Sus', 'Doubtful']);
    // dumping points (tanking, often to lower max PF): he gives players who score now, and wants back things that
    // don't score this season: picks, injured players, young bench players
    const scoresNow = (a, mineSide) => !a.pick && (mineSide ? -margOf(a, false).reg : margOf(a, true).reg) > 0.5;
    const quiet = a => a.pick || OUT_NOW.has(M.players[a.id]?.injury_status) || reg.reduce((s, w) => s + playerWeekPts(L, a.id, w), 0) / Math.max(1, reg.length) < 6;
    const fits = a => want === 'dump' ? quiet(a) : !a.pick && (want === 'vets' ? (a.age || 0) >= (VET[a.pos] ?? 27) && a.fc >= 300
      : want === 'youth' ? (a.age || 30) <= 24 : want ? a.pos === want : false);
    let myPool = mine;
    if (want) {
      myPool = teamAssets(L, L.me).filter(a => (want === 'dump' ? quiet(a) && (a.fc > 150) : fits(a)) && !(a.id && untouch.has(a.id))).sort((a, b) => b.fc - a.fc).slice(0, 14);
      if (want === 'vets') theirs = all.filter(a => a.pick && a.fc > 150); // he pays in picks
      // a tanker keeps his young core: the pool is his producers aged 25+ (QBs 28+)
      if (want === 'dump') theirs = all.filter(a => !a.pick && (a.age || 0) >= (a.pos === 'QB' ? 28 : 25) && reg.reduce((s, w) => s + playerWeekPts(L, a.id, w), 0) / Math.max(1, reg.length) >= 8).sort((a, b) => b.fc - a.fc).slice(0, 14);
    }
    const cands = [];
    for (const gs of want ? [1, 2, 3] : [1, 2]) for (const ts of [1, 2]) {
      for (const g of combos(myPool, gs)) for (const t of combos(theirs, ts)) {
        // a tanker dumping points takes a little under market (but piles of pieces still don't add up to a star)
        const fc = fcSides(g.map(a => a.fc * biasFactor(p.ownerId, a)), t.map(a => perceived(a, p)));
        // people aren't ATMs: owners overvalue what they already have, so they need to come out a bit ahead
        // ...unless they've put the player on the block: then they're a willing seller and fair is enough
        const onBlock = t.some(a => a.id && blockIds.has(String(a.id)));
        const tankHelp = tanker && t.some(a => !a.pick && (theirPts.get(a.id) || 0) > 3);
        const asked = want && g.every(fits);
        const need = want === 'dump' && asked ? -0.1 * fc.B : onBlock || tankHelp || asked ? 0 : (p.mode === 'rebuild' ? R.rebuilderFcMargin : 0.03) * Math.max(fc.A, fc.B);
        if (fc.partnerMargin < need || fc.partnerMargin > need + 0.3 * fc.B + 400) continue;
        if (!asked && p.mode === 'rebuild' && g.some(a => tooOldFor(a, R))) continue;
        if (!asked && p.mode !== 'contend' && g.some(a => a.pos === 'RB' && (a.age || 0) >= R.oldRbAge)) continue;
        // long-term part as of the off-season (this season's production is counted separately, via winNowValue)
        const tat = sum(t.map(a => offseasonValue(L, a))) - sum(g.map(a => offseasonValue(L, a)));
        const dReg = sum(t.map(a => margOf(a, true).reg)) + sum(g.map(a => margOf(a, false).reg));
        const dPo = sum(t.map(a => margOf(a, true).po)) + sum(g.map(a => margOf(a, false).po));
        const score = tat + winNowValue(plan, dReg, dPo) + (t.some(a => a.id && tg.has(a.id)) ? 1500 : 0) - 0.3 * Math.max(0, fc.partnerMargin - need);
        if (T) {
          // points gained now; sell-side long-term cost capped at a title's worth so it stays a sane price
          if (dReg + dPo < 3 || tat < -plan.TITLE * 0.25) continue;
          cands.push({ g, t, score: dReg + dPo + tat / 2000 });
          continue;
        }
        if (score < R.minTatGain * 0.5) continue;
        cands.push({ g, t, score });
      }
    }
    cands.sort((a, b) => b.score - a.score);
    let kept = 0;
    // what he told you (owner notes): players he doesn't want, picks he won't move, or not trading at all
    const rule = rulesOf(p.ownerId, L.id);
    if (rule?.paused) continue;
    const blockedGive = new Set((rule?.noPlayers || []).map(String));
    const okTheirs = a => !(a.pick && (rule?.noPicks || (rule?.noFirsts && a.key.split(':')[2] === '1')));
    cands.splice(0, cands.length, ...cands.filter(c => !c.g.some(a => a.id && blockedGive.has(String(a.id))) && c.t.every(okTheirs)));
    // the calculator this owner actually trades by (KeepTradeCut for most), and the extra he'll want for favourites
    const pc = preferredCalc(p.ownerId), usePc = pc && pc !== 'fc' && M.calcs?.[pc];
    const myPicks = teamAssets(L, L.me).filter(a => a.pick && +a.key.split(':')[2] >= 2);
    for (const c of cands.slice(0, 60)) {
      let giveKeys = c.g.map(a => a.key), sweet = [];
      if (usePc) {
        const fav = c.t.filter(a => a.id && (stance(p.ownerId, a.id, L.id)?.likes || 0) >= 2).length;
        const target = 0.05 * fav; // he holds out for more on players he's attached to
        let edge = calcEdge(L, c.g, c.t, pc);
        if (edge < target - 0.15) continue; // too far off on his calculator to fix with small picks
        // sweeten with the picks his calculator likes most relative to what they cost you on Sanderson's scale
        const pool = myPicks.filter(a => !giveKeys.includes(a.key)).map(a => ({ a, cv: calcValue(L, a, pc) || 0 })).filter(x => x.cv > 0).sort((x, y) => (x.a.tat || 1) / x.cv - (y.a.tat || 1) / y.cv);
        while (edge < target && sweet.length < 2 && pool.length) { const x = pool.shift(); sweet.push(x.a); edge = calcEdge(L, [...c.g, ...sweet], c.t, pc); }
        if (edge < target) continue;
        giveKeys = [...giveKeys, ...sweet.map(a => a.key)];
      }
      const r = evalTrade(L, p, giveKeys, c.t.map(a => a.key));
      if (usePc) { r.calcPref = pc; r.sweetened = sweet.map(a => a.name); }
      if (r.flags.some(f => f.bad)) continue;
      if (r.memory.same && ['rejected', 'ignored', 'withdrawn'].includes(r.memory.same.status)) continue;
      r.value = tradeValue(L, r);
      r.score = r.value.total + (r.get.some(a => a.id && tg.has(a.id)) ? 1500 : 0);
      if (!T && r.value.total < R.minTatGain) continue;
      if (T) r.score = r.me ? (r.me.rosAfter - r.me.rosBefore) + (r.me.poAfter - r.me.poBefore) : c.score;
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
    const blk = new Set((S.block?.[L.id] || []).map(String));
    const wantR = rulesOf(r.partner.ownerId, L.id)?.want;
    if (wantR) r.theirGoal = wantR === 'vets' ? 'Asked for vets' : wantR === 'dump' ? 'Dumping points' : wantR === 'youth' ? 'Asked for youth' : `Asked for a ${wantR}`;
    else if (r.get.some(a => a.id && blk.has(String(a.id)))) r.theirGoal = 'On their block';
    else if (isTanking(L, r.partner) && r.them && r.them.rosAfter < r.them.rosBefore - 1) r.theirGoal = 'Helps their tank';
    else { const fav = r.give.find(a => a.id && (stance(r.partner.ownerId, a.id, L.id)?.likes || 0) >= 2); if (fav) r.theirGoal = `He likes ${M.players[fav.id]?.last_name || fav.name}`; }
    r.type = tradeType(L, r);
    if (r.type.id === 'preference') r.pureValue = true;
    if (!T) r.score += (r.goals.length ? R2.minTatGain : 0) + (r.theirGoal ? R2.minTatGain / 2 : 0);
    r.pureValue = r.pureValue || !r.goals.length;
  }
  if (!T) for (let i = out.length - 1; i >= 0; i--) if (out[i].pureValue && out[i].value.total < 2 * R2.minTatGain) out.splice(i, 1);
  out.sort((a, b) => b.score - a.score);
  // the best few get a full season simulation, so their this-season value is exact rather than estimated
  for (const r of out.slice(0, exactTop)) {
    r.sim = simDelta(L, r, 1200);
    r.value = tradeValue(L, r, r.sim);
    r.dBye = r.sim.me[1].bye - r.sim.me[0].bye;
    // the bye is already inside the title odds, so no extra value; it just counts as meeting a goal
    const byeGoal = goals.find(g => g.id === 'bye');
    if (byeGoal && r.dBye >= 0.03 && !r.goals.includes(byeGoal)) { r.goals.push(byeGoal); r.pureValue = false; }
    r.score = r.value.total + (r.get.some(a => a.id && tg.has(a.id)) ? 1500 : 0) + (r.goals.length ? R2.minTatGain : 0) + (r.theirGoal ? R2.minTatGain / 2 : 0);
    r.dTitle = r.sim.me[1].title - r.sim.me[0].title;
    if (T) r.score = r.dTitle;
  }
  // rank by expected value: value to you × chance he accepts (title-swing mode keeps its own order)
  for (const r of out) {
    const a = pAccept(L, r.partner, r); r.pAccept = a.p; r.acceptF = a.f;
    if (!T) r.score *= a.p / 0.3; // scaled so an average-odds offer keeps its score
  }
  // keep the list varied: each asset appears in at most two suggestions
  const used = new Map(), final = [];
  const pool2 = T ? out.slice(0, exactTop).filter(r => r.dTitle >= 0.01 && r.value.total > -plan.TITLE * 0.1) : out;
  for (const r of pool2.sort((a, b) => b.score - a.score)) {
    if (!T && r.value.total < R.minTatGain) continue;
    const keys = [...r.giveKeys, ...r.getKeys];
    if (keys.some(k => (used.get(k) || 0) >= 2)) continue;
    keys.forEach(k => used.set(k, (used.get(k) || 0) + 1));
    final.push(r);
    if (final.length >= limit) break;
  }
  return final;
}
