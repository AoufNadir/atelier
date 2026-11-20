"""Cancelling an order and returning a delivered one: never by deleting a submitted document, always with the
document that reverses it, so the books stay readable.

- cancel_order: an order not delivered nor invoiced is cancelled; what the customer paid stays as his credit
  (an unallocated advance, used by his next invoice) or is paid back to him from a fund.
- create_return: a credit note on the order's invoice for the quantities chosen; when the customer then has money
  with us, it stays as credit or is paid back. Materials used are not put back in stock (spoiled printing).
"""

import frappe
from frappe import _
from frappe.utils import flt, nowdate

from atelier import api


def _manager():
	from atelier.simple import _manager_only

	_manager_only()


def _paid_on(so_name):
	"""Payments received for this order: linked to it, or kept on the customer with its name (priced later)."""
	linked = frappe.db.sql("""select sum(r.allocated_amount) from `tabPayment Entry Reference` r join `tabPayment Entry` pe on pe.name=r.parent
		where pe.docstatus=1 and r.reference_doctype='Sales Order' and r.reference_name=%s""", so_name)[0][0]
	tagged = frappe.db.sql("""select sum(paid_amount) from `tabPayment Entry` where docstatus=1 and payment_type='Receive' and atelier_order=%s""",
		so_name)[0][0] if frappe.db.has_column("Payment Entry", "atelier_order") else 0
	return max(flt(linked), flt(tagged))


def _refund(customer, amount, mode, remark):
	"""Money paid back to a customer: out of the fund of that payment method, against his account."""
	from erpnext.accounts.party import get_party_account

	company = api._company()
	amount = flt(amount)
	if amount <= 0:
		return None
	if mode not in [m[0] for m in api.all_modes()]:
		frappe.throw(_("طريقة الدفع غير صالحة"))
	pe = frappe.get_doc({"doctype": "Payment Entry", "payment_type": "Pay", "company": company, "posting_date": nowdate(),
		"party_type": "Customer", "party": customer, "mode_of_payment": mode,
		"paid_from": api._cash_account(mode, company), "paid_to": get_party_account("Customer", customer, company),
		"paid_amount": amount, "received_amount": amount, "reference_no": "—", "reference_date": nowdate(),
		"remarks": remark[:140]})
	pe.insert(ignore_permissions=True)
	pe.submit()
	return pe.name


def _refund_against(invoice, amount, mode, remark):
	"""Pay back a negative outstanding with a journal: the customer's account against that invoice, out of the
	fund of the payment method. The invoice closes to zero (a Payment Entry refuses negative allocations here)."""
	if mode not in [m[0] for m in api.all_modes()]:
		frappe.throw(_("طريقة الدفع غير صالحة"))
	si = frappe.get_doc("Sales Invoice", invoice)
	amount = flt(amount)
	je = frappe.get_doc({"doctype": "Journal Entry", "voucher_type": "Journal Entry", "company": si.company, "posting_date": nowdate(),
		"mode_of_payment": mode, "cheque_no": "—", "cheque_date": nowdate(), "user_remark": remark[:140], "accounts": [
			{"account": si.debit_to, "party_type": "Customer", "party": si.customer, "debit_in_account_currency": amount,
				"reference_type": "Sales Invoice", "reference_name": invoice},
			{"account": api._cash_account(mode, si.company), "credit_in_account_currency": amount}]})
	je.flags.ignore_permissions = True
	je.insert()
	je.submit()
	return je.name


def _settle(inv, cn):
	"""Set the credit note against what is still owed on the invoice (a Credit Note journal on the customer's
	account), so both close as far as they can. ERPNext may keep a return's outstanding on itself."""
	si = frappe.get_doc("Sales Invoice", inv)
	note = frappe.get_doc("Sales Invoice", cn)
	amount = min(flt(si.outstanding_amount), -flt(note.outstanding_amount))
	if amount <= 0.005:
		return None
	row = {"account": si.debit_to, "party_type": "Customer", "party": si.customer}
	je = frappe.get_doc({"doctype": "Journal Entry", "voucher_type": "Credit Note", "company": si.company, "posting_date": nowdate(),
		"user_remark": _("تسوية {0} مع {1}").format(cn, inv)[:140], "accounts": [
			dict(row, debit_in_account_currency=amount, reference_type="Sales Invoice", reference_name=cn),
			dict(row, credit_in_account_currency=amount, reference_type="Sales Invoice", reference_name=inv)]})
	je.flags.ignore_permissions = True
	je.insert()
	je.submit()
	return je.name


