"""The team's daily flow: assigning a card, mentioning someone, moving a due date, and what each person then sees."""

import json
import unittest

import frappe
from frappe.utils import add_days, nowdate

from atelier import simple
from atelier.tests.test_finance_paths import _order


class TestTeamFlow(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		frappe.db.savepoint("team")
		simple.save_user("member-t@test.local", "عضو الفريق", "printer")
		from atelier.production import link_member

		link_member("member-t@test.local", "عضو الفريق")

	def tearDown(self):
		frappe.set_user("Administrator")
		frappe.db.rollback(save_point="team")

	def _seen_by_member(self):
		frappe.set_user("member-t@test.local")
		try:
			return simple.notifications()
		finally:
			frappe.set_user("Administrator")

	def test_assignment_and_mention_reach_the_member(self):
		so = _order(1000)
		before = self._seen_by_member()["unread"]
		simple.update_card(so, json.dumps({"members": ["عضو الفريق"]}, ensure_ascii=False))
		simple.add_comment(so, "@عضو الفريق اطبعها اليوم")
		n = self._seen_by_member()
		self.assertGreaterEqual(n["unread"] - before, 2)
		self.assertTrue(any("أسندك" in l.subject for l in n["logs"]))
		self.assertTrue(any("ذكرك" in l.subject for l in n["logs"]))
		frappe.set_user("member-t@test.local")
		try:
			simple.mark_read()
			self.assertEqual(sum(1 for l in simple.notifications()["logs"] if not l.read), 0)
		finally:
			frappe.set_user("Administrator")

	def test_due_date_change_and_late_alert(self):
		so = _order(1000)
		simple.update_card(so, json.dumps({"members": ["عضو الفريق"], "due": add_days(nowdate(), -2)}, ensure_ascii=False))
		self.assertEqual(str(frappe.db.get_value("Sales Order", so, "delivery_date")), add_days(nowdate(), -2))
		due = self._seen_by_member()["due"]
		self.assertTrue(any(d["name"] == so and d["late"] for d in due))

	def test_printer_sees_no_money_on_the_board(self):
		so = _order(1000)
		simple.update_card(so, json.dumps({"members": ["عضو الفريق"]}, ensure_ascii=False))
		frappe.set_user("member-t@test.local")
		try:
			cards = simple.board2()["cards"]
		finally:
			frappe.set_user("Administrator")
		mine = [c for c in cards if c["name"] == so]
		self.assertTrue(mine)
		for k in ("grand_total", "paid", "outstanding"):
			self.assertFalse(mine[0].get(k), f"{k} visible to the printer: {mine[0].get(k)}")

	def test_printer_cannot_call_money_pages_directly(self):
		so = _order(1000)
		simple.update_card(so, json.dumps({"members": ["عضو الفريق"]}, ensure_ascii=False))
		from atelier import api, materials

		calls = [(simple.money3, ()), (simple.reports2, ()), (simple.customers2, ()), (api.customer, (frappe.db.get_value("Sales Order", so, "customer"),)),
			(simple.customer_credit, (frappe.db.get_value("Sales Order", so, "customer"),))]
		frappe.set_user("member-t@test.local")
		try:
			for fn, args in calls:
				try:
					out = fn(*args)
				except frappe.PermissionError:
					continue
				text = json.dumps(out, default=str)
				self.assertNotIn("1000", text, f"{fn.__name__} gave the printer money figures")
			card = simple.card(so)
			for k in ("grand_total", "paid", "outstanding", "docs"):
				self.assertFalse(card.get(k), f"card() gives the printer {k}")
			stock = api.stock()
			self.assertFalse(stock.get("can_value"))
			self.assertTrue(all("value" not in i for i in stock["items"]))
		finally:
			frappe.set_user("Administrator")

	def test_no_read_endpoint_gives_a_printer_money(self):
		"""Every function the interface can read (GET), called as a printer: no amount in any reply."""
		import inspect

		from atelier import api

		money = ("grand_total", "paid", "outstanding", "balance", "amount", "rate", "cost", "value", "price", "owes", "income",
			"expenses", "profit", "total", "debit", "credit")
		so = _order(1000)
		cust = frappe.db.get_value("Sales Order", so, "customer")
		simple.update_card(so, json.dumps({"members": ["عضو الفريق"]}, ensure_ascii=False))
		methods = getattr(frappe, "allowed_http_methods_for_whitelisted_func", {})
		hits = []

		def walk(fn_name, x, path=""):
			if isinstance(x, dict):
				for k, v in x.items():
					if any(m in str(k).lower() for m in money) and isinstance(v, (int, float)) and not isinstance(v, bool) and v not in (0, 1):
						hits.append(f"{fn_name}{path}.{k}={v}")
					walk(fn_name, v, path + "." + str(k))
			elif isinstance(x, (list, tuple)):
				for v in x[:50]:
					walk(fn_name, v, path + "[]")

		frappe.set_user("member-t@test.local")
		try:
			for name in sorted(dir(api)):
				fn = getattr(api, name)
				if name.startswith("_") or not callable(fn) or fn not in frappe.whitelisted:
					continue
				if fn in methods and "GET" not in methods[fn]:
					continue
				args = [{"customer": cust}.get(p.name, so) for p in inspect.signature(fn).parameters.values() if p.default is inspect._empty]
				frappe.db.savepoint("leak")
				try:
					out = fn(*args)
				except Exception:  # refused, or needs other arguments: nothing was given
					frappe.db.rollback(save_point="leak")
					continue
				walk(name, json.loads(json.dumps(out, default=str)))
		finally:
			frappe.set_user("Administrator")
		self.assertEqual(hits, [], "money reached a printer: " + ", ".join(hits[:10]))


	def test_nightly_books_check_alerts_the_manager_only_on_differences(self):
		from atelier import books_check

		before = frappe.db.count("Notification Log", {"document_type": "Company"})
		books_check.nightly()
		self.assertEqual(frappe.db.count("Notification Log", {"document_type": "Company"}), before)  # clean books: no alert
		self.assertIn("differences", frappe.db.get_default("atelier_books_check"))
