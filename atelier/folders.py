"""Mirror customers and their cards as plain folders on the workshop computer.

D:\\نسق is mounted into the container at ROOT (see tools/dev/compose.nasaq.yml):
	<root>\\<sub>\\<customer>\\بيانات العميل.txt
	<root>\\<sub>\\<customer>\\<date — title (00012)>\\<files>
Folder names are stored on the documents (atelier_folder) so renames move the folder
instead of creating a second one. Nothing here ever deletes a folder or a file, and a
missing or read-only drive never blocks saving a customer or a card.
"""

import json
import os
import re
import shutil

import frappe
from frappe.utils import cint, getdate

ROOT = "/mnt/nasaq"
KEY = "atelier_folders"
DEFAULTS = {"enabled": 0, "display_root": "D:\\نسق", "sub": "العملاء", "order": "date_first"}
INFO = "بيانات العميل.txt"
BAD = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def settings():
	c = dict(DEFAULTS)
	try:
		c.update(json.loads(frappe.db.get_default(KEY) or "{}"))
	except ValueError:
		pass
	c["available"] = available()
	return c


def available():
	return os.path.isdir(ROOT) and os.access(ROOT, os.W_OK)


def active():
	return cint(settings()["enabled"]) and available()


def custom_fields():
	from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

	f = {"fieldname": "atelier_folder", "label": "المجلد", "fieldtype": "Data", "read_only": 1, "hidden": 1, "no_copy": 1, "module": "Atelier"}
	create_custom_fields({"Customer": [dict(f, insert_after="atelier_note")], "Sales Order": [dict(f, insert_after="atelier_subject")]})


def clean(s, limit=80):
	s = re.sub(r"\s+", " ", BAD.sub("-", str(s or ""))).strip(" .")
	return s[:limit].strip(" .") or "بلا اسم"


def _base():
	return os.path.join(ROOT, clean(settings()["sub"]))


def _move(old, new):
	"""Rename old to new when possible; return the path that now exists."""
	if old and old != new and os.path.isdir(old) and not os.path.exists(new):
		os.rename(old, new)
	os.makedirs(new, exist_ok=True)
	return new


def _unique(parent, name, suffix):
	if not os.path.exists(os.path.join(parent, name)):
		return name
	return clean("%s (%s)" % (name, suffix), 120)


# --- customers -------------------------------------------------------------

def customer_path(name, create=True):
	"""Absolute folder of a customer, created (or renamed into place) on demand."""
	doc = frappe.db.get_value("Customer", name, ["name", "customer_name", "atelier_folder"], as_dict=True)
	if not doc:
		return None
	base = _base()
	stored = doc.atelier_folder
	want = clean(doc.customer_name or doc.name)
	if stored and os.path.isdir(os.path.join(base, stored)):
		if stored == want or not create:
			return os.path.join(base, stored)
		target = _unique(base, want, doc.name)
		path = _move(os.path.join(base, stored), os.path.join(base, target))
	elif not create:
		return None
	else:
		target = stored or _unique(base, want, doc.name)
		path = os.path.join(base, target)
		os.makedirs(path, exist_ok=True)
	if target != stored:
		frappe.db.set_value("Customer", doc.name, "atelier_folder", target, update_modified=False)
	return path


def write_info(name, path):
	c = frappe.get_doc("Customer", name)
	rows = [
		("الاسم", c.customer_name), ("النوع", "مؤسسة" if c.customer_type == "Company" else "فرد"),
		("الهاتف", c.get("mobile_no")), ("البريد", c.get("email_id")),
		("RC", c.get("atelier_rc")), ("NIF", c.get("tax_id")), ("NIS", c.get("atelier_nis")), ("AI", c.get("atelier_ai")),
		("ملاحظة", c.get("atelier_note")), ("الرمز في البرنامج", c.name),
	]
	text = "\r\n".join("%s: %s" % (k, v) for k, v in rows if v)
	with open(os.path.join(path, INFO), "w", encoding="utf-8-sig") as fh:
		fh.write(text + "\r\n")


def on_customer(doc, method=None):
	_safe(lambda: _customer(doc.name))


def _customer(name):
	path = customer_path(name)
	if path:
		write_info(name, path)


# --- cards (sales orders) --------------------------------------------------

def _leaf(so):
	title = clean(so.get("atelier_subject") or so.name, 70)
	date = str(getdate(so.transaction_date or so.creation))
	num = so.name.rsplit("-", 1)[-1]
	parts = (title, date) if settings()["order"] == "title_first" else (date, title)
	return clean("%s — %s (%s)" % (parts[0], parts[1], num), 120)


def card_path(name, create=True):
	so = frappe.db.get_value("Sales Order", name, ["name", "customer", "atelier_subject", "atelier_folder", "transaction_date", "creation"], as_dict=True)
	if not so:
		return None
	parent = customer_path(so.customer, create)
	if not parent:
		return None
	want = _leaf(so)
	stored = so.atelier_folder
	if stored and os.path.isdir(os.path.join(parent, stored)):
		if stored == want or not create:
			return os.path.join(parent, stored)
		path = _move(os.path.join(parent, stored), os.path.join(parent, want))
	elif not create:
		return None
	else:
		path = os.path.join(parent, want)
		os.makedirs(path, exist_ok=True)
	if want != stored:
		frappe.db.set_value("Sales Order", so.name, "atelier_folder", want, update_modified=False)
	return path


