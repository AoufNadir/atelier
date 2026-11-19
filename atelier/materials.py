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
	color = v.get("color") or ""
	return {"width": flt(v.get("width")), "length": flt(v.get("length")), "pack": (v.get("pack") or "")[:40],
		"pack_qty": flt(v.get("pack_qty")), "waste": flt(v.get("waste")),
		"color": color if isinstance(color, str) and color.startswith("#") and len(color) in (4, 7) else "",
		"kind": (v.get("kind") or "")[:40], "gsm": flt(v.get("gsm")), "size": (v.get("size") or "")[:30], "section": (v.get("section") or "")[:60],
		"closed": cint(v.get("closed")), "opens": (v.get("opens") or [])[-12:] if isinstance(v.get("opens"), list) else []}


def _packs(packs):
	"""Purchase units of a material: [{name, qty}] where qty is in the stock unit (a roll of 3.20 × 50 = 160 م²)."""
	out, seen = [], set()
	p_all = frappe.parse_json(packs) or []
	if isinstance(p_all, dict):
		p_all = [p_all]
	for p in p_all:
		if not isinstance(p, dict):
			continue
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
			old = material_cfg(frappe.db.get_value("Item", item_code, "atelier_packs"))
			c = material_cfg(json.dumps({**p, "closed": p.get("closed", old["closed"]), "opens": old["opens"]}))
			if family == "roll" and c["width"] > 0 and c["length"] > 0:
				c["pack"], c["pack_qty"] = c["pack"] or "لفّة", round(c["width"] * c["length"], 4)
			vals["atelier_packs"] = json.dumps(c, ensure_ascii=False)
		else:
			vals["atelier_packs"] = json.dumps(_packs(packs), ensure_ascii=False)
	if vals:
		frappe.db.set_value("Item", item_code, vals)
	if vals.get("atelier_packs", "").startswith("{"):
		c = json.loads(vals["atelier_packs"])
		if c.get("pack") and flt(c.get("pack_qty")) > 0:
			_pack_uom(item_code, c["pack"], flt(c["pack_qty"]))


def _pack_uom(item_code, pack, factor):
	"""The roll / ream as a real purchase unit of the item, so a roll bought at 500 دج is worth exactly 500 دج in stock."""
	if not frappe.db.exists("UOM", pack):
		frappe.get_doc({"doctype": "UOM", "uom_name": pack, "must_be_whole_number": 0}).insert(ignore_permissions=True)
	item = frappe.get_doc("Item", item_code)
	row = next((u for u in item.uoms if u.uom == pack), None)
	if row and abs(flt(row.conversion_factor) - factor) < 1e-9:
		return
	if row:
		row.conversion_factor = factor
	else:
		item.append("uoms", {"uom": pack, "conversion_factor": factor})
	item.flags.ignore_permissions = True
	item.save()


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
def stock_purchase(item_code, qty, rate, supplier, bill_no=None, uom=None):
	"""Goods in with a debt to the supplier; it appears on the supplier's page.
	With uom (a roll, a ream): qty and rate are per that unit, and ERPNext converts to the stock unit with no rounding loss."""
	_need("Purchase Invoice")
	item, qty, rate = _material(item_code), _quantity(qty), flt(rate)
	row = {"item_code": item.name, "qty": qty, "rate": rate}
	if uom and uom != item.stock_uom:
		factor = flt(frappe.db.get_value("UOM Conversion Detail", {"parent": item.name, "uom": uom}, "conversion_factor"))
		if factor <= 0:  # a material saved before purchase units existed: register its roll / ream now
			c = material_cfg(frappe.db.get_value("Item", item.name, "atelier_packs") if _has("atelier_packs") else None)
			if c["pack"] == uom and c["pack_qty"] > 0:
				_pack_uom(item.name, uom, c["pack_qty"])
				factor = c["pack_qty"]
		if factor <= 0:
			frappe.throw(_("وحدة الشراء «{0}» غير معرّفة لهذه المادة. افتح «تعديل» واحفظ المادة مرة.").format(uom))
		row.update({"uom": uom, "conversion_factor": factor})
	if rate <= 0:
		frappe.throw(_("اكتب سعر الوحدة"))
	if not supplier or not frappe.db.exists("Supplier", supplier):
		frappe.throw(_("اختر المورد"))
	company = api._company()
	invoice = frappe.get_doc({"doctype": "Purchase Invoice", "supplier": supplier, "company": company, "posting_date": nowdate(),
		"update_stock": 1, "set_warehouse": store_for(company), "bill_no": (bill_no or "").strip() or None,
		"items": [{**row, "warehouse": store_for(company)}]})
	invoice.insert()
	invoice.submit()
	if row.get("uom") and abs(qty - round(qty)) < 1e-9:
		_bump_closed(item.name, int(round(qty)))
	return invoice.name


def _cfg_of(item_code):
	return material_cfg(frappe.db.get_value("Item", item_code, "atelier_packs") if _has("atelier_packs") else None)


def _save_cfg(item_code, c):
	frappe.db.set_value("Item", item_code, "atelier_packs", json.dumps(c, ensure_ascii=False))


def _bump_closed(item_code, n):
	c = _cfg_of(item_code)
	c["closed"] = max(0, c["closed"] + n)
	_save_cfg(item_code, c)