def _unlink_advances(so):
	"""Free the order's advances: they stay on the customer as unallocated payments."""
	try:
		from erpnext.accounts.utils import unlink_ref_doc_from_payment_entries

		unlink_ref_doc_from_payment_entries(so)
	except ImportError:
		pass
	rows = frappe.db.sql("""select r.name, r.parent, r.allocated_amount from `tabPayment Entry Reference` r
		where r.reference_doctype='Sales Order' and r.reference_name=%s""", so.name)
	for row, pe, alloc in rows:
		if flt(alloc):
			frappe.db.sql("""update `tabPayment Entry` set unallocated_amount=unallocated_amount+%s, total_allocated_amount=total_allocated_amount-%s
				where name=%s""", (flt(alloc), flt(alloc), pe))
		frappe.db.sql("delete from `tabPayment Entry Reference` where name=%s", row)
	if frappe.db.table_exists("Payment Ledger Entry"):
		frappe.db.sql("""update `tabPayment Ledger Entry` set against_voucher_type=voucher_type, against_voucher_no=voucher_no
			where against_voucher_type='Sales Order' and against_voucher_no=%s""", so.name)
	frappe.local.message_log = []  # erpnext's English "un-linked" note is not shown


@frappe.whitelist()
def cancel_info(name):
	_manager()
	so = frappe.get_doc("Sales Order", name)
	return {"name": so.name, "title": so.get("atelier_subject") or so.name, "customer": so.customer, "customer_name": so.customer_name,
		"total": flt(so.grand_total), "paid": _paid_on(so.name), "delivered": flt(so.per_delivered) > 0, "billed": flt(so.per_billed) > 0,
		"modes": [{"value": v, "label": l} for v, l in api.all_modes()]}


@frappe.whitelist(methods=["POST"])
def cancel_order(name, refund_mode=None, reason=""):
	"""Cancel an order not delivered nor invoiced. refund_mode empty = what he paid stays his credit."""
	_manager()
	from atelier.simple import _log

	so = frappe.get_doc("Sales Order", name)
	if so.docstatus == 2:
		frappe.throw(_("الطلب ملغى من قبل"))
	if flt(so.per_delivered) > 0 or flt(so.per_billed) > 0:
		frappe.throw(_("سُلِّم أو فُوتر هذا الطلب: استعمل «إرجاع / فاتورة دائنة» بدل الإلغاء"))
	paid = _paid_on(so.name)
	reason = (reason or "").strip()[:140]
	if so.docstatus == 1:
		# the advance stays on the customer (unallocated) instead of blocking the cancellation
		frappe.db.set_single_value("Accounts Settings", "unlink_advance_payment_on_cancelation_of_order", 1)
		_unlink_advances(so)
		if frappe.db.has_column("Payment Entry", "atelier_order"):
			frappe.db.sql("update `tabPayment Entry` set atelier_order=null where atelier_order=%s", so.name)
		so.reload()
		so.ignore_linked_doctypes = tuple(so.get("ignore_linked_doctypes") or ()) + ("Payment Entry", "Payment Ledger Entry", "GL Entry")
		so.flags.ignore_permissions = True
		try:
			so.cancel()
		except frappe.LinkExistsError:
			frappe.db.rollback()
			frappe.throw(_("تعذّر إلغاء الطلب: ما زال مرتبطًا بمستند آخر معتمد (دفعة أو تسليم). لم يتغيّر شيء."))
	else:
		so.db_set("docstatus", 2, update_modified=True)  # a draft (priced later) is closed the same way, nothing posted
	if frappe.db.has_column("Payment Entry", "atelier_order"):
		frappe.db.sql("update `tabPayment Entry` set atelier_order=null where atelier_order=%s", so.name)
	if so.project and frappe.db.exists("Project", so.project):
		frappe.db.set_value("Project", so.project, "status", "Cancelled")
	refund = _refund(so.customer, paid, refund_mode, _("استرداد إلغاء طلب {0}").format(so.name)) if refund_mode and paid > 0 else None
	_log(so.name, _("ألغى الطلب") + (" — " + reason if reason else "") + (
		_(" · رُدّ {0}").format(frappe.format_value(paid, {"fieldtype": "Currency"})) if refund else (_(" · بقي ما دفعه رصيدًا له") if paid > 0 else "")))
	return {"cancelled": so.name, "refund": refund, "credit": 0 if refund else paid}


