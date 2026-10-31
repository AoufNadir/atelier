// Atelier daily app — Vue 3 (vendored, no build step) on top of the ERPNext API (atelier.api).
import { createApp, reactive, ref, computed, watch, onMounted, onBeforeUnmount, h } from "./vendor/vue.esm-browser.prod.js";
// Strings follow the app's cache-busting version (?v=…) so text updates are never stale.
const { default: STR } = await import(`./i18n/ar.js${new URL(import.meta.url).search}`);

const BASE = "/atelier";

// ------------------------------------------------------------------ i18n & formatting
const t = (k, ...a) => String(STR[k] ?? k).replace(/\{(\d)\}/g, (_, i) => a[i] ?? "");
// Numbers: Latin digits, space as thousands separator, comma decimals (usage in Algeria).
const nf = new Intl.NumberFormat("fr-DZ", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const num = (v) => (v === null || v === undefined || v === "" ? "—" : nf.format(Number(v)));
const money = (v) => (v === null || v === undefined ? "—" : `${nf.format(Math.round(Number(v) * 100) / 100)} ${t("currency")}`);
const df = new Intl.DateTimeFormat("ar-DZ-u-nu-latn", { day: "numeric", month: "long" });
const dfy = new Intl.DateTimeFormat("ar-DZ-u-nu-latn", { day: "numeric", month: "long", year: "numeric" });
const dfw = new Intl.DateTimeFormat("ar-DZ-u-nu-latn", { weekday: "long", day: "numeric", month: "long" });
const parseDate = (s) => (s ? new Date(String(s).slice(0, 10) + "T00:00:00") : null);
const date = (s, withYear) => (s ? (withYear ? dfy : df).format(parseDate(s)) : "—");
const todayISO = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = parseDate(iso); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const daysFromToday = (iso) => Math.round((parseDate(iso) - parseDate(todayISO())) / 86400000);
const fileSize = (b) => (!b ? "" : b < 1024 * 1024 ? `${Math.ceil(b / 1024)} ك.ب` : `${(b / 1048576).toFixed(1)} م.ب`);

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
  boot: null, toast: null, sheet: null, online: navigator.onLine, keyboard: false,
});
function go(path) {
  const full = path.startsWith("/desk") || path.startsWith("/app/") ? path : BASE + (path === "/" ? "" : path);
  if (path.startsWith("/desk") || path.startsWith("/app/")) { location.href = full.replace(/^\/desk/, "/app"); return; }
  history.pushState({}, "", full);
  state.path = location.pathname; state.query = new URLSearchParams(location.search);
  window.scrollTo(0, 0);
}
window.addEventListener("popstate", () => { state.path = location.pathname; state.query = new URLSearchParams(location.search); });
window.addEventListener("online", () => (state.online = true));
window.addEventListener("offline", () => (state.online = false));
if (window.visualViewport) {
  // Mobile keyboard: hide the bottom navigation so the focused field and the save button stay visible.
  const onVV = () => {
    state.keyboard = window.visualViewport.height < window.innerHeight * 0.75;
    document.body.classList.toggle("keyboard-open", state.keyboard);
  };
  window.visualViewport.addEventListener("resize", onVV);
}
let toastTimer;
// Numeric fields are text + decimal keypad (browsers localise type=number to Arabic-Indic digits).
// Normalise before Vue reads the value: ٠-٩ / ۰-۹ → 0-9, Arabic or French decimal comma → ".", spaces dropped.
document.addEventListener("input", (e) => {
  const el = e.target;
  if (!(el instanceof HTMLInputElement) || el.inputMode !== "decimal") return;
  const v = el.value.replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x660).replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 0x6f0)
    .replace(/[٫,]/g, ".").replace(/[\s  ٬]/g, "").replace(/[^\d.]/g, "");
  if (v !== el.value) el.value = v;
}, true);

function toast(message, kind = "success") {
  state.toast = { message, kind }; clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (state.toast = null), 4000);
}
const route = computed(() => {
  const p = state.path.replace(/^\/atelier/, "").replace(/\/$/, "") || "/";
  let m;
  if (p === "/") return { name: "home" };
  if (p === "/orders/new") return { name: "order-new" };
  if ((m = p.match(/^\/orders\/(.+)$/))) return { name: "order", id: decodeURIComponent(m[1]) };
  if (p === "/orders") return { name: "orders" };
  if ((m = p.match(/^\/customers\/(.+)$/))) return { name: "customer", id: decodeURIComponent(m[1]) };
  if (p === "/customers") return { name: "customers" };
  return { name: "home" };
});

// ------------------------------------------------------------------ icons (inline stroke SVG)
const ICONS = {
  home: "M3 11 12 4l9 7M5 10v10h5v-6h4v6h5V10",
  orders: "M7 4h10l3 3v13H4V4h3Zm0 0v4h10V4M8 13h8M8 17h5",
  users: "M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6M21 19v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8",
  money: "M3 6h18v12H3zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M6 9v.01M18 15v.01",
  box: "M21 8 12 3 3 8v8l9 5 9-5V8ZM3 8l9 5 9-5M12 13v8",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  plus: "M12 5v14M5 12h14",
  in: "M12 19V5M6 11l6-6 6 6",
  out: "M12 5v14M6 13l6 6 6-6",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM21 21l-4.3-4.3",
  back: "M9 6l6 6-6 6",
  chev: "M15 6l-6 6 6 6",
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
};
const Icon = (props) => h("svg", { width: props.size || 20, height: props.size || 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
  "stroke-width": 1.9, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: props.class },
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

// order status helpers (execution stage ≠ billing ≠ payment)
function billing(o) {
  if (o.docstatus === 0) return { cls: "b-neutral", icon: "file", label: t("draft") };
  if (o.per_billed >= 100) return { cls: "b-success", icon: "check", label: t("bill_full") };
  if (o.per_billed > 0) return { cls: "b-warning", icon: "invoice", label: t("bill_part") };
  return { cls: "b-neutral", icon: "invoice", label: t("bill_none") };
}
function payment(o) {
  if (o.paid <= 0) return { cls: "b-neutral", icon: "money", label: t("pay_none") };
  if (o.grand_total > 0 && o.paid >= o.grand_total - 0.01) return { cls: "b-success", icon: "check", label: t("pay_full") };
  return { cls: "b-info", icon: "money", label: o.per_billed > 0 ? t("pay_part", money(o.paid)) : t("pay_advance", money(o.paid)) };
}
function due(o) {
  if (!o.delivery_date || o.per_delivered >= 100) return { text: date(o.delivery_date), cls: "muted" };
  const d = daysFromToday(o.delivery_date);
  if (d < 0) return { text: t("due_late", -d), cls: "b-danger badge" };
  if (d === 0) return { text: t("due_today"), cls: "b-warning badge" };
  if (d === 1) return { text: t("due_tomorrow"), cls: "b-warning badge" };
  return { text: date(o.delivery_date), cls: "muted" };
}

const Badge = { props: ["b"], components: { Icon }, template: `<span class="badge" :class="b.cls"><Icon :name="b.icon" :size="14"/>{{ b.label }}</span>` };

const LoadState = {
  props: ["s", "rows"], emits: ["retry"], components: { Icon },
  setup: () => ({ t }),
  template: `
    <div v-if="s.loading" class="stack" style="padding:16px" aria-busy="true" :aria-label="t('loading')">
      <div v-for="i in (rows||3)" :key="i" class="skeleton" :style="{width: (90 - i*12) + '%'}"></div>
    </div>
    <div v-else-if="s.error" class="alert error" role="alert" style="margin:16px">
      <Icon name="alert"/><div class="stack" style="gap:8px"><span>{{ s.error }}</span>
      <button class="btn sm" @click="$emit('retry')">{{ t('retry') }}</button></div>
    </div>
    <slot v-else></slot>`,
};

// ------------------------------------------------------------------ search
const SearchBox = {
  components: { Icon }, setup() {
    const q = ref(""), res = ref([]), open = ref(false), busy = ref(false);
    let timer;
    watch(q, (v) => {
      clearTimeout(timer);
      if (v.trim().length < 2) { res.value = []; return; }
      timer = setTimeout(async () => {
        busy.value = true;
        try { res.value = await call("search", { q: v }); } catch { res.value = []; }
        busy.value = false;
      }, 250);
    });
    const pick = (r) => { open.value = false; q.value = ""; go(r.route); };
    const onKey = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "k") { e.preventDefault(); document.getElementById("global-search")?.focus(); } };
    onMounted(() => window.addEventListener("keydown", onKey));
    onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
    return { q, res, open, busy, pick, t };
  },
  template: `
    <div class="search" @focusin="open=true" @focusout="setTimeout(()=>open=false,150)">
      <label for="global-search" class="sr-only">{{ t('search_label') }}</label>
      <Icon name="search" class="s-icon"/>
      <input id="global-search" class="input" type="search" v-model="q" :placeholder="t('search_ph')" autocomplete="off" enterkeyhint="search">
      <div v-if="open && q.trim().length>=2" class="pop" role="listbox">
        <div v-if="busy && !res.length" class="empty small">{{ t('loading') }}</div>
        <div v-else-if="!res.length" class="empty small">{{ t('search_none', q) }}</div>
        <button v-for="r in res" :key="r.route" class="list-item" role="option" @mousedown.prevent="pick(r)">
          <Icon :name="r.type==='customer' ? 'users' : 'orders'"/>
          <span class="main-col"><span class="bold ellipsis">{{ r.title }}</span><span class="xs muted ellipsis">{{ r.detail }}</span></span>
          <span class="badge b-neutral">{{ t('type_'+r.type) }}</span>
        </button>
      </div>
    </div>`,
};

