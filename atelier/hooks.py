app_name = "atelier"
app_title = "Atelier"
app_publisher = "Demo Atelier"
app_description = "Gestion atelier (ERPNext)"
app_email = "demo@example.test"
app_license = "gpl-3.0"

# Apps
# ------------------

required_apps = ["erpnext"]

# Each item in the list will be shown as an app in the apps page
# add_to_apps_screen = [
# 	{
# 		"name": "atelier",
# 		"logo": "/assets/atelier/logo.png",
# 		"title": "Atelier",
# 		"route": "/atelier",
# 		"has_permission": "atelier.api.permission.has_app_permission",
# 	}
# ]

# The dock, the rail down the left of the desk, is a document rather than a hook. Author it in
# Manage Dock on a developer-mode site and press Export to App, and it is written to
# `atelier/dock/atelier/atelier.json` for git to carry. An app that ships none has no
# rail: its sidebar gets a switcher in the header instead.
#
# A companion app, one that extends a host app rather than standing on its own, says so with
# `mount_on` on that same record, and its entries are appended to the host's rail. Mounting keeps
# the companion off the apps screen, so it takes precedence over any add_to_apps_screen above.

add_to_apps_screen = [
	{"name": "atelier", "logo": "/assets/atelier/atelier/icon.svg", "title": "الورشة", "route": "/atelier"}
]

# The daily app is a SPA under /atelier (www/atelier.html); deep links fall back to it.
website_route_rules = [{"from_route": "/atelier/<path:app_path>", "to_route": "atelier"}]

fixtures = [{"dt": "Custom Field", "filters": [["module", "=", "Atelier"]]}]

# Includes in <head>
# ------------------

# include js, css files in header of desk.html
# app_include_css = "/assets/atelier/css/atelier.css"
# app_include_js = "/assets/atelier/js/atelier.js"

# include js, css files in header of web template
# web_include_css = "/assets/atelier/css/atelier.css"
# web_include_js = "/assets/atelier/js/atelier.js"

# include custom scss in every website theme (without file extension ".scss")
# website_theme_scss = "atelier/public/scss/website"

# include js, css files in header of web form
# webform_include_js = {"doctype": "public/js/doctype.js"}
# webform_include_css = {"doctype": "public/css/doctype.css"}

# include js in page
# page_js = {"page" : "public/js/file.js"}

# include js in doctype views
# doctype_js = {"doctype" : "public/js/doctype.js"}
# doctype_list_js = {"doctype" : "public/js/doctype_list.js"}
# doctype_kanban_js = {"doctype" : "public/js/doctype_kanban.js"}
# doctype_tree_js = {"doctype" : "public/js/doctype_tree.js"}
# doctype_calendar_js = {"doctype" : "public/js/doctype_calendar.js"}

# Svg Icons
# ------------------
# include app icons in desk
# app_include_icons = "atelier/public/icons.svg"

# Home Pages
# ----------

# application home page (will override Website Settings)
# home_page = "login"

# website user home page (by Role)
# role_home_page = {
# 	"Role": "home_page"
# }

# Generators
# ----------

# automatically create page for each record of this doctype
# website_generators = ["Web Page"]

# automatically load and sync documents of this doctype from downstream apps
# importable_doctypes = [doctype_1]

# Jinja
# ----------

# Helpers for the Arabic print formats (templates/print/atelier_doc.html)
jinja = {"methods": ["atelier.printing.print_context", "atelier.printing.tafqit", "atelier.printing.dz_money", "atelier.printing.dz_qty"]}

# add methods and filters to jinja environment
# jinja = {
# 	"methods": "atelier.utils.jinja_methods",
# 	"filters": "atelier.utils.jinja_filters"
# }

# Installation
# ------------

# before_install = "atelier.install.before_install"
after_install = "atelier.install.after_install"
after_migrate = "atelier.install.after_migrate"
setup_wizard_complete = "atelier.install.after_setup"

# Uninstallation
# ------------

# before_uninstall = "atelier.uninstall.before_uninstall"
# after_uninstall = "atelier.uninstall.after_uninstall"

# Integration Setup
# ------------------
# To set up dependencies/integrations with other apps
# Name of the app being installed is passed as an argument

# before_app_install = "atelier.utils.before_app_install"
# after_app_install = "atelier.utils.after_app_install"

# Integration Cleanup
# -------------------
# To clean up dependencies/integrations with other apps
# Name of the app being uninstalled is passed as an argument

# before_app_uninstall = "atelier.utils.before_app_uninstall"
# after_app_uninstall = "atelier.utils.after_app_uninstall"

