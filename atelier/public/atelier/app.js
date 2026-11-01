// Atelier daily app — Vue 3 (vendored, no build step) on top of the ERPNext API (atelier.api).
import { createApp, reactive, ref, computed, watch, onMounted, onBeforeUnmount, h } from "./vendor/vue.esm-browser.prod.js";
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
    location.href = `/login?redirect-to=${encodeURIComponent(location.pathname)}`;
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
  if ((m = p.match(/^\/customers\/(.+)$/))) return { name: "customer", id: decodeURIComponent(m[1]) };
  if (["/money", "/stock", "/machines", "/reports", "/more", "/prices", "/ds"].includes(p)) return { name: p.slice(1) };
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
  edit: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z",
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
const OrdersTable = {
  props: { rows: Array, hideCustomer: Boolean, limit: Number, title: String, moreLink: Boolean },
  components: { Icon, Badge },
  setup(props) {
    const q = ref(""), filter = ref("all"), sortKey = ref("due"), sortDir = ref(1);
    const counts = computed(() => Object.fromEntries(FILTERS.map(([k, , fn]) => [k, (props.rows || []).filter(fn).length])));
    const sorters = {
      due: (o) => due(o).rank, total: (o) => (o.price_pending ? -1 : o.grand_total), customer: (o) => o.customer_name || "",
      order: (o) => o.atelier_subject || o.name, paid: (o) => o.paid,
    };
    const shown = computed(() => {
      const fn = FILTERS.find((f) => f[0] === filter.value)[2];
      const needle = q.value.trim().toLowerCase();
      let r = (props.rows || []).filter(fn).filter((o) => !needle ||
        [o.atelier_subject, o.name, o.customer_name, o.atelier_stage].some((v) => String(v || "").toLowerCase().includes(needle)));
      const key = sorters[sortKey.value];
      r = [...r].sort((a, b) => { const x = key(a), y = key(b); return (typeof x === "string" ? x.localeCompare(y, "ar") : x - y) * sortDir.value; });
      return props.limit ? r.slice(0, props.limit) : r;
    });
    const sortBy = (k) => { if (sortKey.value === k) sortDir.value *= -1; else { sortKey.value = k; sortDir.value = 1; } };
    const ariaSort = (k) => (sortKey.value === k ? (sortDir.value > 0 ? "ascending" : "descending") : "none");
    const open = (o) => go("/orders/" + encodeURIComponent(o.name));
    return { q, filter, FILTERS, counts, shown, sortBy, sortKey, sortDir, ariaSort, open, t, money, due, billing, payment, go };
  },
  template: `
  <section class="card">
    <div class="card-h"><h2>{{ title || t('orders_open') }}</h2>
      <a v-if="moreLink" class="btn sm ghost" href="/atelier/orders" @click.prevent="go('/orders')">{{ t('all_orders') }}</a></div>
    <div class="table-toolbar">
      <div class="search"><label class="sr-only" :for="'oq-'+(title||'')">{{ t('orders_search') }}</label>
        <Icon name="search" class="s-icon" :size="16"/><input :id="'oq-'+(title||'')" class="input" type="search" v-model="q" :placeholder="t('orders_search')" style="min-height:34px"></div>
      <div class="chips" role="group">
        <button v-for="f in FILTERS" :key="f[0]" v-show="f[0]==='all' || counts[f[0]]" class="chip" :aria-pressed="filter===f[0]" @click="filter=f[0]">
          {{ t(f[1]) }} <span class="count num">{{ counts[f[0]] }}</span></button>
      </div>
    </div>
    <div v-if="!shown.length" class="empty">{{ (rows||[]).length ? t('orders_none_filter') : t('orders_none') }}</div>
    <div v-else class="desktop-only table-wrap">
      <table class="t">
        <thead><tr>
          <th class="sortable" :aria-sort="ariaSort('order')"><button @click="sortBy('order')">{{ t('col_order') }}<Icon name="sort" :size="12"/></button></th>
          <th v-if="!hideCustomer" class="sortable" :aria-sort="ariaSort('customer')"><button @click="sortBy('customer')">{{ t('col_customer') }}<Icon name="sort" :size="12"/></button></th>
          <th>{{ t('col_stage') }}</th>
          <th class="sortable" :aria-sort="ariaSort('due')"><button @click="sortBy('due')">{{ t('col_due') }}<Icon name="sort" :size="12"/></button></th>
          <th>{{ t('col_billing') }}</th><th>{{ t('col_payment') }}</th>
          <th class="n sortable" :aria-sort="ariaSort('total')"><button @click="sortBy('total')">{{ t('col_total') }}<Icon name="sort" :size="12"/></button></th>
          <th class="n sortable" :aria-sort="ariaSort('paid')"><button @click="sortBy('paid')">{{ t('col_paid') }}<Icon name="sort" :size="12"/></button></th>
        </tr></thead>
        <tbody>
          <tr v-for="o in shown" :key="o.name" class="clickable" @click="open(o)">
            <td style="max-width:360px"><div class="title-cell"><a :href="'/atelier/orders/'+o.name" @click.prevent.stop="open(o)" class="medium clamp2">{{ o.atelier_subject || o.name }}</a>
              <span class="cap num">{{ o.name }}</span></div></td>
            <td v-if="!hideCustomer" style="max-width:220px"><span class="clamp2">{{ o.customer_name }}</span></td>
            <td><span>{{ o.atelier_stage }}</span>
              <div v-if="o.price_pending"><span class="badge b-warning"><Icon name="tag" :size="13"/>{{ t('price_pending') }}</span></div></td>
            <td><span :class="due(o).cls">{{ due(o).text }}</span></td>
            <td><Badge :b="billing(o)"/></td>
            <td><Badge :b="payment(o)"/></td>
            <td class="n"><span class="money">{{ money(o.grand_total) }}</span><div v-if="o.price_pending" class="cap">{{ t('amount_incomplete') }}</div></td>
            <td class="n"><span class="money">{{ money(o.paid) }}</span></td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="shown.length" class="mobile-only list">
      <a v-for="o in shown" :key="o.name" class="list-item" :href="'/atelier/orders/'+o.name" @click.prevent="open(o)">
        <span class="main-col">
          <span class="row" style="justify-content:space-between;gap:8px;align-items:flex-start"><span class="medium clamp2">{{ o.atelier_subject || o.name }}</span>
            <span :class="due(o).cls" style="flex-shrink:0">{{ due(o).text }}</span></span>
          <span class="meta ellipsis">{{ hideCustomer ? o.name : o.customer_name }} · {{ o.atelier_stage }}</span>
          <span class="row wrap" style="gap:4px;margin-top:4px">
            <span v-if="o.price_pending" class="badge b-warning"><Icon name="tag" :size="13"/>{{ t('price_pending') }}</span>
            <Badge :b="billing(o)"/><Badge :b="payment(o)"/>
            <span class="spacer"></span><span class="money meta">{{ money(o.grand_total) }}</span></span>
        </span>
      </a>
    </div>
  </section>`,
};

// ------------------------------------------------------------------ home
const Home = {
  components: { Icon, Badge, LoadState, OrdersTable },
  setup() {
    const { s, load } = useLoad(() => call("home"));
    onMounted(load);
    const showAll = ref(false), openKpi = ref(null);
    const actions = computed(() => s.data?.actions || []);
    const visible = computed(() => (showAll.value ? actions.value : actions.value.slice(0, 6)));
    const m = computed(() => s.data?.money);
    const kpis = computed(() => {
      if (!m.value) return [];
      const p = m.value.period;
      return [
        { key: "receivable", label: t("k_receivable"), value: m.value.receivable, hint: t("k_receivable_hint"), tone: m.value.receivable_overdue > 0 ? "danger" : "",
          rows: [[t("d_total"), m.value.receivable], [t("d_overdue"), m.value.receivable_overdue]],
          link: "/app/query-report/Accounts Receivable" },
        { key: "cash", label: t("k_cash"), value: m.value.cash_balance, hint: t("k_cash_hint"),
          rows: [[t("d_in"), m.value.cash_in], [t("d_out"), m.value.cash_out]], note: t("d_cash_note"), link: "/app/query-report/General Ledger" },
        { key: "payable", label: t("k_payable"), value: m.value.payable, hint: t("k_payable_hint"),
          rows: [[t("d_total"), m.value.payable], [t("d_due_now"), m.value.payable_due]], link: "/app/query-report/Accounts Payable" },
        { key: "advances", label: t("k_advances"), value: m.value.advances_held, hint: t("k_advances_hint"), rows: [], note: t("d_advances_note") },
        { key: "result", label: t("k_result"), value: m.value.result, hint: t("k_result_hint"),
          rows: [[t("d_sales"), m.value.sales], [t("d_result"), m.value.result]], note: t("d_result_note") + " " + t("d_period", date(p.from), date(p.to)),
          link: "/app/query-report/Profit and Loss Statement" },
      ];
    });
    const detail = computed(() => kpis.value.find((k) => k.key === openKpi.value));
    const toggle = (k) => (openKpi.value = openKpi.value === k ? null : k);
    const today = dfw.format(new Date());
    return { s, load, showAll, actions, visible, kpis, detail, openKpi, toggle, KIND, t, money, go, today, state };
  },
  template: `
  <div class="page">
    <div class="page-head"><div><h1>{{ t('nav_home') }}</h1><div class="sub">{{ today }}</div></div></div>
    <div class="quick mobile-only">
      <a class="btn primary" href="/atelier/orders/new" @click.prevent="go('/orders/new')"><Icon name="plus"/>{{ t('new_order') }}</a>
      <button v-if="state.boot.can.payment" class="btn" @click="state.sheet={type:'payment'}"><Icon name="in" style="color:var(--success)"/>{{ t('record_payment') }}</button>
      <button v-if="state.boot.can.expense" type="button" class="btn" @click="state.sheet={type:'expense'}"><Icon name="out" style="color:var(--danger)"/>{{ t('record_expense') }}</button>
    </div>

    <LoadState :s="s" :rows="2" @retry="load">
      <div v-if="!s.data.money" class="alert info">{{ t('money_hidden') }}</div>
      <template v-else>
        <div class="kpis" role="group" :aria-label="t('nav_money')">
          <button v-for="k in kpis" :key="k.key" class="kpi" :class="k.tone ? 'tone-'+k.tone : ''" :aria-expanded="openKpi===k.key" aria-controls="kpi-detail" @click="toggle(k.key)">
            <span class="k-label">{{ k.label }}<Icon :name="openKpi===k.key ? 'up' : 'down'" :size="14" class="muted"/></span>
            <span class="k-value money">{{ money(k.value) }}</span><span class="k-hint">{{ k.hint }}</span>
          </button>
        </div>
        <section v-if="detail" id="kpi-detail" class="card kpi-detail">
          <div class="card-h"><h2>{{ detail.label }}</h2><button class="btn sm ghost" @click="openKpi=null">{{ t('k_close') }}</button></div>
          <div class="card-b stack">
            <dl v-if="detail.rows.length" class="kv"><template v-for="r in detail.rows" :key="r[0]"><dt>{{ r[0] }}</dt><dd class="money medium">{{ money(r[1]) }}</dd></template></dl>
            <div v-if="detail.note" class="hint">{{ detail.note }}</div>
            <a v-if="detail.link" class="btn sm" :href="detail.link" style="align-self:flex-start"><Icon name="ext" :size="16"/>{{ t('k_open_report') }}</a>
          </div>
        </section>
      </template>
    </LoadState>

    <div class="home-grid">
      <section class="card side" style="order:0" aria-labelledby="todo-h">
        <div class="card-h"><h2 id="todo-h">{{ t('todo_title') }}</h2>
          <span v-if="actions.length" class="badge b-danger num">{{ actions.length }}</span></div>
        <LoadState :s="s" :rows="4" @retry="load">
          <div v-if="!actions.length" class="empty"><Icon name="check" :size="26" style="color:var(--success)"/>
            <span class="medium" style="color:var(--ink)">{{ t('todo_none') }}</span><span class="meta">{{ t('todo_none_hint') }}</span></div>
          <div v-else class="list">
            <button v-for="(a,i) in visible" :key="i" class="list-item" @click="go(a.route)">
              <span class="dot" :style="{background: KIND[a.kind].dot}"></span>
              <span class="main-col"><span class="medium clamp2">{{ a.title }}</span><span class="meta ellipsis">{{ a.detail }}</span></span>
              <span class="end-col">
                <span class="badge" :class="KIND[a.kind].badge"><Icon :name="KIND[a.kind].icon" :size="13"/>{{ t('kind_'+a.kind) }}</span>
                <span v-if="a.doc && a.doc.amount" class="money meta">{{ money(a.doc.amount) }}</span>
              </span>
            </button>
          </div>
          <div v-if="actions.length>6" class="card-f"><button class="btn sm ghost" @click="showAll=!showAll">{{ showAll ? t('todo_less') : t('todo_more', actions.length) }}</button></div>
        </LoadState>
      </section>
      <div class="mainc">
        <LoadState :s="s" @retry="load"><OrdersTable :rows="s.data.orders" :limit="12" more-link/></LoadState>
      </div>
    </div>
  </div>`,
};

const OrdersPage = {
  components: { LoadState, OrdersTable },
  setup() {
    const closed = ref(false);
    const { s, load } = useLoad(() => call("orders", { include_closed: closed.value ? 1 : 0 }));
    watch(closed, load); onMounted(load);
    return { s, load, closed, t, go };
  },
  template: `
  <div class="page">
    <div class="page-head"><h1>{{ t('orders_title') }}</h1>
      <div class="row"><label class="check"><input type="checkbox" v-model="closed">{{ t('show_closed') }}</label>
        <a class="btn primary" href="/atelier/orders/new" @click.prevent="go('/orders/new')">{{ t('new_order') }}</a></div></div>
    <LoadState :s="s" :rows="6" @retry="load"><OrdersTable :rows="s.data" :title="t('orders_title')"/></LoadState>
  </div>`,
};

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

