import frappe


def execute():
	# The old app accidentally overrode ERPNext's standard Brand DocType.
	# Preserve existing values, then reload ERPNext Brand metadata.
	brand_values = set()
	if frappe.db.table_exists("Brand"):
		columns = frappe.db.get_table_columns("Brand")
		select_cols = []
		for col in ("brand_name", "brand", "name"):
			if col in columns:
				select_cols.append(col)

		if select_cols:
			rows = frappe.db.sql(
				f"select {', '.join(select_cols)} from `tabBrand`",
				as_dict=True,
			)
			for row in rows:
				value = row.get("brand_name") or row.get("brand") or row.get("name")
				if value:
					brand_values.add(value)

		if "brand" in columns and "brand_name" in columns:
			frappe.db.sql(
				"""
				update `tabBrand`
				set brand = brand_name
				where (brand is null or brand = '')
					and brand_name is not null
					and brand_name != ''
				"""
			)

	try:
		frappe.reload_doc("setup", "doctype", "brand", force=True)
	except Exception:
		frappe.log_error(
			title="Maintenance Request Brand Restore Failed",
			message=frappe.get_traceback(),
		)

	if not frappe.db.exists("DocType", "Maintenance Device Brand"):
		return

	for value in sorted(brand_values):
		if not frappe.db.exists("Maintenance Device Brand", value):
			doc = frappe.new_doc("Maintenance Device Brand")
			doc.brand_name = value
			doc.insert(ignore_permissions=True)
