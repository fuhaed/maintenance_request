import frappe


def execute():
	if not frappe.db.table_exists("Maintenance Request"):
		return

	frappe.db.sql(
		"""
		update `tabMaintenance Request`
		set inspection_decision = 'Not Repairable'
		where status = 'Not Repairable'
			and (inspection_decision is null or inspection_decision != 'Not Repairable')
		"""
	)
