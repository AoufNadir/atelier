// Read-only sweep of the windows (sheets) people open every day: opens each one, measures it, closes it without
// saving. Reports browser errors, failed server calls, text under 12px, rows of buttons that wrap, and windows wider
// than the screen. 1440 and 390. TEST SITES ONLY; manager session saved by check_partial_opening.mjs --login.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const ALLOWED = ["http://test-tour.localhost:8002", "http://test.localhost:8000"];
const BASE = process.env.NASAQ_BASE || ALLOWED[0];
if (!ALLOWED.includes(BASE)) { console.error("Refused: test sites only"); process.exit(2); }
const HOST = new URL(BASE).host;
const OUT = new URL("./out/sheets/", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const STATE = new URL("./out/state-manager.json", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
mkdirSync(OUT, { recursive: true });

// [page, button text that opens a window, optional menu to open first, inline panel instead of a pop-up]
const OPENERS = [
  ["money", "تسجيل دخل"], ["money", "إغلاق الصندوق", null, true], ["money", /مصروف/, "حركة"], ["money", /تحويل/, "حركة", true],
  ["stock", "شراء"], ["stock", /^مادة/], ["customers", "عميل جديد"], ["suppliers", /مورد جديد/, null, true],
  ["", "طلب جديد"], ["?action=payment", null], ["?action=expense", null],
];
const issues = [];
const browser = await chromium.launch();
// orders to open: one delivered (return), one open and priced (cancel, partial delivery)
{
  const ctx = await browser.newContext({ storageState: STATE });
  const get = async (filters) => (await (await ctx.request.get(`${BASE}/api/method/frappe.client.get_list`, { params: { doctype: "Sales Order",
    filters: JSON.stringify(filters), fields: JSON.stringify(["name"]), limit_page_length: "1", order_by: "creation desc" } })).json()).message?.[0]?.name;
  const done = await get({ docstatus: 1, per_billed: 100 }), open = await get({ docstatus: 1, per_delivered: 0 });
  if (done) OPENERS.push([`?card=${done}`, "إرجاع / فاتورة دائنة", "المستندات"], [`?card=${done}`, null]);
  if (open) OPENERS.push([`?card=${open}`, "إلغاء الطلب", "المستندات"], [`?card=${open}`, "تسليم جزء من الطلب", "المستندات"]);
  await ctx.close();
}
for (const [w, h, mobile] of [[1440, 900, false], [390, 844, true]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile, locale: "ar", storageState: STATE });
  await ctx.route("**/*", (r) => (new URL(r.request().url()).host === HOST || r.request().url().startsWith("data:") ? r.continue() : r.abort()));
  // never let a click save anything: refuse every POST except reading calls
  await ctx.route("**/api/method/**", (r) => (r.request().method() === "POST" && !/login|logout/.test(r.request().url()) ? r.abort() : r.continue()));
  for (const [path, label, menu, inline] of OPENERS) {
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push("js: " + e.message));
    page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 400) errs.push(`api ${r.status()} ${r.url().split("/api/method/").pop().split("?")[0]}`); });
    await page.goto(`${BASE}/atelier/${path}`);
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1000);
    const name = `${(path || "home").replace(/[/?=]/g, "_")}-${String(label || "auto").replace(/[^\p{L}\d]+/gu, "_")}-${w}`;
    try {
      if (menu) await page.getByRole("button", { name: new RegExp(menu) }).first().click({ timeout: 5000 });
      if (label) await page.getByRole("button", { name: label }).first().click({ timeout: 5000 });
      await page.waitForTimeout(1200);
    } catch (e) { console.log(`skip  ${name}: ${e.message.split("\n")[0]}`); await page.close(); continue; }
    const r = await page.evaluate((inline) => {
      const box = inline ? document.querySelector("main, #app") || document.body : document.querySelector(".overlay .sheet, .overlay form, .od, [role=dialog]");
      if (!box) return { none: true };
      const small = new Set(), wrapped = [];
      for (const el of box.querySelectorAll("*")) {
        if (!el.offsetParent || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
        const fs = parseFloat(getComputedStyle(el).fontSize);
        if (fs < 12) small.add(`"${el.textContent.trim().slice(0, 20)}" ${fs}px`);
      }
      for (const row of box.querySelectorAll(".btn-row, .sh-foot, .od-ft")) {
        const bs = [...row.querySelectorAll(":scope > button")].filter((b) => b.offsetParent);
        if (bs.length > 1 && new Set(bs.map((b) => Math.round(b.getBoundingClientRect().top))).size > 1 && !row.classList.contains("od-ft")) wrapped.push(bs.map((b) => b.textContent.trim()).join(" | "));
        for (const b of bs) if (b.scrollWidth > b.clientWidth + 2) wrapped.push("cut: " + b.textContent.trim());
      }
      const rect = box.getBoundingClientRect();
      return { small: [...small].slice(0, 5), wrapped, wide: rect.right > innerWidth + 1 || rect.left < -1, over: document.documentElement.scrollWidth - innerWidth };
    }, !!inline);
    const found = [];
    if (r.none) found.push("no window opened");
    for (const e of new Set(errs)) found.push(e);
    if (r.small?.length) found.push("text<12px " + r.small.join("; "));
    if (r.wrapped?.length) found.push("buttons " + r.wrapped.join(" ; "));
    if (r.wide) found.push("window wider than the screen");
    if (r.over > 1) found.push(`sideways scroll ${r.over}px`);
    await page.screenshot({ path: `${OUT}${found.length ? "BAD-" : ""}${name}.png` });
    if (found.length) { issues.push({ name, found }); console.log(`ISSUE ${name}: ${found.join(" | ")}`); } else console.log(`ok    ${name}`);
    await page.close();
  }
  await ctx.close();
}
await browser.close();
writeFileSync(`${OUT}issues.json`, JSON.stringify(issues, null, 2));
console.log(`\n${issues.length} issues. Screenshots in ${OUT}`);
process.exit(issues.length ? 1 : 0);
