import { chromium } from "playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import fs from "node:fs";
const OUT = process.env.OUT_DIR || ".";
// Credenziali SOLO da env (audit 21/07: mai committare password in chiaro).
const SHOT_EMAIL = process.env.PRENODO_SHOT_EMAIL || "";
const SHOT_PASSWORD = process.env.PRENODO_SHOT_PASSWORD || "";
if (!SHOT_EMAIL || !SHOT_PASSWORD) {
  console.error("Imposta PRENODO_SHOT_EMAIL e PRENODO_SHOT_PASSWORD nell'ambiente.");
  process.exit(1);
}
const W = 1440, H = 900;
const browser = await chromium.launch();

async function shootNext() {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, reducedMotion: "reduce" });
  await ctx.request.post("http://localhost:3000/api/admin/auth/login", { data: { email: SHOT_EMAIL, password: SHOT_PASSWORD } });
  const page = await ctx.newPage();
  await page.goto("http://localhost:3000/admin", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(4500);
  const buf = await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
  await ctx.close();
  return buf;
}
async function shootPhp() {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto("http://localhost/admin/login", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.fill('input[name="email"]', SHOT_EMAIL);
  await page.fill('input[name="password"]', SHOT_PASSWORD);
  await Promise.all([page.waitForNavigation({ timeout: 45000 }).catch(() => {}), page.press('input[name="password"]', "Enter")]);
  await page.waitForTimeout(1000);
  await page.goto("http://localhost/admin/", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(1500);
  const buf = await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
  await ctx.close();
  return buf;
}
const a = PNG.sync.read(await shootPhp());
const b = PNG.sync.read(await shootNext());
const diff = new PNG({ width: W, height: H });
const m = pixelmatch(a.data, b.data, diff.data, W, H, { threshold: 0.12 });
fs.writeFileSync(`${OUT}/admin_dash.php.png`, PNG.sync.write(a));
fs.writeFileSync(`${OUT}/admin_dash.next.png`, PNG.sync.write(b));
fs.writeFileSync(`${OUT}/admin_dash.diff.png`, PNG.sync.write(diff));
console.log(`admin_dash: ${m} px = ${(m / (W * H) * 100).toFixed(2)}%`);
await browser.close();
