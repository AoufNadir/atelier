"""Run in the bench container, against nasaq.localhost only. No demo helpers."""
import json
from pathlib import Path

import frappe

from atelier import accounts_ar, api, install, simple

assert frappe.local.site == "nasaq.localhost", "Verification must target the clean site only."
frappe.set_user("Administrator")
business = ["Customer", "Supplier", "Item", "Sales Order", "Sales Invoice", "Purchase Invoice", "Payment Entry", "Project", "Task", "GL Entry"]
counts = {dt: frappe.db.count(dt) for dt in business}
print("BUSINESS_COUNTS", json.dumps(counts, sort_keys=True))
assert not any(counts.values()), "Unexpected business data on the clean site."
company = frappe.get_doc("Company", api._company())
assert company.country == "Algeria" and company.default_currency == "DZD"
assert company.abbr == "NSQ"
assert accounts_ar.matches_chart(company)
print("COMPANY", company.name, company.country, company.default_currency, company.chart_of_accounts)

for dt, fields in {
    "Task": ["atelier_kind", "atelier_mode", "atelier_supplier", "atelier_owner", "atelier_seq", "atelier_po", "atelier_cost"],
    "Item": ["atelier_steps"],
    "Sales Order": ["atelier_subject", "atelier_stage", "atelier_assignee", "atelier_column", "atelier_labels", "atelier_members", "atelier_description", "atelier_checklist", "atelier_cover", "atelier_due_time", "atelier_archived", "atelier_pos"],
    "Sales Order Item": ["atelier_price_pending"],
    "Customer": ["atelier_note", "atelier_vip", "atelier_rc", "atelier_nis", "atelier_ai", "atelier_credit_limit", "atelier_tags", "atelier_contacts", "atelier_tva_exempt"],
}.items():
    meta = frappe.get_meta(dt)
    assert all(meta.has_field(field) for field in fields), (dt, fields)
print("CUSTOM_FIELDS_OK")
assert all(frappe.db.get_value("Price List", name, "currency") == "DZD" for name in api.PRICE_LISTS.values())
assert len(simple.get_config()["columns"]) == 4
assert len(simple.checklist_templates()) == 3
assert simple.board2()["cards"] == []
assert simple.settings()["profile"]["name_ar"] == company.name
assert not frappe.db.get_default("atelier_team")
assert not frappe.db.get_default("atelier_customer_tags")
print("EMPTY_BOARD_SETTINGS_PRICE_LISTS_OK")

configuration = {key: frappe.db.get_default(key) for key in ("atelier_board", "atelier_checklists", "atelier_docs", "atelier_alerts")}
field_count = frappe.db.count("Custom Field", {"module": "Atelier"})
format_count = frappe.db.count("Print Format", {"module": "Atelier"})
install.after_migrate()
install.after_migrate()
assert configuration == {key: frappe.db.get_default(key) for key in configuration}
assert field_count == frappe.db.count("Custom Field", {"module": "Atelier"})
assert format_count == frappe.db.count("Print Format", {"module": "Atelier"})
assert counts == {dt: frappe.db.count(dt) for dt in business}
frappe.db.commit()
print("REPEATED_SETUP_NO_DUPLICATES_OR_DEMO_OK", field_count, format_count)

# Preserve even intentionally empty configuration on an existing site.
original = frappe.db.get_default("atelier_checklists")
try:
    frappe.db.set_default("atelier_checklists", "[]")
    install.after_migrate()
    assert frappe.db.get_default("atelier_checklists") == "[]"
finally:
    frappe.db.set_default("atelier_checklists", original)
    frappe.db.commit()
print("EXISTING_EMPTY_CONFIGURATION_PRESERVED_OK")

# Exercise real application writes and PDF rendering in a transaction that is
# rolled back. No customer, item, order, payment, or demonstration record remains.
try:
    customer = api.save_customer2(json.dumps({"customer_name": "Installation verification", "customer_type": "Individual"}))
    item = api.create_item(json.dumps({"item_name": "Installation verification service", "stock_uom": "Nos"}))
    if isinstance(item, dict):
        item = item.get("item_code") or item.get("name")
    result = api.create_order(json.dumps({
        "customer": customer, "subject": "Installation verification", "delivery_date": frappe.utils.add_days(frappe.utils.nowdate(), 1),
        "items": [{"item_code": item, "qty": 1, "rate": 100}], "confirm": False,
    }))
    order = result["sales_order"]
    assert frappe.db.exists("Sales Order", order)
    assert simple.board2()["cards"]
    quick = api.quick_order(json.dumps({"customer": customer, "what": "Quick form verification", "price": None, "delivery_date": frappe.utils.add_days(frappe.utils.nowdate(), 1)}))
    assert frappe.db.exists("Sales Order", quick["sales_order"])
    html = frappe.get_print("Sales Order", order, print_format=f"{api.PRINT_FORMAT} — Sales Order")
    Path("/tmp/nasaq-install-verification.html").write_text(html)
    pdf = frappe.get_print("Sales Order", order, print_format=f"{api.PRINT_FORMAT} — Sales Order", as_pdf=True)
    assert pdf.startswith(b"%PDF") and len(pdf) > 1000
    Path("/tmp/nasaq-install-verification.pdf").write_bytes(pdf)
    print("CUSTOMER_ORDER_AND_PDF_OK", len(pdf), "bytes")
finally:
    frappe.db.rollback()
assert counts == {dt: frappe.db.count(dt) for dt in business}
print("FINAL_SITE_CLEAN_OK")