@frappe.whitelist(methods=["POST"])
def set_closed_packs(item_code, n):
	"""How many unopened rolls / reams are in the workshop now (a new material, or a count of the closed ones)."""
	_need("Item")
	_material(item_code)
	c = _cfg_of(item_code)
	c["closed"] = max(0, cint(n))
	_save_cfg(item_code, c)
	return c["closed"]


def _cycles_ok():
	return frappe.db.table_exists("Material Cycle")


def _cycle_start(item_code):
	"""When the pack now finishing was opened: the end of the previous cycle, else the first move of the material."""
	last = frappe.db.get_value("Material Cycle", {"item": item_code}, "closed_on", order_by="closed_on desc, creation desc") if _cycles_ok() else None
	if not last:
		opens = _cfg_of(item_code)["opens"]
		last = opens[-1]["date"] if opens else None
	return str(last or frappe.db.get_value("Stock Ledger Entry", {"item_code": item_code, "is_cancelled": 0}, "posting_date", order_by="posting_date asc") or nowdate())


def _used_since(item_code, since):
	"""Issued on orders (and by hand) since a date: [(order, qty)], total."""
	rows = frappe.db.sql("""select sle.voucher_no, -sum(sle.actual_qty) from `tabStock Ledger Entry` sle
		where sle.item_code=%s and sle.is_cancelled=0 and sle.voucher_type='Stock Entry' and sle.actual_qty<0 and sle.posting_date>=%s
		group by sle.voucher_no""", (item_code, since))
	entries = {r[0]: flt(r[1]) for r in rows}
	proj = dict(frappe.db.sql("select name, project from `tabStock Entry` where name in %s", [list(entries) or [""]]))
	orders = {o.project: o.name for o in frappe.get_all("Sales Order", filters={"project": ["in", [p for p in proj.values() if p] or [""]]}, fields=["name", "project"])}
	out = {}
	for v, q in entries.items():
		key = orders.get(proj.get(v)) or ""
		out[key] = out.get(key, 0) + q
	return out, sum(entries.values())


def _line_need(line, item_code, roll, waste):
	"""What one order line would take from this material (area + waste for a roll; pieces ÷ per sheet + waste for paper)."""
	from atelier.simple import units
	u = next((x for x in units() if x["name"] == (line.get("atelier_unit") or "")), None)
	calc = u["calc"] if u else "count"
	if roll:
		if calc != "area":
			return 0
		return flt(line.qty) * (0.0001 if u.get("scale") == "cm" else 1) * (1 + waste / 100)
	if calc != "count" or (u and u["name"] in ("خدمة", "ساعة")):
		return 0
	per = max(1, flt(line.get("atelier_per_sheet")) or 1)
	return math.ceil(round(flt(line.qty) / per * (1 + waste / 100), 6))


@frappe.whitelist()
def pack_cycle(item_code):
	"""Before «انتهت اللفّة»: the cycle so far, and orders printed but not yet deducted that may belong to it."""
	api._require("Bin")
	item = _material(item_code)
	c = _cfg_of(item.name)
	since = _cycle_start(item.name)
	by_order, used = _used_since(item.name, since)
	roll = (_cfg_family(item.name) == "roll")
	cands = []
	has_mat = frappe.db.has_column("Sales Order Item", "atelier_material")
	for so in frappe.get_all("Sales Order", filters={"docstatus": ["<", 2], "creation": [">=", since], "status": ["not in", ["Closed", "Cancelled"]]},
			fields=["name", "atelier_subject", "atelier_materials_done", *(["atelier_outsourced"] if frappe.db.has_column("Sales Order", "atelier_outsourced") else [])],
			order_by="creation desc", limit=60):
		if cint(so.get("atelier_materials_done")) or cint(so.get("atelier_outsourced")) or so.name in by_order:
			continue
		lines = frappe.get_all("Sales Order Item", filters={"parent": so.name},
			fields=["qty", "atelier_unit", "atelier_per_sheet", *(["atelier_material"] if has_mat else [])])
		need = sum(_line_need(l, item.name, roll, c["waste"]) for l in lines)
		if need > 0:
			mine = any((l.get("atelier_material") or "") == item.name for l in lines)
			cands.append({"order": so.name, "title": so.atelier_subject or so.name, "qty": round(need, 3), "checked": 1 if mine else 0})
	titles = {o.name: o.atelier_subject or o.name for o in frappe.get_all("Sales Order", filters={"name": ["in", [k for k in by_order if k] or [""]]}, fields=["name", "atelier_subject"])}
	return {"pack": c["pack"] or ("لفّة" if roll else "رزمة"), "size": c["pack_qty"], "uom": item.stock_uom, "since": since, "used": round(used, 3),
		"done": [{"order": k, "title": titles.get(k, "صرف يدوي" if not k else k), "qty": round(v, 3)} for k, v in by_order.items()], "candidates": cands[:30], "closed": c["closed"]}


def _cfg_family(item_code):
	return (frappe.db.get_value("Item", item_code, "atelier_family") if _has("atelier_family") else "") or ""


