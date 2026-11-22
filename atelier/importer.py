"""Importing a shop's existing lists from Excel: customers, suppliers, materials, services with prices, and opening
debts. Each kind has a template; a file is checked row by row (new / already there / error) before anything is
written, and the run is all or nothing. Rows already in رقمي are skipped, never replaced. Manager only."""

import base64
import re
from datetime import date, datetime

import frappe
from frappe import _
from frappe.utils import cstr, flt, getdate, nowdate

# kind → columns (header, key, required)
KINDS = {
	"customers": ("العملاء", [("الاسم", "name", 1), ("الهاتف", "phone", 0), ("النوع (فرد/مؤسسة)", "type", 0), ("NIF", "tax_id", 0),
		("RC", "rc", 0), ("البريد", "email", 0), ("العنوان", "address", 0), ("لغة المستندات (ar/fr)", "lang", 0), ("ملاحظة", "note", 0)]),
	"suppliers": ("الموردون", [("الاسم", "name", 1), ("الهاتف", "phone", 0), ("ماذا يورّد", "supplies", 0), ("NIF", "tax_id", 0),
		("RC", "rc", 0), ("البريد", "email", 0), ("العنوان", "address", 0)]),
	"materials": ("المواد", [("الاسم", "name", 1), ("الوحدة", "uom", 0), ("الحد الأدنى", "min_qty", 0),
		("الكمية الافتتاحية", "qty", 0), ("سعر الشراء للوحدة", "rate", 0)]),
	"services": ("الخدمات والأسعار", [("الاسم", "name", 1), ("الاسم بالفرنسية", "name_fr", 0), ("التصنيف", "category", 0),
		("الوحدة", "uom", 0), ("سعر الأفراد", "price_individual", 0), ("سعر المؤسسات", "price_company", 0), ("النوع (خدمة/منتج)", "kind", 0)]),
	"opening": ("الديون الافتتاحية", [("النوع (عميل/مورد)", "party_type", 1), ("الاسم", "name", 1), ("المبلغ", "amount", 1),
		("التاريخ", "date", 0), ("ملاحظة", "note", 0)]),
}
EXAMPLES = {
	"customers": ["مكتبة النور", "0661 22 33 44", "مؤسسة", "001919012345678", "", "", "سطيف", "fr", ""],
	"suppliers": ["مورد الورق", "0550 11 22 33", "ورق A4 وA3", "", "", "", "العلمة"],
	"materials": ["ورق A4 80g", "ورقة", 500, 2500, 1.6],
	"services": ["بطاقات زيارة", "Cartes de visite", "طباعة رقمية", "قطعة", 15, 12, "خدمة"],
	"opening": ["عميل", "مكتبة النور", 12000, "31/12/2025", "رصيد الدفتر القديم"],
}
MAX_ROWS = 2000


def _manager():
	from atelier.simple import _manager_only

	_manager_only()


def _kind(kind):
	if kind not in KINDS:
		frappe.throw(_("نوع استيراد غير معروف"))
	return KINDS[kind]


@frappe.whitelist()
def import_template(kind):
	"""The empty template (headers + one example row) as an .xlsx download."""
	_manager()
	title, cols = _kind(kind)
	from frappe.utils.xlsxutils import make_xlsx

	xlsx = make_xlsx([[c[0] for c in cols], EXAMPLES[kind]], title[:30])
	frappe.response["filename"] = f"raqmi-{kind}.xlsx"
	frappe.response["filecontent"] = xlsx.getvalue()
	frappe.response["type"] = "binary"


def _read(content):
	from frappe.utils.xlsxutils import read_xlsx_file_from_attached_file

	try:
		raw = base64.b64decode(content.split(",", 1)[-1])
		rows = read_xlsx_file_from_attached_file(fcontent=raw)
	except Exception:
		frappe.throw(_("تعذّرت قراءة الملف. احفظه بصيغة Excel (.xlsx) وأعد المحاولة."))
	return rows or []


def _num(v):
	if v in (None, ""):
		return None
	if isinstance(v, (int, float)):
		return float(v)
	s = re.sub(r"[\s  دجDAda]", "", cstr(v)).replace(",", ".")
	if s.count(".") > 1:  # 1.500.00 → thousands dots
		head, _sep, tail = s.rpartition(".")
		s = head.replace(".", "") + "." + tail
	try:
		return float(s)
	except ValueError:
		return "bad"