const OrderNew = {
  components: { Icon, CustomerPicker },
  setup() {
    const saved = store.get(DRAFT_KEY);
    if (saved) for (const i of saved.items || []) i.key = ++lineSeq;
    const f = reactive(saved || blankForm());
    const restored = ref(!!saved && !!(saved.subject || saved.customer || saved.items?.some((i) => i.item_code)));
    const preset = state.query.get("customer");
    if (preset && !f.customer) call("customer_profile", { name: preset }).then((c) => { f.mode = "pick"; f.customer = c; }).catch(() => {});
    watch(f, (v) => store.set(DRAFT_KEY, v), { deep: true });  // input survives navigation and reloads

    const boot = computed(() => state.boot || { items: [], modes: [], can: {} });
    const itemsByCode = computed(() => Object.fromEntries(boot.value.items.map((i) => [i.item_code, i])));
    // Prices come from the customer's type (individual / company price list). A line whose price was typed by hand
    // keeps it; a missing price for that type leaves the line "priced later", never the other type's price.
    if (!f.newCustomer.type) f.newCustomer.type = "Individual";
    const custType = computed(() => (f.mode === "pick" ? f.customer?.customer_type : f.newCustomer.type) === "Company" ? "Company" : "Individual");
    const applyPrice = (row) => {
      const it = itemsByCode.value[row.item_code];
      if (!it || row.touched) return;
      const p = custType.value === "Company" ? it.price_company : it.price_individual;
      if (p !== null && p !== undefined) Object.assign(row, { rate: p, noPrice: false, autoPending: false });
      else Object.assign(row, { rate: "", noPrice: true, autoPending: true });
    };
    const onItem = (row) => { row.touched = false; applyPrice(row); };
    watch(custType, () => f.items.forEach(applyPrice));
    const attempted = ref(false), saving = ref(false), serverError = ref(null), serverErrors = ref({}), done = ref(null);
    watch(done, (d) => (state.editing = !d), { immediate: true });
    onBeforeUnmount(() => (state.editing = false));

    const priced = (i) => !i.noPrice && i.rate !== "" && i.rate !== null;
    const lineAmount = (i) => (priced(i) ? (+i.qty || 0) * (+i.rate || 0) : null);
    const costAmount = (c) => (c.rate === "" || c.rate === null ? null : (+c.qty || 0) * (+c.rate || 0) * (c.cost_type === "Matière" ? 1 + (+f.waste || 0) / 100 : 1));
    const sum = computed(() => {
      let total = 0, pending = 0, lines = 0, cost = 0, missing = 0;
      for (const i of f.items) if (i.item_code) { lines++; if (priced(i)) total += lineAmount(i); else pending++; }
      for (const c of f.costs) { const a = costAmount(c); if (a === null) missing++; else cost += a; }
      const adv = +f.advance.amount || 0;
      let marginWhy = null;
      if (pending) marginWhy = t("why_margin_price");
      else if (missing) marginWhy = t("why_margin_cost");
      else if (!f.costs.length) marginWhy = t("why_margin_none");
      return { total, pending, lines, cost, missing, adv, margin: marginWhy ? null : total - cost, marginWhy, remaining: pending ? null : total - adv };
    });

    const errors = computed(() => {
      const e = { ...serverErrors.value };
      if (f.mode === "pick" && !f.customer) e.customer = t("err_customer");
      if (f.mode === "new" && !f.newCustomer.name.trim()) e.customer = t("err_customer");
      if (!f.subject.trim()) e.subject = t("err_subject");
      if (!f.delivery_date) e.delivery_date = t("err_due");
      else if (f.delivery_date < todayISO()) e.delivery_date = t("err_due_past");
      if (!f.items.some((i) => i.item_code)) e.items = t("err_items");
      f.items.forEach((i, idx) => {
        if (!i.item_code && f.items.length > 1) e[`items.${idx}.item`] = t("err_item");
        if (i.item_code && !(+i.qty > 0)) e[`items.${idx}.qty`] = t("err_qty");
        if (i.item_code && !i.noPrice && (i.rate === "" || i.rate === null)) e[`items.${idx}.rate`] = t("err_rate");
      });
      if (sum.value.adv > 0 && !f.advance.mode) e.advance_mode = t("err_mode");
      return e;
    });
    const err = (k) => (attempted.value ? errors.value[k] : null);
    const errorCount = computed(() => Object.keys(errors.value).length);

    const discard = () => { Object.assign(f, blankForm()); store.del(DRAFT_KEY); restored.value = false; attempted.value = false; serverError.value = null; };
    const addItem = () => { f.items.push(blankItem()); setTimeout(() => document.getElementById(`it-${f.items.length - 1}`)?.focus(), 0); };
    const addCost = () => { f.costs.push({ cost_type: "Matière", description: "", item: "", qty: 1, rate: "" }); setTimeout(() => document.getElementById(`cd-${f.costs.length - 1}`)?.focus(), 0); };
    const togglePrice = (it) => { it.touched = true; it.autoPending = false; if (it.noPrice) it.rate = ""; };

    async function submit() {
      attempted.value = true; serverError.value = null; serverErrors.value = {};
      if (errorCount.value) {
        serverError.value = t("err_fix_n", errorCount.value);
        setTimeout(() => document.querySelector(".invalid, [aria-invalid='true']")?.focus(), 0);
        return;
      }
      saving.value = true;
      const data = {
        customer: f.mode === "pick" ? f.customer.name : null,
        new_customer: f.mode === "new" ? f.newCustomer : null,
        subject: f.subject, delivery_date: f.delivery_date, waste_percent: f.waste,
        items: f.items.filter((i) => i.item_code).map((i) => ({ item_code: i.item_code, description: i.description || null, qty: +i.qty, rate: priced(i) ? +i.rate : null })),
        costs: f.costs.map((c) => ({ cost_type: c.cost_type, description: c.description, item: c.item || null, qty: +c.qty || 1, rate: c.rate === "" ? null : +c.rate })),
        advance: sum.value.adv > 0 ? { amount: sum.value.adv, mode_of_payment: f.advance.mode } : null,
      };
      try {
        done.value = await call("create_order", { data: JSON.stringify(data) }, true);
        store.del(DRAFT_KEY);
        toast(t("ok_title"));
        window.scrollTo(0, 0);
      } catch (e) {
        serverError.value = e.message;
        if (e.errors) serverErrors.value = e.errors;
      }
      saving.value = false;
    }
    const again = () => { discard(); done.value = null; };
    return { itemsByCode, uom, f, boot, onItem, custType, sum, err, errorCount, attempted, saving, serverError, done, restored, discard, addItem, addCost, togglePrice, submit, again,
      lineAmount, costAmount, COST_TYPES, t, money, go, todayISO, state, dfw, parseDate };
  },
  template: `
  <div class="page">
    <div v-if="done" class="card" style="max-width:640px;margin:24px auto"><div class="card-b stack" style="padding:24px;align-items:flex-start">
      <span class="badge b-success"><Icon name="check" :size="14"/>{{ t('ok_title') }}</span>
      <h1 class="wrap-any">{{ f.subject || done.sales_order }}</h1>
      <div class="meta num">{{ done.sales_order }}</div>
      <div v-if="!done.submitted" class="alert warn"><Icon name="tag" :size="16"/><span>{{ t('ok_draft_note') }}</span></div>
      <div class="row wrap">
        <a class="btn primary" :href="'/atelier/orders/'+done.sales_order" @click.prevent="go('/orders/'+done.sales_order)">{{ t('ok_open_order') }}</a>
        <a class="btn" :href="'/atelier/customers/'+done.customer" @click.prevent="go('/customers/'+encodeURIComponent(done.customer))">{{ t('ok_open_customer') }}</a>
        <a v-if="done.payment" class="btn" target="_blank" rel="noopener" :href="'/api/method/frappe.utils.print_format.download_pdf?doctype=Payment%20Entry&name='+encodeURIComponent(done.payment)">{{ t('ok_receipt') }}</a>
        <button class="btn ghost" @click="again">{{ t('ok_another') }}</button>
      </div>
    </div></div>

    <form v-else novalidate @submit.prevent="submit">
      <div class="page-head"><h1>{{ t('of_title') }}</h1></div>
      <div class="split">
        <div class="stack">
          <div v-if="restored" class="alert info" role="status"><span style="flex:1">{{ t('of_draft_restored') }}</span>
            <button type="button" class="btn sm" @click="discard">{{ t('of_discard') }}</button></div>
          <div v-if="serverError" class="alert error" role="alert"><Icon name="alert" :size="16"/><span>{{ serverError }}</span></div>

          <section class="card">
            <div class="card-h"><h2>{{ t('of_customer') }} <span class="req"></span></h2>
              <div class="seg" role="group" :aria-label="t('of_customer')">
                <button type="button" :aria-pressed="f.mode==='pick'" @click="f.mode='pick'">{{ t('of_existing_customer') }}</button>
                <button type="button" :aria-pressed="f.mode==='new'" @click="f.mode='new'">{{ t('of_new_customer') }}</button></div></div>
            <div class="card-b">
              <div v-if="f.mode==='pick'" class="field">
                <label for="f-customer" class="sr-only">{{ t('of_customer') }}</label>
                <CustomerPicker v-model="f.customer" input-id="f-customer" :invalid="!!err('customer')"/>
                <span v-if="err('customer')" class="error-text"><Icon name="alert" :size="14"/>{{ err('customer') }}</span>
              </div>
              <div v-else class="cols-2">
                <div class="field"><label for="f-nc-name" class="req">{{ t('of_new_name') }}</label>
                  <input id="f-nc-name" class="input" :class="{invalid: err('customer')}" v-model="f.newCustomer.name" autocomplete="off" enterkeyhint="next">
                  <span v-if="err('customer')" class="error-text"><Icon name="alert" :size="14"/>{{ err('customer') }}</span></div>
                <div class="field" style="grid-column:1/-1"><span class="label">{{ t('cs_type') }}</span>
                  <div class="seg" role="group" :aria-label="t('cs_type')">
                    <button type="button" :aria-pressed="f.newCustomer.type!=='Company'" @click="f.newCustomer.type='Individual'">{{ t('c_type_person') }}</button>
                    <button type="button" :aria-pressed="f.newCustomer.type==='Company'" @click="f.newCustomer.type='Company'">{{ t('c_type_company_short') }}</button></div></div>
                <div class="field"><label for="f-nc-phone">{{ t('of_new_phone') }} <span class="cap">({{ t('optional') }})</span></label>
                  <input id="f-nc-phone" class="input num" type="tel" inputmode="tel" v-model="f.newCustomer.phone" autocomplete="off" enterkeyhint="next"></div>
              </div>
            </div>
          </section>

          <section class="card">
            <div class="card-h"><h2>{{ t('of_details') }}</h2></div>
            <div class="card-b cols-2" style="grid-template-columns:minmax(0,2fr) minmax(180px,1fr)">
              <div class="field"><label for="f-subject" class="req">{{ t('of_subject') }}</label>
                <input id="f-subject" class="input" :class="{invalid: err('subject')}" v-model="f.subject" :placeholder="t('of_subject_ph')" enterkeyhint="next">
                <span v-if="err('subject')" class="error-text"><Icon name="alert" :size="14"/>{{ err('subject') }}</span></div>
              <div class="field"><label for="f-due" class="req">{{ t('of_due') }}</label>
                <input id="f-due" lang="fr" class="input num" :class="{invalid: err('delivery_date')}" type="date" :min="todayISO()" v-model="f.delivery_date">
                <span v-if="err('delivery_date')" class="error-text"><Icon name="alert" :size="14"/>{{ err('delivery_date') }}</span>
                <span v-else-if="f.delivery_date" class="hint">{{ dfw.format(parseDate(f.delivery_date)) }}</span></div>
            </div>
          </section>

          <section class="card">
            <div class="card-h"><h2>{{ t('of_items') }}</h2><span class="meta">{{ sum.lines === 1 ? t('sum_line') : t('sum_lines', sum.lines) }}</span></div>
            <div class="card-b">
              <span v-if="err('items')" class="error-text" style="margin-bottom:6px"><Icon name="alert" :size="14"/>{{ err('items') }}</span>
              <div class="lines-head items-grid" aria-hidden="true"><span>{{ t('of_item') }}</span><span>{{ t('of_qty') }}</span><span>{{ t('of_rate') }} ({{ t('currency') }})</span><span style="text-align:end">{{ t('of_amount') }}</span><span></span></div>
              <div v-for="(it, idx) in f.items" :key="it.key" class="line items-grid" :class="{open: it.open}" role="group" :aria-label="t('of_line_n', idx+1)">
                <div class="field c-item"><label :for="'it-'+idx" class="mlabel req">{{ t('of_item') }}</label>
                  <select :id="'it-'+idx" class="input" :class="{invalid: err('items.'+idx+'.item')}" v-model="it.item_code" @change="onItem(it)" :aria-label="t('of_item')">
                    <option value="">{{ t('of_item_ph') }}</option>
                    <option v-for="i in boot.items" :key="i.item_code" :value="i.item_code">{{ i.item_name }}</option>
                  </select>
                  <span v-if="err('items.'+idx+'.item')" class="error-text">{{ err('items.'+idx+'.item') }}</span></div>
                <div class="field"><label :for="'q-'+idx" class="mlabel req">{{ t('of_qty') }}</label>
                  <div class="unit-wrap"><input :id="'q-'+idx" class="input num" :class="{invalid: err('items.'+idx+'.qty')}" type="text" inputmode="decimal" autocomplete="off" v-model="it.qty" :aria-label="t('of_qty')" enterkeyhint="next">
                    <span v-if="itemsByCode[it.item_code]" class="u">{{ uom(itemsByCode[it.item_code].stock_uom) }}</span></div>
                  <span v-if="err('items.'+idx+'.qty')" class="error-text">{{ err('items.'+idx+'.qty') }}</span></div>
                <div class="field"><label :for="'r-'+idx" class="mlabel" :class="{req: !it.noPrice}">{{ t('of_rate') }}</label>
                  <input :id="'r-'+idx" class="input num" :class="{invalid: err('items.'+idx+'.rate')}" type="text" inputmode="decimal" autocomplete="off"
                    v-model="it.rate" @input="it.touched=true" :disabled="it.noPrice" :placeholder="it.noPrice ? '—' : '0.00'" :aria-label="t('of_rate')" enterkeyhint="next">
                  <span v-if="err('items.'+idx+'.rate')" class="error-text">{{ err('items.'+idx+'.rate') }}</span></div>
                <div class="amount"><span class="mlabel">{{ t('of_amount') }}</span>
                  <span v-if="it.noPrice" class="badge b-warning"><Icon name="tag" :size="13"/>{{ t('price_pending') }}</span>
                  <span v-else class="money">{{ it.rate === '' ? '—' : money(lineAmount(it)) }}</span></div>
                <div class="tools c-tools">
                  <label class="check"><input type="checkbox" v-model="it.noPrice" @change="togglePrice(it)">{{ t('of_no_price') }}</label>
                  <span class="row" style="gap:2px">
                    <button type="button" class="btn sm ghost icon-btn" :aria-expanded="it.open" :aria-label="it.open ? t('of_less') : t('of_more')" :title="it.open ? t('of_less') : t('of_more')" @click="it.open=!it.open"><Icon :name="it.open ? 'up' : 'down'" :size="18"/></button>
                    <button v-if="f.items.length>1" type="button" class="btn sm ghost icon-btn danger" :aria-label="t('of_remove')" :title="t('of_remove')" @click="f.items.splice(idx,1)"><Icon name="trash" :size="18"/></button>
                  </span>
                </div>
                <div v-if="it.open || it.noPrice || it.description" class="detail">
                  <div v-if="it.open || it.description" class="field"><label :for="'d-'+idx">{{ t('of_desc') }}</label>
                    <input :id="'d-'+idx" class="input" v-model="it.description" :placeholder="t('of_desc_ph')" enterkeyhint="next"></div>
                  <div v-if="it.autoPending" class="alert warn" style="padding:6px 10px"><Icon name="tag" :size="14"/><span style="flex:1">{{ t(custType==='Company' ? 'pr_missing_company' : 'pr_missing_individual') }}</span>
                    <a v-if="state.boot.can.prices" class="btn sm" href="/atelier/prices" target="_blank" rel="noopener">{{ t('pr_go_prices') }}</a></div>
                  <div v-if="it.noPrice" class="hint">{{ t('of_no_price_hint') }}</div>
                </div>
              </div>
              <button type="button" class="btn" style="margin-top:8px" @click="addItem"><Icon name="plus" :size="18"/>{{ t('of_add_item') }}</button>
            </div>
          </section>

          <section v-if="boot.can.cost" class="card">
            <details class="collapse" :open="f.costs.length>0">
              <summary><Icon name="chev" class="chev" :size="18"/><h2 style="flex:1">{{ t('of_cost') }}</h2>
                <span v-if="f.costs.length" class="money meta">{{ money(sum.cost) }}</span></summary>
              <div class="card-b">
                <p class="hint" style="margin:0 0 8px">{{ t('of_cost_hint') }}</p>
                <div v-if="f.costs.length" class="lines-head costs-grid" aria-hidden="true"><span>{{ t('of_cost_type') }}</span><span>{{ t('of_cost_desc') }}</span><span>{{ t('of_cost_qty') }}</span><span>{{ t('of_cost_rate') }}</span><span style="text-align:end">{{ t('of_cost_amount') }}</span><span></span></div>
                <div v-for="(c, idx) in f.costs" :key="idx" class="line costs-grid">
                  <div class="field"><label :for="'ct-'+idx" class="mlabel">{{ t('of_cost_type') }}</label>
                    <select :id="'ct-'+idx" class="input" v-model="c.cost_type" :aria-label="t('of_cost_type')"><option v-for="ct in COST_TYPES" :key="ct[0]" :value="ct[0]">{{ t(ct[1]) }}</option></select></div>
                  <div class="field c-desc"><label :for="'cd-'+idx" class="mlabel">{{ t('of_cost_desc') }}</label><input :id="'cd-'+idx" class="input" v-model="c.description" :aria-label="t('of_cost_desc')"></div>
                  <div class="field"><label :for="'cq-'+idx" class="mlabel">{{ t('of_cost_qty') }}</label><input :id="'cq-'+idx" class="input num" type="text" inputmode="decimal" autocomplete="off" v-model="c.qty" :aria-label="t('of_cost_qty')"></div>
                  <div class="field"><label :for="'cr-'+idx" class="mlabel">{{ t('of_cost_rate') }}</label><input :id="'cr-'+idx" class="input num" type="text" inputmode="decimal" autocomplete="off" v-model="c.rate" :aria-label="t('of_cost_rate')" placeholder="0.00"></div>
                  <div class="amount"><span class="mlabel">{{ t('of_cost_amount') }}</span>
                    <span v-if="costAmount(c)===null" class="badge b-warning"><Icon name="alert" :size="13"/>{{ t('of_cost_missing') }}</span>
                    <span v-else class="money">{{ money(costAmount(c)) }}</span></div>
                  <div class="tools"><button type="button" class="btn sm ghost icon-btn danger" :aria-label="t('of_remove_cost')" :title="t('of_remove_cost')" @click="f.costs.splice(idx,1)"><Icon name="trash" :size="18"/></button></div>
                </div>
                <div class="row wrap" style="margin-top:8px;align-items:flex-end">
                  <button type="button" class="btn" @click="addCost"><Icon name="plus" :size="18"/>{{ t('of_add_cost') }}</button>
                  <div class="field" style="width:130px"><label for="f-waste">{{ t('of_waste') }}</label><input id="f-waste" class="input num" type="text" inputmode="decimal" autocomplete="off" v-model="f.waste"></div>
                </div>
              </div>
            </details>
          </section>

          <section v-if="boot.can.payment" class="card">
            <div class="card-h"><h2>{{ t('of_advance') }} <span class="cap">({{ t('optional') }})</span></h2></div>
            <div class="card-b stack">
              <div class="cols-2">
                <div class="field"><label for="f-adv">{{ t('of_advance_amount') }} ({{ t('currency') }})</label>
                  <input id="f-adv" class="input num" type="text" inputmode="decimal" autocomplete="off" v-model="f.advance.amount" placeholder="0.00" enterkeyhint="done"></div>
                <div class="field"><span class="label">{{ t('of_mode') }}</span>
                  <div class="seg" role="group" :aria-label="t('of_mode')"><button v-for="m in boot.modes" :key="m.value" type="button" :aria-pressed="f.advance.mode===m.value" @click="f.advance.mode=m.value">{{ m.label }}</button></div>
                  <span v-if="err('advance_mode')" class="error-text">{{ err('advance_mode') }}</span></div>
              </div>
              <span class="hint">{{ t('of_advance_hint') }}</span>
            </div>
          </section>
        </div>

        <aside class="side">
          <section class="card" aria-labelledby="sum-h">
            <div class="card-h"><h2 id="sum-h">{{ t('of_summary') }}</h2>
              <span class="badge" :class="custType==='Company' ? 'b-info' : 'b-neutral'"><Icon name="tag" :size="13"/>{{ t(custType==='Company' ? 'pr_company_prices' : 'pr_individual_prices') }}</span></div>
            <div class="card-b">
              <div class="sum-row"><span>{{ sum.pending ? t('sum_priced') : t('sum_total') }}</span><span class="money strong">{{ money(sum.total) }}</span></div>
              <div v-if="sum.pending" class="sum-note">{{ t('sum_not_final', sum.pending) }}</div>
              <template v-if="f.costs.length">
                <div class="sum-row"><span>{{ sum.missing ? t('sum_cost_known') : t('sum_cost_complete') }}</span><span class="money">{{ money(sum.cost) }}</span></div>
                <div v-if="sum.missing" class="sum-note">{{ t('sum_cost_missing', sum.missing) }}</div>
              </template>
              <div class="sum-row"><span>{{ t('sum_margin') }}</span>
                <span v-if="sum.margin===null" class="stack" style="gap:0;align-items:flex-end"><span class="muted">{{ t('sum_margin_na') }}</span><span class="why">{{ sum.marginWhy }}</span></span>
                <span v-else class="money medium">{{ money(sum.margin) }}</span></div>
              <div v-if="sum.adv" class="sum-row"><span>{{ t('sum_advance') }}</span><span class="money">{{ money(sum.adv) }}</span></div>
              <div class="sum-row total"><span>{{ t('sum_remaining') }}</span>
                <span v-if="sum.remaining===null" class="stack" style="gap:0;align-items:flex-end"><span class="muted">—</span><span class="why">{{ t('why_remaining') }}</span></span>
                <span v-else class="money">{{ money(sum.remaining) }}</span></div>
              <div class="stack desktop-only" style="gap:2px;margin-top:10px">
                <span class="cap medium">{{ t('of_will_create') }}</span>
                <span class="cap">• {{ sum.pending ? t('of_will_so_draft') : t('of_will_so') }}</span>
                <span v-if="f.costs.length" class="cap">• {{ t('of_will_ce') }}</span>
                <span v-if="sum.adv" class="cap">• {{ t('of_will_pe', money(sum.adv)) }}</span>
              </div>
            </div>
            <div class="card-f desktop-only" style="padding:12px 16px">
              <span v-if="attempted && errorCount" class="error-text" style="margin-bottom:8px">{{ t('err_fix_n', errorCount) }}</span>
              <button type="submit" class="btn primary block lg" :disabled="saving">{{ saving ? t('of_saving') : (sum.pending ? t('of_save_draft') : t('of_save')) }}</button>
            </div>
          </section>
        </aside>
      </div>

      <div class="save-bar" role="region" :aria-label="t('of_summary')">
        <div class="sb-info">
          <span class="cap">{{ sum.pending ? t('sum_priced') : t('sum_total') }}</span>
          <span class="money strong">{{ money(sum.total) }}</span>
          <span v-if="sum.pending" class="cap ellipsis" style="color:var(--warning)">{{ t('sb_not_final', sum.pending) }}</span>
        </div>
        <button type="submit" class="btn primary" :disabled="saving">{{ saving ? t('of_saving') : (sum.pending ? t('of_save_draft') : t('of_save')) }}</button>
      </div>
    </form>
  </div>`,
};

