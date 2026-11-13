import json, sys, urllib.request
def get(u):
    try:
        with urllib.request.urlopen(u, timeout=30) as r: return json.load(r)
    except Exception as e: return str(e)
vals = get("https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=2&numTeams=12&ppr=1")
ids = {x['player']['name']: x['player']['id'] for x in vals}
out = []
for name in ['Matthew Golden', 'Tyler Allgeier', 'Kyle Monangai']:
    pid = ids.get(name)
    for q in [f"playerId={pid}", f"playerIds={pid}", f"player={pid}", f"playerId={pid}&numTeams=12&ppr=1&limit=500"]:
        d = get(f"https://api.fantasycalc.com/trades?{q}&isDynasty=true&numQbs=2")
        if not isinstance(d, list): out.append(f"{name} {q}: {str(d)[:100]}"); continue
        has = [t for t in d if any(x['id'] == pid for x in t['side1'] + t['side2'])]
        out.append(f"{name} {q}: {len(d)} trades, {len(has)} with him, dates {d[-1]['date'][:10] if d else ''}..{d[0]['date'][:10] if d else ''}")
        for t in has[:4]:
            out.append(f"   {t['date'][:10]} {[x['name'] for x in t['side1']]} <-> {[x['name'] for x in t['side2']]} diff {t.get('maybeTradedValueDiff')} teams {t['numTeams']} te {t.get('tePremium')}")
open('data/probe-fc.txt', 'w').write('\n'.join(out))
