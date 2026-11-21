"""Jinja helpers for the Arabic print formats (templates/print/atelier_doc.html)."""

import frappe
from frappe.utils import flt, formatdate, get_url

TITLES = {"Quotation": "عرض سعر", "Sales Order": "بون طلب", "Delivery Note": "بون تسليم",
	"Sales Invoice": "فاتورة", "Payment Entry": "وصل دفع", "Statement": "كشف حساب", "Journal Entry": "قيد"}

ONES = ["", "واحد", "اثنان", "ثلاثة", "أربعة", "خمسة", "ستة", "سبعة", "ثمانية", "تسعة", "عشرة",
	"أحد عشر", "اثنا عشر", "ثلاثة عشر", "أربعة عشر", "خمسة عشر", "ستة عشر", "سبعة عشر", "ثمانية عشر", "تسعة عشر"]
TENS = ["", "", "عشرون", "ثلاثون", "أربعون", "خمسون", "ستون", "سبعون", "ثمانون", "تسعون"]
HUNDREDS = ["", "مائة", "مائتان", "ثلاثمائة", "أربعمائة", "خمسمائة", "ستمائة", "سبعمائة", "ثمانمائة", "تسعمائة"]
# (one, two, 3–10 plural, 11+ singular)
SCALES = [("", "", "", ""), ("ألف", "ألفان", "آلاف", "ألف"), ("مليون", "مليونان", "ملايين", "مليون"),
	("مليار", "ملياران", "مليارات", "مليار")]


