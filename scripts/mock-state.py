#!/usr/bin/env python3
"""Helper to build/modify /tmp/mock-dabs-state.json for tests.
  mock-state.py init N_INSTOCK N_OUT          -> fresh catalog
  mock-state.py change K                      -> change store qty of first K in-stock items
  mock-state.py vanish K                      -> set st=0 for K in-stock items (taken from the middle)
  mock-state.py set key=json ...              -> set raw keys (e.g. fail_at_start=96 fail_kind='"http500"')"""
import json, sys
P = "/tmp/mock-dabs-state.json"
def load():
    try: return json.load(open(P))
    except Exception: return {"scenario": "good", "products": []}
s = load(); cmd = sys.argv[1]
if cmd == "init":
    n_in, n_out = int(sys.argv[2]), int(sys.argv[3])
    s = {"scenario": "good", "products": [{"sku": f"{900000+i}", "name": f"MOCK PRODUCT {i:04d} 750ml", "wh": 10 + i % 7, "st": (5 + i % 11) if i < n_in else 0, "oo": 0} for i in range(n_in + n_out)],
         "fail_at_start": None, "fail_kind": None, "drift_after": None, "drift_remove": 0, "short_page_at": None}
elif cmd == "change":
    k = int(sys.argv[2]); ins = [p for p in s["products"] if p["st"] > 0]
    for p in ins[:k]: p["st"] += 1
elif cmd == "vanish":
    k = int(sys.argv[2]); ins = [p for p in s["products"] if p["st"] > 0]; mid = len(ins) // 2
    for p in ins[mid:mid + k]: p["st"] = 0
elif cmd == "set":
    for kv in sys.argv[2:]:
        k, v = kv.split("=", 1); s[k] = json.loads(v)
json.dump(s, open(P, "w"))
ins = sum(1 for p in s["products"] if p["st"] > 0)
print(f"state: scenario={s.get('scenario')} products={len(s['products'])} in_stock={ins} fail_at_start={s.get('fail_at_start')} drift_after={s.get('drift_after')} short_page_at={s.get('short_page_at')}")
