"""Workshop materials: one store, three moves. Each move is a standard ERPNext document."""
import json
import math

import frappe
from frappe import _
from frappe.utils import cint, flt, nowdate

from atelier import api

GROUP = "مواد"
INVENTORY_ACCOUNT_NUMBER = "311"  # Matières premières; the template default is a services account
OPENING_ACCOUNT_NUMBER = "11"


def setup(company):
	"""Point the store at a raw-material account, only if it has none yet."""
	store = store_for(company)
	account = frappe.db.get_value("Account", {"company": company, "account_number": INVENTORY_ACCOUNT_NUMBER, "is_group": 0})
	if store and account and not frappe.db.get_value("Warehouse", store, "account"):
		frappe.db.set_value("Warehouse", store, "account", account)


def store_for(company):
	return frappe.db.get_value("Warehouse", {"company": company, "warehouse_name": "Stores", "is_group": 0}) or frappe.db.get_value(
		"Warehouse", {"company": company, "is_group": 0, "disabled": 0}
	)


def _need(doctype):
	if not frappe.has_permission(doctype, "create"):
		frappe.throw(_("ليست لديك صلاحية لهذا الإجراء."), frappe.PermissionError)


def _material(item_code):
	item = frappe.db.get_value("Item", item_code, ["name", "is_stock_item", "stock_uom"], as_dict=True)
	if not item or not item.is_stock_item:
		frappe.throw(_("مادة غير صالحة"))
	return item


def _quantity(qty):
	qty = flt(qty)
	if qty <= 0:
		frappe.throw(_("اكتب كمية أكبر من صفر"))
	return qty


def _on_hand(item_code, store):
	return flt(frappe.db.get_value("Bin", {"item_code": item_code, "warehouse": store}, "actual_qty"))


@frappe.whitelist(methods=["POST"])
def add_material(name, uom, min_qty=0):
	_need("Item")
	name = (name or "").strip()[:140]
	if not name:
		frappe.throw(_("اكتب اسم المادة"))
	if frappe.db.exists("Item", {"item_name": name, "disabled": 0}):
		frappe.throw(_("يوجد بند بهذا الاسم"))
	uom = (uom or "قطعة").strip()
	if not frappe.db.exists("UOM", uom):
		frappe.get_doc({"doctype": "UOM", "uom_name": uom}).insert(ignore_permissions=True)
	if not frappe.db.exists("Item Group", GROUP):
		root = frappe.db.get_value("Item Group", {"is_group": 1, "parent_item_group": ["in", ["", None]]})
		frappe.get_doc({"doctype": "Item Group", "item_group_name": GROUP, "parent_item_group": root}).insert(ignore_permissions=True)
	code = frappe.generate_hash(length=8).upper()
	return frappe.get_doc({"doctype": "Item", "item_code": "MAT-" + code, "item_name": name, "item_group": GROUP, "stock_uom": uom,
		"is_stock_item": 1, "is_sales_item": 0, "is_purchase_item": 1, "safety_stock": flt(min_qty),
		"valuation_method": "Moving Average"}).insert(ignore_permissions=True).name


@frappe.whitelist(methods=["POST"])
def update_material(item_code, name, min_qty=0):
	_need("Item")
	_material(item_code)
	name = (name or "").strip()[:140]
	if not name:
		frappe.throw(_("اكتب اسم المادة"))
	frappe.db.set_value("Item", item_code, {"item_name": name, "safety_stock": flt(min_qty)})
	return True


@frappe.whitelist(methods=["POST"])
def remove_material(item_code):
	"""Hidden, not deleted: its history stays. Only with nothing left in the store."""
	_need("Item")
	_material(item_code)
	if flt(frappe.db.sql("select sum(actual_qty) from tabBin where item_code=%s", item_code)[0][0]) > 0:
		frappe.throw(_("ما زالت لهذه المادة كمية. صفّرها بالجرد أولًا"))
	frappe.db.set_value("Item", item_code, "disabled", 1)
	return True


@frappe.whitelist(methods=["POST"])
def stock_purchase(item_code, qty, rate, supplier, bill_no=None):
	"""Goods in with a debt to the supplier; it appears on the supplier's page."""
	_need("Purchase Invoice")
	item, qty, rate = _material(item_code), _quantity(qty), flt(rate)
	if rate <= 0:
		frappe.throw(_("اكتب سعر الوحدة"))
	if not supplier or not frappe.db.exists("Supplier", supplier):
		frappe.throw(_("اختر المورد"))
	company = api._company()
	invoice = frappe.get_doc({"doctype": "Purchase Invoice", "supplier": supplier, "company": company, "posting_date": nowdate(),
		"update_stock": 1, "set_warehouse": store_for(company), "bill_no": (bill_no or "").strip() or None,
		"items": [{"item_code": item.name, "qty": qty, "rate": rate, "warehouse": store_for(company)}]})
	invoice.insert()
	invoice.submit()
	return invoice.name


@frappe.whitelist(methods=["POST"])
def stock_issue(item_code, qty, sales_order=None, note=None):
	"""Material used up. With an order, its cost lands on that order's project."""
	_need("Stock Entry")
	item, qty, company = _material(item_code), _quantity(qty), api._company()
	store = store_for(company)
	if qty > _on_hand(item.name, store):
		frappe.throw(_("الكمية المتوفرة {0} فقط").format(_on_hand(item.name, store)))
	project = frappe.db.get_value("Sales Order", sales_order, "project") if sales_order else None
	entry = frappe.get_doc({"doctype": "Stock Entry", "stock_entry_type": "Material Issue", "company": company, "project": project,
		"remarks": (note or "").strip()[:140] or sales_order, "from_warehouse": store,
		"items": [{"item_code": item.name, "qty": qty, "s_warehouse": store, "project": project,
			"expense_account": frappe.db.get_value("Company", company, "stock_adjustment_account")}]})
	entry.insert()
	entry.submit()
	return entry.name


