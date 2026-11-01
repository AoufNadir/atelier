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


def scenarios():
	"""Extra fictitious cases so every home-page state has data. Run after demo_cycle.run."""
	from frappe.utils import add_days, nowdate

	from atelier.api import create_order

	frappe.db.set_value("Item", "PAP-A4-80-DEMO", "safety_stock", 1000)
	for so in frappe.get_all("Sales Order", {"docstatus": 1, "per_delivered": 100}, pluck="name"):
		frappe.db.set_value("Sales Order", so, "atelier_stage", "سُلّم")
	if frappe.db.exists("Sales Order", {"atelier_subject": "بطاقات زيارة (تجريبي)"}):
		return print("SCENARIOS_ALREADY")

	r = create_order(frappe.as_json({
		"customer": "Client Beta (DÉMO)", "subject": "بطاقات زيارة (تجريبي)", "delivery_date": add_days(nowdate(), 1),
		"items": [{"item_code": "SRV-DESIGN-DEMO", "qty": 1, "rate": 3000}, {"item_code": "SRV-PRINT-DEMO", "qty": 500, "rate": 12}],
		"costs": [{"cost_type": "Matière", "item": "PAP-A4-80-DEMO", "qty": 125}],
		"advance": {"amount": 5000, "mode_of_payment": "Cash"},
	}))
	frappe.db.set_value("Sales Order", r["sales_order"], "atelier_stage", "جاهز للتسليم")

	create_order(frappe.as_json({
		"customer": "عميل تجريبي (DÉMO)", "subject": "لافتة 3×1 م وشعار (تجريبي)", "delivery_date": add_days(nowdate(), 4),
		"items": [{"item_code": "SRV-DESIGN-DEMO", "qty": 1, "rate": 6000}, {"item_code": "SRV-PRINT-DEMO", "qty": 3, "rate": None,
			"description": "لافتة فينيل 3×1 م"}],
		"costs": [{"cost_type": "Sous-traitance", "description": "طباعة فينيل خارجية", "qty": 1}],
	}))

	si = frappe.get_doc({
		"doctype": "Sales Invoice", "customer": "عميل تجريبي (DÉMO)", "company": COMPANY,
		"posting_date": "2026-10-05", "set_posting_time": 1, "due_date": "2026-10-19",
		"items": [{"item_code": "SRV-PRINT-DEMO", "qty": 600, "rate": 30}],
	}).insert()
	si.submit()

	svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="#fff"/>'
		'<text x="300" y="120" font-size="40" text-anchor="middle" font-family="sans-serif">BON DE COMMANDE — DÉMO</text>'
		'<text x="300" y="200" font-size="28" text-anchor="middle" font-family="sans-serif">بون تجريبي — بيانات وهمية</text></svg>')
	so_alpha = frappe.db.get_value("Sales Order", {"customer": "Client Alpha (DÉMO)"})
	for fname, dt, dn in (("bon-commande-demo.svg", "Sales Order", so_alpha), ("maquette-flyer-demo.svg", "Customer", "Client Alpha (DÉMO)")):
		frappe.get_doc({"doctype": "File", "file_name": fname, "attached_to_doctype": dt, "attached_to_name": dn,
			"is_private": 1, "content": svg}).insert()
	frappe.db.commit()
	print("SCENARIOS_OK")


AR_NAMES = {
	"Item": {
		"SRV-DESIGN-DEMO": "تصميم جرافيكي (تجريبي)", "SRV-PRINT-DEMO": "طباعة رقمية (تجريبي)",
		"SRV-OFFSET-DEMO": "طباعة أوفست خارجية (تجريبي)", "SRV-FINISH-DEMO": "تشطيب وتغليف (تجريبي)",
		"PAP-A4-80-DEMO": "ورق A4 ‏80غ (تجريبي)",
	},
	"Customer": {
		"Client Alpha (DÉMO)": "مطبعة الأفق (تجريبي)", "Client Beta (DÉMO)": "مؤسسة النور للإشهار (تجريبي)",
		"عميل تجريبي (DÉMO)": "مخبزة السعادة (تجريبي)",
	},
	"Supplier": {"Fournisseur Papier (DÉMO)": "مورد الورق (تجريبي)", "Imprimerie Offset Externe (DÉMO)": "مطبعة أوفست خارجية (تجريبي)"},
}


