/**
 * Scan-verify the tip QR payloads the Worker encodes (owner-approved t85u). Uses the same uqr options as
 * src/tip.ts (ecc M, border 2), rasterizes the matrix, and decodes with ZXing. No wrangler, no network.
 * Run: node --experimental-strip-types scripts/test-tip-qr.ts
 */
import { encode } from "uqr";
import { MultiFormatReader, BarcodeFormat, DecodeHintType, RGBLuminanceSource, BinaryBitmap, HybridBinarizer } from "@zxing/library";

const CASH_QR = "https://cash.app/$Quazar16?qr=1";
const VENMO_QR = "https://www.paypal.com/qrcodes/venmocs/51db6324-8b39-48c1-b215-9ad07680ee72?created=1794872698";
const UQR_OPTS = { ecc: "M" as const, border: 2 };

let passed = 0;
const fails: string[] = [];
function check(name: string, cond: unknown, detail = "") {
  if (cond) { passed++; console.log("  ok  ", name); }
  else { fails.push(detail ? `${name}: ${detail}` : name); console.log("  FAIL", name, detail); }
}

function decodeQr(payload: string): string | null {
  const { data, size } = encode(payload, UQR_OPTS);
  const scale = 8;
  const w = size * scale;
  const lum = new Uint8ClampedArray(w * w);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = data[y][x] ? 0 : 255;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) lum[(y * scale + dy) * w + (x * scale + dx)] = v;
      }
    }
  }
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]);
  hints.set(DecodeHintType.TRY_HARDER, true);
  try {
    const bmp = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(lum, w, w)));
    const reader = new MultiFormatReader();
    reader.setHints(hints);
    return reader.decode(bmp, hints).getText();
  } catch {
    return null;
  }
}

console.log("scan-verify tip QR payloads");
const cashDecoded = decodeQr(CASH_QR);
check("Cash App QR decodes to https://cash.app/$Quazar16?qr=1", cashDecoded === CASH_QR, cashDecoded ?? "decode failed");
const venmoDecoded = decodeQr(VENMO_QR);
check("Venmo QR decodes to the official PayPal Venmo URL", venmoDecoded === VENMO_QR, venmoDecoded ?? "decode failed");

console.log(`\n${passed} passed, ${fails.length} failed`);
for (const f of fails) console.log("  FAILED:", f);
if (fails.length) process.exit(1);
