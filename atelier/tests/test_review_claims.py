"""Six findings reported by an outside review, each reproduced as it was described. A failing test = the finding is
real; a passing one = the app already behaves correctly in that case."""

import json
import unittest

import frappe
from frappe.utils import flt

from atelier import api, returns, simple
from atelier.tests.test_finance_paths import _customer, _deliver, _order


class TestReviewClaims(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		frappe.db.savepoint("claims")
		self.saved_docs = simple.doc_settings()

	def tearDown(self):
		frappe.db.rollback(save_point="claims")
		simple.save_doc_settings(json.dumps(self.saved_docs))
		frappe.clear_cache()

	def _two_lines(self, advance=0, a=400, b=600):
		return simple.quick_order(json.dumps({"customer": _customer(), "subject": "مراجعة", "advance": advance, "mode": "Cash",
			"lines": [{"text": "أ", "qty": 1, "rate": a}, {"text": "ب", "qty": 1, "rate": b}]}, ensure_ascii=False))["sales_order"]

	def _app_balance(self):
		# the customer list's rule: ledger balance + what open orders still have to invoice
		gross = sum(flt(o.grand_total) * (1 - flt(o.per_billed) / 100) for o in api._order_rows(
			{"customer": _customer(), "docstatus": 1, "per_billed": ["<", 100], "status": ["!=", "Closed"]}, limit=0) if not o.price_pending)
		return self._ledger() + gross

	def _ledger(self):
		from erpnext.accounts.utils import get_balance_on

		return flt(get_balance_on(party_type="Customer", party=_customer(), company=api._company()))

	# 1. advance and TVA: an advance equal to the total WITH tax must be accepted, and the invoice must close to zero
	def test_1_advance_with_tva(self):
		simple.save_doc_settings(json.dumps({**self.saved_docs, "tva": 1, "tva_rate": 19}))
		frappe.clear_cache()
		res = simple.quick_order(json.dumps({"customer": _customer(), "subject": "TVA", "advance": 1190, "mode": "Cash",
			"lines": [{"text": "x", "qty": 1, "rate": 1000}]}, ensure_ascii=False))
		inv = frappe.get_doc("Sales Invoice", _deliver(res["sales_order"]))
		self.assertAlmostEqual(flt(inv.grand_total), 1190, places=2)
		self.assertAlmostEqual(flt(inv.outstanding_amount), 0, places=2)

	# 2. partial invoicing must not double the customer's debt in the app
	def test_2_partial_billing_does_not_double_the_debt(self):
		before_app, before_gl = self._app_balance(), self._ledger()
		so = self._two_lines(advance=500)
		simple.partial_deliver(so, json.dumps({frappe.get_doc("Sales Order", so).items[0].name: 1}))
		# owed now: 1000 ordered − 500 paid = 500, whatever was invoiced so far
		self.assertAlmostEqual(self._app_balance() - before_app, 500, places=2)
		self.assertAlmostEqual(self._ledger() - before_gl, 400 - 500, places=2)  # the books: 400 invoiced, 500 received

	# 3. one payment for an order with two open invoices must be spread over both
	def test_3_payment_spread_over_the_orders_invoices(self):
		so = self._two_lines()
		simple.partial_deliver(so, json.dumps({frappe.get_doc("Sales Order", so).items[0].name: 1}))
		simple.move(so, "done")
		api.record_payment(_customer(), 1000, "Cash", so)
		invs = returns._invoices_of(so)
		self.assertEqual(len(invs), 2)
		for i in invs:
			self.assertAlmostEqual(flt(frappe.db.get_value("Sales Invoice", i, "outstanding_amount")), 0, places=2, msg=i)

	# 4. an advance on a priced-later order stays linked to it and ends on its invoice
	def test_4_priced_later_advance_linked(self):
		so = _order(None, advance=300)
		self.assertTrue(frappe.db.get_value("Payment Entry", {"atelier_order": so, "docstatus": 1}))
		row = api._order_rows({"name": so}, limit=1)[0]
		self.assertAlmostEqual(flt(row.paid), 300, places=2)
		api.price_order(so, json.dumps({frappe.get_doc("Sales Order", so).items[0].name: 1000}))
		inv = frappe.get_doc("Sales Invoice", _deliver(so))
		self.assertAlmostEqual(flt(inv.outstanding_amount), 700, places=2)

	# 5. a return must lower the order's profit (revenue net of the credit note)
	def test_5_profit_report_counts_returns(self):
		so = _order(3000, qty=3)
		inv = _deliver(so)
		returns.create_return(so, json.dumps({frappe.get_doc("Sales Invoice", inv).items[0].name: 1}))
		from frappe.utils import nowdate

		rep = simple.reports2("custom", nowdate(), nowdate())
		row = next((r for r in rep["profit"] if r["name"] == so), None)
		self.assertIsNotNone(row)
		self.assertAlmostEqual(flt(row["revenue"]), 2000, places=2)

	# 6. a transfer between two funds must show its amount in the money movements, not 0
	def test_6_transfer_amount_in_movements(self):
		company = api._company()
		cash = api._cash_account("Cash", company)
		bank = frappe.db.get_value("Account", {"company": company, "account_type": "Bank", "is_group": 0}, "name")
		api.record_payment(_customer(), 900, "Cash")
		je = simple.transfer_funds(cash, bank, 250)
		m = simple.money3()
		moves = m.get("moves") or m.get("movements") or []
		row = next((x for x in moves if x.get("voucher_no") == je), None)
		self.assertIsNotNone(row, "transfer missing from the movements")
		self.assertAlmostEqual(abs(flt(row.get("amount"))), 250, places=2)
