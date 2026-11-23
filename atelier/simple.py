"""The simple workshop: an order board (new → in work → ready → delivered), a one-form order, customers and money.

Every screen still writes real ERPNext documents (Sales Order, Delivery Note, Sales Invoice, Payment Entry),
but the person using it never handles them: moving a card to «سُلّم» delivers and invoices in one step.
"""

import re
import json

import frappe
from frappe.rate_limiter import rate_limit
from frappe import _
from frappe.utils import add_days, cint, flt, get_first_day, get_last_day, nowdate

from atelier import production


class _Api:
	"""atelier.api imports this module at its end, so it is looked up on use."""

	def __getattr__(self, name):
		from atelier import api

		return getattr(api, name)


api = _Api()

COLUMNS = {"new": "جديد", "work": "طباعة", "ready": "جاهز للتسليم", "done": "سُلّم"}
GENERAL_ITEM = "SRV-GENERAL"


def custom_fields():
	from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

	create_custom_fields({"Sales Order": [
		{"fieldname": "atelier_assignee", "label": "من يعمل عليه", "fieldtype": "Data", "insert_after": "atelier_stage", "module": "Atelier"},
	]})


def column_of(stage, per_delivered=0):
	if flt(per_delivered) >= 100 or stage == "سُلّم":
		return "done"
	if stage == "جاهز للتسليم":
		return "ready"
	if not stage or stage == "جديد":
		return "new"
	return "work"


@frappe.whitelist()
def board():
	"""Open orders plus what was delivered in the last two weeks."""
	rows = api._order_rows({"docstatus": ["<", 2], "status": ["not in", ["Closed"]]}, limit=400)
	since = add_days(nowdate(), -14)
	names = [r.name for r in rows]
	extra = dict(frappe.get_all("Sales Order", filters={"name": ["in", names or [""]]}, fields=["name", "atelier_assignee"], as_list=True))
	out = []
	for r in rows:
		r.column = column_of(r.atelier_stage, r.per_delivered)
		if r.column == "done" and str(r.transaction_date) < since and r.paid >= flt(r.grand_total) - 0.005:
			continue
		r.assignee = extra.get(r.name)
		out.append(r)
	return out


def _general_item():
	if not frappe.db.exists("Item", GENERAL_ITEM):
		group = "خدمات" if frappe.db.exists("Item Group", "خدمات") else frappe.db.get_value("Item Group", {"is_group": 0})
		frappe.get_doc({"doctype": "Item", "item_code": GENERAL_ITEM, "item_name": "عمل طباعة", "item_group": group,
			"stock_uom": "Nos", "is_stock_item": 0, "is_sales_item": 1, "is_purchase_item": 0}).insert(ignore_permissions=True)
	return GENERAL_ITEM


def _order_lines(d):
	"""One line per service or free text. The older one-line form still works."""
	rows = d.get("lines")
	if rows is None:
		rows = [{"text": d.get("what"), "qty": 1, "rate": d.get("price")}]
	lines = []
	for row in rows:
		text = (row.get("text") or "").strip()[:280]
		code = row.get("item_code")
		if not text and not code:
			continue
		if code and not frappe.db.get_value("Item", code, "is_sales_item"):
			frappe.throw(_("خدمة غير صالحة"))
		rate = row.get("rate")
		line = {"item_code": code or _general_item(), "qty": flt(row.get("qty")) or 1, "description": text,
			"rate": None if rate in (None, "") else flt(rate)}
		line.update(_measure(row, line["qty"]))
		if row.get("material"):  # optional: which stock material this line will use, and how many fit on a sheet
			if not frappe.db.has_column("Sales Order Item", "atelier_material"):
				line_fields()
			line["atelier_material"] = row["material"] if frappe.db.exists("Item", {"name": row["material"], "is_stock_item": 1}) else None
			line["atelier_per_sheet"] = max(1, flt(row.get("per")) or 1)
		_allow_fraction(line)
		lines.append(line)
	return lines


def _allow_fraction(line):
	"""A service sold by the m² or the metre has a fractional quantity (2 × 0.85 = 1.7). ERPNext refuses that when the
	service's unit is a whole-number unit like Nos: let that unit take fractions, for services only (stock items keep their rule)."""
	qty = flt(line.get("qty"))
	if abs(qty - round(qty)) < 1e-9:
		return
	item = frappe.db.get_value("Item", line["item_code"], ["stock_uom", "is_stock_item"], as_dict=True)
	if item and not item.is_stock_item and cint(frappe.db.get_value("UOM", item.stock_uom, "must_be_whole_number")):
		frappe.db.set_value("UOM", item.stock_uom, "must_be_whole_number", 0)


LINE_FIELDS = [
	{"fieldname": "atelier_unit", "label": "الوحدة", "fieldtype": "Data", "insert_after": "description"},
	{"fieldname": "atelier_width", "label": "العرض", "fieldtype": "Float", "insert_after": "atelier_unit"},
	{"fieldname": "atelier_height", "label": "الارتفاع", "fieldtype": "Float", "insert_after": "atelier_width"},
	{"fieldname": "atelier_length", "label": "الطول", "fieldtype": "Float", "insert_after": "atelier_height"},
	{"fieldname": "atelier_pieces", "label": "القطع", "fieldtype": "Float", "insert_after": "atelier_length"},
	{"fieldname": "atelier_size", "label": "المقاس", "fieldtype": "Data", "insert_after": "atelier_pieces"},
	{"fieldname": "atelier_category", "label": "التصنيف", "fieldtype": "Data", "insert_after": "atelier_size"},
	{"fieldname": "atelier_material", "label": "المادة", "fieldtype": "Data", "insert_after": "atelier_category"},
	{"fieldname": "atelier_per_sheet", "label": "في كل ورقة", "fieldtype": "Float", "insert_after": "atelier_material"},
]
LINE_KEYS = [f["fieldname"] for f in LINE_FIELDS]


def line_fields():
	"""Unit, size and category on every selling line; ERPNext copies same-named fields from the order to the delivery note and invoice."""
	from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

	fields = [{**f, "module": "Atelier"} for f in LINE_FIELDS]
	create_custom_fields({dt: fields for dt in ("Quotation Item", "Sales Order Item", "Delivery Note Item", "Sales Invoice Item")})
	create_custom_fields({"Item": [{"fieldname": "atelier_category", "label": "التصنيف", "fieldtype": "Data", "insert_after": "item_group", "module": "Atelier"}]})


def _g(v):
	return ("%g" % flt(v))


def _measure(row, qty):
	"""qty from the unit: area = width x height x pieces, length = length x pieces, count = the quantity typed."""
	name = (row.get("unit") or "").strip()
	unit = next((u for u in units() if u["name"] == name), None)
	if not unit:
		return {"atelier_category": (row.get("category") or "").strip()[:60] or None} if row.get("category") else {}
	out = {"atelier_unit": unit["name"], "atelier_category": (row.get("category") or "").strip()[:60] or None}
	sym = "سم" if unit.get("scale") == "cm" else "م"
	pieces = flt(row.get("pieces")) or 1
	if unit["calc"] == "area":
		w, h = flt(row.get("width")), flt(row.get("height"))
		if w <= 0 or h <= 0:
			frappe.throw(_("اكتب العرض والارتفاع للبند «{0}»").format(row.get("text") or ""))
		out.update(atelier_width=w, atelier_height=h, atelier_pieces=pieces, qty=round(w * h * pieces, 4),
			atelier_size="%s×%s %s · %s قطعة" % (_g(w), _g(h), sym, _g(pieces)))
	elif unit["calc"] == "length":
		ln = flt(row.get("length"))
		if ln <= 0:
			frappe.throw(_("اكتب الطول للبند «{0}»").format(row.get("text") or ""))
		out.update(atelier_length=ln, atelier_pieces=pieces, qty=round(ln * pieces, 4),
			atelier_size="%s %s · %s قطعة" % (_g(ln), sym, _g(pieces)))
	return out


def _order_subject(lines):
	if not lines:
		return ""
	first = lines[0]["description"] or frappe.db.get_value("Item", lines[0]["item_code"], "item_name")
	return first[:120] + (f" +{len(lines) - 1}" if len(lines) > 1 else "")


@frappe.whitelist(methods=["POST"])
def quick_order(data):
	"""One short form: customer, what, price, advance, due date, who works on it, tags."""
	d = frappe.parse_json(data)
	lines = _order_lines(d)
	mode = d.get("mode") or "Cash"
	if flt(d.get("advance")) > 0 and mode not in [m[0] for m in api.all_modes()]:
		frappe.throw(_("طريقة الدفع غير صالحة"))
	res = api.create_order(json.dumps({
		"customer": d.get("customer"), "new_customer": d.get("new_customer") or {},
		"subject": (d.get("subject") or "").strip()[:120] or _order_subject(lines), "delivery_date": d.get("delivery_date"), "no_steps": 1, "items": lines,
		"advance": {"amount": flt(d.get("advance")), "mode_of_payment": mode},
	}, ensure_ascii=False))
	so = res["sales_order"]
	_apply_customer_note(so)
	column = d.get("column")
	if column:
		cfg = get_config()
		if column not in [c["id"] for c in cfg["columns"]] or column == _deliver_col(cfg):
			frappe.throw(_("لا يمكن بدء الطلب من هذا العمود"))
		frappe.db.set_value("Sales Order", so, "atelier_column", column)
	if d.get("assignee"):
		frappe.db.set_value("Sales Order", so, "atelier_assignee", d["assignee"].strip()[:80])
	if (d.get("description") or "").strip():
		frappe.db.set_value("Sales Order", so, "atelier_description", d["description"].strip()[:5000])
	checklist = [{"text": str(t).strip()[:200], "done": 0} for t in (d.get("checklist") or []) if str(t).strip()]
	if checklist:
		frappe.db.set_value("Sales Order", so, "atelier_checklist", json.dumps(checklist, ensure_ascii=False))
	if d.get("tags"):
		production.set_tags(so, json.dumps(d["tags"], ensure_ascii=False))
	if d.get("status") or d.get("labels"):
		cfg = get_config()
		st = [x for x in (d.get("status") or []) if x in {s["id"] for s in cfg["statuses"]}]
		lb = [x for x in (d.get("labels") or []) if x in {l["id"] for l in cfg["labels"]}]
		if st:
			frappe.db.set_value("Sales Order", so, "atelier_status", ",".join(st))
		if lb:
			frappe.db.set_value("Sales Order", so, "atelier_labels", json.dumps(lb))
	return res


@frappe.whitelist(methods=["POST"])
def move(name, column):
	"""Drag a card. «سُلّم» = delivery note + invoice (advances deducted), so nobody handles paperwork."""
	if column not in COLUMNS:
		frappe.throw(_("عمود غير معروف"))
	api.lock_order(name)  # a double click or two people delivering at once: one delivery, one invoice
	so = frappe.get_doc("Sales Order", name)
	so.check_permission("write")
	if column_of(so.atelier_stage, so.per_delivered) == "done":
		frappe.throw(_("هذا الطلب سُلّم ولا يمكن إرجاعه"))
	if column == "done":
		api.confirm_if_priced(so)
		if so.docstatus == 0:
			frappe.throw(_("حدد سعر الطلب قبل تسليمه"))
		if so.per_delivered < 100:
			api.deliver_order(name)
		so.reload()
		if so.per_billed < 100:
			api.invoice_order(name)
	so.reload()
	so.db_set("atelier_stage", COLUMNS[column])
	return column


@frappe.whitelist()
def partial_info(name):
	"""Lines of an order with what was delivered and what is left, for «تسليم جزء»."""
	so = frappe.get_doc("Sales Order", name)
	so.check_permission("read")
	no_worker()
	whole = lambda u: bool(frappe.db.get_value("UOM", u, "must_be_whole_number"))  # noqa: E731
	return {"name": so.name, "customer_name": so.customer_name, "title": so.get("atelier_subject") or so.name,
		"lines": [{"row": i.name, "item_name": frappe.utils.strip_html(i.description or "") or i.item_name, "qty": flt(i.qty),
			"delivered": flt(i.delivered_qty), "left": flt(i.qty) - flt(i.delivered_qty), "rate": flt(i.rate), "whole": whole(i.uom)}
			for i in so.items]}


@frappe.whitelist(methods=["POST"])
def partial_deliver(name, qtys):
	"""Deliver some lines now: a delivery note for them and an invoice for exactly what it delivered (the order's
	advances deducted up to that invoice). The card stays on the board until the rest is delivered."""
	api.lock_order(name)
	so = frappe.get_doc("Sales Order", name)
	so.check_permission("write")
	no_worker()
	if so.docstatus != 1:
		frappe.throw(_("حدد سعر الطلب قبل تسليمه"))
	info = {l["row"]: l for l in partial_info(name)["lines"]}
	qtys = {k: flt(v) for k, v in (frappe.parse_json(qtys) or {}).items() if flt(v) > 0}
	if not qtys:
		frappe.throw(_("اختر كمية بند واحد على الأقل"))
	for row, q in qtys.items():
		if row not in info or q > info[row]["left"] + 1e-9:
			frappe.throw(_("الكمية أكبر من الباقي للتسليم"))
		if info[row]["whole"] and q != int(q):
			frappe.throw(_("وحدة «{0}» لا تقبل الكسور: اكتب عددًا صحيحًا").format(info[row]["item_name"]))
	dn = api.deliver_order(name, json.dumps(qtys))
	inv = api.invoice_order(name, delivery_note=dn)
	so.reload()
	_log(name, _("سلّم جزءًا من الطلب — فاتورة {0}").format(inv))
	if so.per_delivered >= 100:  # everything delivered: the card goes to the delivery column like a drag would
		so.db_set("atelier_stage", COLUMNS["done"])
		col = _deliver_col(get_config())
		if col:
			frappe.db.set_value("Sales Order", name, "atelier_column", col)
	return {"delivery_note": dn, "invoice": inv, "complete": so.per_delivered >= 100,
		"outstanding": flt(frappe.db.get_value("Sales Invoice", inv, "outstanding_amount"))}


@frappe.whitelist(methods=["POST"])
def update_order(name, assignee=None, price=None):
	"""Change who works on it, or give a price to an order saved without one (then it is confirmed)."""
	so = frappe.get_doc("Sales Order", name)
	so.check_permission("write")
	if assignee is not None:
		so.db_set("atelier_assignee", (assignee or "").strip()[:80] or None)
	if price not in (None, "") and so.docstatus == 0:
		if flt(price) < 0:
			frappe.throw(_("السعر لا يكون سالبًا"))
		# The price is the order's total: lines already priced keep their rate, the rest share what remains.
		pending = [r for r in so.items if r.atelier_price_pending]
		remaining = flt(price) - sum(flt(r.qty) * flt(r.rate) for r in so.items if not r.atelier_price_pending)
		if remaining < 0:
			frappe.throw(_("السعر أقل من مجموع البنود المسعّرة"))
		units = sum(flt(r.qty) for r in pending)
		rates = {r.name: remaining / units for r in pending}
		api.price_order(name, json.dumps(rates))
		api.confirm_order(name)
	return name


@frappe.whitelist()
def money():
	"""This month's in/out from the cash and bank accounts, the latest movements, and who owes money."""
	api._require("GL Entry")
	company = api._company()
	start, end = get_first_day(nowdate()), get_last_day(nowdate())
	cash = [r[0] for r in frappe.db.sql("select name from `tabAccount` where company=%s and account_type in ('Cash','Bank') and is_group=0", company)] or [""]

	def one(sql, *args):
		return flt(frappe.db.sql(sql, args)[0][0])

	cash_in = one("select sum(debit) from `tabGL Entry` where is_cancelled=0 and is_opening='No' and posting_date between %s and %s and account in %s", start, end, cash)
	cash_out = one("select sum(credit) from `tabGL Entry` where is_cancelled=0 and is_opening='No' and posting_date between %s and %s and account in %s", start, end, cash)
	moves = frappe.db.sql(
		"""select gle.voucher_type, gle.voucher_no, gle.posting_date, sum(gle.debit - gle.credit) amount,
		max(gle.remarks) remarks, max(gle.owner) owner
		from `tabGL Entry` gle where gle.is_cancelled=0 and gle.account in %s
		group by gle.voucher_type, gle.voucher_no, gle.posting_date order by gle.posting_date desc, max(gle.creation) desc limit 25""",
		[cash], as_dict=True)
	_transfer_amounts(moves, cash, frappe.get_all("Account", filters={"name": ["in", cash]}, fields=["name", "account_name"]))
	for m in moves:
		m.title = m.get("title") or _title(m)
		m.by = frappe.utils.get_fullname(m.owner)
		m.mode = frappe.db.get_value("Payment Entry", m.voucher_no, "mode_of_payment") if m.voucher_type == "Payment Entry" else None
	debtors = frappe.db.sql(
		"""select customer, customer_name, sum(outstanding_amount) amount,
		max(case when due_date < curdate() then datediff(curdate(), due_date) else 0 end) late
		from `tabSales Invoice` where docstatus=1 and company=%s and outstanding_amount > 0.005
		group by customer order by amount desc""", company, as_dict=True)
	return {
		"month": str(start), "cash_balance": one("select sum(debit - credit) from `tabGL Entry` where is_cancelled=0 and account in %s", cash),
		"income": cash_in, "expenses": cash_out, "profit": cash_in - cash_out,
		"payers": cint(one("""select count(distinct party) from `tabPayment Entry` where docstatus=1 and payment_type='Receive'
			and party_type='Customer' and posting_date between %s and %s""", start, end)),
		"moves": moves, "debtors": debtors,
	}


def _transfer_amounts(moves, funds, accs):
	"""Money moved from one fund to another adds up to zero over the funds: show what moved, and from where to where."""
	names = {a.name: a.account_name for a in accs}
	for m in moves:
		if abs(flt(m.amount)) > 0.005:
			continue
		legs = frappe.db.sql("""select account, sum(debit) d, sum(credit) c from `tabGL Entry` where is_cancelled=0 and voucher_no=%s
			and account in %s group by account""", (m.voucher_no, funds), as_dict=True)
		moved = sum(flt(l.d) for l in legs)
		if moved > 0.005:
			src = next((names.get(l.account, l.account) for l in legs if flt(l.c) > 0.005), "")
			dst = next((names.get(l.account, l.account) for l in legs if flt(l.d) > 0.005), "")
			m.amount, m.transfer = moved, 1
			m.title = _("تحويل من {0} إلى {1}").format(src, dst)


def _title(m):
	if m.voucher_type == "Payment Entry":
		pe = frappe.db.get_value("Payment Entry", m.voucher_no, ["party_name", "payment_type", "party_type"], as_dict=True) or {}
		if pe.get("payment_type") == "Receive":
			return _("دفعة من {0}").format(pe.get("party_name") or "")
		return _("دفع إلى {0}").format(pe.get("party_name") or "")
	if m.voucher_type == "Journal Entry":
		remark = frappe.db.get_value("Journal Entry", m.voucher_no, "user_remark")
		return (remark or m.remarks or _("مصروف")).split("\n")[0][:80]
	return m.remarks or m.voucher_type


def demo():
	frappe.set_user("Administrator")
	custom_fields()
	people = [m["name"] for m in production._team()] or ["سمير"]
	for i, so in enumerate(frappe.get_all("Sales Order", filters={"docstatus": ["<", 2]}, pluck="name")):
		frappe.db.set_value("Sales Order", so, "atelier_assignee", people[i % len(people)])
	frappe.db.commit()


# ---------------------------------------------------------------- Trello-style board: custom columns, labels, card details
# The manager shapes the board (columns, labels, team). A card is a Sales Order; its column, labels, members,
# description and checklist live in custom fields, its files are Frappe attachments, its comments and activity
# are Frappe Comments. Only the column marked «deliver» touches accounting (delivery note + invoice).

