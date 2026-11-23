"""Statuses say where a card is inside its column's stage (user's choice, plan A): the original names become
لم يبدأ / قيد العمل / ننتظر العميل / انتهى with clear colours. Exact names only: a status the shop renamed is kept."""

import json

import frappe

RENAME = {
	"En attente": ("لم يبدأ", "#98A2B3", 0), "بالانتظار": ("لم يبدأ", "#98A2B3", 0),
	"En cours": ("قيد العمل", "#2E90FA", 0), "قيد العمل": ("قيد العمل", "#2E90FA", 0),
	"En validation": ("ننتظر العميل", "#F79009", 1), "للمراجعة": ("ننتظر العميل", "#F79009", 1),
	"Terminé": ("انتهى", "#12B76A", 0), "منتهٍ": ("انتهى", "#12B76A", 0),
}


def execute():
	raw = frappe.db.get_default("atelier_board")
	if not raw:
		return
	try:
		cfg = json.loads(raw)
	except ValueError:
		return
	changed = False
	for key in ("statuses", "labels"):
		for x in cfg.get(key) or []:
			if x.get("name") in RENAME:
				x["name"], x["color"], aside = RENAME[x["name"]]
				if aside:
					x["aside"] = 1
				changed = True
	if changed:
		frappe.db.set_default("atelier_board", json.dumps(cfg, ensure_ascii=False))