def on_card(doc, method=None):
	if doc.docstatus < 2:
		_safe(lambda: card_path(doc.name))


def card_changed(name):
	_safe(lambda: card_path(name))


def current_card_path(name):
	if not active():
		return None
	try:
		return card_path(name, create=False)
	except Exception:
		return None


def card_moved(name, old_path):
	"""The card changed customer: move its folder (with its files) under the new customer."""
	def go():
		new = card_path(name)
		if old_path and os.path.isdir(old_path) and old_path != new:
			if os.path.isdir(new) and not os.listdir(new):
				os.rmdir(new)  # only the empty folder just created by on_update
			if not os.path.exists(new):
				shutil.move(old_path, new)
	_safe(go)


def _copy_file(f, folder):
	"""Copy one Frappe File into folder unless a file with that name is already there."""
	if not f.file_url or f.file_url.startswith("http"):
		return False
	src = frappe.get_doc("File", f.name).get_full_path()
	dst = os.path.join(folder, clean(f.file_name, 150))
	if os.path.exists(dst) or not os.path.isfile(src):
		return False
	shutil.copy2(src, dst)
	return True


FINAL = "نهائي"


def final_copy(name, file_url):
	"""Keep a copy of the card's final file in its «نهائي» subfolder."""
	def go():
		f = frappe.db.get_value("File", {"attached_to_doctype": "Sales Order", "attached_to_name": name, "file_url": file_url}, ["name", "file_name", "file_url"], as_dict=True)
		if f:
			folder = os.path.join(card_path(name), FINAL)
			os.makedirs(folder, exist_ok=True)
			_copy_file(f, folder)
	_safe(go)


def on_file(doc, method=None):
	if doc.attached_to_doctype != "Sales Order" or doc.is_folder or frappe.flags.atelier_from_folder:
		return
	_safe(lambda: _copy_file(doc, card_path(doc.attached_to_name)))


def _safe(fn):
	if not active():
		return
	try:
		fn()
	except Exception:
		frappe.log_error(title="نسق: تعذّرت الكتابة في المجلد")


def display(path):
	"""The Windows path a person can paste into File Explorer."""
	if not path:
		return None
	rel = os.path.relpath(path, ROOT).replace("/", "\\")
	return settings()["display_root"].rstrip("\\") + "\\" + rel


def card_folder(name):
	if not active():
		return None
	try:
		return display(card_path(name, create=False))
	except Exception:
		return None


def customer_folder(name):
	if not active():
		return None
	try:
		return display(customer_path(name, create=False))
	except Exception:
		return None


# --- endpoints -------------------------------------------------------------

@frappe.whitelist(methods=["POST"])
def save_settings(data):
	from atelier.simple import _manager_only

	_manager_only()
	d = frappe.parse_json(data) or {}
	c = {
		"enabled": cint(d.get("enabled")),
		"display_root": (str(d.get("display_root") or DEFAULTS["display_root"]).strip().rstrip("\\") or DEFAULTS["display_root"])[:200],
		"sub": clean(d.get("sub") or DEFAULTS["sub"], 60),
		"order": "title_first" if d.get("order") == "title_first" else "date_first",
	}
	frappe.db.set_default(KEY, json.dumps(c, ensure_ascii=False))
	return settings()


@frappe.whitelist(methods=["POST"])
def sync_all():
	"""Create folders for every customer and card, and copy attachments that are missing."""
	from atelier.simple import _manager_only

	_manager_only()
	if not active():
		frappe.throw("المجلدات غير مفعّلة أو القرص غير متصل.")
	n = {"customers": 0, "cards": 0, "files": 0}
	for c in frappe.get_all("Customer", pluck="name"):
		_customer(c)
		n["customers"] += 1
	for so in frappe.get_all("Sales Order", filters={"docstatus": ["<", 2]}, pluck="name"):
		path = card_path(so)
		if not path:
			continue
		n["cards"] += 1
		for f in frappe.get_all("File", filters={"attached_to_doctype": "Sales Order", "attached_to_name": so, "is_folder": 0},
				fields=["name", "file_name", "file_url"]):
			n["files"] += 1 if _copy_file(f, path) else 0
	return n


@frappe.whitelist(methods=["POST"])
def pull_files(name):
	"""Attach files that someone put into the card's folder by hand."""
	frappe.get_doc("Sales Order", name).check_permission("write")
	if not active():
		frappe.throw("المجلدات غير مفعّلة أو القرص غير متصل.")
	from frappe.utils.file_manager import save_file

	path = card_path(name)
	have = {clean(f, 150) for f in frappe.get_all("File", filters={"attached_to_doctype": "Sales Order", "attached_to_name": name}, pluck="file_name")}
	added = 0
	frappe.flags.atelier_from_folder = True
	try:
		for fn in sorted(os.listdir(path)):
			full = os.path.join(path, fn)
			if fn in have or fn.startswith((".", "~$")) or not os.path.isfile(full) or os.path.getsize(full) > 200 * 1024 * 1024:
				continue
			with open(full, "rb") as fh:
				save_file(fn, fh.read(), "Sales Order", name, is_private=1)
			added += 1
	finally:
		frappe.flags.atelier_from_folder = False
	return {"added": added}
