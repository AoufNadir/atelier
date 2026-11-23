// Screenshots for the help center: opens each screen on a site with sample data, saves the picture and where each
// numbered point goes (atelier/public/atelier/guide/<id>.png + shots.json). Run again whenever the screens change.
// Never against a real shop: it opens windows and clicks. Passwords come from the environment, never from this file.
//   RAQMI_URL=http://test.localhost:8000 RAQMI_USER=Administrator RAQMI_PWD=… [RAQMI_SELLER=… RAQMI_SELLER_PWD=…] node tools/dev/guide_shots.mjs
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../atelier/public/atelier/guide");
const URL = process.env.RAQMI_URL || "http://test.localhost:8000";
const W = 1280, H = 760;

// a point: the start (right side, RTL) of a field, or the middle of a button
const at = async (p, sel) => {
  const loc = p.locator(sel);
  const n = await loc.count();
  for (let k = 0; k < n; k++) {
    const b = await loc.nth(k).boundingBox();
    if (!b || b.width < 2) continue;
    const field = await loc.nth(k).evaluate((e) => e.matches("input, textarea, select"));
    const x = field ? b.x + b.width - 16 : b.x + b.width / 2;
    return [+(x / W * 100).toFixed(2), +((b.y + b.height / 2) / H * 100).toFixed(2)];
  }
  return null;
};
// what «open» does before the picture (the live tour does the same)
const OPEN = {
  order: (p) => p.locator("[data-tour=new-order]").first().click(),
  card: (p) => p.locator(".tb-cols .tc2").first().click(),
  customer: (p) => p.locator(".cl-name").first().click(),
};
const { default: GUIDE } = await import(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../atelier/public/atelier/guide.js"));
const SHOTS = GUIDE.filter((a) => a.shot && a.walk);

const login = async (p, usr, pwd) => {
  await p.goto(URL + "/atelier-login");
  const r = await p.evaluate(([u, w]) => fetch("/api/method/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ usr: u, pwd: w }) }).then((x) => x.status), [usr, pwd]);
  if (r !== 200) throw new Error("login failed for " + usr);
};

const browser = await chromium.launch();
fs.mkdirSync(OUT, { recursive: true });
const result = {};
for (const s of SHOTS) {
  const usr = s.shot.seller ? process.env.RAQMI_SELLER : process.env.RAQMI_USER || "Administrator";
  const pwd = s.shot.seller ? process.env.RAQMI_SELLER_PWD : process.env.RAQMI_PWD;
  if (!usr || !pwd) { console.log("skip", s.id, "(no account in the environment)"); continue; }
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  await p.addInitScript(() => { try { localStorage.setItem("atelier.zoom", "1"); localStorage.setItem("raqmi.morning.closed." + new Date().toISOString().slice(0, 10), "1"); } catch { /* fine */ } });
  await login(p, usr, pwd);
  await p.evaluate(() => fetch("/api/method/atelier.api.tour_mark", { method: "POST", headers: { "Content-Type": "application/json", "X-Frappe-CSRF-Token": window.csrf_token || "" }, body: JSON.stringify({ action: "done" }) })).catch(() => {});
  await p.goto(URL + "/atelier" + (s.shot.path === "/" ? "" : s.shot.path)); await p.waitForTimeout(2500);
  if (s.shot.open) { try { await OPEN[s.shot.open](p); await p.waitForTimeout(1500); } catch (e) { console.log("open failed", s.id, e.message); } }
  const pts = [];
  for (const w of s.walk) pts.push(await at(p, w.sel).catch(() => null));
  await p.screenshot({ path: path.join(OUT, s.id + ".png") });
  result[s.id] = { w: W, h: H, points: pts };
  console.log(s.id, JSON.stringify(pts));
  await ctx.close();
}
await browser.close();
const file = path.join(OUT, "shots.json");
const old = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
fs.writeFileSync(file, JSON.stringify({ ...old, ...result }, null, 1));
