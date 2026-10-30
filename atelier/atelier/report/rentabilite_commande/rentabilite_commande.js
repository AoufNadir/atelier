// Copyright (c) 2026, Demo Atelier and contributors
// For license information, please see license.txt

frappe.query_reports["Rentabilite Commande"] = {
	filters: [
		{
			fieldname: "project",
			label: __("Projet"),
			fieldtype: "Link",
			options: "Project",
			reqd: 1,
		},
	],
	formatter(value, row, column, data, default_formatter) {
		value = default_formatter(value, row, column, data);
		return data && data.bold ? `<b>${value}</b>` : value;
	},
};
