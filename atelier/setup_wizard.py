"""The new shop's setup wizard: eight steps, each one marked done from the shop's own data (nothing to tick by
hand), a step can be skipped, and the wizard hidden. Shown to the manager at first login until the essential steps
are done. Manager only."""

import json

import frappe
from frappe import _

STEPS = [
	# key, title, hint, settings tab (None = in the wizard), optional
	("profile", "بيانات المطبعة", "الاسم، الهاتف، العنوان، الشعار", "profile", 0),
	("docs", "الوثائق والضريبة", "RC وNIF، TVA، نص أسفل الفاتورة", "docs", 0),
	("funds", "الصناديق وأرصدتها", "الصندوق، البنك، CCP، الرصيد الحالي", "funds", 0),
	("services", "الخدمات والأسعار", "يدويًا أو من Excel", None, 0),
	("materials", "المواد والمخزون", "الورق والحبر والكميات الحالية", "import", 1),
	("parties", "العملاء والموردون", "من Excel، مع ديونهم السابقة", "import", 0),
	("team", "الفريق", "حسابات البائع والمصمم والطابع", "team", 0),
	("columns", "أعمدة اللوحة", "الافتراضية جاهزة", "columns", 1),
]


def _manager():
	from atelier.simple import _manager_only

	_manager_only()


def _state():
	try:
		return json.loads(frappe.db.get_default("atelier_setup") or "{}") or {}
	except ValueError:
		return {}


def _save(s):
	frappe.db.set_default("atelier_setup", json.dumps(s))


def _done():
	from atelier import api
	from atelier.simple import doc_settings, workshop_profile

	company = api._company()
	p = workshop_profile()
	cash_bank = frappe.get_all("Account", filters={"company": company, "account_type": ["in", ["Cash", "Bank"]], "is_group": 0}, pluck="name")
	return {
		"profile": bool(p.get("name_ar") and p.get("phone") and p.get("address")),
		"docs": bool(p.get("rc") and p.get("nif") and (doc_settings().get("footer") or "").strip()),
		"funds": bool(cash_bank and frappe.db.exists("GL Entry", {"account": ["in", cash_bank], "is_cancelled": 0})),
		"services": bool(frappe.db.sql("""select 1 from `tabItem Price` ip join `tabItem` it on it.name=ip.item_code
			where it.disabled=0 and it.is_sales_item=1 and it.name!='SRV-GENERAL' and ip.selling=1 and ip.price_list_rate>0 limit 1""")),
		"materials": bool(frappe.db.sql("select 1 from `tabBin` where actual_qty>0 limit 1")),
		"parties": bool(frappe.db.count("Customer", {"disabled": 0})),
		"team": bool(frappe.db.count("User", {"user_type": "System User", "enabled": 1, "name": ["not in", ["Administrator", "Guest", frappe.session.user]]})),
		"columns": bool(frappe.db.get_default("atelier_board")),
	}


def pending():
	"""For boot: whether the wizard should open by itself (manager, not hidden, an essential step left)."""
	s = _state()
	if s.get("hidden"):
		return False
	done, skipped = _done(), set(s.get("skipped") or [])
	return any(not done[k] and k not in skipped for k, _t, _h, _tab, opt in STEPS if not opt)


@frappe.whitelist()
def setup_status():
	_manager()
	s, done = _state(), _done()
	skipped = set(s.get("skipped") or [])
	steps = [{"key": k, "title": t, "hint": h, "tab": tab, "optional": opt, "done": done[k], "skipped": k in skipped and not done[k]}
		for k, t, h, tab, opt in STEPS]
	return {"steps": steps, "done": sum(1 for x in steps if x["done"]), "hidden": bool(s.get("hidden"))}


@frappe.whitelist(methods=["POST"])
def setup_skip(step, skip=1):
	_manager()
	if step not in [x[0] for x in STEPS]:
		frappe.throw(_("خطوة غير معروفة"))
	s = _state()
	skipped = set(s.get("skipped") or [])
	(skipped.add if frappe.utils.cint(skip) else skipped.discard)(step)
	s["skipped"] = sorted(skipped)
	_save(s)
	return setup_status()


@frappe.whitelist(methods=["POST"])
def setup_hide(hidden=1):
	_manager()
	s = _state()
	s["hidden"] = frappe.utils.cint(hidden)
	_save(s)
	return setup_status()
