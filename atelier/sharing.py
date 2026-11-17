"""Share chosen work samples with a customer through a temporary public link (no login).

The link shows only the images that were chosen, with a title and specs (prices only if asked).
Nothing else is reachable through it: images are served by index from the stored list.
"""
import html
import json
import secrets

import frappe
from frappe import _
from frappe.utils import add_days, cint, flt, get_datetime, now_datetime

KEY = "atelier_shares"
MAX_ITEMS = 24


def _all():
	try:
		return json.loads(frappe.db.get_default(KEY) or "{}") or {}
	except ValueError:
		return {}


def _put(data):
	frappe.db.set_default(KEY, json.dumps(data, ensure_ascii=False))


def _alive(sh):
	return not sh.get("expires") or get_datetime(sh["expires"]) > now_datetime()


def _get(token):
	sh = _all().get(token or "")
	if not sh or not _alive(sh):
		return None
	return sh


@frappe.whitelist(methods=["POST"])
def create_share(items, days=30, prices=0):
	"""items: [{order, file_url, title, spec, price}] chosen in the customer gallery."""
	from atelier import api

	api._require("Sales Order")
	rows = []
	for it in (frappe.parse_json(items) or [])[:MAX_ITEMS]:
		order, url = it.get("order"), it.get("file_url")
		if not order or not url:
			continue
		frappe.get_doc("Sales Order", order).check_permission("read")
		f = frappe.db.get_value("File", {"file_url": url, "attached_to_doctype": "Sales Order", "attached_to_name": order}, "name")
		if not f:
			continue
		rows.append({"file": f, "title": (it.get("title") or "")[:120], "spec": (it.get("spec") or "")[:160],
			"price": flt(it.get("price")) if cint(prices) else None})
	if not rows:
		frappe.throw(_("اختر عملًا واحدًا على الأقل له صورة"))
	data = {t: s for t, s in _all().items() if _alive(s)}  # drop expired ones
	token = secrets.token_urlsafe(16)
	days = cint(days)
	data[token] = {"items": rows, "created": str(now_datetime()), "by": frappe.session.user,
		"expires": str(add_days(now_datetime(), days)) if days > 0 else None}
	_put(data)
	return {"token": token, "url": frappe.utils.get_url(f"/api/method/atelier.sharing.share_view?t={token}"), "expires": data[token]["expires"]}


@frappe.whitelist(methods=["POST"])
def revoke_share(token):
	data = _all()
	sh = data.get(token)
	if sh and (sh.get("by") == frappe.session.user or "System Manager" in frappe.get_roles()):
		data.pop(token)
		_put(data)
	return True


def _binary(name, content):
	frappe.local.response.filename = name
	frappe.local.response.filecontent = content
	frappe.local.response.type = "binary"
	frappe.local.response.display_content_as = "inline"


@frappe.whitelist(allow_guest=True)
def share_image(t, i):
	sh = _get(t)
	idx = cint(i)
	if not sh or idx < 0 or idx >= len(sh["items"]):
		raise frappe.PermissionError
	f = frappe.get_doc("File", sh["items"][idx]["file"])
	_binary(f.file_name, f.get_content())


@frappe.whitelist(allow_guest=True)
def share_logo(t):
	if not _get(t):
		raise frappe.PermissionError
	from atelier.simple import workshop_profile

	url = workshop_profile().get("logo")
	name = url and frappe.db.get_value("File", {"file_url": url}, "name")
	if not name:
		raise frappe.DoesNotExistError
	f = frappe.get_doc("File", name)
	_binary(f.file_name, f.get_content())


@frappe.whitelist(allow_guest=True)
def share_view(t):
	from atelier.simple import workshop_profile

	sh = _get(t)
	p = workshop_profile()
	e = html.escape
	if not sh:
		body = f'<div class="gone"><b>انتهت صلاحية هذا الرابط</b><p>اطلب من {e(p.get("name_ar") or "المطبعة")} رابطًا جديدًا.</p></div>'
	else:
		tiles = "".join(
			f'<figure><a href="/api/method/atelier.sharing.share_image?t={e(t)}&i={n}" target="_blank"><img src="/api/method/atelier.sharing.share_image?t={e(t)}&i={n}" alt="" loading="lazy"></a>'
			f'<figcaption><b>{e(x["title"])}</b>{"<small>" + e(x["spec"]) + "</small>" if x.get("spec") else ""}'
			f'{"<em>" + frappe.utils.fmt_money(x["price"], 2) + " دج</em>" if x.get("price") else ""}</figcaption></figure>'
			for n, x in enumerate(sh["items"]))
		phone = "".join(c for c in (p.get("phone") or "") if c.isdigit())
		if phone.startswith("0"):
			phone = "213" + phone[1:]
		wa = f'<a class="wa" href="https://wa.me/{phone}?text={e("السلام عليكم، أريد عرض سعر لعمل مشابه")}">اطلب عرض سعر على واتساب</a>' if phone else ""
		until = f'صالح حتى {get_datetime(sh["expires"]).strftime("%d/%m/%Y")}' if sh.get("expires") else ""
		body = f'<main class="grid">{tiles}</main>{wa}<footer>{until}</footer>'
	logo = f'<img class="logo" src="/api/method/atelier.sharing.share_logo?t={e(t)}" alt="">' if sh and p.get("logo") else f'<span class="logo ini">{e((p.get("name_ar") or "ن")[:1])}</span>'
	sub = " · ".join(x for x in [p.get("city"), p.get("phone")] if x)
	page = f"""<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>{e(p.get("name_ar") or "")} — نماذج من أعمالنا</title>
<style>*{{box-sizing:border-box}}body{{margin:0;background:#F5F6F8;font-family:Cairo,Tahoma,sans-serif;color:#17202A}}
header{{display:flex;gap:12px;align-items:center;padding:14px 16px;background:#fff;border-bottom:1px solid #E4E7EC}}
.logo{{width:44px;height:44px;border-radius:10px;object-fit:contain;background:#fff}}.ini{{display:flex;align-items:center;justify-content:center;background:#4F35D2;color:#fff;font-weight:800;font-size:20px}}
header b{{display:block;font-size:16px}}header small{{color:#667085;font-size:13px}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;padding:14px;max-width:980px;margin:0 auto}}
figure{{margin:0;background:#fff;border:1px solid #E4E7EC;border-radius:12px;overflow:hidden}}figure img{{display:block;width:100%;aspect-ratio:1;object-fit:cover;background:#F2F4F7}}
figcaption{{padding:8px 10px;font-size:13px}}figcaption b{{display:block}}figcaption small{{display:block;color:#667085;font-size:12px}}figcaption em{{display:block;font-style:normal;font-weight:700;margin-top:2px}}
.wa{{display:block;max-width:420px;margin:4px auto 10px;text-align:center;background:#12B76A;color:#fff;border-radius:10px;padding:11px;font-weight:700;text-decoration:none}}
footer{{text-align:center;color:#667085;font-size:12px;padding:6px 0 20px}}.gone{{text-align:center;padding:60px 20px}}.gone p{{color:#667085}}</style></head>
<body><header>{logo}<div><b>{e(p.get("name_ar") or "")}</b><small>نماذج من أعمالنا{" · " + e(sub) if sub else ""}</small></div></header>{body}</body></html>"""
	_binary("samples.html", page.encode("utf-8"))
