#!/usr/bin/env python3
"""Synthetic catalog for LOCAL search tests/benchmarks (never run against --remote).
Usage: seed-catalog.py N_PRODUCTS [scenario]  > seed.sql
scenario: never | ok | stale | failed | incomplete   (sweep_state rows relative to now)
"""
import random, sys, datetime as dt
random.seed(16)
N = int(sys.argv[1]) if len(sys.argv) > 1 else 5456
scen = sys.argv[2] if len(sys.argv) > 2 else "ok"
now = dt.datetime.now(dt.timezone.utc)
iso = lambda d: d.strftime("%Y-%m-%dT%H:%M:%S.000Z")
q = lambda s: "'" + str(s).replace("'", "''") + "'"
cats = {
 "spirits": ["WHISKEY - BOURBON & TENNESSEE","WHISKEY - RYE","WHISKEY - SCOTCH SINGLE MALT","WHISKEY - SCOTCH BLENDED","WHISKEY - IRISH","WHISKEY - CANADIAN","WHISKEY - FLAVORED","VODKA - DOMESTIC","VODKA - FLAVORED","GIN - IMPORTED","RUM - FLAVORED","RUM - GOLD","TEQUILA - REPOSADO","TEQUILA - BLANCO","MEZCAL","BRANDY - COGNAC","LIQUEURS - CREAM","LIQUEURS - HERBAL","SCHNAPPS","ALLOCATED SPIRIT","SPECIAL ORDERS - SPIRITS"],
 "wine": ["RED WINE - VARIETAL","WHITE WINE - VARIETAL","RED WINE - IMPORTED","WHITE - IMPORTED","ROSE WINE","SPARKLING BY ORIGIN","SPARKLING BY TYPE","PORT","SHERRY","VERMOUTH","SAKE","WINE - FRUIT & FLAVORED"],
 "beer": ["BEER - ALE","BEER - LAGER","BEER - WHEAT, ICE, FLAV","BEER - DOMESTIC & IMPORT","FLAVORED MALT BEVERAGES - RC"],
 "cider": ["CIDER"], "premixed": ["PREMIXED"], "other": ["LIMITED OFFERS","GIFT & SPECIAL ORDER - YG","ALLOCATED ITEM"],
}
words = {
 "spirits": ["BUFFALO TRACE","EAGLE RARE","WELLER","MAKERS MARK","WOODFORD RESERVE","JACK DANIELS","JIM BEAM","WILD TURKEY","FOUR ROSES","HIGH WEST","GLENFIVE","LAPHROAIG","JAMESON","CROWN ROYAL","TITOS","GREY GOOSE","HENDRICKS","BACARDI","PATRON","CASAMIGOS","DEL MAGUEY","HENNESSY","BAILEYS","FIREBALL","ELIJAH CRAIG","HEAVEN HILL","OLD FORESTER","KNOB CREEK","SAZERAC","STAGG"],
 "wine": ["LA CREMA","KENDALL JACKSON","JOSH CELLARS","MEIOMI","CAYMUS","SILVER OAK","BAREFOOT","CHATEAU STE MICHELLE","SANTA MARGHERITA","VEUVE CLICQUOT","MOET","LA MARCA","DOLIN","TAYLOR FLADGATE","GEKKEIKAN"],
 "beer": ["UINTA","WASATCH","SQUATTERS","EPIC","RED ROCK","BOHEMIAN","GUINNESS","CORONA","MODELO","SIERRA NEVADA","BELLS","STONE"],
 "cider": ["ANGRY ORCHARD","STRONGBOW","ACE"], "premixed": ["HIGH NOON","CUTWATER","ON THE ROCKS"], "other": ["GIFT SET","HOLIDAY PACK","MYSTERY"],
}
suffix = {"spirits": ["BOURBON","10YR","SMALL BATCH","SINGLE BARREL","RYE","REPOSADO","VSOP","CASK STRENGTH","RESERVE",""], "wine": ["PINOT NOIR","CHARDONNAY","CABERNET SAUVIGNON","SAUVIGNON BLANC","ROSE","BRUT","PROSECCO","MERLOT","RIESLING","TAWNY PORT"],
  "beer": ["IPA","LAGER","STOUT","PILSNER","HEFEWEIZEN","PALE ALE"], "cider": ["CRISP","DRY","ROSE"], "premixed": ["PINEAPPLE","MARGARITA","OLD FASHIONED"], "other": ["","VARIETY","SAMPLER"]}
weights = {"spirits": .55, "wine": .30, "beer": .08, "cider": .02, "premixed": .03, "other": .02}
sizes = {"spirits": [750,750,750,1000,1750,375,50], "wine": [750,750,1500,375], "beer": [355,473], "cider": [355], "premixed": [355], "other": [750]}
stores = [f"{i:04d}" for i in range(1, 53)]
out = ["PRAGMA defer_foreign_keys = true;"]
for s in stores:
    name = f"STATE STORE #{int(s)}" + (" (Club store for licensed operations only)" if s in ("0033","0034") else "")
    addr = str(100 + int(s)) + " S MAIN ST"
    city = random.choice(["Salt Lake City", "Provo", "Ogden", "St George", "Park City", "Logan", "Sandy"])
    out.append(f"INSERT OR IGNORE INTO stores (id,name,address,city,phone,lat,lng,updated_at) VALUES ({q(s)},{q(name)},{q(addr)},{q(city)},{q('801-555-01' + s[-2:])},40.7,-111.9,{q(iso(now))});")
