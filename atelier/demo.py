"""Demo data for local testing only. Everything here is fictitious and tagged DÉMO / تجريبي.

Run: bench --site development.localhost execute atelier.demo.setup
"""

import frappe

COMPANY = "Atelier Démo تجريبي"
ABBR = "ADM"
TAG = " (DÉMO)"

# Demo rates — NOT real costs
DEMO_RATES = {"labour_per_hour": 800, "machine_per_hour": 1500}


def setup():
	setup_wizard()
	master_data()
	frappe.db.commit()
	print("DEMO_SETUP_OK", COMPANY, DEMO_RATES)


def setup_wizard():
	if frappe.db.exists("Company", COMPANY):
		return
	from frappe.desk.page.setup_wizard.setup_wizard import setup_complete

	setup_complete(
		{
			"language": "English",
			"country": "Algeria",
			"timezone": "Africa/Algiers",
			"currency": "DZD",
			"company_name": COMPANY,
			"company_abbr": ABBR,
			"chart_of_accounts": "Algerie - Plan Comptable General 2 avec code",
			"fy_start_date": "2026-01-01",
			"fy_end_date": "2026-12-31",
			"setup_demo": 0,
		}
	)


def _ensure(doctype, name_field, name, **fields):
	if frappe.db.exists(doctype, {name_field: name}):
		return
	frappe.get_doc({"doctype": doctype, name_field: name, **fields}).insert(ignore_permissions=True)


def master_data():
	for c in ["Client Alpha", "Client Beta", "عميل تجريبي"]:
		_ensure("Customer", "customer_name", c + TAG, customer_type="Company")
	for s in ["Fournisseur Papier", "Imprimerie Offset Externe"]:
		_ensure("Supplier", "supplier_name", s + TAG)

	for uom in ["Ramette", "Feuille"]:
		_ensure("UOM", "uom_name", uom)

	_ensure(
		"Item", "item_code", "PAP-A4-80-DEMO",
		item_name="Papier A4 80g" + TAG, item_group="Raw Material", stock_uom="Feuille",
		is_stock_item=1, valuation_rate=2.5,
		uoms=[{"uom": "Feuille", "conversion_factor": 1}, {"uom": "Ramette", "conversion_factor": 500}],
		purchase_uom="Ramette",
	)
	for code, name in [
		("SRV-DESIGN-DEMO", "Conception graphique / تصميم"),
		("SRV-PRINT-DEMO", "Impression numérique / طباعة رقمية"),
		("SRV-OFFSET-DEMO", "Impression offset externe / أوفست خارجي"),
		("SRV-FINISH-DEMO", "Finition / تشطيب"),
	]:
		_ensure("Item", "item_code", code, item_name=name + TAG, item_group="Services",
			stock_uom="Nos", is_stock_item=0)