def arabize():
	"""Arabic display names for all demo records (document ids stay unchanged)."""
	for code, name in AR_NAMES["Item"].items():
		frappe.db.set_value("Item", code, {"item_name": name, "description": name})
		for dt in ("Sales Order Item", "Quotation Item", "Sales Invoice Item", "Delivery Note Item", "Purchase Order Item",
				"Purchase Invoice Item", "Purchase Receipt Item", "Stock Entry Detail"):
			frappe.db.sql(f"update `tab{dt}` set item_name=%s, description=%s where item_code=%s", (name, name, code))
	for cust, name in AR_NAMES["Customer"].items():
		frappe.db.set_value("Customer", cust, "customer_name", name)
		for dt in ("Sales Order", "Sales Invoice", "Delivery Note", "Quotation"):
			field = "customer_name"
			frappe.db.sql(f"update `tab{dt}` set {field}=%s where {'party_name' if dt == 'Quotation' else 'customer'}=%s", (name, cust))
		frappe.db.sql("update `tabPayment Entry` set party_name=%s where party=%s", (name, cust))
	for sup, name in AR_NAMES["Supplier"].items():
		frappe.db.set_value("Supplier", sup, "supplier_name", name)
		for dt in ("Purchase Order", "Purchase Invoice", "Purchase Receipt"):
			frappe.db.sql(f"update `tab{dt}` set supplier_name=%s where supplier=%s", (name, sup))
	frappe.db.set_value("Customer", "Client Alpha (DÉMO)", "mobile_no", "0550 12 34 56")

	# Long-text, multi-line order to test layouts.
	from frappe.utils import add_days, nowdate

	from atelier.api import create_order

	subject = "حملة إشهارية كاملة لافتتاح الفرع الجديد: لافتات واجهة، مطويات، بطاقات، وملصقات سيارات (تجريبي)"
	if not frappe.db.exists("Sales Order", {"atelier_subject": subject}):
		create_order(frappe.as_json({
			"customer": "Client Alpha (DÉMO)", "subject": subject, "delivery_date": add_days(nowdate(), 6),
			"items": [
				{"item_code": "SRV-DESIGN-DEMO", "qty": 1, "rate": 15000, "description": "هوية بصرية مختصرة ونماذج الطباعة"},
				{"item_code": "SRV-PRINT-DEMO", "qty": 2000, "rate": 22, "description": "مطويات A4 ثلاث طيات، ورق لامع 135غ"},
				{"item_code": "SRV-PRINT-DEMO", "qty": 500, "rate": 12, "description": "بطاقات زيارة وجهين"},
				{"item_code": "SRV-OFFSET-DEMO", "qty": 5000, "rate": 6.5, "description": "ملصقات A3 أوفست"},
				{"item_code": "SRV-FINISH-DEMO", "qty": 1, "rate": None, "description": "تركيب لافتة الواجهة 6×1.5 م — بانتظار المعاينة"},
			],
			"costs": [{"cost_type": "Sous-traitance", "description": "أوفست ملصقات", "qty": 5000, "rate": 4},
				{"cost_type": "Finition", "description": "تركيب", "qty": 1}],
			"advance": {"amount": 20000, "mode_of_payment": "Cash"},
		}))
	frappe.db.commit()
	print("ARABIZE_OK")


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


def prices():
	"""Demo prices per customer type (fictitious). Finishing has no company price on purpose: it stays 'priced later'."""
	from atelier.api import PRICE_LISTS, _price_list, set_price

	rates = {"SRV-DESIGN-DEMO": (15000, 22000), "SRV-PRINT-DEMO": (22, 18), "SRV-OFFSET-DEMO": (6.5, 5.5), "SRV-FINISH-DEMO": (8000, None)}
	for code, (individual, company) in rates.items():
		set_price(code, "Individual", individual)
		set_price(code, "Company", company)
	for c in frappe.get_all("Customer", fields=["name", "customer_type"]):
		frappe.db.set_value("Customer", c.name, "default_price_list", _price_list(c.customer_type))
	frappe.db.commit()
	print({k: _price_list(k) for k in PRICE_LISTS}, frappe.get_all("Customer", fields=["customer_name", "customer_type", "default_price_list"]))
