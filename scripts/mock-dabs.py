#!/usr/bin/env python3
"""Local mock of the DABS Product Locator for fail-closed / caps tests. NEVER used in production.

Run:  python3 scripts/mock-dabs.py 9911
Point the Worker at it with .dev.vars: DABS_BASE_URL=http://127.0.0.1:9911/dyn

State is read from /tmp/mock-dabs-state.json on every request:
  {
    "scenario": "good" | "allzero" | "badshape" | "empty" | "html" | "http500" | "skumismatch",
    "products": [{"sku": "900001", "name": "...", "wh": 1, "st": 2, "oo": 0}, ...],   # catalog; in stock = st > 0
    "fail_at_start": null | <int>,   # inject failure (fail_kind) for the page with this start offset
    "fail_kind": "http500" | "badshape" | "empty" | "html",
    "drift_after": null | <int>,     # after N table requests, hide the first drift_remove in-stock items (list shift)
    "drift_remove": 0,
    "short_page_at": null | <int>,   # return one row fewer than expected for this start offset
    "page_mode": {"<start>": "fail:<code>:<n>"},   # LoadProductTable answers <code> for the first <n> calls at this start ("*" = always)
                 # or "sleep:<ms>:<n>": first <n> calls at this start stall <ms> before answering (timeout tests; "*" = always)
                 # or "drop:<n>": first <n> calls at this start close the connection with no response (non-timeout network error)
    "detail_mode": {"<sku>": "short" | "extra" | "badshape" | "http500" | "nostores" | "drop1" | "drop1above" | "drop1below" | "drop12" | "dup"
                            | "fail:<code>:<n>"     # GetDetailUrl answers <code> for the first <n> calls for this SKU, then works ("*" = always)
                            | "pdfail:<code>:<n>"   # same, but for the ProductDetail request (the 2nd request of a SKU)
                            | "sleep:<ms>:<n>"      # GetDetailUrl stalls <ms> before answering for the first <n> calls (timeout tests)
                            | "pdsleep:<ms>:<n>"}   # same, for the ProductDetail request
  GET /__stats returns request counters {"detail": {sku: n}, "pd": {sku: n}, "table": n, "page": {start: n}} (in-memory, reset on restart).
  }
Products may carry "status" (e.g. "A  Allocated"). ProductDetail lists 5 stores whose qty sums to the product's st
(all in store 0001 except 1 bottle in 0002 when st >= 2), unless detail_mode injects a fault.
"""
import json, sys, time
from urllib.parse import parse_qs
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE = "/tmp/mock-dabs-state.json"
COUNTER = {"table": 0, "detail": {}, "pd": {}, "page": {}}

def scripted_fail(mode, kind, sku):
    """"fail:522:1" / "pdfail:403:*": returns the status code to inject for this call, or None."""
    if not mode or not mode.startswith(kind + ":"): return None
    _, code, n = mode.split(":")
    seen = COUNTER[("detail" if kind == "fail" else "pd")].get(sku, 0)   # already incremented for this call
    return int(code) if n == "*" or seen <= int(n) else None

def scripted_sleep(handler, mode, kind, sku):
    """"sleep:2500:1" / "pdsleep:2500:*": stall, then answer 504 (the client should have timed out already). True if it stalled."""
    if not mode or not mode.startswith(kind + ":"): return False
    _, ms, n = mode.split(":")
    seen = COUNTER[("detail" if kind == "sleep" else "pd")].get(sku, 0)
    if n != "*" and seen > int(n): return False
    time.sleep(int(ms) / 1000)
    try: handler.send(504, "slow", "text/plain")
    except OSError: pass
    return True

def state():
    try:
        return json.load(open(STATE))
    except (OSError, ValueError):
        return {"scenario": "good", "products": []}

