"""«دين سابق»: what a customer owed us (or we owed a supplier) before the shop started on نَسَق.

An opening journal (is_opening = Yes) on the party's account against the temporary opening account: it is part of
the party's balance and can be settled by later payments, but it is never sales, profit or a cash movement.
A mistake is corrected with a reversing journal linked to it (reversal_of), never by deleting it. Manager only.
"""

import frappe
from frappe import _
from frappe.utils import flt, getdate, nowdate

from atelier import api

PARTIES = ("Customer", "Supplier")


def _manager():
	from atelier.simple import _manager_only

	_manager_only()


def _opening_account(company):
	acc = frappe.db.get_value("Account", {"company": company, "account_type": "Temporary", "is_group": 0}, "name")
	if acc:
		return acc
	parent = frappe.db.get_value("Account", {"company": company, "root_type": "Liability", "is_group": 1}, "name", order_by="lft")
	doc = frappe.get_doc({"doctype": "Account", "company": company, "account_name": _("أرصدة افتتاحية"), "parent_account": parent,
		"account_type": "Temporary", "root_type": "Liability", "is_group": 0})
	doc.insert(ignore_permissions=True)
	return doc.name


def _check(party_type, party):
	if party_type not in PARTIES:
		frappe.throw(_("نوع غير صالح"))
	if not frappe.db.exists(party_type, party):
		frappe.throw(_("غير موجود"))


@frappe.whitelist()
def opening_info(party_type, party):
	_manager()
	_check(party_type, party)
	rows = frappe.db.sql("""select je.name, je.posting_date, je.user_remark, je.reversal_of,
		sum(jea.debit_in_account_currency - jea.credit_in_account_currency) amount
		from `tabJournal Entry` je join `tabJournal Entry Account` jea on jea.parent=je.name
		where je.docstatus=1 and je.is_opening='Yes' and jea.party_type=%s and jea.party=%s
		group by je.name order by je.posting_date, je.creation""", (party_type, party), as_dict=True)
	reversed_ = {r.reversal_of for r in rows if r.reversal_of}
	sign = 1 if party_type == "Customer" else -1
	for r in rows:
		r.amount = sign * flt(r.amount)
		r.reversed = r.name in reversed_
	return {"entries": rows, "total": sum(r.amount for r in rows)}


def _journal(party_type, party, amount, date, remark, reversal_of=None):
	from erpnext.accounts.party import get_party_account

	company = api._company()
	account = get_party_account(party_type, party, company)
	# a customer owes us: debit his account; we owe a supplier: credit his account. A reversal swaps the sides.
	debit_party = (party_type == "Customer") != bool(reversal_of)
	side = lambda dr: {"debit_in_account_currency": amount} if dr else {"credit_in_account_currency": amount}  # noqa: E731
	je = frappe.get_doc({"doctype": "Journal Entry", "voucher_type": "Opening Entry", "is_opening": "Yes", "company": company,
		"posting_date": date, "user_remark": remark[:140], "reversal_of": reversal_of, "accounts": [
			{"account": account, "party_type": party_type, "party": party, **side(debit_party)},
			{"account": _opening_account(company), **side(not debit_party)}]})
	je.flags.ignore_permissions = True
	je.insert()
	je.submit()
	return je.name


@frappe.whitelist(methods=["POST"])
def add_opening(party_type, party, amount, date=None, remark=""):
	"""Record what the party owed (customer) or was owed (supplier) before نَسَق."""
	_manager()
	_check(party_type, party)
	amount = flt(amount)
	if amount <= 0:
		frappe.throw(_("اكتب مبلغًا أكبر من صفر"))
	date = date or nowdate()
	if getdate(date) > getdate(nowdate()):
		frappe.throw(_("تاريخ الدين السابق لا يكون في المستقبل"))
	note = (remark or "").strip() or _("دين سابق (قبل نَسَق)")
	name = _journal(party_type, party, amount, date, _("دين سابق: {0}").format(note) if not note.startswith(_("دين سابق")) else note)
	frappe.get_doc(party_type, party).add_comment("Comment", _("سجّل دينًا سابقًا {0} — {1}").format(
		frappe.format_value(amount, {"fieldtype": "Currency"}), name))
	return {"journal": name, **opening_info(party_type, party)}


@frappe.whitelist(methods=["POST"])
def reverse_opening(journal, reason=""):
	"""Correct a wrong opening debt with a journal that reverses it and points to it."""
	_manager()
	je = frappe.get_doc("Journal Entry", journal)
	row = next((a for a in je.accounts if a.party_type in PARTIES and a.party), None)
	if je.docstatus != 1 or je.is_opening != "Yes" or not row or je.get("reversal_of"):
		frappe.throw(_("هذا ليس دينًا سابقًا قابلًا للتصحيح"))
	if frappe.db.exists("Journal Entry", {"reversal_of": je.name, "docstatus": 1}):
		frappe.throw(_("صُحّح هذا الدين من قبل"))
	amount = flt(row.debit_in_account_currency) or flt(row.credit_in_account_currency)
	note = _("تصحيح دين سابق {0}").format(je.name) + (" — " + reason.strip()[:80] if (reason or "").strip() else "")
	name = _journal(row.party_type, row.party, amount, nowdate(), note, reversal_of=je.name)
	frappe.get_doc(row.party_type, row.party).add_comment("Comment", note + " — " + name)
	return {"journal": name, **opening_info(row.party_type, row.party)}
