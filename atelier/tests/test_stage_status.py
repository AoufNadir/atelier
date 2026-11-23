"""Plan A: statuses say where a card is inside its column; moving to the next column starts it again."""

import json
import unittest

import frappe

from atelier import simple
from atelier.patches import stage_status_names
from atelier.tests.test_finance_paths import _order


class TestStageStatus(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		self.saved = frappe.db.get_default("atelier_board")

	def tearDown(self):
		frappe.db.set_default("atelier_board", self.saved or "")
		frappe.db.commit()

	def test_rename_keeps_ids_and_custom_names(self):
		frappe.db.set_default("atelier_board", json.dumps({"columns": [], "labels": [], "statuses": [
			{"id": "a", "name": "بالانتظار"}, {"id": "b", "name": "En cours"}, {"id": "c", "name": "للمراجعة"},
			{"id": "d", "name": "Terminé"}, {"id": "e", "name": "تغليف"}]}, ensure_ascii=False))
		stage_status_names.execute()
		st = json.loads(frappe.db.get_default("atelier_board"))["statuses"]
		self.assertEqual([x["name"] for x in st], ["لم يبدأ", "قيد العمل", "ننتظر العميل", "انتهى", "تغليف"])
		self.assertEqual([x["id"] for x in st], ["a", "b", "c", "d", "e"])
		self.assertEqual(st[2].get("aside"), 1)

	def test_move_starts_the_new_stage(self):
		frappe.db.set_default("atelier_board", json.dumps(simple.DEFAULT_CONFIG, ensure_ascii=False))
		so = _order(1000)
		cfg = simple.get_config()
		frappe.db.set_value("Sales Order", so, "atelier_status", "l-done")
		simple.move_card(so, "c-design")
		self.assertEqual(frappe.db.get_value("Sales Order", so, "atelier_status"), "l-wait")
		# the «aside» flag survives saving the board settings
		simple.save_board(json.dumps(cfg, ensure_ascii=False))
		self.assertEqual(next(x for x in simple.get_config()["statuses"] if x["id"] == "l-valid").get("aside"), 1)