// ------------------------------------------------------------------ customer picker (reused by order form & payment sheet)
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
    <div v-if="modelValue" class="row" style="border:1px solid var(--line-strong);border-radius:var(--r);padding:6px 12px;min-height:44px;background:var(--surface)">
      <Icon name="users"/><span class="main-col" style="flex:1;min-width:0"><span class="bold ellipsis">{{ modelValue.customer_name }}</span>
      <span v-if="modelValue.mobile_no" class="xs muted num">{{ modelValue.mobile_no }}</span></span>
      <button type="button" class="btn sm ghost" @click="$emit('update:modelValue', null)">{{ t('of_change') }}</button>
    </div>
    <div v-else class="search" style="max-width:none" @focusin="open=true; fetchList()" @focusout="close()">
      <Icon name="search" class="s-icon"/>
      <input :id="inputId" class="input plain" :class="{invalid}" type="search" v-model="q"
        :placeholder="t('of_customer_ph')" autocomplete="off" :aria-invalid="invalid ? 'true' : null">
      <div v-if="open" class="pop">
        <div v-if="!list.length" class="empty small">{{ t('c_none') }}</div>
        <button type="button" v-for="c in list" :key="c.name" class="list-item" @mousedown.prevent="pick(c)">
          <span class="main-col"><span class="bold ellipsis">{{ c.customer_name }}</span><span class="xs muted num">{{ c.mobile_no || '' }}</span></span>
        </button>
      </div>
    </div>`,
};

// ------------------------------------------------------------------ home
const Home = {
  components: { Icon, Badge, LoadState },
  setup() {
    const { s, load } = useLoad(() => call("home"));
    onMounted(load);
    const showAll = ref(false);
    const actions = computed(() => (s.data?.actions || []));
    const visible = computed(() => (showAll.value ? actions.value : actions.value.slice(0, 5)));
    const m = computed(() => s.data?.money);
    const now = computed(() => m.value && [
      { label: t("m_receivable"), value: m.value.receivable, hint: t("m_receivable_hint"), cls: "emph" },
      { label: t("m_cash"), value: m.value.cash_balance, hint: t("m_cash_hint") },
      { label: t("m_payable"), value: m.value.payable, hint: t("m_payable_hint") },
      { label: t("m_advances"), value: m.value.advances_held, hint: t("m_advances_hint") },
    ]);
    const month = computed(() => m.value && [
      { label: t("m_sales"), value: m.value.sales, hint: t("m_sales_hint") },
      { label: t("m_in"), value: m.value.cash_in, hint: t("m_in_hint") },
      { label: t("m_out"), value: m.value.cash_out, hint: t("m_out_hint") },
      { label: t("m_result"), value: m.value.result, hint: t("m_result_hint"), cls: "warn" },
    ]);
    const greeting = computed(() => t("today_is", dfw.format(new Date())));
    const openAction = (a) => go(a.route);
    return { s, load, showAll, actions, visible, now, month, KIND, t, money, date, billing, payment, due, go, greeting, state, openAction, num };
  },
  template: `
  <div class="page stack" style="gap:20px">
    <div class="row wrap" style="justify-content:space-between">
      <div><h1>{{ t('nav_home') }}</h1><div class="small muted">{{ greeting }}</div></div>
    </div>
    <div class="quick mobile-only">
      <a class="btn primary" href="/atelier/orders/new" @click.prevent="go('/orders/new')"><Icon name="plus"/>{{ t('new_order') }}</a>
      <button v-if="state.boot.can.payment" class="btn" @click="state.sheet={type:'payment'}"><Icon name="in" style="color:var(--success)"/>{{ t('record_payment') }}</button>
      <a v-if="state.boot.can.expense" class="btn" href="/app/journal-entry/new" :title="t('expense_hint')"><Icon name="out" style="color:var(--danger)"/>{{ t('record_expense') }}</a>
    </div>

    <div class="home-grid">
      <section class="card" style="grid-area:actions" aria-labelledby="todo-h">
        <div class="card-h"><h2 id="todo-h">{{ t('todo_title') }}</h2>
          <span v-if="actions.length" class="badge b-danger" style="font-size:13px">{{ num(actions.length) }}</span></div>
        <LoadState :s="s" :rows="4" @retry="load">
          <div v-if="!actions.length" class="empty"><Icon name="check" :size="28" style="color:var(--success)"/>
            <span class="bold" style="color:var(--ink)">{{ t('todo_none') }}</span><span class="small">{{ t('todo_none_hint') }}</span></div>
          <div v-else class="list">
            <button v-for="(a,i) in visible" :key="i" class="list-item" @click="openAction(a)">
              <span class="dot" :style="{background: KIND[a.kind].dot}"></span>
              <span class="main-col"><span class="bold wrap-any">{{ a.title }}</span><span class="small muted ellipsis">{{ a.detail }}</span></span>
              <span class="end-col">
                <span class="badge" :class="KIND[a.kind].badge"><Icon :name="KIND[a.kind].icon" :size="14"/>{{ t('kind_'+a.kind) }}</span>
                <span v-if="a.doc && a.doc.amount" class="small bold money">{{ money(a.doc.amount) }}</span>
              </span>
            </button>
          </div>
          <div v-if="actions.length>5" style="padding:8px 16px 12px">
            <button class="btn sm ghost" @click="showAll=!showAll">{{ showAll ? t('todo_less') : t('todo_more', actions.length) }}</button>
          </div>
        </LoadState>
      </section>

      <aside style="grid-area:money" class="stack" aria-labelledby="money-h">
        <div class="row" style="justify-content:space-between"><h2 id="money-h">{{ t('money_title') }}</h2></div>
        <LoadState :s="s" :rows="4" @retry="load">
          <div v-if="!s.data.money" class="alert info">{{ t('money_hidden') }}</div>
          <template v-else>
            <div class="group-label">{{ t('g_now') }}</div>
            <div class="kpis">
              <div v-for="k in now" :key="k.label" class="kpi" :class="k.cls">
                <span class="k-label">{{ k.label }}</span><span class="k-value money">{{ money(k.value) }}</span><span class="k-hint">{{ k.hint }}</span>
              </div>
            </div>
            <div class="group-label">{{ t('g_month') }} · {{ date(s.data.money.period.from) }} – {{ date(s.data.money.period.to) }}</div>
            <div class="kpis">
              <div v-for="k in month" :key="k.label" class="kpi" :class="k.cls">
                <span class="k-label">{{ k.label }}</span><span class="k-value money">{{ money(k.value) }}</span><span class="k-hint">{{ k.hint }}</span>
              </div>
            </div>
          </template>
        </LoadState>
      </aside>

      <section class="card" style="grid-area:orders" aria-labelledby="orders-h">
        <div class="card-h"><h2 id="orders-h">{{ t('orders_title') }}</h2>
          <a class="btn sm ghost" href="/atelier/customers" @click.prevent="go('/customers')">{{ t('nav_customers') }}</a></div>
        <LoadState :s="s" @retry="load">
          <div v-if="!s.data.orders.length" class="empty">{{ t('orders_none') }}</div>
          <div v-else class="desktop-only table-wrap">
            <table class="t">
              <thead><tr><th>{{ t('col_order') }}</th><th>{{ t('col_customer') }}</th><th>{{ t('col_stage') }}</th><th>{{ t('col_due') }}</th>
                <th>{{ t('col_billing') }}</th><th>{{ t('col_payment') }}</th><th class="num">{{ t('col_total') }}</th></tr></thead>
              <tbody>
                <tr v-for="o in s.data.orders" :key="o.name" class="clickable" @click="go('/orders/'+encodeURIComponent(o.name))">
                  <td><a :href="'/atelier/orders/'+o.name" @click.prevent class="bold">{{ o.atelier_subject || o.name }}</a>
                    <div class="xs muted">{{ o.name }}</div></td>
                  <td>{{ o.customer_name }}</td>
                  <td><span>{{ o.atelier_stage }}</span><div v-if="o.price_pending"><span class="badge b-warning"><Icon name="tag" :size="14"/>{{ t('price_pending') }}</span></div></td>
                  <td><span :class="due(o).cls">{{ due(o).text }}</span></td>
                  <td><Badge :b="billing(o)"/></td>
                  <td><Badge :b="payment(o)"/></td>
                  <td class="num"><span class="money">{{ o.price_pending ? '—' : money(o.grand_total) }}</span></td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-if="s.data.orders.length" class="mobile-only list">
            <a v-for="o in s.data.orders" :key="o.name" class="list-item" :href="'/atelier/orders/'+o.name" @click.prevent="go('/orders/'+encodeURIComponent(o.name))">
              <span class="main-col">
                <span class="row" style="justify-content:space-between;gap:8px"><span class="bold ellipsis">{{ o.atelier_subject || o.name }}</span><span :class="due(o).cls" class="xs">{{ due(o).text }}</span></span>
                <span class="small muted ellipsis">{{ o.customer_name }} · {{ o.atelier_stage }}</span>
                <span class="row wrap" style="gap:6px;margin-top:4px">
                  <span v-if="o.price_pending" class="badge b-warning"><Icon name="tag" :size="14"/>{{ t('price_pending') }}</span>
                  <Badge :b="billing(o)"/><Badge :b="payment(o)"/></span>
              </span>
            </a>
          </div>
        </LoadState>
      </section>
    </div>
  </div>`,
};

// ------------------------------------------------------------------ new order
const COST_TYPES = [
  ["Matière", "ct_material"], ["Machine", "ct_machine"], ["Main d'œuvre", "ct_labour"],
  ["Sous-traitance", "ct_external"], ["Finition", "ct_finish"], ["Autre", "ct_other"],
];
const DRAFT_KEY = "atelier.orderDraft.v1";
const blankItem = () => ({ item_code: "", description: "", qty: 1, rate: "", noPrice: false });
const blankForm = () => ({
  mode: "pick", customer: null, newCustomer: { name: "", phone: "" }, subject: "", delivery_date: addDays(todayISO(), 3),
  items: [blankItem()], costs: [], waste: 0, advance: { amount: "", mode: "Cash" },
});

const OrderNew = {
  components: { Icon, CustomerPicker },
  setup() {
    const saved = store.get(DRAFT_KEY);
    const f = reactive(saved || blankForm());
    const restored = ref(!!saved && (saved.subject || saved.customer || saved.items?.some((i) => i.item_code)));
    const preset = state.query.get("customer");
    if (preset && !f.customer) call("customers", { q: preset }).then((l) => { const c = l.find((x) => x.name === preset); if (c) f.customer = c; });
    watch(f, (v) => store.set(DRAFT_KEY, v), { deep: true });  // keeps input when navigating away and back

    const boot = computed(() => state.boot || { items: [], modes: [] });
    const itemsByCode = computed(() => Object.fromEntries(boot.value.items.map((i) => [i.item_code, i])));
    const onItem = (row) => { const it = itemsByCode.value[row.item_code]; if (it && row.rate === "" && it.standard_rate) row.rate = it.standard_rate; };
    const attempted = ref(false), saving = ref(false), serverError = ref(null), serverErrors = ref({}), done = ref(null);

    const priced = (i) => !i.noPrice && i.rate !== "" && i.rate !== null;
    const sum = computed(() => {
      let total = 0, pending = 0, cost = 0, missing = 0;
      for (const i of f.items) if (i.item_code) { if (priced(i)) total += (+i.qty || 0) * (+i.rate || 0); else pending++; }
      for (const c of f.costs) {
        if (c.rate === "" || c.rate === null) { missing++; continue; }
        const w = c.cost_type === "Matière" ? 1 + (+f.waste || 0) / 100 : 1;
        cost += (+c.qty || 0) * (+c.rate || 0) * w;
      }
      const adv = +f.advance.amount || 0;
      return { total, pending, cost, missing, margin: f.costs.length && !pending ? total - cost : null, remaining: total - adv, adv };
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
    const hasErrors = computed(() => Object.keys(errors.value).length > 0);

    const discard = () => { Object.assign(f, blankForm()); store.del(DRAFT_KEY); restored.value = false; attempted.value = false; };
    const addItem = () => f.items.push(blankItem());
    const addCost = () => f.costs.push({ cost_type: "Matière", description: "", item: "", qty: 1, rate: "" });

    async function submit() {
      attempted.value = true; serverError.value = null; serverErrors.value = {};
      if (hasErrors.value) {
        serverError.value = t("err_fix");
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
    return { f, boot, onItem, sum, err, errors, attempted, saving, serverError, done, restored, discard, addItem, addCost, submit, again,
      COST_TYPES, t, money, num, go, todayISO, state, dfw };
  },
  template: `
  <div class="page" :class="{'has-form-footer': !done}">
    <div v-if="done" class="stack" style="max-width:640px;margin:0 auto">
      <div class="card"><div class="card-b stack" style="padding:24px;align-items:flex-start">
        <span class="badge b-success" style="font-size:14px"><Icon name="check" :size="16"/>{{ t('ok_title') }}</span>
        <h1>{{ f.subject || done.sales_order }}</h1>
        <div class="small muted num">{{ done.sales_order }}</div>
        <div v-if="!done.submitted" class="alert warn"><Icon name="tag"/><span>{{ t('ok_draft_note') }}</span></div>
        <div class="row wrap">
          <a class="btn primary" :href="'/atelier/orders/'+done.sales_order" @click.prevent="go('/orders/'+done.sales_order)">{{ t('ok_open_order') }}</a>
          <a class="btn" :href="'/atelier/customers/'+done.customer" @click.prevent="go('/customers/'+encodeURIComponent(done.customer))">{{ t('ok_open_customer') }}</a>
          <a v-if="done.payment" class="btn" target="_blank" rel="noopener"
             :href="'/api/method/frappe.utils.print_format.download_pdf?doctype=Payment%20Entry&name='+encodeURIComponent(done.payment)">{{ t('ok_receipt') }}</a>
          <button class="btn ghost" @click="again">{{ t('ok_another') }}</button>
        </div>
      </div></div>
    </div>

    <form v-else class="grid-2" novalidate @submit.prevent="submit">
      <div class="stack" style="gap:16px">
        <div class="row" style="justify-content:space-between"><h1>{{ t('of_title') }}</h1></div>
        <div v-if="restored" class="alert info" role="status"><span style="flex:1">{{ t('of_draft_restored') }}</span>
          <button type="button" class="btn sm" @click="discard">{{ t('of_discard') }}</button></div>
        <div v-if="serverError" class="alert error" role="alert"><Icon name="alert"/><span>{{ serverError }}</span></div>

        <section class="card"><div class="card-h"><h2>{{ t('of_customer') }}</h2>
          <div class="seg" role="group"><button type="button" :aria-pressed="f.mode==='pick'" @click="f.mode='pick'">{{ t('of_existing_customer') }}</button>
            <button type="button" :aria-pressed="f.mode==='new'" @click="f.mode='new'">{{ t('of_new_customer') }}</button></div></div>
          <div class="card-b stack">
            <div v-if="f.mode==='pick'" class="field">
              <label for="f-customer" class="req">{{ t('of_customer') }}</label>
              <CustomerPicker v-model="f.customer" input-id="f-customer" :invalid="!!err('customer')"/>
              <span v-if="err('customer')" class="error-text"><Icon name="alert" :size="16"/>{{ err('customer') }}</span>
            </div>
            <div v-else class="grid-2" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">
              <div class="field"><label for="f-nc-name" class="req">{{ t('of_new_name') }}</label>
                <input id="f-nc-name" class="input" :class="{invalid: err('customer')}" v-model="f.newCustomer.name" autocomplete="name" enterkeyhint="next">
                <span v-if="err('customer')" class="error-text"><Icon name="alert" :size="16"/>{{ err('customer') }}</span></div>
              <div class="field"><label for="f-nc-phone">{{ t('of_new_phone') }} <span class="muted xs">({{ t('optional') }})</span></label>
                <input id="f-nc-phone" lang="fr" class="input num" type="tel" inputmode="tel" v-model="f.newCustomer.phone" autocomplete="tel" enterkeyhint="next"></div>
            </div>
          </div>
        </section>

        <section class="card"><div class="card-h"><h2>{{ t('of_details') }}</h2></div>
          <div class="card-b grid-2" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr))">
            <div class="field"><label for="f-subject" class="req">{{ t('of_subject') }}</label>
              <input id="f-subject" class="input" :class="{invalid: err('subject')}" v-model="f.subject" :placeholder="t('of_subject_ph')" enterkeyhint="next">
              <span v-if="err('subject')" class="error-text"><Icon name="alert" :size="16"/>{{ err('subject') }}</span></div>
            <div class="field"><label for="f-due" class="req">{{ t('of_due') }}</label>
              <input id="f-due" class="input" :class="{invalid: err('delivery_date')}" lang="fr" type="date" :min="todayISO()" v-model="f.delivery_date">
              <span v-if="err('delivery_date')" class="error-text"><Icon name="alert" :size="16"/>{{ err('delivery_date') }}</span>
              <span v-else-if="f.delivery_date" class="hint">{{ dfw.format(new Date(f.delivery_date + 'T00:00:00')) }}</span></div>
          </div>
        </section>

        <section class="card"><div class="card-h"><h2>{{ t('of_items') }}</h2></div>
          <div class="card-b stack">
            <span v-if="err('items')" class="error-text"><Icon name="alert" :size="16"/>{{ err('items') }}</span>
            <div v-for="(it, idx) in f.items" :key="idx" class="line">
              <div class="field full"><label :for="'it-'+idx" class="req">{{ t('of_item') }}</label>
                <select :id="'it-'+idx" class="input" :class="{invalid: err('items.'+idx+'.item')}" v-model="it.item_code" @change="onItem(it)">
                  <option value="">{{ t('of_item_ph') }}</option>
                  <option v-for="i in boot.items" :key="i.item_code" :value="i.item_code">{{ i.item_name }}</option>
                </select>
                <span v-if="err('items.'+idx+'.item')" class="error-text">{{ err('items.'+idx+'.item') }}</span></div>
              <div class="field"><label :for="'q-'+idx" class="req">{{ t('of_qty') }}</label>
                <input :id="'q-'+idx" lang="fr" class="input num" :class="{invalid: err('items.'+idx+'.qty')}" type="text" inputmode="decimal" autocomplete="off" min="0" step="any" v-model="it.qty" enterkeyhint="next">
                <span v-if="err('items.'+idx+'.qty')" class="error-text">{{ err('items.'+idx+'.qty') }}</span></div>
              <div class="field"><label :for="'r-'+idx" :class="{req: !it.noPrice}">{{ t('of_rate') }}</label>
                <input :id="'r-'+idx" lang="fr" class="input num" :class="{invalid: err('items.'+idx+'.rate')}" type="text" inputmode="decimal" autocomplete="off" min="0" step="any"
                  v-model="it.rate" :disabled="it.noPrice" :placeholder="it.noPrice ? t('price_pending') : ''" enterkeyhint="next">
                <span v-if="err('items.'+idx+'.rate')" class="error-text">{{ err('items.'+idx+'.rate') }}</span></div>
              <div class="field"><span class="label">{{ t('of_amount') }}</span>
                <div style="min-height:44px;display:flex;align-items:center" class="bold">
                  <span v-if="it.noPrice" class="badge b-warning"><Icon name="tag" :size="14"/>{{ t('price_pending') }}</span>
                  <span v-else class="money">{{ it.rate === '' ? '—' : money((+it.qty||0)*(+it.rate||0)) }}</span></div></div>
              <div class="row" style="align-self:end;gap:4px">
                <label class="check"><input type="checkbox" v-model="it.noPrice" @change="it.noPrice && (it.rate='')">{{ t('of_no_price') }}</label>
                <button v-if="f.items.length>1" type="button" class="btn ghost icon-btn danger" :aria-label="t('of_remove')" @click="f.items.splice(idx,1)"><Icon name="trash"/></button>
              </div>
              <div class="field desc full"><label :for="'d-'+idx">{{ t('of_desc') }}</label>
                <input :id="'d-'+idx" class="input" v-model="it.description" :placeholder="t('of_desc_ph')" enterkeyhint="next"></div>
              <div v-if="it.noPrice" class="hint full desc">{{ t('of_no_price_hint') }}</div>
            </div>
            <button type="button" class="btn" @click="addItem"><Icon name="plus"/>{{ t('of_add_item') }}</button>
          </div>
        </section>

        <section v-if="boot.can && boot.can.cost" class="card">
          <details class="collapse card-b" :open="f.costs.length>0" style="padding-top:8px">
            <summary><Icon name="chev" class="chev"/><h2 style="flex:1">{{ t('of_cost') }}</h2>
              <span v-if="f.costs.length" class="small money">{{ money(sum.cost) }}</span></summary>
            <div class="stack">
              <span class="hint">{{ t('of_cost_hint') }}</span>
              <div v-for="(c, idx) in f.costs" :key="idx" class="line">
                <div class="field"><label :for="'ct-'+idx">{{ t('of_cost_type') }}</label>
                  <select :id="'ct-'+idx" class="input" v-model="c.cost_type"><option v-for="ct in COST_TYPES" :key="ct[0]" :value="ct[0]">{{ t(ct[1]) }}</option></select></div>
                <div class="field"><label :for="'cd-'+idx">{{ t('of_cost_desc') }}</label><input :id="'cd-'+idx" class="input" v-model="c.description"></div>
                <div class="field"><label :for="'cq-'+idx">{{ t('of_cost_qty') }}</label><input :id="'cq-'+idx" lang="fr" class="input num" type="text" inputmode="decimal" autocomplete="off" min="0" step="any" v-model="c.qty"></div>
                <div class="field"><label :for="'cr-'+idx">{{ t('of_cost_rate') }}</label><input :id="'cr-'+idx" lang="fr" class="input num" type="text" inputmode="decimal" autocomplete="off" min="0" step="any" v-model="c.rate">
                  <span v-if="c.rate===''" class="badge b-warning" style="align-self:flex-start"><Icon name="alert" :size="14"/>{{ t('of_cost_missing') }}</span></div>
                <div class="row" style="align-self:end"><button type="button" class="btn ghost icon-btn danger" :aria-label="t('of_remove')" @click="f.costs.splice(idx,1)"><Icon name="trash"/></button></div>
              </div>
              <div class="row wrap">
                <button type="button" class="btn" @click="addCost"><Icon name="plus"/>{{ t('of_add_cost') }}</button>
                <div class="field" style="width:140px"><label for="f-waste">{{ t('of_waste') }}</label><input id="f-waste" lang="fr" class="input num" type="text" inputmode="decimal" autocomplete="off" min="0" max="100" v-model="f.waste"></div>
              </div>
            </div>
          </details>
        </section>

        <section v-if="boot.can && boot.can.payment" class="card"><div class="card-h"><h2>{{ t('of_advance') }}</h2></div>
          <div class="card-b stack">
            <div class="grid-2" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">
              <div class="field"><label for="f-adv">{{ t('of_advance_amount') }} <span class="muted xs">({{ t('optional') }})</span></label>
                <input id="f-adv" lang="fr" class="input num" type="text" inputmode="decimal" autocomplete="off" min="0" step="any" v-model="f.advance.amount" enterkeyhint="done"></div>
              <div class="field"><span class="label">{{ t('of_mode') }}</span>
                <div class="seg" role="group"><button v-for="m in boot.modes" :key="m.value" type="button" :aria-pressed="f.advance.mode===m.value" @click="f.advance.mode=m.value">{{ m.label }}</button></div>
                <span v-if="err('advance_mode')" class="error-text">{{ err('advance_mode') }}</span></div>
            </div>
            <span class="hint">{{ t('of_advance_hint') }}</span>
          </div>
        </section>
      </div>

      <aside class="sticky-side stack">
        <section class="card"><div class="card-h"><h2>{{ t('of_summary') }}</h2></div>
          <div class="card-b">
            <div class="summary-row"><span>{{ t('of_total') }}</span><span class="money bold">{{ money(sum.total) }}</span></div>
            <div v-if="sum.pending" class="summary-row"><span class="badge b-warning"><Icon name="tag" :size="14"/>{{ t('of_items_pending', sum.pending) }}</span></div>
            <template v-if="f.costs.length">
              <div class="summary-row"><span>{{ t('of_est_cost') }}</span><span class="money">{{ money(sum.cost) }}</span></div>
              <div v-if="sum.missing" class="summary-row"><span class="badge b-warning"><Icon name="alert" :size="14"/>{{ t('of_costs_missing', sum.missing) }}</span></div>
              <div class="summary-row"><span>{{ t('of_margin') }}</span>
                <span v-if="sum.margin===null || sum.missing" class="badge b-neutral">{{ t('of_incomplete') }}</span>
                <span v-else class="money bold">{{ money(sum.margin) }}</span></div>
            </template>
            <div v-if="sum.adv" class="summary-row"><span>{{ t('of_advance') }}</span><span class="money">{{ money(sum.adv) }}</span></div>
            <div class="summary-row total"><span>{{ t('of_remaining') }}</span><span class="money">{{ sum.pending ? '—' : money(sum.remaining) }}</span></div>
            <div class="stack desktop-only" style="gap:4px;margin-top:12px">
              <span class="xs muted bold">{{ t('of_will_create') }}</span>
              <span class="xs muted">• {{ sum.pending ? t('of_will_so_draft') : t('of_will_so') }}</span>
              <span v-if="f.costs.length" class="xs muted">• {{ t('of_will_ce') }}</span>
              <span v-if="sum.adv" class="xs muted">• {{ t('of_will_pe', money(sum.adv)) }}</span>
            </div>
          </div>
        </section>
        <div class="form-footer">
          <div class="mobile-only stack" style="gap:0;flex:1;min-width:0"><span class="xs muted">{{ t('of_total') }}</span><span class="bold money">{{ money(sum.total) }}</span></div>
          <button type="submit" class="btn primary" style="flex:1" :disabled="saving">{{ saving ? t('of_saving') : t('of_save') }}</button>
        </div>
      </aside>
    </form>
  </div>`,
};

// ------------------------------------------------------------------ order view
const OrderView = {
  props: ["id"], components: { Icon, Badge, LoadState },
  setup(props) {
    const { s, load } = useLoad(() => call("order", { name: props.id }));
    onMounted(load);
    const stages = computed(() => state.boot?.stages || []);
    const setStage = async (stage) => {
      const prev = s.data.atelier_stage; s.data.atelier_stage = stage;
      try { await call("set_stage", { name: props.id, stage }, true); toast(t("ov_stage_saved")); }
      catch (e) { s.data.atelier_stage = prev; toast(e.message, "error"); }
    };
    const stageIdx = computed(() => stages.value.indexOf(s.data?.atelier_stage));
    return { s, load, stages, setStage, stageIdx, t, money, num, date, billing, payment, due, go, state };
  },
  template: `
  <div class="page stack" style="gap:16px">
    <LoadState :s="s" :rows="5" @retry="load"><template v-if="s.data">
      <div class="row wrap" style="justify-content:space-between;align-items:flex-start">
        <div class="stack" style="gap:2px;min-width:0">
          <h1 class="wrap-any">{{ s.data.atelier_subject || s.data.name }}</h1>
          <a class="small" :href="'/atelier/customers/'+s.data.customer" @click.prevent="go('/customers/'+encodeURIComponent(s.data.customer))">{{ s.data.customer_name }}</a>
          <span class="xs muted num">{{ s.data.name }}</span>
        </div>
        <div class="row wrap">
          <span :class="due(s.data).cls">{{ t('col_due') }}: {{ due(s.data).text }}</span>
          <Badge :b="billing(s.data)"/><Badge :b="payment(s.data)"/>
        </div>
      </div>
      <section class="card"><div class="card-h"><h2>{{ t('ov_stage') }}</h2></div>
        <div class="card-b"><div class="stages" role="group" :aria-label="t('ov_stage')">
          <button v-for="(st,i) in stages" :key="st" :class="{done: i<stageIdx, current: i===stageIdx}" :aria-pressed="i===stageIdx" @click="setStage(st)">{{ st }}</button>
        </div></div></section>
      <div class="grid-2">
        <section class="card"><div class="card-h"><h2>{{ t('ov_items') }}</h2></div>
          <div class="list">
            <div v-for="(i,idx) in s.data.items" :key="idx" class="list-item" style="cursor:default">
              <span class="main-col"><span class="bold">{{ i.item_name }}</span>
                <span v-if="i.description && i.description!==i.item_name" class="small muted wrap-any">{{ i.description.replace(/<[^>]+>/g,'') }}</span>
                <span class="xs muted num">{{ num(i.qty) }} × {{ i.rate===null ? '?' : num(i.rate) }}</span></span>
              <span class="end-col"><span v-if="i.rate===null" class="badge b-warning"><Icon name="tag" :size="14"/>{{ t('price_pending') }}</span>
                <span v-else class="money bold">{{ money(i.amount) }}</span></span>
            </div>
          </div></section>
        <aside class="stack">
          <section class="card"><div class="card-h"><h2>{{ t('ov_money') }}</h2></div><div class="card-b">
            <div class="summary-row"><span>{{ t('col_total') }}</span><span class="money bold">{{ s.data.price_pending ? '—' : money(s.data.grand_total) }}</span></div>
            <div class="summary-row"><span>{{ t('ov_paid') }}</span><span class="money">{{ money(s.data.paid) }}</span></div>
            <div class="summary-row total"><span>{{ t('ov_left') }}</span><span class="money">{{ s.data.price_pending ? '—' : money(s.data.grand_total - s.data.paid) }}</span></div>
            <div v-if="s.data.estimate && s.data.estimate.length" class="summary-row"><span>{{ t('ov_estimate') }}</span>
              <span class="money">{{ money(s.data.estimate[0].total_cost) }}<span v-if="s.data.estimate[0].missing_count" class="badge b-warning" style="margin-inline-start:6px">{{ t('of_incomplete') }}</span></span></div>
          </div></section>
          <div class="row wrap">
            <button v-if="state.boot.can.payment" class="btn" @click="state.sheet={type:'payment', customer:{name:s.data.customer, customer_name:s.data.customer_name}, order:s.data.name}"><Icon name="in"/>{{ t('record_payment') }}</button>
            <a class="btn ghost" :href="'/app/sales-order/'+s.data.name"><Icon name="ext"/>{{ t('ov_open_erp') }}</a>
            <a v-if="s.data.project && state.boot.can.finance" class="btn ghost" :href="'/app/query-report/Rentabilite Commande?project='+encodeURIComponent(s.data.project)"><Icon name="chart"/>{{ t('ov_profit') }}</a>
          </div>
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
  props: ["id"], components: { Icon, Badge, LoadState },
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
    return { s, load, tab, tabs, bal, preview, pdf, statement, DT_KEY, isImage, fileSize, t, money, num, date, billing, payment, due, go, state };
  },
  template: `
  <div class="page stack" style="gap:16px">
    <LoadState :s="s" :rows="6" @retry="load"><template v-if="s.data">
      <div class="row wrap" style="justify-content:space-between;align-items:flex-start">
        <div class="stack" style="gap:2px;min-width:0"><h1 class="wrap-any">{{ s.data.customer_name }}</h1>
          <a v-if="s.data.mobile_no" class="small num" :href="'tel:'+s.data.mobile_no"><Icon name="phone" :size="14"/> {{ s.data.mobile_no }}</a></div>
        <div class="row wrap">
          <a class="btn primary" :href="'/atelier/orders/new?customer='+encodeURIComponent(s.data.name)" @click.prevent="go('/orders/new?customer='+encodeURIComponent(s.data.name))"><Icon name="plus"/>{{ t('c_new_order') }}</a>
          <button v-if="state.boot.can.payment" class="btn" @click="state.sheet={type:'payment', customer:{name:s.data.name, customer_name:s.data.customer_name}}"><Icon name="in"/>{{ t('record_payment') }}</button>
          <a v-if="s.data.ledger" class="btn ghost" :href="statement"><Icon name="file"/>{{ t('c_statement') }}</a>
        </div>
      </div>

      <div v-if="s.data.ledger" class="kpis" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
        <div class="kpi emph"><span class="k-label"><span class="badge" :class="bal.cls"><Icon :name="bal.icon" :size="14"/>{{ bal.label }}</span></span>
          <span class="k-value money">{{ money(bal.value) }}</span></div>
        <div class="kpi"><span class="k-label">{{ t('c_outstanding') }}</span><span class="k-value money">{{ money(s.data.outstanding) }}</span></div>
        <div class="kpi"><span class="k-label">{{ t('c_invoiced') }}</span><span class="k-value money">{{ money(s.data.invoiced) }}</span></div>
        <div class="kpi"><span class="k-label">{{ t('c_received') }}</span><span class="k-value money">{{ money(s.data.received) }}</span></div>
      </div>

      <section class="card">
        <div class="tabs" role="tablist" style="padding:0 8px">
          <button v-for="tb in tabs" :key="tb[0]" role="tab" :aria-selected="tab===tb[0]" @click="tab=tb[0]">{{ tb[1] }}<br class="mobile-only"> <span class="muted num xs">({{ tb[2]||0 }})</span></button>
        </div>

        <div v-if="tab==='orders'" role="tabpanel">
          <div v-if="!s.data.orders.length" class="empty">{{ t('c_no_orders') }}</div>
          <div class="list">
            <a v-for="o in s.data.orders" :key="o.name" class="list-item" :href="'/atelier/orders/'+o.name" @click.prevent="go('/orders/'+encodeURIComponent(o.name))">
              <span class="main-col"><span class="bold ellipsis">{{ o.atelier_subject || o.name }}</span>
                <span class="xs muted">{{ o.name }} · {{ date(o.transaction_date, true) }} · {{ o.atelier_stage }}</span>
                <span class="row wrap" style="gap:6px;margin-top:4px"><span v-if="o.price_pending" class="badge b-warning"><Icon name="tag" :size="14"/>{{ t('price_pending') }}</span>
                  <Badge :b="billing(o)"/><Badge :b="payment(o)"/></span></span>
              <span class="end-col"><span class="money bold">{{ o.price_pending ? '—' : money(o.grand_total) }}</span><span :class="due(o).cls" class="xs">{{ due(o).text }}</span></span>
            </a>
          </div>
        </div>

        <div v-if="tab==='ledger'" role="tabpanel">
          <div v-if="!s.data.ledger.length" class="empty">{{ t('c_no_ledger') }}</div>
          <div v-else class="desktop-only table-wrap"><table class="t">
            <thead><tr><th>{{ t('c_date') }}</th><th>{{ t('c_doc') }}</th><th class="num">{{ t('c_debit') }}</th><th class="num">{{ t('c_credit_col') }}</th><th class="num">{{ t('c_balance') }}</th></tr></thead>
            <tbody><tr v-for="(e,i) in s.data.ledger" :key="i">
              <td>{{ date(e.posting_date, true) }}</td>
              <td><span>{{ t(DT_KEY[e.voucher_type] || e.voucher_type) }}</span> <a class="xs num" :href="pdf(e.voucher_type, e.voucher_no)" target="_blank" rel="noopener">{{ e.voucher_no }}</a></td>
              <td class="num"><span class="money">{{ e.debit ? money(e.debit) : '' }}</span></td>
              <td class="num"><span class="money">{{ e.credit ? money(e.credit) : '' }}</span></td>
              <td class="num bold"><span class="money">{{ money(e.balance) }}</span></td></tr></tbody></table></div>
          <div class="mobile-only list">
            <div v-for="(e,i) in s.data.ledger" :key="i" class="list-item" style="cursor:default">
              <span class="main-col"><span class="bold">{{ t(DT_KEY[e.voucher_type] || e.voucher_type) }}</span>
                <span class="xs muted">{{ date(e.posting_date, true) }} · <a class="num" :href="pdf(e.voucher_type, e.voucher_no)" target="_blank" rel="noopener">{{ e.voucher_no }}</a></span></span>
              <span class="end-col"><span class="money bold" :style="{color: e.debit ? 'var(--danger)' : 'var(--success)'}">{{ e.debit ? '+' + money(e.debit) : '−' + money(e.credit) }}</span>
                <span class="xs muted">{{ t('c_balance') }} <span class="money">{{ money(e.balance) }}</span></span></span>
            </div>
          </div>
        </div>

        <div v-if="tab==='docs'" role="tabpanel">
          <div v-if="!s.data.documents.length" class="empty">{{ t('c_no_docs') }}</div>
          <div class="list">
            <div v-for="d in s.data.documents" :key="d.name" class="list-item" style="cursor:default">
              <Icon name="invoice"/><span class="main-col"><span class="bold">{{ t(DT_KEY[d.doctype]) }} <span v-if="d.docstatus===0" class="badge b-neutral">{{ t('draft') }}</span></span>
                <span class="xs muted num">{{ d.name }} · {{ date(d.date, true) }}</span></span>
              <span class="end-col"><span class="money">{{ money(d.amount) }}</span>
                <a class="btn sm ghost" :href="pdf(d.doctype, d.name)" target="_blank" rel="noopener">PDF</a></span>
            </div>
          </div>
        </div>

        <div v-if="tab==='files'" role="tabpanel">
          <div v-if="!s.data.files.length" class="empty">{{ t('c_no_files') }}</div>
          <div class="list">
            <div v-for="f in s.data.files" :key="f.name" class="list-item" style="cursor:default">
              <Icon :name="isImage(f) ? 'image' : 'file'"/>
              <span class="main-col"><span class="bold ellipsis" dir="auto">{{ f.file_name }}</span>
                <span class="xs muted">{{ t('c_attached_to', t(DT_KEY[f.attached_to_doctype] || f.attached_to_doctype)) }} <span class="num">{{ f.attached_to_name }}</span> · {{ fileSize(f.file_size) }}
                  <span v-if="f.is_private" class="badge b-neutral">{{ t('c_private') }}</span></span></span>
              <span class="end-col" style="flex-direction:row">
                <button v-if="isImage(f)" class="btn sm" @click="preview=f">{{ t('c_preview') }}</button>
                <a class="btn sm ghost" :href="f.file_url" target="_blank" rel="noopener" :aria-label="t('c_download')+' '+f.file_name"><Icon name="ext" :size="16"/></a></span>
            </div>
          </div>
        </div>
      </section>

      <div v-if="preview" class="overlay" @click.self="preview=null" role="dialog" aria-modal="true" :aria-label="preview.file_name">
        <div class="sheet wide">
          <div class="row"><h2 class="ellipsis" style="flex:1" dir="auto">{{ preview.file_name }}</h2>
            <button class="btn ghost icon-btn" :aria-label="t('close')" @click="preview=null"><Icon name="x"/></button></div>
          <img class="preview-img" :src="preview.file_url" :alt="preview.file_name" loading="lazy">
        </div>
      </div>
    </template></LoadState>
  </div>`,
};

