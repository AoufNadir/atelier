"""API for the daily app (/atelier). Every read goes through frappe.get_list / permission checks,
every write creates standard ERPNext documents (no parallel accounting)."""

import json

import frappe
from frappe import _
from frappe.utils import add_days, cint, flt, get_first_day, get_last_day, getdate, nowdate

from atelier import production
# Production-step endpoints live in production.py and are exposed under atelier.api like the rest.
from atelier.production import save_steps, save_team, set_service_steps, set_tags, step_action, step_order_supplier, step_supplier_invoice, team  # noqa: F401

MODES = [("Cash", "كاش"), ("BaridiMob", "بريدي موب"), ("CCP", "CCP"), ("Wire Transfer", "تحويل بنكي"), ("Cheque", "صك")]
STAGES = ["جديد", "تصميم", "بانتظار موافقة العميل", "طباعة", "تشطيب", "جاهز للتسليم", "سُلّم"]


def _company():
	return frappe.defaults.get_user_default("Company") or frappe.db.get_single_value("Global Defaults", "default_company")


def _can(doctype, ptype="read"):
	return frappe.has_permission(doctype, ptype)


def _no_worker():
	from atelier.simple import no_worker

	no_worker()


# Two selling price lists: individuals and companies. A customer's type picks its list (Customer.default_price_list),
# so quotations, orders, delivery notes and invoices all carry the right list natively.
PRICE_LISTS = {"Individual": "سعر الأفراد", "Company": "سعر المؤسسات"}


def _price_list(customer_type):
	name = PRICE_LISTS["Company" if customer_type == "Company" else "Individual"]
	if not frappe.db.exists("Price List", name):
		frappe.get_doc({"doctype": "Price List", "price_list_name": name, "selling": 1, "enabled": 1,
			"currency": frappe.db.get_value("Company", _company(), "default_currency")}).insert(ignore_permissions=True)
	return name


def _item_prices(item_codes=None):
	"""{item_code: {"Individual": rate, "Company": rate}} from Item Price; a missing price stays absent."""
	lists = {_price_list(k): k for k in PRICE_LISTS}
	filters = {"price_list": ["in", list(lists)], "selling": 1}
	if item_codes is not None:
		filters["item_code"] = ["in", item_codes or [""]]
	out = {}
	for r in frappe.get_all("Item Price", filters=filters, fields=["item_code", "price_list", "price_list_rate"]):
		out.setdefault(r.item_code, {})[lists[r.price_list]] = flt(r.price_list_rate)
	return out


def _with_prices(items):
	prices = _item_prices([i.item_code for i in items])
	for i in items:
		i.price_individual = prices.get(i.item_code, {}).get("Individual")
		i.price_company = prices.get(i.item_code, {}).get("Company")
	return items


@frappe.whitelist()
def boot():
	from atelier.simple import WORKERS, app_role

	company = _company()
	role = app_role()
	worker = role in WORKERS
	items = frappe.get_list(
		"Item",
		filters={"disabled": 0, "is_sales_item": 1},
		fields=["item_code", "item_name", "stock_uom", "is_stock_item", "standard_rate"],
		order_by="item_name asc",
		limit=500,
	)
	return {
		"user": frappe.session.user,
		"full_name": frappe.utils.get_fullname(frappe.session.user),
		"company": company,
		"company_label": (frappe.db.get_value("Company", company, "company_name") or company or "").replace("Atelier Démo تجريبي", "مطبعة الرؤية"),
		"currency": frappe.db.get_value("Company", company, "default_currency"),
		"is_demo": "DÉMO" in (company or "") or "تجريبي" in (company or ""),
		"items": _with_prices(items),
		"stages": STAGES,
		"units": simple_units(),
		"lists": simple_lists(),
		**production.boot_info(),
		"modes": [{"value": v, "label": l} for v, l in all_modes() if frappe.db.exists("Mode of Payment", v)],
		"can": {
			"order": _can("Sales Order", "create") and not worker,
			"customer": _can("Customer", "create") and not worker,
			"prices": _can("Item Price", "write"),
			"payment": (_can("Payment Entry", "create") or role == "sales") and not worker,
			"expense": _can("Journal Entry", "create"),
			"finance": _can("GL Entry", "read"),
			"cost": _can("Cost Estimate", "read"),
			"stock": _can("Bin", "read") and role != "designer",
		},
		"role": role, "worker": worker,
	}


# ---------------------------------------------------------------- home


@frappe.whitelist()
def home():
	today = getdate(nowdate())
	soon = add_days(today, 3)
	actions = []

	def add(kind, priority, title, detail, route, doc=None):
		actions.append({"kind": kind, "priority": priority, "title": title, "detail": detail, "route": route, "doc": doc})

	if _can("Sales Order"):
		for so in frappe.get_list(
			"Sales Order",
			filters={"docstatus": ["<", 2], "per_delivered": ["<", 100], "status": ["not in", ["Closed", "Completed"]],
				"delivery_date": ["<=", soon]},
			fields=["name", "customer_name", "atelier_subject", "delivery_date", "atelier_stage"],
			order_by="delivery_date asc", limit=20,
		):
			late = getdate(so.delivery_date) < today
			add("late" if late else "due", 0 if late else 1,
				_("متأخر: {0}") .format(so.atelier_subject or so.name) if late else _("تسليم قريب: {0}").format(so.atelier_subject or so.name),
				f"{so.customer_name} · {so.atelier_stage or ''}", f"/orders/{so.name}", so)

		pending = frappe.get_list(
			"Sales Order",
			filters=[["docstatus", "<", 2], ["Sales Order Item", "atelier_price_pending", "=", 1]],
			fields=["name", "customer_name", "atelier_subject"], distinct=True, limit=20,
		)
		for so in pending:
			add("price", 1, _("بانتظار التسعير: {0}").format(so.atelier_subject or so.name), so.customer_name, f"/orders/{so.name}", so)

		for so in frappe.get_list(
			"Sales Order",
			filters={"docstatus": 1, "per_delivered": 100, "per_billed": ["<", 100], "status": ["!=", "Closed"]},
			fields=["name", "customer_name", "atelier_subject"], limit=20,
		):
			add("invoice", 2, _("سُلّم ولم يُفوتر: {0}").format(so.atelier_subject or so.name), so.customer_name, f"/orders/{so.name}", so)

	if _can("Sales Invoice"):
		for si in frappe.get_list(
			"Sales Invoice",
			filters={"docstatus": 1, "outstanding_amount": [">", 0], "due_date": ["<", today]},
			fields=["name", "customer", "customer_name", "outstanding_amount", "due_date"], limit=20,
		):
			add("overdue", 2, _("فاتورة مستحقة: {0}").format(si.customer_name),
				_("{0} يومًا · {1}").format((today - getdate(si.due_date)).days, si.name),
				f"/customers/{si.customer}", {"amount": si.outstanding_amount})

	if _can("Purchase Invoice"):
		for pi in frappe.get_list(
			"Purchase Invoice",
			filters={"docstatus": 1, "outstanding_amount": [">", 0], "due_date": ["<=", add_days(today, 7)]},
			fields=["name", "supplier_name", "outstanding_amount", "due_date"], limit=20,
		):
			add("supplier", 3, _("دفعة لمورد: {0}").format(pi.supplier_name), pi.name, f"/desk/purchase-invoice/{pi.name}",
				{"amount": pi.outstanding_amount})

	if _can("Bin"):
		for b in frappe.db.sql(
			"""select bin.item_code, item.item_name, sum(bin.actual_qty) qty, item.safety_stock, item.stock_uom
			from `tabBin` bin join `tabItem` item on item.name = bin.item_code
			where item.safety_stock > 0 group by bin.item_code having qty < item.safety_stock""",
			as_dict=True,
		):
			add("stock", 3, _("مخزون منخفض: {0}").format(b.item_name),
				_("المتبقي {0} {1} · الحد {2}").format(flt(b.qty), b.stock_uom, flt(b.safety_stock)),
				f"/desk/item/{b.item_code}", {"qty": b.qty})

	actions.sort(key=lambda a: a["priority"])
	return {"actions": actions, "money": _money() if _can("GL Entry") else None, "orders": _recent_orders(), "date": str(today)}


