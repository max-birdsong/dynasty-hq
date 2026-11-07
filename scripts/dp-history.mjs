// Builds data/history/dp-values.json: weekly DynastyProcess dynasty values (superflex + 1QB) since 2025,
// read from the git history of github.com/dynastyprocess/data, mapped to Sleeper player ids.
// Used to judge trades at the values they had when they were made, instead of with hindsight.
// Usage: node scripts/dp-history.mjs <path to a clone of dynastyprocess/data>
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repo = process.argv[2];
const SINCE = process.env.DP_SINCE || '2025-01-01';
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { maxBuffer: 1 << 28 }).toString();

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const split = l => { const out = []; let cur = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
  const head = split(lines[0]);
  return lines.slice(1).map(l => { const c = split(l); return Object.fromEntries(head.map((h, i) => [h, c[i]])); });
}

// fantasypros id -> sleeper id
const ids = parseCsv(git('show', 'HEAD:files/db_playerids.csv'));
const fp2sl = new Map(ids.filter(r => r.fantasypros_id && r.fantasypros_id !== 'NA' && r.sleeper_id && r.sleeper_id !== 'NA').map(r => [r.fantasypros_id, r.sleeper_id]));
const name2sl = new Map(ids.filter(r => r.sleeper_id && r.sleeper_id !== 'NA').map(r => [`${r.merge_name}|${r.position}`, r.sleeper_id]));
const norm = s => s.toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();

// one commit per scrape date
const log = git('log', `--since=${SINCE}`, '--format=%H %cs', '--', 'files/values.csv').trim().split('\n').map(l => l.split(' '));
const byDate = new Map();
for (const [h, d] of log) if (!byDate.has(d)) byDate.set(d, h); // newest commit of each day
const dates = [...byDate.keys()].sort();

const sf = {}, one = {}, pk2 = {}, pk1 = {};
dates.forEach((d, i) => {
  let rows;
  try { rows = parseCsv(git('show', `${byDate.get(d)}:files/values.csv`)); } catch { return; }
  for (const r of rows) {
    const v2 = +r.value_2qb || 0, v1 = +r.value_1qb || 0;
    if (r.pos === 'PICK') {
      (pk2[r.player] ||= new Array(dates.length).fill(0))[i] = v2;
      (pk1[r.player] ||= new Array(dates.length).fill(0))[i] = v1;
      continue;
    }
    const sid = fp2sl.get(r.fp_id) || name2sl.get(`${norm(r.player)}|${r.pos}`);
    if (!sid) continue;
    (sf[sid] ||= new Array(dates.length).fill(0))[i] = v2;
    (one[sid] ||= new Array(dates.length).fill(0))[i] = v1;
  }
});

const out = { source: 'DynastyProcess (github.com/dynastyprocess/data), values from FantasyPros dynasty ECR', updated: new Date().toISOString().slice(0, 10), dates, sf, one, picks: { sf: pk2, one: pk1 } };
const dir = path.join(process.cwd(), 'data', 'history');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'dp-values.json'), JSON.stringify(out));
console.log(`DP history: ${dates.length} dates (${dates[0]} to ${dates.at(-1)}), ${Object.keys(sf).length} players, ${Object.keys(pk2).length} pick names`);
