import json, urllib.request
def get(u):
    try:
        with urllib.request.urlopen(u, timeout=30) as r: return json.load(r)
    except Exception as e: return {'error': str(e)}
vals = get("https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=2&numTeams=12&ppr=1")
ids = {x['player']['name']: x['player']['id'] for x in vals} if isinstance(vals, list) else {}
out = []
for name in ['Kyle Monangai', 'Tyler Allgeier', 'Bam Knight']:
    pid = ids.get(name)
    d = get(f"https://api.fantasycalc.com/trades/implied/{pid}?isDynasty=true&numQbs=2&numTeams=12&ppr=1")
    out.append(f"== {name} keys {list(d)}; historical {len(d.get('historicalValues', []))}")
    iv = d.get('impliedValues') or [] if isinstance(d, dict) else []
    out.append(f"implied: {len(iv)} items; first: {json.dumps(iv[:3])[:2500]}")
# how fast does the global feed move? (latest 50)
t = get("https://api.fantasycalc.com/trades?isDynasty=true")
out.append(f"feed: {len(t)} trades from {t[-1]['date']} to {t[0]['date']}" if isinstance(t, list) and t else f"feed: {str(t)[:200]}")
open('data/probe-fc.txt', 'w').write('\n'.join(out))