def _date(v):
	if v in (None, ""):
		return None
	if isinstance(v, datetime):
		return v.date()
	if isinstance(v, date):
		return v
	s = cstr(v).strip()
	m = re.match(r"^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$", s)
	try:
		return date(int(m[3]), int(m[2]), int(m[1])) if m else getdate(s)
	except Exception:
		return "bad"


def _phone(s):
	d = re.sub(r"\D", "", s or "")
	return d


def _rows(kind, content):
	"""The file's rows as dicts by key, matched on the header names (any order, extra columns ignored)."""
	_title, cols = _kind(kind)
	data = _read(content)
	head_at = next((i for i, r in enumerate(data[:10]) if any(cstr(c).strip() == cols[0][0] for c in r)), None)
	if head_at is None:
		frappe.throw(_("لم يُعثر على عمود «{0}». استعمل قالب «{1}» دون تغيير أسماء الأعمدة.").format(cols[0][0], _title))
	header = [cstr(c).strip() for c in data[head_at]]
	index = {}
	for label, key, _req in cols:
		short = label.split(" (")[0]
		pos = next((i for i, h in enumerate(header) if h == label or h.split(" (")[0] == short), None)
		if pos is not None:
			index[key] = pos
	missing = [c[0] for c in cols if c[2] and c[1] not in index]
	if missing:
		frappe.throw(_("أعمدة ناقصة: {0}").format("، ".join(missing)))
	out = []
	for n, r in enumerate(data[head_at + 1:], start=head_at + 2):
		row = {k: (r[i] if i < len(r) else None) for k, i in index.items()}
		row = {k: (v.strip() if isinstance(v, str) else v) for k, v in row.items()}
		if all(v in (None, "") for v in row.values()):
			continue
		out.append({"line": n, **row})
	if len(out) > MAX_ROWS:
		frappe.throw(_("الملف أكبر من {0} سطر. قسّمه إلى ملفات أصغر.").format(MAX_ROWS))
	return out


# ---------------------------------------------------------------- checking


def _check_party(kind, rows):
	doctype = "Customer" if kind == "customers" else "Supplier"
	name_field = "customer_name" if kind == "customers" else "supplier_name"
	phone_field = "mobile_no" if kind == "customers" else "atelier_phone"
	names = {cstr(n).strip().lower() for n in frappe.get_all(doctype, pluck=name_field)}
	phones = {_phone(p)[-9:] for p in frappe.get_all(doctype, pluck=phone_field) if p and len(_phone(p)) >= 9}
	seen_n, seen_p = set(), set()
	for r in rows:
		name, phone = cstr(r.get("name")), _phone(cstr(r.get("phone")))
		r["name"], r["phone"] = name, cstr(r.get("phone") or "").strip()
		if not name:
			r["error"] = _("الاسم فارغ")
		elif phone and not (9 <= len(phone) <= 13):
			r["error"] = _("هاتف غير صحيح")
		elif r.get("email") and not frappe.utils.validate_email_address(cstr(r["email"])):
			r["error"] = _("بريد غير صحيح")
		elif kind == "customers" and r.get("type") and cstr(r["type"]) not in ("فرد", "مؤسسة", "Individual", "Company"):
			r["error"] = _("النوع: فرد أو مؤسسة")
		elif kind == "customers" and r.get("lang") and cstr(r["lang"]).lower() not in ("ar", "fr"):
			r["error"] = _("لغة المستندات: ar أو fr")
		elif name.lower() in names:
			r["exists"] = _("موجود: نفس الاسم")
		elif phone and phone[-9:] in phones:
			r["exists"] = _("موجود: نفس الهاتف")
		elif name.lower() in seen_n or (phone and phone[-9:] in seen_p):
			r["exists"] = _("مكرر في الملف")
		seen_n.add(name.lower())
		if phone:
			seen_p.add(phone[-9:])


