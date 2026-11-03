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
	_apply_customer_note(so)
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
		fields=["name", "atelier_column", "atelier_labels", "atelier_members", "atelier_checklist", "atelier_cover", "atelier_assignee", "atelier_due_time", "atelier_archived", "atelier_pos"])}
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
		checklist = _jl(e.get("atelier_checklist"))
		cards.append({
			"name": r.name, "title": r.atelier_subject or r.name, "customer": r.customer, "customer_name": r.customer_name,
			"column": r.column, "labels": labels, "members": members, "due": r.delivery_date, "due_time": str(e.atelier_due_time)[:5] if e.get("atelier_due_time") else None, "cover": r.atelier_cover, "pos": e.get("atelier_pos"),
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
		"color": c.get("color") or COLORS[0], **({"deliver": 1} if c.get("deliver") else {}), **({"limit": cint(c["limit"])} if cint(c.get("limit")) > 0 else {})} for c in cfg.get("columns") or []]
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
	for m in production._team():
		if "@" + m["name"] in text:
			notify(m["name"], name, _("{0} ذكرك: «{1}»").format(frappe.utils.get_fullname(frappe.session.user), text[:80]))
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


# ---------------------------------------------------------------- board extras: archive, copy, order, checklist templates, notifications
EXTRA_FIELDS = [
	{"fieldname": "atelier_archived", "label": "مؤرشفة", "fieldtype": "Check", "insert_after": "atelier_due_time"},
	{"fieldname": "atelier_pos", "label": "الترتيب في العمود", "fieldtype": "Float", "insert_after": "atelier_archived"},
]


def extra_fields():
	from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

	create_custom_fields({"Sales Order": [{**f, "module": "Atelier"} for f in EXTRA_FIELDS]})


def _so_write(name):
	so = frappe.get_doc("Sales Order", name)
	so.check_permission("write")
	return so


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
def archived_cards():
	return frappe.get_list("Sales Order", filters={"atelier_archived": 1, "docstatus": ["<", 2]},
		fields=["name", "atelier_subject as title", "customer_name", "modified"], order_by="modified desc", limit=200)