// ------------------------------------------------------------------ order view
const pdfUrl = (doctype, name, format) =>
  `/api/method/frappe.utils.print_format.download_pdf?doctype=${encodeURIComponent(doctype)}&name=${encodeURIComponent(name)}` +
  (format ? `&format=${encodeURIComponent(format + " — " + doctype)}&no_letterhead=1` : "");

const OrderView = {
  props: ["id"], components: { Icon, Badge, LoadState },
  setup(props) {
    const { s, load } = useLoad(() => call("order", { name: props.id }));
    onMounted(load);
    watch(() => state.rev, load);
    const stages = computed(() => state.boot?.stages || []);
    const setStage = async (stage) => {
      const prev = s.data.atelier_stage; s.data.atelier_stage = stage;
      try { await call("set_stage", { name: props.id, stage }, true); toast(t("ov_stage_saved")); }
      catch (e) { s.data.atelier_stage = prev; toast(e.message, "error"); }
    };
    const stageIdx = computed(() => stages.value.indexOf(s.data?.atelier_stage));

    // ---- the cycle: one obvious next step, the others still reachable
    const busy = ref(null), panel = ref(null), rates = reactive({}), qtys = reactive({}), actionError = ref(null);
    const d = computed(() => s.data || {});
    const pendingRows = computed(() => (d.value.items || []).filter((i) => i.rate === null));
    const toDeliver = computed(() => (d.value.items || []).filter((i) => i.qty - (i.delivered_qty || 0) > 0));
    const steps = computed(() => {
      const o = d.value; if (!o.name) return [];
      const draft = o.docstatus === 0;
      return [
        { key: "price", label: t("cy_price"), done: !pendingRows.value.length, show: true },
        { key: "confirm", label: t("cy_confirm"), done: o.docstatus === 1, show: true },
        { key: "deliver", label: t("cy_deliver"), done: o.per_delivered >= 100, show: true },
        { key: "invoice", label: t("cy_invoice"), done: o.per_billed >= 100, show: true },
        { key: "pay", label: t("cy_pay"), done: o.per_billed >= 100 && o.outstanding < 0.01, show: true, blocked: draft },
      ];
    });
    const next = computed(() => steps.value.find((x) => !x.done)?.key || "done");
    const run = async (key, fn) => {
      busy.value = key; actionError.value = null;
      try { const r = await fn(); panel.value = null; await load(); return r; }
      catch (e) { actionError.value = e.message; }
      finally { busy.value = null; }
    };
    const savePrices = () => {
      const bad = pendingRows.value.find((i) => rates[i.row] !== undefined && rates[i.row] !== "" && !(+rates[i.row] >= 0));
      if (bad) { actionError.value = t("pr_err_value"); return; }
      const payload = Object.fromEntries(pendingRows.value.filter((i) => rates[i.row] !== undefined && rates[i.row] !== "").map((i) => [i.row, +rates[i.row]]));
      if (!Object.keys(payload).length) { actionError.value = t("cy_err_no_price"); return; }
      return run("price", async () => { const r = await call("price_order", { name: props.id, rates: JSON.stringify(payload) }, true); toast(t("cy_prices_saved")); return r; });
    };
    const confirmOrder = () => run("confirm", async () => { await call("confirm_order", { name: props.id }, true); toast(t("cy_confirmed")); });
    const openDeliver = () => { for (const i of toDeliver.value) qtys[i.row] = i.qty - (i.delivered_qty || 0); panel.value = "deliver"; };
    const deliver = () => run("deliver", async () => {
      const r = await call("deliver_order", { name: props.id, qtys: JSON.stringify(Object.fromEntries(Object.entries(qtys).map(([k, v]) => [k, +v || 0]))) }, true);
      toast(t("cy_delivered", r));
    });
    const invoice = () => run("invoice", async () => { const r = await call("invoice_order", { name: props.id }, true); toast(t("cy_invoiced", r)); });
    const pay = () => (state.sheet = { type: "payment", customer: { name: d.value.customer, customer_name: d.value.customer_name }, order: d.value.name });
    const unbilled = computed(() => Math.max(0, (d.value.grand_total || 0) * (1 - (d.value.per_billed || 0) / 100)));
    const DOC_ICON = { "Delivery Note": "truck", "Sales Invoice": "invoice", "Payment Entry": "in" };
    return { s, load, stages, setStage, stageIdx, steps, next, busy, panel, rates, qtys, actionError, pendingRows, toDeliver, unbilled,
      savePrices, confirmOrder, openDeliver, deliver, invoice, pay, pdfUrl, DOC_ICON, DT_KEY, t, money, num, date, billing, payment, due, go, state, plain };
  },
  template: `
  <div class="page">
    <LoadState :s="s" :rows="5" @retry="load"><template v-if="s.data">
      <div class="page-head">
        <div class="stack" style="gap:2px;min-width:0;flex:1">
          <h1 class="wrap-any">{{ s.data.atelier_subject || s.data.name }}</h1>
          <span class="meta"><a :href="'/atelier/customers/'+s.data.customer" @click.prevent="go('/customers/'+encodeURIComponent(s.data.customer))">{{ s.data.customer_name }}</a> · <span class="num">{{ s.data.name }}</span></span>
        </div>
        <div class="row wrap" style="gap:6px"><span :class="due(s.data).cls">{{ t('col_due') }}: {{ due(s.data).text }}</span><Badge :b="billing(s.data)"/><Badge :b="payment(s.data)"/></div>
      </div>
      <div class="split">
        <div class="stack">
          <section class="card" aria-labelledby="cy-h">
            <div class="card-h"><h2 id="cy-h">{{ t('cy_title') }}</h2><span v-if="next==='done'" class="badge b-success"><Icon name="check" :size="13"/>{{ t('cy_done') }}</span></div>
            <div class="card-b stack">
              <ol class="cycle">
                <li v-for="(st,i) in steps" :key="st.key" :class="{done: st.done, current: st.key===next}"><span class="dot">{{ st.done ? '✓' : i+1 }}</span>{{ st.label }}</li>
              </ol>
              <div v-if="actionError" class="alert error" role="alert"><Icon name="alert" :size="16"/><span>{{ actionError }}</span></div>

              <template v-if="next==='price'">
                <p class="hint">{{ t('cy_price_hint', pendingRows.length) }}</p>
                <div v-for="i in pendingRows" :key="i.row" class="row wrap" style="gap:8px;align-items:center">
                  <label :for="'pr-'+i.row" style="flex:1;min-width:160px" class="medium">{{ i.item_name }} <span class="cap num">× {{ num(i.qty) }}</span></label>
                  <input :id="'pr-'+i.row" class="input num" style="width:160px" type="text" inputmode="decimal" autocomplete="off" v-model="rates[i.row]" :placeholder="t('of_rate')">
                </div>
                <button type="button" class="btn primary" style="align-self:flex-start" :disabled="busy" @click="savePrices">{{ busy==='price' ? t('of_saving') : t('cy_save_prices') }}</button>
              </template>
              <template v-else-if="next==='confirm'">
                <p class="hint">{{ t('cy_confirm_hint') }}</p>
                <button type="button" class="btn primary" style="align-self:flex-start" :disabled="busy || !s.data.can.submit" @click="confirmOrder">{{ busy==='confirm' ? t('of_saving') : t('cy_confirm') }}</button>
              </template>
              <template v-else-if="next!=='done'">
                <div class="row wrap" style="gap:8px">
                  <button v-if="s.data.per_delivered<100 && s.data.can.deliver" type="button" class="btn" :class="{primary: next==='deliver'}" :disabled="busy" @click="openDeliver"><Icon name="truck" :size="18"/>{{ t('cy_deliver') }}</button>
                  <button v-if="s.data.per_billed<100 && s.data.can.invoice" type="button" class="btn" :class="{primary: next==='invoice'}" :disabled="busy" @click="panel='invoice'"><Icon name="invoice" :size="18"/>{{ t('cy_invoice') }}</button>
                  <button v-if="s.data.outstanding>0.005 && s.data.can.payment" type="button" class="btn" :class="{primary: next==='pay'}" @click="pay"><Icon name="in" :size="18"/>{{ t('record_payment') }}</button>
                </div>
                <div v-if="panel==='deliver'" class="box stack">
                  <span class="medium">{{ t('cy_deliver_title') }}</span>
                  <div v-for="i in toDeliver" :key="i.row" class="row wrap" style="gap:8px;align-items:center">
                    <label :for="'dq-'+i.row" style="flex:1;min-width:160px">{{ i.item_name }} <span class="cap">{{ t('cy_left', num(i.qty - (i.delivered_qty||0))) }}</span></label>
                    <input :id="'dq-'+i.row" class="input num" style="width:120px" type="text" inputmode="decimal" v-model="qtys[i.row]"></div>
                  <span class="hint">{{ t('cy_deliver_hint') }}</span>
                  <div class="row" style="gap:8px"><button type="button" class="btn primary" :disabled="busy" @click="deliver">{{ busy==='deliver' ? t('of_saving') : t('cy_deliver_do') }}</button>
                    <button type="button" class="btn ghost" @click="panel=null">{{ t('close') }}</button></div>
                </div>
                <div v-if="panel==='invoice'" class="box stack">
                  <span class="medium">{{ t('cy_invoice_title') }}</span>
                  <dl class="kv"><dt>{{ t('cy_invoice_amount') }}</dt><dd class="money">{{ money(unbilled) }}</dd>
                    <template v-if="s.data.advance_paid"><dt>{{ t('cy_advance_deducted') }}</dt><dd class="money">− {{ money(Math.min(s.data.advance_paid, unbilled)) }}</dd></template></dl>
                  <span class="hint">{{ t('cy_invoice_hint') }}</span>
                  <div class="row" style="gap:8px"><button type="button" class="btn primary" :disabled="busy" @click="invoice">{{ busy==='invoice' ? t('of_saving') : t('cy_invoice_do') }}</button>
                    <button type="button" class="btn ghost" @click="panel=null">{{ t('close') }}</button></div>
                </div>
              </template>
            </div>
          </section>

          <section class="card"><div class="card-h"><h2>{{ t('ov_stage') }}</h2></div>
            <div class="card-b"><div class="stages" role="group" :aria-label="t('ov_stage')">
              <button v-for="(st,i) in stages" :key="st" type="button" :class="{done: i<stageIdx, current: i===stageIdx}" :aria-pressed="i===stageIdx" @click="setStage(st)">{{ st }}</button>
            </div></div></section>
          <section class="card"><div class="card-h"><h2>{{ t('ov_items') }}</h2></div>
            <div class="desktop-only table-wrap"><table class="t">
              <thead><tr><th>{{ t('of_item') }}</th><th class="n">{{ t('of_qty') }}</th><th class="n">{{ t('cy_delivered_col') }}</th><th class="n">{{ t('of_rate') }}</th><th class="n">{{ t('of_amount') }}</th></tr></thead>
              <tbody><tr v-for="(i,idx) in s.data.items" :key="idx">
                <td><div class="medium">{{ i.item_name }}</div><div v-if="plain(i.description) && plain(i.description)!==i.item_name" class="meta">{{ plain(i.description) }}</div></td>
                <td class="n"><span class="num">{{ num(i.qty) }}</span></td>
                <td class="n"><span class="num" :class="{'t-success': i.delivered_qty>=i.qty}">{{ num(i.delivered_qty||0) }}</span></td>
                <td class="n"><span v-if="i.rate===null" class="badge b-warning"><Icon name="tag" :size="13"/>{{ t('price_pending') }}</span><span v-else class="money">{{ money(i.rate) }}</span></td>
                <td class="n"><span class="money medium">{{ i.rate===null ? '—' : money(i.amount) }}</span></td></tr></tbody></table></div>
            <div class="mobile-only list">
              <div v-for="(i,idx) in s.data.items" :key="idx" class="list-item static">
                <span class="main-col"><span class="medium">{{ i.item_name }}</span>
                  <span v-if="plain(i.description) && plain(i.description)!==i.item_name" class="meta">{{ plain(i.description) }}</span>
                  <span class="cap">{{ num(i.qty) }} × {{ i.rate===null ? '؟' : money(i.rate) }} · {{ t('cy_delivered_col') }} {{ num(i.delivered_qty||0) }}</span></span>
                <span class="end-col"><span v-if="i.rate===null" class="badge b-warning"><Icon name="tag" :size="13"/>{{ t('price_pending') }}</span>
                  <span v-else class="money medium">{{ money(i.amount) }}</span></span>
              </div>
            </div></section>
        </div>
        <aside class="side stack">
          <section class="card"><div class="card-h"><h2>{{ t('ov_money') }}</h2></div><div class="card-b">
            <div class="sum-row"><span>{{ s.data.price_pending ? t('sum_priced') : t('sum_total') }}</span><span class="money strong">{{ money(s.data.grand_total) }}</span></div>
            <div v-if="s.data.price_pending" class="sum-note">{{ t('sum_not_final', s.data.items.filter(i=>i.rate===null).length) }}</div>
            <div class="sum-row"><span>{{ t('ov_paid') }}</span><span class="money">{{ money(s.data.paid) }}</span></div>
            <div class="sum-row total"><span>{{ t('ov_left') }}</span>
              <span v-if="s.data.price_pending" class="stack" style="gap:0;align-items:flex-end"><span class="muted">—</span><span class="why">{{ t('why_remaining') }}</span></span>
              <span v-else class="money">{{ money(Math.max(0, s.data.grand_total - s.data.paid)) }}</span></div>
            <div v-if="s.data.estimate && s.data.estimate.length" class="sum-row"><span>{{ s.data.estimate[0].missing_count ? t('sum_cost_known') : t('sum_cost_complete') }}</span>
              <span class="money">{{ money(s.data.estimate[0].total_cost) }}</span></div>
          </div>
          <div class="card-f row wrap" style="gap:6px">
            <a class="btn sm ghost" :href="'/app/sales-order/'+s.data.name"><Icon name="ext" :size="16"/>{{ t('ov_open_erp') }}</a>
            <a v-if="s.data.project && state.boot.can.finance" class="btn sm ghost" :href="'/app/query-report/Rentabilite Commande?project='+encodeURIComponent(s.data.project)"><Icon name="chart" :size="16"/>{{ t('ov_profit') }}</a>
          </div></section>
          <section class="card" aria-labelledby="docs-h"><div class="card-h"><h2 id="docs-h">{{ t('cy_docs') }}</h2></div>
            <div class="list">
              <div class="list-item static"><Icon name="orders" :size="18" class="muted"/>
                <span class="main-col"><span class="medium">{{ t('cy_doc_order') }}</span><span class="meta num">{{ s.data.name }}</span></span>
                <a class="btn sm" target="_blank" rel="noopener" :href="pdfUrl('Sales Order', s.data.name, s.data.print_format)">PDF</a></div>
              <div v-for="dc in s.data.docs" :key="dc.name" class="list-item static"><Icon :name="DOC_ICON[dc.doctype]" :size="18" class="muted"/>
                <span class="main-col"><span class="medium">{{ t(DT_KEY[dc.doctype]) }}</span>
                  <span class="meta"><span class="num">{{ dc.name }}</span> · {{ date(dc.posting_date) }}
                    <template v-if="dc.doctype==='Sales Invoice'"> · <span :class="dc.outstanding_amount>0.005 ? 't-danger' : 't-success'">{{ dc.outstanding_amount>0.005 ? t('cy_unpaid', money(dc.outstanding_amount)) : t('pay_full') }}</span></template>
                    <template v-else-if="dc.paid_amount"> · <span class="money">{{ money(dc.paid_amount) }}</span></template></span></span>
                <a class="btn sm" target="_blank" rel="noopener" :href="pdfUrl(dc.doctype, dc.name, s.data.print_format)">PDF</a></div>
            </div></section>
        </aside>
      </div>
    </template></LoadState>
  </div>`,
};