COLORS = ["#F5D547", "#F59E0B", "#E5484D", "#2563EB", "#22A06B", "#D7F1A8", "#9B87F5", "#5C5670", "#1597A6", "#C2410C"]
DEFAULT_CONFIG = {
	"columns": [
		{"id": "c-new", "name": "جديد", "color": "#9A94AC"},
		{"id": "c-design", "name": "تصميم", "color": "#9B87F5"},
		{"id": "c-approve", "name": "موافقة العميل", "color": "#1597A6"},
		{"id": "c-work", "name": "طباعة", "color": "#F59E0B"},
		{"id": "c-finish", "name": "تشطيب", "color": "#C2410C"},
		{"id": "c-ready", "name": "جاهز", "color": "#2563EB"},
		{"id": "c-done", "name": "سُلّم", "color": "#22A06B", "deliver": 1},
	],
	"labels": [
		{"id": "l-wait", "name": "بالانتظار", "color": "#F5D547"},
		{"id": "l-cours", "name": "قيد العمل", "color": "#F59E0B"},
		{"id": "l-valid", "name": "للمراجعة", "color": "#22A06B"},
		{"id": "l-done", "name": "منتهٍ", "color": "#2563EB"},
		{"id": "l-urgent", "name": "عاجل", "color": "#E5484D"},
		{"id": "l-important", "name": "مهم", "color": "#C2410C"},
		{"id": "l-approve", "name": "في انتظار موافقة العميل", "color": "#1597A6"},
	],
}
CARD_FIELDS = [
	{"fieldname": "atelier_column", "label": "عمود اللوحة", "fieldtype": "Data", "insert_after": "atelier_assignee"},
	{"fieldname": "atelier_labels", "label": "الحالات", "fieldtype": "Small Text", "insert_after": "atelier_column"},
	{"fieldname": "atelier_members", "label": "الأعضاء", "fieldtype": "Small Text", "insert_after": "atelier_labels"},
	{"fieldname": "atelier_description", "label": "الوصف", "fieldtype": "Text", "insert_after": "atelier_members"},
	{"fieldname": "atelier_checklist", "label": "قائمة المهام", "fieldtype": "Text", "insert_after": "atelier_description"},
	{"fieldname": "atelier_cover", "label": "الغلاف", "fieldtype": "Data", "insert_after": "atelier_checklist"},
	{"fieldname": "atelier_due_time", "label": "ساعة التسليم", "fieldtype": "Time", "insert_after": "atelier_cover"},
]


def board_fields():
	from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

	create_custom_fields({"Sales Order": [{**f, "module": "Atelier"} for f in CARD_FIELDS]})


def _is_manager():
	return bool(frappe.has_permission("Item Price", "write"))


# new sites start with Arabic statuses; older sites keep the names they stored (all editable)
STATUS_NAMES = ("En attente", "En cours", "En validation", "Terminé", "بالانتظار", "قيد العمل", "للمراجعة", "منتهٍ")
COVER_COLORS = ("#0F6E56", "#534AB7", "#993C1D", "#185FA5", "#993556", "#5F5E5A", "#854F0B", "#3B6D11")


def get_config():
	try:
		cfg = json.loads(frappe.db.get_default("atelier_board") or "null")
	except ValueError:
		cfg = None
	cfg = cfg or json.loads(json.dumps(DEFAULT_CONFIG))
	if "statuses" not in cfg:  # before statuses: the En cours / Terminé labels become the card's status
		cfg["statuses"] = [l for l in cfg["labels"] if l["name"] in STATUS_NAMES] or [
			{"id": "s-cours", "name": "En cours", "color": "#BA7517"}, {"id": "s-done", "name": "Terminé", "color": "#3B6D11"}]
		cfg["labels"] = [l for l in cfg["labels"] if l["name"] not in STATUS_NAMES]
	return cfg


def _status_of(so, labels, cfg):
	"""A card's statuses, in the board's order. Stored as comma-separated ids; "-" means none chosen."""
	ids = [s["id"] for s in cfg["statuses"]]
	raw = so.get("atelier_status")
	if raw == "-":
		return []
	have = set((raw or "").split(",")) if raw else {x for x in labels if x in ids}
	return [i for i in ids if i in have]


def _deliver_col(cfg):
	return next((c["id"] for c in cfg["columns"] if c.get("deliver")), None)


def _jl(raw):
	try:
		v = json.loads(raw or "[]")
		return v if isinstance(v, list) else []
	except ValueError:
		return []


def _column_for(so, cfg):
	"""The card's column; orders from before the board get one from their stage."""
	ids = [c["id"] for c in cfg["columns"]]
	if so.get("atelier_column") in ids:
		return so.atelier_column
	if flt(so.get("per_delivered")) >= 100 or so.get("atelier_stage") == "سُلّم":
		return _deliver_col(cfg) or ids[-1]
	old = column_of(so.get("atelier_stage"), so.get("per_delivered"))
	work = [i for i in ids if i != _deliver_col(cfg)]
	return {"new": work[0], "work": work[min(1, len(work) - 1)], "ready": work[-1]}.get(old, work[0])


def _log(name, text):
	frappe.get_doc({"doctype": "Comment", "comment_type": "Info", "reference_doctype": "Sales Order", "reference_name": name,
		"content": text}).insert(ignore_permissions=True)


@frappe.whitelist()
def board2():
	cfg = get_config()
	label_by_name = {l["name"]: l["id"] for l in cfg["labels"]}
	rows = api._order_rows({"docstatus": ["<", 2], "status": ["not in", ["Closed"]]}, limit=500)
	worker, me = is_worker(), _member_of(frappe.session.user)
	names = [r.name for r in rows] or [""]
	extra = {r.name: r for r in frappe.get_all("Sales Order", filters={"name": ["in", names]},
		fields=["name", "atelier_column", "atelier_labels", "atelier_members", "atelier_checklist", "atelier_cover", "atelier_assignee", "atelier_due_time", "atelier_archived", "atelier_pos",
			"atelier_status", "atelier_cover_color"])}
	comments = dict(frappe.db.sql("""select reference_name, count(*) from `tabComment` where reference_doctype='Sales Order'
		and comment_type='Comment' and reference_name in %s group by reference_name""", [names]))
	files = dict(frappe.db.sql("""select attached_to_name, count(*) from `tabFile` where attached_to_doctype='Sales Order'
		and attached_to_name in %s group by attached_to_name""", [names]))
	since = add_days(nowdate(), -21)
	deliver = _deliver_col(cfg)
	cards = []
	for r in rows:
		e = extra.get(r.name) or frappe._dict()
		if e.get("atelier_archived"):
			continue
		r.update({k: e.get(k) for k in ("atelier_column", "atelier_cover")})
		r.column = _column_for(r, cfg)
		if r.column == deliver and str(r.transaction_date) < since and r.paid >= flt(r.grand_total) - 0.005:
			continue
		labels = _jl(e.get("atelier_labels"))
		if not e.get("atelier_labels"):  # before the board: tags become labels
			labels = [label_by_name[t] for t in r.tags if t in label_by_name]
		members = _jl(e.get("atelier_members")) or ([e.atelier_assignee] if e.get("atelier_assignee") else [])
		if worker and me not in members:
			continue
		if worker:
			r.grand_total = r.paid = None
		checklist = _jl(e.get("atelier_checklist"))
		cards.append({
			"name": r.name, "title": r.atelier_subject or r.name, "customer": r.customer, "customer_name": r.customer_name,
			"column": r.column, "labels": labels, "members": members, "due": r.delivery_date, "due_time": str(e.atelier_due_time)[:5] if e.get("atelier_due_time") else None, "cover": r.atelier_cover, "pos": e.get("atelier_pos"),
			"grand_total": r.grand_total, "paid": r.paid, "price_pending": r.price_pending, "docstatus": r.docstatus,
			"per_delivered": r.per_delivered, "comments": comments.get(r.name, 0), "files": files.get(r.name, 0),
			"check": [sum(1 for c in checklist if c.get("done")), len(checklist)],
			"status": _status_of(e, labels, cfg), "cover_color": e.get("atelier_cover_color"),
		})
	return {"config": cfg, "cards": cards, "manager": _is_manager(), "worker": worker, "me": me, "calendar": calendar_settings()}


@frappe.whitelist(methods=["POST"])
def save_board(config, moves=None):
	"""Columns and labels of the board. moves = {deleted column id: column id} for the cards of a removed column."""
	if not _is_manager():
		frappe.throw(_("التخصيص للمدير فقط"), frappe.PermissionError)
	cfg = frappe.parse_json(config)
	old = get_config()
	cols = [{"id": (c.get("id") or frappe.generate_hash(length=8)), "name": (c.get("name") or "").strip()[:60],
		"color": c.get("color") or COLORS[0], **({"deliver": 1} if c.get("deliver") else {}), **({"limit": cint(c["limit"])} if cint(c.get("limit")) > 0 else {}), **({"hidden": 1} if c.get("hidden") else {}), **({"materials": 1} if c.get("materials") else {}), **({"supplier": 1} if c.get("supplier") and not c.get("deliver") else {})} for c in cfg.get("columns") or []]  # a delivery column is never «at a supplier»
	labels = [{"id": (l.get("id") or frappe.generate_hash(length=8)), "name": (l.get("name") or "").strip()[:60], "color": l.get("color") or COLORS[0]}
		for l in cfg.get("labels") or []]
	statuses = [{"id": (l.get("id") or frappe.generate_hash(length=8)), "name": (l.get("name") or "").strip()[:60], "color": l.get("color") or COLORS[0]}
		for l in (cfg.get("statuses") if cfg.get("statuses") is not None else old["statuses"])]
	if any(not l["name"] for l in statuses):
		frappe.throw(_("لكل حالة اسم"))
	if not cols:
		frappe.throw(_("أبقِ عمودًا واحدًا على الأقل"))
	if any(not c["name"] for c in cols) or any(not l["name"] for l in labels):
		frappe.throw(_("لكل عمود وحالة اسم"))
	if sum(1 for c in cols if c.get("deliver")) > 1:
		frappe.throw(_("عمود تسليم واحد فقط"))
	if len(cols) == 1 and cols[0].get("deliver"):
		frappe.throw(_("أضف عمود عمل قبل عمود التسليم"))
	ids = {c["id"] for c in cols}
	moves = frappe.parse_json(moves) or {}
	for gone in [c["id"] for c in old["columns"] if c["id"] not in ids]:
		target = moves.get(gone)
		if target not in ids:
			target = next(c["id"] for c in cols if not c.get("deliver"))
		frappe.db.sql("update `tabSales Order` set atelier_column=%s where atelier_column=%s", (target, gone))
	new = {"columns": cols, "labels": labels, "statuses": statuses}
	frappe.db.set_default("atelier_board", json.dumps(new, ensure_ascii=False))
	return new


@frappe.whitelist(methods=["POST"])
def save_board_tag(kind, id=None, name="", color=""):
	"""Add or edit one status / label from the order window, without sending the whole board."""
	if not _is_manager():
		frappe.throw(_("التخصيص للمدير فقط"), frappe.PermissionError)
	if kind not in ("labels", "statuses"):
		frappe.throw(_("نوع غير معروف"))
	name = (name or "").strip()[:60]
	if not name:
		frappe.throw(_("اكتب الاسم"))
	cfg = get_config()
	rows = [dict(x) for x in cfg[kind]]
	if any(x["name"] == name and x["id"] != id for x in rows):
		frappe.throw(_("يوجد بهذا الاسم"))
	hit = next((x for x in rows if id and x["id"] == id), None)
	if hit:
		hit.update({"name": name, "color": color or hit["color"]})
	else:
		rows.append({"id": frappe.generate_hash(length=8), "name": name, "color": color or COLORS[len(rows) % len(COLORS)]})
	return save_board(json.dumps({**cfg, kind: rows}, ensure_ascii=False))


@frappe.whitelist(methods=["POST"])
def delete_board_tag(kind, id):
	if not _is_manager():
		frappe.throw(_("التخصيص للمدير فقط"), frappe.PermissionError)
	if kind not in ("labels", "statuses"):
		frappe.throw(_("نوع غير معروف"))
	cfg = get_config()
	return save_board(json.dumps({**cfg, kind: [x for x in cfg[kind] if x["id"] != id]}, ensure_ascii=False))


def _uses_materials(so):
	from atelier import materials

	return bool(materials._needed(so))


def _cash_customer():
	name = frappe.db.get_value("Customer", {"customer_name": "زبون نقدي"})
	if not name:
		name = frappe.get_doc({"doctype": "Customer", "customer_name": "زبون نقدي", "customer_group": api._group("final"),
			"customer_type": "Individual", "default_price_list": api._price_list("Individual")}).insert().name
	return name


@frappe.whitelist(methods=["POST"])
def add_card(column, title):
	"""«+ إضافة بطاقة»: just a title in a column; customer, price and the rest come later from the card."""
	title = (title or "").strip()
	if not title:
		frappe.throw(_("اكتب عنوان البطاقة"))
	cfg = get_config()
	if column not in [c["id"] for c in cfg["columns"]] or column == _deliver_col(cfg):
		frappe.throw(_("أضف البطاقة في عمود عمل"))
	res = quick_order(json.dumps({"customer": _cash_customer(), "what": title, "price": None, "delivery_date": add_days(nowdate(), 3)}, ensure_ascii=False))
	so = res["sales_order"]
	frappe.db.set_value("Sales Order", so, "atelier_column", column)
	_log(so, _("أنشأ البطاقة في «{0}»").format(next(c["name"] for c in cfg["columns"] if c["id"] == column)))
	return so


@frappe.whitelist(methods=["POST"])
def move_card(name, column):
	cfg = get_config()
	col = next((c for c in cfg["columns"] if c["id"] == column), None)
	if not col:
		frappe.throw(_("عمود غير معروف"))
	api.lock_order(name)  # the second of two simultaneous moves sees the first one's result and does nothing
	so = frappe.get_doc("Sales Order", name)
	so.check_permission("write")
	current = _column_for(so, cfg)
	if current == column:
		return column
	if flt(so.per_delivered) >= 100 and not col.get("deliver"):
		frappe.throw(_("هذا الطلب سُلّم ولا يمكن إرجاعه"))
	if col.get("deliver"):
		move(name, "done")
	else:
		first = column == cfg["columns"][0]["id"]
		so.db_set("atelier_stage", "جديد" if first else "طباعة")
	frappe.db.set_value("Sales Order", name, "atelier_column", column)
	_log(name, _("نقل البطاقة إلى «{0}»").format(col["name"]))
	return column


@frappe.whitelist()
def card(name):
	so = frappe.get_doc("Sales Order", name)
	so.check_permission("read")
	cfg = get_config()
	row = api._order_rows({"name": name}, limit=1)[0]
	labels = _jl(so.get("atelier_labels"))
	if not so.get("atelier_labels"):
		by = {l["name"]: l["id"] for l in cfg["labels"]}
		labels = [by[t] for t in row.tags if t in by]
	files = frappe.get_all("File", filters={"attached_to_doctype": "Sales Order", "attached_to_name": name},
		fields=["name", "file_name", "file_url", "file_size", "creation", "owner"], order_by="creation desc")
	activity = frappe.get_all("Comment", filters={"reference_doctype": "Sales Order", "reference_name": name, "comment_type": ["in", ["Comment", "Info"]]},
		fields=["name", "comment_type", "content", "owner", "creation"], order_by="creation desc", limit=100)
	for a in activity + files:
		a.by = frappe.utils.get_fullname(a.owner)
	members = _jl(so.get("atelier_members")) or ([so.atelier_assignee] if so.get("atelier_assignee") else [])
	worker = is_worker()
	if worker and _member_of(frappe.session.user) not in members:
		frappe.throw(_("هذه البطاقة ليست مسندة إليك"), frappe.PermissionError)
	client = _client(so.customer)
	if worker:
		row.grand_total = row.paid = None
		client["owes"] = 0
	return {
		"name": name, "title": so.atelier_subject or name, "customer": so.customer, "customer_name": so.customer_name,
		"column": _column_for(so, cfg), "labels": labels,
		"members": members,
		"due": so.delivery_date, "due_time": str(so.atelier_due_time)[:5] if so.get("atelier_due_time") else None,
		"description": so.get("atelier_description") or "", "checklist": _jl(so.get("atelier_checklist")),
		"client": client,
		"cover": so.get("atelier_cover"), "cover_color": so.get("atelier_cover_color"), "final": so.get("atelier_final"),
		"status": _status_of(so, labels, cfg), "files": files, "activity": activity, "folder": _folders().card_folder(name),
		"grand_total": row.grand_total, "paid": row.paid, "price_pending": row.price_pending, "docstatus": so.docstatus,
		"per_delivered": so.per_delivered, "can_edit": bool(frappe.has_permission("Sales Order", "write", so)),
		"can_delete": bool(frappe.has_permission("Sales Order", "write", so)) and not worker and not _delete_blockers(name),
		# designers and production see what to make, never the prices
		"lines": [{**l, "rate": None, "amount": None} for l in _card_lines(so)] if worker else _card_lines(so), "lines_locked": _lines_locked(name),
		"money": not worker,
		"materials_pending": bool(flt(so.per_delivered) >= 100 and not cint(so.get("atelier_materials_done")) and _uses_materials(so)),
	}


@frappe.whitelist(methods=["POST"])
def update_card(name, changes):
	"""Edit card fields; each change is written to the card's activity."""
	so = frappe.get_doc("Sales Order", name)
	so.check_permission("write")
	ch = frappe.parse_json(changes) or {}
	cfg = get_config()
	if "title" in ch:
		t = (ch["title"] or "").strip()[:140]
		if not t:
			frappe.throw(_("العنوان لا يكون فارغًا"))
		so.db_set("atelier_subject", t)
		_folders().card_changed(name)
	if "labels" in ch:
		ids = {l["id"] for l in cfg["labels"]}
		so.db_set("atelier_labels", json.dumps([x for x in ch["labels"] if x in ids]))
	if "members" in ch:
		members = [m for m in ch["members"] if m][:10]
		had = set(_jl(so.get("atelier_members")))
		for m in members:
			if m not in had:
				notify(m, name, _("{0} أسندك إلى «{1}»").format(frappe.utils.get_fullname(frappe.session.user), so.atelier_subject or name))
		so.db_set("atelier_members", json.dumps(members, ensure_ascii=False))
		so.db_set("atelier_assignee", members[0] if members else None)
	if "description" in ch:
		so.db_set("atelier_description", (ch["description"] or "")[:5000])
	if "checklist" in ch:
		before = {c.get("text"): c.get("done") for c in _jl(so.get("atelier_checklist"))}
		items = [{"text": (c.get("text") or "").strip()[:200], "done": 1 if c.get("done") else 0} for c in ch["checklist"] if (c.get("text") or "").strip()]
		so.db_set("atelier_checklist", json.dumps(items, ensure_ascii=False))
		for c in items:
			if c["done"] and not before.get(c["text"]):
				_log(name, _("أكمل «{0}»").format(c["text"]))
	if "cover" in ch:
		so.db_set("atelier_cover", ch["cover"] or None)
	if "cover_color" in ch:
		so.db_set("atelier_cover_color", ch["cover_color"] if ch["cover_color"] in COVER_COLORS else None)
	if "status" in ch:
		st = {s["id"]: s for s in cfg["statuses"]}
		want = ch["status"] if isinstance(ch["status"], list) else ([ch["status"]] if ch["status"] else [])
		if any(x not in st for x in want):
			frappe.throw(_("حالة غير معروفة"))
		want = [i for i in st if i in want]
		before = _status_of(so, _jl(so.get("atelier_labels")), cfg)
		so.db_set("atelier_status", ",".join(want) or "-")
		so.db_set("atelier_labels", json.dumps([x for x in _jl(so.get("atelier_labels")) if x not in st]))
		for x in want:
			if x not in before:
				_log(name, _("أضاف الحالة «{0}»").format(st[x]["name"]))
		for x in before:
			if x not in want:
				_log(name, _("أزال الحالة «{0}»").format(st[x]["name"]))
	if "final" in ch:
		url = ch["final"] or None
		if url and not frappe.db.exists("File", {"attached_to_doctype": "Sales Order", "attached_to_name": name, "file_url": url}):
			frappe.throw(_("هذا الملف ليس من هذه البطاقة"))
		so.db_set("atelier_final", url)
		if url:
			_folders().final_copy(name, url)
			_log(name, _("علّم «{0}» كملف نهائي").format(url.rsplit("/", 1)[-1]))
	if "due_time" in ch:
		so.db_set("atelier_due_time", ch["due_time"] or None)
	if "due" in ch and str(so.delivery_date or "") != str(ch["due"] or ""):
		date = ch["due"] or None
		if so.docstatus == 1:
			frappe.db.sql("update `tabSales Order` set delivery_date=%s where name=%s", (date, name))
			frappe.db.sql("update `tabSales Order Item` set delivery_date=%s where parent=%s", (date, name))
		else:
			so.delivery_date = date
			for i in so.items:
				i.delivery_date = date
			so.save()
		if so.project:
			frappe.db.set_value("Project", so.project, "expected_end_date", date)
		if not date:
			so.db_set("atelier_due_time", None)
		_log(name, _("غيّر الموعد إلى {0}").format(date) if date else _("أزال موعد التسليم"))
	if ch.get("customer") and so.docstatus == 0 and ch["customer"] != so.customer:
		if frappe.db.exists("Payment Entry", {"atelier_order": name, "docstatus": 1}):
			frappe.throw(_("لهذا الطلب تسبيق باسم العميل الحالي، فلا يمكن تغيير العميل"))
		old_folder = _folders().current_card_path(name)
		so.customer = ch["customer"]
		so.selling_price_list = api._price_list(frappe.db.get_value("Customer", so.customer, "customer_type"))
		if so.project:  # ERPNext requires the order and its project to share a customer
			frappe.db.set_value("Project", so.project, "customer", so.customer)
		so.save()
		_folders().card_moved(name, old_folder)
		_log(name, _("غيّر العميل إلى {0}").format(so.customer_name))
	return card(name)


