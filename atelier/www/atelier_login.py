import frappe

no_cache = 1


def get_context(context):
	"""Sign-in page in the workshop's identity. Already signed in: straight to the app."""
	if frappe.session.user != "Guest":
		frappe.local.flags.redirect_location = "/atelier"
		raise frappe.Redirect
	from atelier.simple import workshop_profile

	p = workshop_profile()
	context.workshop = " · ".join(x for x in (p.get("name_ar"), p.get("city")) if x)
	context.no_header = True
	return context
