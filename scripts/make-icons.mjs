// Generates every launcher icon, splash screen, and web/desktop icon from the
// single source logo (branding/reclaim-logo.png). Re-run after the logo
// changes: `npm run gen:icons`.
//
// The source is a 1254x1254 mark on a near-white background, off-centre in
// its canvas. This measures the mark's actual bounding box and farthest
// point from its own centre (not the image's), then places it fresh on each
// target: centred and padded for tiles/splashes, and scaled to fit inside
// the adaptive-icon safe circle (radius 33dp of the 108dp canvas) so no
// launcher mask (circle, squircle, rounded square, ...) ever clips it.
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "branding/reclaim-logo.png");
const RES = path.join(ROOT, "android/app/src/main/res");
const WEB_ASSETS = path.join(ROOT, "web/assets");
const BUILD = path.join(ROOT, "build");
for (const d of [WEB_ASSETS, BUILD]) fs.mkdirSync(d, { recursive: true });

const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };
const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 };
const written = [];
const out = async (file, pipeline) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await pipeline.png({ compressionLevel: 9 }).toFile(file);
  written.push(path.relative(ROOT, file).replace(/\\/g, "/"));
};

// ---- 0. measure the mark: its bounding box and how far its farthest pixel sits from that box's centre
const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height;
const distFromWhite = (i) => Math.max(255 - data[i], 255 - data[i + 1], 255 - data[i + 2]);
const CONTENT_THRESHOLD = 40; // matches what a human eye reads as "not background" on this logo

let minX = W, minY = H, maxX = -1, maxY = -1;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (distFromWhite((y * W + x) * 4) > CONTENT_THRESHOLD) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}
if (maxX < 0) throw new Error(`${SRC}: found no non-background content — is this the right file?`);
const BBOX = { l: minX, t: minY, r: maxX, b: maxY };
const CONTENT_LONG = Math.max(BBOX.r - BBOX.l + 1, BBOX.b - BBOX.t + 1);
const cx = (BBOX.l + BBOX.r) / 2, cy = (BBOX.t + BBOX.b) / 2;
let MAX_R = 0;
for (let y = BBOX.t; y <= BBOX.b; y++) {
  for (let x = BBOX.l; x <= BBOX.r; x++) {
    if (distFromWhite((y * W + x) * 4) > CONTENT_THRESHOLD) MAX_R = Math.max(MAX_R, Math.hypot(x - cx, y - cy));
  }
}

// ---- 1. clean the source: near-white becomes pure white; also build an antialiased alpha mask for the monochrome layer
const clean = Buffer.from(data);
const mask = Buffer.alloc(W * H);
for (let i = 0, p = 0; i < clean.length; i += 4, p++) {
  const d = distFromWhite(i);
  if (d <= 8) clean[i] = clean[i + 1] = clean[i + 2] = 255;
  clean[i + 3] = 255;
  const t = Math.min(1, Math.max(0, (d - 8) / 62));
  mask[p] = Math.round(t * t * (3 - 2 * t) * 255); // smoothstep: soft edges, solid shapes
}
const PAD = Math.round(CONTENT_LONG * 0.06);
const crop = { left: BBOX.l - PAD, top: BBOX.t - PAD, width: BBOX.r - BBOX.l + 1 + 2 * PAD, height: BBOX.b - BBOX.t + 1 + 2 * PAD };
const sized = (s) => ({ width: Math.round(crop.width * s), height: Math.round(crop.height * s), kernel: "lanczos3" });

const markPng = (scale) => sharp(clean, { raw: { width: W, height: H, channels: 4 } }).extract(crop).resize(sized(scale)).png().toBuffer();

async function monoPng(scale) {
  const a = await sharp(mask, { raw: { width: W, height: H, channels: 1 } }).extract(crop).resize(sized(scale)).raw().toBuffer({ resolveWithObject: true });
  // sharp widens a resized 1-channel image to 3 channels, so step by the reported channel count, not a hardcoded 1
  const ch = a.info.channels;
  if (a.data.length !== a.info.width * a.info.height * ch) throw new Error("unexpected mask buffer size");
  const rgba = Buffer.alloc(a.info.width * a.info.height * 4);
  for (let p = 0; p < a.info.width * a.info.height; p++) rgba[p * 4 + 3] = a.data[p * ch];
  return sharp(rgba, { raw: { width: a.info.width, height: a.info.height, channels: 4 } }).png().toBuffer();
}

