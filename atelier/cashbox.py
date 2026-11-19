"""Seller cash boxes: cash a seller collects goes to their own box until the manager confirms the handover.

- each seller gets one Cash account («صندوق <name>») created on first use, next to the company cash account;
- only cash collections go there: CCP and bank go straight to their accounts;
- «سلّمت الصندوق» records a pending handover (what the books say and what the seller counted);
- the manager confirms (money moves to the main cash, any difference is booked under the seller's name) or refuses.
Pending handovers are kept in a default (a small list), the money only moves on confirmation."""

import json

import frappe
from frappe import _
from frappe.utils import flt, nowdate, now_datetime, get_fullname

KEY = "atelier_handovers"


def _company():
	from atelier.api import _company

	return _company()


def _list():
	try:
		return json.loads(frappe.db.get_default(KEY) or "[]")
	except ValueError:
		return []


def _save(rows):
	frappe.db.set_default(KEY, json.dumps(rows[:300], ensure_ascii=False))


def _balance(account):
	return flt(frappe.db.sql("select sum(debit - credit) from `tabGL Entry` where is_cancelled=0 and account=%s", account)[0][0])


def box_of(user, create=False):
	"""The seller's cash account, or None."""
	acc = frappe.db.get_default("atelier_box", parent=user)
	if acc and frappe.db.exists("Account", acc):
		return acc
	if not create:
		return None
	company = _company()
	main = frappe.get_cached_value("Company", company, "default_cash_account")
	parent = frappe.db.get_value("Account", main, "parent_account") if main else None
	if not parent:
		parent = frappe.db.get_value("Account", {"company": company, "account_type": "Cash", "is_group": 1}) or \
			frappe.db.get_value("Account", {"company": company, "root_type": "Asset", "is_group": 1, "parent_account": ["is", "set"]})
	# the box belongs to the user id: two sellers with the same display name never share one
	name = (_("صندوق") + " " + (get_fullname(user) or user))[:100]
	if frappe.db.exists("Account", {"company": company, "account_name": name}):
		name = f"{name} ({user})"[:140]
	existing = frappe.db.get_value("Account", {"company": company, "account_name": name, "is_group": 0})
	if existing and not frappe.db.sql("select 1 from `tabDefaultValue` where defkey='atelier_box' and defvalue=%s and parent!=%s", (existing, user)):
		acc = existing
	else:
		doc = frappe.get_doc({"doctype": "Account", "company": company, "account_name": name, "parent_account": parent,
			"account_type": "Cash", "is_group": 0, "root_type": "Asset"})
		doc.flags.ignore_permissions = True
		doc.insert()
		acc = doc.name
	frappe.db.set_default("atelier_box", acc, parent=user)
	return acc


def all_boxes():
	return [r[0] for r in frappe.db.sql("select defvalue from `tabDefaultValue` where defkey='atelier_box'") if r[0] and frappe.db.exists("Account", r[0])]


def cash_to(user):
	"""Where a seller's cash collection goes: their box (sellers only; the manager collects into the main cash)."""
	from atelier.simple import app_role

	return box_of(user, create=True) if app_role(user) == "sales" else None


def main_cash():
	from atelier.api import all_modes, _cash_account

	company = _company()
	for v, _l in all_modes():
		a = _cash_account(v, company)
		if a and frappe.db.get_value("Account", a, "account_type") == "Cash" and a not in all_boxes():
			return a
	return frappe.get_cached_value("Company", company, "default_cash_account")


def _since(user):
	last = next((h for h in _list() if h["user"] == user and h["status"] == "done"), None)
	return last["at"] if last else None


def _collections(acc, since=None, limit=50):
	cond, args = "", [acc]
	if since:
		cond, args = " and pe.creation > %s", [acc, since]
	return frappe.db.sql(f"""select pe.name, pe.posting_date, pe.party_name, pe.paid_amount, pe.atelier_order as orders,
		(select reference_name from `tabPayment Entry Reference` r where r.parent=pe.name limit 1) as ref
		from `tabPayment Entry` pe where pe.docstatus=1 and pe.payment_type='Receive' and pe.paid_to=%s{cond}
		order by pe.creation desc limit {int(limit)}""", args, as_dict=True) if frappe.db.has_column("Payment Entry", "atelier_order") else \
		frappe.db.sql(f"""select pe.name, pe.posting_date, pe.party_name, pe.paid_amount from `tabPayment Entry` pe
		where pe.docstatus=1 and pe.payment_type='Receive' and pe.paid_to=%s{cond} order by pe.creation desc limit {int(limit)}""", args, as_dict=True)


