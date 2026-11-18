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


FAMILIES = ("roll", "bottle", "count", "area", "length", "volume", "weight")
WAYS = {"roll": "م²", "bottle": "قارورة"}  # stock unit fixed by the way; "count" keeps the unit chosen


def material_cfg(raw):
	"""Stored in atelier_packs: {width, length, pack, pack_qty, waste} (older rows: a list of packs)."""
	try:
		v = json.loads(raw or "{}")
	except ValueError:
		v = {}
	if isinstance(v, list):
		p = v[0] if v else {}
		v = {"width": p.get("width"), "length": p.get("length"), "pack": p.get("name"), "pack_qty": p.get("qty")}
	return {"width": flt(v.get("width")), "length": flt(v.get("length")), "pack": (v.get("pack") or "")[:40],
		"pack_qty": flt(v.get("pack_qty")), "waste": flt(v.get("waste"))}


def _packs(packs):
	"""Purchase units of a material: [{name, qty}] where qty is in the stock unit (a roll of 3.20 × 50 = 160 م²)."""
	out, seen = [], set()
	for p in frappe.parse_json(packs) or []:
		n, q = (p.get("name") or "").strip()[:60], flt(p.get("qty"))
		if n and q > 0 and n not in seen:
			seen.add(n)
			row = {"name": n, "qty": q}
			if flt(p.get("width")) > 0 and flt(p.get("length")) > 0:
				row.update({"width": flt(p["width"]), "length": flt(p["length"])})
			out.append(row)
	return out


def _has(field):
	"""The unit fields come with migrate; create them on first use so a site that was not migrated yet never loses a setting."""
	if not frappe.db.has_column("Item", field):
		custom_fields()
		frappe.clear_cache(doctype="Item")
	return frappe.db.has_column("Item", field)


def _set_units(item_code, family=None, packs=None):
	vals = {}
	if family is not None and _has("atelier_family"):
		vals["atelier_family"] = family if family in FAMILIES else ""
	if packs is not None and _has("atelier_packs"):
		p = frappe.parse_json(packs)
		if isinstance(p, dict):
			c = material_cfg(json.dumps(p))
			if family == "roll" and c["width"] > 0 and c["length"] > 0:
				c["pack"], c["pack_qty"] = c["pack"] or "لفّة", round(c["width"] * c["length"], 4)
			vals["atelier_packs"] = json.dumps(c, ensure_ascii=False)
		else:
			vals["atelier_packs"] = json.dumps(_packs(packs), ensure_ascii=False)
	if vals:
		frappe.db.set_value("Item", item_code, vals)


@frappe.whitelist(methods=["POST"])
def add_material(name, uom, min_qty=0, family=None, packs=None):
	_need("Item")
	name = (name or "").strip()[:140]
	if not name:
		frappe.throw(_("اكتب اسم المادة"))
	if frappe.db.exists("Item", {"item_name": name, "disabled": 0}):
		frappe.throw(_("يوجد بند بهذا الاسم"))
	uom = WAYS.get(family) or (uom or "قطعة").strip()
	if not frappe.db.exists("UOM", uom):
		frappe.get_doc({"doctype": "UOM", "uom_name": uom, "must_be_whole_number": 1 if family in ("count", "bottle") else 0}).insert(ignore_permissions=True)
	if not frappe.db.exists("Item Group", GROUP):
		root = frappe.db.get_value("Item Group", {"is_group": 1, "parent_item_group": ["in", ["", None]]})
		frappe.get_doc({"doctype": "Item Group", "item_group_name": GROUP, "parent_item_group": root}).insert(ignore_permissions=True)
	code = frappe.generate_hash(length=8).upper()
	item = frappe.get_doc({"doctype": "Item", "item_code": "MAT-" + code, "item_name": name, "item_group": GROUP, "stock_uom": uom,
		"is_stock_item": 1, "is_sales_item": 0, "is_purchase_item": 1, "safety_stock": flt(min_qty),
		"valuation_method": "Moving Average"}).insert(ignore_permissions=True).name
	_set_units(item, family, packs)
	return item


@frappe.whitelist(methods=["POST"])
def update_material(item_code, name, min_qty=0, family=None, packs=None, uom=None):
	_need("Item")
	_material(item_code)
	name = (name or "").strip()[:140]
	if not name:
		frappe.throw(_("اكتب اسم المادة"))
	vals = {"item_name": name, "safety_stock": flt(min_qty)}
	# the way (and so the stock unit) may change only while the material has no moves yet
	unit = WAYS.get(family) or ((uom or "").strip() if family == "count" else None)
	if unit and unit != frappe.db.get_value("Item", item_code, "stock_uom"):
		if frappe.db.exists("Stock Ledger Entry", {"item_code": item_code, "is_cancelled": 0}):
			frappe.throw(_("لهذه المادة حركات مسجّلة، فلا يمكن تغيير طريقتها. أنشئ مادة جديدة."))
		if not frappe.db.exists("UOM", unit):
			frappe.get_doc({"doctype": "UOM", "uom_name": unit, "must_be_whole_number": 1 if family in ("count", "bottle") else 0}).insert(ignore_permissions=True)
		vals["stock_uom"] = unit
		frappe.db.sql("update `tabUOM Conversion Detail` set uom=%s where parent=%s and conversion_factor=1", (unit, item_code))
	frappe.db.set_value("Item", item_code, vals)
	_set_units(item_code, family, packs)
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
		"Item": [{"fieldname": "atelier_recipe", "label": "وصفة المواد", "fieldtype": "Long Text", "hidden": 1, "insert_after": "atelier_steps", "module": "Atelier"},
			{"fieldname": "atelier_family", "label": "عائلة الوحدة", "fieldtype": "Data", "hidden": 1, "insert_after": "atelier_recipe", "module": "Atelier"},
			{"fieldname": "atelier_packs", "label": "وحدات الشراء", "fieldtype": "Long Text", "hidden": 1, "insert_after": "atelier_family", "module": "Atelier"}],
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


