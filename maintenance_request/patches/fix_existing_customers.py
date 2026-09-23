import frappe

def execute():
	# 1. Find all Customers who do not have a customer_primary_contact set
	customers = frappe.get_all(
		"Customer",
		filters={"customer_primary_contact": ["is", "not set"]},
		fields=["name"]
	)
	
	for customer in customers:
		# 2. Find if there is any Contact linked to this customer
		contacts = frappe.db.sql(
			"""
			SELECT parent 
			FROM `tabDynamic Link` 
			WHERE parenttype = 'Contact' 
			  AND link_doctype = 'Customer' 
			  AND link_name = %s
			""",
			customer.name,
			as_dict=True
		)
		
		if not contacts:
			continue
			
		# We take the first linked contact
		contact_name = contacts[0].parent
		
		# 3. Get primary phone number from this contact
		contact_doc = frappe.get_doc("Contact", contact_name)
		phone_number = contact_doc.mobile_no
		
		if not phone_number and contact_doc.phone_nos:
			for p in contact_doc.phone_nos:
				if p.is_primary_mobile_no or p.is_primary_phone:
					phone_number = p.phone
					break
			if not phone_number:
				phone_number = contact_doc.phone_nos[0].phone
				
		# 4. Update the Customer record
		frappe.db.set_value(
			"Customer", 
			customer.name, 
			{
				"customer_primary_contact": contact_name,
				"mobile_no": phone_number
			}, 
			update_modified=False
		)