// ------------------------------------------------------------------ customer
const DT_KEY = { "Quotation": "dt_quotation", "Sales Invoice": "dt_sales_invoice", "Delivery Note": "dt_delivery_note",
  "Payment Entry": "dt_payment_entry", "Sales Order": "dt_sales_order", "Journal Entry": "dt_journal_entry", "Customer": "dt_customer" };
const isImage = (f) => /\.(png|jpe?g|gif|webp|svg)$/i.test(f.file_name || f.file_url || "");

const CustomerView = {
  props: ["id"], components: { Icon, Badge, LoadState, OrdersTable },
  setup(props) {
    const { s, load } = useLoad(() => call("customer", { name: props.id }));
    onMounted(load);
    const tab = ref("orders");
    const preview = ref(null);
    const bal = computed(() => {
      const b = s.data?.balance ?? 0;
      if (Math.abs(b) < 0.01) return { label: t("c_settled"), value: 0, cls: "b-success", icon: "check" };
      return b > 0 ? { label: t("c_owes"), value: b, cls: "b-danger", icon: "alert" } : { label: t("c_credit"), value: -b, cls: "b-info", icon: "money" };
    });
    const pdf = (dt, name) => `/api/method/frappe.utils.print_format.download_pdf?doctype=${encodeURIComponent(dt)}&name=${encodeURIComponent(name)}`;
    const statement = computed(() => `/app/query-report/General Ledger?party_type=Customer&party=${encodeURIComponent(props.id)}&group_by=Group by Voucher (Consolidated)`);
    const tabs = computed(() => [
      ["orders", t("c_orders"), s.data?.orders?.length],
      ...(s.data?.ledger ? [["ledger", t("c_ledger"), s.data.ledger.length]] : []),
      ["docs", t("c_docs"), s.data?.documents?.length],
      ["files", t("c_files"), s.data?.files?.length],
    ]);
    const onTabKey = (e) => {
      const keys = tabs.value.map((x) => x[0]); const i = keys.indexOf(tab.value);
      // RTL: ArrowLeft moves forward.
      if (e.key === "ArrowLeft") tab.value = keys[(i + 1) % keys.length];
      else if (e.key === "ArrowRight") tab.value = keys[(i - 1 + keys.length) % keys.length];
      else return;
      e.preventDefault(); setTimeout(() => document.getElementById("tab-" + tab.value)?.focus(), 0);
    };
    return { s, load, tab, tabs, onTabKey, bal, preview, pdf, statement, DT_KEY, isImage, fileSize, t, money, date, go, state };
  },
  template: `
  <div class="page">
    <LoadState :s="s" :rows="6" @retry="load"><template v-if="s.data">
      <div class="page-head">
        <div class="stack" style="gap:2px;min-width:0;flex:1"><h1 class="wrap-any">{{ s.data.customer_name }}</h1>
          <span class="badge" :class="s.data.customer_type==='Company' ? 'b-info' : 'b-neutral'" style="align-self:flex-start"><Icon name="tag" :size="13"/>{{ t(s.data.customer_type==='Company' ? 'pr_company_prices' : 'pr_individual_prices') }}</span>
          <a v-if="s.data.mobile_no" class="meta num" dir="ltr" :href="'tel:'+s.data.mobile_no" style="align-self:flex-start">{{ s.data.mobile_no }}</a></div>
        <div class="row wrap" style="gap:6px">
          <a class="btn primary" :href="'/atelier/orders/new?customer='+encodeURIComponent(s.data.name)" @click.prevent="go('/orders/new?customer='+encodeURIComponent(s.data.name))"><Icon name="plus" :size="18"/>{{ t('c_new_order') }}</a>
          <button v-if="state.boot.can.payment" class="btn" @click="state.sheet={type:'payment', customer:{name:s.data.name, customer_name:s.data.customer_name}}"><Icon name="in" :size="18"/>{{ t('record_payment') }}</button>
          <a v-if="s.data.ledger" class="btn ghost" :href="statement"><Icon name="file" :size="18"/>{{ t('c_statement') }}</a>
          <button v-if="s.data.can_edit" type="button" class="btn ghost" @click="state.sheet={type:'customer', name:s.data.name}"><Icon name="edit" :size="18"/>{{ t('cs_edit') }}</button>
        </div>
      </div>

      <div class="split">
        <aside class="side stack" style="order:-1">
          <section v-if="s.data.ledger" class="card"><div class="card-h"><h2>{{ t('c_balance_title') }}</h2>
            <span class="badge" :class="bal.cls"><Icon :name="bal.icon" :size="13"/>{{ bal.label }}</span></div>
            <div class="card-b stack">
              <span class="money" style="font-size:24px;font-weight:600">{{ money(bal.value) }}</span>
              <dl class="kv"><dt>{{ t('c_outstanding') }}</dt><dd class="money">{{ money(s.data.outstanding) }}</dd>
                <dt>{{ t('c_invoiced') }}</dt><dd class="money">{{ money(s.data.invoiced) }}</dd>
                <dt>{{ t('c_received') }}</dt><dd class="money">{{ money(s.data.received) }}</dd></dl>
            </div></section>
          <section class="card"><div class="card-h"><h2>{{ t('cs_info') }}</h2></div>
            <div class="card-b"><dl class="kv">
              <dt>{{ t('cs_type') }}</dt><dd>{{ t(s.data.customer_type==='Company' ? 'c_type_company' : 'c_type_person') }}</dd>
              <template v-if="s.data.contact_person"><dt>{{ t('cs_contact_person') }}</dt><dd>{{ s.data.contact_person }}</dd></template>
              <dt>{{ t('c_phone') }}</dt><dd><a v-if="s.data.mobile_no" class="num" dir="ltr" :href="'tel:'+s.data.mobile_no">{{ s.data.mobile_no }}</a><span v-else class="muted">—</span></dd>
              <dt>{{ t('cs_email') }}</dt><dd><a v-if="s.data.email_id" :href="'mailto:'+s.data.email_id" dir="ltr">{{ s.data.email_id }}</a><span v-else class="muted">—</span></dd>
              <dt>{{ t('cs_address') }}</dt><dd>{{ [s.data.address, s.data.city].filter(Boolean).join('، ') || '—' }}</dd>
              <template v-if="s.data.customer_type==='Company'"><dt>{{ t('cs_tax_id') }}</dt><dd class="num">{{ s.data.tax_id || '—' }}</dd></template>
            </dl><p v-if="s.data.notes" class="hint" style="margin-top:8px;white-space:pre-line">{{ s.data.notes }}</p></div></section>
        </aside>

        <section class="card" style="min-width:0">
          <div class="tabs" role="tablist" @keydown="onTabKey">
            <button v-for="tb in tabs" :key="tb[0]" :id="'tab-'+tb[0]" role="tab" :aria-selected="tab===tb[0]" :tabindex="tab===tb[0] ? 0 : -1" :aria-controls="'panel-'+tb[0]" @click="tab=tb[0]">
              {{ tb[1] }} <span class="count num">{{ tb[2]||0 }}</span></button>
          </div>

          <div v-if="tab==='orders'" id="panel-orders" role="tabpanel" aria-labelledby="tab-orders">
            <div v-if="!s.data.orders.length" class="empty">{{ t('c_no_orders') }}</div>
            <OrdersTable v-else :rows="s.data.orders" hide-customer :title="t('c_orders')" style="border:0;box-shadow:none"/>
          </div>

          <div v-if="tab==='ledger'" id="panel-ledger" role="tabpanel" aria-labelledby="tab-ledger">
            <div v-if="!s.data.ledger.length" class="empty">{{ t('c_no_ledger') }}</div>
            <div v-else class="desktop-only table-wrap"><table class="t">
              <thead><tr><th>{{ t('c_date') }}</th><th>{{ t('c_doc') }}</th><th class="n">{{ t('c_debit') }}</th><th class="n">{{ t('c_credit_col') }}</th><th class="n">{{ t('c_balance') }}</th></tr></thead>
              <tbody><tr v-for="(e,i) in s.data.ledger" :key="i">
                <td style="white-space:nowrap">{{ date(e.posting_date, true) }}</td>
                <td>{{ t(DT_KEY[e.voucher_type] || e.voucher_type) }} <a class="meta num" :href="pdf(e.voucher_type, e.voucher_no)" target="_blank" rel="noopener">{{ e.voucher_no }}</a></td>
                <td class="n"><span class="money">{{ e.debit ? money(e.debit) : '' }}</span></td>
                <td class="n"><span class="money">{{ e.credit ? money(e.credit) : '' }}</span></td>
                <td class="n"><span class="money medium">{{ money(e.balance) }}</span></td></tr></tbody></table></div>
            <div v-if="s.data.ledger.length" class="mobile-only list">
              <div v-for="(e,i) in s.data.ledger" :key="i" class="list-item" style="cursor:default">
                <span class="main-col"><span class="medium">{{ t(DT_KEY[e.voucher_type] || e.voucher_type) }}</span>
                  <span class="cap">{{ date(e.posting_date, true) }} · <a class="num" :href="pdf(e.voucher_type, e.voucher_no)" target="_blank" rel="noopener">{{ e.voucher_no }}</a></span></span>
                <span class="end-col"><span class="money medium" :style="{color: e.debit ? 'var(--danger)' : 'var(--success)'}">{{ e.debit ? money(e.debit) : money(e.credit) }}</span>
                  <span class="cap">{{ e.debit ? t('c_debit') : t('c_credit_col') }} · {{ t('c_balance') }} <span class="money">{{ money(e.balance) }}</span></span></span>
              </div>
            </div>
          </div>

          <div v-if="tab==='docs'" id="panel-docs" role="tabpanel" aria-labelledby="tab-docs">
            <div v-if="!s.data.documents.length" class="empty">{{ t('c_no_docs') }}</div>
            <div class="list">
              <div v-for="d in s.data.documents" :key="d.name" class="list-item" style="cursor:default">
                <Icon name="invoice" :size="18" class="muted"/><span class="main-col"><span class="medium">{{ t(DT_KEY[d.doctype]) }} <span v-if="d.docstatus===0" class="badge b-neutral">{{ t('draft') }}</span></span>
                  <span class="cap"><span class="num">{{ d.name }}</span> · {{ date(d.date, true) }}</span></span>
                <span class="money meta">{{ money(d.amount) }}</span>
                <a class="btn sm ghost" :href="pdf(d.doctype, d.name)" target="_blank" rel="noopener">PDF</a>
              </div>
            </div>
          </div>

          <div v-if="tab==='files'" id="panel-files" role="tabpanel" aria-labelledby="tab-files">
            <div v-if="!s.data.files.length" class="empty">{{ t('c_no_files') }}</div>
            <div class="list">
              <div v-for="f in s.data.files" :key="f.name" class="list-item" style="cursor:default">
                <Icon :name="isImage(f) ? 'image' : 'file'" :size="18" class="muted"/>
                <span class="main-col"><span class="medium ellipsis" dir="auto">{{ f.file_name }}</span>
                  <span class="cap">{{ t('c_attached_to', t(DT_KEY[f.attached_to_doctype] || f.attached_to_doctype)) }} <span class="num">{{ f.attached_to_name }}</span> · {{ fileSize(f.file_size) }}
                    <span v-if="f.is_private" class="badge b-neutral">{{ t('c_private') }}</span></span></span>
                <button v-if="isImage(f)" class="btn sm" @click="preview=f">{{ t('c_preview') }}</button>
                <a class="btn sm ghost icon-btn" :href="f.file_url" target="_blank" rel="noopener" :aria-label="t('c_open')+' '+f.file_name" :title="t('c_open')"><Icon name="ext" :size="16"/></a>
              </div>
            </div>
          </div>
        </section>
      </div>

      <div v-if="preview" class="overlay" @click.self="preview=null" @keydown.esc="preview=null" role="dialog" aria-modal="true" :aria-label="preview.file_name">
        <div class="sheet wide">
          <div class="row"><h2 class="ellipsis" style="flex:1" dir="auto">{{ preview.file_name }}</h2>
            <button class="btn ghost icon-btn" :aria-label="t('close')" @click="preview=null" autofocus><Icon name="x"/></button></div>
          <img class="preview-img" :src="preview.file_url" :alt="preview.file_name" loading="lazy">
        </div>
      </div>
    </template></LoadState>
  </div>`,
};

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