def _client(customer):
	"""What the team should know about the card's customer: contact, history and what they owe."""
	c = frappe.db.get_value("Customer", customer, ["customer_name", "customer_type", "mobile_no"], as_dict=True) or {}
	owes = None
	if api._can("Sales Invoice"):
		owes = flt(frappe.db.sql("select sum(outstanding_amount) from `tabSales Invoice` where customer=%s and docstatus=1", customer)[0][0])
	return {"name": customer, "customer_name": c.get("customer_name"), "type": c.get("customer_type"), "phone": c.get("mobile_no"),
		"orders": frappe.db.count("Sales Order", {"customer": customer, "docstatus": ["<", 2]}), "owes": owes,
		"cash": c.get("customer_name") == "زبون نقدي"}


@frappe.whitelist(methods=["POST"])
def add_comment(name, text):
	so = frappe.get_doc("Sales Order", name)
	so.check_permission("read")
	text = (text or "").strip()
	if not text:
		frappe.throw(_("اكتب التعليق"))
	so.add_comment("Comment", frappe.utils.escape_html(text)[:4000])
	for m in production._team():
		if "@" + m["name"] in text:
			notify(m["name"], name, _("{0} ذكرك: «{1}»").format(frappe.utils.get_fullname(frappe.session.user), text[:80]), "mention")
	return card(name)


@frappe.whitelist(methods=["POST"])
def delete_file(name, file):
	so = frappe.get_doc("Sales Order", name)
	so.check_permission("write")
	f = frappe.get_doc("File", file)
	if f.attached_to_doctype != "Sales Order" or f.attached_to_name != name:
		frappe.throw(_("هذا الملف ليس من هذه البطاقة"))
	if so.get("atelier_cover") == f.file_url:
		so.db_set("atelier_cover", None)
	if so.get("atelier_final") == f.file_url:
		so.db_set("atelier_final", None)
	f.delete(ignore_permissions=True)
	return card(name)


@frappe.whitelist(methods=["POST"])
def file_added(name, file_url, file_name):
	"""After an upload: log it, and make the first image the cover."""
	so = frappe.get_doc("Sales Order", name)
	so.check_permission("write")
	if not so.get("atelier_cover") and str(file_name).lower().rsplit(".", 1)[-1] in ("png", "jpg", "jpeg", "webp", "gif"):
		so.db_set("atelier_cover", file_url)
	_log(name, _("أرفق {0}").format(file_name))
	return card(name)


def demo_board():
	frappe.set_user("Administrator")
	board_fields()
	frappe.db.commit()


# ---------------------------------------------------------------- board extras: archive, copy, order, checklist templates, notifications
EXTRA_FIELDS = [
	{"fieldname": "atelier_archived", "label": "مؤرشفة", "fieldtype": "Check", "insert_after": "atelier_due_time"},
	{"fieldname": "atelier_pos", "label": "الترتيب في العمود", "fieldtype": "Float", "insert_after": "atelier_archived"},
	{"fieldname": "atelier_status", "label": "الحالة", "fieldtype": "Data", "insert_after": "atelier_pos"},
	{"fieldname": "atelier_cover_color", "label": "لون الغلاف", "fieldtype": "Data", "insert_after": "atelier_status"},
	{"fieldname": "atelier_final", "label": "الملف النهائي", "fieldtype": "Data", "insert_after": "atelier_cover_color"},
]


def extra_fields():
	from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

	create_custom_fields({"Sales Order": [{**f, "module": "Atelier"} for f in EXTRA_FIELDS],
		"File": [{"fieldname": "atelier_kind", "label": "نوع الملف في رقمي", "fieldtype": "Data", "insert_after": "file_url", "module": "Atelier"}]})


def _so_write(name):
	so = frappe.get_doc("Sales Order", name)
	so.check_permission("write")
	return so


def _delete_blockers(name):
	"""Money or documents on the order: those must stay in the books, so the card is archived instead."""
	out = []
	if frappe.db.exists("Payment Entry", {"atelier_order": name, "docstatus": 1}) or frappe.db.sql(
			"select 1 from `tabPayment Entry Reference` where reference_name=%s and docstatus=1 limit 1", name):
		out.append(_("دفعة"))
	if frappe.db.exists("Sales Invoice Item", {"sales_order": name, "docstatus": ["<", 2]}):
		out.append(_("فاتورة"))
	if frappe.db.exists("Delivery Note Item", {"against_sales_order": name, "docstatus": ["<", 2]}):
		out.append(_("بون تسليم"))
	# materials issued or an expense charged to the job: their entries point to its project, which must stay
	project = frappe.db.get_value("Sales Order", name, "project")
	if project and frappe.db.exists("GL Entry", {"project": project, "is_cancelled": 0}):
		out.append(_("مواد مصروفة أو مصروف"))
	return out


def _lines_locked(name):
	"""An invoice or a delivery fixes the lines: they must match those documents."""
	return [b for b in _delete_blockers(name) if b != _("دفعة")]


def _card_lines(so):
	out = []
	for i in so.items:
		text = frappe.utils.strip_html(i.description or "").strip()
		out.append({"row": i.name, "item_code": i.item_code, "item_name": i.item_name, "text": text or i.item_name,
			"unit": i.get("atelier_unit") or {"Nos": "قطعة", "Feuille": "ورقة"}.get(i.uom, i.uom) or "", "width": flt(i.get("atelier_width")), "height": flt(i.get("atelier_height")),
			"length": flt(i.get("atelier_length")), "pieces": flt(i.get("atelier_pieces")) or 1, "qty": flt(i.qty),
			"rate": None if cint(i.get("atelier_price_pending")) else flt(i.rate), "amount": flt(i.amount),
			"size": i.get("atelier_size"), "category": i.get("atelier_category"), "material": i.get("atelier_material") or "", "per": flt(i.get("atelier_per_sheet")) or 1})
	return out


@frappe.whitelist(methods=["POST"])
def update_lines(name, lines):
	"""Edit the order's lines from the card, measured by their unit like a new order."""
	so = _so_write(name)
	if is_worker():
		frappe.throw(_("ليست لديك صلاحية لهذا الإجراء."), frappe.PermissionError)
	locked = _lines_locked(name)
	if locked:
		frappe.throw(_("البنود مقفلة: صدر لهذا الطلب {0}.").format("، ".join(locked)))
	rows = _order_lines({"lines": frappe.parse_json(lines) or []})
	if not rows:
		frappe.throw(_("أبقِ بندًا واحدًا على الأقل"))
	numeric = {"atelier_width", "atelier_height", "atelier_length", "atelier_pieces", "atelier_per_sheet"}
	extra = lambda r: {k: (flt(r.get(k)) if k in numeric else r.get(k)) for k in LINE_KEYS}
	if so.docstatus == 0:
		so.set("items", [])
		for r in rows:
			so.append("items", {"item_code": r["item_code"], "qty": r["qty"], "description": r["description"] or None,
				"rate": 0 if r["rate"] is None else r["rate"], "atelier_price_pending": 1 if r["rate"] is None else 0,
				"delivery_date": so.delivery_date, **extra(r)})
		so.save()
		api.confirm_if_priced(so)  # the last price given: the order is confirmed (and can be delivered)
	else:
		if any(r["rate"] is None for r in rows):
			frappe.throw(_("الطلب مؤكَّد: اكتب سعر كل بند"))
		from erpnext.controllers.accounts_controller import update_child_qty_rate

		old = list(so.items)
		trans = []
		for idx, r in enumerate(rows):
			t = {"item_code": r["item_code"], "qty": r["qty"], "rate": r["rate"], "conversion_factor": 1,
				"uom": frappe.db.get_value("Item", r["item_code"], "stock_uom"), "delivery_date": str(so.delivery_date), "idx": idx + 1}
			if idx < len(old) and old[idx].item_code == r["item_code"]:
				t["docname"] = old[idx].name
			trans.append(t)
		update_child_qty_rate("Sales Order", json.dumps(trans), name)
		so.reload()
		for i, r in zip(so.items, rows):
			frappe.db.set_value("Sales Order Item", i.name, {"description": r["description"] or i.item_name, "atelier_price_pending": 0, **extra(r)},
				update_modified=False)
	_log(name, _("عدّل البنود"))
	return card(name)


@frappe.whitelist(methods=["POST"])
def delete_card(name):
	"""Delete a card created by mistake: the order, its steps and cost. Its folder on D is left as it is."""
	so = _so_write(name)
	if is_worker():
		frappe.throw(_("ليست لديك صلاحية لهذا الإجراء."), frappe.PermissionError)
	blockers = _delete_blockers(name)
	if blockers:
		frappe.throw(_("لا يمكن حذف بطاقة عليها {0}. أرشفها بدل ذلك.").format("، ".join(blockers)))
	if so.docstatus == 1:
		so.cancel()
	project = so.project
	for ce in frappe.get_all("Cost Estimate", filters={"sales_order": name}, pluck="name"):
		frappe.delete_doc("Cost Estimate", ce, force=1, ignore_permissions=True)
	frappe.delete_doc("Sales Order", name, force=1, ignore_permissions=True)
	if project and not frappe.db.exists("Sales Order", {"project": project}):
		for t in frappe.get_all("Task", filters={"project": project}, pluck="name"):
			frappe.delete_doc("Task", t, force=1, ignore_permissions=True)
		frappe.delete_doc("Project", project, force=1, ignore_permissions=True)
	return True


@frappe.whitelist(methods=["POST"])
def archive_card(name, archived=1):
	so = _so_write(name)
	so.db_set("atelier_archived", cint(archived))
	_log(name, _("أرشف البطاقة") if cint(archived) else _("استرجع البطاقة من الأرشيف"))
	return name


@frappe.whitelist(methods=["POST"])
def archive_paid(column):
	"""Clear the delivery column: archive every delivered card that is fully paid."""
	cfg = get_config()
	n = 0
	for c in board2()["cards"]:
		if c["column"] == column and flt(c["per_delivered"]) >= 100 and flt(c["paid"]) >= flt(c["grand_total"]) - 0.005:
			frappe.db.set_value("Sales Order", c["name"], "atelier_archived", 1)
			n += 1
	return n


@frappe.whitelist()
def archived_cards(cancelled=0):
	"""Archived cards, or with cancelled=1 the cancelled orders (kept for the record, never restored)."""
	filters = {"docstatus": 2} if int(cancelled or 0) else {"atelier_archived": 1, "docstatus": ["<", 2]}
	fields = ["name", "atelier_subject as title", "customer_name", "modified"] + ([] if is_worker() else ["grand_total"])
	return frappe.get_list("Sales Order", filters=filters, fields=fields, order_by="modified desc", limit=200)


@frappe.whitelist(methods=["POST"])
def copy_card(name):
	"""A repeat order: same customer, lines (service, unit, sizes, quantity, price, material), description, checklist
	(unticked), labels, members and files. It starts in the first column with no payment."""
	src = frappe.get_doc("Sales Order", name)
	src.check_permission("read")
	cfg = get_config()
	col = cfg["columns"][0]["id"]
	lines = [{k: v for k, v in l.items() if k not in ("row", "amount", "item_name")} for l in _card_lines(src)]
	res = quick_order(json.dumps({"customer": src.customer, "what": f"{src.atelier_subject or src.name} (نسخة)", "subject": f"{src.atelier_subject or src.name} (نسخة)",
		"lines": lines or None, "price": None,
		"delivery_date": max(str(src.delivery_date), nowdate()) if src.delivery_date else add_days(nowdate(), 3)}, ensure_ascii=False))
	new = res["sales_order"]
	checklist = [{"text": c.get("text"), "done": 0} for c in _jl(src.get("atelier_checklist"))]
	for k, v in {"atelier_column": col, "atelier_labels": src.get("atelier_labels"), "atelier_members": src.get("atelier_members"),
			"atelier_assignee": src.get("atelier_assignee"), "atelier_description": src.get("atelier_description"),
			"atelier_checklist": json.dumps(checklist, ensure_ascii=False), "atelier_cover": src.get("atelier_cover")}.items():
		frappe.db.set_value("Sales Order", new, k, v)
	for f in frappe.get_all("File", filters={"attached_to_doctype": "Sales Order", "attached_to_name": name},
			fields=["file_name", "file_url", "is_private"]):
		frappe.get_doc({"doctype": "File", "file_name": f.file_name, "file_url": f.file_url, "is_private": f.is_private,
			"attached_to_doctype": "Sales Order", "attached_to_name": new}).insert(ignore_permissions=True)
	_log(new, _("نُسخت من {0}").format(src.atelier_subject or name))
	return new


@frappe.whitelist(methods=["POST"])
def reorder(column, names):
	"""Manual order inside a column: names in the order shown."""
	for i, n in enumerate(frappe.parse_json(names) or []):
		if frappe.has_permission("Sales Order", "write", n):
			frappe.db.set_value("Sales Order", n, {"atelier_pos": i + 1, "atelier_column": column}, update_modified=False)
	return True


# checklist templates: configuration, not demo orders or customer data
DEFAULT_CHECKLISTS = [
	{"title": "بطاقات زيارة", "items": ["تصميم", "موافقة العميل", "طباعة", "قص", "تغليف"]},
	{"title": "لافتة", "items": ["أخذ المقاسات", "تصميم", "موافقة العميل", "طباعة", "تركيب الإطار", "تركيب عند العميل"]},
	{"title": "ملصقات", "items": ["تصميم", "موافقة العميل", "طباعة", "قص"]},
]


def _templates():
	try:
		return json.loads(frappe.db.get_default("atelier_checklists") or "[]")
	except ValueError:
		return []


@frappe.whitelist()
def checklist_templates():
	return _templates()


@frappe.whitelist(methods=["POST"])
def save_checklist_template(title, items):
	title = (title or "").strip()[:80]
	items = [str(x).strip()[:200] for x in (frappe.parse_json(items) or []) if str(x).strip()]
	if not title or not items:
		frappe.throw(_("اسم القالب وعنصر واحد على الأقل"))
	tpl = [t for t in _templates() if t["title"] != title] + [{"title": title, "items": items}]
	frappe.db.set_default("atelier_checklists", json.dumps(tpl, ensure_ascii=False))
	return tpl


@frappe.whitelist(methods=["POST"])
def delete_checklist_template(title):
	if not _is_manager():
		frappe.throw(_("للمدير فقط"), frappe.PermissionError)
	tpl = [t for t in _templates() if t["title"] != title]
	frappe.db.set_default("atelier_checklists", json.dumps(tpl, ensure_ascii=False))
	return tpl


# notifications: who was assigned, who was mentioned, and what is due
def _user_of(member):
	return next((m.get("user") for m in production._team() if m["name"] == member and m.get("user")), None)


def _member_of(user):
	return next((m["name"] for m in production._team() if m.get("user") == user), None)


def notify(member, name, text, kind="assign"):
	if not alert_settings().get(kind, 1):
		return
	user = _user_of(member)
	if not user or user == frappe.session.user:
		return
	frappe.get_doc({"doctype": "Notification Log", "for_user": user, "from_user": frappe.session.user, "type": "Alert",
		"subject": text[:140], "document_type": "Sales Order", "document_name": name}).db_insert()  # no email: in-app only


@frappe.whitelist()
def notifications():
	logs = frappe.get_all("Notification Log", filters={"for_user": frappe.session.user, "document_type": ["in", ["Sales Order", "Company"]]},
		fields=["name", "subject", "document_type", "document_name", "from_user", "read", "creation"], order_by="creation desc", limit=20)
	for l in logs:
		l.by = frappe.utils.get_fullname(l.from_user)
	due = []
	me = _member_of(frappe.session.user) or frappe.utils.get_fullname(frappe.session.user)
	for c in (board2()["cards"] if alert_settings().get("due", 1) else []):
		if me in c["members"] and c["due"] and flt(c["per_delivered"]) < 100:
			days = (frappe.utils.getdate(c["due"]) - frappe.utils.getdate(nowdate())).days
			if days <= 1:
				due.append({"name": c["name"], "title": c["title"], "due": str(c["due"]), "due_time": c.get("due_time"), "late": days < 0, "days": days})
	return {"logs": logs, "due": due, "unread": sum(1 for l in logs if not l.read) + len(due)}


@frappe.whitelist(methods=["POST"])
def mark_read():
	frappe.db.sql("update `tabNotification Log` set `read`=1 where for_user=%s and document_type in ('Sales Order', 'Company')", frappe.session.user)
	return True


def demo_extras():
	frappe.set_user("Administrator")
	extra_fields()
	if not _templates():
		frappe.db.set_default("atelier_checklists", json.dumps(DEFAULT_CHECKLISTS, ensure_ascii=False))
	frappe.db.commit()


# ---------------------------------------------------------------- customers page: list numbers, sticky note, star, files, reorder
CUSTOMER_FIELDS = [
	{"fieldname": "atelier_note", "label": "ملاحظة ثابتة", "fieldtype": "Small Text", "insert_after": "customer_details"},
	{"fieldname": "atelier_vip", "label": "زبون مميز", "fieldtype": "Check", "insert_after": "atelier_note"},
]
AWAY_DAYS = 60


def customer_fields():
	from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

	create_custom_fields({"Customer": [{**f, "module": "Atelier"} for f in CUSTOMER_FIELDS]})


@frappe.whitelist()
def customers2():
	no_worker()
	rows = api.customers(full=1, include_disabled=1)
	names = [r.name for r in rows] or [""]
	extra = {r.name: r for r in frappe.get_all("Customer", filters={"name": ["in", names]}, fields=["name", "atelier_vip", "creation", "atelier_tags", "disabled"])}
	counts = dict(frappe.db.sql("""select customer, count(*) from `tabSales Order` where docstatus<2 and ifnull(atelier_archived, 0)=0 and customer in %s group by customer""", [names]))
	month = str(get_first_day(nowdate()))
	covers = {}
	for so in frappe.get_all("Sales Order", filters={"customer": ["in", names], "docstatus": ["<", 2], "atelier_cover": ["is", "set"]},
			fields=["customer", "atelier_cover"], order_by="creation desc", limit=600):
		l = covers.setdefault(so.customer, [])
		if len(l) < 3 and so.atelier_cover not in l:
			l.append(so.atelier_cover)
	# same rule as the customer page: invoices + open orders not yet invoiced (minus what was paid on them)
	# the party balance already counts advances paid on those orders (as credit), so the orders add their full
	# unbilled amount; «unbilled» shown = what is still owed on them, «invoices» = the rest of the balance
	unbilled, gross = {}, {}
	for o in api._order_rows({"customer": ["in", names], "docstatus": ["<", 2], "per_billed": ["<", 100], "status": ["!=", "Closed"]}, limit=0):
		if not o.price_pending:
			unbilled[o.customer] = unbilled.get(o.customer, 0) + max(0, flt(o.grand_total) - flt(o.paid))
			gross[o.customer] = gross.get(o.customer, 0) + flt(o.grand_total) * (1 - flt(o.per_billed) / 100)
	for r in rows:
		r.unbilled = unbilled.get(r.name, 0)
		if r.balance is not None:
			r.balance = round(flt(r.balance) + gross.get(r.name, 0), 2)
		r.invoices = round(flt(r.balance) - r.unbilled, 2)
		r.covers = covers.get(r.name, [])
		e = extra.get(r.name) or {}
		r.vip = cint(e.get("atelier_vip"))
		r.tags = _jl(e.get("atelier_tags"))
		r.disabled = cint(e.get("disabled"))
		r.orders = counts.get(r.name, 0)
		r.since = str(e.get("creation") or "")[:10]
		r.new = r.since >= month
		r.away = bool(r.last_order) and (frappe.utils.getdate(nowdate()) - frappe.utils.getdate(r.last_order)).days >= AWAY_DAYS
	cash = frappe.db.get_value("Customer", {"customer_name": "زبون نقدي"})
	return {"rows": [r for r in rows if r.name != cash], "away_days": AWAY_DAYS, "customer_tags": customer_tags(), "manager": _is_manager()}


