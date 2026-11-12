// Real comps: for every player, the most recent real trades he was part of (from data/real-trades.json) and what the
// other side gave. Writes data/comps.json, small enough for the site to load.
import fs from 'node:fs';
const { trades } = JSON.parse(fs.readFileSync('data/real-trades.json', 'utf8'));
const ORD = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: '5th' };
const tag = a => a.pick ? `${a.s} ${ORD[a.r] || a.r + 'th'}${a.own && a.orank && a.s === 2027 ? (a.orank <= 4 ? ' (early)' : '') : ''}` : a.id;
const by = {};
for (const t of [...trades].sort((x, y) => y.d.localeCompare(x.d))) {
  for (const [s, o] of [[t.a, t.b], [t.b, t.a]]) {
    // s received s.got from the other team; each player in it was traded for o.got (plus his package mates)
    for (const a of s.got) {
      if (a.pick || !a.id) continue;
      const L = by[a.id] ||= [];
      if (L.length >= 12) continue;
      L.push({ d: t.d, sf: t.sf, w: s.got.filter(x => x !== a).map(tag), f: o.got.map(tag) });
    }
  }
}
fs.writeFileSync('data/comps.json', JSON.stringify({ updated: new Date().toISOString(), comps: by }));
console.log(Object.keys(by).length, 'players with comps');
