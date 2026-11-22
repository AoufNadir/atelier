"""Setup wizard: steps detected from data, skip and hide remembered, boot flag follows."""

import unittest

import frappe

from atelier import setup_wizard


class TestSetupWizard(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		frappe.db.savepoint("sw")
		self.saved = frappe.db.get_default("atelier_setup")

	def tearDown(self):
		frappe.db.rollback(save_point="sw")
		frappe.db.set_default("atelier_setup", self.saved or "{}")

	def test_status_skip_hide(self):
		r = setup_wizard.setup_status()
		self.assertEqual(len(r["steps"]), 8)
		self.assertTrue(next(s for s in r["steps"] if s["key"] == "services")["done"])  # the test site has priced services
		open_ = [s["key"] for s in r["steps"] if not s["done"] and not s["optional"]]
		for k in open_:
			setup_wizard.setup_skip(k)
		self.assertFalse(setup_wizard.pending())
		setup_wizard.setup_skip(open_[0], 0) if open_ else None
		if open_:
			self.assertTrue(setup_wizard.pending())
			setup_wizard.setup_hide(1)
			self.assertFalse(setup_wizard.pending())
		with self.assertRaises(frappe.ValidationError):
			setup_wizard.setup_skip("nothing")
