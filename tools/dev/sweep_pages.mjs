// Read-only sweep of every page, for each role, at 1440 (desktop) and 390 (phone): opens the page, waits, and
// reports browser errors, failed server calls, text under 12px, sideways page scroll and action rows that wrap.
// Nothing is clicked that changes data. TEST SITES ONLY. Uses the sessions saved by check_partial_opening.mjs --login.
//   node tools/dev/sweep_pages.mjs            (NASAQ_BASE=http://test.localhost:8000 for a local throwaway site)
import { chromium } from "playwright";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";

const ALLOWED = ["http://test-tour.localhost:8002", "http://test.localhost:8000"];
const BASE = process.env.NASAQ_BASE || ALLOWED[0];
if (!ALLOWED.includes(BASE)) { console.error("Refused: test sites only"); process.exit(2); }
const HOST = new URL(BASE).host;
const OUT = new URL("./out/sweep/", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const STATE = new URL("./out/", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
mkdirSync(OUT, { recursive: true });

const PAGES = {
  manager: ["", "orders", "orders/new", "customers", "suppliers", "money", "reports", "prices", "team", "board-settings", "settings", "stock", "calc"],
  seller: ["", "orders", "orders/new", "customers", "box", "stock"],
  printer: ["", "stock"],
};
const WIDTHS = [[1440, 900, false], [390, 844, true]];
const issues = [];
const note = (role, path, w, kind, detail) => { issues.push({ role, path, w, kind, detail }); console.log(`ISSUE ${role} /${path} @${w} ${kind}: ${detail}`); };

const browser = await chromium.launch();
for (const role of Object.keys(PAGES)) {
  if (!existsSync(`${STATE}state-${role}.json`)) { console.log(`skip ${role}: no saved session`); continue; }
  for (const [w, h, mobile] of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile, locale: "ar", storageState: `${STATE}state-${role}.json` });
    await ctx.route("**/*", (r) => (new URL(r.request().url()).host === HOST || r.request().url().startsWith("data:") ? r.continue() : r.abort()));
    // first customer / supplier pages too, when the role may see them
    const extra = [];
    for (const path of [...PAGES[role], ...extra]) {
      const page = await ctx.newPage();
      const errs = [];
      page.on("pageerror", (e) => errs.push("js: " + e.message));
      page.on("response", (r) => { const u = r.url(); if (u.includes("/api/") && r.status() >= 400) errs.push(`api ${r.status()} ${u.split("/api/method/").pop().split("?")[0]}`); });
      await page.goto(`${BASE}/atelier/${path}`);
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(1200);
      if (path === "customers" || path === "suppliers") {
        const first = page.locator("table tbody tr, .cl-row, [data-row]").first();
        if (await first.count()) { await first.click().catch(() => {}); await page.waitForTimeout(1500); }
      }
      const r = await page.evaluate(() => {
        const small = new Set(), wrapped = [];
        for (const el of document.querySelectorAll("body *")) {
          if (!el.offsetParent && getComputedStyle(el).position !== "fixed") continue;
          if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
          const fs = parseFloat(getComputedStyle(el).fontSize);
          if (fs < 12) small.add(`${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ")[0]} "${el.textContent.trim().slice(0, 20)}" ${fs}px`);
        }
        for (const row of document.querySelectorAll(".btn-row, .sh-foot")) {
          const bs = [...row.querySelectorAll(":scope > button, :scope > a")].filter((b) => b.offsetParent);
          if (bs.length > 1 && new Set(bs.map((b) => Math.round(b.getBoundingClientRect().top))).size > 1) wrapped.push(bs.map((b) => b.textContent.trim()).join(" | "));
        }
        const over = document.documentElement.scrollWidth - document.documentElement.clientWidth;
        return { small: [...small].slice(0, 6), wrapped, over, loading: /جارٍ التحميل/.test(document.body.innerText) };
      });
      const tag = `${role}-${(path || "home").replace(/\//g, "_")}-${w}`;
      let bad = false;
      for (const e of [...new Set(errs)]) { note(role, path, w, "error", e); bad = true; }
      if (r.small.length) { note(role, path, w, "text<12px", r.small.join("; ")); bad = true; }
      if (r.wrapped.length) { note(role, path, w, "buttons wrap", r.wrapped.join(" ; ")); bad = true; }
      if (r.over > 1) { note(role, path, w, "sideways scroll", `${r.over}px`); bad = true; }
      if (r.loading) { note(role, path, w, "still loading", "after 1.2s + network idle"); bad = true; }
      await page.screenshot({ path: `${OUT}${bad ? "BAD-" : ""}${tag}.png`, fullPage: false });
      if (!bad) console.log(`ok    ${role} /${path} @${w}`);
      await page.close();
    }
    await ctx.close();
  }
}
await browser.close();
writeFileSync(`${OUT}issues.json`, JSON.stringify(issues, null, 2));
console.log(`\n${issues.length} issues. Screenshots in ${OUT}`);
process.exit(issues.length ? 1 : 0);
