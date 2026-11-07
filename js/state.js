// Persistent user state: settings, TAT uploads, trade log, owner notes, weekly history.
// Kept in localStorage and synced to data/state.json on a dedicated "data" branch of the GitHub repo,
// so the laptop and phone always see the same thing.
import { uid } from './util.js';

const KEY = 'dhq-state-v1';
const TOKEN_KEY = 'dhq-gh-token';
const FILE = 'data/state.json';

// Leagues Max already uses short names for
const KNOWN = {
  '1351209049420468224': 'NF', '1334750787229716480': 'MP', '1327948373461827584': 'Euro', '1326405013299290112': 'Molon',
  '1324589670528450560': 'Mongol', '1324465605297852416': 'Fortress', '1322204500529799168': 'Gang', '1314997123053285376': 'FJ',
  '1314991202088546304': 'R2L', '1312568291490824192': 'UKDL', '1312560768964644864': 'Boys',
};

export function defaultState() {
  return {
    version: 1, updatedAt: 0, settingsAt: 0,
    settings: {
      username: 'boximax',
      nicknames: { ...KNOWN },
      hidden: [],
      simRuns: 3000,
      titleWorth: 4500,
      draftOrder: {},
      sim: { useCalibration: true, teamAdj: true, sdWeek: 0.17, sdSeason: 0.06, horizonSd: 0.05, baseRateWeight: 0.5, injRates: { QB: 0.02, RB: 0.05, WR: 0.035, TE: 0.035 }, injRecover: 0.35 },
      adj: { pct: 0.6982, base: 753, scalar: 0.23 },
      rules: {
        minTatGain: 300, rebuilderFcMargin: 0.05, contenderMaxDrop: 0.3, myMaxDrop: 1.0,
        oldRbAge: 26.5, rebuildMaxAge: 28, contenderWinPct: 0.5, rebuilderWinPct: 0.375,
      },
      targets: [], untouchable: [],
      github: { repo: 'max-birdsong/dynasty-hq', branch: 'data' },
    },
    tatSets: [],
    trades: [],
    ownerNotes: {},   // ownerId -> {text, t}
    history: {},
    deleted: [],      // ids of deleted trades / TAT sets, so other devices drop them too
  };
}

let S = load();
const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return migrate(deepDefaults(JSON.parse(raw), defaultState()));
  } catch {}
  return defaultState();
}
function migrate(s) {
  for (const [k, v] of Object.entries(s.ownerNotes || {})) if (typeof v === 'string') s.ownerNotes[k] = { text: v, t: 0 };
  return s;
}
function deepDefaults(obj, def) {
  for (const [k, v] of Object.entries(def)) {
    if (!(k in obj)) obj[k] = structuredClone(v);
    else if (v && typeof v === 'object' && !Array.isArray(v) && obj[k] && typeof obj[k] === 'object') deepDefaults(obj[k], v);
  }
  return obj;
}
function persist() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { console.warn('localStorage full?', e); } }

export const state = () => S;
export const settings = () => S.settings;
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// settingsChanged marks the settings block as edited so it wins when merging with another device
export function save({ sync = true, settingsChanged = false } = {}) {
  S.updatedAt = Date.now();
  if (settingsChanged) S.settingsAt = Date.now();
  persist();
  listeners.forEach(f => f(S));
  if (sync) schedulePush();
}

export function nick(leagueId, fallback) { return S.settings.nicknames[leagueId] || fallback || leagueId; }

// ---------- TAT ----------
export function addTatSet(rows, label) {
  const set = { id: uid(), date: new Date().toISOString().slice(0, 10), updated: Date.now(), label: label || 'TAT ' + new Date().toISOString().slice(0, 10), rows };
  S.tatSets.push(set);
  S.tatSets.sort((a, b) => a.date.localeCompare(b.date) || a.updated - b.updated);
  save();
  return set;
}
export function latestTat() { return S.tatSets[S.tatSets.length - 1] || null; }
export function tatAt(date) { let r = null; for (const s of S.tatSets) if (s.date <= date) r = s; return r || S.tatSets[0] || null; }
export function deleteTatSet(id) { S.tatSets = S.tatSets.filter(s => s.id !== id); S.deleted.push(id); save(); }

