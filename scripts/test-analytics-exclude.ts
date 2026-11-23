/**
 * Fast unit tests for owner-IP analytics exclusion (OWNER_EXCLUDE_IPS; owner-approved t96u).
 * No wrangler, no network, no real IPs. Run: node --experimental-strip-types scripts/test-analytics-exclude.ts
 */
import { isOwnerExcludedIp, track, type AnalyticsEnv, type PageInfo } from "../src/analytics.ts";

const PAGE: PageInfo = { category: "home", sku: "" };
let passed = 0;
const fails: string[] = [];
function check(name: string, cond: unknown, detail = "") {
  if (cond) { passed++; console.log("  ok  ", name); }
  else { fails.push(detail ? `${name}: ${detail}` : name); console.log("  FAIL", name, detail); }
}

function req(ip: string | null): Request {
  const h = new Headers({ "User-Agent": "UR-Analytics-Exclude-Test/1.0" });
  if (ip !== null) h.set("CF-Connecting-IP", ip);
  return new Request("https://utahremedy.com/", { headers: h });
}

function mockKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => { store.set(key, value); },
    delete: async (key: string) => { store.delete(key); },
  } as unknown as KVNamespace;
}

function env(opts: { secret?: string; events?: { writes: unknown[] } } = {}): AnalyticsEnv {
  const writes = opts.events?.writes ?? [];
  const ev = opts.events
    ? { writeDataPoint: (p: unknown) => { writes.push(p); } }
    : undefined;
  return {
    UTAH_REMEDY_CACHE: mockKv(),
    EVENTS: ev as AnalyticsEngineDataset | undefined,
    OWNER_EXCLUDE_IPS: opts.secret,
  };
}

// Matcher
check("missing secret is not excluded", isOwnerExcludedIp({}, req("203.0.113.10")) === false);
check("empty secret is not excluded", isOwnerExcludedIp({ OWNER_EXCLUDE_IPS: "" }, req("203.0.113.10")) === false);
check("whitespace/comma-only secret is not excluded", isOwnerExcludedIp({ OWNER_EXCLUDE_IPS: "  ,  , " }, req("203.0.113.10")) === false);
check("matching IPv4 is excluded", isOwnerExcludedIp({ OWNER_EXCLUDE_IPS: "203.0.113.10" }, req("203.0.113.10")) === true);
check("non-matching IPv4 is not excluded", isOwnerExcludedIp({ OWNER_EXCLUDE_IPS: "203.0.113.10" }, req("203.0.113.11")) === false);
check("list with spaces matches first and last", isOwnerExcludedIp({ OWNER_EXCLUDE_IPS: "  203.0.113.10 , 203.0.113.11 " }, req("203.0.113.11")) === true);
check("IPv6 exact match", isOwnerExcludedIp({ OWNER_EXCLUDE_IPS: "2001:db8::1" }, req("2001:db8::1")) === true);
check("IPv6 is case-insensitive", isOwnerExcludedIp({ OWNER_EXCLUDE_IPS: "2001:DB8::AB" }, req("2001:db8::ab")) === true);
check("IPv6 non-match", isOwnerExcludedIp({ OWNER_EXCLUDE_IPS: "2001:db8::1" }, req("2001:db8::2")) === false);
check("mixed list with spaces matches IPv6", isOwnerExcludedIp({ OWNER_EXCLUDE_IPS: " 203.0.113.10 , 2001:DB8::1 " }, req("2001:db8::1")) === true);
check("missing CF-Connecting-IP is not excluded", isOwnerExcludedIp({ OWNER_EXCLUDE_IPS: "203.0.113.10" }, req(null)) === false);
check("trimmed header matches", isOwnerExcludedIp({ OWNER_EXCLUDE_IPS: "203.0.113.10" }, req("  203.0.113.10  ")) === true);

// track(): write vs skip
async function written(secret: string | undefined, ip: string, event: "gate_pass" | "visit" = "visit"): Promise<number> {
  const writes: unknown[] = [];
  await track(env({ secret, events: { writes } }), req(ip), event, PAGE);
  return writes.length;
}

await (async () => {
  check("matching IPv4 -> no data point (visit)", (await written("203.0.113.10", "203.0.113.10", "visit")) === 0);
  check("matching IPv4 -> no data point (gate_pass)", (await written("203.0.113.10", "203.0.113.10", "gate_pass")) === 0);
  check("non-matching IPv4 -> data point", (await written("203.0.113.10", "203.0.113.99", "visit")) === 1);
  check("empty secret -> data point", (await written("", "203.0.113.10", "visit")) === 1);
  check("undefined secret -> data point", (await written(undefined, "203.0.113.10", "gate_pass")) === 1);
  check("list with spaces: matching IPv4 -> no data point", (await written("  203.0.113.10 , 2001:db8::1 ", "203.0.113.10")) === 0);
  check("list with spaces: matching IPv6 (case) -> no data point", (await written("  203.0.113.10 , 2001:DB8::1 ", "2001:db8::1")) === 0);
  check("list with spaces: other IP -> data point", (await written("  203.0.113.10 , 2001:db8::1 ", "198.51.100.20")) === 1);

  // Data points must never contain the IP
  const writes: unknown[] = [];
  await track(env({ secret: "", events: { writes } }), req("203.0.113.77"), "visit", PAGE);
  const blob = JSON.stringify(writes);
  check("written data point does not contain the IP", writes.length === 1 && !blob.includes("203.0.113.77"), blob.slice(0, 200));
})();

console.log(`\n${passed} passed, ${fails.length} failed` + (fails.length ? `: ${fails.join("; ")}` : ""));
if (fails.length) process.exit(1);
