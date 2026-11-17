"""Regression checks for unscheduled orders and clearing an existing due date."""

import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from atelier.delivery_dates import OptionalDeliveryDateMixin


class StandardOrder:
	def validate_delivery_date(self):
		self.standard_validation()


class WorkshopOrder(OptionalDeliveryDateMixin, StandardOrder):
	def __init__(self, subject="job", due=None, item_due=None):
		self.atelier_subject = subject
		self.delivery_date = due
		self.items = [SimpleNamespace(delivery_date=item_due)]
		self.standard_validation = Mock()
		self.validate_sales_mntc_quotation = Mock()

	def get(self, key):
		return getattr(self, key)


class TestOptionalDeliveryDate(unittest.TestCase):
	def test_unscheduled_workshop_order_keeps_quotation_validation(self):
		order = WorkshopOrder()
		order.validate_delivery_date()
		order.standard_validation.assert_not_called()
		order.validate_sales_mntc_quotation.assert_called_once()

	def test_dated_or_standard_orders_keep_erpnext_validation(self):
		for values in ({"due": "2026-11-17"}, {"item_due": "2026-11-17"}, {"subject": ""}):
			with self.subTest(values=values):
				order = WorkshopOrder(**values)
				order.validate_delivery_date()
				order.standard_validation.assert_called_once()


def verify_live():
	"""Run against development only, roll back every document and avoid folder writes."""
	import frappe
	from frappe.utils import add_days, nowdate
	from atelier import simple

	assert frappe.local.site == "development.localhost"
	frappe.set_user("Administrator")
	customer = frappe.db.get_value("Customer", {"customer_name": "El Wissam"}, "name")
	assert customer
	before = frappe.db.count("Sales Order")
	try:
		with patch("atelier.folders.on_card"), patch("atelier.folders.card_changed"), patch(
			"atelier.folders.card_folder", return_value=None
		):
			for rate in (3000, None):
				result = simple.quick_order(json.dumps({
					"customer": customer, "subject": f"Optional due date regression {rate}",
					"delivery_date": None,
					"lines": [{"text": "Design service", "qty": 1, "unit": "خدمة", "rate": rate}],
				}))
				name = result["sales_order"]
				order = frappe.get_doc("Sales Order", name)
				assert not order.delivery_date
				assert all(not item.delivery_date for item in order.items)
				assert bool(order.items[0].atelier_price_pending) == (rate is None)
				assert order.docstatus == (0 if rate is None else 1)
				day = add_days(nowdate(), 2)
				simple.update_card(name, json.dumps({"due": day}))
				simple.update_card(name, json.dumps({"due": ""}))
				order.reload()
				assert not order.delivery_date
				assert all(not item.delivery_date for item in order.items)
				assert not frappe.db.get_value("Project", order.project, "expected_end_date")
				card = next(card for card in simple.board2()["cards"] if card["name"] == name)
				assert not card["due"]
				assert not frappe.db.exists("Sales Invoice Item", {"sales_order": name})
				print("OPTIONAL_DUE_OK", "unpriced" if rate is None else "priced")
	finally:
		frappe.db.rollback()
	assert frappe.db.count("Sales Order") == before
	print("OPTIONAL_DUE_ROLLBACK_OK")