def _money():
	company = _company()
	start, end = get_first_day(nowdate()), get_last_day(nowdate())

	def gl(sql, *args):
		return flt(frappe.db.sql(sql, args)[0][0])

	cash_accounts = "select name from `tabAccount` where company=%s and account_type in ('Cash','Bank') and is_group=0"
	pl = frappe.db.sql(
		"""select acc.root_type, sum(gle.credit - gle.debit) from `tabGL Entry` gle
		join `tabAccount` acc on acc.name = gle.account
		where gle.company=%s and gle.is_cancelled=0 and gle.posting_date between %s and %s
		and acc.root_type in ('Income','Expense') group by acc.root_type""",
		(company, start, end),
	)
	pl = {r[0]: flt(r[1]) for r in pl}
	return {
		"period": {"from": str(start), "to": str(end)},
		"sales": gl("""select sum(base_net_total) from `tabSales Invoice` where company=%s and docstatus=1
			and posting_date between %s and %s""", company, start, end),
		"cash_in": gl(f"""select sum(debit) from `tabGL Entry` where company=%s and is_cancelled=0 and is_opening='No'
			and posting_date between %s and %s and account in ({cash_accounts})""", company, start, end, company),
		"cash_out": gl(f"""select sum(credit) from `tabGL Entry` where company=%s and is_cancelled=0 and is_opening='No'
			and posting_date between %s and %s and account in ({cash_accounts})""", company, start, end, company),
		"cash_balance": gl(f"""select sum(debit - credit) from `tabGL Entry` where company=%s and is_cancelled=0
			and account in ({cash_accounts})""", company, company),
		"receivable": gl("select sum(outstanding_amount) from `tabSales Invoice` where company=%s and docstatus=1", company),
		"receivable_overdue": gl("""select sum(outstanding_amount) from `tabSales Invoice` where company=%s and docstatus=1
			and due_date < %s""", company, nowdate()),
		"payable_due": gl("""select sum(outstanding_amount) from `tabPurchase Invoice` where company=%s and docstatus=1
			and due_date <= %s""", company, nowdate()),
		"advances_held": gl("""select sum(unallocated_amount) from `tabPayment Entry` where company=%s and docstatus=1
			and payment_type='Receive' and party_type='Customer'""", company)
			+ gl("""select sum(advance_paid) from `tabSales Order` where company=%s and docstatus=1 and per_billed=0""", company),
		"payable": gl("select sum(outstanding_amount) from `tabPurchase Invoice` where company=%s and docstatus=1", company),
		"result": pl.get("Income", 0) + pl.get("Expense", 0),
	}


def _order_rows(filters, limit=8):
	rows = frappe.get_list(
		"Sales Order",
		filters=filters,
		fields=["name", "customer", "customer_name", "atelier_subject", "atelier_stage", "transaction_date",
			"delivery_date", "grand_total", "per_billed", "per_delivered", "advance_paid", "docstatus", "status", "owner", "project", "_user_tags"],
		order_by="creation desc", limit=limit,
	)
	if not rows:
		return rows
	names = [r.name for r in rows]
	pending = set(frappe.get_all("Sales Order Item", {"parent": ["in", names], "atelier_price_pending": 1}, pluck="parent"))
	paid_on_invoices = dict(frappe.db.sql(
		"""select sii.sales_order, sum(si.grand_total - si.outstanding_amount) from `tabSales Invoice` si
		join (select distinct parent, sales_order from `tabSales Invoice Item`) sii on sii.parent = si.name
		where si.docstatus=1 and sii.sales_order in %s group by sii.sales_order""", [names]))
	names_cache = {}
	steps = production.current_steps([r.project for r in rows if r.project])
	for r in rows:
		r.tags = [x for x in (r.pop("_user_tags", None) or "").split(",") if x]
		r.step = steps.get(r.project)
		r.owner_name = names_cache.setdefault(r.owner, frappe.utils.get_fullname(r.owner))
		r.price_pending = r.name in pending
		r.paid = max(flt(r.advance_paid), flt(paid_on_invoices.get(r.name)))
	return rows


def _recent_orders():
	if not _can("Sales Order"):
		return []
	return _order_rows({"docstatus": ["<", 2], "status": ["not in", ["Closed", "Completed"]]}, limit=12)


@frappe.whitelist()
def orders(include_closed=0):
	_no_worker()
	"""Order list for the orders page; filtering/sorting happens client-side on this set."""
	filters = {"docstatus": ["<", 2]}
	if not cint(include_closed):
		filters["status"] = ["not in", ["Closed", "Completed"]]
	return _order_rows(filters, limit=300)


# ---------------------------------------------------------------- search


@frappe.whitelist()
def search(q):
	_no_worker()
	q = (q or "").strip()
	if len(q) < 2:
		return []
	like = f"%{q}%"
	out = [
		{"type": "customer", "title": c.customer_name, "detail": c.mobile_no or "", "route": f"/customers/{c.name}"}
		for c in frappe.get_list("Customer", or_filters={"customer_name": ["like", like], "mobile_no": ["like", like], "name": ["like", like]},
			fields=["name", "customer_name", "mobile_no"], limit=6)
	]
	if _can("Sales Order"):
		out += [
			{"type": "order", "title": s.atelier_subject or s.name, "detail": f"{s.name} · {s.customer_name}", "route": f"/orders/{s.name}"}
			for s in frappe.get_list("Sales Order", or_filters={"name": ["like", like], "atelier_subject": ["like", like], "customer_name": ["like", like]},
				fields=["name", "atelier_subject", "customer_name"], limit=6)
		]
	return out


# ---------------------------------------------------------------- customer


# Relation is ERPNext's own Customer Group, so price lists and sales reports by group work as-is.
RELATIONS = {"final": "عميل نهائي", "subcontract": "مناولة"}


def _group(relation):
	name = RELATIONS.get(relation, RELATIONS["final"])
	if not frappe.db.exists("Customer Group", name):
		root = frappe.db.get_value("Customer Group", {"is_group": 1, "parent_customer_group": ["in", ["", None]]}) or "All Customer Groups"
		frappe.get_doc({"doctype": "Customer Group", "customer_group_name": name, "parent_customer_group": root, "is_group": 0}).insert(ignore_permissions=True)
	return name


def _relation(group):
	return "subcontract" if group == RELATIONS["subcontract"] else "final"


_AR_FOLD = str.maketrans({"أ": "ا", "إ": "ا", "آ": "ا", "ة": "ه", "ى": "ي", "ؤ": "و", "ئ": "ي", "ـ": None})


def _fold(text):
	"""Arabic spelling variants and diacritics compare equal: أحمد = احمد, فاطمة = فاطمه."""
	text = "".join(c for c in (text or "").lower() if not "\u064b" <= c <= "\u0652")
	return text.translate(_AR_FOLD)


def _rank_customers(q, rows, limit=50):
	"""Names starting with the text first, then a word start, then anywhere, then the phone."""
	needle, ranked = _fold(q.strip()), []
	for row in rows:
		name = _fold(row.customer_name)
		if name.startswith(needle):
			rank = 0
		elif any(word.startswith(needle) for word in name.split()):
			rank = 1
		elif needle in name:
			rank = 2
		elif needle in (row.mobile_no or ""):
			rank = 3
		else:
			continue
		ranked.append((rank, name, row))
	ranked.sort(key=lambda entry: entry[:2])
	return [entry[2] for entry in ranked[:limit]]


