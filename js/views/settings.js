import { M, refreshValues, runSim, computePower, CLASS_TOP, classOf, applyTat, sandersonScale, titleWorthFor } from '../model.js';
import { state, settings, save, ghToken, setGhToken, push, pull, setupLink, syncInfo, exportJson, importJson } from '../state.js';
import { h, toast } from '../util.js';
import { cclear } from '../db.js';

export default function settingsView() {
  const st = settings();
  const root = h('div');
  const num = (obj, k, label, step = 'any', help = '') => h('label', { class: 'f' }, label,
    h('input', { type: 'number', step, value: obj[k], onchange: e => { obj[k] = +e.target.value; save({ settingsChanged: true }); } }), help ? h('span', { class: 'small' }, help) : '');

  root.append(h('div', { class: 'panel' }, h('h2', {}, 'Account'),
    h('div', { class: 'row' }, h('label', { class: 'f' }, 'Sleeper username', h('input', { value: st.username, onchange: e => { st.username = e.target.value.trim(); save({ settingsChanged: true }); } })),
      h('button', { class: 'btn ghost', onclick: () => window.DHQ.boot(true) }, 'Reload with this user'))));

  if (M.ready) {
    root.append(h('div', { class: 'panel' }, h('h2', {}, 'Leagues'),
      h('div', { class: 'muted small', style: { marginBottom: '8px' } }, 'Short names are used everywhere. Untick a league to hide it.'),
      h('div', { class: 'grid g2' }, M.leagues.map(L => h('div', { class: 'row' },
        h('input', { type: 'checkbox', checked: !st.hidden.includes(L.id), onchange: e => { if (e.target.checked) st.hidden = st.hidden.filter(x => x !== L.id); else st.hidden.push(L.id); save({ settingsChanged: true }); } }),
        h('input', { value: L.nick, style: { width: '110px' }, onchange: e => { st.nicknames[L.id] = e.target.value; L.nick = e.target.value; save({ settingsChanged: true }); } }),
        h('select', { title: 'How next year\'s draft order is set', onchange: e => { (st.draftOrder ||= {})[L.id] = e.target.value; L.draftOrder = e.target.value; save({ settingsChanged: true }); runSim(L); computePower(L); } },
          h('option', { value: 'maxpf', selected: L.draftOrder !== 'record' }, 'Draft: reverse max PF'), h('option', { value: 'record', selected: L.draftOrder === 'record' }, 'Draft: reverse record')),
        h('span', { class: 'muted small' }, L.name))))));
  }

  root.append(h('div', { class: 'panel' }, h('h2', {}, 'How trades are valued'),
    h('p', { class: 'small', style: { marginTop: 0 } }, 'Every trade is scored in one currency: Sanderson value gained, plus what it does to your title and playoff odds this season. How much this season counts is worked out per league from your situation (whether you can win, whether you own your next 1st, how strong you are long-term). The one thing to set is what a title is worth to you.'),
    h('div', { class: 'grid g3' }, h('label', { class: 'f' }, 'What a title is worth',
        h('select', { onchange: e => { st.titleAuto = e.target.value === 'auto'; save({ settingsChanged: true }); M.leagues.forEach(L => computePower(L)); toast('Updated'); } },
          h('option', { value: 'auto', selected: st.titleAuto !== false }, 'Work it out per league (recommended)'), h('option', { value: 'manual', selected: st.titleAuto === false }, 'Fixed number below')),
        h('span', { class: 'small' }, M.leagues.filter(L => L.me).map(L => `${L.nick} ${Math.round(titleWorthFor(L) / (L.fc.picks.get(`${+L.season + 1} 1st`) || 3000))}`).join(' · ') + ' base 1sts per title')),
      num(st, 'titleWorth', 'Fixed title worth (TAT points)', 250, 'Only used when set to a fixed number.'),
      h('label', { class: 'f' }, 'Sanderson: a base 2nd is worth (base 1sts)',
        h('input', { type: 'number', step: 0.01, min: 0.1, max: 0.6, value: st.sandersonB2 ?? 0.33, onchange: e => { st.sandersonB2 = +e.target.value; save({ settingsChanged: true }); M.leagues.forEach(L => { L.tatSetCache = null; }); applyTat(); M.leagues.forEach(L => computePower(L)); toast('Sanderson values updated'); } }),
        h('span', { class: 'small' }, (() => { const sc = sandersonScale(); return `Late 1st 0.75 · early 2nd ${sc.E2.toFixed(2)} · base 2nd ${sc.B2.toFixed(2)} · late 2nd ${sc.L2.toFixed(2)} · base 3rd ${sc.B3.toFixed(2)} · 4th ${sc.R4.toFixed(2)}. Prices his tiers and your view of picks; FantasyCalc stays the market price.`; })())),
      ...[1, 2].map(d => { const y = (+M.season || new Date().getFullYear()) + d; return h('label', {}, h('div', { class: 'small' }, `${y} rookie class`),
        h('select', { onchange: e => { (st.classes ||= {})[y] = e.target.value; save({ settingsChanged: true }); M.leagues.forEach(L => computePower(L)); toast('Pick values updated'); } },
          ...Object.keys(CLASS_TOP).map(c => h('option', { value: c, selected: classOf(y) === c }, `${c[0].toUpperCase() + c.slice(1)} (1.01 = ${CLASS_TOP[c]} base 1sts)`)))); })),
    h('details', { style: { marginTop: '12px' } }, h('summary', { class: 'small' }, 'Advanced: partner-fit rules'),
    h('div', { class: 'grid g3', style: { marginTop: '8px' } },
      num(st.rules, 'minTatGain', 'Minimum total gain to suggest', 50),
      num(st.rules, 'rebuilderFcMargin', 'Rebuilder FC win (share of deal)', 0.01, '0.05 = they win by 5%'),
      num(st.rules, 'contenderMaxDrop', 'Contender may lose (pts/wk)', 0.1),
      num(st.rules, 'rebuildMaxAge', 'Rebuilders only take players younger than', 0.5, 'Age for a WR; shifts with career length: +6.5 for QBs, -2 for RBs, +1 for TEs'),
      num(st.rules, 'oldRbAge', 'Old RB age (only to contenders)', 0.5),
      num(st.rules, 'contenderWinPct', 'Contender if win % at least', 0.025, 'median-game leagues count both games'),
      num(st.rules, 'rebuilderWinPct', 'Rebuilder if win % at most', 0.025)))));

  root.append(h('div', { class: 'panel' }, h('h2', {}, 'Simulator & FantasyCalc adjustment'),
    h('div', { class: 'grid g3' },
      num(st, 'simRuns', 'Simulated seasons', 100),
      ...['QB', 'RB', 'WR', 'TE'].map(p => { st.sim.injRates ||= { QB: 0.02, RB: 0.05, WR: 0.035, TE: 0.035 }; return num(st.sim.injRates, p, `${p} injury chance per week`, 0.005, p === 'RB' ? '0.05 ≈ an RB misses ~13% of future weeks' : ''); }),
      num(st.sim, 'injRecover', 'Chance an injured starter returns each week', 0.05, '0.35 ≈ 3 weeks out on average'),
      num(st.sim, 'baseRateWeight', 'Extra blend with seed base rates (title odds)', 0.05, 'Normally 0: playoff luck is already fitted to the real-league data. Raise only to be extra conservative.'),
      num(st.sim, 'horizonSd', 'Forecast-horizon error (season-long)', 0.01, 'Extra uncertainty for projecting weeks ahead; 0.05 = ±5%'),
      num(st.sim, 'sdWeek', 'Weekly spread if not calibrated', 0.01),
      num(st.sim, 'sdSeason', 'Season spread if not calibrated', 0.01),
      h('label', { class: 'f' }, 'Calibration', h('select', { onchange: e => { st.sim.useCalibration = e.target.value === '1'; save({ settingsChanged: true }); } },
        h('option', { value: '1', selected: st.sim.useCalibration }, 'Measured from my leagues'), h('option', { value: '0', selected: !st.sim.useCalibration }, 'Use the manual spreads'))),
      h('label', { class: 'f' }, 'Team track record', h('select', { onchange: e => { st.sim.teamAdj = e.target.value === '1'; save({ settingsChanged: true }); } },
        h('option', { value: '1', selected: st.sim.teamAdj }, 'Shrunk adjustment (recommended)'), h('option', { value: '0', selected: !st.sim.teamAdj }, 'Ignore past results')),),
      num(st.adj, 'pct', 'Adjustment: % of piece', 0.0001),
      num(st.adj, 'base', 'Adjustment: base', 1),
      num(st.adj, 'scalar', 'Adjustment: scalar × value', 0.01)),
    h('div', { class: 'muted small', style: { marginTop: '6px' } }, 'The side giving fewer pieces is credited min(value × %, base + scalar × value) for each smallest extra piece on the other side. If the FantasyCalc site shows a different adjustment for the same trade, tweak these.'),
    h('button', { class: 'btn ghost small', style: { marginTop: '8px' }, onclick: () => { if (!M.ready) return; for (const L of M.leagues) { runSim(L); computePower(L); } toast('Re-simulated'); } }, 'Re-run simulations')));

  // GitHub sync
  const repo = h('input', { value: st.github.repo, style: { width: '220px' }, onchange: e => { st.github.repo = e.target.value.trim(); save({ sync: false }); } });
  const branch = h('input', { value: st.github.branch, style: { width: '80px' }, onchange: e => { st.github.branch = e.target.value.trim() || 'data'; save({ sync: false }); } });
  const token = h('input', { type: 'password', style: { width: '260px' }, placeholder: ghToken() ? '•••••• saved on this device' : 'github_pat_…' });
  const info = syncInfo();
  const linkBox = h('div');
  root.append(h('div', { class: 'panel' }, h('h2', {}, 'Sync laptop and phone (GitHub)'),
    h('p', { class: 'small', style: { marginTop: 0 } }, ghToken()
      ? h('span', {}, 'Status: ', h('b', {}, info.status), info.msg ? ' · ' + info.msg : '', info.last ? ` · last synced ${new Date(info.last).toLocaleString()}` : '')
      : 'Not connected yet. Everything is only saved in this browser until you add a token.'),
    h('ol', { class: 'steps small' },
      h('li', {}, 'On github.com: Settings → Developer settings → Personal access tokens → ', h('b', {}, 'Fine-grained tokens'), ' → Generate new token.'),
      h('li', {}, 'Repository access: ', h('b', {}, 'Only select repositories'), ' → ', h('code', {}, st.github.repo || 'your repo'), '. Permissions → Repository → ', h('b', {}, 'Contents: Read and write'), '. Expiration: up to a year.'),
      h('li', {}, 'Paste it below and press Connect. Then use "Copy link for my phone" and open that link on your phone once.')),
    h('div', { class: 'row' }, h('label', { class: 'f' }, 'Repo', repo), h('label', { class: 'f' }, 'Branch', branch), h('label', { class: 'f' }, 'Token', token)),
    h('div', { class: 'row', style: { marginTop: '10px' } },
      h('button', { class: 'btn', onclick: async () => {
        if (token.value.trim()) setGhToken(token.value.trim());
        if (!ghToken()) return toast('Paste a token first', 'err');
        const ok = await pull() && await push();
        const i = syncInfo();
        toast(ok ? 'Connected. This device now syncs automatically.' : 'Sync failed: ' + i.msg, ok ? '' : 'err');
        if (ok) { refreshValues(); window.DHQ.route(); }
      } }, ghToken() ? 'Sync now' : 'Connect'),
      ghToken() ? h('button', { class: 'btn ghost', onclick: async () => {
        const url = setupLink();
        try { await navigator.clipboard.writeText(url); toast('Link copied. Open it on your phone once.'); } catch {}
        linkBox.replaceChildren(h('div', { class: 'small muted', style: { marginTop: '8px' } }, 'Open this on your other device (it contains your token, so only send it to yourself):'),
          h('textarea', { readonly: true, style: { fontFamily: 'var(--mono)', fontSize: '11px' } }, url));
      } }, 'Copy link for my phone') : '',
      ghToken() ? h('button', { class: 'btn ghost', onclick: () => { if (confirm('Stop syncing on this device?')) { setGhToken(''); window.DHQ.route(); } } }, 'Disconnect this device') : ''),
    linkBox,
    h('p', { class: 'small muted', style: { marginBottom: 0 } }, 'Data is saved to data/state.json on the "data" branch (separate from the website code). Every change is saved within a few seconds, and the other device picks it up when you open or switch back to the site. If both devices change something at once, the two versions are merged: nothing is overwritten.')));

  root.append(h('div', { class: 'panel' }, h('h2', {}, 'Backup'),
    h('div', { class: 'row' },
      h('button', { class: 'btn ghost', onclick: () => { const a = h('a', { href: URL.createObjectURL(new Blob([exportJson()], { type: 'application/json' })), download: `dynasty-hq-${new Date().toISOString().slice(0, 10)}.json` }); a.click(); } }, 'Export JSON'),
      h('label', { class: 'btn ghost' }, 'Import JSON', h('input', { type: 'file', accept: '.json', style: { display: 'none' }, onchange: async e => { importJson(await e.target.files[0].text()); toast('Imported'); } })),
      h('button', { class: 'btn ghost', onclick: async () => { await cclear([]); toast('Cache cleared'); } }, 'Clear API cache'))));
  return root;
}
