// Two people (or a double click) at the same moment, on the throwaway local site: delivering the same order three
// times at once must give one delivery note and one invoice; paying the full amount twice at once must refuse the second.
import { chromium } from "playwright";
const B = "http://test.localhost:8000";
const OUT = new URL("./out/", import.meta.url).pathname; const b = await chromium.launch();
const mk = async (role) => { const ctx = await b.newContext({ storageState: `${OUT}state-${role}.json` }); const p = await ctx.newPage(); await p.goto(B + "/atelier"); const t = await p.evaluate(() => window.csrf_token);
  return (m, a) => ctx.request.post(B + "/api/method/atelier.api." + m, { headers: { "X-Frappe-CSRF-Token": t }, form: a }).then(async (r) => ({ s: r.status(), j: await r.json().catch(() => ({})) })); };
const M = await mk("manager"), S = await mk("seller");
const so = (await M("quick_order", { data: JSON.stringify({ customer: "Test Client", subject: "سباق " + Date.now(), lines: [{ text: "x", qty: 1, rate: 700 }] }) })).j.message.sales_order;
const res = await Promise.all([M("move_card", { name: so, column: "c-done" }), S("move_card", { name: so, column: "c-done" }), M("move_card", { name: so, column: "c-done" })]);
console.log("double delivery:", res.map((r) => r.s).join(","));
const ctx = await b.newContext({ storageState: `${OUT}state-manager.json` });
const inv = (await (await ctx.request.get(B + "/api/method/frappe.client.get_list", { params: { doctype: "Sales Invoice Item", parent: "Sales Invoice", filters: JSON.stringify({ sales_order: so, docstatus: 1 }), fields: '["parent"]' } })).json()).message;
const dn = (await (await ctx.request.get(B + "/api/method/frappe.client.get_list", { params: { doctype: "Delivery Note Item", parent: "Delivery Note", filters: JSON.stringify({ against_sales_order: so, docstatus: 1 }), fields: '["parent"]' } })).json()).message;
console.log("invoices", new Set(inv.map((x) => x.parent)).size, "delivery notes", new Set(dn.map((x) => x.parent)).size);
// two payments of the full amount at the same moment
const inv1 = inv[0]?.parent;
const pay = await Promise.all([M("record_payment", { customer: "Test Client", amount: 700, mode_of_payment: "Cash", sales_order: so }), S("record_payment", { customer: "Test Client", amount: 700, mode_of_payment: "Cash", sales_order: so })]);
console.log("double payment:", pay.map((r) => r.s).join(","));
const out = (await (await ctx.request.get(B + "/api/method/frappe.client.get_value", { params: { doctype: "Sales Invoice", filters: inv1, fieldname: "outstanding_amount" } })).json()).message;
console.log("invoice outstanding after both:", JSON.stringify(out));
await b.close();
