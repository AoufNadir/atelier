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
		paid = sum(flt(frappe.db.get_value("Journal Entry", n, "total_debit")) for n in res["refund"].split(", "))
		self.assertAlmostEqual(paid, 2000, places=2)
		for n in [inv] + frappe.get_all("Sales Invoice", filters={"return_against": inv, "docstatus": 1}, pluck="name"):
			self.assertAlmostEqual(flt(frappe.db.get_value("Sales Invoice", n, "outstanding_amount")), 0, places=2)

	def _two_lines(self, advance=0):
		res = simple.quick_order(json.dumps({"customer": _customer(), "subject": "اختبار جزئي", "advance": advance, "mode": "Cash",
			"lines": [{"text": "لافتة", "qty": 1, "rate": 400}, {"text": "بطاقات", "qty": 1, "rate": 600}]}, ensure_ascii=False))
		return res["sales_order"]

	def test_partial_delivery_bills_only_delivered_and_advance_carries(self):
		so = self._two_lines(advance=500)
		first = frappe.get_doc("Sales Order", so).items[0].name
		r = simple.partial_deliver(so, json.dumps({first: 1}))
		inv1 = frappe.get_doc("Sales Invoice", r["invoice"])
		self.assertEqual(flt(inv1.grand_total), 400)
		self.assertAlmostEqual(flt(inv1.outstanding_amount), 0, places=2)  # 400 of the 500 advance
		self.assertFalse(r["complete"])
		simple.move(so, "done")  # the rest only, no duplicate
		invs = frappe.get_all("Sales Invoice Item", filters={"sales_order": so, "docstatus": 1}, pluck="parent", distinct=True)
		self.assertEqual(len(set(invs)), 2)
		inv2 = frappe.get_doc("Sales Invoice", [i for i in set(invs) if i != inv1.name][0])
		self.assertEqual(flt(inv2.grand_total), 600)
		self.assertAlmostEqual(flt(inv2.outstanding_amount), 500, places=2)  # the remaining 100 of the advance

	def test_opening_debt_is_balance_not_sales(self):
		from erpnext.accounts.utils import get_balance_on

		from atelier import opening

		cust = _customer()
		before = flt(get_balance_on(party_type="Customer", party=cust, company=api._company()))
		r = opening.add_opening("Customer", cust, 12500, remark="اختبار")
		self.assertEqual(frappe.db.get_value("Journal Entry", r["journal"], "is_opening"), "Yes")
		self.assertAlmostEqual(flt(get_balance_on(party_type="Customer", party=cust, company=api._company())) - before, 12500, places=2)
		income = frappe.db.sql("""select count(*) from `tabGL Entry` g join `tabAccount` a on a.name=g.account
			where g.voucher_no=%s and a.root_type='Income'""", r["journal"])[0][0]
		self.assertEqual(income, 0)
		back = opening.reverse_opening(r["journal"])
		self.assertEqual(frappe.db.get_value("Journal Entry", back["journal"], "reversal_of"), r["journal"])
		self.assertAlmostEqual(flt(get_balance_on(party_type="Customer", party=cust, company=api._company())), before, places=2)
		with self.assertRaises(frappe.ValidationError):
			opening.reverse_opening(r["journal"])

	def test_repeat_order_same_subject_is_accepted(self):
		a = simple.quick_order(json.dumps({"customer": _customer(), "subject": "بطاقات زيارة", "lines": [{"text": "x", "qty": 1, "rate": 100}]}, ensure_ascii=False))
		b = simple.quick_order(json.dumps({"customer": _customer(), "subject": "بطاقات زيارة", "lines": [{"text": "x", "qty": 1, "rate": 100}]}, ensure_ascii=False))
		self.assertNotEqual(a["sales_order"], b["sales_order"])

	def test_seller_can_deliver(self):
		from atelier.simple import save_user

		so = _order(500)
		save_user("seller-t@test.local", "Seller T", "sales")
		frappe.set_user("seller-t@test.local")
		try:
			simple.move(so, "done")
		finally:
			frappe.set_user("Administrator")
		self.assertEqual(flt(frappe.db.get_value("Sales Order", so, "per_billed")), 100)
		dn = frappe.db.get_value("Delivery Note Item", {"against_sales_order": so}, "parent")
		self.assertEqual(frappe.db.get_value("Delivery Note", dn, "owner"), "seller-t@test.local")

	def test_return_across_two_invoices_of_a_partial_delivery(self):
		so = self._two_lines(advance=500)
		simple.partial_deliver(so, json.dumps({frappe.get_doc("Sales Order", so).items[0].name: 1}))
		simple.move(so, "done")
		info = returns.return_info(so)
		self.assertEqual(len(info["invoices"]), 2)
		res = returns.create_return(so, json.dumps({l["row"]: l["left"] for l in info["lines"]}), refund_mode="Cash")
		self.assertEqual(len(res["credit_note"].split(", ")), 2)
		for inv in info["invoices"]:
			self.assertAlmostEqual(flt(frappe.db.get_value("Sales Invoice", inv, "outstanding_amount")), 0, places=2)
		paid = sum(flt(frappe.db.get_value("Journal Entry", n, "total_debit")) for n in (res["refund"] or "").split(", ") if n)
		self.assertAlmostEqual(paid, 500, places=2)  # the 500 advance comes back; the rest was never paid

	def test_credit_note_prints(self):
		from atelier.printing import tafqit

		self.assertIn("أربعمائة", tafqit(-400))
		so = _order(3000, qty=3)
		inv = _deliver(so)
		r = returns.create_return(so, json.dumps({frappe.get_doc("Sales Invoice", inv).items[0].name: 1}))
		html = frappe.get_print("Sales Invoice", r["credit_note"], print_format="الورشة — عربي — Sales Invoice")
		self.assertIn("فاتورة دائنة", html)
		self.assertIn(inv, html)

	def test_return_of_a_paid_part_settles_the_other_invoice(self):
		so = self._two_lines(advance=400)
		first = frappe.get_doc("Sales Order", so).items[0].name
		simple.partial_deliver(so, json.dumps({first: 1}))  # 400, paid by the advance
		simple.move(so, "done")  # 600 open
		info = returns.return_info(so)
		row = next(l["row"] for l in info["lines"] if abs(l["rate"] - 400) < 0.01)
		returns.create_return(so, json.dumps({row: 1}))
		out = {i: flt(frappe.db.get_value("Sales Invoice", i, "outstanding_amount")) for i in info["invoices"]}
		self.assertAlmostEqual(sum(out.values()), 200, places=2)  # 600 − the 400 returned
		o = api._order_rows({"name": so}, limit=1)[0]
		self.assertAlmostEqual(flt(o.grand_total) - flt(o.paid), 200, places=2)
