"""Readable morning sentences and the Arabic status names."""

import json
import unittest

import frappe

from atelier import simple
from atelier.patches import arabic_status_names


class TestMorningText(unittest.TestCase):
	def test_amounts(self):
		self.assertEqual(simple._dz(6500), "6,500 دج")
		self.assertEqual(simple._dz(6500.5), "6,500.50 دج")
		self.assertEqual(simple._dz(None), "0 دج")

	def test_status_rename_keeps_custom_names(self):
		saved = frappe.db.get_default("atelier_board")
		try:
			frappe.db.set_default("atelier_board", json.dumps({"columns": [], "labels": [{"id": "l1", "name": "Terminé"}],
				"statuses": [{"id": "s1", "name": "En cours"}, {"id": "s2", "name": "En cours (impression)"}]}, ensure_ascii=False))
			arabic_status_names.execute()
			cfg = json.loads(frappe.db.get_default("atelier_board"))
			self.assertEqual([x["name"] for x in cfg["statuses"]], ["قيد العمل", "En cours (impression)"])
			self.assertEqual(cfg["statuses"][0]["id"], "s1")
			self.assertEqual(cfg["labels"][0]["name"], "منتهٍ")
		finally:
			frappe.db.set_default("atelier_board", saved or "")
			frappe.db.commit()
