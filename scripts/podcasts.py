"""Podcast buzz: what the dynasty podcasts are saying about players, in their own words.

Runs in GitHub Actions (.github/workflows/podcasts.yml):
  1. finds each show's RSS feed (Apple's podcast search) and picks up new episodes
  2. downloads and transcribes them on the runner (faster-whisper, free)
  3. asks Claude Haiku for every player take: player, stance, a short verbatim quote and where it starts
  4. keeps only takes whose quote really is in the transcript and whose player matches Sleeper's list
  5. writes data/buzz.json (takes only; transcripts are never stored: they are the shows' content)

Needs the repo secret ANTHROPIC_API_KEY. Without it the job exits quietly.
"""
import traceback, datetime as dt, difflib, email.utils, json, os, re, sys, tempfile, time, unicodedata
import xml.etree.ElementTree as ET
import requests

SHOWS = [
    {"name": "Fantasy Footballers Dynasty", "search": "Fantasy Footballers Dynasty", "must": "footballers"},
    {"name": "FantasyPros Dynasty", "search": "FantasyPros Dynasty Football Podcast", "must": "fantasypros"},
    {"name": "Dynasty Nerds", "search": "Dynasty Nerds Podcast", "must": "nerds"},
    {"name": "Fantasy Football Today Dynasty", "search": "Fantasy Football Today Dynasty", "must": "today"},
    {"name": "Under The Helmet", "search": "Under The Helmet dynasty", "must": "helmet"},
]
OUT = "data/buzz.json"
MAX_AGE_DAYS = 10          # only episodes this recent
PER_SHOW = 3               # new episodes per show per run (keeps the run under a few hours)
KEEP_DAYS = 120            # takes older than this are dropped
QUOTE_WORDS = 25
MODEL = os.environ.get("BUZZ_MODEL", "claude-haiku-5-5")
STANCES = ["buy", "sell", "hold", "breakout", "bust"]
UA = {"user-agent": "dynasty-hq podcast buzz (personal, non-commercial)"}


def norm(s):
    s = unicodedata.normalize("NFD", s or "").encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b\.?", "", s)
    return re.sub(r"[^a-z ]", "", s).strip()


def words(s):
    return re.sub(r"[^a-z0-9' ]", " ", (s or "").lower()).split()


# ---------- feeds ----------
def find_feed(show):
    r = requests.get("https://itunes.apple.com/search", params={"term": show["search"], "entity": "podcast", "limit": 10}, headers=UA, timeout=30)
    for x in r.json().get("results", []):
        n = (x.get("collectionName") or "").lower()
        if show["must"] in n and "dynasty" in n + (x.get("artistName") or "").lower() and x.get("feedUrl"):
            return x["feedUrl"], x.get("collectionName")
    return None, None


def episodes(feed_url):
    root = ET.fromstring(requests.get(feed_url, headers=UA, timeout=60).content)
    out = []
    for it in root.iter("item"):
        enc = it.find("enclosure")
        if enc is None or not enc.get("url"):
            continue
        try:
            when = email.utils.parsedate_to_datetime(it.findtext("pubDate"))
        except Exception:
            continue
        out.append({"guid": (it.findtext("guid") or enc.get("url")).strip(), "title": (it.findtext("title") or "").strip(),
                    "date": when.astimezone(dt.timezone.utc).isoformat(), "audio": enc.get("url"), "link": (it.findtext("link") or "").strip()})
    return out


# ---------- transcription ----------
_model = None
def transcribe(path):
    global _model
    from faster_whisper import WhisperModel
    if _model is None:
        _model = WhisperModel(os.environ.get("WHISPER_MODEL", "base.en"), device="cpu", compute_type="int8")
    # decode with ffmpeg ourselves (16 kHz mono float32): sidesteps PyAV version breakage inside faster-whisper
    import numpy as np, subprocess
    pcm = subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", "16000", "-"], capture_output=True, check=True).stdout
    audio = np.frombuffer(pcm, np.float32)
    segs, _ = _model.transcribe(audio, vad_filter=True, beam_size=1)
    return [(round(s.start), s.text.strip()) for s in segs]


def stamp(t):
    return f"{t // 3600}:{t // 60 % 60:02d}:{t % 60:02d}"


