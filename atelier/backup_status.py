"""Where the last backup went: written by the computer's backup task (tools/dev/Backup-Nasaq.ps1) after
each run, read by the manager's morning summary. «drive» = copied off the computer; «local» = Google
Drive was not reachable, the copy waits on the computer."""

import json

import frappe
from frappe.utils import now_datetime, time_diff_in_hours

KEY = "atelier_backup_offsite"


def mark(result="drive"):
	s = status()
	s["last_run"] = str(now_datetime())
	s["result"] = "drive" if result == "drive" else "local"
	if s["result"] == "drive":
		s["last_offsite"] = s["last_run"]
	frappe.db.set_default(KEY, json.dumps(s))
	frappe.db.commit()
	return s


def status():
	try:
		return json.loads(frappe.db.get_default(KEY) or "{}") or {}
	except ValueError:
		return {}


def warning():
	"""A sentence for the morning summary, or None. Silent on sites where no backup task ever ran."""
	s = status()
	if not s.get("last_run"):
		return None
	last = s.get("last_offsite")
	hours = time_diff_in_hours(now_datetime(), last) if last else None
	if hours is not None and hours < 48:
		return None
	if not last:
		return "لم تصل أي نسخة احتياطية إلى Google Drive بعد — تأكد أن Google Drive متصل بالحاسوب"
	return "آخر نسخة احتياطية في Google Drive قبل {0} أيام — تأكد أن Google Drive متصل بالحاسوب".format(int(hours // 24))
