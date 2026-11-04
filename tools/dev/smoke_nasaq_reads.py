"""Call every argument-free read endpoint on nasaq.localhost, then roll back. No demo helpers."""
import importlib
import inspect

import frappe

assert frappe.local.site == "nasaq.localhost", "Smoke test must target the clean site only."
frappe.set_user("Administrator")
failed = passed = 0
for module_name in ("atelier.api", "atelier.simple", "atelier.production"):
    module = importlib.import_module(module_name)
    for name, fn in inspect.getmembers(module, inspect.isfunction):
        methods = frappe.allowed_http_methods_for_whitelisted_func.get(fn, [])
        if fn.__module__ != module_name or "demo" in name or fn not in frappe.whitelisted or "GET" not in methods:
            continue
        if any(p.default is p.empty for p in inspect.signature(fn).parameters.values()):
            continue
        try:
            fn()
            passed += 1
        except Exception as error:
            failed += 1
            print("FAIL", module_name, name, repr(error)[:200])
        finally:
            frappe.db.rollback()
print("SMOKE_READS", "passed", passed, "failed", failed)
assert not failed

# Payment methods reach the agreed funds, and search ranking works. Nothing here is written.
from atelier import accounts_ar, api, simple

company = api._company()
for mode, label in accounts_ar.MODE_FUNDS.items():
    assert frappe.db.exists("Mode of Payment", mode), mode
    account = api._cash_account(mode, company)
    name = frappe.db.get_value("Account", account, "account_name")
    print("MODE", mode, "->", name, frappe.db.get_value("Account", account, "account_type"))
    if mode != "Cash":
        assert name == label, (mode, name)
assert {u["name"] for u in simple.units()} >= {"م²", "سم²", "متر طولي", "ساعة", "خدمة"}
rows = [frappe._dict(customer_name=n, mobile_no=m) for n, m in [("سعيد أحمد", "0550"), ("احمد علي", "0661"), ("فاطمة", "0770"), ("محمد", "0555279877")]]
assert [r.customer_name for r in api._rank_customers("أحمد", rows)] == ["احمد علي", "سعيد أحمد"]
assert [r.customer_name for r in api._rank_customers("فاطمه", rows)] == ["فاطمة"]
assert [r.customer_name for r in api._rank_customers("279877", rows)] == ["محمد"]
for field, number in (("default_receivable_account", "4111"), ("default_payable_account", "40132")):
    assert frappe.db.get_value("Account", frappe.db.get_value("Company", company, field), "account_number") == number, field
print("PAYMENT_MODES_UNITS_SEARCH_OK")
