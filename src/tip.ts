/**
 * Site-wide tip and footer-link additions, applied with HTMLRewriter AFTER the Cache API, so config changes take
 * effect on the next request with no cache purge:
 *  - Footer "Feedback" link on every HTML page.
 *  - A small "Tip the dev" link in the header nav (next to Disclaimer), and a compact tip section at the bottom of
 *    main, on public HTML 200s (not the age gate or /not-eligible). Hidden when no valid tip method is configured.
 *  - The short DABS notice (PAGE_NOTICE) at the bottom of every HTML page, just above the tip section when one is
 *    shown; at the bottom of main when there is no tip section (gate, /not-eligible, /tip, 404s, or no tip methods).
 *  - /tip: a dedicated, age-gated page. Payment links and QR codes render only for configured methods.
 *
 * Methods: CASHAPP_HANDLE (valid cashtag) and/or VENMO_HANDLE (valid Venmo username or profile URL).
 * Unset/empty/invalid -> that method is omitted (no placeholder, no dead link). Set with
 * `npx wrangler secret put CASHAPP_HANDLE` / `VENMO_HANDLE` (no code change; takes effect without a redeploy)
 * or as a var in wrangler.jsonc + `npm run deploy`.
 */
import { renderSVG } from "uqr";
import { layout, esc, PAGE_NOTICE } from "./web/pages";

export interface TipEnv { CASHAPP_HANDLE?: string; VENMO_HANDLE?: string }

/**
 * Official Venmo-business QR payload decoded from the owner's @Quazar16 "Venmo me" screenshot (2026-11-16).
 * This is a PayPal Venmo QR URL, not the public profile URL https://www.venmo.com/u/Quazar16; the clickable
 * Venmo link still uses the profile URL. Used only when the configured handle is Quazar16.
 */
export const VENMO_QR_FOR_QUAZAR16 =
  "https://www.paypal.com/qrcodes/venmocs/51db6324-8b39-48c1-b215-9ad07680ee72?created=1794872698";

/** Valid Cash App cashtag without the "$" (1-20 chars, letters/digits/_/-, at least one letter), else null. */
export function cashAppHandle(env: TipEnv): string | null {
  const h = (env.CASHAPP_HANDLE ?? "").trim().replace(/^\$/, "");
  return /^(?=.*[A-Za-z])[A-Za-z0-9_-]{1,20}$/.test(h) ? h : null;
}

/** @deprecated alias kept for the original cashtag helper name */
export const tipHandle = cashAppHandle;

/**
 * Valid Venmo username without "@" (1-30 chars, letters/digits/_/-, at least one letter), else null.
 * Accepts a bare handle, @handle, or a venmo.com / venmo.com/u/ profile URL.
 */
export function venmoHandle(env: TipEnv): string | null {
  let h = (env.VENMO_HANDLE ?? "").trim();
  const fromUrl = h.match(/^https?:\/\/(?:www\.)?venmo\.com\/(?:u\/)?([A-Za-z0-9_-]+)\/?$/i);
  if (fromUrl) h = fromUrl[1];
  h = h.replace(/^@/, "");
  return /^(?=.*[A-Za-z])[A-Za-z0-9_-]{1,30}$/.test(h) ? h : null;
}

export interface TipMethod {
  id: "cashapp" | "venmo";
  label: string;
  handleLabel: string;
  href: string;
  qrPayload: string;
  qrLabel: string;
}

export function tipMethods(env: TipEnv): TipMethod[] {
  const out: TipMethod[] = [];
  const cash = cashAppHandle(env);
  if (cash) {
    out.push({
      id: "cashapp",
      label: "Cash App",
      handleLabel: `$${cash}`,
      href: `https://cash.app/$${cash}`,
      qrPayload: `https://cash.app/$${cash}?qr=1`,
      qrLabel: `QR code for Cash App $${cash}`,
    });
  }
  const venmo = venmoHandle(env);
  if (venmo) {
    out.push({
      id: "venmo",
      label: "Venmo",
      handleLabel: `@${venmo}`,
      href: `https://www.venmo.com/u/${venmo}`,
      qrPayload: venmo.toLowerCase() === "quazar16" ? VENMO_QR_FOR_QUAZAR16 : `https://www.venmo.com/u/${venmo}`,
      qrLabel: `QR code for Venmo @${venmo}`,
    });
  }
  return out;
}

