// r/DynastyFF buzz from the public RSS feeds (the JSON API blocks GitHub's servers; RSS doesn't).
// Finds which players are being talked about in new posts and comments, before Sleeper adds pile up.
const UA = 'dynasty-hq/0.1 (personal waiver scanner)';
// new posts only: the comments feed is rate-limited (429) for GitHub's servers
const FEEDS = ['https://www.reddit.com/r/DynastyFF/new/.rss?limit=100'];
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
  const wait = ms => new Promise(r => setTimeout(r, ms));
  for (const u of FEEDS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(u, { headers: { 'user-agent': UA } });
        if (r.ok) { items.push(...entries(await r.text())); break; }
        console.log('reddit', r.status, u);
        if (r.status !== 429) break;
      } catch (e) { console.log('reddit error', e.message); }
      await wait(15000 * (attempt + 1));
    }
    await wait(5000); // be polite between feeds
  }
  const cut = Date.now() - hours * 3600e3, out = new Map(), seenLinks = new Set();
  for (const it of items) {
    if (it.t < cut || seenLinks.has(it.link)) continue;
    seenLinks.add(it.link);
    const title = norm(it.title);
    const hits = [...names].filter(([nm]) => it.text.includes(nm));
    // rankings and recap posts name dozens of players: not a waiver signal unless the player is in the title
    const focused = hits.length <= 4;
    for (const [nm, id] of hits) {
      const inTitle = title.includes(nm);
      if (!focused && !inTitle) continue;
      const o = out.get(id) || out.set(id, { n: 0, news: false, posts: [] }).get(id);
      o.n++;
      if (inTitle && NEWS.test(it.title)) o.news = true;
      if (o.posts.length < 3) o.posts.push({ title: it.title, link: it.link });
    }
  }
  console.log(`reddit: ${items.length} items, ${out.size} players mentioned`);
  return out;
}
