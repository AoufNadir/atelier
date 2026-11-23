"""First-login tour: pending for a new account, «later» hides it until tomorrow, «done» for good, «reset» again."""

import unittest

import frappe
from frappe.utils import add_days, nowdate

from atelier import simple


class TestTour(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		self.team = frappe.db.get_default("atelier_team")
		self.email = simple.save_user("tour.test@example.invalid", "اختبار الجولة", "sales")["name"]

	def tearDown(self):
		frappe.set_user("Administrator")
		frappe.db.set_default("atelier_team", self.team or "[]")
		frappe.delete_doc("User", self.email, force=1, ignore_permissions=True)
		frappe.db.commit()

	def test_tour_states(self):
		self.assertFalse(simple.tour_pending("Administrator"))
		frappe.set_user(self.email)
		self.assertTrue(simple.tour_pending())
		self.assertFalse(simple.tour_mark("later")["pending"])
		frappe.db.set_default("atelier_tour", "later:" + str(add_days(nowdate(), -1)), parent=self.email)
		self.assertTrue(simple.tour_pending())  # asked «later» yesterday: offered again today
		self.assertFalse(simple.tour_mark("done")["pending"])
		self.assertTrue(simple.tour_mark("reset")["pending"])
		with self.assertRaises(frappe.ValidationError):
			simple.tour_mark("nonsense")