const Kpis = {
  props: { items: Array },
  template: `<div class="kpis static" role="group"><div v-for="k in items" :key="k.label" class="kpi" :class="k.tone ? 'tone-'+k.tone : ''">
    <span class="k-label">{{ k.label }}</span><span class="k-value" :class="{money: k.money !== false}">{{ k.value }}</span><span class="k-hint">{{ k.hint }}</span></div></div>`,
};

const deskLink = (doctype, name) => `/app/${doctype.toLowerCase().replace(/ /g, "-")}/${encodeURIComponent(name)}`;

const CustomerList = {
  components: { Icon, LoadState, DataTable },
  setup() {
    const { s, load } = useLoad(() => call("customers", { full: 1 }));
    onMounted(load);
    watch(() => state.rev, load);
    const finance = computed(() => (s.data || []).some((c) => c.balance !== null && c.balance !== undefined));
    const cols = computed(() => [
      { k: "customer_name", label: t("col_customer"), sort: true }, { k: "mobile_no", label: t("c_phone") },
      { k: "open_orders", label: t("c_open_orders"), type: "num", sort: true }, { k: "last_order", label: t("c_last_order"), type: "date", sort: true },
      ...(finance.value ? [{ k: "balance", label: t("c_balance"), type: "money", sort: true, main: true }] : []),
    ]);
    const filters = computed(() => [
      ...(finance.value ? [["owes", "c_f_owes", (c) => c.balance > 0.005], ["credit", "c_f_credit", (c) => c.balance < -0.005]] : []),
      ["active", "c_f_active", (c) => c.open_orders > 0],
      ["company", "c_type_company_short", (c) => c.customer_type === "Company"], ["person", "c_type_person", (c) => c.customer_type !== "Company"],
    ]);
    const open = (c) => go("/customers/" + encodeURIComponent(c.name));
    return { s, load, cols, filters, open, t, money, num, date, state };
  },
  template: `
  <div class="page">
    <div class="page-head"><div><h1>{{ t('c_title') }}</h1><div class="sub">{{ t('c_sub') }}</div></div>
      <button v-if="state.boot.can.customer" type="button" class="btn primary" @click="state.sheet={type:'customer'}"><Icon name="plus" :size="18"/>{{ t('c_add') }}</button></div>
    <LoadState :s="s" :rows="6" @retry="load">
      <DataTable :rows="s.data" :cols="cols" row-key="name" :search-keys="['customer_name','mobile_no','email_id']" :filters="filters"
        initial-sort="customer_name" :empty="t('c_none')">
        <template #cell="{row, col}">
          <span v-if="col.k==='customer_name'" class="title-cell"><a :href="'/atelier/customers/'+encodeURIComponent(row.name)" @click.prevent="open(row)" class="medium clamp2">{{ row.customer_name }}</a>
            <span class="row wrap" style="gap:4px"><span class="badge" :class="row.customer_type==='Company' ? 'b-info' : 'b-neutral'">{{ t(row.customer_type==='Company' ? 'pr_company_prices' : 'pr_individual_prices') }}</span></span></span>
          <a v-else-if="col.k==='mobile_no'" class="num" dir="ltr" :href="row.mobile_no ? 'tel:'+row.mobile_no : null">{{ row.mobile_no || '—' }}</a>
          <span v-else-if="col.k==='open_orders'" class="num">{{ row.open_orders || '—' }}</span>
          <template v-else-if="col.k==='last_order'">{{ row.last_order ? date(row.last_order, true) : '—' }}</template>
          <template v-else-if="col.k==='balance'">
            <span v-if="Math.abs(row.balance) < 0.005" class="cap">{{ t('c_settled') }}</span>
            <span v-else class="money medium" :class="row.balance > 0 ? 't-danger' : 't-success'">{{ money(Math.abs(row.balance)) }}
              <span class="cap">{{ row.balance > 0 ? t('c_owes') : t('c_credit_short') }}</span></span></template>
        </template>
      </DataTable>
    </LoadState>
  </div>`,
};

// ------------------------------------------------------------------ customer sheet (create / edit)
const CustomerSheet = {
  props: ["opts"], components: { Icon },
  setup(props) {
    const editing = !!props.opts.name;
    const f = reactive({ name: props.opts.name || null, customer_name: "", customer_type: "Individual", contact_person: "", mobile_no: "", email_id: "", tax_id: "", address: "", city: "", notes: "" });
    const originalType = ref(null);
    const ready = ref(!editing), saving = ref(false), error = ref(null), serverErrors = ref({}), attempted = ref(false);
    onMounted(async () => {
      if (editing) { try { Object.assign(f, await call("customer_profile", { name: f.name })); originalType.value = f.customer_type; } catch (e) { error.value = e.message; } ready.value = true; }
      setTimeout(() => document.getElementById("cs-name")?.focus(), 50);
    });
    const errs = computed(() => ({
      customer_name: !f.customer_name.trim() ? t("cs_err_name") : serverErrors.value.customer_name,
      email_id: f.email_id && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email_id) ? t("cs_err_email") : serverErrors.value.email_id,
    }));
    const close = () => (state.sheet = null);
    const onKey = (e) => { if (e.key === "Escape") close(); };
    onMounted(() => window.addEventListener("keydown", onKey));
    onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
    async function save() {
      attempted.value = true; error.value = null; serverErrors.value = {};
      const first = ["customer_name", "email_id"].find((k) => errs.value[k]);
      if (first) { document.getElementById({ customer_name: "cs-name", email_id: "cs-email" }[first])?.focus(); return; }
      saving.value = true;
      try {
        const name = await call("save_customer", { data: JSON.stringify(f) }, true);
        toast(editing ? t("cs_saved") : t("cs_created"));
        close(); state.rev++;
        if (!editing) go("/customers/" + encodeURIComponent(name));
      } catch (e) { error.value = e.message; serverErrors.value = e.errors || {}; }
      saving.value = false;
    }
    return { originalType, f, editing, ready, saving, error, attempted, errs, save, close, t };
  },
  template: `
  <div class="overlay" @click.self="close" role="dialog" aria-modal="true" aria-labelledby="cs-h">
    <form class="sheet wide" novalidate @submit.prevent="save">
      <div class="row"><h2 id="cs-h" style="flex:1">{{ editing ? t('cs_edit_title') : t('c_add') }}</h2><button type="button" class="btn ghost icon-btn" :aria-label="t('close')" @click="close"><Icon name="x"/></button></div>
      <div v-if="error" class="alert error" role="alert"><Icon name="alert" :size="16"/><span>{{ error }}</span></div>
      <div v-if="!ready" class="meta">{{ t('loading') }}</div>
      <template v-else>
        <div class="seg" role="group" :aria-label="t('cs_type')">
          <button type="button" :aria-pressed="f.customer_type==='Individual'" @click="f.customer_type='Individual'"><Icon name="users" :size="16"/>{{ t('c_type_person') }}</button>
          <button type="button" :aria-pressed="f.customer_type==='Company'" @click="f.customer_type='Company'"><Icon name="orders" :size="16"/>{{ t('c_type_company_short') }}</button></div>
        <div v-if="editing && originalType && originalType!==f.customer_type" class="alert info" role="status"><Icon name="tag" :size="16"/>
          <span>{{ t('pr_convert_note', t(f.customer_type==='Company' ? 'pr_company_prices' : 'pr_individual_prices')) }}</span></div>
        <div class="field"><label for="cs-name" class="req">{{ f.customer_type==='Company' ? t('cs_company_name') : t('cs_full_name') }}</label>
          <input id="cs-name" class="input" :class="{invalid: attempted && errs.customer_name}" type="text" v-model="f.customer_name" autocomplete="off" enterkeyhint="next">
          <span v-if="attempted && errs.customer_name" class="error-text">{{ errs.customer_name }}</span></div>
        <div class="grid-2">
          <div v-if="f.customer_type==='Company'" class="field"><label for="cs-person">{{ t('cs_contact_person') }}</label>
            <input id="cs-person" class="input" type="text" v-model="f.contact_person" autocomplete="off"></div>
          <div class="field"><label for="cs-phone">{{ t('c_phone') }}</label>
            <input id="cs-phone" class="input num" type="tel" inputmode="tel" dir="ltr" v-model="f.mobile_no" autocomplete="off" placeholder="0550 00 00 00"></div>
          <div class="field"><label for="cs-email">{{ t('cs_email') }}</label>
            <input id="cs-email" class="input" :class="{invalid: attempted && errs.email_id}" type="email" inputmode="email" dir="ltr" v-model="f.email_id" autocomplete="off">
            <span v-if="attempted && errs.email_id" class="error-text">{{ errs.email_id }}</span></div>
          <div v-if="f.customer_type==='Company'" class="field"><label for="cs-tax">{{ t('cs_tax_id') }}</label>
            <input id="cs-tax" class="input num" type="text" dir="ltr" v-model="f.tax_id" autocomplete="off"></div>
          <div class="field"><label for="cs-addr">{{ t('cs_address') }}</label><input id="cs-addr" class="input" type="text" v-model="f.address"></div>
          <div class="field"><label for="cs-city">{{ t('cs_city') }}</label><input id="cs-city" class="input" type="text" v-model="f.city"></div>
        </div>
        <div class="field"><label for="cs-notes">{{ t('cs_notes') }}</label><textarea id="cs-notes" class="input" rows="2" v-model="f.notes"></textarea></div>
        <button type="submit" class="btn primary block lg" :disabled="saving">{{ saving ? t('of_saving') : editing ? t('cs_save') : t('c_add') }}</button>
      </template>
    </form>
  </div>`,
};

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
    return { f, orders, saving, error, attempted, errs, save, close, done, t, money, state };
  },
  template: `
  <div class="overlay" @click.self="close" role="dialog" aria-modal="true" aria-labelledby="pay-h">
    <form class="sheet" novalidate @submit.prevent="save">
      <div class="row"><h2 id="pay-h" style="flex:1">{{ t('p_title') }}</h2><button type="button" class="btn ghost icon-btn" :aria-label="t('close')" @click="close"><Icon name="x"/></button></div>
      <template v-if="done">
        <div class="alert success"><Icon name="check" :size="16"/><span>{{ t('p_done', done) }}</span></div>
        <div class="row wrap"><a class="btn primary" target="_blank" rel="noopener" :href="'/api/method/frappe.utils.print_format.download_pdf?doctype=Payment%20Entry&name='+encodeURIComponent(done)">{{ t('p_receipt') }}</a>
          <button type="button" class="btn" @click="close">{{ t('close') }}</button></div>
      </template>
      <template v-else>
        <div v-if="error" class="alert error" role="alert"><Icon name="alert" :size="16"/><span>{{ error }}</span></div>
        <div class="field"><label for="p-c" class="req">{{ t('p_customer') }}</label>
          <CustomerPicker v-model="f.customer" input-id="p-c" :invalid="attempted && !!errs.customer"/>
          <span v-if="attempted && errs.customer" class="error-text">{{ errs.customer }}</span></div>
        <div class="field"><label for="p-a" class="req">{{ t('p_amount') }} ({{ t('currency') }})</label>
          <input id="p-a" class="input num" :class="{invalid: attempted && errs.amount}" type="text" inputmode="decimal" autocomplete="off" v-model="f.amount" placeholder="0.00" enterkeyhint="done">
          <span v-if="attempted && errs.amount" class="error-text">{{ errs.amount }}</span></div>
        <div class="field"><span class="label">{{ t('p_mode') }}</span>
          <div class="seg" role="group" :aria-label="t('p_mode')"><button v-for="m in state.boot.modes" :key="m.value" type="button" :aria-pressed="f.mode===m.value" @click="f.mode=m.value">{{ m.label }}</button></div></div>
        <div class="field"><label for="p-o">{{ t('p_order') }}</label>
          <select id="p-o" class="input" v-model="f.order"><option value="">{{ t('p_order_none') }}</option>
            <option v-for="o in orders" :key="o.name" :value="o.name">{{ (o.atelier_subject || o.name) + ' — ' + money(o.grand_total - o.paid) }}</option></select></div>
        <button type="submit" class="btn primary block lg" :disabled="saving">{{ saving ? t('of_saving') : t('p_save') }}</button>
      </template>
    </form>
  </div>`,
};

