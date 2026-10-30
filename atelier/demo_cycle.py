"""One complete FICTITIOUS order cycle, through standard ERPNext documents. Local testing only.

Run: bench --site development.localhost execute atelier.demo_cycle.run
"""

import frappe
from frappe.utils import flt

from atelier.demo import ABBR, COMPANY, DEMO_RATES

DATE = "2026-10-31"
PROJECT = "DÉMO Flyers Client Alpha"
CUSTOMER = "Client Alpha (DÉMO)"
PAPER = "PAP-A4-80-DEMO"


def run():
	frappe.set_user("Administrator")
	if frappe.db.exists("Project", {"project_name": PROJECT}):
		print("ALREADY_DONE")
		return report()
	project = frappe.get_doc({"doctype": "Project", "project_name": PROJECT, "company": COMPANY, "customer": CUSTOMER}).insert().name
	log = {"project": project}

	# 1. Buy paper into stock (inventory, not an expense yet)
	pr = frappe.get_doc({
		"doctype": "Purchase Receipt", "supplier": "Fournisseur Papier (DÉMO)", "company": COMPANY,
		"posting_date": DATE, "set_posting_time": 1,
		"items": [{"item_code": PAPER, "qty": 3, "uom": "Ramette", "conversion_factor": 500, "rate": 1300,
			"warehouse": warehouse()}],
	}).insert()
	pr.submit()
	from erpnext.stock.doctype.purchase_receipt.purchase_receipt import make_purchase_invoice as pr_to_pi
	submit(pr_to_pi(pr.name), bill_no="DEMO-F-PAP-1")
	log["paper_purchase"] = pr.name

	# 2. Cost estimate (offset quote from supplier; finishing cost intentionally left missing)
	ce = frappe.get_doc({
		"doctype": "Cost Estimate", "customer": CUSTOMER, "company": COMPANY, "project": project,
		"title": "1000 flyers A4 + 2000 dépliants offset (DÉMO)", "qty": 1, "waste_percent": 5,
		"selling_price": 53000,
		"lines": [
			{"cost_type": "Matière", "item": PAPER, "qty": 1000, "uom": "Feuille"},
			{"cost_type": "Machine", "description": "Impression numérique", "qty": 2, "rate": DEMO_RATES["machine_per_hour"], "rate_source": "Taux démo"},
			{"cost_type": "Main d'œuvre", "description": "Conception", "qty": 3, "rate": DEMO_RATES["labour_per_hour"], "rate_source": "Taux démo"},
			{"cost_type": "Sous-traitance", "item": "SRV-OFFSET-DEMO", "qty": 1, "rate": 11000, "rate_source": "Devis fournisseur"},
			{"cost_type": "Finition", "description": "Massicot + emballage", "qty": 1},
		],
	}).insert()
	log["estimate"] = ce.name

	# 3. Quotation -> Sales Order
	qtn = frappe.get_doc({
		"doctype": "Quotation", "quotation_to": "Customer", "party_name": CUSTOMER, "company": COMPANY,
		"transaction_date": DATE,
		"items": [
			{"item_code": "SRV-DESIGN-DEMO", "qty": 1, "rate": 8000},
			{"item_code": "SRV-PRINT-DEMO", "qty": 1000, "rate": 25},
			{"item_code": "SRV-OFFSET-DEMO", "qty": 2000, "rate": 7.5},
			{"item_code": "SRV-FINISH-DEMO", "qty": 1000, "rate": 5},
		],
	}).insert()
	qtn.submit()
	from erpnext.selling.doctype.quotation.quotation import make_sales_order
	so = make_sales_order(qtn.name)
	so.delivery_date = DATE
	so.project = project
	so.insert()
	so.submit()
	ce.db_set({"quotation": qtn.name, "sales_order": so.name})
	log["sales_order"] = so.name

	# 4. Customer advance (cash) against the order
	log["advance"] = receive(so.doctype, so.name, 20000)

	# 5. External offset printing: PO -> supplier invoice, charged to the project
	po = frappe.get_doc({
		"doctype": "Purchase Order", "supplier": "Imprimerie Offset Externe (DÉMO)", "company": COMPANY,
		"transaction_date": DATE, "schedule_date": DATE, "project": project,
		"items": [{"item_code": "SRV-OFFSET-DEMO", "qty": 2000, "rate": 5.5, "project": project, "schedule_date": DATE}],
	}).insert()
	po.submit()
	from erpnext.buying.doctype.purchase_order.purchase_order import make_purchase_invoice as po_to_pi
	log["offset_invoice"] = submit(po_to_pi(po.name), bill_no="DEMO-F-OFF-1", project=project)

	# 6. Consume paper for the job: 1000 good + 50 waste, charged to the project
	se = frappe.get_doc({
		"doctype": "Stock Entry", "stock_entry_type": "Material Issue", "company": COMPANY,
		"posting_date": DATE, "set_posting_time": 1, "project": project,
		"items": [
			{"item_code": PAPER, "qty": 1000, "s_warehouse": warehouse(), "project": project},
			{"item_code": PAPER, "qty": 50, "s_warehouse": warehouse(), "project": project, "description": "Gâche / essais"},
		],
	}).insert()
	se.submit()
	log["consumption"] = se.name

	# 7. Direct expense paid in cash (delivery transport)
	je = frappe.get_doc({
		"doctype": "Journal Entry", "company": COMPANY, "posting_date": DATE, "user_remark": "Transport livraison (DÉMO)",
		"accounts": [
			{"account": expense_account(), "debit_in_account_currency": 1500, "project": project, "cost_center": cost_center()},
			{"account": cash_account(), "credit_in_account_currency": 1500},
		],
	}).insert()
	je.submit()
	log["expense"] = je.name

	# 8. Internal time (demo rates)
	log["timesheet"] = timesheet(project)

	# 9. Delivery note (service items: no stock movement, paper already issued in step 6)
	from erpnext.selling.doctype.sales_order.sales_order import make_delivery_note, make_sales_invoice
	dn = make_delivery_note(so.name)
	dn.posting_date = DATE
	dn.set_posting_time = 1
	dn.insert()
	dn.submit()
	log["delivery"] = dn.name

	# 10. Invoice, deducting the advance, then the balance payment
	si = make_sales_invoice(so.name)
	si.posting_date = DATE
	si.set_posting_time = 1
	si.project = project
	si.set_advances()
	si.insert()
	si.submit()
	log["invoice"] = si.name
	log["balance_payment"] = receive(si.doctype, si.name, flt(si.outstanding_amount))

	frappe.db.commit()
	print("CYCLE_OK", log)
	return report()


