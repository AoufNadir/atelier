"""Production steps of an order: each step is an ERPNext Task in the order's project.

A step has a kind (design, digital print, cutting…), where it is done (in-house or at a supplier),
who handles it, a due date and a status. An external step can raise a Purchase Order to the
supplier, and later its Purchase Invoice, so the cost lands on the order's project like any other.
The order's coarse stage (atelier_stage) is derived from the first unfinished step.
"""

import json

import frappe
from frappe import _
from frappe.utils import cint, flt, getdate, nowdate

# kind → the coarse order stage it belongs to
KINDS = {
	"تصميم": "تصميم", "موافقة العميل": "بانتظار موافقة العميل",
	"طباعة رقمية": "طباعة", "طباعة أوفست": "طباعة", "طباعة كبيرة الحجم": "طباعة",
	"قص": "تشطيب", "تجليد": "تشطيب", "تغليف وسلوفان": "تشطيب", "تركيب": "تشطيب", "تشطيب آخر": "تشطيب",
}
INTERNAL, EXTERNAL = "داخلي", "خارجي"
DEFAULT_STEPS = [{"kind": "تصميم", "mode": INTERNAL}]
EXTERNAL_ITEM = "SRV-EXTERNAL"


def custom_fields():
	from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

	module = "Atelier"
	create_custom_fields({
		"Task": [
			{"fieldname": "atelier_kind", "label": "نوع المرحلة", "fieldtype": "Data", "insert_after": "subject", "module": module},
			{"fieldname": "atelier_mode", "label": "مكان التنفيذ", "fieldtype": "Select", "options": f"{INTERNAL}\n{EXTERNAL}",
				"default": INTERNAL, "insert_after": "atelier_kind", "module": module},
			{"fieldname": "atelier_supplier", "label": "المورد", "fieldtype": "Link", "options": "Supplier",
				"insert_after": "atelier_mode", "depends_on": f"eval:doc.atelier_mode=='{EXTERNAL}'", "module": module},
			{"fieldname": "atelier_owner", "label": "المسؤول", "fieldtype": "Data", "insert_after": "atelier_supplier", "module": module},
			{"fieldname": "atelier_seq", "label": "الترتيب", "fieldtype": "Int", "insert_after": "atelier_owner", "module": module},
			{"fieldname": "atelier_po", "label": "طلب الشراء", "fieldtype": "Link", "options": "Purchase Order",
				"insert_after": "atelier_seq", "read_only": 1, "module": module},
			{"fieldname": "atelier_cost", "label": "تكلفة المورد", "fieldtype": "Currency", "insert_after": "atelier_po", "module": module},
		],
		"Item": [
			{"fieldname": "atelier_steps", "label": "مراحل الإنتاج الافتراضية", "fieldtype": "Small Text", "insert_after": "description",
				"description": "JSON: [{\"kind\": \"تصميم\", \"mode\": \"داخلي\"}, …]", "module": module},
		],
	})


def _so(name, ptype="read"):
	so = frappe.get_doc("Sales Order", name)
	so.check_permission(ptype)
	if not so.project:
		frappe.throw(_("هذا الطلب غير مرتبط بمشروع"))
	return so


def steps_of(project):
	if not project:
		return []
	return frappe.get_all("Task", filters={"project": project, "atelier_kind": ["is", "set"], "status": ["!=", "Cancelled"]},
		fields=["name", "atelier_kind as kind", "atelier_mode as mode", "atelier_supplier as supplier", "atelier_owner as owner",
			"atelier_seq as seq", "atelier_po as po", "atelier_cost as cost", "status", "exp_end_date as due", "completed_on"],
		order_by="atelier_seq asc, creation asc")


def _po_state(po):
	if not po:
		return None
	d = frappe.db.get_value("Purchase Order", po, ["docstatus", "per_billed", "grand_total"], as_dict=True)
	return {"name": po, "billed": flt(d.per_billed) >= 100, "amount": flt(d.grand_total)} if d else None


def steps_for_view(project):
	out = []
	for s in steps_of(project):
		s.done = s.status == "Completed"
		s.started = s.status == "Working"
		s.po_state = _po_state(s.po)
		s.supplier_name = frappe.db.get_value("Supplier", s.supplier, "supplier_name") if s.supplier else None
		out.append(s)
	return out