@frappe.whitelist(methods=["POST"])
def close_pack(item_code, orders=None):
	"""«انتهت اللفّة / الرزمة»: deduct the orders the user ticked, then close the cycle (open_pack) and keep it for the reports."""
	_need("Stock Entry")
	item = _material(item_code)
	since = _cycle_start(item.name)
	for o in frappe.parse_json(orders) or []:
		q = flt(o.get("qty"))
		if o.get("order") and q > 0:
			stock_issue(item.name, min(q, _on_hand(item.name, store_for(api._company()))), o["order"], _("مواد طلب {0}").format(o["order"]))
			frappe.db.set_value("Sales Order", o["order"], "atelier_materials_done", 1)
	by_order, used = _used_since(item.name, since)
	rate = flt(frappe.db.get_value("Bin", {"item_code": item.name, "warehouse": store_for(api._company())}, "valuation_rate"))
	res = open_pack(item.name)
	size = flt(res.get("size")) or _cfg_of(item.name)["pack_qty"]
	if _cycles_ok():
		frappe.get_doc({"doctype": "Material Cycle", "item": item.name, "item_name": frappe.db.get_value("Item", item.name, "item_name"),
			"opened_on": since, "closed_on": nowdate(), "size": size, "uom": item.stock_uom, "cost": round(size * rate, 2),
			"recorded": round(used, 4), "gap": round(size - used, 4), "coverage": min(100, round(used / size * 100, 1)) if size else 0,
			"orders": json.dumps([{"order": k, "qty": round(v, 3)} for k, v in by_order.items()], ensure_ascii=False)}).insert(ignore_permissions=True)
	return {**res, "used": round(used, 3), "waste": round(size - used, 3), "coverage": min(100, round(used / size * 100, 1)) if size else 0}


@frappe.whitelist(methods=["POST"])
def open_pack(item_code):
	"""«فتحت لفّة / رزمة جديدة»: the previous one is finished, so the true stock is known without measuring:
	closed ones × size + the one just opened (full). The gap with the computed stock is recorded as waste or unrecorded use."""
	_need("Stock Reconciliation")
	item = _material(item_code)
	c = _cfg_of(item.name)
	size = c["pack_qty"]
	if size <= 0:
		frappe.throw(_("لم يُحدَّد حجم اللفّة أو الرزمة لهذه المادة. افتح «تعديل» وأكمله."))
	if c["closed"] < 1:
		frappe.throw(_("لا توجد {0} مغلقة مسجّلة. سجّل الشراء أولًا، أو صحّح عدد المغلقة من «جرد».").format(c["pack"] or "لفّة"))
	store = store_for(api._company())
	before = _on_hand(item.name, store)
	c["closed"] -= 1
	actual = round(c["closed"] * size + size, 4)
	gap = round(before - actual, 4)  # > 0: more was used than recorded (waste); < 0: recorded more than used
	if abs(gap) > 1e-6:
		stock_count(item.name, actual)
	c["opens"] = (c["opens"] + [{"date": nowdate(), "gap": gap, "size": size}])[-12:]
	_save_cfg(item.name, c)
	return {"gap": gap, "closed": c["closed"], "stock": actual, "pack": c["pack"] or "لفّة", "size": size}


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
		"Sales Order": [{"fieldname": "atelier_materials_done", "label": "خُصمت المواد", "fieldtype": "Check", "read_only": 1, "insert_after": "atelier_due_time", "module": "Atelier"},
			{"fieldname": "atelier_outsourced", "label": "طُبع عند مورد", "fieldtype": "Check", "read_only": 1, "insert_after": "atelier_materials_done", "module": "Atelier"}],
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
	cycles = frappe.get_all("Material Cycle", filters={"item": item_code}, fields=["opened_on", "closed_on", "size", "cost", "recorded", "gap", "coverage"],
		order_by="closed_on desc, creation desc", limit=12) if _cycles_ok() else []
	good = [c for c in cycles if flt(c.coverage) >= 70 and flt(c.recorded) > 0]
	real = sum(flt(c.cost) for c in good) / sum(flt(c.recorded) for c in good) if len(good) >= 3 else None
	return {"rows": rows, "month_used": used, "daily": used60 / 60, "last_buy": last[0] if last else None, "cycles": cycles, "real_cost": real, "good_cycles": len(good)}


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
	# printed at a supplier: our rolls and paper were not used, only what the recipes add (stands, eyelets…)
	rolls = {} if _outsourced(so.name) else _rolls(store)
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
			pick = rolls.get(line.get("atelier_material") or "") or fit[0]  # the roll chosen on the order, else the narrowest that fits
			rows.append({"item_code": pick["item_code"], "item_name": pick["item_name"], "uom": "م²", "line": (line.description or line.item_name or "")[:80],
				"size": line.get("atelier_size") or "", "area": round(area, 3), "waste": pick["waste"],
				"need": round(area * (1 + pick["waste"] / 100), 3), "on_hand": pick["on_hand"],
				"choices": [{k: r[k] for k in ("item_code", "item_name", "on_hand", "waste")} for r in sorted(rolls.values(), key=lambda r: r["width"])]})
	# lines counted by the sheet / piece and printed here: ask which paper (the user picks; nothing is guessed)
	sheets = {} if _outsourced(so.name) else _sheets(store)
	if sheets:
		from atelier.simple import units
		counted = {u["name"] for u in units() if u["calc"] == "count"} - {"خدمة", "ساعة"}
		for line in so.items:
			unit = line.get("atelier_unit") or {"Nos": "قطعة", "Feuille": "ورقة"}.get(line.uom, line.uom)
			if unit not in counted or flt(line.qty) <= 0 or any(r["item_code"] in sheets for r in _recipe(line.item_code)):
				continue
			chosen, per = sheets.get(line.get("atelier_material") or ""), max(1, flt(line.get("atelier_per_sheet")) or 1)
			need = math.ceil(round(flt(line.qty) / per * (1 + (chosen["waste"] if chosen else 0) / 100), 6)) if chosen else flt(line.qty)
			rows.append({"item_code": chosen["item_code"] if chosen else "", "item_name": chosen["item_name"] if chosen else "", "uom": chosen["uom"] if chosen else "",
				"line": (line.description or line.item_name or "")[:80], "size": line.get("atelier_size") or "", "base": flt(line.qty), "per": per,
				"waste": chosen["waste"] if chosen else 0, "need": need, "on_hand": chosen["on_hand"] if chosen else 0, "ask": 1,
				"choices": [{k: r[k] for k in ("item_code", "item_name", "on_hand", "waste", "uom")} for r in sheets.values()]})
	for code, qty in needed.items():
		item = frappe.db.get_value("Item", code, ["item_name", "stock_uom", "disabled"], as_dict=True)
		if not item or item.disabled:
			continue
		if frappe.db.get_value("UOM", item.stock_uom, "must_be_whole_number"):
			qty = math.ceil(round(qty, 6))
		rows.append({"item_code": code, "item_name": item.item_name, "uom": item.stock_uom, "need": round(qty, 3), "on_hand": _on_hand(code, store)})
	return {"rows": rows, "done": cint(so.get("atelier_materials_done")), "delivered": flt(so.per_delivered) >= 100,
		"title": so.get("atelier_subject") or so.name, "outsourced": _outsourced(so.name)}