// ------------------------------------------------------------------ money
const MoneyPage = {
  components: { Icon, LoadState, DataTable, Kpis },
  setup() {
    const { s, load } = useLoad(() => call("money"));
    onMounted(load);
    const tab = ref("payments"), allAccounts = ref(false);
    const kpis = computed(() => {
      const m = s.data?.summary; if (!m) return [];
      return [
        { label: t("k_cash"), value: money(m.cash_balance), hint: t("k_cash_hint") },
        { label: t("d_in"), value: money(m.cash_in), hint: t("d_period", date(m.period.from), date(m.period.to)) },
        { label: t("d_out"), value: money(m.cash_out), hint: t("d_period", date(m.period.from), date(m.period.to)) },
        { label: t("k_receivable"), value: money(m.receivable), hint: t("k_receivable_hint"), tone: m.receivable_overdue > 0 ? "danger" : "" },
        { label: t("k_payable"), value: money(m.payable), hint: t("k_payable_hint") },
      ];
    });
    const accounts = computed(() => (s.data?.accounts || []).filter((a) => allAccounts.value || Math.abs(a.balance) > 0.005));
    const hiddenAccounts = computed(() => (s.data?.accounts || []).length - accounts.value.length);
    const payments = computed(() => (s.data?.payments || []).map((p) => ({ ...p, dir: p.payment_type === "Receive" ? "in" : p.payment_type === "Pay" ? "out" : "transfer" })));
    const expenses = computed(() => (s.data?.expenses || []).map((e, i) => ({ ...e, key: e.voucher_no + i })));
    const payCols = [
      { k: "posting_date", label: t("c_date"), type: "date", sort: true }, { k: "party_name", label: t("m_party"), sort: true },
      { k: "dir", label: t("m_direction") }, { k: "mode_of_payment", label: t("p_mode") },
      { k: "name", label: t("c_doc") }, { k: "paid_amount", label: t("p_amount"), type: "money", sort: true, main: true },
    ];
    const expCols = [
      { k: "posting_date", label: t("c_date"), type: "date", sort: true }, { k: "account_name", label: t("m_account"), sort: true },
      { k: "project", label: t("m_project") }, { k: "voucher_no", label: t("c_doc") },
      { k: "amount", label: t("p_amount"), type: "money", sort: true, main: true },
    ];
    const payFilters = [["in", "m_in", (p) => p.dir === "in"], ["out", "m_out", (p) => p.dir === "out"], ["adv", "pay_advance", (p) => p.unallocated_amount > 0]];
    return { s, load, tab, kpis, accounts, hiddenAccounts, allAccounts, payments, expenses, payCols, expCols, payFilters, t, money, date, state, deskLink };
  },
  template: `
  <div class="page">
    <div class="page-head"><div><h1>{{ t('nav_money') }}</h1><div class="sub">{{ t('m_sub') }}</div></div>
      <div class="row" style="gap:8px">
        <button v-if="state.boot.can.payment" type="button" class="btn" @click="state.sheet={type:'payment'}"><Icon name="in" :size="18" style="color:var(--success)"/>{{ t('record_payment') }}</button>
        <button v-if="state.boot.can.expense" type="button" class="btn" @click="state.sheet={type:'expense'}"><Icon name="out" :size="18" style="color:var(--danger)"/>{{ t('record_expense') }}</button></div></div>
    <LoadState :s="s" :rows="3" @retry="load">
      <Kpis :items="kpis"/>
      <div class="alert info" style="margin-bottom:var(--s4)"><Icon name="alert" :size="16"/><span>{{ t('m_separate') }}</span></div>
      <div class="home-grid">
        <section class="card side" aria-labelledby="acc-h">
          <div class="card-h"><h2 id="acc-h">{{ t('m_accounts') }}</h2></div>
          <div v-if="!accounts.length" class="empty">{{ t('m_no_balance') }}</div>
          <div class="list"><div v-for="a in accounts" :key="a.name" class="list-item static">
            <Icon :name="a.account_type==='Cash' ? 'money' : 'invoice'" :size="18" class="muted"/>
            <span class="main-col"><span class="medium ellipsis">{{ a.account_name }}</span><span class="meta">{{ t(a.account_type==='Cash' ? 'm_cash' : 'm_bank') }}</span></span>
            <span class="money medium" :class="{'t-danger': a.balance < 0}">{{ money(a.balance) }}</span></div></div>
          <div v-if="hiddenAccounts || allAccounts" class="card-f"><button type="button" class="btn sm ghost" @click="allAccounts=!allAccounts">
            {{ allAccounts ? t('m_hide_zero') : t('m_show_zero', hiddenAccounts) }}</button></div>
        </section>
        <div class="mainc stack">
          <div class="tabs" role="tablist">
            <button type="button" role="tab" id="tab-payments" :aria-selected="tab==='payments'" @click="tab='payments'">{{ t('m_payments') }}</button>
            <button type="button" role="tab" id="tab-expenses" :aria-selected="tab==='expenses'" @click="tab='expenses'">{{ t('m_expenses') }}</button></div>
          <DataTable v-if="tab==='payments'" :rows="payments" :cols="payCols" row-key="name" :search-keys="['party_name','name','mode_of_payment']" :filters="payFilters" :empty="t('m_no_payments')">
            <template #cell="{row, col}">
              <span v-if="col.k==='dir'" class="badge" :class="row.dir==='in' ? 'b-success' : row.dir==='out' ? 'b-danger' : 'b-info'">
                <Icon :name="row.dir==='out' ? 'out' : 'in'" :size="13"/>{{ t('m_'+row.dir) }}</span>
              <a v-else-if="col.k==='name'" class="num" :href="deskLink('Payment Entry', row.name)">{{ row.name }}</a>
              <template v-else-if="col.k==='mode_of_payment'">{{ (state.boot.modes.find(m=>m.value===row.mode_of_payment)||{}).label || row.mode_of_payment || '—' }}</template>
              <template v-else-if="col.k==='party_name'">{{ row.party_name || row.party || '—' }}<span v-if="row.unallocated_amount>0" class="badge b-info" style="margin-inline-start:6px">{{ t('pay_advance') }}</span></template>
              <span v-else-if="col.type==='money'" class="money" :class="row.dir==='out' ? 't-danger' : ''">{{ money(row[col.k]) }}</span>
              <template v-else>{{ col.type==='date' ? date(row[col.k], true) : row[col.k] }}</template>
            </template>
          </DataTable>
          <DataTable v-else :rows="expenses" :cols="expCols" row-key="key" :search-keys="['account_name','voucher_no','project','remarks']" :empty="t('m_no_expenses')">
            <template #cell="{row, col}">
              <a v-if="col.k==='voucher_no'" class="num" :href="deskLink(row.voucher_type, row.voucher_no)">{{ row.voucher_no }}</a>
              <span v-else-if="col.k==='project'" class="num">{{ row.project || t('m_general') }}</span>
              <span v-else-if="col.type==='money'" class="money">{{ money(row.amount) }}</span>
              <template v-else>{{ col.type==='date' ? date(row[col.k], true) : row[col.k] }}</template>
            </template>
          </DataTable>
        </div>
      </div>
    </LoadState>
  </div>`,
};

// ------------------------------------------------------------------ stock
const StockPage = {
  components: { Icon, LoadState, DataTable, Kpis },
  setup() {
    const { s, load } = useLoad(() => call("stock"));
    onMounted(load);
    const items = computed(() => (s.data?.items || []).map((i) => ({ ...i, available: i.qty - i.reserved })));
    const kpis = computed(() => {
      if (!s.data) return [];
      const k = [
        { label: t("s_items"), value: num(items.value.length), hint: t("s_items_hint"), money: false },
        { label: t("s_low"), value: num(items.value.filter((i) => i.low).length), hint: t("s_low_hint"), money: false, tone: items.value.some((i) => i.low) ? "danger" : "" },
      ];
      if (s.data.can_value) k.push({ label: t("s_value"), value: money(items.value.reduce((a, i) => a + i.value, 0)), hint: t("s_value_hint") });
      return k;
    });
    const cols = computed(() => [
      { k: "item_name", label: t("s_item"), sort: true }, { k: "group", label: t("s_group"), sort: true },
      { k: "qty", label: t("s_qty"), type: "num", sort: true, main: true }, { k: "reserved", label: t("s_reserved"), type: "num" },
      { k: "available", label: t("s_available"), type: "num", sort: true }, { k: "safety_stock", label: t("s_min"), type: "num" },
      ...(s.data?.can_value ? [{ k: "value", label: t("s_value"), type: "money", sort: true }] : []), { k: "low", label: t("s_status") },
    ]);
    const filters = [["low", "s_f_low", (i) => i.low], ["zero", "s_f_zero", (i) => i.qty <= 0]];
    const moveCols = [
      { k: "posting_date", label: t("c_date"), type: "date" }, { k: "item_name", label: t("s_item") },
      { k: "actual_qty", label: t("s_move_qty"), type: "num", main: true }, { k: "voucher_type", label: t("s_move_type") }, { k: "voucher_no", label: t("c_doc") },
    ];
    const moves = computed(() => (s.data?.moves || []).map((m, i) => ({ ...m, key: m.voucher_no + i })));
    const vt = (v) => t({ "Stock Entry": "s_vt_entry", "Purchase Receipt": "s_vt_receipt", "Delivery Note": "dt_delivery_note", "Stock Reconciliation": "s_vt_recon", "Purchase Invoice": "s_vt_pinv" }[v] || v);
    return { s, load, items, kpis, cols, filters, moveCols, moves, vt, t, num, money, date, deskLink, signed: (v) => LRI + (v > 0 ? "+" : "") + nfq.format(v) + PDI };
  },
  template: `
  <div class="page">
    <div class="page-head"><div><h1>{{ t('nav_stock') }}</h1><div class="sub">{{ t('s_sub') }}</div></div>
      <div class="row" style="gap:8px"><a class="btn" href="/app/stock-entry/new"><Icon name="box" :size="18"/>{{ t('s_new_entry') }}</a>
        <a class="btn" href="/app/purchase-receipt/new"><Icon name="in" :size="18" style="color:var(--success)"/>{{ t('s_new_receipt') }}</a></div></div>
    <LoadState :s="s" :rows="4" @retry="load">
      <Kpis :items="kpis"/>
      <div class="stack">
        <DataTable :rows="items" :cols="cols" row-key="item_code" :search-keys="['item_name','item_code','group']" :filters="filters" :title="t('s_items')" initial-sort="item_name" :empty="t('s_none')">
          <template #cell="{row, col}">
            <span v-if="col.k==='item_name'" class="title-cell"><a :href="deskLink('Item', row.item_code)" class="medium clamp2">{{ row.item_name }}</a>
              <span class="cap num">{{ row.item_code }}<template v-if="row.warehouses.length"> · {{ row.warehouses.map(w => w.warehouse.replace(/ - [^-]+$/, '')).join('، ') }}</template></span></span>
            <span v-else-if="col.k==='low'" class="badge" :class="row.low ? 'b-danger' : row.qty<=0 ? 'b-warning' : 'b-success'">
              <Icon :name="row.low ? 'alert' : 'check'" :size="13"/>{{ row.low ? t('s_low_badge') : row.qty<=0 ? t('s_f_zero') : t('s_ok') }}</span>
            <span v-else-if="col.type==='num'" class="num" :class="{'t-danger': col.k==='qty' && row.low}">{{ num(row[col.k]) }} <span v-if="['qty','available'].includes(col.k)" class="cap">{{ row.uom }}</span></span>
            <span v-else-if="col.type==='money'" class="money">{{ money(row[col.k]) }}</span>
            <template v-else>{{ row[col.k] }}</template>
          </template>
        </DataTable>
        <DataTable :rows="moves" :cols="moveCols" row-key="key" :title="t('s_moves')" :empty="t('s_no_moves')">
          <template #cell="{row, col}">
            <span v-if="col.k==='actual_qty'" class="num medium" :class="row.actual_qty<0 ? 't-danger' : 't-success'">{{ signed(row.actual_qty) }}</span>
            <template v-else-if="col.k==='voucher_type'">{{ vt(row.voucher_type) }}</template>
            <a v-else-if="col.k==='voucher_no'" class="num" :href="deskLink(row.voucher_type, row.voucher_no)">{{ row.voucher_no }}</a>
            <template v-else-if="col.type==='date'">{{ date(row.posting_date, true) }}</template>
            <template v-else>{{ row[col.k] }}</template>
          </template>
        </DataTable>
        <div class="hint">{{ t('s_note') }}</div>
      </div>
    </LoadState>
  </div>`,
};