def current_steps(projects):
	"""{project: first unfinished step} for list pages."""
	if not projects:
		return {}
	rows = frappe.get_all("Task", filters={"project": ["in", projects], "atelier_kind": ["is", "set"], "status": ["not in", ["Completed", "Cancelled"]]},
		fields=["project", "atelier_kind as kind", "atelier_mode as mode", "atelier_owner as owner", "atelier_supplier as supplier"],
		order_by="atelier_seq asc, creation asc")
	out = {}
	for r in rows:
		out.setdefault(r.project, r)
	for r in out.values():
		if r.supplier:
			r.supplier_name = frappe.db.get_value("Supplier", r.supplier, "supplier_name")
	return out


def sync_stage(so):
	"""Coarse stage = the stage of the first unfinished step; all done → ready (unless already delivered)."""
	steps = steps_of(so.project)
	if not steps:
		return
	if so.per_delivered >= 100:
		stage = "سُلّم"
	else:
		todo = [s for s in steps if s.status != "Completed"]
		stage = KINDS.get(todo[0].kind, "تشطيب") if todo else "جاهز للتسليم"
	if so.atelier_stage != stage:
		so.db_set("atelier_stage", stage)


def _template(item_code):
	raw = frappe.db.get_value("Item", item_code, "atelier_steps")
	try:
		steps = json.loads(raw) if raw else []
	except ValueError:
		steps = []
	return [s for s in steps if s.get("kind") in KINDS]


def create_default_steps(so):
	"""On a new order: the union of its services' step templates, in order, each kind once."""
	if not so.project or steps_of(so.project):
		return
	seen, plan = set(), []
	for row in so.items:
		for st in _template(row.item_code):
			key = (st["kind"], st.get("mode") or INTERNAL, st.get("supplier") or "")
			if key not in seen:
				seen.add(key)
				plan.append(st)
	order = list(KINDS)
	plan.sort(key=lambda st: order.index(st["kind"]))  # design before print before finishing, whatever the item order
	for i, st in enumerate(plan or DEFAULT_STEPS):
		_new_task(so, st, i)
	sync_stage(so)


def _new_task(so, st, seq):
	mode = st.get("mode") if st.get("mode") in (INTERNAL, EXTERNAL) else INTERNAL
	t = frappe.get_doc({
		"doctype": "Task", "project": so.project, "subject": f"{st['kind']} — {so.atelier_subject or so.name}"[:140],
		"atelier_kind": st["kind"], "atelier_mode": mode, "atelier_supplier": st.get("supplier") if mode == EXTERNAL else None,
		"atelier_owner": (st.get("owner") or "").strip() or None, "atelier_seq": seq,
		"exp_end_date": st.get("due") or so.delivery_date, "status": "Open",
	})
	t.insert()
	return t


@frappe.whitelist(methods=["POST"])
def save_steps(name, steps):
	"""Replace the order's step plan: update kept steps, add new ones, cancel removed unfinished ones."""
	so = _so(name, "write")
	steps = frappe.parse_json(steps) or []
	if not steps:
		frappe.throw(_("أضف مرحلة واحدة على الأقل"))
	for st in steps:
		if st.get("kind") not in KINDS:
			frappe.throw(_("نوع مرحلة غير معروف: {0}").format(st.get("kind")))
		if st.get("mode") == EXTERNAL and not st.get("supplier"):
			frappe.throw(_("اختر المورد للمرحلة الخارجية «{0}»").format(st["kind"]))
	existing = {s.name: s for s in steps_of(so.project)}
	kept = set()
	for seq, st in enumerate(steps):
		if st.get("name") in existing:
			t = frappe.get_doc("Task", st["name"])
			kept.add(t.name)
			if t.status != "Completed":
				t.atelier_kind = st["kind"]
				t.atelier_mode = st.get("mode") or INTERNAL
				t.atelier_supplier = st.get("supplier") if t.atelier_mode == EXTERNAL else None
			t.atelier_owner = (st.get("owner") or "").strip() or None
			t.atelier_seq = seq
			if st.get("due"):
				t.exp_end_date = st["due"]
			t.save()
		else:
			_new_task(so, st, seq)
	for n, s in existing.items():
		if n not in kept:
			if s.status == "Completed" or s.po:
				frappe.throw(_("لا يمكن حذف مرحلة منتهية أو أُرسل طلبها للمورد: {0}").format(s.kind))
			frappe.db.set_value("Task", n, "status", "Cancelled")
	so.reload()
	sync_stage(so)
	return steps_for_view(so.project)


