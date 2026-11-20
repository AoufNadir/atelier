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