def _rolls(store):
	if not _has("atelier_family"):
		return {}
	out = {}
	for r in frappe.get_all("Item", filters={"disabled": 0, "is_stock_item": 1, "atelier_family": "roll"}, fields=["name", "item_name", "atelier_packs"]):
		c = material_cfg(r.atelier_packs)
		out[r.name] = {"item_code": r.name, "item_name": r.item_name, "width": c["width"], "waste": c["waste"], "on_hand": _on_hand(r.name, store)}
	return out


@frappe.whitelist()
def material_ledger(item_code, limit=60):
	"""Every move of one material with the balance after it, and the order or supplier behind it."""
	api._require("Bin")
	_material(item_code)
	rows = frappe.get_all("Stock Ledger Entry", filters={"item_code": item_code, "is_cancelled": 0},
		fields=["posting_date", "voucher_type", "voucher_no", "actual_qty", "qty_after_transaction", "valuation_rate"],
		order_by="posting_date desc, posting_time desc, creation desc", limit=cint(limit) or 60)
	entries = [r.voucher_no for r in rows if r.voucher_type == "Stock Entry"] or [""]
	info = {e.name: e for e in frappe.get_all("Stock Entry", filters={"name": ["in", entries]}, fields=["name", "project", "remarks"])}
	orders = {o.project: o for o in frappe.get_all("Sales Order", filters={"project": ["in", [e.project for e in info.values() if e.project] or [""]]}, fields=["name", "project", "atelier_subject"])}
	bills = [r.voucher_no for r in rows if r.voucher_type == "Purchase Invoice"] or [""]
	sup = dict(frappe.db.sql("select name, supplier_name from `tabPurchase Invoice` where name in %s", [bills]))
	for r in rows:
		e = info.get(r.voucher_no)
		so = orders.get(e.project) if e and e.project else None
		r.order, r.order_title = (so.name, so.atelier_subject or so.name) if so else (None, None)
		r.note = (e.remarks if e and not so else None) or sup.get(r.voucher_no)
	month = str(frappe.utils.get_first_day(nowdate()))
	used = -flt(frappe.db.sql("""select sum(actual_qty) from `tabStock Ledger Entry` where item_code=%s and is_cancelled=0
		and voucher_type='Stock Entry' and actual_qty<0 and posting_date>=%s""", (item_code, month))[0][0])
	used60 = -flt(frappe.db.sql("""select sum(actual_qty) from `tabStock Ledger Entry` where item_code=%s and is_cancelled=0
		and voucher_type='Stock Entry' and actual_qty<0 and posting_date>=%s""", (item_code, frappe.utils.add_days(nowdate(), -60)))[0][0])
	last = frappe.db.sql("""select pi.posting_date, pi.supplier_name, pii.rate from `tabPurchase Invoice Item` pii join `tabPurchase Invoice` pi on pi.name=pii.parent
		where pii.item_code=%s and pi.docstatus=1 order by pi.posting_date desc, pi.creation desc limit 1""", item_code, as_dict=True)
	return {"rows": rows, "month_used": used, "daily": used60 / 60, "last_buy": last[0] if last else None}


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
	rolls = _rolls(store)
	needed = _needed(so)
	if rolls:
		from atelier.simple import units
		scale = {u["name"]: (0.0001 if u.get("scale") == "cm" else 1) for u in units() if u["calc"] == "area"}
		for line in so.items:
			if line.get("atelier_unit") not in scale or any(r["item_code"] in rolls for r in _recipe(line.item_code)):
				continue
			w, h = flt(line.get("atelier_width")), flt(line.get("atelier_height"))
			area = flt(line.qty) * scale[line.atelier_unit]
			if area <= 0:
				continue
			# the narrowest roll that takes the shorter side, else the widest
			side = min(w, h) * (0.01 if scale[line.atelier_unit] < 1 else 1) if w and h else 0
			fit = sorted((r for r in rolls.values() if r["width"] >= side), key=lambda r: r["width"]) or sorted(rolls.values(), key=lambda r: -r["width"])
			pick = fit[0]
			rows.append({"item_code": pick["item_code"], "item_name": pick["item_name"], "uom": "م²", "line": (line.description or line.item_name or "")[:80],
				"size": line.get("atelier_size") or "", "area": round(area, 3), "waste": pick["waste"],
				"need": round(area * (1 + pick["waste"] / 100), 3), "on_hand": pick["on_hand"],
				"choices": [{k: r[k] for k in ("item_code", "item_name", "on_hand", "waste")} for r in sorted(rolls.values(), key=lambda r: r["width"])]})
	for code, qty in needed.items():
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
