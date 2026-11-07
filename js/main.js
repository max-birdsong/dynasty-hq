import { M, loadAll, refreshValues, fitPlayoffVariance } from './model.js';
import { pull, startAutoSync, onSync, syncReady, applySetup } from './state.js';
import { $, $$, h, toast } from './util.js';
import { cclear } from './db.js';
import dashboard from './views/dashboard.js';
import leagueView from './views/league.js';
import ownersView from './views/owners.js';
import tradesView from './views/trades.js';
import valuesView from './views/values.js';
import settingsView from './views/settings.js';

const routes = { '': dashboard, league: leagueView, owners: ownersView, trades: tradesView, values: valuesView, settings: settingsView };
const app = $('#app');

export async function route() {
  const [, name = '', ...args] = (location.hash || '#/').slice(1).split('/');
  $$('#nav a').forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#/' + name));
  const view = routes[name] || dashboard;
  if (!M.ready && name !== 'settings') return;
  try {
    const node = await view(...args.map(decodeURIComponent));
    app.replaceChildren(node);
  } catch (e) {
    console.error(e);
    app.replaceChildren(h('div', { class: 'err-box' }, 'Something broke on this page: ' + e.message));
  }
}

async function boot(force = false) {
  const prog = msg => { const p = $('#progress'); if (p) p.textContent = msg + '…'; };
  app.replaceChildren(h('div', { class: 'loading' }, h('div', { class: 'spinner' }), h('div', { id: 'progress' }, 'Loading…')));
  if (force) await cclear();
  try {
    const setup = location.hash.match(/^#\/settings\/setup\/(.+)$/);
    if (setup) { try { applySetup(decodeURIComponent(setup[1])); toast('This device is now connected'); } catch { toast('That setup link is broken', 'err'); } history.replaceState(null, '', location.pathname + '#/'); }
    startAutoSync();
    if (syncReady()) { prog('Syncing from GitHub'); await pull(); }
    await loadAll(prog);
    if (M.errors.length) console.warn(M.errors);
    route();
    if (M.needsPlayoffFit) setTimeout(async () => { await fitPlayoffVariance(); M.needsPlayoffFit = false; const a = document.activeElement; if (!a || !['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName)) route(); }, 300);

  } catch (e) {
    console.error(e);
    app.replaceChildren(h('div', { class: 'panel' }, h('div', { class: 'err-box' }, 'Could not load data: ' + e.message),
      h('p', {}, 'Check your Sleeper username in Settings, or try again.'), h('button', { class: 'btn', onclick: () => boot(true) }, 'Retry'),
      ' ', h('a', { href: '#/settings', class: 'btn ghost' }, 'Settings')));
  }
}

window.addEventListener('hashchange', route);

// sync indicator + re-render when another device changed something
const LABEL = { off: ['Not syncing', 'off'], synced: ['Synced', 'ok'], pending: ['Saving…', 'pend'], syncing: ['Syncing…', 'pend'], offline: ['Offline, will retry', 'warn'], error: ['Sync error', 'err'] };
onSync(s => {
  const el = $('#sync'); if (!el) return;
  const [txt, c] = LABEL[s.status] || [s.status, ''];
  el.textContent = txt; el.className = 'sync ' + c; el.title = s.msg || (s.last ? 'Last sync ' + new Date(s.last).toLocaleTimeString() : '');
  if (s.status === 'synced' && s.changed && M.ready) {
    s.changed = false;
    const a = document.activeElement;
    refreshValues();
    const hsh = location.hash || '#/';
    const live = /^#\/(league|owners)?(\/|$)/.test(hsh) || /^#\/trades\/.*\/log$/.test(hsh); // don't wipe suggestions or the calculator
    if (live && (!a || !['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName))) route();
  }
});
$('#refresh').addEventListener('click', () => { toast('Refreshing all data'); boot(true); });
window.DHQ = { M, boot, route };
boot();
