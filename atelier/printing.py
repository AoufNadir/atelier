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


def tafqit(amount, lang="ar"):
	"""28000.5 → «ثمانية وعشرون ألف دينار جزائري وخمسون سنتيمًا» (wording used on Algerian invoices)."""
	amount = abs(round(flt(amount), 2))  # a credit note's total is negative; its title already says what it is
	if lang == "fr":
		return _tafqit_fr(amount)
	dinars, cents = int(amount), int(round((amount - int(amount)) * 100))
	text = f"{number_words(dinars)} دينار جزائري"
	if cents:
		text += f" و{number_words(cents)} سنتيم"
	return text + " لا غير"


# wkhtmltopdf's fonts have no glyphs for the Unicode isolate marks used in the app, so numbers are
# wrapped in a left-to-right span instead (the template's .num class).
def _tafqit_fr(amount):
	"""28000.5 → «vingt-huit mille dinars algériens et cinquante centimes» (Arrêtée la présente facture à la somme de…)."""
	from num2words import num2words

	dinars, cents = int(amount), int(round((amount - int(amount)) * 100))
	text = f"{num2words(dinars, lang='fr')} dinar{'s' if dinars > 1 else ''} algérien{'s' if dinars > 1 else ''}"
	if cents:
		text += f" et {num2words(cents, lang='fr')} centime{'s' if cents > 1 else ''}"
	return text


def dz_money(value, lang="ar"):
	"""28,000.00 دج — or 28 000,00 DA on a French document."""
	if lang == "fr":
		return '<span class="num">' + f"{flt(value):,.2f}".replace(",", "\u202f").replace(".", ",") + "</span> DA"
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


# every word printed on a document, in both languages (French for administrations and companies that ask for it)
WORDS = {
	"ar": {"demo": "وثيقة تجريبية — الأسماء والأرقام وهمية", "phone": "الهاتف", "no": "رقم", "against": "مقابل الفاتورة", "date": "التاريخ",
		"due": "تاريخ الاستحقاق", "devis_band": "عرض سعر — DEVIS", "devis_note": "عرض مقترح للعميل، وليس فاتورة ولا إثبات دفع",
		"pf_band": "فاتورة شكلية — PRO FORMA", "pf_note": "وثيقة لتحضير الدفع فقط، ليست فاتورة نهائية ولا إثبات دفع",
		"received_from": "استلمنا من", "customer": "العميل", "subject": "الموضوع", "valid": "صالح حتى", "pickup": "موعد الاستلام",
		"later": "يُحدَّد لاحقًا", "ask": "للاستفسار", "received": "المبلغ المقبوض", "method": "طريقة الدفع", "for_invoice": "عن الفاتورة",
		"for_order": "عن الطلب", "advance_left": "تسبيق يبقى رصيدًا للعميل", "in_words": "المبلغ بالحروف", "desc": "البيان", "qty": "الكمية",
		"unit": "الوحدة", "rate": "سعر الوحدة", "amount": "المبلغ", "waiting": "بانتظار التسعير", "total": "المجموع", "discount": "الخصم",
		"grand": "الإجمالي", "grand_part": "إجمالي البنود المسعّرة", "paid": "المدفوع", "left": "الباقي", "advance": "التسبيق المخصوم",
		"credit": "رصيد للعميل عندنا", "to_pay": "الباقي للدفع", "incomplete": "الإجمالي النهائي لم يكتمل: {0} بند بانتظار التسعير.",
		"stop_invoice": "أُوقفت هذه الفاتورة على مبلغ", "stop_credit": "أُوقفت هذه الفاتورة الدائنة على مبلغ", "pay_info": "معلومات الدفع",
		"sign_receiver": "توقيع المستلم", "sign_quote": "موافقة العميل وتوقيعه", "sign_customer": "توقيع العميل", "stamp": "الختم والتوقيع",
		"modes": {"Cash": "نقدًا", "Wire Transfer": "تحويل بنكي", "Cheque": "صك"}, "units": {"Nos": "قطعة", "Feuille": "ورقة"}},
	"fr": {"demo": "Document de démonstration — noms et chiffres fictifs", "phone": "Tél", "no": "N°", "against": "Sur la facture", "date": "Date",
		"due": "Échéance", "devis_band": "DEVIS", "devis_note": "Proposition au client — ni facture ni preuve de paiement",
		"pf_band": "FACTURE PRO FORMA", "pf_note": "Document préparatoire au paiement — ni facture définitive ni preuve de paiement",
		"received_from": "Reçu de", "customer": "Client", "subject": "Objet", "valid": "Valable jusqu'au", "pickup": "Date de retrait",
		"later": "À préciser", "ask": "Renseignements", "received": "Montant reçu", "method": "Mode de paiement", "for_invoice": "Facture",
		"for_order": "Commande", "advance_left": "Avance restant au crédit du client", "in_words": "Montant en lettres", "desc": "Désignation",
		"qty": "Qté", "unit": "Unité", "rate": "Prix unitaire", "amount": "Montant", "waiting": "Prix à définir", "total": "Total",
		"discount": "Remise", "grand": "Total", "grand_part": "Total des lignes chiffrées", "paid": "Payé", "left": "Reste",
		"advance": "Avance déduite", "credit": "Crédit du client", "to_pay": "Net à payer", "incomplete": "Total incomplet : {0} ligne(s) sans prix.",
		"stop_invoice": "Arrêtée la présente facture à la somme de", "stop_credit": "Arrêté le présent avoir à la somme de",
		"pay_info": "Informations de paiement", "sign_receiver": "Signature du réceptionnaire", "sign_quote": "Bon pour accord — signature du client",
		"sign_customer": "Signature du client", "stamp": "Cachet et signature",
		"modes": {"Cash": "Espèces", "Wire Transfer": "Virement", "Cheque": "Chèque", "CCP": "CCP", "BaridiMob": "BaridiMob"},
		"units": {"Nos": "pièce", "Feuille": "feuille", "قطعة": "pièce", "ورقة": "feuille", "م²": "m²", "متر": "m", "ساعة": "heure", "خدمة": "forfait", "رزمة": "rame", "لفّة": "rouleau"}},
}
TITLES_FR = {"Quotation": "Devis", "Sales Order": "Bon de commande", "Delivery Note": "Bon de livraison", "Sales Invoice": "Facture",
	"Payment Entry": "Reçu de paiement", "Statement": "Relevé de compte", "Journal Entry": "Écriture"}