@frappe.whitelist()
def customers(q=None, full=0, include_disabled=0):
	_no_worker()
	"""Picker search (q) or, with full=1, the customer list page with balances and order counts."""
	filters = {} if cint(include_disabled) else {"disabled": 0}
	if q and not cint(full):
		return _rank_customers(q, frappe.get_list("Customer", filters=filters, order_by="modified desc", limit=5000,
			fields=["name", "customer_name", "mobile_no", "customer_type", "email_id", "customer_group"]))
	or_filters = {"customer_name": ["like", f"%{q}%"], "mobile_no": ["like", f"%{q}%"]} if q else None
	rows = frappe.get_list("Customer", filters=filters, or_filters=or_filters,
		fields=["name", "customer_name", "mobile_no", "customer_type", "email_id", "customer_group"], order_by="modified desc",
		limit=500 if cint(full) else 20)
	if not cint(full) or not rows:
		return rows
	names = [r.name for r in rows]
	open_orders, last_order = {}, {}
	if _can("Sales Order"):
		for so in frappe.get_list("Sales Order", filters={"customer": ["in", names], "docstatus": ["<", 2], "atelier_archived": ["!=", 1]},
				fields=["customer", "status", "transaction_date"], limit=5000):
			if so.status not in ("Closed", "Completed"):
				open_orders[so.customer] = open_orders.get(so.customer, 0) + 1
			if not last_order.get(so.customer) or str(so.transaction_date) > last_order[so.customer]:
				last_order[so.customer] = str(so.transaction_date)
	balances = None
	if _can("GL Entry"):
		balances = dict(frappe.db.sql(
			"""select party, sum(debit - credit) from `tabGL Entry` where party_type='Customer' and is_cancelled=0
			and company=%s and party in %s group by party""", (_company(), names)))
	sales, overdue = {}, {}
	if _can("Sales Invoice"):
		for si in frappe.db.sql("""select customer, sum(grand_total) total,
				max(case when outstanding_amount > 0 and due_date < curdate() then datediff(curdate(), due_date) else 0 end) late
				from `tabSales Invoice` where docstatus=1 and customer in %s group by customer""", [names], as_dict=True):
			sales[si.customer], overdue[si.customer] = flt(si.total), int(si.late or 0)
	for r in rows:
		r.sales = sales.get(r.name, 0)
		r.overdue_days = overdue.get(r.name, 0)
		r.relation = _relation(r.customer_group)
		r.open_orders = open_orders.get(r.name, 0)
		r.last_order = last_order.get(r.name)
		r.balance = flt(balances.get(r.name)) if balances is not None else None
	return rows


def _primary(doctype, customer, field):
	name = frappe.db.get_value("Customer", customer, field)
	if name:
		return frappe.get_doc(doctype, name)
	linked = frappe.get_all("Dynamic Link", {"link_doctype": "Customer", "link_name": customer, "parenttype": doctype}, pluck="parent", limit=1)
	return frappe.get_doc(doctype, linked[0]) if linked else None


def _contact_person(doc):
	"""For a company, the primary contact's name when it differs from the company name."""
	if doc.customer_type != "Company" or not doc.customer_primary_contact:
		return ""
	full = " ".join(filter(None, frappe.db.get_value("Contact", doc.customer_primary_contact, ["first_name", "last_name"]) or []))
	return "" if full.strip() == doc.customer_name else full.strip()


def _address_parts(customer):
	addr = _primary("Address", customer, "customer_primary_address")
	return (addr.address_line1, addr.city if addr.city != "—" else "") if addr else ("", "")


@frappe.whitelist()
def customer_profile(name):
	doc = frappe.get_doc("Customer", name)
	doc.check_permission("read")
	address, city = _address_parts(name)
	return {"name": doc.name, "customer_name": doc.customer_name, "customer_type": doc.customer_type,
		"relation": _relation(doc.customer_group), "contact_person": _contact_person(doc),
		"mobile_no": doc.mobile_no or "", "email_id": doc.email_id or "", "tax_id": doc.tax_id or "",
		"address": address, "city": city, "notes": doc.customer_details or ""}


@frappe.whitelist(methods=["POST"])
def save_customer(data):
	"""Create or edit a customer. Phone/email live on the primary Contact, the address on the primary Address,
	as in ERPNext itself, so Desk, print formats and documents stay consistent."""
	data = frappe.parse_json(data)
	errors = {}
	if not (data.get("customer_name") or "").strip():
		errors["customer_name"] = _("اكتب اسم العميل")
	email = (data.get("email_id") or "").strip()
	if email and not frappe.utils.validate_email_address(email):
		errors["email_id"] = _("البريد الإلكتروني غير صالح")
	if errors:
		frappe.local.response["errors"] = errors
		frappe.throw(_("راجع الحقول المشار إليها"), title=_("بيانات ناقصة"))
	phone = (data.get("mobile_no") or "").strip()
	if data.get("name"):
		doc = frappe.get_doc("Customer", data["name"])
		doc.check_permission("write")
	else:
		if not _can("Customer", "create"):
			frappe.throw(_("ليست لديك صلاحية لهذا الإجراء."), frappe.PermissionError)
		doc = frappe.new_doc("Customer")
	doc.customer_name = data["customer_name"].strip()
	doc.customer_type = "Company" if data.get("customer_type") == "Company" else "Individual"
	doc.default_price_list = _price_list(doc.customer_type)
	if doc.is_new() or data.get("relation"):
		doc.customer_group = _group(data.get("relation"))
	# Tax ID belongs to companies; an individual keeps none.
	doc.tax_id = ((data.get("tax_id") or "").strip() or None) if doc.customer_type == "Company" else None
	doc.customer_details = (data.get("notes") or "").strip() or None
	doc.save()

	contact = _primary("Contact", doc.name, "customer_primary_contact")
	person = (data.get("contact_person") or "").strip() if doc.customer_type == "Company" else ""
	if phone or email or contact or person:
		if not contact:
			contact = frappe.new_doc("Contact")
			contact.first_name = doc.customer_name
			contact.append("links", {"link_doctype": "Customer", "link_name": doc.name})
		contact.first_name, contact.last_name = person or doc.customer_name, None
		contact.phone_nos = [r for r in contact.phone_nos if not r.is_primary_mobile_no]
		if phone:
			contact.append("phone_nos", {"phone": phone, "is_primary_mobile_no": 1})
		contact.email_ids = [r for r in contact.email_ids if not r.is_primary]
		if email:
			contact.append("email_ids", {"email_id": email, "is_primary": 1})
		contact.save()
		doc.db_set({"customer_primary_contact": contact.name, "mobile_no": phone or None, "email_id": email or None})

	line = (data.get("address") or "").strip()
	addr = _primary("Address", doc.name, "customer_primary_address")
	if line or addr:
		if not addr:
			addr = frappe.new_doc("Address")
			addr.address_title = doc.customer_name
			addr.address_type = "Billing"
			addr.country = frappe.db.get_value("Company", _company(), "country") or "Algeria"
			addr.append("links", {"link_doctype": "Customer", "link_name": doc.name})
		addr.address_line1 = line or addr.address_line1
		addr.city = (data.get("city") or "").strip() or addr.city or "—"
		addr.save()
		doc.db_set("customer_primary_address", addr.name)
	return doc.name