@frappe.whitelist()
def customer2(name):
	no_worker()
	res = api.customer(name)
	doc = frappe.db.get_value("Customer", name, ["atelier_note", "atelier_vip", "customer_name"], as_dict=True)
	res["note"] = doc.atelier_note or ""
	res["vip"] = cint(doc.atelier_vip)
	if api._can("Sales Order"):  # the whole history, not only the latest orders
		res["orders"] = api._order_rows({"customer": name, "docstatus": ["<", 2]}, limit=1000)
	orders = [o.name for o in res.get("orders") or []] or [""]
	extra = {r.name: r for r in frappe.get_all("Sales Order", filters={"name": ["in", orders]},
		fields=["name", "atelier_cover", "atelier_column", "atelier_archived", "atelier_cover_color", "atelier_status", "atelier_final", "atelier_labels"])}
	cfg = get_config()
	folders = _folders()
	for o in res.get("orders") or []:
		e = extra.get(o.name) or frappe._dict()
		o.cover, o.atelier_column, o.archived = e.atelier_cover, e.atelier_column, cint(e.atelier_archived)
		o.column = next((c["name"] for c in cfg["columns"] if c["id"] == _column_for(o, cfg)), "")
		o.cover_color, o.final = e.get("atelier_cover_color"), e.get("atelier_final")
		o.status = _status_of(e, _jl(e.get("atelier_labels")), cfg)
		o.folder = folders.card_folder(o.name)
	sizes, lines = {}, {}
	for r in frappe.get_all("Sales Order Item", filters={"parent": ["in", orders]},
			fields=["parent", "atelier_size", "item_name", "item_group", "qty", "uom", "rate", "amount", "atelier_price_pending"], order_by="idx asc"):
		if r.atelier_size:
			sizes.setdefault(r.parent, r.atelier_size)
		l = lines.setdefault(r.parent, [])
		if len(l) < 4:  # gallery: what was made, how many, at what price
			l.append({"what": r.item_name, "group": r.item_group, "qty": flt(r.qty), "uom": r.uom, "size": r.atelier_size,
				"rate": None if r.atelier_price_pending else flt(r.rate), "amount": None if r.atelier_price_pending else flt(r.amount)})
	for o in res.get("orders") or []:
		o.size = sizes.get(o.name)
		o.lines = lines.get(o.name, [])
	res["statuses"] = cfg["statuses"]
	if api._can("Payment Entry"):
		res["year_paid"] = flt(frappe.db.sql("""select sum(paid_amount) from `tabPayment Entry` where party_type='Customer' and party=%s
			and docstatus=1 and payment_type='Receive' and posting_date >= %s""", (name, str(frappe.utils.getdate(nowdate()).year) + "-01-01"))[0][0])
	kind_col = "f.atelier_kind" if frappe.db.has_column("File", "atelier_kind") else "'' as atelier_kind"
	files = frappe.db.sql(
		"""select f.name, f.file_name, f.file_url, f.file_size, f.creation, f.owner, f.attached_to_doctype, f.attached_to_name, so.atelier_subject, """ + kind_col + """
		from `tabFile` f left join `tabSales Order` so on f.attached_to_doctype='Sales Order' and so.name=f.attached_to_name
		where (f.attached_to_doctype='Customer' and f.attached_to_name=%s) or (f.attached_to_doctype='Sales Order' and so.customer=%s)
		order by f.creation desc limit 400""", (name, name), as_dict=True)
	seen, res["card_files"] = set(), []
	for f in files:  # a copied card shares its source's file: show it once
		if f.file_url not in seen:
			seen.add(f.file_url)
			res["card_files"].append(f)
	if api._can("Sales Invoice"):
		res["avg_pay_days"] = frappe.db.sql(
			"""select round(avg(datediff(pe.posting_date, si.posting_date))) from `tabSales Invoice` si
			join `tabPayment Entry Reference` per on per.reference_doctype='Sales Invoice' and per.reference_name=si.name
			join `tabPayment Entry` pe on pe.name=per.parent and pe.docstatus=1
			where si.customer=%s and si.docstatus=1""", name)[0][0]
		res["oldest_unpaid"] = frappe.db.sql(
			"""select si.name, si.posting_date, si.outstanding_amount,
			(select so.atelier_subject from `tabSales Invoice Item` sii join `tabSales Order` so on so.name=sii.sales_order
				where sii.parent=si.name and sii.sales_order is not null limit 1) subject
			from `tabSales Invoice` si where si.customer=%s and si.docstatus=1 and si.outstanding_amount > 0.005
			order by si.posting_date asc limit 1""", name, as_dict=True)
		res["oldest_unpaid"] = res["oldest_unpaid"][0] if res["oldest_unpaid"] else None
	res["workshop"] = frappe.get_cached_value("Company", api._company(), "company_name")
	res.update(customer_extras(name))
	return res


@frappe.whitelist(methods=["POST"])
def set_customer_extra(name, note=None, vip=None):
	doc = frappe.get_doc("Customer", name)
	doc.check_permission("write")
	if note is not None:
		doc.db_set("atelier_note", (note or "").strip()[:1000] or None)
	if vip is not None:
		doc.db_set("atelier_vip", cint(vip))
	return customer2(name)


@frappe.whitelist(methods=["POST"])
def reorder_card(name):
	"""«↻ أعد الطلب»: the same work again, in the board's first column, no price yet."""
	new = copy_card(name)
	cfg = get_config()
	frappe.db.set_value("Sales Order", new, {"atelier_column": cfg["columns"][0]["id"], "atelier_subject": frappe.db.get_value("Sales Order", name, "atelier_subject") or name})
	return new


def _apply_customer_note(so_name):
	"""New card: the customer's sticky note goes on top of the description."""
	customer = frappe.db.get_value("Sales Order", so_name, "customer")
	note = frappe.db.get_value("Customer", customer, "atelier_note")
	if note:
		frappe.db.set_value("Sales Order", so_name, "atelier_description", "📌 " + note)


def demo_customers():
	frappe.set_user("Administrator")
	customer_fields()
	frappe.db.commit()


# ---------------------------------------------------------------- money page: month figures, trend, categories, what we are owed and owe
@frappe.whitelist()
def money3(offset=0):
	"""offset = months back from this one (0 = this month)."""
	api._require("GL Entry")
	from frappe.utils import add_months

	company = api._company()
	ref = add_months(nowdate(), -cint(offset))
	start, end = get_first_day(ref), get_last_day(ref)
	pstart, pend = get_first_day(add_months(ref, -1)), get_last_day(add_months(ref, -1))
	accs = frappe.get_all("Account", filters={"company": company, "account_type": ["in", ["Cash", "Bank"]], "is_group": 0},
		fields=["name", "account_name", "account_type"])
	cash = [a.name for a in accs] or [""]

	def one(sql, *args):
		return flt(frappe.db.sql(sql, args)[0][0])

	owner = owner_account(create=False) or ""
	# transfers, handovers and the owner's own money are not income nor expenses
	skip = """ and voucher_no not in (select je.name from `tabJournal Entry` je where je.voucher_type='Contra Entry'
		or exists (select 1 from `tabJournal Entry Account` x where x.parent=je.name and x.account=%s))"""

	def inout(a, b):
		return (one("select sum(debit) from `tabGL Entry` where is_cancelled=0 and is_opening='No' and posting_date between %s and %s and account in %s" + skip, a, b, cash, owner),
			one("select sum(credit) from `tabGL Entry` where is_cancelled=0 and is_opening='No' and posting_date between %s and %s and account in %s" + skip, a, b, cash, owner))

	def own(col):
		return one(f"select sum({col}) from `tabGL Entry` where is_cancelled=0 and account=%s and posting_date between %s and %s", owner, start, end) if owner else 0

	income, expenses = inout(start, end)
	pin, pout = inout(pstart, pend)
	balances = {a.name: one("select sum(debit - credit) from `tabGL Entry` where is_cancelled=0 and account=%s", a.name) for a in accs}
	# the French chart has many cash/bank accounts: show only the ones in use, plus the company defaults
	used = {r[0] for r in frappe.db.sql("select distinct account from `tabGL Entry` where is_cancelled=0 and account in %s", [cash])}
	defaults = api.mode_funds(company) | set(frappe.get_cached_value("Company", company, ["default_cash_account", "default_bank_account"]) or [])
	shown = [a for a in accs if a.name in used or a.name in defaults] or accs
	weeks = []
	for i in range(7, -1, -1):
		wend = add_days(end if cint(offset) else nowdate(), -7 * i)
		wstart = add_days(wend, -6)
		a, b = inout(wstart, wend)
		weeks.append({"from": str(wstart), "to": str(wend), "in": a, "out": b})
	moves = frappe.db.sql(
		"""select gle.voucher_type, gle.voucher_no, gle.posting_date, sum(gle.debit - gle.credit) amount, max(gle.owner) owner, max(gle.account) account
		from `tabGL Entry` gle where gle.is_cancelled=0 and gle.account in %s and gle.posting_date between %s and %s
		group by gle.voucher_type, gle.voucher_no, gle.posting_date order by gle.posting_date desc, max(gle.creation) desc limit 200""",
		(cash, start, end), as_dict=True)
	_transfer_amounts(moves, cash, accs)
	for m in moves:
		m.title = m.get("title") or _title(m)
		# a seller's payment is saved by the system user but owned by the seller who took the money
		who = frappe.db.get_value(m.voucher_type, m.voucher_no, "owner") if m.voucher_type in ("Payment Entry", "Journal Entry") else None
		m.by = frappe.utils.get_fullname(who or m.owner)
		m.category, m.order, m.order_title = _move_meta(m)
		m.files = frappe.db.count("File", {"attached_to_doctype": m.voucher_type, "attached_to_name": m.voucher_no})
		m.fund = next((a.account_name for a in accs if a.name == m.account), "")
	cats = frappe.db.sql(
		"""select acc.account_name name, sum(gle.debit - gle.credit) amount from `tabGL Entry` gle join `tabAccount` acc on acc.name=gle.account
		where gle.is_cancelled=0 and gle.company=%s and acc.root_type='Expense' and gle.posting_date between %s and %s
		group by acc.account_name having amount > 0 order by amount desc limit 8""", (company, start, end), as_dict=True)
	for c in cats:
		c.name = _plain_account(c.name)
	debtors = frappe.db.sql(
		"""select si.customer, si.customer_name, sum(si.outstanding_amount) amount,
		max(case when si.due_date < curdate() then datediff(curdate(), si.due_date) else 0 end) late, c.mobile_no
		from `tabSales Invoice` si left join `tabCustomer` c on c.name=si.customer
		where si.docstatus=1 and si.company=%s and si.outstanding_amount > 0.005 group by si.customer order by late desc, amount desc""", company, as_dict=True)
	# same rule as the customer pages: open invoices + priced orders not invoiced yet (minus what was paid on them)
	for d in debtors:
		d.invoices, d.unbilled = flt(d.amount), 0
	byc = {d.customer: d for d in debtors}
	for o in api._order_rows({"docstatus": ["<", 2], "per_billed": ["<", 100], "status": ["!=", "Closed"]}, limit=0):
		left = max(0, flt(o.grand_total) - flt(o.paid))
		if o.price_pending or left <= 0.005:
			continue
		d = byc.get(o.customer)
		if not d:
			d = byc[o.customer] = frappe._dict(customer=o.customer, customer_name=o.customer_name, amount=0, invoices=0, unbilled=0, late=0,
				mobile_no=frappe.db.get_value("Customer", o.customer, "mobile_no"))
			debtors.append(d)
		d.unbilled += left
		d.amount = flt(d.amount) + left
	debtors.sort(key=lambda d: (-cint(d.late), -flt(d.amount)))
	ages = frappe.db.sql(
		"""select sum(case when ifnull(datediff(curdate(), si.due_date), 0) <= 30 then si.outstanding_amount else 0 end) a,
		sum(case when datediff(curdate(), si.due_date) between 31 and 60 then si.outstanding_amount else 0 end) b,
		sum(case when datediff(curdate(), si.due_date) > 60 then si.outstanding_amount else 0 end) c
		from `tabSales Invoice` si where si.docstatus=1 and si.company=%s and si.outstanding_amount > 0.005""", company, as_dict=True)[0]
	cheques = frappe.db.sql(
		"""select pe.name, pe.party_name, pe.paid_amount amount, pe.reference_no, pe.reference_date, pe.posting_date, pe.paid_to
		from `tabPayment Entry` pe where pe.docstatus=1 and pe.company=%s and pe.payment_type='Receive' and pe.mode_of_payment='Cheque'
		and pe.clearance_date is null order by pe.reference_date asc, pe.posting_date asc""", company, as_dict=True)
	closings = _closings()
	for m in moves:
		m.kind = "transfer" if m.category in (_("تحويل"), _("تحويل بين الصناديق")) else ("in" if m.amount > 0 else "out")
		if m.kind == "transfer":
			# a transfer nets to 0 across the funds: show what moved, not the net
			m.moved = flt(frappe.db.sql("""select sum(gle.debit) from `tabGL Entry` gle where gle.voucher_no=%s and gle.is_cancelled=0
				and gle.account in %s""", (m.voucher_no, cash))[0][0])
		if m.voucher_type == "Journal Entry":
			if owner and frappe.db.exists("Journal Entry Account", {"parent": m.voucher_no, "account": owner}):
				m.kind, m.category = "owner", (_("سحب شخصي") if m.amount < 0 else _("إيداع من المالك"))
			elif (frappe.db.get_value("Journal Entry", m.voucher_no, "user_remark") or "").startswith(_("تسليم صندوق")):
				m.kind, m.category = "handover", _("تسليم صندوق")
				got, closed = frappe.db.sql("""select sum(jea.debit_in_account_currency), sum(jea.credit_in_account_currency)
					from `tabJournal Entry Account` jea join `tabAccount` acc on acc.name=jea.account
					where jea.parent=%s and acc.account_type='Cash'""", m.voucher_no)[0]
				m.handover = {"received": flt(got), "closed": flt(closed), "diff": round(flt(got) - flt(closed), 2)}
		if m.voucher_type == "Payment Entry":
			m.ref = frappe.db.get_value("Payment Entry", m.voucher_no, "reference_no")
			if m.ref == "—":
				m.ref = None
	payables = frappe.db.sql(
		"""select pi.name, pi.supplier, pi.supplier_name, pi.outstanding_amount amount, pi.due_date,
		(select pii.description from `tabPurchase Invoice Item` pii where pii.parent=pi.name limit 1) what
		from `tabPurchase Invoice` pi where pi.docstatus=1 and pi.company=%s and pi.outstanding_amount > 0.005 order by pi.due_date asc""", company, as_dict=True)
	return {
		"month": str(start), "offset": cint(offset),
		"funds": [{"name": a.name, "label": a.account_name, "type": a.account_type, "balance": balances[a.name],
			"last_closing": next((c for c in closings if c["account"] == a.name), None),
			"cheques": sum(1 for c in cheques if c.paid_to == a.name)} for a in shown],
		"ages": {"a": flt(ages.a), "b": flt(ages.b), "c": flt(ages.c)}, "cheques": cheques, "closings": closings[:10],
		"cash_balance": sum(balances.values()),
		"income": income, "expenses": expenses, "profit": income - expenses, "owner_out": own("debit"), "owner_in": own("credit"), "prev_income": pin, "prev_expenses": pout,
		"payers": cint(one("""select count(distinct party) from `tabPayment Entry` where docstatus=1 and payment_type='Receive'
			and party_type='Customer' and posting_date between %s and %s""", start, end)),
		"weeks": weeks, "moves": moves, "categories": cats, "debtors": debtors, "payables": payables,
		"modes": [{"value": v, "label": l} for v, l in api.all_modes() if frappe.db.exists("Mode of Payment", v)],
	}


def _plain_account(name):
	"""Long chart-of-accounts names in a summary read as the thing they are; the official name stays in the books."""
	n = (name or "").lower()
	if n.startswith("variation") and "stock" in n:
		return _("مواد مصروفة من المخزون")
	if n.startswith("achats stock"):
		return _("مشتريات مواد")
	return name


CLOSINGS_KEY = "atelier_cash_closings"


def _closings():
	try:
		return json.loads(frappe.db.get_default(CLOSINGS_KEY) or "[]")
	except ValueError:
		return []


@frappe.whitelist(methods=["POST"])
def close_cash(account, counted, note=None):
	"""End of day: compare the cash counted with what the books say, and book any difference.

	The difference goes to the company's round-off account (gain when there is more cash, loss when less),
	so the fund then shows what is really in the drawer. Each closing is kept with who did it."""
	_manager_only()
	api._require("GL Entry")
	company = api._company()
	if tuple(frappe.db.get_value("Account", account, ["company", "account_type"]) or ()) != (company, "Cash"):
		frappe.throw(_("اختر صندوقًا نقديًا"))
	counted = flt(counted)
	if counted < 0:
		frappe.throw(_("المبلغ المعدود غير صحيح"))
	expected = flt(frappe.db.sql("select sum(debit - credit) from `tabGL Entry` where is_cancelled=0 and account=%s", account)[0][0])
	diff = round(counted - expected, 2)
	entry = None
	if abs(diff) >= 0.01:
		from atelier.cashbox import cash_diff_account

		off, cc = cash_diff_account(company), frappe.get_cached_value("Company", company, "round_off_cost_center") or frappe.get_cached_value("Company", company, "cost_center")
		je = frappe.get_doc({"doctype": "Journal Entry", "voucher_type": "Journal Entry", "company": company, "posting_date": nowdate(),
			"user_remark": _("فرق إغلاق الصندوق") + (" — " + note.strip()[:100] if note and note.strip() else ""),
			"accounts": [
				{"account": account, "debit_in_account_currency": diff if diff > 0 else 0, "credit_in_account_currency": -diff if diff < 0 else 0},
				{"account": off, "cost_center": cc, "debit_in_account_currency": -diff if diff < 0 else 0, "credit_in_account_currency": diff if diff > 0 else 0},
			]})
		je.insert()
		je.submit()
		entry = je.name
	row = {"account": account, "label": frappe.db.get_value("Account", account, "account_name"), "at": str(frappe.utils.now_datetime())[:16],
		"by": frappe.utils.get_fullname(frappe.session.user), "expected": expected, "counted": counted, "diff": diff,
		"note": (note or "").strip()[:200], "entry": entry}
	frappe.db.set_default(CLOSINGS_KEY, json.dumps(([row] + _closings())[:200], ensure_ascii=False))
	return row


@frappe.whitelist(methods=["POST"])
def clear_cheque(name, date=None):
	"""The bank collected the cheque: mark it so it leaves the waiting list."""
	_manager_only()
	pe = frappe.get_doc("Payment Entry", name)
	if pe.docstatus != 1 or pe.mode_of_payment != "Cheque":
		frappe.throw(_("هذا ليس صكًّا مسجّلًا"))
	frappe.db.set_value("Payment Entry", name, "clearance_date", date or nowdate(), update_modified=False)
	return True


def _move_meta(m):
	if m.voucher_type == "Payment Entry":
		pe = frappe.db.get_value("Payment Entry", m.voucher_no, ["payment_type", "party_type"], as_dict=True) or {}
		ref = frappe.db.get_value("Payment Entry Reference", {"parent": m.voucher_no}, ["reference_doctype", "reference_name"], as_dict=True)
		order = None
		if ref and ref.reference_doctype == "Sales Order":
			order = ref.reference_name
		elif ref and ref.reference_doctype == "Sales Invoice":
			order = frappe.db.get_value("Sales Invoice Item", {"parent": ref.reference_name, "sales_order": ["is", "set"]}, "sales_order")
		cat = _("دفعة عميل") if pe.get("payment_type") == "Receive" else (_("دفع لمورد") if pe.get("party_type") == "Supplier" else _("تحويل"))
		return cat, order, frappe.db.get_value("Sales Order", order, "atelier_subject") if order else None
	if m.voucher_type == "Journal Entry":
		if frappe.db.get_value("Journal Entry", m.voucher_no, "is_opening") == "Yes":
			return _("رصيد افتتاحي"), None, None
		acc = frappe.db.sql("""select acc.account_name, jea.project from `tabJournal Entry Account` jea join `tabAccount` acc on acc.name=jea.account
			where jea.parent=%s and acc.root_type in ('Expense','Asset') and acc.account_type not in ('Cash','Bank') limit 1""", m.voucher_no, as_dict=True)
		if not acc:
			return _("تحويل بين الصناديق"), None, None
		order = frappe.db.get_value("Sales Order", {"project": acc[0].project}, "name") if acc[0].project else None
		return acc[0].account_name, order, frappe.db.get_value("Sales Order", order, "atelier_subject") if order else None
	return m.voucher_type, None, None


def owner_account(create=True):
	"""The owner's current account (equity): personal withdrawals and deposits, never income nor expenses."""
	acc = frappe.db.get_default("atelier_owner_account")
	if acc and frappe.db.exists("Account", acc):
		return acc
	if not create:
		return None
	company = api._company()
	name = _("حساب المالك الجاري")
	acc = frappe.db.get_value("Account", {"company": company, "account_name": name, "is_group": 0})
	if not acc:
		parent = frappe.db.get_value("Account", {"company": company, "root_type": "Equity", "is_group": 1, "parent_account": ["is", "set"]}) or \
			frappe.db.get_value("Account", {"company": company, "root_type": "Equity", "is_group": 1})
		if not parent:
			frappe.throw(_("لا يوجد حساب حقوق ملكية في دليل الحسابات"))
		doc = frappe.get_doc({"doctype": "Account", "company": company, "account_name": name, "parent_account": parent, "is_group": 0, "root_type": "Equity"})
		doc.flags.ignore_permissions = True
		doc.insert()
		acc = doc.name
	frappe.db.set_default("atelier_owner_account", acc)
	return acc


