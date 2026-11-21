"""Read-only consistency check of the books against what the app shows. Writes nothing.

Run on any site (it only reads):  bench --site <site> execute atelier.books_check.run
Each line is OK or DIFF; the last line counts the differences.
"""

import frappe
from frappe.utils import flt, get_first_day, get_last_day, nowdate


def _line(ok, what, detail=""):
	print(("OK    " if ok else "DIFF  ") + what + (f" — {detail}" if detail else ""))
	return 0 if ok else 1


def run(rollback=True):
	from atelier import api, simple

	frappe.set_user("Administrator")
	diffs = 0
	company = api._company()

	# 1. every posting balances
	d, c = frappe.db.sql("select sum(debit), sum(credit) from `tabGL Entry` where is_cancelled=0 and company=%s", company)[0]
	diffs += _line(abs(flt(d) - flt(c)) < 0.01, "trial balance: total debit = total credit", f"{flt(d):.2f} / {flt(c):.2f}")
	bad = frappe.db.sql("""select voucher_type, voucher_no, sum(debit-credit) from `tabGL Entry` where is_cancelled=0 and company=%s
		group by voucher_type, voucher_no having abs(sum(debit-credit)) > 0.01 limit 5""", company)
	diffs += _line(not bad, "every document balances on its own", str(bad))

	# 2. invoice outstanding = what the ledger says is open on it
	for si in frappe.get_all("Sales Invoice", filters={"docstatus": 1, "company": company}, fields=["name", "outstanding_amount", "is_return", "return_against"]):
		ple = flt(frappe.db.sql("""select sum(amount) from `tabPayment Ledger Entry` where delinked=0 and against_voucher_type='Sales Invoice'
			and against_voucher_no=%s""", si.name)[0][0])
		if abs(ple - flt(si.outstanding_amount)) > 0.01:
			diffs += _line(False, f"invoice {si.name}: outstanding {si.outstanding_amount} vs ledger {ple}")
	print("      (sales invoices checked against the payment ledger)")

	# 3. customer balance shown in the app = ledger balance + not yet invoiced on open orders
	rows = {r.name: r for r in simple.customers2()["rows"]}
	from erpnext.accounts.utils import get_balance_on

	for name, r in rows.items():
		gl = flt(get_balance_on(party_type="Customer", party=name, company=company))
		unbilled = sum(flt(o.grand_total) * (1 - flt(o.per_billed) / 100) for o in api._order_rows(
			{"customer": name, "docstatus": 1, "per_billed": ["<", 100], "status": ["!=", "Closed"]}, limit=0) if not o.price_pending)
		if r.balance is not None and abs(flt(r.balance) - (gl + unbilled)) > 0.01:
			diffs += _line(False, f"customer {name}: app {r.balance} vs ledger {gl:.2f} + unbilled {unbilled:.2f}")
	print(f"      ({len(rows)} customers compared)")

	# 4. this month's cash in/out on the money page = cash and bank accounts in the ledger
	m = simple.money3()
	start, end = get_first_day(nowdate()), get_last_day(nowdate())
	cash = [a[0] for a in frappe.db.sql("select name from `tabAccount` where company=%s and account_type in ('Cash','Bank') and is_group=0", company)] or [""]
	gin = flt(frappe.db.sql("""select sum(debit) from `tabGL Entry` where is_cancelled=0 and is_opening='No' and posting_date between %s and %s
		and account in %s""", (start, end, cash))[0][0])
	shown = {k: v for k, v in m.items() if isinstance(v, (int, float))}
	print(f"      money page numbers: {shown}")
	print(f"      ledger cash in this month (all cash/bank debits, transfers included): {gin:.2f}")

	# 5. orders: what the board says is paid never exceeds the order, and a fully invoiced order's «left» = its invoices' outstanding
	for o in api._order_rows({"docstatus": 1, "company": company}, limit=0):
		if flt(o.paid) - flt(o.grand_total) > 0.01:
			diffs += _line(False, f"order {o.name}: paid {o.paid} > total {o.grand_total}")
		if flt(o.per_billed) >= 100:
			out = flt(frappe.db.sql("""select sum(si.outstanding_amount) from `tabSales Invoice` si where si.docstatus=1 and si.name in
				(select distinct parent from `tabSales Invoice Item` where sales_order=%s)""", o.name)[0][0])
			if abs(max(0, flt(o.grand_total) - flt(o.paid)) - max(0, out)) > 0.01:
				diffs += _line(False, f"order {o.name}: board left {flt(o.grand_total) - flt(o.paid):.2f} vs invoices outstanding {out:.2f}")
	print("      (orders checked)")

	# 6. no negative stock
	neg = frappe.db.sql("select item_code, warehouse, actual_qty from `tabBin` where actual_qty < -0.0001 limit 5")
	diffs += _line(not neg, "no negative stock", str(neg))

	# 7. advances not swallowed: an unallocated receipt tagged for an order that is already fully invoiced
	if frappe.db.has_column("Payment Entry", "atelier_order"):
		stuck = frappe.db.sql("""select pe.name, pe.atelier_order, pe.unallocated_amount from `tabPayment Entry` pe join `tabSales Order` so on so.name=pe.atelier_order
			where pe.docstatus=1 and pe.unallocated_amount > 0.01 and so.per_billed >= 100 limit 5""")
		diffs += _line(not stuck, "no advance left unallocated on a fully invoiced order", str(stuck))

	print(f"\n{diffs} differences")
	if rollback:
		frappe.db.rollback()
	return diffs


def nightly():
	"""Daily job: run the check quietly; on any difference, an in-app alert to each manager with the lines found."""
	import contextlib
	import io

	out = io.StringIO()
	with contextlib.redirect_stdout(out):
		diffs = run(rollback=False)  # it only reads
	frappe.db.set_default("atelier_books_check", frappe.as_json({"at": frappe.utils.now(), "differences": diffs}))
	if not diffs:
		return
	lines = [l for l in out.getvalue().splitlines() if l.startswith("DIFF")][:5]
	from atelier.simple import app_role

	for user in frappe.get_all("User", filters={"enabled": 1, "user_type": "System User"}, pluck="name"):
		if app_role(user) == "manager" and user != "Guest":
			frappe.get_doc({"doctype": "Notification Log", "for_user": user, "type": "Alert", "document_type": "Company",
				"document_name": frappe.defaults.get_global_default("company"),
				"subject": f"فحص الدفاتر الليلي وجد {diffs} فرقًا — راجع: " + " | ".join(lines)[:120]}).insert(ignore_permissions=True)
	frappe.db.commit()