@frappe.whitelist()
def customer(name):
	_no_worker()
	doc = frappe.get_doc("Customer", name)
	doc.check_permission("read")
	company = _company()
	res = {
		"name": doc.name, "customer_name": doc.customer_name, "mobile_no": doc.mobile_no, "email_id": doc.email_id,
		"customer_type": doc.customer_type, "tax_id": doc.tax_id, "notes": doc.customer_details,
		"relation": _relation(doc.customer_group), "contact_person": _contact_person(doc),
		"since": str(doc.creation)[:10],
		"last_payment": frappe.db.get_value("Payment Entry", {"party_type": "Customer", "party": name, "docstatus": 1, "payment_type": "Receive"}, "posting_date", order_by="posting_date desc"),
		"overdue_days": int(frappe.db.sql("""select coalesce(max(datediff(curdate(), due_date)), 0) from `tabSales Invoice`
			where customer=%s and docstatus=1 and outstanding_amount > 0 and due_date < curdate()""", name)[0][0] or 0),
		"can_edit": bool(frappe.has_permission("Customer", "write", doc)),
		**{k: v for k, v in zip(("address", "city"), _address_parts(name))},
		"orders": _order_rows({"customer": name, "docstatus": ["<", 2]}, limit=50) if _can("Sales Order") else [],
	}
	if _can("GL Entry"):
		from erpnext.accounts.utils import get_balance_on

		res["balance"] = flt(get_balance_on(party_type="Customer", party=name, company=company))
		res["outstanding"] = flt(frappe.db.sql(
			"select sum(outstanding_amount) from `tabSales Invoice` where customer=%s and docstatus=1", name)[0][0])
		res["invoiced"] = flt(frappe.db.sql(
			"select sum(grand_total) from `tabSales Invoice` where customer=%s and docstatus=1", name)[0][0])
		res["received"] = flt(frappe.db.sql(
			"""select sum(paid_amount) from `tabPayment Entry` where party_type='Customer' and party=%s
			and docstatus=1 and payment_type='Receive'""", name)[0][0])
		entries = frappe.get_list(
			"GL Entry",
			filters={"party_type": "Customer", "party": name, "is_cancelled": 0, "company": company},
			fields=["posting_date", "voucher_type", "voucher_no", "debit", "credit", "against_voucher", "remarks"],
			order_by="posting_date asc, creation asc", limit=500,
		)
		running = 0
		for e in entries:
			running += flt(e.debit) - flt(e.credit)
			e.balance = running
		res["ledger"] = list(reversed(entries))
	res["documents"] = _documents(name)
	res["files"] = _files(name, res)
	return res


def _documents(customer):
	docs = []
	for dt, date_field, amount in (
		("Quotation", "transaction_date", "grand_total"),
		("Sales Invoice", "posting_date", "grand_total"),
		("Delivery Note", "posting_date", "grand_total"),
		("Payment Entry", "posting_date", "paid_amount"),
	):
		if not _can(dt):
			continue
		party = {"Quotation": "party_name", "Payment Entry": "party"}.get(dt, "customer")
		for d in frappe.get_list(dt, filters={party: customer, "docstatus": ["<", 2]},
				fields=["name", f"{date_field} as date", f"{amount} as amount", "docstatus"], limit=50):
			d.doctype = dt
			docs.append(d)
	docs.sort(key=lambda d: str(d.date), reverse=True)
	return docs


def _files(customer, res):
	attached = [("Customer", customer)]
	attached += [("Sales Order", o.name) for o in res.get("orders", [])]
	attached += [(d.doctype, d.name) for d in res.get("documents", [])]
	if not attached:
		return []
	files = []
	by_dt = {}
	for dt, dn in attached:
		by_dt.setdefault(dt, []).append(dn)
	for dt, names in by_dt.items():
		files += frappe.get_list("File",
			filters={"attached_to_doctype": dt, "attached_to_name": ["in", names], "is_folder": 0},
			fields=["name", "file_name", "file_url", "file_size", "is_private", "attached_to_doctype", "attached_to_name", "creation"],
			order_by="creation desc", limit=200)
	files.sort(key=lambda f: str(f.creation), reverse=True)
	return files


# ---------------------------------------------------------------- order


@frappe.whitelist()
def order(name):
	_no_worker()
	so = frappe.get_doc("Sales Order", name)
	so.check_permission("read")
	row = _order_rows({"name": name}, limit=1)[0]
	row["items"] = [
		{"row": i.name, "item_code": i.item_code, "item_name": i.item_name, "description": i.description, "qty": i.qty, "uom": i.uom,
			"delivered_qty": i.delivered_qty,
			"rate": None if i.atelier_price_pending else i.rate, "amount": None if i.atelier_price_pending else i.amount}
		for i in so.items
	]
	row["project"] = so.project
	row["steps"] = production.steps_for_view(so.project)
	row["tags"] = [x for x in (so.get("_user_tags") or "").split(",") if x]
	img = frappe.get_all("File", {"attached_to_doctype": "Sales Order", "attached_to_name": name, "is_folder": 0},
		["file_url", "file_name"], order_by="creation desc")
	row["image"] = next((f.file_url for f in img if (f.file_name or "").lower().rsplit(".", 1)[-1] in ("png", "jpg", "jpeg", "webp", "gif")), None)
	row["docs"] = _order_docs(so)
	row["outstanding"] = sum(flt(d.get("outstanding_amount")) for d in row["docs"] if d["doctype"] == "Sales Invoice")
	row["print_format"] = PRINT_FORMAT
	row["can"] = {"edit": bool(so.has_permission("write")), "submit": bool(so.has_permission("submit")),
		"deliver": _can("Delivery Note", "create"), "invoice": _can("Sales Invoice", "create"), "payment": _can("Payment Entry", "create")}
	if _can("Cost Estimate"):
		row["estimate"] = frappe.get_all("Cost Estimate", {"sales_order": name},
			["name", "total_cost", "missing_count", "estimated_margin", "pricing_status"], limit=1)
	return row


@frappe.whitelist(methods=["POST"])
def set_stage(name, stage):
	if stage not in STAGES:
		frappe.throw(_("مرحلة غير معروفة"))
	so = frappe.get_doc("Sales Order", name)
	so.check_permission("write")
	so.db_set("atelier_stage", stage)  # allowed on submitted orders: execution stage is not accounting data
	return stage