@frappe.whitelist(methods=["POST"])
def step_action(task, action):
	"""start | done | reopen"""
	t = frappe.get_doc("Task", task)
	so_name = frappe.db.get_value("Sales Order", {"project": t.project, "docstatus": ["<", 2]}, "name")
	so = _so(so_name, "write")
	if action == "start":
		t.status = "Working"
	elif action == "done":
		t.status = "Completed"
		t.completed_on = nowdate()
	elif action == "reopen":
		t.status = "Open"
		t.completed_on = None
	else:
		frappe.throw(_("إجراء غير معروف"))
	t.save()
	so.reload()
	sync_stage(so)
	return t.status


def _external_item():
	if not frappe.db.exists("Item", EXTERNAL_ITEM):
		group = "خدمات" if frappe.db.exists("Item Group", "خدمات") else frappe.db.get_value("Item Group", {"is_group": 0})
		frappe.get_doc({"doctype": "Item", "item_code": EXTERNAL_ITEM, "item_name": "خدمة لدى مورد", "item_group": group,
			"stock_uom": "Nos", "is_stock_item": 0, "is_sales_item": 0, "is_purchase_item": 1}).insert(ignore_permissions=True)
	return EXTERNAL_ITEM


@frappe.whitelist(methods=["POST"])
def step_order_supplier(task, cost):
	"""External step: a submitted Purchase Order to its supplier, charged to the order's project."""
	if not frappe.has_permission("Purchase Order", "create"):
		frappe.throw(_("ليست لديك صلاحية لهذا الإجراء."), frappe.PermissionError)
	t = frappe.get_doc("Task", task)
	if t.atelier_mode != EXTERNAL or not t.atelier_supplier:
		frappe.throw(_("هذه المرحلة ليست عند مورد"))
	if t.atelier_po:
		return t.atelier_po
	if flt(cost) <= 0:
		frappe.throw(_("أدخل تكلفة المورد"))
	so_name = frappe.db.get_value("Sales Order", {"project": t.project, "docstatus": ["<", 2]}, ["name", "company", "atelier_subject"], as_dict=True)
	po = frappe.get_doc({
		"doctype": "Purchase Order", "supplier": t.atelier_supplier, "company": so_name.company, "project": t.project,
		"transaction_date": nowdate(), "schedule_date": max(getdate(t.exp_end_date or nowdate()), getdate(nowdate())),
		"items": [{"item_code": _external_item(), "qty": 1, "rate": flt(cost), "project": t.project,
			"description": f"{t.atelier_kind} — {so_name.atelier_subject or so_name.name}",
			"schedule_date": max(getdate(t.exp_end_date or nowdate()), getdate(nowdate()))}],
	})
	po.insert()
	po.submit()
	t.atelier_po, t.atelier_cost, t.status = po.name, flt(cost), "Working"
	t.save()
	return po.name


@frappe.whitelist(methods=["POST"])
def step_supplier_invoice(task):
	"""Book the supplier's invoice for an external step (cost lands on the project)."""
	from erpnext.buying.doctype.purchase_order.purchase_order import make_purchase_invoice

	if not frappe.has_permission("Purchase Invoice", "create"):
		frappe.throw(_("ليست لديك صلاحية لهذا الإجراء."), frappe.PermissionError)
	t = frappe.get_doc("Task", task)
	if not t.atelier_po:
		frappe.throw(_("لم يُرسل طلب لهذا المورد بعد"))
	pi = make_purchase_invoice(t.atelier_po)
	for row in pi.items:
		row.project = t.project
	pi.project = t.project
	pi.insert()
	pi.submit()
	return pi.name


@frappe.whitelist(methods=["POST"])
def set_tags(name, tags):
	from frappe.desk.doctype.tag.tag import add_tag, remove_tag

	so = frappe.get_doc("Sales Order", name)
	so.check_permission("write")
	want = [x.strip() for x in (frappe.parse_json(tags) or []) if x and x.strip()]
	have = [x for x in (so.get("_user_tags") or "").split(",") if x]
	for x in have:
		if x not in want:
			remove_tag(x, "Sales Order", name)
	for x in want:
		if x not in have:
			add_tag(x, "Sales Order", name)
	return want


