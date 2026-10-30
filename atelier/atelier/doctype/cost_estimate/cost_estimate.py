# Copyright (c) 2026, Demo Atelier and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document
from frappe.utils import flt


class CostEstimate(Document):
	def validate(self):
		self.fill_material_rates()
		self.calculate()

	def fill_material_rates(self):
		"""Material lines without a cost take the item's current stock valuation, if known."""
		for line in self.lines:
			if line.cost_type == "Matière" and line.item and not flt(line.rate) and not line.zero_confirmed:
				rate = get_valuation_rate(line.item)
				if rate:
					line.rate = rate
					line.rate_source = "Valorisation stock"

	def calculate(self):
		total = missing = 0
		for line in self.lines:
			# An empty or 0 cost is missing data unless explicitly confirmed as zero.
			line.is_missing = 0 if (flt(line.rate) or line.zero_confirmed) else 1
			waste = flt(self.waste_percent) / 100 if line.cost_type == "Matière" else 0
			line.amount = flt(line.qty) * flt(line.rate) * (1 + waste)
			total += line.amount
			missing += line.is_missing

		self.total_cost = total
		self.unit_cost = total / flt(self.qty) if flt(self.qty) else 0
		self.missing_count = missing
		self.is_estimate_complete = 0 if missing or not self.lines else 1

		if flt(self.selling_price):
			self.pricing_status = "Prix fixé"
		elif self.price_zero_confirmed:
			self.pricing_status = "Gratuit confirmé"
		else:
			# Empty price is never treated as free.
			self.pricing_status = "En attente de prix"

		if self.pricing_status == "En attente de prix":
			self.estimated_margin = None
			self.margin_percent = None
		else:
			self.estimated_margin = flt(self.selling_price) - total
			self.margin_percent = (
				self.estimated_margin / flt(self.selling_price) * 100 if flt(self.selling_price) else 0
			)


def get_valuation_rate(item_code):
	rate = frappe.db.sql(
		"""select sum(stock_value) / nullif(sum(actual_qty), 0) from `tabBin`
		where item_code = %s and actual_qty > 0""",
		item_code,
	)[0][0]
	return flt(rate) or flt(frappe.db.get_value("Item", item_code, "valuation_rate"))