const CustomerList = {
  components: { Icon, LoadState },
  setup() {
    const q = ref("");
    const { s, load } = useLoad(() => call("customers", q.value ? { q: q.value } : {}));
    let timer; watch(q, () => { clearTimeout(timer); timer = setTimeout(load, 250); });
    onMounted(load);
    return { q, s, load, t, go };
  },
  template: `
  <div class="page stack">
    <h1>{{ t('c_title') }}</h1>
    <div class="field"><label for="c-q" class="sr-only">{{ t('search_label') }}</label>
      <input id="c-q" class="input" type="search" v-model="q" :placeholder="t('c_list_ph')" enterkeyhint="search"></div>
    <section class="card"><LoadState :s="s" @retry="load">
      <div v-if="!s.data.length" class="empty">{{ t('c_none') }}</div>
      <div class="list"><a v-for="c in s.data" :key="c.name" class="list-item" :href="'/atelier/customers/'+c.name" @click.prevent="go('/customers/'+encodeURIComponent(c.name))">
        <Icon name="users"/><span class="main-col"><span class="bold ellipsis">{{ c.customer_name }}</span><span class="xs muted num">{{ c.mobile_no || '' }}</span></span>
        <Icon name="chev" :size="18"/></a></div>
    </LoadState></section>
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
      try { orders.value = (await call("customer", { name: f.customer.name })).orders.filter((o) => o.docstatus === 1 && o.per_billed < 100); } catch { /* optional */ }
    };
    watch(() => f.customer, loadOrders, { immediate: true });
    const errs = computed(() => ({
      customer: !f.customer ? t("err_pick_customer") : null,
      amount: !(+f.amount > 0) ? t("err_amount") : null,
    }));
    const close = () => (state.sheet = null);
    async function save() {
      attempted.value = true; error.value = null;
      if (errs.value.customer || errs.value.amount) return;
      saving.value = true;
      try {
        done.value = await call("record_payment", { customer: f.customer.name, amount: +f.amount, mode_of_payment: f.mode, sales_order: f.order || null }, true);
        toast(t("p_done", done.value));
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
        <div class="alert success"><Icon name="check"/><span>{{ t('p_done', done) }}</span></div>
        <div class="row wrap"><a class="btn primary" target="_blank" rel="noopener" :href="'/api/method/frappe.utils.print_format.download_pdf?doctype=Payment%20Entry&name='+encodeURIComponent(done)">{{ t('p_receipt') }}</a>
          <button type="button" class="btn" @click="close">{{ t('close') }}</button></div>
      </template>
      <template v-else>
        <div v-if="error" class="alert error" role="alert"><Icon name="alert"/><span>{{ error }}</span></div>
        <div class="field"><label for="p-c" class="req">{{ t('p_customer') }}</label>
          <CustomerPicker v-model="f.customer" input-id="p-c" :invalid="attempted && !!errs.customer"/>
          <span v-if="attempted && errs.customer" class="error-text">{{ errs.customer }}</span></div>
        <div class="field"><label for="p-a" class="req">{{ t('p_amount') }}</label>
          <input id="p-a" lang="fr" class="input num" :class="{invalid: attempted && errs.amount}" type="text" inputmode="decimal" autocomplete="off" min="0" step="any" v-model="f.amount" enterkeyhint="done">
          <span v-if="attempted && errs.amount" class="error-text">{{ errs.amount }}</span></div>
        <div class="field"><span class="label">{{ t('p_mode') }}</span>
          <div class="seg" role="group"><button v-for="m in state.boot.modes" :key="m.value" type="button" :aria-pressed="f.mode===m.value" @click="f.mode=m.value">{{ m.label }}</button></div></div>
        <div class="field"><label for="p-o">{{ t('p_order') }}</label>
          <select id="p-o" class="input" v-model="f.order"><option value="">{{ t('p_order_none') }}</option>
            <option v-for="o in orders" :key="o.name" :value="o.name">{{ (o.atelier_subject || o.name) + ' — ' + money(o.grand_total - o.paid) }}</option></select></div>
        <button type="submit" class="btn primary block" :disabled="saving">{{ saving ? t('of_saving') : t('p_save') }}</button>
      </template>
    </form>
  </div>`,
};