/** Crisp monochrome SVG QR (presentation attributes only, so inline SVG stays within style-src 'self'). */
export function qrSvg(payload: string, label: string): string {
  const svg = renderSVG(payload, { ecc: "M", border: 2, pixelSize: 10, whiteColor: "#ffffff", blackColor: "#14181f" });
  return svg.replace(
    /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="([^"]+)">/,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="$1" class="tip-qr-svg" role="img" aria-label="${esc(label)}">`,
  );
}

function methodLink(m: TipMethod): string {
  return `<a class="btn tip-btn" href="${esc(m.href)}" target="_blank" rel="noopener noreferrer external">${esc(m.label)} ${esc(m.handleLabel)}</a>`;
}

function methodQr(m: TipMethod): string {
  return `<figure class="tip-qr tip-qr-${m.id}" data-qr="${esc(m.qrPayload)}"><a href="${esc(m.href)}" target="_blank" rel="noopener noreferrer external">${qrSvg(m.qrPayload, m.qrLabel)}</a><figcaption>${esc(m.label)}</figcaption></figure>`;
}

export function tipFooterHtml(methods: TipMethod[]): string {
  if (!methods.length) return "";
  return `<aside class="tip tip-footer" aria-label="Tip the dev"><div class="tip-text">` +
    `<p class="tip-copy"><strong>Like what you see?</strong> Utah Remedy is an independent project. Tips are optional and help cover hosting and data costs.</p>` +
    `<p class="tip-actions">${methods.map(methodLink).join("")}</p></div>` +
    `<div class="tip-qrs">${methods.map(methodQr).join("")}</div></aside>`;
}

export function tipPageHtml(env: TipEnv): string {
  const methods = tipMethods(env);
  const methodsBlock = methods.length
    ? `<div class="tip-methods">${methods.map((m) =>
      `<div class="tip-method tip-method-${m.id}">${methodQr(m)}<p class="tip-method-link">${methodLink(m)}</p></div>`
    ).join("")}</div>`
    : "";
  const body = `<article class="wrap tip-page">
  <p class="eyebrow">Optional</p>
  <h1>Tip the dev</h1>
  <p class="lede">Utah Remedy is a free tool I built independently to make public Utah liquor data easier to look up. It is not affiliated with or endorsed by the Utah Department of Alcoholic Beverage Services (DABS).</p>
  <p>If the site has been useful &mdash; maybe it saved you a wasted trip &mdash; you are welcome to leave a tip. It is entirely optional. Tips help cover hosting and data costs. There are no perks, and nothing on the site changes if you don&rsquo;t tip.</p>
  ${methodsBlock}
  <p class="muted small">Cash App and Venmo are third-party services. Payment details are entered on their sites or apps, not here. Thank you for using Utah Remedy.</p>
</article>`;
  return layout("Tip the dev", body, {
    description: "Optional tips help cover the cost of running Utah Remedy, a free, independent Utah liquor availability tool. Not affiliated with Utah DABS.",
  });
}

export function tipPage(env: TipEnv): Response {
  return new Response(tipPageHtml(env), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

const FOOTER_LINK = ` <span class="foot-links">&middot; <a href="/feedback">Feedback</a></span>`;
const SKIP_TIP = new Set(["/gate", "/not-eligible"]);

export function addSiteLinks(res: Response, env: TipEnv, path: string): Response {
  if (!(res.headers.get("Content-Type") || "").includes("text/html")) return res;
  let rw = new HTMLRewriter().on("footer.site-footer .wrap", { element(el) { el.append(FOOTER_LINK, { html: true }); } });
  const methods = tipMethods(env);
  const showTip = methods.length > 0 && res.status === 200 && !SKIP_TIP.has(path);
  if (showTip) {
    rw = rw.on("header.site-header nav.nav", {
      element(el) { el.append(`<a href="/tip">Tip the dev</a>`, { html: true }); },
    });
  }
  const tip = showTip && path !== "/tip" ? tipFooterHtml(methods) : "";
  rw = rw.on("main", { element(el) { el.append(`<div class="wrap">${PAGE_NOTICE}${tip}</div>`, { html: true }); } });
  return rw.transform(res);
}
