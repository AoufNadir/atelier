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