// ------------------------------------------------------------------ machines
const MachinesPage = {
  components: { Icon, LoadState, DataTable },
  setup() {
    const { s, load } = useLoad(() => call("machines"));
    onMounted(load);
    const cols = [
      { k: "asset_name", label: t("mc_name"), sort: true }, { k: "status", label: t("mc_status") }, { k: "location", label: t("mc_location") },
      { k: "purchase_date", label: t("mc_bought"), type: "date", sort: true }, { k: "gross_purchase_amount", label: t("mc_cost"), type: "money" },
      { k: "value_after_depreciation", label: t("mc_value"), type: "money", main: true },
    ];
    const taskCols = [
      { k: "asset_name", label: t("mc_name") }, { k: "maintenance_task", label: t("mc_task") },
      { k: "next_due_date", label: t("mc_next"), type: "date", sort: true, main: true }, { k: "periodicity", label: t("mc_every") },
    ];
    const tasks = computed(() => (s.data?.tasks || []).map((x, i) => ({ ...x, key: i })));
    return { s, load, cols, taskCols, tasks, t, money, deskLink, daysFromToday, date };
  },
  template: `
  <div class="page">
    <div class="page-head"><div><h1>{{ t('nav_machines') }}</h1><div class="sub">{{ t('mc_sub') }}</div></div>
      <div class="row" style="gap:8px"><a class="btn primary" href="/app/asset/new"><Icon name="plus" :size="18"/>{{ t('mc_add') }}</a>
        <a class="btn" href="/app/asset-repair/new"><Icon name="gear" :size="18"/>{{ t('mc_repair') }}</a></div></div>
    <LoadState :s="s" :rows="3" @retry="load">
      <section v-if="!s.data.assets.length" class="card"><div class="empty" style="padding:var(--s6) var(--s4)">
        <Icon name="gear" :size="30" class="muted"/><span class="medium" style="color:var(--ink)">{{ t('mc_none') }}</span>
        <span class="meta" style="max-width:520px">{{ t('mc_none_hint') }}</span>
        <a class="btn primary" href="/app/asset/new" style="margin-top:var(--s3)"><Icon name="plus" :size="18"/>{{ t('mc_add') }}</a></div></section>
      <div v-else class="stack">
        <DataTable :rows="s.data.assets" :cols="cols" row-key="name" :search-keys="['asset_name','item_name','location']" :title="t('nav_machines')">
          <template #cell="{row, col}">
            <span v-if="col.k==='asset_name'" class="title-cell"><a :href="deskLink('Asset', row.name)" class="medium">{{ row.asset_name }}</a><span class="cap num">{{ row.name }}</span></span>
            <span v-else-if="col.type==='money'" class="money">{{ money(row[col.k]) }}</span>
            <template v-else-if="col.type==='date'">{{ date(row[col.k], true) }}</template>
            <template v-else>{{ row[col.k] || '—' }}</template>
          </template>
        </DataTable>
      </div>
      <div class="stack" style="margin-top:var(--s4)">
        <DataTable :rows="tasks" :cols="taskCols" row-key="key" :title="t('mc_tasks')" :empty="t('mc_no_tasks')" initial-sort="next_due_date">
          <template #cell="{row, col}">
            <span v-if="col.k==='next_due_date'" :class="row.next_due_date && daysFromToday(row.next_due_date) < 0 ? 't-danger medium' : ''">{{ date(row.next_due_date, true) }}</span>
            <template v-else>{{ row[col.k] || '—' }}</template>
          </template>
        </DataTable>
        <div class="hint">{{ t('mc_note') }}</div>
      </div>
    </LoadState>
  </div>`,
};

// ------------------------------------------------------------------ reports
const ReportsPage = {
  components: { Icon, LoadState, DataTable, Kpis },
  setup() {
    const { s, load } = useLoad(() => call("reports"));
    onMounted(load);
    const rows = computed(() => (s.data?.orders || []).map((o) => ({ ...o, margin_sort: o.est_margin ?? -1e15, result_sort: o.result ?? -1e15 })));
    const kpis = computed(() => {
      const r = rows.value, done = r.filter((o) => o.result !== null);
      return [
        { label: t("r_orders"), value: num(r.length), hint: t("r_orders_hint"), money: false },
        { label: t("r_revenue"), value: money(done.reduce((a, o) => a + o.revenue, 0)), hint: t("r_revenue_hint") },
        { label: t("r_result"), value: money(done.reduce((a, o) => a + o.result, 0)), hint: t("r_result_hint", done.length) },
      ];
    });
    const cols = [
      { k: "atelier_subject", label: t("col_order"), sort: true }, { k: "atelier_stage", label: t("col_stage") },
      { k: "margin_sort", label: t("r_est_margin"), type: "money", sort: true }, { k: "revenue", label: t("r_revenue"), type: "money", sort: true },
      { k: "cost", label: t("r_cost"), type: "money" }, { k: "result_sort", label: t("r_actual"), type: "money", sort: true, main: true },
    ];
    const filters = [["done", "r_f_billed", (o) => o.result !== null], ["open", "r_f_open", (o) => o.result === null], ["missing", "r_f_missing", (o) => o.est_missing > 0 || o.est_cost === null]];
    const reportLink = (o) => `/app/query-report/Rentabilite Commande?project=${encodeURIComponent(o.project)}`;
    return { s, load, rows, kpis, cols, filters, reportLink, t, money, go };
  },
  template: `
  <div class="page">
    <div class="page-head"><div><h1>{{ t('nav_reports') }}</h1><div class="sub">{{ t('r_sub') }}</div></div>
      <div class="row wrap" style="gap:8px">
        <a class="btn" href="/app/query-report/Profit and Loss Statement"><Icon name="ext" :size="16"/>{{ t('r_pl') }}</a>
        <a class="btn" href="/app/query-report/Accounts Receivable"><Icon name="ext" :size="16"/>{{ t('r_ar') }}</a></div></div>
    <LoadState :s="s" :rows="4" @retry="load">
      <Kpis :items="kpis"/>
      <div class="alert info" style="margin-bottom:var(--s4)"><Icon name="alert" :size="16"/><span>{{ t('r_explain') }}</span></div>
      <DataTable :rows="rows" :cols="cols" row-key="name" :search-keys="['atelier_subject','customer_name','name']" :filters="filters" :title="t('r_title')" :empty="t('orders_none')">
        <template #cell="{row, col}">
          <span v-if="col.k==='atelier_subject'" class="title-cell"><a :href="'/atelier/orders/'+row.name" @click.prevent="go('/orders/'+encodeURIComponent(row.name))" class="medium clamp2">{{ row.atelier_subject || row.name }}</a>
            <span class="cap">{{ row.customer_name }} · <a :href="reportLink(row)">{{ t('r_detail') }}</a></span></span>
          <template v-else-if="col.k==='margin_sort'"><span v-if="row.est_margin!==null" class="money">{{ money(row.est_margin) }}</span>
            <span v-else class="cap">{{ row.est_cost===null ? t('why_margin_none') : t('why_margin_price') }}</span>
            <div v-if="row.est_missing" class="cap t-warning">{{ t('r_missing', row.est_missing) }}</div></template>
          <template v-else-if="col.k==='result_sort'"><span v-if="row.result!==null" class="money medium" :class="row.result<0 ? 't-danger' : 't-success'">{{ money(row.result) }}</span>
            <span v-else class="cap">{{ t('r_not_billed') }}</span></template>
          <template v-else-if="col.type==='money'"><span v-if="row[col.k]" class="money">{{ money(row[col.k]) }}</span><span v-else class="cap">—</span>
            <div v-if="col.k==='cost' && row.internal" class="cap">{{ t('r_internal', money(row.internal)) }}</div></template>
          <template v-else>{{ row[col.k] || '—' }}</template>
        </template>
      </DataTable>
    </LoadState>
  </div>`,
};

