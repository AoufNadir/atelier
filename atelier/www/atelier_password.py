import frappe

no_cache = 1


def get_context(context):
	"""Choosing a password from a link the manager sent (replaces ERPNext's /update-password page)."""
	from atelier.simple import workshop_profile

	p = workshop_profile()
	context.workshop = " · ".join(x for x in (p.get("name_ar"), p.get("city")) if x)
	context.no_header = True
	return context
