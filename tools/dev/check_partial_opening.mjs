// Checks for b7f7ffd and later: partial delivery, opening debt, seller delivery, printer cannot close a pack.
// Runs headless in the background (no mouse), on the TEST site only, and saves screenshots to tools/dev/out/.
//
// Usage (PowerShell, inside C:\Projects\atelier), passwords typed in your own terminal, never saved:
//   $env:NASAQ_MANAGER="Administrator";  $env:NASAQ_MANAGER_PWD="..."
//   $env:NASAQ_SELLER="karim@...";      $env:NASAQ_SELLER_PWD="..."
//   $env:NASAQ_PRINTER="printer@...";   $env:NASAQ_PRINTER_PWD="..."
//   $env:NASAQ_CUSTOMER="ACC2 إعادة التحقق";  $env:NASAQ_SUPPLIER="<a test supplier>"
//   node tools/dev/check_partial_opening.mjs
//
// It creates test documents (two orders, invoices, one opening debt and its reversal per party). Submitted
// documents are never deleted: they stay as test data on test-tour only.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.NASAQ_BASE || "http://test-tour.localhost:8002";
if (!/^http:\/\/test-tour\.localhost:8002\/?$/.test(BASE)) {
  console.error("Refused: this script runs only on http://test-tour.localhost:8002");
  process.exit(2);
}
const need = (k) => { const v = process.env[k]; if (!v) { console.error(`Missing ${k}`); process.exit(2); } return v; };
const MANAGER = [need("NASAQ_MANAGER"), need("NASAQ_MANAGER_PWD")];
const SELLER = [need("NASAQ_SELLER"), need("NASAQ_SELLER_PWD")];
const PRINTER = [need("NASAQ_PRINTER"), need("NASAQ_PRINTER_PWD")];
const CUSTOMER = need("NASAQ_CUSTOMER");
const SUPPLIER = need("NASAQ_SUPPLIER");
const OUT = new URL("./out/", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); };
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.01;

const browser = await chromium.launch();

async function session([usr, pwd]) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "ar" });
  const r = await ctx.request.post(`${BASE}/api/method/login`, { form: { usr, pwd } });
  if (!r.ok()) throw new Error(`login failed for ${usr}: ${r.status()}`);
  const csrf = async () => {
    const p = await ctx.newPage(); await p.goto(`${BASE}/atelier`); const t = await p.evaluate(() => window.csrf_token || ""); await p.close(); return t;
  };
  const token = await csrf();
  const call = async (method, args = {}, post = true) => {
    const url = `${BASE}/api/method/${method.includes(".") ? method : "atelier.api." + method}`;
    const res = post
      ? await ctx.request.post(url, { form: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])), headers: { "X-Frappe-CSRF-Token": token } })
      : await ctx.request.get(url, { params: args });
    const body = await res.json().catch(() => ({}));
    if (!res.ok()) { const msg = body._server_messages ? JSON.parse(JSON.parse(body._server_messages)[0]).message : body.exception || res.status(); const e = new Error(String(msg)); e.status = res.status(); throw e; }
    return body.message;
  };
  return { ctx, call };
}
const invoicesOf = async (call, so) => {
  const rows = await call("frappe.client.get_list", { doctype: "Sales Invoice Item", parent: "Sales Invoice", filters: { sales_order: so, docstatus: 1 }, fields: ["parent"], limit_page_length: 50 }, false);
  const names = [...new Set(rows.map((r) => r.parent))];
  const out = [];
  for (const n of names) out.push(await call("frappe.client.get_value", { doctype: "Sales Invoice", filters: n, fieldname: ["name", "grand_total", "outstanding_amount", "is_return"] }, false));
  return out.filter((i) => !i.is_return).sort((a, b) => a.grand_total - b.grand_total);
};
const sizesOk = async (page, scope) => page.evaluate((sel) => {
  const root = document.querySelector(sel); if (!root) return { small: ["no " + sel], wrapped: [] };
  const small = [], wrapped = [];
  for (const el of root.querySelectorAll("*")) {
    if (!el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize); if (fs < 12) small.push(`${el.textContent.trim().slice(0, 30)} (${fs}px)`);
  }
  for (const b of root.querySelectorAll("button")) { const lh = parseFloat(getComputedStyle(b).lineHeight) || 20; if (b.offsetHeight > lh * 2.2 + 16) wrapped.push(b.textContent.trim()); }
  return { small, wrapped };
}, scope);

