// Atelier daily app — Vue 3 (vendored, no build step) on top of the ERPNext API (atelier.api).
import { createApp, reactive, ref, computed, watch, onMounted, onBeforeUnmount, nextTick, h, TransitionGroup, provide, inject } from "./vendor/vue.esm-browser.prod.js";
// Strings follow the app's cache-busting version (?v=…) so text updates are never stale.
const { default: STR } = await import(`./i18n/ar.js${new URL(import.meta.url).search}`);

const BASE = "/atelier";

// ------------------------------------------------------------------ i18n & formatting
const t = (k, ...a) => String(STR[k] ?? k).replace(/\{(\d)\}/g, (_, i) => a[i] ?? "");
// Amounts: 28,000.00 دج — the number is wrapped in LRI…PDI so it keeps its order inside Arabic text.
const LRI = "⁦", PDI = "⁩";
const nf2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nfq = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });
const money = (v) => (v === null || v === undefined || Number.isNaN(+v) ? "—" : `${LRI}${nf2.format(+v)}${PDI} ${t("currency")}`);
const num = (v) => (v === null || v === undefined || v === "" ? "—" : `${LRI}${nfq.format(+v)}${PDI}`);
const df = new Intl.DateTimeFormat("ar-DZ-u-nu-latn", { day: "numeric", month: "long" });
const dfy = new Intl.DateTimeFormat("ar-DZ-u-nu-latn", { day: "numeric", month: "long", year: "numeric" });
const dfw = new Intl.DateTimeFormat("ar-DZ-u-nu-latn", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const parseDate = (s) => (s ? new Date(String(s).slice(0, 10) + "T00:00:00") : null);
const date = (s, withYear) => (s ? (withYear ? dfy : df).format(parseDate(s)) : "—");
const todayISO = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = parseDate(iso); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const daysFromToday = (iso) => Math.round((parseDate(iso) - parseDate(todayISO())) / 86400000);
const fileSize = (b) => (!b ? "" : b < 1048576 ? `${LRI}${Math.ceil(b / 1024)}${PDI} ك.ب` : `${LRI}${(b / 1048576).toFixed(1)}${PDI} م.ب`);
const plain = (html) => String(html || "").replace(/<[^>]+>/g, "").trim();

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
};

// ------------------------------------------------------------------ display size (per user, saved on the server)
const SCALES = [[0.85, "85%"], [0.9, "90%"], [1, "100%"], [1.1, "110%"]];
const zoomOf = () => +document.documentElement.style.zoom || 1;
function applyScale(z) { if (!SCALES.some((x) => x[0] === +z)) return; document.documentElement.style.zoom = z; document.documentElement.style.setProperty("--zoom", z); store.set("atelier.zoom", +z); }
applyScale(store.get("atelier.zoom") ?? 0.9);

// ------------------------------------------------------------------ API
function serverMessage(data) {
  try {
    const msgs = JSON.parse(data._server_messages || "[]").map((m) => JSON.parse(m).message);
    if (msgs.length) return msgs.join(" — ").replace(/<[^>]+>/g, "");
  } catch { /* ignore */ }
  return data.exception ? String(data.exception).split(":").slice(1).join(":").trim() || t("error_load") : t("error_load");
}

async function call(method, args = {}, post = false) {
  const headers = { Accept: "application/json" };
  let url = `/api/method/atelier.api.${method}`;
  const init = { credentials: "same-origin", headers };
  if (post) {
    init.method = "POST";
    headers["Content-Type"] = "application/json";
    headers["X-Frappe-CSRF-Token"] = window.csrf_token;
    init.body = JSON.stringify(args);
  } else if (Object.keys(args).length) {
    url += "?" + new URLSearchParams(args);
  }
  let res;
  try { res = await fetch(url, init); } catch { throw { message: t("error_net"), net: true }; }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 || (res.status === 403 && data.exc_type === "SessionExpired")) {
    location.href = `/atelier-login?redirect-to=${encodeURIComponent(location.pathname)}`;
  }
  if (res.status === 403) throw { message: t("error_perm"), status: 403 };
  if (!res.ok) throw { message: serverMessage(data), errors: data.errors, status: res.status };
  return data.message;
}

function useLoad(fn) {
  const s = reactive({ loading: true, error: null, data: null });
  const load = async () => {
    s.loading = true; s.error = null;
    try { s.data = await fn(); } catch (e) { s.error = e.message || t("error_load"); }
    s.loading = false;
  };
  return { s, load };
}

// ------------------------------------------------------------------ app state
const state = reactive({
  path: location.pathname, query: new URLSearchParams(location.search),
  boot: null, toast: null, sheet: null, online: navigator.onLine, keyboard: false, editing: false,
  collapsed: !!store.get("atelier.sidebarCollapsed"), rev: 0,
});
watch(() => state.collapsed, (v) => store.set("atelier.sidebarCollapsed", v));
function go(path) {
  history.pushState({}, "", BASE + (path === "/" ? "" : path));
  state.path = location.pathname; state.query = new URLSearchParams(location.search);
  window.scrollTo(0, 0);
  document.getElementById("main")?.focus({ preventScroll: true });
}
window.addEventListener("popstate", () => { state.path = location.pathname; state.query = new URLSearchParams(location.search); });
window.addEventListener("online", () => (state.online = true));
window.addEventListener("offline", () => (state.online = false));
if (window.visualViewport) {
  // Phone keyboard: hide the bottom navigation and keep the focused field in view above the save bar.
  const onVV = () => {
    const was = state.keyboard;
    state.keyboard = window.visualViewport.height < window.innerHeight * 0.75 || window.visualViewport.height < screen.height * 0.6;
    document.body.classList.toggle("keyboard-open", state.keyboard);
    // The keyboard opens after focus: bring the active field back into view once the screen has shrunk.
    if (state.keyboard && !was) setTimeout(revealActive, 50);
  };
  window.visualViewport.addEventListener("resize", onVV);
  window.addEventListener("resize", onVV);
}
function revealActive() {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || !el.matches("input, select, textarea") || window.innerWidth >= 1024) return;
  // Centre the field in the space left above the save bar.
  const bar = document.querySelector(".save-bar");
  const bottom = bar && getComputedStyle(bar).display !== "none" ? bar.getBoundingClientRect().top : window.innerHeight;
  const r = el.getBoundingClientRect();
  if (r.top < 64 || r.bottom > bottom - 8) window.scrollBy({ top: r.top - (bottom - r.height) / 2, behavior: "instant" });
}
document.addEventListener("focusin", (e) => { if (e.target instanceof HTMLElement) setTimeout(revealActive, 300); });
// Numeric fields are text + decimal keypad (browsers localise type=number to Arabic-Indic digits).
// Normalise before Vue reads the value: ٠-٩ / ۰-۹ → 0-9, decimal comma → ".", separators dropped.
document.addEventListener("input", (e) => {
  const el = e.target;
  if (!(el instanceof HTMLInputElement) || el.inputMode !== "decimal") return;
  const v = el.value.replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x660).replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 0x6f0)
    .replace(/[٫,]/g, ".").replace(/[\s  ٬]/g, "").replace(/[^\d.]/g, "");
  if (v !== el.value) el.value = v;
}, true);

let toastTimer;
function toast(message, kind = "success") {
  state.toast = { message, kind }; clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (state.toast = null), 4000);
}
const route = computed(() => {
  const p = state.path.replace(/^\/atelier/, "").replace(/\/$/, "") || "/";
  let m;
  if (p === "/") return { name: "home" };
  if (p === "/orders/new") return { name: "order-new" };
  if (p === "/orders") return { name: "orders" };
  if ((m = p.match(/^\/orders\/(.+)$/))) return { name: "order", id: decodeURIComponent(m[1]) };
  if (p === "/customers") return { name: "customers" };
  if (p === "/suppliers") return { name: "suppliers" };
  if ((m = p.match(/^\/suppliers\/(.+)$/))) return { name: "supplier", id: decodeURIComponent(m[1]) };
  if ((m = p.match(/^\/customers\/(.+)$/))) return { name: "customer", id: decodeURIComponent(m[1]) };
  if (["/money", "/reports", "/prices", "/team", "/board-settings", "/settings", "/stock", "/calc"].includes(p)) return { name: p.slice(1) };
  return { name: "home" };
});

// ------------------------------------------------------------------ icons (inline stroke SVG)
const ICONS = {
  calc: "M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM8 7h8M8 12h2M12 12h2M8 16h2M12 16h2",
  home: "M3 11 12 4l9 7M5 10v10h5v-6h4v6h5V10",
  orders: "M7 4h10l3 3v13H4V4h3Zm0 0v4h10V4M8 13h8M8 17h5",
  users: "M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6M21 19v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8",
  money: "M3 6h18v12H3zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M6 9v.01M18 15v.01",
  box: "M21 8 12 3 3 8v8l9 5 9-5V8ZM3 8l9 5 9-5M12 13v8",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19 12l2-1-1-3-2 .2-1.3-1.5.3-2-3-1-.9 1.8h-2.2L10 3.7l-3 1 .3 2L6 8.2 4 8l-1 3 2 1-.1 1 .1 1-2 1 1 3 2-.2 1.3 1.5-.3 2 3 1 .9-1.8h2.2l.9 1.8 3-1-.3-2 1.3-1.5 2 .2 1-3-2-1 .1-1Z",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  plus: "M12 5v14M5 12h14",
  in: "M12 19V5M6 11l6-6 6 6",
  out: "M12 5v14M6 13l6 6 6-6",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM21 21l-4.3-4.3",
  back: "M9 6l6 6-6 6",
  chev: "M15 6l-6 6 6 6",
  down: "M6 9l6 6 6-6",
  up: "M6 15l6-6 6 6",
  sort: "M8 9l4-4 4 4M16 15l-4 4-4-4",
  alert: "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2",
  check: "M5 12l5 5L20 7",
  tag: "M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8ZM7.5 7.5h.01",
  invoice: "M6 2h9l5 5v15H6zM14 2v6h6M9 13h6M9 17h6M9 9h2",
  truck: "M1 4h14v12H1zM15 9h4l4 4v3h-8M5.5 21a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5M18.5 21a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5",
  file: "M14 2H6v20h12V6l-4-4ZM14 2v4h4",
  image: "M3 3h18v18H3zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3M21 15l-5-5L5 21",
  x: "M18 6 6 18M6 6l12 12",
  phone: "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z",
  ext: "M14 3h7v7M10 14 21 3M19 14v7H3V5h7",
  trash: "M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15",
  wifi: "M2 8.8a15 15 0 0 1 20 0M5 12.6a10 10 0 0 1 14 0M8.5 16.4a5 5 0 0 1 7 0M12 20h.01",
  panel: "M3 4h18v16H3zM15 4v16",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  wallet: "M3 7h15a3 3 0 0 1 3 3v8H3zM3 7l2-3h11v3M16 13h2",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  printer: "M6 9V3h12v6M6 18H4v-7h16v7h-2M7 14h10v7H7z",
  bell: "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21h4",
  edit: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z",
  factory: "M3 21V10l6 3V10l6 3V6l6 3v12Z",
  filter: "M4 5h16l-6 8v5l-4 2v-7L4 5Z",
  msg: "M21 12a8 8 0 0 1-11.6 7.2L4 21l1.8-5.4A8 8 0 1 1 21 12Z",
  pin: "M12 17v5M5 17h14l-2-4V6h1V3H6v3h1v7Z",
  star: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z"
};
const Icon = (props) => h("svg", { width: props.size || 20, height: props.size || 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
  "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: props.class },
  [h("path", { d: ICONS[props.name] || "" })]);
Icon.props = ["name", "size", "class"];

const KIND = {
  late: { badge: "b-danger", icon: "alert", dot: "var(--danger)" },
  overdue: { badge: "b-danger", icon: "invoice", dot: "var(--danger)" },
  due: { badge: "b-warning", icon: "clock", dot: "var(--warning)" },
  price: { badge: "b-warning", icon: "tag", dot: "var(--warning)" },
  invoice: { badge: "b-info", icon: "invoice", dot: "var(--info)" },
  supplier: { badge: "b-neutral", icon: "truck", dot: "var(--ink-3)" },
  stock: { badge: "b-neutral", icon: "box", dot: "var(--ink-3)" },
};

// order status helpers — execution stage ≠ billing ≠ payment
function billing(o) {
  if (o.docstatus === 0) return { cls: "b-neutral", icon: "file", label: t("draft") };
  if (o.per_billed >= 100) return { cls: "b-success", icon: "check", label: t("bill_full") };
  if (o.per_billed > 0) return { cls: "b-warning", icon: "invoice", label: t("bill_part") };
  return { cls: "b-neutral", icon: "invoice", label: t("bill_none") };
}
function payment(o) {
  if (o.paid <= 0) return { cls: "b-neutral", icon: "money", label: t("pay_none") };
  if (!o.price_pending && o.grand_total > 0 && o.paid >= o.grand_total - 0.01) return { cls: "b-success", icon: "check", label: t("pay_full") };
  return { cls: "b-info", icon: "money", label: o.per_billed > 0 ? t("pay_part") : t("pay_advance") };
}
function due(o) {
  if (!o.delivery_date || o.per_delivered >= 100) return { text: date(o.delivery_date), cls: "meta", rank: 9e9 };
  const d = daysFromToday(o.delivery_date);
  if (d < 0) return { text: t("due_late", -d), cls: "badge b-danger", rank: d };
  if (d === 0) return { text: t("due_today"), cls: "badge b-warning", rank: d };
  if (d === 1) return { text: t("due_tomorrow"), cls: "badge b-warning", rank: d };
  return { text: date(o.delivery_date), cls: "meta", rank: d };
}

const Badge = { props: ["b"], components: { Icon }, template: `<span class="badge" :class="b.cls"><Icon :name="b.icon" :size="13"/>{{ b.label }}</span>` };

const LoadState = {
  props: ["s", "rows"], emits: ["retry"], components: { Icon },
  setup: () => ({ t }),
  template: `
    <div v-if="s.loading" class="stack" style="padding:16px" aria-busy="true" :aria-label="t('loading')">
      <div v-for="i in (rows||3)" :key="i" class="skeleton" :style="{width: (92 - i*11) + '%'}"></div>
    </div>
    <div v-else-if="s.error" class="alert error" role="alert" style="margin:12px">
      <Icon name="alert"/><div class="stack" style="gap:8px"><span>{{ s.error }}</span>
      <button class="btn sm" @click="$emit('retry')">{{ t('retry') }}</button></div>
    </div>
    <slot v-else></slot>`,
};

// ------------------------------------------------------------------ global search
const SearchBox = {
  components: { Icon }, setup() {
    const q = ref(""), res = ref([]), open = ref(false), busy = ref(false), active = ref(-1);
    let timer;
    watch(q, (v) => {
      clearTimeout(timer); active.value = -1;
      if (v.trim().length < 2) { res.value = []; return; }
      timer = setTimeout(async () => {
        busy.value = true;
        try { res.value = await call("search", { q: v }); } catch { res.value = []; }
        busy.value = false;
      }, 220);
    });
    const pick = (r) => { open.value = false; q.value = ""; go(r.route); };
    const onKeyNav = (e) => {
      if (e.key === "ArrowDown") { active.value = Math.min(active.value + 1, res.value.length - 1); e.preventDefault(); }
      else if (e.key === "ArrowUp") { active.value = Math.max(active.value - 1, 0); e.preventDefault(); }
      else if (e.key === "Enter" && res.value[active.value]) { pick(res.value[active.value]); e.preventDefault(); }
      else if (e.key === "Escape") { open.value = false; }
    };
    const onKey = (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); document.getElementById("global-search")?.focus(); } };
    onMounted(() => window.addEventListener("keydown", onKey));
    onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
    return { q, res, open, busy, pick, active, onKeyNav, t, later: (f) => setTimeout(f, 150) };
  },
  template: `
    <div class="search" @focusin="open=true" @focusout="later(()=>open=false)">
      <label for="global-search" class="sr-only">{{ t('search_label') }}</label>
      <Icon name="search" class="s-icon" :size="18"/>
      <input id="global-search" class="input" type="search" v-model="q" :placeholder="t('search_ph')" autocomplete="off" enterkeyhint="search"
        role="combobox" :aria-expanded="open && q.trim().length>=2" aria-controls="search-pop" @keydown="onKeyNav">
      <div v-if="open && q.trim().length>=2" id="search-pop" class="pop" role="listbox">
        <div v-if="busy && !res.length" class="empty">{{ t('loading') }}</div>
        <div v-else-if="!res.length" class="empty">{{ t('search_none', q) }}</div>
        <button v-for="(r,i) in res" :key="r.route" class="list-item" role="option" :aria-selected="i===active" :style="i===active ? 'background:var(--surface-2)' : ''" @mousedown.prevent="pick(r)">
          <Icon :name="r.type==='customer' ? 'users' : 'orders'" :size="18"/>
          <span class="main-col"><span class="ellipsis medium">{{ r.title }}</span><span class="cap ellipsis">{{ r.detail }}</span></span>
          <span class="badge b-neutral">{{ t('type_'+r.type) }}</span>
        </button>
      </div>
    </div>`,
};

// ------------------------------------------------------------------ customer picker (order form & payment sheet)
const CustomerPicker = {
  props: ["modelValue", "invalid", "inputId"], emits: ["update:modelValue"], components: { Icon },
  setup(props, { emit }) {
    const q = ref(""), list = ref([]), open = ref(false);
    let timer;
    const fetchList = async () => { try { list.value = await call("customers", q.value ? { q: q.value } : {}); } catch { list.value = []; } };
    watch(q, () => { clearTimeout(timer); timer = setTimeout(fetchList, 200); });
    const pick = (c) => { emit("update:modelValue", c); open.value = false; q.value = ""; };
    return { q, list, open, pick, fetchList, t, close: () => setTimeout(() => (open.value = false), 150) };
  },
  template: `
    <div v-if="modelValue" class="row" style="border:1px solid var(--line-strong);border-radius:var(--r);padding:0 4px 0 0;padding-inline:12px 4px;min-height:var(--control-h);background:var(--surface)">
      <Icon name="users" :size="18" class="muted"/><span style="flex:1;min-width:0" class="ellipsis medium">{{ modelValue.customer_name }}</span>
      <span v-if="modelValue.mobile_no" class="meta num">{{ modelValue.mobile_no }}</span>
      <button type="button" class="btn sm ghost" @click="$emit('update:modelValue', null)">{{ t('of_change') }}</button>
    </div>
    <div v-else class="search" style="max-width:none" @focusin="open=true; fetchList()" @focusout="close()">
      <Icon name="search" class="s-icon" :size="18"/>
      <input :id="inputId" class="input plain" :class="{invalid}" type="search" v-model="q" :placeholder="t('of_customer_ph')" autocomplete="off" :aria-invalid="invalid ? 'true' : null">
      <div v-if="open" class="pop">
        <div v-if="!list.length" class="empty">{{ t('c_none') }}</div>
        <button type="button" v-for="c in list" :key="c.name" class="list-item" @mousedown.prevent="pick(c)">
          <span class="main-col"><span class="ellipsis medium">{{ c.customer_name }}</span><span class="cap num">{{ c.mobile_no || '' }}</span></span>
        </button>
      </div>
    </div>`,
};

// ------------------------------------------------------------------ orders table (home, orders page, customer)
const FILTERS = [
  ["all", "f_all", () => true],
  ["late", "f_late", (o) => o.per_delivered < 100 && o.delivery_date && daysFromToday(o.delivery_date) < 0],
  ["soon", "f_soon", (o) => o.per_delivered < 100 && o.delivery_date && daysFromToday(o.delivery_date) >= 0 && daysFromToday(o.delivery_date) <= 3],
  ["pending", "f_pending", (o) => o.price_pending],
  ["unbilled", "f_unbilled", (o) => o.per_billed < 100],
  ["unpaid", "f_unpaid", (o) => o.price_pending || o.paid < o.grand_total - 0.01],
];

// ------------------------------------------------------------------ home
// Production stages as the workspace shows them: the seven order stages folded into four steps.
const STEP_OF = { "جديد": 0, "تصميم": 0, "بانتظار موافقة العميل": 0, "طباعة": 1, "تشطيب": 2, "جاهز للتسليم": 3, "سُلّم": 3 };
const STEPS = ["تصميم", "طباعة", "تشطيب", "تسليم"];
const STAGE_TONE = { "جديد": "design", "تصميم": "design", "بانتظار موافقة العميل": "design", "طباعة": "print", "تشطيب": "finish", "جاهز للتسليم": "ready", "سُلّم": "ready" };
const THUMB_TONES = ["#3E4C63", "#F2D45C", "#DCE9C8", "#F3DCC4", "#E3DDF3", "#2F4A6A", "#E6F0D8"];
const thumbTone = (s) => THUMB_TONES[[...String(s || "")].reduce((a, c) => a + c.charCodeAt(0), 0) % THUMB_TONES.length];
const darkTone = (hex) => ["#3E4C63", "#2F4A6A"].includes(hex);
const firstName = (n) => String(n || "").split(" ")[0];
const dueText = (o) => {
  if (!o.delivery_date) return { text: "—", late: false };
  const d = daysFromToday(o.delivery_date);
  if (o.per_delivered < 100 && d < 0) return { text: d === -1 ? "متأخر يومًا" : d === -2 ? "متأخر يومين" : `متأخر ${-d} أيام`, late: true };
  if (d === 0) return { text: "اليوم", late: false };
  if (d === 1) return { text: "غدًا", late: false };
  return { text: date(o.delivery_date), late: false };
};
// Who handles the current step: a person in-house, or the supplier for an external step.
const stepWho = (o) => (o.step ? (o.step.mode === "خارجي" ? (o.step.supplier_name || o.step.supplier || "مورد") : (o.step.owner || "—")) : "—");
const stepLabel = (o) => (o.step ? o.step.kind : o.atelier_stage);
// The three quick tags have fixed colours; any other tag is neutral.
const quickTags = () => (state.boot?.lists?.tags || []).map((q) => [q.name, q.tone || ""]);
const tagTone = (tg) => (quickTags().find((q) => q[0] === tg) || [])[1] || "";
// the list's order is its priority: the first tag sorts first
const tagRank = (o) => { const order = quickTags().map((q) => q[0]); const hits = (o.tags || []).map((x) => order.indexOf(x)).filter((i) => i >= 0); return hits.length ? Math.min(...hits) : order.length; };
// Where the order is, whatever its steps are called: at the workshop, at a supplier, or ready.
const phaseOf = (o) => (["جاهز للتسليم", "سُلّم"].includes(o.atelier_stage) ? "ready" : o.step && o.step.mode === "خارجي" ? "ext" : "work");
const PHASE_TABS = [["work", "قيد التنفيذ", (o) => phaseOf(o) === "work"], ["ext", "عند مورد", (o) => phaseOf(o) === "ext"], ["ready", "جاهز للتسليم", (o) => phaseOf(o) === "ready"]];
// amounts always show two decimals (1,377.00); whole counts use figN
const fig = (v) => `${LRI}${nf2.format(+v || 0)}${PDI}`;
const figN = (v) => `${LRI}${new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(+v || 0)}${PDI}`;


const billState = (o) => (o.docstatus === 0 ? { text: "مسودة", cls: "" } : o.per_billed >= 100 ? { text: "✓ مفوتر", cls: "ok" }
  : o.per_billed > 0 ? { text: "مفوتر جزئيًا", cls: "info" } : { text: "غير مفوتر", cls: "" });
const payState = (o) => {
  if (o.price_pending) return { text: o.paid > 0 ? `تسبيق ${fig(o.paid)}` : "لا دفع", cls: o.paid > 0 ? "info" : "" };
  if (o.paid >= o.grand_total - 0.005 && o.grand_total > 0) return { text: "✓ مدفوع", cls: "ok" };
  if (o.per_billed > 0) return { text: o.paid > 0 ? "مدفوع جزئيًا" : "لم يُدفع", cls: "bad" };
  return o.paid > 0 ? { text: `تسبيق ${fig(o.paid)}`, cls: "info" } : { text: "لا دفع", cls: "" };
};
const PERIODS = [["month", "هذا الشهر"], ["quarter", "آخر 3 أشهر"], ["all", "كل الفترات"]];


// ------------------------------------------------------------------ new order
const COST_TYPES = [
  ["Matière", "ct_material"], ["Machine", "ct_machine"], ["Main d'œuvre", "ct_labour"],
  ["Sous-traitance", "ct_external"], ["Finition", "ct_finish"], ["Autre", "ct_other"],
];
const UOM_AR = { Nos: "قطعة", Unit: "وحدة", Feuille: "ورقة", Hour: "ساعة", Meter: "متر", "Square Meter": "م²", Kg: "كغ", Box: "علبة" };
const uom = (u) => UOM_AR[u] || u || "";
const DRAFT_KEY = "atelier.orderDraft.v1";
let lineSeq = 0;
const blankItem = () => ({ key: ++lineSeq, item_code: "", description: "", qty: 1, rate: "", noPrice: false, open: false, touched: false, autoPending: false });
const blankForm = () => ({
  mode: "pick", customer: null, newCustomer: { name: "", phone: "", type: "Individual" }, subject: "", delivery_date: addDays(todayISO(), 3),
  items: [blankItem()], costs: [], waste: 0, advance: { amount: "", mode: "Cash" },
});


// ------------------------------------------------------------------ order view
const pdfUrl = (doctype, name, format) =>
  `/api/method/frappe.utils.print_format.download_pdf?doctype=${encodeURIComponent(doctype)}&name=${encodeURIComponent(name)}` +
  (format ? `&format=${encodeURIComponent(format + " — " + doctype)}&no_letterhead=1` : "");


// ------------------------------------------------------------------ customer
const DT_KEY = { "Quotation": "dt_quotation", "Sales Invoice": "dt_sales_invoice", "Delivery Note": "dt_delivery_note",
  "Payment Entry": "dt_payment_entry", "Sales Order": "dt_sales_order", "Journal Entry": "dt_journal_entry", "Customer": "dt_customer" };
const isImage = (f) => /\.(png|jpe?g|gif|webp|svg)$/i.test(f.file_name || f.file_url || "");


// ------------------------------------------------------------------ sections: shared table
// Columns: { k, label, type: "money" | "num" | "date" | "text", sort: bool, cls }. Custom cells via the #cell slot.
const DataTable = {
  props: { rows: Array, cols: Array, rowKey: String, searchKeys: Array, filters: Array, title: String, empty: String, initialSort: String, desc: Boolean },
  components: { Icon },
  setup(props) {
    const q = ref(""), filter = ref("all"), sortKey = ref(props.initialSort || null), sortDir = ref(props.desc ? -1 : 1);
    const allFilters = computed(() => (props.filters ? [["all", "f_all", () => true], ...props.filters] : []));
    const counts = computed(() => Object.fromEntries(allFilters.value.map(([k, , fn]) => [k, (props.rows || []).filter(fn).length])));
    const shown = computed(() => {
      const fn = allFilters.value.find((f) => f[0] === filter.value)?.[2] || (() => true);
      const needle = q.value.trim().toLowerCase();
      let r = (props.rows || []).filter(fn).filter((x) => !needle || (props.searchKeys || []).some((k) => String(x[k] ?? "").toLowerCase().includes(needle)));
      if (sortKey.value) {
        const k = sortKey.value;
        r = [...r].sort((a, b) => { const x = a[k] ?? "", y = b[k] ?? ""; return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "ar")) * sortDir.value; });
      }
      return r;
    });
    const sortBy = (k) => { if (sortKey.value === k) sortDir.value *= -1; else { sortKey.value = k; sortDir.value = 1; } };
    const ariaSort = (k) => (sortKey.value === k ? (sortDir.value > 0 ? "ascending" : "descending") : "none");
    const fmt = (c, v) => (c.type === "money" ? money(v) : c.type === "num" ? num(v) : c.type === "date" ? date(v, true) : v ?? "—");
    const uid = Math.random().toString(36).slice(2, 7);
    return { q, filter, allFilters, counts, shown, sortBy, ariaSort, fmt, uid, t };
  },
  template: `
  <section class="card">
    <div v-if="title" class="card-h"><h2>{{ title }}</h2><slot name="actions"></slot></div>
    <div v-if="searchKeys || allFilters.length" class="table-toolbar">
      <div v-if="searchKeys" class="search"><label class="sr-only" :for="'dq-'+uid">{{ t('search_label') }}</label>
        <Icon name="search" class="s-icon" :size="16"/><input :id="'dq-'+uid" class="input" type="search" v-model="q" :placeholder="t('search_in_table')" style="min-height:34px"></div>
      <div v-if="allFilters.length" class="chips" role="group">
        <button v-for="f in allFilters" :key="f[0]" type="button" v-show="f[0]==='all' || counts[f[0]]" class="chip" :aria-pressed="filter===f[0]" @click="filter=f[0]">
          {{ t(f[1]) }} <span class="count num">{{ counts[f[0]] }}</span></button>
      </div>
    </div>
    <div v-if="!shown.length" class="empty">{{ (rows||[]).length ? t('none_filter') : (empty || t('none')) }}</div>
    <template v-else>
      <div class="desktop-only table-wrap">
        <table class="t">
          <thead><tr>
            <th v-for="c in cols" :key="c.k" :class="[{n: c.type==='money'||c.type==='num', sortable: c.sort}]" :aria-sort="c.sort ? ariaSort(c.k) : null">
              <button v-if="c.sort" type="button" @click="sortBy(c.k)">{{ c.label }}<Icon name="sort" :size="12"/></button><template v-else>{{ c.label }}</template></th>
          </tr></thead>
          <tbody><tr v-for="r in shown" :key="r[rowKey]">
            <td v-for="c in cols" :key="c.k" :class="[{n: c.type==='money'||c.type==='num'}, c.cls]">
              <slot name="cell" :row="r" :col="c"><span :class="{money: c.type==='money'}">{{ fmt(c, r[c.k]) }}</span></slot></td>
          </tr></tbody>
        </table>
      </div>
      <div class="mobile-only list">
        <div v-for="r in shown" :key="r[rowKey]" class="list-item static">
          <span class="main-col">
            <span class="row" style="justify-content:space-between;gap:8px;align-items:flex-start">
              <span class="medium clamp2"><slot name="cell" :row="r" :col="cols[0]">{{ fmt(cols[0], r[cols[0].k]) }}</slot></span>
              <span v-if="cols.find(c=>c.main)" class="money medium" style="flex-shrink:0"><slot name="cell" :row="r" :col="cols.find(c=>c.main)">{{ fmt(cols.find(c=>c.main), r[cols.find(c=>c.main).k]) }}</slot></span></span>
            <span class="row wrap meta" style="gap:4px 12px">
              <span v-for="c in cols.slice(1).filter(c=>!c.main)" :key="c.k"><span class="muted">{{ c.label }}:</span> <slot name="cell" :row="r" :col="c">{{ fmt(c, r[c.k]) }}</slot></span></span>
          </span>
        </div>
      </div>
    </template>
  </section>`,
};


// Documents are shown, not linked to the underlying engine: no page of the app leads outside it.
const deskLink = () => undefined;


// ------------------------------------------------------------------ customer sheet (create / edit)

// ------------------------------------------------------------------ payment sheet
const PaymentSheet = {
  props: ["opts"], components: { Icon, CustomerPicker },
  setup(props) {
    const f = reactive({ customer: props.opts.customer || null, amount: "", mode: "Cash", order: props.opts.order || "", ref: "", refDate: todayISO() });
    const orders = ref([]), saving = ref(false), error = ref(null), attempted = ref(false), done = ref(null);
    const loadOrders = async () => {
      orders.value = [];
      if (!f.customer) return;
      try { orders.value = (await call("customer", { name: f.customer.name })).orders.filter((o) => o.docstatus === 1 && (o.per_billed < 100 || o.paid < o.grand_total - 0.005)); } catch { /* optional */ }
    };
    watch(() => f.customer, loadOrders, { immediate: true });
    const errs = computed(() => ({ customer: !f.customer ? t("err_pick_customer") : null, amount: !(+f.amount > 0) ? t("err_amount") : null,
      ref: f.mode === "Cheque" && !f.ref.trim() ? "اكتب رقم الصك" : null }));
    const close = () => (props.opts?.sub ? (state.subsheet = null) : (state.sheet = null));
    const onKey = (e) => { if (e.key === "Escape") close(); };
    onMounted(() => { window.addEventListener("keydown", onKey); setTimeout(() => document.querySelector(".sheet input")?.focus(), 50); });
    onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
    async function save() {
      attempted.value = true; error.value = null;
      if (errs.value.customer || errs.value.amount || errs.value.ref) return;
      saving.value = true;
      try {
        done.value = await call("record_payment", { customer: f.customer.name, amount: +f.amount, mode_of_payment: f.mode, sales_order: f.order || null,
          ...(f.mode === "Cheque" ? { reference_no: f.ref.trim(), reference_date: f.refDate } : {}) }, true);
        toast(t("p_done", done.value));
        state.rev++;  // pages showing this customer or order reload
      } catch (e) { error.value = e.message; }
      saving.value = false;
    }
    const owesNow = computed(() => orders.value.reduce((a, o) => a + Math.max(0, o.grand_total - (o.paid || 0)), 0));
    return { owesNow, f, orders, saving, error, attempted, errs, save, close, done, t, money, state };
  },
  template: `
  <div class="overlay" @click.self="close" role="dialog" aria-modal="true" aria-labelledby="pay-h">
    <form class="sheet" novalidate @submit.prevent="save">
      <div class="sh-head"><div><h2 id="pay-h">{{ t('p_title') }}</h2><span class="muted">يُصدر وصل دفع تلقائيًا</span></div><button type="button" class="cl-btn icon ghost" :aria-label="t('close')" @click="close"><Icon name="x" :size="18"/></button></div>
      <template v-if="done">
        <div class="alert success"><Icon name="check" :size="16"/><span>{{ t('p_done', done) }}</span></div>
        <div class="row wrap"><a class="btn primary" target="_blank" rel="noopener" :href="'/api/method/frappe.utils.print_format.download_pdf?doctype=Payment%20Entry&name='+encodeURIComponent(done)">{{ t('p_receipt') }}</a>
          <button type="button" class="btn" @click="close">{{ t('close') }}</button></div>
      </template>
      <template v-else>
        <div v-if="error" class="alert error" role="alert"><Icon name="alert" :size="16"/><span>{{ error }}</span></div>
        <div class="field"><label for="p-c" class="req">{{ t('p_customer') }}</label>
          <CustomerPicker v-model="f.customer" input-id="p-c" :invalid="attempted && !!errs.customer"/>
          <span v-if="attempted && errs.customer" class="error-text">{{ errs.customer }}</span>
          <div v-if="owesNow > 0.005" class="sh-note bad">عليه {{ money(owesNow) }} على {{ orders.length }} {{ orders.length === 1 ? 'طلب' : 'طلبات' }}</div></div>
        <div class="field"><label for="p-a" class="req">{{ t('p_amount') }} ({{ t('currency') }})</label>
          <input id="p-a" class="input num" :class="{invalid: attempted && errs.amount}" type="text" inputmode="decimal" autocomplete="off" v-model="f.amount" placeholder="0.00" enterkeyhint="done">
          <span v-if="attempted && errs.amount" class="error-text">{{ errs.amount }}</span></div>
        <div class="field"><span class="label">{{ t('p_mode') }}</span>
          <div class="seg" role="group" :aria-label="t('p_mode')"><button v-for="m in state.boot.modes" :key="m.value" type="button" :aria-pressed="f.mode===m.value" @click="f.mode=m.value">{{ m.label }}</button></div></div>
        <div v-if="f.mode === 'Cheque'" class="row" style="gap:10px">
          <div class="field" style="flex:1"><label for="p-ref" class="req">رقم الصك</label><input id="p-ref" class="input num" :class="{invalid: attempted && errs.ref}" v-model="f.ref" autocomplete="off">
            <span v-if="attempted && errs.ref" class="error-text">{{ errs.ref }}</span></div>
          <div class="field" style="flex:1"><label for="p-rd">تاريخ الصك</label><input id="p-rd" class="input" type="date" v-model="f.refDate"></div></div>
        <span v-if="f.mode === 'Cheque'" class="muted">يبقى الصك في «شيكات لم تُحصَّل» في صفحة المال حتى تعلّمه «حُصِّل».</span>
        <div class="field"><label for="p-o">{{ t('p_order') }}</label>
          <select id="p-o" class="input" v-model="f.order"><option value="">{{ t('p_order_none') }}</option>
            <option v-for="o in orders" :key="o.name" :value="o.name">{{ (o.atelier_subject || o.name) + ' — ' + money(o.grand_total - o.paid) }}</option></select></div>
<div class="sh-foot"><button type="submit" class="cl-btn primary" :disabled="saving">{{ saving ? t('of_saving') : t('p_save') }}</button><button type="button" class="cl-btn" @click="close">إلغاء</button></div>
      </template>
    </form>
  </div>`,
};

// ------------------------------------------------------------------ money

// ------------------------------------------------------------------ stock

// ------------------------------------------------------------------ machines

// ------------------------------------------------------------------ reports

// ------------------------------------------------------------------ services & prices
const PricesPage = {
  props: ["embedded"], components: { Icon, LoadState, DataTable },
  setup() {
    const { s, load } = useLoad(() => call("prices"));
    onMounted(load);
    const saving = reactive({}), failed = reactive({});
    const cols = [
      { k: "item_name", label: "العمل", sort: true },
      { k: "atelier_category", label: "التصنيف", sort: true },
      { k: "stock_uom", label: "الوحدة", sort: true },
      { k: "price_individual", label: t("pr_individual_prices"), type: "money", sort: true },
      { k: "price_company", label: t("pr_company_prices"), type: "money", sort: true, main: true },
    ];
    const filters = [
      ["noCompany", "pr_f_no_company", (i) => i.price_company === null || i.price_company === undefined],
      ["noIndividual", "pr_f_no_individual", (i) => i.price_individual === null || i.price_individual === undefined],
    ];
    // Saved on leaving the field; empty = no price for that type (orders show "priced later").
    async function save(row, key, kind, ev) {
      const raw = ev.target.value.trim(), old = row[key];
      const value = raw === "" ? null : +raw;
      if (value !== null && (Number.isNaN(value) || value < 0)) { failed[row.item_code + key] = t("pr_err_value"); return; }
      if (value === old || (value === null && (old === null || old === undefined))) return;
      saving[row.item_code + key] = true; delete failed[row.item_code + key];
      try {
        row[key] = await call("set_price", { item_code: row.item_code, kind, rate: value === null ? "" : value }, true);
        const b = state.boot.items.find((i) => i.item_code === row.item_code); if (b) b[key] = row[key];
        toast(t("pr_saved"));
      } catch (e) { failed[row.item_code + key] = e.message; ev.target.value = old ?? ""; }
      delete saving[row.item_code + key];
    }
    watch(() => state.rev, load);
    const setCategory = async (row, ev) => {
      const v = ev.target.value;
      try { row.atelier_category = await call("set_item_category", { item_code: row.item_code, category: v }, true) || null;
        const b = state.boot.items.find((i) => i.item_code === row.item_code); if (b) b.atelier_category = row.atelier_category; toast("حُفظ التصنيف"); }
      catch (e) { toast(e.message, "error"); ev.target.value = row.atelier_category || ""; }
    };
    return { s, load, cols, filters, save, saving, failed, t, money, uom, state, setCategory };
  },
  template: `
  <div class="page">
    <div v-if="!embedded" class="page-head"><div><h1>{{ t('nav_prices') }}</h1><div class="sub">{{ t('pr_sub') }}</div></div>
      <button v-if="s.data && s.data.can_edit" type="button" class="btn primary" @click="state.sheet={type:'item'}"><Icon name="plus" :size="18"/>{{ t('pr_new_service') }}</button></div>
    <LoadState :s="s" :rows="4" @retry="load">
      <p v-if="embedded" class="muted" style="margin:0 0 14px">{{ t('pr_explain') }}</p>
      <div v-else class="alert info" style="margin-bottom:var(--s4)"><Icon name="tag" :size="16"/><span>{{ t('pr_explain') }}</span></div>
      <DataTable :rows="s.data.items" :cols="cols" row-key="item_code" :search-keys="['item_name','item_code','atelier_category','stock_uom']" :filters="filters" initial-sort="item_name" :empty="t('pr_none')">
        <template #cell="{row, col}">
          <span v-if="col.k==='item_name'" class="title-cell"><span class="medium clamp2">{{ row.item_name }}</span></span>
          <select v-else-if="col.k==='atelier_category' && s.data.can_edit" class="input pr-cat" :value="row.atelier_category || ''" :aria-label="'تصنيف ' + row.item_name" @change="setCategory(row, $event)">
            <option value="">—</option><option v-for="c in state.boot.lists.categories || []" :key="c.name" :value="c.name">{{ c.name }}</option>
            <option v-if="row.atelier_category && !(state.boot.lists.categories || []).some(c => c.name === row.atelier_category)" :value="row.atelier_category">{{ row.atelier_category }}</option></select>
          <span v-else-if="col.k==='atelier_category'" class="muted">{{ row.atelier_category || '—' }}</span>
          <span v-else-if="col.k==='stock_uom'" class="muted">{{ uom(row.stock_uom) }}</span>
          <span v-else class="price-cell">
            <input v-if="s.data.can_edit" class="input num" type="text" inputmode="decimal" autocomplete="off" :value="row[col.k] ?? ''"
              :placeholder="t('price_pending')" :aria-label="col.label + ' — ' + row.item_name" :class="{invalid: failed[row.item_code+col.k]}"
              @change="save(row, col.k, col.k==='price_company' ? 'Company' : 'Individual', $event)" @keydown.enter="$event.target.blur()">
            <span v-else-if="row[col.k]!==null && row[col.k]!==undefined" class="money">{{ money(row[col.k]) }}</span>
            <span v-else class="badge b-warning"><Icon name="tag" :size="13"/>{{ t('price_pending') }}</span>
            <span v-if="saving[row.item_code+col.k]" class="cap">{{ t('of_saving') }}</span>
            <span v-else-if="failed[row.item_code+col.k]" class="error-text">{{ failed[row.item_code+col.k] }}</span>
          </span>
        </template>
      </DataTable>
    </LoadState>
  </div>`,
};

// ------------------------------------------------------------------ new service / product
const unitGroups = () => { const g = {}; (state.boot.units || []).forEach((u) => (g[u.group] ||= []).push(u.name)); return Object.entries(g); };
const ItemSheet = {
  props: ["opts"], components: { Icon },
  setup(props) {
    const f = reactive({ item_name: "", kind: "service", uom: state.boot.units?.[0]?.name || "قطعة", price_individual: "", price_company: "", description: "", category: "",
      ...(props.opts?.prefill || {}) });
    const saving = ref(false), error = ref(null), attempted = ref(false);
    const errs = computed(() => ({
      item_name: !f.item_name.trim() ? t("it_err_name") : null,
      price: [f.price_individual, f.price_company].some((v) => v !== "" && !(+v >= 0)) ? t("pr_err_value") : null,
    }));
    const close = () => (props.opts?.sub ? (state.subsheet = null) : (state.sheet = null));
    onMounted(() => setTimeout(() => document.getElementById("is-name")?.focus(), 50));
    async function save() {
      attempted.value = true; error.value = null;
      if (errs.value.item_name || errs.value.price) return;
      saving.value = true;
      try {
        const item = await call("create_item", { data: JSON.stringify(f) }, true);
        state.boot.items.push(item); state.boot.items.sort((a, b) => a.item_name.localeCompare(b.item_name, "ar"));
        toast(t("it_created", item.item_name)); const sub = props.opts?.sub; close(); if (!sub) state.rev++;
      } catch (e) { error.value = e.message; }
      saving.value = false;
    }
    return { f, saving, error, attempted, errs, save, close, unitGroups, t, state };
  },
  template: `
  <div class="overlay" @click.self="close" role="dialog" aria-modal="true" aria-labelledby="is-h">
    <form class="sheet wide" novalidate @submit.prevent="save">
      <div class="sh-head"><div><h2 id="is-h">{{ t('pr_new_service') }}</h2><span class="muted">تُقترح في الطلبات بوحدتها وسعرها حسب نوع العميل</span></div><button type="button" class="cl-btn icon ghost" :aria-label="t('close')" @click="close"><Icon name="x" :size="18"/></button></div>
      <div v-if="error" class="alert error" role="alert"><Icon name="alert" :size="16"/><span>{{ error }}</span></div>
      <div class="seg" role="group" :aria-label="t('it_kind')">
        <button type="button" :aria-pressed="f.kind==='service'" @click="f.kind='service'">{{ t('it_service') }}</button>
        <button type="button" :aria-pressed="f.kind==='product'" @click="f.kind='product'">{{ t('it_product') }}</button></div>
      <span class="hint">{{ f.kind==='service' ? t('it_service_hint') : t('it_product_hint') }}</span>
      <div class="field"><label for="is-name" class="req">{{ t('it_name') }}</label>
        <input id="is-name" class="input" :class="{invalid: attempted && errs.item_name}" type="text" v-model="f.item_name" :placeholder="t('it_name_ph')" autocomplete="off">
        <span v-if="attempted && errs.item_name" class="error-text">{{ errs.item_name }}</span></div>
      <div class="field"><span class="label">{{ t('it_unit') }}</span>
        <select class="input" v-model="f.uom" :aria-label="t('it_unit')"><optgroup v-for="g in unitGroups()" :key="g[0]" :label="g[0]"><option v-for="u in g[1]" :key="u" :value="u">{{ u }}</option></optgroup></select></div>
      <div class="field"><label for="is-cat">التصنيف <span class="cap">({{ t('optional') }})</span></label>
        <select id="is-cat" class="input" v-model="f.category"><option value="">بلا تصنيف</option><option v-for="c in state.boot.lists.categories || []" :key="c.name" :value="c.name">{{ c.name }}</option></select></div>
      <div class="grid-2">
        <div class="field"><label for="is-pi">{{ t('pr_individual_prices') }} ({{ t('currency') }})</label>
          <input id="is-pi" class="input num" type="text" inputmode="decimal" autocomplete="off" v-model="f.price_individual" :placeholder="t('it_price_ph')"></div>
        <div class="field"><label for="is-pc">{{ t('pr_company_prices') }} ({{ t('currency') }})</label>
          <input id="is-pc" class="input num" type="text" inputmode="decimal" autocomplete="off" v-model="f.price_company" :placeholder="t('it_price_ph')"></div>
      </div>
      <span v-if="attempted && errs.price" class="error-text">{{ errs.price }}</span>
      <div class="field"><label for="is-desc">{{ t('it_desc') }} <span class="cap">({{ t('optional') }})</span></label>
        <input id="is-desc" class="input" type="text" v-model="f.description" :placeholder="t('of_desc_ph')"></div>
<div class="sh-foot"><button type="submit" class="cl-btn primary" :disabled="saving">{{ saving ? t('of_saving') : t('it_save') }}</button><button type="button" class="cl-btn" @click="close">إلغاء</button></div>
    </form>
  </div>`,
};

// ------------------------------------------------------------------ simple workshop: board, customers, money
const COLS = [["new", "جديد"], ["work", "في العمل"], ["ready", "جاهز"], ["done", "سُلّم"]];
const colOf = (o) => (o.per_delivered >= 100 || o.atelier_stage === "سُلّم" ? "done" : o.atelier_stage === "جاهز للتسليم" ? "ready" : !o.atelier_stage || o.atelier_stage === "جديد" ? "new" : "work");
const weekday = new Intl.DateTimeFormat("ar", { weekday: "long" });
const dueWord = (iso) => {
  if (!iso) return "";
  const n = daysFromToday(iso);
  if (n < 0) return `متأخر ${-n} ${-n === 1 ? "يوم" : "أيام"}`;
  if (n === 0) return "اليوم";
  if (n === 1) return "غدًا";
  return n < 7 ? weekday.format(parseDate(iso)) : date(iso);
};
const isoIn = (days) => { const d = parseDate(todayISO()); d.setDate(d.getDate() + days); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const avatarStyle = (name) => ({ background: name ? thumbTone(name) : "#C9C3D8", color: name && !darkTone(thumbTone(name)) ? "#2B2B2B" : "#fff" });
const waLink = (phone) => { const d = String(phone || "").replace(/\D/g, ""); return d ? "https://wa.me/" + (d.startsWith("0") ? "213" + d.slice(1) : d) : null; };

const Avatar = {
  props: ["name", "size"],
  setup: () => ({ avatarStyle }),
  template: `<span class="bd-av" :style="[avatarStyle(name), size ? {width: size + 'px', height: size + 'px', fontSize: Math.max(12, size * 0.4) + 'px'} : {}]" :title="name || 'بلا مسؤول'" aria-hidden="true">{{ name ? [...name][0] : '؟' }}</span>`,
};

// Customer search-or-create field used by the quick order form.
const CustomerField = {
  props: ["modelValue"], emits: ["update:modelValue"],
  setup(props, { emit }) {
    const q = ref(props.modelValue?.customer_name || ""), list = ref([]), open = ref(false), searched = ref(false);
    let timer;
    watch(q, (v) => {
      if (props.modelValue && v !== props.modelValue.customer_name) emit("update:modelValue", null);
      clearTimeout(timer);
      searched.value = false;
      if (!v.trim()) { list.value = []; return; }
      timer = setTimeout(async () => { try { list.value = await call("customers", { q: v.trim() }); searched.value = true; open.value = true; } catch { list.value = []; } }, 200);
    });
    const pick = (c) => { emit("update:modelValue", { name: c.name, customer_name: c.customer_name, customer_type: c.customer_type }); q.value = c.customer_name; open.value = false; };
    const blur = () => setTimeout(() => (open.value = false), 150);
    return { q, list, open, searched, pick, blur };
  },
  template: `
  <div class="cf">
    <input id="qo-customer" class="input" v-model="q" autocomplete="off" placeholder="اكتب اسم العميل أو هاتفه…" @focus="open = true" @blur="blur" role="combobox" :aria-expanded="open && list.length > 0">
    <div v-if="open && list.length && !modelValue" class="cf-list" role="listbox">
      <button v-for="c in list" :key="c.name" type="button" role="option" @mousedown.prevent="pick(c)">{{ c.customer_name }} <span class="m" dir="ltr">{{ c.mobile_no || '' }}</span></button>
    </div>
    <div v-else-if="open && searched && !list.length && !modelValue && q.trim()" class="cf-list cf-none">لا يوجد عميل بهذا الاسم.</div>
  </div>`,
};

// order lines measured by their unit, shared by the new-order window and the card window
const unitOfName = (n) => (state.boot.units || []).find((u) => u.name === n) || { calc: "count" };
// changing m² ↔ cm² (or m ↔ cm) keeps the same piece and the same total: sizes and the unit price are converted
const unitChanged = (l, from) => {
  const a = unitOfName(from), b = unitOfName(l.unit);
  if (a.calc !== b.calc || a.calc === "count" || (a.scale || "m") === (b.scale || "m")) return;
  const k = (a.scale || "m") === "m" ? 100 : 0.01, r6 = (v) => +(+v).toFixed(6);
  if (a.calc === "area") { if (+l.width) l.width = r6(l.width * k); if (+l.height) l.height = r6(l.height * k); }
  if (a.calc === "length" && +l.length) l.length = r6(l.length * k);
  if (l.rate !== "" && l.rate !== null && l.rate !== undefined) { l.rate = r6(l.rate / (a.calc === "area" ? k * k : k)); l.auto = false; }
  const fine = l.rate === "" || l.rate === null || l.rate === undefined || Math.abs(l.rate * 100 - Math.round(l.rate * 100)) < 1e-6;
  toast(fine ? `حُوّل المقاس والسعر إلى ${l.unit}: المجموع لم يتغير` : `سعر ${l.unit} صار ${l.rate} دج، وقد يُقرَّب عند الحفظ فيتغير المجموع قليلًا. الأدق: التسعير بوحدة أكبر.`, fine ? "ok" : "error");
};
const lineMeasure = (l) => { const c = unitOfName(l.unit).calc, q = +l.qty || 0;
  return c === "area" ? (+l.width || 0) * (+l.height || 0) * q : c === "length" ? (+l.length || 0) * q : q; };
const lineSpec = (l) => { // a small proportional drawing of the piece
  const c = unitOfName(l.unit).calc;
  if (c === "area" && +l.width > 0 && +l.height > 0) { const k = Math.min(60 / l.width, 40 / l.height); return { kind: "area", w: Math.max(6, l.width * k), h: Math.max(6, l.height * k) }; }
  if (c === "length" && +l.length > 0) return { kind: "length" };
  return { kind: "count" };
};
const newLine = () => ({ text: "", item_code: null, unit: (state.boot.units || [])[0]?.name || "قطعة", width: "", height: "", length: "", qty: 1, rate: "", auto: false, category: "", focus: false });
// Side panel: a new order (one short form) or an existing order card.
const BoardPanel = {
  props: ["mode", "order", "preset", "columns", "statuses", "labels", "edit"], emits: ["close", "saved", "move"], components: { Icon, Avatar, CustomerField },
  setup(props, { emit }) {
    const f = reactive({ customer: props.preset || null, phone: "", type: "Individual", subject: "", lines: [newLine()], advance: "", due: isoIn(0), assignee: "", tags: [], column: null, mode: "Cash", description: "", checklist: [], cover_color: "", coverIdx: -1 });
    // opened from any page: the board settings come with it, or are fetched once
    const cfg = ref(null);
    onMounted(async () => { if (props.mode === "new" && !props.columns) { try { cfg.value = (await call("board2")).config; } catch { /* columns stay empty */ } } });
    const boardCols = computed(() => props.columns || cfg.value?.columns || []);
    const boardStatuses = computed(() => props.statuses || cfg.value?.statuses || []);
    const boardLabels = computed(() => props.labels || cfg.value?.labels || []);
    const startColumns = computed(() => boardCols.value.filter((c) => !c.deliver));
    // a new order never lands in a column by default: the person chooses (only one column → that one)
    watch(startColumns, (v) => { if (!f.column && v.length === 1) f.column = v[0].id; }, { immediate: true });
    const miss = reactive({ column: false, status: false });
    const colName = computed(() => startColumns.value.find((c) => c.id === f.column)?.name || "");
    f.status = []; f.labels = [];
    const flip = (list, id) => { const i = list.indexOf(id); if (i >= 0) list.splice(i, 1); else list.push(id); };
    const pickCust = ref(!props.preset);
    watch(() => f.customer, (c) => { if (c) pickCust.value = false; });
    const dueChips = computed(() => (state.boot?.lists?.due || []).map((c) => [c.label, c.days]));
    const saving = ref(false), error = ref(null), newName = ref(""), credit = ref(null);
    // a new order is a draft kept in this browser until it is saved: a misclick, a closed tab or a power cut lose nothing
    const DRAFT = "atelier.orderDraft", draftNote = ref(""), otherDraft = ref(null);
    const draftKeys = ["customer", "phone", "type", "subject", "lines", "advance", "due", "assignee", "tags", "column", "mode", "description", "checklist", "cover_color", "status", "labels"];
    const hasContent = () => !!(f.customer || newName.value || f.subject.trim() || f.description.trim() || f.checklist.length || f.lines.some((l) => l.text.trim()));
    const draftPick = (o) => Object.fromEntries(draftKeys.map((k) => [k, o[k]]));
    const applyDraft = (d) => { Object.assign(f, JSON.parse(JSON.stringify(d.f))); if (d.newName) newName.value = d.newName; if (d.f.customer) pickCust.value = false;
      nextTick(() => { const el = document.getElementById("qo-customer"); if (el && !f.customer && d.newName) el.value = d.newName; }); draftNote.value = "استُعيدت مسودة لم تُحفظ"; };
    const dropDraft = () => store.del(DRAFT);
    // the customer's type (it picks the price list) and phone come from the server, whatever page opened the form
    watch(() => f.customer, async (c) => { credit.value = null; if (c) { try { credit.value = await call("customer_credit", { name: c.name });
      if (f.customer === c && credit.value.customer_type && c.customer_type !== credit.value.customer_type) { f.customer = { ...c, customer_type: credit.value.customer_type, mobile_no: c.mobile_no || credit.value.mobile_no }; } } catch { /* optional */ } } }, { immediate: true });
    const toggle = (l, v) => { const i = l.indexOf(v); if (i >= 0) l.splice(i, 1); else l.push(v); };
    const onCustomerInput = () => { newName.value = document.getElementById("qo-customer")?.value?.trim() || ""; };
    // a line is a known service (its price follows the customer's type) or free text
    const customerType = computed(() => f.customer?.customer_type || f.type);
    const priceOf = (it) => { const v = customerType.value === "Company" ? it.price_company : it.price_individual; return v === null || v === undefined ? "" : v; };
    // free text; the price list only suggests (unit, price for this customer type, category)
    const lineInput = (l) => {
      l.focus = true;
      if (l.item_code && (state.boot.items || []).find((x) => x.item_code === l.item_code)?.item_name !== l.text.trim()) {
        l.item_code = null; if (l.auto) { l.rate = ""; l.auto = false; }
      }
    };
    const sugg = (l) => { const n = l.text.trim(); if (!n || l.item_code) return [];
      return (state.boot.items || []).filter((it) => it.item_code !== "SRV-GENERAL" && it.item_name.includes(n)).slice(0, 6); };
    const pick = (l, it) => {
      l.text = it.item_name; l.item_code = it.item_code; l.focus = false;
      if ((state.boot.units || []).some((u) => u.name === it.stock_uom)) l.unit = it.stock_uom;
      l.category = it.atelier_category || l.category;
      l.rate = priceOf(it); l.auto = l.rate !== "";
    };
    const blurLine = (l) => setTimeout(() => (l.focus = false), 150);
    const unitOf = (l) => (state.boot.units || []).find((u) => u.name === l.unit) || { calc: "count" };
    const calcOf = (l) => unitOf(l).calc;
    const sym = (l) => (unitOf(l).scale === "cm" ? "سم" : "م");
    const measure = (l) => { const c = calcOf(l), q = +l.qty || 0;
      return c === "area" ? (+l.width || 0) * (+l.height || 0) * q : c === "length" ? (+l.length || 0) * q : q; };
    const nf = (v) => new Intl.NumberFormat("ar-DZ", { maximumFractionDigits: 2 }).format(v);
    const lineTotal = (l) => (l.rate === "" || !(measure(l) > 0) ? null : measure(l) * (+l.rate || 0));
    const lineCalc = (l) => { const c = calcOf(l), m = measure(l); if (!(m > 0)) return "";
      const head = c === "area" ? `${nf(+l.width)}×${nf(+l.height)} ${sym(l)} × ${nf(+l.qty)} قطعة = ${nf(m)} ${l.unit}` : c === "length" ? `${nf(+l.length)} ${sym(l)} × ${nf(+l.qty)} قطعة = ${nf(m)} ${l.unit}` : `${nf(m)} ${l.unit}`;
      return l.rate === "" ? head + " · السعر لاحقًا" : `${head} × ${fig(+l.rate)} دج`; };
    const addToList = (l) => { const key = customerType.value === "Company" ? "price_company" : "price_individual";
      state.subsheet = { type: "item", sub: 1, prefill: { item_name: l.text.trim(), uom: l.unit, category: l.category, [key]: l.rate } }; };
    watch(customerType, () => f.lines.forEach((l) => { if (l.auto) { const it = state.boot.items.find((x) => x.item_code === l.item_code); if (it) { l.rate = priceOf(it); l.auto = l.rate !== ""; } } }));
    const addLine = () => f.lines.push(newLine());
    const dropLine = (i) => { f.lines.splice(i, 1); if (!f.lines.length) addLine(); };
    const filled = computed(() => f.lines.filter((l) => l.text.trim()));
    const total = computed(() => (filled.value.length && filled.value.every((l) => lineTotal(l) !== null) ? filled.value.reduce((sum, l) => sum + lineTotal(l), 0) : null));
    async function save(openAfter) {
      error.value = null; onCustomerInput();
      if (!f.customer && !newName.value) return (error.value = "اكتب اسم العميل");
      if (!filled.value.length) return (error.value = "اكتب ماذا يريد العميل");
      miss.column = startColumns.value.length > 1 && !f.column; miss.status = boardStatuses.value.length > 0 && !f.status.length;
      if (miss.column || miss.status) { nextTick(() => document.querySelector(".od-miss")?.scrollIntoView({ block: "center", behavior: "smooth" }));
        return (error.value = miss.column && miss.status ? "اختر العمود والحالة قبل الحفظ" : miss.column ? "اختر العمود الذي يبدأ فيه الطلب" : "اختر حالة واحدة على الأقل"); }
      if (filled.value.some((l) => !(+l.qty > 0))) return (error.value = "الكمية غير صحيحة");
      const noSize = filled.value.find((l) => (calcOf(l) === "area" && !(+l.width > 0 && +l.height > 0)) || (calcOf(l) === "length" && !(+l.length > 0)));
      if (noSize) return (error.value = `اكتب ${calcOf(noSize) === "area" ? "العرض والارتفاع" : "الطول"} للبند «${noSize.text.trim()}»`);
      if (filled.value.some((l) => l.rate !== "" && !(+l.rate >= 0))) return (error.value = "السعر غير صحيح");
      if (f.advance !== "" && !(+f.advance >= 0)) return (error.value = "التسبيق غير صحيح");
      if (total.value !== null && +f.advance > total.value) return (error.value = "التسبيق أكبر من المجموع");
      saving.value = true;
      try {
        const res = await call("quick_order", { data: JSON.stringify({
          customer: f.customer?.name || null, subject: f.subject.trim(), new_customer: f.customer ? {} : { name: newName.value, phone: f.phone, type: f.type },
          lines: filled.value.map((l) => ({ text: l.text.trim(), item_code: l.item_code, qty: +l.qty, rate: l.rate === "" ? null : +l.rate,
            unit: l.unit, width: +l.width || 0, height: +l.height || 0, length: +l.length || 0, pieces: +l.qty, category: l.category || null })),
          status: f.status, labels: f.labels, checklist: (f.checklist || []).map((c) => c.text), description: f.description || "", advance: +f.advance || 0, mode: f.mode, delivery_date: f.due, assignee: f.assignee, tags: f.tags, column: f.column,
        }) }, true);
        let coverUrl = "";
        if (res?.sales_order && queued.value.length) {
          for (const [k, q] of queued.value.entries()) { const up = await uploadPrivate(isImg({ file_name: q.name }) ? await shrinkImage(q) : q, "Sales Order", res.sales_order); await call("file_added", { name: res.sales_order, file_url: up.file_url, file_name: up.file_name }, true); if (k === f.coverIdx) coverUrl = up.file_url; }
        }
        if (res?.sales_order && (coverUrl || f.cover_color)) await call("update_card", { name: res.sales_order, changes: JSON.stringify(coverUrl ? { cover: coverUrl } : { cover_color: f.cover_color }) }, true);
        dropDraft(); toast("أُنشئ الطلب"); emit("saved", res?.sales_order);
        if (openAfter === true && res?.sales_order) go("/?card=" + encodeURIComponent(res.sales_order));
      } catch (e) { error.value = e.message; } finally { saving.value = false; }
    }
    // existing order
    const o = computed(() => props.order || {});
    const left = computed(() => Math.max(0, (o.value.grand_total || 0) - (o.value.paid || 0)));
    const price = ref(""), busy = ref(false);
    const act = async (fn, msg) => { busy.value = true; error.value = null; try { await fn(); if (msg) toast(msg); emit("saved", o.value.name); } catch (e) { error.value = e.message; } finally { busy.value = false; } };
    const setAssignee = (p) => act(() => call("update_order", { name: o.value.name, assignee: o.value.assignee === p ? "" : p }, true));
    const setPrice = () => (+price.value > 0 ? act(() => call("update_order", { name: o.value.name, price: +price.value }, true), "حُفظ السعر") : (error.value = "أدخل السعر"));
    const toggleTag = (tg) => { const l = [...(o.value.tags || [])]; toggle(l, tg); act(() => call("set_tags", { name: o.value.name, tags: JSON.stringify(l) }, true)); };
    const pay = () => (state.sheet = { type: "payment", customer: { name: o.value.customer, customer_name: o.value.customer_name }, order: o.value.name });
    const next = computed(() => COLS[COLS.findIndex((c) => c[0] === o.value.column) + 1]);
    const onKey = (e) => { if (e.key === "Escape" && !state.sheet) emit("close"); };
    onMounted(() => { window.addEventListener("keydown", onKey); setTimeout(() => document.querySelector(".bd-panel input, .bd-panel button")?.focus(), 50); });
    onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
    // totals for the summary and the footer
    const priced = computed(() => filled.value.filter((l) => lineTotal(l) !== null).reduce((a, l) => a + lineTotal(l), 0));
    const unpriced = computed(() => filled.value.filter((l) => lineTotal(l) === null).length);
    // editing an existing card in this same window: everything loads from the card, the advance becomes what was paid
    const ed = ref(null), members = ref([]);
    const editing = computed(() => !!props.edit);
    const locked = computed(() => (ed.value?.lines_locked || []).length > 0);
    const worker = computed(() => !!state.boot.worker || ed.value?.money === false);  // designer / production: no prices, no money
    const ro = computed(() => locked.value || worker.value);
    onMounted(async () => {
      if (!props.edit) return;
      try {
        const d = await call("card", { name: props.edit }); ed.value = d;
        f.customer = { name: d.customer, customer_name: d.customer_name, customer_type: d.client?.type || "Individual", mobile_no: d.client?.mobile || d.client?.phone || "" };
        f.subject = d.title === d.name ? "" : d.title || ""; f.due = d.due || ""; f.column = d.column; f.status = [...(d.status || [])]; f.labels = [...(d.labels || [])];
        members.value = [...(d.members || [])]; f.due_time = d.due_time || ""; f.description = plain(d.description || ""); f.checklist = (d.checklist || []).map((c) => ({ ...c }));
        f.lines = (d.lines.length ? d.lines : [{}]).map((l) => { const unit = l.unit || (state.boot.units || [])[0]?.name || "قطعة", count = unitOfName(unit).calc === "count";
          return { text: l.text || "", item_code: l.item_code && l.item_code !== "SRV-GENERAL" ? l.item_code : null, unit, width: l.width || "", height: l.height || "", length: l.length || "",
            qty: count ? (l.qty || 1) : (l.pieces || 1), rate: l.rate === null || l.rate === undefined ? "" : l.rate, category: l.category || "", auto: false, focus: false }; });
        await nextTick(); lastLines = linesPayload(); ready.value = true;
      } catch (e) { error.value = e.message; }
    });
    onMounted(() => {
      if (props.edit) return;
      const d = store.get(DRAFT);
      if (d && d.f && Date.now() - (d.at || 0) < 30 * 86400000) {
        if (!props.preset || d.f.customer?.name === props.preset.name) applyDraft(d); else otherDraft.value = d;
      }
    });
    watch(() => [JSON.stringify(draftPick(f)), newName.value], () => {
      if (props.edit) return;
      if (hasContent()) store.set(DRAFT, { f: draftPick(f), newName: newName.value, at: Date.now() });
    });
    const useOtherDraft = () => { applyDraft(otherDraft.value); otherDraft.value = null; };
    const cancelNew = () => { if (hasContent() && !confirm("تجاهل هذا الطلب؟ ستُحذف المسودة المحفوظة.")) return; dropDraft(); emit("close"); };
    const flipMember = (p) => { const i = members.value.indexOf(p); if (i >= 0) members.value.splice(i, 1); else members.value.push(p); };
    // an opened card saves itself: details right after a change, lines once every line is complete
    const sv = ref(""), svMsg = ref(""), ready = ref(false), timers = {};
    const later = (k, fn, ms) => { clearTimeout(timers[k]); timers[k] = setTimeout(fn, ms); };
    const linesPayload = () => JSON.stringify(filled.value.map((l) => ({ text: l.text.trim(), item_code: l.item_code, qty: +l.qty,
      rate: l.rate === "" ? null : +l.rate, unit: l.unit, width: +l.width || 0, height: +l.height || 0, length: +l.length || 0, pieces: +l.qty, category: l.category || null })));
    let lastLines = "";
    const run = async (fn) => { sv.value = "saving"; try { await fn(); sv.value = "saved"; svMsg.value = ""; state.rev++; } catch (e) { sv.value = "error"; svMsg.value = e.message; } };
    const saveMeta = () => run(() => call("update_card", { name: props.edit, changes: JSON.stringify({ title: f.subject.trim() || props.edit, status: f.status, labels: f.labels, members: members.value, description: f.description, checklist: f.checklist, due_time: f.due ? f.due_time || "" : "", due: f.due || null }) }, true));
    const saveLinesNow = () => {
      if (ro.value || !ready.value) return;
      const bad = !filled.value.length ? "أبقِ بندًا واحدًا على الأقل" : filled.value.some((l) => !(+l.qty > 0)) ? "الكمية غير صحيحة"
        : (() => { const x = filled.value.find((l) => (calcOf(l) === "area" && !(+l.width > 0 && +l.height > 0)) || (calcOf(l) === "length" && !(+l.length > 0))); return x ? `أكمل مقاس البند «${x.text.trim()}»` : ""; })()
        || (ed.value?.docstatus === 1 && filled.value.some((l) => l.rate === "") ? "الطلب مؤكَّد: يلزم سعر لكل بند" : "");
      if (bad) { sv.value = "pending"; svMsg.value = bad; return; }
      const p = linesPayload(); if (p === lastLines) return;
      return run(async () => { await call("update_lines", { name: props.edit, lines: p }, true); lastLines = p; });
    };
    watch(() => [f.subject, f.due, f.due_time, JSON.stringify(f.status), JSON.stringify(f.labels), JSON.stringify(members.value), f.description, JSON.stringify(f.checklist)], () => { if (ready.value) later("meta", saveMeta, 600); });
    // checklist, attachments, cover (same window for a new order and an opened card)
    // optional sections: null = automatic (open when they hold something), true/false = the person's choice
    const secOpen = reactive({ desc: null, ck: null, files: null, cost: null });
    const allActs = ref(false);
    const newItem = ref(""), queued = ref([]), fileIn = ref(null), uploading = ref(false), ckTpls = ref(null);
    const addItem = () => { const v = newItem.value.trim(); if (v) f.checklist.push({ text: v, done: 0 }); newItem.value = ""; };
    const openCkTpls = async () => { if (ckTpls.value) { ckTpls.value = null; return; } try { ckTpls.value = await call("checklist_templates"); } catch { ckTpls.value = []; } };
    const useCkTpl = (tp) => { tp.items.forEach((t) => { if (!f.checklist.some((c) => c.text === t)) f.checklist.push({ text: t, done: 0 }); }); ckTpls.value = null; };
    const saveCkTpl = async () => { const title = prompt("اسم قالب المهام:", (f.subject || "").slice(0, 40)); if (!title) return;
      try { await call("save_checklist_template", { title, items: JSON.stringify(f.checklist.map((c) => c.text)) }, true); toast("حُفظ القالب"); } catch (e) { toast(e.message, "error"); } };
    const files = computed(() => ed.value?.files || []);
    const fileCount = computed(() => (editing.value ? files.value.length : queued.value.length));
    const secHas = (k) => (k === "desc" ? !!f.description.trim() : k === "ck" ? f.checklist.length > 0 : k === "files" ? fileCount.value > 0 || !!(editing.value ? ed.value?.cover_color : f.cover_color) : false);
    const isOpen = (k) => (secOpen[k] === null ? secHas(k) : secOpen[k]);
    const toggleSec = (k) => { secOpen[k] = !isOpen(k); };
    const secLabel = (k) => k === "desc" ? (f.description.trim() ? "✓ الوصف" : "الوصف")
      : k === "ck" ? (f.checklist.length ? `المهام ${f.checklist.filter((c) => c.done).length}/${f.checklist.length}` : "قائمة مهام")
      : k === "files" ? (fileCount.value ? `المرفقات ${fileCount.value}` : "مرفق أو غلاف") : "التكلفة";
    const imagesOf = computed(() => files.value.filter(isImg));
    const onFiles = async (e) => {
      const list = [...(e.target.files || e.dataTransfer?.files || [])]; if (!list.length) return;
      if (!editing.value) { queued.value.push(...list); if (fileIn.value) fileIn.value.value = ""; return; }
      uploading.value = true;
      try { for (const x of list) { const up = await uploadPrivate(isImg({ file_name: x.name }) ? await shrinkImage(x) : x, "Sales Order", props.edit); ed.value = await call("file_added", { name: props.edit, file_url: up.file_url, file_name: up.file_name }, true); } state.rev++; }
      catch (x) { toast(x.message, "error"); } finally { uploading.value = false; if (fileIn.value) fileIn.value.value = ""; }
    };
    // Ctrl+V anywhere in the window: a copied image or screenshot becomes an attachment
    const onPaste = (e) => {
      const imgs = [...(e.clipboardData?.items || [])].filter((i) => i.kind === "file").map((i) => i.getAsFile()).filter(Boolean);
      if (!imgs.length) return;
      e.preventDefault();
      const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
      const named = imgs.map((x, k) => (x.name && x.name !== "image.png" ? x : new File([x], `لصق-${stamp}${k ? "-" + k : ""}.${(x.type.split("/")[1] || "png").replace("jpeg", "jpg")}`, { type: x.type })));
      secOpen.files = true; onFiles({ target: { files: named } }); toast(editing.value ? "جارٍ رفع الصورة الملصقة" : "أُضيفت الصورة، تُرفع عند حفظ الطلب");
    };
    onMounted(() => document.addEventListener("paste", onPaste)); onBeforeUnmount(() => document.removeEventListener("paste", onPaste));
    const delFile = async (x) => { if (!confirm(`حذف «${x.file_name}»؟`)) return; try { ed.value = await call("delete_file", { name: props.edit, file: x.name }, true); state.rev++; } catch (e) { toast(e.message, "error"); } };
    const cardSet = async (changes) => { try { ed.value = await call("update_card", { name: props.edit, changes: JSON.stringify(changes) }, true); state.rev++; } catch (e) { toast(e.message, "error"); } };
    // money, payments and the card's conversation
    watch(() => state.rev, async () => { if (props.edit && ready.value) { try { const d = await call("card", { name: props.edit }); ed.value = d; } catch { /* keep */ } } });
    const payNow = () => { state.subsheet = { type: "payment", sub: 1, customer: { name: ed.value.customer, customer_name: ed.value.customer_name }, order: props.edit }; };
    const comment = ref("");
    const addComment = async () => { if (!comment.value.trim()) return; try { ed.value = await call("add_comment", { name: props.edit, text: comment.value }, true); comment.value = ""; } catch (e) { toast(e.message, "error"); } };
    const materials = () => offerMaterials(props.edit);
    const copyPath = async () => { try { await navigator.clipboard.writeText(ed.value.folder); toast("نُسخ مسار المجلد"); } catch { /* selectable */ } };
    watch(() => linesPayload(), () => { if (ready.value) later("lines", saveLinesNow, 900); });
    watch(() => f.column, async (c, old) => { if (ready.value && c && old && c !== old) await run(() => call("move_card", { name: props.edit, column: c }, true)); });
    const flush = async () => { clearTimeout(timers.meta); clearTimeout(timers.lines); if (!ready.value) return; await saveMeta(); await saveLinesNow(); };
    const closeEdit = async () => { if (ready.value && sv.value !== "error") await flush(); emit("close"); };
    // header actions of an opened card
    const hdPop = ref(null);
    const quoteDoc = async (kind) => {
      hdPop.value = null; const win = window.open("about:blank", "_blank");
      try { await flush(); const n = await call("card_quote", { order: props.edit, kind }, true); if (win) win.location = pdfUrl("Quotation", n, "الورشة — عربي"); }
      catch (e) { if (win) win.close(); sv.value = "error"; svMsg.value = e.message; }
    };
    const copyIt = async () => { hdPop.value = null; try { await flush(); const n = await cardActions.copy(props.edit); state.rev++; state.sheet = { type: "order", edit: n }; } catch (e) { toast(e.message, "error"); } };
    const archiveIt = async () => { hdPop.value = null; if (!confirm("أرشفة هذه البطاقة؟ تجدها لاحقًا في «الأرشيف».")) return; try { await cardActions.archive(props.edit); state.rev++; emit("close"); } catch (e) { toast(e.message, "error"); } };
    const templateIt = async () => { hdPop.value = null; const t = prompt("اسم القالب", f.subject || ""); if (!t || !t.trim()) return; try { await flush(); await call("save_card_template", { name: props.edit, title: t.trim() }, true); toast(`حُفظ القالب «${t.trim()}»`); } catch (e) { toast(e.message, "error"); } };
    const deleteIt = async () => { hdPop.value = null; if (!confirm("حذف البطاقة نهائيًا؟ لا يمكن التراجع.")) return; try { await call("delete_card", { name: props.edit }, true); toast("حُذفت البطاقة"); state.rev++; emit("close"); } catch (e) { toast(e.message, "error"); } };
    const closeHd = () => (hdPop.value = null);
    onMounted(() => document.addEventListener("click", closeHd)); onBeforeUnmount(() => { document.removeEventListener("click", closeHd); Object.values(timers).forEach(clearTimeout); });
    async function saveEdit() {
      error.value = null; const d = ed.value; if (!d) return;
      if (!filled.value.length) return (error.value = "أبقِ بندًا واحدًا على الأقل");
      if (filled.value.some((l) => !(+l.qty > 0))) return (error.value = "الكمية غير صحيحة");
      const noSize = filled.value.find((l) => (calcOf(l) === "area" && !(+l.width > 0 && +l.height > 0)) || (calcOf(l) === "length" && !(+l.length > 0)));
      if (noSize) return (error.value = `اكتب ${calcOf(noSize) === "area" ? "العرض والارتفاع" : "الطول"} للبند «${noSize.text.trim()}»`);
      if (d.docstatus === 1 && filled.value.some((l) => l.rate === "")) return (error.value = "الطلب مؤكَّد: يلزم سعر لكل بند");
      saving.value = true;
      try {
        const changes = { title: f.subject.trim() || d.name, status: f.status, labels: f.labels, members: members.value };
        changes.due = f.due || null;
        await call("update_card", { name: d.name, changes: JSON.stringify(changes) }, true);
        if (!locked.value) await call("update_lines", { name: d.name, lines: JSON.stringify(filled.value.map((l) => ({ text: l.text.trim(), item_code: l.item_code, qty: +l.qty,
          rate: l.rate === "" ? null : +l.rate, unit: l.unit, width: +l.width || 0, height: +l.height || 0, length: +l.length || 0, pieces: +l.qty, category: l.category || null }))) }, true);
        if (f.column && f.column !== d.column) await call("move_card", { name: d.name, column: f.column }, true);
        toast("حُفظت التعديلات"); emit("saved", d.name);
      } catch (e) { error.value = e.message; } finally { saving.value = false; }
    }
    const paid = computed(() => +(ed.value?.paid || 0));
    const remain = computed(() => priced.value - (editing.value ? paid.value : (+f.advance || 0)));
    const popular = computed(() => (state.boot.items || []).filter((it) => it.item_code !== "SRV-GENERAL").slice(0, 3));
    const tpls = ref([]), tplOn = ref(null);
    onMounted(async () => { if (props.mode === "new") { try { tpls.value = await call("card_templates"); } catch { /* none */ } } });
    const useTpl = (tp) => {
      tplOn.value = tp.id; f.subject = tp.subject || tp.title; f.checklist = (tp.checklist || []).map((t) => ({ text: t, done: 0 }));
      const ls = (tp.lines || []).map((x) => { const l = newLine(); Object.assign(l, { text: x.text || "", item_code: x.item_code || null, unit: x.unit || l.unit, width: x.width || "", height: x.height || "", length: x.length || "", category: x.category || "" });
        const c = calcOf(l); l.qty = c === "count" ? (x.qty || 1) : (x.pieces || 1);
        const it = l.item_code && (state.boot.items || []).find((i) => i.item_code === l.item_code);
        if (it) { l.rate = priceOf(it); l.auto = l.rate !== ""; } else { l.rate = x.rate === null || x.rate === undefined ? "" : x.rate; }
        return l; });
      f.lines.splice(0, f.lines.length, ...(ls.length ? ls : [newLine()]));
    };
    const clearTpl = () => { tplOn.value = null; f.checklist = []; f.subject = ""; f.lines.splice(0, f.lines.length, newLine()); };
    const dropTpl = async (tp) => { if (!confirm(`حذف القالب «${tp.title}»؟`)) return; try { tpls.value = await call("delete_card_template", { id: tp.id }, true); if (tplOn.value === tp.id) tplOn.value = null; } catch (e) { error.value = e.message; } };
    const addFrom = (it) => { const last = f.lines[f.lines.length - 1]; const l = last && !last.text.trim() ? last : (f.lines.push(newLine()), f.lines[f.lines.length - 1]); pick(l, it); };
    const initialOf = (t) => (String(t || "?").trim()[0] || "?").toUpperCase();
    const folderHint = () => setTimeout(() => toast("إن لم يُفتح المجلد فأداة «فتح المجلد» غير مثبتة على هذا الحاسوب — استعمل «نسخ المسار»"), 1500);
    return { folderLink, folderHint, draftNote, otherDraft, useOtherDraft, cancelNew, dropDraft, miss, secOpen, isOpen, toggleSec, secHas, secLabel, allActs, worker, ro, daysFromToday, payNow, comment, addComment, materials, ago, newItem, addItem, ckTpls, openCkTpls, useCkTpl, saveCkTpl, queued, fileIn, uploading, files, imagesOf, onFiles, delFile, cardSet, copyPath, COVER_COLORS, isImg, sv, svMsg, closeEdit, hdPop, quoteDoc, copyIt, archiveIt, templateIt, deleteIt, pdfUrl, boardCols, editing, ed, locked, members, flipMember, saveEdit, paid, unitChanged, tpls, tplOn, useTpl, clearTpl, dropTpl, customerType, boardStatuses, boardLabels, colName, flip, pickCust, priced, unpriced, remain, popular, addFrom, initialOf, inkOn,
      sugg, pick, blurLine, calcOf, sym, lineTotal, lineCalc, addToList, priceOf, uom, lineInput, addLine, dropLine, total, filled, credit, fig, f, startColumns, dueChips, saving, error, newName, toggle, onCustomerInput, save, o, left, price, busy, setAssignee, setPrice, toggleTag, pay, next,
      QUICK_TAGS: computed(quickTags), tagTone, isoIn, money, date, dueWord, pdfUrl, go, state };
  },
  template: `
  <aside class="bd-panel" :aria-label="mode === 'new' ? 'طلب جديد' : 'الطلب'">
    <div v-if="mode === 'new'" class="overlay od-ov" @click.self="editing ? closeEdit() : $emit('close')">
    <form class="od" role="dialog" aria-modal="true" aria-labelledby="od-h" novalidate @submit.prevent="editing ? closeEdit() : save(false)" @keydown.ctrl.enter.prevent="editing ? closeEdit() : save(false)">
      <header class="od-hd"><span class="od-ic"><Icon name="file" :size="22"/></span>
        <div v-if="editing"><h2 id="od-h">{{ ed && ed.title ? ed.title : 'الطلب' }}</h2><span class="m">{{ ed ? ed.name : 'جارٍ التحميل…' }}</span></div>
        <template v-if="editing && ed">
          <span class="spacer"></span>
          <span class="od-sv" :class="sv" role="status">{{ sv === 'saving' ? 'جارٍ الحفظ…' : sv === 'saved' ? '✓ حُفظ' : sv === 'pending' ? 'غير محفوظ: ' + svMsg : sv === 'error' ? 'تعذّر الحفظ: ' + svMsg : '' }}</span>
          <span class="od-pop-host"><button type="button" class="cl-btn icon od-more" aria-label="خيارات البطاقة" :aria-expanded="hdPop === 'more'" @click.stop="hdPop = hdPop === 'more' ? null : 'more'"><Icon name="more" :size="16"/></button>
            <div v-if="hdPop === 'more'" class="tm-pop od-pop" @click.stop>
              <button v-if="!worker" type="button" class="tm-pop-row" @click="copyIt"><Icon name="file" :size="15"/>نسخ البطاقة</button>
              <button v-if="!worker" type="button" class="tm-pop-row" @click="templateIt"><Icon name="grid" :size="15"/>حفظ كقالب</button>
              <button v-if="!worker" type="button" class="tm-pop-row" @click="archiveIt"><Icon name="box" :size="15"/>أرشفة</button>
              <button v-if="ed.can_delete" type="button" class="tm-pop-row tm3-danger" @click="deleteIt"><Icon name="trash" :size="15"/>حذف البطاقة</button>
              <span v-else-if="!worker" class="m tm3-hint">عليها دفعة أو تسليم: أرشفها بدل الحذف.</span></div></span>
        </template>
        <div v-else><h2 id="od-h">طلب جديد</h2><span class="m">{{ colName ? 'يُضاف إلى لوحة الطلبات في عمود «' + colName + '»' : 'يُضاف إلى لوحة الطلبات' }}</span></div>
        <button type="button" class="od-x" aria-label="إغلاق" @click="editing ? closeEdit() : $emit('close')"><Icon name="x" :size="18"/></button></header>
      <div class="od-bd">
        <div class="od-main">
          <div v-if="!editing && draftNote" class="od-draft" role="status"><Icon name="check" :size="15"/>{{ draftNote }}. تُحفظ كتابتك تلقائيًا حتى تحفظ الطلب.<span class="spacer"></span><button type="button" class="cl-link" @click="cancelNew">بدء طلب فارغ</button></div>
          <div v-if="!editing && otherDraft" class="od-draft" role="status">لديك مسودة لم تُحفظ<template v-if="otherDraft.f.customer"> للعميل «{{ otherDraft.f.customer.customer_name }}»</template>.<span class="spacer"></span><button type="button" class="cl-link" @click="useOtherDraft">استعادتها</button><button type="button" class="cl-link" @click="dropDraft(); otherDraft = null">حذفها</button></div>
          <section class="od-card od-pad">
            <div v-if="f.customer && !pickCust" class="od-cust">
              <span class="od-av">{{ initialOf(f.customer.customer_name) }}</span>
              <div style="flex:1;min-width:0">
                <div class="od-cn"><b>{{ f.customer.customer_name }}</b><span class="od-tag">{{ customerType === 'Company' ? 'مؤسسة' : 'فرد' }}</span><span v-if="!worker" class="od-tag pri">{{ customerType === 'Company' ? 'أسعار المؤسسات' : 'أسعار الأفراد' }}</span>
                  <span v-if="credit && credit.owes > 0.005" class="od-tag bad">عليه {{ fig(credit.owes) }} دج</span></div>
                <span v-if="f.customer.mobile_no" class="m" dir="ltr">{{ f.customer.mobile_no }}</span></div>
              <button v-if="!editing" type="button" class="cl-link" @click="pickCust = true">تغيير العميل</button></div>
            <div v-else class="f"><label for="qo-customer">العميل</label><CustomerField v-model="f.customer" @input="onCustomerInput"/>
              <div v-if="!f.customer && newName" class="bd-newc"><span class="m">سيُنشأ عميل جديد عند الحفظ</span><div class="bd-newc-row">
                <input class="input" v-model="f.phone" inputmode="tel" dir="ltr" placeholder="الهاتف (اختياري)" aria-label="هاتف العميل الجديد">
                <div class="seg" role="group" aria-label="نوع العميل"><button type="button" :aria-pressed="f.type==='Individual'" @click="f.type='Individual'">فرد</button><button type="button" :aria-pressed="f.type==='Company'" @click="f.type='Company'">مؤسسة</button></div></div></div></div>
            <div v-if="credit && credit.note" class="sh-note warn">ملاحظة العميل: {{ credit.note }}</div>
            <div v-if="credit && credit.over" class="sc2-alert" role="alert">هذا العميل تجاوز سقف الدين: عليه {{ fig(credit.owes) }} من {{ fig(credit.limit) }} دج</div>
            <div class="f"><label for="qo-subject">اسم المشروع <span class="m" style="display:inline;font-weight:400">— اختياري، يظهر على البطاقة والمجلد والـ Devis</span></label>
              <input id="qo-subject" class="input" v-model="f.subject" maxlength="120" placeholder="مثال: هوية مطعم الواحة"></div>
          </section>

          <section class="od-card">
            <div class="od-ch"><Icon name="orders" :size="18"/><b>البنود</b><span class="m od-r">اكتب الوصف بحرية — تظهر اقتراحات من قائمة الأسعار</span></div>
            <div v-if="locked" class="alert warn od-lock">البنود مقفلة: صدر لهذا الطلب {{ ed.lines_locked.join('، ') }}. يمكنك تعديل الباقي.</div>
            <div v-if="tpls.length && !editing" class="od-tpls" role="group" aria-label="ابدأ من قالب"><span class="m">من قالب:</span>
              <span v-for="tp in tpls" :key="tp.id" class="od-tpl" :class="{on: tplOn === tp.id}"><button type="button" :aria-pressed="tplOn === tp.id" @click="useTpl(tp)">{{ tp.title }}<span class="m">{{ (tp.lines || []).length }} بند<template v-if="(tp.checklist || []).length"> · {{ tp.checklist.length }} مهام</template></span></button>
                <button type="button" class="od-tpl-x" :aria-label="'حذف القالب ' + tp.title" @click="dropTpl(tp)">×</button></span>
              <button v-if="tplOn" type="button" class="cl-link" @click="clearTpl">طلب فارغ</button></div>
            <fieldset class="lb-list od-fs" :disabled="ro">
              <div v-for="(l, i) in f.lines" :key="i" class="lb">
                <div class="lb-top"><span class="lb-no">{{ i + 1 }}</span>
                  <div class="ol2-desc"><textarea class="input lb-desc" rows="1" v-model="l.text" @input="lineInput(l)" @focus="l.focus = true" @blur="blurLine(l)" @keydown.enter.prevent :aria-label="'وصف البند ' + (i + 1)" placeholder="الوصف: بطاقات زيارة 350 غ وجهان…" autocomplete="off"></textarea>
                    <div v-if="l.focus && sugg(l).length" class="ol2-sug"><span class="m">من قائمة الأسعار</span>
                      <button v-for="it in sugg(l)" :key="it.item_code" type="button" class="tm-pop-row" @mousedown.prevent="pick(l, it)"><span style="flex:1;min-width:0"><b>{{ it.item_name }}</b>
                        <span class="m" style="display:block">{{ [it.atelier_category, uom(it.stock_uom), priceOf(it) !== '' ? fig(priceOf(it)) + ' دج' : 'بلا سعر'].filter(Boolean).join(' · ') }}</span></span></button></div></div>
                  <button v-if="f.lines.length > 1" type="button" class="lb-del" :aria-label="'حذف البند ' + (i + 1)" @click="dropLine(i)"><Icon name="x" :size="14"/></button></div>
                <div class="lb-f">
                  <label class="lb-c"><span>الوحدة</span><select class="input lb-in" v-model="l.unit" @focus="l._u = l.unit" @change="unitChanged(l, l._u); l._u = l.unit"><option v-for="u in state.boot.units" :key="u.name" :value="u.name">{{ u.name }}</option></select></label>
                  <div class="lb-c"><span>{{ calcOf(l) === 'count' ? 'المقاس' : 'المقاس (' + sym(l) + ')' }}</span>
                    <div v-if="calcOf(l) === 'area'" class="lb-size"><input class="input lb-in num" :class="{miss: !(+l.width > 0)}" inputmode="decimal" v-model="l.width" placeholder="العرض" :aria-label="'العرض ' + (i + 1)"><span>×</span><input class="input lb-in num" :class="{miss: !(+l.height > 0)}" inputmode="decimal" v-model="l.height" placeholder="الارتفاع" :aria-label="'الارتفاع ' + (i + 1)"></div>
                    <div v-else-if="calcOf(l) === 'length'" class="lb-size"><input class="input lb-in num" :class="{miss: !(+l.length > 0)}" inputmode="decimal" v-model="l.length" placeholder="الطول" :aria-label="'الطول ' + (i + 1)"></div>
                    <span v-else class="lb-none">—</span></div>
                  <label class="lb-c"><span>{{ calcOf(l) === 'count' ? 'الكمية' : 'عدد القطع' }}</span><input class="input lb-in num" inputmode="decimal" v-model="l.qty"></label>
                  <label v-if="!worker" class="lb-c"><span>سعر الوحدة</span><input class="input lb-in num" inputmode="decimal" v-model="l.rate" @input="l.auto = false" placeholder="لاحقًا"></label>
                  <div v-if="!worker" class="lb-c lb-t"><span>المجموع</span><b v-if="lineTotal(l) !== null">{{ fig(lineTotal(l)) }}</b><em v-else-if="l.text.trim()" class="od-pending">{{ l.rate !== '' && calcOf(l) !== 'count' ? (calcOf(l) === 'area' ? 'أدخل المقاس' : 'أدخل الطول') : 'بلا سعر' }}</em></div>
                </div>
                <div v-if="!worker && (lineCalc(l) || (l.text.trim() && !l.item_code && state.boot.can.prices))" class="lb-calc"><span>{{ lineCalc(l) }}</span>
                  <button v-if="l.text.trim() && !l.item_code && state.boot.can.prices" type="button" class="cl-link od-tolist" @click="addToList(l)">+ إلى قائمة الأسعار</button></div>
              </div></fieldset>
            <div v-if="!ro" class="od-add"><button type="button" class="od-addb" @click="addLine"><Icon name="plus" :size="16"/>بند جديد</button><span class="spacer"></span>
              <template v-if="popular.length"><span class="m">الأكثر طلبًا:</span><button v-for="it in popular" :key="it.item_code" type="button" class="od-sug" @click="addFrom(it)">{{ it.item_name }}</button></template></div>
            <div v-if="!worker" class="od-totals"><div class="od-tbox">
              <div><span>مجموع البنود المسعّرة</span><span class="num">{{ money(priced) }}</span></div>
              <div v-if="unpriced"><span>بنود بلا سعر</span><span>{{ unpriced }}</span></div>
              <div v-if="editing && paid > 0.005"><span>المدفوع</span><span class="num od-ok">− {{ money(paid) }}</span></div>
              <div v-else-if="!editing && +f.advance > 0"><span>التسبيق</span><span class="num od-ok">− {{ money(+f.advance) }}</span></div>
              <div class="od-g-row"><span>الباقي على العميل</span><span class="num">{{ money(Math.max(0, remain)) }}</span></div></div></div>
          </section>

          <div class="od-secbar" role="group" aria-label="أقسام إضافية">
            <button v-for="k in (editing && ed && state.boot.can.finance ? ['desc', 'ck', 'files', 'cost'] : ['desc', 'ck', 'files'])" :key="k" type="button" class="od-sec" :class="{on: isOpen(k), has: secHas(k)}" :aria-pressed="isOpen(k)" @click="toggleSec(k)">
              <Icon :name="isOpen(k) ? 'down' : 'plus'" :size="13"/>{{ secLabel(k) }}</button></div>
          <section v-if="isOpen('desc')" class="od-card"><div class="od-ch"><Icon name="file" :size="18"/><b>الوصف</b><button type="button" class="od-fold" aria-label="طي الوصف" title="طي (يبقى المحتوى)" @click="secOpen.desc = false"><Icon name="x" :size="14"/></button><span class="m od-r">يظهر في البون والعرض إن فُعّل في الإعدادات</span></div>
            <div class="od-pad"><textarea class="input od-desc" v-model="f.description" rows="3" placeholder="المقاسات، الورق، الكمية، ملاحظات العميل…" aria-label="الوصف"></textarea></div></section>

          <section v-if="isOpen('ck')" class="od-card"><div class="od-ch"><Icon name="check" :size="18"/><b>قائمة المهام</b><button type="button" class="od-fold" aria-label="طي قائمة المهام" title="طي (يبقى المحتوى)" @click="secOpen.ck = false"><Icon name="x" :size="14"/></button><span v-if="f.checklist.length" class="m">{{ f.checklist.filter((c) => c.done).length }} / {{ f.checklist.length }}</span>
              <span class="od-r od-pop-host"><button type="button" class="cl-link" @click.stop="openCkTpls">من قالب ▾</button>
                <div v-if="ckTpls" class="tm-pop od-pop" @click.stop><button v-for="tp in ckTpls" :key="tp.title" type="button" class="tm-pop-row" @click="useCkTpl(tp)">{{ tp.title }} <span class="m">· {{ tp.items.length }}</span></button>
                  <span v-if="!ckTpls.length" class="m tm3-hint">لا قوالب بعد.</span>
                  <button v-if="f.checklist.length" type="button" class="tm-pop-row" @click="ckTpls = null; saveCkTpl()">+ احفظ هذه القائمة كقالب</button></div></span></div>
            <div class="od-pad od-ck">
              <div v-for="(c, i) in f.checklist" :key="i" class="od-ck-row"><button type="button" class="od-box" :class="{on: c.done}" :aria-pressed="!!c.done" :aria-label="'إنجاز ' + c.text" @click="c.done = c.done ? 0 : 1">{{ c.done ? '✓' : '' }}</button>
                <input class="input lb-in" :class="{done: c.done}" v-model="c.text" :aria-label="'مهمة ' + (i + 1)"><button type="button" class="lb-del" :aria-label="'حذف ' + c.text" @click="f.checklist.splice(i, 1)"><Icon name="x" :size="14"/></button></div>
              <input class="input lb-in" v-model="newItem" placeholder="+ مهمة جديدة ثم Enter" aria-label="مهمة جديدة" @keydown.enter.prevent="addItem"></div></section>

          <section v-if="isOpen('files')" class="od-card"><div class="od-ch"><Icon name="image" :size="18"/><b>المرفقات</b><button type="button" class="od-fold" aria-label="طي المرفقات" title="طي (يبقى المحتوى)" @click="secOpen.files = false"><Icon name="x" :size="14"/></button><span v-if="uploading" class="m">جارٍ الرفع…</span>
              <span class="od-r btn-row"><label class="cl-btn sm"><Icon name="image" :size="14"/>تصوير<input type="file" accept="image/*" capture="environment" class="sr-only" @change="onFiles"></label>
                <label class="cl-btn sm"><Icon name="plus" :size="14"/>إضافة<input ref="fileIn" type="file" multiple class="sr-only" @change="onFiles"></label></span></div>
            <div class="od-pad">
              <div v-if="!editing && queued.length" class="od-files"><span v-for="(q, i) in queued" :key="i" class="od-file" :class="{cover: f.coverIdx === i}"><span class="ellipsis">{{ q.name }}</span>
                  <span class="od-file-acts"><button v-if="isImg({file_name: q.name})" type="button" class="cl-link" @click="f.coverIdx = f.coverIdx === i ? -1 : i; f.cover_color = ''">{{ f.coverIdx === i ? '✓ الغلاف' : 'غلاف' }}</button>
                    <button type="button" class="cl-link bad" @click="queued.splice(i, 1); if (f.coverIdx === i) f.coverIdx = -1; else if (f.coverIdx > i) f.coverIdx--">إزالة</button></span></span>
                <span class="m">تُرفع عند حفظ الطلب.</span></div>
              <div v-if="!editing" class="od-cover"><span class="m">لون الغلاف:</span><button v-for="c in COVER_COLORS" :key="c" type="button" class="bs-sw" :style="{background: c}" :aria-pressed="f.coverIdx < 0 && f.cover_color === c" :aria-label="'لون ' + c" @click="f.cover_color = f.cover_color === c ? '' : c; f.coverIdx = -1"></button>
                <button v-if="f.cover_color || f.coverIdx >= 0" type="button" class="cl-link" @click="f.cover_color = ''; f.coverIdx = -1">بلا غلاف</button></div>
              <div v-if="editing && files.length" class="od-files">
                <div v-for="x in files" :key="x.name" class="od-file" :class="{img: isImg(x), cover: ed.cover === x.file_url, final: ed.final === x.file_url}">
                  <a :href="x.file_url" target="_blank" rel="noopener" class="od-thumb"><img v-if="isImg(x)" :src="x.file_url" alt=""><Icon v-else name="file" :size="22"/></a>
                  <span class="ellipsis" :title="x.file_name">{{ x.file_name }}</span>
                  <span class="od-file-acts"><button v-if="isImg(x)" type="button" class="cl-link" @click="cardSet(ed.cover === x.file_url ? {cover: ''} : {cover: x.file_url})">{{ ed.cover === x.file_url ? 'إزالة الغلاف' : 'غلاف' }}</button>
                    <button type="button" class="cl-link" @click="cardSet({final: ed.final === x.file_url ? '' : x.file_url})">{{ ed.final === x.file_url ? '✓ نهائي' : 'نهائي' }}</button>
                    <button type="button" class="cl-link bad" @click="delFile(x)">حذف</button></span></div></div>
              <span v-if="(editing ? !files.length : !queued.length)" class="m">لا مرفقات. أضف الشعار أو ملف التصميم أو صورة من الهاتف.</span>
              <div v-if="editing && ed" class="od-meta"><div class="od-cover"><span class="od-k">الغلاف</span><button v-for="c in COVER_COLORS" :key="c" type="button" class="bs-sw" :style="{background: c}" :aria-pressed="!ed.cover && ed.cover_color === c" :aria-label="'لون ' + c" @click="cardSet({cover: '', cover_color: c})"></button>
                <button type="button" class="bs-sw none" :aria-pressed="!ed.cover && !ed.cover_color" title="بلا غلاف" aria-label="بلا غلاف" @click="cardSet({cover: '', cover_color: ''})"></button></div>
              <div v-if="ed.folder" class="od-folder"><span class="od-k">المجلد</span><div class="od-path"><code dir="ltr" :title="ed.folder">{{ ed.folder }}</code><button type="button" class="od-pbtn" title="نسخ المسار" @click="copyPath">نسخ</button><a class="od-pbtn pri" :href="folderLink(ed.folder)" title="يفتح المجلد في مستكشف Windows" @click="folderHint">فتح المجلد</a></div></div></div></div></section>

          <section v-if="editing && ed && state.boot.can.finance && isOpen('cost')" class="od-card"><div class="od-ch"><Icon name="calc" :size="18"/><b>التكلفة</b><button type="button" class="od-fold" aria-label="طي التكلفة" title="طي" @click="secOpen.cost = false"><Icon name="x" :size="14"/></button><span class="m od-r">للمدير فقط</span></div>
            <div class="od-pad"><CostSection :name="ed.name" :key="ed.name"/></div></section>
        </div>

        <aside class="od-side">
          <section class="od-card"><div class="od-ch"><Icon name="calendar" :size="18"/><b>التسليم</b></div><div class="od-pad">
            <div class="bd-chips"><button v-for="c in dueChips" :key="c[1]" type="button" class="bd-chip" :aria-pressed="f.due === isoIn(c[1])" @click="f.due = isoIn(c[1])">{{ c[0] }}</button><button type="button" class="bd-chip" :aria-pressed="!f.due" @click="f.due = ''; f.due_time = ''">بلا موعد</button></div>
            <div class="od-due"><input type="date" class="input" v-model="f.due" :min="editing ? null : isoIn(0)" aria-label="تاريخ التسليم"><input v-if="editing" type="time" class="input od-time" v-model="f.due_time" aria-label="الساعة"></div>
            <span v-if="editing && f.due && daysFromToday(f.due) < 0 && !(ed && ed.per_delivered >= 100)" class="od-late">متأخر {{ -daysFromToday(f.due) }} {{ -daysFromToday(f.due) <= 10 ? 'أيام' : 'يومًا' }}</span>
            <label v-if="editing && ed" class="cl-fgroup"><span>العمود</span><select class="input" v-model="f.column" aria-label="العمود"><option v-for="c in boardCols" :key="c.id" :value="c.id" :disabled="c.deliver && c.id !== ed.column">{{ c.name }}</option></select></label>
            <label v-if="startColumns.length > 1 && !editing" class="cl-fgroup" :class="{'od-miss': miss.column && !f.column}"><span>يبدأ في عمود <b class="od-req">*</b></span><select id="qo-column" class="input" v-model="f.column"><option :value="null" disabled>اختر العمود</option><option v-for="c in startColumns" :key="c.id" :value="c.id">{{ c.name }}</option></select>
              <em v-if="miss.column && !f.column" class="od-misstxt">اختر العمود الذي يبدأ فيه الطلب</em></label></div></section>
          <section v-if="editing && ed && !worker" class="od-card"><div class="od-ch"><Icon name="wallet" :size="18"/><b>المال</b><span class="m od-r">المجموع {{ money(ed.grand_total) }}</span></div><div class="od-pad">
            <div class="od-money"><span class="m">{{ ed.grand_total - ed.paid > 0.005 ? 'الباقي' : 'دُفع بالكامل' }}</span><b :class="{bad: ed.grand_total - ed.paid > 0.005}">{{ money(Math.max(0, ed.grand_total - ed.paid)) }}</b></div>
            <div class="tm-paybar"><span :style="{width: Math.min(100, ed.grand_total ? ed.paid / ed.grand_total * 100 : 0) + '%'}"></span></div>
            <span class="m">المدفوع: {{ money(ed.paid) }}</span>
            <button v-if="state.boot.can.payment && !ed.price_pending && ed.grand_total - ed.paid > 0.005" type="button" class="cl-btn primary" @click="payNow">استلمت دفعة</button>
                      <span v-if="state.boot.can.order && !worker" class="od-pop-host od-docs"><button type="button" class="cl-btn od-docbtn" :aria-expanded="hdPop === 'docs'" @click.stop="hdPop = hdPop === 'docs' ? null : 'docs'"><Icon name="file" :size="16"/>المستندات<Icon name="down" :size="14"/></button>
            <div v-if="hdPop === 'docs'" class="tm-pop od-pop" @click.stop>
              <button type="button" class="tm-pop-row" :disabled="unpriced > 0" @click="quoteDoc('devis')"><Icon name="file" :size="15"/>Devis — عرض سعر</button>
              <button type="button" class="tm-pop-row" :disabled="unpriced > 0" @click="quoteDoc('proforma')"><Icon name="file" :size="15"/>Pro forma</button>
              <a class="tm-pop-row" target="_blank" rel="noopener" :href="pdfUrl('Sales Order', ed.name, 'الورشة — عربي')" @click="hdPop = null"><Icon name="printer" :size="15"/>بون الطلب</a>
              <span v-if="unpriced > 0" class="m tm3-hint">سعّر كل البنود لإصدار Devis أو Pro forma.</span></div></span>
            <button v-if="ed.materials_pending" type="button" class="cl-btn sm" @click="materials">خصم مواد الطلب من المخزون</button></div></section>

          <section v-else class="od-card"><div class="od-ch"><Icon name="wallet" :size="18"/><b>تسبيق</b></div><div class="od-pad">
            <div class="unit-wrap"><input id="qo-adv" class="input num" inputmode="decimal" v-model="f.advance" placeholder="0" aria-label="التسبيق"><span class="u">دج</span></div>
            <div v-if="+f.advance > 0" class="bd-chips"><button v-for="m in state.boot.modes" :key="m.value" type="button" class="bd-chip" :aria-pressed="f.mode === m.value" @click="f.mode = m.value">{{ m.label }}</button></div></div></section>
          <section class="od-card"><div class="od-ch"><Icon name="users" :size="18"/><b>من يعمل عليه؟</b></div><div class="od-pad">
            <template v-if="editing"><button v-for="p in state.boot.team" :key="p" type="button" class="od-person" :aria-pressed="members.includes(p)" @click="flipMember(p)"><Avatar :name="p" :size="28"/><span style="flex:1">{{ p }}</span><span v-if="members.includes(p)" class="tm-tick">✓</span></button></template>
            <button v-else v-for="p in state.boot.team" :key="p" type="button" class="od-person" :aria-pressed="f.assignee === p" @click="f.assignee = f.assignee === p ? '' : p"><Avatar :name="p" :size="28"/><span style="flex:1">{{ p }}</span><span v-if="f.assignee === p" class="tm-tick">✓</span></button>
            <a v-if="!state.boot.team.length" href="/atelier/team" class="m" @click.prevent="go('/team')">أضف أسماء الفريق أولًا</a></div></section>
          <section v-if="boardStatuses.length || boardLabels.length" class="od-card" :class="{'od-miss': miss.status && !f.status.length && !editing}"><div class="od-ch"><Icon name="tag" :size="18"/><b>الحالات</b><b v-if="!editing && boardStatuses.length" class="od-req">*</b>
              <em v-if="miss.status && !f.status.length && !editing" class="od-misstxt od-r">اختر حالة واحدة على الأقل</em></div><div class="od-pad">
            <div class="od-opts"><button v-for="x in boardStatuses" :key="x.id" type="button" class="od-opt" :aria-pressed="f.status.includes(x.id)" @click="flip(f.status, x.id)">
                <span class="od-box" :style="f.status.includes(x.id) ? {background: x.color, borderColor: x.color, color: inkOn(x.color)} : {}">{{ f.status.includes(x.id) ? '✓' : '' }}</span>
                <span class="od-pill" :style="{background: x.color, color: inkOn(x.color)}">{{ x.name }}</span></button></div>
            <template v-if="boardLabels.length"><span class="od-sub">الوسوم</span>
              <div class="od-opts"><button v-for="x in boardLabels" :key="x.id" type="button" class="od-opt" :aria-pressed="f.labels.includes(x.id)" @click="flip(f.labels, x.id)">
                <span class="od-box" :style="f.labels.includes(x.id) ? {background: x.color, borderColor: x.color, color: inkOn(x.color)} : {}">{{ f.labels.includes(x.id) ? '✓' : '' }}</span>
                <span class="od-pill" :style="{background: x.color, color: inkOn(x.color)}">{{ x.name }}</span></button></div></template></div></section>
          <section v-if="editing && ed" class="od-card"><div class="od-ch"><Icon name="msg" :size="18"/><b>التعليقات والنشاط</b></div><div class="od-pad">
            <form class="od-comment" @submit.prevent="addComment"><textarea class="input od-desc" v-model="comment" rows="2" placeholder="اكتب تعليقًا… (Ctrl + Enter للحفظ)" aria-label="تعليق" @keydown.ctrl.enter.prevent.stop="addComment"></textarea>
              <button v-if="comment.trim()" type="submit" class="cl-btn primary sm">حفظ التعليق</button></form>
            <div class="od-acts"><div v-for="a in (allActs ? ed.activity : ed.activity.slice(0, 3))" :key="a.name" class="od-act"><Avatar :name="a.by" :size="26"/>
              <div style="flex:1;min-width:0"><b>{{ a.by }}</b> <span v-if="a.comment_type !== 'Comment'">{{ a.content }}</span>
                <div v-if="a.comment_type === 'Comment'" class="tm3-bubble" v-html="a.content"></div><div class="m">{{ ago(a.creation) }}</div></div></div>
              <span v-if="!ed.activity.length" class="m">لا نشاط بعد.</span>
              <button v-if="ed.activity.length > 3" type="button" class="cl-link" @click="allActs = !allActs">{{ allActs ? 'عرض الأحدث فقط' : 'عرض الكل (' + ed.activity.length + ')' }}</button></div></div></section>
        </aside>
      </div>
      <footer class="od-ft">
        <template v-if="!worker"><div class="od-big"><span>المجموع</span><b>{{ money(priced) }}</b></div>
        <div class="od-big"><span>الباقي</span><b :class="{bad: remain > 0.005}">{{ money(Math.max(0, remain)) }}</b></div></template>
        <div v-if="error" class="alert error od-err" role="alert">{{ error }}</div>
        <span class="spacer"></span>
        <span v-if="!editing" class="od-kbd"><kbd>Ctrl</kbd> + <kbd>Enter</kbd> حفظ · <kbd>Esc</kbd> إغلاق</span><span v-else class="od-kbd">كل تعديل يُحفظ مباشرة</span>
        <button v-if="editing" type="button" class="cl-btn primary od-btn" @click="closeEdit">إغلاق</button>
        <button v-else type="button" class="cl-btn od-btn" @click="cancelNew">إلغاء</button>
        <button v-if="!editing" type="button" class="cl-btn od-btn" :disabled="saving" @click="save(true)">حفظ وفتح البطاقة</button>
        <button v-if="!editing" type="submit" class="cl-btn primary od-btn" :disabled="saving">{{ saving ? 'جارٍ الحفظ…' : 'حفظ الطلب' }}</button>
      </footer>
    </form>
    </div>

    <div v-else class="bd-form">
      <div class="bd-ph"><div><h2>{{ o.atelier_subject || o.name }}</h2><a class="m" :href="'/atelier/customers?c=' + encodeURIComponent(o.customer)" @click.prevent="go('/customers?c=' + encodeURIComponent(o.customer))">{{ o.customer_name }}</a></div>
        <button type="button" class="btn ghost icon-btn" aria-label="إغلاق" @click="$emit('close')"><Icon name="x"/></button></div>
      <div class="bd-tags"><button v-for="q in QUICK_TAGS" :key="q[0]" type="button" class="qtag" :class="['tg-' + q[1], {on: (o.tags||[]).includes(q[0])}]" :aria-pressed="(o.tags||[]).includes(q[0])" :disabled="busy" @click="toggleTag(q[0])">{{ (o.tags||[]).includes(q[0]) ? '✓ ' : '' }}{{ q[0] }}</button></div>
      <div v-if="o.price_pending" class="bd-box warn"><label for="op-price" class="strong">لم يُحدَّد السعر بعد</label>
        <div class="row" style="gap:8px"><div class="unit-wrap" style="flex:1"><input id="op-price" class="input num" inputmode="decimal" v-model="price" placeholder="0"><span class="u">دج</span></div><button type="button" class="btn primary" :disabled="busy" @click="setPrice">حفظ</button></div></div>
      <div v-else class="bd-sums">
        <div><span class="m">السعر</span><span class="money strong">{{ money(o.grand_total) }}</span></div>
        <div><span class="m">دفع</span><span class="money">{{ money(o.paid) }}</span></div>
        <div><span class="m">الباقي</span><span class="money strong" :class="{'bd-late': left > 0.005}">{{ money(left) }}</span></div>
      </div>
      <div class="bd-line"><span class="m">الموعد</span><span>{{ date(o.delivery_date) }} · {{ dueWord(o.delivery_date) }}</span></div>
      <div class="f"><span class="lbl">من يعمل عليه؟</span><div class="bd-chips">
        <button v-for="p in state.boot.team" :key="p" type="button" class="bd-person" :aria-pressed="o.assignee === p" :disabled="busy" @click="setAssignee(p)"><Avatar :name="p"/>{{ p }}</button></div></div>
      <div v-if="error" class="alert error" role="alert">{{ error }}</div>
      <div class="spacer"></div>
      <button v-if="next" type="button" class="btn primary bd-save" :disabled="busy || (next[0]==='done' && o.price_pending)" @click="$emit('move', o, next[0])">{{ next[0] === 'done' ? 'سلّمته للعميل ‹' : 'نقل إلى «' + next[1] + '» ‹' }}</button>
      <span v-if="next && next[0]==='done'" class="hint">يُصدر بون التسليم والفاتورة تلقائيًا، ويُخصم التسبيق.</span>
      <div class="row" style="gap:8px">
        <button v-if="state.boot.can.payment && left > 0.005" type="button" class="btn" style="flex:1" @click="pay">استلمت دفعة</button>
        <a class="btn" style="flex:1" target="_blank" rel="noopener" :href="pdfUrl('Sales Order', o.name, 'الورشة — عربي')">بون الطلب PDF</a></div>
    </div>
  </aside>`,
};

const inkOn = (hex) => { const h = String(hex || "#888").replace("#", ""); const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? "#1D1630" : "#fff"; };
const labelStyle = (l) => ({ background: l.color, color: inkOn(l.color) });
const COVER_COLORS = ["#0F6E56", "#534AB7", "#993C1D", "#185FA5", "#993556", "#5F5E5A", "#854F0B", "#3B6D11"];
const folderLink = (path) => "nasaq://open/?p=" + encodeURIComponent(path || "");
const StatusMenu = {
  props: ["statuses", "current"], emits: ["pick"],
  setup(props, { emit }) {
    const has = (id) => (props.current || []).includes(id);
    const flip = (id) => emit("pick", has(id) ? props.current.filter((x) => x !== id) : [...(props.current || []), id]);
    return { has, flip, inkOn, go, state };
  },
  template: `<div class="st-menu"><b>الحالات <span class="m" style="display:inline;font-weight:400">— اختر واحدة أو أكثر</span></b>
    <label v-for="x in statuses" :key="x.id" class="tm-pop-row st-row"><input type="checkbox" :checked="has(x.id)" @change="flip(x.id)">
      <span class="st-pill" :style="{background: x.color, color: inkOn(x.color)}">{{ x.name }}</span></label>
    <button v-if="(current || []).length" type="button" class="tm-pop-row" @click="$emit('pick', [])"><i class="st-sw st-none"></i><span style="flex:1">إزالة كل الحالات</span></button>
    <button v-if="state.boot.can.prices" type="button" class="tm-pop-add" @click="go('/settings?tab=board')">تعديل الحالات وألوانها</button></div>`,
};
const BOARD_COLORS = ["#9A94AC", "#F5D547", "#F59E0B", "#E5484D", "#2563EB", "#22A06B", "#D7F1A8", "#9B87F5", "#1597A6", "#C2410C"];
const isImg = (f) => /\.(png|jpe?g|gif|webp)$/i.test(f.file_name || f.file_url || "");
const ago = (iso) => { const m = Math.round((Date.now() - new Date(String(iso).replace(" ", "T")).getTime()) / 60000);
  return m < 1 ? "الآن" : m < 60 ? `منذ ${m} دقيقة` : m < 1440 ? `منذ ${Math.round(m / 60)} ساعة` : `منذ ${Math.round(m / 1440)} يوم`; };

const BoardCard = {
  props: ["c", "labels", "statuses", "busy", "dropBefore", "columns"], emits: ["open", "drag", "dropon", "menu", "status", "hover"], components: { Avatar, Icon },
  setup(props, { emit }) {
    const sts = computed(() => (props.statuses || []).filter((x) => (props.c.status || []).includes(x.id)));
    // a lifted, slightly tilted copy follows the pointer; the card left behind fades
    const dragStart = (e) => {
      const el = e.currentTarget, ghost = el.cloneNode(true), r = el.getBoundingClientRect();
      ghost.classList.add("tc-ghost"); ghost.style.width = r.width + "px"; document.body.appendChild(ghost);
      e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", props.c.name);
      e.dataTransfer.setDragImage(ghost, Math.min(e.offsetX || 30, r.width - 10), 20);
      setTimeout(() => { ghost.remove(); el.classList.add("is-dragging"); }, 0);
      emit("drag", props.c);
    };
    return { dragStart, sts, inkOn, labelStyle, dueWord, daysFromToday, money };
  },
  template: `
  <article class="tc tc2" :class="{busy, 'drop-before': dropBefore}" draggable="true" tabindex="0" @dragstart="dragStart($event)" @dragend="$el.classList.remove('is-dragging')" @click="$emit('open', c)" @keydown.enter="$emit('open', c)"
     @contextmenu.prevent.stop="$emit('menu', c, $event)" @mouseenter="$emit('hover', c)" @mouseleave="$emit('hover', null)" @focus="$emit('hover', c)"
    @dragover.prevent.stop="$emit('dropon', c, false)" @drop.prevent.stop="$emit('dropon', c, true)" :aria-label="c.title + ' — ' + c.customer_name">
    <img v-if="c.cover" class="tc-cover" :src="c.cover" alt="" loading="lazy">
    <div v-else-if="c.cover_color" class="tc2-band" :style="{background: c.cover_color}"></div>
    <div class="tc-body">
      <div class="tc3-top" :class="{'has-sts': sts.length}"><div class="tc-title">{{ c.title }}</div>
        <button type="button" class="tc2-sts" :class="{empty: !sts.length}" :aria-label="'الحالات: ' + (sts.length ? sts.map(x => x.name).join('، ') : 'بلا حالة') + ' — تغيير'" @click.stop="$emit('status', c, $event)">
          <span v-for="x in sts" :key="x.id" class="st-pill" :style="{background: x.color, color: inkOn(x.color)}">{{ x.name }}</span>
          <span v-if="!sts.length" class="st-pill none">+ حالة</span></button>
        <button type="button" class="tc2-more" aria-label="خيارات البطاقة" @click.stop="$emit('menu', c, $event)"><Icon name="more" :size="14"/></button></div>
      <div class="tc-cust">{{ c.customer_name }}<template v-if="c.price_pending"> · <span class="bd-warn">بلا سعر</span></template><template v-else-if="c.grand_total > 0"> · {{ money(c.grand_total) }}</template></div>
      <div v-if="c.labels.some(id => labels[id])" class="tc2-tags"><span v-for="id in c.labels.filter(id => labels[id])" :key="id" class="tc2-tag"><i :style="{background: labels[id].color}"></i>{{ labels[id].name }}</span></div>
      <div class="tc-foot">
        <span v-if="c.due && c.per_delivered < 100" class="tc-due" :class="{late: daysFromToday(c.due) < 0, soon: daysFromToday(c.due) >= 0 && daysFromToday(c.due) <= 1}"><Icon name="clock" :size="13"/>{{ dueWord(c.due) }}<template v-if="c.due_time"> {{ c.due_time }}</template></span>
        <span v-if="c.comments" class="tc-m" title="تعليقات"><Icon name="msg" :size="13"/>{{ c.comments }}</span>
        <span v-if="c.files" class="tc-m" title="مرفقات"><Icon name="file" :size="13"/>{{ c.files }}</span>
        <span v-if="c.check[1]" class="tc-check" :class="{full: c.check[0] === c.check[1]}" title="قائمة المهام"><Icon name="check" :size="13"/>{{ c.check[0] }}/{{ c.check[1] }}</span>
        <span class="spacer"></span>
        <span v-if="c.grand_total > 0" class="tc-pay" :class="c.paid >= c.grand_total - 0.005 ? 'ok' : c.paid > 0.005 ? 'part' : 'none'">{{ c.paid >= c.grand_total - 0.005 ? 'مدفوع' : c.paid > 0.005 ? 'جزئي' : 'غير مدفوع' }}</span>
        <span class="tc-members"><Avatar v-for="m in c.members.slice(0, 3)" :key="m" :name="m"/></span>
      </div>
    </div>
  </article>`,
};

// card actions shared by the board menu and the card window
const cardActions = {
  copy: async (name) => { const n = await call("copy_card", { name }, true); toast("نُسخت البطاقة"); return n; },
  archive: async (name, on = 1) => { await call("archive_card", { name, archived: on }, true); toast(on ? "أُرشفت البطاقة" : "استُرجعت البطاقة"); },
  photo: async (name, file) => {
    const up = await uploadPrivate(await shrinkImage(file), "Sales Order", name);
    await call("file_added", { name, file_url: up.file_url, file_name: up.file_name }, true); toast("أُرفقت الصورة");
  },
};

const WEEK = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const CostSection = {
  props: ["name"], emits: ["use-price"], components: { Icon },
  setup(props, { emit }) {
    const d = ref(null), error = ref(null), busy = ref(false), open = ref(false), target = ref(30);
    const load = async () => { try { d.value = await call("card_cost", { name: props.name }); open.value = false; } catch (e) { error.value = e.message; } };
    const add = () => { d.value.lines.push({ cost_type: costTypes.value[0].value, description: "", qty: 1, rate: "" }); open.value = true; };
    const costTypes = computed(() => state.boot.lists.cost_types);
    const typeOptions = (l) => (costTypes.value.some((c) => c.value === l.cost_type) ? costTypes.value : [...costTypes.value, { value: l.cost_type, label: l.cost_type }]);
    const isMaterial = (l) => l.cost_type === "Matière" || costTypes.value.some((c) => c.value === l.cost_type && c.material);
    const amount = (l) => (+l.qty || 0) * (+l.rate || 0) * (isMaterial(l) ? 1 + (+d.value.waste_percent || 0) / 100 : 1);
    const total = computed(() => d.value.lines.reduce((sum, l) => sum + amount(l), 0));
    const unit = computed(() => (+d.value.qty ? total.value / +d.value.qty : 0));
    const missing = computed(() => d.value.lines.filter((l) => l.description.trim() && (l.rate === "" || l.rate === null)).length);
    const profit = computed(() => (d.value.selling_price === null ? null : d.value.selling_price - total.value));
    const margin = computed(() => (d.value.selling_price ? Math.round(profit.value / d.value.selling_price * 100) : null));
    const suggested = computed(() => { const m = +target.value; return m >= 0 && m < 100 && total.value ? Math.ceil(total.value / (1 - m / 100)) : null; });
    const save = async () => {
      busy.value = true; error.value = null;
      try { d.value = await call("save_card_cost", { name: props.name, data: JSON.stringify({ qty: d.value.qty, waste_percent: d.value.waste_percent, lines: d.value.lines }) }, true); toast("حُفظت التكلفة"); }
      catch (e) { error.value = e.message; } finally { busy.value = false; }
    };
    load();
    return { d, error, busy, open, target, add, total, unit, missing, profit, margin, suggested, save, money, typeOptions, emit };
  },
  template: `
  <div class="tm-money tm-cost"><button type="button" class="tm-fold" :aria-expanded="open" @click="open = !open"><b>التكلفة</b><span class="m">{{ d && d.lines.length ? money(total) : 'اختياري' }} {{ open ? '▴' : '▾' }}</span></button>
    <div v-if="error" class="alert error">{{ error }}</div>
    <template v-if="d && open">
      <template v-if="true">
        <div v-for="(l, i) in d.lines" :key="i" class="cost-line">
          <select class="input" v-model="l.cost_type" aria-label="نوع التكلفة"><option v-for="c in typeOptions(l)" :key="c.value" :value="c.value">{{ c.label }}</option></select>
          <input class="input" v-model="l.description" aria-label="البند" placeholder="البند، مثل: ورق 350غ">
          <input class="input num" inputmode="decimal" v-model="l.qty" aria-label="الكمية" placeholder="الكمية">
          <input class="input num" inputmode="decimal" v-model="l.rate" aria-label="سعر الوحدة" placeholder="السعر">
          <button type="button" class="btn ghost icon-btn" :aria-label="'حذف ' + (l.description || 'البند')" @click="d.lines.splice(i, 1)">×</button>
        </div>
        <div class="cost-opts"><label><span class="m">الكمية المنتجة</span><input class="input num" inputmode="decimal" v-model="d.qty"></label>
          <label><span class="m">تلف المواد %</span><input class="input num" inputmode="decimal" v-model="d.waste_percent"></label></div>
      </template>
      <button type="button" class="btn sm" @click="add">+ إضافة بند</button>
      <template v-if="d.lines.length">
        <div v-if="missing" class="m bd-late">{{ missing }} بند بلا سعر: الحساب غير مكتمل</div>
        <div class="bd-line"><span class="m">التكلفة الكلية</span><b class="money">{{ money(total) }}</b></div>
        <div class="bd-line"><span class="m">تكلفة الوحدة</span><span class="money">{{ money(unit) }}</span></div>
        <template v-if="profit !== null"><div class="bd-line"><span class="m">الربح المتوقع</span><b class="money" :class="{'bd-late': profit < 0}">{{ money(profit) }}</b></div>
          <div v-if="margin !== null" class="bd-line"><span class="m">الهامش</span><span class="money">{{ margin }}%</span></div></template>
        <div class="cost-opts"><label><span class="m">الهامش المستهدف %</span><input class="input num" inputmode="decimal" v-model="target"></label>
          <div><span class="m">السعر المقترح</span><b class="money" style="display:block">{{ suggested ? money(suggested) : '—' }}</b></div></div>
        <button v-if="suggested && d.selling_price === null" type="button" class="btn sm" @click="emit('use-price', suggested)">ضع المقترح في خانة السعر</button>
        <button type="button" class="btn primary" :disabled="busy" @click="save">حفظ التكلفة</button>
      </template>
    </template>
  </div>`,
};
BoardPanel.components.CostSection = CostSection;


// display size control: a button with a small popover, and Alt + = / Alt + - anywhere (even inside a card)
const sizeState = reactive({ zoom: zoomOf() });
async function setScale(z, announce) {
  applyScale(z); sizeState.zoom = z;
  if (announce) toast(`حجم العرض ${Math.round(z * 100)}%`);
  try { await call("set_ui_scale", { scale: z }, true); } catch (e) { toast(e.message, "error"); }
}
window.addEventListener("keydown", (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey) return;
  const step = e.code === "Equal" || e.code === "NumpadAdd" ? 1 : e.code === "Minus" || e.code === "NumpadSubtract" ? -1 : 0;
  if (!step) return;
  e.preventDefault();
  const i = SCALES.findIndex((x) => x[0] === sizeState.zoom), next = SCALES[Math.min(SCALES.length - 1, Math.max(0, (i < 0 ? 1 : i) + step))][0];
  if (next !== sizeState.zoom) setScale(next, true);
});
const SizeControl = {
  props: ["cls"],
  setup() {
    const open = ref(false);
    const close = () => (open.value = false);
    onMounted(() => document.addEventListener("click", close)); onBeforeUnmount(() => document.removeEventListener("click", close));
    return { open, sizeState, SCALES, pick: (z) => setScale(z) };
  },
  template: `
  <div class="sz-host"><button type="button" :class="cls || 'cl-btn icon'" class="sz-btn" aria-label="حجم العرض" title="حجم العرض" :aria-expanded="open" @click.stop="open = !open">Aa</button>
    <div v-if="open" class="sz-pop" role="group" aria-label="حجم العرض" @click.stop><b>حجم العرض</b>
      <div class="who-seg"><button v-for="x in SCALES" :key="x[0]" type="button" dir="ltr" :aria-pressed="sizeState.zoom === x[0]" @click="pick(x[0])">{{ x[1] }}</button></div>
      <span class="m">خاص بك ويبقى معك على أي حاسوب.</span><span class="m">من أي مكان: <bdi dir="ltr">Alt +</bdi> للتكبير، <bdi dir="ltr">Alt −</bdi> للتصغير.</span></div></div>`,
};

const Board = {
  props: ["startNew", "openCard"], components: { Icon, BoardCard, BoardPanel, Avatar, TransitionGroup, StatusMenu, SizeControl },
  setup(props) {
    const { s, load } = useLoad(() => call("board2"));
    onMounted(load);
    watch(() => state.rev, load);
    const cfg = computed(() => s.data?.config || { columns: [], labels: [], statuses: [] });
    const labels = computed(() => Object.fromEntries(cfg.value.labels.map((l) => [l.id, l])));
    const mine = ref(false), label = ref(""), q = ref(""), view = ref(localStorage.getItem("atelier.view") || "board");
    watch(view, (v) => { try { localStorage.setItem("atelier.view", v); } catch { /* private mode */ } });
    const me = computed(() => state.boot.me || state.boot.full_name || "");
    const needle = computed(() => q.value.trim().toLowerCase());
    const fCust = ref(""), fMember = ref(""), when = ref("");
    const custOpts = computed(() => [...new Map((s.data?.cards || []).map((c) => [c.customer, c.customer_name])).entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1]), "ar")));
    const memberOpts = computed(() => [...new Set((s.data?.cards || []).flatMap((c) => c.members))].sort());
    const inWhen = (c) => { if (!when.value) return true; if (!c.due || c.per_delivered >= 100) return false; const d = daysFromToday(c.due);
      return when.value === "late" ? d < 0 : when.value === "today" ? d === 0 : d >= 0 && d <= 6; };
    const filtersOn = computed(() => !!(label.value || mine.value || fCust.value || fMember.value || when.value || q.value));
    const clearFilters = () => { label.value = ""; mine.value = false; fCust.value = ""; fMember.value = ""; when.value = ""; q.value = ""; };
    const rows = computed(() => (s.data?.cards || []).filter((c) => (!mine.value || c.members.includes(me.value)) && (!label.value || c.labels.includes(label.value) || (c.status || []).includes(label.value))
      && (!fCust.value || c.customer === fCust.value) && (!fMember.value || c.members.includes(fMember.value)) && inWhen(c)
      && (!needle.value || [c.title, c.customer_name, c.name].some((v) => String(v || "").toLowerCase().includes(needle.value)))));
    const urgent = (c) => (c.labels.some((x) => labels.value[x]?.name === "عاجل") ? 0 : 1);
    const order = (a, b) => (a.pos && b.pos ? a.pos - b.pos : a.pos ? -1 : b.pos ? 1 : urgent(a) - urgent(b) || String(a.due || "9").localeCompare(String(b.due || "9")));
    let saved0 = {}; try { saved0 = JSON.parse(localStorage.getItem("atelier.colsort") || "{}"); } catch { /* private mode */ }
    const colSort = reactive(saved0);
    watch(colSort, (v) => { try { localStorage.setItem("atelier.colsort", JSON.stringify(v)); } catch { /* private mode */ } });
    const SORTS = { due: (a, b) => String(a.due || "9").localeCompare(String(b.due || "9")), created: (a, b) => String(b.name).localeCompare(String(a.name)), amount: (a, b) => (+b.grand_total || 0) - (+a.grand_total || 0) };
    const isLate = (c) => c.due && c.per_delivered < 100 && daysFromToday(c.due) < 0;
    const cols = computed(() => cfg.value.columns.filter((col) => !col.hidden).map((col) => { const items = rows.value.filter((c) => c.column === col.id).sort(SORTS[colSort[col.id]] || order);
      // work columns show the value in progress (and what was paid ahead); the delivery column shows what is still owed
      const sum = items.reduce((a, c) => a + (+c.grand_total || 0), 0), paid = items.reduce((a, c) => a + (+c.paid || 0), 0);
      const owed = items.reduce((a, c) => a + Math.max(0, (+c.grand_total || 0) - (+c.paid || 0)), 0);
      return { ...col, items, sum, paid, owed, late: items.filter(isLate).length, unpriced: items.filter((c) => c.price_pending).length }; }));
    const flash = ref(null);  // {col, kind}: briefly marks the late or unpriced cards of one column
    const flashCards = (col, kind) => { flash.value = { col, kind }; setTimeout(() => (flash.value = null), 2200); };
    const hiddenCols = computed(() => cfg.value.columns.filter((c) => c.hidden));
    // column menu
    const colMenu = ref(null), colName = ref(""), colMove = ref(false);
    const openColMenu = (col, ev) => { menu.value = null; stMenu.value = null; colName.value = col.name; colMove.value = false; colMenu.value = { col, ...place(ev, 250) }; };
    const saveCols = async (list) => {
      try { await call("save_board", { config: JSON.stringify({ columns: list, labels: cfg.value.labels, statuses: cfg.value.statuses }) }, true); await load(); } catch (e) { toast(e.message, "error"); }
    };
    const editCol = (id, ch) => saveCols(cfg.value.columns.map((c) => (c.id === id ? { ...c, ...ch } : c)));
    const renameCol = async () => { const v = colName.value.trim(), m = colMenu.value; if (!m || !v || v === m.col.name) return; colMenu.value = null; await editCol(m.col.id, { name: v }); toast("تغيّر اسم العمود"); };
    const setColColor = async (color) => { const m = colMenu.value; if (!m) return; m.col.color = color; await editCol(m.col.id, { color }); };
    const hideCol = async (on, id) => { colMenu.value = null; more.value = false; await editCol(id, on ? { hidden: 1 } : { hidden: 0 }); };
    // drag a column by its title to change the order (manager)
    const colDrag = ref(null), colOver = ref(null);
    const colIdx = (id) => (cfg.value?.columns || []).findIndex((x) => x.id === id);
    const colDragStart = (c, e) => { if (!s.data?.manager) return; colDrag.value = c.id; colOver.value = c.id; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", "col:" + c.id);
      const sec = e.target.closest(".tb-col"); if (sec) { const r = sec.getBoundingClientRect(); try { e.dataTransfer.setDragImage(sec, e.clientX - r.left, e.clientY - r.top); } catch { /* ok */ } } };
    const colDrop = async (target) => {
      const from = colDrag.value; colDrag.value = null; colOver.value = null; if (!from || from === target.id) return;
      const list = cfg.value.columns.map((c) => ({ ...c })), a = list.findIndex((c) => c.id === from), b = list.findIndex((c) => c.id === target.id);
      const [m] = list.splice(a, 1); list.splice(b, 0, m); cfg.value.columns.splice(0, cfg.value.columns.length, ...list);
      await saveCols(list); toast("تغيّر ترتيب الأعمدة");
    };
    const sortCol = (id, k) => { if (k) colSort[id] = k; else delete colSort[id]; colMenu.value = null; };
    const moveAll = async (from, to) => {
      colMenu.value = null; const list = (s.data?.cards || []).filter((c) => c.column === from.id); if (!list.length) return;
      busy.value = "*";
      try { for (const c of list) await call("move_card", { name: c.name, column: to.id }, true); toast(`نُقلت ${list.length} بطاقة إلى «${to.name}»`); if (to.deliver) list.forEach((c) => offerMaterials(c.name)); }
      catch (e) { toast(e.message, "error"); } finally { busy.value = null; await load(); }
    };
    // save a card as a template
    const tplAsk = ref(null), tplName = ref(""), tplBusy = ref(false);
    const saveTpl = async () => {
      const c = tplAsk.value, v = tplName.value.trim(); if (!c || !v) return; tplBusy.value = true;
      try { await call("save_card_template", { name: c.name, title: v }, true); toast(`حُفظ القالب «${v}»`); tplAsk.value = null; } catch (e) { toast(e.message, "error"); } finally { tplBusy.value = false; }
    };
    const panel = ref(null);
    if (props.startNew) { state.sheet = { type: "order", customer: state.quickCustomer || null }; }
    state.quickCustomer = null;
    const open = ref(props.openCard || state.query.get("card") || null);
    // a card opens in the order window (same as a new order); the full card (files, comments, money) on request
    watch(open, (v) => { if (v) { state.sheet = { type: "order", edit: v }; open.value = null; } }, { immediate: true });
    const busy = ref(null), dragging = ref(null), over = ref(null), before = ref(null);
    async function moveTo(c, col, beforeName) {
      busy.value = c.name;
      try {
        if (c.column !== col) { await call("move_card", { name: c.name, column: col }, true); if (cfg.value.columns.find((x) => x.id === col)?.deliver) offerMaterials(c.name); toast(`نُقلت إلى «${cfg.value.columns.find((x) => x.id === col).name}»`); }
        if (beforeName !== undefined) {
          const list = cols.value.find((x) => x.id === col).items.map((x) => x.name).filter((n) => n !== c.name);
          const i = beforeName ? list.indexOf(beforeName) : -1;
          list.splice(i >= 0 ? i : list.length, 0, c.name);
          await call("reorder", { column: col, names: JSON.stringify(list) }, true);
        }
        await load();
      } catch (e) { toast(e.message, "error"); await load(); } finally { busy.value = null; }
    }
    const drop = (col) => { const c = dragging.value; dragging.value = null; over.value = null; before.value = null; if (c) moveTo(c, col, null); };
    const dropOn = (target, done) => {
      if (colDrag.value) { const col = cols.value.find((x) => x.items.some((i) => i.name === target.name)); if (col) { if (done) colDrop(col); else colOver.value = col.id; } return; }
      if (!dragging.value || dragging.value.name === target.name) return;
      over.value = target.column; before.value = target.name;
      if (done) { const c = dragging.value; dragging.value = null; over.value = null; before.value = null; moveTo(c, target.column, target.name); }
    };
    // inline add card / column
    const adding = ref(null), newTitle = ref("");
    const addCard = async (col) => {
      const v = newTitle.value.trim(); if (!v) { adding.value = null; return; }
      try { await call("add_card", { column: col, title: v }, true); newTitle.value = ""; await load(); } catch (e) { toast(e.message, "error"); }
    };
    const startAdd = (col) => { adding.value = col; newTitle.value = ""; nextTick(() => document.getElementById("add-" + col)?.focus()); };
    const newCol = ref(""), addingCol = ref(false);
    const addColumn = async () => {
      const v = newCol.value.trim(); if (!v) { addingCol.value = false; return; }
      const list = [...cfg.value.columns]; const di = list.findIndex((c) => c.deliver);
      list.splice(di >= 0 ? di : list.length, 0, { name: v, color: BOARD_COLORS[list.length % BOARD_COLORS.length] });
      try { await call("save_board", { config: JSON.stringify({ columns: list, labels: cfg.value.labels }) }, true); newCol.value = ""; addingCol.value = false; await load(); } catch (e) { toast(e.message, "error"); }
    };
    const startCol = () => { addingCol.value = true; nextTick(() => document.getElementById("new-col")?.focus()); };
    const archivePaid = async (col) => {
      if (!confirm("أرشفة كل البطاقات المسلّمة والمدفوعة في هذا العمود؟")) return;
      try { const n = await call("archive_paid", { column: col }, true); toast(`أُرشفت ${n} بطاقة`); await load(); } catch (e) { toast(e.message, "error"); }
    };
    const paidCount = (col) => col.items.filter((c) => c.per_delivered >= 100 && c.paid >= c.grand_total - 0.005).length;
    // card menu
    const menu = ref(null), photoInput = ref(null);
    // menus are position:fixed inside a zoomed page: work in page pixels (screen pixels ÷ zoom)
    const box = (ev) => {
      const z = zoomOf(), vh = window.innerHeight / z, vw = window.innerWidth / z;
      if (ev.type === "contextmenu") { const x = ev.clientX / z, y = ev.clientY / z; return { z, top: y, bottom: y, right: x, vh, vw }; }
      const r = ev.currentTarget.getBoundingClientRect(); return { z, top: r.top / z, bottom: r.bottom / z, right: r.right / z, vh, vw };
    };
    const place = (ev, w) => { const r = box(ev); return { top: Math.min(r.bottom + 6, r.vh - 340), left: Math.min(Math.max(8, r.right - w), r.vw - w - 8) }; };
    // after it renders, keep the menu on screen: below the button if it fits, else above, else pinned with its own scroll
    const fitPop = (m, ev) => {
      const r = box(ev);
      nextTick(() => {
        const el = document.querySelector(".tb-menu"); if (!el || !m.value) return;
        const h = Math.min(el.scrollHeight, r.vh - 16), below = r.vh - r.bottom - 8, above = r.top - 8;
        m.value.top = h <= below ? r.bottom + 6 : h <= above ? r.top - 6 - h : Math.max(8, r.vh - 8 - h);
      });
    };
    const openMenu = (c, ev) => { stMenu.value = null; menu.value = { c, view: null, ...place(ev, 236) }; menu.anchor = ev.type === "contextmenu" ? { type: "contextmenu", clientX: ev.clientX, clientY: ev.clientY } : { type: "click", currentTarget: ev.currentTarget }; fitPop(menu, ev); };
    // sub-views of the card menu: statuses, members, due date
    const menuView = (v) => { if (!menu.value) return; menu.value.view = v; if (menu.anchor) fitPop(menu, menu.anchor); };
    const team = computed(() => state.boot.team || []);
    const saveCard = async (c, changes, msg) => {
      try { await call("update_card", { name: c.name, changes: JSON.stringify(changes) }, true); if (msg) toast(msg); } catch (e) { toast(e.message, "error"); await load(); }
    };
    const menuStatus = (list) => { const c = menu.value?.c; if (!c) return; c.status = list; saveCard(c, { status: list }); };
    const toggleMember = (c, m) => { const had = (c.members || []).includes(m); c.members = had ? c.members.filter((x) => x !== m) : [...(c.members || []), m]; saveCard(c, { members: c.members }); return !had; };
    const menuDue = async (iso) => { const c = menu.value?.c; if (!c) return; menu.value = null; c.due = iso || null; await saveCard(c, { due: iso || null }, iso ? "تغيّر الموعد" : "أُزيل موعد التسليم"); await load(); };
    // Space over a card: take it (add myself as a member) or let it go
    const hovered = ref(null);
    const onSpace = (e) => {
      if (e.code !== "Space" || e.ctrlKey || e.altKey || e.metaKey || !hovered.value) return;
      const t = e.target; if (t instanceof HTMLElement && (t.matches("input, textarea, select, [contenteditable]") || t.isContentEditable)) return;
      if (open.value || panel.value || document.querySelector(".overlay")) return;
      e.preventDefault();
      const me = s.data?.me; if (!me) { toast("اربط حسابك بشخص في الإعدادات ← الفريق لتأخذ البطاقات.", "error"); return; }
      const c = hovered.value, added = toggleMember(c, me);
      toast(added ? `أُضفت إلى «${c.title}»` : `أُزلت من «${c.title}»`);
    };
    onMounted(() => window.addEventListener("keydown", onSpace)); onBeforeUnmount(() => window.removeEventListener("keydown", onSpace));
    const stMenu = ref(null);
    const openStatus = (c, ev) => { menu.value = null; stMenu.value = { c, ...place(ev, 230) }; fitPop(stMenu, ev); };
    const pickStatus = async (list) => {
      const c = stMenu.value?.c; if (!c) return;
      const before = c.status; c.status = list;
      try { await call("update_card", { name: c.name, changes: JSON.stringify({ status: list }) }, true); }
      catch (e) { c.status = before; toast(e.message, "error"); }
    };
    const fopen = ref(false), more = ref(false);
    const openCount = computed(() => (s.data?.cards || []).filter((c) => c.per_delivered < 100).length);
    const closeMenu = () => { menu.value = null; stMenu.value = null; fopen.value = false; more.value = false; colMenu.value = null; };
    onMounted(() => window.addEventListener("click", closeMenu));
    onBeforeUnmount(() => window.removeEventListener("click", closeMenu));
    const act = async (kind, extra) => {
      const c = menu.value?.c; menu.value = null; if (!c) return;
      try {
        if (kind === "copy") { const n = await cardActions.copy(c.name); await load(); open.value = n; }
        else if (kind === "archive") { await cardActions.archive(c.name); await load(); }
        else if (kind === "move") await moveTo(c, extra, undefined);
        else if (kind === "photo") { photoFor.value = c.name; photoInput.value.click(); }
        else if (kind === "delete") { delAsk.value = c; }
        else if (kind === "template") { tplName.value = c.title; tplAsk.value = c; nextTick(() => document.getElementById("tpl-name")?.select()); }
      } catch (e) { toast(e.message, "error"); }
    };
    const photoFor = ref(null);
    const delAsk = ref(null), delBusy = ref(false);
    const doDelete = async () => {
      const c = delAsk.value; if (!c) return; delBusy.value = true;
      try { await call("delete_card", { name: c.name }, true); toast("حُذفت البطاقة"); delAsk.value = null; await load(); }
      catch (e) { toast(e.message, "error"); delAsk.value = null; } finally { delBusy.value = false; }
    };
    const onPhoto = async (e) => { const f = e.target.files?.[0]; if (!f || !photoFor.value) return; try { await cardActions.photo(photoFor.value, f); await load(); } catch (x) { toast(x.message, "error"); } e.target.value = ""; };
    // archive list
    const archive = ref(null);
    const showArchive = async () => { archive.value = []; try { archive.value = await call("archived_cards"); } catch (e) { toast(e.message, "error"); } };
    const restore = async (n) => { await cardActions.archive(n, 0); archive.value = archive.value.filter((x) => x.name !== n); await load(); };
    // notifications
    const notes = ref({ logs: [], due: [], unread: 0 }), bell = ref(false);
    const loadNotes = async () => { try { notes.value = await call("notifications"); } catch { /* bell stays quiet */ } };
    let timer;
    onMounted(() => { loadNotes(); timer = setInterval(loadNotes, 60000); });
    onBeforeUnmount(() => clearInterval(timer));
    const toggleBell = async () => { bell.value = !bell.value; if (bell.value && notes.value.logs.some((l) => !l.read)) { await call("mark_read", {}, true).catch(() => {}); } };
    watch(bell, (v) => !v && loadNotes());
    // calendar
    // the week starts on Saturday; off days and the daily limit come from the workshop's settings
    const calMode = ref("week"), weekStart = ref(0), monthOff = ref(0);
    const calCfg = computed(() => s.data?.calendar || { day_limit: 5, off_days: [5] });
    const satOf = (d) => { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 1) % 7)); return x; };
    const openRows = computed(() => rows.value.filter((c) => c.per_delivered < 100));
    const dayOf = (d, extra) => { const iso = isoOf(d), items = openRows.value.filter((c) => c.due === iso);
      return { iso, name: WEEK[d.getDay()], num: d.getDate(), today: iso === todayISO(), off: calCfg.value.off_days.includes(d.getDay()), items,
        full: calCfg.value.day_limit > 0 && items.length > calCfg.value.day_limit, ...extra }; };
    const days = computed(() => {
      const base = satOf(parseDate(todayISO())); base.setDate(base.getDate() + weekStart.value * 7);
      return Array.from({ length: 7 }, (_, i) => { const d = new Date(base); d.setDate(base.getDate() + i); return dayOf(d); });
    });
    const monthDays = computed(() => {
      const t = parseDate(todayISO()), first = new Date(t.getFullYear(), t.getMonth() + monthOff.value, 1), start = satOf(first);
      const last = new Date(first.getFullYear(), first.getMonth() + 1, 0), n = Math.ceil((Math.round((last - start) / 86400000) + 1) / 7) * 7;
      return Array.from({ length: n }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return dayOf(d, { out: d.getMonth() !== first.getMonth() }); });
    });
    const monthTitle = computed(() => { const t = parseDate(todayISO()); return new Intl.DateTimeFormat("ar-DZ-u-nu-latn", { month: "long", year: "numeric" }).format(new Date(t.getFullYear(), t.getMonth() + monthOff.value, 1)); });
    const calHead = computed(() => WEEK.map((_, i) => WEEK[(i + 6) % 7]));
    const lateRows = computed(() => openRows.value.filter((c) => c.due && daysFromToday(c.due) < 0).sort((a, b) => (a.due < b.due ? -1 : 1)));
    const lateCount = computed(() => lateRows.value.length);
    const undated = computed(() => openRows.value.filter((c) => !c.due));
    const lateWord = (iso) => { const n = -daysFromToday(iso); return n === 1 ? "أمس" : n === 2 ? "منذ يومين" : `منذ ${n} ${n <= 10 ? "أيام" : "يومًا"}`; };
    const colOf = (c) => (cfg.value.columns || []).find((x) => x.id === c.column) || { name: "", color: "#9B87F5" };
    const calPrev = () => (calMode.value === "week" ? weekStart.value-- : monthOff.value--);
    const calNext = () => (calMode.value === "week" ? weekStart.value++ : monthOff.value++);
    const calToday = () => { weekStart.value = 0; monthOff.value = 0; };
    const openWeek = (iso) => { const sat = satOf(parseDate(iso)), now = satOf(parseDate(todayISO())); weekStart.value = Math.round((sat - now) / (7 * 86400000)); calMode.value = "week"; };
    const dropDay = async (iso) => {
      const c = dragging.value; dragging.value = null; over.value = null; if (!c || c.due === iso) return;
      try { await call("update_card", { name: c.name, changes: JSON.stringify({ due: iso }) }, true); toast("تغيّر الموعد"); await load(); } catch (e) { toast(e.message, "error"); }
    };
    const saved = async () => { await load(); panel.value = null; };
    const closePanel = () => { panel.value = null; if (route.value.name === "order-new") go("/"); };
    return { colDrag, colOver, colIdx, colDragStart, colDrop, flash, flashCards, isLate, menuView, team, menuStatus, toggleMember, menuDue, hovered, isoIn, fCust, fMember, when, custOpts, memberOpts, filtersOn, clearFilters, colSort, hiddenCols, colMenu, colName, colMove, openColMenu, renameCol, setColColor, hideCol, sortCol, moveAll,
      tplAsk, tplName, tplBusy, saveTpl, BOARD_COLORS, money, me, delAsk, delBusy, doDelete, stMenu, openStatus, pickStatus, fopen, more, openCount, s, load, cfg, labels, mine, label, q, view, cols, panel, open, busy, dragging, over, before, moveTo, drop, dropOn, adding, newTitle, addCard, startAdd,
      newCol, addingCol, addColumn, startCol, archivePaid, paidCount, menu, openMenu, act, photoInput, onPhoto, archive, showArchive, restore,
      notes, bell, toggleBell, weekStart, days, lateCount, dropDay, calMode, monthDays, monthTitle, calHead, lateRows, undated, lateWord, colOf, calPrev, calNext, calToday, openWeek, calCfg, saved, closePanel, labelStyle, ago, dueWord, date, state, go, t };
  },
  template: `
  <div class="page tb cb">
    <div class="tb-head">
      <h1>الطلبات</h1>
      <span class="cl-count">{{ openCount }} {{ openCount === 1 ? 'طلب جارٍ' : 'طلبات جارية' }}</span>
      <div class="mn-month cb-views" role="group" aria-label="طريقة العرض"><button type="button" :aria-pressed="view === 'board'" @click="view = 'board'"><Icon name="grid" :size="15"/>لوحة</button><button type="button" :aria-pressed="view === 'calendar'" @click="view = 'calendar'"><Icon name="calendar" :size="15"/>تقويم</button></div>
      <span class="spacer"></span>
      <label class="cl-search"><Icon name="search" :size="16"/><span class="sr-only">بحث في البطاقات</span><input type="search" v-model="q" placeholder="ابحث: عميل، عنوان، رقم"></label>
      <SizeControl/>
      <div class="tb-bell-host"><button type="button" class="cl-btn icon cb-bell" :aria-label="'التنبيهات' + (notes.unread ? ' — ' + notes.unread + ' جديدة' : '')" :aria-expanded="bell" @click.stop="fopen = false; more = false; toggleBell()"><Icon name="bell" :size="18"/><span v-if="notes.unread" class="cb-dot"></span></button>
        <div v-if="bell" class="tm-pop tb-bell-pop" @click.stop>
          <b>التنبيهات</b>
          <button v-for="d in notes.due" :key="'d' + d.name" type="button" class="tm-pop-row" @click="open = d.name; bell = false">
            <span class="tb-due-ic" :class="{late: d.late}"><Icon name="clock" :size="15"/></span><span style="flex:1">«{{ d.title }}» <span :class="d.late ? 'bd-late' : 'bd-warn'">{{ dueWord(d.due) }}<template v-if="d.due_time"> {{ d.due_time }}</template></span></span></button>
          <button v-for="l in notes.logs" :key="l.name" type="button" class="tm-pop-row" :class="{unread: !l.read}" @click="open = l.document_name; bell = false">
            <Avatar :name="l.by" :size="28"/><span style="flex:1;min-width:0"><span>{{ l.subject }}</span><span class="m">{{ ago(l.creation) }}</span></span></button>
          <span v-if="!notes.due.length && !notes.logs.length" class="m">لا تنبيهات.</span>
        </div></div>
      <div class="cl-pop-host"><button type="button" class="cl-btn icon" aria-label="المزيد" :aria-expanded="more" @click.stop="more = !more; fopen = false; bell = false"><Icon name="more" :size="18"/></button>
        <div v-if="more" class="cl-pop cl-menu" @click.stop><button type="button" @click="more = false; showArchive()"><Icon name="box" :size="16"/>الأرشيف</button>
          <button v-if="s.data && s.data.manager" type="button" @click="go('/settings?tab=board')"><Icon name="gear" :size="16"/>تخصيص اللوحة</button>
          <template v-if="hiddenCols.length && s.data && s.data.manager"><span class="m tb-more-h">أعمدة مخفية</span>
            <button v-for="hc in hiddenCols" :key="hc.id" type="button" @click="hideCol(false, hc.id)"><i class="st-sw" :style="{background: hc.color}"></i>إظهار «{{ hc.name }}»</button></template></div></div>
      <button v-if="state.boot.can.order" type="button" class="cl-btn primary" @click="state.sheet = {type: 'order'}"><Icon name="plus" :size="16"/>طلب جديد</button>
    </div>
    <div v-if="s.data" class="tb-filters" role="group" aria-label="تصفية البطاقات">
      <select class="input" :class="{on: fCust}" v-model="fCust" aria-label="العميل"><option value="">كل العملاء</option><option v-for="o in custOpts" :key="o[0]" :value="o[0]">{{ o[1] }}</option></select>
      <select v-if="memberOpts.length" class="input" :class="{on: fMember}" v-model="fMember" aria-label="العضو"><option value="">كل الأعضاء</option><option v-for="m in memberOpts" :key="m" :value="m">{{ m }}</option></select>
      <select class="input" :class="{on: label}" v-model="label" aria-label="الحالة أو الوسم"><option value="">كل الحالات والوسوم</option><optgroup label="الحالة"><option v-for="l in cfg.statuses" :key="l.id" :value="l.id">{{ l.name }}</option></optgroup><optgroup v-if="cfg.labels.length" label="الوسوم"><option v-for="l in cfg.labels" :key="l.id" :value="l.id">{{ l.name }}</option></optgroup></select>
      <template v-if="view !== 'calendar'"><span class="tb-fsep"></span><button v-for="w in [['late','متأخرة'],['today','اليوم'],['week','هذا الأسبوع']]" :key="w[0]" type="button" class="tb-fchip" :class="w[0]" :aria-pressed="when === w[0]" @click="when = when === w[0] ? '' : w[0]">{{ w[1] }}</button></template>
      <button v-if="memberOpts.includes(me)" type="button" class="tb-fchip" :aria-pressed="mine" @click="mine = !mine">بطاقاتي</button>
      <button v-if="filtersOn" type="button" class="cl-link" @click="clearFilters">مسح التصفية</button>
      <template v-if="view === 'calendar'"><span class="spacer"></span>
        <b class="cal2-range">{{ calMode === 'week' ? date(days[0].iso) + ' — ' + date(days[6].iso, true) : monthTitle }}</b>
        <div class="cal2-seg" role="group" aria-label="العرض"><button type="button" :aria-pressed="calMode === 'week'" @click="calMode = 'week'">أسبوع</button><button type="button" :aria-pressed="calMode === 'month'" @click="calMode = 'month'">شهر</button></div>
        <div class="btn-row cal2-nav"><button type="button" class="cl-btn sm" aria-label="السابق" title="السابق" @click="calPrev">‹</button><button type="button" class="cl-btn sm" :class="{on: !weekStart && !monthOff}" @click="calToday">اليوم</button><button type="button" class="cl-btn sm" aria-label="التالي" title="التالي" @click="calNext">›</button></div></template>
    </div>
    <div v-if="s.loading && !s.data" class="ws-loading">{{ t('loading') }}</div>
    <div v-else-if="s.error" class="alert error"><span style="flex:1">{{ s.error }}</span><button class="btn sm" @click="load">{{ t('retry') }}</button></div>

    <div v-else-if="view === 'calendar'" class="tb-cal cal2">
      <div class="cal2-body"><div class="cal2-main">
        <section v-if="lateRows.length" class="cal2-late" aria-label="متأخرة"><h3>متأخرة <span class="cal2-n">{{ lateRows.length }}</span><span class="m">— اسحبها إلى يوم جديد</span></h3>
          <div class="cal2-late-row"><button v-for="c in lateRows" :key="c.name" type="button" class="cal2-ev" draggable="true" :style="{'--c': colOf(c).color}" @dragstart="dragging = c" @click="open = c.name">
            <b>{{ c.title }}</b><span class="m"><span class="cal2-st">{{ colOf(c).name }}</span><span class="cal2-late-d">{{ lateWord(c.due) }}</span><span class="tc-members"><Avatar v-for="m in c.members.slice(0, 2)" :key="m" :name="m"/></span></span></button></div></section>
        <div v-if="calMode === 'week'" class="cal2-week">
          <section v-for="d in days" :key="d.iso" class="cal2-day" :class="{today: d.today, off: d.off, over: over === d.iso}" :aria-label="d.name + ' ' + d.num"
            @dragover.prevent="over = d.iso" @dragleave="over === d.iso && (over = null)" @drop.prevent="dropDay(d.iso)">
            <div class="cal2-dh">{{ d.name }} <span class="cal2-num">{{ d.num }}</span><span v-if="d.off && !d.items.length" class="cal2-off">عطلة</span>
              <span v-else class="cal2-cnt" :class="{full: d.full}" :title="d.full ? 'تجاوز الحد اليومي (' + calCfg.day_limit + ')' : ''">{{ d.items.length }}<template v-if="d.full"> / {{ calCfg.day_limit }}</template></span></div>
            <div class="cal2-dl"><button v-for="c in d.items" :key="c.name" type="button" class="cal2-ev" draggable="true" :style="{'--c': colOf(c).color}" @dragstart="dragging = c" @click="open = c.name">
              <b>{{ c.title }}</b><span class="m"><span class="cal2-st">{{ colOf(c).name }}</span>{{ c.due_time || '' }} {{ c.customer_name }}<span class="tc-members"><Avatar v-for="m in c.members.slice(0, 2)" :key="m" :name="m"/></span></span></button></div>
          </section></div>
        <div v-else class="cal2-month">
          <div v-for="h in calHead" :key="h" class="cal2-mh">{{ h }}</div>
          <div v-for="d in monthDays" :key="d.iso" class="cal2-mc" :class="{out: d.out, off: d.off, today: d.today, over: over === d.iso}" role="button" tabindex="0" :aria-label="d.name + ' ' + d.num"
            @click="openWeek(d.iso)" @keydown.enter="openWeek(d.iso)" @dragover.prevent="over = d.iso" @dragleave="over === d.iso && (over = null)" @drop.prevent="dropDay(d.iso)">
            <span class="cal2-mn">{{ d.num }}<span v-if="d.items.length" class="cal2-cnt" :class="{full: d.full}">{{ d.items.length }}</span></span>
            <span v-for="c in d.items.slice(0, 3)" :key="c.name" class="cal2-pill" draggable="true" :style="{'--c': colOf(c).color}" @dragstart.stop="dragging = c" @click.stop="open = c.name">{{ c.title }}</span>
            <span v-if="d.items.length > 3" class="cal2-more">+ {{ d.items.length - 3 }} المزيد</span></div></div>
        <span class="m cal2-hint">اسحب بطاقة إلى يوم لتغيير موعدها. الرقم في رأس اليوم عدد الطلبات، ويصبح برتقاليًا إذا تجاوز الحد اليومي ({{ calCfg.day_limit }}).</span>
      </div>
      <aside class="cal2-side" @dragover.prevent @drop.prevent="dragging = null; over = null"><h3>بلا موعد <span class="cal2-n">{{ undated.length }}</span></h3>
        <div class="cal2-dl"><button v-for="c in undated" :key="c.name" type="button" class="cal2-ev" draggable="true" :style="{'--c': colOf(c).color}" @dragstart="dragging = c" @click="open = c.name">
          <b>{{ c.title }}</b><span class="m"><span class="cal2-st">{{ colOf(c).name }}</span>{{ c.customer_name }}</span></button>
          <span v-if="!undated.length" class="m">كل الطلبات لها موعد.</span></div>
        <span v-if="undated.length" class="m">اسحب إلى يوم لتعطيه موعدًا.</span>
        <div class="cal2-legend"><span v-for="c in (cfg.columns || []).filter((x) => !x.deliver && !x.hidden)" :key="c.id"><i :style="{background: c.color}"></i>{{ c.name }}</span></div></aside></div>
    </div>

    <div v-else class="tb-cols">
      <section v-for="c in cols" :key="c.id" class="tb-col" :class="{over: over === c.id, 'col-moving': colDrag === c.id, 'col-target': colDrag && colOver === c.id && colDrag !== c.id, 'col-after': colDrag && colOver === c.id && colIdx(colDrag) < colIdx(c.id), deliver: c.deliver, full: c.limit && c.items.length > c.limit}" :aria-label="c.name" :style="{'--cc': c.color}"
        @dragover.prevent="colDrag ? (colOver = c.id) : dragging && (over = c.id, before = null)" @dragleave="over === c.id && !before && (over = null)" @drop.prevent="colDrag ? colDrop(c) : drop(c.id)">
        <h2 class="tb-ch" :draggable="!!s.data.manager" :class="{'col-drag': colDrag === c.id, 'col-drop': colOver === c.id && colDrag && colDrag !== c.id}"
          @dragstart.stop="colDragStart(c, $event)" @dragend="colDrag = null; colOver = null" ><i :style="{background: c.color}"></i>{{ c.name }}<span v-if="c.deliver" title="عمود التسليم" class="cb-truck"><Icon name="truck" :size="15"/></span>
          <span class="bd-n" :class="{over: c.limit && c.items.length > c.limit}">{{ c.items.length }}<template v-if="c.limit"> / {{ c.limit }}<template v-if="c.items.length > c.limit"> !</template></template></span>
          <button type="button" class="tb-cdots" :aria-label="'خيارات العمود ' + c.name" :aria-expanded="colMenu && colMenu.col.id === c.id" @click.stop="openColMenu(c, $event)"><Icon name="more" :size="16"/></button></h2>
        <div v-if="(c.sum && !s.data.worker) || c.late || c.unpriced || colSort[c.id]" class="tb-cstat">
          <template v-if="!s.data.worker && c.items.length"><template v-if="c.deliver"><span v-if="c.owed > 0.005" class="tb-owed" title="ما سُلّم ولم يُدفع: دين على العملاء">لم يُحصَّل <b class="num">{{ money(c.owed) }}</b></span><span v-else-if="c.sum" class="tb-ok">✓ محصّل بالكامل</span></template>
            <template v-else-if="c.sum"><span class="num" title="قيمة الأعمال الجارية في هذا العمود"><b>{{ money(c.sum) }}</b></span><span v-if="c.paid > 0.005" class="m" title="ما دفعه العملاء مقدمًا">مُسبَّق {{ money(c.paid) }}</span></template></template>
          <button v-if="c.unpriced && !s.data.worker" type="button" class="tb-cchip warn" title="طلبات بلا سعر: اضغط لإبرازها" @click="flashCards(c.id, 'unpriced')">{{ c.unpriced }} بلا سعر</button>
          <button v-if="c.late" type="button" class="tb-cchip late" title="اضغط لإبراز المتأخرة" @click="flashCards(c.id, 'late')"><Icon name="clock" :size="12"/>{{ c.late }} متأخرة</button>
          <span v-if="colSort[c.id]" class="m">مرتّبة {{ {due: 'بالموعد', created: 'بالأحدث', amount: 'بالمبلغ'}[colSort[c.id]] }}</span></div>
        <TransitionGroup name="tcm" tag="div" class="tb-list">
          <BoardCard v-for="card in c.items" :key="card.name" :c="card" :labels="labels" :statuses="cfg.statuses" :busy="busy === card.name" :drop-before="before === card.name"
            :class="{'tc-flash': flash && flash.col === c.id && (flash.kind === 'late' ? isLate(card) : card.price_pending)}"
            @open="open = card.name" @drag="dragging = $event" @dropon="dropOn" @menu="openMenu" @status="openStatus" @hover="hovered = $event"/>
        </TransitionGroup>
        <div v-if="dragging && over === c.id && !before && dragging.column !== c.id" class="tb-ph" aria-hidden="true"></div>
        <button v-if="c.deliver && paidCount(c)" type="button" class="tb-addbtn" @click="archivePaid(c.id)">أرشفة المدفوع كله ({{ paidCount(c) }})</button>
        <template v-if="!c.deliver">
          <form v-if="adding === c.id" class="tb-add" @submit.prevent="addCard(c.id)">
            <textarea :id="'add-' + c.id" class="input tb-addin" v-model="newTitle" rows="1" placeholder="عنوان البطاقة…" aria-label="عنوان البطاقة" @keydown.enter.prevent="addCard(c.id)" @keydown.esc="adding = null"></textarea>
            <div class="row" style="gap:6px"><button type="submit" class="btn primary sm">إضافة</button><button type="button" class="btn ghost sm" @click="adding = null">إلغاء</button></div></form>
          <button v-else-if="state.boot.can.order" type="button" class="tb-addbtn" @click="startAdd(c.id)">+ إضافة بطاقة</button>
        </template>
      </section>
      <div v-if="s.data && s.data.manager" class="tb-newcol">
        <form v-if="addingCol" @submit.prevent="addColumn"><input id="new-col" class="input" v-model="newCol" placeholder="اسم العمود" aria-label="اسم العمود الجديد" @keydown.esc="addingCol = false">
          <div class="row" style="gap:6px;margin-top:8px"><button type="submit" class="btn primary sm">إضافة</button><button type="button" class="btn ghost sm" @click="addingCol = false">إلغاء</button></div></form>
        <button v-else type="button" class="tb-newcol-btn" @click="startCol">+ إضافة عمود</button>
      </div>
    </div>

    <div v-if="menu" class="tm-pop tb-menu" :style="{top: menu.top + 'px', left: menu.left + 'px'}" @click.stop>
      <template v-if="menu.view === 'status'"><b>الحالات</b><StatusMenu :statuses="cfg.statuses || []" :current="menu.c.status" @pick="menuStatus"/>
        <hr class="tm2-hr"><button type="button" class="tm-pop-row tb-back" @click="menuView(null)">‹ رجوع</button></template>
      <template v-else-if="menu.view === 'members'"><b>الأعضاء</b>
        <button v-for="p in team" :key="p" type="button" class="tm-pop-row" :aria-pressed="(menu.c.members || []).includes(p)" @click="toggleMember(menu.c, p)"><Avatar :name="p" :size="22"/><span class="ellipsis" style="flex:1">{{ p }}</span><b v-if="(menu.c.members || []).includes(p)" class="tb-ok">✓</b></button>
        <span v-if="!team.length" class="m tm3-hint">أضف أسماء الفريق من الإعدادات أولًا.</span>
        <hr class="tm2-hr"><button type="button" class="tm-pop-row tb-back" @click="menuView(null)">‹ رجوع</button></template>
      <template v-else-if="menu.view === 'due'"><b>الموعد</b>
        <div class="tb-due-q"><button type="button" class="cl-btn sm" @click="menuDue(isoIn(0))">اليوم</button><button type="button" class="cl-btn sm" @click="menuDue(isoIn(1))">غدًا</button><button type="button" class="cl-btn sm" @click="menuDue(isoIn(3))">بعد 3 أيام</button><button type="button" class="cl-btn sm" @click="menuDue(null)">بلا موعد</button></div>
        <input type="date" class="input tb-due-in" :value="menu.c.due || ''" aria-label="تاريخ الموعد" @change="menuDue($event.target.value)">
        <hr class="tm2-hr"><button type="button" class="tm-pop-row tb-back" @click="menuView(null)">‹ رجوع</button></template>
      <template v-else>
      <b class="ellipsis">{{ menu.c.title }}</b>
      <button type="button" class="tm-pop-row" @click="open = menu.c.name; menu = null"><Icon name="ext" :size="15"/>فتح البطاقة</button>
      <button v-if="state.boot.can.order" type="button" class="tm-pop-row" @click="state.sheet = {type: 'order', edit: menu.c.name}; menu = null"><Icon name="file" :size="15"/>تعديل الطلب</button>
      <button v-if="(cfg.statuses || []).length" type="button" class="tm-pop-row tb-new" @click="menuView('status')"><Icon name="tag" :size="15"/>الحالات<span class="tb-ch">‹</span></button>
      <button type="button" class="tm-pop-row tb-new" @click="menuView('members')"><Icon name="users" :size="15"/>الأعضاء<span class="tb-ch">‹</span></button>
      <button type="button" class="tm-pop-row tb-new" @click="menuView('due')"><Icon name="clock" :size="15"/>الموعد<span class="tb-ch">‹</span></button>
      <hr class="tm2-hr">
      <button type="button" class="tm-pop-row" @click="act('photo')"><Icon name="image" :size="15"/>تصوير وإرفاق</button>
      <button type="button" class="tm-pop-row" @click="act('copy')"><Icon name="file" :size="15"/>نسخ البطاقة</button>
      <button v-if="!s.data.worker" type="button" class="tm-pop-row" @click="act('template')"><Icon name="grid" :size="15"/>حفظ كقالب</button>
      <button type="button" class="tm-pop-row" @click="act('archive')"><Icon name="box" :size="15"/>أرشفة</button>
      <hr class="tm2-hr"><b>نقل إلى</b>
      <div class="tb-moves"><button v-for="col in cfg.columns.filter(x => x.id !== menu.c.column)" :key="col.id" type="button" class="tm-pop-row" @click="act('move', col.id)"><i class="st-sw" :style="{background: col.color}"></i><span class="ellipsis">{{ col.name }}</span></button></div>
      <template v-if="state.boot.can.order"><hr class="tm2-hr">
        <button v-if="!(menu.c.paid > 0.005) && !(menu.c.per_delivered > 0)" type="button" class="tm-pop-row tm3-danger" @click="act('delete')"><Icon name="trash" :size="15"/>حذف البطاقة</button>
        <span v-else class="m tm3-hint">عليها دفعة أو تسليم: أرشفها بدل الحذف.</span></template>
      </template>
    </div>
    <div v-if="delAsk" class="overlay tm3-confirm tb-confirm" role="alertdialog" aria-modal="true" aria-labelledby="bdel-h" @click.self="delAsk = null">
      <div class="tm3-cbox"><b id="bdel-h">حذف البطاقة نهائيًا؟</b>
        <p>«{{ delAsk.title }}» وملفاتها المرفقة في البرنامج تُحذف ولا يمكن استرجاعها. مجلدها في D يبقى كما هو.</p>
        <div class="row" style="justify-content:flex-end;gap:8px"><button type="button" class="cl-btn" @click="delAsk = null">إلغاء</button>
          <button type="button" class="cl-btn tm3-del" :disabled="delBusy" @click="doDelete">{{ delBusy ? 'جارٍ الحذف…' : 'حذف نهائي' }}</button></div></div>
    </div>
    <div v-if="colMenu" class="tm-pop tb-menu tb-colmenu" :style="{top: colMenu.top + 'px', left: colMenu.left + 'px'}" @click.stop>
      <b class="ellipsis">خيارات «{{ colMenu.col.name }}»</b>
      <template v-if="s.data.manager">
        <form class="tb-cm-name" @submit.prevent="renameCol"><input class="input" v-model="colName" aria-label="اسم العمود" maxlength="60"><button type="submit" class="cl-btn" :disabled="!colName.trim() || colName.trim() === colMenu.col.name">حفظ</button></form>
        <span class="m tb-cm-h">اللون</span>
        <div class="tb-cm-sw"><button v-for="k in BOARD_COLORS" :key="k" type="button" :style="{background: k}" :aria-pressed="colMenu.col.color === k" :aria-label="'لون ' + k" @click="setColColor(k)"></button></div>
        <hr class="tm2-hr"></template>
      <span class="m tb-cm-h">ترتيب البطاقات</span>
      <button v-for="o in [['','الترتيب اليدوي'],['due','حسب الموعد'],['created','حسب تاريخ الإنشاء'],['amount','حسب المبلغ']]" :key="o[0]" type="button" class="tm-pop-row" :aria-pressed="(colSort[colMenu.col.id] || '') === o[0]" @click="sortCol(colMenu.col.id, o[0])">{{ o[1] }}<span v-if="(colSort[colMenu.col.id] || '') === o[0]" class="tb-cm-on">✓</span></button>
      <template v-if="state.boot.can.order && colMenu.col.items.length"><hr class="tm2-hr">
        <button type="button" class="tm-pop-row" :aria-expanded="colMove" @click="colMove = !colMove">نقل كل البطاقات ({{ colMenu.col.items.length }}) إلى…</button>
        <template v-if="colMove"><button v-for="to in cfg.columns.filter(x => x.id !== colMenu.col.id)" :key="to.id" type="button" class="tm-pop-row tb-cm-sub" @click="moveAll(colMenu.col, to)"><i class="st-sw" :style="{background: to.color}"></i>{{ to.name }}</button></template></template>
      <template v-if="s.data.manager"><hr class="tm2-hr"><button type="button" class="tm-pop-row" @click="hideCol(true, colMenu.col.id)">إخفاء العمود</button></template>
    </div>
    <div v-if="tplAsk" class="overlay tm3-confirm tb-confirm" role="dialog" aria-modal="true" aria-labelledby="tpl-h" @click.self="tplAsk = null">
      <form class="tm3-cbox" @submit.prevent="saveTpl"><b id="tpl-h">حفظ البطاقة كقالب</b>
        <p>يُحفظ العنوان والبنود وقائمة المهام. تختاره لاحقًا من نافذة «طلب جديد».</p>
        <label class="m" for="tpl-name">اسم القالب</label><input id="tpl-name" class="input" v-model="tplName" maxlength="60" style="margin:4px 0 14px">
        <div class="row" style="justify-content:flex-end;gap:8px"><button type="button" class="cl-btn" @click="tplAsk = null">إلغاء</button>
          <button type="submit" class="cl-btn primary" :disabled="tplBusy || !tplName.trim()">{{ tplBusy ? 'جارٍ الحفظ…' : 'حفظ القالب' }}</button></div></form>
    </div>
    <div v-if="stMenu" class="tm-pop tb-menu" :style="{top: stMenu.top + 'px', left: stMenu.left + 'px'}" @click.stop>
      <StatusMenu :statuses="cfg.statuses || []" :current="stMenu.c.status" @pick="pickStatus"/>
    </div>
    <input ref="photoInput" type="file" accept="image/*" capture="environment" class="sr-only" tabindex="-1" aria-hidden="true" @change="onPhoto">

    <div v-if="archive" class="overlay tm-overlay" @click.self="archive = null">
      <div class="tm tb-archive" role="dialog" aria-modal="true" aria-label="الأرشيف">
        <div class="bd-ph" style="padding:20px 22px 0"><h2>الأرشيف</h2><button type="button" class="btn ghost icon-btn" aria-label="إغلاق" @click="archive = null"><Icon name="x"/></button></div>
        <div style="padding:16px 22px 22px;display:flex;flex-direction:column;gap:8px">
          <div v-if="!archive.length" class="m">لا بطاقات مؤرشفة.</div>
          <div v-for="a in archive" :key="a.name" class="bs-row"><span style="flex:1;min-width:0"><b>{{ a.title || a.name }}</b><span class="m">{{ a.customer_name }} · {{ ago(a.modified) }}</span></span>
            <button type="button" class="btn sm" @click="open = a.name">فتح</button><button type="button" class="btn sm" @click="restore(a.name)">استرجاع</button></div>
        </div>
      </div>
    </div>

    <BoardPanel v-if="panel" :mode="panel.mode" :preset="panel.preset" :columns="cfg?.columns" @close="closePanel" @saved="saved"/>
  </div>`,
};

// Large image viewer: the customer's work, one image at a time, with arrows and keyboard.
const ImageViewer = {
  props: ["list", "start"], emits: ["close"], components: { Icon },
  setup(props, { emit }) {
    const i = ref(props.start || 0);
    const cur = computed(() => props.list[i.value]);
    const step = (n) => { i.value = (i.value + n + props.list.length) % props.list.length; };
    const onKey = (e) => { if (e.key === "Escape") emit("close"); else if (e.key === "ArrowLeft") step(1); else if (e.key === "ArrowRight") step(-1); };
    onMounted(() => { window.addEventListener("keydown", onKey); nextTick(() => document.querySelector(".iv-x")?.focus()); });
    onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
    const openCard = () => { emit("close"); go("/?card=" + encodeURIComponent(cur.value.o.name)); };
    return { i, cur, step, openCard, folderLink, date };
  },
  template: `
  <div class="overlay iv" role="dialog" aria-modal="true" aria-label="عارض الصور" @click.self="$emit('close')">
    <button type="button" class="cl-btn icon iv-x" aria-label="إغلاق" @click="$emit('close')"><Icon name="x" :size="20"/></button>
    <button v-if="list.length > 1" type="button" class="cl-btn icon iv-nav prev" aria-label="الصورة السابقة" @click="step(-1)"><Icon name="chev" :size="20"/></button>
    <figure class="iv-fig">
      <img :src="cur.url" :alt="cur.o.atelier_subject || cur.name">
      <figcaption>
        <div style="min-width:0"><b class="ellipsis" style="display:block">{{ cur.o.atelier_subject || cur.o.name }}</b>
          <span class="m">{{ date(cur.o.transaction_date) }} · {{ cur.name }} · {{ i + 1 }} من {{ list.length }}</span></div>
        <span class="spacer"></span>
        <a class="cl-btn sm" :href="cur.url" download>تحميل</a>
        <a v-if="cur.o.folder" class="cl-btn sm" :href="folderLink(cur.o.folder)">افتح المجلد</a>
        <button type="button" class="cl-btn sm primary" @click="openCard">فتح البطاقة</button>
      </figcaption>
    </figure>
    <button v-if="list.length > 1" type="button" class="cl-btn icon iv-nav next" aria-label="الصورة التالية" @click="step(1)"><Icon name="back" :size="20"/></button>
  </div>`,
};

const SimpleCustomers = {
  props: ["openId"], components: { Icon, Avatar, ImageViewer },
  setup(props) {
    const { s, load } = useLoad(() => call("customers2"));
    onMounted(load);
    const sel = ref(props.openId || state.query.get("c") || null), d = ref(null), err = ref(null), tab = ref("orders");
    watch(() => state.rev, () => { load(); if (sel.value) open(sel.value, true); });
    const q = ref("");
    // filters: applied values and the draft edited in the filter panel
    const EMPTY = { type: "all", status: "all", tag: "", sort: "last" };
    const f = reactive({ ...EMPTY }), draft = reactive({ ...EMPTY }), fopen = ref(false), more = ref(false);
    const openFilters = () => { Object.assign(draft, f); fopen.value = !fopen.value; more.value = false; };
    const applyFilters = () => { Object.assign(f, draft); fopen.value = false; };
    const resetFilters = () => { Object.assign(draft, EMPTY); Object.assign(f, EMPTY); fopen.value = false; };
    const TYPES = [["all", "الكل"], ["company", "مؤسسات"], ["person", "أفراد"]];
    const STATUSES = [["all", "الكل"], ["debt", "عليهم دين"], ["away", "غابوا عنك"], ["off", "موقوفون"]];
    const SORTS = [["last", "آخر طلب"], ["orders", "الأكثر طلبًا"], ["debt", "الأكثر دينًا"], ["name", "الاسم"]];
    const everyone = computed(() => s.data?.rows || []);
    const all = computed(() => everyone.value.filter((c) => !c.disabled));
    const ctags = computed(() => Object.fromEntries((s.data?.customer_tags || []).map((x) => [x.id, x])));
    const owes = (c) => (c.balance || 0) > 0.005;
    const sorter = { last: (a, b) => String(b.last_order || "").localeCompare(String(a.last_order || "")), orders: (a, b) => b.orders - a.orders || b.sales - a.sales,
      debt: (a, b) => (b.balance || 0) - (a.balance || 0), name: (a, b) => a.customer_name.localeCompare(b.customer_name, "ar") };
    const rows = computed(() => (f.status === "off" ? everyone.value.filter((c) => c.disabled) : all.value)
      .filter((c) => f.type === "all" || (f.type === "company") === (c.customer_type === "Company"))
      .filter((c) => f.status !== "debt" || owes(c)).filter((c) => f.status !== "away" || c.away)
      .filter((c) => !f.tag || (c.tags || []).includes(f.tag))
      .filter((c) => !q.value || (c.customer_name + " " + (c.mobile_no || "")).toLowerCase().includes(q.value.trim().toLowerCase()))
      .sort((a, b) => b.vip - a.vip || sorter[f.sort](a, b)));
    const active = computed(() => {
      const l = [];
      if (f.type !== "all") l.push({ k: "type", t: TYPES.find((x) => x[0] === f.type)[1] });
      if (f.status !== "all") l.push({ k: "status", t: STATUSES.find((x) => x[0] === f.status)[1] });
      if (f.tag && ctags.value[f.tag]) l.push({ k: "tag", t: ctags.value[f.tag].name });
      return l;
    });
    const clearOne = (k) => (f[k] = EMPTY[k]);
    const kpi = computed(() => {
      const debt = all.value.filter(owes), top = [...all.value].sort(sorter.orders)[0];
      return { total: all.value.length, fresh: all.value.filter((c) => c.new).length, debt: debt.reduce((a, c) => a + c.balance, 0), debtN: debt.length,
        late: all.value.filter((c) => c.overdue_days > 0).length, top, away: all.value.filter((c) => c.away).length };
    });
    const quick = (k) => { Object.assign(f, { ...EMPTY, status: k }); };
    async function open(name, keep) {
      sel.value = name; err.value = null; if (!keep) { tab.value = "log"; d.value = null; jq.value = ""; hview.value = "list"; Object.keys(openYears).forEach((k) => delete openYears[k]); window.scrollTo(0, 0); }
      try { d.value = await call("customer2", { name }); } catch (e) { err.value = e.message; }
    }
    const bal = (v) => (v > 0.005 ? { text: money(v), cls: "bad" } : v < -0.005 ? { text: "له " + money(-v), cls: "ok" } : { text: "خالص", cls: "" });
    const lastWord = (iso) => { if (!iso) return "—"; const n = -daysFromToday(iso); return n <= 0 ? "اليوم" : n === 1 ? "أمس" : n === 2 ? "منذ يومين" : n < 30 ? `منذ ${n} أيام` : date(iso); };
    const csv = (name, head, lines) => {
      const text = "﻿" + [head, ...lines].map((r) => r.map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(",")).join("\n");
      const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" })); a.download = name; a.click();
    };
    const exportList = () => { more.value = false; csv("العملاء.csv", ["العميل", "النوع", "الهاتف", "الطلبات", "آخر طلب", "الرصيد"],
      rows.value.map((c) => [c.customer_name, c.customer_type === "Company" ? "مؤسسة" : "فرد", c.mobile_no || "", c.orders || 0, c.last_order || "", (c.balance || 0).toFixed(2)])); };
    const newOrderFor = (c) => { state.sheet = { type: "order", customer: { name: c.name, customer_name: c.customer_name, customer_type: c.customer_type, mobile_no: c.mobile_no } }; };
    const pay = () => (state.sheet = { type: "payment", customer: { name: d.value.name, customer_name: d.value.customer_name } });
    // profile
    const pmenu = ref(false), merging = ref(null), editNote = ref(false), note = ref(""), remind = ref(null);
    const closeMenus = () => { pmenu.value = false; more.value = false; stOpen.value = false; fmenu.value = null; };
    onMounted(() => window.addEventListener("click", closeMenus));
    onBeforeUnmount(() => window.removeEventListener("click", closeMenus));
    const startNote = () => { note.value = d.value.note; editNote.value = true; };
    const saveExtra = async (args) => { try { d.value = await call("set_customer_extra", { name: d.value.name, ...args }, true); editNote.value = false; load(); } catch (e) { err.value = e.message; } };
    const startRemind = () => { const u = d.value.oldest_unpaid;
      remind.value = `السلام عليكم ${d.value.customer_name}،\nنذكّركم بأن المبلغ المتبقي هو ${fig(d.value.balance)} دج` + (u ? ` عن «${u.subject || u.name}» (${date(u.posting_date)})` : "") + `.\nشكرًا لثقتكم — ${state.boot.company_label || ""}`; };
    const sendRemind = () => { const l = waLink(d.value.mobile_no); if (l) window.open(l + "?text=" + encodeURIComponent(remind.value), "_blank", "noopener"); remind.value = null; };
    const toggleDisabled = async () => { pmenu.value = false;
      try { await call("set_customer_disabled", { name: d.value.name, disabled: d.value.disabled ? 0 : 1 }, true); toast(d.value.disabled ? "أُعيد تفعيل العميل" : "أُوقف العميل"); await open(d.value.name, true); load(); } catch (e) { err.value = e.message; } };
    const doMerge = async () => { const target = everyone.value.find((c) => c.name === merging.value);
      if (!target || !confirm(`دمج «${d.value.customer_name}» في «${target.customer_name}»؟ لا يمكن التراجع.`)) return;
      try { await call("merge_customers", { source: d.value.name, target: target.name }, true); toast("تم الدمج"); merging.value = null; await load(); open(target.name); } catch (e) { err.value = e.message; } };
    const exportOrders = () => { pmenu.value = false; csv(`طلبات ${d.value.customer_name}.csv`, ["الطلب", "الرقم", "التاريخ", "المبلغ", "دفع"],
      d.value.orders.map((o) => [o.atelier_subject || o.name, o.name, o.transaction_date, o.grand_total.toFixed(2), o.paid.toFixed(2)])); };
    const reorder = async (o) => { try { const n = await call("reorder_card", { name: o.name }, true); toast("أُنشئت بطاقة جديدة في اللوحة"); go("/?card=" + encodeURIComponent(n)); } catch (e) { toast(e.message, "error"); } };
    const uploading = ref(false);
    const copyText = async (t) => { try { await navigator.clipboard.writeText(t); toast("نُسخ مسار المجلد — الصقه في مستكشف الملفات"); } catch { /* selectable */ } };
    const onFile = async (e) => { const list = [...(e.target.files || [])]; if (!list.length) return; uploading.value = true;
      try { for (const x of list) await uploadPrivate(isImg({ file_name: x.name }) ? await shrinkImage(x) : x, "Customer", d.value.name); toast("رُفع الملف"); await open(d.value.name, true); }
      catch (x) { err.value = x.message; } finally { uploading.value = false; e.target.value = ""; } };
    const LOG_KINDS = [["call", "اتصال"], ["whatsapp", "واتساب"], ["visit", "زيارة"], ["promise", "وعد بالدفع"], ["note", "ملاحظة"]];
    const logKind = ref("call"), logText = ref("");
    const addLog = async () => { try { d.value = await call("add_customer_log", { name: d.value.name, kind: logKind.value, text: logText.value }, true); logText.value = ""; } catch (e) { err.value = e.message; } };
    const months6 = computed(() => { const out = [], base = parseDate(todayISO());
      for (let i = 5; i >= 0; i--) { const m = new Date(base.getFullYear(), base.getMonth() - i, 1), key = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}`;
        out.push({ key, label: new Intl.DateTimeFormat("ar", { month: "short" }).format(m), total: (d.value?.months || []).find((x) => x.m === key)?.total || 0 }); } return out; });
    const maxMonth = computed(() => Math.max(1, ...months6.value.map((m) => m.total)));
    const stTo = ref(todayISO()), stFrom = ref(isoOf(new Date(parseDate(todayISO()).getFullYear(), parseDate(todayISO()).getMonth() - 3, 1)));
    const statementUrl = computed(() => (d.value ? `/api/method/atelier.api.statement_pdf?name=${encodeURIComponent(d.value.name)}&from_date=${stFrom.value}&to_date=${stTo.value}` : "#"));
    const sendStatement = () => { window.open(statementUrl.value, "_blank", "noopener");
      const text = `السلام عليكم ${d.value.customer_name}،\nنرسل لكم كشف حسابكم من ${date(stFrom.value)} إلى ${date(stTo.value)}.\nالرصيد الحالي: ${fig(Math.max(0, d.value.balance))} دج.\n${state.boot.company_label || ""}`;
      window.open(waLink(d.value.mobile_no) + "?text=" + encodeURIComponent(text), "_blank", "noopener"); };
    const STATE_DOT = (o) => (o.archived ? "#98A2B3" : o.per_delivered >= 100 ? "#12B76A" : o.docstatus === 0 ? "#F79009" : "#2E90FA");
    const owesNow = computed(() => d.value && d.value.balance > 0.005);
    const TABS = computed(() => [["log", "التواصل"], ["files", "الملفات"], ...(d.value?.balance !== undefined ? [["account", "كشف الحساب"]] : []), ["stats", "الإحصاء"], ["data", "البيانات"]]);
    // list: one-click filters
    const quickF = (type, status) => Object.assign(f, { ...EMPTY, type: type || "all", status: status || "all" });
    const chips = computed(() => [
      { k: "all", t: "الكل", n: all.value.length, on: f.type === "all" && f.status === "all", run: () => quickF() },
      { k: "debt", t: "عليهم دين", n: all.value.filter(owes).length, on: f.status === "debt", run: () => quickF("all", "debt") },
      { k: "company", t: "مؤسسات", n: all.value.filter((c) => c.customer_type === "Company").length, on: f.type === "company" && f.status === "all", run: () => quickF("company") },
      { k: "person", t: "أفراد", n: all.value.filter((c) => c.customer_type !== "Company").length, on: f.type === "person" && f.status === "all", run: () => quickF("person") },
      { k: "away", t: "غابوا عنا", n: kpi.value.away, on: f.status === "away", run: () => quickF("all", "away") },
    ]);
    const closeCustomer = () => { sel.value = null; d.value = null; nextTick(() => window.scrollTo(0, 0)); };
    // the customer's work, by year then month
    const jq = ref(""), hview = ref("list"), openYears = reactive({}), viewer = ref(null), jf = ref("all"), stOpen = ref(false), logAll = ref(false), filesAll = ref(false);
    const isOpenJob = (o) => (o.per_delivered || 0) < 100 && !o.archived && o.status !== "Closed";
    const JF = { all: () => true, open: isOpenJob, unpaid: (o) => !o.price_pending && o.grand_total - (o.paid || 0) > 0.005,
      unbilled: (o) => !o.price_pending && (o.per_billed || 0) < 100 && o.docstatus < 2 && o.status !== "Closed" };
    const jobChips = computed(() => [["all", "الكل"], ["open", "جارية"], ["unpaid", "غير مدفوعة"], ["unbilled", "بلا فاتورة"]]
      .map(([k, t]) => ({ k, t, n: (d.value?.orders || []).filter(JF[k]).length })).filter((c) => c.k === "all" || c.n));
    const jobs = computed(() => { const n = jq.value.trim().toLowerCase();
      return (d.value?.orders || []).filter(JF[jf.value] || JF.all).filter((o) => !n || String(o.atelier_subject || o.name).toLowerCase().includes(n) || String(o.name).toLowerCase().includes(n)); });
    const imagesOf = (o) => (d.value?.card_files || []).filter((x) => x.attached_to_name === o.name && isImg(x));
    const thumbOf = (o) => o.cover || imagesOf(o)[0]?.file_url || null;
    const monthName = new Intl.DateTimeFormat("ar", { month: "long" });
    const years = computed(() => {
      const by = {};
      for (const o of jobs.value) {
        const dt = parseDate(String(o.transaction_date).slice(0, 10)), y = dt.getFullYear(), m = dt.getMonth();
        const Y = (by[y] ||= { y, total: 0, n: 0, months: {} });
        Y.total += o.price_pending ? 0 : (o.grand_total || 0); Y.n++;
        (Y.months[m] ||= { m, label: monthName.format(dt), items: [] }).items.push(o);
      }
      return Object.values(by).sort((a, b) => b.y - a.y).map((Y) => ({ ...Y, months: Object.values(Y.months).sort((a, b) => b.m - a.m) }));
    });
    const yearOpen = (y, i) => (openYears[y] !== undefined ? openYears[y] : i === 0 || !!jq.value.trim() || jf.value !== "all");
    const stOf = (o) => (d.value?.statuses || []).filter((x) => (o.status || []).includes(x.id));
    const payWord = (o) => (o.price_pending ? { t: "بلا سعر", c: "warn" } : o.grand_total - o.paid > 0.005 ? { t: "باقي " + money(o.grand_total - o.paid), c: "bad" } : { t: "مدفوع", c: "ok" });
    const gallery = computed(() => jobs.value.flatMap((o) => { const im = imagesOf(o); return im.length ? im.map((x) => ({ url: x.file_url, name: x.file_name, o })) : [{ url: null, name: "", o }]; }));
    const showImages = (o, url) => { const list = gallery.value.filter((g) => g.url); const i = list.findIndex((g) => (url ? g.url === url : g.o.name === o.name));
      if (i >= 0) viewer.value = { list, i }; else go("/?card=" + encodeURIComponent(o.name)); };
    const openCard = (o) => go("/?card=" + encodeURIComponent(o.name));
    // gallery for the salesperson: delivered work, what it was and what it cost
    const gGroup = ref("all"), gSort = ref("new"), gAll = ref(true);
    const groupOf = (o) => (o.lines || [])[0]?.group || "أخرى";
    const galleryJobs = computed(() => jobs.value.filter((o) => gAll.value || (o.per_delivered || 0) >= 100));
    const gGroups = computed(() => { const c = {}; for (const o of galleryJobs.value) c[groupOf(o)] = (c[groupOf(o)] || 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1]); });
    const gallery2 = computed(() => { const list = galleryJobs.value.filter((o) => gGroup.value === "all" || groupOf(o) === gGroup.value);
      return gSort.value === "price" ? [...list].sort((a, b) => (b.grand_total || 0) - (a.grand_total || 0)) : list; });
    const specOf = (o) => { const l = (o.lines || [])[0]; if (!l) return o.size || "";
      return [l.size || o.size, l.qty ? (Number.isInteger(l.qty) ? l.qty.toLocaleString("en-US") : fig(l.qty)) + " " + (l.uom || "") : "", (o.lines.length > 1 ? "و" + (o.lines.length - 1 === 1 ? "بند آخر" : (o.lines.length - 1) + " بنود أخرى") : "")].filter(Boolean).join(" · "); };
    const unitOf = (o) => { const l = (o.lines || [])[0]; return l && l.rate && o.lines.length === 1 && l.qty > 1 ? fig(l.rate) + " / " + (/m|م/i.test(l.uom || "") ? (l.uom || "") : "وحدة") : ""; };
    const coverOf = (o) => o.cover || (isImg({ file_name: o.final || "" }) ? o.final : null) || imagesOf(o)[0]?.file_url || null;
    // files tab: grouped by job, identity first, kind = final / source / reference (guessed, can be corrected), old versions folded
    const fk = ref("all"), fq = ref(""), fsel = ref(null), verOpen = reactive({});
    const FILE_KINDS = [["final", "نهائي للطباعة"], ["source", "مصدر التصميم"], ["ref", "مراجع وصور"], ["identity", "الهوية"]];
    const SRC_EXT = ["ai", "psd", "indd", "cdr", "eps", "afdesign", "sketch", "fig", "svg", "tif", "tiff"];
    const extOf = (x) => (String(x.file_name || "").split(".").pop() || "").toLowerCase();
    const orderOf = computed(() => Object.fromEntries((d.value?.orders || []).map((o) => [o.name, o])));
    const kindOf = (x) => { if (x.atelier_kind) return x.atelier_kind; if (x.attached_to_doctype === "Customer") return "identity";
      const o = orderOf.value[x.attached_to_name], e = extOf(x); if (o && o.final === x.file_url) return "final";
      return SRC_EXT.includes(e) ? "source" : e === "pdf" ? "final" : "ref"; };
    const verKey = (x) => String(x.file_name || "").toLowerCase().replace(/[-_ .]?v\d+(?=\.[^.]+$)/, "").replace(/\s*\(\d+\)(?=\.[^.]+$)/, "");
    const verOf = (x) => (String(x.file_name || "").match(/v(\d+)\.[^.]+$/i) || [])[1];
    const kindCount = computed(() => { const c = { all: (d.value?.card_files || []).length }; for (const x of d.value?.card_files || []) { const k = kindOf(x); c[k] = (c[k] || 0) + 1; } return c; });
    const fileGroups = computed(() => {
      const n = fq.value.trim().toLowerCase(), by = new Map();
      const id = { key: "__id", title: "الهوية", sub: "الشعار والألوان والخطوط — تُستعمل في كل الأعمال", folder: d.value?.folder, all: [] };
      by.set("__id", id);
      for (const x of d.value?.card_files || []) {
        const k = kindOf(x), g = k === "identity" ? "__id" : x.attached_to_name;
        if (!by.has(g)) { const o = orderOf.value[g]; by.set(g, { key: g, title: o?.atelier_subject || x.atelier_subject || g, sub: o ? date(o.transaction_date) + (o.column ? " · " + o.column : "") : "", folder: o?.folder, order: o, all: [] }); }
        by.get(g).all.push(x);
      }
      return [...by.values()].map((G) => {
        const files = G.all.filter((x) => (fk.value === "all" || kindOf(x) === fk.value) && (!n || x.file_name.toLowerCase().includes(n) || String(G.title).toLowerCase().includes(n)));
        const rows = [], idx = {};
        for (const x of files) { const v = verKey(x); if (idx[v] === undefined) { idx[v] = rows.length; rows.push({ main: x, older: [] }); } else rows[idx[v]].older.push(x); }
        const rank = { final: 0, source: 1, identity: 1, ref: 2 };
        rows.sort((a, b) => rank[kindOf(a.main)] - rank[kindOf(b.main)]);
        return { ...G, rows, n: G.all.length };
      }).filter((G) => G.n);
    });
    const shownGroups = computed(() => fileGroups.value.filter((G) => G.rows.length && (!fsel.value || G.key === fsel.value)));
    const setKind = async (x, kind) => { try { await call("set_file_kind", { name: x.name, kind }, true); x.atelier_kind = kind; toast("تغيّر نوع الملف"); } catch (e) { toast(e.message, "error"); } };
    const fmenu = ref(null);
    const KIND_LABEL = Object.fromEntries(FILE_KINDS);
    const delCustFile = async (x) => { fmenu.value = null; if (!confirm(`حذف «${x.file_name}» نهائيًا؟`)) return;
      try { await call("delete_customer_file", { file: x.name }, true); toast("حُذف الملف"); await open(d.value.name, true); } catch (e) { toast(e.message, "error"); } };
    const fileSize = (b) => (!b ? "" : b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB");
    const viewFile = (x) => { if (isImg(x)) viewer.value = { list: [{ url: x.file_url, name: x.file_name, o: {} }], i: 0 }; else window.open(x.file_url, "_blank", "noopener"); };
    const allFiles = () => { hview.value = "files"; fsel.value = null; nextTick(() => document.querySelector(".cp-hist")?.scrollIntoView({ behavior: "smooth", block: "start" })); };
    const initial = (t) => (String(t || "?").trim()[0] || "?").toUpperCase();
    const finalName = (o) => decodeURIComponent((o.final || "").split("/").pop());
    // what the customer owes, in one sum: unpaid invoices + confirmed orders not invoiced yet
    const account = computed(() => {
      const o = (d.value?.orders || []).filter((x) => !x.price_pending && !["Closed"].includes(x.status));
      const unbilled = o.filter((x) => (x.per_billed || 0) < 100 && x.docstatus < 2).reduce((a, x) => a + Math.max(0, x.grand_total - (x.paid || 0)), 0);
      const invoices = Math.max(0, d.value?.outstanding || 0);
      return { invoices, unbilled, total: invoices + unbilled, all: o.reduce((a, x) => a + (x.grand_total || 0), 0),
        delivered: (d.value?.orders || []).filter((x) => x.per_delivered >= 100).length };
    });
    const remaining = (o) => (o.price_pending ? null : Math.max(0, o.grand_total - (o.paid || 0)));
    const showNote = computed(() => !!(d.value?.note) || editNote.value);
    const openCount = computed(() => (d.value?.orders || []).filter((o) => (o.per_delivered || 0) < 100 && !o.archived && o.status !== "Closed").length);
    if (sel.value) open(sel.value);
    return { s, load, sel, d, err, tab, q, f, draft, fopen, more, openFilters, applyFilters, resetFilters, TYPES, STATUSES, SORTS, everyone, ctags, rows, active, clearOne,
      kpi, quick, open, bal, lastWord, exportList, newOrderFor, pay, pmenu, merging, editNote, note, startNote, saveExtra, remind, startRemind, sendRemind, toggleDisabled,
      doMerge, exportOrders, reorder, uploading, onFile, copyText, LOG_KINDS, logKind, logText, addLog, months6, maxMonth, stFrom, stTo, statementUrl, sendStatement, STATE_DOT,
      owesNow, TABS, labelStyle, isImg, waLink, money, fig, date, ago, state, go, t,
      account, remaining, showNote, chips, gGroup, gSort, gAll, groupOf, galleryJobs, gGroups, gallery2, specOf, unitOf, coverOf, fk, fq, fsel, verOpen, FILE_KINDS, kindOf, verOf, kindCount, fileGroups, shownGroups, setKind, fmenu, KIND_LABEL, delCustFile, fileSize, viewFile, allFiles, extOf, jf, jobChips, stOpen, logAll, filesAll, closeCustomer, jq, hview, openYears, viewer, jobs, imagesOf, thumbOf, years, yearOpen, stOf, payWord, gallery, showImages, openCard, initial, finalName, openCount, folderLink, inkOn };
  },
  template: `
  <div class="cl">
    <div v-if="!sel" class="cl-main">
      <header class="cl-head">
        <div class="cl-head-row">
          <h1>العملاء</h1><span class="cl-count" v-if="s.data">{{ rows.length }} {{ rows.length === 1 ? 'عميل' : 'عملاء' }}</span>
          <span class="spacer"></span>
          <label class="cl-search"><Icon name="search" :size="16"/><span class="sr-only">بحث</span><input type="search" v-model="q" placeholder="ابحث بالاسم أو الهاتف"></label>
          <div class="cl-pop-host">
            <button type="button" class="cl-btn" :aria-expanded="fopen" @click.stop="openFilters"><Icon name="filter" :size="16"/>تصفية<template v-if="active.length"> · {{ active.length }}</template></button>
            <div v-if="fopen" class="cl-pop cl-filters" @click.stop>
              <div class="cl-fgroup"><span>النوع</span><div class="cl-seg"><button v-for="x in TYPES" :key="x[0]" type="button" :aria-pressed="draft.type === x[0]" @click="draft.type = x[0]">{{ x[1] }}</button></div></div>
              <div class="cl-fgroup"><span>الحالة</span><div class="cl-seg wrap"><button v-for="x in STATUSES" :key="x[0]" type="button" :aria-pressed="draft.status === x[0]" @click="draft.status = x[0]">{{ x[1] }}</button></div></div>
              <label v-if="s.data && s.data.rows.some((c) => (c.tags || []).length)" class="cl-fgroup"><span>التصنيف</span><select class="input" v-model="draft.tag"><option value="">كل التصنيفات</option><option v-for="x in s.data.customer_tags" :key="x.id" :value="x.id">{{ x.name }}</option></select></label>
              <label class="cl-fgroup"><span>الترتيب</span><select class="input" v-model="draft.sort"><option v-for="x in SORTS" :key="x[0]" :value="x[0]">{{ x[1] }}</option></select></label>
              <div class="cl-pop-foot"><button type="button" class="cl-link" @click="resetFilters">إعادة ضبط</button><button type="button" class="cl-btn primary" @click="applyFilters">تطبيق</button></div>
            </div>
          </div>
          <div class="cl-pop-host">
            <button type="button" class="cl-btn icon" aria-label="المزيد" :aria-expanded="more" @click.stop="more = !more; fopen = false"><Icon name="more" :size="18"/></button>
            <div v-if="more" class="cl-pop cl-menu" @click.stop><button type="button" @click="exportList"><Icon name="file" :size="16"/>تصدير القائمة (Excel)</button></div>
          </div>
          <button v-if="state.boot.can.customer" type="button" class="cl-btn primary" @click="state.sheet = {type: 'customer'}"><Icon name="plus" :size="16"/>عميل جديد</button>
        </div>
        <div v-if="s.data" class="cl-quick" role="group" aria-label="تصفية سريعة">
          <button v-for="c in chips" :key="c.k" type="button" class="bd-chip" :class="{debt: c.k === 'debt'}" :aria-pressed="c.on" @click="c.run()">{{ c.t }} <span class="cl-quick-n">{{ c.n }}</span></button>
        </div>
        <div v-if="active.some(a => a.k === 'tag')" class="cl-active">
          <button v-for="a in active.filter(a => a.k === 'tag')" :key="a.k" type="button" class="cl-chip" :aria-label="'إزالة ' + a.t" @click="clearOne(a.k)">{{ a.t }}<Icon name="x" :size="13"/></button>
        </div>
      </header>

      <div v-if="s.loading && !s.data" class="ws-loading">جارٍ التحميل…</div>
      <div v-else-if="s.error" class="alert error" style="margin:20px 28px">{{ s.error }}</div>
      <template v-else-if="s.data">
        <div class="cl-stats">
          <button type="button" @click="quick('all')"><span>العملاء</span><b>{{ kpi.total }}</b><small>{{ kpi.fresh }} جدد هذا الشهر</small></button>
          <button type="button" @click="quick('debt')"><span>عليهم دين</span><b class="bad money">{{ money(kpi.debt) }}</b><small>{{ kpi.debtN }} عملاء<template v-if="kpi.late"> · {{ kpi.late }} متأخرون</template></small></button>
          <button type="button" :disabled="!kpi.top" @click="kpi.top && open(kpi.top.name)"><span>الأكثر طلبًا</span><b class="ellipsis">{{ kpi.top ? kpi.top.customer_name : '—' }}</b><small>{{ kpi.top ? kpi.top.orders + ' طلبات' : '' }}</small></button>
          <button type="button" @click="quick('away')"><span>غابوا عنا</span><b>{{ kpi.away }}</b><small>بلا طلب منذ {{ s.data.away_days }} يومًا</small></button>
        </div>
        <div class="cl-table-wrap">
          <table class="cl-table cl-table2">
            <thead><tr><th>العميل</th><th class="desktop-only">الأعمال</th><th class="desktop-only">آخر عمل</th><th class="n">الرصيد</th><th class="acts desktop-only"><span class="sr-only">إجراءات</span></th></tr></thead>
            <tbody>
              <tr v-if="!rows.length"><td colspan="5" class="cl-empty">لا عملاء يطابقون البحث أو التصفية.</td></tr>
              <tr v-for="c in rows" :key="c.name" :class="{off: c.disabled}" tabindex="0" @click="open(c.name)" @keydown.enter="open(c.name)">
                <td><div class="cl-who"><Avatar :name="c.customer_name" :size="36"/>
                  <div style="min-width:0"><span class="cl-name">{{ c.customer_name }}<Icon v-if="c.vip" name="star" :size="14" class="cl-star"/></span>
                    <span class="cl-sub">{{ c.customer_type === 'Company' ? 'مؤسسة' : 'فرد' }}<template v-if="c.mobile_no"> · <span dir="ltr">{{ c.mobile_no }}</span></template></span>
                    <span v-if="(c.tags || []).length" class="cl-tags"><span v-for="id in c.tags.filter(x => ctags[x])" :key="id"><i :style="{background: ctags[id].color}"></i>{{ ctags[id].name }}</span></span></div></div></td>
                <td class="desktop-only">{{ c.orders ? c.orders + (c.orders === 1 ? ' عمل' : ' أعمال') : '—' }}<span v-if="c.open_orders" class="cl-sub">{{ c.open_orders }} جارية</span></td>
                <td class="desktop-only muted" :class="{warn: c.away}">{{ lastWord(c.last_order) }}</td>
                <td class="n"><span class="cl-bal" :class="bal(c.balance).cls"><i v-if="bal(c.balance).cls"></i>{{ c.balance === null ? '' : (bal(c.balance).cls === 'bad' ? 'عليه ' : '') + bal(c.balance).text }}<small v-if="c.unbilled > 0.005 && c.balance > 0.005" class="cl-bal-sub">{{ c.invoices > 0.005 ? 'منها ' + fig(c.unbilled) + ' لم تُفوتر' : 'طلبات لم تُفوتر' }}</small></span>
                  <span v-if="c.overdue_days" class="cl-late">متأخر {{ c.overdue_days }} يومًا</span></td>
                <td class="acts desktop-only"><span class="cl-row-acts">
                  <a v-if="c.mobile_no" class="cl-btn icon sm" :href="'tel:' + c.mobile_no" :aria-label="'اتصال بـ ' + c.customer_name" @click.stop><Icon name="phone" :size="14"/></a>
                  <button v-if="state.boot.can.order" type="button" class="cl-btn icon sm" :aria-label="'طلب جديد لـ ' + c.customer_name" @click.stop="newOrderFor(c)"><Icon name="plus" :size="14"/></button></span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>

    <div v-else class="cp">
      <div v-if="err" class="alert error">{{ err }}</div>
      <div v-else-if="!d" class="ws-loading">جارٍ التحميل…</div>
      <template v-else>
        <header class="cp-card cp-head">
          <button type="button" class="cl-btn icon cp-back" aria-label="العودة إلى العملاء" title="العملاء" @click="closeCustomer"><Icon name="back" :size="16"/></button>
          <div class="cp-id">
            <h1>{{ d.customer_name }}<span class="cp-type">{{ d.customer_type === 'Company' ? 'مؤسسة' : 'فرد' }}</span>
              <button v-if="d.can_edit" type="button" class="cl-star-btn" :aria-pressed="!!d.vip" :title="d.vip ? 'إلغاء زبون مميز' : 'زبون مميز'" @click="saveExtra({vip: d.vip ? 0 : 1})"><Icon name="star" :size="16"/></button></h1>
            <span class="muted"><template v-if="d.mobile_no"><span dir="ltr">{{ d.mobile_no }}</span> · </template>عميل منذ {{ date(d.since) }}<template v-for="id in d.tags.filter(x => ctags[x])" :key="id"> · {{ ctags[id].name }}</template></span>
          </div>
          <div class="cp-acts">
            <a v-if="d.mobile_no" class="cl-btn" :href="'tel:' + d.mobile_no"><Icon name="phone" :size="15"/>اتصال</a>
            <a v-if="waLink(d.mobile_no)" class="cl-btn" target="_blank" rel="noopener" :href="waLink(d.mobile_no)"><Icon name="msg" :size="15"/>واتساب</a>
            <div v-if="d.balance !== undefined" class="cl-pop-host"><button type="button" class="cl-btn" :aria-expanded="stOpen" @click.stop="stOpen = !stOpen; pmenu = false"><Icon name="file" :size="15"/>كشف حساب</button>
              <div v-if="stOpen" class="cl-pop cp-stpop" @click.stop>
                <b>كشف حساب {{ d.customer_name }}</b>
                <div class="cp-stdates"><label class="cl-fgroup"><span>من</span><input type="date" class="input" v-model="stFrom"></label><label class="cl-fgroup"><span>إلى</span><input type="date" class="input" v-model="stTo"></label></div>
                <div class="btn-row"><a class="cl-btn primary sm" target="_blank" rel="noopener" :href="statementUrl" @click="stOpen = false">تحميل PDF</a>
                  <button v-if="waLink(d.mobile_no)" type="button" class="cl-btn sm" @click="sendStatement(); stOpen = false">إرسال بواتساب</button></div>
                <span v-if="waLink(d.mobile_no)" class="muted cp-small">واتساب لا يقبل الإرفاق من رابط: يُحمَّل الملف ثم أرفقه في المحادثة.</span></div></div>
            <div class="cl-pop-host"><button type="button" class="cl-btn icon" aria-label="المزيد" :aria-expanded="pmenu" @click.stop="pmenu = !pmenu; stOpen = false"><Icon name="more" :size="18"/></button>
              <div v-if="pmenu" class="cl-pop cl-menu" @click.stop>
                <a v-if="d.folder" :href="folderLink(d.folder)" class="cp-menu-a" @click="pmenu = false"><Icon name="file" :size="16"/>افتح مجلد العميل</a>
                <button v-if="d.can_edit" type="button" @click="pmenu = false; state.sheet = {type: 'customer', name: d.name}"><Icon name="edit" :size="16"/>تعديل بيانات العميل</button>
                <button v-if="d.can_edit" type="button" @click="pmenu = false; startNote()"><Icon name="pin" :size="16"/>{{ d.note ? 'تعديل الملاحظة الثابتة' : 'إضافة ملاحظة ثابتة' }}</button>
                <button v-if="owesNow && waLink(d.mobile_no)" type="button" @click="pmenu = false; startRemind()"><Icon name="msg" :size="16"/>تذكير بالدفع</button>
                <button type="button" @click="exportOrders"><Icon name="file" :size="16"/>تصدير أعماله (Excel)</button>
                <button v-if="s.data && s.data.manager" type="button" @click="pmenu = false; merging = ''">دمج مع عميل آخر</button>
                <button v-if="d.can_edit" type="button" @click="toggleDisabled">{{ d.disabled ? 'إعادة تفعيل العميل' : 'إيقاف العميل' }}</button></div></div>
            <button v-if="state.boot.can.payment" type="button" class="cl-btn" @click="pay">استلمت دفعة</button>
            <button v-if="state.boot.can.order" type="button" class="cl-btn primary" @click="newOrderFor(d)"><Icon name="plus" :size="16"/>طلب جديد</button>
          </div>
        </header>
        <div v-if="d.disabled" class="cl-note muted-note">هذا العميل موقوف: لا يظهر في القوائم ولا في اختيار العملاء.</div>
        <div v-if="merging !== null" class="cp-card cp-pad">
          <b>دمج «{{ d.customer_name }}» في عميل آخر</b>
          <span class="muted">تنتقل كل طلباته وفواتيره ودفعاته وملفاته إلى العميل المختار، ويُحذف هذا الاسم. لا يمكن التراجع.</span>
          <select class="input" v-model="merging" aria-label="العميل الذي يبقى"><option value="">اختر العميل الذي يبقى…</option>
            <option v-for="c in everyone.filter(x => x.name !== d.name && x.customer_type === d.customer_type)" :key="c.name" :value="c.name">{{ c.customer_name }}</option></select>
          <div class="row" style="gap:8px"><button type="button" class="cl-btn danger" :disabled="!merging" @click="doMerge">دمج</button><button type="button" class="cl-btn ghost" @click="merging = null">إلغاء</button></div>
        </div>
        <div v-if="remind !== null" class="cp-card cp-pad"><label class="muted" for="remind-t">رسالة التذكير (عدّلها قبل الإرسال)</label><textarea id="remind-t" class="input" v-model="remind" rows="5"></textarea>
          <div class="row" style="gap:8px"><button type="button" class="cl-btn primary" @click="sendRemind">فتح في واتساب</button><button type="button" class="cl-btn ghost" @click="remind = null">إلغاء</button></div></div>

        <div class="cp-2col"><div class="cp-main">
        <div class="cp-card cp-acc cp-acc4">
          <div><span class="muted">المطلوب منه الآن</span><b :class="account.total > 0.005 ? 'bad' : 'ok'">{{ account.total > 0.005 ? money(account.total) : 'لا شيء' }}</b>
            <span v-if="account.total > 0.005" class="muted">فواتير {{ fig(account.invoices) }} · طلبات لم تُفوتر {{ fig(account.unbilled) }}</span>
            <span v-if="d.overdue_days" class="muted bad">أقدم فاتورة متأخرة {{ d.overdue_days }} يومًا</span></div>
          <div v-if="d.received !== undefined"><span class="muted">دفع حتى الآن</span><b>{{ money(d.received || 0) }}</b><span class="muted">من مجموع أعماله {{ fig(account.all) }} دج</span></div>
          <div><span class="muted">الأعمال</span><b>{{ d.orders.length }}</b><span class="muted">{{ openCount }} جارية · {{ account.delivered }} سُلّمت</span></div>
          <div v-if="d.credit_limit"><span class="muted">سقف الدين</span><b>{{ money(d.credit_limit) }}</b>
            <span class="muted" :class="d.credit_limit - account.total < 0 ? 'bad' : 'ok'">{{ d.credit_limit - account.total < 0 ? 'تجاوزه بـ ' + fig(account.total - d.credit_limit) + ' دج' : 'متبقٍ له ' + fig(d.credit_limit - account.total) + ' دج' }}</span></div>
          <div v-else-if="d.received !== undefined"><span class="muted">عادة الدفع</span><b>{{ d.avg_pay_days === null || d.avg_pay_days === undefined ? '—' : d.avg_pay_days + ' يومًا' }}</b><span class="muted">آخر دفعة {{ d.last_payment ? date(d.last_payment) : '—' }}</span></div>
        </div>
        <section class="cp-card cp-hist" aria-label="أعماله">
          <div class="cp-hist-head"><h2>أعماله</h2><span class="muted">{{ d.orders.length }}</span>
            <template v-if="hview !== 'files'"><button v-for="c in jobChips" :key="c.k" type="button" class="bd-chip" :class="{debt: c.k === 'unpaid'}" :aria-pressed="jf === c.k" @click="jf = c.k">{{ c.t }} <span class="cl-quick-n">{{ c.n }}</span></button></template>
            <template v-else><button v-for="k in [['all', 'الكل'], ['final', 'نهائي'], ['source', 'مصدر'], ['ref', 'مراجع'], ['identity', 'الهوية']]" :key="k[0]" v-show="k[0] === 'all' || kindCount[k[0]]" type="button" class="bd-chip" :aria-pressed="fk === k[0]" @click="fk = k[0]">{{ k[1] }} <span class="cl-quick-n">{{ kindCount[k[0]] || 0 }}</span></button></template>
            <span class="spacer"></span>
            <label v-if="hview === 'files'" class="cl-search"><Icon name="search" :size="16"/><span class="sr-only">بحث في الملفات</span><input type="search" v-model="fq" placeholder="اسم الملف أو العمل"></label>
            <label v-else class="cl-search"><Icon name="search" :size="16"/><span class="sr-only">بحث في أعماله</span><input type="search" v-model="jq" placeholder="ابحث في أعماله"></label>
            <div class="seg" role="group" aria-label="طريقة العرض"><button type="button" :aria-pressed="hview === 'list'" @click="hview = 'list'">جدول</button><button type="button" :aria-pressed="hview === 'gallery'" @click="hview = 'gallery'">معرض الصور</button><button type="button" :aria-pressed="hview === 'files'" @click="hview = 'files'">الملفات <span class="muted">{{ d.card_files.length }}</span></button></div></div>
          <div v-if="hview === 'files'" class="cpf">
            <nav class="cpf-tree" aria-label="مجموعات الملفات"><button type="button" :aria-pressed="!fsel" @click="fsel = null">كل الأعمال<i>{{ d.card_files.length }}</i></button>
              <button v-for="G in fileGroups" :key="G.key" type="button" :aria-pressed="fsel === G.key" :class="{id: G.key === '__id'}" @click="fsel = G.key"><span class="ellipsis">{{ G.title }}</span><i>{{ G.n }}</i></button>
</nav>
            <div class="cpf-body">
              <div class="cpf-help">الملفات مرتبة حسب العمل. الملفات تُرفع من بطاقة العمل. لجعل ملف (مثل الشعار) من <b>الهوية</b> أو لحذفه اضغط <b>⋯</b> بجانبه.</div>
              <div v-if="!shownGroups.length" class="muted cp-pad">{{ d.card_files.length ? 'لا ملفات تطابق التصفية.' : 'لا ملفات بعد. ما يُرفق في البطاقات يظهر هنا مرتبًا حسب العمل.' }}</div>
              <section v-for="G in shownGroups" :key="G.key" class="cpf-grp">
                <div class="cpf-gh"><b class="ellipsis">{{ G.title }}</b><span class="muted">{{ G.sub }}</span><button v-if="G.order" type="button" class="cl-link" @click="openCard(G.order)">فتح البطاقة</button>
                  <span v-if="G.folder" class="od-path cpf-path"><code dir="ltr" :title="G.folder">{{ G.folder }}</code><button type="button" class="od-pbtn" @click="copyText(G.folder)">نسخ</button><a class="od-pbtn pri" :href="folderLink(G.folder)">فتح المجلد</a></span></div>
                <template v-for="r in G.rows" :key="r.main.name">
                  <div class="cpf-row">
                    <span class="cpf-ic" :class="'k-' + kindOf(r.main)"><img v-if="isImg(r.main)" :src="r.main.file_url" alt="" loading="lazy"><template v-else>{{ extOf(r.main).slice(0, 4).toUpperCase() || '?' }}</template></span>
                    <button type="button" class="cpf-n" :title="r.main.file_name" @click="viewFile(r.main)"><b class="ellipsis">{{ r.main.file_name }}</b><span class="muted">{{ ago(r.main.creation) }}<template v-if="r.main.file_size"> · {{ fileSize(r.main.file_size) }}</template><template v-if="verOf(r.main)"> · v{{ verOf(r.main) }}</template></span></button>
                    <span class="cpf-badge" :class="'k-' + kindOf(r.main)">{{ KIND_LABEL[kindOf(r.main)] }}</span>
                    <span class="btn-row cpf-acts"><a class="cl-btn sm" :href="r.main.file_url" download>تنزيل</a>
                      <span v-if="d.can_edit" class="cl-pop-host"><button type="button" class="cl-btn icon sm" aria-label="خيارات الملف" :aria-expanded="fmenu === r.main.name" @click.stop="fmenu = fmenu === r.main.name ? null : r.main.name"><Icon name="more" :size="16"/></button>
                        <div v-if="fmenu === r.main.name" class="cl-pop cl-menu cpf-menu" @click.stop>
                          <span class="cpf-mh">نوع الملف</span>
                          <button v-for="k in FILE_KINDS" :key="k[0]" type="button" :aria-pressed="kindOf(r.main) === k[0]" @click="setKind(r.main, k[0]); fmenu = null"><i class="cpf-dot" :class="'k-' + k[0]"></i>{{ k[1] }}</button>
                          <hr><button type="button" class="bad" @click="delCustFile(r.main)">حذف الملف</button></div></span></span>
                  </div>
                  <button v-if="r.older.length" type="button" class="cpf-ver" @click="verOpen[r.main.name] = !verOpen[r.main.name]">{{ verOpen[r.main.name] ? 'إخفاء' : 'النسخ السابقة' }} ({{ r.older.length }}) <Icon :name="verOpen[r.main.name] ? 'up' : 'down'" :size="12"/></button>
                  <template v-if="verOpen[r.main.name]"><div v-for="x in r.older" :key="x.name" class="cpf-row old">
                    <span class="cpf-ic">{{ extOf(x).slice(0, 4).toUpperCase() }}</span>
                    <button type="button" class="cpf-n" @click="viewFile(x)"><b class="ellipsis">{{ x.file_name }}</b><span class="muted">{{ ago(x.creation) }}</span></button><span class="cpf-badge">نسخة سابقة</span>
                    <span class="btn-row cpf-acts"><a class="cl-btn sm" :href="x.file_url" download>تنزيل</a><button v-if="d.can_edit" type="button" class="cl-btn sm" @click="delCustFile(x)">حذف</button></span></div></template>
                </template>
              </section>
            </div>
          </div>
          <div v-else-if="!jobs.length" class="muted cp-pad">{{ jq.trim() || jf !== 'all' ? 'لا أعمال تطابق التصفية.' : 'لا أعمال بعد.' }}</div>
          <div v-else-if="hview === 'list'" class="cp-tbl-wrap">
            <table class="cl-table cp-tbl">
              <thead><tr><th class="cp-td-img"><span class="sr-only">صورة</span></th><th>العمل</th><th>التاريخ</th><th class="desktop-only">المرحلة</th><th>الحالة</th><th class="n desktop-only">المبلغ</th><th class="n">الباقي</th></tr></thead>
              <tbody v-for="(Y, yi) in years" :key="Y.y">
                <tr class="cp-yr" tabindex="0" :aria-expanded="yearOpen(Y.y, yi)" @click="openYears[Y.y] = !yearOpen(Y.y, yi)" @keydown.enter="openYears[Y.y] = !yearOpen(Y.y, yi)">
                  <td colspan="7"><b>{{ Y.y }}</b> <span class="muted">· {{ Y.n }} {{ Y.n === 1 ? 'عمل' : 'أعمال' }} · {{ money(Y.total) }}</span><Icon :name="yearOpen(Y.y, yi) ? 'up' : 'down'" :size="14" class="cp-yr-ic"/></td></tr>
                <template v-if="yearOpen(Y.y, yi)"><template v-for="M in Y.months" :key="M.m">
                  <tr class="cp-mo"><td colspan="7">{{ M.label }}<span class="muted">{{ M.items.length }} {{ M.items.length === 1 ? 'عمل' : 'أعمال' }} · {{ fig(M.items.reduce((a, o) => a + (o.price_pending ? 0 : o.grand_total || 0), 0)) }} دج</span></td></tr>
                  <tr v-for="o in M.items" :key="o.name" class="cp-row" tabindex="0" :title="'فتح بطاقة ' + (o.atelier_subject || o.name)" @click="openCard(o)" @keydown.enter="openCard(o)">
                    <td class="cp-td-img cp-c-img"><button v-if="thumbOf(o)" type="button" class="cp-mini" :aria-label="'صور ' + (o.atelier_subject || o.name)" @click.stop="showImages(o)"><img :src="thumbOf(o)" alt="" loading="lazy"></button></td>
                    <td class="cp-c-name"><b class="cp-job-n">{{ o.atelier_subject || o.name }}</b>
                      <span v-if="o.size" class="cl-sub">{{ o.size }}</span>
                      <a v-if="o.final" class="cp-final" :href="o.final" download @click.stop><Icon name="star" :size="12"/>الملف النهائي</a></td>
                    <td class="muted cp-nowrap cp-c-date">{{ date(o.transaction_date) }}</td>
                    <td class="desktop-only cp-c-stage"><span class="cp-stage">{{ o.archived ? 'مؤرشفة' : o.column || '—' }}</span></td>
                    <td class="cp-c-st"><span class="cp-sts"><span v-for="x in stOf(o)" :key="x.id" class="st-pill" :style="{background: x.color, color: inkOn(x.color)}">{{ x.name }}</span></span></td>
                    <td class="n desktop-only cp-nowrap cp-c-amt"><span v-if="o.price_pending" class="cp-pay warn">بلا سعر</span><template v-else>{{ fig(o.grand_total) }}</template></td>
                    <td class="n cp-nowrap cp-c-rem"><span v-if="remaining(o) === null" class="muted">—</span><span v-else-if="remaining(o) > 0.005" class="cp-pay bad">{{ fig(remaining(o)) }}</span><span v-else class="cp-pay ok">مدفوع</span></td>
                  </tr>
                </template></template>
              </tbody>
            </table>
          </div>
          <div v-else class="cpg">
            <div class="cpg-bar"><template v-if="gGroups.length > 1"><button type="button" class="bd-chip" :aria-pressed="gGroup === 'all'" @click="gGroup = 'all'">كل الخدمات <span class="cl-quick-n">{{ galleryJobs.length }}</span></button>
              <button v-for="g in gGroups" :key="g[0]" type="button" class="bd-chip" :aria-pressed="gGroup === g[0]" @click="gGroup = g[0]">{{ g[0] }} <span class="cl-quick-n">{{ g[1] }}</span></button></template>
              <span class="spacer"></span>
              <label class="cpg-chk"><input type="checkbox" :checked="!gAll" @change="gAll = !$event.target.checked">المسلَّمة فقط</label>
              <select class="input cpg-sort" v-model="gSort" aria-label="الترتيب"><option value="new">الأحدث</option><option value="price">الأعلى سعرًا</option></select></div>
            <div v-if="!gallery2.length" class="muted cp-pad">{{ gAll ? 'لا أعمال.' : 'لا أعمال مسلَّمة بعد — ألغِ «المسلَّمة فقط» لرؤية الكل.' }}</div>
            <div class="cpg-grid">
              <article v-for="o in gallery2" :key="o.name" class="cpg-it">
                <button type="button" class="cpg-ph" :style="coverOf(o) ? {} : {background: o.cover_color || '#98A2B3'}" :aria-label="'صور ' + (o.atelier_subject || o.name)" @click="coverOf(o) ? showImages(o, imagesOf(o)[0]?.file_url) : openCard(o)">
                  <img v-if="coverOf(o)" :src="coverOf(o)" alt="" loading="lazy"><span v-else class="cpg-ini">{{ initial(o.atelier_subject || o.name) }}</span>
                  <span v-if="gGroups.length > 1" class="cpg-tag">{{ groupOf(o) }}</span><span v-if="(o.per_delivered || 0) < 100" class="cpg-tag run">قيد التنفيذ</span></button>
                <div class="cpg-in">
                  <button type="button" class="cpg-t" dir="auto" :title="o.atelier_subject || o.name" @click="openCard(o)">{{ o.atelier_subject || o.name }}</button>
                  <span class="cpg-spec">{{ specOf(o) || '—' }}</span>
                  <div class="cpg-pr"><b v-if="!o.price_pending">{{ money(o.grand_total) }}</b><b v-else class="warn">بلا سعر</b><small v-if="unitOf(o)">{{ unitOf(o) }}</small></div>
                  <div class="cpg-ft"><span>{{ date(o.transaction_date) }}</span>
                    <button v-if="state.boot.can.order" type="button" class="cpg-again" title="بطاقة جديدة بنفس البنود في اللوحة" @click="reorder(o)">طلب مشابه</button></div>
                </div>
              </article>
            </div>
          </div>
        </section>

        </div>
        <aside class="cp-side">
        <div v-if="showNote" class="cl-note cp-sidenote">
          <Icon name="pin" :size="15"/>
          <template v-if="editNote"><div style="flex:1"><textarea class="input" v-model="note" rows="3" aria-label="الملاحظة الثابتة" placeholder="تظهر في كل بطاقة جديدة لهذا العميل"></textarea>
            <div class="row" style="gap:8px;margin-top:6px"><button type="button" class="cl-btn primary sm" @click="saveExtra({note})">حفظ</button><button type="button" class="cl-btn ghost sm" @click="editNote = false">إلغاء</button></div></div></template>
          <template v-else><span style="flex:1">{{ d.note }}</span><button v-if="d.can_edit" type="button" class="cl-link" @click="startNote">تعديل</button></template>
        </div>

          <section class="cp-card cp-sc"><h3>التواصل<button v-if="d.log.length > 3" type="button" class="cl-link" @click="logAll = !logAll">{{ logAll ? 'أقل' : 'الكل ' + d.log.length }}</button></h3>
            <form class="cl-logf" @submit.prevent="addLog">
              <div class="cl-seg wrap"><button v-for="k in LOG_KINDS" :key="k[0]" type="button" :aria-pressed="logKind === k[0]" @click="logKind = k[0]">{{ k[1] }}</button></div>
              <textarea class="input" v-model="logText" rows="2" placeholder="ماذا حدث؟ مثلًا: وعد بدفع 20,000 يوم الخميس" aria-label="سجّل تواصلًا"></textarea>
              <button v-if="logText.trim()" type="submit" class="cl-btn primary sm" style="align-self:flex-start">حفظ</button></form>
            <div v-if="!d.log.length" class="muted cp-small">لا تواصل مسجّل بعد.</div>
            <div v-for="l in (logAll ? d.log : d.log.slice(0, 3))" :key="l.name" class="cp-logi"><div class="cl-logt" v-html="l.content"></div><span class="muted">{{ l.by }} · {{ ago(l.creation) }}</span></div>
          </section>
          <section class="cp-card cp-sc"><h3>الملفات <span class="muted">{{ d.card_files.length }}</span><button v-if="d.card_files.length" type="button" class="cl-link" @click="allFiles">كل الملفات مرتبة</button></h3>
            <a v-for="x in d.card_files.slice(0, 4)" :key="x.name" class="cp-fi" :href="x.file_url" target="_blank" rel="noopener">
              <span class="cp-fi-ic"><img v-if="isImg(x)" :src="x.file_url" alt="" loading="lazy"><Icon v-else name="file" :size="16"/></span>
              <span class="cp-fi-t"><b class="ellipsis">{{ x.file_name }}</b><span class="muted ellipsis">{{ x.atelier_subject || 'ملف العميل' }} · {{ ago(x.creation) }}</span></span></a>
            <div v-if="!d.card_files.length" class="muted cp-small">كل ما يُرفق في بطاقات هذا العميل يظهر هنا.</div>
            <a v-if="d.folder" class="cl-link cp-small" :href="folderLink(d.folder)">فتح مجلد العميل في الحاسوب</a>
          </section>
          <section class="cp-card cp-sc"><h3>البيانات<button v-if="d.can_edit" type="button" class="cl-link" @click="state.sheet = {type: 'customer', name: d.name}">تعديل</button></h3>
            <div v-for="p in d.contacts" :key="p.name + p.phone" class="cp-kv"><span>{{ p.role || 'شخص' }}</span><b>{{ p.name }}<template v-if="p.phone"> · <a dir="ltr" :href="'tel:' + p.phone">{{ p.phone }}</a></template></b></div>
            <div class="cp-kv"><span>البريد</span><b dir="ltr">{{ d.email_id || '—' }}</b></div>
            <div class="cp-kv"><span>العنوان</span><b>{{ [d.address, d.city].filter(x => x && x !== '—').join('، ') || '—' }}</b></div>
            <template v-if="d.customer_type === 'Company'">
              <div v-for="k in [['rc','RC'],['nif','NIF'],['nis','NIS'],['ai','AI']]" :key="k[0]" class="cp-kv"><span>{{ k[1] }}</span><b v-if="d.legal[k[0]]" dir="ltr">{{ d.legal[k[0]] }}</b><b v-else-if="k[0] === 'nif' || k[0] === 'rc'" class="bad">ناقص</b><b v-else>—</b></div></template>
          </section>
          <section v-if="d.top && d.top.length" class="cp-card cp-sc"><h3>أكثر ما يطلبه</h3>
            <div v-for="x in d.top.slice(0, 5)" :key="x.what" class="cp-kv"><span class="ellipsis">{{ x.what }}</span><b>{{ x.n }}</b></div></section>
        </aside></div>
      </template>
    </div>
    <ImageViewer v-if="viewer" :list="viewer.list" :start="viewer.i" @close="viewer = null"/>
  </div>`,
};

// ------------------------------------------------------------------ customer form (new / edit), board identity
const CustomerSheet2 = {
  props: ["opts"], components: { Icon, Avatar },
  setup(props) {
    const editing = !!props.opts.name;
    const f = reactive({ name: props.opts.name || null, customer_name: "", customer_type: "Individual", mobile_no: "", email_id: "", address: "", city: "",
      nif: "", rc: "", nis: "", ai: "", contacts: [], credit_limit: "", tags: [], note: "", tva_exempt: 0 });
    const tags = ref([]), ready = ref(!editing), saving = ref(false), error = ref(null), attempted = ref(false);
    onMounted(async () => {
      try {
        if (editing) {
          const d = await call("customer2", { name: f.name });
          Object.assign(f, { customer_name: d.customer_name, customer_type: d.customer_type, mobile_no: d.mobile_no || "", email_id: d.email_id || "",
            address: d.address || "", city: d.city || "", nif: d.legal.nif || "", rc: d.legal.rc || "", nis: d.legal.nis || "", ai: d.legal.ai || "",
            contacts: d.contacts.map((c) => ({ ...c })), credit_limit: d.credit_limit || "", tags: [...d.tags], note: d.note || "", tva_exempt: d.tva_exempt || 0 });
          tags.value = d.customer_tags;
        } else tags.value = (await call("customers2")).customer_tags;
      } catch (e) { error.value = e.message; }
      ready.value = true;
      setTimeout(() => document.getElementById("c2-name")?.focus(), 50);
    });
    const company = computed(() => f.customer_type === "Company");
    const errs = computed(() => ({ name: !f.customer_name.trim() ? "اكتب اسم العميل" : null,
      email: f.email_id && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email_id) ? "البريد غير صالح" : null,
      limit: f.credit_limit !== "" && !(+f.credit_limit >= 0) ? "السقف غير صحيح" : null }));
    const toggleTag = (id) => { const i = f.tags.indexOf(id); if (i >= 0) f.tags.splice(i, 1); else f.tags.push(id); };
    const close = () => (state.sheet = null);
    const onKey = (e) => { if (e.key === "Escape") close(); };
    onMounted(() => window.addEventListener("keydown", onKey));
    onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
    async function save() {
      attempted.value = true; error.value = null;
      if (errs.value.name || errs.value.email || errs.value.limit) return;
      saving.value = true;
      try {
        const name = await call("save_customer2", { data: JSON.stringify({ ...f, credit_limit: f.credit_limit === "" ? 0 : +f.credit_limit,
          contact_person: f.contacts[0]?.name || "" }) }, true);
        toast(editing ? "حُفظ العميل" : "أُضيف العميل"); close(); state.rev++;
        if (!editing) go("/customers?c=" + encodeURIComponent(name));
      } catch (e) { error.value = e.message; }
      saving.value = false;
    }
    return { f, editing, tags, ready, saving, error, attempted, company, errs, toggleTag, close, save, labelStyle };
  },
  template: `
  <div class="overlay tm-overlay" @click.self="close">
    <form class="tm cs2" role="dialog" aria-modal="true" :aria-label="editing ? 'تعديل العميل' : 'عميل جديد'" novalidate @submit.prevent="save">
      <div class="cs2-head"><b>{{ editing ? 'تعديل العميل' : 'عميل جديد' }}</b><button type="button" class="cl-btn icon ghost" aria-label="إغلاق" @click="close"><Icon name="x" :size="18"/></button></div>
      <div v-if="!ready" class="tm-loading">جارٍ التحميل…</div>
      <div v-else class="cs2-body">
        <div class="cl-seg cs2-type" role="group" aria-label="نوع العميل"><button type="button" :aria-pressed="!company" @click="f.customer_type = 'Individual'">فرد</button><button type="button" :aria-pressed="company" @click="f.customer_type = 'Company'">مؤسسة</button></div>
        <section class="cs2-sec"><b>المعلومات</b>
          <div class="cs2-row"><label class="cs2-f grow2"><span class="m">{{ company ? 'اسم المؤسسة' : 'الاسم' }} *</span><input id="c2-name" class="input" v-model="f.customer_name" :aria-invalid="attempted && !!errs.name"><span v-if="attempted && errs.name" class="err">{{ errs.name }}</span></label>
            <label class="cs2-f"><span class="m">الهاتف</span><input class="input" v-model="f.mobile_no" inputmode="tel" dir="ltr"></label></div>
          <div class="cs2-row"><label class="cs2-f"><span class="m">البريد</span><input class="input" v-model="f.email_id" type="email" dir="ltr" :aria-invalid="attempted && !!errs.email"><span v-if="attempted && errs.email" class="err">{{ errs.email }}</span></label>
            <label class="cs2-f grow2"><span class="m">العنوان</span><input class="input" v-model="f.address"></label>
            <label class="cs2-f"><span class="m">المدينة</span><input class="input" v-model="f.city"></label></div>
        </section>
        <section v-if="company" class="cs2-sec"><b>البيانات القانونية <span class="m" style="display:inline;font-weight:400">· تظهر على الفاتورة</span></b>
          <div class="cs2-row"><label class="cs2-f"><span class="m">السجل التجاري RC</span><input class="input" v-model="f.rc" dir="ltr"></label><label class="cs2-f"><span class="m">الرقم الجبائي NIF</span><input class="input" v-model="f.nif" dir="ltr"></label></div>
          <div class="cs2-row"><label class="cs2-f"><span class="m">NIS</span><input class="input" v-model="f.nis" dir="ltr"></label><label class="cs2-f"><span class="m">المادة AI</span><input class="input" v-model="f.ai" dir="ltr"></label></div>
        </section>
        <section class="cs2-sec"><b>الأشخاص</b>
          <div v-for="(p, i) in f.contacts" :key="i" class="cs2-row cs2-person">
            <input class="input" v-model="p.name" placeholder="الاسم" :aria-label="'اسم الشخص ' + (i + 1)">
            <input class="input" v-model="p.role" placeholder="الدور (المحاسبة، الطلبات…)" :aria-label="'دور الشخص ' + (i + 1)">
            <input class="input" v-model="p.phone" placeholder="الهاتف" dir="ltr" inputmode="tel" :aria-label="'هاتف الشخص ' + (i + 1)">
            <button type="button" class="btn ghost icon-btn sm danger" :aria-label="'حذف ' + (p.name || 'الشخص')" @click="f.contacts.splice(i, 1)"><Icon name="trash" :size="15"/></button></div>
          <button type="button" class="tm-pop-add" style="border:0;padding:2px 0" @click="f.contacts.push({name: '', role: '', phone: ''})">+ إضافة شخص</button>
        </section>
        <section class="cs2-sec"><b>للفريق</b>
          <div class="cs2-row"><label class="cs2-f"><span class="m">سقف الدين</span><div class="unit-wrap"><input class="input num" v-model="f.credit_limit" inputmode="decimal" placeholder="بلا سقف"><span class="u">دج</span></div><span v-if="attempted && errs.limit" class="err">{{ errs.limit }}</span></label>
            <div v-if="f.tags.length" class="cs2-f grow2"><span class="m">التصنيف</span><div class="bd-chips">
              <button v-for="tg in tags" :key="tg.id" type="button" class="tl tl-btn" :class="{off: !f.tags.includes(tg.id)}" :style="labelStyle(tg)" :aria-pressed="f.tags.includes(tg.id)" @click="toggleTag(tg.id)">{{ f.tags.includes(tg.id) ? '✓ ' : '' }}{{ tg.name }}</button></div></div></div>
          <label class="cs2-f"><span class="m">ملاحظة ثابتة (تظهر في كل بطاقة جديدة له)</span><textarea class="input" v-model="f.note" rows="2"></textarea></label>
          <label class="bs-deliver"><input type="checkbox" :checked="!!f.tva_exempt" @change="f.tva_exempt = $event.target.checked ? 1 : 0">معفى من TVA</label>
        </section>
        <div v-if="error" class="alert error" role="alert">{{ error }}</div>
        <button type="submit" class="btn primary bd-save" :disabled="saving">{{ saving ? 'جارٍ الحفظ…' : 'حفظ العميل' }}</button>
      </div>
    </form>
  </div>`,
};

const SimpleMoney = {
  components: { Icon, Avatar },
  setup() {
    const offset = ref(0);
    const { s, load } = useLoad(() => call("money3", { offset: offset.value }));
    onMounted(load);
    watch([() => state.rev, offset], load);
    const d = computed(() => s.data);
    const month = computed(() => (d.value ? new Intl.DateTimeFormat("ar", { month: "long", year: "numeric" }).format(parseDate(d.value.month)) : ""));
    const pct = (now, prev) => (prev > 0.005 ? Math.round(((now - prev) / prev) * 100) : null);
    const kind = ref("all"), q = ref(""), fundSel = ref(null);
    watch(offset, () => (fundSel.value = null));
    const moves = computed(() => (d.value?.moves || []).filter((m) => (kind.value === "all" || m.kind === kind.value) && (!fundSel.value || m.account === fundSel.value)
      && (!q.value || [m.title, m.category, m.order_title, m.by, m.ref].some((v) => String(v || "").includes(q.value.trim())))));
    const days = computed(() => {
      const out = [];
      for (const m of moves.value) {
        const k = String(m.posting_date); let g = out.find((x) => x.k === k);
        if (!g) { g = { k, items: [], total: 0 }; out.push(g); }
        g.items.push(m); if (m.kind !== "transfer") g.total += m.amount;
      }
      return out;
    });
    const dayFmt = new Intl.DateTimeFormat("ar", { weekday: "long", day: "numeric", month: "long" });
    const dayLabel = (iso) => { const n = daysFromToday(iso); return (n === 0 ? "اليوم · " : n === -1 ? "أمس · " : "") + dayFmt.format(parseDate(iso)); };
    const KINDS = [["all", "الكل"], ["in", "دخل"], ["out", "مصاريف"], ["transfer", "تحويلات"]];
    const exportMoves = () => {
      const rows = [["التاريخ", "البيان", "النوع", "الصندوق", "المبلغ", "سجّلها"], ...moves.value.map((m) => [m.posting_date, m.title, m.category, m.fund, m.amount.toFixed(2), m.by])];
      const text = "\ufeff" + rows.map((r) => r.map((v) => '"' + String(v ?? "").replace(/"/g, '""') + '"').join(",")).join("\n");
      const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" })); a.download = "حركات المال " + month.value + ".csv"; a.click();
    };
    const fundNote = (f) => (f.type === "Cash" ? (f.last_closing ? "آخر إغلاق " + ago(f.last_closing.at.replace(" ", "T")) : "لم يُغلق بعد") : f.cheques ? f.cheques + " صك لم يُحصَّل" : "حساب بنكي");
    // end-of-day cash closing
    const cashFunds = computed(() => (d.value?.funds || []).filter((f) => f.type === "Cash"));
    const cl = ref(null), clBusy = ref(false);
    const openClose = () => { const f = cashFunds.value[0]; if (f) cl.value = { account: f.name, counted: "", note: "" }; };
    const clExpected = computed(() => (cl.value ? (d.value.funds.find((f) => f.name === cl.value.account)?.balance || 0) : 0));
    const clDiff = computed(() => (cl.value && cl.value.counted !== "" ? Math.round((+cl.value.counted - clExpected.value) * 100) / 100 : null));
    const doClose = async () => {
      clBusy.value = true;
      try { const r = await call("close_cash", { account: cl.value.account, counted: +cl.value.counted, note: cl.value.note }, true);
        toast(Math.abs(r.diff) < 0.01 ? "أُغلق الصندوق: لا فرق" : `أُغلق الصندوق: ${r.diff > 0 ? "زيادة" : "نقص"} ${fig(Math.abs(r.diff))} دج سُجّل في الحسابات`); cl.value = null; await load(); }
      catch (e) { toast(e.message, "error"); } finally { clBusy.value = false; }
    };
    // cheques waiting for the bank
    const clearing = ref(null);
    const clearCheque = async (c) => {
      clearing.value = c.name;
      try { await call("clear_cheque", { name: c.name }, true); toast(`حُصِّل صك ${c.reference_no || ""}`); await load(); }
      catch (e) { toast(e.message, "error"); } finally { clearing.value = null; }
    };
    const chequeTotal = computed(() => (d.value?.cheques || []).reduce((a, c) => a + c.amount, 0));
    const maxWeek = computed(() => Math.max(1, ...(d.value?.weeks || []).flatMap((w) => [w.in, w.out])));
    const maxCat = computed(() => Math.max(1, ...(d.value?.categories || []).map((c) => c.amount)));
    const catTotal = computed(() => (d.value?.categories || []).reduce((a, c) => a + c.amount, 0));
    const owed = computed(() => (d.value?.debtors || []).reduce((a, x) => a + x.amount, 0));
    const owe = computed(() => (d.value?.payables || []).reduce((a, x) => a + x.amount, 0));
    const CAT_COLORS = ["#F59E0B", "#2563EB", "#9B87F5", "#5C5670", "#1597A6", "#C2410C", "#22A06B", "#E5484D"];
    const fund = (type) => (d.value?.funds || []).filter((f) => f.type === type).reduce((a, f) => a + f.balance, 0);
    const pay = (c) => (state.sheet = { type: "payment", customer: c ? { name: c.customer, customer_name: c.customer_name } : null });
    const remind = (c) => {
      const l = waLink(c.mobile_no); if (!l) { toast("لا يوجد هاتف لهذا العميل", "error"); return; }
      const text = `السلام عليكم ${c.customer_name}،\nنذكّركم بأن المبلغ المتبقي هو ${fig(c.amount)} دج.\nشكرًا لثقتكم — ${state.boot.company_label || ""}`;
      window.open(l + "?text=" + encodeURIComponent(text), "_blank", "noopener");
    };
    // transfer between funds
    const tr = ref(null), trBusy = ref(false);
    const openTransfer = () => { const f = d.value.funds; tr.value = { from: f[0]?.name, to: f[1]?.name || f[0]?.name, amount: "", note: "" }; };
    const doTransfer = async () => {
      trBusy.value = true;
      try { await call("transfer_funds", { from_account: tr.value.from, to_account: tr.value.to, amount: +tr.value.amount, note: tr.value.note }, true); toast("تم التحويل"); tr.value = null; await load(); }
      catch (e) { toast(e.message, "error"); } finally { trBusy.value = false; }
    };
    // pay a supplier
    const paying = ref(null);
    const paySupplier = async (p, mode) => {
      paying.value = p.name;
      try { await call("pay_supplier", { invoice: p.name, mode_of_payment: mode }, true); toast(`دُفع ${fig(p.amount)} دج لـ ${p.supplier_name}`); await load(); }
      catch (e) { toast(e.message, "error"); } finally { paying.value = null; }
    };
    const supplierMode = ref("Cash");
    const prevName = computed(() => (d.value ? new Intl.DateTimeFormat("ar", { month: "long" }).format(new Date(parseDate(d.value.month).getFullYear(), parseDate(d.value.month).getMonth() - 1, 1)) : ""));
    const change = (now, prev) => { const p = pct(now, prev); return p === null ? `لا أرقام لشهر ${prevName.value}` : p === 0 ? `مثل ${prevName.value}` : `${p > 0 ? "أكثر" : "أقل"} بـ ${Math.abs(p)}% من ${prevName.value}`; };
    return { fundSel, days, dayLabel, KINDS, exportMoves, fundNote, cashFunds, cl, clBusy, openClose, clExpected, clDiff, doClose, clearing, clearCheque, chequeTotal, ago,
      change, s, load, d, offset, month, pct, kind, q, moves, maxWeek, maxCat, catTotal, owed, owe, CAT_COLORS, fund, pay, remind, tr, trBusy, openTransfer, doTransfer,
      paying, paySupplier, supplierMode, waLink, money, fig, date, dueWord, daysFromToday, state, go, t };
  },
  template: `
  <div class="cl mn">
    <div class="cl-main">
      <header class="cl-head">
        <div class="cl-head-row">
          <h1>المال</h1><span class="cl-count">للمدير فقط</span><span class="spacer"></span>
          <div class="mn-month" role="group" aria-label="الشهر">
            <button type="button" aria-label="الشهر السابق" @click="offset++"><Icon name="back" :size="16"/></button>
            <button type="button" class="mn-month-l" :aria-pressed="offset === 0" @click="offset = 0">{{ month }}</button>
            <button type="button" aria-label="الشهر التالي" :disabled="offset === 0" @click="offset > 0 && offset--"><Icon name="chev" :size="16"/></button></div>
          <div v-if="d && d.funds.length > 1" class="cl-pop-host"><button type="button" class="cl-btn" :aria-expanded="!!tr" @click.stop="tr ? (tr = null) : openTransfer()"><Icon name="sort" :size="16"/>تحويل</button>
            <form v-if="tr" class="cl-pop cl-filters" @click.stop @submit.prevent="doTransfer">
              <b>تحويل بين الصناديق</b>
              <label class="cl-fgroup"><span>من</span><select class="input" v-model="tr.from"><option v-for="f in d.funds" :key="f.name" :value="f.name">{{ f.label }} — {{ fig(f.balance) }}</option></select></label>
              <label class="cl-fgroup"><span>إلى</span><select class="input" v-model="tr.to"><option v-for="f in d.funds" :key="f.name" :value="f.name">{{ f.label }}</option></select></label>
              <label class="cl-fgroup"><span>المبلغ</span><div class="unit-wrap"><input class="input num" inputmode="decimal" v-model="tr.amount" placeholder="0"><span class="u">دج</span></div></label>
              <label class="cl-fgroup"><span>ملاحظة</span><input class="input" v-model="tr.note" placeholder="اختياري"></label>
              <div class="cl-pop-foot"><button type="button" class="cl-link" @click="tr = null">إلغاء</button><button type="submit" class="cl-btn primary" :disabled="trBusy || !(+tr.amount > 0) || tr.from === tr.to">تحويل</button></div></form></div>
          <button v-if="d && cashFunds.length" type="button" class="cl-btn" :aria-pressed="!!cl" @click="cl ? (cl = null) : openClose()"><Icon name="check" :size="16"/>إغلاق الصندوق</button>
          <button v-if="state.boot.can.expense" type="button" class="cl-btn" @click="state.sheet = {type: 'expense'}"><Icon name="out" :size="16"/>مصروف</button>
          <button v-if="state.boot.can.payment" type="button" class="cl-btn primary" @click="pay()"><Icon name="in" :size="16"/>تسجيل دخل</button>
        </div>
      </header>
      <div v-if="s.loading && !s.data" class="ws-loading">جارٍ التحميل…</div>
      <div v-else-if="s.error" class="alert error" style="margin:20px 28px">{{ s.error }}</div>
      <template v-else-if="d">
        <div class="mn-funds" role="group" aria-label="الصناديق">
          <button type="button" class="mn-fund" :aria-pressed="!fundSel" @click="fundSel = null"><span>كل الصناديق</span><b class="money">{{ money(d.cash_balance) }}</b><small>{{ d.funds.length }} {{ d.funds.length === 1 ? 'صندوق' : 'صناديق' }}</small></button>
          <button v-for="f in d.funds" :key="f.name" type="button" class="mn-fund" :aria-pressed="fundSel === f.name" :title="'عرض حركات ' + f.label + ' فقط'" @click="fundSel = fundSel === f.name ? null : f.name">
            <span>{{ f.label }}</span><b class="money">{{ fig(f.balance) }}</b><small :class="{warn: f.cheques}">{{ fundNote(f) }}</small></button>
        </div>
        <div class="cl-stats mn-stats mn-stats3">
          <div><span>دخل {{ offset ? 'الشهر' : 'هذا الشهر' }}</span><b class="money ok">{{ money(d.income) }}</b><small>{{ change(d.income, d.prev_income) }}</small></div>
          <div><span>خرج من الصناديق {{ offset ? 'في الشهر' : 'هذا الشهر' }}</span><b class="money bad">{{ money(d.expenses) }}</b>
            <small>مصاريف مسجّلة {{ fig(catTotal) }}<template v-if="catTotal - d.expenses > 0.005"> · منها {{ fig(catTotal - d.expenses) }} لم تُدفع بعد</template></small></div>
          <div><span>الصافي في الصناديق</span><b class="money" :class="{bad: d.profit < 0}">{{ money(d.profit) }}</b><small>ما دخل ناقص ما خرج</small></div>
        </div>

        <form v-if="cl" class="mn-card mn-close" @submit.prevent="doClose">
          <div class="mn-card-h"><b>إغلاق الصندوق</b><button type="button" class="cl-btn icon ghost sm" aria-label="إلغاء" @click="cl = null"><Icon name="x" :size="16"/></button></div>
          <div class="mn-close-b">
            <label v-if="cashFunds.length > 1" class="cl-fgroup"><span>الصندوق</span><select class="input" v-model="cl.account"><option v-for="f in cashFunds" :key="f.name" :value="f.name">{{ f.label }}</option></select></label>
            <div class="mn-close-n"><span class="muted">يجب أن يكون فيه</span><b class="money">{{ money(clExpected) }}</b></div>
            <label class="cl-fgroup"><span>المبلغ المعدود فعلًا</span><div class="unit-wrap"><input id="cl-count" class="input num" inputmode="decimal" v-model="cl.counted" placeholder="0" autocomplete="off"><span class="u">دج</span></div></label>
            <div class="mn-close-n"><span class="muted">الفرق</span>
              <b :class="clDiff === null ? '' : Math.abs(clDiff) < 0.01 ? 'ok' : 'bad'">{{ clDiff === null ? '—' : Math.abs(clDiff) < 0.01 ? 'لا فرق' : (clDiff > 0 ? 'زيادة ' : 'نقص ') + fig(Math.abs(clDiff)) + ' دج' }}</b></div>
            <label class="cl-fgroup grow"><span>ملاحظة</span><input class="input" v-model="cl.note" placeholder="اختياري: سبب الفرق"></label>
          </div>
          <div class="mn-foot row" style="gap:8px;justify-content:space-between;flex-wrap:wrap"><span class="muted">إن وُجد فرق يُسجَّل في الحسابات، فيصبح رصيد الصندوق مطابقًا لما في الدرج.</span>
            <button type="submit" class="cl-btn primary" :disabled="clBusy || cl.counted === '' || !(+cl.counted >= 0)">{{ clBusy ? 'جارٍ…' : 'إغلاق الصندوق' }}</button></div>
        </form>

        <div class="mn-grid">
          <div class="mn-col">
            <section class="mn-card"><div class="mn-card-h"><b>الحركات<template v-if="fundSel"> · {{ d.funds.find(f => f.name === fundSel)?.label }}</template></b>
                <span class="row" style="gap:8px;flex-wrap:wrap"><span class="cl-seg"><button v-for="k in KINDS" :key="k[0]" type="button" :aria-pressed="kind === k[0]" @click="kind = k[0]">{{ k[1] }}</button></span>
                  <label class="cl-search mn-search"><Icon name="search" :size="14"/><span class="sr-only">بحث في الحركات</span><input type="search" v-model="q" placeholder="بحث"></label>
                  <button type="button" class="cl-btn sm" :disabled="!moves.length" @click="exportMoves"><Icon name="file" :size="14"/>Excel</button></span></div>
              <div v-if="!moves.length" class="mn-empty">لا حركات<template v-if="fundSel || kind !== 'all' || q"> تطابق الاختيار</template>.</div>
              <template v-for="g in days" :key="g.k">
                <div class="mn-day"><span>{{ dayLabel(g.k) }}</span><span class="spacer"></span><b :class="g.total >= 0 ? 'ok' : 'bad'">{{ g.total >= 0 ? '+' : '−' }}{{ fig(Math.abs(g.total)) }}</b></div>
                <div v-for="m in g.items" :key="m.voucher_no" class="mn-mv">
                  <span class="mn-ic" :class="m.kind" aria-hidden="true">{{ m.kind === 'in' ? '↓' : m.kind === 'out' ? '↑' : '⇄' }}</span>
                  <div style="min-width:0"><span class="cl-name">{{ m.title }}<Icon v-if="m.files" name="file" :size="13" class="mn-clip"/></span>
                    <span class="muted mn-sub">{{ m.category }}<template v-if="m.ref"> · صك {{ m.ref }}</template><template v-if="m.order"> · <a :href="'/atelier/?card=' + m.order" @click.prevent="go('/?card=' + encodeURIComponent(m.order))">{{ m.order_title || m.order }}</a></template> · {{ [m.fund, m.by].filter(Boolean).join(' · ') }}</span></div>
                  <span class="mn-amt" :class="m.kind">{{ m.kind === 'transfer' ? '' : m.amount >= 0 ? '+' : '−' }}{{ fig(Math.abs(m.amount)) }}</span>
                </div>
              </template>
            </section>
          </div>
          <div class="mn-col">
            <section class="mn-card"><div class="mn-card-h"><b>شيكات لم تُحصَّل</b><b v-if="d.cheques.length" class="warn">{{ money(chequeTotal) }}</b></div>
              <div v-if="!d.cheques.length" class="mn-empty">لا شيكات تنتظر البنك. سجّل الصك من «تسجيل دخل» بطريقة «صك».</div>
              <div v-for="c in d.cheques" :key="c.name" class="mn-line">
                <div class="mn-who" style="cursor:default"><span class="cl-name">{{ c.party_name }}</span>
                  <span class="muted">صك {{ c.reference_no || '—' }} · {{ date(c.reference_date || c.posting_date) }}</span></div>
                <b>{{ fig(c.amount) }}</b>
                <button type="button" class="cl-btn sm" :disabled="clearing === c.name" @click="clearCheque(c)">{{ clearing === c.name ? '…' : 'حُصِّل' }}</button></div>
            </section>
            <section class="mn-card"><div class="mn-card-h"><b>لنا عند العملاء</b><b class="bad">{{ money(owed) }}</b></div>
              <div v-if="owed > 0.005" class="mn-ages">
                <div><span class="muted">حتى 30 يومًا</span><b>{{ fig(d.ages.a) }}</b></div>
                <div><span class="muted">31–60 يومًا</span><b class="warn">{{ fig(d.ages.b) }}</b></div>
                <div><span class="muted">أكثر من 60</span><b class="bad">{{ fig(d.ages.c) }}</b></div></div>
              <div v-if="!d.debtors.length" class="mn-empty">لا أحد عليه دين.</div>
              <div v-for="c in d.debtors" :key="c.customer" class="mn-line">
                <button type="button" class="mn-who" :title="'تسجيل دفعة من ' + c.customer_name" @click="pay(c)"><span class="cl-name">{{ c.customer_name }}</span><span class="muted" :class="{bad: c.late}">{{ c.late ? 'متأخر ' + c.late + ' يومًا' : 'لم يحن موعده' }}</span></button>
                <b class="bad">{{ fig(c.amount) }}</b>
                <button v-if="waLink(c.mobile_no)" type="button" class="cl-btn sm" :aria-label="'تذكير ' + c.customer_name + ' بواتساب'" @click="remind(c)">تذكير</button></div>
              <div class="mn-foot muted">اضغط على الاسم لتسجيل دفعة.</div></section>
            <section class="mn-card"><div class="mn-card-h"><b>علينا للموردين</b><b class="warn">{{ money(owe) }}</b></div>
              <div v-if="!d.payables.length" class="mn-empty">لا ديون للموردين.</div>
              <div v-for="p in d.payables" :key="p.name" class="mn-line">
                <div class="mn-who" style="cursor:default"><span class="cl-name">{{ p.supplier_name }}</span>
                  <span class="muted" style="white-space:normal">{{ p.what }}<template v-if="p.due_date"> · <span :class="{bad: daysFromToday(p.due_date) < 0}">{{ daysFromToday(p.due_date) < 0 ? 'متأخر ' + -daysFromToday(p.due_date) + ' يومًا' : 'يستحق ' + dueWord(p.due_date) }}</span></template></span></div>
                <b>{{ fig(p.amount) }}</b>
                <button v-if="state.boot.can.payment" type="button" class="cl-btn sm" :disabled="paying === p.name" @click="paySupplier(p, supplierMode)">{{ paying === p.name ? '…' : 'دفع' }}</button></div>
              <label v-if="d.payables.length && d.modes.length > 1" class="mn-foot row" style="gap:8px"><span class="muted">طريقة الدفع للمورد</span>
                <select class="input" style="width:auto;min-height:32px" v-model="supplierMode"><option v-for="m in d.modes" :key="m.value" :value="m.value">{{ m.label }}</option></select></label></section>
            <section class="mn-card"><div class="mn-card-h"><b>أين يذهب المال</b><span class="muted">{{ month }}</span></div>
              <div v-if="!d.categories.length" class="mn-empty">لا مصاريف مسجّلة هذا الشهر.</div>
              <div v-for="c in d.categories" :key="c.name" class="mn-cat">
                <div class="row" style="justify-content:space-between;gap:8px"><span class="ellipsis">{{ c.name }}</span><span><b>{{ fig(c.amount) }}</b> <span class="muted">{{ Math.round(c.amount / catTotal * 100) }}%</span></span></div>
                <div class="mn-catbar"><span :style="{width: (c.amount / maxCat * 100) + '%'}"></span></div></div></section>
            <section v-if="d.closings.length" class="mn-card"><div class="mn-card-h"><b>آخر إغلاقات الصندوق</b></div>
              <div v-for="(c, i) in d.closings" :key="i" class="mn-line">
                <div class="mn-who" style="cursor:default"><span class="cl-name">{{ c.label }}</span><span class="muted">{{ c.at }} · {{ c.by }}<template v-if="c.note"> · {{ c.note }}</template></span></div>
                <b :class="Math.abs(c.diff) < 0.01 ? 'ok' : 'bad'">{{ Math.abs(c.diff) < 0.01 ? 'مطابق' : (c.diff > 0 ? '+' : '−') + fig(Math.abs(c.diff)) }}</b></div></section>
          </div>
        </div>
      </template>
    </div>
  </div>`,
};
// ------------------------------------------------------------------ suppliers, classic
const SuppliersPage = {
  props: ["openId"], components: { Icon, Avatar },
  setup(props) {
    const { s, load } = useLoad(() => call("suppliers2"));
    onMounted(load);
    const sel = ref(props.openId || state.query.get("s") || null), d = ref(null), err = ref(null), tab = ref("invoices"), busy = ref(null);
    watch(() => state.rev, () => { load(); if (sel.value) open(sel.value, true); });
    const q = ref(""), filter = ref("all"), more = ref(false), pmenu = ref(false);
    const FILTERS = [["all", "الكل"], ["owe", "علينا لهم"], ["late", "متأخر"], ["off", "موقوفون"]];
    const all = computed(() => (s.data?.rows || []));
    const rows = computed(() => all.value.filter((x) => (filter.value === "off" ? x.disabled : !x.disabled))
      .filter((x) => filter.value !== "owe" || x.owe > 0.005).filter((x) => filter.value !== "late" || x.late > 0)
      .filter((x) => !q.value || (x.supplier_name + " " + (x.atelier_phone || "") + " " + (x.atelier_supplies || "")).toLowerCase().includes(q.value.trim().toLowerCase()))
      .sort((a, b) => b.late - a.late || b.owe - a.owe || a.supplier_name.localeCompare(b.supplier_name, "ar")));
    const active = computed(() => all.value.filter((x) => !x.disabled));
    const kpi = computed(() => ({ total: active.value.length, busy: active.value.filter((x) => x.month > 0).length,
      owe: active.value.reduce((a, x) => a + x.owe, 0), invoices: active.value.reduce((a, x) => a + x.open_invoices, 0),
      late: active.value.reduce((a, x) => a + x.late_amount, 0), lateN: active.value.filter((x) => x.late > 0).length,
      month: active.value.reduce((a, x) => a + x.month, 0) }));
    const change = (now, prev) => { if (!(prev > 0.005)) return "لا مشتريات الشهر الماضي"; const p = Math.round(((now - prev) / prev) * 100); return p === 0 ? "مثل الشهر الماضي" : `${p > 0 ? "أكثر" : "أقل"} بـ ${Math.abs(p)}% من الشهر الماضي`; };
    async function open(name, keep) { sel.value = name; err.value = null; if (!keep) { tab.value = "payments"; d.value = null; form.value = null; hf.value = "all"; window.scrollTo(0, 0); }
      try { d.value = await call("supplier2", { name }); } catch (e) { err.value = e.message; } }
    const lastWord = (iso) => { if (!iso) return "—"; const n = -daysFromToday(iso); return n <= 0 ? "اليوم" : n === 1 ? "أمس" : n === 2 ? "منذ يومين" : n < 30 ? `منذ ${n} أيام` : date(iso); };
    const closeMenus = () => { more.value = false; pmenu.value = false; };
    onMounted(() => window.addEventListener("click", closeMenus));
    onBeforeUnmount(() => window.removeEventListener("click", closeMenus));
    const exportList = () => { more.value = false;
      const text = "﻿" + [["المورد", "ما نشتريه", "الهاتف", "آخر شراء", "علينا"], ...rows.value.map((x) => [x.supplier_name, x.atelier_supplies || "", x.atelier_phone || "", x.last || "", x.owe.toFixed(2)])]
        .map((r) => r.map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(",")).join("\n");
      const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" })); a.download = "الموردون.csv"; a.click(); };
    // forms in the profile: edit / new supplier, purchase order, supplier invoice, payment
    const form = ref(null), mode = ref("Cash");
    const run = async (key, fn, msg) => { busy.value = key; err.value = null; try { const r = await fn(); if (msg) toast(msg); return r; } catch (e) { err.value = e.message; } finally { busy.value = null; } };
    const newSupplier = () => { window.scrollTo(0, 0); sel.value = "__new"; d.value = { payments: [], name: null, supplier_name: "", supplies: "", phone: "", email: "", address: "", tax_id: "", rc: "", note: "", invoices: [], orders: [], items: [], accounts: [], open_orders: [], can_edit: true }; form.value = { kind: "edit", ...d.value }; };
    const edit = () => { pmenu.value = false; form.value = { kind: "edit", name: d.value.name, supplier_name: d.value.supplier_name, supplies: d.value.supplies, phone: d.value.phone, email: d.value.email, address: d.value.address, tax_id: d.value.tax_id, rc: d.value.rc, note: d.value.note }; };
    const saveSupplier = () => run("save", async () => { const n = await call("save_supplier", { data: JSON.stringify(form.value) }, true); form.value = null; await load(); await open(n); }, "حُفظ المورد");
    const newPO = () => { form.value = { kind: "po", description: "", amount: "", order: "", schedule_date: "" }; };
    const savePO = () => run("po", async () => { await call("create_purchase_order", { supplier: d.value.name, description: form.value.description, amount: +form.value.amount, order: form.value.order || null, schedule_date: form.value.schedule_date || null }, true); form.value = null; tab.value = "orders"; await open(d.value.name, true); load(); }, "أُرسل طلب الشراء");
    const newInvoice = (po) => { form.value = { kind: "inv", description: po ? po.what : "", amount: po ? po.grand_total : "", account: d.value.accounts[0]?.name || "", order: "", bill_no: "", due_date: "", purchase_order: po ? po.name : null }; };
    const saveInvoice = () => run("inv", async () => { const f = form.value;
      await call("create_supplier_invoice", { supplier: d.value.name, description: f.description, amount: +f.amount, account: f.account || null, order: f.order || null, bill_no: f.bill_no, due_date: f.due_date || null, purchase_order: f.purchase_order }, true);
      form.value = null; tab.value = "invoices"; await open(d.value.name, true); load(); }, "سُجّلت فاتورة المورد");
    const payInvoice = (inv) => { if (!confirm(`دفع ${fig(inv.outstanding_amount)} دج لـ ${d.value.supplier_name} عن ${inv.bill_no || inv.name}؟`)) return;
      return run("pay", async () => { await call("pay_supplier", { invoice: inv.name, mode_of_payment: mode.value }, true); await open(d.value.name, true); load(); }, "سُجّل الدفع"); };
    const oldest = computed(() => (d.value?.invoices || []).filter((i) => i.outstanding_amount > 0.005).sort((a, b) => String(a.due_date || "").localeCompare(String(b.due_date || "")))[0]);
    const toggleDisabled = () => { pmenu.value = false; return run("off", async () => { await call("set_supplier_disabled", { name: d.value.name, disabled: d.value.disabled ? 0 : 1 }, true); await open(d.value.name, true); load(); }, d.value.disabled ? "أُعيد تفعيل المورد" : "أُوقف المورد"); };
    const invState = (i) => (i.outstanding_amount <= 0.005 ? ["مدفوعة", "#12B76A"] : i.late ? [`متأخرة ${i.late} يومًا`, "#D92D20"] : ["مفتوحة", "#F79009"]);
    const poState = (o) => (o.per_billed >= 100 ? ["مفوتر", "#12B76A"] : o.per_billed > 0 ? ["مفوتر جزئيًا", "#F79009"] : ["بانتظار الفاتورة", "#2E90FA"]);
    const TABS = [["payments", "الدفعات"], ["items", "ما اشتريناه منه"], ["data", "البيانات"]];
    // list: one-click filters, including what we buy from them
    const supplies = computed(() => { const c = {}; all.value.filter((x) => !x.disabled && x.atelier_supplies).forEach((x) => { const k = x.atelier_supplies.split(/[،,]/)[0].trim(); if (k) c[k] = (c[k] || 0) + 1; });
      return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 4); });
    const sup = ref("");
    const shown = computed(() => rows.value.filter((x) => !sup.value || (x.atelier_supplies || "").includes(sup.value)));
    const chips = computed(() => [
      { k: "all", t: "الكل", n: active.value.length, on: filter.value === "all" && !sup.value, run: () => { filter.value = "all"; sup.value = ""; } },
      { k: "owe", t: "علينا لهم", n: active.value.filter((x) => x.owe > 0.005).length, on: filter.value === "owe", run: () => { filter.value = "owe"; sup.value = ""; } },
      { k: "late", t: "متأخر الدفع", n: active.value.filter((x) => x.late > 0).length, on: filter.value === "late", run: () => { filter.value = "late"; sup.value = ""; }, debt: 1 },
      ...supplies.value.map(([k, n]) => ({ k: "s:" + k, t: k, n, on: sup.value === k, run: () => { filter.value = "all"; sup.value = sup.value === k ? "" : k; } })),
    ]);
    const week = computed(() => { const l = active.value.filter((x) => x.week > 0.005); return { amount: l.reduce((a, x) => a + x.week, 0), who: l.map((x) => x.supplier_name) }; });
    const closeSupplier = () => { sel.value = null; d.value = null; form.value = null; nextTick(() => window.scrollTo(0, 0)); };
    // supplier page: everything bought from them, in one table
    const hf = ref("all");
    const history = computed(() => {
      if (!d.value) return [];
      const inv = (d.value.invoices || []).map((i) => ({ key: i.name, kind: "inv", date: i.posting_date, what: i.what || (i.bill_no ? "فاتورة " + i.bill_no : i.name), ref: i.bill_no,
        order: i.order_name, order_title: i.order_title, amount: i.grand_total, left: i.outstanding_amount, due: i.due_date, late: i.late, src: i }));
      const po = (d.value.orders || []).filter((o) => o.per_billed < 100).map((o) => ({ key: o.name, kind: "po", date: o.transaction_date, what: o.what || o.name, ref: o.name,
        order: o.order_name, order_title: o.order_title, amount: o.grand_total, left: null, due: o.schedule_date, src: o }));
      return [...inv, ...po].filter((x) => hf.value === "all" || (hf.value === "open" ? x.kind === "inv" && x.left > 0.005 : x.kind === "po"))
        .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    });
    const openPOs = computed(() => (d.value?.orders || []).filter((o) => o.per_billed < 100).length);
    const openInvoices = computed(() => (d.value?.invoices || []).filter((i) => i.outstanding_amount > 0.005));
    if (sel.value) open(sel.value);
    return { s, load, sel, d, err, tab, busy, q, filter, more, pmenu, FILTERS, rows, kpi, change, open, lastWord, exportList, form, mode, newSupplier, edit, saveSupplier,
      newPO, savePO, newInvoice, saveInvoice, payInvoice, oldest, toggleDisabled, invState, poState, TABS, waLink, money, fig, date, dueWord, state, go,
      active, chips, shown, sup, week, closeSupplier, hf, history, openPOs, openInvoices };
  },
  template: `
  <div class="cl">
    <div v-if="!sel" class="cl-main">
      <header class="cl-head"><div class="cl-head-row">
        <h1>الموردون</h1><span class="cl-count" v-if="s.data">{{ shown.length }} {{ shown.length === 1 ? 'مورد' : 'موردين' }}</span><span class="spacer"></span>
        <label class="cl-search"><Icon name="search" :size="16"/><span class="sr-only">بحث</span><input type="search" v-model="q" placeholder="ابحث بالاسم أو ما نشتريه"></label>
        <div class="cl-pop-host"><button type="button" class="cl-btn icon" aria-label="المزيد" :aria-expanded="more" @click.stop="more = !more"><Icon name="more" :size="18"/></button>
          <div v-if="more" class="cl-pop cl-menu" @click.stop><button type="button" @click="exportList"><Icon name="file" :size="16"/>تصدير القائمة (Excel)</button>
            <button type="button" @click="more = false; filter = 'off'; sup = ''">الموردون الموقوفون</button></div></div>
        <button type="button" class="cl-btn primary" @click="newSupplier"><Icon name="plus" :size="16"/>مورد جديد</button></div>
        <div v-if="s.data" class="cl-quick" role="group" aria-label="تصفية سريعة">
          <button v-for="c in chips" :key="c.k" type="button" class="bd-chip" :class="{debt: c.debt}" :aria-pressed="c.on" @click="c.run()">{{ c.t }} <span class="cl-quick-n">{{ c.n }}</span></button>
          <button v-if="filter === 'off'" type="button" class="bd-chip" aria-pressed="true" @click="filter = 'all'">الموقوفون ×</button></div>
      </header>
      <div v-if="s.loading && !s.data" class="ws-loading">جارٍ التحميل…</div>
      <div v-else-if="s.error" class="alert error" style="margin:20px 28px">{{ s.error }}</div>
      <template v-else-if="s.data">
        <div class="cl-stats mn-stats3">
          <button type="button" @click="filter = 'owe'; sup = ''"><span>علينا للموردين</span><b class="money" style="color:#B54708">{{ money(kpi.owe) }}</b><small>{{ active.filter(x => x.owe > 0.005).length }} موردين<template v-if="kpi.lateN"> · {{ kpi.lateN }} متأخرون</template></small></button>
          <button type="button" style="cursor:default"><span>يستحق هذا الأسبوع</span><b class="money">{{ money(week.amount) }}</b><small class="ellipsis">{{ week.who.length ? week.who.join('، ') : 'لا شيء يستحق' }}</small></button>
          <button type="button" style="cursor:default"><span>اشترينا هذا الشهر</span><b class="money">{{ money(kpi.month) }}</b><small>{{ change(kpi.month, s.data.prev_month) }}</small></button>
        </div>
        <div class="cl-table-wrap"><table class="cl-table cl-table2">
          <thead><tr><th>المورد</th><th class="desktop-only">ما نشتريه منه</th><th class="desktop-only">آخر شراء</th><th class="n">علينا له</th></tr></thead>
          <tbody>
            <tr v-if="!shown.length"><td colspan="4" class="cl-empty">{{ (s.data.rows || []).length ? 'لا موردين يطابقون البحث أو التصفية.' : 'لا موردين بعد. أضف أول مورد.' }}</td></tr>
            <tr v-for="x in shown" :key="x.name" :class="{off: x.disabled}" tabindex="0" @click="open(x.name)" @keydown.enter="open(x.name)">
              <td><div class="cl-who"><Avatar :name="x.supplier_name" :size="36"/><div style="min-width:0"><span class="cl-name">{{ x.supplier_name }}</span>
                <span class="cl-sub"><span v-if="x.atelier_phone" dir="ltr">{{ x.atelier_phone }}</span><template v-else>—</template></span></div></div></td>
              <td class="desktop-only"><span v-if="x.atelier_supplies" class="cp-stage">{{ x.atelier_supplies }}</span><span v-else class="muted">—</span></td>
              <td class="desktop-only muted">{{ lastWord(x.last) }}</td>
              <td class="n"><span v-if="x.owe > 0.005" class="cl-bal" :class="x.late ? 'bad' : 'warn-b'"><i></i>{{ money(x.owe) }}</span><span v-else class="cl-bal">خالص</span>
                <span v-if="x.late" class="cl-late">متأخر {{ x.late }} {{ x.late === 1 ? 'يوم' : 'أيام' }}</span></td>
            </tr></tbody></table></div>
      </template>
    </div>

    <div v-else class="cp">
      <div v-if="!d" class="ws-loading">{{ err || 'جارٍ التحميل…' }}</div>
      <template v-else>
        <header v-if="d.name" class="cp-card cp-head">
          <button type="button" class="cl-btn icon cp-back" aria-label="العودة إلى الموردين" title="الموردون" @click="closeSupplier"><Icon name="back" :size="16"/></button>
          <div class="cp-id">
            <h1>{{ d.supplier_name }}<span v-if="d.disabled" class="cp-type">موقوف</span></h1>
            <span class="muted">{{ [d.supplies, d.phone, d.tax_id ? 'NIF ' + d.tax_id : ''].filter(Boolean).join(' · ') || 'مورد' }}</span>
          </div>
          <div class="cp-acts">
            <a v-if="d.phone" class="cl-btn" :href="'tel:' + d.phone"><Icon name="phone" :size="15"/>اتصال</a>
            <div class="cl-pop-host"><button type="button" class="cl-btn icon" aria-label="المزيد" :aria-expanded="pmenu" @click.stop="pmenu = !pmenu"><Icon name="more" :size="18"/></button>
              <div v-if="pmenu" class="cl-pop cl-menu" @click.stop>
                <a v-if="waLink(d.phone)" class="cp-menu-a" target="_blank" rel="noopener" :href="waLink(d.phone)" @click="pmenu = false"><Icon name="msg" :size="16"/>واتساب</a>
                <button v-if="d.can_edit" type="button" @click="edit"><Icon name="edit" :size="16"/>تعديل بيانات المورد</button>
                <button v-if="d.can_edit" type="button" @click="toggleDisabled">{{ d.disabled ? 'إعادة تفعيل المورد' : 'إيقاف المورد' }}</button></div></div>
            <button v-if="state.boot.can.expense" type="button" class="cl-btn" @click="newPO"><Icon name="plus" :size="15"/>أمر شراء</button>
            <button type="button" class="cl-btn" @click="newInvoice(null)"><Icon name="file" :size="15"/>فاتورة مورد</button>
            <button v-if="oldest && state.boot.can.payment" type="button" class="cl-btn primary" :disabled="busy === 'pay'" @click="payInvoice(oldest)">دفعت له</button>
          </div>
        </header>
        <div v-if="err" class="alert error">{{ err }}</div>

        <form v-if="form && form.kind === 'edit'" class="cp-card cp-pad cp-form" @submit.prevent="saveSupplier">
          <b>{{ form.name ? 'تعديل المورد' : 'مورد جديد' }}</b>
          <div class="cp-form-grid">
            <label class="cl-fgroup"><span>الاسم *</span><input class="input" v-model="form.supplier_name" required></label>
            <label class="cl-fgroup"><span>ما نشتريه منه</span><input class="input" v-model="form.supplies" placeholder="ورق، حبر، طباعة أوفست، نقل…"></label>
            <label class="cl-fgroup"><span>الهاتف</span><input class="input" v-model="form.phone" dir="ltr" inputmode="tel"></label>
            <label class="cl-fgroup"><span>البريد</span><input class="input" v-model="form.email" dir="ltr" type="email"></label>
            <label class="cl-fgroup"><span>العنوان</span><input class="input" v-model="form.address"></label>
            <label class="cl-fgroup"><span>الرقم الجبائي NIF</span><input class="input" v-model="form.tax_id" dir="ltr"></label>
            <label class="cl-fgroup"><span>السجل التجاري RC</span><input class="input" v-model="form.rc" dir="ltr"></label>
            <label class="cl-fgroup"><span>ملاحظة</span><input class="input" v-model="form.note"></label></div>
          <div class="row" style="gap:8px"><button type="submit" class="cl-btn primary" :disabled="busy === 'save' || !form.supplier_name.trim()">حفظ المورد</button><button type="button" class="cl-btn" @click="form = null; if (!d.name) closeSupplier()">إلغاء</button></div>
        </form>

        <template v-if="d.name">
          <form v-if="form && form.kind === 'po'" class="cp-card cp-pad cp-form" @submit.prevent="savePO">
            <b>أمر شراء جديد</b>
            <div class="cp-form-grid">
              <label class="cl-fgroup"><span>ما نطلبه *</span><input class="input" v-model="form.description" placeholder="مثلًا: طباعة أوفست 5000 مطوية"></label>
              <label class="cl-fgroup"><span>المبلغ *</span><div class="unit-wrap"><input class="input num" v-model="form.amount" inputmode="decimal"><span class="u">دج</span></div></label>
              <label class="cl-fgroup"><span>موعد الاستلام</span><input class="input" type="date" v-model="form.schedule_date"></label>
              <label class="cl-fgroup"><span>لأي طلب (تُحسب في ربحه)</span><select class="input" v-model="form.order"><option value="">بدون طلب</option><option v-for="o in d.open_orders" :key="o.name" :value="o.name">{{ (o.atelier_subject || o.name) + ' — ' + o.customer_name }}</option></select></label></div>
            <div class="row" style="gap:8px"><button type="submit" class="cl-btn primary" :disabled="busy === 'po' || !form.description.trim() || !(+form.amount > 0)">إرسال أمر الشراء</button><button type="button" class="cl-btn" @click="form = null">إلغاء</button></div>
          </form>
          <form v-if="form && form.kind === 'inv'" class="cp-card cp-pad cp-form" @submit.prevent="saveInvoice">
            <b>فاتورة مورد{{ form.purchase_order ? ' — من أمر الشراء ' + form.purchase_order : '' }}</b>
            <div class="cp-form-grid">
              <template v-if="!form.purchase_order">
                <label class="cl-fgroup"><span>البيان *</span><input class="input" v-model="form.description"></label>
                <label class="cl-fgroup"><span>المبلغ *</span><div class="unit-wrap"><input class="input num" v-model="form.amount" inputmode="decimal"><span class="u">دج</span></div></label>
                <label class="cl-fgroup"><span>النوع</span><select class="input" v-model="form.account"><option v-for="a in d.accounts" :key="a.name" :value="a.name">{{ a.account_name }}</option></select></label>
                <label class="cl-fgroup"><span>لأي طلب (اختياري)</span><select class="input" v-model="form.order"><option value="">بدون طلب</option><option v-for="o in d.open_orders" :key="o.name" :value="o.name">{{ (o.atelier_subject || o.name) + ' — ' + o.customer_name }}</option></select></label>
              </template>
              <span v-else class="muted">{{ form.description }} · {{ money(form.amount) }}</span>
              <label class="cl-fgroup"><span>رقم فاتورة المورد</span><input class="input" v-model="form.bill_no" dir="ltr"></label>
              <label class="cl-fgroup"><span>تاريخ الاستحقاق</span><input class="input" type="date" v-model="form.due_date"></label></div>
            <div class="row" style="gap:8px"><button type="submit" class="cl-btn primary" :disabled="busy === 'inv' || (!form.purchase_order && (!form.description.trim() || !(+form.amount > 0)))">تسجيل الفاتورة</button><button type="button" class="cl-btn" @click="form = null">إلغاء</button></div>
          </form>

          <div class="cp-card cp-acc">
            <div><span class="muted">علينا له الآن</span><b :class="d.owe > 0.005 ? 'bad' : 'ok'">{{ d.owe > 0.005 ? money(d.owe) : 'لا شيء' }}</b>
              <span v-if="openInvoices.length" class="muted">{{ openInvoices.length }} {{ openInvoices.length === 1 ? 'فاتورة غير مدفوعة' : 'فواتير غير مدفوعة' }}<template v-if="oldest && oldest.late"> · أقدمها متأخرة {{ oldest.late }} يومًا</template></span>
              <label v-if="oldest && state.boot.modes.length > 1" class="muted row" style="gap:6px;margin-top:4px">الدفع من <select class="input" style="width:auto;min-height:30px;height:30px" v-model="mode"><option v-for="m in state.boot.modes" :key="m.value" :value="m.value">{{ m.label }}</option></select></label></div>
            <div><span class="muted">أقرب استحقاق</span><b>{{ oldest ? (oldest.late ? 'متأخر' : dueWord(oldest.due_date) || '—') : '—' }}</b><span class="muted">{{ oldest ? fig(oldest.outstanding_amount) + ' دج' : 'لا فواتير مفتوحة' }}</span></div>
            <div><span class="muted">دفعنا له هذه السنة</span><b>{{ money(d.year_paid || 0) }}</b><span class="muted">من مشتريات {{ fig(d.year_bought || 0) }} دج</span></div>
            <div><span class="muted">أوامر شراء مفتوحة</span><b>{{ openPOs }}</b><span class="muted">{{ openPOs ? 'لم تصل فاتورتها بعد' : 'لا شيء ينتظر' }}</span></div>
          </div>

          <section class="cp-card cp-hist" aria-label="التعامل معه">
            <div class="cp-hist-head"><h2>التعامل معه</h2><span class="spacer"></span>
              <div class="seg" role="group" aria-label="تصفية"><button v-for="x in [['all', 'الكل'], ['open', 'غير مدفوع'], ['po', 'أوامر شراء']]" :key="x[0]" type="button" :aria-pressed="hf === x[0]" @click="hf = x[0]">{{ x[1] }}</button></div></div>
            <div v-if="!history.length" class="muted cp-pad">{{ hf === 'all' ? 'لا تعامل بعد. سجّل أمر شراء أو فاتورة مورد.' : 'لا شيء هنا.' }}</div>
            <div v-else class="cp-tbl-wrap"><table class="cl-table cp-tbl sp-tbl">
              <thead><tr><th>التاريخ</th><th>البيان</th><th class="desktop-only">النوع</th><th class="desktop-only">لطلب</th><th class="n desktop-only">المبلغ</th><th class="n">الباقي</th><th>الاستحقاق</th><th><span class="sr-only">إجراء</span></th></tr></thead>
              <tbody><tr v-for="x in history" :key="x.key" class="sp-row">
                <td class="muted cp-nowrap sp-c-date">{{ date(x.date) }}</td>
                <td class="sp-c-what"><b class="cp-job-n">{{ x.what }}</b><span v-if="x.ref && x.kind === 'inv'" class="cl-sub">فاتورة رقم {{ x.ref }}</span></td>
                <td class="desktop-only"><span class="cp-stage">{{ x.kind === 'inv' ? 'فاتورة' : 'أمر شراء' }}</span></td>
                <td class="desktop-only"><a v-if="x.order" :href="'/atelier/?card=' + x.order" @click.prevent="go('/?card=' + encodeURIComponent(x.order))" class="cp-final">{{ x.order_title || x.order }}</a><span v-else class="muted">—</span></td>
                <td class="n desktop-only cp-nowrap">{{ fig(x.amount) }}</td>
                <td class="n cp-nowrap sp-c-left"><span v-if="x.kind === 'po'" class="muted">—</span><span v-else-if="x.left > 0.005" class="cp-pay bad">{{ fig(x.left) }}</span><span v-else class="cp-pay ok">مدفوع</span></td>
                <td class="cp-nowrap sp-c-due"><span v-if="x.kind === 'po'" class="muted">لم تصل الفاتورة</span><span v-else-if="x.left <= 0.005" class="muted">—</span>
                  <span v-else-if="x.late" class="cp-pay bad">متأخر {{ x.late }} يومًا</span><span v-else class="cp-pay warn">{{ x.due ? dueWord(x.due) : '—' }}</span></td>
                <td class="sp-c-act"><button v-if="x.kind === 'inv' && x.left > 0.005 && state.boot.can.payment" type="button" class="cl-btn sm" :disabled="busy === 'pay'" @click="payInvoice(x.src)">دفعت</button>
                  <button v-else-if="x.kind === 'po'" type="button" class="cl-btn sm" @click="newInvoice(x.src)">سجّل فاتورته</button></td>
              </tr></tbody></table></div>
          </section>

          <section class="cp-card cp-more">
            <nav class="cl-tabs" role="tablist"><button v-for="x in TABS" :key="x[0]" type="button" role="tab" :aria-selected="tab === x[0]" @click="tab = x[0]">{{ x[1] }}<span v-if="x[0] === 'payments'" class="muted"> {{ d.payments.length }}</span></button></nav>
            <div class="cl-p-body">
              <template v-if="tab === 'payments'">
                <div v-if="!d.payments.length" class="muted">لا دفعات بعد.</div>
                <div v-for="p in d.payments" :key="p.name" class="cl-line"><div style="flex:1;min-width:0"><span class="cl-line-t">{{ date(p.posting_date) }}</span>
                  <span class="muted">{{ (state.boot.modes.find(m => m.value === p.mode_of_payment) || {}).label || p.mode_of_payment || '—' }}<template v-if="p.reference_no && p.reference_no !== '—'"> · رقم {{ p.reference_no }}</template></span></div><b>{{ fig(p.paid_amount) }}</b></div>
              </template>
              <template v-else-if="tab === 'items'">
                <div v-if="!d.items.length" class="muted">لا مشتريات مفوترة بعد.</div>
                <div v-for="x in d.items" :key="x.what" class="cl-kv"><span class="ellipsis">{{ x.what }}</span><span><b>{{ fig(x.amount) }}</b> <span class="muted">· آخرها {{ date(x.last) }}</span></span></div>
              </template>
              <template v-else>
                <div class="cl-kv"><span>الهاتف</span><span dir="ltr">{{ d.phone || '—' }}</span></div>
                <div class="cl-kv"><span>البريد</span><span dir="ltr">{{ d.email || '—' }}</span></div>
                <div class="cl-kv"><span>العنوان</span><span>{{ d.address || '—' }}</span></div>
                <div class="cl-kv"><span>الرقم الجبائي NIF</span><span dir="ltr">{{ d.tax_id || '—' }}</span></div>
                <div class="cl-kv"><span>السجل التجاري RC</span><span dir="ltr">{{ d.rc || '—' }}</span></div>
                <div class="cl-kv"><span>ملاحظة</span><span>{{ d.note || '—' }}</span></div>
              </template>
            </div>
          </section>
        </template>
      </template>
    </div>
  </div>`,
};

// ------------------------------------------------------------------ team (/atelier/team)
const RoleOptions = {
  setup() { return { state }; },
  template: `<datalist id="role-list"><option v-for="r in state.boot.lists.roles" :key="r.name" :value="r.name"></option></datalist>`,
};
const TeamPage = {
  props: ["embedded"], components: { Icon, RoleOptions },
  setup() {
    const rows = ref((state.boot.team_members || []).map((m) => ({ ...m })));
    const saving = ref(false), err = ref(null);
    if (!rows.value.length) rows.value.push({ name: "", role: "", user: "" });
    // logins to link to, picked from a list so an email can never be mistyped
    const accounts = ref([]);
    call("team_accounts").then((a) => (accounts.value = a)).catch(() => {});
    const missing = (r) => r.user && !accounts.value.some((a) => a.name === r.user);
    watch(() => state.boot.team_members, (v) => { rows.value = (v || []).map((m) => ({ ...m })); if (!rows.value.length) rows.value.push({ name: "", role: "", user: "" }); });
    const save = async () => {
      saving.value = true; err.value = null;
      try {
        const out = await call("save_team", { members: JSON.stringify(rows.value.filter((r) => r.name.trim())) }, true);
        state.boot.team_members = out; state.boot.team = out.map((m) => m.name);
        rows.value = out.map((m) => ({ ...m })); toast("حُفظ الفريق");
      } catch (e) { err.value = e.message; } finally { saving.value = false; }
    };
    const form = useSettingsForm("team", () => rows.value, () => { rows.value = (state.boot.team_members || []).map((m) => ({ ...m })); if (!rows.value.length) rows.value.push({ name: "", role: "", user: "" }); }, async () => { await save(); return !err.value; });
    return { rows, saving, err, save, t, accounts, missing, inSettings: !!form };
  },
  template: `
  <div :class="embedded ? '' : 'page'">
    <div v-if="!embedded" class="page-head"><div><h1>الفريق</h1><div class="sub">من يعمل في الورشة. تختار منهم أعضاء كل بطاقة.</div></div></div>
    <div class="card team-card">
      <div v-for="(r, i) in rows" :key="i" class="team-row">
        <input class="input" v-model="r.name" :aria-label="'الاسم ' + (i+1)" placeholder="الاسم">
        <input class="input" v-model="r.role" list="role-list" :aria-label="'الدور ' + (i+1)" placeholder="الدور (مصمم، طابع…)">
        <select class="input" v-model="r.user" :aria-label="'حساب الدخول ' + (i+1)"><option value="">بلا حساب دخول</option>
          <option v-if="missing(r)" :value="r.user">{{ r.user }} (غير موجود)</option>
          <option v-for="a in accounts" :key="a.name" :value="a.name">{{ a.full_name }} — {{ a.name }}</option></select>
        <button type="button" class="btn sm ghost icon-btn danger" :aria-label="'حذف ' + (r.name || 'السطر')" @click="rows.splice(i, 1)"><Icon name="trash" :size="16"/></button>
      </div>
      <RoleOptions/>
      <div v-if="err" class="alert error" role="alert">{{ err }}</div>
      <div class="row" style="gap:8px"><button type="button" class="btn chip dashed" @click="rows.push({name:'', role:'', user:''})">+ إضافة شخص</button><span class="spacer"></span>
        <button v-if="!inSettings" type="button" class="btn primary" :disabled="saving" @click="save">{{ saving ? t('of_saving') : 'حفظ' }}</button></div>
    </div>
  </div>`,
};

const BoardSettings = {
  props: ["embedded", "only"], components: { Icon, TeamPage },
  setup(props) {
    const { s, load } = useLoad(() => call("board2"));
    onMounted(load);
    const tab = ref(props.only || "columns"), cols = ref([]), labels = ref([]), statuses = ref([]), moves = reactive({}), removed = ref([]), saving = ref(false), err = ref(null);
    const fill = (v) => { cols.value = v.config.columns.map((c) => ({ ...c })); labels.value = v.config.labels.map((l) => ({ ...l })); statuses.value = (v.config.statuses || []).map((l) => ({ ...l })); removed.value = []; };
    watch(() => s.data, (v) => { if (v) { fill(v); nextTick(() => boardForm?.clean()); } });
    const count = (id) => (s.data?.cards || []).filter((c) => c.column === id).length;
    const lcount = (id) => (s.data?.cards || []).filter((c) => c.labels.includes(id) || (c.status || []).includes(id)).length;
    const up = (l, i, dir) => { const j = i + dir; if (j < 0 || j >= l.length) return; [l[i], l[j]] = [l[j], l[i]]; };
    const delCol = (i) => { const c = cols.value[i]; if (c.id && count(c.id)) { removed.value.push(c); moves[c.id] = cols.value.find((x) => x.id !== c.id && !x.deliver)?.id; } cols.value.splice(i, 1); };
    const setDeliver = (c) => cols.value.forEach((x) => (x.deliver = x === c ? (x.deliver ? 0 : 1) : 0));
    const save = async () => {
      saving.value = true; err.value = null;
      try {
        await call("save_board", { config: JSON.stringify({ columns: cols.value, labels: labels.value, statuses: statuses.value }), moves: JSON.stringify(moves) }, true);
        toast("حُفظ التخصيص"); await load(); state.rev++;
      } catch (e) { err.value = e.message; } finally { saving.value = false; }
    };
    // calendar: daily limit and off days (getDay numbers), week shown from Saturday
    const cal = reactive({ day_limit: 5, off_days: [5] });
    watch(() => s.data?.calendar, (v) => v && Object.assign(cal, { day_limit: v.day_limit, off_days: [...v.off_days] }), { immediate: true });
    const CAL_DAYS = [6, 0, 1, 2, 3, 4, 5].map((i) => [i, WEEK[i]]);
    const flipOff = (i) => { cal.off_days = cal.off_days.includes(i) ? cal.off_days.filter((x) => x !== i) : [...cal.off_days, i]; };
    const saveCal = async () => {
      saving.value = true; err.value = null;
      try { const v = await call("save_calendar", { day_limit: cal.day_limit, off_days: JSON.stringify(cal.off_days) }, true); Object.assign(cal, v); toast("حُفظت إعدادات التقويم"); }
      catch (e) { err.value = e.message; } finally { saving.value = false; }
    };
    const inSettings = !!inject("stForms", null);
    const boardForm = props.only === "calendar"
      ? useSettingsForm("calendar", () => cal, () => { const v = s.data?.calendar; if (v) Object.assign(cal, { day_limit: v.day_limit, off_days: [...v.off_days] }); }, async () => { await saveCal(); return !err.value; })
      : props.only ? useSettingsForm("board:" + props.only, () => ({ c: cols.value, l: labels.value, s: statuses.value }), () => s.data && fill(s.data), async () => { await save(); return !err.value; }) : null;
    watch(() => s.data?.calendar, () => nextTick(() => props.only === "calendar" && boardForm?.clean()));
    return { inSettings, statuses, s, tab, cols, labels, moves, removed, saving, err, count, lcount, up, delCol, setDeliver, save, BOARD_COLORS, COVER_COLORS, labelStyle, go, cal, CAL_DAYS, flipOff, saveCal };
  },
  template: `
  <div class="page">
    <div v-if="!embedded" class="bd-head"><div><h1>تخصيص اللوحة</h1><div class="sub">للمدير فقط. التغييرات تظهر للفريق مباشرة.</div></div>
      <button type="button" class="btn" @click="go('/')">← العودة إلى الطلبات</button></div>
    <div v-if="!only || only === 'statuses'" class="cv-tabs" role="tablist" style="margin:12px 0 18px">
      <button v-for="tb in (only ? [['statuses','الحالات'],['labels','الوسوم']] : [['columns','الأعمدة'],['statuses','الحالات'],['labels','الوسوم'],['calendar','التقويم']])" :key="tb[0]" type="button" role="tab" class="bs-tab" :aria-selected="tab===tb[0]" @click="tab=tb[0]">{{ tb[1] }}</button></div>
    <div v-if="!s.data && tab !== 'team'" class="ws-loading">جارٍ التحميل…</div>
    <div v-else-if="tab === 'columns'" class="bs-list">
      <div v-for="(c, i) in cols" :key="c.id || i" class="bs-row">
        <span class="bs-move"><button type="button" class="btn ghost icon-btn sm" :aria-label="'تقديم ' + c.name" @click="up(cols, i, -1)"><Icon name="up" :size="16"/></button><button type="button" class="btn ghost icon-btn sm" :aria-label="'تأخير ' + c.name" @click="up(cols, i, 1)"><Icon name="down" :size="16"/></button></span>
        <input class="input" v-model="c.name" :aria-label="'اسم العمود ' + (i + 1)" placeholder="اسم العمود">
        <span class="bs-colors" role="group" :aria-label="'لون ' + c.name"><button v-for="col in BOARD_COLORS" :key="col" type="button" class="bs-sw" :style="{background: col}" :aria-pressed="c.color === col" :aria-label="col" @click="c.color = col"></button></span>
        <label class="bs-deliver"><input type="checkbox" :checked="!!c.deliver" @change="setDeliver(c)">عمود التسليم</label>
        <label class="bs-limit">حدّ <input type="number" min="0" class="input" v-model.number="c.limit" :aria-label="'أقصى عدد بطاقات في ' + c.name" placeholder="∞"></label>
        <span class="m">{{ c.id ? count(c.id) + ' بطاقة' : 'جديد' }}</span>
        <button type="button" class="btn ghost icon-btn sm danger" :aria-label="'حذف ' + c.name" @click="delCol(i)"><Icon name="trash" :size="16"/></button>
      </div>
      <div v-for="r in removed" :key="r.id" class="bs-warn"><b>حذف «{{ r.name }}» وفيه {{ count(r.id) }} بطاقة</b> — تُنقل البطاقات إلى:
        <select class="input" v-model="moves[r.id]" style="width:auto"><option v-for="c in cols.filter(c => c.id && !c.deliver)" :key="c.id" :value="c.id">{{ c.name }}</option></select></div>
      <button type="button" class="bs-addrow" @click="cols.splice(cols.findIndex(c => c.deliver) >= 0 ? cols.findIndex(c => c.deliver) : cols.length, 0, {name: '', color: BOARD_COLORS[cols.length % BOARD_COLORS.length]})">+ إضافة عمود</button>
      <span class="m">نقل بطاقة إلى «عمود التسليم» يصدر بون التسليم والفاتورة تلقائيًا. عمود واحد فقط يحمل هذه الصفة.</span>
    </div>
    <div v-else-if="tab === 'statuses'" class="bs-list">
      <span class="m">الحالات أقراص ملوّنة أعلى كل بطاقة (مثل En cours و«في انتظار معلومات»). يمكن وضع أكثر من حالة على البطاقة، وتُغيَّر بنقرة من اللوحة.</span>
      <div v-for="(l, i) in statuses" :key="l.id || i" class="bs-row">
        <span class="tl bs-prev" :style="labelStyle(l)">{{ l.name || 'حالة' }}</span>
        <input class="input" v-model="l.name" :aria-label="'اسم الحالة ' + (i + 1)" placeholder="اسم الحالة">
        <span class="bs-colors" role="group" :aria-label="'لون ' + l.name"><button v-for="col in COVER_COLORS.concat(BOARD_COLORS)" :key="col" type="button" class="bs-sw" :style="{background: col}" :aria-pressed="l.color === col" :aria-label="col" @click="l.color = col"></button></span>
        <span class="m">{{ l.id ? lcount(l.id) + ' بطاقة' : 'جديدة' }}</span>
        <button type="button" class="btn ghost icon-btn sm danger" :aria-label="'حذف ' + l.name" @click="statuses.splice(i, 1)"><Icon name="trash" :size="16"/></button>
      </div>
      <button type="button" class="bs-addrow" @click="statuses.push({name: '', color: COVER_COLORS[statuses.length % COVER_COLORS.length]})">+ إضافة حالة</button>
    </div>
    <div v-else-if="tab === 'labels'" class="bs-list">
      <span class="m">الوسوم علامات صغيرة إضافية مثل «عاجل» و«مهم»، ويمكن وضع أكثر من وسم على البطاقة.</span>
      <div v-for="(l, i) in labels" :key="l.id || i" class="bs-row">
        <span class="tl bs-prev" :style="labelStyle(l)">{{ l.name || 'وسم' }}</span>
        <input class="input" v-model="l.name" :aria-label="'اسم الوسم ' + (i + 1)" placeholder="اسم الوسم">
        <span class="bs-colors" role="group" :aria-label="'لون ' + l.name"><button v-for="col in BOARD_COLORS" :key="col" type="button" class="bs-sw" :style="{background: col}" :aria-pressed="l.color === col" :aria-label="col" @click="l.color = col"></button></span>
        <span class="m">{{ l.id ? lcount(l.id) + ' بطاقة' : 'جديدة' }}</span>
        <button type="button" class="btn ghost icon-btn sm danger" :aria-label="'حذف ' + l.name" @click="labels.splice(i, 1)"><Icon name="trash" :size="16"/></button>
      </div>
      <button type="button" class="bs-addrow" @click="labels.push({name: '', color: BOARD_COLORS[labels.length % BOARD_COLORS.length]})">+ إضافة وسم</button>
    </div>
    <TeamPage v-else-if="tab === 'team'" embedded/>
    <div v-else-if="tab === 'calendar'" class="bs-list bs-cal">
      <label class="cl-fgroup" style="max-width:420px"><span>الحد اليومي للطلبات</span><div class="unit-wrap"><input class="input num" style="max-width:160px" v-model="cal.day_limit" inputmode="numeric"><span class="u">طلب</span></div>
        <span class="m">يصبح رقم اليوم برتقاليًا إذا تجاوزه. 0 لإلغاء التنبيه.</span></label>
      <div class="cl-fgroup"><span>أيام العطلة</span><div class="bs-days"><label v-for="d in CAL_DAYS" :key="d[0]" class="st2-check"><input type="checkbox" :checked="cal.off_days.includes(d[0])" @change="flipOff(d[0])"><span>{{ d[1] }}</span></label></div>
        <span class="m">تظهر رمادية في التقويم. الأسبوع يبدأ السبت.</span></div>
      <div v-if="err" class="alert error" role="alert">{{ err }}</div>
      <div v-if="!inSettings" class="row" style="justify-content:flex-end"><button type="button" class="btn primary" :disabled="saving" @click="saveCal">{{ saving ? 'جارٍ الحفظ…' : 'حفظ' }}</button></div>
    </div>
    <template v-if="tab !== 'team' && tab !== 'calendar' && s.data">
      <div v-if="err" class="alert error" role="alert" style="margin-top:12px">{{ err }}</div>
      <div v-if="!inSettings" class="row" style="justify-content:flex-end;margin-top:16px"><button type="button" class="btn primary" :disabled="saving" @click="save">{{ saving ? 'جارٍ الحفظ…' : 'حفظ' }}</button></div>
    </template>
  </div>`,
};

// ------------------------------------------------------------------ settings (/atelier/settings), manager only
// one save bar for all settings: each form says when it differs from what was loaded, and how to save or undo
function useSettingsForm(id, read, reset, save, own) {
  const reg = own || inject("stForms", null); if (!reg) return null;
  const snap = ref(JSON.stringify(read()));
  const form = reactive({ id, dirty: computed(() => JSON.stringify(read()) !== snap.value),
    clean: () => { snap.value = JSON.stringify(read()); },
    save: async () => { const ok = await save(); if (ok !== false) snap.value = JSON.stringify(read()); return ok !== false; },
    reset: async () => { await reset(); await nextTick(); snap.value = JSON.stringify(read()); } });
  onMounted(() => reg.set(id, form)); onBeforeUnmount(() => reg.delete(id));
  return form;
}
const SETTINGS_GROUPS = [
  ["المطبعة", [["profile", "printer", "بيانات المطبعة"], ["docs", "invoice", "الوثائق والضريبة"]]],
  ["العمل", [["team", "users", "الفريق والحسابات"], ["columns", "grid", "أعمدة اللوحة"], ["statuses", "tag", "الحالات والوسوم"], ["calendar", "calendar", "التقويم"],
    ["prices", "tag", "الخدمات والأسعار"], ["lists", "grid", "القوائم"]]],
  ["المال", [["funds", "wallet", "الدفع والصناديق"]]],
  ["النظام", [["alerts", "bell", "التنبيهات"], ["mail", "invoice", "البريد"], ["folders", "file", "المجلدات"], ["backup", "box", "النسخ الاحتياطي"]]],
];
// settings search: what people type, and where it lives
const SETTINGS_INDEX = [
  ["اسم المطبعة الشعار logo", "profile", "الشعار والاسم"], ["العنوان المدينة الهاتف البريد email", "profile", "العنوان والاتصال"],
  ["RC السجل التجاري NIF الرقم الجبائي NIS AI المادة RIB الحساب البنكي", "profile", "البيانات القانونية"],
  ["TVA الضريبة نص أسفل الوثائق مهلة الدفع صلاحية Devis الوصف", "docs", "الوثائق والضريبة"],
  ["حساب دخول كلمة السر صلاحية مدير بائع مصمم طباعة الفريق أسماء", "team", "الفريق والحسابات"],
  ["أعمدة اللوحة عمود التسليم لون حد", "columns", "أعمدة اللوحة"], ["الحالات الوسوم En attente", "statuses", "الحالات والوسوم"],
  ["التقويم الحد اليومي العطلة الجمعة السبت", "calendar", "التقويم"], ["خدمة سعر الأفراد المؤسسات قائمة الأسعار", "prices", "الخدمات والأسعار"],
  ["وحدات البيع م² سم² قطعة تصنيفات الأوسام مواعيد التسليم أنواع التكلفة الأدوار", "lists", "القوائم"],
  ["الصناديق طرق الدفع كاش بريدي موب CCP تحويل صك الرصيد الافتتاحي", "funds", "الدفع والصناديق"],
  ["التنبيهات الجرس إسناد ذكر المواعيد", "alerts", "التنبيهات"], ["البريد SMTP رسالة تجريبية", "mail", "البريد"],
  ["المجلدات مجلد العميل البطاقة D:", "folders", "المجلدات"], ["النسخ الاحتياطي نسخة تحميل", "backup", "النسخ الاحتياطي"],
];
const SETTINGS_TABS = [["profile", "🏢", "المطبعة"], ["docs", "📄", "الوثائق والضريبة"], ["team", "👥", "الفريق والحسابات"], ["board", "▦", "تخصيص اللوحة"],
  ["prices", "🏷", "الخدمات والأسعار"], ["funds", "💳", "الدفع والصناديق"], ["alerts", "🔔", "التنبيهات"], ["backup", "💾", "النسخ الاحتياطي"]];

const OpeningGroup = {
  setup() {
    const d = ref(null), date = ref(isoIn(0)), busy = ref(false), error = ref(null);
    const load = async () => { try { d.value = await call("opening_balances"); d.value.rows.forEach((r) => (r.input = "")); error.value = null; } catch (e) { error.value = e.message; } };
    const run = async (fn, msg) => { busy.value = true; try { await fn(); toast(msg); await load(); } catch (e) { toast(e.message, "error"); } finally { busy.value = false; } };
    const save = (r) => run(() => call("save_opening", { account: r.account, amount: r.input, posting_date: date.value }, true), "سُجّل الرصيد الافتتاحي");
    const cancel = (r) => { if (confirm(`إلغاء الرصيد الافتتاحي لـ«${r.label}»؟`)) run(() => call("cancel_opening", { entry: r.entry }, true), "أُلغي الرصيد الافتتاحي"); };
    load();
    return { d, date, busy, error, save, cancel, money };
  },
  template: `
  <div class="st2-grp"><div class="st2-lbl"><b>الرصيد الافتتاحي</b><span>المال الموجود عند بداية العمل. يظهر في الأرصدة ولا يُحسب دخلًا.</span></div>
    <div class="st2-fields"><p v-if="error" class="muted">{{ error }}</p>
      <template v-if="d"><label class="st2-line"><span style="min-width:110px">تاريخ البداية</span><input class="input" type="date" v-model="date"></label>
        <div v-for="r in d.rows" :key="r.account" class="st2-line"><span style="min-width:110px">{{ r.label }}</span>
          <template v-if="r.entry"><b class="money">{{ money(r.amount) }}</b><span class="muted">{{ r.date }}</span><button type="button" class="cl-btn sm" :disabled="busy" @click="cancel(r)">إلغاء</button></template>
          <template v-else><input class="input" type="number" min="0" step="0.01" v-model="r.input" :aria-label="'رصيد ' + r.label" placeholder="0"><button type="button" class="cl-btn sm" :disabled="busy || !(+r.input > 0)" @click="save(r)">تسجيل</button></template></div>
        <span class="muted">يُسجَّل مقابل حساب «{{ d.counter }}» (11).</span></template></div></div>`,
};

const LIST_DEFS = [
  { key: "units", title: "الوحدات", hint: "لكل وحدة طريقة حساب: بالعدد (قطعة، صفحة، وجه)، بالطول (متر طولي)، أو بالمساحة (م²). البند يطلب المقاس حسب وحدته.",
    cols: [["name", "الوحدة"], ["calc", "طريقة الحساب", "select", [["count", "بالعدد"], ["length", "بالطول"], ["area", "بالمساحة"]]], ["scale", "المقياس", "select", [["m", "متر"], ["cm", "سنتيمتر"]]], ["whole", "عدد صحيح", "check"]],
    blank: { name: "", calc: "count", scale: "m", whole: 0 } },
  { key: "categories", title: "تصنيفات الأعمال", hint: "تُختار في البند وفي قائمة الأسعار، وتظهر في التقارير: كم ربحت من كل تصنيف.", cols: [["name", "التصنيف"]], blank: { name: "" } },
  { key: "tags", title: "الأوسام السريعة", hint: "الترتيب يحدد الأولوية على اللوحة. الطلبات السابقة تحتفظ بوسمها.", cols: [["name", "الوسم"]], blank: { name: "", tone: "" } },
  { key: "due", title: "أزرار موعد التسليم", hint: "تظهر في الطلب الجديد.", cols: [["label", "النص"], ["days", "بعد كم يوم", "number"]], blank: { label: "", days: 1 } },
  { key: "cost_types", title: "أنواع التكلفة", hint: "«مادة» يعني أن تلف المواد يُضاف إلى هذا النوع.", cols: [["label", "النوع"], ["material", "مادة", "check"]], blank: { label: "", material: 0 } },
  { key: "roles", title: "أدوار الفريق", hint: "اقتراحات عند إضافة شخص إلى الفريق.", cols: [["name", "الدور"]], blank: { name: "" } },
];
const ListEditor = {
  props: ["def"],
  setup(props) {
    const current = () => (props.def.key === "units" ? state.boot.units : state.boot.lists[props.def.key]);
    const rows = ref(current().map((r) => ({ ...r }))), busy = ref(false);
    const add = () => rows.value.push({ ...props.def.blank });
    const shift = (i, by) => { const r = rows.value, j = i + by; if (j >= 0 && j < r.length) [r[i], r[j]] = [r[j], r[i]]; };
    const save = async () => {
      busy.value = true;
      try {
        const out = await call("save_list", { key: props.def.key, rows: JSON.stringify(rows.value) }, true);
        if (props.def.key === "units") state.boot.units = out; else state.boot.lists[props.def.key] = out;
        rows.value = out.map((r) => ({ ...r })); toast("حُفظت القائمة"); return true;
      } catch (e) { toast(e.message, "error"); return false; } finally { busy.value = false; }
    };
    const form = useSettingsForm("list:" + props.def.key, () => rows.value, () => { rows.value = current().map((r) => ({ ...r })); }, () => save());
    return { rows, busy, add, shift, save, inSettings: !!form };
  },
  template: `
  <div class="st2-grp"><div class="st2-lbl"><b>{{ def.title }}</b><span>{{ def.hint }}</span></div>
    <div class="st2-fields"><div v-for="(r, i) in rows" :key="i" class="st2-line">
        <template v-for="c in def.cols" :key="c[0]">
          <label v-if="c[2] === 'check'" class="row" style="gap:4px;white-space:nowrap"><input type="checkbox" :checked="!!r[c[0]]" @change="r[c[0]] = $event.target.checked ? 1 : 0">{{ c[1] }}</label>
          <select v-else-if="c[2] === 'select'" class="input" v-model="r[c[0]]" :aria-label="c[1]" :disabled="c[0] === 'scale' && r.calc === 'count'"><option v-for="o in c[3]" :key="o[0]" :value="o[0]">{{ o[1] }}</option></select>
          <input v-else class="input" :type="c[2] === 'number' ? 'number' : 'text'" :min="c[2] === 'number' ? 0 : null" v-model="r[c[0]]" :aria-label="c[1]" :placeholder="c[1]"></template>
        <button type="button" class="cl-btn sm" :disabled="i === 0" :aria-label="'رفع ' + (i + 1)" @click="shift(i, -1)">↑</button>
        <button type="button" class="cl-btn sm" :aria-label="'حذف ' + (i + 1)" @click="rows.splice(i, 1)">×</button></div>
      <div class="row" style="gap:8px"><button type="button" class="cl-btn sm" @click="add">+ إضافة</button><button v-if="!inSettings" type="button" class="cl-btn primary sm" :disabled="busy" @click="save">حفظ</button></div></div></div>`,
};

const SettingsPage = {
  props: ["start"], components: { Icon, Avatar, BoardSettings, PricesPage, TeamPage, ListEditor, OpeningGroup },
  setup(props) {
    const { s, load } = useLoad(() => call("settings"));
    onMounted(load);
    const forms = reactive(new Map()); provide("stForms", forms);
    const dirtyForms = computed(() => [...forms.values()].filter((x) => x.dirty));
    const tab = ref({ board: "columns" }[props.start || state.query.get("tab")] || props.start || state.query.get("tab") || "profile");
    const sq = ref("");
    const norm = (x) => String(x || "").toLowerCase().replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي");
    const sres = computed(() => { const q = norm(sq.value.trim()); if (!q) return [];
      const title = Object.fromEntries(SETTINGS_GROUPS.flatMap((g) => g[1].map((x) => [x[0], x[2]])));
      return SETTINGS_INDEX.filter((x) => norm(x[0] + " " + x[2]).includes(q)).slice(0, 6).map((x) => ({ tab: x[1], sec: x[2], page: title[x[1]] })); });
    const goSearch = (x) => { sq.value = ""; if (dirtyForms.value.length && x.tab !== tab.value) { leaveTo.value = x.tab; return; } tab.value = x.tab; nextTick(() => { const el = [...document.querySelectorAll(".st2-lbl b, .st2-body h3, .st2-body b")].find((b) => b.textContent.trim() === x.sec);
      if (el) { el.scrollIntoView({ block: "center" }); const g = el.closest(".st2-grp") || el.parentElement; g?.classList.add("st2-hl"); setTimeout(() => g?.classList.remove("st2-hl"), 1800); g?.querySelector("input, select, textarea")?.focus(); } }); };
    // what a workshop still needs before official invoices
    const READY = [["name_ar", "الاسم"], ["phone", "الهاتف"], ["address", "العنوان"], ["logo", "الشعار"], ["rc", "RC"], ["nif", "NIF"]];
    const ready = computed(() => { const done = READY.filter((x) => String(p[x[0]] || "").trim()); return { items: READY.map((x) => ({ label: x[1], ok: done.includes(x) })), pct: Math.round(done.length / READY.length * 100), missing: READY.length - done.length }; });
    const navFlag = (k) => (!s.data ? "" : k === "profile" && ready.value.missing ? "ناقص " + ready.value.missing : k === "mail" && !s.data.email?.configured ? "dot" : k === "backup" && !(s.data.backups || []).length ? "dot" : "");
    const p = reactive({}), docs = reactive({}), alerts = reactive({});
    watch(() => s.data, (v) => { if (v) { Object.assign(p, v.profile); Object.assign(docs, v.docs); Object.assign(alerts, v.alerts); } });
    const busy = ref(null), err = ref(null);
    const run = async (key, fn, msg) => { busy.value = key; err.value = null; try { const r = await fn(); if (msg) toast(msg); return r; } catch (e) { err.value = e.message; } finally { busy.value = null; } };
    const saveProfile = () => run("profile", async () => { Object.assign(p, await call("save_profile", { profile: JSON.stringify(p) }, true)); state.boot.company_label = p.name_ar || state.boot.company_label; }, "حُفظت بيانات المطبعة");
    const logoInput = ref(null);
    const onLogo = (e) => run("logo", async () => {
      const f = e.target.files?.[0]; if (!f) return;
      const fd = new FormData(); fd.append("file", f, f.name); fd.append("is_private", "0"); fd.append("doctype", "Company"); fd.append("docname", state.boot.company);
      const res = await fetch("/api/method/upload_file", { method: "POST", body: fd, credentials: "same-origin", headers: { "X-Frappe-CSRF-Token": window.csrf_token } });
      if (!res.ok) throw new Error(serverMessage(await res.json().catch(() => ({}))));
      p.logo = (await res.json()).message.file_url; e.target.value = "";
    }, "رُفع الشعار — اضغط «حفظ»");
    const saveDocs = () => run("docs", async () => Object.assign(docs, await call("save_doc_settings", { docs: JSON.stringify(docs) }, true)), "حُفظت إعدادات الوثائق");
    const saveAlerts = () => run("alerts", async () => Object.assign(alerts, await call("save_alerts", { alerts: JSON.stringify(alerts) }, true)), "حُفظت التنبيهات");
    // accounts
    const nu = reactive({ email: "", full_name: "", role: "sales" }), link = ref(null);
    const saveUser = (u) => run("user", async () => {
      const r = await call("save_user", u ? { email: u.name, full_name: u.full_name, role: u.role, enabled: u.enabled } : { ...nu }, true);
      if (!u) { link.value = { email: nu.email, url: r.link }; nu.email = ""; nu.full_name = ""; }
      await load();
    }, u ? "حُفظ الحساب" : "أُنشئ الحساب");
    const addToTeam = (u) => run("team", async () => {
      const team = await call("add_to_team", { email: u.name }, true);
      state.boot.team_members = team; state.boot.team = team.map((m) => m.name); await load();
    }, "أُضيف إلى الفريق");
    const resetLink = (u) => run("link", async () => { link.value = { email: u.name, url: await call("reset_link", { email: u.name }, true) }; });
    const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast("نُسخ الرابط"); } catch { /* user can select it */ } };
    // funds
    const renameFund = (f) => run("fund", () => call("rename_fund", { account: f.name, label: f.account_name }, true), "حُفظ الاسم");
    const newFund = reactive({ label: "", type: "Cash" }), newMode = reactive({ label: "", account: null });
    const refreshModes = async () => { await load(); state.boot.modes = (await call("boot")).modes; };
    const addFund = () => run("fund", async () => { await call("add_fund", { label: newFund.label, fund_type: newFund.type }, true); newFund.label = ""; await load(); }, "أُضيف الصندوق");
    const removeFund = (x) => { if (confirm(`حذف «${x.account_name}»؟`)) run("fund", async () => { await call("remove_fund", { account: x.name }, true); await load(); }, "حُذف الصندوق"); };
    const addMode = () => run("mode", async () => { await call("add_mode", { label: newMode.label, account: newMode.account }, true); newMode.label = ""; newMode.account = null; await refreshModes(); }, "أُضيفت الطريقة");
    const removeMode = (m) => { if (confirm(`حذف «${m.label}»؟ تبقى الدفعات السابقة كما هي.`)) run("mode", async () => { await call("remove_mode", { value: m.value }, true); await refreshModes(); }, "حُذفت الطريقة"); };
    const setMode = (m) => run("mode", async () => { await call("set_mode_account", { mode: m.value, account: m.account, label: m.label }, true); await refreshModes(); }, "حُفظ");
    const backup = () => run("backup", async () => { s.data.backups = await call("backup_now", {}, true); }, "أُنشئت نسخة احتياطية");
    const size = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.round(b / 1024) + " KB");
    const sample = computed(() => { const net = 18000, tax = docs.tva ? net * (+docs.tva_rate || 0) / 100 : 0; return { net, tax, total: net + tax }; });
    const preview = ref(false);
    const mail = reactive({ email_id: "", smtp_server: "", smtp_port: 587, security: "tls", login_id: "", password: "" }), mailTo = ref("");
    watch(() => s.data, (v) => { if (v && v.email) Object.assign(mail, { ...v.email, password: "" }); }, { immediate: true });
    const MAIL_PRESETS = [["Gmail", "smtp.gmail.com", 587, "tls"], ["Outlook", "smtp.office365.com", 587, "tls"], ["Yahoo", "smtp.mail.yahoo.com", 465, "ssl"]];
    const saveMail = () => run("mail", async () => { Object.assign(mail, { ...(await call("save_email", { cfg: JSON.stringify(mail) }, true)), password: "" }); }, "حُفظ البريد");
    const fold = reactive({ enabled: 0, display_root: "D:\\نسق", sub: "العملاء", order: "date_first", available: false }), foldDone = ref(null);
    watch(() => s.data, (v) => { if (v && v.folders) Object.assign(fold, v.folders); }, { immediate: true });
    const saveFolders = () => run("folders", async () => { Object.assign(fold, await call("save_folders", { data: JSON.stringify(fold) }, true)); }, "حُفظت إعدادات المجلدات");
    const syncFolders = () => run("foldsync", async () => { foldDone.value = await call("sync_folders", {}, true); });
    const foldSample = computed(() => { const d = "2026-11-08", t = "لافتة واجهة"; return (fold.order === "title_first" ? `${t} — ${d}` : `${d} — ${t}`) + " (00012)"; });
    const testMail = () => run("mailtest", () => call("test_email", { to: mailTo.value || mail.email_id }, true), "أُرسلت رسالة تجريبية — تحقق من صندوق الوارد");
    const META = { profile: ["بيانات المطبعة", "تظهر في رأس كل بون وفاتورة وكشف حساب", saveProfile], docs: ["الوثائق والضريبة", "الضريبة ونص أسفل الوثائق ومهلة الدفع", saveDocs],
      team: ["الفريق والحسابات", "من يدخل إلى البرنامج وبأي صلاحية"], columns: ["أعمدة اللوحة", "مراحل الطلب كما يراها الفريق في اللوحة"], statuses: ["الحالات والوسوم", "حالات البطاقة ووسومها وألوانها"], calendar: ["التقويم", "الحد اليومي للطلبات وأيام العطلة"], prices: ["الخدمات والأسعار", "سعر الأفراد وسعر المؤسسات لكل خدمة"],
      lists: ["القوائم", "وحدات البيع والأوسام ومواعيد التسليم وأنواع التكلفة والأدوار"], funds: ["الدفع والصناديق", "أسماء الصناديق وطرق الدفع"], alerts: ["التنبيهات", "ما يصل إلى جرس كل عضو", saveAlerts],
      mail: ["البريد", "لإرسال رابط كلمة السر ورسائل الحسابات الجديدة", saveMail], folders: ["المجلدات", "مجلد لكل عميل ولكل بطاقة على هذا الحاسوب", saveFolders], backup: ["النسخ الاحتياطي", "نسخة كاملة من البيانات والملفات"] };
    const meta = computed(() => { const m = META[tab.value] || META.profile; return { title: m[0], desc: m[1], save: m[2] }; });
    // own forms (profile, documents, alerts, mail, folders): clean once the settings load
    const loaded = (v) => JSON.parse(JSON.stringify(v));
    let base = {};
    const own = [["profile", p, saveProfile], ["docs", docs, saveDocs], ["alerts", alerts, saveAlerts], ["mail", mail, saveMail], ["folders", fold, saveFolders]];
    const ownForms = own.map(([id, obj, fn]) => useSettingsForm("own:" + id, () => obj, () => Object.assign(obj, base[id] || {}), async () => { await fn(); return !err.value; }, forms));
    watch(() => s.data, () => nextTick(() => { own.forEach(([id, obj]) => (base[id] = loaded(obj))); ownForms.forEach((x) => x?.clean()); }));
    const saving2 = ref(false);
    const saveAll = async () => { saving2.value = true; try { for (const x of dirtyForms.value) { if (!(await x.save())) return false; } return true; } finally { saving2.value = false; } };
    const undoAll = async () => { for (const x of dirtyForms.value) await x.reset(); };
    const leaveTo = ref(null);
    const switchTab = (t) => { if (t === tab.value) return; if (dirtyForms.value.length) { leaveTo.value = t; return; } tab.value = t; };
    const leave = async (how) => { const t = leaveTo.value; leaveTo.value = null; if (how === "save" && !(await saveAll())) return; if (how === "drop") await undoAll(); tab.value = t; };
    const onUnload = (e) => { if (dirtyForms.value.length) { e.preventDefault(); e.returnValue = ""; } };
    onMounted(() => window.addEventListener("beforeunload", onUnload)); onBeforeUnmount(() => window.removeEventListener("beforeunload", onUnload));
    return { dirtyForms, saveAll, undoAll, saving2, leaveTo, switchTab, leave, sq, sres, goSearch, ready, navFlag, fold, foldDone, saveFolders, syncFolders, foldSample, mail, mailTo, MAIL_PRESETS, testMail, preview, meta, SETTINGS_GROUPS, s, load, tab, p, docs, alerts, busy, err, saveProfile, logoInput, onLogo, saveDocs, saveAlerts, nu, link, saveUser, resetLink, copy,
      LIST_DEFS, addToTeam, renameFund, setMode, newFund, newMode, addFund, removeFund, addMode, removeMode, backup, size, sample, SETTINGS_TABS, fig, ago, state, go };
  },
  template: `
  <div class="cl st2">
    <nav class="st2-nav" aria-label="أقسام الإعدادات">
      <div class="st2-search"><Icon name="search" :size="15"/><input v-model="sq" placeholder="ابحث في الإعدادات" aria-label="ابحث في الإعدادات" @keydown.enter.prevent="sres[0] && goSearch(sres[0])"></div>
      <div v-if="sq.trim()" class="st2-res"><button v-for="x in sres" :key="x.tab + x.sec" type="button" @click="goSearch(x)">{{ x.sec }}<small>{{ x.page }}</small></button>
        <span v-if="!sres.length" class="muted">لا نتيجة.</span></div>
      <template v-for="g in SETTINGS_GROUPS" :key="g[0]">
        <span class="st2-group">{{ g[0] }}</span>
        <button v-for="x in g[1]" :key="x[0]" type="button" :aria-current="tab === x[0] ? 'page' : null" @click="switchTab(x[0])"><Icon :name="x[1]" :size="17"/>{{ x[2] }}
          <span v-if="navFlag(x[0]) === 'dot'" class="st2-dot" title="يحتاج انتباهًا"></span><span v-else-if="navFlag(x[0])" class="st2-flag">{{ navFlag(x[0]) }}</span></button>
      </template>
    </nav>
    <div class="cl-main">
      <header class="cl-head st2-head">
        <div class="cl-head-row"><div style="min-width:0"><h1>{{ meta.title }}</h1><div class="muted">{{ meta.desc }}</div></div><span class="spacer"></span>
          <button v-if="tab === 'profile' || tab === 'docs'" type="button" class="cl-btn" @click="preview = true"><Icon name="file" :size="16"/>معاينة الفاتورة</button>
          <button v-if="tab === 'prices' && state.boot.can.prices" type="button" class="cl-btn primary" @click="state.sheet = {type: 'item'}"><Icon name="plus" :size="16"/>خدمة جديدة</button>
</div>
      </header>
      <div v-if="s.loading && !s.data" class="ws-loading">جارٍ التحميل…</div>
      <div v-else-if="s.error" class="alert error" style="margin:20px 32px">{{ s.error }}</div>
      <div v-else class="st2-body">
        <div v-if="err" class="alert error" role="alert">{{ err }}</div>

        <div v-if="tab === 'profile'" class="st2-ready"><b>جاهزية المطبعة</b><span class="st2-rbar"><i :style="{width: ready.pct + '%'}"></i></span><b>{{ ready.pct }}%</b>
          <span v-for="x in ready.items" :key="x.label" :class="x.ok ? 'ok' : 'no'">{{ x.ok ? '✓ ' : '' }}{{ x.label }}</span></div>
        <div v-if="tab === 'profile'" class="st2-card">
          <div class="st2-grp"><div class="st2-lbl"><b>الشعار والاسم</b><span>PNG أو SVG بخلفية شفافة. الاسم بالفرنسية اختياري ويظهر تحت الاسم العربي.</span></div>
            <div class="st2-fields">
              <div class="st2-logo-row"><div class="st2-logo"><img v-if="p.logo" :src="p.logo" alt="الشعار"><Icon v-else name="image" :size="26"/></div>
                <div class="st2-col"><button type="button" class="cl-btn" :disabled="busy === 'logo'" @click="logoInput.click()"><Icon name="in" :size="15"/>{{ p.logo ? 'تغيير الشعار' : 'رفع الشعار' }}</button><span class="muted">الحجم المقترح 400×400</span></div>
                <input ref="logoInput" type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" class="sr-only" @change="onLogo"></div>
              <div class="st2-row"><label class="cl-fgroup"><span>اسم المطبعة</span><input class="input" v-model="p.name_ar"></label><label class="cl-fgroup"><span>الاسم بالفرنسية</span><input class="input" v-model="p.name_fr" dir="ltr"></label></div></div></div>
          <div class="st2-grp"><div class="st2-lbl"><b>العنوان والاتصال</b><span>يُطبع في رأس الوثائق ويظهر في رسائل التذكير.</span></div>
            <div class="st2-fields"><div class="st2-row"><label class="cl-fgroup grow2"><span>العنوان</span><input class="input" v-model="p.address"></label><label class="cl-fgroup"><span>المدينة</span><input class="input" v-model="p.city"></label></div>
              <div class="st2-row"><label class="cl-fgroup"><span>الهاتف</span><input class="input" v-model="p.phone" dir="ltr" inputmode="tel"></label><label class="cl-fgroup"><span>هاتف ثانٍ</span><input class="input" v-model="p.phone2" dir="ltr" inputmode="tel"></label>
                <label class="cl-fgroup"><span>البريد</span><input class="input" v-model="p.email" dir="ltr" type="email"></label></div></div></div>
          <div class="st2-grp"><div class="st2-lbl"><b>البيانات القانونية</b><span>مطلوبة على الفواتير وفق التشريع الجزائري.</span></div>
            <div class="st2-fields"><div class="st2-row"><label class="cl-fgroup"><span>السجل التجاري RC</span><input class="input" v-model="p.rc" dir="ltr"></label><label class="cl-fgroup"><span>الرقم الجبائي NIF</span><input class="input" v-model="p.nif" dir="ltr"></label></div>
              <div class="st2-row"><label class="cl-fgroup"><span>NIS</span><input class="input" v-model="p.nis" dir="ltr"></label><label class="cl-fgroup"><span>المادة AI</span><input class="input" v-model="p.ai" dir="ltr"></label></div>
              <div class="st2-row"><label class="cl-fgroup"><span>رقم الحساب البنكي RIB</span><input class="input" v-model="p.rib" dir="ltr"></label></div></div></div>
        </div>

        <div v-else-if="tab === 'docs'" class="st2-card">
          <div class="st2-grp"><div class="st2-lbl"><b>الضريبة على القيمة المضافة</b><span>تُضاف على الطلبات والفواتير الجديدة فقط. يمكن إعفاء عميل من نافذة تعديله.</span></div>
            <div class="st2-fields"><label class="st2-check"><input type="checkbox" :checked="!!docs.tva" @change="docs.tva = $event.target.checked ? 1 : 0"><span>تطبيق TVA</span></label>
              <label v-if="docs.tva" class="cl-fgroup" style="max-width:180px"><span>النسبة</span><div class="unit-wrap"><input class="input num" v-model="docs.tva_rate" inputmode="decimal"><span class="u">%</span></div></label></div></div>
          <div class="st2-grp"><div class="st2-lbl"><b>أسفل الوثائق والدفع</b><span>النص يُطبع أسفل كل بون وفاتورة. المهلة تحدّد تاريخ استحقاق الفاتورة.</span></div>
            <div class="st2-fields"><label class="cl-fgroup"><span>نص أسفل الوثائق</span><input class="input" v-model="docs.footer"></label>
              <label class="st2-check"><input type="checkbox" :checked="!!docs.show_description" @change="docs.show_description = $event.target.checked ? 1 : 0"><span>إظهار وصف البطاقة في البون والعرض</span></label>
              <label class="cl-fgroup" style="max-width:220px"><span>صلاحية Devis</span><div class="unit-wrap"><input class="input num" v-model="docs.quote_days" inputmode="numeric"><span class="u">يوم</span></div></label>
              <label class="cl-fgroup" style="max-width:220px"><span>مهلة الدفع</span><div class="unit-wrap"><input class="input num" v-model="docs.payment_days" inputmode="numeric"><span class="u">يوم</span></div></label>
              <span class="muted">الطابع الجبائي على الدفع نقدًا غير مفعّل بعد في هذه النسخة.</span></div></div>
        </div>

        <template v-else-if="tab === 'team'">
          <div class="st2-card">
            <div class="st2-grp"><div class="st2-lbl"><b>حسابات الدخول</b><span>«مدير» يرى كل شيء. «بائع» يعمل على الطلبات والعملاء ويقبض الدفعات، ولا يرى التكلفة والأرباح. «مصمم» و«طباعة» يريان البطاقات المسندة إليهما فقط بلا أسعار، فاربط كلًّا منهما باسمه في الفريق. لا تُكتب كلمة السر هنا: يُعطى الموظف رابطًا ليختارها.</span></div>
              <div class="st2-fields">
                <table class="cl-table st2-table"><thead><tr><th>الاسم</th><th>الصلاحية</th><th>الحالة</th><th></th></tr></thead><tbody>
                  <tr v-for="u in s.data.users" :key="u.name" style="cursor:default"><td><span class="cl-name">{{ u.full_name }}</span><span class="muted" style="display:block" dir="ltr">{{ u.name }}</span>
                      <span class="muted" style="display:block">{{ u.member ? 'في الفريق باسم «' + u.member + '»' : 'غير مربوط باسم في الفريق' }}<template v-if="u.last_login"> · آخر دخول {{ ago(u.last_login) }}</template>
                        <button v-if="!u.member" type="button" class="cl-link" style="margin-inline-start:6px" :disabled="!!busy" @click="addToTeam(u)">إضافة إلى الفريق</button></span></td>
                    <td><select class="input" style="width:auto;min-height:34px" v-model="u.role" :aria-label="'صلاحية ' + u.full_name"><option value="manager">مدير</option><option value="sales">بائع</option><option value="designer">مصمم</option><option value="printer">طباعة</option></select></td>
                    <td><label class="st2-check"><input type="checkbox" :checked="!!u.enabled" @change="u.enabled = $event.target.checked ? 1 : 0"><span>مفعّل</span></label></td>
                    <td class="n"><button type="button" class="cl-btn sm" :disabled="!!busy" @click="saveUser(u)">حفظ</button> <button type="button" class="cl-btn sm ghost" :disabled="!!busy" @click="resetLink(u)">رابط كلمة السر</button></td></tr>
                  <tr v-if="!s.data.users.length"><td colspan="4" class="cl-empty">لا حسابات بعد.</td></tr></tbody></table>
                <form class="st2-row st2-newu" @submit.prevent="saveUser()"><label class="cl-fgroup"><span>الاسم</span><input class="input" v-model="nu.full_name"></label>
                  <label class="cl-fgroup grow2"><span>البريد</span><input class="input" v-model="nu.email" type="email" dir="ltr"></label>
                  <label class="cl-fgroup" style="flex:0 0 130px"><span>الصلاحية</span><select class="input" v-model="nu.role"><option value="manager">مدير</option><option value="sales">بائع</option><option value="designer">مصمم</option><option value="printer">طباعة</option></select></label>
                  <button type="submit" class="cl-btn primary" style="align-self:flex-end" :disabled="!nu.email || !!busy"><Icon name="plus" :size="15"/>إنشاء حساب</button></form>
                <div v-if="link" class="st2-link"><b>رابط اختيار كلمة السر لـ {{ link.email }}</b><span class="muted">أرسله للموظف ليختار كلمة سره بنفسه.</span>
                  <div class="row" style="gap:6px"><input class="input" :value="link.url" readonly dir="ltr" aria-label="الرابط" @focus="$event.target.select()"><button type="button" class="cl-btn" @click="copy(link.url)">نسخ</button></div></div>
              </div></div>
            <div class="st2-grp"><div class="st2-lbl"><b>أسماء الفريق</b><span>الأسماء التي تُسند إليها البطاقات. اربط كل اسم ببريد حسابه ليعمل «مهامي» والتنبيهات.</span></div>
              <div class="st2-fields"><TeamPage :embedded="true"/></div></div>
          </div>
        </template>

        <div v-else-if="tab === 'columns' || tab === 'statuses' || tab === 'calendar'" class="st2-card st2-embed"><BoardSettings :embedded="true" :only="tab" :key="tab"/></div>
        <div v-else-if="tab === 'prices'" class="st2-card st2-embed"><PricesPage :embedded="true"/></div>
        <div v-else-if="tab === 'lists'" class="st2-card"><ListEditor v-for="l in LIST_DEFS" :key="l.key" :def="l"/></div>

        <div v-else-if="tab === 'funds'" class="st2-card">
          <div class="st2-grp"><div class="st2-lbl"><b>الصناديق</b><span>الأسماء التي تظهر في صفحة المال وفي تسجيل الدفعات.</span></div>
            <div class="st2-fields"><div v-for="x in s.data.funds" :key="x.name" class="st2-line"><span class="muted" style="min-width:44px">{{ x.account_type === 'Bank' ? 'بنك' : 'نقد' }}</span>
              <input class="input" v-model="x.account_name" :aria-label="'اسم ' + x.name"><button type="button" class="cl-btn sm" :disabled="!!busy" @click="renameFund(x)">حفظ</button><button type="button" class="cl-btn sm" :disabled="!!busy" @click="removeFund(x)">حذف</button></div>
              <div class="st2-line"><select class="input" style="width:auto" v-model="newFund.type" aria-label="نوع الصندوق الجديد"><option value="Cash">نقد</option><option value="Bank">بنك</option></select><input class="input" v-model="newFund.label" aria-label="اسم الصندوق الجديد" placeholder="صندوق جديد"><button type="button" class="cl-btn sm" :disabled="!!busy || !newFund.label.trim()" @click="addFund">+ إضافة</button></div></div></div>
          <OpeningGroup :key="s.data.funds.length"/>
          <div class="st2-grp"><div class="st2-lbl"><b>طرق الدفع</b><span>إلى أي صندوق يدخل المال حسب طريقة الدفع.</span></div>
            <div class="st2-fields"><div v-for="m in s.data.modes" :key="m.value" class="st2-line"><input class="input" style="width:150px;flex:none" v-model="m.label" :aria-label="'اسم الطريقة ' + m.value">
              <select class="input" v-model="m.account" :aria-label="'صندوق ' + m.label"><option :value="null" disabled>غير محدد</option><option v-for="x in s.data.all_funds" :key="x.name" :value="x.name">{{ x.account_name }}</option></select>
              <button type="button" class="cl-btn sm" :disabled="!!busy || !m.account" @click="setMode(m)">حفظ</button><button type="button" class="cl-btn sm" :disabled="!!busy" @click="removeMode(m)">حذف</button></div>
              <div class="st2-line"><input class="input" v-model="newMode.label" aria-label="اسم طريقة الدفع الجديدة" placeholder="طريقة جديدة"><select class="input" v-model="newMode.account" aria-label="صندوق الطريقة الجديدة"><option :value="null" disabled>الصندوق</option><option v-for="x in s.data.funds" :key="x.name" :value="x.name">{{ x.account_name }}</option></select><button type="button" class="cl-btn sm" :disabled="!!busy || !newMode.label.trim() || !newMode.account" @click="addMode">+ إضافة</button></div></div></div>
        </div>

        <div v-else-if="tab === 'alerts'" class="st2-card">
          <div class="st2-grp"><div class="st2-lbl"><b>التنبيهات داخل التطبيق</b><span>تظهر في الجرس لكل عضو مربوط بحساب. لا يُرسل بريد.</span></div>
            <div class="st2-fields">
              <label class="st2-check"><input type="checkbox" :checked="!!alerts.assign" @change="alerts.assign = $event.target.checked ? 1 : 0"><span>عند إسناد بطاقة لشخص</span></label>
              <label class="st2-check"><input type="checkbox" :checked="!!alerts.mention" @change="alerts.mention = $event.target.checked ? 1 : 0"><span>عند ذكر شخص بـ «@» في تعليق</span></label>
              <label class="st2-check"><input type="checkbox" :checked="!!alerts.due" @change="alerts.due = $event.target.checked ? 1 : 0"><span>المواعيد القريبة والمتأخرة</span></label></div></div>
        </div>

        <div v-else-if="tab === 'mail'" class="st2-card">
          <div class="st2-grp"><div class="st2-lbl"><b>البريد الصادر</b><span>بريد المطبعة الذي تُرسل منه رسائل «نسيت كلمة السر» وروابط الحسابات الجديدة. كلمة السر تُحفظ مشفّرة، ولا تظهر بعد الحفظ.</span></div>
            <div class="st2-fields">
              <div class="row" style="gap:6px;flex-wrap:wrap"><span class="muted">إعداد سريع:</span><button v-for="x in MAIL_PRESETS" :key="x[0]" type="button" class="cl-btn sm" @click="mail.smtp_server = x[1]; mail.smtp_port = x[2]; mail.security = x[3]">{{ x[0] }}</button></div>
              <div class="st2-row"><label class="cl-fgroup grow2"><span>البريد</span><input class="input" v-model="mail.email_id" type="email" dir="ltr" autocomplete="off"></label>
                <label class="cl-fgroup"><span>اسم الدخول (إن كان مختلفًا)</span><input class="input" v-model="mail.login_id" dir="ltr" autocomplete="off"></label></div>
              <div class="st2-row"><label class="cl-fgroup grow2"><span>خادم الإرسال SMTP</span><input class="input" v-model="mail.smtp_server" dir="ltr" placeholder="smtp.gmail.com"></label>
                <label class="cl-fgroup"><span>المنفذ</span><input class="input num" v-model="mail.smtp_port" inputmode="numeric"></label>
                <label class="cl-fgroup"><span>الحماية</span><select class="input" v-model="mail.security"><option value="tls">TLS</option><option value="ssl">SSL</option><option value="none">بدون</option></select></label></div>
              <label class="cl-fgroup"><span>كلمة السر {{ s.data.email.has_password ? '(محفوظة — اتركها فارغة لإبقائها)' : '' }}</span><input class="input" v-model="mail.password" type="password" dir="ltr" autocomplete="new-password"></label>
              <span class="muted">مع Gmail استعمل «كلمة سر التطبيقات» من إعدادات حساب Google، لا كلمة سرك العادية.</span></div></div>
          <div class="st2-grp"><div class="st2-lbl"><b>تجربة الإرسال</b><span>بعد الحفظ، أرسل رسالة تجريبية للتأكد.</span></div>
            <div class="st2-fields"><div class="st2-row"><label class="cl-fgroup grow2"><span>إلى</span><input class="input" v-model="mailTo" type="email" dir="ltr" :placeholder="mail.email_id"></label>
              <button type="button" class="cl-btn" style="align-self:flex-end" :disabled="!s.data.email.configured || !!busy" @click="testMail">إرسال رسالة تجريبية</button></div>
              <span v-if="!s.data.email.configured" class="muted">البريد غير مضبوط بعد.</span></div></div>
        </div>

        <div v-else-if="tab === 'folders'" class="st2-card">
          <div class="st2-grp"><div class="st2-lbl"><b>مجلدات العملاء</b><span>عند إنشاء عميل يُنشأ له مجلد باسمه، وداخله مجلد لكل بطاقة. الملفات المرفوعة على البطاقة تُنسخ إليه. لا يُحذف أي مجلد أبدًا.</span></div>
            <div class="st2-fields">
              <label class="st2-check"><input type="checkbox" :checked="!!fold.enabled" @change="fold.enabled = $event.target.checked ? 1 : 0"><span>تفعيل المجلدات</span></label>
              <div v-if="!fold.available" class="st2-warn">القرص غير متصل بالبرنامج على هذا الحاسوب، فلن تُنشأ المجلدات حتى يتصل.</div>
              <div class="st2-row"><label class="cl-fgroup grow2"><span>المجلد الرئيسي</span><input class="input" v-model="fold.display_root" dir="ltr"></label>
                <label class="cl-fgroup"><span>مجلد العملاء داخله</span><input class="input" v-model="fold.sub"></label></div>
              <span class="muted">المجلد الرئيسي يحدده تشغيل البرنامج على الحاسوب (D:\\نسق افتراضيًا). غيّر هذا الحقل فقط إذا نُقل المجلد.</span></div></div>
          <div class="st2-grp"><div class="st2-lbl"><b>اسم مجلد البطاقة</b><span>التاريخ أولًا يرتّب المشاريع من الأقدم إلى الأحدث.</span></div>
            <div class="st2-fields">
              <label class="st2-check"><input type="radio" name="fold-order" value="date_first" v-model="fold.order"><span>التاريخ — المشروع</span></label>
              <label class="st2-check"><input type="radio" name="fold-order" value="title_first" v-model="fold.order"><span>المشروع — التاريخ</span></label>
              <span class="muted" dir="ltr" style="text-align:right">{{ fold.display_root }}\\{{ fold.sub }}\\مخبزة السعادة\\{{ foldSample }}</span></div></div>
          <div class="st2-grp"><div class="st2-lbl"><b>العملاء والبطاقات الموجودة</b><span>احفظ الإعدادات أولًا، ثم أنشئ المجلدات لما هو موجود مع نسخ ملفاته. يمكن تكرارها بأمان.</span></div>
            <div class="st2-fields"><button type="button" class="cl-btn" style="align-self:flex-start" :disabled="!fold.enabled || !fold.available || !!busy" @click="syncFolders">{{ busy === 'foldsync' ? 'جارٍ الإنشاء…' : 'إنشاء المجلدات الآن' }}</button>
              <span v-if="foldDone" class="muted">تمّ: {{ foldDone.customers }} عميل، {{ foldDone.cards }} بطاقة، {{ foldDone.files }} ملف منسوخ.</span></div></div>
        </div>

        <div v-else-if="tab === 'backup'" class="st2-card">
          <div class="st2-grp"><div class="st2-lbl"><b>النسخ الاحتياطي</b><span>نسخة كاملة من البيانات والملفات. احفظ نسخة خارج الجهاز من حين لآخر.</span></div>
            <div class="st2-fields"><button type="button" class="cl-btn primary" style="align-self:flex-start" :disabled="busy === 'backup'" @click="backup">{{ busy === 'backup' ? 'جارٍ إنشاء النسخة…' : 'إنشاء نسخة الآن' }}</button>
              <div v-for="b in s.data.backups" :key="b.file" class="st2-line"><span class="ellipsis" style="flex:1" dir="ltr">{{ b.file }}</span><span class="muted">{{ size(b.size) }}</span><a class="cl-btn sm" :href="b.url">تحميل</a></div>
              <span v-if="!s.data.backups.length" class="muted">لا نسخ بعد.</span></div></div>
        </div>
      </div>
    </div>

    <div v-if="preview" class="overlay tm-overlay" @click.self="preview = false">
      <div class="st2-preview" role="dialog" aria-modal="true" aria-label="معاينة الفاتورة">
        <div class="cl-head-row" style="padding:14px 18px;border-bottom:1px solid #E4E7EC"><b>معاينة الفاتورة</b><span class="spacer"></span><button type="button" class="cl-btn icon ghost" aria-label="إغلاق" @click="preview = false"><Icon name="x" :size="18"/></button></div>
        <div class="st-paper" style="box-shadow:none;margin:18px">
          <div class="st-ph"><div><b class="st-pn">{{ p.name_ar || 'اسم المطبعة' }}</b><span v-if="p.name_fr" dir="ltr">{{ p.name_fr }}</span><span v-if="p.address || p.city">{{ [p.address, p.city].filter(Boolean).join('، ') }}</span>
              <span v-if="p.phone" dir="ltr">{{ p.phone }}<template v-if="p.phone2"> · {{ p.phone2 }}</template></span>
              <span dir="ltr" class="st-legal">{{ [p.rc && 'RC ' + p.rc, p.nif && 'NIF ' + p.nif, p.nis && 'NIS ' + p.nis, p.ai && 'AI ' + p.ai].filter(Boolean).join(' · ') || 'RC · NIF · NIS · AI' }}</span></div>
            <img v-if="p.logo" :src="p.logo" alt="" class="st-plogo"></div>
          <div class="row" style="justify-content:space-between"><b>فاتورة</b><span dir="ltr" class="muted">ACC-SINV-2026-00007</span></div>
          <div class="st-pbox"><b>مخبزة السعادة</b><span dir="ltr" class="muted">RC 19/00-1234567 B 22 · NIF 001919012345678</span></div>
          <div class="st-plines"><div class="bd-line"><span>لافتة 3×1 م</span><b>6,000.00</b></div><div class="bd-line"><span>أكياس 2000</span><b>12,000.00</b></div></div>
          <div class="bd-line"><span>{{ docs.tva ? 'المجموع خارج الرسم' : 'المجموع' }}</span><b>{{ fig(sample.net) }}</b></div>
          <div v-if="docs.tva" class="bd-line"><span>TVA {{ docs.tva_rate }}%</span><b>{{ fig(sample.tax) }}</b></div>
          <div class="st-ptotal"><b>المجموع</b><b>{{ fig(sample.total) }} دج</b></div>
          <span class="st-pfoot">{{ docs.footer }}<template v-if="p.rib"> · RIB {{ p.rib }}</template></span>
        </div>
      </div>
    </div>
    <div v-if="dirtyForms.length" class="st2-savebar" role="status">لديك {{ dirtyForms.length === 1 ? 'تغيير غير محفوظ' : 'تغييرات غير محفوظة في ' + dirtyForms.length + ' أقسام' }}
      <button type="button" class="cl-btn sm st2-ghost" :disabled="saving2" @click="undoAll">تراجع</button><button type="button" class="cl-btn primary sm" :disabled="saving2" @click="saveAll">{{ saving2 ? 'جارٍ الحفظ…' : 'حفظ' }}</button></div>
    <div v-if="leaveTo" class="overlay tm3-confirm tb-confirm" role="alertdialog" aria-modal="true" aria-labelledby="st-leave-h" @click.self="leaveTo = null">
      <div class="tm3-cbox"><b id="st-leave-h">تغييرات غير محفوظة</b><p>لم تحفظ تعديلاتك في هذا القسم. ماذا تريد قبل الانتقال؟</p>
        <div class="row" style="justify-content:flex-end;gap:8px"><button type="button" class="cl-btn" @click="leaveTo = null">البقاء</button><button type="button" class="cl-btn" @click="leave('drop')">تجاهل</button><button type="button" class="cl-btn primary" @click="leave('save')">حفظ والانتقال</button></div></div></div>
  </div>`,
};

// ------------------------------------------------------------------ reports, classic
const ReportsPage2 = {
  components: { Icon },
  setup() {
    const period = ref("month"), from = ref(""), to = ref(""), custom = ref(false);
    const { s, load } = useLoad(() => call("reports2", period.value === "custom" ? { period: "custom", start: from.value, end: to.value } : { period: period.value }));
    onMounted(load);
    const setPeriod = (p) => { if (p === "custom") { custom.value = true; return; } custom.value = false; period.value = p; load(); };
    const applyCustom = () => { if (!from.value || !to.value) return; period.value = "custom"; custom.value = false; load(); };
    const d = computed(() => s.data);
    const PERIODS = [["month", "الشهر"], ["quarter", "الربع"], ["year", "السنة"], ["custom", "فترة…"]];
    const pname = (iso, kind) => { const x = parseDate(iso);
      if (kind === "year") return "سنة " + x.getFullYear();
      if (kind === "quarter") return `الربع ${["الأول", "الثاني", "الثالث", "الرابع"][Math.floor(x.getMonth() / 3)]} ${x.getFullYear()}`;
      if (kind === "month") return new Intl.DateTimeFormat("ar", { month: "long", year: "numeric" }).format(x);
      return date(iso); };
    const title = computed(() => { const p = d.value?.period; if (!p) return "";
      return p.kind === "custom" ? `${date(p.from)} — ${date(p.to)}` : `${pname(p.from, p.kind)} · مقارنة بـ ${pname(p.prev_from, p.kind)}`; });
    const cmp = (now, prev) => { if (!(prev > 0.005)) return "لا أرقام للفترة السابقة"; const p = Math.round(((now - prev) / prev) * 100);
      return p === 0 ? "مثل الفترة السابقة" : `${p > 0 ? "أكثر" : "أقل"} بـ ${Math.abs(p)}% من الفترة السابقة`; };
    const pct = (a, b) => (b > 0.005 ? Math.round((a / b) * 100) : 0);
    const maxM = computed(() => Math.max(1, ...(d.value?.months || []).flatMap((m) => [m.sales, m.expenses])));
    const mlabel = (iso) => new Intl.DateTimeFormat("ar", { month: "short" }).format(parseDate(iso));
    const ageTotal = computed(() => Object.values(d.value?.ageing || {}).reduce((x, y) => x + y, 0));
    const AGES = [["current", "لم يحن موعدها", "#667085"], ["d30", "1–30 يومًا", "#B54708"], ["d60", "31–60 يومًا", "#B42318"], ["older", "أكثر من 60 يومًا", "#7A271A"]];
    const maxTop = (l) => Math.max(1, ...(l || []).map((x) => x.total));
    const exportCsv = () => {
      const n = d.value.now, rows = [["البند", "القيمة"], ["الفترة", title.value], ["المبيعات المفوترة", n.invoiced], ["المحصّل", n.collected], ["المصاريف", n.expenses], ["الربح", n.profit],
        ["عدد الطلبات", n.orders], [], ["الطلب", "العميل", "المبيعات", "التكلفة", "الربح", "الهامش %"], ...d.value.profit.map((r) => [r.title, r.customer, r.revenue, r.cost, r.result, r.margin]),
        [], ["طريقة الدفع", "المبلغ", "عدد الدفعات"], ...(d.value.by_mode || []).map((x) => [x.label, x.total, x.n]),
        [], ["نوع المصروف", "المبلغ"], ...(d.value.expense_types || []).map((x) => [x.name, x.total]),
        [], ["المورد", "المشتريات", "الفواتير"], ...(d.value.purchases || []).map((x) => [x.name, x.total, x.n]),
        [], ["المادة المصروفة", "الكمية", "القيمة"], ...(d.value.materials || []).map((x) => [x.name, x.qty, x.total])];
      const text = "﻿" + rows.map((r) => r.map((v) => '"' + String(v ?? "").replace(/"/g, '""') + '"').join(",")).join("\n");
      const el = document.createElement("a"); el.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" })); el.download = `تقرير ${title.value}.csv`; el.click();
    };
    const printIt = () => window.print();
    const marginTone = (m) => (m === null ? "" : m < 15 ? "bad" : m < 35 ? "warn" : "ok");
    const ageOpen = ref(null);
    const kfig = (v) => figN(Math.round((+v || 0) / 1000));
    const sumOf = (l) => (l || []).reduce((x, y) => x + (+y.total || 0), 0);
    const isCur = (iso) => d.value && String(iso).slice(0, 7) === String(d.value.period.to).slice(0, 7);
    return { figN, ageOpen, kfig, sumOf, isCur, uom, s, load, d, period, from, to, custom, setPeriod, applyCustom, PERIODS, title, cmp, pct, maxM, mlabel, ageTotal, AGES, maxTop, exportCsv, printIt, marginTone, money, fig, date, go };
  },
  template: `
  <div class="cl rp">
    <div class="cl-main">
      <header class="cl-head"><div class="cl-head-row">
        <div style="min-width:0"><h1>التقارير</h1><div class="muted">{{ title }}</div></div><span class="spacer"></span>
        <div class="mn-month cb-views" role="group" aria-label="الفترة">
          <button v-for="p in PERIODS" :key="p[0]" type="button" :aria-pressed="(p[0] === 'custom' ? custom || period === 'custom' : !custom && period === p[0])" @click="setPeriod(p[0])">{{ p[1] }}</button></div>
        <button type="button" class="cl-btn" :disabled="!d" @click="exportCsv"><Icon name="file" :size="16"/>تصدير Excel</button>
        <button type="button" class="cl-btn" :disabled="!d" @click="printIt"><Icon name="printer" :size="16"/>طباعة</button></div>
        <form v-if="custom" class="cl-head-row rp-custom" @submit.prevent="applyCustom"><label class="cl-fgroup"><span>من</span><input type="date" class="input" v-model="from"></label>
          <label class="cl-fgroup"><span>إلى</span><input type="date" class="input" v-model="to"></label><button type="submit" class="cl-btn primary" style="align-self:flex-end" :disabled="!from || !to">عرض</button></form>
      </header>
      <div v-if="s.loading && !s.data" class="ws-loading">جارٍ التحميل…</div>
      <div v-else-if="s.error" class="alert error" style="margin:20px 28px">{{ s.error }}</div>
      <template v-else-if="d">
        <div class="cl-stats mn-stats rp-stats">
          <div><span>المبيعات المفوترة</span><b class="money">{{ money(d.now.invoiced) }}</b><small>{{ cmp(d.now.invoiced, d.prev.invoiced) }}</small></div>
          <div><span>المحصّل</span><b class="money ok">{{ money(d.now.collected) }}</b><small>{{ d.now.invoiced ? pct(d.now.collected, d.now.invoiced) + '% من المفوتر' : '—' }}</small></div>
          <div><span>المصاريف</span><b class="money bad">{{ money(d.now.expenses) }}</b><small>{{ cmp(d.now.expenses, d.prev.expenses) }}</small></div>
          <div><span>الربح</span><b class="money" :class="{bad: d.now.profit < 0}">{{ money(d.now.profit) }}</b><small>{{ d.now.income ? 'هامش ' + pct(d.now.profit, d.now.income) + '%' : '—' }}</small></div>
          <div><span>عدد الطلبات</span><b>{{ d.now.orders }}</b><small>{{ d.now.orders ? 'متوسط الطلب ' + fig(d.now.orders_total / d.now.orders) + ' دج' : '—' }}</small></div>
          <div><span>في الوقت</span><b>{{ d.now.delivered ? pct(d.now.delivered - d.now.late, d.now.delivered) + '%' : '—' }}</b><small>{{ d.now.delivered ? d.now.late + ' من ' + d.now.delivered + ' سُلّمت متأخرة' : 'لا تسليمات في الفترة' }}</small></div>
        </div>
        <div class="mn-grid">
          <div class="mn-col">
            <section class="mn-card"><div class="mn-card-h"><b>المبيعات والمصاريف</b><span class="mn-legend"><span><i class="rp-s"></i>المبيعات</span><span><i class="rp-e"></i>المصاريف</span><span>آخر 12 شهرًا · بالآلاف</span></span></div>
              <div class="mn-chart rp-chart" role="img" aria-label="المبيعات والمصاريف لآخر 12 شهرًا">
                <div v-for="m in d.months" :key="m.month" class="mn-wk rp-mo" :class="{cur: isCur(m.month)}" :title="mlabel(m.month) + ': مبيعات ' + fig(m.sales) + ' · مصاريف ' + fig(m.expenses)">
                  <span class="rp-v">{{ kfig(m.sales) }}</span><span class="rp-v2">{{ kfig(m.expenses) }}</span>
                  <div class="mn-bars"><span class="rp-s" :style="{height: (m.sales / maxM * 100) + '%'}"></span><span class="rp-e" :style="{height: (m.expenses / maxM * 100) + '%'}"></span></div><small>{{ mlabel(m.month) }}</small></div></div></section>
            <section class="mn-card"><div class="mn-card-h"><b>ربحية الطلبات</b><span class="muted">الأقل ربحًا أولًا</span></div>
              <table class="cl-table mn-table"><thead><tr><th>الطلب</th><th class="n">المبيعات</th><th class="n desktop-only">التكلفة</th><th class="n">الربح</th><th class="n">الهامش</th></tr></thead><tbody>
                <tr v-if="!d.profit.length"><td colspan="5" class="cl-empty">لا طلبات مفوترة في هذه الفترة.</td></tr>
                <tr v-for="r in d.profit" :key="r.name" @click="go('/?card=' + encodeURIComponent(r.name))"><td style="white-space:normal"><span class="cl-name">{{ r.title }}</span><span class="muted" style="display:block">{{ r.customer }}</span></td>
                  <td class="n">{{ fig(r.revenue) }}</td><td class="n desktop-only muted">{{ fig(r.cost) }}</td><td class="n"><span class="cl-bal" :class="r.result < 0 ? 'bad' : ''">{{ fig(r.result) }}</span></td>
                  <td class="n"><span class="rp-m" :class="marginTone(r.margin)">{{ r.margin === null ? '—' : r.margin + '%' }}</span></td></tr></tbody></table></section>
            <section class="mn-card"><div class="mn-card-h"><b>أعمار الديون</b><b class="bad">{{ money(ageTotal) }}</b></div>
              <div class="rp-ages"><button v-for="x in AGES" :key="x[0]" type="button" class="rp-age" :aria-pressed="ageOpen === x[0]" :disabled="!(d.debtors && d.debtors[x[0]] || []).length" @click="ageOpen = ageOpen === x[0] ? null : x[0]"><span class="muted">{{ x[1] }}</span><b :style="{color: x[2]}">{{ fig(d.ageing[x[0]]) }}</b><i :style="{background: x[2], width: Math.max(2, pct(d.ageing[x[0]], ageTotal)) + '%'}"></i></button></div>
              <div v-if="ageOpen && d.debtors" class="rp-debtors"><button v-for="x in d.debtors[ageOpen]" :key="x.invoice" type="button" class="rp-rank rp-link" @click="go('/customers/' + encodeURIComponent(x.customer))">
                <div style="flex:1;min-width:0"><span class="cl-name ellipsis" style="display:block">{{ x.customer_name }}</span><span class="muted">فاتورة {{ x.invoice }}<template v-if="x.late"> · متأخرة {{ x.late }} {{ x.late <= 10 ? 'أيام' : 'يومًا' }}</template></span></div>
                <div class="rp-val"><b>{{ fig(x.amount) }}</b></div><span class="rp-go">‹ فتح</span></button></div></section>
            <section class="mn-card"><div class="mn-card-h"><b>المحصّل حسب طريقة الدفع</b><span class="muted">{{ money(sumOf(d.by_mode)) }}</span></div>
              <div v-if="!(d.by_mode || []).length" class="mn-empty">لا دفعات في هذه الفترة.</div>
              <div v-else class="rp-modes"><div v-for="x in d.by_mode" :key="x.mode || 'x'"><span class="muted">{{ x.label }}</span><b>{{ fig(x.total) }}</b><small class="muted">{{ pct(x.total, sumOf(d.by_mode)) }}% · {{ x.n }} {{ x.n === 1 ? 'دفعة' : 'دفعات' }}</small></div></div></section>
          </div>
          <div class="mn-col">
            <section class="mn-card"><div class="mn-card-h"><b>أفضل العملاء</b><span class="muted">بالمبيعات · اضغط لفتح العميل</span></div>
              <div v-if="!d.top_customers.length" class="mn-empty">لا مبيعات في هذه الفترة.</div>
              <div v-for="(c, i) in d.top_customers" :key="c.name" class="rp-rank rp-link" role="link" tabindex="0" @click="c.customer && go('/customers/' + encodeURIComponent(c.customer))" @keydown.enter="c.customer && go('/customers/' + encodeURIComponent(c.customer))"><span class="muted">{{ i + 1 }}</span><div style="flex:1;min-width:0"><span class="cl-name ellipsis" style="display:block">{{ c.name }}</span><div class="mn-catbar"><span :style="{width: (c.total / maxTop(d.top_customers) * 100) + '%'}"></span></div></div>
                <div class="rp-val"><b>{{ fig(c.total) }}</b><span class="muted">{{ c.n }} {{ c.n === 1 ? 'فاتورة' : 'فواتير' }}</span></div></div></section>
            <section class="mn-card"><div class="mn-card-h"><b>المصاريف حسب النوع</b><span class="muted">{{ money(sumOf(d.expense_types)) }}</span></div>
              <div v-if="!(d.expense_types || []).length" class="mn-empty">لا مصاريف في هذه الفترة.</div>
              <div v-for="c in d.expense_types" :key="c.name" class="rp-rank"><div style="flex:1;min-width:0"><span class="cl-name ellipsis" style="display:block">{{ c.name }}</span><div class="mn-catbar rp-bar-o"><span :style="{width: pct(c.total, maxTop(d.expense_types)) + '%'}"></span></div></div>
                <div class="rp-val"><b>{{ fig(c.total) }}</b><span class="muted">{{ pct(c.total, sumOf(d.expense_types)) }}%</span></div></div></section>
            <section class="mn-card"><div class="mn-card-h"><b>المشتريات حسب المورد</b><span class="muted">{{ money(sumOf(d.purchases)) }}</span></div>
              <div v-if="!(d.purchases || []).length" class="mn-empty">لا مشتريات في هذه الفترة.</div>
              <div v-for="c in d.purchases" :key="c.supplier" class="rp-rank"><div style="flex:1;min-width:0"><span class="cl-name ellipsis" style="display:block">{{ c.name }}</span><div class="mn-catbar rp-bar-g"><span :style="{width: pct(c.total, maxTop(d.purchases)) + '%'}"></span></div></div>
                <div class="rp-val"><b>{{ fig(c.total) }}</b><span class="muted">{{ c.n }} {{ c.n === 1 ? 'فاتورة' : 'فواتير' }}</span></div></div></section>
            <section class="mn-card"><div class="mn-card-h"><b>المواد المصروفة من المخزون</b><span class="muted">{{ money(sumOf(d.materials)) }}</span></div>
              <div v-if="!(d.materials || []).length" class="mn-empty">لم تُصرف مواد في هذه الفترة.</div>
              <table v-else class="cl-table mn-table"><thead><tr><th>المادة</th><th class="n">الكمية</th><th class="n">القيمة</th></tr></thead><tbody>
                <tr v-for="x in d.materials" :key="x.item_code" style="cursor:default"><td>{{ x.name }}</td><td class="n">{{ figN(x.qty) }} {{ uom(x.uom) }}</td><td class="n">{{ fig(x.total) }}</td></tr></tbody></table></section>
            <section class="mn-card"><div class="mn-card-h"><b>أكثر الخدمات طلبًا</b></div>
              <div v-if="!d.top_services.length" class="mn-empty">لا طلبات في هذه الفترة.</div>
              <div v-for="(c, i) in d.top_services" :key="c.name" class="rp-rank"><span class="muted">{{ i + 1 }}</span><div style="flex:1;min-width:0"><span class="cl-name ellipsis" style="display:block">{{ c.name }}</span><div class="mn-catbar"><span :style="{width: (c.total / maxTop(d.top_services) * 100) + '%'}"></span></div></div>
                <div class="rp-val"><b>{{ fig(c.total) }}</b><span class="muted">{{ c.n }} {{ c.n === 1 ? 'طلب' : 'طلبات' }}</span></div></div></section>
            <section class="mn-card"><div class="mn-card-h"><b>عمل الفريق</b><span class="muted">أُنجز في الفترة · جارٍ الآن</span></div>
              <table class="cl-table mn-table"><thead><tr><th>الشخص</th><th class="n">أنجز</th><th class="n">جارية</th><th class="n">متأخرة</th></tr></thead><tbody>
                <tr v-if="!d.team.length"><td colspan="4" class="cl-empty">لا بطاقات مسندة بعد.</td></tr>
                <tr v-for="t in d.team" :key="t.name" style="cursor:default"><td><span class="cl-name">{{ t.name }}</span><span v-if="t.role" class="muted"> · {{ t.role }}</span></td>
                  <td class="n">{{ t.done }}</td><td class="n">{{ t.open }}</td><td class="n"><span :class="{'rp-late': t.late}">{{ t.late }}</span></td></tr></tbody></table></section>
          </div>
        </div>
      </template>
    </div>
  </div>`,
};

// ------------------------------------------------------------------ design system reference (/atelier/ds)
const DS_COLORS = [
  ["--primary", "الرئيسي"], ["--primary-weak", "الرئيسي الفاتح"], ["--accent", "علامة (ليموني)"], ["--nav-bg", "القائمة"],
  ["--ink", "النص"], ["--ink-3", "النص الثانوي"], ["--bg", "الخلفية"], ["--line", "الحدود"],
  ["--success", "نجاح"], ["--warning", "تحذير"], ["--danger", "خطر"], ["--info", "معلومة"],
];

// ------------------------------------------------------------------ more (phone)


// Receipts: photos are shrunk to 1600px JPEG before upload (phone photos are often 5–10 MB); PDFs go as they are.
async function shrinkImage(file) {
  if (!file.type.startsWith("image/") || file.type === "image/gif" || file.size < 400 * 1024) return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.82));
    return blob && blob.size < file.size ? new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" }) : file;
  } catch { return file; }
}
async function uploadPrivate(file, doctype, docname) {
  const fd = new FormData();
  fd.append("file", file, file.name); fd.append("doctype", doctype); fd.append("docname", docname); fd.append("is_private", "1");
  const res = await fetch("/api/method/upload_file", { method: "POST", body: fd, credentials: "same-origin", headers: { "X-Frappe-CSRF-Token": window.csrf_token } });
  if (!res.ok) throw new Error(serverMessage(await res.json().catch(() => ({}))));
  return (await res.json()).message;
}

// ------------------------------------------------------------------ expense sheet
const ExpenseSheet = {
  props: ["opts"], components: { Icon },
  setup(props) {
    const f = reactive({ account: "", amount: "", mode: "Cash", description: "", order: props.opts.order || "", date: todayISO() });
    const receipt = ref(null), receiptError = ref(null), uploadWarn = ref(null), fileInput = ref(null);
    const onFile = (e) => {
      const file = e.target.files?.[0]; receiptError.value = null;
      if (!file) return;
      if (!/^image\/|^application\/pdf$/.test(file.type)) { receiptError.value = t("e_receipt_type"); e.target.value = ""; return; }
      if (file.size > 15 * 1048576) { receiptError.value = t("e_receipt_big"); e.target.value = ""; return; }
      receipt.value = { file, name: file.name, size: file.size, url: file.type.startsWith("image/") ? URL.createObjectURL(file) : null };
    };
    const dropReceipt = () => { if (receipt.value?.url) URL.revokeObjectURL(receipt.value.url); receipt.value = null; if (fileInput.value) fileInput.value.value = ""; };
    onBeforeUnmount(dropReceipt);
    const opts = ref(null), loadError = ref(null), saving = ref(false), error = ref(null), attempted = ref(false), done = ref(null), q = ref("");
    onMounted(async () => {
      try { opts.value = await call("expense_options"); } catch (e) { loadError.value = e.message; }
    });
    const label = (a) => (a.account_number ? a.account_number + " — " : "") + a.account_name;
    const frequent = computed(() => (opts.value?.accounts || []).filter((a) => a.used).sort((a, b) => b.used - a.used).slice(0, 6));
    const matches = computed(() => {
      const n = q.value.trim().toLowerCase();
      if (!n) return [];
      return (opts.value?.accounts || []).filter((a) => label(a).toLowerCase().includes(n)).slice(0, 8);
    });
    const chosen = computed(() => (opts.value?.accounts || []).find((a) => a.name === f.account));
    const pick = (a) => { f.account = a.name; q.value = ""; };
    const errs = computed(() => ({
      account: !f.account ? t("e_err_account") : null, amount: !(+f.amount > 0) ? t("err_amount") : null,
      description: !f.description.trim() ? t("e_err_desc") : null,
    }));
    const close = () => (state.sheet = null);
    const onKey = (e) => { if (e.key === "Escape") close(); };
    onMounted(() => { window.addEventListener("keydown", onKey); setTimeout(() => document.getElementById("e-a")?.focus(), 50); });
    onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
    async function save() {
      attempted.value = true; error.value = null;
      const first = ["account", "amount", "description"].find((k) => errs.value[k]);
      if (first) { document.getElementById({ account: "e-q", amount: "e-a", description: "e-d" }[first])?.focus(); return; }
      saving.value = true;
      try {
        done.value = await call("record_expense", { account: f.account, amount: +f.amount, mode_of_payment: f.mode, description: f.description,
          sales_order: f.order || null, posting_date: f.date }, true);
        if (receipt.value) {
          // The expense is already booked; a failed upload must not hide that.
          try { await uploadPrivate(await shrinkImage(receipt.value.file), "Journal Entry", done.value.name); done.value.receipt = true; }
          catch (e) { uploadWarn.value = t("e_receipt_failed", e.message || t("error_net")); }
        }
        toast(t("e_done", done.value.name));
      } catch (e) { error.value = e.message; }
      saving.value = false;
    }
    const again = () => { Object.assign(f, { account: "", amount: "", description: "", order: "" }); dropReceipt(); uploadWarn.value = null; done.value = null; attempted.value = false; };
    return { receipt, receiptError, uploadWarn, fileInput, onFile, dropReceipt, fileSize, f, opts, loadError, saving, error, attempted, errs, save, close, done, again, q, frequent, matches, chosen, pick, label, t, money, state, date, dfw, parseDate };
  },
  template: `
  <div class="overlay" @click.self="close" role="dialog" aria-modal="true" aria-labelledby="exp-h">
    <form class="sheet" novalidate @submit.prevent="save">
      <div class="sh-head"><div><h2 id="exp-h">{{ t('e_title') }}</h2><span class="muted">يُخصم من الصندوق ويظهر في صفحة المال</span></div><button type="button" class="cl-btn icon ghost" :aria-label="t('close')" @click="close"><Icon name="x" :size="18"/></button></div>
      <template v-if="done">
        <div class="alert success"><Icon name="check" :size="16"/><span>{{ t('e_done', done.name) }}<template v-if="done.project"> · {{ t('e_on_order') }}</template><template v-if="done.receipt"> · {{ t('e_receipt_saved') }}</template></span></div>
        <div v-if="uploadWarn" class="alert warn" role="alert"><Icon name="alert" :size="16"/><span>{{ uploadWarn }}</span></div>
        <div class="row wrap"><button type="button" class="btn primary" @click="again">{{ t('e_another') }}</button>
          <button type="button" class="btn ghost" @click="close">{{ t('close') }}</button></div>
      </template>
      <div v-else-if="loadError" class="alert error" role="alert"><Icon name="alert" :size="16"/><span>{{ loadError }}</span></div>
      <div v-else-if="!opts" class="meta">{{ t('loading') }}</div>
      <template v-else>
        <div v-if="error" class="alert error" role="alert"><Icon name="alert" :size="16"/><span>{{ error }}</span></div>
        <div class="field"><label for="e-a" class="req">{{ t('p_amount') }} ({{ t('currency') }})</label>
          <input id="e-a" class="input num" :class="{invalid: attempted && errs.amount}" type="text" inputmode="decimal" autocomplete="off" v-model="f.amount" placeholder="0.00" enterkeyhint="next">
          <span v-if="attempted && errs.amount" class="error-text">{{ errs.amount }}</span></div>
        <div class="field"><label for="e-d" class="req">{{ t('e_desc') }}</label>
          <input id="e-d" class="input" :class="{invalid: attempted && errs.description}" type="text" v-model="f.description" :placeholder="t('e_desc_ph')" enterkeyhint="next">
          <span v-if="attempted && errs.description" class="error-text">{{ errs.description }}</span></div>
        <div class="field"><label for="e-q" class="req">{{ t('e_account') }}</label>
          <div v-if="chosen" class="row" style="gap:8px"><span class="badge b-info" style="font-size:var(--fs-body);padding:6px 10px">{{ label(chosen) }}</span>
            <button type="button" class="btn sm ghost" @click="f.account=''">{{ t('of_change') }}</button></div>
          <template v-else>
            <div v-if="frequent.length || opts.accounts.length <= 16" class="chips" role="group" :aria-label="t('e_frequent')">
              <button v-for="a in (opts.accounts.length <= 16 ? opts.accounts : frequent)" :key="a.name" type="button" class="chip" @click="pick(a)">{{ a.account_name }}</button></div>
            <input v-if="opts.accounts.length > 16" id="e-q" class="input" :class="{invalid: attempted && errs.account}" type="search" v-model="q" :placeholder="t('e_account_ph')" autocomplete="off">
            <div v-if="matches.length" class="list" style="border:1px solid var(--line);border-radius:10px">
              <button v-for="a in matches" :key="a.name" type="button" class="list-item" @click="pick(a)"><span class="main-col"><span class="ellipsis">{{ label(a) }}</span></span></button></div>
            <span v-else-if="q" class="meta">{{ t('search_none', q) }}</span>
            <span v-if="attempted && errs.account" class="error-text">{{ errs.account }}</span>
          </template></div>
        <div class="field"><span class="label">{{ t('e_paid_from') }}</span>
          <div class="seg" role="group" :aria-label="t('e_paid_from')"><button v-for="m in state.boot.modes" :key="m.value" type="button" :aria-pressed="f.mode===m.value" @click="f.mode=m.value">{{ m.label }}</button></div></div>
        <div class="field"><label for="e-o">{{ t('e_order') }} <span class="cap">({{ t('optional') }})</span></label>
          <select id="e-o" class="input" v-model="f.order"><option value="">{{ t('e_order_none') }}</option>
            <option v-for="o in opts.orders" :key="o.name" :value="o.name">{{ (o.atelier_subject || o.name) + ' — ' + o.customer_name }}</option></select>
          <span class="hint">{{ f.order ? t('e_order_hint') : t('e_general_hint') }}</span></div>
        <div class="field"><span class="label">{{ t('e_receipt') }} <span class="cap">({{ t('optional') }})</span></span>
          <div v-if="receipt" class="row" style="gap:10px;border:1px solid var(--line);border-radius:10px;padding:8px">
            <img v-if="receipt.url" :src="receipt.url" alt="" style="width:56px;height:56px;object-fit:cover;border-radius:8px;flex-shrink:0">
            <Icon v-else name="file" :size="28" class="muted"/>
            <span style="min-width:0;flex:1;display:flex;flex-direction:column"><span class="ellipsis" dir="auto">{{ receipt.name }}</span><span class="meta" v-html="fileSize(receipt.size)"></span></span>
            <button type="button" class="btn sm ghost" @click="dropReceipt">{{ t('e_receipt_remove') }}</button></div>
          <label v-else for="e-r" class="btn" style="align-self:flex-start;cursor:pointer"><Icon name="image" :size="18"/>{{ t('e_receipt_add') }}</label>
          <input id="e-r" ref="fileInput" type="file" accept="image/*,application/pdf" class="sr-only" @change="onFile">
          <span v-if="receiptError" class="error-text">{{ receiptError }}</span>
          <span v-else class="hint">{{ t('e_receipt_hint') }}</span></div>
        <div class="field"><label for="e-dt">{{ t('c_date') }}</label>
          <input id="e-dt" class="input" type="date" v-model="f.date" :max="new Date().toISOString().slice(0,10)">
          <span v-if="f.date" class="hint">{{ dfw.format(parseDate(f.date)) }}</span></div>
<div class="sh-foot"><button type="submit" class="cl-btn primary" :disabled="saving">{{ saving ? t('of_saving') : t('e_save') }}</button><button type="button" class="cl-btn" @click="close">إلغاء</button></div>
      </template>
    </form>
  </div>`,
};

// ------------------------------------------------------------------ shell
const NAV = [
  { key: "orders", path: "/", icon: "orders", label: "nav_orders", match: ["home", "order", "order-new", "orders"] },
  { key: "customers", path: "/customers", icon: "users", label: "nav_customers", match: ["customer", "customers"], need: "customer" },
  { key: "suppliers", path: "/suppliers", icon: "factory", label: "nav_suppliers", match: ["suppliers", "supplier"], need: "finance" },
  { key: "money", path: "/money", icon: "wallet", label: "nav_money_simple", match: ["money"], need: "finance" },
];
const SECTION_NAV = [
  { key: "stock", path: "/stock", icon: "box", label: "nav_stock", match: ["stock"], need: "stock" },
  { key: "machines", path: "/machines", icon: "gear", label: "nav_machines", match: ["machines"] },
  { key: "prices", path: "/prices", icon: "tag", label: "nav_prices", match: ["prices"], need: "prices" },
  { key: "calc", path: "/calc", icon: "calc", label: "nav_calc", match: ["calc"], need: "finance" },
  { key: "reports", path: "/reports", icon: "chart", label: "nav_reports", match: ["reports"], need: "finance" },
  { key: "team", path: "/team", icon: "users", label: "nav_team", match: ["team"], need: "prices" },
];

// Delivery never waits for this: the sheet opens after it, and can be left for later from the card.
async function offerMaterials(order) {
  try {
    const m = await call("order_materials", { order });
    if (m.rows.length && !m.done) state.sheet = { type: "materials", order, rows: m.rows.map((r) => ({ ...r, qty: Math.min(r.need, r.on_hand) })) };
  } catch { /* the delivery itself already succeeded */ }
}
const MaterialsSheet = {
  props: ["opts"],
  setup(props) {
    const busy = ref(false), err = ref(null), rows = ref(props.opts.rows);
    const close = () => (state.sheet = null);
    const short = (r) => r.need > r.on_hand;
    const submit = async () => {
      busy.value = true; err.value = null;
      try { await call("issue_order_materials", { order: props.opts.order, rows: JSON.stringify(rows.value) }, true); toast("خُصمت المواد من المخزون"); state.rev++; close(); }
      catch (e) { err.value = e.message; } finally { busy.value = false; }
    };
    return { rows, busy, err, close, short, submit, uom };
  },
  template: `
  <div class="overlay" @click.self="close"><form class="sheet" @submit.prevent="submit"><div class="sh-head"><div><h2>مواد هذا الطلب</h2><span class="muted">راجع الكميات الفعلية قبل الخصم</span></div></div>
    <div v-if="err" class="alert error">{{ err }}</div>
    <div v-for="r in rows" :key="r.item_code" class="field"><label :for="'mt-' + r.item_code">{{ r.item_name }} ({{ uom(r.uom) }})</label><input :id="'mt-' + r.item_code" class="input num" inputmode="decimal" v-model="r.qty">
      <span class="muted" :class="{'bd-late': short(r)}">المتوقع {{ r.need }} · المتوفر {{ r.on_hand }}</span></div>
    <div class="sh-foot"><button type="button" class="cl-btn" @click="close">لاحقًا</button><button type="submit" class="cl-btn primary" :disabled="busy">خصم من المخزون</button></div>
  </form></div>`,
};
const RecipesCard = {
  setup() {
    const d = ref(null), code = ref(""), rows = ref([]), busy = ref(false), err = ref(null);
    const load = async () => { try { d.value = await call("recipes"); } catch (e) { err.value = e.message; } };
    const service = computed(() => d.value?.services.find((s) => s.item_code === code.value));
    watch(code, () => { rows.value = (service.value?.recipe || []).map((r) => ({ ...r })); });
    const add = () => rows.value.push({ item_code: "", qty: "" });
    const save = async () => {
      busy.value = true; err.value = null;
      try { const out = await call("save_recipe", { item_code: code.value, rows: JSON.stringify(rows.value) }, true); service.value.recipe = out; rows.value = out.map((r) => ({ ...r })); toast("حُفظت الوصفة"); }
      catch (e) { err.value = e.message; } finally { busy.value = false; }
    };
    load();
    return { d, code, rows, busy, err, service, add, save, uom };
  },
  template: `
  <section v-if="d" class="mn-card"><div class="mn-card-h"><b>وصفات الخدمات</b><span class="muted">ما تستهلكه الوحدة الواحدة، لتُقترح الكميات عند التسليم</span></div>
    <div style="display:flex;flex-direction:column;gap:8px;padding:12px 16px">
      <div v-if="err" class="alert error">{{ err }}</div>
      <p v-if="!d.services.length" class="muted" style="margin:0">أضف خدمة أولًا من الخدمات والأسعار.</p>
      <template v-else><select class="input" v-model="code" aria-label="الخدمة"><option value="" disabled>اختر خدمة</option><option v-for="s in d.services" :key="s.item_code" :value="s.item_code">{{ s.item_name }}{{ s.recipe.length ? ' ✓' : '' }}</option></select>
        <template v-if="service"><span class="muted">لكل 1 {{ uom(service.stock_uom) }} من «{{ service.item_name }}»:</span>
          <div v-for="(r, i) in rows" :key="i" class="row" style="gap:6px"><select class="input" v-model="r.item_code" aria-label="المادة"><option value="" disabled>اختر مادة</option><option v-for="m in d.materials" :key="m.item_code" :value="m.item_code">{{ m.item_name }} ({{ uom(m.stock_uom) }})</option></select>
            <input class="input num" style="max-width:110px" inputmode="decimal" v-model="r.qty" aria-label="الكمية" placeholder="الكمية"><button type="button" class="cl-btn sm" :aria-label="'حذف ' + (i + 1)" @click="rows.splice(i, 1)">×</button></div>
          <div class="row" style="gap:8px"><button type="button" class="cl-btn sm" :disabled="!d.materials.length" @click="add">+ مادة</button><button type="button" class="cl-btn primary sm" :disabled="busy" @click="save">حفظ الوصفة</button></div></template></template></div></section>`,
};
// Cost calculator: price a job before the order exists. Same cost rules as the card's cost section.
const CalcPage = {
  components: { Icon },
  setup() {
    const { s, load } = useLoad(() => call("calc_data"));
    const num = (v) => +v || 0;
    const blank = () => ({ id: null, title: "", item_code: "", qty: 1, width: "", height: "", waste_percent: 5, lines: [],
      margins: { ...(s.data?.margins || { Individual: 40, Company: 30 }) } });
    const c = ref(blank());
    onMounted(async () => { await load(); c.value.margins = { ...s.data.margins }; });
    const svc = computed(() => (s.data?.services || []).find((x) => x.item_code === c.value.item_code));
    const types = computed(() => s.data?.cost_types || []);
    const isMat = (t) => !!types.value.find((x) => x.value === t)?.material;
    const area = computed(() => !!(svc.value?.area && num(c.value.width) && num(c.value.height)));
    const units = computed(() => (area.value ? num(c.value.qty) * num(c.value.width) * num(c.value.height) : num(c.value.qty)));
    const unitName = computed(() => (svc.value ? uom(svc.value.stock_uom) : "قطعة"));
    const recipeLines = () => (svc.value?.recipe || []).map((r) => {
      const m = (s.data?.materials || []).find((x) => x.item_code === r.item_code) || {};
      return { cost_type: "Matière", description: m.item_name || r.item_code, item: r.item_code, per: r.qty, qty: +(r.qty * units.value).toFixed(3), rate: m.rate ?? "", uom: m.stock_uom, source: "recipe" };
    });
    const pickService = () => {
      if (svc.value && !c.value.title) c.value.title = svc.value.item_name;
      c.value.lines = [...recipeLines(), ...c.value.lines.filter((l) => l.source !== "recipe")];
    };
    watch(units, (u) => { for (const l of c.value.lines) if (l.source === "recipe") l.qty = +(l.per * u).toFixed(3); });
    const addLine = (kind) => c.value.lines.push(kind === "mat"
      ? { cost_type: "Matière", description: "", item: "", qty: units.value || 1, rate: "", source: "stock" }
      : { cost_type: (types.value.find((t) => !t.material) || types.value[0] || {}).value || "Autre", description: "", qty: 1, rate: "", source: "manual" });
    const pickMaterial = (l) => { const m = (s.data?.materials || []).find((x) => x.item_code === l.item); if (m) { l.description = m.item_name; l.uom = m.stock_uom; l.rate = m.rate ?? ""; } };
    const amount = (l) => num(l.qty) * num(l.rate) * (isMat(l.cost_type) ? 1 + num(c.value.waste_percent) / 100 : 1);
    const missing = computed(() => c.value.lines.filter((l) => l.description && (l.rate === "" || l.rate === null)).length);
    const matTotal = computed(() => c.value.lines.filter((l) => isMat(l.cost_type)).reduce((a, l) => a + amount(l), 0));
    const total = computed(() => c.value.lines.reduce((a, l) => a + amount(l), 0));
    const unitCost = computed(() => (units.value ? total.value / units.value : 0));
    const suggest = (k) => { const m = Math.min(90, num(c.value.margins[k])); return unitCost.value ? Math.ceil(unitCost.value / (1 - m / 100) / 10) * 10 : 0; };
    const current = (k) => (svc.value ? svc.value[k === "Individual" ? "price_individual" : "price_company"] : null);
    const curMargin = (k) => { const p = num(current(k)); return p ? Math.round((p - unitCost.value) / p * 100) : null; };
    const KINDS = [["Individual", "الأفراد"], ["Company", "المؤسسات"]];
    const PRESETS = [20, 30, 40, 50, 60];
    const busy = ref(null), err = ref(null);
    const run = async (key, fn, msg) => { busy.value = key; err.value = null; try { const r = await fn(); if (msg) toast(msg); return r; } catch (e) { err.value = e.message; } finally { busy.value = null; } };
    const payload = () => JSON.stringify({ ...c.value, lines: c.value.lines.filter((l) => l.description) });
    const saveMargins = () => run("margins", async () => { s.data.margins = await call("save_margins", { data: JSON.stringify(c.value.margins) }, true); }, "حُفظت الهوامش كقيمة افتراضية");
    const savePrice = (k) => run("price" + k, async () => {
      const r = await call("set_price", { item_code: c.value.item_code, kind: k, rate: suggest(k) }, true);
      svc.value[k === "Individual" ? "price_individual" : "price_company"] = r;
    }, "حُفظ السعر للخدمة");
    // saved calculations
    const list = ref(false);
    const save = () => run("save", async () => {
      if (!c.value.title) c.value.title = svc.value?.item_name || "";
      const r = await call("save_calc", { data: payload(), id: c.value.id }, true);
      c.value.id = r.id; s.data.saved = [r, ...s.data.saved.filter((x) => x.id !== r.id)];
    }, "حُفظ الحساب");
    const open = (x) => run("open", async () => { const r = await call("get_calc", { id: x.id }); c.value = { ...blank(), ...r.data, id: r.id, margins: { ...r.data.margins } }; list.value = false; });
    const drop = (x) => { if (confirm(`حذف «${x.title}»؟`)) run("drop", async () => { await call("delete_calc", { id: x.id }, true); s.data.saved = s.data.saved.filter((y) => y.id !== x.id); }); };
    const fresh = () => { c.value = blank(); err.value = null; };
    // order / devis
    const sheet = ref(null), customers = ref([]);
    const startOrder = async (kind) => {
      err.value = null;
      sheet.value = { kind, customer: "", rate: suggest("Individual") };
      if (!customers.value.length) { try { customers.value = (await call("customers2")).rows; } catch { customers.value = []; } }
    };
    const pickCustomer = () => { const x = customers.value.find((y) => y.name === sheet.value.customer); sheet.value.rate = suggest(x?.customer_type === "Company" ? "Company" : "Individual"); };
    const submitOrder = async () => {
      const f = sheet.value, win = f.kind === "devis" ? window.open("about:blank", "_blank") : null;
      busy.value = "order"; err.value = null;
      try {
        const so = await call("calc_order", { data: payload(), customer: f.customer || null, rate: f.rate }, true);
        if (f.kind === "devis") { const q = await call("card_quote", { order: so, kind: "devis" }, true); if (win) win.location = pdfUrl("Quotation", q, "الورشة — عربي"); }
        sheet.value = null; toast(f.kind === "devis" ? "أُنشئ الطلب وعرض السعر" : "أُنشئ الطلب"); go("/order/" + so);
      } catch (e) { if (win) win.close(); err.value = e.message; } finally { busy.value = null; }
    };
    return { s, c, svc, types, isMat, area, units, unitName, pickService, addLine, pickMaterial, amount, missing, matTotal, total, unitCost, suggest, current, curMargin,
      KINDS, PRESETS, busy, err, saveMargins, savePrice, list, save, open, drop, fresh, sheet, customers, startOrder, pickCustomer, submitOrder, money, num, uom, state };
  },
  template: `
  <div class="page tb cb calc">
    <div class="calc-head"><div><h1>حاسبة التكلفة</h1><span class="muted">احسب السعر قبل أن تعطيه للعميل</span></div><span class="spacer"></span>
      <button type="button" class="cl-btn" @click="list = !list"><Icon name="file" :size="16"/>حسابات محفوظة<span v-if="s.data" class="muted"> {{ s.data.saved.length }}</span></button>
      <button type="button" class="cl-btn" @click="fresh"><Icon name="plus" :size="16"/>حساب جديد</button></div>
    <div v-if="s.error" class="alert error" style="margin:0 28px 12px">{{ s.error }}</div>
    <div v-if="err" class="alert error" style="margin:0 28px 12px">{{ err }}</div>
    <section v-if="list && s.data" class="mn-card calc-saved">
      <div v-for="x in s.data.saved" :key="x.id" class="cl-line"><div style="flex:1;min-width:0"><a href="#" class="cl-line-t ellipsis" style="display:block" @click.prevent="open(x)">{{ x.title }}</a><span class="muted">{{ x.at }} · {{ x.by }}</span></div>
        <button type="button" class="cl-btn sm ghost" :aria-label="'حذف ' + x.title" @click="drop(x)"><Icon name="x" :size="14"/></button></div>
      <div v-if="!s.data.saved.length" class="muted">لا حسابات محفوظة بعد.</div></section>
    <div v-if="s.data" class="calc-body">
      <div class="calc-main">
        <section class="mn-card"><div class="mn-card-h"><b>العمل</b><span class="muted">ماذا يريد العميل؟</span></div>
          <div class="calc-fields">
            <div class="calc-row"><label class="cl-fgroup grow2"><span>الخدمة</span><select class="input" v-model="c.item_code" @change="pickService"><option value="">اختر الخدمة</option><option v-for="x in s.data.services" :key="x.item_code" :value="x.item_code">{{ x.item_name }}</option></select></label>
              <label class="cl-fgroup grow2"><span>اسم الحساب</span><input class="input" v-model="c.title" placeholder="مثال: لافتة مخبزة السعادة"></label></div>
            <div class="calc-row"><label class="cl-fgroup"><span>الكمية</span><div class="unit-wrap"><input class="input num" v-model="c.qty" inputmode="decimal"><span class="u">قطعة</span></div></label>
              <template v-if="svc && svc.area"><label class="cl-fgroup"><span>العرض</span><div class="unit-wrap"><input class="input num" v-model="c.width" inputmode="decimal"><span class="u">م</span></div></label>
                <label class="cl-fgroup"><span>الارتفاع</span><div class="unit-wrap"><input class="input num" v-model="c.height" inputmode="decimal"><span class="u">م</span></div></label></template>
              <label class="cl-fgroup"><span>نسبة التلف</span><div class="unit-wrap"><input class="input num" v-model="c.waste_percent" inputmode="decimal"><span class="u">%</span></div></label></div>
            <span v-if="area" class="muted">المساحة: {{ +units.toFixed(2) }} م² · مع التلف {{ +(units * (1 + num(c.waste_percent) / 100)).toFixed(2) }} م²</span>
            <span v-else-if="svc && svc.area" class="muted">هذه الخدمة تُسعَّر بالمتر المربع: أدخل العرض والارتفاع.</span>
            <span v-if="svc && !svc.recipe.length" class="muted">لا وصفة مواد لهذه الخدمة. أضف المواد يدويًا، أو سجّل الوصفة في صفحة المخزون.</span></div></section>
        <section class="mn-card"><div class="mn-card-h"><b>بنود التكلفة</b><span class="muted">تُقترح من وصفة الخدمة، ويمكن تعديلها</span></div>
          <div class="calc-lines">
            <div v-for="(l, i) in c.lines" :key="i" class="calc-line">
              <div class="calc-l-name"><select v-if="l.source === 'stock'" class="input" v-model="l.item" @change="pickMaterial(l)" aria-label="المادة"><option value="" disabled>اختر المادة</option><option v-for="m in s.data.materials" :key="m.item_code" :value="m.item_code">{{ m.item_name }}</option></select>
                <input v-else class="input" v-model="l.description" aria-label="البند" placeholder="مثال: تشغيل آلة الطباعة">
                <span class="muted">{{ l.source === 'recipe' ? 'من الوصفة · ' + l.per + ' لكل ' + unitName : l.source === 'stock' ? 'من المخزون' : 'أُضيف يدويًا' }}<template v-if="l.item && l.rate !== '' && l.rate !== null"> · سعر المخزون</template></span></div>
              <select class="input calc-l-type" v-model="l.cost_type" aria-label="النوع" :disabled="l.source !== 'manual'"><option v-for="t in types" :key="t.value" :value="t.value">{{ t.label }}</option></select>
              <label class="unit-wrap calc-l-n"><input class="input num" v-model="l.qty" inputmode="decimal" aria-label="الكمية"><span class="u">{{ l.uom ? uom(l.uom) : '' }}</span></label>
              <label class="unit-wrap calc-l-n"><input class="input num" v-model="l.rate" inputmode="decimal" aria-label="سعر الوحدة" :class="{'calc-miss': l.rate === '' || l.rate === null}" placeholder="السعر"><span class="u">دج</span></label>
              <b class="money calc-l-amt">{{ money(amount(l)) }}</b>
              <button type="button" class="cl-btn sm ghost" :aria-label="'حذف ' + (l.description || 'البند')" @click="c.lines.splice(i, 1)"><Icon name="x" :size="14"/></button></div>
            <div v-if="!c.lines.length" class="muted">اختر خدمة لتُقترح موادها، أو أضف بنودًا.</div>
            <div class="row" style="gap:16px;flex-wrap:wrap"><button type="button" class="cl-link" @click="addLine('manual')">+ بند (آلة، يد عاملة، مورد…)</button><button type="button" class="cl-link" @click="addLine('mat')">+ مادة من المخزون</button></div>
            <span v-if="missing" class="calc-warn">{{ missing }} بند بلا سعر: النتيجة أقل من الحقيقة.</span></div></section>
      </div>
      <aside class="calc-side">
        <section class="mn-card calc-res"><b>النتيجة</b>
          <div class="calc-kv"><span>المواد (مع التلف)</span><span class="money">{{ money(matTotal) }}</span></div>
          <div class="calc-kv"><span>بنود أخرى</span><span class="money">{{ money(total - matTotal) }}</span></div>
          <div class="calc-kv calc-strong"><span>التكلفة الكلية</span><span class="money">{{ money(total) }}</span></div>
          <div class="calc-kv calc-strong"><span>تكلفة {{ unitName }}</span><span class="money">{{ money(unitCost) }}</span></div>
          <div v-if="area" class="calc-kv"><span>تكلفة القطعة</span><span class="money">{{ money(num(c.qty) ? total / num(c.qty) : 0) }}</span></div>
          <div v-for="k in KINDS" :key="k[0]" class="calc-price">
            <div class="row" style="gap:8px"><span class="muted" style="flex:1">هامش ربح {{ k[1] }}</span>
              <div class="unit-wrap" style="width:96px"><input class="input num" v-model="c.margins[k[0]]" inputmode="decimal" :aria-label="'هامش ' + k[1]"><span class="u">%</span></div></div>
            <div class="calc-chips"><button v-for="p in PRESETS" :key="p" type="button" :class="{on: num(c.margins[k[0]]) === p}" @click="c.margins[k[0]] = p">{{ p }}%</button></div>
            <div class="calc-sug"><span class="money">{{ money(suggest(k[0])) }}</span><span class="muted"> لكل {{ unitName }}</span></div>
            <span v-if="svc" class="muted">السعر المسجّل: {{ current(k[0]) ? money(current(k[0])) : 'غير محدد' }}<template v-if="curMargin(k[0]) !== null"> · <b :class="curMargin(k[0]) < num(c.margins[k[0]]) ? 'bad' : 'good'">ربحه {{ curMargin(k[0]) }}%</b></template></span>
            <button v-if="svc && s.data.can_price" type="button" class="cl-btn sm" :disabled="!suggest(k[0]) || !!busy" @click="savePrice(k[0])">حفظ كسعر {{ k[1] }}</button></div>
          <button type="button" class="cl-link" :disabled="!!busy" @click="saveMargins">اجعل هذه الهوامش افتراضية</button></section>
        <div class="calc-actions"><button type="button" class="cl-btn primary" :disabled="!total || !!busy" @click="startOrder('devis')"><Icon name="file" :size="16"/>إنشاء عرض سعر</button>
          <div class="row" style="gap:8px"><button type="button" class="cl-btn" style="flex:1" :disabled="!total || !!busy" @click="startOrder('order')"><Icon name="plus" :size="16"/>إنشاء طلب</button>
            <button type="button" class="cl-btn" style="flex:1" :disabled="!c.lines.length || !!busy" @click="save">{{ busy === 'save' ? 'جارٍ…' : 'حفظ الحساب' }}</button></div></div>
      </aside>
    </div>
    <div v-if="sheet" class="overlay" @click.self="sheet = null"><form class="sheet" @submit.prevent="submitOrder"><div class="sh-head"><h2>{{ sheet.kind === 'devis' ? 'إنشاء عرض سعر' : 'إنشاء طلب' }}</h2></div>
      <div v-if="err" class="alert error">{{ err }}</div>
      <div class="field"><label for="calc-cust">العميل</label><select id="calc-cust" class="input" v-model="sheet.customer" @change="pickCustomer"><option value="">زبون نقدي</option><option v-for="x in customers" :key="x.name" :value="x.name">{{ x.customer_name }}</option></select></div>
      <div class="field"><label for="calc-rate">السعر لكل {{ unitName }} (دج)</label><input id="calc-rate" class="input num" v-model="sheet.rate" inputmode="decimal"><span class="muted">مقترح حسب نوع العميل. المجموع: {{ money(num(sheet.rate) * units) }}</span></div>
      <span class="muted">يُنشأ الطلب في اللوحة، وتُحفظ بنود التكلفة في قسم التكلفة في البطاقة.{{ sheet.kind === 'devis' ? ' ويُفتح عرض السعر للطباعة.' : '' }}</span>
      <div class="sh-foot"><button type="button" class="cl-btn" @click="sheet = null">إلغاء</button><button type="submit" class="cl-btn primary" :disabled="busy === 'order' || !(num(sheet.rate) > 0)">{{ busy === 'order' ? 'جارٍ…' : 'إنشاء' }}</button></div>
    </form></div>
  </div>`,
};

const StockPage = {
  components: { Icon, RecipesCard, SizeControl },
  setup() {
    const { s, load } = useLoad(() => call("stock"));
    onMounted(load);
    const busy = ref(false), err = ref(null), q = ref(""), sheet = ref(null), orders = ref([]);
    const onlyLow = ref(false), rowMenu = ref(null);
    const items = computed(() => (s.data?.items || []).filter((i) => i.item_name.toLowerCase().includes(q.value.trim().toLowerCase()) && (!onlyLow.value || i.low)));
    const low = computed(() => (s.data?.items || []).filter((i) => i.low));
    const totalValue = computed(() => (s.data?.items || []).reduce((a, i) => a + (+i.value || 0), 0));
    // level bar: full at twice the minimum (or any stock when there is no minimum)
    const level = (i) => Math.max(0, Math.min(100, i.safety_stock ? (i.qty / (2 * i.safety_stock)) * 100 : i.qty > 0 ? 100 : 0));
    const shortBy = (i) => +(i.safety_stock - i.qty).toFixed(3);
    const closeRow = () => (rowMenu.value = null);
    onMounted(() => document.addEventListener("click", closeRow)); onBeforeUnmount(() => document.removeEventListener("click", closeRow));
    const MOVE_TAG = { "Purchase Invoice": "st-buy", "Stock Entry": "st-out", "Stock Reconciliation": "st-cnt" };
    const units = computed(() => state.boot.units || []);
    const suppliers = computed(() => state.boot.suppliers || []);
    const open = async (kind, item) => {
      err.value = null;
      sheet.value = { kind, item, name: item?.item_name || "", uom: units.value[0]?.name || "قطعة", min_qty: item?.safety_stock || 0, qty: kind === "count" ? (item?.qty ?? "") : "", rate: "", supplier: "", order: "", note: "", bill: "" };
      if (kind === "issue") { try { orders.value = (await call("board2")).cards; } catch { orders.value = []; } }
    };
    const TITLES = { add: "مادة جديدة", edit: "تعديل المادة", buy: "شراء من مورد", issue: "صرف مادة", count: "جرد" };
    const submit = async () => {
      const f = sheet.value, code = f.item?.item_code;
      busy.value = true; err.value = null;
      try {
        if (f.kind === "add") await call("add_material", { name: f.name, uom: f.uom, min_qty: f.min_qty }, true);
        if (f.kind === "edit") await call("update_material", { item_code: code, name: f.name, min_qty: f.min_qty }, true);
        if (f.kind === "buy") await call("stock_purchase", { item_code: code, qty: f.qty, rate: f.rate, supplier: f.supplier, bill_no: f.bill }, true);
        if (f.kind === "issue") await call("stock_issue", { item_code: code, qty: f.qty, sales_order: f.order, note: f.note }, true);
        if (f.kind === "count") await call("stock_count", { item_code: code, qty: f.qty, rate: f.rate }, true);
        sheet.value = null; toast("تم الحفظ"); await load();
      } catch (e) { err.value = e.message; } finally { busy.value = false; }
    };
    const remove = async (i) => {
      if (!confirm(`حذف «${i.item_name}»؟ يبقى سجلها محفوظًا.`)) return;
      try { await call("remove_material", { item_code: i.item_code }, true); toast("حُذفت المادة"); await load(); } catch (e) { toast(e.message, "error"); }
    };
    const MOVE = { "Purchase Invoice": "شراء", "Stock Entry": "صرف", "Stock Reconciliation": "جرد" };
    return { s, load, busy, err, q, sheet, orders, items, low, units, suppliers, open, TITLES, submit, remove, MOVE, money, date, uom, onlyLow, rowMenu, totalValue, level, shortBy, MOVE_TAG, num, go };
  },
  template: `
  <div class="page tb cb">
    <div class="stk-head"><h1>المخزون</h1><span class="spacer"></span>
      <input class="input stk-q" v-model="q" aria-label="بحث في المواد" placeholder="ابحث عن مادة"><SizeControl/><button type="button" class="cl-btn primary" @click="open('add')"><Icon name="plus" :size="16"/>مادة جديدة</button></div>
    <div v-if="s.error" class="alert error" style="margin:0 28px 12px">{{ s.error }}</div>
    <div v-if="s.data" class="stock-body stk">
      <div class="stk-kpis">
        <div class="stk-kpi"><span>عدد المواد</span><b>{{ s.data.items.length }}</b></div>
        <div v-if="s.data.can_value" class="stk-kpi"><span>قيمة المخزون</span><b class="money">{{ money(totalValue) }}</b></div>
        <button type="button" class="stk-kpi" :class="{warn: low.length}" :aria-pressed="onlyLow" @click="onlyLow = !onlyLow"><span>تحت الحد الأدنى{{ low.length ? ' — اضغط للعرض' : '' }}</span><b>{{ low.length }}</b></button>
      </div>
      <div class="stk-bar"><div class="cal2-seg" role="group" aria-label="تصفية"><button type="button" :aria-pressed="!onlyLow" @click="onlyLow = false">الكل</button><button type="button" :aria-pressed="onlyLow" @click="onlyLow = true">تحت الحد الأدنى<span v-if="low.length" class="stk-n">{{ low.length }}</span></button></div></div>
      <section class="mn-card stk-card"><table class="cl-table stk-table"><thead><tr><th>المادة</th><th class="n">الكمية</th><th class="n">الحد الأدنى</th><th v-if="s.data.can_value" class="n">القيمة</th><th class="n">إجراء</th></tr></thead>
        <tbody><tr v-for="i in items" :key="i.item_code" :class="{low: i.low}">
          <td><b>{{ i.item_name }}</b><span class="m stk-sub">{{ uom(i.uom) }}<template v-if="i.low"> · ينقص {{ num(shortBy(i)) }}</template></span></td>
          <td class="n"><div class="stk-lvl"><span class="stk-meter" aria-hidden="true"><i :style="{width: level(i) + '%'}"></i></span><b class="stk-qty">{{ num(i.qty) }}</b></div></td>
          <td class="n"><span class="m">{{ i.safety_stock ? num(i.safety_stock) : '—' }}</span></td>
          <td v-if="s.data.can_value" class="n money">{{ money(i.value) }}</td>
          <td class="n"><div class="btn-row stk-acts"><button v-if="s.data.can_buy" type="button" class="cl-btn sm" @click="open('buy', i)">شراء</button><button v-if="s.data.can_issue" type="button" class="cl-btn sm" :disabled="i.qty <= 0" @click="open('issue', i)">صرف</button>
            <button type="button" class="cl-btn sm" :aria-label="'إجراءات أخرى لـ ' + i.item_name" :aria-expanded="rowMenu === i.item_code" @click.stop="rowMenu = rowMenu === i.item_code ? null : i.item_code">▾</button>
            <div v-if="rowMenu === i.item_code" class="tm-pop stk-more" @click.stop><button type="button" class="tm-pop-row" @click="rowMenu = null; open('count', i)">جرد</button><button type="button" class="tm-pop-row" @click="rowMenu = null; open('edit', i)">تعديل</button><button type="button" class="tm-pop-row tm3-danger" @click="rowMenu = null; remove(i)">حذف</button></div></div></td></tr>
          <tr v-if="!items.length"><td :colspan="s.data.can_value ? 5 : 4" class="muted" style="text-align:center;padding:24px">{{ onlyLow ? 'لا مواد تحت الحد الأدنى.' : 'لا مواد بعد. أضف مادة ثم سجّل رصيدها بالجرد أو الشراء.' }}</td></tr></tbody></table></section>
      <RecipesCard/>
      <section v-if="s.data.moves.length" class="mn-card stk-card"><div class="mn-card-h"><b>آخر الحركات</b></div><table class="cl-table stk-table">
        <thead><tr><th>المادة</th><th>النوع</th><th class="n">الكمية</th><th>الطلب</th><th>التاريخ</th></tr></thead>
        <tbody><tr v-for="m in s.data.moves" :key="m.voucher_no + m.item_code"><td>{{ m.item_name }}</td><td><span class="stk-tag" :class="MOVE_TAG[m.voucher_type]">{{ MOVE[m.voucher_type] || m.voucher_type }}</span></td>
          <td class="n" :class="m.voucher_type === 'Stock Reconciliation' ? '' : m.actual_qty < 0 ? 'stk-minus' : 'stk-plus'" dir="ltr">{{ m.voucher_type === 'Stock Reconciliation' ? num(m.actual_qty) : (m.actual_qty < 0 ? '−' : '+') + num(Math.abs(m.actual_qty)) }}</td>
          <td><a v-if="m.order" class="cl-link" :href="'/atelier/orders/' + m.order" @click.prevent="go('/orders/' + encodeURIComponent(m.order))">{{ m.order_title }}</a><span v-else class="m">—</span></td>
          <td><span class="m">{{ date(m.posting_date) }}</span></td></tr></tbody></table></section>
    </div>
    <div v-if="sheet" class="overlay" @click.self="sheet = null"><form class="sheet" @submit.prevent="submit"><div class="sh-head"><h2>{{ TITLES[sheet.kind] }}<template v-if="sheet.item"> · {{ sheet.item.item_name }}</template></h2></div>
      <div v-if="err" class="alert error">{{ err }}</div>
      <template v-if="sheet.kind === 'add' || sheet.kind === 'edit'"><div class="field"><label for="st-name">الاسم</label><input id="st-name" class="input" v-model="sheet.name"></div>
        <div v-if="sheet.kind === 'add'" class="field"><label for="st-uom">الوحدة</label><select id="st-uom" class="input" v-model="sheet.uom"><option v-for="u in units" :key="u.name" :value="u.name">{{ u.name }}</option></select></div>
        <div class="field"><label for="st-min">الحد الأدنى للتنبيه</label><input id="st-min" class="input" inputmode="decimal" v-model="sheet.min_qty"></div></template>
      <template v-else><div class="field"><label for="st-qty">{{ sheet.kind === 'count' ? 'الكمية الفعلية' : 'الكمية' }}</label><input id="st-qty" class="input" inputmode="decimal" v-model="sheet.qty"></div>
        <div v-if="sheet.kind !== 'issue'" class="field"><label for="st-rate">سعر الوحدة (دج){{ sheet.kind === 'count' ? ' — مطلوب للرصيد الأول' : '' }}</label><input id="st-rate" class="input" inputmode="decimal" v-model="sheet.rate"></div>
        <template v-if="sheet.kind === 'buy'"><div class="field"><label for="st-sup">المورد</label><select id="st-sup" class="input" v-model="sheet.supplier"><option value="" disabled>اختر المورد</option><option v-for="x in suppliers" :key="x.name" :value="x.name">{{ x.supplier_name }}</option></select></div>
          <div class="field"><label for="st-bill">رقم فاتورة المورد (اختياري)</label><input id="st-bill" class="input" v-model="sheet.bill"></div></template>
        <template v-if="sheet.kind === 'issue'"><div class="field"><label for="st-order">الطلب (اختياري)</label><select id="st-order" class="input" v-model="sheet.order"><option value="">بدون طلب</option><option v-for="o in orders" :key="o.name" :value="o.name">{{ o.title || o.name }}</option></select></div>
          <div class="field"><label for="st-note">ملاحظة</label><input id="st-note" class="input" v-model="sheet.note"></div></template></template>
      <div class="sh-foot"><button type="button" class="cl-btn" @click="sheet = null">إلغاء</button><button type="submit" class="cl-btn primary" :disabled="busy">حفظ</button></div>
    </form></div>
  </div>`,
};

const App = {
  components: { SizeControl, BoardPanel, StockPage, CalcPage, MaterialsSheet, Icon, SearchBox, PaymentSheet, ExpenseSheet, ItemSheet, PricesPage, TeamPage, Board, SimpleCustomers, SimpleMoney, BoardSettings, CustomerSheet2, SettingsPage, ReportsPage2, SuppliersPage },
  setup() {
    const bootErr = ref(null);
    const loadBoot = async () => {
      bootErr.value = null;
      try { state.boot = await call("boot"); applyScale(state.boot.ui_scale); sizeState.zoom = zoomOf(); } catch (e) { bootErr.value = e.message; }
      call("orders").then((l) => (state.openOrders = l.length)).catch(() => {});
    };
    onMounted(async () => {
      await loadBoot();
      if (state.query.get("action") === "payment" && state.boot?.can.payment) state.sheet = { type: "payment" };
      if (state.query.get("action") === "expense" && state.boot?.can.expense) state.sheet = { type: "expense" };
      if ("serviceWorker" in navigator) navigator.serviceWorker.register("/atelier-sw.js", { scope: "/atelier" }).catch(() => {});
    });
    const isActive = (n) => n.match.includes(route.value.name);
    const titles = { ds: "ds_title", "order-new": "of_title", customer: "c_title", customers: "c_title", order: "nav_orders", orders: "orders_title",
      money: "nav_money", suppliers: "nav_suppliers", supplier: "nav_suppliers", stock: "nav_stock", calc: "nav_calc", machines: "nav_machines", reports: "nav_reports", more: "nav_more", prices: "nav_prices", team: "nav_team", "board-settings": "nav_board_settings", settings: "nav_settings" };
    const back = () => (history.length > 1 ? history.back() : go("/"));
    const initials = (n) => String(n || "").split(" ").filter(Boolean).slice(0, 2).map((w) => w[0]).join(" ");
    const logout = async () => {
      try { await fetch("/api/method/logout", { method: "POST", headers: { "X-Frappe-CSRF-Token": window.csrf_token } }); } catch { /* go to the sign-in page anyway */ }
      try { localStorage.removeItem("atelier.remember"); } catch { /* private mode */ }
      location.href = "/atelier-login";
    };
    return { logout, state, route, NAV, SECTION_NAV, isActive, bootErr, loadBoot, t, go, titles, back, initials };
  },
  template: `
  <div v-if="bootErr" class="page"><div class="alert error" role="alert"><span style="flex:1">{{ bootErr }}</span><button class="btn sm" @click="loadBoot">{{ t('retry') }}</button></div></div>
  <div v-else-if="!state.boot" class="boot">{{ t('loading') }}</div>
  <div v-else class="shell" :class="{editing: state.editing}">
    <a href="#main" class="skip">{{ t('skip') }}</a>
    <nav class="sidebar" :aria-label="t('app_name')">
      <div class="brand">
        <svg class="brand-mark" width="44" height="44" viewBox="0 0 44 44" aria-hidden="true"><rect x="8" y="6" width="28" height="9" rx="1" fill="#D4F06A"/><rect x="8" y="6" width="9" height="32" rx="1" fill="#9B87F5"/><rect x="17" y="20" width="16" height="7" rx="1" fill="#D4F06A"/><rect x="24" y="30" width="12" height="8" rx="1" fill="#9B87F5"/></svg>
        <span class="name"><span class="brand-word">{{ t('app_name') }}</span><small>{{ t('app_tagline') }}</small></span>
      </div>
      <button type="button" class="ws-org"><Icon name="printer" :size="18"/><span class="lbl">{{ state.boot.company_label }}</span><Icon name="down" :size="16"/></button>
      <a v-for="n in NAV.filter(n => !n.need || state.boot.can[n.need])" :key="n.key" class="nav" :class="{active: isActive(n)}" :href="'/atelier'+(n.path==='/'?'':n.path)" @click.prevent="go(n.path)"
        :aria-current="isActive(n) ? 'page' : null"><Icon :name="n.icon"/><span class="lbl">{{ t(n.label) }}</span><span v-if="n.key==='orders' && state.openOrders" class="nav-n">{{ state.openOrders }}</span></a>
      <div v-if="state.boot.can.finance" class="group">{{ t('nav_group_admin') }}</div>
      <a v-for="n in SECTION_NAV.filter(n => !['machines', 'prices', 'team'].includes(n.key) && (!n.need || state.boot.can[n.need]))" :key="n.key" class="nav" :class="{active: isActive(n)}" :href="'/atelier'+n.path" @click.prevent="go(n.path)"
        :aria-current="isActive(n) ? 'page' : null"><Icon :name="n.icon"/><span class="lbl">{{ t(n.label) }}</span></a>
      <div class="spacer"></div>
      <a v-if="state.boot.can.prices" class="nav" :class="{active: route.name==='settings'}" href="/atelier/settings" @click.prevent="go('/settings')"><Icon name="gear"/><span class="lbl">{{ t('nav_settings') }}</span></a>
      <div class="who-row"><span class="who-av">{{ initials(state.boot.full_name) }}</span><span class="who-txt"><span class="who-name">{{ state.boot.full_name }}</span><span class="who-role">{{ state.boot.can.prices ? t('role_manager') : 'موظف' }}</span></span>
        <button type="button" class="who-out" aria-label="تسجيل الخروج" title="تسجيل الخروج" @click="logout"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/></svg></button></div>
    </nav>

    <div class="main">
      <div v-if="state.boot.is_demo && route.name!=='home'" class="demo-banner" role="note"><Icon name="alert" :size="15"/>{{ t('demo_banner') }}</div>
      <div v-if="!state.online" class="alert warn" role="status" style="border-radius:0"><Icon name="wifi" :size="16"/>{{ t('offline') }}</div>
      <header class="topbar" :class="{'own-header': ['customers', 'customer', 'suppliers', 'supplier', 'settings', 'money', 'home', 'orders', 'order-new', 'order', 'reports', 'calc', 'stock'].includes(route.name), 'no-bar': ['home', 'orders', 'order-new', 'order'].includes(route.name)}">
        <button type="button" v-if="route.name!=='home'" class="btn ghost icon-btn mobile-only" :aria-label="t('back')" @click="back"><Icon name="back"/></button>
        <span v-if="route.name!=='home'" class="title mobile-only ellipsis">{{ t(titles[route.name] || 'app_name') }}</span>
        <nav class="crumbs desktop-only" aria-label="المسار"><span class="crumb-root">{{ t('crumb_root') }}</span><Icon name="chev" :size="14"/><span>{{ route.name==='home' ? t('crumb_today') : t(titles[route.name] || 'app_name') }}</span></nav>
        <div class="spacer desktop-only"></div>
        <SearchBox :class="{'desktop-only': route.name!=='home'}"/>
        <SizeControl class="desktop-only" cls="btn ghost icon-btn"/>
        <button type="button" class="btn ghost icon-btn desktop-only" :aria-label="t('notifications')"><Icon name="bell" :size="20"/></button>
      </header>
      <main id="main" tabindex="-1" style="outline:none">
        <Board v-if="['home', 'orders', 'order-new'].includes(route.name)" :key="route.name === 'order-new' ? state.path : 'board'" :start-new="route.name === 'order-new'"/>
        <Board v-else-if="route.name==='order'" :key="'order-' + route.id" :open-card="route.id"/>
        <SimpleCustomers v-else-if="route.name==='customers' || route.name==='customer'" :key="state.path + state.query" :open-id="route.id"/>
        <SimpleMoney v-else-if="route.name==='money'"/>
        <SuppliersPage v-else-if="route.name==='suppliers' || route.name==='supplier'" :key="state.path" :open-id="route.id"/>
        <StockPage v-else-if="route.name==='stock'"/>
        <CalcPage v-else-if="route.name==='calc'"/>
        <ReportsPage2 v-else-if="route.name==='reports'"/>
        <SettingsPage v-else-if="route.name==='prices'" key="prices" start="prices"/>
        <SettingsPage v-else-if="route.name==='team'" key="team" start="team"/>
        <BoardSettings v-else-if="route.name==='board-settings'"/>
        <SettingsPage v-else-if="route.name==='settings'" :key="state.query.get('tab') || ''"/>
      </main>
    </div>

    <nav class="bottom-nav" :aria-label="t('app_name')">
      <a href="/atelier" :class="{active: ['home','orders','order'].includes(route.name)}" @click.prevent="go('/')"><Icon name="orders"/>{{ t('nav_orders') }}</a>
      <a class="fab" href="/atelier/orders/new" @click.prevent="state.sheet = {type: 'order'}"><span class="fab-circle"><Icon name="plus" :size="22"/></span><span class="lbl">{{ t('new_order') }}</span></a>
      <a href="/atelier/customers" :class="{active: ['customer','customers'].includes(route.name)}" @click.prevent="go('/customers')"><Icon name="users"/>{{ t('nav_customers') }}</a>
      <a v-if="state.boot.can.finance" href="/atelier/money" :class="{active: route.name==='money'}" @click.prevent="go('/money')"><Icon name="wallet"/>{{ t('nav_money_simple') }}</a>
    </nav>

    <PaymentSheet v-if="state.sheet && state.sheet.type==='payment'" :opts="state.sheet"/>
    <ExpenseSheet v-if="state.sheet && state.sheet.type==='expense'" :opts="state.sheet"/>
    <CustomerSheet2 v-if="state.sheet && state.sheet.type==='customer'" :opts="state.sheet"/>
    <ItemSheet v-if="state.sheet && state.sheet.type==='item'" :opts="state.sheet"/>
    <MaterialsSheet v-if="state.sheet && state.sheet.type==='materials'" :opts="state.sheet"/>
    <div v-if="state.subsheet" class="subsheet-layer"><PaymentSheet v-if="state.subsheet.type === 'payment'" :opts="state.subsheet"/><ItemSheet v-else :opts="state.subsheet"/></div>
    <BoardPanel v-if="state.sheet && state.sheet.type==='order'" :key="state.sheet.edit || 'new'" mode="new" :edit="state.sheet.edit" :preset="state.sheet.customer" @close="state.sheet = null; route.name === 'order-new' && go('/')" @saved="state.sheet = null; state.rev++; route.name === 'order-new' && go('/')"/>
    <div v-if="state.toast" class="toast" role="status" aria-live="polite"><div class="alert" :class="state.toast.kind"><Icon :name="state.toast.kind==='error' ? 'alert' : 'check'" :size="16"/>{{ state.toast.message }}</div></div>
  </div>`,
};

// «تذكّرني» unchecked at sign-in: once the browser has been closed (its session cookie is gone), sign out.
const forgetMe = (() => { try { return localStorage.getItem("atelier.remember") === "0"; } catch { return false; } })();
if (forgetMe && !document.cookie.split("; ").includes("atelier_live=1")) {
  try { localStorage.removeItem("atelier.remember"); } catch { /* private mode */ }
  await fetch("/api/method/logout", { method: "POST", headers: { "X-Frappe-CSRF-Token": window.csrf_token } }).catch(() => {});
  location.href = "/atelier-login";
} else {
  createApp(App).mount("#app");
}
