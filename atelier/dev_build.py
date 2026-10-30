"""Creates the app's DocTypes/Reports in developer mode (writes JSON into the app).

Run: bench --site development.localhost execute atelier.dev_build.build
"""

import frappe

MODULE = "Atelier"

COST_TYPES = "Matière\nMachine\nMain d'œuvre\nSous-traitance\nFinition\nAutre"


def _doctype(name, fields, **props):
	if frappe.db.exists("DocType", name):
		doc = frappe.get_doc("DocType", name)
		doc.fields = []
	else:
		doc = frappe.new_doc("DocType")
		doc.name = name
	doc.update({"module": MODULE, "custom": 0, **props})
	for f in fields:
		doc.append("fields", f)
	doc.save() if not doc.is_new() else doc.insert()


def build():
	_doctype(
		"Cost Estimate Line",
		[
			{"fieldname": "cost_type", "label": "Type de coût", "fieldtype": "Select", "options": COST_TYPES, "reqd": 1, "in_list_view": 1, "columns": 2},
			{"fieldname": "item", "label": "Article", "fieldtype": "Link", "options": "Item", "in_list_view": 1, "columns": 2},
			{"fieldname": "description", "label": "Description", "fieldtype": "Data", "in_list_view": 1, "columns": 2},
			{"fieldname": "qty", "label": "Quantité", "fieldtype": "Float", "default": "1", "in_list_view": 1, "columns": 1},
			{"fieldname": "uom", "label": "Unité", "fieldtype": "Link", "options": "UOM"},
			{"fieldname": "rate", "label": "Coût unitaire", "fieldtype": "Currency", "in_list_view": 1, "columns": 1},
			{"fieldname": "zero_confirmed", "label": "Coût zéro confirmé", "fieldtype": "Check",
				"description": "Cocher seulement si le coût est réellement nul. Sinon, un coût vide ou 0 est considéré comme manquant."},
			{"fieldname": "rate_source", "label": "Source du coût", "fieldtype": "Select",
				"options": "\nSaisie manuelle\nValorisation stock\nTaux démo\nDevis fournisseur", "read_only": 0},
			{"fieldname": "amount", "label": "Montant", "fieldtype": "Currency", "read_only": 1, "in_list_view": 1, "columns": 1},
			{"fieldname": "is_missing", "label": "Donnée manquante", "fieldtype": "Check", "read_only": 1, "in_list_view": 1, "columns": 1},
		],
		istable=1,
		editable_grid=1,
	)
	_doctype(
		"Cost Estimate",
		[
			{"fieldname": "customer", "label": "Client", "fieldtype": "Link", "options": "Customer", "reqd": 1, "in_list_view": 1, "in_standard_filter": 1},
			{"fieldname": "title", "label": "Objet", "fieldtype": "Data", "reqd": 1, "in_list_view": 1},
			{"fieldname": "qty", "label": "Quantité produite", "fieldtype": "Float", "default": "1", "reqd": 1},
			{"fieldname": "column_break_1", "fieldtype": "Column Break"},
			{"fieldname": "company", "label": "Société", "fieldtype": "Link", "options": "Company", "reqd": 1},
			{"fieldname": "project", "label": "Projet", "fieldtype": "Link", "options": "Project", "in_standard_filter": 1},
			{"fieldname": "quotation", "label": "Devis", "fieldtype": "Link", "options": "Quotation"},
			{"fieldname": "sales_order", "label": "Commande client", "fieldtype": "Link", "options": "Sales Order"},
			{"fieldname": "section_lines", "label": "Éléments de coût", "fieldtype": "Section Break"},
			{"fieldname": "lines", "label": "Lignes", "fieldtype": "Table", "options": "Cost Estimate Line"},
			{"fieldname": "waste_percent", "label": "Gâche matière (%)", "fieldtype": "Percent",
				"description": "Appliquée aux lignes Matière uniquement."},
			{"fieldname": "section_result", "label": "Résultat estimé", "fieldtype": "Section Break"},
			{"fieldname": "total_cost", "label": "Coût total estimé", "fieldtype": "Currency", "read_only": 1},
			{"fieldname": "unit_cost", "label": "Coût unitaire estimé", "fieldtype": "Currency", "read_only": 1},
			{"fieldname": "missing_count", "label": "Lignes sans coût", "fieldtype": "Int", "read_only": 1},
			{"fieldname": "column_break_2", "fieldtype": "Column Break"},
			{"fieldname": "selling_price", "label": "Prix de vente total (HT)", "fieldtype": "Currency"},
			{"fieldname": "price_zero_confirmed", "label": "Prix zéro confirmé (gratuit)", "fieldtype": "Check"},
			{"fieldname": "pricing_status", "label": "Statut du prix", "fieldtype": "Select",
				"options": "En attente de prix\nPrix fixé\nGratuit confirmé", "read_only": 1, "in_list_view": 1, "in_standard_filter": 1},
			{"fieldname": "estimated_margin", "label": "Marge estimée", "fieldtype": "Currency", "read_only": 1},
			{"fieldname": "margin_percent", "label": "Marge estimée (%)", "fieldtype": "Percent", "read_only": 1},
			{"fieldname": "is_estimate_complete", "label": "Estimation complète", "fieldtype": "Check", "read_only": 1},
		],
		autoname="CE-.YYYY.-.#####",
		title_field="title",
		track_changes=1,
		permissions=[
			{"role": "System Manager", "read": 1, "write": 1, "create": 1, "delete": 1, "report": 1, "export": 1, "print": 1},
			{"role": "Accounts Manager", "read": 1, "write": 1, "create": 1, "report": 1, "print": 1},
			{"role": "Sales Manager", "read": 1, "write": 1, "create": 1, "report": 1, "print": 1},
		],
	)
	_report("Rentabilite Commande", "Project")
	frappe.db.commit()
	print("BUILD_OK")


def _report(name, ref_doctype):
	if frappe.db.exists("Report", name):
		return
	frappe.get_doc(
		{
			"doctype": "Report",
			"report_name": name,
			"ref_doctype": ref_doctype,
			"report_type": "Script Report",
			"is_standard": "Yes",
			"module": MODULE,
			"roles": [{"role": "System Manager"}, {"role": "Accounts Manager"}],
		}
	).insert()