@frappe.whitelist()
def my_box():
	user = frappe.session.user
	acc = box_of(user)
	pending = next((h for h in _list() if h["user"] == user and h["status"] == "pending"), None)
	since = _since(user)
	return {"account": acc, "name": get_fullname(user), "balance": _balance(acc) if acc else 0, "since": since, "pending": pending,
		"collections": _collections(acc, since) if acc else []}


@frappe.whitelist(methods=["POST"])
def hand_over(counted, reason=None):
	user = frappe.session.user
	acc = box_of(user)
	if not acc:
		frappe.throw(_("لا يوجد صندوق باسمك بعد"))
	rows = _list()
	if any(h["user"] == user and h["status"] == "pending" for h in rows):
		frappe.throw(_("لديك تسليم بانتظار تأكيد المدير"))
	recorded, counted = round(_balance(acc), 2), round(flt(counted), 2)
	if recorded <= 0 and counted <= 0:
		frappe.throw(_("الصندوق فارغ"))
	if counted < 0:
		frappe.throw(_("المبلغ غير صحيح"))
	row = {"id": frappe.generate_hash(length=10), "user": user, "name": get_fullname(user), "account": acc, "at": str(now_datetime())[:19],
		"recorded": recorded, "counted": counted, "diff": round(counted - recorded, 2), "reason": (reason or "").strip()[:200],
		"count": len(_collections(acc, _since(user), 500)), "status": "pending"}
	_save([row] + rows)
	return row


@frappe.whitelist()
def boxes():
	from atelier.simple import _manager_only

	_manager_only()
	pend = [h for h in _list() if h["status"] == "pending"]
	out = [{"account": a, "label": frappe.db.get_value("Account", a, "account_name"), "balance": _balance(a),
		"pending": next((h["id"] for h in pend if h["account"] == a), None)} for a in all_boxes()]
	return {"pending": pend, "boxes": out, "main": main_cash(), "recent": [h for h in _list() if h["status"] != "pending"][:10]}


def _find(id):
	rows = _list()
	h = next((x for x in rows if x["id"] == id and x["status"] == "pending"), None)
	if not h:
		frappe.throw(_("هذا التسليم لم يعد بانتظار التأكيد"))
	return rows, h


@frappe.whitelist(methods=["POST"])
def confirm_handover(id):
	"""Recorded amount leaves the seller's box; the counted amount enters the main cash; the gap is booked
	(round-off account, like the end-of-day closing) with the seller's name in the remark."""
	from atelier.simple import _manager_only

	_manager_only()
	rows, h = _find(id)
	company = _company()
	main = main_cash()
	if not main or main == h["account"]:
		frappe.throw(_("لا يوجد صندوق رئيسي نقدي"))
	recorded, counted, diff = flt(h["recorded"]), flt(h["counted"]), flt(h["diff"])
	cc = frappe.get_cached_value("Company", company, "cost_center")
	lines = []
	if counted > 0:
		lines.append({"account": main, "debit_in_account_currency": counted, "cost_center": cc})
	if recorded > 0:
		lines.append({"account": h["account"], "credit_in_account_currency": recorded, "cost_center": cc})
	elif recorded < 0:
		lines.append({"account": h["account"], "debit_in_account_currency": -recorded, "cost_center": cc})
	if abs(diff) >= 0.01:
		off, occ = frappe.get_cached_value("Company", company, ["round_off_account", "round_off_cost_center"])
		if not off:
			frappe.throw(_("لا يوجد حساب فروق التقريب في إعدادات الشركة"))
		lines.append({"account": off, "cost_center": occ or cc, "debit_in_account_currency": -diff if diff < 0 else 0,
			"credit_in_account_currency": diff if diff > 0 else 0})
	je = frappe.get_doc({"doctype": "Journal Entry", "voucher_type": "Contra Entry", "company": company, "posting_date": nowdate(),
		"user_remark": _("تسليم صندوق") + " — " + h["name"] + ((" · " + _("فرق صندوق") + f" {diff:+.2f}" + (" — " + h["reason"] if h["reason"] else "")) if abs(diff) >= 0.01 else ""),
		"accounts": lines})
	je.insert(ignore_permissions=True)
	je.submit()
	h.update({"status": "done", "entry": je.name, "by": get_fullname(frappe.session.user), "done_at": str(now_datetime())[:19]})
	_save(rows)
	return h


@frappe.whitelist(methods=["POST"])
def reject_handover(id):
	from atelier.simple import _manager_only

	_manager_only()
	rows, h = _find(id)
	h.update({"status": "rejected", "by": get_fullname(frappe.session.user), "done_at": str(now_datetime())[:19]})
	_save(rows)
	return h
