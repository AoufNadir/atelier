"""Backup alert: silent before any run, warns when Drive was unreachable or the last off-site copy is old."""

import json
import unittest

import frappe
from frappe.utils import add_days, now_datetime

from atelier import backup_status, simple


class TestBackupStatus(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		self.saved = frappe.db.get_default(backup_status.KEY)

	def tearDown(self):
		frappe.db.set_default(backup_status.KEY, self.saved or "{}")
		frappe.db.commit()

	def test_alert(self):
		frappe.db.set_default(backup_status.KEY, "{}")
		self.assertIsNone(backup_status.warning())
		backup_status.mark("drive")
		self.assertIsNone(backup_status.warning())
		backup_status.mark("local")  # Drive away today: the last off-site copy is still fresh
		self.assertIsNone(backup_status.warning())
		s = backup_status.status()
		s["last_offsite"] = str(add_days(now_datetime(), -3))
		frappe.db.set_default(backup_status.KEY, json.dumps(s))
		self.assertIn("3 أيام", backup_status.warning())
		self.assertTrue(any(d["kind"] == "backup" for d in simple.morning()["decisions"]))
		frappe.db.set_default(backup_status.KEY, json.dumps({"last_run": str(now_datetime()), "result": "local"}))
		self.assertIn("لم تصل", backup_status.warning())
