// Works out what each of your teams should be doing, from its situation rather than from rules you set:
//  - how much a point per week is worth in title/playoff odds (measured by re-simulating the league)
//  - whether winning now helps you at all (if you don't own your next 1st, losing gains you nothing; if you do
//    and you're out of it, winning now costs draft position)
//  - where the lineup is short (position groups producing far less than the league's typical starters)
//  - players who are out for the season (zero points now, value later)
// Everything is turned into one currency: Sanderson (TAT) value. A title is worth `titleWorth` TAT.
import { M, simInput, simParams, playerWeekPts, posOf, teamAssets, expectedFromDist } from './model.js';
import { simulate } from './sim.js';
import { bestLineup } from './lineup.js';
import { settings } from './state.js';
import { myGoals } from './trade.js';

const GROUPS = ['QB', 'RB', 'WR', 'TE'];

function groupPoints(L, ids, weeks) {
  const tot = { QB: 0, RB: 0, WR: 0, TE: 0 };
  for (const w of weeks) {
    const pts = {}; for (const id of ids) pts[id] = playerWeekPts(L, id, w);
    for (const [, id] of bestLineup(ids, pts, posOf, L.slots).lineup) if (id) { const g = M.players[id]?.position; if (g in tot) tot[g] += pts[id]; }
  }
  for (const g of GROUPS) tot[g] /= Math.max(1, weeks.length);
  return tot;
}

