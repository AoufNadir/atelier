"""Keep unspecified workshop prices out of ERPNext's totals."""


class PendingPriceMixin:
	def calculate_taxes_and_totals(self):
		# ERPNext can fill a zero rate from Item Price during set_missing_values.
		# Pending is a separate state, never acceptance of the suggested price.
		for item in self.get("items") or []:
			if item.get("atelier_price_pending"):
				item.rate = item.price_list_rate = 0
				item.discount_percentage = item.discount_amount = 0
		return super().calculate_taxes_and_totals()
