"""Repeatable site setup. No demo module or sample business data is used here."""

import json

import frappe

from atelier import api, dev_build, folders, materials, production, quotes, simple


def after_install():
	setup()


def after_migrate():
	setup()


def after_setup(args=None):
	"""The company and its accounts only exist after the ERPNext setup wizard."""
	setup_company()


def setup():
	"""Install schema and missing defaults without replacing a site's configuration."""
	dev_build.custom_fields()
	production.custom_fields()
	simple.custom_fields()
	simple.board_fields()
	simple.extra_fields()
	simple.line_fields()
	simple.customer_fields()
	simple.customer_fields_2()
	simple.settings_fields()
	simple.supplier_fields()
	simple.payment_order_field()
	quotes.custom_fields()
	materials.custom_fields()
	folders.custom_fields()
	from atelier import printing

	printing.custom_fields()
	api.setup_print_formats(commit=False)
	for key, value in {
		"atelier_board": simple.DEFAULT_CONFIG,
		"atelier_checklists": simple.DEFAULT_CHECKLISTS,
		"atelier_docs": simple.DOC_DEFAULTS,
		"atelier_alerts": simple.ALERT_DEFAULTS,
		"atelier_units": simple.DEFAULT_UNITS,
		"atelier_team": [],  # the workshop adds its own people; never sample names
	}.items():
		if frappe.db.get_default(key) is None:
			frappe.db.set_default(key, json.dumps(value, ensure_ascii=False))
	setup_company()


def setup_company():
	"""Set up one workshop; defer company-dependent work on a pre-wizard site."""
	companies = frappe.get_all("Company", fields=["name", "country", "default_currency", "chart_of_accounts"])
	company = companies[0] if len(companies) == 1 else None
	currency = company.default_currency if company else "DZD"
	for name in api.PRICE_LISTS.values():
		if not frappe.db.exists("Price List", name):
			frappe.get_doc({
				"doctype": "Price List", "price_list_name": name,
				"selling": 1, "enabled": 1, "currency": currency,
			}).insert(ignore_permissions=True)
	if not company:
		return
	from atelier import accounts_ar

	if accounts_ar.matches_chart(company):
		if not frappe.db.get_default("atelier_accounts_ar_initialized"):
			accounts_ar.run(company=company.name, commit=False)
			frappe.db.set_default("atelier_accounts_ar_initialized", company.name)
		accounts_ar.default_bank(company=company.name, commit=False, only_if_missing=True)
		accounts_ar.party_accounts(company.name)
		accounts_ar.payment_modes(company.name)
		materials.setup(company.name)
