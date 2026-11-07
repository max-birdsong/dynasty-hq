// r/DynastyFF buzz from the public RSS feeds (the JSON API blocks GitHub's servers; RSS doesn't).
// Finds which players are being talked about in new posts and comments, before Sleeper adds pile up.
const UA = 'dynasty-hq/0.1 (personal waiver scanner)';
const FEEDS = ['https://www.reddit.com/r/DynastyFF/new/.rss?limit=100', 'https://www.reddit.com/r/DynastyFF/comments/.rss?limit=100'];
const NEWS = /\b(ruled out|out for|season[- ]ending|torn|acl|achilles|ir\b|injur|will start|to start|starting|promoted|elevated|signed|released|waived|traded|lead back|bellcow|workhorse|breakout|handcuff|pick ?up|add\b|waiver)/i;

export const norm = s => ' ' + String(s).toLowerCase().replace(/<[^>]+>/g, ' ').replace(/&#39;|&apos;|’/g, "'").replace(/&[a-z]+;|&#\d+;/g, ' ')
  .replace(/[.'`]/g, '').replace(/\b(jr|sr|ii|iii|iv)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';

function entries(xml) {
  const out = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const title = (e.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    const content = (e.match(/<content[^>]*>([\s\S]*?)<\/content>/) || [])[1] || '';
    const link = (e.match(/<link href="([^"]+)"/) || [])[1] || '';
    const updated = (e.match(/<updated>([^<]+)<\/updated>/) || [])[1] || '';
    out.push({ title: title.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'"), text: norm(title + ' ' + content.replace(/&lt;/g, '<').replace(/&gt;/g, '>')), link, t: Date.parse(updated) || Date.now(), isComment: /\/comments\/[^/]+\/[^/]+\/[a-z0-9]+\/?$/.test(link) });
  }
  return out;
}

// names: Map(normalized " first last " -> player id). Returns Map(id -> { n, news, posts: [{title, link}] })
export async function buzz(names, hours = 36) {
  const items = [];
  for (const u of FEEDS) {
    try { const r = await fetch(u, { headers: { 'user-agent': UA } }); if (r.ok) items.push(...entries(await r.text())); else console.log('reddit', r.status, u); }
    catch (e) { console.log('reddit error', e.message); }
  }
  const cut = Date.now() - hours * 3600e3, out = new Map();
  for (const it of items) {
    if (it.t < cut) continue;
    const title = norm(it.title);
    for (const [nm, id] of names) {
      if (!it.text.includes(nm)) continue;
      const o = out.get(id) || out.set(id, { n: 0, news: false, posts: [] }).get(id);
      o.n++;
      if (!it.isComment && title.includes(nm) && NEWS.test(it.title)) o.news = true;
      if (o.posts.length < 3 && !o.posts.some(p => p.title === it.title)) o.posts.push({ title: it.title.replace(/^\/u\/\S+ on /, ''), link: it.link });
    }
  }
  console.log(`reddit: ${items.length} items, ${out.size} players mentioned`);
  return out;
}