def _check_items(kind, rows):
	names = {cstr(n).strip().lower() for n in frappe.get_all("Item", filters={"disabled": 0}, pluck="item_name")}
	seen = set()
	nums = ("min_qty", "qty", "rate") if kind == "materials" else ("price_individual", "price_company")
	for r in rows:
		name = cstr(r.get("name"))
		r["name"] = name
		for k in nums:
			r[k] = _num(r.get(k))
		bad = next((k for k in nums if r[k] == "bad" or (r[k] is not None and r[k] < 0)), None)
		if not name:
			r["error"] = _("الاسم فارغ")
		elif bad:
			r["error"] = _("رقم غير صحيح في «{0}»").format(next(c[0] for c in KINDS[kind][1] if c[1] == bad))
		elif kind == "materials" and flt(r["qty"]) > 0 and flt(r["rate"]) <= 0:
			r["error"] = _("الكمية الافتتاحية تحتاج سعر الشراء")
		elif kind == "services" and r.get("kind") and cstr(r["kind"]) not in ("خدمة", "منتج"):
			r["error"] = _("النوع: خدمة أو منتج")
		elif name.lower() in names:
			r["exists"] = _("موجود: نفس الاسم")
		elif name.lower() in seen:
			r["exists"] = _("مكرر في الملف")
		seen.add(name.lower())


def _party_of(party_type, name):
	doctype = "Customer" if party_type == "عميل" else "Supplier"
	field = "customer_name" if doctype == "Customer" else "supplier_name"
	return doctype, (frappe.db.get_value(doctype, {"name": name}) or frappe.db.get_value(doctype, {field: name}))


def _in_open_year(d):
	from atelier import api

	company = api._company()
	if not frappe.db.exists("Fiscal Year", {"year_start_date": ["<=", d], "year_end_date": [">=", d], "disabled": 0}):
		return False
	frozen = frappe.db.get_value("Company", company, "accounts_frozen_till_date") if frappe.db.has_column("Company", "accounts_frozen_till_date") else None
	return not (frozen and getdate(d) <= getdate(frozen))


def _check_opening(rows):
	seen = set()
	for r in rows:
		r["name"], pt = cstr(r.get("name")), cstr(r.get("party_type"))
		r["amount"], r["date"] = _num(r.get("amount")), _date(r.get("date"))
		if pt not in ("عميل", "مورد"):
			r["error"] = _("النوع: عميل أو مورد")
			continue
		doctype, party = _party_of(pt, r["name"])
		r["party"], r["doctype"] = party, doctype
		if not r["name"]:
			r["error"] = _("الاسم فارغ")
		elif not party:
			r["error"] = _("غير موجود في رقمي — استورده أولًا")
		elif r["amount"] in (None, "bad") or r["amount"] <= 0:
			r["error"] = _("مبلغ غير صحيح")
		elif r["date"] == "bad":
			r["error"] = _("تاريخ غير صحيح (يوم/شهر/سنة)")
		elif r["date"] and r["date"] > getdate(nowdate()):
			r["error"] = _("التاريخ في المستقبل")
		elif r["date"] and not _in_open_year(r["date"]):
			r["error"] = _("لا توجد سنة مالية مفتوحة لهذا التاريخ")
		elif frappe.db.exists("Journal Entry Account", {"party_type": doctype, "party": party, "docstatus": 1,
				"parent": ["in", frappe.get_all("Journal Entry", filters={"voucher_type": "Opening Entry", "docstatus": 1}, pluck="name") or [""]]}):
			r["exists"] = _("له دين سابق مسجّل")
		elif (doctype, party) in seen:
			r["exists"] = _("مكرر في الملف")
		seen.add((doctype, party))


def _checked(kind, content):
	rows = _rows(kind, content)
	if kind in ("customers", "suppliers"):
		_check_party(kind, rows)
	elif kind in ("materials", "services"):
		_check_items(kind, rows)
	else:
		_check_opening(rows)
	for r in rows:
		r["status"] = "error" if r.get("error") else "exists" if r.get("exists") else "new"
	return rows


def _public(r):
	return {k: (str(v) if isinstance(v, date) else v) for k, v in r.items() if k not in ("party", "doctype")}


@frappe.whitelist(methods=["POST"])
def import_check(kind, content):
	_manager()
	rows = _checked(kind, content)
	count = {s: sum(1 for r in rows if r["status"] == s) for s in ("new", "exists", "error")}
	return {"kind": kind, "columns": [[c[0], c[1]] for c in KINDS[kind][1]], "rows": [_public(r) for r in rows], "count": count}


