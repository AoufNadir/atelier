// UI checks + screenshots of the local app in headless Edge (DevTools protocol, no extra packages).
// Usage: node scripts/shots.mjs   → docs/screenshots/*.png + a test summary on stdout.
// Logs in with the frappe_docker dev default account (local demo site only).
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const BASE = "http://development.localhost:8000";
const OUT = new URL("../docs/screenshots/", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const PORT = 9333;
mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) if (f.endsWith(".png")) rmSync(join(OUT, f));

const ALPHA = "/atelier/customers/Client%20Alpha%20(D%C3%89MO)";
const D = [1366, 1440, 1920], M = [360, 390, 430];
const SHOTS = [
  ...D.map((w) => [`d${w}-1-home`, "/atelier", { width: w, height: 900 }]),
  ["d1440-1b-home-kpi-open", "/atelier", { width: 1440, height: 900 }, "openKpi"],
  ...D.map((w) => [`d${w}-2-new-order`, "/atelier/orders/new", { width: w, height: 900 }, "fillOrder"]),
  ...D.map((w) => [`d${w}-3-customer`, ALPHA, { width: w, height: 900 }]),
  ["d1440-3b-customer-ledger", ALPHA, { width: 1440, height: 900 }, "ledgerTab"],
  ["d1366-4-orders", "/atelier/orders", { width: 1366, height: 900 }],
  ["d1440-5-collapsed", "/atelier", { width: 1440, height: 900 }, "collapse"],
  ...M.map((w) => [`m${w}-1-home`, "/atelier", { width: w, height: 800, mobile: true }, null, false]),
  ...M.map((w) => [`m${w}-2-order-items`, "/atelier/orders/new", { width: w, height: 800, mobile: true }, "fillOrderItems", false]),
  ...M.map((w) => [`m${w}-3-order-end`, "/atelier/orders/new", { width: w, height: 800, mobile: true }, "fillOrderEnd", false]),
  ...M.map((w) => [`m${w}-4-customer`, ALPHA, { width: w, height: 800, mobile: true }, null, false]),
  ["m390-5-payment", "/atelier?action=payment", { width: 390, height: 844, mobile: true }, null, false],
  ...["money", "stock", "machines", "reports"].flatMap((p, i) => [
    ...D.map((w) => [`d${w}-${6 + i}-${p}`, `/atelier/${p}`, { width: w, height: 900 }]),
    ...M.map((w) => [`m${w}-${6 + i}-${p}`, `/atelier/${p}`, { width: w, height: 800, mobile: true }]),
  ]),
  ["d1440-10-expense", "/atelier/money?action=expense", { width: 1440, height: 900 }, null, false],
  ...M.map((w) => [`m${w}-10-expense`, "/atelier/money?action=expense", { width: w, height: 800, mobile: true }, null, false]),
  ...D.map((w) => [`d${w}-11-customers`, "/atelier/customers", { width: w, height: 900 }]),
  ...M.map((w) => [`m${w}-11-customers`, "/atelier/customers", { width: w, height: 800, mobile: true }]),
  ["d1440-12-customer-edit", ALPHA, { width: 1440, height: 900 }, "editCustomer", false],
  ["m390-12-customer-edit", ALPHA, { width: 390, height: 800, mobile: true }, "editCustomer", false],
  ["m390-13-new-customer", "/atelier/customers", { width: 390, height: 844, mobile: true }, "newCompanySub", false],
  ...D.map((w) => [`d${w}-14-prices`, "/atelier/prices", { width: w, height: 900 }]),
  ...M.map((w) => [`m${w}-14-prices`, "/atelier/prices", { width: w, height: 800, mobile: true }]),
  ["d1440-15-order-company", "/atelier/orders/new?customer=Client%20Beta%20(D%C3%89MO)", { width: 1440, height: 900 }, "companyOrder", false],
  ...[1366, 1440].map((w) => [`d${w}-16-order-pricing`, "/atelier/orders/SAL-ORD-2026-00005", { width: w, height: 900 }]),
  ["d1440-17-order-done", "/atelier/orders/SAL-ORD-2026-00006", { width: 1440, height: 900 }],
  ...M.map((w) => [`m${w}-16-order-pricing`, "/atelier/orders/SAL-ORD-2026-00005", { width: w, height: 800, mobile: true }]),
  ["m390-17-order-done", "/atelier/orders/SAL-ORD-2026-00006", { width: 390, height: 800, mobile: true }],
  ["d1440-18-new-item", "/atelier/prices", { width: 1440, height: 900 }, "newItem", false],
  ["m390-18-new-item", "/atelier/prices", { width: 390, height: 844, mobile: true }, "newItem", false],
  ["d1440-19-design-system", "/atelier/ds", { width: 1440, height: 900 }],
  ["m390-19-design-system", "/atelier/ds", { width: 390, height: 800, mobile: true }],
  ["m390-9-more", "/atelier/more", { width: 390, height: 800, mobile: true }, null, false],
].filter((s) => !/^fillOrder/.test(s[3] || "")); // the old multi-step order form is gone: the board's one-form panel replaced it

