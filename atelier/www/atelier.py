import os

import frappe

no_cache = 1


def get_context(context):
	if frappe.session.user == "Guest":
		frappe.local.flags.redirect_location = "/login?redirect-to=/atelier"
		raise frappe.Redirect
	context.csrf_token = frappe.sessions.get_csrf_token()
	# Cache-busting: version = latest change of the app's own assets.
	public = frappe.get_app_path("atelier", "public", "atelier")
	context.build = int(max(os.path.getmtime(os.path.join(root, f)) for root, _, files in os.walk(public) for f in files))
	context.no_header = True
	return context
