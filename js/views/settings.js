import { M, refreshValues, runSim, computePower } from '../model.js';
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
        h('span', { class: 'muted small' }, L.name))))));
  }

  root.append(h('div', { class: 'panel' }, h('h2', {}, 'Trade rules'),
    h('div', { class: 'grid g3' },
      num(st.rules, 'minTatGain', 'Minimum Sanderson gain', 50),
      num(st.rules, 'rebuilderFcMargin', 'Rebuilder FC win (share of deal)', 0.01, '0.05 = they win by 5%'),
      num(st.rules, 'contenderMaxDrop', 'Contender may lose (pts/wk)', 0.1),
      num(st.rules, 'myMaxDrop', 'You may lose when contending (pts/wk)', 0.1),
      num(st.rules, 'rebuildMaxAge', 'Rebuilders only take players younger than', 0.5),
      num(st.rules, 'oldRbAge', 'Old RB age (only to contenders)', 0.5),
      num(st.rules, 'contenderWinPct', 'Contender if win % at least', 0.025, 'median-game leagues count both games'),
      num(st.rules, 'rebuilderWinPct', 'Rebuilder if win % at most', 0.025))));

  root.append(h('div', { class: 'panel' }, h('h2', {}, 'Simulator & FantasyCalc adjustment'),
    h('div', { class: 'grid g3' },
      num(st, 'simRuns', 'Simulated seasons', 100),
      num(st, 'simSd', 'Weekly score spread (share of mean)', 0.01, '0.18 ≈ typical PPR week-to-week noise'),
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