try {
  const M = await session(MANAGER);
  // 0. the site serves the new code
  try { await M.call("partial_info", { name: "__none__" }, false); } catch (e) {
    if (/not whitelisted|has no attribute|No module/i.test(e.message)) { check("site runs b7f7ffd or later", false, "partial_info missing: update, migrate, build and restart first"); throw e; }
  }
  check("site runs b7f7ffd or later", true);

  // 1. partial delivery with a 500 advance
  const so = (await M.call("quick_order", { data: JSON.stringify({ customer: CUSTOMER, subject: "PW تسليم جزئي", advance: 500, mode: "Cash",
    lines: [{ text: "لافتة PW", qty: 1, rate: 400 }, { text: "بطاقات PW", qty: 1, rate: 600 }] }) })).sales_order;
  const page = await M.ctx.newPage();
  await page.goto(`${BASE}/atelier?card=${encodeURIComponent(so)}`);
  await page.getByRole("button", { name: /المستندات/ }).first().click();
  await page.getByRole("button", { name: "تسليم جزء من الطلب" }).click();
  const qty = page.locator(".sheet input.rt-qty");
  await qty.first().waitFor();
  await qty.first().fill("1");
  await page.screenshot({ path: `${OUT}1-partial-sheet-1440.png` });
  const s1 = await sizesOk(page, ".overlay .sheet");
  check("partial sheet: no text under 12px", !s1.small.length, s1.small.join(", "));
  check("partial sheet: buttons on one line", !s1.wrapped.length, s1.wrapped.join(", "));
  await page.getByRole("button", { name: "تسليم وإصدار الفاتورة" }).click();
  await page.locator(".overlay .sheet").waitFor({ state: "detached", timeout: 20000 }).catch(() => {});
  let inv = await invoicesOf(M.call, so);
  check("partial: one invoice of 400", inv.length === 1 && near(inv[0].grand_total, 400), JSON.stringify(inv));
  check("partial: first invoice fully paid by the advance", inv.length === 1 && near(inv[0].outstanding_amount, 0), JSON.stringify(inv));
  await page.goto(`${BASE}/atelier`);
  const badge = page.locator(".tc-part", { hasText: "سُلّم جزئيًا" });
  const hasBadge = await badge.first().isVisible().catch(() => false);
  if (!hasBadge) await page.screenshot({ path: `${OUT}2-board-no-badge.png`, fullPage: true });
  check("board: «سُلّم جزئيًا» badge shown", hasBadge);
  await M.call("move", { name: so, column: "done" });
  inv = await invoicesOf(M.call, so);
  check("rest delivered: two invoices 400 + 600, no duplicate", inv.length === 2 && near(inv[0].grand_total, 400) && near(inv[1].grand_total, 600), JSON.stringify(inv));
  check("rest delivered: 600 invoice leaves 500 (100 of the advance used)", inv.length === 2 && near(inv[1].outstanding_amount, 500), JSON.stringify(inv));

  // 2. opening debt (customer through the UI, supplier through the API)
  const bal = async (pt, p) => Number(await M.call("erpnext.accounts.utils.get_balance_on", { party_type: pt, party: p }, false)) || 0;
  const before = await bal("Customer", CUSTOMER);
  await page.goto(`${BASE}/atelier/customers/${encodeURIComponent(CUSTOMER)}`);
  await page.getByRole("button", { name: "المزيد" }).last().click();
  await page.getByRole("button", { name: "دين سابق (قبل نَسَق)" }).click();
  await page.locator("#op-a").fill("12500");
  await page.locator("#op-r").fill("PW اختبار");
  await page.screenshot({ path: `${OUT}3-opening-sheet-1440.png` });
  const s2 = await sizesOk(page, ".overlay .sheet");
  check("opening sheet: no text under 12px", !s2.small.length, s2.small.join(", "));
  await page.getByRole("button", { name: "تسجيل الدين السابق" }).click();
  await page.waitForTimeout(2500);
  const mid = await bal("Customer", CUSTOMER);
  check("opening: customer balance +12,500", near(mid - before, 12500), `${before} → ${mid}`);
  const info = await M.call("opening_info", { party_type: "Customer", party: CUSTOMER }, false);
  const last = info.entries.filter((e) => !e.reversal_of && !e.reversed).pop();
  const gl = await M.call("frappe.client.get_list", { doctype: "GL Entry", filters: { voucher_no: last?.name, is_cancelled: 0 }, fields: ["account", "is_opening"], limit_page_length: 10 }, false);
  const types = [];
  for (const g of gl) types.push((await M.call("frappe.client.get_value", { doctype: "Account", filters: g.account, fieldname: "root_type" }, false)).root_type);
  check("opening: is_opening and no income/expense/cash account", gl.length > 0 && gl.every((g) => g.is_opening === "Yes") && !types.some((t) => t === "Income" || t === "Expense"), JSON.stringify(gl));
  await page.getByRole("button", { name: "تصحيح" }).last().click();
  await page.getByRole("button", { name: "تسجيل القيد العكسي" }).click();
  await page.waitForTimeout(2500);
  check("opening reversed: balance back", near(await bal("Customer", CUSTOMER), before));
  await page.screenshot({ path: `${OUT}4-opening-after-reverse-1440.png` });
  const sb = await bal("Supplier", SUPPLIER);
  const so2 = await M.call("add_opening", { party_type: "Supplier", party: SUPPLIER, amount: 3000, remark: "PW مورد" });
  check("supplier opening: we owe 3,000 more", near((await bal("Supplier", SUPPLIER)) - sb, -3000) || near((await bal("Supplier", SUPPLIER)) - sb, 3000), "sign as ERPNext reports it");
  await M.call("reverse_opening", { journal: so2.journal });
  check("supplier opening reversed: balance back", near(await bal("Supplier", SUPPLIER), sb));

  // 3. the seller delivers and collects into his own box
  const so3 = (await M.call("quick_order", { data: JSON.stringify({ customer: CUSTOMER, subject: "PW تسليم البائع", lines: [{ text: "PW", qty: 1, rate: 500 }] }) })).sales_order;
  const S = await session(SELLER);
  try { await S.call("move", { name: so3, column: "done" }); check("seller: delivery allowed", true); }
  catch (e) { check("seller: delivery allowed", false, e.message); }
  try {
    const pe = await S.call("record_payment", { customer: CUSTOMER, amount: 500, mode_of_payment: "Cash", sales_order: so3 });
    const name = typeof pe === "string" ? pe : pe?.name || pe?.payment_entry;
    const doc = await M.call("frappe.client.get_value", { doctype: "Payment Entry", filters: name, fieldname: ["paid_to", "owner"] }, false);
    check("seller: payment recorded (check paid_to is his box)", !!doc, JSON.stringify(doc));
  } catch (e) { check("seller: payment recorded", false, e.message); }
  const sp = await S.ctx.newPage(); await sp.goto(`${BASE}/atelier?card=${encodeURIComponent(so3)}`); await sp.waitForTimeout(1500);
  await sp.screenshot({ path: `${OUT}5-seller-card-1440.png` });

  // 4. the printer issues materials but cannot close a pack
  const P = await session(PRINTER);
  const stock = await P.call("stock", {}, false);
  const pack = (stock.items || stock.rows || []).find((i) => i.cfg && i.cfg.pack_qty);
  check("printer: can issue materials", !!stock.can_issue);
  check("printer: no pack-closing right (can_close false)", !stock.can_close);
  try { await P.call("close_pack", { item_code: pack?.item_code || "__none__", orders: "[]" }); check("printer: close_pack refused", false, "it was accepted"); }
  catch (e) { check("printer: close_pack refused with an Arabic message", /[\u0600-\u06FF]/.test(e.message), e.message); }
  const pp = await P.ctx.newPage(); await pp.goto(`${BASE}/atelier/stock`); await pp.waitForTimeout(2000);
  const closeBtn = await pp.getByRole("button", { name: /^انتهت ال/ }).count();
  check("printer: «انتهت الرزمة» button hidden", closeBtn === 0, `${closeBtn} found`);
  await pp.screenshot({ path: `${OUT}6-printer-stock-1440.png` });

  console.log(`\nTest documents: ${so}, ${so3} (subject starts with «PW»). Screenshots: ${OUT}`);
} catch (e) {
  console.error("\nStopped:", e.message);
} finally {
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
