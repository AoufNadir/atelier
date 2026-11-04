"""Devis and pro forma: a priced snapshot of an order card, with no accounting effect."""
import frappe
from frappe import _
from frappe.utils import add_days, cint, flt, getdate, nowdate

from atelier import simple

KINDS = {"devis": "عرض سعر", "proforma": "فاتورة شكلية"}
FIELDS = [
	{"fieldname": "atelier_order", "label": "الطلب", "fieldtype": "Link", "options": "Sales Order", "insert_after": "party_name", "read_only": 1},
	{"fieldname": "atelier_kind", "label": "نوع المستند", "fieldtype": "Data", "insert_after": "atelier_order", "read_only": 1},
	{"fieldname": "atelier_subject", "label": "الموضوع", "fieldtype": "Data", "insert_after": "atelier_kind"},
	{"fieldname": "atelier_description", "label": "الوصف", "fieldtype": "Text", "insert_after": "atelier_subject"},
]


def custom_fields():
	from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

	create_custom_fields({"Quotation": [{**f, "module": "Atelier"} for f in FIELDS]})


def _active(order, kind):
	return frappe.get_all("Quotation", filters={"atelier_order": order, "atelier_kind": kind, "docstatus": 1},
		fields=["name", "grand_total", "valid_till"], order_by="creation desc")


@frappe.whitelist(methods=["POST"])
def card_quote(order, kind="devis"):
	"""Reuses the current document while the card is unchanged; a changed card replaces it."""
	if kind not in KINDS:
		frappe.throw(_("نوع مستند غير معروف"))
	so = frappe.get_doc("Sales Order", order)
	so.check_permission("read")
	if not frappe.has_permission("Quotation", "create"):
		frappe.throw(_("ليست لديك صلاحية لهذا الإجراء."), frappe.PermissionError)
	if so.docstatus == 2:
		frappe.throw(_("هذا الطلب ملغى"))
	if any(i.atelier_price_pending for i in so.items) or flt(so.grand_total) <= 0:
		frappe.throw(_("حدّد سعر الطلب أولًا"))
	current = _active(order, kind)
	if current and flt(current[0].grand_total) == flt(so.grand_total) and getdate(current[0].valid_till) >= getdate(nowdate()):
		same = frappe.get_all("Quotation Item", filters={"parent": current[0].name}, fields=["item_code", "qty", "rate", "description"], order_by="idx")
		items = [(i.item_code, flt(i.qty), flt(i.rate), i.description) for i in so.items]
		text = frappe.db.get_value("Quotation", current[0].name, ["atelier_subject", "atelier_description"])
		if items == [(i.item_code, flt(i.qty), flt(i.rate), i.description) for i in same] and tuple(text) == (so.get("atelier_subject"), so.get("atelier_description")):
			return current[0].name
	for old in current:
		frappe.get_doc("Quotation", old.name).cancel()
	days = max(1, cint(simple.doc_settings().get("quote_days") or 15))
	doc = frappe.get_doc({"doctype": "Quotation", "quotation_to": "Customer", "party_name": so.customer, "company": so.company,
		"transaction_date": nowdate(), "valid_till": add_days(nowdate(), days), "selling_price_list": so.selling_price_list,
		"order_type": "Sales", "atelier_order": so.name, "atelier_kind": kind, "atelier_subject": so.get("atelier_subject"),
		"atelier_description": so.get("atelier_description"), "taxes_and_charges": so.taxes_and_charges,
		"items": [{"item_code": i.item_code, "qty": i.qty, "uom": i.uom, "rate": i.rate, "description": i.description} for i in so.items],
		"taxes": [{"charge_type": t.charge_type, "account_head": t.account_head, "description": t.description, "rate": t.rate} for t in so.taxes]})
	doc.insert()
	doc.submit()
	return doc.name