def _sheets(store):
	"""Materials used by the sheet or the piece (paper, card…): everything stocked that is neither a roll nor an ink bottle."""
	fam = ["atelier_family"] if _has("atelier_family") else []
	out = {}
	for r in frappe.get_all("Item", filters={"disabled": 0, "is_stock_item": 1}, fields=["name", "item_name", "stock_uom", "atelier_packs", *fam]):
		way = r.get("atelier_family") or ""
		if way in ("roll", "bottle") or (not way and r.stock_uom in ("م²", "m²", "Litre", "لتر", "قارورة")):
			continue
		c = material_cfg(r.atelier_packs)
		out[r.name] = {"item_code": r.name, "item_name": r.item_name, "uom": r.stock_uom, "waste": c["waste"], "on_hand": _on_hand(r.name, store)}
	return out


@frappe.whitelist(methods=["POST"])
def skip_materials(order):
	"""«لم يُستهلك من المخزون»: close the question for this order without moving the stock."""
	so = frappe.get_doc("Sales Order", order)
	so.check_permission("write")
	so.db_set("atelier_materials_done", 1)
	return True


@frappe.whitelist(methods=["POST"])
def issue_order_materials(order, rows):
	"""One confirmation per order. All lines succeed together, or none is issued."""
	_need("Stock Entry")
	so = frappe.get_doc("Sales Order", order)
	so.check_permission("write")
	if cint(so.get("atelier_materials_done")):
		frappe.throw(_("خُصمت مواد هذا الطلب من قبل"))
	issued = [stock_issue(r["item_code"], r["qty"], order, _("مواد طلب {0}").format(order)) for r in frappe.parse_json(rows) or [] if r.get("item_code") and flt(r.get("qty")) > 0]
	so.db_set("atelier_materials_done", 1)
	return issued


@frappe.whitelist()
def supplier_names():
	"""Suppliers to pick from when buying (fresh each time, so one added a minute ago is there)."""
	return frappe.get_list("Supplier", filters={"disabled": 0}, fields=["name", "supplier_name"], order_by="supplier_name asc", limit=1000)



def _outsourced(order):
	if not frappe.db.has_column("Sales Order", "atelier_outsourced"):
		return False
	return cint(frappe.db.get_value("Sales Order", order, "atelier_outsourced"))


@frappe.whitelist(methods=["POST"])
def mark_outsourced(order, on=1):
	"""The card went through a «عمل عند مورد» column: remembered on the order even if it moves on later."""
	so = frappe.get_doc("Sales Order", order)
	so.check_permission("write")
	if not frappe.db.has_column("Sales Order", "atelier_outsourced"):
		custom_fields()
		frappe.clear_cache(doctype="Sales Order")
	so.db_set("atelier_outsourced", 1 if cint(on) else 0)
	return True