@frappe.whitelist(methods=["POST"])
def owner_move(kind, account, amount, note=None):
	"""«سحب شخصي» (money out of a fund to the owner) or «إيداع من المالك» (money into a fund from the owner)."""
	_manager_only()
	amount = flt(amount)
	if amount <= 0:
		frappe.throw(_("المبلغ يجب أن يكون أكبر من صفر"))
	if kind not in ("withdraw", "deposit"):
		frappe.throw(_("نوع حركة غير معروف"))
	company = api._company()
	if tuple(frappe.db.get_value("Account", account, ["company", "account_type"]) or ()) not in ((company, "Cash"), (company, "Bank")):
		frappe.throw(_("اختر صندوقًا"))
	owner = owner_account()
	out = kind == "withdraw"
	if out:
		api.ensure_funds(account, amount)
	label = _("سحب شخصي") if out else _("إيداع من المالك")
	je = frappe.get_doc({"doctype": "Journal Entry", "voucher_type": "Journal Entry", "company": company, "posting_date": nowdate(),
		"user_remark": label + (" — " + note.strip()[:120] if note and note.strip() else ""),
		"accounts": [{"account": owner, "debit_in_account_currency": amount if out else 0, "credit_in_account_currency": 0 if out else amount},
			{"account": account, "debit_in_account_currency": 0 if out else amount, "credit_in_account_currency": amount if out else 0}]})
	je.insert(ignore_permissions=True)
	je.submit()
	return je.name


@frappe.whitelist(methods=["POST"])
def transfer_funds(from_account, to_account, amount, note=None):
	"""Move money between the workshop's cash box and bank."""
	if not frappe.has_permission("Journal Entry", "create"):
		frappe.throw(_("ليست لديك صلاحية لهذا الإجراء."), frappe.PermissionError)
	amount = flt(amount)
	if amount <= 0 or from_account == to_account:
		frappe.throw(_("اختر صندوقين مختلفين ومبلغًا أكبر من صفر"))
	company = api._company()
	for a in (from_account, to_account):
		if frappe.db.get_value("Account", a, "account_type") not in ("Cash", "Bank"):
			frappe.throw(_("حساب غير صالح"))
	api.ensure_funds(from_account, amount)
	je = frappe.get_doc({"doctype": "Journal Entry", "voucher_type": "Contra Entry", "company": company, "posting_date": nowdate(),
		"user_remark": (note or _("تحويل بين الصناديق"))[:140],
		"accounts": [{"account": to_account, "debit_in_account_currency": amount}, {"account": from_account, "credit_in_account_currency": amount}]})
	je.insert()
	je.submit()
	return je.name


@frappe.whitelist(methods=["POST"])
def pay_supplier(invoice, mode_of_payment="Cash", amount=None):
	"""Pay what is left on a supplier invoice, or only part of it (amount)."""
	from erpnext.accounts.doctype.payment_entry.payment_entry import get_payment_entry

	if not frappe.has_permission("Payment Entry", "create"):
		frappe.throw(_("ليست لديك صلاحية لهذا الإجراء."), frappe.PermissionError)
	pe = get_payment_entry("Purchase Invoice", invoice, bank_account=api._cash_account(mode_of_payment, api._company()))
	pe.mode_of_payment = mode_of_payment
	if amount not in (None, ""):
		if flt(amount) <= 0:
			frappe.throw(_("المبلغ يجب أن يكون أكبر من صفر"))
		if flt(amount) > flt(pe.paid_amount) + 0.005:
			frappe.throw(_("المبلغ أكبر من الباقي للمورد ({0})").format(frappe.format_value(pe.paid_amount, {"fieldtype": "Currency"})))
	if amount not in (None, "") and flt(amount) < flt(pe.paid_amount):
		pe.paid_amount = pe.received_amount = flt(amount)
		for r in pe.references:
			r.allocated_amount = min(flt(amount), flt(r.outstanding_amount))
		if hasattr(pe, "set_amounts"):
			pe.set_amounts()
	api.ensure_funds(pe.paid_from, pe.paid_amount)
	pe.posting_date = nowdate()
	pe.reference_no = pe.reference_no or "—"
	pe.reference_date = nowdate()
	pe.insert()
	pe.submit()
	return pe.name


# ---------------------------------------------------------------- customers: legal ids, people, credit limit, groups, contact log, stats, merge
CUSTOMER_FIELDS_2 = [
	{"fieldname": "atelier_rc", "label": "السجل التجاري RC", "fieldtype": "Data", "insert_after": "tax_id"},
	{"fieldname": "atelier_nis", "label": "NIS", "fieldtype": "Data", "insert_after": "atelier_rc"},
	{"fieldname": "atelier_ai", "label": "المادة AI", "fieldtype": "Data", "insert_after": "atelier_nis"},
	{"fieldname": "atelier_credit_limit", "label": "سقف الدين", "fieldtype": "Currency", "insert_after": "atelier_vip"},
	{"fieldname": "atelier_tags", "label": "التصنيفات", "fieldtype": "Small Text", "insert_after": "atelier_credit_limit"},
	{"fieldname": "atelier_contacts", "label": "الأشخاص", "fieldtype": "Text", "insert_after": "atelier_tags"},
]
DEFAULT_CUSTOMER_TAGS = [
	{"id": "t-wholesale", "name": "جملة", "color": "#2563EB"}, {"id": "t-partner", "name": "مطبعة شريكة", "color": "#22A06B"},
	{"id": "t-public", "name": "إدارة عمومية", "color": "#9B87F5"},
]


def customer_fields_2():
	from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

	create_custom_fields({"Customer": [{**f, "module": "Atelier"} for f in CUSTOMER_FIELDS_2]})


def customer_tags():
	try:
		return json.loads(frappe.db.get_default("atelier_customer_tags") or "null") or DEFAULT_CUSTOMER_TAGS
	except ValueError:
		return DEFAULT_CUSTOMER_TAGS


@frappe.whitelist(methods=["POST"])
def save_customer_tags(tags):
	if not _is_manager():
		frappe.throw(_("للمدير فقط"), frappe.PermissionError)
	out = [{"id": t.get("id") or frappe.generate_hash(length=8), "name": (t.get("name") or "").strip()[:40], "color": t.get("color") or "#9A94AC"}
		for t in frappe.parse_json(tags) or [] if (t.get("name") or "").strip()]
	frappe.db.set_default("atelier_customer_tags", json.dumps(out, ensure_ascii=False))
	return out


@frappe.whitelist(methods=["POST"])
def save_customer2(data):
	"""The customer form: base fields through save_customer (contact, address), then legal ids, people, limit, groups, note."""
	d = frappe.parse_json(data)
	d["tax_id"] = d.get("nif")
	name = api.save_customer(json.dumps(d, ensure_ascii=False))
	company = d.get("customer_type") == "Company"
	people = [{"name": (p.get("name") or "").strip()[:80], "role": (p.get("role") or "").strip()[:60], "phone": (p.get("phone") or "").strip()[:30]}
		for p in d.get("contacts") or [] if (p.get("name") or "").strip()]
	ids = {t["id"] for t in customer_tags()}
	frappe.db.set_value("Customer", name, {
		"atelier_rc": (d.get("rc") or "").strip() or None if company else None,
		"atelier_nis": (d.get("nis") or "").strip() or None if company else None,
		"atelier_ai": (d.get("ai") or "").strip() or None if company else None,
		"atelier_credit_limit": flt(d.get("credit_limit")),
		"atelier_tags": json.dumps([t for t in d.get("tags") or [] if t in ids]),
		"atelier_contacts": json.dumps(people, ensure_ascii=False),
		"atelier_note": (d.get("note") or "").strip()[:1000] or None,
		"atelier_tva_exempt": cint(d.get("tva_exempt")),
		**({"atelier_doc_lang": d.get("doc_lang") if d.get("doc_lang") in ("ar", "fr") else "ar"} if frappe.db.has_column("Customer", "atelier_doc_lang") else {}),
	})
	return name


@frappe.whitelist()
def customer_credit(name):
	"""For the new-order form: is this customer over their credit limit? Designers and printers never see money."""
	if is_worker():
		c = frappe.db.get_value("Customer", name, ["customer_type", "mobile_no", "atelier_note"], as_dict=True) or {}
		return {"limit": 0, "owes": 0, "over": False, "note": c.get("atelier_note"), "tva_exempt": 0,
			"customer_type": c.get("customer_type"), "mobile_no": c.get("mobile_no")}
	limit = flt(frappe.db.get_value("Customer", name, "atelier_credit_limit"))
	# computed for everyone who takes orders (a seller has no invoice rights, the limit must still apply):
	# the customer's account balance + what is still to be invoiced on his open orders
	from erpnext.accounts.utils import get_balance_on

	owes = flt(get_balance_on(party_type="Customer", party=name, company=api._company()))
	for o in api._order_rows({"customer": name, "docstatus": ["<", 2], "per_billed": ["<", 100], "status": ["!=", "Closed"]}, limit=0):
		if not o.price_pending:
			owes += flt(o.grand_total) * (1 - flt(o.per_billed) / 100)
	owes = round(owes, 2)
	c = frappe.db.get_value("Customer", name, ["customer_type", "mobile_no", "atelier_note", "atelier_tva_exempt"], as_dict=True) or {}
	return {"limit": limit, "owes": owes, "over": bool(limit) and owes > limit, "note": c.get("atelier_note"), "tva_exempt": cint(c.get("atelier_tva_exempt")),
		"customer_type": c.get("customer_type"), "mobile_no": c.get("mobile_no")}


@frappe.whitelist(methods=["POST"])
def add_customer_log(name, kind, text):
	doc = frappe.get_doc("Customer", name)
	doc.check_permission("read")
	text = (text or "").strip()
	if not text:
		frappe.throw(_("اكتب ما حدث"))
	label = {"call": "اتصال", "whatsapp": "واتساب", "visit": "زيارة", "promise": "وعد بالدفع"}.get(kind, "ملاحظة")
	doc.add_comment("Comment", f"<b>{label}:</b> " + frappe.utils.escape_html(text)[:2000])
	return customer2(name)


@frappe.whitelist(methods=["POST"])
def set_customer_disabled(name, disabled=1):
	doc = frappe.get_doc("Customer", name)
	doc.check_permission("write")
	doc.db_set("disabled", cint(disabled))
	return cint(disabled)


@frappe.whitelist(methods=["POST"])
def merge_customers(source, target):
	"""Merge a duplicate into another customer: its orders, invoices, payments and files move over."""
	if not _is_manager():
		frappe.throw(_("الدمج للمدير فقط"), frappe.PermissionError)
	if source == target:
		frappe.throw(_("اختر عميلًا آخر"))
	if frappe.db.get_value("Customer", source, "customer_type") != frappe.db.get_value("Customer", target, "customer_type"):
		frappe.throw(_("لا يمكن دمج فرد مع مؤسسة"))
	frappe.rename_doc("Customer", source, target, merge=True, force=True)
	return target


def customer_extras(name):
	"""Extra blocks for the profile: legal ids, people, limit, groups, contact log, stats."""
	c = frappe.db.get_value("Customer", name, ["tax_id", "atelier_rc", "atelier_nis", "atelier_ai", "atelier_credit_limit", "atelier_tags",
		"atelier_contacts", "disabled"], as_dict=True) or {}
	log = frappe.get_all("Comment", filters={"reference_doctype": "Customer", "reference_name": name, "comment_type": "Comment"},
		fields=["name", "content", "owner", "creation"], order_by="creation desc", limit=50)
	for l in log:
		l.by = frappe.utils.get_fullname(l.owner)
	months = frappe.db.sql("""select date_format(transaction_date, '%%Y-%%m') m, sum(grand_total) total from `tabSales Order`
		where customer=%s and docstatus=1 and transaction_date >= %s group by m order by m""", (name, add_days(get_first_day(nowdate()), -150)), as_dict=True)
	top = frappe.db.sql("""select coalesce(nullif(so.atelier_subject, ''), soi.item_name) what, count(distinct so.name) n from `tabSales Order` so
		join `tabSales Order Item` soi on soi.parent=so.name where so.customer=%s and so.docstatus<2 group by what order by n desc limit 5""", name, as_dict=True)
	return {"legal": {"nif": c.get("tax_id"), "rc": c.get("atelier_rc"), "nis": c.get("atelier_nis"), "ai": c.get("atelier_ai")},
		"credit_limit": flt(c.get("atelier_credit_limit")), "tags": _jl(c.get("atelier_tags")), "contacts": _jl(c.get("atelier_contacts")),
		"disabled": cint(c.get("disabled")), "tva_exempt": cint(frappe.db.get_value("Customer", name, "atelier_tva_exempt")),
		"doc_lang": (frappe.db.get_value("Customer", name, "atelier_doc_lang") if frappe.db.has_column("Customer", "atelier_doc_lang") else None) or "ar", "folder": _folders().customer_folder(name), "log": log, "months": months, "top": top, "customer_tags": customer_tags()}


def demo_customers_2():
	frappe.set_user("Administrator")
	customer_fields_2()
	frappe.db.commit()


# ---------------------------------------------------------------- settings: workshop profile, documents and TVA, accounts, funds, alerts, backups
PROFILE_KEYS = ["name_ar", "name_fr", "address", "city", "phone", "phone2", "email", "rc", "nif", "nis", "ai", "rib", "logo"]
DOC_DEFAULTS = {"tva": 0, "tva_rate": 19, "footer": "شكرًا لثقتكم", "payment_days": 0, "quote_days": 15, "show_description": 1}
ALERT_DEFAULTS = {"assign": 1, "mention": 1, "due": 1}
TVA_TEMPLATE = "TVA (atelier)"


def _manager_only():
	if not _is_manager():
		frappe.throw(_("الإعدادات للمدير فقط"), frappe.PermissionError)


def _json_default(key, fallback):
	try:
		v = json.loads(frappe.db.get_default(key) or "null")
	except ValueError:
		v = None
	return {**fallback, **(v or {})}


def workshop_profile():
	company = frappe.get_cached_doc("Company", api._company())
	base = {"name_ar": company.company_name.replace("Atelier Démo تجريبي", "مطبعة الرؤية"), "phone": company.phone_no, "email": company.email, "nif": company.tax_id, "logo": company.company_logo}
	return {k: v for k, v in _json_default("atelier_profile", {k: base.get(k) or "" for k in PROFILE_KEYS}).items() if k in PROFILE_KEYS}


def doc_settings():
	return _json_default("atelier_docs", DOC_DEFAULTS)


def alert_settings():
	return _json_default("atelier_alerts", ALERT_DEFAULTS)


@frappe.whitelist()
def settings():
	_manager_only()
	company = api._company()
	from atelier.production import _team
	users = frappe.get_all("User", filters={"user_type": "System User", "name": ["not in", ["Administrator", "Guest"]]},
		fields=["name", "full_name", "enabled", "last_login"], order_by="full_name asc")
	for u in users:
		u.role = app_role(u.name)
		u.member = next((m["name"] for m in _team() if m.get("user") == u.name), None)
	accs = frappe.get_all("Account", filters={"company": company, "account_type": ["in", ["Cash", "Bank"]], "is_group": 0, "disabled": 0},
		fields=["name", "account_name", "account_type"])
	used = {r[0] for r in frappe.db.sql("select distinct account from `tabGL Entry` where is_cancelled=0")}
	defaults = api.mode_funds(company) | set(frappe.get_cached_value("Company", company, ["default_cash_account", "default_bank_account"]) or [])
	modes = []
	for v, label in api.all_modes():
		if frappe.db.exists("Mode of Payment", v):
			modes.append({"value": v, "label": label, "account": frappe.db.get_value("Mode of Payment Account", {"parent": v, "company": company}, "default_account")})
	return {
		"profile": workshop_profile(), "docs": doc_settings(), "alerts": alert_settings(),
		"users": users, "funds": [a for a in accs if a.name in used or a.name in defaults], "all_funds": accs, "modes": modes,
		"backups": _backups(), "email": email_settings(), "folders": _folders().settings(),
	}


@frappe.whitelist(methods=["POST"])
def save_profile(profile):
	_manager_only()
	p = frappe.parse_json(profile) or {}
	clean = {k: (str(p.get(k) or "").strip())[:300] for k in PROFILE_KEYS}
	frappe.db.set_default("atelier_profile", json.dumps(clean, ensure_ascii=False))
	company = api._company()
	frappe.db.set_value("Company", company, {"phone_no": clean["phone"] or None, "email": clean["email"] or None, "tax_id": clean["nif"] or None,
		"company_logo": clean["logo"] or None})
	_sync_mail_name()  # the sender name follows the shop's name
	return workshop_profile()


def _tva_template(rate):
	company = api._company()
	name = frappe.db.get_value("Sales Taxes and Charges Template", {"title": TVA_TEMPLATE, "company": company})
	# the account must say the rate charged: «TVA 19%» for 19% (the chart has several TVA accounts, e.g. 9%)
	rate_txt = f"{flt(rate):g}%"
	# the exact rate, not one that contains it: «9%» must not pick «TVA 19%»
	import re

	account = next((a.name for a in frappe.get_all("Account", filters={"company": company, "is_group": 0, "root_type": "Liability",
		"account_type": "Tax", "account_name": ["like", f"%{rate_txt}%"]}, fields=["name", "account_name"])
		if re.search(rf"(?<![\d.,]){re.escape(rate_txt)}", a.account_name)), None)
	if not account:
		base = frappe.db.get_value("Account", {"company": company, "account_number": "4457", "is_group": 0}) or \
			frappe.db.get_value("Account", {"company": company, "account_type": "Tax", "is_group": 0, "root_type": "Liability"})
		parent = frappe.db.get_value("Account", base, "parent_account") if base else None
		if parent:
			doc = frappe.get_doc({"doctype": "Account", "company": company, "account_name": f"TVA collectée {rate_txt}", "parent_account": parent,
				"account_type": "Tax", "tax_rate": flt(rate), "is_group": 0, "root_type": "Liability"})
			doc.flags.ignore_permissions = True
			doc.insert()
			account = doc.name
		else:
			account = base
	if not account:
		frappe.throw(_("لا يوجد حساب ضريبة TVA في دليل الحسابات"))
	doc = frappe.get_doc("Sales Taxes and Charges Template", name) if name else frappe.new_doc("Sales Taxes and Charges Template")
	doc.title, doc.company = TVA_TEMPLATE, company
	doc.taxes = []
	doc.append("taxes", {"charge_type": "On Net Total", "account_head": account, "description": f"TVA {flt(rate):g}%", "rate": flt(rate)})
	doc.save(ignore_permissions=True)
	return doc.name


@frappe.whitelist(methods=["POST"])
def save_doc_settings(docs):
	_manager_only()
	d = frappe.parse_json(docs) or {}
	clean = {"tva": cint(d.get("tva")), "tva_rate": min(100, max(0, flt(d.get("tva_rate") or 19))), "footer": str(d.get("footer") or "")[:300],
		"payment_days": max(0, cint(d.get("payment_days"))), "quote_days": max(1, cint(d.get("quote_days")) or 15),
		"show_description": 1 if d.get("show_description") else 0}
	if clean["tva"]:
		clean["tva_template"] = _tva_template(clean["tva_rate"])
	frappe.db.set_default("atelier_docs", json.dumps(clean, ensure_ascii=False))
	return clean


def apply_tva(so):
	"""New order: add the TVA template when TVA is on and the customer is not exempt."""
	d = doc_settings()
	if not d.get("tva") or not d.get("tva_template"):
		return
	if cint(frappe.db.get_value("Customer", so.customer, "atelier_tva_exempt")):
		return
	so.taxes_and_charges = d["tva_template"]
	so.set("taxes", [])
	from erpnext.controllers.accounts_controller import get_taxes_and_charges
	for t in get_taxes_and_charges("Sales Taxes and Charges Template", d["tva_template"]) or []:
		so.append("taxes", t)


STAFF_ROLES = ["Sales User", "Projects User", "Stock User", "Purchase User"]
MANAGER_ROLES = STAFF_ROLES + ["Sales Manager", "Accounts User", "Accounts Manager", "Item Manager", "Purchase Manager", "Projects Manager"]
# The workshop's four roles. Manager sees everything; sales works on orders, customers and payments but never
# cost or profit; designer and printer see only the cards they are on, without prices.
ROLE_GRANTS = {
	"manager": MANAGER_ROLES,
	"sales": STAFF_ROLES,
	"designer": ["Sales User", "Projects User"],
	"printer": ["Sales User", "Projects User", "Stock User"],
}
WORKERS = ("designer", "printer")


def app_role(user=None):
	user = user or frappe.session.user
	roles = frappe.get_roles(user)
	if user == "Administrator" or "System Manager" in roles or "Accounts Manager" in roles:
		return "manager"
	r = frappe.db.get_default("atelier_role", parent=user)
	return r if r in ROLE_GRANTS else "sales"


def is_worker(user=None):
	return app_role(user) in WORKERS


def no_worker():
	if is_worker():
		frappe.throw(_("هذه الصفحة غير متاحة لدورك"), frappe.PermissionError)