@frappe.whitelist(methods=["POST"])
def create_order(data):
	"""Customer → (Project, Sales Order, Cost Estimate) → optional advance. One request, one transaction."""
	data = frappe.parse_json(data)
	company = _company()
	errors = {}

	customer = data.get("customer")
	new_customer = data.get("new_customer") or {}
	if not customer and not (new_customer.get("name") or "").strip():
		errors["customer"] = _("اختر عميلًا أو أدخل اسم عميل جديد")
	if not (data.get("subject") or "").strip():
		errors["subject"] = _("اكتب موضوع الطلب")
	if not data.get("delivery_date"):
		errors["delivery_date"] = _("حدد موعد التسليم")
	elif getdate(data["delivery_date"]) < getdate(nowdate()):
		errors["delivery_date"] = _("موعد التسليم في الماضي")
	items = [i for i in data.get("items") or [] if i.get("item_code")]
	if not items:
		errors["items"] = _("أضف بندًا واحدًا على الأقل")
	for idx, i in enumerate(items):
		if flt(i.get("qty")) <= 0:
			errors[f"items.{idx}.qty"] = _("الكمية يجب أن تكون أكبر من صفر")
		if i.get("rate") not in (None, "") and flt(i["rate"]) < 0:
			errors[f"items.{idx}.rate"] = _("السعر لا يكون سالبًا")
	advance = data.get("advance") or {}
	if flt(advance.get("amount")) < 0:
		errors["advance"] = _("مبلغ التسبيق لا يكون سالبًا")
	if flt(advance.get("amount")) > 0 and not advance.get("mode_of_payment"):
		errors["advance_mode"] = _("اختر طريقة الدفع")
	if errors:
		frappe.local.response["errors"] = errors
		frappe.throw(_("راجع الحقول المشار إليها"), title=_("بيانات ناقصة"))

	if not customer:
		customer = frappe.get_doc({
			"doctype": "Customer", "customer_name": new_customer["name"].strip(), "customer_group": _group("final"),
			"customer_type": "Company" if new_customer.get("type") == "Company" else "Individual",
			"default_price_list": _price_list(new_customer.get("type")),
			"mobile_no": (new_customer.get("phone") or "").strip() or None,
		}).insert().name

	subject = data["subject"].strip()
	project = frappe.get_doc({
		"doctype": "Project", "project_name": f"{subject} — {customer}"[:140], "company": company, "customer": customer,
		"expected_end_date": data["delivery_date"],
	}).insert().name

	so = frappe.get_doc({
		"doctype": "Sales Order", "customer": customer, "company": company, "project": project,
		"selling_price_list": _price_list(frappe.db.get_value("Customer", customer, "customer_type")),
		"transaction_date": nowdate(), "delivery_date": data["delivery_date"],
		"atelier_subject": subject, "atelier_stage": STAGES[0],
		"items": [
			{
				"item_code": i["item_code"], "qty": flt(i["qty"]), "delivery_date": data["delivery_date"],
				**({"description": i["description"]} if i.get("description") else {}),
				"rate": 0 if i.get("rate") in (None, "") else flt(i["rate"]),
				"atelier_price_pending": 1 if i.get("rate") in (None, "") else 0,
			}
			for i in items
		],
	})
	from atelier import simple
	simple.apply_tva(so)
	so.insert()
	if not data.get("no_steps"):
		production.create_default_steps(so)
	price_pending = any(i.atelier_price_pending for i in so.items)
	if not price_pending and data.get("confirm", True):
		so.submit()

	estimate = None
	costs = [c for c in data.get("costs") or [] if c.get("cost_type")]
	if costs and _can("Cost Estimate", "create"):
		estimate = frappe.get_doc({
			"doctype": "Cost Estimate", "customer": customer, "company": company, "project": project,
			"sales_order": so.name, "title": subject, "qty": 1, "waste_percent": flt(data.get("waste_percent")),
			"selling_price": None if price_pending else so.net_total,
			"lines": [
				{"cost_type": c["cost_type"], "item": c.get("item") or None, "description": c.get("description"),
					"qty": flt(c.get("qty")) or 1, "rate": None if c.get("rate") in (None, "") else flt(c["rate"]),
					"zero_confirmed": cint(c.get("zero_confirmed")),
					"rate_source": c.get("rate_source") or ("Saisie manuelle" if c.get("rate") not in (None, "") else None)}
				for c in costs
			],
		}).insert().name

	payment = None
	if flt(advance.get("amount")) > 0:
		payment = _receive(customer, flt(advance["amount"]), advance["mode_of_payment"], so if so.docstatus == 1 else None, so.name)

	return {"customer": customer, "project": project, "sales_order": so.name, "submitted": so.docstatus == 1,
		"price_pending": price_pending, "estimate": estimate, "payment": payment}


def simple_lists():
	from atelier import simple

	return simple.lists()


def simple_units():
	from atelier import simple

	return simple.units()


def _stored_list(key):
	try:
		return json.loads(frappe.db.get_default(key) or "[]")
	except ValueError:
		return []


def all_modes():
	"""The workshop's payment methods: the built-in list until it customizes them."""
	stored = _stored_list("atelier_modes")
	return [(m["value"], m["label"]) for m in stored] if stored else list(MODES)


def mode_funds(company):
	linked = frappe.get_all("Mode of Payment Account", filters={"company": company, "parent": ["in", [m[0] for m in all_modes()]]}, pluck="default_account")
	funds = set(linked) | {a for a in _stored_list("atelier_funds") if frappe.db.exists("Account", a)}
	return {a for a in funds if not frappe.db.get_value("Account", a, "disabled")}


def _cash_account(mode, company):
	from erpnext.accounts.doctype.sales_invoice.sales_invoice import get_bank_cash_account

	try:
		return get_bank_cash_account(mode, company).get("account")
	except Exception:
		return frappe.db.get_value("Company", company, "default_cash_account")


def _receive(customer, amount, mode, sales_order=None, order_name=None):
	company = _company()
	account = _cash_account(mode, company)
	if sales_order:
		from erpnext.accounts.doctype.payment_entry.payment_entry import get_payment_entry

		pe = get_payment_entry("Sales Order", sales_order.name, party_amount=amount, bank_account=account)
	else:
		from erpnext.accounts.party import get_party_account

		# Order not confirmed yet (prices pending): keep the money as an unallocated customer advance.
		pe = frappe.get_doc({
			"doctype": "Payment Entry", "payment_type": "Receive", "company": company,
			"party_type": "Customer", "party": customer,
			"paid_from": get_party_account("Customer", customer, company), "paid_to": account,
			"paid_amount": amount, "received_amount": amount,
		})
	pe.mode_of_payment = mode
	pe.posting_date = nowdate()
	pe.reference_no = pe.reference_no or "—"
	pe.reference_date = nowdate()
	pe.remarks = _("تسبيق")
	# the order this advance belongs to, even when it is not confirmed yet (see invoice_order)
	pe.atelier_order = sales_order.name if sales_order else order_name
	pe.insert()
	pe.submit()
	return pe.name


@frappe.whitelist(methods=["POST"])
def record_payment(customer, amount, mode_of_payment, sales_order=None):
	"""Sales staff take payments without the accounting role that would also show them the books."""
	from atelier.simple import app_role

	if _can("Payment Entry", "create"):
		return _record_payment(customer, amount, mode_of_payment, sales_order)
	if app_role() != "sales":
		frappe.throw(_("ليست لديك صلاحية لهذا الإجراء."), frappe.PermissionError)
	if sales_order:
		frappe.get_doc("Sales Order", sales_order).check_permission("read")
	# ERPNext checks the Payment Entry role itself, so run as Administrator and keep the seller as the owner.
	user = frappe.session.user
	frappe.set_user("Administrator")
	try:
		name = _record_payment(customer, amount, mode_of_payment, sales_order)
		frappe.db.set_value("Payment Entry", name, "owner", user, update_modified=False)
		return name
	finally:
		frappe.set_user(user)


def _record_payment(customer, amount, mode_of_payment, sales_order=None):
	if flt(amount) <= 0:
		frappe.throw(_("المبلغ يجب أن يكون أكبر من صفر"))
	so = frappe.get_doc("Sales Order", sales_order) if sales_order else None
	if so and so.docstatus == 1:
		unpaid = [d for d in _order_docs(so) if d["doctype"] == "Sales Invoice" and flt(d["outstanding_amount"]) > 0]
		if unpaid:
			return _receive_invoice(unpaid[0]["name"], flt(amount), mode_of_payment)
	return _receive(customer, flt(amount), mode_of_payment, so if so and so.docstatus == 1 else None)


def _receive_invoice(invoice, amount, mode):
	from erpnext.accounts.doctype.payment_entry.payment_entry import get_payment_entry

	pe = get_payment_entry("Sales Invoice", invoice, party_amount=amount, bank_account=_cash_account(mode, _company()))
	pe.mode_of_payment = mode
	pe.posting_date = nowdate()
	pe.reference_no = pe.reference_no or "—"
	pe.reference_date = nowdate()
	pe.insert()
	pe.submit()
	return pe.name


# ---------------------------------------------------------------- sections (money, stock, machines, reports)


def _require(doctype):
	if not _can(doctype):
		frappe.throw(_("ليست لديك صلاحية لهذا الإجراء."), frappe.PermissionError)


