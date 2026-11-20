// UI check for partial delivery, opening debt, the seller's delivery and collection, and the printer's rights.
// Every change is made through the interface (clicks, typing, drag and drop); the API is only read to compare
// the documents and balances. Headless, 1440 wide, TEST SITE ONLY (http://test-tour.localhost:8002).
//
// No password is given to the script. Log in once per account in a window the script opens; it keeps only the
// session cookie, locally, in tools/dev/out/ (not committed). Delete that folder to forget the sessions.
//
//   node tools/dev/check_partial_opening.mjs --login manager     (then seller, printer: a window opens, log in, it closes)
//   $env:NASAQ_CUSTOMER="ACC2 إعادة التحقق"; $env:NASAQ_SUPPLIER="<test supplier>"
//   node tools/dev/check_partial_opening.mjs > tools/dev/out/result.txt 2>&1
//
// Creates: one manager order «PW …» (two invoices), opening debts of 12,500 for the customer and the supplier and
// their reversals. Uses SAL-ORD-2026-00022 for the seller (delivery + collection). Never touches SAL-ORD-2026-00021.
import { chromium } from "playwright";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";

// test sites only: the user's test-tour, or a throwaway local site
const ALLOWED = ["http://test-tour.localhost:8002", "http://test.localhost:8000"];
const BASE = process.env.NASAQ_BASE || ALLOWED[0];
if (!ALLOWED.includes(BASE)) { console.error("Refused: test sites only"); process.exit(2); }
const HOST = new URL(BASE).host;
const SELLER_ORDER = process.env.NASAQ_SELLER_ORDER || "SAL-ORD-2026-00022";
const FORBIDDEN = "SAL-ORD-2026-00021";
const OUT = new URL("./out/", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
mkdirSync(OUT, { recursive: true });
const stateOf = (role) => `${OUT}state-${role}.json`;

// ---- one-time login, in a visible window; only the session is kept
const li = process.argv.indexOf("--login");
if (li > 0) {
  const role = process.argv[li + 1];
  if (!["manager", "seller", "printer"].includes(role)) { console.error("--login manager | seller | printer"); process.exit(2); }
  const b = await chromium.launch({ headless: false });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
  const p = await ctx.newPage();
  await p.goto(`${BASE}/login?redirect-to=/atelier`);
  console.log(`Log in as the ${role} in the window. It closes by itself once the app opens.`);
  await p.waitForURL((u) => u.pathname.startsWith("/atelier"), { timeout: 300000 });
  await ctx.storageState({ path: stateOf(role) });
  await b.close();
  console.log(`Saved the ${role} session in ${stateOf(role)}`);
  process.exit(0);
}

const need = (k) => { const v = process.env[k]; if (!v) { console.error(`Missing ${k}`); process.exit(2); } return v; };
const CUSTOMER = need("NASAQ_CUSTOMER"), SUPPLIER = need("NASAQ_SUPPLIER");
for (const r of ["manager", "seller", "printer"]) if (!existsSync(stateOf(r))) { console.error(`No ${r} session: run --login ${r} first`); process.exit(2); }

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); };
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.01;
const stamp = new Date().toISOString().slice(5, 19).replace(/[-T:]/g, "");
const browser = await chromium.launch();