// ---------- trades ----------
export function logTrade(t) {
  const rec = { id: uid(), created: Date.now(), updated: Date.now(), status: 'sent', notes: '', ...t };
  S.trades.unshift(rec); save(); return rec;
}
export function updateTrade(id, patch) {
  const t = S.trades.find(x => x.id === id); if (!t) return;
  Object.assign(t, patch, { updated: Date.now() }); save();
}
export function deleteTrade(id) { S.trades = S.trades.filter(t => t.id !== id); S.deleted.push(id); save(); }

// ---------- notes ----------
export const noteOf = id => S.ownerNotes[id]?.text || '';
export function setNote(id, text) { S.ownerNotes[id] = { text, t: Date.now() }; save(); }

// ---------- history ----------
export function recordHistory(leagueId, week, entry) {
  S.history[leagueId] ||= {};
  S.history[leagueId][week] = { ...entry, date: new Date().toISOString().slice(0, 10), t: Date.now() };
  save();
}

// ---------- merging two copies (this device + GitHub) ----------
function mergeById(a = [], b = [], dead) {
  const m = new Map();
  for (const x of [...a, ...b]) {
    if (dead.has(x.id)) continue;
    const o = m.get(x.id);
    if (!o || (x.updated || 0) >= (o.updated || 0)) m.set(x.id, x);
  }
  return [...m.values()];
}
export function merge(local, remote) {
  if (!remote || !remote.version) return local;
  remote = migrate(deepDefaults(structuredClone(remote), defaultState()));
  const out = structuredClone(local);
  const dead = new Set([...(local.deleted || []), ...(remote.deleted || [])]);
  out.deleted = [...dead].slice(-500);
  out.trades = mergeById(local.trades, remote.trades, dead).sort((a, b) => b.created - a.created);
  out.tatSets = mergeById(local.tatSets, remote.tatSets, dead).sort((a, b) => a.date.localeCompare(b.date) || (a.updated || 0) - (b.updated || 0));
  if ((remote.settingsAt || 0) > (local.settingsAt || 0)) { out.settings = remote.settings; out.settingsAt = remote.settingsAt; }
  out.ownerNotes = { ...local.ownerNotes };
  for (const [k, v] of Object.entries(remote.ownerNotes || {})) if (!out.ownerNotes[k] || (v.t || 0) > (out.ownerNotes[k].t || 0)) out.ownerNotes[k] = v;
  out.history = structuredClone(local.history || {});
  for (const [lg, weeks] of Object.entries(remote.history || {})) {
    out.history[lg] ||= {};
    for (const [w, e] of Object.entries(weeks)) { const o = out.history[lg][w]; if (!o || (e.t || 0) > (o.t || 0) || (o.fromSnapshot && !e.fromSnapshot)) out.history[lg][w] = e; }
  }
  out.updatedAt = Math.max(local.updatedAt || 0, remote.updatedAt || 0);
  return out;
}
function adopt(next) { S = next; persist(); listeners.forEach(f => f(S)); }

// ---------- GitHub sync ----------
export const ghToken = () => localStorage.getItem(TOKEN_KEY) || '';
export const setGhToken = t => { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); syncStatus(ghToken() ? 'pending' : 'off'); };
export const syncReady = () => !!(ghToken() && S.settings.github.repo);

const sync = { status: 'off', msg: '', last: 0, dirty: false, timer: null, busy: null, sha: null };
const syncListeners = new Set();
export const onSync = fn => { syncListeners.add(fn); fn(sync); return () => syncListeners.delete(fn); };
export const syncInfo = () => sync;
function syncStatus(status, msg = '') { sync.status = status; sync.msg = msg; syncListeners.forEach(f => f(sync)); }

async function gh(path, opts = {}) {
  const { repo } = S.settings.github;
  const r = await fetch(`https://api.github.com/repos/${repo}${path ? "/" + path : ""}`, {
    ...opts, cache: 'no-store',
    headers: { Authorization: `Bearer ${ghToken()}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(opts.headers || {}) },
  });
  if (r.status === 404) return null;
  if (!r.ok) { const e = new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 160)}`); e.status = r.status; throw e; }
  return r.status === 204 ? {} : r.json();
}
const b64 = s => { const bytes = new TextEncoder().encode(s); let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(bin); };
const unb64 = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, '')), c => c.charCodeAt(0)));