@frappe.whitelist(methods=["POST"])
def set_service_steps(item_code, steps):
	"""Default step plan of a service, used for new orders."""
	if not frappe.has_permission("Item", "write"):
		frappe.throw(_("ليست لديك صلاحية لهذا الإجراء."), frappe.PermissionError)
	steps = [{"kind": s["kind"], "mode": s.get("mode") or INTERNAL, **({"supplier": s["supplier"]} if s.get("supplier") else {})}
		for s in (frappe.parse_json(steps) or []) if s.get("kind") in KINDS]
	frappe.db.set_value("Item", item_code, "atelier_steps", json.dumps(steps, ensure_ascii=False))
	return steps


def boot_info():
	team = sorted({r[0] for r in frappe.db.sql("select distinct atelier_owner from `tabTask` where ifnull(atelier_owner, '') != ''")})
	return {
		"step_kinds": list(KINDS), "step_modes": [INTERNAL, EXTERNAL], "team": team,
		"suppliers": frappe.get_all("Supplier", filters={"disabled": 0}, fields=["name", "supplier_name"], order_by="supplier_name asc", limit=200),
		"tags": sorted({x for r in frappe.db.sql("select _user_tags from `tabSales Order` where ifnull(_user_tags, '') != ''") for x in r[0].split(",") if x}),
	}


def demo_backfill():
	"""Demo only: service templates and steps for existing open orders."""
	custom_fields()
	sup = frappe.db.get_value("Supplier", {"supplier_name": ["like", "%أفق%"]}) or frappe.db.get_value("Supplier", {})
	templates = {
		"SRV-DESIGN-DEMO": [{"kind": "تصميم", "mode": INTERNAL}, {"kind": "موافقة العميل", "mode": INTERNAL}],
		"SRV-PRINT-DEMO": [{"kind": "طباعة رقمية", "mode": INTERNAL}, {"kind": "قص", "mode": INTERNAL}],
		"SRV-OFFSET-DEMO": [{"kind": "طباعة أوفست", "mode": EXTERNAL, "supplier": sup}],
		"SRV-FINISH-DEMO": [{"kind": "تركيب", "mode": INTERNAL}],
	}
	for code, steps in templates.items():
		if frappe.db.exists("Item", code):
			frappe.db.set_value("Item", code, "atelier_steps", json.dumps(steps, ensure_ascii=False))
	owners = ["سمير", "مريم", "أمين", "يوسف"]
	for i, so_name in enumerate(frappe.get_all("Sales Order", {"docstatus": ["<", 2], "status": ["not in", ["Completed", "Closed"]], "project": ["is", "set"]}, pluck="name")):
		so = frappe.get_doc("Sales Order", so_name)
		if steps_of(so.project):
			continue
		create_default_steps(so)
		for j, st in enumerate(steps_of(so.project)):
			frappe.db.set_value("Task", st.name, "atelier_owner", None if st.mode == EXTERNAL else owners[(i + j) % len(owners)])
	frappe.db.commit()
	print({n: [(s.kind, s.mode, s.owner) for s in steps_of(frappe.db.get_value("Sales Order", n, "project"))]
		for n in frappe.get_all("Sales Order", {"docstatus": ["<", 2], "project": ["is", "set"]}, pluck="name")})


def demo_fix_order():
	"""Demo only: natural step order, and steps already done for orders that are ready or delivered."""
	order = list(KINDS)
	for so_name in frappe.get_all("Sales Order", {"docstatus": ["<", 2], "project": ["is", "set"]}, pluck="name"):
		so = frappe.get_doc("Sales Order", so_name)
		steps = sorted(steps_of(so.project), key=lambda st: order.index(st.kind) if st.kind in order else 99)
		finished = so.per_delivered > 0 or so_name in ("SAL-ORD-2026-00002",)
		for i, st in enumerate(steps):
			frappe.db.set_value("Task", st.name, {"atelier_seq": i, **({"status": "Completed", "completed_on": nowdate()} if finished else {})})
		sync_stage(so)
	frappe.db.commit()
	print({n: frappe.db.get_value("Sales Order", n, "atelier_stage") for n in frappe.get_all("Sales Order", {"docstatus": ["<", 2]}, pluck="name")})
