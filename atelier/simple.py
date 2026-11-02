"""The simple workshop: an order board (new → in work → ready → delivered), a one-form order, customers and money.

Every screen still writes real ERPNext documents (Sales Order, Delivery Note, Sales Invoice, Payment Entry),
but the person using it never handles them: moving a card to «سُلّم» delivers and invoices in one step.
"""

import json

import frappe
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


@frappe.whitelist(methods=["POST"])
def quick_order(data):
	"""One short form: customer, what, price, advance, due date, who works on it, tags."""
	d = frappe.parse_json(data)
	what = (d.get("what") or "").strip()
	price = d.get("price")
	res = api.create_order(json.dumps({
		"customer": d.get("customer"), "new_customer": d.get("new_customer") or {},
		"subject": what, "delivery_date": d.get("delivery_date"), "no_steps": 1,
		"items": [{"item_code": _general_item(), "qty": 1, "description": what,
			"rate": None if price in (None, "") else flt(price)}] if what else [],
		"advance": {"amount": flt(d.get("advance")), "mode_of_payment": d.get("mode") or "Cash"},
	}, ensure_ascii=False))
	so = res["sales_order"]
	if d.get("assignee"):
		frappe.db.set_value("Sales Order", so, "atelier_assignee", d["assignee"].strip()[:80])
	if d.get("tags"):
		production.set_tags(so, json.dumps(d["tags"], ensure_ascii=False))
	return res