// ------------------------------------------------------------------ services & prices
const PricesPage = {
  components: { Icon, LoadState, DataTable },
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
    <div class="page-head"><div><h1>{{ t('nav_prices') }}</h1><div class="sub">{{ t('pr_sub') }}</div></div>
      <button v-if="s.data && s.data.can_edit" type="button" class="btn primary" @click="state.sheet={type:'item'}"><Icon name="plus" :size="18"/>{{ t('pr_new_service') }}</button></div>
    <LoadState :s="s" :rows="4" @retry="load">
      <div class="alert info" style="margin-bottom:var(--s4)"><Icon name="tag" :size="16"/><span>{{ t('pr_explain') }}</span></div>
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
const ITEM_UNITS = ["قطعة", "ورقة", "م²", "متر", "ساعة", "علبة"];
const ItemSheet = {
  props: ["opts"], components: { Icon },
  setup() {
    const f = reactive({ item_name: "", kind: "service", uom: "قطعة", price_individual: "", price_company: "", description: "" });
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
    return { f, saving, error, attempted, errs, save, close, ITEM_UNITS, t };
  },
  template: `
  <div class="overlay" @click.self="close" role="dialog" aria-modal="true" aria-labelledby="is-h">
    <form class="sheet wide" novalidate @submit.prevent="save">
      <div class="row"><h2 id="is-h" style="flex:1">{{ t('pr_new_service') }}</h2><button type="button" class="btn ghost icon-btn" :aria-label="t('close')" @click="close"><Icon name="x"/></button></div>
      <div v-if="error" class="alert error" role="alert"><Icon name="alert" :size="16"/><span>{{ error }}</span></div>
      <div class="seg" role="group" :aria-label="t('it_kind')">
        <button type="button" :aria-pressed="f.kind==='service'" @click="f.kind='service'">{{ t('it_service') }}</button>
        <button type="button" :aria-pressed="f.kind==='product'" @click="f.kind='product'">{{ t('it_product') }}</button></div>
      <span class="hint">{{ f.kind==='service' ? t('it_service_hint') : t('it_product_hint') }}</span>
      <div class="field"><label for="is-name" class="req">{{ t('it_name') }}</label>
        <input id="is-name" class="input" :class="{invalid: attempted && errs.item_name}" type="text" v-model="f.item_name" :placeholder="t('it_name_ph')" autocomplete="off">
        <span v-if="attempted && errs.item_name" class="error-text">{{ errs.item_name }}</span></div>
      <div class="field"><span class="label">{{ t('it_unit') }}</span>
        <div class="chips" role="group" :aria-label="t('it_unit')"><button v-for="u in ITEM_UNITS" :key="u" type="button" class="chip" :aria-pressed="f.uom===u" @click="f.uom=u">{{ u }}</button></div></div>
      <div class="grid-2">
        <div class="field"><label for="is-pi">{{ t('pr_individual_prices') }} ({{ t('currency') }})</label>
          <input id="is-pi" class="input num" type="text" inputmode="decimal" autocomplete="off" v-model="f.price_individual" :placeholder="t('it_price_ph')"></div>
        <div class="field"><label for="is-pc">{{ t('pr_company_prices') }} ({{ t('currency') }})</label>
          <input id="is-pc" class="input num" type="text" inputmode="decimal" autocomplete="off" v-model="f.price_company" :placeholder="t('it_price_ph')"></div>
      </div>
      <span v-if="attempted && errs.price" class="error-text">{{ errs.price }}</span>
      <div class="field"><label for="is-desc">{{ t('it_desc') }} <span class="cap">({{ t('optional') }})</span></label>
        <input id="is-desc" class="input" type="text" v-model="f.description" :placeholder="t('of_desc_ph')"></div>
      <button type="submit" class="btn primary block lg" :disabled="saving">{{ saving ? t('of_saving') : t('it_save') }}</button>
    </form>
  </div>`,
};

// ------------------------------------------------------------------ design system reference (/atelier/ds)
const DS_COLORS = [
  ["--primary", "الرئيسي"], ["--primary-weak", "الرئيسي الفاتح"], ["--accent", "علامة (ليموني)"], ["--nav-bg", "القائمة"],
  ["--ink", "النص"], ["--ink-3", "النص الثانوي"], ["--bg", "الخلفية"], ["--line", "الحدود"],
  ["--success", "نجاح"], ["--warning", "تحذير"], ["--danger", "خطر"], ["--info", "معلومة"],
];
const StyleGuide = {
  components: { Icon },
  setup() {
    const css = getComputedStyle(document.documentElement);
    const colors = DS_COLORS.map(([v, l]) => ({ v, l, hex: css.getPropertyValue(v).trim() }));
    const seg = ref("Individual"), chip = ref("all"), check = ref(true);
    return { colors, seg, chip, check, t, money };
  },
  template: `
  <div class="page">
    <div class="page-head"><div><h1>{{ t('ds_title') }}</h1><div class="sub">{{ t('ds_sub') }}</div></div></div>
    <div class="stack" style="gap:var(--s5)">
      <section class="card"><div class="card-h"><h2>{{ t('ds_colors') }}</h2></div><div class="card-b">
        <div class="ds-swatches"><div v-for="c in colors" :key="c.v" class="ds-swatch">
          <div class="chip-color" :style="{background: 'var(' + c.v + ')'}"></div>
          <div class="lbl"><div class="medium">{{ c.l }}</div><div class="cap num" dir="ltr">{{ c.hex }}</div></div></div></div>
      </div></section>

      <section class="card"><div class="card-h"><h2>{{ t('ds_type') }}</h2></div><div class="card-b ds-type">
        <h1>كل طلب، في وقته. — 26</h1><h2>عنوان قسم — 17</h2>
        <p style="font-size:var(--fs-body)">نص أساسي — 15. الخط IBM Plex Sans Arabic بثلاثة أوزان.</p>
        <p style="font-size:var(--fs-table)">نص الجداول — 14</p><p class="meta">نص ثانوي — 13</p><p class="cap">تعليق — 12</p>
        <p><span class="money big">28,000.00 دج</span> · {{ t('ds_money_rule') }}</p>
      </div></section>

      <section class="card"><div class="card-h"><h2>{{ t('ds_buttons') }}</h2></div><div class="card-b stack">
        <div class="ds-row">
          <button type="button" class="btn primary"><Icon name="plus" :size="18"/>طلب جديد</button>
          <button type="button" class="btn">تسجيل دفعة</button>
          <button type="button" class="btn ghost">إلغاء</button>
          <button type="button" class="btn sm">زر صغير</button>
          <button type="button" class="btn primary" disabled>غير متاح</button>
          <button type="button" class="btn ghost icon-btn" aria-label="حذف"><Icon name="trash" :size="18"/></button>
        </div>
      </div></section>

      <section class="card"><div class="card-h"><h2>{{ t('ds_inputs') }}</h2></div><div class="card-b">
        <div class="grid-2">
          <div class="field"><label for="ds-a" class="req">اسم العميل</label><input id="ds-a" class="input" placeholder="مثال: مؤسسة النور"></div>
          <div class="field"><label for="ds-b">المبلغ (دج)</label><input id="ds-b" class="input num" inputmode="decimal" placeholder="0.00"></div>
          <div class="field"><label for="ds-c">حقل خاطئ</label><input id="ds-c" class="input invalid" aria-invalid="true" value="—"><span class="error-text">اكتب اسم العميل</span></div>
          <div class="field"><label for="ds-d">قائمة</label><select id="ds-d" class="input"><option>نقدًا</option><option>تحويل بنكي</option></select></div>
        </div>
        <div class="ds-row" style="margin-top:var(--s4)">
          <div class="seg" role="group" aria-label="النوع"><button type="button" :aria-pressed="seg==='Individual'" @click="seg='Individual'">فرد</button><button type="button" :aria-pressed="seg==='Company'" @click="seg='Company'">مؤسسة</button></div>
          <div class="chips" role="group" aria-label="تصفية"><button v-for="c in [['all','الكل 7'],['late','متأخرة 1'],['soon','خلال 3 أيام 3']]" :key="c[0]" type="button" class="chip" :aria-pressed="chip===c[0]" @click="chip=c[0]">{{ c[1] }}</button></div>
          <label class="check"><input type="checkbox" v-model="check">خانة اختيار</label>
        </div>
      </div></section>

      <section class="card"><div class="card-h"><h2>{{ t('ds_status') }}</h2></div><div class="card-b stack">
        <div class="ds-row">
          <span class="badge b-success"><Icon name="check" :size="13"/>مدفوع</span>
          <span class="badge b-warning"><Icon name="tag" :size="13"/>بانتظار التسعير</span>
          <span class="badge b-danger"><Icon name="alert" :size="13"/>متأخر</span>
          <span class="badge b-info"><Icon name="invoice" :size="13"/>مفوتر جزئيًا</span>
          <span class="badge b-neutral">مسودة</span>
        </div>
        <div class="alert info"><Icon name="alert" :size="16"/><span>معلومة: التسبيق ليس ربحًا.</span></div>
        <div class="alert warn"><Icon name="tag" :size="16"/><span>تنبيه: الإجمالي النهائي لم يكتمل.</span></div>
        <div class="alert error"><Icon name="alert" :size="16"/><span>خطأ: راجع الحقول المشار إليها.</span></div>
        <div class="alert success"><Icon name="check" :size="16"/><span>تم: حُفظ الطلب.</span></div>
        <p class="hint">{{ t('ds_status_rule') }}</p>
      </div></section>

      <section class="card"><div class="card-h"><h2>{{ t('ds_data') }}</h2></div>
        <div class="card-b"><div class="kpis static">
          <div class="kpi"><span class="k-label">السيولة الآن</span><span class="k-value money">{{ money(74800) }}</span><span class="k-hint">الصندوق والبنك</span></div>
          <div class="kpi tone-danger"><span class="k-label">مستحقات العملاء</span><span class="k-value money">{{ money(18000) }}</span><span class="k-hint">فواتير لم تُدفع</span></div>
        </div></div>
        <div class="table-wrap"><table class="t">
          <thead><tr><th>الطلب</th><th>المرحلة</th><th class="n">المبلغ</th></tr></thead>
          <tbody><tr><td><div class="medium">500 بطاقة زيارة</div><div class="cap">مؤسسة النور</div></td><td><span class="badge b-info">طباعة</span></td><td class="n"><span class="money">{{ money(8000) }}</span></td></tr>
            <tr><td><div class="medium">لافتة 3×1 م</div><div class="cap">مخبزة السعادة</div></td><td><span class="badge b-danger">متأخر</span></td><td class="n"><span class="money">{{ money(18000) }}</span></td></tr></tbody>
        </table></div>
      </section>
    </div>
  </div>`,
};

// ------------------------------------------------------------------ more (phone)
const MorePage = {
  components: { Icon },
  setup() { return { t, go, SECTION_NAV, state }; },
  template: `
  <div class="page"><div class="page-head"><h1>{{ t('nav_more') }}</h1></div>
    <section class="card"><div class="list">
      <a v-for="n in SECTION_NAV.filter(n => !n.need || state.boot.can[n.need])" :key="n.key" class="list-item" :href="'/atelier'+n.path" @click.prevent="go(n.path)"><Icon :name="n.icon" class="muted"/>
        <span class="main-col"><span class="medium">{{ t(n.label) }}</span></span><Icon name="chev" :size="16" class="muted"/></a>
    </div></section></div>`,
};


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
      <div class="row"><h2 id="exp-h" style="flex:1">{{ t('e_title') }}</h2><button type="button" class="btn ghost icon-btn" :aria-label="t('close')" @click="close"><Icon name="x"/></button></div>
      <template v-if="done">
        <div class="alert success"><Icon name="check" :size="16"/><span>{{ t('e_done', done.name) }}<template v-if="done.project"> · {{ t('e_on_order') }}</template><template v-if="done.receipt"> · {{ t('e_receipt_saved') }}</template></span></div>
        <div v-if="uploadWarn" class="alert warn" role="alert"><Icon name="alert" :size="16"/><span>{{ uploadWarn }}</span></div>
        <div class="row wrap"><button type="button" class="btn primary" @click="again">{{ t('e_another') }}</button>
          <a class="btn" :href="'/app/journal-entry/'+encodeURIComponent(done.name)">{{ t('ov_open_erp') }}</a>
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
            <div v-if="frequent.length" class="chips" role="group" :aria-label="t('e_frequent')">
              <button v-for="a in frequent" :key="a.name" type="button" class="chip" @click="pick(a)">{{ a.account_name }}</button></div>
            <input id="e-q" class="input" :class="{invalid: attempted && errs.account}" type="search" v-model="q" :placeholder="t('e_account_ph')" autocomplete="off">
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
        <button type="submit" class="btn primary block lg" :disabled="saving">{{ saving ? t('of_saving') : t('e_save') }}</button>
      </template>
    </form>
  </div>`,
};

// ------------------------------------------------------------------ shell
const NAV = [
  { key: "home", path: "/", icon: "home", label: "nav_home", match: ["home"] },
  { key: "orders", path: "/orders", icon: "orders", label: "nav_orders", match: ["order", "order-new", "orders"] },
  { key: "customers", path: "/customers", icon: "users", label: "nav_customers", match: ["customer", "customers"] },
];
const SECTION_NAV = [
  { key: "money", path: "/money", icon: "money", label: "nav_money", match: ["money"], need: "finance" },
  { key: "stock", path: "/stock", icon: "box", label: "nav_stock", match: ["stock"] },
  { key: "machines", path: "/machines", icon: "gear", label: "nav_machines", match: ["machines"] },
  { key: "prices", path: "/prices", icon: "tag", label: "nav_prices", match: ["prices"], need: "prices" },
  { key: "reports", path: "/reports", icon: "chart", label: "nav_reports", match: ["reports"], need: "finance" },
];

const App = {
  components: { Icon, SearchBox, Home, OrdersPage, OrderNew, OrderView, CustomerView, CustomerList, PaymentSheet, ExpenseSheet, CustomerSheet, ItemSheet, MoneyPage, StockPage, MachinesPage, ReportsPage, MorePage, PricesPage, StyleGuide },
  setup() {
    const bootErr = ref(null);
    const loadBoot = async () => {
      bootErr.value = null;
      try { state.boot = await call("boot"); } catch (e) { bootErr.value = e.message; }
    };
    onMounted(async () => {
      await loadBoot();
      if (state.query.get("action") === "payment" && state.boot?.can.payment) state.sheet = { type: "payment" };
      if (state.query.get("action") === "expense" && state.boot?.can.expense) state.sheet = { type: "expense" };
      if ("serviceWorker" in navigator) navigator.serviceWorker.register("/atelier-sw.js", { scope: "/atelier" }).catch(() => {});
    });
    const isActive = (n) => n.match.includes(route.value.name);
    const titles = { "order-new": "of_title", customer: "c_title", customers: "c_title", order: "nav_orders", orders: "orders_title",
      money: "nav_money", stock: "nav_stock", machines: "nav_machines", reports: "nav_reports", more: "nav_more", prices: "nav_prices" };
    const back = () => (history.length > 1 ? history.back() : go("/"));
    return { state, route, NAV, SECTION_NAV, isActive, bootErr, loadBoot, t, go, titles, back };
  },
  template: `
  <div v-if="bootErr" class="page"><div class="alert error" role="alert"><span style="flex:1">{{ bootErr }}</span><button class="btn sm" @click="loadBoot">{{ t('retry') }}</button></div></div>
  <div v-else-if="!state.boot" class="boot">{{ t('loading') }}</div>
  <div v-else class="shell" :class="{editing: state.editing}">
    <a href="#main" class="skip">{{ t('skip') }}</a>
    <nav class="sidebar" :class="{collapsed: state.collapsed}" :aria-label="t('app_name')">
      <div class="brand"><img src="/assets/atelier/atelier/icon.svg" alt=""><span class="name">{{ t('app_name') }}<small>{{ t('app_tagline') }}</small></span>
        <button type="button" class="btn ghost sm icon-btn collapse-btn" :aria-label="state.collapsed ? t('expand') : t('collapse')" :title="state.collapsed ? t('expand') : t('collapse')"
          :aria-expanded="!state.collapsed" @click="state.collapsed=!state.collapsed"><Icon name="panel" :size="18"/></button></div>
      <div class="group">{{ t('nav_group_daily') }}</div>
      <a v-for="n in NAV" :key="n.key" class="nav" :class="{active: isActive(n)}" :href="'/atelier'+(n.path==='/'?'':n.path)" @click.prevent="go(n.path)"
        :aria-current="isActive(n) ? 'page' : null" :title="state.collapsed ? t(n.label) : null"><Icon :name="n.icon"/><span class="lbl">{{ t(n.label) }}</span></a>
      <div class="sep"></div>
      <div class="group">{{ t('nav_group_sections') }}</div>
      <a v-for="n in SECTION_NAV.filter(n => !n.need || state.boot.can[n.need])" :key="n.key" class="nav" :class="{active: isActive(n)}" :href="'/atelier'+n.path" @click.prevent="go(n.path)"
        :aria-current="isActive(n) ? 'page' : null" :title="state.collapsed ? t(n.label) : null"><Icon :name="n.icon"/><span class="lbl">{{ t(n.label) }}</span></a>
      <div class="spacer"></div>
      <div class="cap who" style="padding:6px 12px">{{ state.boot.full_name }}</div>
    </nav>

    <div class="main">
      <div v-if="state.boot.is_demo" class="demo-banner" role="note"><Icon name="alert" :size="15"/>{{ t('demo_banner') }}</div>
      <div v-if="!state.online" class="alert warn" role="status" style="border-radius:0"><Icon name="wifi" :size="16"/>{{ t('offline') }}</div>
      <header class="topbar">
        <button type="button" v-if="route.name!=='home'" class="btn ghost icon-btn mobile-only" :aria-label="t('back')" @click="back"><Icon name="back"/></button>
        <span v-if="route.name!=='home'" class="title mobile-only ellipsis">{{ t(titles[route.name] || 'app_name') }}</span>
        <SearchBox :class="{'desktop-only': route.name!=='home'}"/>
        <span class="cap desktop-only"><kbd>Ctrl</kbd> + <kbd>K</kbd></span>
        <div class="spacer desktop-only"></div>
        <div v-if="route.name==='home'" class="row desktop-only" style="gap:8px">
          <a class="btn primary" href="/atelier/orders/new" @click.prevent="go('/orders/new')"><Icon name="plus" :size="18"/>{{ t('new_order') }}</a>
          <button v-if="state.boot.can.payment" class="btn" @click="state.sheet={type:'payment'}"><Icon name="in" :size="18" style="color:var(--success)"/>{{ t('record_payment') }}</button>
          <button v-if="state.boot.can.expense" type="button" class="btn" @click="state.sheet={type:'expense'}"><Icon name="out" :size="18" style="color:var(--danger)"/>{{ t('record_expense') }}</button>
        </div>
      </header>
      <main id="main" tabindex="-1" style="outline:none">
        <Home v-if="route.name==='home'" :key="state.path"/>
        <OrdersPage v-else-if="route.name==='orders'"/>
        <OrderNew v-else-if="route.name==='order-new'" :key="state.path + state.query"/>
        <OrderView v-else-if="route.name==='order'" :id="route.id" :key="route.id"/>
        <CustomerView v-else-if="route.name==='customer'" :id="route.id" :key="route.id + ':' + state.rev"/>
        <CustomerList v-else-if="route.name==='customers'"/>
        <MoneyPage v-else-if="route.name==='money'"/>
        <StockPage v-else-if="route.name==='stock'"/>
        <MachinesPage v-else-if="route.name==='machines'"/>
        <ReportsPage v-else-if="route.name==='reports'"/>
        <MorePage v-else-if="route.name==='more'"/>
        <PricesPage v-else-if="route.name==='prices'"/>
        <StyleGuide v-else-if="route.name==='ds'"/>
      </main>
    </div>

    <nav class="bottom-nav" :aria-label="t('app_name')">
      <a href="/atelier" :class="{active: route.name==='home'}" @click.prevent="go('/')"><Icon name="home"/>{{ t('nav_home') }}</a>
      <a href="/atelier/orders" :class="{active: ['orders','order'].includes(route.name)}" @click.prevent="go('/orders')"><Icon name="orders"/>{{ t('nav_orders') }}</a>
      <a class="fab" href="/atelier/orders/new" @click.prevent="go('/orders/new')"><span class="fab-circle"><Icon name="plus" :size="22"/></span><span class="lbl">{{ t('new_order') }}</span></a>
      <a href="/atelier/customers" :class="{active: ['customer','customers'].includes(route.name)}" @click.prevent="go('/customers')"><Icon name="users"/>{{ t('nav_customers') }}</a>
      <a href="/atelier/more" :class="{active: ['more','money','stock','machines','reports','prices'].includes(route.name)}" @click.prevent="go('/more')"><Icon name="more"/>{{ t('nav_more') }}</a>
    </nav>

    <PaymentSheet v-if="state.sheet && state.sheet.type==='payment'" :opts="state.sheet"/>
    <ExpenseSheet v-if="state.sheet && state.sheet.type==='expense'" :opts="state.sheet"/>
    <CustomerSheet v-if="state.sheet && state.sheet.type==='customer'" :opts="state.sheet"/>
    <ItemSheet v-if="state.sheet && state.sheet.type==='item'" :opts="state.sheet"/>
    <div v-if="state.toast" class="toast" role="status" aria-live="polite"><div class="alert" :class="state.toast.kind"><Icon :name="state.toast.kind==='error' ? 'alert' : 'check'" :size="16"/>{{ state.toast.message }}</div></div>
  </div>`,
};

createApp(App).mount("#app");