def report():
	from atelier.atelier.report.rentabilite_commande.rentabilite_commande import rows
	project = frappe.db.get_value("Project", {"project_name": PROJECT})
	for r in rows(project):
		print(f"{r['section'][:28]:28} | {r['label'][:52]:52} | est={r['estimated']} | reel={r['actual']} | {r['note']}")
	stock = frappe.db.get_value("Bin", {"item_code": PAPER}, ["actual_qty", "stock_value"], as_dict=True)
	sle = frappe.db.sql("select voucher_type, sum(actual_qty), sum(stock_value_difference) from `tabStock Ledger Entry` where item_code=%s and is_cancelled=0 group by voucher_type", PAPER)
	print("STOCK paper:", stock, sle)


# helpers ---------------------------------------------------------------

def submit(doc, **values):
	doc.update(values)
	doc.posting_date = DATE
	doc.set_posting_time = 1
	doc.insert()
	doc.submit()
	return doc.name


def receive(dt, dn, amount):
	from erpnext.accounts.doctype.payment_entry.payment_entry import get_payment_entry
	pe = get_payment_entry(dt, dn, party_amount=amount, bank_account=cash_account())
	pe.posting_date = DATE
	pe.mode_of_payment = "Cash"
	pe.reference_no = "DEMO"
	pe.reference_date = DATE
	pe.insert()
	pe.submit()
	return pe.name


def timesheet(project):
	for name, rate in (("Conception (DÉMO)", DEMO_RATES["labour_per_hour"]), ("Machine numérique (DÉMO)", DEMO_RATES["machine_per_hour"])):
		if not frappe.db.exists("Activity Type", name):
			frappe.get_doc({"doctype": "Activity Type", "activity_type": name, "costing_rate": rate, "billing_rate": 0}).insert()
	emp = frappe.db.get_value("Employee", {"first_name": "Opérateur Démo"})
	if not emp:
		emp = frappe.get_doc({"doctype": "Employee", "first_name": "Opérateur Démo", "gender": "Male", "company": COMPANY,
			"date_of_birth": "1990-01-01", "date_of_joining": "2026-01-01"}).insert().name
	ts = frappe.get_doc({
		"doctype": "Timesheet", "company": COMPANY, "employee": emp, "parent_project": project,
		"time_logs": [
			{"activity_type": "Conception (DÉMO)", "hours": 3, "from_time": f"{DATE} 08:00:00", "project": project, "is_billable": 0},
			{"activity_type": "Machine numérique (DÉMO)", "hours": 2, "from_time": f"{DATE} 11:00:00", "project": project, "is_billable": 0},
		],
	}).insert()
	ts.submit()
	return ts.name


def warehouse():
	return frappe.db.get_value("Warehouse", {"company": COMPANY, "is_group": 0, "warehouse_name": ["like", "Stores%"]}) or frappe.db.get_value("Warehouse", {"company": COMPANY, "is_group": 0})


def cash_account():
	return frappe.db.get_value("Company", COMPANY, "default_cash_account") or frappe.db.get_value("Account", {"company": COMPANY, "account_type": "Cash", "is_group": 0})


def cost_center():
	return frappe.db.get_value("Company", COMPANY, "cost_center")


def expense_account():
	# PCG 624 "Transports" — provisional mapping, to be validated by the accountant
	return frappe.db.get_value("Account", {"company": COMPANY, "is_group": 0, "account_number": ["like", "624%"]}) or frappe.db.get_value("Company", COMPANY, "default_expense_account")
