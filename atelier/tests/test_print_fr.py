"""French documents: title, amount in words, the service's French name; Arabic stays the default."""

import unittest

import frappe

from atelier import printing
from atelier.tests.test_finance_paths import _deliver, _order


class TestPrintFr(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		frappe.db.savepoint("pfr")

	def tearDown(self):
		frappe.form_dict.pop("lang", None)
		frappe.db.rollback(save_point="pfr")

	def test_words(self):
		self.assertIn("mille", printing.tafqit(1500, "fr").lower())
		self.assertIn("6 000,00", printing.dz_money(6000, "fr").replace(" ", " ").replace("\xa0", " "))

	def test_invoice_french(self):
		inv = frappe.get_doc("Sales Invoice", _deliver(_order(1000)))
		self.assertEqual(printing.doc_lang(inv), "ar")
		frappe.form_dict.lang = "fr"
		c = printing.print_context(inv)
		self.assertEqual(c["lang"], "fr")
		self.assertIn("Facture", c["title"])
		self.assertIn("Facture", frappe.get_print("Sales Invoice", inv.name, doc=inv))
		# a real service row shows its French name
		code = frappe.db.get_value("Item", {"is_sales_item": 1, "is_stock_item": 0, "name": ["!=", "SRV-GENERAL"]}, "name")
		frappe.db.set_value("Item", code, "atelier_name_fr", "Carte de visite")
		self.assertEqual(printing.item_name(frappe._dict(item_code=code, item_name="x"), "fr"), "Carte de visite")
		self.assertEqual(printing.item_name(frappe._dict(item_code=code, item_name="x"), "ar"), "x")
