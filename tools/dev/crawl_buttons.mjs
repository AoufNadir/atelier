// Clicks every visible button on every page, for each role, at 1440: each click from a fresh page load.
// Reports what breaks: browser errors, server errors (4xx/5xx with their message), English or technical error text
// shown to the user, windows that open off-screen or with text under 12px. Confirm dialogs are ACCEPTED, so this
// changes and deletes data: THROWAWAY LOCAL SITE ONLY (http://test.localhost:8000). Back it up first.
//   node tools/dev/crawl_buttons.mjs [role] [page]
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";

const BASE = "http://test.localhost:8000";
if (process.env.NASAQ_BASE && process.env.NASAQ_BASE !== BASE) { console.error("Refused: throwaway local site only"); process.exit(2); }
const OUT = new URL("./out/crawl/", import.meta.url).pathname;
const STATE = new URL("./out/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const PAGES = {
  manager: ["", "orders", "customers", "suppliers", "money", "reports", "prices", "team", "board-settings", "settings", "stock", "calc"],
  seller: ["", "orders", "customers", "box", "stock"],
  printer: ["", "stock"],
};
// buttons that leave the session or only move between pages already crawled
const SKIP = /^(خروج|تسجيل الخروج|Aa|إغلاق|رجوع|لاحقًا|إلغاء|×)$/;
const [onlyRole, onlyPage] = process.argv.slice(2);
const issues = [];
const browser = await chromium.launch();

async function open(ctx, path) {
  const page = await ctx.newPage();
  const errs = [];
  page.on("dialog", (d) => d.accept().catch(() => {}));
  page.on("pageerror", (e) => errs.push("js: " + e.message.slice(0, 160)));
  page.on("response", async (r) => {
    if (r.url().includes("/api/") && r.status() >= 400 && r.status() !== 417) {
      let msg = "";
      try { const j = await r.json(); msg = j._server_messages ? JSON.parse(JSON.parse(j._server_messages)[0]).message : (j.exception || ""); } catch { /* not json */ }
      errs.push(`api ${r.status()} ${r.url().split("/api/method/").pop().split("?")[0]}: ${String(msg).replace(/<[^>]+>/g, "").slice(0, 160)}`);
    }
  });
  await page.goto(`${BASE}/atelier/${path}`);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1500);  // the board re-renders once its settings arrive
  return { page, errs };
}
const labels = (page) => page.evaluate(() => {
  const seen = new Map();
  for (const b of document.querySelectorAll("button, a[role=button], [role=tab]")) {
    if (!b.offsetParent || b.disabled) continue;
    const t = (b.getAttribute("aria-label") || b.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (!t) continue;
    seen.set(t, (seen.get(t) || 0) + 1);
  }
  return [...seen.keys()];
});

for (const role of Object.keys(PAGES)) {
  if (onlyRole && role !== onlyRole) continue;
  if (!existsSync(`${STATE}state-${role}.json`)) continue;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "ar", storageState: `${STATE}state-${role}.json` });
  await ctx.route("**/*", (r) => (new URL(r.request().url()).host === "test.localhost:8000" || r.request().url().startsWith("data:") ? r.continue() : r.abort()));
  // each load starts like a first visit: views remembered in the browser (calendar, a tab, a zoom) would hide buttons
  await ctx.addInitScript(() => { try { if (!sessionStorage.getItem("crawl")) { localStorage.clear(); sessionStorage.setItem("crawl", "1"); } } catch { /* storage off */ } });
  for (const path of PAGES[role]) {
    if (onlyPage !== undefined && path !== onlyPage) continue;
    const first = await open(ctx, path);
    const list = (await labels(first.page)).filter((t) => !SKIP.test(t));
    for (const e of first.errs) issues.push({ role, path, button: "(load)", e });
    await first.page.close();
    let n = 0;
    for (const label of list) {
      const { page, errs } = await open(ctx, path);
      try {
        // the same button as listed (label + first visible match), clicked like a person would, after scrolling to it
        const hit = await page.evaluate((label) => {
          const b = [...document.querySelectorAll("button, a[role=button], [role=tab]")].find((x) => x.offsetParent && !x.disabled
            && (x.getAttribute("aria-label") || x.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60) === label);
          if (!b) return false;
          b.scrollIntoView({ block: "center", inline: "center" }); b.setAttribute("data-crawl", "1"); return true;
        }, label);
        if (!hit) throw new Error("button gone after reload");
        await page.locator("[data-crawl='1']").click({ timeout: 4000 }).catch(async () => page.evaluate(() => document.querySelector("[data-crawl='1']").click()));
        await page.waitForTimeout(1200);
        const r = await page.evaluate(() => {
          const txt = document.body.innerText;
          const box = document.querySelector(".overlay .sheet, .overlay form, [role=dialog], .cl-pop, .tm-pop");
          const small = [], off = [];
          if (box) {
            const rc = box.getBoundingClientRect();
            if (rc.right > innerWidth + 1 || rc.left < -1 || rc.bottom > innerHeight + 400) off.push(`${Math.round(rc.left)},${Math.round(rc.right)}`);
            for (const el of box.querySelectorAll("*")) {
              if (!el.offsetParent || ![...el.childNodes].some((x) => x.nodeType === 3 && x.textContent.trim())) continue;
              const fs = parseFloat(getComputedStyle(el).fontSize); if (fs < 12) small.push(`${el.textContent.trim().slice(0, 18)} ${fs}px`);
            }
          }
          // technical or English error text shown to a person
          const leak = (txt.match(/(Traceback|Error:|Exception|undefined|NaN|\[object Object\]|is not whitelisted|Not permitted|does not have)[^\n]{0,80}/) || [])[0];
          return { small: small.slice(0, 3), off, leak };
        });
        if (r.leak) errs.push("shown: " + r.leak);
        if (r.small.length) errs.push("text<12px: " + r.small.join("; "));
        if (r.off.length) errs.push("window off-screen " + r.off.join(" "));
      } catch (e) { errs.push("click failed: " + e.message.split("\n")[0].slice(0, 120)); }
      const real = [...new Set(errs)].filter((e) => !/^click failed/.test(e) || !/not visible|detached|intercepts/.test(e));
      if (real.length) {
        const tag = `${role}-${(path || "home").replace(/\//g, "_")}-${++n}`;
        await page.screenshot({ path: `${OUT}${tag}.png` }).catch(() => {});
        for (const e of real) { issues.push({ role, path, button: label, e, shot: tag }); console.log(`ISSUE ${role} /${path} [${label}] ${e}`); }
      }
      await page.close();
    }
    console.log(`done  ${role} /${path}: ${list.length} buttons`);
  }
  await ctx.close();
}
await browser.close();
writeFileSync(`${OUT}issues.json`, JSON.stringify(issues, null, 2));
console.log(`\n${issues.length} issues`);