# ---------- take extraction ----------
PROMPT_VERSION = 3
PROMPT = """Below is part of an auto-generated transcript of a dynasty fantasy football podcast episode ("{show}: {title}"). Each line starts with its timestamp [h:mm:ss]. Names may be misspelled by the transcription.

Find the hosts' opinions about specific NFL players' DYNASTY value: their long-term trade value and outlook, the kind of thing that should make a dynasty manager buy, sell or hold him.

Do NOT include: start/sit advice, streaming, this week's matchups, weekly projections, game recaps or stat lines without a value opinion, betting, real-NFL contract or team talk with no fantasy opinion, college prospects not yet in the NFL, and anything you are not sure is about this player.

Stances:
- "buy": the host would acquire him / thinks the market is too low on him
- "sell": the host would move him / thinks the market is too high or his outlook is worse than his price
- "hold": keep him, don't sell low or chase
- "breakout": expects his value to rise sharply soon
- "bust": thinks he is done or won't live up to his price
(If a statement is negative about his future, it is sell or bust, never buy. "Regression candidate" is sell.)

For each take return:
- "player": the player's correct full name (fix transcription misspellings)
- "stance": one of {stances}
- "quote": the host's exact words from the transcript that state the take, copied verbatim, at most {qw} words. Pick the sentence where the opinion is clearest, preferably one that names the player.
- "t": the timestamp of the line where the quote starts, as h:mm:ss
- "speaker": the host's name if the transcript makes it clear, else null
- "price": if the host names a price, what he would pay for the player or want back for him (e.g. "a 1st and a young RB", "a mid 2nd", "3.05", "two 1sts", "not more than a 3rd"), written short in his terms; else null. Price talk is the most useful kind of take: when a host names a price, use the sentence with the price as the quote.
- "price_dir": "pay" if that is what he would give to get the player, "ask" if it is what he would want back for him, "cap" if it is the most he would pay or the price he calls too high; else null
- "sure": true only if the stance and the player are both unambiguous

Return only a JSON array (empty if there are none), no other text.

TRANSCRIPT:
{text}"""


CHUNK_S = 1500  # ~25 minutes per request: long episodes otherwise overflow the answer and come back empty
def extract(show, title, segs, key):
    out, start = [], 0
    end = segs[-1][0] if segs else 0
    while start <= end:
        part = [x for x in segs if start - 60 <= x[0] < start + CHUNK_S]
        if part:
            out += extract_part(show, title, part, key)
        start += CHUNK_S
    return out