def _is_local(netloc):
	host = (netloc or "").split(":")[0].lower()
	return host in ("localhost", "127.0.0.1", "0.0.0.0", "::1") or host.endswith(".localhost") or host.startswith(("192.168.", "10."))


def remember_public_url():
	"""Called on boot: the first time the app is opened from a public address (e.g. the Tailscale link),
	remember it, so links made on the shop's own computer (localhost) still work on the workers' phones."""
	req = getattr(frappe.local, "request", None)
	if not req:
		return
	from urllib.parse import urlsplit

	h = urlsplit(req.host_url)
	if h.scheme == "https" and not _is_local(h.netloc):
		url = f"https://{h.netloc}"
		if frappe.db.get_default("atelier_public_url") != url:
			frappe.db.set_default("atelier_public_url", url)
			frappe.db.commit()  # boot is a GET request: Frappe does not commit it by itself


def _here(link):
	"""A link the person receiving it can open: the shop's public address when the manager is on the shop's own
	computer (localhost), else the address the manager is using."""
	req = getattr(frappe.local, "request", None)
	if not link:
		return link
	from urllib.parse import urlsplit, urlunsplit

	u = urlsplit(link)
	base = urlsplit(req.host_url) if req else None
	public = frappe.db.get_default("atelier_public_url")
	if public and (not base or _is_local(base.netloc)):
		base = urlsplit(public)
	if not base:
		return link
	return urlunsplit((base.scheme, base.netloc, u.path, u.query, u.fragment))


@frappe.whitelist(methods=["POST"])
def set_user_password(email, password):
	"""The manager sets a password and tells it to the employee (simpler than a link for a small shop)."""
	_manager_only()
	if email in ("Administrator", "Guest") or not frappe.db.exists("User", email):
		frappe.throw(_("الحساب غير موجود"))
	_check_password(password)
	from frappe.utils.password import update_password

	update_password(email, password, logout_all_sessions=True)
	return {"ok": 1}


def _check_password(password):
	"""One rule for the manager's window and the employee's link page: 8+ characters, not only digits."""
	password = password or ""
	if len(password) < 8:
		frappe.throw(_("كلمة السر 8 أحرف على الأقل"))
	if password.isdigit() or len(set(password)) < 4:
		frappe.throw(_("كلمة السر سهلة جدًا: امزج حروفًا وأرقامًا"))


@frappe.whitelist(allow_guest=True, methods=["POST"])
@rate_limit(limit=10, seconds=600)
def password_by_link(key, password):
	"""The employee's own link (from «كلمة السر» ← «رابط»): checks the link, then sets the password."""
	from frappe.core.doctype.user.user import _get_user_for_update_password
	from frappe.utils.password import update_password

	r = _get_user_for_update_password(key, None)
	if not r.user or r.message:
		frappe.throw(_("الرابط مستعمل من قبل أو انتهت صلاحيته. اطلب رابطًا جديدًا من مدير المطبعة."))
	_check_password(password)
	update_password(r.user, password, logout_all_sessions=True)
	frappe.db.set_value("User", r.user, "reset_password_key", "")
	return {"email": r.user}


@frappe.whitelist(methods=["POST"])
def save_user(email, full_name, role="sales", enabled=1):
	"""Create or update a login for a team member. No password is set here: a reset link is returned for the person to choose one."""
	_manager_only()
	email = (email or "").strip().lower()
	if not frappe.utils.validate_email_address(email):
		frappe.throw(_("البريد غير صالح"))
	new = not frappe.db.exists("User", email)
	user = frappe.new_doc("User") if new else frappe.get_doc("User", email)
	if new:
		user.email = email
		user.send_welcome_email = 0
		user.user_type = "System User"
	parts = (full_name or email).strip().split(" ", 1)
	user.first_name, user.last_name = parts[0], (parts[1] if len(parts) > 1 else None)
	user.enabled = cint(enabled)
	user.language = "ar"
	role = role if role in ROLE_GRANTS else "sales"
	user.set("roles", [r for r in user.roles if r.role not in MANAGER_ROLES])
	for r in ROLE_GRANTS[role]:
		user.append("roles", {"role": r})
	user.save(ignore_permissions=True)
	frappe.db.set_default("atelier_role", role, parent=user.name)
	link = _here(user._reset_password(send_email=False)) if new else None
	if new:
		from atelier.production import link_member
		link_member(user.name, user.full_name)
	return {"name": user.name, "link": link}


@frappe.whitelist(methods=["POST"])
def add_to_team(email):
	"""One click from Settings: the login becomes a person in the team, linked to it."""
	_manager_only()
	if not frappe.db.exists("User", email):
		frappe.throw(_("الحساب غير موجود"))
	from atelier.production import link_member
	return link_member(email)


@frappe.whitelist()
def team_accounts():
	"""Logins a team member can be linked to."""
	if not frappe.has_permission("Project", "write"):
		frappe.throw(_("ليست لديك صلاحية لهذا الإجراء."), frappe.PermissionError)
	return frappe.get_all("User", filters={"user_type": "System User", "enabled": 1, "name": ["not in", ["Administrator", "Guest"]]},
		fields=["name", "full_name"], order_by="full_name asc")


@frappe.whitelist(methods=["POST"])
def reset_link(email):
	_manager_only()
	return _here(frappe.get_doc("User", email)._reset_password(send_email=False))


@frappe.whitelist(methods=["POST"])
def rename_fund(account, label):
	_manager_only()
	if frappe.db.get_value("Account", account, "account_type") not in ("Cash", "Bank"):
		frappe.throw(_("حساب غير صالح"))
	label = (label or "").strip()[:80]
	if not label:
		frappe.throw(_("اكتب اسمًا"))
	frappe.db.set_value("Account", account, "account_name", label)
	return label


@frappe.whitelist(methods=["POST"])
def set_mode_account(mode, account, label=None):
	"""Which fund a payment method lands in, and the name shown for it."""
	_manager_only()
	label = (label or "").strip()[:60]
	if label:
		_save_modes([(v, label if v == mode else old) for v, old in api.all_modes()])
	company = api._company()
	mop = frappe.get_doc("Mode of Payment", mode)
	row = next((r for r in mop.accounts if r.company == company), None)
	if row:
		row.default_account = account
	else:
		mop.append("accounts", {"company": company, "default_account": account})
	mop.save(ignore_permissions=True)
	return account


@frappe.whitelist(methods=["POST"])
def save_alerts(alerts):
	_manager_only()
	a = frappe.parse_json(alerts) or {}
	clean = {k: cint(a.get(k)) for k in ALERT_DEFAULTS}
	frappe.db.set_default("atelier_alerts", json.dumps(clean))
	return clean


def _backups():
	import os
	path = frappe.get_site_path("private", "backups")
	if not os.path.isdir(path):
		return []
	files = sorted((f for f in os.listdir(path) if f.endswith((".sql.gz", ".tar"))), reverse=True)[:12]
	return [{"file": f, "size": os.path.getsize(os.path.join(path, f)), "url": "/backups/" + f} for f in files]


@frappe.whitelist(methods=["POST"])
def backup_now():
	_manager_only()
	from frappe.utils.backups import new_backup
	new_backup(ignore_files=False, force=True)
	return _backups()


def settings_fields():
	from frappe.custom.doctype.custom_field.custom_field import create_custom_fields
	create_custom_fields({"Customer": [{"fieldname": "atelier_tva_exempt", "label": "معفى من TVA", "fieldtype": "Check", "insert_after": "atelier_ai", "module": "Atelier"}]})


def demo_settings():
	frappe.set_user("Administrator")
	settings_fields()
	frappe.db.commit()


# ---------------------------------------------------------------- reports: one period against the previous one
def _period(kind, start=None, end=None):
	from frappe.utils import add_months, getdate
	today = getdate(nowdate())
	if kind == "custom" and start and end:
		a, b = getdate(start), getdate(end)
		n = (b - a).days + 1
		return a, b, add_days(a, -n), add_days(a, -1)
	if kind == "year":
		a = today.replace(month=1, day=1)
		return a, a.replace(month=12, day=31), a.replace(year=a.year - 1), a.replace(year=a.year - 1, month=12, day=31)
	if kind == "quarter":
		q = (today.month - 1) // 3
		a = today.replace(month=q * 3 + 1, day=1)
		b = get_last_day(add_months(a, 2))
		pa = add_months(a, -3)
		return a, b, pa, get_last_day(add_months(pa, 2))
	a = get_first_day(today)
	pa = add_months(a, -1)
	return a, get_last_day(a), pa, get_last_day(pa)


@frappe.whitelist()
def reports2(period="month", start=None, end=None):
	api._require("GL Entry")
	company = api._company()
	a, b, pa, pb = _period(period, start, end)

	def one(sql, *args):
		return flt(frappe.db.sql(sql, args)[0][0])

	def figures(x, y):
		inv = one("select sum(base_net_total) from `tabSales Invoice` where docstatus=1 and company=%s and posting_date between %s and %s", company, x, y)
		got = one("""select sum(base_received_amount) from `tabPayment Entry` where docstatus=1 and company=%s and payment_type='Receive'
			and party_type='Customer' and posting_date between %s and %s""", company, x, y)
		# money given back to customers (a cancelled order, a return) is not collected money
		got -= one("""select sum(base_paid_amount) from `tabPayment Entry` where docstatus=1 and company=%s and payment_type='Pay'
			and party_type='Customer' and posting_date between %s and %s""", company, x, y)
		got -= one("""select sum(jea.debit) from `tabJournal Entry Account` jea join `tabJournal Entry` je on je.name=jea.parent
			where je.docstatus=1 and je.company=%s and je.is_opening='No' and je.posting_date between %s and %s and jea.party_type='Customer'
			and exists (select 1 from `tabJournal Entry Account` c join `tabAccount` acc on acc.name=c.account
				where c.parent=je.name and acc.account_type in ('Cash','Bank') and c.credit > 0)""", company, x, y)
		pl = dict(frappe.db.sql("""select acc.root_type, sum(gle.credit - gle.debit) from `tabGL Entry` gle join `tabAccount` acc on acc.name=gle.account
			where gle.company=%s and gle.is_cancelled=0 and gle.posting_date between %s and %s and acc.root_type in ('Income','Expense') group by acc.root_type""", (company, x, y)))
		orders = frappe.db.sql("""select count(*), coalesce(sum(grand_total), 0) from `tabSales Order` where docstatus<2 and company=%s
			and ifnull(atelier_archived, 0) in (0, 1) and transaction_date between %s and %s""", (company, x, y))[0]
		return {"invoiced": inv, "collected": got, "income": flt(pl.get("Income")), "expenses": -flt(pl.get("Expense")),
			"profit": flt(pl.get("Income")) + flt(pl.get("Expense")), "orders": cint(orders[0]), "orders_total": flt(orders[1])}

	now, prev = figures(a, b), figures(pa, pb)
	# delivered on time: first delivery note of each order delivered in the period, against its due date
	late = frappe.db.sql("""select so.name, so.delivery_date, min(dn.posting_date) delivered from `tabSales Order` so
		join `tabDelivery Note Item` dni on dni.against_sales_order=so.name join `tabDelivery Note` dn on dn.name=dni.parent and dn.docstatus=1
		where so.company=%s group by so.name having delivered between %s and %s""", (company, a, b), as_dict=True)
	now["delivered"] = len(late)
	now["late"] = sum(1 for r in late if r.delivery_date and r.delivered > r.delivery_date)
	# 12 months of sales and expenses
	from frappe.utils import add_months
	months = []
	for i in range(11, -1, -1):
		m0 = get_first_day(add_months(b, -i))
		m1 = get_last_day(m0)
		months.append({"month": str(m0),
			"sales": one("select sum(base_net_total) from `tabSales Invoice` where docstatus=1 and company=%s and posting_date between %s and %s", company, m0, m1),
			"expenses": one("""select sum(gle.debit - gle.credit) from `tabGL Entry` gle join `tabAccount` acc on acc.name=gle.account
				where gle.company=%s and gle.is_cancelled=0 and acc.root_type='Expense' and gle.posting_date between %s and %s""", company, m0, m1)})
	# profitability of the period's orders (ledger result, as on the old reports page)
	from atelier.atelier.report.rentabilite_commande import rentabilite_commande as rc
	profit = []
	for so in frappe.get_list("Sales Order", filters={"docstatus": ["<", 2], "project": ["is", "set"], "transaction_date": ["between", [a, b]]},
			fields=["name", "project", "customer_name", "atelier_subject", "grand_total"], order_by="creation desc", limit=200):
		gl = rc.gl_totals(so.project)
		revenue, cost = sum(gl["Income"].values()), sum(gl["Expense"].values()) + rc.internal_cost(so.project)
		if revenue:
			profit.append({"name": so.name, "title": so.atelier_subject or so.name, "customer": so.customer_name, "revenue": revenue, "cost": cost,
				"result": revenue - cost, "margin": round((revenue - cost) / revenue * 100) if revenue else None})
	profit.sort(key=lambda r: r["margin"] if r["margin"] is not None else 999)
	# ageing of what customers owe
	ageing = {"current": 0, "d30": 0, "d60": 0, "older": 0}
	debtors = {k: [] for k in ageing}
	for r in frappe.db.sql("""select name, customer, customer_name, outstanding_amount, datediff(curdate(), due_date) late from `tabSales Invoice`
			where docstatus=1 and company=%s and outstanding_amount > 0.005 order by due_date asc""", company, as_dict=True):
		k = "current" if r.late <= 0 else "d30" if r.late <= 30 else "d60" if r.late <= 60 else "older"
		ageing[k] += flt(r.outstanding_amount)
		debtors[k].append({"invoice": r.name, "customer": r.customer, "customer_name": r.customer_name, "amount": flt(r.outstanding_amount), "late": max(0, cint(r.late))})
	# money in by payment method, expenses by account, purchases by supplier, materials used from stock
	by_mode = frappe.db.sql("""select mode_of_payment mode, count(*) n, sum(base_received_amount) total from `tabPayment Entry`
		where docstatus=1 and company=%s and payment_type='Receive' and party_type='Customer' and posting_date between %s and %s
		group by mode_of_payment order by total desc""", (company, a, b), as_dict=True)
	labels = dict(api.all_modes())
	for r in by_mode:
		r.label = labels.get(r.mode, r.mode or "غير محدد")
	expense_types = frappe.db.sql("""select acc.account_name name, sum(gle.debit - gle.credit) total from `tabGL Entry` gle join `tabAccount` acc on acc.name=gle.account
		where gle.is_cancelled=0 and gle.company=%s and acc.root_type='Expense' and gle.posting_date between %s and %s
		group by acc.account_name having total > 0 order by total desc limit 8""", (company, a, b), as_dict=True)
	for c in expense_types:
		c.name = _plain_account(c.name)
	purchases = frappe.db.sql("""select supplier, supplier_name name, count(*) n, sum(base_net_total) total from `tabPurchase Invoice`
		where docstatus=1 and company=%s and posting_date between %s and %s group by supplier order by total desc limit 8""", (company, a, b), as_dict=True)
	materials = frappe.db.sql("""select sle.item_code, item.item_name name, item.stock_uom uom, -sum(sle.actual_qty) qty, -sum(sle.stock_value_difference) total
		from `tabStock Ledger Entry` sle join `tabItem` item on item.name=sle.item_code
		where sle.is_cancelled=0 and sle.company=%s and sle.voucher_type='Stock Entry' and sle.actual_qty < 0 and sle.posting_date between %s and %s
		group by sle.item_code order by total desc limit 10""", (company, a, b), as_dict=True)
	top_customers = frappe.db.sql("""select customer, customer_name name, count(*) n, sum(base_net_total) total from `tabSales Invoice`
		where docstatus=1 and company=%s and posting_date between %s and %s group by customer order by total desc limit 6""", (company, a, b), as_dict=True)
	top_services = frappe.db.sql("""select soi.item_name name, count(distinct so.name) n, sum(soi.base_net_amount) total from `tabSales Order Item` soi
		join `tabSales Order` so on so.name=soi.parent where so.docstatus<2 and so.company=%s and so.transaction_date between %s and %s
		group by soi.item_name order by total desc limit 6""", (company, a, b), as_dict=True)
	# team: cards each member is on, done in the period, still open, late
	cfg = get_config()
	deliver = _deliver_col(cfg)
	team = {}
	today = frappe.utils.getdate(nowdate())
	for so in frappe.get_all("Sales Order", filters={"docstatus": ["<", 2], "atelier_members": ["is", "set"]},
			fields=["name", "atelier_members", "atelier_column", "per_delivered", "delivery_date", "transaction_date", "modified", "atelier_archived"], limit=2000):
		done = flt(so.per_delivered) >= 100 or so.atelier_column == deliver
		for m in _jl(so.atelier_members):
			t = team.setdefault(m, {"name": m, "done": 0, "open": 0, "late": 0})
			if done:
				if a <= frappe.utils.getdate(so.modified) <= b:
					t["done"] += 1
			elif not cint(so.atelier_archived):
				t["open"] += 1
				if so.delivery_date and frappe.utils.getdate(so.delivery_date) < today:
					t["late"] += 1
	roles = {m["name"]: m.get("role") for m in production._team()}
	for t in team.values():
		t["role"] = roles.get(t["name"])
	return {"period": {"kind": period, "from": str(a), "to": str(b), "prev_from": str(pa), "prev_to": str(pb)},
		"now": now, "prev": prev, "months": months, "profit": profit, "ageing": ageing,
		"top_customers": top_customers, "top_services": top_services, "team": sorted(team.values(), key=lambda t: -t["done"]),
		"debtors": debtors, "by_mode": by_mode, "expense_types": expense_types, "purchases": purchases, "materials": materials}


def payment_order_field():
	"""Payment Entry → the order an advance was taken for (used to keep advances on their own order)."""
	from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

	create_custom_fields({"Payment Entry": [{"fieldname": "atelier_order", "label": "طلب التسبيق", "fieldtype": "Link", "options": "Sales Order",
		"insert_after": "party_name", "read_only": 1, "module": "Atelier"}]})
	frappe.db.commit()


# ---------------------------------------------------------------- outgoing email (password reset, new accounts)
MAIL_ACCOUNT = "البريد الصادر"  # renamed to the shop name on save (_sync_mail_name)


def email_settings():
	name = frappe.db.get_value("Email Account", {"default_outgoing": 1}) or frappe.db.get_value("Email Account", MAIL_ACCOUNT)
	if not name:
		return {"configured": 0, "email_id": "", "smtp_server": "", "smtp_port": 587, "security": "tls", "login_id": ""}
	a = frappe.get_doc("Email Account", name)
	return {"configured": 1, "name": a.name, "email_id": a.email_id, "smtp_server": a.smtp_server, "smtp_port": a.smtp_port or 587,
		"security": "ssl" if a.use_ssl_for_outgoing else "tls" if a.use_tls else "none", "login_id": a.login_id or "",
		"has_password": 1 if a.get_password("password", raise_exception=False) else 0}


@frappe.whitelist(methods=["POST"])
def save_email(cfg):
	"""Outgoing mail through the workshop's own mailbox. The password is typed by the manager and stored encrypted by Frappe."""
	_manager_only()
	c = frappe.parse_json(cfg) or {}
	email = (c.get("email_id") or "").strip()
	if not frappe.utils.validate_email_address(email) or not (c.get("smtp_server") or "").strip():
		frappe.throw(_("اكتب البريد وخادم الإرسال"))
	name = frappe.db.get_value("Email Account", {"default_outgoing": 1}) or frappe.db.get_value("Email Account", MAIL_ACCOUNT)
	a = frappe.get_doc("Email Account", name) if name else frappe.new_doc("Email Account")
	if a.is_new():
		a.email_account_name = MAIL_ACCOUNT
	a.email_id = email
	a.enable_outgoing, a.default_outgoing, a.enable_incoming = 1, 1, 0
	a.smtp_server = c["smtp_server"].strip()
	a.smtp_port = cint(c.get("smtp_port")) or 587
	sec = c.get("security") or "tls"
	a.use_tls, a.use_ssl_for_outgoing = (1 if sec == "tls" else 0), (1 if sec == "ssl" else 0)
	login = (c.get("login_id") or "").strip()
	a.login_id_is_different = 1 if login and login != email else 0
	a.login_id = login if a.login_id_is_different else None
	if c.get("password"):
		a.password = c["password"]
	a.awaiting_password = 0
	a.flags.ignore_validate = False
	try:
		a.save(ignore_permissions=True)
	except frappe.ValidationError as e:
		# ERPNext tests the mailbox on save and answers in English: say what to check, in Arabic
		frappe.clear_messages()
		frappe.throw(_("تعذّر الاتصال بخادم البريد. تحقّق من الخادم والمنفذ ونوع الحماية والبريد وكلمة السر.") + f" ({str(e)[:120]})")
	_sync_mail_name(a.name)
	return email_settings()


