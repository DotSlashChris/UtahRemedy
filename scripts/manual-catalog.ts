/**
 * Manual DABS catalog staging helper (owner-approved manual import, used for 2026-11 after abs.utah.gov 403s).
 * Makes NO network requests. Runs the worker's own parseXlsx + validateCatalog on a locally downloaded Product List
 * XLSX and writes the staged list (JSON CatRow[]) exactly as download() stores it at KV dabs:v1:catalog:staged:<period>.
 *
 * Usage: npx tsx scripts/manual-catalog.ts <file.xlsx> <out rows.json> [prev-skus.json] [instock-skus.json] [prev-row-count]
 *   prev-skus.json / instock-skus.json: wrangler d1 --json output of "SELECT sku ..." or a previous staged list (optional, for the diff and the
 *   same sanity guards download() applies: >= 70% of the last complete row count, >= 60% of in-stock SKUs on the list).
 * Exits non-zero (and writes nothing) if validation or a guard fails.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseXlsx, validateCatalog } from "../src/fetchers/catalog-list";

const [file, out, prevPath, inStockPath, prevCountArg] = process.argv.slice(2);
if (!file || !out) { console.error("usage: manual-catalog.ts <file.xlsx> <out.json> [prev-skus.json] [instock-skus.json] [prev-row-count]"); process.exit(2); }
const skusFrom = (p: string): string[] => {
  const j = JSON.parse(readFileSync(p, "utf8"));
  const rows = Array.isArray(j) ? (j[0]?.results ?? j) : j.results;
  return rows.map((r: { sku: string } | string[]) => (Array.isArray(r) ? r[0] : r.sku)); // d1 --json rows or a staged CatRow[]
};
const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };

const buf = new Uint8Array(readFileSync(file));
if (buf.byteLength < 100_000 || buf.byteLength > 15 * 1024 * 1024) fail(`implausible size ${buf.byteLength} bytes`);
const sheet = await parseXlsx(buf);
if (!sheet.ok) fail(sheet.error);
const v = validateCatalog((sheet as { ok: true; value: string[][] }).value);
if (!v.ok) fail(v.error);
const list = (v as { ok: true; value: [string, string, string, string, number | null, number | null, number][] }).value;
const skus = new Set(list.map((r) => r[0]));
const report: Record<string, unknown> = { file, bytes: buf.byteLength, row_count: list.length };
const statusCounts: Record<string, number> = {};
for (const r of list) statusCounts[r[3]] = (statusCounts[r[3]] ?? 0) + 1;
report.status_counts = statusCounts;
const prevCount = prevCountArg ? Number(prevCountArg) : 0;
if (prevCount) {
  report.prev_complete_row_count = prevCount;
  if (list.length < prevCount * 0.7) fail(`row count dropped ${prevCount} -> ${list.length}`);
}
if (prevPath) {
  const prev = new Set(skusFrom(prevPath));
  const added = [...skus].filter((s) => !prev.has(s)), removed = [...prev].filter((s) => !skus.has(s));
  Object.assign(report, { prev_catalog_skus: prev.size, added: added.length, removed: removed.length, added_sample: added.slice(0, 10), removed_sample: removed.slice(0, 10) });
}
if (inStockPath) {
  const inStock = skusFrom(inStockPath);
  const hit = inStock.filter((s) => skus.has(s)).length;
  report.instock_overlap = `${hit}/${inStock.length}`;
  if (inStock.length >= 500 && hit < inStock.length * 0.6) fail(`only ${hit}/${inStock.length} in-stock SKUs are on the list`);
}
writeFileSync(out, JSON.stringify(list));
report.sample = list.slice(0, 3);
console.log(JSON.stringify(report, null, 2));
