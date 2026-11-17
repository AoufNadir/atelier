"""Allow a workshop order to stay unscheduled without inventing a delivery date."""


class OptionalDeliveryDateMixin:
	def validate_delivery_date(self):
		# Standard ERPNext orders keep their original validation. A Nasaq order may
		# be unscheduled only when neither its header nor any item has a date.
		if self.get("atelier_subject") and not self.delivery_date and not any(
			item.delivery_date for item in self.get("items")
		):
			self.validate_sales_mntc_quotation()
			return
		return super().validate_delivery_date()