def _sync_mail_name(name=None):
	"""Customers see the account name as the sender: it is the shop's name, never the product's."""
	name = name or frappe.db.get_value("Email Account", {"default_outgoing": 1})
	if not name:
		return
	prof = workshop_profile()
	want = f"{(prof.get('name_ar') or api._company()).strip()[:90]}"
	if want and name != want and not frappe.db.exists("Email Account", want):
		frappe.rename_doc("Email Account", name, want, force=True)


@frappe.whitelist(methods=["POST"])
def test_email(to):
	_manager_only()
	frappe.sendmail(recipients=[to], subject="رقمي — رسالة تجريبية", message="<p dir='rtl'>البريد الصادر يعمل.</p>", now=True)
	return True


# ---------------------------------------------------------------- suppliers: list, profile, purchase orders, supplier invoices, payments


def _cost_manager():
	"""Cost and margin are manager-only, whatever else a role may read."""
	_manager_only()
	api._require("GL Entry")


def _cost_view(name):
	estimate = frappe.db.get_value("Cost Estimate", {"sales_order": name})
	so = frappe.get_doc("Sales Order", name)
	base = {"selling_price": None if any(i.atelier_price_pending for i in so.items) else flt(so.net_total),
		"default_qty": sum(flt(i.qty) for i in so.items) or 1}
	if not estimate:
		return {**base, "name": None, "qty": base["default_qty"], "waste_percent": 0, "lines": []}
	doc = frappe.get_doc("Cost Estimate", estimate)
	return {**base, "name": doc.name, "qty": doc.qty, "waste_percent": flt(doc.waste_percent), "total_cost": doc.total_cost,
		"unit_cost": doc.unit_cost, "estimated_margin": doc.estimated_margin, "margin_percent": doc.margin_percent,
		"missing_count": doc.missing_count,
		"lines": [{"cost_type": l.cost_type, "description": l.description, "qty": l.qty, "rate": l.rate if l.rate or l.zero_confirmed else None,
			"amount": l.amount} for l in doc.lines]}


@frappe.whitelist()
def card_cost(name):
	_cost_manager()
	return _cost_view(name)


@frappe.whitelist(methods=["POST"])
def save_card_cost(name, data):
	_cost_manager()
	d = frappe.parse_json(data) or {}
	so = frappe.get_doc("Sales Order", name)
	if so.docstatus == 2:
		frappe.throw(_("هذا الطلب ملغى"))
	estimate = frappe.db.get_value("Cost Estimate", {"sales_order": name})
	doc = frappe.get_doc("Cost Estimate", estimate) if estimate else frappe.new_doc("Cost Estimate")
	old_lines = list(doc.get("lines") or [])  # a type removed from the list stays valid on old lines
	lines = []
	for row in d.get("lines") or []:
		text = (row.get("description") or "").strip()[:140]
		if not text:
			continue
		if row.get("cost_type") not in [c["value"] for c in custom_list("cost_types")] + [l.cost_type for l in old_lines]:
			frappe.throw(_("نوع التكلفة غير صالح"))
		known = row.get("rate") not in (None, "")
		lines.append({"cost_type": row["cost_type"], "description": text, "qty": flt(row.get("qty")) or 1,
			"rate": flt(row["rate"]) if known else None, "zero_confirmed": 1 if known and not flt(row["rate"]) else 0,
			"rate_source": "Saisie manuelle" if known else None})
	pending = any(i.atelier_price_pending for i in so.items)
	doc.update({"customer": so.customer, "company": so.company, "project": so.project, "sales_order": so.name,
		"title": so.get("atelier_subject") or so.name, "qty": flt(d.get("qty")) or 1,
		"waste_percent": max(0, min(100, flt(d.get("waste_percent")))),
		"selling_price": None if pending else so.net_total})
	doc.set("lines", lines)
	doc.flags.ignore_permissions = True
	doc.save()
	return _cost_view(name)


def _save_modes(modes):
	frappe.db.set_default("atelier_modes", json.dumps([{"value": v, "label": l} for v, l in modes], ensure_ascii=False))


@frappe.whitelist(methods=["POST"])
def add_fund(label, fund_type):
	"""A new cash box or bank account, placed beside the company's default one in the chart."""
	_manager_only()
	label = (label or "").strip()[:80]
	if not label or fund_type not in ("Cash", "Bank"):
		frappe.throw(_("اكتب اسم الصندوق واختر نوعه"))
	company = api._company()
	existing = frappe.db.get_value("Account", {"company": company, "account_name": label}, ["name", "disabled", "account_type"], as_dict=True)
	if existing and not (existing.disabled and existing.account_type == fund_type):
		frappe.throw(_("يوجد حساب بهذا الاسم"))
	if existing:  # a removed fund comes back
		frappe.db.set_value("Account", existing.name, "disabled", 0)
		frappe.db.set_default("atelier_funds", json.dumps(api._stored_list("atelier_funds") + [existing.name], ensure_ascii=False))
		return existing.name
	default = frappe.db.get_value("Company", company, "default_cash_account" if fund_type == "Cash" else "default_bank_account")
	account = frappe.get_doc({"doctype": "Account", "company": company, "account_name": label, "account_type": fund_type,
		"parent_account": frappe.db.get_value("Account", default, "parent_account"), "is_group": 0}).insert(ignore_permissions=True)
	frappe.db.set_default("atelier_funds", json.dumps(api._stored_list("atelier_funds") + [account.name], ensure_ascii=False))
	return account.name


@frappe.whitelist(methods=["POST"])
def remove_fund(account):
	"""Any fund with no movement and no payment method. Accounts are disabled: the chart keeps them."""
	_manager_only()
	company = api._company()
	if frappe.db.get_value("Account", account, "account_type") not in ("Cash", "Bank"):
		frappe.throw(_("حساب غير صالح"))
	if frappe.db.exists("GL Entry", {"account": account}):
		frappe.throw(_("لهذا الصندوق حركات مالية، فلا يمكن حذفه"))
	if frappe.db.exists("Mode of Payment Account", {"default_account": account, "parent": ["in", [m[0] for m in api.all_modes()]]}):
		frappe.throw(_("هذا الصندوق مرتبط بطريقة دفع. غيّر ربطها أولًا"))
	if account in frappe.get_cached_value("Company", company, ["default_cash_account", "default_bank_account"]):
		frappe.throw(_("هذا هو الصندوق الافتراضي للشركة، فلا يمكن حذفه"))
	frappe.db.set_value("Account", account, "disabled", 1)
	frappe.db.set_default("atelier_funds", json.dumps([a for a in api._stored_list("atelier_funds") if a != account], ensure_ascii=False))
	return True


@frappe.whitelist(methods=["POST"])
def add_mode(label, account):
	_manager_only()
	label, company = (label or "").strip()[:60], api._company()
	kind = frappe.db.get_value("Account", account, "account_type")
	if not label or kind not in ("Cash", "Bank"):
		frappe.throw(_("اكتب اسم الطريقة واختر صندوقها"))
	if any(label in m for m in api.all_modes()):
		frappe.throw(_("توجد طريقة بهذا الاسم"))
	if frappe.db.exists("Mode of Payment", label):
		doc = frappe.get_doc("Mode of Payment", label)  # a method removed earlier comes back
	else:
		doc = frappe.get_doc({"doctype": "Mode of Payment", "mode_of_payment": label, "type": kind, "enabled": 1})
	row = next((r for r in doc.accounts if r.company == company), None)
	if row:
		row.default_account = account
	else:
		doc.append("accounts", {"company": company, "default_account": account})
	doc.save(ignore_permissions=True)
	_save_modes(api.all_modes() + [(label, label)])
	return label


@frappe.whitelist(methods=["POST"])
def remove_mode(value):
	"""Leaves the list; the record stays, so past payments keep their method."""
	_manager_only()
	modes = api.all_modes()
	if value not in [m[0] for m in modes]:
		frappe.throw(_("طريقة غير صالحة"))
	if len(modes) == 1:
		frappe.throw(_("أبقِ طريقة دفع واحدة على الأقل"))
	_save_modes([m for m in modes if m[0] != value])
	return True


OPENING_ACCOUNT_NUMBER = "11"  # Report à Nouveau: starting money is neither income nor a sale


def _opening_counter(company):
	account = frappe.db.get_value("Account", {"company": company, "account_number": OPENING_ACCOUNT_NUMBER, "is_group": 0, "root_type": "Equity"})
	if not account:
		frappe.throw(_("لم يوجد حساب الترحيل من جديد (11) في دليل الحسابات"))
	return account


def _opening_entry(account):
	rows = frappe.db.sql("""select je.name, je.posting_date, jea.debit_in_account_currency amount
		from `tabJournal Entry` je join `tabJournal Entry Account` jea on jea.parent=je.name
		where je.docstatus=1 and je.is_opening='Yes' and jea.account=%s limit 1""", account, as_dict=True)
	return rows[0] if rows else None


@frappe.whitelist()
def opening_balances():
	_manager_only()
	company = api._company()
	rows = []
	for account in sorted(api.mode_funds(company)):
		entry = _opening_entry(account)
		rows.append({"account": account, "label": frappe.db.get_value("Account", account, "account_name"),
			"entry": entry.name if entry else None, "amount": flt(entry.amount) if entry else 0,
			"date": str(entry.posting_date) if entry else None})
	return {"rows": rows, "counter": frappe.db.get_value("Account", _opening_counter(company), "account_name")}


@frappe.whitelist(methods=["POST"])
def save_opening(account, amount, posting_date):
	"""One opening entry per fund: posted against 11, so it never counts as income."""
	_manager_only()
	company, amount = api._company(), flt(amount)
	if amount <= 0:
		frappe.throw(_("اكتب مبلغًا أكبر من صفر"))
	if account not in api.mode_funds(company):
		frappe.throw(_("حساب غير صالح"))
	if _opening_entry(account):
		frappe.throw(_("لهذا الصندوق رصيد افتتاحي. ألغه أولًا لتصحيحه"))
	je = frappe.get_doc({"doctype": "Journal Entry", "voucher_type": "Opening Entry", "is_opening": "Yes", "company": company,
		"posting_date": posting_date, "user_remark": _("رصيد افتتاحي"),
		"accounts": [{"account": account, "debit_in_account_currency": amount},
			{"account": _opening_counter(company), "credit_in_account_currency": amount}]})
	je.insert(ignore_permissions=True)
	je.submit()
	return je.name


@frappe.whitelist(methods=["POST"])
def cancel_opening(entry):
	_manager_only()
	je = frappe.get_doc("Journal Entry", entry)
	if je.is_opening != "Yes" or je.docstatus != 1:
		frappe.throw(_("هذا ليس قيدًا افتتاحيًا"))
	je.flags.ignore_permissions = True
	je.cancel()
	return True


DEFAULT_UNITS = [
	{"name": "قطعة", "calc": "count", "whole": 1}, {"name": "صفحة", "calc": "count", "whole": 1}, {"name": "وجه", "calc": "count", "whole": 1},
	{"name": "ورقة", "calc": "count", "whole": 1}, {"name": "علبة", "calc": "count", "whole": 1}, {"name": "خدمة", "calc": "count", "whole": 1},
	{"name": "م²", "calc": "area", "scale": "m", "whole": 0}, {"name": "سم²", "calc": "area", "scale": "cm", "whole": 0},
	{"name": "متر طولي", "calc": "length", "scale": "m", "whole": 0}, {"name": "سم طولي", "calc": "length", "scale": "cm", "whole": 0},
	{"name": "ساعة", "calc": "count", "whole": 0},
]
CALC_GROUP = {"count": "بالعدد", "length": "بالطول", "area": "بالمساحة"}


def _unit_calc(u):
	"""Older stored units have no calc: guess it from the name."""
	n = u.get("name") or ""
	if u.get("calc") in CALC_GROUP:
		calc = u["calc"]
	elif "²" in n or "مربع" in n:
		calc = "area"
	elif "طولي" in n:
		calc = "length"
	else:
		calc = "count"
	scale = u.get("scale") if u.get("scale") in ("m", "cm") else ("cm" if "سم" in n else "m")
	return {**u, "calc": calc, "scale": scale if calc != "count" else None, "group": CALC_GROUP[calc]}


DEFAULT_LISTS = {
	"tags": [{"name": "عاجل", "tone": "urgent"}, {"name": "مهم", "tone": "important"}, {"name": "في انتظار موافقة العميل", "tone": "wait"}],
	"roles": [{"name": n} for n in ("مصمم", "طابع", "تشطيب", "تركيب", "استقبال")],
	"cost_types": [{"value": "Matière", "label": "مواد", "material": 1}, {"value": "Machine", "label": "آلة", "material": 0},
		{"value": "Main d'œuvre", "label": "يد عاملة", "material": 0}, {"value": "Sous-traitance", "label": "عند مورد", "material": 0},
		{"value": "Finition", "label": "تشطيب", "material": 0}, {"value": "Autre", "label": "أخرى", "material": 0}],
	"due": [{"label": "اليوم", "days": 0}, {"label": "غدًا", "days": 1}, {"label": "بعد 3 أيام", "days": 3}, {"label": "بعد أسبوع", "days": 7}],
	"categories": [{"name": n} for n in ("طباعة رقمية", "أوفست", "لافتات", "ملصقات", "تصميم", "تركيب", "منتجات")],
	# stock page sections; each has the counting way a new material in it starts with
	"stock_sections": [{"name": "الورق", "way": "count", "color": "#2E90FA"}, {"name": "الطباعة الكبيرة", "way": "roll", "color": "#F79009"},
		{"name": "الأحبار", "way": "bottle", "color": "#9E77ED"}, {"name": "أخرى", "way": "count", "color": "#98A2B3"}],
	"paper_kinds": [{"name": n} for n in ("كوشيه", "أوتوكولون", "أوفست", "بريستول", "كرتون", "كالك")],
	"paper_sizes": [{"name": n} for n in ("A4", "A3", "A3+", "SRA3", "32×45", "50×70", "70×100")],
	"count_units": [{"name": n} for n in ("ورقة", "قطعة", "علبة", "متر طولي", "لتر")],
	"pack_names": [{"name": n} for n in ("رزمة", "علبة", "كرتونة", "حزمة")],
}
# lists edited from a picker, and the material setting that carries their value (a rename follows the materials)
PICKER_LISTS = {"stock_sections": "section", "paper_kinds": "kind", "paper_sizes": "size", "categories": None, "cost_types": None, "units": None,
	"count_units": None, "pack_names": "pack", "roles": None}


def custom_list(key):
	try:
		return json.loads(frappe.db.get_default("atelier_list_" + key) or "null") or DEFAULT_LISTS[key]
	except ValueError:
		return DEFAULT_LISTS[key]


def lists():
	return {key: custom_list(key) for key in DEFAULT_LISTS}


@frappe.whitelist(methods=["POST"])
def save_list_item(key, old, row):
	"""Add or edit one entry of a list from a picker; a rename carries the materials that used it."""
	_manager_only()
	if key not in PICKER_LISTS:
		frappe.throw(_("قائمة غير معروفة"))
	row = frappe.parse_json(row) or {}
	t = "label" if key == "cost_types" else "name"
	name = (row.get(t) or "").strip()[:60]
	if not name:
		frappe.throw(_("اكتب الاسم"))
	rows = [dict(x) for x in (units() if key == "units" else custom_list(key))]
	if name != old and any(x[t] == name for x in rows):
		frappe.throw(_("يوجد عنصر بهذا الاسم"))
	if key == "units" and old and old != name and _unit_used(old):
		frappe.throw(_("هذه الوحدة مستعملة في طلبات سابقة، لا يمكن تغيير اسمها. أضف وحدة جديدة بدلها."))
	row[t] = name
	i = next((k for k, x in enumerate(rows) if x[t] == old), None) if old else None
	if i is None:
		if key == "cost_types":
			row.setdefault("value", name)
		rows.append(row)
	else:
		rows[i] = {**rows[i], **row}
	out = save_units(json.dumps(rows, ensure_ascii=False)) if key == "units" else save_list(key, json.dumps(rows, ensure_ascii=False))
	if old and old != name:
		_rename_value(key, old, name)
	return out


@frappe.whitelist(methods=["POST"])
def delete_list_item(key, name, move_to=""):
	_manager_only()
	if key not in PICKER_LISTS:
		frappe.throw(_("قائمة غير معروفة"))
	if key == "units":
		return save_units(json.dumps([x for x in units() if x["name"] != name], ensure_ascii=False))
	t = "label" if key == "cost_types" else "name"
	out = save_list(key, json.dumps([x for x in custom_list(key) if x[t] != name], ensure_ascii=False))
	if PICKER_LISTS[key]:
		_move_cfg(PICKER_LISTS[key], name, move_to if any(x["name"] == move_to for x in out) else "")
	elif key == "categories":
		_rename_value(key, name, move_to if any(x["name"] == move_to for x in out) else "")
	return out


def _unit_used(name):
	return bool(frappe.db.sql("select 1 from `tabSales Order Item` where uom=%s limit 1", name)) or \
		(frappe.db.has_column("Sales Order Item", "atelier_unit") and bool(frappe.db.sql("select 1 from `tabSales Order Item` where atelier_unit=%s limit 1", name)))


def _rename_value(key, old, new):
	"""A renamed entry follows the records that stored it (cost types keep their stored value, so nothing moves)."""
	if PICKER_LISTS.get(key):
		_move_cfg(PICKER_LISTS[key], old, new)
	elif key == "categories":
		for dt in ("Item", "Sales Order Item", "Quotation Item"):
			if frappe.db.has_column(dt, "atelier_category"):
				frappe.db.sql(f"update `tab{dt}` set atelier_category=%s where atelier_category=%s", (new or None, old))


@frappe.whitelist(methods=["POST"])
def save_stock_section(old, name, way="count", color=""):
	return save_list_item("stock_sections", old, json.dumps({"name": name, "way": way, "color": color}))


@frappe.whitelist(methods=["POST"])
def delete_stock_section(name, move_to=""):
	return delete_list_item("stock_sections", name, move_to)


def _move_cfg(field, old, new):
	from atelier.materials import _has, material_cfg

	if not _has("atelier_packs"):
		return
	for it in frappe.get_all("Item", filters={"atelier_packs": ["like", f"%{field}%"]}, fields=["name", "atelier_packs"]):
		c = material_cfg(it.atelier_packs)
		if c.get(field) == old:
			raw = json.loads(it.atelier_packs or "{}")
			raw[field] = new
			frappe.db.set_value("Item", it.name, "atelier_packs", json.dumps(raw, ensure_ascii=False), update_modified=False)


def material_cost_types():
	return {"Matière"} | {c["value"] for c in custom_list("cost_types") if c.get("material")}


@frappe.whitelist(methods=["POST"])
def save_list(key, rows):
	"""Add, rename, reorder or remove the entries of one list. Past records keep what they stored."""
	_manager_only()
	if key == "units":
		return save_units(rows)
	if key not in DEFAULT_LISTS:
		frappe.throw(_("قائمة غير معروفة"))
	title = "label" if key in ("cost_types", "due") else "name"
	seen, out = set(), []
	for row in frappe.parse_json(rows) or []:
		text = (row.get(title) or "").strip()[:60]
		if not text or text in seen:
			continue
		seen.add(text)
		clean = {title: text}
		if key == "tags":
			clean["tone"] = row.get("tone") or ""
		elif key == "cost_types":
			clean.update({"value": row.get("value") or text, "material": cint(row.get("material"))})
		elif key == "due":
			clean["days"] = max(0, cint(row.get("days")))
		elif key in ("paper_kinds", "paper_sizes", "count_units", "pack_names", "roles"):
			pass
		elif key == "stock_sections":
			clean["way"] = row.get("way") if row.get("way") in ("roll", "bottle", "count") else "count"
			c = str(row.get("color") or "")
			clean["color"] = c if re.fullmatch(r"#[0-9A-Fa-f]{6}", c) else ""
		out.append(clean)
	if not out:
		frappe.throw(_("أبقِ عنصرًا واحدًا على الأقل"))
	frappe.db.set_default("atelier_list_" + key, json.dumps(out, ensure_ascii=False))
	return out


def units():
	try:
		rows = json.loads(frappe.db.get_default("atelier_units") or "null") or DEFAULT_UNITS
	except ValueError:
		rows = DEFAULT_UNITS
	return [_unit_calc(u) for u in rows]


@frappe.whitelist(methods=["POST"])
def save_units(rows):
	_manager_only()
	# a unit already on orders keeps its name: renaming or removing it here would orphan those lines
	new_names = {(r.get("name") or "").strip() for r in frappe.parse_json(rows) or []}
	for u in units():
		if u["name"] not in new_names and _unit_used(u["name"]):
			frappe.throw(_("الوحدة «{0}» مستعملة في طلبات، فلا يمكن حذفها أو تغيير اسمها. أضف وحدة جديدة بدلها.").format(u["name"]))
	seen, out = set(), []
	for row in frappe.parse_json(rows) or []:
		name = (row.get("name") or "").strip()[:40]
		if name and name not in seen:
			seen.add(name)
			out.append(_unit_calc({"name": name, "calc": row.get("calc"), "scale": row.get("scale"), "whole": 1 if row.get("whole") else 0}))
	if not out:
		frappe.throw(_("أبقِ وحدة واحدة على الأقل"))
	frappe.db.set_default("atelier_units", json.dumps(out, ensure_ascii=False))
	return out