@frappe.whitelist()
def money():
	"""Cash/bank balances, recent receipts/payments and expenses — all read from the ledger."""
	_require("GL Entry")
	company = _company()
	accounts = frappe.db.sql(
		"""select acc.name, acc.account_name, acc.account_type, coalesce(sum(gle.debit - gle.credit), 0) balance
		from `tabAccount` acc left join `tabGL Entry` gle on gle.account = acc.name and gle.is_cancelled = 0
		where acc.company=%s and acc.is_group=0 and acc.account_type in ('Cash','Bank')
		group by acc.name order by acc.account_type, acc.account_name""",
		company, as_dict=True,
	)
	payments = frappe.get_list(
		"Payment Entry", filters={"docstatus": 1, "company": company},
		fields=["name", "posting_date", "payment_type", "party_type", "party", "party_name", "paid_amount", "mode_of_payment", "unallocated_amount"],
		order_by="posting_date desc, creation desc", limit=30,
	)
	expenses = frappe.db.sql(
		"""select gle.voucher_type, gle.voucher_no, gle.posting_date, acc.account_name, gle.project,
		sum(gle.debit - gle.credit) amount, max(gle.remarks) remarks
		from `tabGL Entry` gle join `tabAccount` acc on acc.name = gle.account
		where gle.company=%s and gle.is_cancelled=0 and acc.root_type='Expense'
		group by gle.voucher_no, gle.account order by gle.posting_date desc, gle.creation desc limit 30""",
		company, as_dict=True,
	)
	return {"summary": _money(), "accounts": accounts, "payments": payments, "expenses": expenses}


@frappe.whitelist()
def stock():
	"""Stock items with quantity per warehouse, value, reserved quantity and low-stock flag."""
	_require("Bin")
	rows = frappe.db.sql(
		"""select item.item_code, item.item_name, item.item_group, item.stock_uom, item.safety_stock,
		bin.warehouse, bin.actual_qty, bin.reserved_qty, bin.stock_value
		from `tabItem` item left join `tabBin` bin on bin.item_code = item.name
		where item.is_stock_item=1 and item.disabled=0 order by item.item_group, item.item_name""",
		as_dict=True,
	)
	items = {}
	for r in rows:
		it = items.setdefault(r.item_code, {"item_code": r.item_code, "item_name": r.item_name, "group": r.item_group,
			"uom": r.stock_uom, "safety_stock": flt(r.safety_stock), "qty": 0, "reserved": 0, "value": 0, "warehouses": []})
		if r.warehouse:
			it["qty"] += flt(r.actual_qty); it["reserved"] += flt(r.reserved_qty); it["value"] += flt(r.stock_value)
			it["warehouses"].append({"warehouse": r.warehouse, "qty": flt(r.actual_qty)})
	for it in items.values():
		it["low"] = bool(it["safety_stock"]) and it["qty"] < it["safety_stock"]
	moves = frappe.get_list(
		"Stock Ledger Entry", filters={"is_cancelled": 0},
		fields=["posting_date", "item_code", "warehouse", "actual_qty", "voucher_type", "voucher_no", "stock_value_difference"],
		order_by="posting_date desc, creation desc", limit=20,
	)
	names = {i["item_code"]: i["item_name"] for i in items.values()}
	for m in moves:
		m.item_name = names.get(m.item_code, m.item_code)
	return {"items": list(items.values()), "moves": moves, "can_value": _can("GL Entry"),
		"can_buy": _can("Purchase Invoice", "create"), "can_issue": _can("Stock Entry", "create")}


@frappe.whitelist()
def machines():
	"""Machines are ERPNext Assets; maintenance tasks come from Asset Maintenance when set up."""
	_require("Asset")
	assets = frappe.get_list(
		"Asset", filters={"docstatus": ["<", 2]},
		fields=["name", "asset_name", "item_name", "status", "location", "purchase_date", "gross_purchase_amount",
			"value_after_depreciation", "docstatus"],
		order_by="asset_name asc", limit=200,
	)
	tasks = []
	if frappe.db.exists("DocType", "Asset Maintenance Task") and _can("Asset Maintenance"):
		tasks = frappe.db.sql(
			"""select am.asset_name, t.maintenance_task, t.next_due_date, t.periodicity, t.maintenance_status
			from `tabAsset Maintenance Task` t join `tabAsset Maintenance` am on am.name = t.parent
			order by t.next_due_date asc limit 50""",
			as_dict=True,
		)
	repairs = []
	if _can("Asset Repair"):
		repairs = frappe.get_list("Asset Repair", fields=["name", "asset_name", "failure_date", "repair_status", "repair_cost"],
			order_by="failure_date desc", limit=20)
	return {"assets": assets, "tasks": tasks, "repairs": repairs}


@frappe.whitelist()
def reports():
	"""Per-order profitability: estimated margin vs. actual result from the ledger, plus cash received."""
	_require("GL Entry")
	from atelier.atelier.report.rentabilite_commande import rentabilite_commande as rc

	out = []
	for so in frappe.get_list(
		"Sales Order", filters={"docstatus": ["<", 2], "project": ["is", "set"]},
		fields=["name", "project", "customer_name", "atelier_subject", "atelier_stage", "grand_total", "per_billed", "advance_paid"],
		order_by="creation desc", limit=100,
	):
		est = rc.estimate(so.project)
		gl = rc.gl_totals(so.project)
		revenue, cost, internal = sum(gl["Income"].values()), sum(gl["Expense"].values()), rc.internal_cost(so.project)
		out.append({**so, "est_cost": est["total_cost"], "est_margin": est["margin"], "est_missing": est["missing"],
			"revenue": revenue, "cost": cost, "internal": internal,
			"result": revenue - cost - internal if revenue else None})
	return {"orders": out, "period": _money()["period"]}


# ---------------------------------------------------------------- expenses


@frappe.whitelist()
def expense_options():
	"""Expense accounts (most used first) and open orders an expense can be charged to."""
	if not _can("Journal Entry", "create"):
		frappe.throw(_("ليست لديك صلاحية لهذا الإجراء."), frappe.PermissionError)
	company = _company()
	used = dict(frappe.db.sql(
		"""select gle.account, count(*) from `tabGL Entry` gle join `tabAccount` acc on acc.name = gle.account
		where gle.company=%s and gle.is_cancelled=0 and acc.root_type='Expense'
		and gle.voucher_type in ('Journal Entry', 'Purchase Invoice') group by gle.account""", company))
	filters = {"company": company, "root_type": "Expense", "is_group": 0, "disabled": 0}
	short = json.loads(frappe.db.get_default("atelier_expense_accounts") or "[]")  # the workshop's short list, see accounts_ar.py
	if short:
		filters["name"] = ["in", short]
	accounts = frappe.get_all("Account", filters=filters, fields=["name", "account_name", "account_number"], order_by="account_number asc")
	if short:
		accounts.sort(key=lambda a: short.index(a.name))
	for a in accounts:
		a.used = used.get(a.name, 0)
	orders = frappe.get_list("Sales Order", filters={"docstatus": ["<", 2], "project": ["is", "set"], "status": ["not in", ["Closed", "Completed"]]},
		fields=["name", "project", "atelier_subject", "customer_name"], order_by="creation desc", limit=100)
	return {"accounts": accounts, "orders": orders}


