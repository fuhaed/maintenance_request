import os
import frappe

def after_migrate():
	"""Ensure custom Print Format for Maintenance Receipt is seeded and editable (standard='No')."""
	sync_maintenance_receipt_print_format()

def sync_maintenance_receipt_print_format(force=False):
	html_path = os.path.join(
		os.path.dirname(__file__),
		"maintenance_request",
		"print_format",
		"maintenance_receipt",
		"maintenance_receipt.html"
	)

	html_content = ""
	if os.path.exists(html_path):
		with open(html_path, "r", encoding="utf-8") as f:
			html_content = f.read()

	if not frappe.db.exists("Print Format", "Maintenance Receipt"):
		pf = frappe.new_doc("Print Format")
		pf.name = "Maintenance Receipt"
		pf.doc_type = "Maintenance Request"
		pf.module = "Maintenance Request"
		pf.standard = "No"
		pf.custom_format = 1
		pf.print_format_type = "Jinja"
		pf.default_print_language = "ar"
		pf.html = html_content
		pf.insert(ignore_permissions=True)
		frappe.db.commit()
	else:
		# If it exists, ensure it is set to standard="No" and custom_format=1 so the user can edit it freely
		pf = frappe.get_doc("Print Format", "Maintenance Receipt")
		updated = False
		if pf.standard != "No":
			pf.standard = "No"
			updated = True
		if not pf.custom_format:
			pf.custom_format = 1
			updated = True
		if not pf.html or force:
			pf.html = html_content
			updated = True
		if updated:
			pf.flags.ignore_permissions = True
			pf.flags.ignore_validate = True
			pf.save()
			frappe.db.commit()