SUPPLIER_FIELDS = [
	{"fieldname": "atelier_supplies", "label": "ما نشتريه منه", "fieldtype": "Data", "insert_after": "supplier_name"},
	{"fieldname": "atelier_phone", "label": "الهاتف", "fieldtype": "Data", "insert_after": "atelier_supplies"},
	{"fieldname": "atelier_email", "label": "البريد", "fieldtype": "Data", "insert_after": "atelier_phone"},
	{"fieldname": "atelier_address", "label": "العنوان", "fieldtype": "Small Text", "insert_after": "atelier_email"},
	{"fieldname": "atelier_rc", "label": "السجل التجاري RC", "fieldtype": "Data", "insert_after": "tax_id"},
	{"fieldname": "atelier_note", "label": "ملاحظة", "fieldtype": "Small Text", "insert_after": "atelier_address"},
]


def supplier_fields():
	from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

	create_custom_fields({"Supplier": [{**f, "module": "Atelier"} for f in SUPPLIER_FIELDS]})
	frappe.db.commit()


def _need_buying():
	if not api._can("Purchase Invoice"):
		frappe.throw(_("ليست لديك صلاحية لهذا الإجراء."), frappe.PermissionError)


@frappe.whitelist()
def suppliers2():
	_need_buying()
	company = api._company()
	month = get_first_day(nowdate())
	rows = frappe.get_all("Supplier", fields=["name", "supplier_name", "disabled", "atelier_supplies", "atelier_phone", "creation"], order_by="supplier_name asc", limit=1000)
	owe = {r.supplier: r for r in frappe.db.sql("""select supplier, sum(outstanding_amount) amount, count(*) n,
		max(case when due_date < curdate() then datediff(curdate(), due_date) else 0 end) late,
		sum(case when due_date < curdate() then outstanding_amount else 0 end) late_amount,
		sum(case when due_date between curdate() and date_add(curdate(), interval 7 day) then outstanding_amount else 0 end) week_amount
		from `tabPurchase Invoice` where docstatus=1 and company=%s and outstanding_amount > 0.005 group by supplier""", company, as_dict=True)}
	last = dict(frappe.db.sql("""select supplier, max(posting_date) from `tabPurchase Invoice` where docstatus=1 and company=%s group by supplier""", company))
	last_po = dict(frappe.db.sql("""select supplier, max(transaction_date) from `tabPurchase Order` where docstatus=1 and company=%s group by supplier""", company))
	bought = dict(frappe.db.sql("""select supplier, sum(base_net_total) from `tabPurchase Invoice` where docstatus=1 and company=%s and posting_date >= %s group by supplier""", (company, month)))
	for r in rows:
		o = owe.get(r.name) or {}
		r.owe, r.open_invoices, r.late, r.late_amount = flt(o.get("amount")), cint(o.get("n")), cint(o.get("late")), flt(o.get("late_amount"))
		r.week = flt(o.get("week_amount"))
		dates = [str(d) for d in (last.get(r.name), last_po.get(r.name)) if d]
		r.last = max(dates) if dates else None
		r.month = flt(bought.get(r.name))
	pmonth = get_first_day(add_days(month, -1))
	prev = flt(frappe.db.sql("""select sum(base_net_total) from `tabPurchase Invoice` where docstatus=1 and company=%s and posting_date between %s and %s""",
		(company, pmonth, add_days(month, -1)))[0][0])
	return {"rows": rows, "prev_month": prev}


@frappe.whitelist()
def supplier2(name):
	_need_buying()
	s = frappe.get_doc("Supplier", name)
	s.check_permission("read")
	invoices = frappe.db.sql("""select pi.name, pi.posting_date, pi.due_date, pi.grand_total, pi.outstanding_amount, pi.bill_no,
		(select so.name from `tabPurchase Invoice Item` x join `tabSales Order` so on so.project=x.project where x.parent=pi.name and ifnull(x.project, '')!='' limit 1) order_name,
		(select pii.description from `tabPurchase Invoice Item` pii where pii.parent=pi.name limit 1) what
		from `tabPurchase Invoice` pi where pi.supplier=%s and pi.docstatus=1 order by pi.posting_date desc limit 100""", name, as_dict=True)
	orders = frappe.db.sql("""select po.name, po.transaction_date, po.schedule_date, po.grand_total, po.per_billed, po.per_received, po.status,
		(select so.name from `tabPurchase Order Item` x join `tabSales Order` so on so.project=x.project where x.parent=po.name and ifnull(x.project, '')!='' limit 1) order_name,
		(select poi.description from `tabPurchase Order Item` poi where poi.parent=po.name limit 1) what
		from `tabPurchase Order` po where po.supplier=%s and po.docstatus=1 order by po.transaction_date desc limit 100""", name, as_dict=True)
	items = frappe.db.sql("""select pii.item_name, coalesce(pii.description, pii.item_name) what, sum(pii.qty) qty, sum(pii.base_net_amount) amount, max(pi.posting_date) last
		from `tabPurchase Invoice Item` pii join `tabPurchase Invoice` pi on pi.name=pii.parent where pi.supplier=%s and pi.docstatus=1
		group by what order by amount desc limit 30""", name, as_dict=True)
	for i in invoices:
		i.late = max(0, (frappe.utils.getdate(nowdate()) - frappe.utils.getdate(i.due_date)).days) if i.due_date and flt(i.outstanding_amount) > 0.005 else 0
	titles = dict(frappe.db.sql("select name, atelier_subject from `tabSales Order` where name in %s",
		[[x.order_name for x in invoices + orders if x.order_name] or [""]]))
	for x in invoices + orders:
		x.order_title = titles.get(x.order_name) if x.order_name else None
	payments = frappe.db.sql("""select name, posting_date, paid_amount, mode_of_payment, reference_no from `tabPayment Entry`
		where docstatus=1 and party_type='Supplier' and party=%s order by posting_date desc limit 100""", name, as_dict=True)
	year = str(frappe.utils.getdate(nowdate()).year) + "-01-01"
	return {"name": s.name, "supplier_name": s.supplier_name, "supplies": s.get("atelier_supplies") or "", "phone": s.get("atelier_phone") or "",
		"email": s.get("atelier_email") or "", "address": s.get("atelier_address") or "", "tax_id": s.tax_id or "", "rc": s.get("atelier_rc") or "",
		"note": s.get("atelier_note") or "", "disabled": cint(s.disabled), "since": str(s.creation)[:10],
		"owe": sum(flt(i.outstanding_amount) for i in invoices), "invoices": invoices, "orders": orders, "items": items, "payments": payments,
		"year_paid": sum(flt(p.paid_amount) for p in payments if str(p.posting_date) >= year),
		"year_bought": sum(flt(i.grand_total) for i in invoices if str(i.posting_date) >= year),
		"can_edit": bool(frappe.has_permission("Supplier", "write", s)), "accounts": api.expense_options()["accounts"] if api._can("Journal Entry", "create") else [],
		"open_orders": frappe.get_list("Sales Order", filters={"docstatus": ["<", 2], "project": ["is", "set"], "status": ["not in", ["Closed", "Completed"]]},
			fields=["name", "atelier_subject", "customer_name"], order_by="creation desc", limit=80)}


@frappe.whitelist(methods=["POST"])
def save_supplier(data):
	d = frappe.parse_json(data)
	name = (d.get("supplier_name") or "").strip()
	if not name:
		frappe.throw(_("اكتب اسم المورد"))
	if d.get("name"):
		s = frappe.get_doc("Supplier", d["name"])
		s.check_permission("write")
	else:
		if not frappe.has_permission("Supplier", "create"):
			frappe.throw(_("ليست لديك صلاحية لهذا الإجراء."), frappe.PermissionError)
		s = frappe.new_doc("Supplier")
		s.supplier_group = frappe.db.get_value("Supplier Group", {"is_group": 0}) or "All Supplier Groups"
	s.supplier_name = name[:140]
	s.tax_id = (d.get("tax_id") or "").strip() or None
	for k in ("supplies", "phone", "email", "address", "rc", "note"):
		s.set("atelier_" + k, (d.get(k) or "").strip() or None)
	s.save()
	return s.name


@frappe.whitelist(methods=["POST"])
def set_supplier_disabled(name, disabled=1):
	s = frappe.get_doc("Supplier", name)
	s.check_permission("write")
	s.db_set("disabled", cint(disabled))
	return cint(disabled)


def _external_line(description, amount, order=None, account=None):
	item = production._external_item()
	row = {"item_code": item, "qty": 1, "rate": flt(amount), "description": (description or "").strip()[:300] or None}
	if order:
		row["project"] = frappe.db.get_value("Sales Order", order, "project")
	if account:
		row["expense_account"] = account
	return row


@frappe.whitelist(methods=["POST"])
def create_purchase_order(supplier, description, amount, order=None, schedule_date=None):
	"""A purchase order to a supplier (outside work, paper…). Charged to an order's project when one is given."""
	if not frappe.has_permission("Purchase Order", "create"):
		frappe.throw(_("ليست لديك صلاحية لهذا الإجراء."), frappe.PermissionError)
	if flt(amount) <= 0 or not (description or "").strip():
		frappe.throw(_("اكتب ما نطلبه والمبلغ"))
	day = max(str(schedule_date or nowdate()), nowdate())
	line = {**_external_line(description, amount, order), "schedule_date": day}
	po = frappe.get_doc({"doctype": "Purchase Order", "supplier": supplier, "company": api._company(), "transaction_date": nowdate(), "schedule_date": day,
		"project": line.get("project"), "items": [line]})
	po.insert()
	po.submit()
	return po.name


@frappe.whitelist(methods=["POST"])
def create_supplier_invoice(supplier, description, amount, account=None, order=None, bill_no=None, due_date=None, purchase_order=None):
	"""A supplier invoice: from one of its purchase orders, or direct with an expense type."""
	_need_buying()
	if not frappe.has_permission("Purchase Invoice", "create"):
		frappe.throw(_("ليست لديك صلاحية لهذا الإجراء."), frappe.PermissionError)
	if purchase_order:
		from erpnext.buying.doctype.purchase_order.purchase_order import make_purchase_invoice
		pi = make_purchase_invoice(purchase_order)
		pi.disable_rounded_total = 1  # owe exactly what the supplier billed (no rounding to the dinar)
	else:
		if flt(amount) <= 0 or not (description or "").strip():
			frappe.throw(_("اكتب البيان والمبلغ"))
		line = _external_line(description, amount, order, account)
		pi = frappe.get_doc({"doctype": "Purchase Invoice", "disable_rounded_total": 1, "supplier": supplier, "company": api._company(), "posting_date": nowdate(),
			"project": line.get("project"), "items": [line]})
	pi.bill_no = (bill_no or "").strip() or None
	if due_date:
		pi.due_date = due_date
	pi.insert()
	pi.submit()
	return pi.name


def demo_suppliers():
	frappe.set_user("Administrator")
	supplier_fields()


def _folders():
	from atelier import folders

	return folders


# ---------------------------------------------------------------- card templates: a card's title, lines and checklist, reused by «طلب جديد»
def _card_templates():
	return frappe.parse_json(frappe.db.get_default("atelier_card_templates") or "[]") or []


@frappe.whitelist()
def card_templates():
	return _card_templates()


@frappe.whitelist(methods=["POST"])
def save_card_template(name, title):
	if is_worker():
		frappe.throw(_("ليست لديك صلاحية لهذا الإجراء."), frappe.PermissionError)
	title = (title or "").strip()[:60]
	if not title:
		frappe.throw(_("اكتب اسم القالب"))
	so = frappe.get_doc("Sales Order", name)
	so.check_permission("read")
	lines = [{k: l.get(k) for k in ("text", "item_code", "unit", "width", "height", "length", "pieces", "qty", "rate", "category")} for l in _card_lines(so)]
	for l in lines:
		if l["item_code"] == "SRV-GENERAL":
			l["item_code"] = None
	tpl = {"id": frappe.generate_hash(length=8), "title": title, "subject": so.get("atelier_subject") or "",
		"lines": lines, "checklist": [c.get("text") for c in _jl(so.get("atelier_checklist")) if c.get("text")]}
	items = [t for t in _card_templates() if t.get("title") != title] + [tpl]
	frappe.db.set_default("atelier_card_templates", json.dumps(items, ensure_ascii=False))
	return items


@frappe.whitelist(methods=["POST"])
def delete_card_template(id):
	if is_worker():
		frappe.throw(_("ليست لديك صلاحية لهذا الإجراء."), frappe.PermissionError)
	items = [t for t in _card_templates() if t.get("id") != id]
	frappe.db.set_default("atelier_card_templates", json.dumps(items, ensure_ascii=False))
	return items


# ---------------------------------------------------------------- display size (per user)
UI_SCALES = ("0.85", "0.9", "1", "1.1")
DEFAULT_UI_SCALE = "0.9"


def ui_scale(user=None):
	v = frappe.db.get_default("atelier_ui_scale", parent=user or frappe.session.user)
	return float(v if v in UI_SCALES else DEFAULT_UI_SCALE)


@frappe.whitelist(methods=["POST"])
def set_ui_scale(scale):
	"""Each user picks the app's size for themselves; it follows them to any computer."""
	v = str(scale).rstrip("0").rstrip(".") if "." in str(scale) else str(scale)
	if v not in UI_SCALES:
		frappe.throw(_("حجم غير صالح"))
	frappe.defaults.set_user_default("atelier_ui_scale", v)
	return float(v)


# ---------------------------------------------------------------- calendar settings (per workshop)
CALENDAR_DEFAULT = {"day_limit": 5, "off_days": [5]}  # off_days: JS getDay() numbers, 5 = Friday


def calendar_settings():
	try:
		v = json.loads(frappe.db.get_default("atelier_calendar") or "null")
	except ValueError:
		v = None
	return {**CALENDAR_DEFAULT, **(v or {})}


@frappe.whitelist(methods=["POST"])
def save_calendar(day_limit=5, off_days=None):
	if not _is_manager():
		frappe.throw(_("التخصيص للمدير فقط"), frappe.PermissionError)
	days = sorted({cint(d) for d in (frappe.parse_json(off_days) if off_days is not None else []) if 0 <= cint(d) <= 6})
	if len(days) >= 7:
		frappe.throw(_("أبقِ يوم عمل واحدًا على الأقل"))
	v = {"day_limit": max(0, cint(day_limit)), "off_days": days}
	frappe.db.set_default("atelier_calendar", json.dumps(v))
	return v


FILE_KINDS = ("final", "source", "ref", "identity", "")


@frappe.whitelist(methods=["POST"])
def set_file_kind(name, kind=""):
	"""Customer files tab: the user corrects the guessed kind of a file (final / source / reference / identity)."""
	if kind not in FILE_KINDS:
		frappe.throw(_("نوع غير معروف"))
	f = frappe.get_doc("File", name)
	if f.attached_to_doctype and f.attached_to_name:
		frappe.get_doc(f.attached_to_doctype, f.attached_to_name).check_permission("write")
	frappe.db.set_value("File", name, "atelier_kind", kind)
	return True


@frappe.whitelist(methods=["POST"])
def delete_customer_file(file):
	"""Customer files tab: delete a file uploaded by mistake (on the customer or on one of its cards)."""
	f = frappe.get_doc("File", file)
	if f.attached_to_doctype == "Sales Order":
		delete_file(f.attached_to_name, file)
		return True
	if f.attached_to_doctype != "Customer":
		frappe.throw(_("هذا الملف ليس من ملفات العميل"))
	frappe.get_doc("Customer", f.attached_to_name).check_permission("write")
	f.delete(ignore_permissions=True)
	return True


# ---------------------------------------------------------------- morning summary for the manager
@frappe.whitelist()
def morning():
	"""What the manager needs first thing: today's deliveries, what is late, money owed and in the boxes, and the
	decisions waiting for them. Read only."""
	_manager_only()
	from atelier import cashbox

	company = api._company()
	today = frappe.utils.getdate(nowdate())
	cfg = get_config()
	names = {c["id"]: c["name"] for c in cfg["columns"]}
	open_rows = [o for o in board2()["cards"] if flt(o.get("per_delivered")) < 100 and o.get("due")]
	def row(o):
		return {"name": o["name"], "title": o["title"], "customer": o.get("customer_name"), "column": names.get(o.get("column"), ""),
			"due": str(o["due"]), "days": (frappe.utils.getdate(o["due"]) - today).days}
	due_today = [row(o) for o in open_rows if frappe.utils.getdate(o["due"]) == today]
	late = sorted((row(o) for o in open_rows if frappe.utils.getdate(o["due"]) < today), key=lambda r: r["days"])
	owed = frappe.db.sql("""select coalesce(sum(outstanding_amount), 0), coalesce(sum(case when due_date < %s then outstanding_amount else 0 end), 0)
		from `tabSales Invoice` where docstatus=1 and company=%s and outstanding_amount > 0.005""", (frappe.utils.add_days(today, -30), company))[0]
	boxes = cashbox.boxes()
	cash = [r[0] for r in frappe.db.sql("select name from `tabAccount` where company=%s and account_type in ('Cash','Bank') and is_group=0", company)] or [""]
	in_funds = flt(frappe.db.sql("select sum(debit - credit) from `tabGL Entry` where is_cancelled=0 and account in %s", [cash])[0][0])
	unpriced = frappe.db.sql("""select count(distinct so.name) from `tabSales Order` so join `tabSales Order Item` soi on soi.parent=so.name
		where so.docstatus=0 and soi.atelier_price_pending=1 and so.creation < %s""", frappe.utils.add_days(today, -2))[0][0] \
		if frappe.db.has_column("Sales Order Item", "atelier_price_pending") else 0
	low = frappe.db.sql("""select i.item_name, coalesce(sum(b.actual_qty), 0) qty, i.safety_stock from `tabItem` i left join `tabBin` b on b.item_code=i.name
		where i.is_stock_item=1 and i.disabled=0 and i.safety_stock > 0 group by i.name having qty < i.safety_stock order by i.item_name limit 5""", as_dict=True)
	check = frappe.parse_json(frappe.db.get_default("atelier_books_check") or "{}") or {}
	decisions = []
	for h in boxes["pending"]:
		decisions.append({"kind": "handover", "text": _("{0} سلّم صندوقه: {1} من {2}").format(h["name"],
			frappe.format_value(flt(h["counted"]), {"fieldtype": "Currency"}), frappe.format_value(flt(h["recorded"]), {"fieldtype": "Currency"})), "go": "/money"})
	if unpriced:
		decisions.append({"kind": "unpriced", "text": _("{0} طلبات بلا سعر منذ أكثر من يومين").format(unpriced), "go": "/"})
	for m in low:
		decisions.append({"kind": "low", "text": _("«{0}» تحت الحد الأدنى ({1} من {2})").format(m.item_name, f"{flt(m.qty):g}", f"{flt(m.safety_stock):g}"), "go": "/stock"})
	from atelier.backup_status import warning as backup_warning

	if (bw := backup_warning()):
		decisions.insert(0, {"kind": "backup", "text": bw, "go": "/settings?tab=backup"})
	return {"date": str(today), "due_today": due_today, "late": late[:8], "late_count": len(late),
		"owed": flt(owed[0]), "owed_old": flt(owed[1]), "in_funds": in_funds,
		"boxes_pending": [{"name": h["name"], "amount": flt(h["recorded"])} for h in boxes["pending"]],
		"decisions": decisions, "books": {"at": check.get("at"), "differences": check.get("differences")}}


# ---------------------------------------------------------------- first-login tour (per user, stored on the account)


def tour_pending(user=None):
	"""True until the user finished or skipped the tour; «later» hides it until the next day."""
	user = user or frappe.session.user
	if user in ("Guest", "Administrator"):
		return False
	v = frappe.db.get_default("atelier_tour", parent=user) or ""
	if v == "done":
		return False
	if v.startswith("later:"):
		return v[6:] < nowdate()
	return True


@frappe.whitelist(methods=["POST"])
def tour_mark(action="done"):
	"""done = finished or closed; later = ask again tomorrow; reset = show again (from the guide)."""
	user = frappe.session.user
	if user == "Guest":
		frappe.throw(_("سجّل الدخول أولًا"), frappe.PermissionError)
	value = {"done": "done", "later": "later:" + nowdate(), "reset": ""}.get(action)
	if value is None:
		frappe.throw(_("إجراء غير معروف"))
	frappe.db.set_default("atelier_tour", value, parent=user)
	return {"pending": tour_pending(user)}