@frappe.whitelist(methods=["POST"])
def import_errors(kind, content):
	"""The rows with errors, as an .xlsx to fix and upload again (the reason in the last column)."""
	_manager()
	cols = KINDS[kind][1]
	data = [[c[0] for c in cols] + [_("الخطأ")]]
	for r in _checked(kind, content):
		if r["status"] == "error":
			data.append([("" if r.get(c[1]) is None else str(r.get(c[1]))) for c in cols] + [r["error"]])
	from frappe.utils.xlsxutils import make_xlsx

	return base64.b64encode(make_xlsx(data, "errors").getvalue()).decode()


# ---------------------------------------------------------------- writing


def _add_customer(r):
	from atelier import api

	company = cstr(r.get("type")) in ("مؤسسة", "Company")
	name = api.save_customer({"customer_name": r["name"], "mobile_no": r["phone"], "customer_type": "Company" if company else "Individual",
		"tax_id": cstr(r.get("tax_id")), "email_id": cstr(r.get("email")), "address": cstr(r.get("address")), "notes": cstr(r.get("note"))})
	extra = {}
	if r.get("rc") and frappe.db.has_column("Customer", "atelier_rc"):
		extra["atelier_rc"] = cstr(r["rc"])
	if r.get("lang") and frappe.db.has_column("Customer", "atelier_doc_lang"):
		extra["atelier_doc_lang"] = cstr(r["lang"]).lower()
	if extra:
		frappe.db.set_value("Customer", name, extra)


def _add_supplier(r):
	from atelier import simple

	simple.save_supplier({"supplier_name": r["name"], "phone": r["phone"], "supplies": cstr(r.get("supplies")), "tax_id": cstr(r.get("tax_id")),
		"rc": cstr(r.get("rc")), "email": cstr(r.get("email")), "address": cstr(r.get("address"))})


def _add_material(r):
	from atelier import materials

	code = materials.add_material(r["name"], cstr(r.get("uom")) or "قطعة", flt(r.get("min_qty")))
	if flt(r.get("qty")) > 0:
		materials.stock_count(code, flt(r["qty"]), flt(r["rate"]))
	elif flt(r.get("rate")) > 0:
		frappe.db.set_value("Item", code, "valuation_rate", flt(r["rate"]))


def _add_service(r):
	from atelier import api

	item = api.create_item({"item_name": r["name"], "uom": cstr(r.get("uom")) or "قطعة", "category": cstr(r.get("category")),
		"kind": "product" if cstr(r.get("kind")) == "منتج" else "service",
		"price_individual": r.get("price_individual"), "price_company": r.get("price_company")})
	if r.get("name_fr") and frappe.db.has_column("Item", "atelier_name_fr"):
		frappe.db.set_value("Item", item["item_code"], "atelier_name_fr", cstr(r["name_fr"])[:140])


def _add_opening(r):
	from atelier import opening

	opening.add_opening(r["doctype"], r["party"], r["amount"], str(r["date"]) if r.get("date") else None,
		cstr(r.get("note")) or _("دين سابق (استيراد Excel)"))


WRITERS = {"customers": _add_customer, "suppliers": _add_supplier, "materials": _add_material, "services": _add_service, "opening": _add_opening}


@frappe.whitelist(methods=["POST"])
def import_run(kind, content):
	"""Write every «new» row, all or nothing: one failing row undoes the whole file."""
	_manager()
	rows = [r for r in _checked(kind, content) if r["status"] == "new"]
	if not rows:
		frappe.throw(_("لا أسطر جديدة للاستيراد"))
	frappe.db.savepoint("atelier_import")
	for r in rows:
		try:
			WRITERS[kind](r)
		except Exception as e:
			frappe.db.rollback(save_point="atelier_import")
			frappe.clear_last_message()
			msg = getattr(e, "message", None) or cstr(e) or type(e).__name__
			frappe.throw(_("توقف الاستيراد عند السطر {0} ({1}): {2}. لم يُحفظ أي سطر.").format(r["line"], r["name"], re.sub("<[^>]+>", "", msg)))
	return {"imported": len(rows)}