# Build
# ------------------
# To hook into the build process

# after_build = "atelier.build.after_build"

# To hook into the build process of other apps
# The list of apps being built is passed as an argument

# after_app_build = "atelier.build.after_app_build"

# Desk Notifications
# ------------------
# See frappe.core.notifications.get_notification_config

# notification_config = "atelier.notifications.get_notification_config"

# Awesome Bar
# -----------
# Extra search results: list of dicts with label, description, route, index.
# route: ["List", "ToDo"], "/desk/docs/some/page", or "https://example.com"
# awesomebar_search = ["atelier.search.awesomebar_results"]

# Permissions
# -----------
# Permissions evaluated in scripted ways

# permission_query_conditions = {
# 	"Event": "frappe.desk.doctype.event.event.get_permission_query_conditions",
# }
#
# has_permission = {
# 	"Event": "frappe.desk.doctype.event.event.has_permission",
# }

# Document Events
# ---------------
# Hook on document methods and events

doc_events = {
	"Customer": {"on_update": "atelier.folders.on_customer"},
	"Sales Order": {"on_update": "atelier.folders.on_card", "on_update_after_submit": "atelier.folders.on_card"},
	"File": {"after_insert": "atelier.folders.on_file"},
}

# doc_events = {
# 	"*": {
# 		"on_update": "method",
# 		"on_cancel": "method",
# 		"on_trash": "method"
# 	}
# }

# Scheduled Tasks
# every night: the books checked against what the app shows; the manager is alerted on any difference
scheduler_events = {"daily": ["atelier.books_check.nightly"]}

# ---------------

# scheduler_events = {
# 	"all": [
# 		"atelier.tasks.all"
# 	],
# 	"daily": [
# 		"atelier.tasks.daily"
# 	],
# 	"hourly": [
# 		"atelier.tasks.hourly"
# 	],
# 	"weekly": [
# 		"atelier.tasks.weekly"
# 	],
# 	"monthly": [
# 		"atelier.tasks.monthly"
# 	],
# }

# Testing
# -------

# before_tests = "atelier.install.before_tests"

# Extend DocType Class
# ------------------------------
#
# Specify custom mixins to extend the standard doctype controller.
# extend_doctype_class = {
# 	"Task": "atelier.custom.task.CustomTaskMixin"
# }
extend_doctype_class = {
	"Sales Order": [
		"atelier.delivery_dates.OptionalDeliveryDateMixin",
		"atelier.order_pricing.PendingPriceMixin",
	],
}

# Overriding Methods
# ------------------------------
#
# override_whitelisted_methods = {
# 	"frappe.desk.doctype.event.event.get_events": "atelier.event.get_events"
# }
#
# each overriding function accepts a `data` argument;
# generated from the base implementation of the doctype dashboard,
# along with any modifications made in other Frappe apps
# override_doctype_dashboards = {
# 	"Task": "atelier.task.get_dashboard_data"
# }

# exempt linked doctypes from being automatically cancelled
#
# auto_cancel_exempted_doctypes = ["Auto Repeat"]

# Ignore links to specified DocTypes when deleting documents
# -----------------------------------------------------------

# ignore_links_on_delete = ["Communication", "ToDo"]

# Request Events
# ----------------
# before_request = ["atelier.utils.before_request"]
# after_request = ["atelier.utils.after_request"]

# Job Events
# ----------
# before_job = ["atelier.utils.before_job"]
# after_job = ["atelier.utils.after_job"]

# User Data Protection
# --------------------

# user_data_fields = [
# 	{
# 		"doctype": "{doctype_1}",
# 		"filter_by": "{filter_by}",
# 		"redact_fields": ["{field_1}", "{field_2}"],
# 		"partial": 1,
# 	},
# 	{
# 		"doctype": "{doctype_2}",
# 		"filter_by": "{filter_by}",
# 		"partial": 1,
# 	},
# 	{
# 		"doctype": "{doctype_3}",
# 		"strict": False,
# 	},
# 	{
# 		"doctype": "{doctype_4}"
# 	}
# ]

# Authentication and authorization
# --------------------------------

# auth_hooks = [
# 	"atelier.auth.validate"
# ]

# Automatically update python controller files with type annotations for this app.
# export_python_type_annotations = True

# default_log_clearing_doctypes = {
# 	"Logging DocType Name": 30  # days to retain logs
# }

# Translation
# ------------
# List of apps whose translatable strings should be excluded from this app's translations.
# ignore_translatable_strings_from = []