def row(p):
    return {"name": p["name"], "sku": p["sku"], "displayGroup": "WHISKEY - BOURBON", "status": p.get("status", "1  General Distribution"),
            "warehouseQty": p["wh"], "storeQty": p["st"], "onOrderQty": p["oo"], "currentPrice": 29.99,
            "onSpa": False, "newItem": False, "inStock": p["st"] > 0}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, body, ctype="application/json; charset=utf-8", extra=None):
        b = body.encode() if isinstance(body, str) else body
        self.send_response(code); self.send_header("Content-Type", ctype)
        for k, v in (extra or {}).items(): self.send_header(k, v)
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def do_POST(self):
        form = {k: v[0] for k, v in parse_qs(self.rfile.read(int(self.headers.get("Content-Length", 0))).decode()).items()}
        st = state(); sc = st.get("scenario", "good")
        COUNTER["table"] += 1
        start, length = int(form.get("start", 0)), int(form.get("length", 25))
        COUNTER["page"][str(start)] = COUNTER["page"].get(str(start), 0) + 1
        pm = (st.get("page_mode") or {}).get(str(start))
        if pm and pm.startswith("sleep:"):
            _, ms, n = pm.split(":")
            if n == "*" or COUNTER["page"][str(start)] <= int(n):
                time.sleep(int(ms) / 1000)
                try: return self.send(504, "slow", "text/plain")   # client should have given up already
                except OSError: return
        if pm and pm.startswith("drop:"):
            n = pm.split(":")[1]
            if n == "*" or COUNTER["page"][str(start)] <= int(n):
                self.close_connection = True
                return
        if pm and pm.startswith("fail:"):
            _, code, n = pm.split(":")
            if n == "*" or COUNTER["page"][str(start)] <= int(n):
                return self.send(int(code), f"injected {code}", "text/plain")
        if sc == "http500" or (st.get("fail_at_start") == start and st.get("fail_kind") == "http500"):
            return self.send(500, "Internal Server Error", "text/plain")
        if sc == "html" or (st.get("fail_at_start") == start and st.get("fail_kind") == "html"):
            return self.send(200, "<html><body>Site under maintenance</body></html>", "text/html")
        if sc == "badshape" or (st.get("fail_at_start") == start and st.get("fail_kind") == "badshape"):
            return self.send(200, json.dumps({"recordsTotal": 3, "recordsFiltered": 3, "data": [{"name": "X", "sku": "12AB", "status": "1"}]}))
        if sc == "empty" or (st.get("fail_at_start") == start and st.get("fail_kind") == "empty"):
            return self.send(200, json.dumps({"recordsTotal": 0, "recordsFiltered": 0, "data": []}))
        prods = sorted(st.get("products", []), key=lambda p: p["name"])
        if form.get("in_stock") == "true":
            prods = [p for p in prods if p["st"] > 0]
            if st.get("drift_after") is not None and COUNTER["table"] > st["drift_after"]:
                prods = prods[st.get("drift_remove", 0):]
        if form.get("item_code"):
            prods = [p for p in prods if p["sku"] == form["item_code"]]
        if form.get("item_name"):
            prods = [p for p in prods if form["item_name"].lower() in p["name"].lower()]
        rows = [row(p) for p in prods]
        if sc == "allzero":
            rows = [dict(r, warehouseQty=0, storeQty=0, onOrderQty=0) for r in rows]
        page = rows[start:start + length]
        if st.get("short_page_at") == start and page:
            page = page[:-1]
        self.send(200, json.dumps({"recordsTotal": len(rows), "recordsFiltered": len(rows), "data": page}))

    def do_GET(self):
        st = state(); sc = st.get("scenario", "good")
        if self.path.startswith("/__stats"):
            return self.send(200, json.dumps(COUNTER))
        if "GetDetailUrl" in self.path:
            sku = self.path.split("sku=")[-1][:6]
            mode = (st.get("detail_mode") or {}).get(sku)
            COUNTER["detail"][sku] = COUNTER["detail"].get(sku, 0) + 1
            if scripted_sleep(self, mode, "sleep", sku): return
            code = scripted_fail(mode, "fail", sku)
            if code: return self.send(code, f"injected {code}", "text/plain")
            if mode == "http500":
                return self.send(500, "Internal Server Error", "text/plain")
            return self.send(200, '"/ProductDetail/Index"', extra={"Set-Cookie": f".AspNetCore.Mvc.CookieTempDataProvider=sku{sku}; path=/; httponly"})
        if "ProductDetail" in self.path and sc == "skumismatch":
            return self.send(200, '<span>111111</span> <span> | </span> <span>1  General Distribution</span>', "text/html")
        if "ProductDetail" in self.path:
            ck = self.headers.get("Cookie", "")
            sku = ck.split("CookieTempDataProvider=sku")[-1][:6] if "CookieTempDataProvider=sku" in ck else ""
            prod = next((p for p in st.get("products", []) if p["sku"] == sku), None)
            if not prod:
                return self.send(404, "nope", "text/plain")
            mode = (st.get("detail_mode") or {}).get(sku)
            COUNTER["pd"][sku] = COUNTER["pd"].get(sku, 0) + 1
            if scripted_sleep(self, mode, "pdsleep", sku): return
            code = scripted_fail(mode, "pdfail", sku)
            if code: return self.send(code, f"injected {code}", "text/plain")
            if mode == "badshape":
                return self.send(200, "<html><body>Something else entirely</body></html>", "text/html")
            qty = [0] * 5
            if prod["st"] >= 2: qty[0], qty[1] = prod["st"] - 1, 1
            else: qty[0] = prod["st"]
            if mode == "short": qty = qty[1:]           # drops the stocked store 0001 -> incomplete
            if mode == "extra": qty[4] += 1             # sum != statewide
            ids = [f"{i:04d}" for i in range(1, 6)][-len(qty):] if mode == "short" else [f"{i:04d}" for i in range(1, 6)]
            # Missing-store rule fixtures (2026-11-02): stores absent but the list still adds up exactly (or not).
            if mode in ("drop1", "drop1above", "drop1below"):   # 0001 absent, its qty moved to 0002 -> sum == statewide
                ids, qty = ["0002", "0003", "0004", "0005"], [prod["st"], 0, 0, 0]
                if mode == "drop1above": qty[0] += 1
                if mode == "drop1below": qty[0] -= 1
            if mode == "drop12":                                   # 0001 and 0002 absent, all qty on 0003
                ids, qty = ["0003", "0004", "0005"], [prod["st"], 0, 0]
            if mode == "dup":                                      # store 0003 listed twice (sum still matches)
                ids, qty = ids + ["0003"], qty + [0]
            rows = "".join(f'<tr><td>{i}</td><td>STORE {i}</td><td>{int(i)} MAIN ST</td><td>SALT LAKE CITY</td><td>801-555-{i}</td><td>{q}</td>'
                           f'<td><a href="https://maps.google.com/?q=40.{int(i)},-111.9">map</a></td></tr>' for i, q in zip(ids, qty))
            table = "<p>No stores currently have this item.</p>" if mode == "nostores" else f'<table id="storeTable"><thead><tr><th>x</th></tr></thead><tbody>{rows}</tbody></table>'
            html = (f'<html><body><span>{sku}</span> <span> | </span> <span>{prod.get("status", "1  General Distribution")}</span>'
                    f'<span>{prod["wh"]}</span> <span class="x">At Warehouse</span> <span>{prod["oo"]}</span> <span class="x">On Order</span>'
                    f'<p>$59.99</p>{table}</body></html>')
            return self.send(200, html, "text/html; charset=utf-8")
        self.send(404, "nope", "text/plain")

ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 9911), H).serve_forever()