@frappe.whitelist(methods=["POST"])
def stock_count(item_code, qty, rate=None):
	"""Set the counted quantity. The first count of a material is its opening stock."""
	_need("Stock Reconciliation")
	item, company = _material(item_code), api._company()
	qty, store = flt(qty), store_for(company)
	if qty < 0:
		frappe.throw(_("كمية غير صالحة"))
	opening = not frappe.db.exists("Stock Ledger Entry", {"item_code": item.name, "is_cancelled": 0})
	if opening and qty and flt(rate) <= 0:
		frappe.throw(_("اكتب سعر الوحدة للرصيد الأول"))
	if opening:
		account = frappe.db.get_value("Account", {"company": company, "account_number": OPENING_ACCOUNT_NUMBER, "is_group": 0})
	else:
		account = frappe.db.get_value("Company", company, "stock_adjustment_account")
	row = {"item_code": item.name, "warehouse": store, "qty": qty}
	if flt(rate) > 0:
		row["valuation_rate"] = flt(rate)
	doc = frappe.get_doc({"doctype": "Stock Reconciliation", "company": company, "purpose": "Opening Stock" if opening else "Stock Reconciliation",
		"expense_account": account, "items": [row]})
	doc.insert()
	doc.submit()
	return doc.name


# ---------------------------------------------------------------- recipes: what one unit of a service uses


def custom_fields():
	from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

	create_custom_fields({
		"Item": [{"fieldname": "atelier_recipe", "label": "وصفة المواد", "fieldtype": "Long Text", "hidden": 1, "insert_after": "atelier_steps", "module": "Atelier"}],
		"Sales Order": [{"fieldname": "atelier_materials_done", "label": "خُصمت المواد", "fieldtype": "Check", "read_only": 1, "insert_after": "atelier_due_time", "module": "Atelier"}],
	})


def _recipe(item_code):
	try:
		return json.loads(frappe.db.get_value("Item", item_code, "atelier_recipe") or "[]")
	except ValueError:
		return []


@frappe.whitelist()
def recipes():
	api._require("Bin")
	services = frappe.get_all("Item", filters={"disabled": 0, "is_sales_item": 1, "is_stock_item": 0, "name": ["!=", "SRV-GENERAL"]},
		fields=["item_code", "item_name", "stock_uom", "atelier_recipe"], order_by="item_name asc", limit=500)
	materials = frappe.get_all("Item", filters={"disabled": 0, "is_stock_item": 1}, fields=["item_code", "item_name", "stock_uom"], order_by="item_name asc", limit=500)
	for s in services:
		s.recipe = json.loads(s.pop("atelier_recipe") or "[]")
	return {"services": services, "materials": materials}


@frappe.whitelist(methods=["POST"])
def save_recipe(item_code, rows):
	_need("Item")
	if not frappe.db.exists("Item", item_code):
		frappe.throw(_("خدمة غير صالحة"))
	clean = []
	for row in frappe.parse_json(rows) or []:
		if row.get("item_code") and flt(row.get("qty")) > 0:
			_material(row["item_code"])
			clean.append({"item_code": row["item_code"], "qty": flt(row["qty"])})
	frappe.db.set_value("Item", item_code, "atelier_recipe", json.dumps(clean, ensure_ascii=False))
	return clean


def _needed(so):
	totals = {}
	for line in so.items:
		for row in _recipe(line.item_code):
			totals[row["item_code"]] = totals.get(row["item_code"], 0) + flt(line.qty) * flt(row["qty"])
	return totals


@frappe.whitelist()
def order_materials(order):
	"""What the order's services use. A quantity in a whole-number unit rounds up."""
	so = frappe.get_doc("Sales Order", order)
	so.check_permission("read")
	store, rows = store_for(so.company), []
	for code, qty in _needed(so).items():
		item = frappe.db.get_value("Item", code, ["item_name", "stock_uom", "disabled"], as_dict=True)
		if not item or item.disabled:
			continue
		if frappe.db.get_value("UOM", item.stock_uom, "must_be_whole_number"):
			qty = math.ceil(round(qty, 6))
		rows.append({"item_code": code, "item_name": item.item_name, "uom": item.stock_uom, "need": round(qty, 3), "on_hand": _on_hand(code, store)})
	return {"rows": rows, "done": cint(so.get("atelier_materials_done")), "delivered": flt(so.per_delivered) >= 100}


@frappe.whitelist(methods=["POST"])
def issue_order_materials(order, rows):
	"""One confirmation per order. All lines succeed together, or none is issued."""
	_need("Stock Entry")
	so = frappe.get_doc("Sales Order", order)
	so.check_permission("write")
	if cint(so.get("atelier_materials_done")):
		frappe.throw(_("خُصمت مواد هذا الطلب من قبل"))
	issued = [stock_issue(r["item_code"], r["qty"], order, _("مواد طلب {0}").format(order)) for r in frappe.parse_json(rows) or [] if flt(r.get("qty")) > 0]
	so.db_set("atelier_materials_done", 1)
	return issued