def extract_part(show, title, segs, key):
    text = "\n".join(f"[{stamp(t)}] {s}" for t, s in segs)
    body = {"model": MODEL, "max_tokens": 6000, "messages": [{"role": "user", "content": PROMPT.format(show=show, title=title, stances=", ".join(STANCES), qw=QUOTE_WORDS, text=text)}]}
    for attempt in range(4):
        r = requests.post("https://api.anthropic.com/v1/messages", json=body, timeout=600,
                          headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
        if r.status_code in (429, 500, 502, 503, 529):
            time.sleep(20 * (attempt + 1)); continue
        r.raise_for_status()
        out = "".join(c.get("text", "") for c in r.json()["content"])
        # tolerate a cut-off answer: take every complete {...} object
        objs = []
        for m in re.finditer(r"\{[^{}]*\}", out):
            try: objs.append(json.loads(m.group(0)))
            except Exception: pass
        return objs
    raise RuntimeError("API kept failing")


# ---------- checks ----------
def verbatim(quote, segs, t_hint):
    """the quote must really be in the transcript (allowing for punctuation); returns (clean quote, start second)"""
    q = words(quote)[:QUOTE_WORDS]
    if len(q) < 4:
        return None
    # transcript as a word list with the second each word was said
    allw, secs, orig = [], [], []
    for t, s in segs:
        for tok in s.split():
            w = words(tok)
            if not w:
                continue
            allw.append(w[0] if len(w) == 1 else "".join(w)); secs.append(t); orig.append(tok)
    n = len(q)
    best, at = 0, None
    for i in range(0, max(1, len(allw) - n + 1)):
        if not (allw[i] == q[0] or (n > 1 and i + 1 < len(allw) and allw[i + 1] == q[1]) or (i + n - 1 < len(allw) and allw[i + n - 1] == q[-1])):
            continue
        sim = difflib.SequenceMatcher(None, allw[i:i + n], q).ratio()
        if sim > best:
            best, at = sim, i
    if best < 0.9:
        return None
    return " ".join(orig[at:at + n]).strip(" ,;:-"), secs[at]


def player_index():
    pl = requests.get("https://api.sleeper.app/v1/players/nfl", timeout=120).json()
    idx = {}
    for pid, p in pl.items():
        if p.get("position") not in ("QB", "RB", "WR", "TE"):
            continue
        n = norm(p.get("full_name") or f"{p.get('first_name', '')} {p.get('last_name', '')}")
        if n:
            idx.setdefault(n, []).append((pid, p))
    return idx


def match(name, idx):
    n = norm(name)
    c = idx.get(n)
    if not c:
        close = difflib.get_close_matches(n, idx.keys(), n=1, cutoff=0.88)
        c = idx.get(close[0]) if close else None
    if not c:
        return None
    c = sorted(c, key=lambda x: (not x[1].get("active"), x[1].get("team") is None))
    return c[0][0]


# ---------- main ----------
def main():
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        print("No ANTHROPIC_API_KEY secret set: nothing to do."); return
    try:
        data = json.load(open(OUT))
    except Exception:
        data = {"feeds": {}, "episodes": {}, "takes": []}
    old = {g for g, e in data["episodes"].items() if e.get("v") != PROMPT_VERSION}
    if old:
        data["takes"] = [t for t in data["takes"] if t["guid"] not in old]
        data["episodes"] = {g: e for g, e in data["episodes"].items() if g not in old}
    idx = player_index()
    now = dt.datetime.now(dt.timezone.utc)
    log = [f"run {now.isoformat()[:16]} model {MODEL}"]
    budget_end = time.time() + float(os.environ.get("BUDGET_MIN", "200")) * 60
    for show in SHOWS:
        feed = data["feeds"].get(show["name"], {}).get("url")
        if not feed:
            feed, title = find_feed(show)
            if not feed:
                print("feed not found:", show["name"]); continue
            data["feeds"][show["name"]] = {"url": feed, "title": title}
        try:
            eps = episodes(feed)
        except Exception as e:
            print("feed failed", show["name"], e); log.append(f"{show['name']}: feed failed: {e}"); continue
        log.append(f"{show['name']}: {len(eps)} episodes in feed")
        new = [e for e in eps if e["guid"] not in data["episodes"] and (now - dt.datetime.fromisoformat(e["date"])).days <= MAX_AGE_DAYS]
        for ep in sorted(new, key=lambda e: e["date"], reverse=True)[:PER_SHOW]:
            if time.time() > budget_end:
                print("time budget used up"); break
            print("episode:", show["name"], "|", ep["title"]); sys.stdout.flush()
            stage = "download"
            try:
                with tempfile.TemporaryDirectory() as d:
                    path = os.path.join(d, "ep.mp3")
                    with requests.get(ep["audio"], headers=UA, stream=True, timeout=120) as r:
                        r.raise_for_status()
                        with open(path, "wb") as f:
                            for chunk in r.iter_content(1 << 20): f.write(chunk)
                    stage = "transcribe"
                    t0 = time.time(); segs = transcribe(path)
                    log.append(f"{show['name']} | {ep['title'][:60]}: {os.path.getsize(path) >> 20} MB, {len(segs)} segments in {time.time() - t0:.0f}s")
                stage = "extract"
                raw = extract(show["name"], ep["title"], segs, key)
            except Exception as e:
                traceback.print_exc()
                log.append(f"{show['name']} | {ep['title'][:60]}: failed at {stage}: {type(e).__name__}: {str(e)[:300]}")
                data["log"] = log; json.dump(data, open(OUT, "w"), indent=0)
                continue
            kept = 0
            for x in raw:
                if not isinstance(x, dict) or x.get("stance") not in STANCES or x.get("sure") is False:
                    continue
                pid = match(x.get("player", ""), idx)
                v = verbatim(x.get("quote", ""), segs, x.get("t"))
                if not pid or not v:
                    continue
                quote, sec = v
                if any(t["guid"] == ep["guid"] and t["pid"] == pid and (t["quote"] == quote or abs(t["t"] - sec) < 20) for t in data["takes"]):
                    continue
                data["takes"].append({"pid": pid, "player": x.get("player"), "stance": x["stance"], "quote": quote, "t": sec,
                                      "price": (x.get("price") or None) and str(x["price"])[:80], "price_dir": x.get("price_dir") if x.get("price_dir") in ("pay", "ask", "cap") else None,
                                      "speaker": x.get("speaker"), "show": show["name"], "episode": ep["title"], "date": ep["date"],
                                      "audio": ep["audio"], "link": ep["link"], "guid": ep["guid"]})
                kept += 1
            data["episodes"][ep["guid"]] = {"show": show["name"], "title": ep["title"], "date": ep["date"], "takes": kept, "raw": len(raw), "v": PROMPT_VERSION}
            print(f"  {kept} takes kept of {len(raw)}")
            log.append(f"  -> {kept} takes kept of {len(raw)}")
            json.dump(data, open(OUT, "w"), indent=0)  # save as we go
    cut = (now - dt.timedelta(days=KEEP_DAYS)).isoformat()
    data["takes"] = [t for t in data["takes"] if t["date"] >= cut]
    data["episodes"] = {g: e for g, e in data["episodes"].items() if e["date"] >= cut}
    data["updated"] = now.isoformat()
    data["log"] = log
    json.dump(data, open(OUT, "w"), indent=0)


if __name__ == "__main__":
    main()