@frappe.whitelist(methods=["POST"])
def record_expense(account, amount, mode_of_payment, description, sales_order=None, posting_date=None):
	"""One Journal Entry: debit the expense (tagged with the order's project), credit cash/bank."""
	if not _can("Journal Entry", "create"):
		frappe.throw(_("ليست لديك صلاحية لهذا الإجراء."), frappe.PermissionError)
	amount = flt(amount)
	if amount <= 0:
		frappe.throw(_("المبلغ يجب أن يكون أكبر من صفر"))
	if not (description or "").strip():
		frappe.throw(_("اكتب بيان المصروف"))
	company = _company()
	if frappe.db.get_value("Account", account, ["company", "root_type", "is_group"]) != (company, "Expense", 0):
		frappe.throw(_("اختر حساب مصروف صالحًا"))
	project = None
	if sales_order:
		so = frappe.get_doc("Sales Order", sales_order)
		so.check_permission("read")
		project = so.project
	paid_from = _cash_account(mode_of_payment, company)
	is_bank = frappe.db.get_value("Account", paid_from, "account_type") == "Bank"
	cost_center = frappe.db.get_value("Company", company, "cost_center")
	date = posting_date or nowdate()
	je = frappe.get_doc({
		"doctype": "Journal Entry", "voucher_type": "Bank Entry" if is_bank else "Cash Entry", "company": company,
		"posting_date": date, "user_remark": description.strip(), "mode_of_payment": mode_of_payment,
		"cheque_no": "—" if is_bank else None, "cheque_date": date if is_bank else None,
		"accounts": [
			{"account": account, "debit_in_account_currency": amount, "project": project, "cost_center": cost_center},
			{"account": paid_from, "credit_in_account_currency": amount, "cost_center": cost_center},
		],
	})
	je.insert()
	je.submit()
	return {"name": je.name, "project": project}


# ---------------------------------------------------------------- prices


@frappe.whitelist()
def prices():
	"""Sales items with their individual and company prices."""
	_require("Item Price")
	items = frappe.get_list("Item", filters={"disabled": 0, "is_sales_item": 1},
		fields=["item_code", "item_name", "item_group", "stock_uom"], order_by="item_name asc", limit=1000)
	return {"items": _with_prices(items), "lists": {k: _price_list(k) for k in PRICE_LISTS}, "can_edit": _can("Item Price", "write")}


@frappe.whitelist(methods=["POST"])
def set_price(item_code, kind, rate=None):
	"""Create, change or (empty rate) remove one Item Price. Removing means the item is priced later for that type."""
	if not _can("Item Price", "write"):
		frappe.throw(_("ليست لديك صلاحية لهذا الإجراء."), frappe.PermissionError)
	if kind not in PRICE_LISTS:
		frappe.throw(_("نوع سعر غير معروف"))
	price_list = _price_list(kind)
	uom = frappe.db.get_value("Item", item_code, "stock_uom")
	if not uom:
		frappe.throw(_("الخدمة غير موجودة"))
	existing = frappe.get_all("Item Price", {"item_code": item_code, "price_list": price_list}, pluck="name")
	if rate in (None, ""):
		for name in existing:
			frappe.delete_doc("Item Price", name)
		return None
	if flt(rate) < 0:
		frappe.throw(_("السعر لا يكون سالبًا"))
	doc = frappe.get_doc("Item Price", existing[0]) if existing else frappe.get_doc(
		{"doctype": "Item Price", "item_code": item_code, "price_list": price_list, "uom": uom})
	doc.price_list_rate = flt(rate)
	doc.save()
	return doc.price_list_rate


# ---------------------------------------------------------------- order cycle: price → confirm → deliver → invoice → pay
# Every step creates or submits the standard ERPNext document from the order (make_delivery_note,
# make_sales_invoice, get_payment_entry), so stock, receivables and advances follow ERPNext's own rules.

PRINT_FORMAT = "الورشة — عربي"


def _so_for(name, ptype="write"):
	so = frappe.get_doc("Sales Order", name)
	so.check_permission(ptype)
	return so


def _sync_estimate(so):
	for ce in frappe.get_all("Cost Estimate", {"sales_order": so.name}, pluck="name"):
		doc = frappe.get_doc("Cost Estimate", ce)
		pending = any(i.atelier_price_pending for i in so.items)
		doc.selling_price = None if pending else so.net_total
		doc.save()


@frappe.whitelist(methods=["POST"])
def price_order(name, rates):
	"""Set prices of lines still 'priced later' on a draft order. rates = {row name: rate}."""
	so = _so_for(name)
	if so.docstatus != 0:
		frappe.throw(_("الطلب معتمد؛ تعديل الأسعار يكون من ERPNext بإلغاء وتعديل"))
	rates = frappe.parse_json(rates) or {}
	for row in so.items:
		if row.name in rates and rates[row.name] not in (None, ""):
			if flt(rates[row.name]) < 0:
				frappe.throw(_("السعر لا يكون سالبًا"))
			row.rate = flt(rates[row.name])
			row.atelier_price_pending = 0
	so.save()
	_sync_estimate(so)
	return {"pending": sum(1 for i in so.items if i.atelier_price_pending)}


@frappe.whitelist(methods=["POST"])
def confirm_order(name):
	so = _so_for(name, "submit")
	if so.docstatus != 0:
		return so.name
	if any(i.atelier_price_pending for i in so.items):
		frappe.throw(_("سعّر كل البنود قبل اعتماد الطلب"))
	so.submit()
	return so.name


@frappe.whitelist(methods=["POST"])
def deliver_order(name, qtys=None):
	"""Delivery note from the order: everything left, or qtys = {order row name: qty} for a partial delivery."""
	from erpnext.selling.doctype.sales_order.sales_order import make_delivery_note

	so = _so_for(name, "read")
	if so.docstatus != 1:
		frappe.throw(_("اعتمد الطلب أولًا"))
	if not _can("Delivery Note", "create"):
		frappe.throw(_("ليست لديك صلاحية لهذا الإجراء."), frappe.PermissionError)
	dn = make_delivery_note(so.name)
	qtys = frappe.parse_json(qtys) if qtys else None
	if qtys:
		for row in dn.items:
			if row.so_detail in qtys:
				row.qty = min(flt(qtys[row.so_detail]), row.qty)
		dn.items = [r for r in dn.items if flt(r.qty) > 0]
	if not dn.items:
		frappe.throw(_("لا شيء للتسليم"))
	dn.insert()
	dn.submit()
	so.reload()
	if so.per_delivered >= 100:
		so.db_set("atelier_stage", STAGES[-1])
	return dn.name


@frappe.whitelist(methods=["POST"])
def invoice_order(name):
	"""Sales invoice for what is not billed yet; customer advances are deducted automatically."""
	from erpnext.selling.doctype.sales_order.sales_order import make_sales_invoice

	so = _so_for(name, "read")
	if so.docstatus != 1:
		frappe.throw(_("اعتمد الطلب أولًا"))
	if not _can("Sales Invoice", "create"):
		frappe.throw(_("ليست لديك صلاحية لهذا الإجراء."), frappe.PermissionError)
	si = make_sales_invoice(so.name)
	si.allocate_advances_automatically = 1
	si.set_advances()
	# ERPNext offers every open advance of the customer; keep only this order's own advances,
	# so an advance paid for one job is never swallowed by another job's invoice.
	own = set(frappe.get_all("Payment Entry Reference", filters={"reference_doctype": "Sales Order", "reference_name": so.name, "docstatus": 1}, pluck="parent"))
	own |= set(frappe.get_all("Payment Entry", filters={"atelier_order": so.name, "docstatus": 1}, pluck="name"))
	si.set("advances", [a for a in si.advances if a.reference_type != "Payment Entry" or a.reference_name in own])
	si.allocate_advances_automatically = 0  # otherwise validate() reallocates every open advance again
	si.insert()
	si.submit()
	return si.name


def _order_docs(so):
	"""Documents created from this order, oldest first, with what the order page needs."""
	docs = []
	for dt, child, field in (("Delivery Note", "Delivery Note Item", "against_sales_order"), ("Sales Invoice", "Sales Invoice Item", "sales_order")):
		names = frappe.get_all(child, {field: so.name, "docstatus": ["<", 2]}, pluck="parent", distinct=True)
		extra = ["outstanding_amount", "grand_total", "total_advance"] if dt == "Sales Invoice" else ["grand_total"]
		for d in frappe.get_all(dt, {"name": ["in", names or [""]], "docstatus": 1}, ["name", "posting_date", "creation", *extra]):
			docs.append({"doctype": dt, **d})
	invoices = [d["name"] for d in docs if d["doctype"] == "Sales Invoice"]
	refs = [so.name, *invoices]
	for p in frappe.db.sql(
		"""select distinct pe.name, pe.posting_date, pe.creation, pe.paid_amount from `tabPayment Entry` pe
		join `tabPayment Entry Reference` per on per.parent = pe.name
		where pe.docstatus = 1 and per.reference_name in %s""", [refs], as_dict=True):
		docs.append({"doctype": "Payment Entry", **p})
	docs.sort(key=lambda d: d["creation"])
	for d in docs:
		d.pop("creation", None)
	return docs