async function session(role) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "ar", storageState: stateOf(role) });
  const page = await ctx.newPage();
  // never leave the test site
  await ctx.route("**/*", (r) => (new URL(r.request().url()).host === HOST || r.request().url().startsWith("data:") ? r.continue() : r.abort()));
  await page.goto(`${BASE}/atelier`);
  if (!page.url().includes("/atelier")) throw new Error(`${role}: session expired, run --login ${role} again`);
  // read-only lookups (GET) for comparing; nothing is written through the API
  const read = async (method, args = {}) => {
    const url = `${BASE}/api/method/${method.includes(".") ? method : "atelier.api." + method}`;
    const res = await ctx.request.get(url, { params: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok()) { const e = new Error(body._server_messages ? JSON.parse(JSON.parse(body._server_messages)[0]).message : String(body.exception || res.status())); e.status = res.status(); throw e; }
    return body.message;
  };
  return { ctx, page, read };
}
const shot = (page, name) => page.screenshot({ path: `${OUT}${name}.png` });
const toastText = async (page) => (await page.locator(".toast, [role=status]").last().textContent({ timeout: 8000 }).catch(() => "")) || "";
const sizes = (page, sel) => page.evaluate((sel) => {
  const root = document.querySelector(sel); if (!root) return { small: ["(window not found)"], wrapped: [] };
  const small = [], wrapped = [];
  for (const el of root.querySelectorAll("*")) {
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize); if (fs < 12) small.push(`${el.textContent.trim().slice(0, 25)} (${fs}px)`);
  }
  for (const b of root.querySelectorAll(".sh-foot button, .btn-row button")) { if (b.getClientRects().length > 1 || b.scrollWidth > b.clientWidth + 1) wrapped.push(b.textContent.trim()); }
  return { small, wrapped };
}, sel);
const invoicesOf = async (read, so) => {
  const rows = await read("frappe.client.get_list", { doctype: "Sales Invoice Item", parent: "Sales Invoice", filters: { sales_order: so, docstatus: 1 }, fields: ["parent"], limit_page_length: 50 });
  const out = [];
  for (const n of [...new Set(rows.map((r) => r.parent))]) out.push(await read("frappe.client.get_value", { doctype: "Sales Invoice", filters: n, fieldname: ["name", "grand_total", "outstanding_amount", "is_return"] }));
  return out.filter((i) => !i.is_return).sort((a, b) => a.grand_total - b.grand_total);
};
// the board uses HTML5 drag and drop: the same events a mouse drag fires, on the card and the delivery column
async function dragToDeliver(page, title) {
  const moved = page.waitForResponse((r) => /move_card|\.move$/.test(r.url()), { timeout: 60000 }).catch(() => null);
  await page.locator("article.tc", { hasText: title }).first().waitFor();
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1500); // the board re-renders once its settings arrive
  const ok = await page.evaluate((title) => {
    const c = [...document.querySelectorAll("article.tc")].find((x) => x.textContent.includes(title));
    const t = document.querySelector("section.tb-col.deliver");
    if (!c || !t) return false;
    const dt = new DataTransfer();
    c.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    t.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
    t.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    c.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
    return true;
  }, title);
  if (!ok) throw new Error("card or delivery column not found: " + title);
  const r = await moved;
  if (!r) throw new Error("no answer from the server after the drag: " + title);
  if (!r.ok()) throw new Error("the server refused the delivery: " + (await r.text()).slice(0, 200));
}
const numbers = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => typeof v === "number"));

