# Copyright (c) 2026, Demo Atelier and contributors
# For license information, please see license.txt
"""Order (project) profitability: estimate vs. actual.

Actual accounting figures come only from GL Entry (one source, so nothing is counted twice).
Internal labour/machine time comes from Timesheets and is shown separately because it is
not posted to the ledger (salaries/depreciation are already period expenses).
"""

import frappe
from frappe import _
from frappe.utils import flt


def execute(filters=None):
	filters = frappe._dict(filters or {})
	if not filters.project:
		return columns(), []
	return columns(), rows(filters.project)


def columns():
	return [
		{"fieldname": "section", "label": _("Section"), "fieldtype": "Data", "width": 200},
		{"fieldname": "label", "label": _("Rubrique"), "fieldtype": "Data", "width": 280},
		{"fieldname": "estimated", "label": _("Estimé"), "fieldtype": "Currency", "width": 140},
		{"fieldname": "actual", "label": _("Réel"), "fieldtype": "Currency", "width": 140},
		{"fieldname": "note", "label": _("Source / remarque"), "fieldtype": "Data", "width": 360},
	]


def rows(project):
	out = []

	def add(section, label, est=None, act=None, note="", bold=0):
		out.append({"section": section, "label": label, "estimated": est, "actual": act, "note": note, "bold": bold})

	est = estimate(project)
	gl = gl_totals(project)
	internal = internal_cost(project)

	revenue = sum(gl["Income"].values())
	ledger_cost = sum(gl["Expense"].values())

	add(_("1. Chiffre d'affaires"), _("Ventes facturées (HT)"), est["selling_price"], revenue,
		_("Grand livre: comptes de produits"), 1)

	add(_("2. Coûts comptabilisés"), "")
	for account, amount in sorted(gl["Expense"].items()):
		add("", account, None, amount, _("Grand livre"))
	for cost_type, amount in est["by_type"].items():
		add("", _("Estimé: {0}").format(cost_type), amount, None, _("Estimation de coût"))
	add("", _("Total coûts comptabilisés"), None, ledger_cost, "", 1)

	add(_("3. Coûts internes"), _("Temps main d'œuvre / machine"), None, internal,
		_("Feuilles de temps: coût interne, non passé au grand livre"))

	total_actual = ledger_cost + internal
	add(_("4. Résultat"), _("Coût total"), est["total_cost"], total_actual, "", 1)
	add("", _("Marge estimée (devis)"), est["margin"], None,
		_("Estimation incomplète: {0} ligne(s) sans coût").format(est["missing"]) if est["missing"] else _("Estimation"), 1)
	add("", _("Résultat de la commande"), None, revenue - total_actual,
		_("Ventes facturées − coûts comptabilisés − coûts internes"), 1)

	cash = cash_position(project)
	add(_("5. Trésorerie (≠ résultat)"), _("Encaissé du client"), None, cash["received"],
		_("Paiements reçus liés à la commande"))
	add("", _("Reste à encaisser (factures)"), None, cash["outstanding"], _("Factures validées"))
	add("", _("Acompte non encore imputé sur facture"), None, cash["unallocated"],
		_("Avance client: dette envers le client, pas un produit"))

	for warning in warnings(project):
		add(_("⚠ À compléter"), warning)
	return out


def estimate(project):
	res = {"selling_price": None, "total_cost": None, "margin": None, "missing": 0, "by_type": {}}
	estimates = frappe.get_all(
		"Cost Estimate",
		filters={"project": project},
		fields=["name", "selling_price", "total_cost", "estimated_margin", "missing_count", "pricing_status"],
	)
	if not estimates:
		return res
	res["total_cost"] = sum(flt(e.total_cost) for e in estimates)
	res["missing"] = sum(e.missing_count or 0 for e in estimates)
	if all(e.pricing_status != "En attente de prix" for e in estimates):
		res["selling_price"] = sum(flt(e.selling_price) for e in estimates)
		res["margin"] = sum(flt(e.estimated_margin) for e in estimates)
	for line in frappe.get_all(
		"Cost Estimate Line",
		filters={"parent": ["in", [e.name for e in estimates]], "parenttype": "Cost Estimate"},
		fields=["cost_type", "amount"],
	):
		res["by_type"][line.cost_type] = res["by_type"].get(line.cost_type, 0) + flt(line.amount)
	return res


def gl_totals(project):
	data = frappe.db.sql(
		"""select acc.root_type, gle.account, sum(gle.debit - gle.credit) as amount
		from `tabGL Entry` gle join `tabAccount` acc on acc.name = gle.account
		where gle.project = %s and gle.is_cancelled = 0 and acc.root_type in ('Income', 'Expense')
		group by acc.root_type, gle.account""",
		project,
		as_dict=True,
	)
	res = {"Income": {}, "Expense": {}}
	for d in data:
		res[d.root_type][d.account] = -flt(d.amount) if d.root_type == "Income" else flt(d.amount)
	return res


def internal_cost(project):
	return flt(
		frappe.db.sql(
			"""select sum(tsd.costing_amount) from `tabTimesheet Detail` tsd
			join `tabTimesheet` ts on ts.name = tsd.parent
			where tsd.project = %s and ts.docstatus = 1""",
			project,
		)[0][0]
	)


def _received(docs, doctype=None):
	if not docs:
		return 0
	condition = "and per.reference_doctype = %(dt)s" if doctype else ""
	return flt(
		frappe.db.sql(
			f"""select sum(per.allocated_amount) from `tabPayment Entry Reference` per
			join `tabPayment Entry` pe on pe.name = per.parent
			where pe.docstatus = 1 and pe.payment_type = 'Receive'
			and per.reference_name in %(docs)s {condition}""",
			{"docs": docs, "dt": doctype},
		)[0][0]
	)


def cash_position(project):
	orders = frappe.get_all("Sales Order", {"project": project, "docstatus": 1}, pluck="name")
	invoices = frappe.get_all("Sales Invoice", {"project": project, "docstatus": 1}, pluck="name")
	outstanding = flt(
		frappe.db.sql(
			"select sum(outstanding_amount) from `tabSales Invoice` where project = %s and docstatus = 1",
			project,
		)[0][0]
	)
	advances_on_invoice = flt(
		frappe.db.sql(
			"""select sum(adv.allocated_amount) from `tabSales Invoice Advance` adv
			join `tabSales Invoice` si on si.name = adv.parent
			where si.project = %s and si.docstatus = 1""",
			project,
		)[0][0]
	)
	on_orders = _received(orders, "Sales Order")
	return {
		"received": on_orders + _received(invoices, "Sales Invoice"),
		"outstanding": outstanding,
		"unallocated": max(on_orders - advances_on_invoice, 0),
	}


def warnings(project):
	w = []
	for so in frappe.get_all(
		"Sales Order", {"project": project, "docstatus": 1, "per_billed": ["<", 100]}, ["name", "per_billed"]
	):
		w.append(_("Commande {0} facturée à {1}%").format(so.name, flt(so.per_billed, 0)))
	for po in frappe.get_all("Purchase Order", {"project": project, "docstatus": 1, "per_billed": ["<", 100]}, ["name"]):
		w.append(_("Achat {0} non entièrement facturé par le fournisseur: coût réel incomplet").format(po.name))
	for dt in ("Sales Invoice", "Purchase Invoice", "Stock Entry", "Timesheet", "Journal Entry"):
		if frappe.get_meta(dt).has_field("project"):
			n = frappe.db.count(dt, {"project": project, "docstatus": 0})
			if n:
				w.append(_("{0} {1} en brouillon (non comptabilisé)").format(n, _(dt)))
	return w