// ------------------------------------------------------------------ shell
const NAV = [
  { key: "home", path: "/", icon: "home", label: "nav_home" },
  { key: "orders", path: "/orders/new", icon: "orders", label: "nav_orders", match: ["order", "order-new", "orders"] },
  { key: "customers", path: "/customers", icon: "users", label: "nav_customers", match: ["customer", "customers"] },
];
const DESK_NAV = [
  { href: "/app/accounting", icon: "money", label: "nav_money" },
  { href: "/app/stock", icon: "box", label: "nav_stock" },
  { href: "/app/asset", icon: "gear", label: "nav_machines" },
  { href: "/app/query-report/Rentabilite Commande", icon: "chart", label: "nav_reports" },
];

const App = {
  components: { Icon, SearchBox, Home, OrderNew, OrderView, CustomerView, CustomerList, PaymentSheet },
  setup() {
    const bootErr = ref(null);
    const loadBoot = async () => {
      bootErr.value = null;
      try { state.boot = await call("boot"); } catch (e) { bootErr.value = e.message; }
    };
    onMounted(async () => {
      await loadBoot();
      if (state.query.get("action") === "payment" && state.boot?.can.payment) state.sheet = { type: "payment" };
      if ("serviceWorker" in navigator) navigator.serviceWorker.register("/atelier-sw.js", { scope: "/atelier" }).catch(() => {});
    });
    const isActive = (n) => (n.match || [n.key]).includes(route.value.name);
    const titles = { "order-new": "of_title", customer: "c_title", customers: "c_title", order: "nav_orders" };
    return { state, route, NAV, DESK_NAV, isActive, bootErr, loadBoot, t, go, titles };
  },
  template: `
  <div v-if="bootErr" class="page"><div class="alert error" role="alert"><span style="flex:1">{{ bootErr }}</span><button class="btn sm" @click="loadBoot">{{ t('retry') }}</button></div></div>
  <div v-else-if="!state.boot" class="boot">{{ t('loading') }}</div>
  <div v-else class="shell">
    <nav class="sidebar" :aria-label="t('app_name')">
      <div class="brand"><img src="/assets/atelier/atelier/icon.svg" alt="">{{ t('app_name') }}</div>
      <a v-for="n in NAV" :key="n.key" class="nav" :class="{active: isActive(n)}" :href="'/atelier'+(n.path==='/'?'':n.path)" @click.prevent="go(n.path)" :aria-current="isActive(n) ? 'page' : null">
        <Icon :name="n.icon"/>{{ t(n.label) }}</a>
      <div class="sep"></div>
      <a v-for="n in DESK_NAV" :key="n.href" class="nav" :href="n.href"><Icon :name="n.icon"/>{{ t(n.label) }}<span class="soon">{{ t('soon') }}</span></a>
      <div class="spacer"></div>
      <a class="nav" href="/app"><Icon name="ext"/>{{ t('nav_erpnext') }}</a>
      <div class="xs muted" style="padding:8px 12px">{{ state.boot.full_name }}</div>
    </nav>

    <div class="main">
      <div v-if="state.boot.is_demo" class="demo-banner" role="note"><Icon name="alert" :size="16"/>{{ t('demo_banner') }}</div>
      <div v-if="!state.online" class="alert warn" role="status" style="border-radius:0"><Icon name="wifi"/>{{ t('offline') }}</div>
      <header class="topbar">
        <button v-if="route.name!=='home'" class="btn ghost icon-btn mobile-only" :aria-label="t('back')" @click="history.length>1 ? history.back() : go('/')"><Icon name="back"/></button>
        <span v-if="route.name!=='home'" class="title mobile-only ellipsis">{{ t(titles[route.name] || 'app_name') }}</span>
        <SearchBox :class="{'desktop-only': route.name!=='home'}"/>
        <div class="row desktop-only" style="gap:8px">
          <a class="btn primary" href="/atelier/orders/new" @click.prevent="go('/orders/new')"><Icon name="plus"/>{{ t('new_order') }}</a>
          <button v-if="state.boot.can.payment" class="btn" @click="state.sheet={type:'payment'}"><Icon name="in" style="color:var(--success)"/>{{ t('record_payment') }}</button>
          <a v-if="state.boot.can.expense" class="btn" href="/app/journal-entry/new" :title="t('expense_hint')"><Icon name="out" style="color:var(--danger)"/>{{ t('record_expense') }}</a>
        </div>
      </header>
      <main>
        <Home v-if="route.name==='home'" :key="state.path"/>
        <OrderNew v-else-if="route.name==='order-new'" :key="state.path + state.query"/>
        <OrderView v-else-if="route.name==='order'" :id="route.id" :key="route.id"/>
        <CustomerView v-else-if="route.name==='customer'" :id="route.id" :key="route.id"/>
        <CustomerList v-else-if="route.name==='customers'"/>
      </main>
    </div>

    <nav class="bottom-nav" :aria-label="t('app_name')">
      <a href="/atelier" :class="{active: route.name==='home'}" @click.prevent="go('/')"><Icon name="home"/>{{ t('nav_home') }}</a>
      <a href="/atelier/customers" :class="{active: ['customer','customers'].includes(route.name)}" @click.prevent="go('/customers')"><Icon name="users"/>{{ t('nav_customers') }}</a>
      <a class="fab" href="/atelier/orders/new" @click.prevent="go('/orders/new')" :aria-label="t('new_order')"><span class="fab-circle"><Icon name="plus" :size="24"/></span><span class="lbl">{{ t('new_order') }}</span></a>
      <button v-if="state.boot.can.payment" @click="state.sheet={type:'payment'}"><Icon name="in"/>{{ t('record_payment') }}</button>
      <a v-else href="/atelier/customers" @click.prevent="go('/customers')"><Icon name="search"/>{{ t('search_label') }}</a>
      <a href="/app"><Icon name="more"/>{{ t('nav_more') }}</a>
    </nav>

    <PaymentSheet v-if="state.sheet && state.sheet.type==='payment'" :opts="state.sheet"/>
    <div v-if="state.toast" class="toast" role="status" aria-live="polite"><div class="alert" :class="state.toast.kind"><Icon :name="state.toast.kind==='error' ? 'alert' : 'check'"/>{{ state.toast.message }}</div></div>
  </div>`,
};

const app = createApp(App);
app.config.globalProperties.history = window.history;
app.config.globalProperties.setTimeout = window.setTimeout.bind(window);
app.mount("#app");
