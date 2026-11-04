import json
import frappe
assert frappe.local.site == "nasaq.localhost"
print("AUTH_LOG", json.dumps(frappe.get_all("Activity Log", filters={"user": "Administrator"}, fields=["creation", "operation", "status"], order_by="creation desc", limit=6), default=str))
print("USER_ENABLED", frappe.db.get_value("User", "Administrator", "enabled"))
print("HAS_PASSWORD_HASH", bool(frappe.db.sql("select 1 from `__Auth` where doctype='User' and name='Administrator' and fieldname='password' and encrypted=0 limit 1")))
print("DEFAULT_BANK", frappe.db.get_value("Account", frappe.db.get_value("Company", "نَسَق للطباعة", "default_bank_account"), "account_name"))
