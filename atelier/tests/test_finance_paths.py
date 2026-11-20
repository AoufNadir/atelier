"""Financial paths on a real test site, each test rolled back afterwards.

Run only on a test site (never a real print shop):
    bench --site test-tour.localhost set-config allow_tests true
    bench --site test-tour.localhost run-tests --module atelier.tests.test_finance_paths

Each test checks the books, not the screen: outstanding, unallocated advances, refunds.
"""

import json
import unittest

import frappe
from frappe.utils import flt

from atelier import api, returns, simple


def _customer():
	name = "اختبار مالي آلي"
	if not frappe.db.exists("Customer", {"customer_name": name}):
		frappe.get_doc({"doctype": "Customer", "customer_name": name, "customer_group": frappe.db.get_value("Customer Group", {"is_group": 0}),
			"territory": frappe.db.get_value("Territory", {"is_group": 0})}).insert(ignore_permissions=True)
	return frappe.db.get_value("Customer", {"customer_name": name})


def _order(price, advance=0, qty=1):
	rate = None if price is None else flt(price) / qty
	res = simple.quick_order(json.dumps({"customer": _customer(), "subject": "اختبار",
		"lines": [{"text": "بند اختبار", "qty": qty, "rate": rate}], "advance": advance, "mode": "Cash"}, ensure_ascii=False))
	return res["sales_order"]


def _deliver(so):
	simple.move(so, "done")
	return returns._invoice_of(so)


def _unallocated(customer):
	return flt(frappe.db.sql("""select sum(unallocated_amount) from `tabPayment Entry`
		where docstatus=1 and party_type='Customer' and party=%s and payment_type='Receive'""", customer)[0][0])


class TestFinancePaths(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		frappe.db.savepoint("fin_test")

	def tearDown(self):
		frappe.db.rollback(save_point="fin_test")
		frappe.local.message_log = []

	def test_advance_is_deducted_on_delivery(self):
		so = _order(3000, advance=1000)
		inv = frappe.get_doc("Sales Invoice", _deliver(so))
		self.assertEqual(flt(inv.grand_total), 3000)
		self.assertEqual(flt(inv.outstanding_amount), 2000)

	def test_priced_later_advance_reaches_invoice(self):
		so = _order(None, advance=500)
		row = frappe.get_doc("Sales Order", so).items[0].name
		api.price_order(so, json.dumps({row: 2000}))
		self.assertEqual(frappe.db.get_value("Sales Order", so, "docstatus"), 1)
		inv = frappe.get_doc("Sales Invoice", _deliver(so))
		self.assertEqual(flt(inv.outstanding_amount), 1500)

	def test_cancel_keeps_advance_as_credit(self):
		cust = _customer()
		before = _unallocated(cust)
		so = _order(900, advance=300)
		returns.cancel_order(so)
		self.assertEqual(frappe.db.get_value("Sales Order", so, "docstatus"), 2)
		self.assertAlmostEqual(_unallocated(cust) - before, 300, places=2)

	def test_cancel_with_refund_pays_back(self):
		so = _order(900, advance=300)
		res = returns.cancel_order(so, refund_mode="Cash")
		self.assertTrue(res["refund"])
		pe = frappe.get_doc("Payment Entry", res["refund"])
		self.assertEqual((pe.payment_type, flt(pe.paid_amount)), ("Pay", 300))

	def test_full_return_with_refund_settles_everything(self):
		so = _order(3000, advance=1500)
		inv = _deliver(so)
		row = frappe.get_doc("Sales Invoice", inv).items[0].name
		res = returns.create_return(so, json.dumps({row: 1}), refund_mode="Cash")
		self.assertTrue(res["refund"])
		self.assertAlmostEqual(flt(frappe.db.get_value("Sales Invoice", inv, "outstanding_amount")), 0, places=2)
		self.assertAlmostEqual(flt(frappe.db.get_value("Sales Invoice", res["credit_note"], "outstanding_amount")), 0, places=2)

	def test_partial_return_lowers_debt(self):
		so = _order(3000, qty=3)
		inv = _deliver(so)
		row = frappe.get_doc("Sales Invoice", inv).items[0].name
		returns.create_return(so, json.dumps({row: 1}))
		self.assertAlmostEqual(flt(frappe.db.get_value("Sales Invoice", inv, "outstanding_amount")), 2000, places=2)

	def test_fraction_refused_on_whole_unit(self):
		so = _order(3000, qty=3)
		inv = _deliver(so)
		item = frappe.get_doc("Sales Invoice", inv).items[0]
		if not frappe.db.get_value("UOM", item.uom, "must_be_whole_number"):
			self.skipTest("unit accepts fractions")
		with self.assertRaises(frappe.ValidationError):
			returns.create_return(so, json.dumps({item.name: 0.75}))

	def test_two_returns_with_advance_refund_the_rest(self):
		so = _order(3000, advance=2000, qty=4)
		inv = _deliver(so)
		row = frappe.get_doc("Sales Invoice", inv).items[0].name
		returns.create_return(so, json.dumps({row: 1}))
		self.assertAlmostEqual(flt(frappe.db.get_value("Sales Invoice", inv, "outstanding_amount")), 250, places=2)
		res = returns.create_return(so, json.dumps({row: 3}), refund_mode="Cash")
		self.assertAlmostEqual(flt(frappe.db.get_value("Payment Entry", res["refund"].split(", ")[0], "paid_amount")), 2000, places=2)
		for n in [inv] + frappe.get_all("Sales Invoice", filters={"return_against": inv, "docstatus": 1}, pluck="name"):
			self.assertAlmostEqual(flt(frappe.db.get_value("Sales Invoice", n, "outstanding_amount")), 0, places=2)