clean_at = {"ok": now - dt.timedelta(hours=10), "stale": now - dt.timedelta(hours=40), "failed": now - dt.timedelta(hours=34), "incomplete": now - dt.timedelta(hours=34), "never": None}[scen]
obs_old = now - dt.timedelta(days=5)
for i in range(N):
    kind = random.choices(list(weights), list(weights.values()))[0]
    nm = f"{random.choice(words[kind])} {random.choice(suffix[kind])}".strip()
    size = random.choice(sizes[kind]); name = f"{nm} {size}ml"
    sku = f"{200000+i:06d}"
    status = random.choice(["1","1","1","L","L","A","D","U","S","T","X","P","N"])
    out.append(f"INSERT INTO products (sku,name,category,status,status_label,price_cents,size_ml,on_spa,updated_at) VALUES ({q(sku)},{q(name)},{q(random.choice(cats[kind]))},{q(status)},'label {status}',{random.randint(500,30000)},{size},0,{q(iso(now))});")
    r = random.random()
    if i % 97 == 0: continue                      # never fetched -> unknown
    st = random.randint(1, 400) if r < .75 else 0
    wh = random.randint(0, 300)
    inferred = 1 if st == 0 and r < .85 else 0
    o = obs_old if random.random() < .7 else now - dt.timedelta(hours=random.randint(1, 30))
    out.append(f"INSERT INTO inventory_latest (sku,store_key,quantity,store_total_qty,on_order_qty,observed_at,inferred) VALUES ({q(sku)},'',{'NULL' if inferred else wh},{st},{'NULL' if inferred else random.randint(0,50)},{q(iso(o))},{inferred});")
    if i < 300 and st > 0:                          # store-level rows for the first ~300 in-stock SKUs
        left = st
        for s in random.sample(stores, 12):
            qn = min(left, random.randint(0, 40)); left -= qn
            out.append(f"INSERT INTO inventory_latest (sku,store_key,quantity,store_total_qty,on_order_qty,observed_at,inferred) VALUES ({q(sku)},{q(s)},{qn},NULL,NULL,{q(iso(o))},0);")
# Real-looking anchor rows (mirror production SKUs) for UI checks
out.append("INSERT INTO products (sku,name,category,status,status_label,price_cents,size_ml,on_spa,updated_at) VALUES ('018006','BUFFALO TRACE BOURBON 750ml','WHISKEY - BOURBON & TENNESSEE','L','Limited Distribution',3099,750,0,'2026-10-21T21:48:49.046Z');")
out.append(f"INSERT INTO inventory_latest VALUES ('018006','',0,40,198,{q(iso(now - dt.timedelta(hours=3)))},0);")
for s, qn in [("0013", 12), ("0022", 10), ("0034", 8), ("0007", 6), ("0035", 4), ("0001", 0), ("0002", 0)]:
    out.append(f"INSERT INTO inventory_latest VALUES ('018006',{q(s)},{qn},NULL,NULL,{q(iso(now - dt.timedelta(hours=3)))},0);")
if clean_at:
    day = (clean_at - dt.timedelta(hours=7)).strftime("%Y-%m-%d")
    out.append(f"INSERT INTO sweep_state (day,status,next_start,pages_done,total_first,total_last,seen,degraded,vanished_applied,vanish_skipped,error,started_at,updated_at,completed_at) VALUES ({q(day)},'complete',5472,114,5456,5456,'',NULL,12,NULL,NULL,{q(iso(clean_at - dt.timedelta(minutes=50)))},{q(iso(clean_at))},{q(iso(clean_at))});")
    if scen in ("failed", "incomplete"):
        d2 = (now - dt.timedelta(hours=7)).strftime("%Y-%m-%d")
        st2, sk, err = ("failed", None, "http_error at start=480: HTTP 500") if scen == "failed" else ("complete", "degraded: total drifted 5456 -> 5470", None)
        out.append(f"INSERT INTO sweep_state (day,status,next_start,pages_done,total_first,total_last,seen,degraded,vanished_applied,vanish_skipped,error,started_at,updated_at,completed_at) VALUES ({q(d2)},{q(st2)},528,11,5456,5470,'',NULL,0,{q(sk) if sk else 'NULL'},{q(err) if err else 'NULL'},{q(iso(now - dt.timedelta(hours=2)))},{q(iso(now - dt.timedelta(hours=1)))},{q(iso(now - dt.timedelta(hours=1))) if scen=='incomplete' else 'NULL'});")
print("\n".join(out))