export function teamPlan(L) {
  if (L.plan) return L.plan;
  const t = L.me; if (!t) return null;
  const S = settings();
  const TITLE = S.titleWorth ?? 4500;
  const runs = 1200, params = simParams(), seed = 4242;
  const po = []; for (let w = L.playoffStart; w <= M.lastWeek; w++) po.push(w);
  const reg = L.regWeeks;

  // This season pays out as title equity plus, if you own it, the value of your own next 1st.
  // So this season's value = title odds x title worth + expected value of
  // your own next 1st (if you still own it), both read from the simulated seasons.
  const ny = +L.season + 1;
  const ownFirst = t.picks.includes(`k:${ny}:1:${t.rid}`);
  const pickEV = res => ownFirst ? expectedFromDist(L, ny, '1st', res.slotDist) : 0;
  const base = simulate(simInput(L), { runs, params, seed })[t.rid];
  const bumped = weeks => { const w = { ...L.weekly[t.rid] }; for (const k of weeks) w[k] = (w[k] || 0) + 10; return simulate(simInput(L, { [t.rid]: w }), { runs, params, seed })[t.rid]; };
  const r = reg.length ? bumped(reg) : base, p = bumped(po);
  const sens = {
    titleReg: Math.max(0, (r.title - base.title) / 10), titlePo: Math.max(0, (p.title - base.title) / 10),
    playoffReg: Math.max(0, (r.playoff - base.playoff) / 10),
    pickReg: (pickEV(r) - pickEV(base)) / 10, pickPo: (pickEV(p) - pickEV(base)) / 10, // usually negative: winning costs draft slot
  };
  const pickNow = pickEV(base);
  const slotNow = base.slot;
  const outOfIt = (t.playoff ?? 0) < 0.25;
  const tanking = ownFirst && outOfIt;

  // long-term standing
  const n = L.teams.length;
  const dynRank = t.tatTotalRank || t.fcTotalRank;
  const weakLongTerm = dynRank > n * 0.6;

  // lineup holes: my starters' points per position group vs the league median
  const weeks = reg.length ? reg : po;
  const all = L.teams.map(x => ({ x, g: groupPoints(L, x.players, weeks) }));
  const mine = all.find(a => a.x.isMe).g;
  const med = {};
  for (const g of GROUPS) { const v = all.map(a => a.g[g]).sort((a, b) => a - b); med[g] = v[Math.floor(v.length / 2)]; }
  const holes = GROUPS.map(g => ({ g, mine: mine[g], med: med[g], gap: mine[g] - med[g] })).filter(x => x.gap < -5).sort((a, b) => a.gap - b.gap);

  // dead weight this season: valuable players projected for ~nothing the rest of the year
  const dead = teamAssets(L, t).filter(a => !a.pick && a.tat >= 800 && weeks.every(w => playerWeekPts(L, a.id, w) < 1) && (a.inj || '').length);

  const lines = [];
  const pc = x => Math.round(x * 100) + '%';
  lines.push(`Playoff odds ${pc(t.playoff)}, title odds ${pc(t.title)}; long-term (Sanderson) rank ${dynRank} of ${n}.`);
  lines.push(ownFirst
    ? `This season pays off two ways: the title (${pc(t.title)}, worth ${Math.round(TITLE * (t.title || 0)).toLocaleString()} TAT in expectation) and your own ${ny} 1st (projects #${slotNow.toFixed(1)}, worth about ${Math.round(pickNow).toLocaleString()}). Staying in contention keeps the title chance alive; a reload only pays if the pick gains more than the title equity you give up.`
    : `You don't own your ${ny} 1st, so a bad finish earns you nothing; the only payoff left this season is the title (${pc(t.title)}).`);
  if (tanking) lines.push(`Points now mostly cost you draft position: adding 10 pts/wk changes your pick's value by about ${Math.round(sens.pickReg * 10).toLocaleString()} and your title equity by ${Math.round(TITLE * sens.titleReg * 10).toLocaleString()}.`);
  else {
    const parts = [];
    if (sens.titleReg * 10 >= 0.002 || sens.playoffReg * 10 >= 0.005) parts.push(`+10 pts/wk for the rest of the regular season ≈ ${(sens.playoffReg * 1000).toFixed(0)}% playoff odds and ${(sens.titleReg * 1000).toFixed(1)}% title odds`);
    if (sens.titlePo * 10 >= 0.002) parts.push(`+10 pts/wk in the playoff weeks ≈ ${(sens.titlePo * 1000).toFixed(1)}% title odds`);
    lines.push(`You're in the race, so points now matter${parts.length ? ': ' + parts.join('; ') : ''}.`);
  }
  if (holes.length) lines.push(`Biggest hole: ${holes.map(x => `${x.g} (${x.mine.toFixed(1)} pts/wk vs league typical ${x.med.toFixed(1)})`).join(', ')}.`);
  if (dead.length) lines.push(`Out for the season: ${dead.map(a => a.name).join(', ')}. They score nothing this year but hold ${Math.round(dead.reduce((s, a) => s + a.tat, 0)).toLocaleString()} TAT of value.`);
  if (t.mix?.total) {
    const pp = x => Math.round(100 * x / t.mix.total);
    const lm = L.teams.reduce((s, x) => s + x.mix.future / x.mix.total, 0) / n;
    lines.push(`Your buying power: ${pp(t.mix.picks)}% picks, ${pp(t.mix.now)}% this season's production, ${pp(t.mix.future)}% future years (league average ${Math.round(lm * 100)}% future). ` +
      (t.mix.future / t.mix.total > lm + 0.08 ? "That's EYR-heavy, the most fragile kind of value: young players rarely hold their price. Picks and productive vets are sturdier." : t.mix.picks / t.mix.total > 0.15 ? 'Plenty of picks: they gain value as they get closer to the draft and pay off big when they land early.' : 'A reasonably balanced mix.'));
    const eff = t.tatTotalRank - t.titleRank;
    if (eff <= -3 && (t.title ?? 0) < 0.15) lines.push(`Efficiency: your buying power ranks ${t.tatTotalRank} of ${n} but your title odds rank ${t.titleRank}. Some of that value isn't turning into wins; converting EYR or surplus picks into productive vets would use it better.`);
    else if (eff >= 3) lines.push(`Efficiency: your title odds rank ${t.titleRank} of ${n} on buying power that ranks ${t.tatTotalRank}, so your roster is turning value into wins well.`);
  }
  if (weakLongTerm) lines.push('Your roster ranks low long-term, so selling aging players for younger ones is still smart, even if you keep competing.');

  // Sanderson's conveyor belt / "chip and a chair": if your buying power is middle or better, stay in the game every
  // year; buy the minimum production needed to contend for a bye at the lowest cost, then store surplus in picks.
  // Tanking is a one-year reload at most.
  let headline;
  const bpOk = dynRank <= Math.ceil(n / 2);
  const middle = false;
  const lastYearBad = L.prevRecord && L.prevRecord.winPct < 0.4;
  if ((t.title ?? 0) >= 0.15 && (t.bye ?? 0) >= 0.5) headline = 'Bye secured: extend the window, don\'t chase the last piece';
  else if ((t.title ?? 0) >= 0.12) headline = 'Contend for a bye, at the lowest cost';
  else if (tanking && !bpOk) headline = lastYearBad ? 'Second down year: get back to competing' : 'One-year reload';
  else if (holes.length && (t.playoff ?? 0) >= 0.05) headline = `Stay at the table: fix ${holes[0].g} cheaply`;
  else if (bpOk) headline = 'Chip and a chair: compete with what you have';
  else headline = 'Reload for one year, then compete';
  if ((t.bye ?? 0) >= 0.5 && (t.title ?? 0) >= 0.15) lines.push("You're likely to get a bye, and that's where most of your title odds come from. One more stud adds only 1–2% (Adeiko), so spending future value now has sharply diminishing returns. Put surplus into picks and extending the window.");
  if (tanking && lastYearBad) lines.push(`You were ${L.prevRecord.wins}-${L.prevRecord.losses} last year too. Sanderson's rule: a reload should last one year, because a second tank year rarely gains more than the title equity it gives up.`);
  if (tanking && bpOk) lines.push(`Your buying power ranks ${dynRank} of ${n}, which is enough to compete. Conceding the season costs real win equity, and your pick only offsets part of it.`);

  const planObj = { holes, tanking, weakLongTerm };
  L.plan = { sens, ownFirst, tanking, middle, pickNow, slotNow, dynRank, n, holes, dead, weakLongTerm, lines, headline, base, TITLE };
  const goals = myGoals(L, L.plan);
  if (goals.length) L.plan.lines.push('Trade goals here: ' + goals.map(g => g.label).join(', ') + '.');
  return L.plan;
}

// value of a lineup change (pts/wk in the regular season and the playoff weeks) in TAT
export function winNowValue(plan, dReg, dPo) {
  if (!plan) return 0;
  const s = plan.sens;
  return plan.TITLE * (s.titleReg * dReg + s.titlePo * dPo) + s.pickReg * dReg + s.pickPo * dPo;
}