@frappe.whitelist(methods=["POST"])
def outsource_cost(order, amount, supplier=None, note=None):
	"""What the supplier charged for this order, added to its cost (type «عند مورد»)."""
	from atelier import simple

	amount = flt(amount)
	if amount <= 0:
		frappe.throw(_("اكتب المبلغ"))
	view = simple.card_cost(order)
	sup = frappe.db.get_value("Supplier", supplier, "supplier_name") if supplier else None
	text = " — ".join(x for x in (_("طباعة عند مورد"), sup, (note or "").strip()[:60]) if x)[:140]
	lines = [{k: l.get(k) for k in ("cost_type", "description", "qty", "rate")} for l in view.get("lines") or []]
	types = simple.custom_list("cost_types")
	kind = next((c["value"] for c in types if c["value"] == "Sous-traitance"), None) or next((c["value"] for c in types if "مورد" in (c.get("label") or "")), None) or types[0]["value"]
	lines.append({"cost_type": kind, "description": text, "qty": 1, "rate": amount})
	simple.save_card_cost(order, json.dumps({"lines": lines, "qty": view.get("qty") or 1, "waste_percent": view.get("waste_percent") or 0}))
	return True


# ---------------------------------------------------------------- reports: what the materials really cost


def _real_cost(item_code):
	good = frappe.get_all("Material Cycle", filters={"item": item_code, "coverage": [">=", 70], "recorded": [">", 0]}, fields=["cost", "recorded"]) if _cycles_ok() else []
	return (sum(flt(c.cost) for c in good) / sum(flt(c.recorded) for c in good)) if len(good) >= 3 else None, len(good)


@frappe.whitelist()
def materials_report(period="month", start=None, end=None):
	"""Per material over a period: used (qty and money), waste from finished cycles, purchase vs real unit cost, and how much to trust it."""
	api._require("Bin")
	from atelier.simple import _period

	a, b = _period(period, start, end)[:2]
	store = store_for(api._company())
	fam = ["atelier_family"] if _has("atelier_family") else []
	items = frappe.get_all("Item", filters={"disabled": 0, "is_stock_item": 1}, fields=["name", "item_name", "stock_uom", "safety_stock", "atelier_packs", *fam])
	used = {r[0]: (-flt(r[1]), -flt(r[2])) for r in frappe.db.sql("""select item_code, sum(actual_qty), sum(stock_value_difference) from `tabStock Ledger Entry`
		where is_cancelled=0 and voucher_type='Stock Entry' and actual_qty<0 and posting_date between %s and %s group by item_code""", (a, b))}
	cyc = {}
	if _cycles_ok():
		for c in frappe.get_all("Material Cycle", filters={"closed_on": ["between", [a, b]]}, fields=["item", "size", "cost", "recorded", "gap", "coverage"]):
			x = cyc.setdefault(c.item, {"n": 0, "good": 0, "gap": 0, "size": 0, "gap_value": 0})
			x["n"] += 1
			if flt(c.coverage) >= 70:
				x["good"] += 1
				x["gap"] += max(0, flt(c.gap))
				x["size"] += flt(c.size)
				x["gap_value"] += max(0, flt(c.gap)) * (flt(c.cost) / flt(c.size) if flt(c.size) else 0)
	buy = {r[0]: flt(r[1]) for r in frappe.db.sql("""select pii.item_code, sum(pii.base_net_amount) / nullif(sum(pii.stock_qty), 0) from `tabPurchase Invoice Item` pii
		join `tabPurchase Invoice` pi on pi.name=pii.parent where pi.docstatus=1 group by pii.item_code""")}
	bins = {r.item_code: r for r in frappe.get_all("Bin", filters={"warehouse": store}, fields=["item_code", "actual_qty", "stock_value", "valuation_rate"])}
	rows, printed_m2 = [], 0
	for it in items:
		way = it.get("atelier_family") or ("roll" if it.stock_uom in ("م²", "m²") else "")
		q, v = used.get(it.name, (0, 0))
		if way == "roll":
			printed_m2 += q
		real, good_all = _real_cost(it.name)
		c = cyc.get(it.name) or {}
		unit = buy.get(it.name) or flt((bins.get(it.name) or {}).get("valuation_rate"))
		rows.append({"item_code": it.name, "item_name": it.item_name, "uom": it.stock_uom, "way": way, "used": round(q, 3), "used_value": round(v, 2),
			"cycles": c.get("n", 0), "good": c.get("good", 0), "waste": round(c.get("gap", 0), 3), "waste_pct": round(c["gap"] / c["size"] * 100, 1) if c.get("size") else None,
			"waste_value": round(c.get("gap_value", 0), 2), "unit_buy": round(unit, 4), "unit_real": round(real, 4) if real else None, "good_all": good_all,
			"diff_pct": round((real - unit) / unit * 100, 1) if real and unit else None,
			"stock_value": flt((bins.get(it.name) or {}).get("stock_value")), "low": bool(it.safety_stock) and flt((bins.get(it.name) or {}).get("actual_qty")) < flt(it.safety_stock)})
	ink = sum(r["used_value"] for r in rows if r["way"] == "bottle")
	for r in rows:
		if r["way"] == "bottle":
			r["per_m2"] = round(r["used_value"] / printed_m2, 2) if printed_m2 > 0 else None
	rows.sort(key=lambda r: (-r["waste_value"], -r["used_value"]))
	return {"from": str(a), "to": str(b), "rows": rows,
		"used_value": round(sum(r["used_value"] for r in rows), 2), "waste_value": round(sum(r["waste_value"] for r in rows), 2),
		"cycles": sum(r["cycles"] for r in rows), "good": sum(r["good"] for r in rows), "stock_value": round(sum(r["stock_value"] for r in rows), 2),
		"low": sum(1 for r in rows if r["low"]), "ink_per_m2": round(ink / printed_m2, 2) if printed_m2 > 0 else None}