@frappe.whitelist(methods=["POST"])
def move(name, column):
	"""Drag a card. «سُلّم» = delivery note + invoice (advances deducted), so nobody handles paperwork."""
	if column not in COLUMNS:
		frappe.throw(_("عمود غير معروف"))
	so = frappe.get_doc("Sales Order", name)
	so.check_permission("write")
	if column_of(so.atelier_stage, so.per_delivered) == "done":
		frappe.throw(_("هذا الطلب سُلّم ولا يمكن إرجاعه"))
	if column == "done":
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
		rates = {r.name: flt(price) / max(flt(r.qty), 1) for r in so.items}
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

	cash_in = one("select sum(debit) from `tabGL Entry` where is_cancelled=0 and posting_date between %s and %s and account in %s", start, end, cash)
	cash_out = one("select sum(credit) from `tabGL Entry` where is_cancelled=0 and posting_date between %s and %s and account in %s", start, end, cash)
	moves = frappe.db.sql(
		"""select gle.voucher_type, gle.voucher_no, gle.posting_date, sum(gle.debit - gle.credit) amount,
		max(gle.remarks) remarks, max(gle.owner) owner
		from `tabGL Entry` gle where gle.is_cancelled=0 and gle.account in %s
		group by gle.voucher_type, gle.voucher_no, gle.posting_date order by gle.posting_date desc, max(gle.creation) desc limit 25""",
		[cash], as_dict=True)
	for m in moves:
		m.title = _title(m)
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
		{"id": "c-work", "name": "في العمل", "color": "#F59E0B"},
		{"id": "c-ready", "name": "جاهز", "color": "#2563EB"},
		{"id": "c-done", "name": "سُلّم", "color": "#22A06B", "deliver": 1},
	],
	"labels": [
		{"id": "l-wait", "name": "En attente", "color": "#F5D547"},
		{"id": "l-cours", "name": "En cours", "color": "#F59E0B"},
		{"id": "l-valid", "name": "En validation", "color": "#22A06B"},
		{"id": "l-done", "name": "Terminé", "color": "#2563EB"},
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


def get_config():
	try:
		cfg = json.loads(frappe.db.get_default("atelier_board") or "null")
	except ValueError:
		cfg = None
	return cfg or json.loads(json.dumps(DEFAULT_CONFIG))


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
	names = [r.name for r in rows] or [""]
	extra = {r.name: r for r in frappe.get_all("Sales Order", filters={"name": ["in", names]},
		fields=["name", "atelier_column", "atelier_labels", "atelier_members", "atelier_checklist", "atelier_cover", "atelier_assignee", "atelier_due_time"])}
	comments = dict(frappe.db.sql("""select reference_name, count(*) from `tabComment` where reference_doctype='Sales Order'
		and comment_type='Comment' and reference_name in %s group by reference_name""", [names]))
	files = dict(frappe.db.sql("""select attached_to_name, count(*) from `tabFile` where attached_to_doctype='Sales Order'
		and attached_to_name in %s group by attached_to_name""", [names]))
	since = add_days(nowdate(), -21)
	deliver = _deliver_col(cfg)
	cards = []
	for r in rows:
		e = extra.get(r.name) or frappe._dict()
		r.update({k: e.get(k) for k in ("atelier_column", "atelier_cover")})
		r.column = _column_for(r, cfg)
		if r.column == deliver and str(r.transaction_date) < since and r.paid >= flt(r.grand_total) - 0.005:
			continue
		labels = _jl(e.get("atelier_labels"))
		if not e.get("atelier_labels"):  # before the board: tags become labels
			labels = [label_by_name[t] for t in r.tags if t in label_by_name]
		members = _jl(e.get("atelier_members")) or ([e.atelier_assignee] if e.get("atelier_assignee") else [])
		checklist = _jl(e.get("atelier_checklist"))
		cards.append({
			"name": r.name, "title": r.atelier_subject or r.name, "customer": r.customer, "customer_name": r.customer_name,
			"column": r.column, "labels": labels, "members": members, "due": r.delivery_date, "due_time": str(e.atelier_due_time)[:5] if e.get("atelier_due_time") else None, "cover": r.atelier_cover,
			"grand_total": r.grand_total, "paid": r.paid, "price_pending": r.price_pending, "docstatus": r.docstatus,
			"per_delivered": r.per_delivered, "comments": comments.get(r.name, 0), "files": files.get(r.name, 0),
			"check": [sum(1 for c in checklist if c.get("done")), len(checklist)],
		})
	return {"config": cfg, "cards": cards, "manager": _is_manager()}


@frappe.whitelist(methods=["POST"])
def save_board(config, moves=None):
	"""Columns and labels of the board. moves = {deleted column id: column id} for the cards of a removed column."""
	if not _is_manager():
		frappe.throw(_("التخصيص للمدير فقط"), frappe.PermissionError)
	cfg = frappe.parse_json(config)
	old = get_config()
	cols = [{"id": (c.get("id") or frappe.generate_hash(length=8)), "name": (c.get("name") or "").strip()[:60],
		"color": c.get("color") or COLORS[0], **({"deliver": 1} if c.get("deliver") else {})} for c in cfg.get("columns") or []]
	labels = [{"id": (l.get("id") or frappe.generate_hash(length=8)), "name": (l.get("name") or "").strip()[:60], "color": l.get("color") or COLORS[0]}
		for l in cfg.get("labels") or []]
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
	new = {"columns": cols, "labels": labels}
	frappe.db.set_default("atelier_board", json.dumps(new, ensure_ascii=False))
	return new


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
	return {
		"name": name, "title": so.atelier_subject or name, "customer": so.customer, "customer_name": so.customer_name,
		"column": _column_for(so, cfg), "labels": labels,
		"members": _jl(so.get("atelier_members")) or ([so.atelier_assignee] if so.get("atelier_assignee") else []),
		"due": so.delivery_date, "due_time": str(so.atelier_due_time)[:5] if so.get("atelier_due_time") else None,
		"description": so.get("atelier_description") or "", "checklist": _jl(so.get("atelier_checklist")),
		"client": _client(so.customer),
		"cover": so.get("atelier_cover"), "files": files, "activity": activity,
		"grand_total": row.grand_total, "paid": row.paid, "price_pending": row.price_pending, "docstatus": so.docstatus,
		"per_delivered": so.per_delivered, "can_edit": bool(frappe.has_permission("Sales Order", "write", so)),
		"money": api._can("GL Entry"),
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
	if "labels" in ch:
		ids = {l["id"] for l in cfg["labels"]}
		so.db_set("atelier_labels", json.dumps([x for x in ch["labels"] if x in ids]))
	if "members" in ch:
		members = [m for m in ch["members"] if m][:10]
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
	if "due_time" in ch:
		so.db_set("atelier_due_time", ch["due_time"] or None)
	if "due" in ch and ch["due"]:
		if so.docstatus == 1:
			frappe.db.sql("update `tabSales Order` set delivery_date=%s where name=%s", (ch["due"], name))
			frappe.db.sql("update `tabSales Order Item` set delivery_date=%s where parent=%s", (ch["due"], name))
		else:
			so.delivery_date = ch["due"]
			for i in so.items:
				i.delivery_date = ch["due"]
			so.save()
		_log(name, _("غيّر الموعد إلى {0}").format(ch["due"]))
	if ch.get("customer") and so.docstatus == 0 and ch["customer"] != so.customer:
		so.customer = ch["customer"]
		so.save()
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
