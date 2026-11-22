"""Closing a year: statements add up, the closing moves the result to account 12, and the closed year is frozen."""

import unittest

import frappe
from frappe.utils import flt

from atelier import api, yearend


class TestYearEnd(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		frappe.db.savepoint("ye")
		self.company = api._company()
		if not frappe.db.exists("Fiscal Year", "2025"):
			fy = frappe.get_doc({"doctype": "Fiscal Year", "year": "2025", "year_start_date": "2025-01-01", "year_end_date": "2025-12-31",
				"companies": [{"company": self.company}]})
			fy.insert(ignore_permissions=True)
		income = frappe.db.get_value("Account", {"company": self.company, "root_type": "Income", "is_group": 0, "account_number": ["like", "70%"]})
		cash = api._cash_account("Cash", self.company)
		frozen = frappe.db.get_value("Company", self.company, "accounts_frozen_till_date")
		self.assertFalse(frozen and str(frozen) >= "2025-06-01", "2025 already frozen on this site")
		je = frappe.get_doc({"doctype": "Journal Entry", "company": self.company, "posting_date": "2025-06-01", "user_remark": "بيع 2025",
			"accounts": [{"account": cash, "debit_in_account_currency": 5000}, {"account": income, "credit_in_account_currency": 5000,
				"cost_center": frappe.db.get_value("Company", self.company, "cost_center")}]})
		je.insert(ignore_permissions=True)
		je.submit()

	def tearDown(self):
		frappe.db.rollback(save_point="ye")

	def test_statements_add_up(self):
		st = yearend.year_status(2025)
		self.assertGreaterEqual(st["results"]["income"], 5000)
		self.assertAlmostEqual(st["balance"]["assets"], st["balance"]["liabilities_equity"], places=2)
		self.assertTrue(st["ended"])
		self.assertFalse(st["closed"])

	def test_close_moves_result_and_freezes_the_year(self):
		before = yearend.year_status(2025)["results"]["result"]
		res = yearend.close_year(2025)
		self.assertTrue(res["closed"])
		acc12 = frappe.db.get_value("Account", {"company": self.company, "account_number": "12", "is_group": 0})
		moved = flt(frappe.db.sql("""select sum(credit - debit) from `tabGL Entry` where voucher_type='Period Closing Voucher'
			and voucher_no=%s and account=%s and is_cancelled=0""", (res["voucher"], acc12))[0][0])
		self.assertAlmostEqual(moved, before, places=2)
		self.assertEqual(str(frappe.db.get_value("Company", self.company, "accounts_frozen_till_date")), "2025-12-31")
		with self.assertRaises(frappe.ValidationError):
			yearend.close_year(2025)

	def test_current_year_cannot_be_closed_early(self):
		with self.assertRaises(frappe.ValidationError):
			yearend.close_year(2026)