@frappe.whitelist(methods=["POST"])
def copy_card(name):
	"""Same customer, title, description, checklist (unticked), labels, members and files; a fresh order with no price."""
	src = frappe.get_doc("Sales Order", name)
	src.check_permission("read")
	cfg = get_config()
	col = _column_for(src, cfg)
	if col == _deliver_col(cfg):
		col = cfg["columns"][0]["id"]
	res = quick_order(json.dumps({"customer": src.customer, "what": f"{src.atelier_subject or src.name} (نسخة)", "price": None,
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


# checklist templates
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


def notify(member, name, text):
	user = _user_of(member)
	if not user or user == frappe.session.user:
		return
	frappe.get_doc({"doctype": "Notification Log", "for_user": user, "from_user": frappe.session.user, "type": "Alert",
		"subject": text[:140], "document_type": "Sales Order", "document_name": name}).db_insert()  # no email: in-app only


@frappe.whitelist()
def notifications():
	logs = frappe.get_all("Notification Log", filters={"for_user": frappe.session.user, "document_type": "Sales Order"},
		fields=["name", "subject", "document_name", "from_user", "read", "creation"], order_by="creation desc", limit=20)
	for l in logs:
		l.by = frappe.utils.get_fullname(l.from_user)
	due = []
	me = _member_of(frappe.session.user) or frappe.utils.get_fullname(frappe.session.user)
	for c in board2()["cards"]:
		if me in c["members"] and c["due"] and flt(c["per_delivered"]) < 100:
			days = (frappe.utils.getdate(c["due"]) - frappe.utils.getdate(nowdate())).days
			if days <= 1:
				due.append({"name": c["name"], "title": c["title"], "due": str(c["due"]), "due_time": c.get("due_time"), "late": days < 0, "days": days})
	return {"logs": logs, "due": due, "unread": sum(1 for l in logs if not l.read) + len(due)}


@frappe.whitelist(methods=["POST"])
def mark_read():
	frappe.db.sql("update `tabNotification Log` set `read`=1 where for_user=%s and document_type='Sales Order'", frappe.session.user)
	return True


def demo_extras():
	frappe.set_user("Administrator")
	extra_fields()
	if not _templates():
		frappe.db.set_default("atelier_checklists", json.dumps([
			{"title": "بطاقات زيارة", "items": ["تصميم", "موافقة العميل", "طباعة", "قص", "تغليف"]},
			{"title": "لافتة", "items": ["أخذ المقاسات", "تصميم", "موافقة العميل", "طباعة", "تركيب الإطار", "تركيب عند العميل"]},
			{"title": "ملصقات", "items": ["تصميم", "موافقة العميل", "طباعة", "قص"]},
		], ensure_ascii=False))
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
	for r in rows:
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
	res = api.customer(name)
	doc = frappe.db.get_value("Customer", name, ["atelier_note", "atelier_vip", "customer_name"], as_dict=True)
	res["note"] = doc.atelier_note or ""
	res["vip"] = cint(doc.atelier_vip)
	orders = [o.name for o in res.get("orders") or []] or [""]
	extra = {r.name: r for r in frappe.get_all("Sales Order", filters={"name": ["in", orders]}, fields=["name", "atelier_cover", "atelier_column", "atelier_archived"])}
	cfg = get_config()
	for o in res.get("orders") or []:
		e = extra.get(o.name) or frappe._dict()
		o.cover, o.atelier_column, o.archived = e.atelier_cover, e.atelier_column, cint(e.atelier_archived)
		o.column = next((c["name"] for c in cfg["columns"] if c["id"] == _column_for(o, cfg)), "")
	files = frappe.db.sql(
		"""select f.name, f.file_name, f.file_url, f.creation, f.attached_to_doctype, f.attached_to_name, so.atelier_subject
		from `tabFile` f left join `tabSales Order` so on f.attached_to_doctype='Sales Order' and so.name=f.attached_to_name
		where (f.attached_to_doctype='Customer' and f.attached_to_name=%s) or (f.attached_to_doctype='Sales Order' and so.customer=%s)
		order by f.creation desc limit 100""", (name, name), as_dict=True)
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

	def inout(a, b):
		return (one("select sum(debit) from `tabGL Entry` where is_cancelled=0 and posting_date between %s and %s and account in %s", a, b, cash),
			one("select sum(credit) from `tabGL Entry` where is_cancelled=0 and posting_date between %s and %s and account in %s", a, b, cash))

	income, expenses = inout(start, end)
	pin, pout = inout(pstart, pend)
	balances = {a.name: one("select sum(debit - credit) from `tabGL Entry` where is_cancelled=0 and account=%s", a.name) for a in accs}
	# the French chart has many cash/bank accounts: show only the ones in use, plus the company defaults
	used = {r[0] for r in frappe.db.sql("select distinct account from `tabGL Entry` where is_cancelled=0 and account in %s", [cash])}
	defaults = set(frappe.get_cached_value("Company", company, ["default_cash_account", "default_bank_account"]) or [])
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
	for m in moves:
		m.title = _title(m)
		m.by = frappe.utils.get_fullname(m.owner)
		m.category, m.order, m.order_title = _move_meta(m)
		m.files = frappe.db.count("File", {"attached_to_doctype": m.voucher_type, "attached_to_name": m.voucher_no})
		m.fund = next((a.account_name for a in accs if a.name == m.account), "")
	cats = frappe.db.sql(
		"""select acc.account_name name, sum(gle.debit - gle.credit) amount from `tabGL Entry` gle join `tabAccount` acc on acc.name=gle.account
		where gle.is_cancelled=0 and gle.company=%s and acc.root_type='Expense' and gle.posting_date between %s and %s
		group by acc.account_name having amount > 0 order by amount desc limit 8""", (company, start, end), as_dict=True)
	debtors = frappe.db.sql(
		"""select si.customer, si.customer_name, sum(si.outstanding_amount) amount,
		max(case when si.due_date < curdate() then datediff(curdate(), si.due_date) else 0 end) late, c.mobile_no
		from `tabSales Invoice` si left join `tabCustomer` c on c.name=si.customer
		where si.docstatus=1 and si.company=%s and si.outstanding_amount > 0.005 group by si.customer order by late desc, amount desc""", company, as_dict=True)
	payables = frappe.db.sql(
		"""select pi.name, pi.supplier, pi.supplier_name, pi.outstanding_amount amount, pi.due_date,
		(select pii.description from `tabPurchase Invoice Item` pii where pii.parent=pi.name limit 1) what
		from `tabPurchase Invoice` pi where pi.docstatus=1 and pi.company=%s and pi.outstanding_amount > 0.005 order by pi.due_date asc""", company, as_dict=True)
	return {
		"month": str(start), "offset": cint(offset),
		"funds": [{"name": a.name, "label": a.account_name, "type": a.account_type, "balance": balances[a.name]} for a in shown],
		"cash_balance": sum(balances.values()),
		"income": income, "expenses": expenses, "profit": income - expenses, "prev_income": pin, "prev_expenses": pout,
		"payers": cint(one("""select count(distinct party) from `tabPayment Entry` where docstatus=1 and payment_type='Receive'
			and party_type='Customer' and posting_date between %s and %s""", start, end)),
		"weeks": weeks, "moves": moves, "categories": cats, "debtors": debtors, "payables": payables,
		"modes": [{"value": v, "label": l} for v, l in api.MODES if frappe.db.exists("Mode of Payment", v)],
	}


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
		acc = frappe.db.sql("""select acc.account_name, jea.project from `tabJournal Entry Account` jea join `tabAccount` acc on acc.name=jea.account
			where jea.parent=%s and acc.root_type in ('Expense','Asset') and acc.account_type not in ('Cash','Bank') limit 1""", m.voucher_no, as_dict=True)
		if not acc:
			return _("تحويل بين الصناديق"), None, None
		order = frappe.db.get_value("Sales Order", {"project": acc[0].project}, "name") if acc[0].project else None
		return acc[0].account_name, order, frappe.db.get_value("Sales Order", order, "atelier_subject") if order else None
	return m.voucher_type, None, None


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
	je = frappe.get_doc({"doctype": "Journal Entry", "voucher_type": "Contra Entry", "company": company, "posting_date": nowdate(),
		"user_remark": (note or _("تحويل بين الصناديق"))[:140],
		"accounts": [{"account": to_account, "debit_in_account_currency": amount}, {"account": from_account, "credit_in_account_currency": amount}]})
	je.insert()
	je.submit()
	return je.name


@frappe.whitelist(methods=["POST"])
def pay_supplier(invoice, mode_of_payment="Cash"):
	"""Pay what is left on a supplier invoice."""
	from erpnext.accounts.doctype.payment_entry.payment_entry import get_payment_entry

	if not frappe.has_permission("Payment Entry", "create"):
		frappe.throw(_("ليست لديك صلاحية لهذا الإجراء."), frappe.PermissionError)
	pe = get_payment_entry("Purchase Invoice", invoice, bank_account=api._cash_account(mode_of_payment, api._company()))
	pe.mode_of_payment = mode_of_payment
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
	})
	return name


@frappe.whitelist()
def customer_credit(name):
	"""For the new-order form: is this customer over their credit limit?"""
	limit = flt(frappe.db.get_value("Customer", name, "atelier_credit_limit"))
	owes = flt(frappe.db.sql("select sum(outstanding_amount) from `tabSales Invoice` where customer=%s and docstatus=1", name)[0][0]) if api._can("Sales Invoice") else 0
	return {"limit": limit, "owes": owes, "over": bool(limit) and owes > limit}


@frappe.whitelist(methods=["POST"])
def add_customer_log(name, kind, text):
	doc = frappe.get_doc("Customer", name)
	doc.check_permission("read")
	text = (text or "").strip()
	if not text:
		frappe.throw(_("اكتب ما حدث"))
	icon = {"call": "📞", "whatsapp": "💬", "visit": "🤝", "promise": "🗓"}.get(kind, "📝")
	doc.add_comment("Comment", icon + " " + frappe.utils.escape_html(text)[:2000])
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
		"disabled": cint(c.get("disabled")), "log": log, "months": months, "top": top, "customer_tags": customer_tags()}


def demo_customers_2():
	frappe.set_user("Administrator")
	customer_fields_2()
	frappe.db.commit()
