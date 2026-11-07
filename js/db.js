// Small IndexedDB key-value cache with expiry (used for large API payloads like the Sleeper player database).
let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open('dynasty-hq', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }).catch(() => null);
  return dbp;
}
async function tx(mode, fn) {
  const db = await open();
  if (!db) return null;
  return new Promise((res) => {
    try {
      const t = db.transaction('kv', mode);
      const req = fn(t.objectStore('kv'));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => res(null);
    } catch { res(null); }
  });
}
export async function cget(key, maxAgeMs = Infinity) {
  const v = await tx('readonly', s => s.get(key));
  if (!v) return null;
  if (Date.now() - v.t > maxAgeMs) return null;
  return v.d;
}
export async function cset(key, d) { return tx('readwrite', s => s.put({ t: Date.now(), d }, key)); }
export async function cclear(keep = ['players-nfl']) {
  const db = await open(); if (!db) return;
  const keys = await tx('readonly', s => s.getAllKeys()) || [];
  await tx('readwrite', s => { let r; for (const k of keys) if (!keep.includes(k)) r = s.delete(k); return r; });
}

// fetch JSON with cache
export async function cachedJson(url, maxAgeMs, { key = url, allowStale = true } = {}) {
  const hit = await cget(key, maxAgeMs);
  if (hit) return hit;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(r.status + ' ' + url);
    const d = await r.json();
    await cset(key, d);
    return d;
  } catch (e) {
    if (allowStale) { const old = await cget(key); if (old) return old; }
    throw e;
  }
}