const ITEMS = [
  ["SRV-DESIGN-DEMO", "1", "15000", "هوية بصرية كاملة مع دليل استخدام مختصر ونماذج جاهزة للطباعة"],
  ["SRV-PRINT-DEMO", "2000", "22", ""],
  ["SRV-PRINT-DEMO", "500", "12", "بطاقات زيارة وجهين"],
  ["SRV-OFFSET-DEMO", "5000", "6.5", ""],
  ["SRV-FINISH-DEMO", "1", null, "تركيب لافتة الواجهة 6×1.5 م"],
];
const ACTIONS = {
  fillOrder: `(async () => {
    const w = (ms) => new Promise(r => setTimeout(r, ms));
    const set = (el, v) => { el.value = v; el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', {bubbles: true})); };
    const btn = (txt) => [...document.querySelectorAll('button')].find(b => b.textContent.includes(txt));
    btn('عميل جديد').click(); await w(400);
    set(document.getElementById('f-nc-name'), 'شركة الواحة للتجهيزات الفندقية والمطاعم الكبرى (تجريبي)');
    set(document.getElementById('f-nc-phone'), '0550 00 00 00');
    set(document.getElementById('f-subject'), 'حملة إشهارية كاملة لافتتاح الفرع الجديد: مطويات، بطاقات، ملصقات ولافتة واجهة');
    const items = ${JSON.stringify(ITEMS)};
    for (let i = 0; i < items.length; i++) {
      if (i) { btn('إضافة بند').click(); await w(120); }
      const [code, q, r, d] = items[i];
      set(document.getElementById('it-' + i), code); set(document.getElementById('q-' + i), q);
      set(document.getElementById('r-' + i), r === null ? '' : r);  // an empty price = priced later
      if (d) { document.querySelectorAll('.line.items-grid')[i].querySelector('[aria-expanded]').click(); await w(80); set(document.getElementById('d-' + i), d); }
    }
    const det = document.querySelector('details.collapse'); if (det) det.open = true; await w(80);
    btn('إضافة تكلفة').click(); await w(80);
    set(document.getElementById('ct-0'), 'Sous-traitance'); set(document.getElementById('cd-0'), 'أوفست الملصقات'); set(document.getElementById('cq-0'), '5000'); set(document.getElementById('cr-0'), '4');
    btn('إضافة تكلفة').click(); await w(80);
    set(document.getElementById('ct-1'), 'Finition'); set(document.getElementById('cd-1'), 'تركيب اللافتة');
    set(document.getElementById('f-adv'), '20000');
    document.activeElement?.blur(); window.scrollTo(0, 0);
  })()`,
  ledgerTab: `document.getElementById('tab-ledger')?.click()`,
  openKpi: `document.querySelector('.kpi')?.click()`,
  collapse: `document.querySelector('.collapse-btn')?.click()`,
  newCompanySub: `(async () => { [...document.querySelectorAll('button')].find(b => b.textContent.includes('عميل جديد')).click(); await new Promise(r => setTimeout(r, 500));
    const segs = document.querySelectorAll('.sheet .seg'); segs[0].querySelectorAll('button')[1].click(); segs[1].querySelectorAll('button')[1].click(); document.activeElement?.blur(); })()`,
  companyOrder: `(async () => { const w = (ms) => new Promise(r => setTimeout(r, ms)); await w(800);
    const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('change', {bubbles: true})); };
    const add = () => [...document.querySelectorAll('button')].find(b => b.textContent.includes('إضافة بند')).click();
    set(document.getElementById('it-0'), 'SRV-PRINT-DEMO'); add(); await w(120); set(document.getElementById('it-1'), 'SRV-FINISH-DEMO'); await w(150);
    document.activeElement?.blur(); window.scrollTo(0, 0); })()`,
  newItem: `(async () => { [...document.querySelectorAll('button')].find(b => b.textContent.includes('خدمة أو منتج جديد')).click(); await new Promise(r => setTimeout(r, 500)); document.activeElement?.blur(); })()`,
  editCustomer: `(async () => { [...document.querySelectorAll('button')].find(b => b.textContent.includes('تعديل البيانات')).click(); await new Promise(r => setTimeout(r, 1200)); })()`,
};
ACTIONS.fillOrderItems = `${ACTIONS.fillOrder}.then(() => { const s = document.getElementById('it-0').closest('section'); window.scrollTo(0, s.getBoundingClientRect().top + scrollY - 70); })`;
ACTIONS.fillOrderEnd = `${ACTIONS.fillOrder}.then(() => window.scrollTo(0, document.body.scrollHeight))`;

