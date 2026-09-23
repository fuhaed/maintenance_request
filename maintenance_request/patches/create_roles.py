import frappe


def execute():
	for role in ("Maintenance Manager", "Maintenance User"):
		if not frappe.db.exists("Role", role):
			doc = frappe.new_doc("Role")
			doc.role_name = role
			doc.desk_access = 1
			doc.insert(ignore_permissions=True)
