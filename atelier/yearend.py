"""Closing a financial year: what to check first, the year's statements (results and balance sheet), and the closing
itself (an ERPNext Period Closing Voucher to account 12, then the year frozen). Manager only. Nothing is deleted;
after closing, a correction is a new entry in the next year."""

import frappe
from frappe import _
from frappe.utils import add_days, flt, getdate, nowdate

# results by the first digits of the Algerian chart (SCF): the lines a small print shop recognises
RESULT_LINES = [
	("70", "المبيعات والخدمات", "Income"),
	("7", "إيرادات أخرى", "Income"),
	("60", "المشتريات المستهلكة (ورق، حبر…)", "Expense"),
	("61", "الخدمات الخارجية", "Expense"),
	("62", "الخدمات الخارجية الأخرى", "Expense"),
	("63", "أعباء المستخدمين", "Expense"),
	("64", "الضرائب والرسوم", "Expense"),
	("65", "أعباء أخرى (فروق الصندوق…)", "Expense"),
	("66", "الأعباء المالية", "Expense"),
	("68", "الاهتلاكات", "Expense"),
	("6", "أعباء أخرى", "Expense"),
]
BALANCE_LINES = [
	("Asset", "Cash", "الصناديق والبنك"),
	("Asset", "Stock", "المخزون"),
	("Asset", "Receivable", "ديون العملاء"),
	("Asset", "Tax", "TVA قابلة للاسترجاع"),
	("Asset", None, "أصول أخرى"),
	("Liability", "Payable", "ديون الموردين"),
	("Liability", "Tax", "TVA مستحقة"),
	("Liability", None, "خصوم أخرى"),
	("Equity", None, "الأموال الخاصة"),
]


def _manager():
	from atelier.simple import _manager_only

	_manager_only()


def _fy(year):
	fy = frappe.db.get_value("Fiscal Year", {"name": str(year)}, ["name", "year_start_date", "year_end_date"], as_dict=True) or \
		frappe.db.get_value("Fiscal Year", {"year_start_date": ["<=", f"{year}-12-31"], "year_end_date": [">=", f"{year}-01-01"]},
			["name", "year_start_date", "year_end_date"], as_dict=True)
	if not fy:
		frappe.throw(_("لا توجد سنة مالية {0}").format(year))
	return fy


def _closed(fy, company):
	return frappe.db.get_value("Period Closing Voucher", {"fiscal_year": fy.name, "company": company, "docstatus": 1}, "name")


def results(fy, company):
	"""Income and expenses of the year, grouped as above, from the ledger (closing entries left out)."""
	rows = frappe.db.sql("""select acc.account_number num, acc.root_type root, sum(gle.credit - gle.debit) amount
		from `tabGL Entry` gle join `tabAccount` acc on acc.name=gle.account
		where gle.is_cancelled=0 and gle.company=%s and gle.posting_date between %s and %s and acc.root_type in ('Income','Expense')
		and gle.voucher_type != 'Period Closing Voucher' group by acc.name""", (company, fy.year_start_date, fy.year_end_date), as_dict=True)
	lines = {code: 0.0 for code, _l, _r in RESULT_LINES}
	for r in rows:
		num = str(r.num or "")
		code = next((c for c, _l, root in RESULT_LINES if root == r.root and num.startswith(c)), None) or ("7" if r.root == "Income" else "6")
		lines[code] += flt(r.amount)
	out = [{"code": c, "label": label, "amount": round(lines[c], 2)} for c, label, _r in RESULT_LINES if abs(lines[c]) > 0.005]
	income = sum(flt(r.amount) for r in rows if r.root == "Income")
	expense = -sum(flt(r.amount) for r in rows if r.root == "Expense")
	return {"lines": out, "income": round(income, 2), "expense": round(expense, 2), "result": round(income - expense, 2)}


def balance(fy, company):
	"""What the shop holds and owes at the end of the year."""
	rows = frappe.db.sql("""select acc.root_type root, acc.account_type type, sum(gle.debit - gle.credit) amount
		from `tabGL Entry` gle join `tabAccount` acc on acc.name=gle.account
		where gle.is_cancelled=0 and gle.company=%s and gle.posting_date <= %s and acc.root_type in ('Asset','Liability','Equity')
		group by acc.root_type, acc.account_type""", (company, fy.year_end_date), as_dict=True)
	lines = []
	for root, kind, label in BALANCE_LINES:
		amount = sum(flt(r.amount) for r in rows if r.root == root and (r.type == kind if kind else
			r.type not in [k for rt, k, _l in BALANCE_LINES if rt == root and k]))
		if root != "Asset":
			amount = -amount
		if abs(amount) > 0.005:
			lines.append({"root": root, "label": label, "amount": round(amount, 2)})
	res = results(fy, company)["result"]
	closed = _closed(fy, company)
	if not closed and abs(res) > 0.005:  # before closing, the year's result is not in an equity account yet
		lines.append({"root": "Equity", "label": _("نتيجة السنة (قبل الإقفال)"), "amount": res})
	assets = sum(l["amount"] for l in lines if l["root"] == "Asset")
	other = sum(l["amount"] for l in lines if l["root"] != "Asset")
	return {"lines": lines, "assets": round(assets, 2), "liabilities_equity": round(other, 2)}