// Checks run on every page.
const CHECKS = `(() => {
  const r = {};
  r.overflow = document.documentElement.scrollWidth > innerWidth ||
    [...document.querySelectorAll('body *')].some(e => { if (e.closest('.overlay, .table-wrap, .bd-cols, .tb-cols, .tabs, .st2-nav, .cl-tabs')) return false; const b = e.getBoundingClientRect(); return b.width && (b.right > innerWidth + 1 || b.left < -1); });
r.font = document.fonts.check('15px "Cairo"') && getComputedStyle(document.body).fontFamily.includes('Cairo');
  // Vertical clipping of Arabic glyphs in single-line ellipsis elements.
  r.clipped = [...document.querySelectorAll('.ellipsis')].filter(e => e.offsetParent && e.scrollHeight > e.clientHeight + 1).length;
  const nav = document.querySelector('.bottom-nav'), bar = document.querySelector('.save-bar');
  r.bottomNavVisible = !!(nav && nav.offsetParent);
  r.saveBarVisible = !!(bar && getComputedStyle(bar).display !== 'none');
  if (r.saveBarVisible && r.bottomNavVisible) {
    const a = bar.getBoundingClientRect(), b = nav.getBoundingClientRect(); r.overlap = a.bottom > b.top && a.top < b.bottom;
  }
  r.fabVisible = !!document.querySelector('.bottom-nav .fab')?.offsetParent;
  r.smallText = [...document.querySelectorAll('body *')].filter(e => e.offsetParent && e.childNodes.length && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && parseFloat(getComputedStyle(e).fontSize) < 12).length;
  return r;
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "atelier-shots-"))}`,
  "--no-first-run", "--hide-scrollbars", "--lang=ar", "about:blank"], { stdio: "ignore" });

let ws, id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params }));
});
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
const setViewport = (vp, height = vp.height) => send("Emulation.setDeviceMetricsOverride", { width: vp.width, height, deviceScaleFactor: vp.mobile ? 2 : 1,
  mobile: !!vp.mobile, screenWidth: vp.width, screenHeight: vp.height });
const key = async (k, code, keyCode, shift = false) => {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: keyCode, modifiers: shift ? 8 : 0, ...(k === "Enter" ? { text: "\r" } : {}) });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: keyCode, modifiers: shift ? 8 : 0 });
};
const problems = [];

