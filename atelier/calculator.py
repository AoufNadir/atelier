"""Cost calculator: price a job before the order exists.

Materials come from the service recipe at their stock valuation; the person adds machine,
labour or subcontracting lines. Waste applies to material lines only, exactly like the card's
Cost Estimate, so a calculation turned into an order shows the same cost on the card.
Suggested price = unit cost / (1 - margin), margin taken on the selling price.
"""

import json
import re
import uuid

import frappe
from frappe import _
from frappe.utils import add_days, cint, flt, now_datetime, nowdate

from atelier import api
from atelier.atelier.doctype.cost_estimate.cost_estimate import get_valuation_rate

MARGINS_KEY = "atelier_calc_margins"
SAVED_KEY = "atelier_calcs"
MARGIN_DEFAULTS = {"Individual": 40, "Company": 30}
AREA = re.compile(r"(²|m2|sq|متر مربع)", re.I)


def _manager():
	from atelier.simple import _cost_manager

	_cost_manager()


def margins():
	m = dict(MARGIN_DEFAULTS)
	try:
		m.update(json.loads(frappe.db.get_default(MARGINS_KEY) or "{}"))
	except ValueError:
		pass
	return m


def _saved():
	try:
		return json.loads(frappe.db.get_default(SAVED_KEY) or "[]")
	except ValueError:
		return []


@frappe.whitelist()
def calc_data():
	_manager()
	from atelier.simple import custom_list, material_cost_types

	services = frappe.get_all("Item", filters={"disabled": 0, "is_sales_item": 1, "is_stock_item": 0, "name": ["!=", "SRV-GENERAL"]},
		fields=["item_code", "item_name", "stock_uom", "atelier_recipe"], order_by="item_name asc", limit=500)
	for s in services:
		s.recipe = json.loads(s.pop("atelier_recipe") or "[]")
		s.area = 1 if AREA.search(s.stock_uom or "") else 0
	api._with_prices(services)
	materials = frappe.get_all("Item", filters={"disabled": 0, "is_stock_item": 1}, fields=["item_code", "item_name", "stock_uom"],
		order_by="item_name asc", limit=500)
	for m in materials:
		m.rate = flt(get_valuation_rate(m.item_code)) or None
	types = custom_list("cost_types")
	mat = material_cost_types()
	return {
		"services": services, "materials": materials,
		"cost_types": [{"value": t["value"], "label": t["label"], "material": 1 if t["value"] in mat else 0} for t in types],
		"margins": margins(), "saved": [{k: c[k] for k in ("id", "title", "at", "by")} for c in _saved()],
		"can_price": api._can("Item Price", "write"),
	}


@frappe.whitelist(methods=["POST"])
def save_margins(data):
	_manager()
	d = frappe.parse_json(data) or {}
	m = {k: max(0, min(90, flt(d.get(k, MARGIN_DEFAULTS[k])))) for k in MARGIN_DEFAULTS}
	frappe.db.set_default(MARGINS_KEY, json.dumps(m))
	return m


def _clean(data):
	d = frappe.parse_json(data) or {}
	lines = []
	for l in d.get("lines") or []:
		text = (l.get("description") or "").strip()[:140]
		if not text:
			continue
		rate = l.get("rate")
		lines.append({"cost_type": l.get("cost_type") or "Autre", "description": text, "item": l.get("item") or None,
			"qty": flt(l.get("qty")), "rate": None if rate in (None, "") else flt(rate), "source": (l.get("source") or "")[:40]})
	return {
		"item_code": d.get("item_code") or None, "title": (d.get("title") or "").strip()[:140],
		"qty": flt(d.get("qty")) or 1, "width": flt(d.get("width")), "height": flt(d.get("height")),
		"waste_percent": max(0, min(100, flt(d.get("waste_percent")))), "lines": lines,
		"margins": {k: max(0, min(90, flt((d.get("margins") or {}).get(k, v)))) for k, v in margins().items()},
	}


@frappe.whitelist(methods=["POST"])
def save_calc(data, id=None):
	"""Keep a calculation to reopen later (the latest 50)."""
	_manager()
	calc = _clean(data)
	if not calc["title"]:
		frappe.throw(_("اكتب اسمًا للحساب"))
	rows = [c for c in _saved() if c["id"] != id]
	row = {"id": id or uuid.uuid4().hex[:10], "title": calc["title"], "at": str(now_datetime())[:16],
		"by": frappe.utils.get_fullname(frappe.session.user), "data": calc}
	rows = ([row] + rows)[:50]
	frappe.db.set_default(SAVED_KEY, json.dumps(rows, ensure_ascii=False))
	return row


@frappe.whitelist()
def get_calc(id):
	_manager()
	for c in _saved():
		if c["id"] == id:
			return c
	frappe.throw(_("الحساب غير موجود"))


@frappe.whitelist(methods=["POST"])
def delete_calc(id):
	_manager()
	frappe.db.set_default(SAVED_KEY, json.dumps([c for c in _saved() if c["id"] != id], ensure_ascii=False))
	return True


@frappe.whitelist(methods=["POST"])
def calc_order(data, customer=None, rate=None, column=None):
	"""Turn the calculation into a card: one order line at the chosen price, and the cost on the card."""
	_manager()
	from atelier.simple import _cash_customer, quick_order, save_card_cost

	calc = _clean(data)
	if not calc["item_code"] and not calc["title"]:
		frappe.throw(_("اختر الخدمة"))
	area = 0
	if calc["item_code"]:
		area = 1 if AREA.search(frappe.db.get_value("Item", calc["item_code"], "stock_uom") or "") else 0
	units = calc["qty"] * calc["width"] * calc["height"] if area and calc["width"] and calc["height"] else calc["qty"]
	text = calc["title"]
	if area and calc["width"] and calc["height"]:
		text = "%s — %s قطعة %g×%g م" % (text or frappe.db.get_value("Item", calc["item_code"], "item_name"), cint(calc["qty"]), calc["width"], calc["height"])
	res = quick_order(json.dumps({
		"customer": customer or _cash_customer(), "column": column or None,
		"lines": [{"item_code": calc["item_code"], "text": text, "qty": units, "rate": None if rate in (None, "") else flt(rate)}],
		"delivery_date": add_days(nowdate(), 3),
	}, ensure_ascii=False))
	so = res["sales_order"]
	if calc["lines"]:
		save_card_cost(so, json.dumps({"qty": units, "waste_percent": calc["waste_percent"],
			"lines": [{"cost_type": l["cost_type"], "description": l["description"], "qty": l["qty"] or 1, "rate": l["rate"]} for l in calc["lines"]]},
			ensure_ascii=False))
	return so