def _below_1000(n):
	parts = []
	if n >= 100:
		parts.append(HUNDREDS[n // 100])
		n %= 100
	if n >= 20:
		parts.append(f"{ONES[n % 10]} و{TENS[n // 10]}" if n % 10 else TENS[n // 10])
	elif n:
		parts.append(ONES[n])
	return " و".join(parts)


def number_words(n):
	n = int(n)
	if n == 0:
		return "صفر"
	groups, i = [], 0
	while n:
		n, g = divmod(n, 1000)
		if g:
			one, two, plural, single = SCALES[i]
			if i == 0:
				groups.append(_below_1000(g))
			elif g == 1:
				groups.append(one)
			elif g == 2:
				groups.append(two)
			elif 3 <= g <= 10:
				groups.append(f"{_below_1000(g)} {plural}")
			else:
				groups.append(f"{_below_1000(g)} {single}")
		i += 1
	return " و".join(reversed(groups))


def tafqit(amount):
	"""28000.5 → «ثمانية وعشرون ألف دينار جزائري وخمسون سنتيمًا» (wording used on Algerian invoices)."""
	amount = abs(round(flt(amount), 2))  # a credit note's total is negative; its title already says what it is
	dinars, cents = int(amount), int(round((amount - int(amount)) * 100))
	text = f"{number_words(dinars)} دينار جزائري"
	if cents:
		text += f" و{number_words(cents)} سنتيم"
	return text + " لا غير"


# wkhtmltopdf's fonts have no glyphs for the Unicode isolate marks used in the app, so numbers are
# wrapped in a left-to-right span instead (the template's .num class).
def dz_money(value):
	"""28,000.00 دج"""
	return f'<span class="num">{flt(value):,.2f}</span> دج'


def dz_qty(value):
	v = flt(value)
	text = f"{v:,.0f}" if v == int(v) else f"{v:,.3f}".rstrip("0").rstrip(".")
	return f'<span class="num">{text}</span>'


def _address(doctype, name):
	addr = frappe.get_all("Dynamic Link", {"link_doctype": doctype, "link_name": name, "parenttype": "Address"}, pluck="parent", limit=1)
	if not addr:
		return ""
	a = frappe.db.get_value("Address", addr[0], ["address_line1", "city"], as_dict=True)
	return "، ".join(x for x in (a.address_line1, a.city if a.city != "—" else None) if x)


def print_context(doc):
	company = frappe.get_cached_doc("Company", doc.company)
	party = {"Payment Entry": doc.get("party"), "Quotation": doc.get("party_name")}.get(doc.doctype) or doc.get("customer")
	customer = frappe.db.get_value("Customer", party, ["customer_name", "customer_type", "mobile_no", "tax_id", "atelier_rc", "atelier_nis", "atelier_ai"], as_dict=True) or {}
	from atelier.simple import doc_settings, workshop_profile
	prof, docs = workshop_profile(), doc_settings()
	logo = prof.get("logo") or company.company_logo
	address = "، ".join(x for x in (prof.get("address"), prof.get("city")) if x) or _address("Company", company.name)
	return {
		"title": "فاتورة شكلية Pro forma" if doc.get("atelier_kind") == "proforma"
			else "فاتورة دائنة (Avoir)" if doc.doctype == "Sales Invoice" and doc.get("is_return")
			else TITLES.get(doc.doctype, doc.doctype),
		"against": doc.get("return_against") if doc.get("is_return") else None,
		"show_description": _show_description(),
		"date": formatdate(doc.get("posting_date") or doc.get("transaction_date"), "dd/MM/yyyy"),
		# the demo banner only while the workshop has not given its own name in Settings → بيانات المطبعة
		"is_demo": ("DÉMO" in company.name or "Démo" in company.name or "تجريبي" in company.name)
			and (prof.get("name_ar") or "") in ("", "مطبعة الرؤية", company.company_name),
		"number": (doc.name.rsplit("-", 1)[-1].lstrip("0") or doc.name) if "-" in doc.name else doc.name,
		"company": {"name": prof.get("name_ar") or company.company_name, "name_fr": prof.get("name_fr"),
			"phone": " · ".join(x for x in (prof.get("phone") or company.phone_no, prof.get("phone2")) if x),
			"email": prof.get("email") or company.email, "tax_id": prof.get("nif") or company.tax_id,
			"rc": prof.get("rc"), "nis": prof.get("nis"), "ai": prof.get("ai"), "rib": prof.get("rib"),
			"logo": (get_url(logo) if logo and logo.startswith("/") else logo), "address": address},
		"footer": docs.get("footer"),
		"customer": {"name": customer.get("customer_name") or party, "phone": customer.get("mobile_no"),
			"tax_id": customer.get("tax_id") if customer.get("customer_type") == "Company" else None,
			**({"rc": customer.get("atelier_rc"), "nis": customer.get("atelier_nis"), "ai": customer.get("atelier_ai")} if customer.get("customer_type") == "Company" else {}),
			"address": _address("Customer", party)},
		"font_url": get_url("/assets/atelier/atelier/fonts/cairo.css"),  # bundled: prints the same without internet
	}


def _show_description():
	from atelier import simple

	return simple.doc_settings().get("show_description", 1)


@frappe.whitelist()
def pdf(doctype, name, format=None, no_letterhead=1):
	"""The PDF of a document; when the PDF engine fails (e.g. it cannot reach the site's address), an Arabic page
	instead of a server error, with a print view that the browser itself can print."""
	import html
	from urllib.parse import quote

	from frappe.utils.print_format import download_pdf

	try:
		download_pdf(doctype, name, format=format, no_letterhead=no_letterhead)
		return
	except Exception:
		frappe.log_error(title="Atelier PDF")
		frappe.clear_messages()
	view = f"/printview?doctype={quote(doctype)}&name={quote(name)}" + (f"&format={quote(format)}" if format else "") + "&no_letterhead=1&trigger_print=1"
	page = f"""<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>تعذّر إنشاء PDF</title>
<style>body{{font-family:Cairo,Tahoma,sans-serif;background:#F5F6F8;color:#17202A;display:grid;place-items:center;min-height:90vh;margin:0}}
main{{background:#fff;border:1px solid #E4E7EC;border-radius:12px;padding:28px;max-width:460px;text-align:center}}
a{{display:inline-block;margin:6px;padding:9px 16px;border-radius:8px;text-decoration:none;font-weight:700}}
.p{{background:#4F35D2;color:#fff}}.s{{border:1px solid #D0D5DD;color:#17202A}}p{{color:#475467;line-height:1.8}}</style></head>
<body><main><h1 style="font-size:20px;margin:0 0 8px">تعذّر إنشاء ملف PDF الآن</h1>
<p>المستند {html.escape(name)} محفوظ. يمكنك طباعته من المتصفح مباشرة، أو المحاولة لاحقًا. سُجّل الخطأ ليراجعه المسؤول.</p>
<a class="p" href="{html.escape(view)}">طباعة من المتصفح</a><a class="s" href="javascript:history.back()">العودة</a></main></body></html>"""
	frappe.local.response.type = "binary"
	frappe.local.response.filecontent = page.encode()
	frappe.local.response.filename = "error.html"
	frappe.local.response.display_content_as = "inline"
