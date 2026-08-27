// Regenerates the runtime brand raster assets from the single authoritative
// master logo (public/brand/ev-media-logo-master.svg).
//
// The master is the official MYEV Media logo, supplied as an SVG that wraps a
// large embedded raster. It is never redrawn, recoloured, or reinterpreted —
// this script only rasterises the SAME artwork at the sizes the UI needs and
// compresses it. Visual appearance and proportions are preserved: the full
// lockup is only ever scaled uniformly (trim removes transparent margin, not
// artwork), and the square icons letterbox the untouched lockup with
// transparent (or white, for Apple) padding — no crop, no new mark.
//
// Run from apps/web:  node scripts/generate-brand-assets.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const master = resolve(webRoot, "public/brand/ev-media-logo-master.svg");
const svg = readFileSync(master);

// Density chosen so the embedded raster renders a bit above the largest
// output size (the master's own embedded bitmap is ~2816px wide, so there is
// no fidelity gained past that and a lot of memory/time lost).
const RENDER_DENSITY = 150;

async function trimmedLockup() {
  const { data, info } = await sharp(svg, { density: RENDER_DENSITY, limitInputPixels: false })
    .trim({ threshold: 1 })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function main() {
  const lockup = await trimmedLockup();
  const aspect = (lockup.width / lockup.height).toFixed(4);
  console.log(`master trimmed lockup: ${lockup.width}x${lockup.height} (aspect ${aspect})`);

  // Full colour horizontal lockup — the primary in-product asset. 720px wide
  // covers the largest on-screen use (~180px) at 3x DPR.
  const LOCKUP_W = 720;
  const lockupResized = await sharp(lockup.data).resize({ width: LOCKUP_W }).toBuffer();
  await sharp(lockupResized).webp({ quality: 90 }).toFile(resolve(webRoot, "public/brand/ev-media-logo.webp"));
  await sharp(lockupResized)
    .png({ palette: true, quality: 90, compressionLevel: 9 })
    .toFile(resolve(webRoot, "public/brand/ev-media-logo.png"));

  // Square app icons: untouched lockup, contained (never cropped) on a square
  // canvas. Transparent for the browser tab icon; white for Apple (iOS masks
  // to a rounded rect and does not honour transparency).
  const iconInner = await sharp(lockup.data).resize({ width: 220, fit: "inside" }).toBuffer();
  await sharp({
    create: { width: 256, height: 256, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: iconInner, gravity: "center" }])
    .png()
    .toFile(resolve(webRoot, "app/icon.png"));

  const appleInner = await sharp(lockup.data).resize({ width: 156, fit: "inside" }).toBuffer();
  await sharp({
    create: { width: 180, height: 180, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .composite([{ input: appleInner, gravity: "center" }])
    .png()
    .toFile(resolve(webRoot, "app/apple-icon.png"));

  console.log("brand assets written: public/brand/ev-media-logo.{webp,png}, app/icon.png, app/apple-icon.png");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