def doc_lang(doc):
	"""French or Arabic: asked for this one document (?lang=fr), else the customer's choice, else Arabic."""
	asked = (frappe.form_dict.get("lang") or "") if getattr(frappe.local, "form_dict", None) else ""
	if asked in WORDS:
		return asked
	party = {"Payment Entry": doc.get("party"), "Quotation": doc.get("party_name")}.get(doc.doctype) or doc.get("customer")
	if party and frappe.db.has_column("Customer", "atelier_doc_lang"):
		return frappe.db.get_value("Customer", party, "atelier_doc_lang") or "ar"
	return "ar"


def item_name(row, lang):
	"""A service's French name when the document is in French and one was given in the price list."""
	if lang == "fr" and row.get("item_code") and frappe.db.has_column("Item", "atelier_name_fr"):
		return frappe.db.get_value("Item", row.item_code, "atelier_name_fr") or row.item_name
	return row.item_name


def print_context(doc):
	company = frappe.get_cached_doc("Company", doc.company)
	party = {"Payment Entry": doc.get("party"), "Quotation": doc.get("party_name")}.get(doc.doctype) or doc.get("customer")
	customer = frappe.db.get_value("Customer", party, ["customer_name", "customer_type", "mobile_no", "tax_id", "atelier_rc", "atelier_nis", "atelier_ai"], as_dict=True) or {}
	from atelier.simple import doc_settings, workshop_profile
	prof, docs = workshop_profile(), doc_settings()
	logo = prof.get("logo") or company.company_logo
	address = "، ".join(x for x in (prof.get("address"), prof.get("city")) if x) or _address("Company", company.name)
	lang = doc_lang(doc)
	fr = lang == "fr"
	return {
		"lang": lang, "t": WORDS[lang],
		"title": ("Facture pro forma" if fr else "فاتورة شكلية Pro forma") if doc.get("atelier_kind") == "proforma"
			else ("Avoir" if fr else "فاتورة دائنة (Avoir)") if doc.doctype == "Sales Invoice" and doc.get("is_return")
			else (TITLES_FR if fr else TITLES).get(doc.doctype, doc.doctype),
		"against": doc.get("return_against") if doc.get("is_return") else None,
		"show_description": _show_description(),
		"date": formatdate(doc.get("posting_date") or doc.get("transaction_date"), "dd/MM/yyyy"),
		# the demo banner only while the workshop has not given its own name in Settings → بيانات المطبعة
		"is_demo": ("DÉMO" in company.name or "Démo" in company.name or "تجريبي" in company.name)
			and (prof.get("name_ar") or "") in ("", "مطبعة الرؤية", company.company_name),
		"number": (doc.name.rsplit("-", 1)[-1].lstrip("0") or doc.name) if "-" in doc.name else doc.name,
		"company": {"name": (prof.get("name_fr") if fr else None) or prof.get("name_ar") or company.company_name,
			"name_fr": None if fr else prof.get("name_fr"),
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


def custom_fields():
	"""The customer's document language, and a service's French name for French documents."""
	from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

	create_custom_fields({
		"Customer": [{"fieldname": "atelier_doc_lang", "label": "لغة الوثائق", "fieldtype": "Select", "options": "ar\nfr", "default": "ar",
			"insert_after": "atelier_tva_exempt", "module": "Atelier"}],
		"Item": [{"fieldname": "atelier_name_fr", "label": "الاسم بالفرنسية", "fieldtype": "Data", "insert_after": "item_name", "module": "Atelier"}],
	}, update=True)


@frappe.whitelist(methods=["POST"])
def set_item_name_fr(item_code, name=""):
	"""The service's name on French documents (empty = the Arabic name is used)."""
	frappe.has_permission("Item", "write", item_code, throw=True)
	frappe.db.set_value("Item", item_code, "atelier_name_fr", (name or "").strip()[:140])
	return (name or "").strip()[:140]