@frappe.whitelist()
def material_detail(item_code):
	"""One material: every finished roll / ream, and what each supplier charged per roll / ream over time."""
	api._require("Bin")
	item = _material(item_code)
	c = _cfg_of(item.name)
	cycles = frappe.get_all("Material Cycle", filters={"item": item.name}, fields=["opened_on", "closed_on", "size", "cost", "recorded", "gap", "coverage", "orders"],
		order_by="closed_on desc, creation desc", limit=24) if _cycles_ok() else []
	for x in cycles:
		x.days = (frappe.utils.getdate(x.closed_on) - frappe.utils.getdate(x.opened_on)).days if x.opened_on and x.closed_on else None
		try:
			x.n_orders = len([o for o in json.loads(x.pop("orders") or "[]") if o.get("order")])
		except ValueError:
			x.n_orders = 0
		x.real = round(flt(x.cost) / flt(x.recorded), 4) if flt(x.recorded) > 0 and flt(x.coverage) >= 70 else None
	buys = frappe.db.sql("""select pi.posting_date, pi.supplier_name, pii.base_net_amount / nullif(pii.stock_qty, 0) unit from `tabPurchase Invoice Item` pii
		join `tabPurchase Invoice` pi on pi.name=pii.parent where pi.docstatus=1 and pii.item_code=%s order by pi.posting_date asc, pi.creation asc limit 40""", item.name, as_dict=True)
	size = c["pack_qty"] if c["pack_qty"] > 0 else 1
	for x in buys:
		x.per_pack = round(flt(x.unit) * size, 2)
	return {"pack": c["pack"] or "", "size": size, "uom": item.stock_uom, "cycles": cycles, "buys": buys}


# ---------------------------------------------------------------- profit per order and pricing help


def target_margin():
	return flt(frappe.db.get_default("atelier_target_margin") or 30)


@frappe.whitelist(methods=["POST"])
def set_target_margin(value):
	from atelier.simple import _manager_only

	_manager_only()
	v = max(0, min(90, flt(value)))
	frappe.db.set_default("atelier_target_margin", str(v))
	return v


def _ink_per_m2(days=90):
	"""Ink is not traced to orders: its cost over a period ÷ the m² of rolls used in it (an estimate, said so)."""
	since = frappe.utils.add_days(nowdate(), -days)
	fam = _has("atelier_family")
	rows = frappe.db.sql(f"""select it.stock_uom, {"it.atelier_family" if fam else "''"}, -sum(sle.actual_qty), -sum(sle.stock_value_difference)
		from `tabStock Ledger Entry` sle join `tabItem` it on it.name=sle.item_code
		where sle.is_cancelled=0 and sle.voucher_type='Stock Entry' and sle.actual_qty<0 and sle.posting_date>=%s group by it.name""", since)
	m2 = sum(flt(r[2]) for r in rows if r[1] == "roll" or (not r[1] and r[0] in ("م²", "m²")))
	ink = sum(flt(r[3]) for r in rows if r[1] == "bottle" or (not r[1] and r[0] in ("لتر", "Litre", "قارورة")))
	return round(ink / m2, 4) if m2 > 0 else 0


@frappe.whitelist()
def pricing_info():
	"""For the price hint under an order line: target margin, ink per m², real unit cost of each material."""
	reals = {}
	if _cycles_ok():
		for r in frappe.db.sql("""select item, sum(cost), sum(recorded), count(*) from `tabMaterial Cycle` where coverage>=70 and recorded>0 group by item"""):
			if cint(r[3]) >= 3 and flt(r[2]) > 0:
				reals[r[0]] = round(flt(r[1]) / flt(r[2]), 4)
	return {"target": target_margin(), "ink_per_m2": _ink_per_m2(), "real": reals}


