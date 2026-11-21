"""What a hurried or careless user might type: each must be refused with an Arabic message, never booked."""

import json
import unittest

import frappe
from frappe.utils import flt

from atelier import api, simple
from atelier.tests.test_finance_paths import _customer, _deliver, _order


def _arabic(e):
	return any("؀" <= ch <= "ۿ" for ch in str(e))


class TestIllogicalInputs(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		frappe.db.savepoint("ill")

	def tearDown(self):
		frappe.db.rollback(save_point="ill")
		frappe.local.message_log = []

	def refused(self, fn, *a, **k):
		with self.assertRaises(frappe.ValidationError) as cm:
			fn(*a, **k)
		self.assertTrue(_arabic(cm.exception), f"message not in Arabic: {cm.exception}")

	def _cash(self):
		return api._cash_account("Cash", api._company())

	def _balance(self, acc):
		from erpnext.accounts.utils import get_balance_on

		return flt(get_balance_on(acc))

	def test_negative_price_refused(self):
		self.refused(simple.quick_order, json.dumps({"customer": _customer(), "subject": "x", "lines": [{"text": "x", "qty": 1, "rate": -100}]}, ensure_ascii=False))

	def test_zero_or_negative_quantity_refused(self):
		self.refused(simple.quick_order, json.dumps({"customer": _customer(), "subject": "x", "lines": [{"text": "x", "qty": -2, "rate": 100}]}, ensure_ascii=False))

	def test_advance_larger_than_order_refused(self):
		self.refused(simple.quick_order, json.dumps({"customer": _customer(), "subject": "x", "advance": 5000, "mode": "Cash",
			"lines": [{"text": "x", "qty": 1, "rate": 1000}]}, ensure_ascii=False))

	def test_negative_payment_refused(self):
		self.refused(api.record_payment, _customer(), -500, "Cash")

	def test_transfer_more_than_the_box_holds_refused(self):
		cash = self._cash()
		bank = frappe.db.get_value("Account", {"company": api._company(), "account_type": "Bank", "is_group": 0}, "name")
		self.refused(simple.transfer_funds, cash, bank, self._balance(cash) + 1000)

	def test_expense_more_than_the_box_holds_refused(self):
		acc = api.expense_options()["accounts"][0]["name"]
		self.refused(api.record_expense, acc, self._balance(self._cash()) + 1000, "Cash", "أكثر من الصندوق")

	def test_negative_expense_refused(self):
		acc = api.expense_options()["accounts"][0]["name"]
		self.refused(api.record_expense, acc, -50, "Cash", "سالب")

	def test_invoice_twice_refused(self):
		so = _order(1000)
		_deliver(so)
		self.refused(api.invoice_order, so)

	def test_cancel_delivered_order_refused(self):
		from atelier import returns

		so = _order(1000)
		_deliver(so)
		self.refused(returns.cancel_order, so)

	def test_return_more_than_sold_refused(self):
		from atelier import returns

		so = _order(1000)
		inv = _deliver(so)
		self.refused(returns.create_return, so, json.dumps({frappe.get_doc("Sales Invoice", inv).items[0].name: 5}))

	def test_cash_count_negative_refused(self):
		self.refused(simple.close_cash, self._cash(), -10)

	def test_supplier_payment_more_than_the_box_holds_refused(self):
		from atelier import materials

		supplier = frappe.db.get_value("Supplier", {}, "name")
		item = materials.add_material("ورق اختبار الرصيد", "Nos")
		big = self._balance(self._cash()) + 5000
		bill = materials.purchase_bill(supplier, json.dumps([{"item_code": item, "qty": 1, "rate": big}]), paid=0)
		self.refused(simple.pay_supplier, bill["invoice"], "Cash")