def setup_print_formats(commit=True):
	"""One Jinja print format shared by the documents (HTML in templates/print/atelier_doc.html), set as default."""
	html = '{% include "templates/print/atelier_doc.html" %}'
	for dt in ("Quotation", "Sales Order", "Delivery Note", "Sales Invoice", "Payment Entry"):
		name = f"{PRINT_FORMAT} — {dt}"
		pf = frappe.get_doc("Print Format", name) if frappe.db.exists("Print Format", name) else frappe.new_doc("Print Format")
		pf.update({"name": name, "doc_type": dt, "module": "Atelier", "standard": "No", "custom_format": 1,
			"print_format_type": "Jinja", "html": html, "disabled": 0, "raw_printing": 0})
		pf.flags.ignore_permissions = True
		pf.save() if not pf.is_new() else pf.insert(set_name=name)
		frappe.make_property_setter({"doctype": dt, "doctype_or_field": "DocType", "property": "default_print_format",
			"value": name, "property_type": "Data"}, validate_fields_for_doctype=False)
	if commit:
		frappe.db.commit()


@frappe.whitelist(methods=["POST"])
def create_item(data):
	"""A sellable service (no stock) or product, with its unit and the two prices. Raw materials are added from stock."""
	from frappe.model.naming import make_autoname

	if not (_can("Item", "create") and _can("Item Price", "write")):
		frappe.throw(_("ليست لديك صلاحية لهذا الإجراء."), frappe.PermissionError)
	data = frappe.parse_json(data)
	name = (data.get("item_name") or "").strip()
	if not name:
		frappe.throw(_("اكتب اسم الخدمة أو المنتج"))
	if frappe.db.exists("Item", {"item_name": name, "disabled": 0}):
		frappe.throw(_("يوجد بند بهذا الاسم"))
	uom = (data.get("uom") or "قطعة").strip()
	if not frappe.db.exists("UOM", uom):
		frappe.get_doc({"doctype": "UOM", "uom_name": uom, "must_be_whole_number": next((u["whole"] for u in simple_units() if u["name"] == uom), 0)}).insert(ignore_permissions=True)
	product = data.get("kind") == "product"
	group = "خدمات" if not product else "منتجات"
	if not frappe.db.exists("Item Group", group):
		root = frappe.db.get_value("Item Group", {"is_group": 1, "parent_item_group": ["in", ["", None]]}) or "All Item Groups"
		frappe.get_doc({"doctype": "Item Group", "item_group_name": group, "parent_item_group": root}).insert(ignore_permissions=True)
	item = frappe.get_doc({
		"doctype": "Item", "item_code": make_autoname(("PRD" if product else "SRV") + "-.####"), "item_name": name,
		"item_group": group, "stock_uom": uom, "is_stock_item": 1 if product else 0, "is_sales_item": 1, "is_purchase_item": 1 if product else 0,
		"include_item_in_manufacturing": 0, "description": (data.get("description") or "").strip() or name,
	}).insert()
	for kind, key in (("Individual", "price_individual"), ("Company", "price_company")):
		if data.get(key) not in (None, ""):
			set_price(item.name, kind, data[key])
	return _with_prices([frappe._dict(item_code=item.name, item_name=item.item_name, stock_uom=uom, is_stock_item=item.is_stock_item, standard_rate=0)])[0]


@frappe.whitelist()
def statement_pdf(name, from_date=None, to_date=None):
	"""Customer statement (opening balance, every movement, closing balance) as an Arabic PDF."""
	from frappe.utils import add_months, formatdate
	from frappe.utils.pdf import get_pdf

	if not _can("GL Entry"):
		frappe.throw(_("ليست لديك صلاحية لهذا الإجراء."), frappe.PermissionError)
	doc = frappe.get_doc("Customer", name)
	doc.check_permission("read")
	company = _company()
	to_date = getdate(to_date or nowdate())
	from_date = getdate(from_date or add_months(to_date, -12))
	opening = flt(frappe.db.sql("""select sum(debit - credit) from `tabGL Entry` where party_type='Customer' and party=%s
		and company=%s and is_cancelled=0 and posting_date < %s""", (name, company, from_date))[0][0])
	rows, running = [], opening
	for e in frappe.get_all("GL Entry", filters={"party_type": "Customer", "party": name, "company": company, "is_cancelled": 0,
			"posting_date": ["between", [from_date, to_date]]}, fields=["posting_date", "voucher_type", "voucher_no", "debit", "credit"],
			order_by="posting_date asc, creation asc"):
		running += flt(e.debit) - flt(e.credit)
		rows.append({**e, "balance": running})
	from atelier.printing import TITLES, print_context

	ctx = print_context(frappe._dict(doctype="Statement", company=company, customer=name, posting_date=to_date))
	html = frappe.render_template("templates/print/atelier_statement.html", {
		"c": ctx, "rows": rows, "opening": opening, "closing": running, "titles": TITLES,
		"from_date": formatdate(from_date, "dd/MM/yyyy"), "to_date": formatdate(to_date, "dd/MM/yyyy"),
		"debit": sum(flt(r["debit"]) for r in rows), "credit": sum(flt(r["credit"]) for r in rows),
	})
	frappe.local.response.filename = f"كشف حساب {doc.customer_name}.pdf"
	frappe.local.response.filecontent = get_pdf(html)
	frappe.local.response.type = "pdf"


# Simple workshop endpoints (board, quick order, money) — imported last: simple.py builds on this module.
from atelier.simple import reports2, save_email, test_email  # noqa: E402, F401
from atelier.simple import create_purchase_order, create_supplier_invoice, save_supplier, set_supplier_disabled, supplier2, suppliers2  # noqa: E402, F401
from atelier.simple import money3, pay_supplier, transfer_funds  # noqa: E402, F401
from atelier.simple import backup_now, rename_fund, reset_link, save_alerts, save_doc_settings, save_profile, save_user, set_mode_account, settings  # noqa: E402, F401
from atelier.materials import issue_order_materials, order_materials, recipes, save_recipe, add_material, remove_material, stock_count, stock_issue, stock_purchase, update_material
from atelier.quotes import card_quote
from atelier.simple import save_list, add_fund, add_mode, remove_fund, remove_mode, card_cost, save_card_cost, cancel_opening, opening_balances, save_opening, save_units, add_customer_log, customer_credit, merge_customers, save_customer2, save_customer_tags, set_customer_disabled  # noqa: E402, F401
from atelier.simple import customer2, customers2, reorder_card, set_customer_extra  # noqa: E402, F401
from atelier.simple import archive_card, archive_paid, archived_cards, checklist_templates, copy_card, delete_checklist_template, mark_read, notifications, reorder, save_checklist_template  # noqa: E402, F401
from atelier.simple import add_card, add_comment, board, board2, card, delete_file, file_added, move, move_card, quick_order, save_board, update_card, update_order  # noqa: E402, F401
from atelier.simple import money as money_simple  # noqa: E402, F401
from atelier.folders import pull_files, save_settings as save_folders, sync_all as sync_folders  # noqa: E402, F401
from atelier.calculator import calc_data, calc_order, delete_calc, get_calc, save_calc, save_margins  # noqa: E402, F401