@frappe.whitelist()
def profit_report(period="month", start=None, end=None):
	"""Each priced order of the period: sale − materials (real unit cost when known) − supplier − other costs − ink (estimate)."""
	api._require("GL Entry")
	from atelier.simple import _period, material_cost_types

	a, b = _period(period, start, end)[:2]
	target = target_margin()
	info = pricing_info()
	sos = frappe.get_all("Sales Order", filters={"docstatus": ["<", 2], "transaction_date": ["between", [a, b]]},
		fields=["name", "atelier_subject", "customer_name", "net_total", "project", "transaction_date"], order_by="transaction_date desc", limit=500)
	pending = set(frappe.get_all("Sales Order Item", filters={"parent": ["in", [s.name for s in sos] or [""]], "atelier_price_pending": 1}, pluck="parent"))
	sos = [s for s in sos if s.name not in pending and flt(s.net_total) > 0]
	projects = {s.project: s.name for s in sos if s.project}
	fam = _has("atelier_family")
	issues = frappe.db.sql(f"""select se.project, sed.item_code, sum(sed.qty), sum(sed.amount), it.stock_uom, {"it.atelier_family" if fam else "''"}
		from `tabStock Entry Detail` sed join `tabStock Entry` se on se.name=sed.parent join `tabItem` it on it.name=sed.item_code
		where se.docstatus=1 and se.stock_entry_type='Material Issue' and se.project in %s group by se.project, sed.item_code""", [list(projects) or [""]])
	mat, rec, m2 = {}, {}, {}
	for proj, code, qty, amount, uom_, way in issues:
		so = projects.get(proj)
		real = info["real"].get(code)
		cost = flt(qty) * real if real else flt(amount)
		roll = way == "roll" or (not way and uom_ in ("م²", "m²"))
		bucket = mat if (roll or way == "count") else rec
		bucket[so] = bucket.get(so, 0) + cost
		if roll:
			m2[so] = m2.get(so, 0) + flt(qty)
	matl = material_cost_types()
	sup, other = {}, {}
	for est, so_name in frappe.db.sql("select name, sales_order from `tabCost Estimate` where sales_order in %s", [[s.name for s in sos] or [""]]):
		for l in frappe.get_all("Cost Estimate Line", filters={"parent": est}, fields=["cost_type", "amount"]):
			if l.cost_type == "Sous-traitance":
				sup[so_name] = sup.get(so_name, 0) + flt(l.amount)
			elif l.cost_type in matl and (so_name in mat or so_name in rec):
				continue  # already counted from the stock it took
			else:
				other[so_name] = other.get(so_name, 0) + flt(l.amount)
	rows = []
	for s in sos:
		parts = {"materials": round(mat.get(s.name, 0), 2), "supplier": round(sup.get(s.name, 0), 2), "recipes": round(rec.get(s.name, 0), 2),
			"ink": round(m2.get(s.name, 0) * info["ink_per_m2"], 2), "other": round(other.get(s.name, 0), 2)}
		cost = sum(parts.values())
		sale = flt(s.net_total)
		rows.append({"order": s.name, "title": s.atelier_subject or s.name, "customer": s.customer_name, "date": str(s.transaction_date), "sale": sale,
			"cost": round(cost, 2), "parts": parts, "m2": round(m2.get(s.name, 0), 3), "profit": round(sale - cost, 2) if cost else None,
			"margin": round((sale - cost) / sale * 100, 1) if cost else None})
	costed = [r for r in rows if r["margin"] is not None]
	rows.sort(key=lambda r: (r["margin"] is None, r["margin"] if r["margin"] is not None else 0))
	sale_c, cost_c = sum(r["sale"] for r in costed), sum(r["cost"] for r in costed)
	under = [r for r in costed if r["margin"] < target]
	return {"target": target, "ink_per_m2": info["ink_per_m2"], "rows": rows,
		"sales": round(sum(r["sale"] for r in rows), 2), "orders": len(rows), "costed": len(costed), "sales_costed": round(sale_c, 2),
		"cost": round(cost_c, 2), "parts": {k: round(sum(r["parts"][k] for r in costed), 2) for k in ("materials", "supplier", "recipes", "ink", "other")},
		"profit": round(sale_c - cost_c, 2), "margin": round((sale_c - cost_c) / sale_c * 100, 1) if sale_c else None,
		"under": len(under), "lost": round(sum(r["sale"] * target / 100 - (r["sale"] - r["cost"]) for r in under), 2), "losses": sum(1 for r in costed if r["profit"] < 0)}


@frappe.whitelist(methods=["POST"])
def purchase_bill(supplier, lines, bill_no=None, posting_date=None, paid=None, mode="Cash", due_date=None):
	"""One supplier invoice with several materials, each in its roll / ream / unit; «دفعت الآن» pays it in full,
	in part or not at all (the rest stays owed to the supplier)."""
	_need("Purchase Invoice")
	if not supplier or not frappe.db.exists("Supplier", supplier):
		frappe.throw(_("اختر المورد"))
	company, store = api._company(), store_for(api._company())
	rows, packs = [], []
	for l in frappe.parse_json(lines) or []:
		if not l.get("item_code") or flt(l.get("qty")) <= 0:
			continue
		item = _material(l["item_code"])
		if flt(l.get("rate")) <= 0:
			frappe.throw(_("اكتب سعر «{0}»").format(frappe.db.get_value("Item", item.name, "item_name")))
		row = {"item_code": item.name, "qty": flt(l["qty"]), "rate": flt(l["rate"]), "warehouse": store}
		uom = (l.get("uom") or "").strip()
		if uom and uom != item.stock_uom:
			factor = flt(frappe.db.get_value("UOM Conversion Detail", {"parent": item.name, "uom": uom}, "conversion_factor"))
			if factor <= 0:
				c = _cfg_of(item.name)
				if c["pack"] == uom and c["pack_qty"] > 0:
					_pack_uom(item.name, uom, c["pack_qty"])
					factor = c["pack_qty"]
			if factor <= 0:
				frappe.throw(_("وحدة الشراء «{0}» غير معرّفة للمادة").format(uom))
			row.update({"uom": uom, "conversion_factor": factor})
			if abs(flt(l["qty"]) - round(flt(l["qty"]))) < 1e-9:
				packs.append((item.name, int(round(flt(l["qty"])))))
		rows.append(row)
	if not rows:
		frappe.throw(_("أضف مادة واحدة على الأقل"))
	inv = frappe.get_doc({"doctype": "Purchase Invoice", "supplier": supplier, "company": company,
		"posting_date": posting_date or nowdate(), "set_posting_time": 1 if posting_date else 0,
		"due_date": due_date or None, "update_stock": 1, "set_warehouse": store, "bill_no": (bill_no or "").strip() or None, "items": rows})
	inv.insert()
	inv.submit()
	for code, n in packs:
		_bump_closed(code, n)
	pay = flt(paid) if paid not in (None, "") else flt(inv.grand_total)
	payment = None
	if pay > 0.005:
		from atelier.simple import pay_supplier

		payment = pay_supplier(inv.name, mode or "Cash", min(pay, flt(inv.grand_total)))
	return {"invoice": inv.name, "total": flt(inv.grand_total), "paid": min(pay, flt(inv.grand_total)), "owed": round(max(0, flt(inv.grand_total) - pay), 2), "payment": payment}


