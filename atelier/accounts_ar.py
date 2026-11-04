"""Workshop names for the accounts the app shows: a short Arabic list instead of the full Algerian chart."""
import json

import frappe

# account number → Arabic name, in the order the expense form shows them
EXPENSES = [
	("60111", "ورق وكرتون"), ("60112", "حبر"), ("60171", "لوازم الطباعة"), ("6111", "عمل عند مورد"),
	("6241", "نقل وتوصيل"), ("6148", "كراء المحل"), ("6073", "كهرباء وماء وغاز"), ("6152", "صيانة الآلات"),
	("6263", "هاتف وإنترنت"), ("63111", "رواتب العمال"), ("6071", "وقود"), ("6278", "مصاريف بنكية"),
	("6078", "مشتريات أخرى"),
]
FUNDS = {"Caisse auxiliaire : Succursale (ou Unité) B": "الصندوق", "Caisse principale en Dinars": "الصندوق الرئيسي",
	"Comptes bancaires : Dinars": "البنك", "Banque postale (C.C.P)": "الحساب البريدي CCP"}


# Same postal account for BaridiMob and CCP: only the way the money arrives differs.
MODE_FUNDS = {"Cash": "الصندوق", "BaridiMob": "الحساب البريدي CCP", "CCP": "الحساب البريدي CCP",
	"Wire Transfer": "البنك", "Cheque": "البنك"}

CHART = "Algerie - Plan Comptable General 2 avec code"


def matches_chart(company):
	return company.country == "Algeria" and company.default_currency == "DZD" and company.chart_of_accounts == CHART


def run(company=None, commit=True):
	from atelier import api
	company = company or api._company()
	if not company or not matches_chart(frappe.get_doc("Company", company)):
		return
	keep = []
	for number, label in EXPENSES:
		name = frappe.db.get_value("Account", {"company": company, "account_number": number, "is_group": 0})
		if name:
			frappe.db.set_value("Account", name, "account_name", label)
			keep.append(name)
	for old, label in FUNDS.items():
		name = frappe.db.get_value("Account", {"company": company, "account_name": old, "is_group": 0})
		if name:
			frappe.db.set_value("Account", name, "account_name", label)
	frappe.db.set_default("atelier_expense_accounts", json.dumps(keep, ensure_ascii=False))
	if commit:
		frappe.db.commit()
	return len(keep)


def payment_modes(company):
	"""Create the local payment methods and link only those with no fund yet."""
	for mode, label in MODE_FUNDS.items():
		if frappe.db.exists("Mode of Payment", mode):
			doc = frappe.get_doc("Mode of Payment", mode)
		else:
			doc = frappe.get_doc({"doctype": "Mode of Payment", "mode_of_payment": mode, "enabled": 1,
				"type": "Cash" if mode == "Cash" else "Bank"})
		if not any(row.company == company for row in doc.accounts):
			account = frappe.db.get_value("Account", {"company": company, "account_name": label, "is_group": 0,
				"account_type": ["in", ["Cash", "Bank"]]})
			if account:
				doc.append("accounts", {"company": company, "default_account": account})
		doc.save(ignore_permissions=True)


def default_bank(company=None, commit=True, only_if_missing=False):
	"""The company's default bank was a stock-brokerage account; point it to the workshop's bank."""
	from atelier import api
	company = company or api._company()
	if not company or not matches_chart(frappe.get_doc("Company", company)):
		return
	current = frappe.db.get_value("Company", company, "default_bank_account")
	if only_if_missing and current:
		# This chart's first Bank-typed leaf can be a brokerage account. Repair
		# that template default, but retain a workshop's deliberate bank choice.
		if frappe.db.get_value("Account", current, "account_name") != "Société de bourse":
			return
	bank = frappe.db.get_value("Account", {"company": company, "account_name": "البنك", "is_group": 0})
	if bank:
		frappe.db.set_value("Company", company, "default_bank_account", bank)
		if commit:
			frappe.db.commit()
	return bank