try {
  let targets;
  for (let i = 0; i < 40 && !targets; i++) { await sleep(250); targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).catch(() => null); }
  ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.rej(d.error) : p.res(d.result); } };
  await send("Page.enable"); await send("Runtime.enable");
  await send("Page.navigate", { url: `${BASE}/login` }); await sleep(2500);
  console.log("login:", await evaluate(`fetch('/api/method/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({usr:'Administrator',pwd:'admin'})}).then(r=>r.status)`));

  for (const [name, path, vp, action, fullPage = true] of SHOTS) {
    await setViewport(vp);
    await send("Emulation.setTouchEmulationEnabled", { enabled: !!vp.mobile });
    await evaluate(`localStorage.removeItem('atelier.orderDraft.v1'); localStorage.removeItem('atelier.sidebarCollapsed')`);
    await send("Page.navigate", { url: BASE + path }); await sleep(2800);
    await evaluate("document.fonts.ready.then(() => true)");
    if (action) { await evaluate(ACTIONS[action]); await sleep(700); }
    const c = await evaluate(CHECKS);
    const height = fullPage ? Math.max(vp.height, await evaluate("Math.ceil(document.documentElement.scrollHeight)")) : vp.height;
    const shot = height > vp.height
      ? await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: vp.width, height, scale: 1 } })
      : await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(shot.data, "base64"));
    const flags = [c.overflow && "OVERFLOW", !c.font && "FONT-NOT-LOADED", c.clipped && `CLIPPED:${c.clipped}`, c.overlap && "SAVEBAR-OVERLAP",
      path.includes("orders/new") && vp.mobile && (c.bottomNavVisible || c.fabVisible) && "NAV-VISIBLE-WHILE-EDITING",
      path.includes("orders/new") && vp.mobile && !c.saveBarVisible && "NO-SAVE-BAR", c.smallText && `TEXT<12px:${c.smallText}`].filter(Boolean);
    if (flags.length) problems.push(`${name}: ${flags.join(", ")}`);
    console.log(name.padEnd(30), `${vp.width}x${height}`, flags.length ? flags.join(", ") : "ok");
  }

  // Phone keyboard: focus the last field, shrink the viewport like a real keyboard (resizes-content), check visibility.
  for (const w of []) { // old order-form keyboard check, kept for when a phone form test returns
    const vp = { width: w, height: 800, mobile: true };
    await setViewport(vp); await evaluate(`localStorage.removeItem('atelier.orderDraft.v1')`);
    await send("Page.navigate", { url: `${BASE}/atelier/orders/new` }); await sleep(2500);
    await evaluate(ACTIONS.fillOrder); await sleep(400);
    await evaluate(`document.getElementById('f-adv').focus()`);
    await setViewport(vp, 440); await sleep(900);
    const k = await evaluate(`(() => { const el = document.activeElement.getBoundingClientRect(), bar = document.querySelector('.save-bar').getBoundingClientRect();
      return { keyboard: document.body.classList.contains('keyboard-open'), fieldVisible: el.top >= 0 && el.bottom <= bar.top, barBottom: Math.round(bar.bottom), vh: innerHeight }; })()`);
    const shot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, `m${w}-6-keyboard.png`), Buffer.from(shot.data, "base64"));
    const ok = k.keyboard && k.fieldVisible && k.barBottom <= k.vh;
    if (!ok) problems.push(`keyboard ${w}: ${JSON.stringify(k)}`);
    console.log(`keyboard ${w}`.padEnd(30), ok ? "ok (field visible above save bar)" : JSON.stringify(k));
  }

  //   // Keyboard-only navigation on desktop: Tab through the order form, the save button must be reachable with a visible focus ring.
  //   await setViewport({ width: 1440, height: 900 }); await send("Emulation.setTouchEmulationEnabled", { enabled: false });
  //   await evaluate(`localStorage.removeItem('atelier.orderDraft.v1')`);
  //   await send("Page.navigate", { url: `${BASE}/atelier/orders/new` }); await sleep(2500);
  //   let reached = false, ringOk = true, steps = 0;
  //   for (; steps < 80 && !reached; steps++) {
  //     await key("Tab", "Tab", 9); await sleep(40);
  //     const f = await evaluate(`(() => { const e = document.activeElement; const s = getComputedStyle(e);
  //       return { submit: e.type === 'submit' && !!e.closest('form') && !!e.offsetParent, ring: s.outlineStyle !== 'none' || s.boxShadow !== 'none',
  //         what: e.tagName + '#' + e.id + '.' + e.className + ' ' + (e.textContent || '').trim().slice(0, 20) }; })()`);
  //     if (!f.ring && !f.what.startsWith("BODY")) { ringOk = false; console.log("  no focus ring on:", f.what); }
  //     if (f.submit) reached = true;
  //   }
  //   console.log("  focused before Enter:", await evaluate(`document.activeElement.outerHTML.slice(0, 120)`));
  //   await key("Enter", "Enter", 13); await sleep(600);
  //   const v = await evaluate(`({ errors: document.querySelectorAll('.error-text').length, focused: document.activeElement.getAttribute('aria-invalid') === 'true' || document.activeElement.classList.contains('invalid') })`);
  //   console.log("tab navigation".padEnd(30), `save reached after ${steps} tabs: ${reached}, focus ring always visible: ${ringOk}, empty submit → ${v.errors} errors, focus on first error: ${v.focused}`);
  //   if (!reached || !ringOk || !v.errors || !v.focused) problems.push("keyboard navigation");
  // 
  await send("Emulation.clearDeviceMetricsOverride");
  await send("Page.navigate", { url: `${BASE}/atelier` }); await sleep(3000);
  console.log("service worker".padEnd(30), await evaluate(`navigator.serviceWorker.getRegistration('/atelier').then(r => r ? (r.active ? r.active.state : 'pending') : 'none')`));
  console.log("\nPROBLEMS:", problems.length ? "\n- " + problems.join("\n- ") : "none");
} catch (e) {
  console.error("ERROR", e);
} finally {
  ws?.close(); edge.kill();
}