try {
  const M = await session("manager");
  // 0. the site serves b7f7ffd or later (the partial-delivery method exists)
  try { await M.read("partial_info", { name: "__none__" }); } catch (e) {
    if (/not whitelisted|has no attribute|No module named/i.test(e.message)) { check("site runs b7f7ffd or later", false, "update, migrate, build and restart first"); throw e; }
  }
  check("site runs b7f7ffd or later", true);

  // 1. manager: new order 400 + 600 with a 500 advance, from the new-order window
  const subject = `PW تسليم جزئي ${stamp}`;
  const p = M.page;
  await p.goto(`${BASE}/atelier/orders/new`);
  await p.locator("#qo-customer").fill(CUSTOMER);
  await p.locator(".cf-list [role=option]", { hasText: CUSTOMER }).first().click();
  await p.locator("#qo-subject").fill(subject);
  const addLine = p.getByRole("button", { name: "بند جديد" });
  const desc = p.locator("textarea.lb-desc"), qtyIn = p.locator("label.lb-c", { has: p.locator("span", { hasText: /^(الكمية|عدد القطع)$/ }) }).locator("input"), rateIn = p.locator('input[placeholder="لاحقًا"]');
  if (await desc.count() < 1) await addLine.click();
  await desc.nth(0).fill("لافتة PW"); await qtyIn.nth(0).fill("1"); await rateIn.nth(0).fill("400");
  await addLine.click();
  await desc.nth(1).fill("بطاقات PW"); await qtyIn.nth(1).fill("1"); await rateIn.nth(1).fill("600");
  await p.locator("#qo-adv").fill("500");
  if (await p.locator("#qo-column").count()) await p.locator("#qo-column").selectOption({ index: 1 });
  await p.getByRole("button", { name: "حفظ الطلب" }).click();
  await p.waitForTimeout(1500);
  if (await p.locator(".od-miss").count()) { await p.locator(".od-miss button").first().click().catch(() => {}); await p.getByRole("button", { name: "حفظ الطلب" }).click(); }
  await p.waitForTimeout(2500);
  const so = (await M.read("frappe.client.get_list", { doctype: "Sales Order", filters: { atelier_subject: subject }, fields: ["name"], limit_page_length: 1 }))[0]?.name;
  check("new order saved from the window", !!so, so || "not found");
  if (!so) { await shot(p, "1-new-order-failed"); throw new Error("no order"); }
  if (so === FORBIDDEN) throw new Error("refused to touch " + FORBIDDEN);

  // 2. «تسليم جزء من الطلب» from the documents menu, first line only
  await p.goto(`${BASE}/atelier?card=${encodeURIComponent(so)}`);
  await p.getByRole("button", { name: /المستندات/ }).first().click();
  await p.getByRole("button", { name: "تسليم جزء من الطلب" }).click();
  const q = p.locator(".overlay .sheet input.rt-qty");
  await q.first().waitFor();
  await q.first().fill("1");
  await shot(p, "2-partial-sheet-1440");
  const s1 = await sizes(p, ".overlay .sheet");
  check("partial window: no text under 12px", !s1.small.length, s1.small.join(", "));
  check("partial window: buttons on one line", !s1.wrapped.length, s1.wrapped.join(", "));
  await p.getByRole("button", { name: "تسليم وإصدار الفاتورة" }).click();
  console.log("      toast:", (await toastText(p)).trim());
  await p.waitForTimeout(1500);
  let inv = await invoicesOf(M.read, so);
  check("partial: one invoice of 400", inv.length === 1 && near(inv[0].grand_total, 400), JSON.stringify(inv));
  check("partial: that invoice is paid by the advance (left 0)", inv.length === 1 && near(inv[0].outstanding_amount, 0), JSON.stringify(inv));

  // 3. the board shows the badge; drag the card to «سُلّم»
  await p.goto(`${BASE}/atelier`);
  await p.keyboard.press("Escape").catch(() => {});
  await p.locator("article.tc", { hasText: subject }).first().waitFor({ timeout: 20000 }).catch(() => {});
  const badge = await p.locator("article.tc", { hasText: subject }).locator(".tc-part").isVisible().catch(() => false);
  await shot(p, "3-board-badge-1440");
  check("board: «سُلّم جزئيًا» on the card", badge);
  await dragToDeliver(p, subject);
  const later = p.getByRole("button", { name: "لاحقًا" });
  if (await later.isVisible({ timeout: 6000 }).catch(() => false)) { await shot(p, "4-collect-after-drag-1440"); await later.click(); }
  await p.waitForTimeout(2500);
  inv = await invoicesOf(M.read, so);
  check("after «سُلّم»: two invoices 400 + 600, no duplicate", inv.length === 2 && near(inv[0].grand_total, 400) && near(inv[1].grand_total, 600), JSON.stringify(inv));
  check("after «سُلّم»: left 0 and 500", inv.length === 2 && near(inv[0].outstanding_amount, 0) && near(inv[1].outstanding_amount, 500), JSON.stringify(inv));

  // 4. opening debt 12,500: customer and supplier, from their pages, then reversed
  const bal = async (pt, party) => (await M.read("frappe.client.get_list", { doctype: "GL Entry", filters: { party_type: pt, party, is_cancelled: 0 },
    fields: ["debit", "credit"], limit_page_length: 0 })).reduce((a, g) => a + Number(g.debit) - Number(g.credit), 0);
  const money0 = numbers(await M.read("money3").catch(() => ({})));
  async function opening(kind, party, path) {
    const before = await bal(kind, party);
    await p.goto(`${BASE}/atelier/${path}/${encodeURIComponent(party)}`);
    await p.getByRole("button", { name: "المزيد" }).last().click();
    await p.getByRole("button", { name: "دين سابق (قبل نَسَق)" }).click();
    await p.locator("#op-a").fill("12500");
    await p.locator("#op-r").fill(`PW ${stamp}`);
    await shot(p, `5-opening-${kind}-1440`);
    const s = await sizes(p, ".overlay .sheet");
    check(`${kind} opening window: no text under 12px, buttons on one line`, !s.small.length && !s.wrapped.length, [...s.small, ...s.wrapped].join(", "));
    await p.getByRole("button", { name: "تسجيل الدين السابق" }).click();
    await p.waitForTimeout(2500);
    const mid = await bal(kind, party);
    check(`${kind}: balance moved by 12,500`, near(Math.abs(mid - before), 12500), `${before} → ${mid}`);
    const info = await M.read("opening_info", { party_type: kind, party });
    const je = info.entries.filter((e) => !e.reversal_of && !e.reversed).pop();
    const gl = await M.read("frappe.client.get_list", { doctype: "GL Entry", filters: { voucher_no: je?.name, is_cancelled: 0 }, fields: ["account", "is_opening"], limit_page_length: 10 });
    const roots = [];
    for (const g of gl) roots.push((await M.read("frappe.client.get_value", { doctype: "Account", filters: g.account, fieldname: ["root_type", "account_type"] })));
    check(`${kind}: opening entry, no sales/expense/cash account`, gl.length === 2 && gl.every((g) => g.is_opening === "Yes")
      && !roots.some((r) => ["Income", "Expense"].includes(r.root_type) || ["Cash", "Bank"].includes(r.account_type)), `${je?.name} ${JSON.stringify(roots)}`);
    await p.getByRole("button", { name: "تصحيح" }).last().click();
    await p.locator("#op-w").fill("PW تصحيح");
    await p.getByRole("button", { name: "تسجيل القيد العكسي" }).click();
    await p.waitForTimeout(2500);
    await shot(p, `6-opening-${kind}-reversed-1440`);
    check(`${kind}: reversed, balance back`, near(await bal(kind, party), before), `${await bal(kind, party)} vs ${before}`);
  }
  await opening("Customer", CUSTOMER, "customers");
  await opening("Supplier", SUPPLIER, "suppliers");
  const money1 = numbers(await M.read("money3").catch(() => ({})));
  const moved = Object.keys(money0).filter((k) => !near(money0[k], money1[k]));
  check("reports and cash unchanged by opening + reversal", !moved.length, moved.map((k) => `${k}: ${money0[k]} → ${money1[k]}`).join(", "));

  // 5. seller (Karim): drags SAL-ORD-2026-00022 to «سُلّم» and collects in the window, into his own box
  if (SELLER_ORDER === FORBIDDEN) throw new Error("refused to touch " + FORBIDDEN);
  const S = await session("seller");
  const sinfo = await M.read("frappe.client.get_value", { doctype: "Sales Order", filters: SELLER_ORDER, fieldname: ["atelier_subject", "grand_total", "per_delivered", "docstatus"] });
  const box0 = await S.read("my_box");
  const posts = [];
  S.page.on("response", async (r) => { if (r.request().method() === "POST" && r.url().includes("/api/method/")) posts.push(`${r.url().split("/").pop()} ${r.status()} ${(await r.text().catch(() => "")).slice(0, 160)}`); });
  await S.page.goto(`${BASE}/atelier`);
  await dragToDeliver(S.page, sinfo.atelier_subject || SELLER_ORDER);
  const collect = S.page.locator(".overlay .stk-collect");
  const shown = await collect.isVisible({ timeout: 8000 }).catch(() => false);
  await shot(S.page, "7-seller-collect-1440");
  check("seller: delivery accepted and the collect window opened", shown, shown ? "" : posts.join(" | "));
  let got = 0;
  if (shown) {
    got = Number((await S.page.locator("#co-a").inputValue()).replace(/[^\d.]/g, "")) || 0;
    await S.page.getByRole("button", { name: "تسجيل التحصيل" }).click();
    await S.page.waitForTimeout(2500);
  }
  const after = await M.read("frappe.client.get_value", { doctype: "Sales Order", filters: SELLER_ORDER, fieldname: ["per_delivered", "per_billed"] });
  check("seller: order delivered and invoiced", near(after.per_delivered, 100) && near(after.per_billed, 100), JSON.stringify(after));
  const box1 = await S.read("my_box");
  check("seller: his box grew by what he collected", !!box1.account && got > 0 && near(box1.balance - box0.balance, got), `${box1.account}: ${box0.balance} → ${box1.balance}`);

  // 6. printer: issues materials, cannot close a pack
  const P = await session("printer");
  await P.page.goto(`${BASE}/atelier/stock`);
  await P.page.waitForTimeout(2500);
  const stock = await P.read("stock");
  check("printer: can issue materials", !!stock.can_issue);
  check("printer: no pack-closing right", !stock.can_close);
  const closeBtn = await P.page.getByRole("button", { name: /^انتهت ال/ }).count();
  check("printer: «انتهت الرزمة» hidden", closeBtn === 0, `${closeBtn} found`);
  await shot(P.page, "8-printer-stock-1440");

  console.log(`\nDocuments created: ${so} («${subject}»), opening debts and reversals marked «PW ${stamp}». Seller order: ${SELLER_ORDER}.`);
} catch (e) {
  console.error("\nStopped:", e.message);
  check("run completed", false, e.message);
} finally {
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  writeFileSync(`${OUT}result.json`, JSON.stringify(results, null, 2));
  console.log(`\n${results.length - failed} passed, ${failed} failed. Screenshots and result.json in ${OUT}`);
  process.exit(failed ? 1 : 0);
}
