"""Excel import: check (new / exists / error), all-or-nothing run, nothing replaced, opening debts booked."""

import base64
import unittest

import frappe
from frappe.utils import flt
from frappe.utils.xlsxutils import make_xlsx

from atelier import importer


def _file(kind, rows):
	head = [c[0] for c in importer.KINDS[kind][1]]
	return base64.b64encode(make_xlsx([head] + rows, "x").getvalue()).decode()


class TestImport(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		frappe.db.savepoint("imp")

	def tearDown(self):
		frappe.db.rollback(save_point="imp")

	def test_customers_check_and_run(self):
		f = _file("customers", [
			["زبون استيراد أ", "0661 99 88 77", "مؤسسة", "", "RC-1", "", "سطيف", "fr", ""],
			["زبون استيراد أ", "0661 00 00 01", "فرد", "", "", "", "", "", ""],      # duplicate in file
			["", "0550 00 00 00", "فرد", "", "", "", "", "", ""],                    # no name
			["زبون استيراد ب", "06612", "فرد", "", "", "", "", "", ""],               # bad phone
			["زبون استيراد ج", "", "شركه", "", "", "", "", "", ""],                   # bad type
		])
		r = importer.import_check("customers", f)
		self.assertEqual(r["count"], {"new": 1, "exists": 1, "error": 3})
		self.assertEqual(importer.import_run("customers", f)["imported"], 1)
		c = frappe.get_doc("Customer", {"customer_name": "زبون استيراد أ"})
		self.assertEqual(c.customer_type, "Company")
		self.assertEqual(c.atelier_doc_lang, "fr")
		# a second run: everything is already there, nothing replaced
		self.assertEqual(importer.import_check("customers", f)["count"]["new"], 0)

	def test_services_and_materials(self):
		importer.import_run("services", _file("services", [["خدمة استيراد", "Service import", "طباعة", "قطعة", 15, 12, "خدمة"]]))
		code = frappe.db.get_value("Item", {"item_name": "خدمة استيراد"})
		self.assertEqual(frappe.db.get_value("Item", code, "atelier_name_fr"), "Service import")
		self.assertEqual(flt(frappe.db.get_value("Item Price", {"item_code": code, "price_list_rate": 15}, "price_list_rate")), 15)
		bad = _file("materials", [["مادة استيراد", "ورقة", 10, 100, ""]])
		self.assertEqual(importer.import_check("materials", bad)["count"]["error"], 1)  # opening qty without a price
		importer.import_run("materials", _file("materials", [["مادة استيراد", "ورقة", 10, 100, "1,5"]]))
		m = frappe.db.get_value("Item", {"item_name": "مادة استيراد"})
		self.assertAlmostEqual(flt(frappe.db.get_value("Bin", {"item_code": m}, "stock_value")), 150, places=2)

	def test_opening_and_all_or_nothing(self):
		importer.import_run("customers", _file("customers", [["زبون دين قديم", "", "فرد", "", "", "", "", "", ""]]))
		f = _file("opening", [["عميل", "زبون دين قديم", "12 000", "", ""], ["عميل", "غير موجود أبدًا", 500, "", ""],
			["عميل", "زبون دين قديم", 10, "01/01/1990", ""]])
		r = importer.import_check("opening", f)
		self.assertEqual(r["count"], {"new": 1, "exists": 0, "error": 2})
		importer.import_run("opening", f)
		from erpnext.accounts.utils import get_balance_on

		party = frappe.db.get_value("Customer", {"customer_name": "زبون دين قديم"})
		self.assertAlmostEqual(flt(get_balance_on(party_type="Customer", party=party)), 12000, places=2)
		self.assertEqual(importer.import_check("opening", f)["count"]["exists"], 1)
		# a row failing while writing undoes the whole file
		orig = importer.WRITERS["suppliers"]
		calls = []

		def boom(row):
			calls.append(row["name"])
			if len(calls) == 2:
				raise frappe.ValidationError("x")
			orig(row)

		importer.WRITERS["suppliers"] = boom
		try:
			with self.assertRaises(frappe.ValidationError):
				importer.import_run("suppliers", _file("suppliers", [["مورد أ للاستيراد", "", "", "", "", "", ""], ["مورد ب للاستيراد", "", "", "", "", "", ""]]))
		finally:
			importer.WRITERS["suppliers"] = orig
		self.assertFalse(frappe.db.exists("Supplier", {"supplier_name": "مورد أ للاستيراد"}))

	def test_wrong_file(self):
		with self.assertRaises(frappe.ValidationError):
			importer.import_check("customers", base64.b64encode(b"not excel").decode())
