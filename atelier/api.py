"""API for the daily app (/atelier). Every read goes through frappe.get_list / permission checks,
every write creates standard ERPNext documents (no parallel accounting)."""

import frappe
from frappe import _
from frappe.utils import add_days, cint, flt, get_first_day, get_last_day, getdate, nowdate

MODES = [("Cash", "نقدًا"), ("Wire Transfer", "تحويل بنكي"), ("Cheque", "صك")]
STAGES = ["جديد", "تصميم", "بانتظار موافقة العميل", "طباعة", "تشطيب", "جاهز للتسليم", "سُلّم"]


def _company():
	return frappe.defaults.get_user_default("Company") or frappe.db.get_single_value("Global Defaults", "default_company")


def _can(doctype, ptype="read"):
	return frappe.has_permission(doctype, ptype)


@frappe.whitelist()
def boot():
	company = _company()
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
		"currency": frappe.db.get_value("Company", company, "default_currency"),
		"is_demo": "DÉMO" in (company or "") or "تجريبي" in (company or ""),
		"items": items,
		"stages": STAGES,
		"modes": [{"value": v, "label": l} for v, l in MODES if frappe.db.exists("Mode of Payment", v)],
		"can": {
			"order": _can("Sales Order", "create"),
			"payment": _can("Payment Entry", "create"),
			"expense": _can("Journal Entry", "create"),
			"finance": _can("GL Entry", "read"),
			"cost": _can("Cost Estimate", "read"),
		},
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
		"cash_in": gl(f"""select sum(debit) from `tabGL Entry` where company=%s and is_cancelled=0
			and posting_date between %s and %s and account in ({cash_accounts})""", company, start, end, company),
		"cash_out": gl(f"""select sum(credit) from `tabGL Entry` where company=%s and is_cancelled=0
			and posting_date between %s and %s and account in ({cash_accounts})""", company, start, end, company),
		"cash_balance": gl(f"""select sum(debit - credit) from `tabGL Entry` where company=%s and is_cancelled=0
			and account in ({cash_accounts})""", company, company),
		"receivable": gl("select sum(outstanding_amount) from `tabSales Invoice` where company=%s and docstatus=1", company),
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
			"delivery_date", "grand_total", "per_billed", "per_delivered", "advance_paid", "docstatus", "status"],
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
	for r in rows:
		r.price_pending = r.name in pending
		r.paid = max(flt(r.advance_paid), flt(paid_on_invoices.get(r.name)))
	return rows


def _recent_orders():
	if not _can("Sales Order"):
		return []
	return _order_rows({"docstatus": ["<", 2], "status": ["not in", ["Closed", "Completed"]]})


# ---------------------------------------------------------------- search


@frappe.whitelist()
def search(q):
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


@frappe.whitelist()
def customers(q=None):
	filters = {"disabled": 0}
	or_filters = {"customer_name": ["like", f"%{q}%"], "mobile_no": ["like", f"%{q}%"]} if q else None
	return frappe.get_list("Customer", filters=filters, or_filters=or_filters,
		fields=["name", "customer_name", "mobile_no"], order_by="modified desc", limit=20)


@frappe.whitelist()
def customer(name):
	doc = frappe.get_doc("Customer", name)
	doc.check_permission("read")
	company = _company()
	res = {
		"name": doc.name, "customer_name": doc.customer_name, "mobile_no": doc.mobile_no, "email_id": doc.email_id,
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
	so = frappe.get_doc("Sales Order", name)
	so.check_permission("read")
	row = _order_rows({"name": name}, limit=1)[0]
	row["items"] = [
		{"item_code": i.item_code, "item_name": i.item_name, "description": i.description, "qty": i.qty, "uom": i.uom,
			"rate": None if i.atelier_price_pending else i.rate, "amount": None if i.atelier_price_pending else i.amount}
		for i in so.items
	]
	row["project"] = so.project
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
			"doctype": "Customer", "customer_name": new_customer["name"].strip(), "customer_type": "Individual",
			"mobile_no": (new_customer.get("phone") or "").strip() or None,
		}).insert().name

	subject = data["subject"].strip()
	project = frappe.get_doc({
		"doctype": "Project", "project_name": f"{subject} — {customer}"[:140], "company": company, "customer": customer,
		"expected_end_date": data["delivery_date"],
	}).insert().name

	so = frappe.get_doc({
		"doctype": "Sales Order", "customer": customer, "company": company, "project": project,
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
	so.insert()
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
		payment = _receive(customer, flt(advance["amount"]), advance["mode_of_payment"], so if so.docstatus == 1 else None)

	return {"customer": customer, "project": project, "sales_order": so.name, "submitted": so.docstatus == 1,
		"price_pending": price_pending, "estimate": estimate, "payment": payment}


def _cash_account(mode, company):
	from erpnext.accounts.doctype.sales_invoice.sales_invoice import get_bank_cash_account

	try:
		return get_bank_cash_account(mode, company).get("account")
	except Exception:
		return frappe.db.get_value("Company", company, "default_cash_account")


def _receive(customer, amount, mode, sales_order=None):
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
	pe.insert()
	pe.submit()
	return pe.name


@frappe.whitelist(methods=["POST"])
def record_payment(customer, amount, mode_of_payment, sales_order=None):
	if flt(amount) <= 0:
		frappe.throw(_("المبلغ يجب أن يكون أكبر من صفر"))
	so = frappe.get_doc("Sales Order", sales_order) if sales_order else None
	return _receive(customer, flt(amount), mode_of_payment, so if so and so.docstatus == 1 else None)
