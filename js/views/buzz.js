// Podcast buzz page: what the dynasty podcasts are saying, player by player, in the hosts' own words.
import { M } from '../model.js';
import { h } from '../util.js';
import { loadBuzz, summary, takesFor, disagreements } from '../buzz.js';
import { loadDp } from '../history.js';

const STANCE = { buy: ['Buy', 'good'], breakout: ['Breakout', 'good'], sell: ['Sell', 'bad'], bust: ['Bust', 'bad'], hold: ['Hold', ''], neutral: ['Take', ''] };
const ago = d => { const n = Math.round((Date.now() - Date.parse(d)) / 864e5); return n <= 0 ? 'today' : n === 1 ? 'yesterday' : `${n}d ago`; };
const mmss = t => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;

// one shared player: tap ▶ on a take to hear it from that second
const audio = h('audio', { controls: true, preload: 'none', style: { width: '100%' } });
const nowPlaying = h('div', { class: 'small muted' });
function play(t) {
  const at = Math.max(0, t.t - 3);
  nowPlaying.textContent = `${t.show} · ${t.episode} · from ${mmss(at)}`;
  if (audio.dataset.src !== t.audio) { audio.src = t.audio; audio.dataset.src = t.audio; }
  const go = () => { audio.currentTime = at; audio.play().catch(() => {}); };
  if (audio.readyState >= 1) go(); else { audio.addEventListener('loadedmetadata', go, { once: true }); audio.load(); }
}

function takeRow(t) {
  const [lbl, cls] = STANCE[t.stance] || [t.stance, ''];
  return h('div', { class: 'take', style: { padding: '6px 0', borderTop: '1px solid var(--line)' } },
    h('div', { class: 'row', style: { gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' } },
      h('span', { class: 'tag ' + cls }, lbl),
      h('span', {}, '“', t.quote, '”'),
      h('button', { class: 'btn ghost small', title: 'Hear it from this moment', onclick: () => play(t) }, `▶ ${mmss(t.t)}`)),
    h('div', { class: 'small muted' }, [t.speaker, t.show].filter(Boolean).join(', '), ' · ',
      t.link ? h('a', { href: t.link, target: '_blank', rel: 'noopener' }, t.episode) : t.episode, ' · ', ago(t.date)));
}

export default async function buzzView() {
  const [B, dp] = await Promise.all([loadBuzz(), loadDp()]);
  const root = h('div');
  root.append(h('h2', {}, 'Podcast buzz'));
  if (!B?.takes?.length) {
    root.append(h('div', { class: 'card' }, h('p', {}, 'No podcast takes yet. They arrive once the daily podcast job has run (it needs the ANTHROPIC_API_KEY secret in your GitHub repo).')));
    return root;
  }
  const mine = new Set(M.leagues.flatMap(L => L.me?.players || []).map(String));
  let scope = 'mine', days = 30, q = '';
  const list = h('div');
  const name = pid => M.players[pid]?.full_name || pid;
  const shows = Object.keys(B.feeds || {});

  const render = () => {
    const S = Object.values(summary(B, days))
      .filter(s => scope === 'all' || mine.has(s.pid))
      .filter(s => !q || name(s.pid).toLowerCase().includes(q))
      .sort((a, b) => b.n - a.n || b.latest.localeCompare(a.latest));
    list.replaceChildren(...(S.length ? S.slice(0, 80).map(s => {
      const p = M.players[s.pid], tk = takesFor(B, s.pid, days);
      const lean = s.net > 0 ? h('span', { class: 'tag good' }, `${s.up} buying${s.down ? `, ${s.down} selling` : ''}`) : s.net < 0 ? h('span', { class: 'tag bad' }, `${s.down} selling${s.up ? `, ${s.up} buying` : ''}`) : h('span', { class: 'tag' }, s.up ? 'split' : `${s.n} take${s.n > 1 ? 's' : ''}`);
      return h('details', { class: 'card', style: { marginBottom: '8px' }, open: S.length <= 6 },
        h('summary', { style: { cursor: 'pointer' } }, h('b', {}, name(s.pid)), ' ', h('span', { class: 'muted small' }, `${p?.position || ''} ${p?.team || ''}`), ' ', lean,
          mine.has(s.pid) ? h('span', { class: 'tag', style: { marginLeft: '6px' } }, 'yours') : '',
          h('div', { class: 'small', style: { marginTop: '4px' } }, '“', tk[0].quote, '” ', h('span', { class: 'muted' }, `(${tk[0].show})`))),
        ...tk.map(takeRow));
    }) : [h('p', { class: 'muted' }, scope === 'mine' ? 'No takes on your players in this window. Switch to all players.' : 'No takes match.')]));
  };

  const D = disagreements(B, dp, days).filter(d => scope === 'all' || mine.has(d.pid));
  const flags = h('div', { class: 'card', style: { marginBottom: '12px' } },
    h('b', {}, 'Podcasts vs the market'), h('div', { class: 'small muted' }, 'Where the shows lean one way and DynastyProcess values have moved the other over 4 weeks. These are where prices tend to move next.'),
    ...(D.length ? D.slice(0, 10).map(d => h('div', { class: 'small', style: { marginTop: '4px' } }, h('span', { class: 'tag ' + (d.kind === 'buy-low' ? 'good' : 'bad') }, d.kind === 'buy-low' ? 'Buy low?' : 'Sell high?'), ' ', h('b', {}, name(d.pid)), ': ', d.text))
      : [h('div', { class: 'small muted', style: { marginTop: '4px' } }, 'None right now.')]));

  const sel = (opts, cur, set) => h('select', { onchange: e => { set(e.target.value); render(); } }, opts.map(([v, l]) => h('option', { value: v, selected: String(cur) === String(v) }, l)));
  root.append(
    h('div', { class: 'card', style: { marginBottom: '12px', position: 'sticky', top: '0', zIndex: 5 } },
      h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
        sel([['mine', 'Your players'], ['all', 'All players']], scope, v => scope = v),
        sel([[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days']], days, v => days = +v),
        h('input', { placeholder: 'Find a player…', oninput: e => { q = e.target.value.toLowerCase(); render(); } })),
      h('div', { style: { marginTop: '8px' } }, audio, nowPlaying)),
    flags, list,
    h('p', { class: 'small muted' }, `From ${shows.join(', ')}. Episodes are transcribed automatically and each take is the host's exact words (up to 25), checked against the transcript; tap ▶ to hear it in context. Updated ${B.updated ? ago(B.updated) : 'never'}.`));
  render();
  return root;
}
