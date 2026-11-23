"""Manager sets an employee's password; links point to the shop's public address, not localhost."""

import unittest
from werkzeug.test import EnvironBuilder
from werkzeug.wrappers import Request

import frappe
from frappe.utils.password import check_password

from atelier import simple


def _req(url):
	return Request(EnvironBuilder(base_url=url).get_environ())


class TestPasswords(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		self.saved = frappe.db.get_default("atelier_public_url")
		self.team = frappe.db.get_default("atelier_team")
		self.had_request = hasattr(frappe.local, "request")
		self.request = getattr(frappe.local, "request", None)
		self.email = simple.save_user("pw.test@example.invalid", "اختبار كلمة السر", "sales")["name"]

	def tearDown(self):
		if self.had_request:
			frappe.local.request = self.request
		elif hasattr(frappe.local, "request"):
			del frappe.local.request
		frappe.db.set_default("atelier_public_url", self.saved or "")
		frappe.db.set_default("atelier_team", self.team or "[]")
		frappe.delete_doc("User", self.email, force=1, ignore_permissions=True)
		frappe.db.commit()

	def test_set_password(self):
		for bad in ("short1", "12345678", "aaaaaaaa"):
			with self.assertRaises(frappe.ValidationError, msg=bad):
				simple.set_user_password(self.email, bad)
		with self.assertRaises(frappe.ValidationError):
			simple.set_user_password("Administrator", "Strong-pass-1")
		simple.set_user_password(self.email, "Matbaa2026x")
		self.assertEqual(check_password(self.email, "Matbaa2026x"), self.email)

	def test_link_uses_public_address(self):
		frappe.local.request = _req("https://atelier.tail0000.ts.net/")
		simple.remember_public_url()
		self.assertEqual(frappe.db.get_default("atelier_public_url"), "https://atelier.tail0000.ts.net")
		frappe.local.request = _req("http://nasaq.localhost:8001/")
		link = simple.reset_link(self.email)
		self.assertTrue(link.startswith("https://atelier.tail0000.ts.net/update-password?key="), link)
		simple.remember_public_url()  # a local visit does not overwrite it
		self.assertEqual(frappe.db.get_default("atelier_public_url"), "https://atelier.tail0000.ts.net")
