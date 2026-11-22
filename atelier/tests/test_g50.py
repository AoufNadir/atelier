"""The monthly TVA return: collected on sales (credit notes deducted) − recoverable on purchases = to pay; paying it
clears both accounts and takes the money from the fund."""

import json
import unittest

import frappe
from frappe.utils import add_days, flt, get_last_day, nowdate

from atelier import api, materials, returns, simple, tva
from atelier.tests.test_finance_paths import _customer, _deliver


class TestG50(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		frappe.db.savepoint("g50")
		self.saved = simple.doc_settings()
		simple.save_doc_settings(json.dumps({**self.saved, "tva": 1, "tva_rate": 19}))
		frappe.clear_cache()

	def tearDown(self):
		frappe.flags.atelier_today = None
		frappe.db.rollback(save_point="g50")
		simple.save_doc_settings(json.dumps(self.saved))
		frappe.clear_cache()

	def test_collected_minus_recoverable_and_payment(self):
		before = tva.g50()
		so = simple.quick_order(json.dumps({"customer": _customer(), "subject": "G50", "lines": [{"text": "x", "qty": 2, "rate": 5000}]}, ensure_ascii=False))["sales_order"]
		inv = _deliver(so)  # 10,000 + 1,900
		returns.create_return(so, json.dumps({frappe.get_doc("Sales Invoice", inv).items[0].name: 1}))  # − 5,000 − 950
		item = materials.add_material("ورق G50", "Nos")
		materials.purchase_bill(frappe.db.get_value("Supplier", {}, "name"), json.dumps([{"item_code": item, "qty": 10, "rate": 100}]), paid=0, tva_rate=19)  # 190
		d = tva.g50()
		self.assertAlmostEqual(d["collected"] - before["collected"], 1900 - 950, places=2)
		self.assertAlmostEqual(d["deductible"] - before["deductible"], 190, places=2)
		self.assertAlmostEqual(d["due"], d["collected"] - d["deductible"], places=2)
		with self.assertRaises(frappe.ValidationError):
			tva.pay_g50(d["month"])  # the month is not over
		api.record_payment(_customer(), 20000, "Cash")  # money in the box to pay with
		frappe.flags.atelier_today = add_days(get_last_day(nowdate()), 1)
		res = tva.pay_g50(d["month"])
		self.assertTrue(res["paid"])
		self.assertAlmostEqual(flt(frappe.db.get_value("Journal Entry", res["journal"], "total_credit")), d["collected"], places=2)
		with self.assertRaises(frappe.ValidationError):
			tva.pay_g50(d["month"])  # never twice
