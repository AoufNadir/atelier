"""The four original French status names become Arabic (user's request). Matched by exact name only:
a status the shop renamed itself is left as it is. Ids do not change, so cards keep their status."""

import json

import frappe

RENAME = {"En attente": "بالانتظار", "En cours": "قيد العمل", "En validation": "للمراجعة", "Terminé": "منتهٍ"}


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
		for s in cfg.get(key) or []:
			if s.get("name") in RENAME:
				s["name"] = RENAME[s["name"]]
				changed = True
	if changed:
		frappe.db.set_default("atelier_board", json.dumps(cfg, ensure_ascii=False))