// Centre `mark` on an N x N (or W x H) canvas.
async function onCanvas(w, h, markBuf, background) {
  const m = await sharp(markBuf).metadata();
  return sharp({ create: { width: w, height: h, channels: 4, background } }).composite([
    { input: markBuf, left: Math.round(w / 2 - m.width / 2), top: Math.round(h / 2 - m.height / 2) },
  ]);
}
const roundedMask = (n, frac) => Buffer.from(`<svg width="${n}" height="${n}"><rect width="${n}" height="${n}" rx="${n * frac}" ry="${n * frac}" fill="#fff"/></svg>`);
const circleMask = (n) => Buffer.from(`<svg width="${n}" height="${n}"><circle cx="${n / 2}" cy="${n / 2}" r="${n / 2}" fill="#fff"/></svg>`);
const masked = async (pipeline, maskSvg) => sharp(await pipeline.png().toBuffer()).composite([{ input: maskSvg, blend: "dest-in" }]);

const DENSITY = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

// ---- 2. Android launcher icons
for (const [name, d] of Object.entries(DENSITY)) {
  const dir = path.join(RES, `mipmap-${name}`);

  // Adaptive foreground (108dp canvas). Scaled so every visible pixel lands inside the
  // 66dp safe circle (radius 33dp) that every launcher mask shape is guaranteed to show.
  const fgN = Math.round(108 * d);
  const fgScale = (33 * d) / MAX_R;
  await out(path.join(dir, "ic_launcher_foreground.png"), await onCanvas(fgN, fgN, await markPng(fgScale), WHITE));
  await out(path.join(dir, "ic_launcher_monochrome.png"), await onCanvas(fgN, fgN, await monoPng(fgScale), CLEAR));

  // Legacy icons (48dp), for Android before 8.0 where no adaptive icon exists.
  const n = Math.round(48 * d);
  await out(path.join(dir, "ic_launcher.png"), await onCanvas(n, n, await markPng((0.7 * n) / CONTENT_LONG), WHITE));
  await out(path.join(dir, "ic_launcher_round.png"), await masked(await onCanvas(n, n, await markPng((0.78 * (n / 2)) / MAX_R), WHITE), circleMask(n)));
}

// Themed-icon (Android 13+) layer: reference it from both adaptive icon definitions, once.
for (const f of ["ic_launcher.xml", "ic_launcher_round.xml"]) {
  const file = path.join(RES, "mipmap-anydpi-v26", f);
  let xml = fs.readFileSync(file, "utf8");
  if (!xml.includes("<monochrome")) {
    const nl = xml.includes("\r\n") ? "\r\n" : "\n";
    xml = xml.replace("</adaptive-icon>", `    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>${nl}</adaptive-icon>`);
    fs.writeFileSync(file, xml);
    written.push(path.relative(ROOT, file).replace(/\\/g, "/") + " (added monochrome layer)");
  }
}

// ---- 3. Splash screens (shown pre-Android 12; 12+ uses the launcher icon instead): keep every existing size, just redraw it
for (const dir of fs.readdirSync(RES)) {
  const file = path.join(RES, dir, "splash.png");
  if (!/^drawable/.test(dir) || !fs.existsSync(file)) continue;
  const m = await sharp(file).metadata();
  const scale = (0.2 * Math.min(m.width, m.height)) / CONTENT_LONG;
  await out(file, await onCanvas(m.width, m.height, await markPng(scale), WHITE));
}

// ---- 4. Tiles: white rounded square with the mark, for the web favicon/brand, Electron's window icon, and the Windows build
const tile = async (n) => masked(await onCanvas(n, n, await markPng((0.68 * n) / CONTENT_LONG), WHITE), roundedMask(n, 0.22));
await out(path.join(WEB_ASSETS, "icon-192.png"), await tile(192));
await out(path.join(WEB_ASSETS, "icon-512.png"), await tile(512));
await out(path.join(BUILD, "icon.png"), await tile(1024));

// Windows .ico: PNG-compressed entries (supported since Vista). electron-builder
// picks up build/icon.ico automatically for the NSIS installer/exe.
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = [];
for (const s of icoSizes) pngs.push(await (await tile(s)).png().toBuffer());
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(icoSizes.length, 4);
let offset = 6 + 16 * icoSizes.length;
const entries = icoSizes.map((s, i) => {
  const e = Buffer.alloc(16);
  e[0] = s === 256 ? 0 : s;
  e[1] = s === 256 ? 0 : s;
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(pngs[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += pngs[i].length;
  return e;
});
fs.writeFileSync(path.join(BUILD, "icon.ico"), Buffer.concat([header, ...entries, ...pngs]));
written.push("build/icon.ico");

console.log(`${written.length} files written from ${path.relative(ROOT, SRC)}:\n` + written.map((w) => `  ${w}`).join("\n"));
