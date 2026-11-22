"""The monthly TVA return (G50): TVA collected on sales (credit notes included) minus TVA recoverable on purchases =
the amount to pay. Read from the documents and the ledger; «سدّدتُ G50» books the payment and clears both accounts.
Manager only."""

import frappe
from frappe import _
from frappe.utils import flt, get_first_day, get_last_day, getdate, nowdate


def _manager():
	from atelier.simple import _manager_only

	_manager_only()


def _month(month):
	d = getdate(f"{month}-01") if month else get_first_day(nowdate())
	return get_first_day(d), get_last_day(d)


def _key(start):
	return f"G50 {str(start)[:7]}"


@frappe.whitelist()
def g50(month=None):
	_manager()
	from atelier import api, materials

	company = api._company()
	a, b = _month(month)
	sales = frappe.db.sql("""select t.rate, si.is_return, sum(t.base_tax_amount) tax, count(distinct si.name) n
		from `tabSales Taxes and Charges` t join `tabSales Invoice` si on si.name=t.parent
		where si.docstatus=1 and si.company=%s and si.posting_date between %s and %s group by t.rate, si.is_return""", (company, a, b), as_dict=True)
	# net per rate, exactly: each taxed invoice counted once at its rate
	net_by = {}
	for r in frappe.db.sql("""select si.name, si.base_net_total net, si.is_return, max(t.rate) rate from `tabSales Invoice` si
			join `tabSales Taxes and Charges` t on t.parent=si.name where si.docstatus=1 and si.company=%s and si.posting_date between %s and %s
			group by si.name""", (company, a, b), as_dict=True):
		k = (flt(r.rate), r.is_return)
		net_by[k] = net_by.get(k, 0) + flt(r.net)
	lines = []
	for r in sorted(sales, key=lambda x: (x.is_return, -flt(x.rate))):
		lines.append({"kind": "return" if r.is_return else "sale", "rate": flt(r.rate), "net": round(net_by.get((flt(r.rate), r.is_return), 0), 2),
			"tax": round(flt(r.tax), 2), "count": r.n})
	exempt = flt(frappe.db.sql("""select sum(si.base_net_total) from `tabSales Invoice` si where si.docstatus=1 and si.company=%s
		and si.posting_date between %s and %s and not exists (select 1 from `tabSales Taxes and Charges` t where t.parent=si.name)""", (company, a, b))[0][0])
	collected = round(sum(l["tax"] for l in lines), 2)
	acc = materials.deductible_tva_account(company)
	purch = frappe.db.sql("""select sum(t.base_tax_amount_after_discount_amount) tax, count(distinct pi.name) n
		from `tabPurchase Taxes and Charges` t join `tabPurchase Invoice` pi on pi.name=t.parent
		where pi.docstatus=1 and pi.company=%s and pi.posting_date between %s and %s and t.account_head=%s""", (company, a, b, acc), as_dict=True)[0]
	purch.net = flt(frappe.db.sql("""select sum(pi.base_net_total) from `tabPurchase Invoice` pi where pi.docstatus=1 and pi.company=%s
		and pi.posting_date between %s and %s and exists (select 1 from `tabPurchase Taxes and Charges` t where t.parent=pi.name and t.account_head=%s)""",
		(company, a, b, acc))[0][0])
	deductible = round(flt(purch.tax), 2)
	paid = frappe.db.get_value("Journal Entry", {"docstatus": 1, "company": company, "user_remark": ["like", _key(a) + "%"]}, "name")
	months = [str(get_first_day(getdate(f"{y}-{m:02d}-01")))[:7] for y in (getdate(nowdate()).year,) for m in range(1, getdate(nowdate()).month + 1)]
	return {"month": str(a)[:7], "from": str(a), "to": str(b), "lines": lines, "exempt": round(exempt, 2), "collected": collected,
		"deductible": deductible, "purchases_net": round(flt(purch.net), 2), "purchases": purch.n or 0,
		"due": round(collected - deductible, 2), "paid": paid, "months": months[::-1]}


@frappe.whitelist(methods=["POST"])
def pay_g50(month, mode_of_payment="Cash"):
	"""Clear the month's collected TVA against the recoverable TVA and pay the difference from a fund."""
	_manager()
	from atelier import api, materials

	company = api._company()
	a, b = _month(month)
	d = g50(month)
	if d["paid"]:
		frappe.throw(_("صُرّح بهذا الشهر وسُدّد من قبل ({0})").format(d["paid"]))
	today = getdate(frappe.flags.get("atelier_today") or nowdate())  # tests may set the day
	if today <= getdate(b):
		frappe.throw(_("يُسدَّد تصريح الشهر بعد نهايته"))
	if d["due"] <= 0.005:
		frappe.throw(_("لا شيء للدفع هذا الشهر: TVA القابلة للخصم تساوي أو تفوق المحصّلة"))
	cash = api._cash_account(mode_of_payment, company)
	api.ensure_funds(cash, d["due"])
	cc = frappe.db.get_value("Company", company, "cost_center")
	rows = []
	# each sales TVA account by what it collected this month
	for acc, amount in frappe.db.sql("""select gle.account, sum(gle.credit - gle.debit) from `tabGL Entry` gle join `tabAccount` acc on acc.name=gle.account
			where gle.is_cancelled=0 and gle.company=%s and gle.posting_date between %s and %s and gle.voucher_type='Sales Invoice'
			and acc.account_type='Tax' and acc.root_type='Liability' group by gle.account""", (company, a, b)):
		if abs(flt(amount)) > 0.005:
			rows.append({"account": acc, "debit_in_account_currency": flt(amount), "cost_center": cc})
	if d["deductible"] > 0.005:
		rows.append({"account": materials.deductible_tva_account(company), "credit_in_account_currency": d["deductible"], "cost_center": cc})
	rows.append({"account": cash, "credit_in_account_currency": d["due"], "cost_center": cc})
	je = frappe.get_doc({"doctype": "Journal Entry", "voucher_type": "Journal Entry", "company": company, "posting_date": nowdate(),
		"mode_of_payment": mode_of_payment, "cheque_no": _key(a), "cheque_date": nowdate(),
		"user_remark": _key(a) + " — " + _("تسديد TVA لشهر {0}").format(str(a)[:7]), "accounts": rows})
	je.flags.ignore_permissions = True
	je.insert()
	je.submit()
	return {"journal": je.name, **g50(month)}
