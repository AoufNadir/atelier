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
