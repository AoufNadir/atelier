"""Local permission checks for the daily app API (dev only).

Run: bench --site development.localhost execute atelier.dev_checks.permissions
"""

import frappe

USER = "ventes.demo@example.test"


def permissions():
	if not frappe.db.exists("User", USER):
		u = frappe.get_doc({"doctype": "User", "email": USER, "first_name": "Vendeur démo", "send_welcome_email": 0,
			"user_type": "System User", "roles": [{"role": "Sales User"}]})
		u.insert(ignore_permissions=True)
		frappe.db.commit()
	from atelier import api

	frappe.set_user(USER)
	boot = api.boot()
	home = api.home()
	print("can:", boot["can"])
	print("home.money is hidden:", home["money"] is None, "| actions:", [a["kind"] for a in home["actions"]])
	cust = api.customer("Client Alpha (DÉMO)")
	print("customer keys:", sorted(k for k in cust if k not in ("orders", "documents", "files")))
	try:
		api.record_payment("Client Alpha (DÉMO)", 100, "Cash")
		print("payment: ALLOWED")
	except frappe.PermissionError:
		print("payment: refused (PermissionError)")
	frappe.db.rollback()
