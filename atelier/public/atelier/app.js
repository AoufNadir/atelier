// Atelier daily app — Vue 3 (vendored, no build step) on top of the ERPNext API (atelier.api).
import { createApp, reactive, ref, computed, watch, onMounted, onBeforeUnmount, nextTick, h, TransitionGroup } from "./vendor/vue.esm-browser.prod.js";
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
  if (["/money", "/reports", "/prices", "/team", "/board-settings", "/settings", "/stock"].includes(p)) return { name: p.slice(1) };
  return { name: "home" };
});

// ------------------------------------------------------------------ icons (inline stroke SVG)
const ICONS = {
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
const fig = (v) => `${LRI}${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(+v || 0))}${PDI}`;


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
    const f = reactive({ customer: props.opts.customer || null, amount: "", mode: "Cash", order: props.opts.order || "" });
    const orders = ref([]), saving = ref(false), error = ref(null), attempted = ref(false), done = ref(null);
    const loadOrders = async () => {
      orders.value = [];
      if (!f.customer) return;
      try { orders.value = (await call("customer", { name: f.customer.name })).orders.filter((o) => o.docstatus === 1 && (o.per_billed < 100 || o.paid < o.grand_total - 0.005)); } catch { /* optional */ }
    };
    watch(() => f.customer, loadOrders, { immediate: true });
    const errs = computed(() => ({ customer: !f.customer ? t("err_pick_customer") : null, amount: !(+f.amount > 0) ? t("err_amount") : null }));
    const close = () => (state.sheet = null);
    const onKey = (e) => { if (e.key === "Escape") close(); };
    onMounted(() => { window.addEventListener("keydown", onKey); setTimeout(() => document.querySelector(".sheet input")?.focus(), 50); });
    onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
    async function save() {
      attempted.value = true; error.value = null;
      if (errs.value.customer || errs.value.amount) return;
      saving.value = true;
      try {
        done.value = await call("record_payment", { customer: f.customer.name, amount: +f.amount, mode_of_payment: f.mode, sales_order: f.order || null }, true);
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
      { k: "item_name", label: t("pr_service"), sort: true },
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
    return { s, load, cols, filters, save, saving, failed, t, money, uom, state };
  },
  template: `
  <div class="page">
    <div v-if="!embedded" class="page-head"><div><h1>{{ t('nav_prices') }}</h1><div class="sub">{{ t('pr_sub') }}</div></div>
      <button v-if="s.data && s.data.can_edit" type="button" class="btn primary" @click="state.sheet={type:'item'}"><Icon name="plus" :size="18"/>{{ t('pr_new_service') }}</button></div>
    <LoadState :s="s" :rows="4" @retry="load">
      <p v-if="embedded" class="muted" style="margin:0 0 14px">{{ t('pr_explain') }}</p>
      <div v-else class="alert info" style="margin-bottom:var(--s4)"><Icon name="tag" :size="16"/><span>{{ t('pr_explain') }}</span></div>
      <DataTable :rows="s.data.items" :cols="cols" row-key="item_code" :search-keys="['item_name','item_code','item_group']" :filters="filters" initial-sort="item_name" :empty="t('pr_none')">
        <template #cell="{row, col}">
          <span v-if="col.k==='item_name'" class="title-cell"><span class="medium clamp2">{{ row.item_name }}</span><span class="cap">{{ t('pr_per', uom(row.stock_uom)) }}</span></span>
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
  setup() {
    const f = reactive({ item_name: "", kind: "service", uom: state.boot.units?.[0]?.name || "قطعة", price_individual: "", price_company: "", description: "" });
    const saving = ref(false), error = ref(null), attempted = ref(false);
    const errs = computed(() => ({
      item_name: !f.item_name.trim() ? t("it_err_name") : null,
      price: [f.price_individual, f.price_company].some((v) => v !== "" && !(+v >= 0)) ? t("pr_err_value") : null,
    }));
    const close = () => (state.sheet = null);
    onMounted(() => setTimeout(() => document.getElementById("is-name")?.focus(), 50));
    async function save() {
      attempted.value = true; error.value = null;
      if (errs.value.item_name || errs.value.price) return;
      saving.value = true;
      try {
        const item = await call("create_item", { data: JSON.stringify(f) }, true);
        state.boot.items.push(item); state.boot.items.sort((a, b) => a.item_name.localeCompare(b.item_name, "ar"));
        toast(t("it_created", item.item_name)); close(); state.rev++;
      } catch (e) { error.value = e.message; }
      saving.value = false;
    }
    return { f, saving, error, attempted, errs, save, close, unitGroups, t };
  },
  template: `
  <div class="overlay" @click.self="close" role="dialog" aria-modal="true" aria-labelledby="is-h">
    <form class="sheet wide" novalidate @submit.prevent="save">
      <div class="sh-head"><div><h2 id="is-h">{{ t('pr_new_service') }}</h2><span class="muted">تظهر في الطلبات بسعرها حسب نوع العميل</span></div><button type="button" class="cl-btn icon ghost" :aria-label="t('close')" @click="close"><Icon name="x" :size="18"/></button></div>
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
  template: `<span class="bd-av" :style="[avatarStyle(name), size ? {width: size + 'px', height: size + 'px', fontSize: (size * 0.4) + 'px'} : {}]" :title="name || 'بلا مسؤول'" aria-hidden="true">{{ name ? [...name][0] : '؟' }}</span>`,
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

// Side panel: a new order (one short form) or an existing order card.
const BoardPanel = {
  props: ["mode", "order", "preset", "columns"], emits: ["close", "saved", "move"], components: { Icon, Avatar, CustomerField },
  setup(props, { emit }) {
    const f = reactive({ customer: props.preset || null, phone: "", type: "Individual", lines: [{ text: "", item_code: null, uom: "", qty: 1, rate: "", auto: false }], advance: "", due: isoIn(0), assignee: "", tags: [], column: null, mode: "Cash" });
    const startColumns = computed(() => (props.columns || []).filter((c) => !c.deliver));
    if (startColumns.value.length) f.column = startColumns.value[0].id;
    const dueChips = computed(() => (state.boot?.lists?.due || []).map((c) => [c.label, c.days]));
    const saving = ref(false), error = ref(null), newName = ref(""), credit = ref(null);
    watch(() => f.customer, async (c) => { credit.value = null; if (c) { try { credit.value = await call("customer_credit", { name: c.name }); } catch { /* optional */ } } }, { immediate: true });
    const toggle = (l, v) => { const i = l.indexOf(v); if (i >= 0) l.splice(i, 1); else l.push(v); };
    const onCustomerInput = () => { newName.value = document.getElementById("qo-customer")?.value?.trim() || ""; };
    // a line is a known service (its price follows the customer's type) or free text
    const customerType = computed(() => f.customer?.customer_type || f.type);
    const priceOf = (it) => { const v = customerType.value === "Company" ? it.price_company : it.price_individual; return v === null || v === undefined ? "" : v; };
    const lineInput = (l) => {
      const it = (state.boot.items || []).find((x) => x.item_name === l.text.trim());
      l.item_code = it ? it.item_code : null; l.uom = it ? uom(it.stock_uom) : "";
      if (it && (l.rate === "" || l.auto)) { l.rate = priceOf(it); l.auto = l.rate !== ""; }
      if (!it && l.auto) { l.rate = ""; l.auto = false; }
    };
    watch(customerType, () => f.lines.forEach((l) => { if (l.auto) { const it = state.boot.items.find((x) => x.item_code === l.item_code); if (it) { l.rate = priceOf(it); l.auto = l.rate !== ""; } } }));
    const addLine = () => f.lines.push({ text: "", item_code: null, uom: "", qty: 1, rate: "", auto: false });
    const dropLine = (i) => { f.lines.splice(i, 1); if (!f.lines.length) addLine(); };
    const filled = computed(() => f.lines.filter((l) => l.text.trim()));
    const total = computed(() => (filled.value.length && filled.value.every((l) => l.rate !== "") ? filled.value.reduce((sum, l) => sum + (+l.qty || 0) * (+l.rate || 0), 0) : null));
    async function save() {
      error.value = null; onCustomerInput();
      if (!f.customer && !newName.value) return (error.value = "اكتب اسم العميل");
      if (!filled.value.length) return (error.value = "اكتب ماذا يريد العميل");
      if (filled.value.some((l) => !(+l.qty > 0))) return (error.value = "الكمية غير صحيحة");
      if (filled.value.some((l) => l.rate !== "" && !(+l.rate >= 0))) return (error.value = "السعر غير صحيح");
      if (f.advance !== "" && !(+f.advance >= 0)) return (error.value = "التسبيق غير صحيح");
      if (total.value !== null && +f.advance > total.value) return (error.value = "التسبيق أكبر من المجموع");
      saving.value = true;
      try {
        await call("quick_order", { data: JSON.stringify({
          customer: f.customer?.name || null, new_customer: f.customer ? {} : { name: newName.value, phone: f.phone, type: f.type },
          lines: filled.value.map((l) => ({ text: l.text.trim(), item_code: l.item_code, qty: +l.qty, rate: l.rate === "" ? null : +l.rate })), advance: +f.advance || 0, mode: f.mode, delivery_date: f.due, assignee: f.assignee, tags: f.tags, column: f.column,
        }) }, true);
        toast("حُفظ الطلب"); emit("saved");
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
    return { lineInput, addLine, dropLine, total, filled, credit, fig, f, startColumns, dueChips, saving, error, newName, toggle, onCustomerInput, save, o, left, price, busy, setAssignee, setPrice, toggleTag, pay, next,
      QUICK_TAGS: computed(quickTags), tagTone, isoIn, money, date, dueWord, pdfUrl, go, state };
  },
  template: `
  <aside class="bd-panel" :aria-label="mode === 'new' ? 'طلب جديد' : 'الطلب'">
    <form v-if="mode === 'new'" class="bd-form" novalidate @submit.prevent="save">
      <div class="bd-ph"><h2>طلب جديد</h2><button type="button" class="btn ghost icon-btn" aria-label="إغلاق" @click="$emit('close')"><Icon name="x"/></button></div>
      <div class="f"><label for="qo-customer">العميل</label><CustomerField v-model="f.customer" @input="onCustomerInput"/>
        <div v-if="!f.customer && newName" class="bd-newc"><span class="m">سيُنشأ عميل جديد عند الحفظ</span><div class="bd-newc-row">
          <input class="input" v-model="f.phone" inputmode="tel" dir="ltr" placeholder="الهاتف (اختياري)" aria-label="هاتف العميل الجديد">
          <div class="seg" role="group" aria-label="نوع العميل"><button type="button" :aria-pressed="f.type==='Individual'" @click="f.type='Individual'">فرد</button><button type="button" :aria-pressed="f.type==='Company'" @click="f.type='Company'">مؤسسة</button></div></div></div></div>
      <div v-if="credit && credit.note" class="sh-note warn">ملاحظة العميل: {{ credit.note }}</div>
      <div v-if="credit && credit.over" class="sc2-alert" role="alert">هذا العميل تجاوز سقف الدين: عليه {{ fig(credit.owes) }} من {{ fig(credit.limit) }} دج</div>
      <div class="f"><span class="lbl">ماذا يريد؟</span>
        <div v-for="(l, i) in f.lines" :key="i" class="ol-row">
          <input class="input ol-text" list="svc-list" v-model="l.text" @input="lineInput(l)" aria-label="الخدمة" placeholder="اختر خدمة أو اكتب وصفًا">
          <label class="ol-f"><span class="m">الكمية<template v-if="l.uom"> ({{ l.uom }})</template></span><input class="input num" inputmode="decimal" v-model="l.qty"></label>
          <label class="ol-f"><span class="m">سعر الوحدة (دج)</span><input class="input num" inputmode="decimal" v-model="l.rate" @input="l.auto = false" placeholder="لاحقًا"></label>
          <button v-if="f.lines.length > 1" type="button" class="btn ghost icon-btn" :aria-label="'حذف البند ' + (i + 1)" @click="dropLine(i)">×</button></div>
        <datalist id="svc-list"><option v-for="it in state.boot.items" :key="it.item_code" :value="it.item_name"></option></datalist>
        <div class="row" style="justify-content:space-between"><button type="button" class="tb-addbtn" @click="addLine">+ بند آخر</button><span v-if="filled.length" class="m">المجموع: <b class="money">{{ total === null ? 'يُحدَّد لاحقًا' : money(total) }}</b></span></div></div>
      <div class="f"><label for="qo-adv">تسبيق</label><div class="unit-wrap"><input id="qo-adv" class="input num" inputmode="decimal" v-model="f.advance" placeholder="0"><span class="u">دج</span></div></div>
      <div v-if="+f.advance > 0" class="f"><span class="lbl">طريقة دفع التسبيق</span><div class="bd-chips"><button v-for="m in state.boot.modes" :key="m.value" type="button" class="bd-chip" :aria-pressed="f.mode === m.value" @click="f.mode = m.value">{{ m.label }}</button></div></div>
      <div class="f"><span class="lbl">متى يستلم؟</span><div class="bd-chips">
        <button v-for="c in dueChips" :key="c[1]" type="button" class="bd-chip" :aria-pressed="f.due === isoIn(c[1])" @click="f.due = isoIn(c[1])">{{ c[0] }}</button>
        <input type="date" class="input bd-date" v-model="f.due" :min="isoIn(0)" aria-label="تاريخ آخر"></div></div>
      <div v-if="startColumns.length > 1" class="f"><label for="qo-column">يبدأ من</label><select id="qo-column" class="input" v-model="f.column"><option v-for="c in startColumns" :key="c.id" :value="c.id">{{ c.name }}</option></select></div>
      <div class="f"><span class="lbl">من يعمل عليه؟</span><div class="bd-chips">
        <button v-for="p in state.boot.team" :key="p" type="button" class="bd-person" :aria-pressed="f.assignee === p" @click="f.assignee = f.assignee === p ? '' : p"><Avatar :name="p"/>{{ p }}</button>
        <a v-if="!state.boot.team.length" href="/atelier/team" class="m" @click.prevent="go('/team')">أضف أسماء الفريق أولًا</a></div></div>
      <div class="f"><span class="lbl">وسم</span><div class="bd-chips">
        <button v-for="q in QUICK_TAGS" :key="q[0]" type="button" class="qtag" :class="['tg-' + q[1], {on: f.tags.includes(q[0])}]" :aria-pressed="f.tags.includes(q[0])" @click="toggle(f.tags, q[0])">{{ f.tags.includes(q[0]) ? '✓ ' : '' }}{{ q[0] }}</button></div></div>
      <div class="spacer"></div>
      <div class="bd-savebar"><div v-if="error" class="alert error" role="alert" style="margin-bottom:8px">{{ error }}</div><button type="submit" class="btn primary bd-save" :disabled="saving">{{ saving ? 'جارٍ الحفظ…' : 'حفظ الطلب' }}</button></div>
    </form>

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
const BOARD_COLORS = ["#9A94AC", "#F5D547", "#F59E0B", "#E5484D", "#2563EB", "#22A06B", "#D7F1A8", "#9B87F5", "#1597A6", "#C2410C"];
const isImg = (f) => /\.(png|jpe?g|gif|webp)$/i.test(f.file_name || f.file_url || "");
const ago = (iso) => { const m = Math.round((Date.now() - new Date(String(iso).replace(" ", "T")).getTime()) / 60000);
  return m < 1 ? "الآن" : m < 60 ? `منذ ${m} دقيقة` : m < 1440 ? `منذ ${Math.round(m / 60)} ساعة` : `منذ ${Math.round(m / 1440)} يوم`; };

const BoardCard = {
  props: ["c", "labels", "busy", "dropBefore", "columns"], emits: ["open", "drag", "dropon", "menu"], components: { Avatar, Icon },
  setup() { return { labelStyle, dueWord, daysFromToday, money }; },
  template: `
  <article class="tc" :class="{busy, 'drop-before': dropBefore}" draggable="true" tabindex="0" @dragstart="$emit('drag', c)" @click="$emit('open', c)" @keydown.enter="$emit('open', c)"
    @dragover.prevent.stop="$emit('dropon', c, false)" @drop.prevent.stop="$emit('dropon', c, true)" :aria-label="c.title + ' — ' + c.customer_name">
    <button type="button" class="tc-menu-btn" aria-label="خيارات البطاقة" @click.stop="$emit('menu', c, $event)">···</button>
    <img v-if="c.cover" class="tc-cover" :src="c.cover" alt="" loading="lazy">
    <div class="tc-body">
      <div v-if="c.labels.length" class="tc-labels"><span v-for="id in c.labels.filter(id => labels[id])" :key="id" class="tl" :style="{...labelStyle(labels[id]), '--lb': labels[id].color}">{{ labels[id].name }}</span></div>
      <div class="tc-title">{{ c.title }}</div>
      <div class="tc-cust">{{ c.customer_name }}<template v-if="c.price_pending"> · <span class="bd-warn">بلا سعر</span></template></div>
      <div class="tc-foot">
        <span v-if="c.due && c.per_delivered < 100" class="tc-due" :class="{late: daysFromToday(c.due) < 0, soon: daysFromToday(c.due) >= 0 && daysFromToday(c.due) <= 1}"><Icon name="clock" :size="13"/>{{ dueWord(c.due) }}<template v-if="c.due_time"> {{ c.due_time }}</template></span>
        <span v-else-if="c.per_delivered >= 100" :class="c.grand_total - c.paid > 0.005 ? 'bd-late' : 'bd-ok'">{{ c.grand_total - c.paid > 0.005 ? 'باقي ' + money(c.grand_total - c.paid) : 'مدفوع' }}</span>
        <span v-if="c.comments" class="tc-m" title="تعليقات"><Icon name="msg" :size="13"/>{{ c.comments }}</span>
        <span v-if="c.files" class="tc-m" title="مرفقات"><Icon name="file" :size="13"/>{{ c.files }}</span>
        <span v-if="c.check[1]" class="tc-check" :class="{full: c.check[0] === c.check[1]}" title="قائمة المهام"><Icon name="check" :size="13"/>{{ c.check[0] }}/{{ c.check[1] }}</span>
        <span class="spacer"></span>
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

const CardModal = {
  props: ["name", "config"], emits: ["close", "changed", "open"], components: { Icon, Avatar, CustomerField, CostSection },
  setup(props, { emit }) {
    const d = ref(null), err = ref(null), busy = ref(false), fileInput = ref(null);
    const labels = computed(() => Object.fromEntries(props.config.labels.map((l) => [l.id, l])));
    const load = async () => { try { d.value = await call("card", { name: props.name }); } catch (e) { err.value = e.message; } };
    onMounted(load);
    const save = async (changes) => {
      busy.value = true; err.value = null;
      try { d.value = await call("update_card", { name: props.name, changes: JSON.stringify(changes) }, true); emit("changed"); }
      catch (e) { err.value = e.message; await load(); } finally { busy.value = false; }
    };
    const title = ref(""); watch(d, (v) => v && (title.value = v.title), { immediate: true });
    const saveTitle = () => title.value.trim() && title.value.trim() !== d.value.title && save({ title: title.value.trim() });
    const toggle = (key, v) => { const l = [...d.value[key]]; const i = l.indexOf(v); if (i >= 0) l.splice(i, 1); else l.push(v); save({ [key]: l }); };
    const moveTo = async (col) => {
      busy.value = true; err.value = null;
      try { await call("move_card", { name: props.name, column: col }, true); await load(); emit("changed"); if (props.config.columns.find((c) => c.id === col)?.deliver) offerMaterials(props.name); }
      catch (e) { err.value = e.message; await load(); } finally { busy.value = false; }
    };
    // description
    const editDesc = ref(false), desc = ref("");
    const startDesc = () => { desc.value = d.value.description; editDesc.value = true; };
    const saveDesc = async () => { await save({ description: desc.value }); editDesc.value = false; };
    // checklist
    const newItem = ref("");
    const checkDone = computed(() => (d.value?.checklist || []).filter((c) => c.done).length);
    const setCheck = (list) => save({ checklist: list });
    const addItem = () => { const v = newItem.value.trim(); if (!v) return; setCheck([...d.value.checklist, { text: v, done: 0 }]); newItem.value = ""; };
    const tick = (i) => setCheck(d.value.checklist.map((c, j) => (j === i ? { ...c, done: c.done ? 0 : 1 } : c)));
    const dropItem = (i) => setCheck(d.value.checklist.filter((_, j) => j !== i));
    // files
    const uploading = ref(false);
    const onFiles = async (e) => {
      const list = [...(e.target.files || e.dataTransfer?.files || [])]; if (!list.length) return;
      uploading.value = true; err.value = null;
      try {
        for (const f of list) {
          const up = await uploadPrivate(isImg({ file_name: f.name }) ? await shrinkImage(f) : f, "Sales Order", props.name);
          d.value = await call("file_added", { name: props.name, file_url: up.file_url, file_name: up.file_name }, true);
        }
        emit("changed");
      } catch (x) { err.value = x.message; } finally { uploading.value = false; if (fileInput.value) fileInput.value.value = ""; }
    };
    const delFile = async (f) => {
      if (!confirm(`حذف «${f.file_name}»؟`)) return;
      try { d.value = await call("delete_file", { name: props.name, file: f.name }, true); emit("changed"); } catch (x) { err.value = x.message; }
    };
    const copyFolder = async () => { try { await navigator.clipboard.writeText(d.value.folder); toast("نُسخ مسار المجلد — الصقه في مستكشف الملفات"); } catch { /* path stays selectable */ } };
    const pulling = ref(false);
    const pullFiles = async () => {
      pulling.value = true; err.value = null;
      try { const r = await call("pull_files", { name: props.name }, true); toast(r.added ? `أُضيف ${r.added} ملف من المجلد` : "لا ملفات جديدة في المجلد"); if (r.added) { d.value = await call("card", { name: props.name }); emit("changed"); } }
      catch (x) { err.value = x.message; } finally { pulling.value = false; }
    };
    // comments
    const comment = ref("");
    const addComment = async () => {
      if (!comment.value.trim()) return;
      try { d.value = await call("add_comment", { name: props.name, text: comment.value }, true); comment.value = ""; emit("changed"); } catch (x) { err.value = x.message; }
    };
    // money
    const price = ref("");
    const setPrice = async () => {
      if (!(+price.value > 0)) { err.value = "أدخل السعر"; return; }
      try { await call("update_order", { name: props.name, price: +price.value }, true); price.value = ""; await load(); emit("changed"); toast("حُفظ السعر"); } catch (x) { err.value = x.message; }
    };
    const quote = async (kind) => {
      const win = window.open("about:blank", "_blank"); // opened now: browsers block it after an await
      try {
        if (d.value.price_pending) { await call("update_order", { name: props.name, price: +price.value }, true); price.value = ""; await load(); emit("changed"); }
        const name = await call("card_quote", { order: props.name, kind }, true);
        if (win) win.location = pdfUrl("Quotation", name, "الورشة — عربي");
      } catch (x) { if (win) win.close(); err.value = x.message; }
    };
    const pay = () => (state.sheet = { type: "payment", customer: { name: d.value.customer, customer_name: d.value.customer_name }, order: props.name });
    watch(() => state.rev, load);
    const customer = ref(null);
    watch(customer, (c) => c && save({ customer: c.name }));
    const onKey = (e) => { if (e.key === "Escape" && !state.sheet) emit("close"); };
    onMounted(() => window.addEventListener("keydown", onKey));
    onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
    const column = computed(() => props.config.columns.find((c) => c.id === d.value?.column));
    const pop = ref(null), who = ref(""), editing = ref(null), pickClient = ref(false);
    // checklist templates, copy, archive
    const tpls = ref([]);
    const openTpl = async () => { pop.value = pop.value === "tpl" ? null : "tpl"; if (pop.value) { try { tpls.value = await call("checklist_templates"); } catch { tpls.value = []; } } };
    const applyTpl = (tp) => { pop.value = null; save({ checklist: [...d.value.checklist, ...tp.items.filter((x) => !d.value.checklist.some((c) => c.text === x)).map((x) => ({ text: x, done: 0 }))] }); };
    const saveTpl = async () => {
      const title = prompt("اسم القالب:", d.value.title.split(":")[0].slice(0, 40)); if (!title) return;
      try { tpls.value = await call("save_checklist_template", { title, items: JSON.stringify(d.value.checklist.map((c) => c.text)) }, true); toast("حُفظ القالب"); } catch (e) { err.value = e.message; }
    };
    const dropTpl = async (tp) => { if (!confirm(`حذف القالب «${tp.title}»؟`)) return; try { tpls.value = await call("delete_checklist_template", { title: tp.title }, true); } catch (e) { err.value = e.message; } };
    const copyCard = async () => { try { const n = await cardActions.copy(props.name); emit("changed"); emit("open", n); } catch (e) { err.value = e.message; } };
    const archiveCard = async () => { if (!confirm("أرشفة هذه البطاقة؟ تجدها لاحقًا في «الأرشيف».")) return; try { await cardActions.archive(props.name); emit("changed"); emit("close"); } catch (e) { err.value = e.message; } };
    // drop-downs: members (team people with a login) and labels (editable here by the manager)
    const closePop = () => { pop.value = null; editing.value = null; };
    onMounted(() => window.addEventListener("click", closePop));
    onBeforeUnmount(() => window.removeEventListener("click", closePop));
    const people = computed(() => {
      const all = state.boot.team_members || [], linked = all.filter((m) => m.user);
      return (linked.length ? linked : all).filter((m) => !who.value || m.name.includes(who.value.trim()));
    });
    const manager = computed(() => !!state.boot.can.prices);
    const saveConfig = async (labels) => {
      try { await call("save_board", { config: JSON.stringify({ columns: props.config.columns, labels }) }, true); editing.value = null; emit("changed"); }
      catch (e) { err.value = e.message; }
    };
    const newLabel = () => { editing.value = { name: "", color: BOARD_COLORS[props.config.labels.length % BOARD_COLORS.length] }; nextTick(() => document.getElementById("new-label")?.focus()); };
    const saveLabel = () => {
      const e = editing.value; if (!e || !e.name.trim()) return;
      const labels = e.id ? props.config.labels.map((l) => (l.id === e.id ? { ...l, name: e.name.trim(), color: e.color } : l)) : [...props.config.labels, { name: e.name.trim(), color: e.color }];
      saveConfig(labels);
    };
    const deleteLabel = (l) => { if (confirm(`حذف الحالة «${l.name}» من كل البطاقات؟`)) saveConfig(props.config.labels.filter((x) => x.id !== l.id)); };
    const dueTone = computed(() => { if (!d.value?.due || d.value.per_delivered >= 100) return ""; const n = daysFromToday(d.value.due); return n < 0 ? "late" : n <= 1 ? "soon" : ""; });
    watch(customer, () => (pickClient.value = false));
    return { tpls, openTpl, applyTpl, saveTpl, dropTpl, copyCard, archiveCard, pop, who, editing, pickClient, people, manager, newLabel, saveLabel, deleteLabel, dueTone, waLink, BOARD_COLORS, d, err, busy, fileInput, labels, title, saveTitle, toggle, moveTo, save, editDesc, desc, startDesc, saveDesc, newItem, checkDone, addItem, tick, dropItem,
      uploading, onFiles, delFile, copyFolder, pulling, pullFiles, comment, addComment, price, setPrice, pay, quote, offerMaterials, customer, column, labelStyle, isImg, ago, money, date, dueWord, pdfUrl, go, state };
  },
  template: `
  <div class="overlay tm-overlay" @click.self="$emit('close')">
    <div class="tm" role="dialog" aria-modal="true" :aria-label="d ? d.title : 'البطاقة'" @dragover.prevent @drop.prevent="onFiles">
      <div v-if="!d" class="tm-loading">{{ err || 'جارٍ التحميل…' }}</div>
      <template v-else>
      <div class="tm-cover" :style="d.cover ? {backgroundImage: 'url(' + d.cover + ')'} : {}">
        <label class="tm-col"><span class="sr-only">العمود</span>
          <select class="input" :value="d.column" :disabled="busy || !d.can_edit" @change="moveTo($event.target.value)">
            <option v-for="c in config.columns" :key="c.id" :value="c.id">{{ c.name }}{{ c.deliver ? ' (تسليم)' : '' }}</option></select></label>
        <button type="button" class="btn icon-btn tm-close" aria-label="إغلاق" @click="$emit('close')"><Icon name="x"/></button>
        <div v-if="d.can_edit" class="tm-actions"><button type="button" class="btn sm" @click="copyCard">نسخ</button><button type="button" class="btn sm" @click="archiveCard"><Icon name="box" :size="15"/>أرشفة</button></div>
      </div>
      <div class="tm-body">
        <div class="tm-main">
          <div v-if="err" class="alert error" role="alert">{{ err }}</div>
          <div class="tm-titlebox">
            <textarea class="tm-title" v-model="title" rows="1" :readonly="!d.can_edit" aria-label="عنوان البطاقة" @blur="saveTitle" @keydown.enter.prevent="$event.target.blur()"></textarea>
          </div>
          <div class="tm-client">
            <Avatar :name="d.client.customer_name" :size="42"/>
            <div style="flex:1;min-width:0">
              <div><a class="strong" :href="'/atelier/customers?c=' + encodeURIComponent(d.customer)" @click.prevent="go('/customers?c=' + encodeURIComponent(d.customer))">{{ d.client.customer_name }}</a>
                <span v-if="!d.client.cash" class="tm-type">{{ d.client.type === 'Company' ? 'مؤسسة' : 'فرد' }}</span></div>
              <div class="m"><template v-if="d.client.cash">لم يُحدَّد العميل بعد</template><template v-else>
                <span v-if="d.client.phone" dir="ltr">{{ d.client.phone }}</span><template v-if="d.client.phone"> · </template>{{ d.client.orders }} {{ d.client.orders === 1 ? 'طلب' : 'طلبات' }}
                <template v-if="d.client.owes > 0.005"> · <span class="bd-late">عليه {{ money(d.client.owes) }}</span></template></template></div>
            </div>
            <a v-if="d.client.phone" class="btn sm" :href="'tel:' + d.client.phone" aria-label="اتصال"><Icon name="phone" :size="15"/></a>
            <a v-if="waLink(d.client.phone)" class="btn sm" target="_blank" rel="noopener" :href="waLink(d.client.phone)">واتساب</a>
            <button v-if="d.docstatus === 0 && d.can_edit" type="button" class="btn sm" @click="pickClient = !pickClient">{{ d.client.cash ? 'اختيار العميل' : 'تغيير' }}</button>
          </div>
          <div v-if="pickClient" class="tm-cust"><CustomerField v-model="customer"/></div>
          <div class="tm-meta">
            <div class="tm-meta-b tm-pop-host"><span class="m">الأعضاء</span>
              <div class="row" style="gap:4px"><Avatar v-for="p in d.members" :key="p" :name="p" :size="32"/>
                <button v-if="d.can_edit" type="button" class="tm-plus" aria-label="اختيار الأعضاء" :aria-expanded="pop === 'members'" @click.stop="pop = pop === 'members' ? null : 'members'">+</button></div>
              <div v-if="pop === 'members'" class="tm-pop" @click.stop>
                <b>الأعضاء</b>
                <input class="input" v-model="who" placeholder="ابحث في الفريق…" aria-label="بحث في الفريق">
                <button v-for="m in people" :key="m.name" type="button" class="tm-pop-row" :aria-pressed="d.members.includes(m.name)" :disabled="busy" @click="toggle('members', m.name)">
                  <Avatar :name="m.name" :size="28"/><span style="flex:1"><b>{{ m.name }}</b><span v-if="m.role" class="m" style="display:inline"> · {{ m.role }}</span></span><span v-if="d.members.includes(m.name)" class="tm-tick">✓</span></button>
                <span v-if="!people.length" class="m">لا أحد في الفريق بحساب دخول.</span>
                <span class="m">فقط من لهم حساب في التطبيق.</span>
              </div>
            </div>
            <div class="tm-meta-b tm-pop-host"><span class="m">الحالات</span>
              <div class="row" style="gap:4px;flex-wrap:wrap"><span v-for="id in d.labels.filter(id => labels[id])" :key="id" class="tl tm-lb" :style="{'--lb': labels[id].color}">{{ labels[id].name }}</span>
                <button v-if="d.can_edit" type="button" class="tm-plus sq" aria-label="اختيار الحالات" :aria-expanded="pop === 'labels'" @click.stop="pop = pop === 'labels' ? null : 'labels'">+</button></div>
              <div v-if="pop === 'labels'" class="tm-pop" @click.stop>
                <b>الحالات</b>
                <template v-for="l in config.labels" :key="l.id">
                  <div v-if="editing && editing.id === l.id" class="tm-ledit">
                    <input class="input" v-model="editing.name" aria-label="اسم الحالة" @keydown.enter.prevent="saveLabel">
                    <span class="bs-colors"><button v-for="col in BOARD_COLORS" :key="col" type="button" class="bs-sw" :style="{background: col}" :aria-pressed="editing.color === col" :aria-label="col" @click="editing.color = col"></button></span>
                    <div class="row" style="gap:6px"><button type="button" class="btn primary sm" @click="saveLabel">حفظ</button><button type="button" class="btn ghost sm" @click="editing = null">إلغاء</button>
                      <span class="spacer"></span><button type="button" class="btn ghost sm" style="color:var(--danger)" @click="deleteLabel(l)">حذف</button></div>
                  </div>
                  <div v-else class="tm-lrow">
                    <label class="tm-lcheck"><input type="checkbox" :checked="d.labels.includes(l.id)" :disabled="busy" @change="toggle('labels', l.id)"><span class="tl" :style="labelStyle(l)">{{ l.name }}</span></label>
                    <button v-if="manager" type="button" class="btn ghost icon-btn sm" :aria-label="'تعديل ' + l.name" @click="editing = {...l}"><Icon name="edit" :size="14"/></button>
                  </div>
                </template>
                <div v-if="editing && !editing.id" class="tm-ledit">
                  <input id="new-label" class="input" v-model="editing.name" placeholder="اسم الحالة" aria-label="اسم الحالة الجديدة" @keydown.enter.prevent="saveLabel">
                  <span class="bs-colors"><button v-for="col in BOARD_COLORS" :key="col" type="button" class="bs-sw" :style="{background: col}" :aria-pressed="editing.color === col" :aria-label="col" @click="editing.color = col"></button></span>
                  <div class="row" style="gap:6px"><button type="button" class="btn primary sm" @click="saveLabel">إضافة</button><button type="button" class="btn ghost sm" @click="editing = null">إلغاء</button></div>
                </div>
                <button v-else-if="manager" type="button" class="tm-pop-add" @click="newLabel">+ حالة جديدة</button>
              </div>
            </div>
            <div class="tm-meta-b"><span class="m">الموعد النهائي</span>
              <div class="tm-due" :class="dueTone">
                <input type="date" class="input bd-date" :value="d.due" :disabled="busy || !d.can_edit" aria-label="تاريخ التسليم" @change="save({due: $event.target.value})">
                <input type="time" class="input bd-date" :value="d.due_time || ''" :disabled="busy || !d.can_edit" aria-label="ساعة التسليم" @change="save({due_time: $event.target.value})">
                <span class="tm-due-w">{{ dueWord(d.due) }}</span></div></div>
          </div>

          <section class="tm-sec"><h3><Icon name="file" :size="17"/>الوصف <span class="spacer"></span><button v-if="d.can_edit && !editDesc" type="button" class="btn sm" @click="startDesc">تعديل</button></h3>
            <template v-if="editDesc"><textarea class="input tm-desc" v-model="desc" rows="5" aria-label="الوصف"></textarea>
              <div class="row" style="gap:8px"><button type="button" class="btn primary sm" :disabled="busy" @click="saveDesc">حفظ</button><button type="button" class="btn ghost sm" @click="editDesc=false">إلغاء</button></div></template>
            <div v-else class="tm-desc-v" :class="{empty: !d.description}" @click="d.can_edit && startDesc()">{{ d.description || 'أضف وصفًا: المقاسات، الورق، رقم العميل…' }}</div>
          </section>

          <section class="tm-sec"><h3><Icon name="check" :size="17"/>قائمة المهام <span v-if="d.checklist.length" class="m" style="display:inline">{{ checkDone }}/{{ d.checklist.length }}</span><span class="spacer"></span>
            <span v-if="d.can_edit" class="tm-pop-host"><button type="button" class="btn sm tm-tpl-btn" :aria-expanded="pop === 'tpl'" @click.stop="openTpl">من قالب</button>
              <div v-if="pop === 'tpl'" class="tm-pop" style="inset-inline-start:auto;inset-inline-end:0" @click.stop><b>القوالب</b>
                <div v-for="tp in tpls" :key="tp.title" class="tm-lrow"><button type="button" class="tm-pop-row" style="flex:1" @click="applyTpl(tp)">{{ tp.title }} <span class="m" style="display:inline">({{ tp.items.length }})</span></button>
                  <button v-if="manager" type="button" class="btn ghost icon-btn sm" :aria-label="'حذف قالب ' + tp.title" @click="dropTpl(tp)"><Icon name="x" :size="14"/></button></div>
                <span v-if="!tpls.length" class="m">لا قوالب بعد.</span>
                <button v-if="d.checklist.length" type="button" class="tm-pop-add" @click="saveTpl">+ حفظ قائمة هذه البطاقة كقالب</button></div></span></h3>
            <div v-if="d.checklist.length" class="tm-bar"><span :style="{width: (checkDone / d.checklist.length * 100) + '%'}"></span></div>
            <div v-for="(c, i) in d.checklist" :key="i" class="tm-ck">
              <label class="row" style="gap:10px;flex:1"><input type="checkbox" :checked="!!c.done" :disabled="busy || !d.can_edit" @change="tick(i)"><span :class="{done: c.done}">{{ c.text }}</span></label>
              <button v-if="d.can_edit" type="button" class="btn ghost icon-btn sm" :aria-label="'حذف ' + c.text" @click="dropItem(i)"><Icon name="x" :size="14"/></button></div>
            <form v-if="d.can_edit" class="row" style="gap:8px" @submit.prevent="addItem"><input class="input" v-model="newItem" placeholder="+ أضف عنصرًا" aria-label="عنصر جديد"><button type="submit" class="btn sm">إضافة</button></form>
          </section>

          <section class="tm-sec"><h3><Icon name="file" :size="17"/>المرفقات <span class="spacer"></span>
            <label v-if="d.can_edit" class="btn sm"><Icon name="image" :size="15"/>تصوير<input type="file" accept="image/*" capture="environment" class="sr-only" @change="onFiles"></label>
            <label v-if="d.can_edit" class="btn sm">{{ uploading ? 'جارٍ الرفع…' : '+ إضافة' }}<input ref="fileInput" type="file" multiple class="sr-only" @change="onFiles"></label></h3>
            <div v-if="d.folder" class="tm-folder"><Icon name="file" :size="15"/><span class="ellipsis" :title="d.folder">{{ d.folder.split('\\\\').pop() }}</span>
              <button type="button" class="btn ghost sm" @click="copyFolder">نسخ المسار</button>
              <button v-if="d.can_edit" type="button" class="btn ghost sm" :disabled="pulling" @click="pullFiles">{{ pulling ? 'جارٍ…' : 'تحديث الملفات' }}</button></div>
            <div v-if="!d.files.length" class="m">اسحب الملفات إلى هنا، أو اضغط «+ إضافة».</div>
            <div v-for="f in d.files" :key="f.name" class="tm-file">
              <a class="tm-thumb" :href="f.file_url" target="_blank" rel="noopener"><img v-if="isImg(f)" :src="f.file_url" alt=""><span v-else>{{ (f.file_name.split('.').pop() || '').toUpperCase() }}</span></a>
              <div style="flex:1;min-width:0"><a class="strong ellipsis" style="display:block" :href="f.file_url" target="_blank" rel="noopener">{{ f.file_name }}</a>
                <span class="m">{{ ago(f.creation) }} · {{ f.by }}<template v-if="d.cover === f.file_url"> · الغلاف</template></span>
                <span class="row" style="gap:10px"><a class="m" :href="f.file_url" download>تحميل</a>
                  <a v-if="isImg(f) && d.cover !== f.file_url && d.can_edit" href="#" class="m" @click.prevent="save({cover: f.file_url})">جعلها الغلاف</a>
                  <a v-if="d.can_edit" href="#" class="m" style="color:var(--danger)" @click.prevent="delFile(f)">حذف</a></span></div></div>
          </section>
        </div>

        <aside class="tm-side">
          <div v-if="d.money" class="tm-money"><h3>المال <span class="m" style="display:inline;margin-inline-start:auto">للمدير</span></h3>
            <template v-if="d.price_pending"><span class="m">لم يُحدَّد السعر بعد</span>
              <div class="row" style="gap:8px"><div class="unit-wrap" style="flex:1"><input class="input num" inputmode="decimal" v-model="price" placeholder="0" aria-label="السعر"><span class="u">دج</span></div><button type="button" class="btn primary" @click="setPrice">حفظ</button></div></template>
            <template v-else>
              <div class="bd-line"><span class="m">السعر</span><b class="money">{{ money(d.grand_total) }}</b></div>
              <div class="bd-line"><span class="m">دفع</span><span class="money">{{ money(d.paid) }}</span></div>
              <div class="tm-paybar"><span :style="{width: Math.min(100, d.grand_total ? d.paid / d.grand_total * 100 : 0) + '%'}"></span></div>
              <div class="bd-line"><span class="m">الباقي</span><b class="money" :class="{'bd-late': d.grand_total - d.paid > 0.005}">{{ money(Math.max(0, d.grand_total - d.paid)) }}</b></div></template>
            <div class="row" style="gap:8px"><button v-if="state.boot.can.payment && !d.price_pending && d.grand_total - d.paid > 0.005" type="button" class="btn" style="flex:1" @click="pay">استلمت دفعة</button>
              </div>
            <button v-if="d.materials_pending" type="button" class="btn" @click="offerMaterials(d.name)">خصم مواد الطلب من المخزون</button>
            <div class="tm-docs"><a class="btn" target="_blank" rel="noopener" :href="pdfUrl('Sales Order', d.name, 'الورشة — عربي')">بون</a><button type="button" class="btn" :disabled="d.price_pending && !(+price > 0)" @click="quote('devis')">Devis</button><button type="button" class="btn" :disabled="d.price_pending && !(+price > 0)" @click="quote('proforma')">Pro forma</button></div>
            <span v-if="d.price_pending && !(+price > 0)" class="m">اكتب السعر لإصدار Devis أو Pro forma</span>
          </div>
          <CostSection v-if="d.money" :name="d.name" :key="d.name + ':' + d.grand_total" @use-price="price = $event"/>
          <h3>التعليقات والنشاط</h3>
          <form class="tm-comment" @submit.prevent="addComment"><textarea class="input" v-model="comment" rows="2" placeholder="اكتب تعليقًا…" aria-label="تعليق" @keydown.ctrl.enter="addComment"></textarea>
            <button v-if="comment.trim()" type="submit" class="btn primary sm">حفظ</button></form>
          <div v-for="a in d.activity" :key="a.name" class="tm-act" :class="{info: a.comment_type === 'Info'}">
            <Avatar :name="a.by" :size="30"/>
            <div style="flex:1;min-width:0"><div><b>{{ a.by }}</b> <span class="m" style="display:inline">{{ ago(a.creation) }}</span></div>
              <div v-if="a.comment_type === 'Comment'" class="tm-bubble" v-html="a.content"></div><div v-else class="m">{{ a.content }}</div></div></div>
        </aside>
      </div>
      </template>
    </div>
  </div>`,
};

const Board = {
  props: ["startNew", "openCard"], components: { Icon, BoardCard, BoardPanel, CardModal, Avatar, TransitionGroup },
  setup(props) {
    const { s, load } = useLoad(() => call("board2"));
    onMounted(load);
    watch(() => state.rev, load);
    const cfg = computed(() => s.data?.config || { columns: [], labels: [] });
    const labels = computed(() => Object.fromEntries(cfg.value.labels.map((l) => [l.id, l])));
    const mine = ref(false), label = ref(""), q = ref(""), view = ref(localStorage.getItem("atelier.view") || "board");
    watch(view, (v) => { try { localStorage.setItem("atelier.view", v); } catch { /* private mode */ } });
    const me = computed(() => state.boot.me || state.boot.full_name || "");
    const needle = computed(() => q.value.trim().toLowerCase());
    const rows = computed(() => (s.data?.cards || []).filter((c) => (!mine.value || c.members.includes(me.value)) && (!label.value || c.labels.includes(label.value))
      && (!needle.value || [c.title, c.customer_name, c.name].some((v) => String(v || "").toLowerCase().includes(needle.value)))));
    const urgent = (c) => (c.labels.some((x) => labels.value[x]?.name === "عاجل") ? 0 : 1);
    const order = (a, b) => (a.pos && b.pos ? a.pos - b.pos : a.pos ? -1 : b.pos ? 1 : urgent(a) - urgent(b) || String(a.due || "9").localeCompare(String(b.due || "9")));
    const cols = computed(() => cfg.value.columns.map((col) => ({ ...col, items: rows.value.filter((c) => c.column === col.id).sort(order) })));
    const panel = ref(props.startNew ? { mode: "new", preset: state.quickCustomer || null } : null);
    state.quickCustomer = null;
    const open = ref(props.openCard || state.query.get("card") || null);
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
    const openMenu = (c, ev) => { const r = ev.currentTarget.getBoundingClientRect(); menu.value = { c, top: r.bottom + 4, left: Math.max(8, r.left - 180) }; };
    const fopen = ref(false), more = ref(false);
    const openCount = computed(() => (s.data?.cards || []).filter((c) => c.per_delivered < 100).length);
    const closeMenu = () => { menu.value = null; fopen.value = false; more.value = false; };
    onMounted(() => window.addEventListener("click", closeMenu));
    onBeforeUnmount(() => window.removeEventListener("click", closeMenu));
    const act = async (kind, extra) => {
      const c = menu.value?.c; menu.value = null; if (!c) return;
      try {
        if (kind === "copy") { const n = await cardActions.copy(c.name); await load(); open.value = n; }
        else if (kind === "archive") { await cardActions.archive(c.name); await load(); }
        else if (kind === "move") await moveTo(c, extra, undefined);
        else if (kind === "photo") { photoFor.value = c.name; photoInput.value.click(); }
      } catch (e) { toast(e.message, "error"); }
    };
    const photoFor = ref(null);
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
    const weekStart = ref(0);
    const days = computed(() => {
      const base = parseDate(todayISO()); base.setDate(base.getDate() - base.getDay() + weekStart.value * 7);
      return Array.from({ length: 7 }, (_, i) => { const d = new Date(base); d.setDate(base.getDate() + i); const iso = isoOf(d);
        return { iso, name: WEEK[d.getDay()], num: d.getDate(), today: iso === todayISO(), items: rows.value.filter((c) => c.due === iso && c.per_delivered < 100) }; });
    });
    const lateCount = computed(() => rows.value.filter((c) => c.due && c.per_delivered < 100 && daysFromToday(c.due) < 0).length);
    const dropDay = async (iso) => {
      const c = dragging.value; dragging.value = null; over.value = null; if (!c || c.due === iso) return;
      try { await call("update_card", { name: c.name, changes: JSON.stringify({ due: iso }) }, true); toast("تغيّر الموعد"); await load(); } catch (e) { toast(e.message, "error"); }
    };
    const saved = async () => { await load(); panel.value = null; };
    const closePanel = () => { panel.value = null; if (route.value.name === "order-new") go("/"); };
    return { fopen, more, openCount, s, load, cfg, labels, mine, label, q, view, cols, panel, open, busy, dragging, over, before, moveTo, drop, dropOn, adding, newTitle, addCard, startAdd,
      newCol, addingCol, addColumn, startCol, archivePaid, paidCount, menu, openMenu, act, photoInput, onPhoto, archive, showArchive, restore,
      notes, bell, toggleBell, weekStart, days, lateCount, dropDay, saved, closePanel, labelStyle, ago, dueWord, date, state, go, t };
  },
  template: `
  <div class="page tb cb">
    <div class="tb-head">
      <h1>الطلبات</h1>
      <span class="cl-count">{{ openCount }} {{ openCount === 1 ? 'طلب جارٍ' : 'طلبات جارية' }}</span>
      <div class="mn-month cb-views" role="group" aria-label="طريقة العرض"><button type="button" :aria-pressed="view === 'board'" @click="view = 'board'"><Icon name="grid" :size="15"/>لوحة</button><button type="button" :aria-pressed="view === 'calendar'" @click="view = 'calendar'"><Icon name="calendar" :size="15"/>تقويم</button></div>
      <span class="spacer"></span>
      <label class="cl-search"><Icon name="search" :size="16"/><span class="sr-only">بحث في البطاقات</span><input type="search" v-model="q" placeholder="ابحث: عميل، عنوان، رقم"></label>
      <div class="cl-pop-host"><button type="button" class="cl-btn" :aria-expanded="fopen" @click.stop="fopen = !fopen; more = false; bell = false"><Icon name="filter" :size="16"/>تصفية<template v-if="label || mine"> · {{ (label ? 1 : 0) + (mine ? 1 : 0) }}</template></button>
        <div v-if="fopen" class="cl-pop cl-filters" @click.stop>
          <label class="cl-fgroup"><span>الحالة</span><select class="input" v-model="label"><option value="">كل الحالات</option><option v-for="l in cfg.labels" :key="l.id" :value="l.id">{{ l.name }}</option></select></label>
          <label class="st2-check"><input type="checkbox" v-model="mine"><span>بطاقاتي فقط (مهامي)</span></label>
          <div class="cl-pop-foot"><button type="button" class="cl-link" @click="label = ''; mine = false">إعادة ضبط</button><button type="button" class="cl-btn primary" @click="fopen = false">تم</button></div></div></div>
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
          <button v-if="s.data && s.data.manager" type="button" @click="go('/settings?tab=board')"><Icon name="gear" :size="16"/>تخصيص اللوحة</button></div></div>
      <button type="button" class="cl-btn primary" @click="panel = {mode: 'new'}"><Icon name="plus" :size="16"/>طلب جديد</button>
    </div>
    <div v-if="s.loading && !s.data" class="ws-loading">{{ t('loading') }}</div>
    <div v-else-if="s.error" class="alert error"><span style="flex:1">{{ s.error }}</span><button class="btn sm" @click="load">{{ t('retry') }}</button></div>

    <div v-else-if="view === 'calendar'" class="tb-cal">
      <div class="tb-cal-head"><b>{{ date(days[0].iso) }} — {{ date(days[6].iso) }}</b><span v-if="lateCount" class="bd-chip debt" style="cursor:default">{{ lateCount }} متأخرة</span><span class="spacer"></span>
        <button type="button" class="bd-chip" @click="weekStart--">‹ السابق</button><button type="button" class="bd-chip" :aria-pressed="weekStart === 0" @click="weekStart = 0">هذا الأسبوع</button><button type="button" class="bd-chip" @click="weekStart++">التالي ›</button></div>
      <div class="tb-cal-grid">
        <section v-for="d in days" :key="d.iso" class="tb-day" :class="{today: d.today, over: over === d.iso}" :aria-label="d.name + ' ' + d.num"
          @dragover.prevent="over = d.iso" @dragleave="over === d.iso && (over = null)" @drop.prevent="dropDay(d.iso)">
          <h2><span>{{ d.name }}</span><span class="tb-day-n">{{ d.num }}</span></h2>
          <button v-for="c in d.items" :key="c.name" type="button" class="tb-ev" draggable="true" @dragstart="dragging = c" @click="open = c.name"
            :style="{borderInlineStartColor: (c.labels[0] && labels[c.labels[0]]) ? labels[c.labels[0]].color : '#9B87F5'}">
            <span class="strong">{{ c.title }}</span><span class="m">{{ c.due_time || '' }} {{ c.customer_name }}</span>
            <span class="tc-members"><Avatar v-for="m in c.members.slice(0, 3)" :key="m" :name="m"/></span></button>
        </section>
      </div>
      <span class="m" style="color:#fff">اسحب بطاقة إلى يوم آخر لتغيير موعدها.</span>
    </div>

    <div v-else class="tb-cols">
      <section v-for="c in cols" :key="c.id" class="tb-col" :class="{over: over === c.id, deliver: c.deliver, full: c.limit && c.items.length > c.limit}" :aria-label="c.name"
        @dragover.prevent="over = c.id; before = null" @dragleave="over === c.id && !before && (over = null)" @drop.prevent="drop(c.id)">
        <h2 class="tb-ch"><i :style="{background: c.color}"></i>{{ c.name }}<span v-if="c.deliver" title="عمود التسليم" class="cb-truck"><Icon name="truck" :size="15"/></span>
          <span class="bd-n" :class="{over: c.limit && c.items.length > c.limit}">{{ c.items.length }}<template v-if="c.limit"> / {{ c.limit }}<template v-if="c.items.length > c.limit"> !</template></template></span></h2>
        <TransitionGroup name="tcm" tag="div" class="tb-list">
          <BoardCard v-for="card in c.items" :key="card.name" :c="card" :labels="labels" :busy="busy === card.name" :drop-before="before === card.name"
            @open="open = card.name" @drag="dragging = $event" @dropon="dropOn" @menu="openMenu"/>
        </TransitionGroup>
        <button v-if="c.deliver && paidCount(c)" type="button" class="tb-addbtn" @click="archivePaid(c.id)">أرشفة المدفوع كله ({{ paidCount(c) }})</button>
        <template v-if="!c.deliver">
          <form v-if="adding === c.id" class="tb-add" @submit.prevent="addCard(c.id)">
            <textarea :id="'add-' + c.id" class="input" v-model="newTitle" rows="2" placeholder="عنوان البطاقة…" aria-label="عنوان البطاقة" @keydown.enter.prevent="addCard(c.id)" @keydown.esc="adding = null"></textarea>
            <div class="row" style="gap:6px"><button type="submit" class="btn primary sm">إضافة</button><button type="button" class="btn ghost sm" @click="adding = null">إلغاء</button></div></form>
          <button v-else type="button" class="tb-addbtn" @click="startAdd(c.id)">+ إضافة بطاقة</button>
        </template>
      </section>
      <div v-if="s.data && s.data.manager" class="tb-newcol">
        <form v-if="addingCol" @submit.prevent="addColumn"><input id="new-col" class="input" v-model="newCol" placeholder="اسم العمود" aria-label="اسم العمود الجديد" @keydown.esc="addingCol = false">
          <div class="row" style="gap:6px;margin-top:8px"><button type="submit" class="btn primary sm">إضافة</button><button type="button" class="btn ghost sm" @click="addingCol = false">إلغاء</button></div></form>
        <button v-else type="button" class="tb-newcol-btn" @click="startCol">+ إضافة عمود</button>
      </div>
    </div>

    <div v-if="menu" class="tm-pop tb-menu" :style="{top: menu.top + 'px', left: menu.left + 'px'}" @click.stop>
      <b class="ellipsis">{{ menu.c.title }}</b>
      <button type="button" class="tm-pop-row" @click="act('copy')"><Icon name="file" :size="15"/>نسخ البطاقة</button>
      <button type="button" class="tm-pop-row" @click="act('archive')"><Icon name="box" :size="15"/>أرشفة</button>
      <button type="button" class="tm-pop-row" @click="act('photo')"><Icon name="image" :size="15"/>تصوير وإرفاق</button>
      <label class="tm-pop-row">نقل إلى <select class="input" style="width:auto;min-height:32px" @change="act('move', $event.target.value)"><option value="">…</option>
        <option v-for="col in cfg.columns.filter(x => x.id !== menu.c.column)" :key="col.id" :value="col.id">{{ col.name }}</option></select></label>
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
    <CardModal v-if="open && s.data" :key="open" :name="open" :config="cfg" @close="open = null" @changed="load" @open="open = $event"/>
  </div>`,
};

const SimpleCustomers = {
  props: ["openId"], components: { Icon, Avatar },
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
      sel.value = name; err.value = null; if (!keep) { tab.value = "orders"; d.value = null; }
      try { d.value = await call("customer2", { name }); } catch (e) { err.value = e.message; }
    }
    if (sel.value) open(sel.value);
    const bal = (v) => (v > 0.005 ? { text: money(v), cls: "bad" } : v < -0.005 ? { text: "له " + money(-v), cls: "ok" } : { text: "خالص", cls: "" });
    const lastWord = (iso) => { if (!iso) return "—"; const n = -daysFromToday(iso); return n <= 0 ? "اليوم" : n === 1 ? "أمس" : n === 2 ? "منذ يومين" : n < 30 ? `منذ ${n} أيام` : date(iso); };
    const csv = (name, head, lines) => {
      const text = "﻿" + [head, ...lines].map((r) => r.map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(",")).join("\n");
      const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" })); a.download = name; a.click();
    };
    const exportList = () => { more.value = false; csv("العملاء.csv", ["العميل", "النوع", "الهاتف", "الطلبات", "آخر طلب", "الرصيد"],
      rows.value.map((c) => [c.customer_name, c.customer_type === "Company" ? "مؤسسة" : "فرد", c.mobile_no || "", c.orders || 0, c.last_order || "", (c.balance || 0).toFixed(2)])); };
    const newOrderFor = (c) => { state.quickCustomer = { name: c.name, customer_name: c.customer_name }; go("/orders/new"); };
    const pay = () => (state.sheet = { type: "payment", customer: { name: d.value.name, customer_name: d.value.customer_name } });
    // profile
    const pmenu = ref(false), merging = ref(null), editNote = ref(false), note = ref(""), remind = ref(null);
    const closeMenus = () => { pmenu.value = false; more.value = false; };
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
    const TABS = computed(() => [["orders", "الطلبات"], ["files", "الملفات"], ["log", "التواصل"], ["stats", "الإحصاء"], ...(d.value?.balance !== undefined ? [["account", "الحساب"]] : []), ["data", "البيانات"]]);
    return { s, load, sel, d, err, tab, q, f, draft, fopen, more, openFilters, applyFilters, resetFilters, TYPES, STATUSES, SORTS, everyone, ctags, rows, active, clearOne,
      kpi, quick, open, bal, lastWord, exportList, newOrderFor, pay, pmenu, merging, editNote, note, startNote, saveExtra, remind, startRemind, sendRemind, toggleDisabled,
      doMerge, exportOrders, reorder, uploading, onFile, copyText, LOG_KINDS, logKind, logText, addLog, months6, maxMonth, stFrom, stTo, statementUrl, sendStatement, STATE_DOT,
      owesNow, TABS, labelStyle, isImg, waLink, money, fig, date, ago, state, go, t };
  },
  template: `
  <div class="cl" :class="{'with-panel': sel}">
    <div class="cl-main">
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
        <div v-if="active.length" class="cl-active">
          <button v-for="a in active" :key="a.k" type="button" class="cl-chip" :aria-label="'إزالة ' + a.t" @click="clearOne(a.k)">{{ a.t }}<Icon name="x" :size="13"/></button>
          <button type="button" class="cl-link" @click="resetFilters">مسح التصفية</button>
        </div>
      </header>

      <div v-if="s.loading && !s.data" class="ws-loading">جارٍ التحميل…</div>
      <div v-else-if="s.error" class="alert error" style="margin:20px 28px">{{ s.error }}</div>
      <template v-else-if="s.data">
        <div class="cl-stats">
          <button type="button" @click="quick('all')"><span>العملاء</span><b>{{ kpi.total }}</b><small>{{ kpi.fresh }} جدد هذا الشهر</small></button>
          <button type="button" @click="quick('debt')"><span>عليهم دين</span><b class="bad money">{{ money(kpi.debt) }}</b><small>{{ kpi.debtN }} عملاء<template v-if="kpi.late"> · {{ kpi.late }} متأخرون</template></small></button>
          <button type="button" :disabled="!kpi.top" @click="kpi.top && open(kpi.top.name)"><span>الأكثر طلبًا</span><b class="ellipsis">{{ kpi.top ? kpi.top.customer_name : '—' }}</b><small>{{ kpi.top ? kpi.top.orders + ' طلبات' : '' }}</small></button>
          <button type="button" @click="quick('away')"><span>غابوا عنك</span><b>{{ kpi.away }}</b><small>بلا طلب منذ {{ s.data.away_days }} يومًا</small></button>
        </div>
        <div class="cl-table-wrap">
          <table class="cl-table">
            <thead><tr><th>العميل</th><th class="desktop-only wide-only">النوع</th><th class="desktop-only wide-only">الهاتف</th><th class="desktop-only">الطلبات</th><th class="desktop-only">آخر طلب</th><th class="n">الرصيد</th><th class="acts desktop-only"><span class="sr-only">إجراءات</span></th></tr></thead>
            <tbody>
              <tr v-if="!rows.length"><td colspan="7" class="cl-empty">لا عملاء يطابقون البحث أو التصفية.</td></tr>
              <tr v-for="c in rows" :key="c.name" :class="{sel: sel === c.name, off: c.disabled}" tabindex="0" @click="open(c.name)" @keydown.enter="open(c.name)">
                <td><span class="cl-name">{{ c.customer_name }}<Icon v-if="c.vip" name="star" :size="14" class="cl-star"/></span>
                  <span v-if="(c.tags || []).length" class="cl-tags"><span v-for="id in c.tags.filter(x => ctags[x])" :key="id"><i :style="{background: ctags[id].color}"></i>{{ ctags[id].name }}</span></span></td>
                <td class="desktop-only wide-only muted">{{ c.customer_type === 'Company' ? 'مؤسسة' : 'فرد' }}</td>
                <td class="desktop-only wide-only muted" dir="ltr" style="text-align:right">{{ c.mobile_no || '—' }}</td>
                <td class="desktop-only">{{ c.orders || '—' }}<span v-if="c.open_orders" class="muted"> · {{ c.open_orders }} جارية</span></td>
                <td class="desktop-only muted" :class="{warn: c.away}">{{ lastWord(c.last_order) }}</td>
                <td class="n"><span class="cl-bal" :class="bal(c.balance).cls"><i v-if="bal(c.balance).cls"></i>{{ c.balance === null ? '' : bal(c.balance).text }}</span>
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

    <aside v-if="sel" class="cl-panel" aria-label="ملف العميل">
      <div v-if="err" class="alert error" style="margin:16px">{{ err }}</div>
      <div v-else-if="!d" class="ws-loading">جارٍ التحميل…</div>
      <template v-else>
        <div class="cl-p-head">
          <div class="cl-p-title"><div style="min-width:0"><h2>{{ d.customer_name }}<button v-if="d.can_edit" type="button" class="cl-star-btn" :aria-pressed="!!d.vip" :title="d.vip ? 'إلغاء زبون مميز' : 'زبون مميز'" @click="saveExtra({vip: d.vip ? 0 : 1})"><Icon name="star" :size="16"/></button></h2>
              <span class="muted">{{ d.customer_type === 'Company' ? 'مؤسسة' : 'فرد' }}<template v-for="id in d.tags.filter(x => ctags[x])" :key="id"> · {{ ctags[id].name }}</template> · منذ {{ date(d.since) }}</span></div>
            <button type="button" class="cl-btn icon ghost" aria-label="إغلاق" @click="sel = null"><Icon name="x" :size="18"/></button></div>
          <div class="cl-p-acts">
            <a v-if="d.mobile_no" class="cl-btn" :href="'tel:' + d.mobile_no"><Icon name="phone" :size="15"/>اتصال</a>
            <a v-if="waLink(d.mobile_no)" class="cl-btn" target="_blank" rel="noopener" :href="waLink(d.mobile_no)"><Icon name="msg" :size="15"/>واتساب</a>
            <button v-if="d.can_edit" type="button" class="cl-btn" @click="state.sheet = {type: 'customer', name: d.name}"><Icon name="edit" :size="15"/>تعديل</button>
            <div class="cl-pop-host"><button type="button" class="cl-btn icon" aria-label="خيارات العميل" :aria-expanded="pmenu" @click.stop="pmenu = !pmenu"><Icon name="more" :size="18"/></button>
              <div v-if="pmenu" class="cl-pop cl-menu end" @click.stop>
                <button v-if="s.data.manager" type="button" @click="pmenu = false; merging = ''">دمج مع عميل آخر</button>
                <button v-if="d.can_edit" type="button" @click="toggleDisabled">{{ d.disabled ? 'إعادة تفعيل العميل' : 'إيقاف العميل' }}</button>
                <button type="button" @click="exportOrders">تصدير طلباته (Excel)</button></div></div>
          </div>
        </div>
        <div v-if="d.disabled" class="cl-note muted-note">هذا العميل موقوف: لا يظهر في القوائم ولا في اختيار العملاء.</div>
        <div v-if="merging !== null" class="cl-p-sec">
          <b>دمج «{{ d.customer_name }}» في عميل آخر</b>
          <span class="muted">تنتقل كل طلباته وفواتيره ودفعاته وملفاته إلى العميل المختار، ويُحذف هذا الاسم. لا يمكن التراجع.</span>
          <select class="input" v-model="merging" aria-label="العميل الذي يبقى"><option value="">اختر العميل الذي يبقى…</option>
            <option v-for="c in everyone.filter(x => x.name !== d.name && x.customer_type === d.customer_type)" :key="c.name" :value="c.name">{{ c.customer_name }}</option></select>
          <div class="row" style="gap:8px"><button type="button" class="cl-btn danger" :disabled="!merging" @click="doMerge">دمج</button><button type="button" class="cl-btn ghost" @click="merging = null">إلغاء</button></div>
        </div>
        <div v-if="d.balance !== undefined" class="cl-p-sec cl-balance">
          <div style="min-width:0"><span class="muted">{{ owesNow ? 'الرصيد المستحق' : d.balance < -0.005 ? 'رصيد لصالح العميل' : 'الحساب' }}</span>
            <b :class="owesNow ? 'bad' : d.balance < -0.005 ? 'ok' : ''">{{ owesNow ? money(d.balance) : d.balance < -0.005 ? money(-d.balance) : 'خالص' }}</b>
            <span class="muted"><template v-if="d.overdue_days">متأخر {{ d.overdue_days }} يومًا</template><template v-if="d.overdue_days && d.credit_limit"> · </template><template v-if="d.credit_limit">سقف الدين {{ fig(d.credit_limit) }}</template></span></div>
          <div class="cl-balance-acts"><button v-if="state.boot.can.payment" type="button" class="cl-btn primary" @click="pay">تسجيل دفعة</button>
            <button v-if="owesNow && waLink(d.mobile_no)" type="button" class="cl-link" @click="startRemind">تذكير بالدفع</button></div>
        </div>
        <div v-if="d.credit_limit && d.balance > d.credit_limit" class="cl-note danger-note">تجاوز سقف الدين: عليه {{ fig(d.balance) }} من {{ fig(d.credit_limit) }} دج</div>
        <div v-if="remind !== null" class="cl-p-sec"><label class="muted" for="remind-t">رسالة التذكير (عدّلها قبل الإرسال)</label><textarea id="remind-t" class="input" v-model="remind" rows="5"></textarea>
          <div class="row" style="gap:8px"><button type="button" class="cl-btn primary" @click="sendRemind">فتح في واتساب</button><button type="button" class="cl-btn ghost" @click="remind = null">إلغاء</button></div></div>
        <div class="cl-note" :class="{empty: !d.note && !editNote}">
          <Icon name="pin" :size="15"/>
          <template v-if="editNote"><div style="flex:1"><textarea class="input" v-model="note" rows="3" aria-label="الملاحظة الثابتة"></textarea>
            <div class="row" style="gap:8px;margin-top:6px"><button type="button" class="cl-btn primary sm" @click="saveExtra({note})">حفظ</button><button type="button" class="cl-btn ghost sm" @click="editNote = false">إلغاء</button></div></div></template>
          <template v-else><span style="flex:1">{{ d.note || 'ملاحظة ثابتة تظهر في كل بطاقة جديدة لهذا العميل' }}</span>
            <button v-if="d.can_edit" type="button" class="cl-link" @click="startNote">{{ d.note ? 'تعديل' : 'إضافة' }}</button></template>
        </div>

        <nav class="cl-tabs" role="tablist"><button v-for="x in TABS" :key="x[0]" type="button" role="tab" :aria-selected="tab === x[0]" @click="tab = x[0]">{{ x[1] }}<span v-if="x[0] === 'orders'" class="muted"> {{ d.orders.length }}</span><span v-if="x[0] === 'files'" class="muted"> {{ d.card_files.length }}</span></button></nav>
        <div class="cl-p-body">
          <template v-if="tab === 'orders'">
            <div v-if="!d.orders.length" class="muted">لا طلبات بعد.</div>
            <div v-for="o in d.orders.slice(0, 40)" :key="o.name" class="cl-line">
              <div style="flex:1;min-width:0"><a class="cl-line-t" :href="'/atelier/?card=' + o.name" @click.prevent="go('/?card=' + encodeURIComponent(o.name))">{{ o.atelier_subject || o.name }}</a>
                <span class="muted">{{ date(o.transaction_date) }} · {{ o.price_pending ? 'بلا سعر' : money(o.grand_total) }}</span></div>
              <span class="cl-state"><i :style="{background: STATE_DOT(o)}"></i>{{ o.archived ? 'مؤرشفة' : o.column }}</span>
              <button v-if="state.boot.can.order" type="button" class="cl-link" @click="reorder(o)">أعد الطلب</button>
            </div>
          </template>
          <template v-else-if="tab === 'files'">
            <label v-if="d.can_edit" class="cl-btn" style="align-self:flex-start">{{ uploading ? 'جارٍ الرفع…' : 'رفع ملف' }}<input type="file" multiple class="sr-only" @change="onFile"></label>
            <div v-if="d.folder" class="tm-folder"><Icon name="file" :size="15"/><span class="ellipsis" :title="d.folder">{{ d.folder.split('\\\\').pop() }}</span>
              <button type="button" class="cl-btn sm" @click="copyText(d.folder)">نسخ المسار</button></div>
            <div v-for="x in d.card_files" :key="x.name" class="cl-line"><Icon name="file" :size="18"/>
              <div style="flex:1;min-width:0"><a class="cl-line-t ellipsis" style="display:block" :href="x.file_url" target="_blank" rel="noopener">{{ x.file_name }}</a><span class="muted">{{ x.atelier_subject || 'ملف العميل' }} · {{ ago(x.creation) }}</span></div></div>
            <div v-if="!d.card_files.length" class="muted">كل ما يُرفق في بطاقات هذا العميل يظهر هنا.</div>
          </template>
          <template v-else-if="tab === 'log'">
            <form class="cl-logf" @submit.prevent="addLog">
              <div class="cl-seg wrap"><button v-for="k in LOG_KINDS" :key="k[0]" type="button" :aria-pressed="logKind === k[0]" @click="logKind = k[0]">{{ k[1] }}</button></div>
              <textarea class="input" v-model="logText" rows="2" placeholder="ماذا حدث؟ مثلًا: وعد بدفع 20,000 يوم الخميس" aria-label="سجّل تواصلًا"></textarea>
              <button type="submit" class="cl-btn primary sm" style="align-self:flex-start" :disabled="!logText.trim()">حفظ</button></form>
            <div v-if="!d.log.length" class="muted">لا تواصل مسجّل بعد.</div>
            <div v-for="l in d.log" :key="l.name" class="cl-line top"><div style="flex:1;min-width:0"><span class="muted">{{ l.by }} · {{ ago(l.creation) }}</span><div class="cl-logt" v-html="l.content"></div></div></div>
          </template>
          <template v-else-if="tab === 'stats'">
            <span class="muted">مشترياته آخر 6 أشهر</span>
            <div class="cl-chart"><div v-for="m in months6" :key="m.key" :title="m.label + ': ' + fig(m.total) + ' دج'"><span :style="{height: (m.total / maxMonth * 100) + '%'}"></span><small>{{ m.label }}</small></div></div>
            <span class="muted" style="margin-top:10px">أكثر ما يطلبه</span>
            <div v-for="x in d.top" :key="x.what" class="cl-kv"><span class="ellipsis">{{ x.what }}</span><b>{{ x.n }}</b></div>
            <div v-if="!d.top.length" class="muted">لا طلبات بعد.</div>
          </template>
          <template v-else-if="tab === 'account'">
            <div class="cl-kv"><span>مجموع المشتريات</span><b class="money">{{ money(d.invoiced) }}</b></div>
            <div class="cl-kv"><span>المدفوع</span><span class="money">{{ money(d.received) }}</span></div>
            <div class="cl-kv"><span>متوسط مدة الدفع</span><span>{{ d.avg_pay_days === null || d.avg_pay_days === undefined ? '—' : d.avg_pay_days + ' يومًا' }}</span></div>
            <div class="cl-kv"><span>آخر دفعة</span><span>{{ d.last_payment ? date(d.last_payment) : '—' }}</span></div>
            <b style="margin-top:14px">كشف الحساب</b>
            <div class="row" style="gap:8px"><label class="cl-fgroup" style="flex:1"><span>من</span><input type="date" class="input" v-model="stFrom"></label><label class="cl-fgroup" style="flex:1"><span>إلى</span><input type="date" class="input" v-model="stTo"></label></div>
            <div class="row" style="gap:8px"><a class="cl-btn" target="_blank" rel="noopener" :href="statementUrl"><Icon name="file" :size="15"/>تحميل PDF</a>
              <button v-if="waLink(d.mobile_no)" type="button" class="cl-btn" @click="sendStatement"><Icon name="msg" :size="15"/>إرسال بواتساب</button></div>
            <span v-if="waLink(d.mobile_no)" class="muted">واتساب لا يقبل الإرفاق من رابط: يُحمَّل الملف، ثم أرفقه في المحادثة التي تُفتح.</span>
          </template>
          <template v-else>
            <b>الأشخاص</b>
            <div v-for="p in d.contacts" :key="p.name + p.phone" class="cl-line"><div style="flex:1;min-width:0"><span class="cl-line-t">{{ p.name }}</span><span class="muted">{{ p.role || '—' }}<template v-if="p.phone"> · <span dir="ltr">{{ p.phone }}</span></template></span></div>
              <a v-if="waLink(p.phone)" class="cl-btn icon sm" target="_blank" rel="noopener" :href="waLink(p.phone)" :aria-label="'واتساب ' + p.name"><Icon name="msg" :size="14"/></a>
              <a v-if="p.phone" class="cl-btn icon sm" :href="'tel:' + p.phone" :aria-label="'اتصال ' + p.name"><Icon name="phone" :size="14"/></a></div>
            <div v-if="!d.contacts.length" class="muted">لا أشخاص مسجّلون.</div>
            <b style="margin-top:14px">بيانات الاتصال</b>
            <div class="cl-kv"><span>الهاتف</span><span dir="ltr">{{ d.mobile_no || '—' }}</span></div>
            <div class="cl-kv"><span>البريد</span><span dir="ltr">{{ d.email_id || '—' }}</span></div>
            <div class="cl-kv"><span>العنوان</span><span>{{ [d.address, d.city].filter(x => x && x !== '—').join('، ') || '—' }}</span></div>
            <template v-if="d.customer_type === 'Company'"><b style="margin-top:14px">البيانات القانونية</b>
              <div v-for="k in [['rc','السجل التجاري RC'],['nif','الرقم الجبائي NIF'],['nis','NIS'],['ai','المادة AI']]" :key="k[0]" class="cl-kv"><span>{{ k[1] }}</span><span dir="ltr">{{ d.legal[k[0]] || '—' }}</span></div>
              <span v-if="!d.legal.rc && !d.legal.nif && d.can_edit" class="muted">ناقصة — <a href="#" @click.prevent="state.sheet = {type: 'customer', name: d.name}">أضفها</a> لتظهر على فواتيره.</span></template>
          </template>
        </div>
        <div class="cl-p-foot"><button v-if="state.boot.can.order" type="button" class="cl-btn primary block" @click="newOrderFor(d)"><Icon name="plus" :size="16"/>طلب جديد لهذا العميل</button></div>
      </template>
    </aside>
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
    const kind = ref("all"), q = ref("");
    const moves = computed(() => (d.value?.moves || []).filter((m) => (kind.value === "all" || (kind.value === "in" ? m.amount > 0 : m.amount < 0))
      && (!q.value || [m.title, m.category, m.order_title, m.by].some((v) => String(v || "").includes(q.value.trim())))));
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
    return { change, s, load, d, offset, month, pct, kind, q, moves, maxWeek, maxCat, catTotal, owed, owe, CAT_COLORS, fund, pay, remind, tr, trBusy, openTransfer, doTransfer,
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
          <button v-if="state.boot.can.expense" type="button" class="cl-btn" @click="state.sheet = {type: 'expense'}"><Icon name="out" :size="16"/>مصروف</button>
          <button v-if="state.boot.can.payment" type="button" class="cl-btn primary" @click="pay()"><Icon name="in" :size="16"/>تسجيل دخل</button>
        </div>
      </header>
      <div v-if="s.loading && !s.data" class="ws-loading">جارٍ التحميل…</div>
      <div v-else-if="s.error" class="alert error" style="margin:20px 28px">{{ s.error }}</div>
      <template v-else-if="d">
        <div class="cl-stats mn-stats">
          <div><span>في الصندوق الآن</span><b class="money">{{ money(d.cash_balance) }}</b><small>نقدًا {{ fig(fund('Cash')) }} · البنك {{ fig(fund('Bank')) }}</small></div>
          <div><span>دخل {{ offset ? 'الشهر' : 'هذا الشهر' }}</span><b class="money ok">{{ money(d.income) }}</b><small>{{ change(d.income, d.prev_income) }}</small></div>
          <div><span>مصاريف {{ offset ? 'الشهر' : 'هذا الشهر' }}</span><b class="money bad">{{ money(d.expenses) }}</b><small>{{ change(d.expenses, d.prev_expenses) }}</small></div>
          <div><span>الربح</span><b class="money" :class="{bad: d.profit < 0}">{{ money(d.profit) }}</b><small>الدخل ناقص المصاريف</small></div>
        </div>
        <div class="mn-grid">
          <div class="mn-col">
            <section class="mn-card"><div class="mn-card-h"><b>الدخل والمصاريف</b>
                <span class="mn-legend"><span><i class="in"></i>دخل</span><span><i class="out"></i>مصاريف</span><span>آخر 8 أسابيع</span></span></div>
              <div class="mn-chart" role="img" aria-label="الدخل والمصاريف لآخر 8 أسابيع">
                <div v-for="w in d.weeks" :key="w.from" class="mn-wk" :title="date(w.from) + ' — ' + date(w.to) + ': دخل ' + fig(w.in) + ' · مصاريف ' + fig(w.out)">
                  <div class="mn-bars"><span class="in" :style="{height: (w.in / maxWeek * 100) + '%'}"></span><span class="out" :style="{height: (w.out / maxWeek * 100) + '%'}"></span></div>
                  <small>{{ date(w.to) }}</small></div></div></section>
            <section class="mn-card"><div class="mn-card-h"><b>الحركات</b>
                <span class="row" style="gap:8px;flex-wrap:wrap"><span class="cl-seg"><button v-for="k in [['all','الكل'],['in','دخل'],['out','مصاريف']]" :key="k[0]" type="button" :aria-pressed="kind === k[0]" @click="kind = k[0]">{{ k[1] }}</button></span>
                  <label class="cl-search mn-search"><Icon name="search" :size="14"/><span class="sr-only">بحث في الحركات</span><input type="search" v-model="q" placeholder="بحث"></label></span></div>
              <table class="cl-table mn-table">
                <thead><tr><th>التاريخ</th><th>البيان</th><th class="desktop-only">النوع</th><th class="n">المبلغ</th></tr></thead>
                <tbody>
                  <tr v-if="!moves.length"><td colspan="4" class="cl-empty">لا حركات.</td></tr>
                  <tr v-for="m in moves" :key="m.voucher_no" style="cursor:default">
                    <td class="muted">{{ date(m.posting_date) }}</td>
                    <td style="white-space:normal"><span class="cl-name">{{ m.title }}<Icon v-if="m.files" name="file" :size="13" class="mn-clip"/></span>
                      <span class="muted" style="display:block">{{ [m.fund, m.by].filter(Boolean).join(' · ') }}<template v-if="m.order"> · <a :href="'/atelier/?card=' + m.order" @click.prevent="go('/?card=' + encodeURIComponent(m.order))">{{ m.order_title || m.order }}</a></template></span></td>
                    <td class="desktop-only muted">{{ m.category }}</td>
                    <td class="n"><span class="cl-bal" :class="m.amount >= 0 ? 'ok' : 'bad'">{{ m.amount >= 0 ? '+' : '−' }} {{ fig(Math.abs(m.amount)) }}</span></td></tr>
                </tbody></table></section>
          </div>
          <div class="mn-col">
            <section class="mn-card"><div class="mn-card-h"><b>لنا عند العملاء</b><b class="bad">{{ money(owed) }}</b></div>
              <div v-if="!d.debtors.length" class="mn-empty">لا أحد عليه دين.</div>
              <div v-for="c in d.debtors" :key="c.customer" class="mn-line">
                <button type="button" class="mn-who" @click="pay(c)"><span class="cl-name">{{ c.customer_name }}</span><span class="muted" :class="{bad: c.late}">{{ c.late ? 'متأخر ' + c.late + ' يومًا' : 'لم يحن موعده' }}</span></button>
                <b class="bad">{{ fig(c.amount) }}</b>
                <button v-if="waLink(c.mobile_no)" type="button" class="cl-btn icon sm" :aria-label="'تذكير ' + c.customer_name + ' بواتساب'" @click="remind(c)"><Icon name="msg" :size="14"/></button></div>
              <div class="mn-foot muted">اضغط على الاسم لتسجيل دفعة.</div></section>
            <section class="mn-card"><div class="mn-card-h"><b>علينا للموردين</b><b class="warn">{{ money(owe) }}</b></div>
              <div v-if="!d.payables.length" class="mn-empty">لا ديون للموردين.</div>
              <div v-for="p in d.payables" :key="p.name" class="mn-line">
                <div class="mn-who" style="cursor:default"><span class="cl-name">{{ p.supplier_name }}</span>
                  <span class="muted" style="white-space:normal">{{ p.what }}<template v-if="p.due_date"> · <span :class="{bad: daysFromToday(p.due_date) < 0}">{{ daysFromToday(p.due_date) < 0 ? 'متأخر ' + -daysFromToday(p.due_date) + ' يومًا' : 'يستحق ' + dueWord(p.due_date) }}</span></template></span></div>
                <b>{{ fig(p.amount) }}</b>
                <button v-if="state.boot.can.payment" type="button" class="cl-btn sm" :disabled="paying === p.name" @click="paySupplier(p, supplierMode)">{{ paying === p.name ? '…' : 'دفعت' }}</button></div>
              <label v-if="d.payables.length && d.modes.length > 1" class="mn-foot row" style="gap:8px"><span class="muted">طريقة الدفع للمورد</span>
                <select class="input" style="width:auto;min-height:32px" v-model="supplierMode"><option v-for="m in d.modes" :key="m.value" :value="m.value">{{ m.label }}</option></select></label></section>
            <section class="mn-card"><div class="mn-card-h"><b>أين يذهب المال</b><span class="muted">{{ month }}</span></div>
              <div v-if="!d.categories.length" class="mn-empty">لا مصاريف مسجّلة هذا الشهر.</div>
              <div v-for="c in d.categories" :key="c.name" class="mn-cat">
                <div class="row" style="justify-content:space-between;gap:8px"><span class="ellipsis">{{ c.name }}</span><span><b>{{ fig(c.amount) }}</b> <span class="muted">{{ Math.round(c.amount / catTotal * 100) }}%</span></span></div>
                <div class="mn-catbar"><span :style="{width: (c.amount / maxCat * 100) + '%'}"></span></div></div>
              <div class="mn-foot muted">كل المصاريف المسجّلة، ومنها فواتير الموردين غير المدفوعة بعد.</div></section>
          </div>
        </div>
      </template>
    </div>
  </div>`,
};
// ------------------------------------------------------------------ suppliers, classic
const SuppliersPage = {
  props: ["openId"], components: { Icon },
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
    async function open(name, keep) { sel.value = name; err.value = null; if (!keep) { tab.value = "invoices"; d.value = null; form.value = null; }
      try { d.value = await call("supplier2", { name }); } catch (e) { err.value = e.message; } }
    if (sel.value) open(sel.value);
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
    const newSupplier = () => { sel.value = "__new"; d.value = { name: null, supplier_name: "", supplies: "", phone: "", email: "", address: "", tax_id: "", rc: "", note: "", invoices: [], orders: [], items: [], accounts: [], open_orders: [], can_edit: true }; form.value = { kind: "edit", ...d.value }; };
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
    const TABS = [["invoices", "الفواتير"], ["orders", "طلبات الشراء"], ["items", "المشتريات"], ["data", "البيانات"]];
    return { s, load, sel, d, err, tab, busy, q, filter, more, pmenu, FILTERS, rows, kpi, change, open, lastWord, exportList, form, mode, newSupplier, edit, saveSupplier,
      newPO, savePO, newInvoice, saveInvoice, payInvoice, oldest, toggleDisabled, invState, poState, TABS, waLink, money, fig, date, dueWord, state, go };
  },
  template: `
  <div class="cl" :class="{'with-panel': sel}">
    <div class="cl-main">
      <header class="cl-head"><div class="cl-head-row">
        <h1>الموردون</h1><span class="cl-count" v-if="s.data">{{ rows.length }} {{ rows.length === 1 ? 'مورد' : 'موردين' }}</span><span class="spacer"></span>
        <label class="cl-search"><Icon name="search" :size="16"/><span class="sr-only">بحث</span><input type="search" v-model="q" placeholder="ابحث بالاسم أو الهاتف"></label>
        <span class="cl-seg"><button v-for="f in FILTERS" :key="f[0]" type="button" :aria-pressed="filter === f[0]" @click="filter = f[0]">{{ f[1] }}</button></span>
        <div class="cl-pop-host"><button type="button" class="cl-btn icon" aria-label="المزيد" :aria-expanded="more" @click.stop="more = !more"><Icon name="more" :size="18"/></button>
          <div v-if="more" class="cl-pop cl-menu" @click.stop><button type="button" @click="exportList"><Icon name="file" :size="16"/>تصدير القائمة (Excel)</button></div></div>
        <button type="button" class="cl-btn primary" @click="newSupplier"><Icon name="plus" :size="16"/>مورد جديد</button></div></header>
      <div v-if="s.loading && !s.data" class="ws-loading">جارٍ التحميل…</div>
      <div v-else-if="s.error" class="alert error" style="margin:20px 28px">{{ s.error }}</div>
      <template v-else-if="s.data">
        <div class="cl-stats">
          <button type="button" @click="filter = 'all'"><span>الموردون</span><b>{{ kpi.total }}</b><small>{{ kpi.busy }} نشطون هذا الشهر</small></button>
          <button type="button" @click="filter = 'owe'"><span>علينا للموردين</span><b class="money" style="color:var(--c-warn)">{{ money(kpi.owe) }}</b><small>{{ kpi.invoices }} فواتير مفتوحة</small></button>
          <button type="button" @click="filter = 'late'"><span>متأخرة</span><b class="money bad">{{ money(kpi.late) }}</b><small>{{ kpi.lateN }} {{ kpi.lateN === 1 ? 'مورد' : 'موردين' }}</small></button>
          <button type="button" style="cursor:default"><span>مشتريات الشهر</span><b class="money">{{ money(kpi.month) }}</b><small>{{ change(kpi.month, s.data.prev_month) }}</small></button>
        </div>
        <div class="cl-table-wrap"><table class="cl-table">
          <thead><tr><th>المورد</th><th class="desktop-only wide-only">ما نشتريه</th><th class="desktop-only wide-only">الهاتف</th><th class="desktop-only">آخر شراء</th><th class="n">علينا</th></tr></thead>
          <tbody>
            <tr v-if="!rows.length"><td colspan="5" class="cl-empty">{{ (s.data.rows || []).length ? 'لا موردين يطابقون البحث أو التصفية.' : 'لا موردين بعد. أضف أول مورد.' }}</td></tr>
            <tr v-for="x in rows" :key="x.name" :class="{sel: sel === x.name, off: x.disabled}" tabindex="0" @click="open(x.name)" @keydown.enter="open(x.name)">
              <td><span class="cl-name">{{ x.supplier_name }}</span></td>
              <td class="desktop-only wide-only muted">{{ x.atelier_supplies || '—' }}</td>
              <td class="desktop-only wide-only muted" dir="ltr" style="text-align:right">{{ x.atelier_phone || '—' }}</td>
              <td class="desktop-only muted">{{ lastWord(x.last) }}</td>
              <td class="n"><span v-if="x.owe > 0.005" class="cl-bal" :class="x.late ? 'bad' : 'warn-b'"><i></i>{{ money(x.owe) }}</span><span v-else class="cl-bal">لا شيء</span>
                <span v-if="x.late" class="cl-late">متأخر {{ x.late }} {{ x.late === 1 ? 'يوم' : 'أيام' }}</span></td>
            </tr></tbody></table></div>
      </template>
    </div>

    <aside v-if="sel" class="cl-panel" aria-label="ملف المورد">
      <div v-if="!d" class="ws-loading">{{ err || 'جارٍ التحميل…' }}</div>
      <template v-else>
        <div class="cl-p-head">
          <div class="cl-p-title"><div style="min-width:0"><h2>{{ d.supplier_name || 'مورد جديد' }}</h2><span v-if="d.name" class="muted">{{ d.supplies || 'مورد' }} · منذ {{ date(d.since) }}</span></div>
            <button type="button" class="cl-btn icon ghost" aria-label="إغلاق" @click="sel = null; form = null"><Icon name="x" :size="18"/></button></div>
          <div v-if="d.name" class="cl-p-acts">
            <a v-if="d.phone" class="cl-btn" :href="'tel:' + d.phone"><Icon name="phone" :size="15"/>اتصال</a>
            <a v-if="waLink(d.phone)" class="cl-btn" target="_blank" rel="noopener" :href="waLink(d.phone)"><Icon name="msg" :size="15"/>واتساب</a>
            <button v-if="d.can_edit" type="button" class="cl-btn" @click="edit"><Icon name="edit" :size="15"/>تعديل</button>
            <div class="cl-pop-host"><button type="button" class="cl-btn icon" aria-label="خيارات المورد" :aria-expanded="pmenu" @click.stop="pmenu = !pmenu"><Icon name="more" :size="18"/></button>
              <div v-if="pmenu" class="cl-pop cl-menu end" @click.stop><button v-if="d.can_edit" type="button" @click="toggleDisabled">{{ d.disabled ? 'إعادة تفعيل المورد' : 'إيقاف المورد' }}</button></div></div>
          </div>
        </div>
        <div v-if="err" class="alert error" style="margin:12px 22px 0">{{ err }}</div>

        <form v-if="form && form.kind === 'edit'" class="cl-p-sec" @submit.prevent="saveSupplier">
          <b>{{ form.name ? 'تعديل المورد' : 'مورد جديد' }}</b>
          <label class="cl-fgroup"><span>الاسم *</span><input class="input" v-model="form.supplier_name" required></label>
          <label class="cl-fgroup"><span>ما نشتريه منه</span><input class="input" v-model="form.supplies" placeholder="ورق، حبر، طباعة أوفست، نقل…"></label>
          <div class="st2-row"><label class="cl-fgroup"><span>الهاتف</span><input class="input" v-model="form.phone" dir="ltr" inputmode="tel"></label><label class="cl-fgroup"><span>البريد</span><input class="input" v-model="form.email" dir="ltr" type="email"></label></div>
          <label class="cl-fgroup"><span>العنوان</span><input class="input" v-model="form.address"></label>
          <div class="st2-row"><label class="cl-fgroup"><span>الرقم الجبائي NIF</span><input class="input" v-model="form.tax_id" dir="ltr"></label><label class="cl-fgroup"><span>السجل التجاري RC</span><input class="input" v-model="form.rc" dir="ltr"></label></div>
          <label class="cl-fgroup"><span>ملاحظة</span><input class="input" v-model="form.note"></label>
          <div class="row" style="gap:8px"><button type="submit" class="cl-btn primary" :disabled="busy === 'save' || !form.supplier_name.trim()">حفظ المورد</button><button type="button" class="cl-btn" @click="form = null; if (!d.name) sel = null">إلغاء</button></div>
        </form>

        <template v-if="d.name">
          <div class="cl-p-sec cl-balance">
            <div><span class="muted">علينا له</span><b :class="{bad: oldest && oldest.late}" :style="!(oldest && oldest.late) && d.owe > 0.005 ? 'color:var(--c-warn)' : ''">{{ d.owe > 0.005 ? money(d.owe) : 'لا شيء' }}</b>
              <span class="muted" v-if="oldest">{{ d.invoices.filter(i => i.outstanding_amount > 0.005).length }} فواتير · الأقرب {{ oldest.late ? 'متأخرة ' + oldest.late + ' يومًا' : 'تستحق ' + dueWord(oldest.due_date) }}</span></div>
            <div class="cl-balance-acts"><button v-if="oldest && state.boot.can.payment" type="button" class="cl-btn primary" :disabled="busy === 'pay'" @click="payInvoice(oldest)">تسجيل دفع</button>
              <label v-if="oldest && state.boot.modes.length > 1" class="muted row" style="gap:6px">من <select class="input" style="width:auto;min-height:30px" v-model="mode"><option v-for="m in state.boot.modes" :key="m.value" :value="m.value">{{ m.label }}</option></select></label></div>
          </div>

          <form v-if="form && form.kind === 'po'" class="cl-p-sec" @submit.prevent="savePO">
            <b>طلب شراء جديد</b>
            <label class="cl-fgroup"><span>ما نطلبه *</span><input class="input" v-model="form.description" placeholder="مثلًا: طباعة أوفست 5000 مطوية"></label>
            <div class="st2-row"><label class="cl-fgroup"><span>المبلغ *</span><div class="unit-wrap"><input class="input num" v-model="form.amount" inputmode="decimal"><span class="u">دج</span></div></label>
              <label class="cl-fgroup"><span>موعد الاستلام</span><input class="input" type="date" v-model="form.schedule_date"></label></div>
            <label class="cl-fgroup"><span>لأي طلب (تُحسب في ربحه)</span><select class="input" v-model="form.order"><option value="">بدون طلب</option><option v-for="o in d.open_orders" :key="o.name" :value="o.name">{{ (o.atelier_subject || o.name) + ' — ' + o.customer_name }}</option></select></label>
            <div class="row" style="gap:8px"><button type="submit" class="cl-btn primary" :disabled="busy === 'po' || !form.description.trim() || !(+form.amount > 0)">إرسال الطلب</button><button type="button" class="cl-btn" @click="form = null">إلغاء</button></div>
          </form>
          <form v-if="form && form.kind === 'inv'" class="cl-p-sec" @submit.prevent="saveInvoice">
            <b>فاتورة مورد{{ form.purchase_order ? ' — من ' + form.purchase_order : '' }}</b>
            <template v-if="!form.purchase_order">
              <label class="cl-fgroup"><span>البيان *</span><input class="input" v-model="form.description"></label>
              <div class="st2-row"><label class="cl-fgroup"><span>المبلغ *</span><div class="unit-wrap"><input class="input num" v-model="form.amount" inputmode="decimal"><span class="u">دج</span></div></label>
                <label class="cl-fgroup"><span>النوع</span><select class="input" v-model="form.account"><option v-for="a in d.accounts" :key="a.name" :value="a.name">{{ a.account_name }}</option></select></label></div>
              <label class="cl-fgroup"><span>لأي طلب (اختياري)</span><select class="input" v-model="form.order"><option value="">بدون طلب</option><option v-for="o in d.open_orders" :key="o.name" :value="o.name">{{ (o.atelier_subject || o.name) + ' — ' + o.customer_name }}</option></select></label>
            </template>
            <span v-else class="muted">{{ form.description }} · {{ money(form.amount) }}</span>
            <div class="st2-row"><label class="cl-fgroup"><span>رقم فاتورة المورد</span><input class="input" v-model="form.bill_no" dir="ltr"></label><label class="cl-fgroup"><span>تاريخ الاستحقاق</span><input class="input" type="date" v-model="form.due_date"></label></div>
            <div class="row" style="gap:8px"><button type="submit" class="cl-btn primary" :disabled="busy === 'inv' || (!form.purchase_order && (!form.description.trim() || !(+form.amount > 0)))">تسجيل الفاتورة</button><button type="button" class="cl-btn" @click="form = null">إلغاء</button></div>
          </form>

          <nav class="cl-tabs" role="tablist"><button v-for="x in TABS" :key="x[0]" type="button" role="tab" :aria-selected="tab === x[0]" @click="tab = x[0]">{{ x[1] }}<span v-if="x[0] === 'invoices'" class="muted"> {{ d.invoices.length }}</span><span v-if="x[0] === 'orders'" class="muted"> {{ d.orders.length }}</span></button></nav>
          <div class="cl-p-body">
            <template v-if="tab === 'invoices'">
              <div v-if="!d.invoices.length" class="muted">لا فواتير بعد.</div>
              <div v-for="i in d.invoices" :key="i.name" class="cl-line">
                <div style="flex:1;min-width:0"><span class="cl-line-t">{{ i.bill_no ? 'فاتورة ' + i.bill_no : i.name }}</span><span class="muted">{{ i.what || '—' }} · {{ i.outstanding_amount > 0.005 ? 'تستحق ' + date(i.due_date) : date(i.posting_date) }}</span></div>
                <div class="rp-val"><b>{{ fig(i.grand_total) }}</b><span class="cl-state"><i :style="{background: invState(i)[1]}"></i>{{ invState(i)[0] }}</span></div>
                <button v-if="i.outstanding_amount > 0.005 && state.boot.can.payment" type="button" class="cl-btn sm" :disabled="busy === 'pay'" @click="payInvoice(i)">دفعت</button></div>
            </template>
            <template v-else-if="tab === 'orders'">
              <div v-if="!d.orders.length" class="muted">لا طلبات شراء بعد.</div>
              <div v-for="o in d.orders" :key="o.name" class="cl-line">
                <div style="flex:1;min-width:0"><span class="cl-line-t">{{ o.what || o.name }}</span><span class="muted">{{ o.name }} · {{ date(o.transaction_date) }}</span></div>
                <div class="rp-val"><b>{{ fig(o.grand_total) }}</b><span class="cl-state"><i :style="{background: poState(o)[1]}"></i>{{ poState(o)[0] }}</span></div>
                <button v-if="o.per_billed < 100" type="button" class="cl-btn sm" @click="newInvoice(o)">فاتورته</button></div>
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
          <div class="cl-p-foot row" style="gap:8px">
            <button v-if="state.boot.can.expense" type="button" class="cl-btn primary" style="flex:1" @click="newPO"><Icon name="plus" :size="16"/>طلب شراء جديد</button>
            <button type="button" class="cl-btn" @click="newInvoice(null)"><Icon name="file" :size="16"/>فاتورة مورد</button></div>
        </template>
      </template>
    </aside>
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
    const save = async () => {
      saving.value = true; err.value = null;
      try {
        const out = await call("save_team", { members: JSON.stringify(rows.value.filter((r) => r.name.trim())) }, true);
        state.boot.team_members = out; state.boot.team = out.map((m) => m.name);
        rows.value = out.map((m) => ({ ...m })); toast("حُفظ الفريق");
      } catch (e) { err.value = e.message; } finally { saving.value = false; }
    };
    return { rows, saving, err, save, t };
  },
  template: `
  <div :class="embedded ? '' : 'page'">
    <div v-if="!embedded" class="page-head"><div><h1>الفريق</h1><div class="sub">من يعمل في الورشة. تختار منهم أعضاء كل بطاقة.</div></div></div>
    <div class="card team-card">
      <div v-for="(r, i) in rows" :key="i" class="team-row">
        <input class="input" v-model="r.name" :aria-label="'الاسم ' + (i+1)" placeholder="الاسم">
        <input class="input" v-model="r.role" list="role-list" :aria-label="'الدور ' + (i+1)" placeholder="الدور (مصمم، طابع…)">
        <input class="input" v-model="r.user" dir="ltr" type="email" :aria-label="'حساب الدخول ' + (i+1)" placeholder="بريد حساب الدخول">
        <button type="button" class="btn sm ghost icon-btn danger" :aria-label="'حذف ' + (r.name || 'السطر')" @click="rows.splice(i, 1)"><Icon name="trash" :size="16"/></button>
      </div>
      <RoleOptions/>
      <div v-if="err" class="alert error" role="alert">{{ err }}</div>
      <div class="row" style="gap:8px"><button type="button" class="btn chip dashed" @click="rows.push({name:'', role:'', user:''})">+ إضافة شخص</button><span class="spacer"></span>
        <button type="button" class="btn primary" :disabled="saving" @click="save">{{ saving ? t('of_saving') : 'حفظ' }}</button></div>
    </div>
  </div>`,
};

const BoardSettings = {
  props: ["embedded"], components: { Icon, TeamPage },
  setup() {
    const { s, load } = useLoad(() => call("board2"));
    onMounted(load);
    const tab = ref("columns"), cols = ref([]), labels = ref([]), moves = reactive({}), removed = ref([]), saving = ref(false), err = ref(null);
    watch(() => s.data, (v) => { if (v) { cols.value = v.config.columns.map((c) => ({ ...c })); labels.value = v.config.labels.map((l) => ({ ...l })); removed.value = []; } });
    const count = (id) => (s.data?.cards || []).filter((c) => c.column === id).length;
    const lcount = (id) => (s.data?.cards || []).filter((c) => c.labels.includes(id)).length;
    const up = (l, i, dir) => { const j = i + dir; if (j < 0 || j >= l.length) return; [l[i], l[j]] = [l[j], l[i]]; };
    const delCol = (i) => { const c = cols.value[i]; if (c.id && count(c.id)) { removed.value.push(c); moves[c.id] = cols.value.find((x) => x.id !== c.id && !x.deliver)?.id; } cols.value.splice(i, 1); };
    const setDeliver = (c) => cols.value.forEach((x) => (x.deliver = x === c ? (x.deliver ? 0 : 1) : 0));
    const save = async () => {
      saving.value = true; err.value = null;
      try {
        await call("save_board", { config: JSON.stringify({ columns: cols.value, labels: labels.value }), moves: JSON.stringify(moves) }, true);
        toast("حُفظ التخصيص"); await load(); state.rev++;
      } catch (e) { err.value = e.message; } finally { saving.value = false; }
    };
    return { s, tab, cols, labels, moves, removed, saving, err, count, lcount, up, delCol, setDeliver, save, BOARD_COLORS, labelStyle, go };
  },
  template: `
  <div class="page">
    <div v-if="!embedded" class="bd-head"><div><h1>تخصيص اللوحة</h1><div class="sub">للمدير فقط. التغييرات تظهر للفريق مباشرة.</div></div>
      <button type="button" class="btn" @click="go('/')">← العودة إلى الطلبات</button></div>
    <div class="cv-tabs" role="tablist" style="margin:12px 0 18px">
      <button v-for="tb in [['columns','الأعمدة'],['labels','الحالات'],['team','الفريق']]" :key="tb[0]" type="button" role="tab" class="bs-tab" :aria-selected="tab===tb[0]" @click="tab=tb[0]">{{ tb[1] }}</button></div>
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
    <div v-else-if="tab === 'labels'" class="bs-list">
      <div v-for="(l, i) in labels" :key="l.id || i" class="bs-row">
        <span class="tl bs-prev" :style="labelStyle(l)">{{ l.name || 'حالة' }}</span>
        <input class="input" v-model="l.name" :aria-label="'اسم الحالة ' + (i + 1)" placeholder="اسم الحالة">
        <span class="bs-colors" role="group" :aria-label="'لون ' + l.name"><button v-for="col in BOARD_COLORS" :key="col" type="button" class="bs-sw" :style="{background: col}" :aria-pressed="l.color === col" :aria-label="col" @click="l.color = col"></button></span>
        <span class="m">{{ l.id ? lcount(l.id) + ' بطاقة' : 'جديدة' }}</span>
        <button type="button" class="btn ghost icon-btn sm danger" :aria-label="'حذف ' + l.name" @click="labels.splice(i, 1)"><Icon name="trash" :size="16"/></button>
      </div>
      <button type="button" class="bs-addrow" @click="labels.push({name: '', color: BOARD_COLORS[labels.length % BOARD_COLORS.length]})">+ إضافة حالة</button>
    </div>
    <TeamPage v-else-if="tab === 'team'" embedded/>
    <template v-if="tab !== 'team' && s.data">
      <div v-if="err" class="alert error" role="alert" style="margin-top:12px">{{ err }}</div>
      <div class="row" style="justify-content:flex-end;margin-top:16px"><button type="button" class="btn primary" :disabled="saving" @click="save">{{ saving ? 'جارٍ الحفظ…' : 'حفظ' }}</button></div>
    </template>
  </div>`,
};

// ------------------------------------------------------------------ settings (/atelier/settings), manager only
const SETTINGS_GROUPS = [
  ["المطبعة", [["profile", "printer", "بيانات المطبعة"], ["docs", "invoice", "الوثائق والضريبة"]]],
  ["العمل", [["team", "users", "الفريق والحسابات"], ["board", "grid", "لوحة الطلبات"], ["prices", "tag", "الخدمات والأسعار"], ["lists", "grid", "القوائم"]]],
  ["المال والنظام", [["funds", "wallet", "الدفع والصناديق"], ["alerts", "bell", "التنبيهات"], ["mail", "invoice", "البريد"], ["folders", "file", "المجلدات"], ["backup", "box", "النسخ الاحتياطي"]]],
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
  { key: "units", title: "وحدات البيع", hint: "تظهر عند إضافة خدمة أو منتج. الخدمات الموجودة تبقى على وحدتها.", cols: [["name", "الوحدة"], ["group", "المجموعة"], ["whole", "عدد صحيح", "check"]], blank: { name: "", group: "أخرى", whole: 0 } },
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
        rows.value = out.map((r) => ({ ...r })); toast("حُفظت القائمة");
      } catch (e) { toast(e.message, "error"); } finally { busy.value = false; }
    };
    return { rows, busy, add, shift, save };
  },
  template: `
  <div class="st2-grp"><div class="st2-lbl"><b>{{ def.title }}</b><span>{{ def.hint }}</span></div>
    <div class="st2-fields"><div v-for="(r, i) in rows" :key="i" class="st2-line">
        <template v-for="c in def.cols" :key="c[0]">
          <label v-if="c[2] === 'check'" class="row" style="gap:4px;white-space:nowrap"><input type="checkbox" :checked="!!r[c[0]]" @change="r[c[0]] = $event.target.checked ? 1 : 0">{{ c[1] }}</label>
          <input v-else class="input" :type="c[2] === 'number' ? 'number' : 'text'" :min="c[2] === 'number' ? 0 : null" v-model="r[c[0]]" :aria-label="c[1]" :placeholder="c[1]"></template>
        <button type="button" class="cl-btn sm" :disabled="i === 0" :aria-label="'رفع ' + (i + 1)" @click="shift(i, -1)">↑</button>
        <button type="button" class="cl-btn sm" :aria-label="'حذف ' + (i + 1)" @click="rows.splice(i, 1)">×</button></div>
      <div class="row" style="gap:8px"><button type="button" class="cl-btn sm" @click="add">+ إضافة</button><button type="button" class="cl-btn primary sm" :disabled="busy" @click="save">حفظ</button></div></div></div>`,
};

const SettingsPage = {
  props: ["start"], components: { Icon, Avatar, BoardSettings, PricesPage, TeamPage, ListEditor, OpeningGroup },
  setup(props) {
    const { s, load } = useLoad(() => call("settings"));
    onMounted(load);
    const tab = ref(props.start || state.query.get("tab") || "profile");
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
    const nu = reactive({ email: "", full_name: "", role: "staff" }), link = ref(null);
    const saveUser = (u) => run("user", async () => {
      const r = await call("save_user", u ? { email: u.name, full_name: u.full_name, role: u.role, enabled: u.enabled } : { ...nu }, true);
      if (!u) { link.value = { email: nu.email, url: r.link }; nu.email = ""; nu.full_name = ""; }
      await load();
    }, u ? "حُفظ الحساب" : "أُنشئ الحساب");
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
      team: ["الفريق والحسابات", "من يدخل إلى البرنامج وبأي صلاحية"], board: ["لوحة الطلبات", "الأعمدة والحالات التي يراها الفريق"], prices: ["الخدمات والأسعار", "سعر الأفراد وسعر المؤسسات لكل خدمة"],
      lists: ["القوائم", "وحدات البيع والأوسام ومواعيد التسليم وأنواع التكلفة والأدوار"], funds: ["الدفع والصناديق", "أسماء الصناديق وطرق الدفع"], alerts: ["التنبيهات", "ما يصل إلى جرس كل عضو", saveAlerts],
      mail: ["البريد", "لإرسال رابط كلمة السر ورسائل الحسابات الجديدة", saveMail], folders: ["المجلدات", "مجلد لكل عميل ولكل بطاقة على هذا الحاسوب", saveFolders], backup: ["النسخ الاحتياطي", "نسخة كاملة من البيانات والملفات"] };
    const meta = computed(() => { const m = META[tab.value] || META.profile; return { title: m[0], desc: m[1], save: m[2] }; });
    return { fold, foldDone, saveFolders, syncFolders, foldSample, mail, mailTo, MAIL_PRESETS, testMail, preview, meta, SETTINGS_GROUPS, s, load, tab, p, docs, alerts, busy, err, saveProfile, logoInput, onLogo, saveDocs, saveAlerts, nu, link, saveUser, resetLink, copy,
      LIST_DEFS, renameFund, setMode, newFund, newMode, addFund, removeFund, addMode, removeMode, backup, size, sample, SETTINGS_TABS, fig, ago, state, go };
  },
  template: `
  <div class="cl st2">
    <nav class="st2-nav" aria-label="أقسام الإعدادات">
      <template v-for="g in SETTINGS_GROUPS" :key="g[0]">
        <span class="st2-group">{{ g[0] }}</span>
        <button v-for="x in g[1]" :key="x[0]" type="button" :aria-current="tab === x[0] ? 'page' : null" @click="tab = x[0]"><Icon :name="x[1]" :size="17"/>{{ x[2] }}</button>
      </template>
    </nav>
    <div class="cl-main">
      <header class="cl-head st2-head">
        <div class="cl-head-row"><div style="min-width:0"><h1>{{ meta.title }}</h1><div class="muted">{{ meta.desc }}</div></div><span class="spacer"></span>
          <button v-if="tab === 'profile' || tab === 'docs'" type="button" class="cl-btn" @click="preview = true"><Icon name="file" :size="16"/>معاينة الفاتورة</button>
          <button v-if="tab === 'prices' && state.boot.can.prices" type="button" class="cl-btn primary" @click="state.sheet = {type: 'item'}"><Icon name="plus" :size="16"/>خدمة جديدة</button>
          <button v-if="meta.save" type="button" class="cl-btn primary" :disabled="!!busy" @click="meta.save()">{{ busy ? 'جارٍ الحفظ…' : 'حفظ التغييرات' }}</button></div>
      </header>
      <div v-if="s.loading && !s.data" class="ws-loading">جارٍ التحميل…</div>
      <div v-else-if="s.error" class="alert error" style="margin:20px 32px">{{ s.error }}</div>
      <div v-else class="st2-body">
        <div v-if="err" class="alert error" role="alert">{{ err }}</div>

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
            <div class="st2-grp"><div class="st2-lbl"><b>حسابات الدخول</b><span>«موظف» يعمل على الطلبات والعملاء. «مدير» يرى المال والإعدادات. لا تُكتب كلمة السر هنا: يُعطى الموظف رابطًا ليختارها.</span></div>
              <div class="st2-fields">
                <table class="cl-table st2-table"><thead><tr><th>الاسم</th><th>الصلاحية</th><th>الحالة</th><th></th></tr></thead><tbody>
                  <tr v-for="u in s.data.users" :key="u.name" style="cursor:default"><td><span class="cl-name">{{ u.full_name }}</span><span class="muted" style="display:block" dir="ltr">{{ u.name }}</span>
                      <span class="muted" style="display:block">{{ u.member ? 'في الفريق باسم «' + u.member + '»' : 'غير مربوط باسم في الفريق' }}<template v-if="u.last_login"> · آخر دخول {{ ago(u.last_login) }}</template></span></td>
                    <td><select class="input" style="width:auto;min-height:34px" v-model="u.role" :aria-label="'صلاحية ' + u.full_name"><option value="staff">موظف</option><option value="manager">مدير</option></select></td>
                    <td><label class="st2-check"><input type="checkbox" :checked="!!u.enabled" @change="u.enabled = $event.target.checked ? 1 : 0"><span>مفعّل</span></label></td>
                    <td class="n"><button type="button" class="cl-btn sm" :disabled="!!busy" @click="saveUser(u)">حفظ</button> <button type="button" class="cl-btn sm ghost" :disabled="!!busy" @click="resetLink(u)">رابط كلمة السر</button></td></tr>
                  <tr v-if="!s.data.users.length"><td colspan="4" class="cl-empty">لا حسابات بعد.</td></tr></tbody></table>
                <form class="st2-row st2-newu" @submit.prevent="saveUser()"><label class="cl-fgroup"><span>الاسم</span><input class="input" v-model="nu.full_name"></label>
                  <label class="cl-fgroup grow2"><span>البريد</span><input class="input" v-model="nu.email" type="email" dir="ltr"></label>
                  <label class="cl-fgroup" style="flex:0 0 130px"><span>الصلاحية</span><select class="input" v-model="nu.role"><option value="staff">موظف</option><option value="manager">مدير</option></select></label>
                  <button type="submit" class="cl-btn primary" style="align-self:flex-end" :disabled="!nu.email || !!busy"><Icon name="plus" :size="15"/>إنشاء حساب</button></form>
                <div v-if="link" class="st2-link"><b>رابط اختيار كلمة السر لـ {{ link.email }}</b><span class="muted">أرسله للموظف ليختار كلمة سره بنفسه.</span>
                  <div class="row" style="gap:6px"><input class="input" :value="link.url" readonly dir="ltr" aria-label="الرابط" @focus="$event.target.select()"><button type="button" class="cl-btn" @click="copy(link.url)">نسخ</button></div></div>
              </div></div>
            <div class="st2-grp"><div class="st2-lbl"><b>أسماء الفريق</b><span>الأسماء التي تُسند إليها البطاقات. اربط كل اسم ببريد حسابه ليعمل «مهامي» والتنبيهات.</span></div>
              <div class="st2-fields"><TeamPage :embedded="true"/></div></div>
          </div>
        </template>

        <div v-else-if="tab === 'board'" class="st2-card st2-embed"><BoardSettings :embedded="true"/></div>
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
        ["عدد الطلبات", n.orders], [], ["الطلب", "العميل", "المبيعات", "التكلفة", "الربح", "الهامش %"], ...d.value.profit.map((r) => [r.title, r.customer, r.revenue, r.cost, r.result, r.margin])];
      const text = "﻿" + rows.map((r) => r.map((v) => '"' + String(v ?? "").replace(/"/g, '""') + '"').join(",")).join("\n");
      const el = document.createElement("a"); el.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" })); el.download = `تقرير ${title.value}.csv`; el.click();
    };
    const printIt = () => window.print();
    const marginTone = (m) => (m === null ? "" : m < 15 ? "bad" : m < 35 ? "warn" : "ok");
    return { s, load, d, period, from, to, custom, setPeriod, applyCustom, PERIODS, title, cmp, pct, maxM, mlabel, ageTotal, AGES, maxTop, exportCsv, printIt, marginTone, money, fig, date, go };
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
            <section class="mn-card"><div class="mn-card-h"><b>المبيعات والمصاريف</b><span class="mn-legend"><span><i class="rp-s"></i>المبيعات</span><span><i class="rp-e"></i>المصاريف</span><span>آخر 12 شهرًا</span></span></div>
              <div class="mn-chart rp-chart" role="img" aria-label="المبيعات والمصاريف لآخر 12 شهرًا">
                <div v-for="m in d.months" :key="m.month" class="mn-wk" :title="mlabel(m.month) + ': مبيعات ' + fig(m.sales) + ' · مصاريف ' + fig(m.expenses)">
                  <div class="mn-bars"><span class="rp-s" :style="{height: (m.sales / maxM * 100) + '%'}"></span><span class="rp-e" :style="{height: (m.expenses / maxM * 100) + '%'}"></span></div><small>{{ mlabel(m.month) }}</small></div></div></section>
            <section class="mn-card"><div class="mn-card-h"><b>ربحية الطلبات</b><span class="muted">الأقل ربحًا أولًا</span></div>
              <table class="cl-table mn-table"><thead><tr><th>الطلب</th><th class="n">المبيعات</th><th class="n desktop-only">التكلفة</th><th class="n">الربح</th><th class="n">الهامش</th></tr></thead><tbody>
                <tr v-if="!d.profit.length"><td colspan="5" class="cl-empty">لا طلبات مفوترة في هذه الفترة.</td></tr>
                <tr v-for="r in d.profit" :key="r.name" @click="go('/?card=' + encodeURIComponent(r.name))"><td style="white-space:normal"><span class="cl-name">{{ r.title }}</span><span class="muted" style="display:block">{{ r.customer }}</span></td>
                  <td class="n">{{ fig(r.revenue) }}</td><td class="n desktop-only muted">{{ fig(r.cost) }}</td><td class="n"><span class="cl-bal" :class="r.result < 0 ? 'bad' : ''">{{ fig(r.result) }}</span></td>
                  <td class="n"><span class="rp-m" :class="marginTone(r.margin)">{{ r.margin === null ? '—' : r.margin + '%' }}</span></td></tr></tbody></table></section>
            <section class="mn-card"><div class="mn-card-h"><b>أعمار الديون</b><b class="bad">{{ money(ageTotal) }}</b></div>
              <div class="rp-ages"><div v-for="x in AGES" :key="x[0]"><span class="muted">{{ x[1] }}</span><b :style="{color: x[2]}">{{ fig(d.ageing[x[0]]) }}</b><i :style="{background: x[2], width: Math.max(2, pct(d.ageing[x[0]], ageTotal)) + '%'}"></i></div></div></section>
          </div>
          <div class="mn-col">
            <section class="mn-card"><div class="mn-card-h"><b>أفضل العملاء</b><span class="muted">بالمبيعات</span></div>
              <div v-if="!d.top_customers.length" class="mn-empty">لا مبيعات في هذه الفترة.</div>
              <div v-for="(c, i) in d.top_customers" :key="c.name" class="rp-rank"><span class="muted">{{ i + 1 }}</span><div style="flex:1;min-width:0"><span class="cl-name ellipsis" style="display:block">{{ c.name }}</span><div class="mn-catbar"><span :style="{width: (c.total / maxTop(d.top_customers) * 100) + '%'}"></span></div></div>
                <div class="rp-val"><b>{{ fig(c.total) }}</b><span class="muted">{{ c.n }} {{ c.n === 1 ? 'فاتورة' : 'فواتير' }}</span></div></div></section>
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
  { key: "customers", path: "/customers", icon: "users", label: "nav_customers", match: ["customer", "customers"] },
  { key: "suppliers", path: "/suppliers", icon: "factory", label: "nav_suppliers", match: ["suppliers", "supplier"], need: "finance" },
  { key: "money", path: "/money", icon: "wallet", label: "nav_money_simple", match: ["money"], need: "finance" },
];
const SECTION_NAV = [
  { key: "stock", path: "/stock", icon: "box", label: "nav_stock", match: ["stock"], need: "stock" },
  { key: "machines", path: "/machines", icon: "gear", label: "nav_machines", match: ["machines"] },
  { key: "prices", path: "/prices", icon: "tag", label: "nav_prices", match: ["prices"], need: "prices" },
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
const StockPage = {
  components: { Icon, RecipesCard },
  setup() {
    const { s, load } = useLoad(() => call("stock"));
    onMounted(load);
    const busy = ref(false), err = ref(null), q = ref(""), sheet = ref(null), orders = ref([]);
    const items = computed(() => (s.data?.items || []).filter((i) => i.item_name.toLowerCase().includes(q.value.trim().toLowerCase())));
    const low = computed(() => (s.data?.items || []).filter((i) => i.low));
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
    return { s, load, busy, err, q, sheet, orders, items, low, units, suppliers, open, TITLES, submit, remove, MOVE, money, date, uom };
  },
  template: `
  <div class="page tb cb">
    <div class="row" style="gap:10px;padding:20px 28px 12px;flex-wrap:wrap"><h1 style="margin:0;font-size:24px">المخزون</h1><span style="flex:1"></span>
      <input class="input" style="max-width:260px" v-model="q" aria-label="بحث في المواد" placeholder="ابحث عن مادة"><button type="button" class="cl-btn primary" @click="open('add')"><Icon name="plus" :size="16"/>مادة جديدة</button></div>
    <div v-if="s.error" class="alert error" style="margin:0 28px 12px">{{ s.error }}</div>
    <div v-if="low.length" class="alert error" style="margin:0 28px 12px">مواد تحت الحد الأدنى: {{ low.map((i) => i.item_name).join('، ') }}</div>
    <div v-if="s.data" class="stock-body">
      <section class="mn-card"><table class="cl-table mn-table"><thead><tr><th>المادة</th><th class="n">الكمية</th><th class="n">الحد الأدنى</th><th v-if="s.data.can_value" class="n">القيمة</th><th>إجراء</th></tr></thead>
        <tbody><tr v-for="i in items" :key="i.item_code"><td><b>{{ i.item_name }}</b></td><td class="n" :class="{'bd-late': i.low}">{{ i.qty }} {{ uom(i.uom) }}</td><td class="n">{{ i.safety_stock || '—' }}</td><td v-if="s.data.can_value" class="n money">{{ money(i.value) }}</td>
          <td><div class="row" style="gap:4px;flex-wrap:wrap"><button v-if="s.data.can_buy" type="button" class="cl-btn sm" @click="open('buy', i)">شراء</button><button v-if="s.data.can_issue" type="button" class="cl-btn sm" :disabled="i.qty <= 0" @click="open('issue', i)">صرف</button><button type="button" class="cl-btn sm" @click="open('count', i)">جرد</button><button type="button" class="cl-btn sm" @click="open('edit', i)">تعديل</button><button type="button" class="cl-btn sm" @click="remove(i)">حذف</button></div></td></tr>
          <tr v-if="!items.length"><td colspan="5" class="muted" style="text-align:center;padding:24px">لا مواد بعد. أضف مادة ثم سجّل رصيدها بالجرد أو الشراء.</td></tr></tbody></table></section>
      <RecipesCard/>
      <section v-if="s.data.moves.length" class="mn-card"><div class="mn-card-h"><b>آخر الحركات</b></div><table class="cl-table mn-table"><tbody><tr v-for="m in s.data.moves" :key="m.voucher_no + m.item_code"><td>{{ m.item_name }}</td><td>{{ MOVE[m.voucher_type] || m.voucher_type }}</td><td class="n" dir="ltr">{{ m.actual_qty }}</td><td class="n">{{ date(m.posting_date) }}</td></tr></tbody></table></section>
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
  components: { StockPage, MaterialsSheet, Icon, SearchBox, PaymentSheet, ExpenseSheet, ItemSheet, PricesPage, TeamPage, Board, SimpleCustomers, SimpleMoney, BoardSettings, CustomerSheet2, SettingsPage, ReportsPage2, SuppliersPage },
  setup() {
    const bootErr = ref(null);
    const loadBoot = async () => {
      bootErr.value = null;
      try { state.boot = await call("boot"); } catch (e) { bootErr.value = e.message; }
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
      money: "nav_money", suppliers: "nav_suppliers", supplier: "nav_suppliers", stock: "nav_stock", machines: "nav_machines", reports: "nav_reports", more: "nav_more", prices: "nav_prices", team: "nav_team", "board-settings": "nav_board_settings", settings: "nav_settings" };
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
      <header class="topbar" :class="{'own-header': ['customers', 'customer', 'suppliers', 'supplier', 'settings', 'money', 'home', 'orders', 'order-new', 'order', 'reports'].includes(route.name), 'no-bar': ['home', 'orders', 'order-new', 'order'].includes(route.name)}">
        <button type="button" v-if="route.name!=='home'" class="btn ghost icon-btn mobile-only" :aria-label="t('back')" @click="back"><Icon name="back"/></button>
        <span v-if="route.name!=='home'" class="title mobile-only ellipsis">{{ t(titles[route.name] || 'app_name') }}</span>
        <nav class="crumbs desktop-only" aria-label="المسار"><span class="crumb-root">{{ t('crumb_root') }}</span><Icon name="chev" :size="14"/><span>{{ route.name==='home' ? t('crumb_today') : t(titles[route.name] || 'app_name') }}</span></nav>
        <div class="spacer desktop-only"></div>
        <SearchBox :class="{'desktop-only': route.name!=='home'}"/>
        <button type="button" class="btn ghost icon-btn desktop-only" :aria-label="t('notifications')"><Icon name="bell" :size="20"/></button>
      </header>
      <main id="main" tabindex="-1" style="outline:none">
        <Board v-if="['home', 'orders', 'order-new'].includes(route.name)" :key="route.name === 'order-new' ? state.path : 'board'" :start-new="route.name === 'order-new'"/>
        <Board v-else-if="route.name==='order'" :key="'order-' + route.id" :open-card="route.id"/>
        <SimpleCustomers v-else-if="route.name==='customers' || route.name==='customer'" :key="state.path + state.query" :open-id="route.id"/>
        <SimpleMoney v-else-if="route.name==='money'"/>
        <SuppliersPage v-else-if="route.name==='suppliers' || route.name==='supplier'" :key="state.path" :open-id="route.id"/>
        <StockPage v-else-if="route.name==='stock'"/>
        <ReportsPage2 v-else-if="route.name==='reports'"/>
        <SettingsPage v-else-if="route.name==='prices'" key="prices" start="prices"/>
        <SettingsPage v-else-if="route.name==='team'" key="team" start="team"/>
        <BoardSettings v-else-if="route.name==='board-settings'"/>
        <SettingsPage v-else-if="route.name==='settings'" :key="state.query.get('tab') || ''"/>
      </main>
    </div>

    <nav class="bottom-nav" :aria-label="t('app_name')">
      <a href="/atelier" :class="{active: ['home','orders','order'].includes(route.name)}" @click.prevent="go('/')"><Icon name="orders"/>{{ t('nav_orders') }}</a>
      <a class="fab" href="/atelier/orders/new" @click.prevent="go('/orders/new')"><span class="fab-circle"><Icon name="plus" :size="22"/></span><span class="lbl">{{ t('new_order') }}</span></a>
      <a href="/atelier/customers" :class="{active: ['customer','customers'].includes(route.name)}" @click.prevent="go('/customers')"><Icon name="users"/>{{ t('nav_customers') }}</a>
      <a v-if="state.boot.can.finance" href="/atelier/money" :class="{active: route.name==='money'}" @click.prevent="go('/money')"><Icon name="wallet"/>{{ t('nav_money_simple') }}</a>
    </nav>

    <PaymentSheet v-if="state.sheet && state.sheet.type==='payment'" :opts="state.sheet"/>
    <ExpenseSheet v-if="state.sheet && state.sheet.type==='expense'" :opts="state.sheet"/>
    <CustomerSheet2 v-if="state.sheet && state.sheet.type==='customer'" :opts="state.sheet"/>
    <ItemSheet v-if="state.sheet && state.sheet.type==='item'" :opts="state.sheet"/>
    <MaterialsSheet v-if="state.sheet && state.sheet.type==='materials'" :opts="state.sheet"/>
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
