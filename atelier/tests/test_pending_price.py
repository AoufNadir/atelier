"""Unspecified prices remain distinct from both defaults and accepted prices."""

import unittest

from atelier.order_pricing import PendingPriceMixin


class Item:
	def __init__(self, pending, rate):
		self.atelier_price_pending = pending
		self.rate = self.price_list_rate = rate
		self.discount_percentage = 10
		self.discount_amount = 250

	def get(self, field):
		return getattr(self, field)


class Totals:
	def calculate_taxes_and_totals(self):
		return sum(item.rate for item in self.items)


class Order(PendingPriceMixin, Totals):
	def __init__(self):
		self.items = [Item(True, 2500), Item(False, 3000)]

	def get(self, field):
		return getattr(self, field)


class TestPendingPrice(unittest.TestCase):
	def test_suggested_rate_is_excluded_but_agreed_price_is_preserved(self):
		order = Order()
		self.assertEqual(order.calculate_taxes_and_totals(), 3000)
		self.assertTrue(order.items[0].atelier_price_pending)
		self.assertEqual(order.items[0].price_list_rate, 0)
		self.assertEqual(order.items[0].discount_amount, 0)
		self.assertEqual(order.items[1].rate, 3000)
