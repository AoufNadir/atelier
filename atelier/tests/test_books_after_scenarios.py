"""Every money path the workshop uses, one after the other, then the whole book is checked (books_check):
balances, invoice outstanding, customer balances, orders, stock. Rolled back afterwards; test sites only."""

import json
import unittest

import frappe
from frappe.utils import flt

from atelier import api, books_check, materials, opening, returns, simple
from atelier.tests.test_finance_paths import _customer, _deliver, _order


class TestBooksAfterScenarios(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		frappe.db.savepoint("books")

	def tearDown(self):
		frappe.db.rollback(save_point="books")
		frappe.local.message_log = []

	def test_all_paths_then_the_books_agree(self):
		cust, company = _customer(), api._company()
		# sales: advance, delivery, payment after the invoice
		so = _order(3000, advance=1000)
		inv = _deliver(so)
		api.record_payment(cust, 500, "Cash", so)
		# priced later with an advance
		so2 = _order(None, advance=500)
		api.price_order(so2, json.dumps({frappe.get_doc("Sales Order", so2).items[0].name: 2000}))
		_deliver(so2)
		# cancellations
		returns.cancel_order(_order(900, advance=300))
		returns.cancel_order(_order(900, advance=300), refund_mode="Cash")
		# returns: partial as credit, then the rest paid back
		so3 = _order(3000, advance=2000, qty=4)
		inv3 = _deliver(so3)
		row = frappe.get_doc("Sales Invoice", inv3).items[0].name
		returns.create_return(so3, json.dumps({row: 1}))
		returns.create_return(so3, json.dumps({row: 3}), refund_mode="Cash")
		# partial delivery then the rest
		res = simple.quick_order(json.dumps({"customer": cust, "subject": "جزئي", "advance": 500, "mode": "Cash",
			"lines": [{"text": "أ", "qty": 1, "rate": 400}, {"text": "ب", "qty": 1, "rate": 600}]}, ensure_ascii=False))
		so4 = res["sales_order"]
		simple.partial_deliver(so4, json.dumps({frappe.get_doc("Sales Order", so4).items[0].name: 1}))
		simple.move(so4, "done")
		# materials: buy (part paid), pay the rest, issue to an order
		supplier = frappe.db.get_value("Supplier", {}, "name") or frappe.get_doc({"doctype": "Supplier", "supplier_name": "مورد اختبار",
			"supplier_group": frappe.db.get_value("Supplier Group", {"is_group": 0})}).insert().name
		item = materials.add_material("ورق اختبار الدفاتر", "Nos")
		bill = materials.purchase_bill(supplier, json.dumps([{"item_code": item, "qty": 100, "rate": 10}]), paid=400)
		simple.pay_supplier(bill["invoice"], "Cash")
		materials.stock_issue(item, 30, so, "اختبار")
		# an expense, a transfer, a cash count short by 200
		acc = api.expense_options()["accounts"][0]["name"]
		api.record_expense(acc, 250, "Cash", "مصروف اختبار")
		cash = api._cash_account("Cash", company)
		bank = frappe.db.get_value("Account", {"company": company, "account_type": "Bank", "is_group": 0}, "name")
		if bank:
			simple.transfer_funds(cash, bank, 100)
		from erpnext.accounts.utils import get_balance_on

		simple.close_cash(cash, flt(get_balance_on(cash)) - 200)
		# opening debts and a reversal
		j = opening.add_opening("Customer", cust, 12500)["journal"]
		opening.reverse_opening(j)
		opening.add_opening("Supplier", supplier, 3000)

		self.assertEqual(books_check.run(rollback=False), 0)

	def test_three_pack_cycles_give_the_real_cost(self):
		"""4 reams of 100 sheets at 1,000 each (10 a sheet). Three cycles: 80, 75 and 90 sheets recorded on orders,
		each ream then finished. Real cost = 3 × 1,000 ÷ (80 + 75 + 90) = 12.24 a recorded sheet; stock only goes down."""
		from erpnext.stock.utils import get_stock_balance

		supplier = frappe.db.get_value("Supplier", {}, "name")
		item = materials.add_material("ورق دورات اختبار", "Nos", family="paper", packs=json.dumps({"pack": "رزمة", "pack_qty": 100}))
		materials.purchase_bill(supplier, json.dumps([{"item_code": item, "qty": 4, "rate": 1000, "uom": "رزمة"}]), paid=0)
		store = materials.store_for(api._company())
		self.assertAlmostEqual(flt(get_stock_balance(item, store)), 400, places=2)
		so = _order(1000)
		last = 400
		for used in (80, 75, 90):
			materials.stock_issue(item, used, so, "اختبار دورة")
			res = materials.close_pack(item)
			stock = flt(get_stock_balance(item, store))
			self.assertLessEqual(stock, last - used + 1e-6)  # closing never adds stock
			self.assertGreaterEqual(res["coverage"], 70)
			last = stock
		d = materials.material_ledger(item)
		self.assertEqual(d["good_cycles"], 3)
		self.assertAlmostEqual(d["real_cost"], 3000 / 245, places=2)
		self.assertEqual(books_check.run(rollback=False), 0)

	def test_merge_two_customers_moves_everything(self):
		from erpnext.accounts.utils import get_balance_on

		def new(name):
			return frappe.get_doc({"doctype": "Customer", "customer_name": name, "customer_type": "Company",
				"customer_group": frappe.db.get_value("Customer Group", {"is_group": 0}), "territory": frappe.db.get_value("Territory", {"is_group": 0})}).insert().name

		a, b = new("مكرر الدمج أ"), new("مكرر الدمج ب")
		so_a = json.loads(json.dumps(simple.quick_order(json.dumps({"customer": a, "subject": "أ", "advance": 300, "mode": "Cash",
			"lines": [{"text": "x", "qty": 1, "rate": 1000}]}, ensure_ascii=False))))["sales_order"]
		inv_a = _deliver(so_a)  # 1000 − 300 advance = 700 open
		opening.add_opening("Customer", a, 2000)
		so_b = simple.quick_order(json.dumps({"customer": b, "subject": "ب", "lines": [{"text": "y", "qty": 1, "rate": 500}]}, ensure_ascii=False))["sales_order"]
		company = api._company()
		total = flt(get_balance_on(party_type="Customer", party=a, company=company)) + flt(get_balance_on(party_type="Customer", party=b, company=company))
		simple.merge_customers(a, b)
		self.assertFalse(frappe.db.exists("Customer", a))
		self.assertEqual(frappe.db.get_value("Sales Invoice", inv_a, "customer"), b)
		self.assertEqual(frappe.db.get_value("Sales Order", so_a, "customer"), b)
		self.assertAlmostEqual(flt(frappe.db.get_value("Sales Invoice", inv_a, "outstanding_amount")), 700, places=2)
		self.assertAlmostEqual(flt(get_balance_on(party_type="Customer", party=b, company=company)), total, places=2)
		self.assertFalse(frappe.db.exists("GL Entry", {"party_type": "Customer", "party": a}))
		self.assertFalse(frappe.db.exists("Payment Ledger Entry", {"party_type": "Customer", "party": a}))
		row = next(r for r in simple.customers2()["rows"] if r.name == b)
		self.assertAlmostEqual(flt(row.balance), total + 500, places=2)  # + the open order not yet invoiced
		self.assertEqual(books_check.run(rollback=False), 0)
