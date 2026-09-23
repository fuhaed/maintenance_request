import frappe


def execute():
	page_name = "maintenance-dashboard"
	if not frappe.db.exists("Page", page_name):
		return

	page = frappe.get_doc("Page", page_name)
	page.set("roles", [])
	for role in ("System Manager", "Maintenance Manager", "Maintenance User"):
		page.append("roles", {"role": role})
	page.save(ignore_permissions=True)
