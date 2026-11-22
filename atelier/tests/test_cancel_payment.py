"""Cancelling a payment: invoices open again, the box gives the money back, a reason is required, manager only,
the box cannot go negative."""

import json
import unittest

import frappe
from frappe.utils import flt

from atelier import api, returns, simple
from atelier.tests.test_finance_paths import _customer, _deliver


class TestCancelPayment(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		frappe.db.savepoint("cp")

	def tearDown(self):
		frappe.set_user("Administrator")
		frappe.db.rollback(save_point="cp")

	def _balance(self):
		from erpnext.accounts.utils import get_balance_on

		return flt(get_balance_on(party_type="Customer", party=_customer(), company=api._company()))

	def test_cancel_reopens_invoice(self):
		so = simple.quick_order(json.dumps({"customer": _customer(), "subject": "إلغاء دفعة", "mode": "Cash",
			"lines": [{"text": "x", "qty": 1, "rate": 1000}]}, ensure_ascii=False))["sales_order"]
		inv = _deliver(so)
		before = self._balance()
		api.record_payment(_customer(), 1000, "Cash", so)
		self.assertAlmostEqual(flt(frappe.db.get_value("Sales Invoice", inv, "outstanding_amount")), 0, places=2)
		pe = frappe.get_all("Payment Entry", filters={"party": _customer(), "docstatus": 1}, order_by="creation desc", limit=1, pluck="name")[0]
		with self.assertRaises(frappe.ValidationError):
			returns.cancel_payment(pe, "")
		returns.cancel_payment(pe, "مبلغ خاطئ")
		self.assertEqual(frappe.db.get_value("Payment Entry", pe, "docstatus"), 2)
		self.assertAlmostEqual(flt(frappe.db.get_value("Sales Invoice", inv, "outstanding_amount")), 1000, places=2)
		self.assertAlmostEqual(self._balance(), before, places=2)
		with self.assertRaises(frappe.ValidationError):
			returns.cancel_payment(pe, "مرة ثانية")

	def test_box_cannot_go_negative(self):
		api.record_payment(_customer(), 500, "Cash")
		pe = frappe.get_all("Payment Entry", filters={"party": _customer(), "docstatus": 1}, order_by="creation desc", limit=1, pluck="name")[0]
		cash = frappe.db.get_value("Payment Entry", pe, "paid_to")
		from erpnext.accounts.utils import get_balance_on

		have = flt(get_balance_on(cash))
		bank = frappe.db.get_value("Account", {"company": api._company(), "account_type": "Bank", "is_group": 0}, "name")
		simple.transfer_funds(cash, bank, have)  # the box is emptied after the payment
		with self.assertRaises(frappe.ValidationError):
			returns.cancel_payment(pe, "خطأ")