@frappe.whitelist()
def return_info(name):
	"""The order's invoice lines that can still be returned."""
	_manager()
	inv = _invoice_of(name)
	si = frappe.get_doc("Sales Invoice", inv)
	returned = {}
	for r in frappe.db.sql("""select sii.sales_invoice_item, -sum(sii.qty) from `tabSales Invoice Item` sii join `tabSales Invoice` si on si.name=sii.parent
		where si.docstatus=1 and si.is_return=1 and si.return_against=%s group by sii.sales_invoice_item""", inv):
		returned[r[0]] = flt(r[1])
	lines = [{"row": i.name, "item_name": frappe.utils.strip_html(i.description or "") or i.item_name, "qty": flt(i.qty),
		"left": flt(i.qty) - returned.get(i.name, 0), "rate": flt(i.rate),
		"whole": bool(frappe.db.get_value("UOM", i.uom, "must_be_whole_number"))} for i in si.items]
	notes = flt(frappe.db.sql("""select sum(outstanding_amount) from `tabSales Invoice` where docstatus=1 and is_return=1 and return_against=%s""", inv)[0][0])
	return {"invoice": inv, "customer": si.customer, "customer_name": si.customer_name, "outstanding": flt(si.outstanding_amount) + notes,
		"lines": lines, "modes": [{"value": v, "label": l} for v, l in api.all_modes()]}


def _invoice_of(so_name):
	inv = frappe.db.sql("""select distinct sii.parent from `tabSales Invoice Item` sii join `tabSales Invoice` si on si.name=sii.parent
		where sii.sales_order=%s and si.docstatus=1 and si.is_return=0 order by si.posting_date desc limit 1""", so_name)
	if not inv:
		frappe.throw(_("لا فاتورة لهذا الطلب بعد. الطلب غير المسلَّم يُلغى بدل أن يُرجَع."))
	return inv[0][0]


@frappe.whitelist(methods=["POST"])
def create_return(name, qtys, refund_mode=None, reason=""):
	"""Credit note on the order's invoice for qtys = {invoice row: qty}. With refund_mode, what the customer then has
	with us on that invoice is paid back; otherwise it stays his credit."""
	_manager()
	from erpnext.accounts.doctype.sales_invoice.sales_invoice import make_sales_return
	from atelier.simple import _log

	inv = _invoice_of(name)
	qtys = {k: flt(v) for k, v in (frappe.parse_json(qtys) or {}).items() if flt(v) > 0}
	if not qtys:
		frappe.throw(_("اختر كمية بند واحد على الأقل"))
	info = {l["row"]: l for l in return_info(name)["lines"]}
	for row, q in qtys.items():
		if row not in info or q > info[row]["left"] + 1e-9:
			frappe.throw(_("كمية الإرجاع أكبر من الباقي في الفاتورة"))
		if info[row]["whole"] and q != int(q):
			frappe.throw(_("وحدة «{0}» لا تقبل الكسور: اكتب عددًا صحيحًا").format(info[row]["item_name"]))
	cn = make_sales_return(inv)
	cn.items = [i for i in cn.items if i.sales_invoice_item in qtys]
	for i in cn.items:
		i.qty = -qtys[i.sales_invoice_item]
	cn.update_stock = 0  # spoiled printing does not go back on the shelf
	if cn.meta.has_field("update_outstanding_for_self"):
		cn.set("update_outstanding_for_self", 0)  # the return lowers what is owed on the original invoice
	cn.disable_rounded_total = 1
	cn.remarks = ((reason or "").strip() or _("إرجاع"))[:140]
	cn.flags.ignore_permissions = True
	cn.insert()
	cn.submit()
	notes = frappe.get_all("Sales Invoice", filters={"docstatus": 1, "is_return": 1, "return_against": inv}, pluck="name", order_by="creation")
	for n in notes:  # earlier returns too, so nothing is left open between them
		_settle(inv, n)
	# what the customer now has with us: the negative outstanding left on the invoice or on its credit notes
	neg = [(n, -flt(o)) for n in [inv] + notes for o in [frappe.db.get_value("Sales Invoice", n, "outstanding_amount")] if flt(o) < -0.005]
	si = frappe.get_doc("Sales Invoice", inv)
	cn.reload()
	excess = sum(a for _n, a in neg)
	refund = None
	if refund_mode and excess > 0.005:
		refund = ", ".join(_refund_against(n, a, refund_mode, _("استرداد إرجاع {0}").format(cn.name)) for n, a in neg)
	_log(name, _("إرجاع {0} بقيمة {1}").format(cn.name, frappe.format_value(-flt(cn.grand_total), {"fieldtype": "Currency"}))
		+ (" — " + reason.strip()[:80] if (reason or "").strip() else ""))
	return {"credit_note": cn.name, "amount": -flt(cn.grand_total), "refund": refund, "credit": 0 if refund else max(0, excess)}