@frappe.whitelist()
def services_overview():
	"""Each sales service: prices, cost per unit from its recipe (real unit cost when known), margin, and its sales."""
	from frappe.utils import add_months, get_first_day, nowdate

	from atelier.api import PRICE_LISTS, _with_prices

	api._require("Item Price")
	info = pricing_info()
	target = info["target"]
	items = frappe.get_list("Item", filters={"disabled": 0, "is_sales_item": 1, "name": ["!=", "SRV-GENERAL"]},
		fields=["item_code", "item_name", "stock_uom", "atelier_category", "is_stock_item", "atelier_recipe"], order_by="item_name asc", limit=1000)
	_with_prices(items)
	mats = {}
	for r in frappe.db.sql("""select it.name, it.item_name, it.stock_uom, it.valuation_rate, sum(b.stock_value), sum(b.actual_qty)
		from `tabItem` it left join `tabBin` b on b.item_code=it.name where it.is_stock_item=1 group by it.name""", as_list=True):
		buy = flt(r[4]) / flt(r[5]) if flt(r[5]) > 0 else flt(r[3])
		mats[r[0]] = {"name": r[1], "uom": r[2], "buy": buy, "real": info["real"].get(r[0])}
	since3 = add_months(nowdate(), -3)
	since6 = get_first_day(add_months(nowdate(), -5))
	sales = {}
	for code, n, qty, amount in frappe.db.sql("""select soi.item_code, count(distinct so.name), sum(soi.qty), sum(soi.net_amount)
		from `tabSales Order Item` soi join `tabSales Order` so on so.name=soi.parent
		where so.docstatus=1 and so.transaction_date>=%s group by soi.item_code""", since3):
		sales[code] = {"orders": cint(n), "qty": flt(qty), "amount": flt(amount), "avg": flt(amount) / flt(qty) if flt(qty) else 0}
	months = {}
	for code, ym, amount in frappe.db.sql("""select soi.item_code, date_format(so.transaction_date, '%%Y-%%m'), sum(soi.net_amount)
		from `tabSales Order Item` soi join `tabSales Order` so on so.name=soi.parent
		where so.docstatus=1 and so.transaction_date>=%s group by soi.item_code, 2""", since6):
		months.setdefault(code, {})[ym] = flt(amount)
	top = {}
	for code, cust, n in frappe.db.sql("""select soi.item_code, so.customer_name, count(distinct so.name) c
		from `tabSales Order Item` soi join `tabSales Order` so on so.name=soi.parent
		where so.docstatus=1 and so.transaction_date>=%s group by soi.item_code, so.customer_name order by c desc""", since6):
		top.setdefault(code, {"customer": cust, "orders": cint(n)})
	keys = [str(add_months(since6, k))[:7] for k in range(6)]
	from atelier.simple import units

	area = {u["name"] for u in units() if u.get("calc") == "area"}
	out = []
	for i in items:
		try:
			recipe = json.loads(i.pop("atelier_recipe") or "[]")
		except ValueError:
			recipe = []
		parts, cost = [], None
		if recipe:
			cost = 0
			for r in recipe:
				m = mats.get(r.get("item_code"))
				if not m:
					continue
				unit = m["real"] or m["buy"]
				line = flt(r.get("qty")) * unit
				cost += line
				parts.append({"label": m["name"], "qty": flt(r.get("qty")), "uom": m["uom"], "unit": unit, "real": bool(m["real"]), "amount": line})
			if i.stock_uom in area and info["ink_per_m2"]:
				parts.append({"label": _("حبر (تقدير)"), "qty": 1, "uom": i.stock_uom, "unit": info["ink_per_m2"], "real": False, "amount": info["ink_per_m2"], "estimate": True})
				cost += info["ink_per_m2"]
		price = i.price_company if i.price_company is not None else i.price_individual
		margin = round((flt(price) - cost) / flt(price) * 100, 1) if cost is not None and flt(price) > 0 else None
		out.append({**i, "cost": cost, "parts": parts, "margin": margin,
			"min_price": round(cost / (1 - target / 100), 2) if cost and target < 100 else None,
			"sales": sales.get(i.item_code), "months": [months.get(i.item_code, {}).get(k, 0) for k in keys], "top": top.get(i.item_code)})
	return {"items": out, "target": target, "months": keys, "can_edit": api._can("Item Price", "write"), "lists": {k: api._price_list(k) for k in PRICE_LISTS}}