@frappe.whitelist()
def year_status(year=None):
	_manager()
	from atelier import api, books_check

	company = api._company()
	year = int(year or getdate(nowdate()).year)
	fy = _fy(year)
	checks = []
	import contextlib
	import io

	with contextlib.redirect_stdout(io.StringIO()):
		diffs = books_check.run(rollback=False)
	checks.append({"ok": diffs == 0, "title": _("فحص الدفاتر"), "detail": _("0 فروق — ميزان المراجعة متوازن") if diffs == 0 else _("{0} فروق — راجعها قبل الإقفال").format(diffs)})
	unbilled = frappe.db.sql("""select name, atelier_subject from `tabSales Order` where docstatus=1 and company=%s and per_delivered > 0
		and per_billed < 100 and transaction_date <= %s""", (company, fy.year_end_date), as_dict=True)
	checks.append({"ok": not unbilled, "title": _("الطلبات المسلَّمة مفوترة"),
		"detail": _("كلها مفوترة") if not unbilled else _("{0} طلبات سُلّمت ولم تُفوتر: تُفوتر قبل الإقفال حتى تدخل مبيعات السنة").format(len(unbilled)),
		"orders": [u.name for u in unbilled[:20]]})
	draft = frappe.db.count("Sales Order", {"docstatus": 0, "company": company, "transaction_date": ["between", [fy.year_start_date, fy.year_end_date]]})
	checks.append({"ok": True, "title": _("طلبات بلا سعر"), "detail": _("{0} طلبات بلا سعر — لا أثر لها في الحسابات").format(draft) if draft else _("لا شيء")})
	last_count = frappe.db.sql("""select max(posting_date) from `tabStock Reconciliation` where docstatus=1 and company=%s
		and posting_date <= %s""", (company, fy.year_end_date))[0][0]
	checks.append({"ok": bool(last_count) and getdate(last_count) >= add_days(fy.year_end_date, -31),
		"title": _("جرد المخزون"), "detail": _("آخر جرد: {0}").format(last_count) if last_count else _("لا جرد مسجّل — يُنصح بجرد آخر السنة")})
	return {"year": year, "fiscal_year": fy.name, "from": str(fy.year_start_date), "to": str(fy.year_end_date),
		"ended": getdate(nowdate()) > getdate(fy.year_end_date), "closed": _closed(fy, company),
		"checks": checks, "results": results(fy, company), "balance": balance(fy, company),
		"years": [int(str(y)[:4]) for y in frappe.get_all("Fiscal Year", pluck="year_start_date", order_by="year_start_date desc")]}


@frappe.whitelist(methods=["POST"])
def close_year(year):
	"""The year's income and expenses moved to account 12 (one Period Closing Voucher), then the year frozen."""
	_manager()
	from atelier import api

	company = api._company()
	fy = _fy(int(year))
	if getdate(nowdate()) <= getdate(fy.year_end_date):
		frappe.throw(_("لا تُقفل السنة قبل نهايتها ({0})").format(fy.year_end_date))
	if _closed(fy, company):
		frappe.throw(_("هذه السنة مقفلة من قبل"))
	result_acc = frappe.db.get_value("Account", {"company": company, "account_number": "12", "is_group": 0}) or \
		frappe.db.get_value("Account", {"company": company, "root_type": "Equity", "is_group": 0, "account_name": ["like", "%sultat%"]})
	if not result_acc:
		frappe.throw(_("لا يوجد حساب «نتيجة السنة» (12) في دليل الحسابات"))
	pcv = frappe.get_doc({"doctype": "Period Closing Voucher", "company": company, "fiscal_year": fy.name,
		"transaction_date": nowdate(), "posting_date": fy.year_end_date, "period_start_date": fy.year_start_date,
		"period_end_date": fy.year_end_date, "closing_account_head": result_acc,
		"remarks": _("إقفال السنة المالية {0}").format(fy.name)})
	pcv.flags.ignore_permissions = True
	pcv.insert()
	pcv.submit()
	# nothing may be booked inside the closed year any more
	frozen = frappe.db.get_single_value("Accounts Settings", "acc_frozen_upto") if frappe.get_meta("Accounts Settings").has_field("acc_frozen_upto") else None
	if frappe.get_meta("Accounts Settings").has_field("acc_frozen_upto") and (not frozen or getdate(frozen) < getdate(fy.year_end_date)):
		frappe.db.set_single_value("Accounts Settings", "acc_frozen_upto", fy.year_end_date)
	elif frappe.get_meta("Company").has_field("accounts_frozen_till_date"):
		frappe.db.set_value("Company", company, "accounts_frozen_till_date", fy.year_end_date)
	return {"voucher": pcv.name, **year_status(year)}