// make sure the data branch exists (created from the default branch the first time)
async function ensureBranch() {
  const { branch } = S.settings.github;
  if (await gh(`git/ref/heads/${branch}`)) return;
  const repo = await gh('');
  if (!repo) throw new Error(`Repo ${S.settings.github.repo} not found, or the token can't see it`);
  const head = await gh(`git/ref/heads/${repo.default_branch}`);
  await gh('git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: head.object.sha }) });
}

async function readRemote() {
  const { branch } = S.settings.github;
  const f = await gh(`contents/${FILE}?ref=${branch}`);
  if (!f) { sync.sha = null; return null; }
  sync.sha = f.sha;
  if (f.content) return JSON.parse(unb64(f.content));
  // files over 1 MB come back without content: fetch the raw blob
  const blob = await gh(`git/blobs/${f.sha}`);
  return JSON.parse(unb64(blob.content));
}

export async function pull() {
  if (!syncReady()) { syncStatus('off'); return false; }
  if (!navigator.onLine) { syncStatus('offline'); return false; }
  try {
    syncStatus('syncing');
    const remote = await readRemote();
    sync.changed = !!remote && (remote.updatedAt || 0) > (S.updatedAt || 0);
    if (remote) adopt(merge(S, remote));
    sync.last = Date.now();
    syncStatus(sync.dirty ? 'pending' : 'synced');
    if (sync.dirty || !remote) schedulePush(0);
    return true;
  } catch (e) {
    syncStatus(e.status === 401 || e.status === 403 ? 'error' : 'offline', e.message);
    return false;
  }
}

export function schedulePush(delay = 2000) {
  sync.dirty = true;
  if (!syncReady()) return;
  syncStatus('pending');
  clearTimeout(sync.timer);
  sync.timer = setTimeout(() => { push().catch(() => {}); }, delay);
}

export async function push() {
  if (!syncReady()) return false;
  if (sync.busy) return sync.busy;
  sync.busy = (async () => {
    if (!navigator.onLine) { syncStatus('offline'); return false; }
    syncStatus('syncing');
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await ensureBranch();
        const remote = await readRemote();
        if (remote) adopt(merge(S, remote));
        const { branch } = S.settings.github;
        const body = { message: `Dynasty HQ update (${navigator.userAgent.includes('Mobile') ? 'phone' : 'laptop'})`, branch, content: b64(JSON.stringify(S)), ...(sync.sha ? { sha: sync.sha } : {}) };
        const res = await gh(`contents/${FILE}`, { method: 'PUT', body: JSON.stringify(body) });
        sync.sha = res?.content?.sha || null;
        sync.dirty = false; sync.last = Date.now();
        syncStatus('synced');
        return true;
      } catch (e) {
        if (e.status === 409 || e.status === 422) { await new Promise(r => setTimeout(r, 400 * (attempt + 1))); continue; } // someone else wrote first: re-merge and retry
        syncStatus(e.status === 401 || e.status === 403 || e.status === 404 ? 'error' : 'offline', e.message);
        return false;
      }
    }
    syncStatus('error', 'Could not save after several tries');
    return false;
  })();
  try { return await sync.busy; } finally { sync.busy = null; }
}

// keep devices in step: pull when the app comes back into view, when the network returns, and every few minutes
export function startAutoSync() {
  if (startAutoSync.on) return; startAutoSync.on = true;
  const again = () => { if (document.visibilityState === 'visible') pull(); };
  document.addEventListener('visibilitychange', again);
  window.addEventListener('focus', again);
  window.addEventListener('online', () => (sync.dirty ? push() : pull()));
  window.addEventListener('pagehide', () => { if (sync.dirty && syncReady()) push(); });
  setInterval(again, 3 * 60e3);
  syncStatus(syncReady() ? 'pending' : 'off');
}

// one-tap setup link for another device (the token travels in the URL fragment, which is never sent to a server)
export function setupLink() {
  const payload = btoa(JSON.stringify({ r: S.settings.github.repo, b: S.settings.github.branch, t: ghToken(), u: S.settings.username }));
  return `${location.origin}${location.pathname}#/settings/setup/${payload}`;
}
export function applySetup(payload) {
  const o = JSON.parse(atob(payload));
  S.settings.github.repo = o.r; S.settings.github.branch = o.b || 'data';
  if (o.u) S.settings.username = o.u;
  persist();
  setGhToken(o.t);
}

export function exportJson() { return JSON.stringify(S, null, 1); }
export function importJson(text) { adopt(merge(S, JSON.parse(text))); save(); }
