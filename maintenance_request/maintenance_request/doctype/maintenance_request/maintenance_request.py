# Copyright (c) 2025, HIGH SPEED IT and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import add_days, today, flt, getdate


# ── Status Flow ─────────────────────────────────────────────────────
ALLOWED_TRANSITIONS = {
	"Pending": ["In Progress"],
	"In Progress": ["Completed", "Not Repairable"],
	"Completed": ["Ready for Delivery"],
	"Not Repairable": ["Ready for Delivery"],
	"Ready for Delivery": ["Delivered"],
}

class MaintenanceRequest(Document):
	def before_save(self):
		self._auto_set_receivers()
		self.calculate_totals()
		self.calculate_warranty_end_date()
		self._sync_status_with_inspection()

	def validate(self):
		self.validate_status_transition()
		self.validate_stage_requirements()
		self.validate_invoice_lock()
		self.calculate_totals()
		self.calculate_warranty_end_date()

	def validate_status_transition(self):
		"""Ensure status changes follow the allowed flow."""
		if self.is_new():
			return

		old_doc = self.get_doc_before_save()
		if not old_doc:
			return

		old_status = old_doc.status
		new_status = self.status

		if old_status == new_status:
			return

		allowed = ALLOWED_TRANSITIONS.get(old_status, [])
		if new_status not in allowed:
			frappe.throw(
				_("Cannot change status from '{0}' to '{1}'. Allowed: {2}").format(
					old_status, new_status, ", ".join(allowed) if allowed else _("None")
				)
			)

	def validate_stage_requirements(self):
		"""Validate required fields before allowing status transition."""
		if self.is_new():
			return

		old_doc = self.get_doc_before_save()
		if not old_doc:
			return

		old_status = old_doc.status
		new_status = self.status

		if old_status == new_status:
			return

		if new_status == "In Progress":
			if not self.inspection_decision:
				frappe.throw(_("Inspection Decision is required before moving to In Progress"))
			if not self.technician:
				frappe.throw(_("Technician is required before moving to In Progress"))
			if self.inspection_decision == "Repairable" and not self.diagnosis:
				frappe.throw(_("Diagnosis is required when device is Repairable"))
			if self.inspection_decision == "Not Repairable" and not self.not_repairable_reason:
				frappe.throw(_("Reason is required when device is Not Repairable"))

		if new_status == "Delivered":
			if not self.actual_delivery_date:
				frappe.throw(_("Actual Delivery Date is required before marking as Delivered"))
			if not self.delivery_receiver:
				frappe.throw(_("Delivery Receiver is required before marking as Delivered"))

	def _sync_status_with_inspection(self):
		"""Auto-sync status when inspection_decision changes."""
		if self.is_new():
			return

		old_doc = self.get_doc_before_save()
		if not old_doc:
			return

		if old_doc.inspection_decision != self.inspection_decision:
			if self.inspection_decision == "Not Repairable" and self.status == "In Progress":
				self.status = "Not Repairable"
			elif (
				self.inspection_decision == "Repairable"
				and old_doc.status == "Not Repairable"
				and self.status == "Not Repairable"
			):
				self.status = "In Progress"

	def _auto_set_receivers(self):
		"""Auto-set intake_receiver and delivery_receiver to current user."""
		user_fullname = frappe.utils.get_fullname(frappe.session.user)

		# Auto-set intake_receiver on creation
		if self.is_new() and not self.intake_receiver:
			self.intake_receiver = user_fullname

		# Auto-set delivery_receiver when transitioning to Delivered
		if not self.is_new():
			old_doc = self.get_doc_before_save()
			if old_doc and old_doc.status != "Delivered" and self.status == "Delivered":
				if not self.delivery_receiver:
					self.delivery_receiver = user_fullname
				if not self.actual_delivery_date:
					self.actual_delivery_date = today()

	def validate_invoice_lock(self):
		"""Prevent editing if a sales invoice has been created."""
		if not self.is_new() and self.sales_invoice:
			old_doc = self.get_doc_before_save()
			if old_doc and old_doc.sales_invoice:
				allowed_fields = {
					"status", "actual_delivery_date", "delivery_receiver",
					"warranty_days", "warranty_end_date",
				}
				for field in self.meta.get("fields"):
					fn = field.fieldname
					if fn in allowed_fields or field.fieldtype in ("Section Break", "Column Break", "Tab Break"):
						continue
					if self.get(fn) != old_doc.get(fn):
						frappe.throw(
							_("Cannot modify this request because Sales Invoice {0} has been issued. Cancel the invoice first.").format(
								f'<a href="/app/sales-invoice/{self.sales_invoice}">{self.sales_invoice}</a>'
							)
						)

	def calculate_totals(self):
		"""Calculate total amount from services table."""
		self.total_amount = 0
		if self.services:
			for service in self.services:
				service.amount = flt(service.qty) * flt(service.rate)
				self.total_amount += flt(service.amount)

		self.outstanding_amount = flt(self.total_amount) - flt(self.advance_paid)

	def calculate_warranty_end_date(self):
		"""Calculate warranty end date based on warranty days."""
		if self.warranty_days and self.actual_delivery_date:
			self.warranty_end_date = add_days(self.actual_delivery_date, self.warranty_days)
		elif self.warranty_days and not self.actual_delivery_date:
			self.warranty_end_date = None


@frappe.whitelist()
def get_user_branch():
	"""Get branch from current user's employee record."""
	user = frappe.session.user
	employee = frappe.db.get_value("Employee", {"user_id": user}, "branch")
	return employee if employee else None


@frappe.whitelist()
def get_customer_contact_info(customer):
	"""Get primary phone numbers from customer's contact."""
	if not customer:
		return {}

	result = {"phone": "", "secondary_phone": ""}

	contact_name = frappe.db.get_value(
		"Dynamic Link",
		{"link_doctype": "Customer", "link_name": customer, "parenttype": "Contact"},
		"parent"
	)

	if contact_name:
		phones = frappe.get_all(
			"Contact Phone",
			filters={"parent": contact_name},
			fields=["phone", "is_primary_mobile_no"],
			order_by="is_primary_mobile_no desc"
		)
		for i, p in enumerate(phones):
			if i == 0:
				result["phone"] = p.phone
			elif i == 1:
				result["secondary_phone"] = p.phone

	if not result["phone"] and contact_name:
		try:
			contact_doc = frappe.db.get_value(
				"Contact", contact_name,
				["mobile_no", "phone"],
				as_dict=True
			)
			if contact_doc:
				result["phone"] = contact_doc.get("mobile_no") or contact_doc.get("phone") or ""
		except Exception as e:
			frappe.log_error(f"Failed to fetch contact info for {customer}: {e}")

	if not result["phone"]:
		try:
			customer_meta = frappe.get_meta("Customer")
			available_fields = []
			for field_name in ["mobile_no", "phone"]:
				if customer_meta.has_field(field_name):
					available_fields.append(field_name)

			if available_fields:
				customer_doc = frappe.db.get_value(
					"Customer", customer, available_fields, as_dict=True
				)
				if customer_doc:
					for field_name in available_fields:
						if customer_doc.get(field_name):
							result["phone"] = customer_doc.get(field_name)
							break
		except Exception as e:
			frappe.log_error(f"Failed to fetch customer phone for {customer}: {e}")

	return result


@frappe.whitelist()
def get_customer_list(doctype, txt, searchfield, start, page_len, filters):
	"""Custom search for Customer: by name, ID, or phone number from Contact."""
	txt = txt or ""
	escaped = txt.replace("%", "\\%").replace("_", "\\_")
	like_txt = f"%{escaped}%"

	# Search by customer name and ID
	customers = frappe.db.sql("""
		SELECT c.name, c.customer_name
		FROM `tabCustomer` c
		WHERE (c.name LIKE %(txt)s OR c.customer_name LIKE %(txt)s)
			AND c.disabled = 0
		ORDER BY c.customer_name ASC
		LIMIT %(start)s, %(page_len)s
	""", {"txt": like_txt, "start": int(start), "page_len": int(page_len)}, as_list=True)

	# Also search by phone from Contact Phone table
	phone_matches = frappe.db.sql("""
		SELECT DISTINCT dl.link_name, cust.customer_name
		FROM `tabContact Phone` cp
		JOIN `tabContact` ct ON ct.name = cp.parent
		JOIN `tabDynamic Link` dl ON dl.parent = ct.name
			AND dl.link_doctype = 'Customer'
		JOIN `tabCustomer` cust ON cust.name = dl.link_name
			AND cust.disabled = 0
		WHERE cp.phone LIKE %(txt)s
		LIMIT %(page_len)s
	""", {"txt": like_txt, "page_len": int(page_len)}, as_list=True)

	# Merge results, removing duplicates
	seen = set()
	result = []
	for row in customers + phone_matches:
		if row[0] not in seen:
			seen.add(row[0])
			result.append(row)

	return result[:int(page_len)]


@frappe.whitelist()
def get_brand_options():
	"""Return list of brand names for the Brand Select field."""
	brands = frappe.get_all("Brand", fields=["brand_name"], order_by="brand_name asc", limit_page_length=0)
	return [b.brand_name for b in brands]


@frappe.whitelist()
def create_customer_quick(customer_name, customer_type="Individual", phone_number=None, company=None):
	"""Quick create customer from dashboard — phone number is mandatory."""
	if not phone_number:
		frappe.throw(_("Phone number is mandatory when creating a customer"))

	existing = frappe.db.get_value("Customer", {"customer_name": customer_name}, "name")
	if existing:
		frappe.throw(_("Customer with name '{0}' already exists").format(customer_name))

	customer = frappe.new_doc("Customer")
	customer.customer_name = customer_name
	customer.customer_type = customer_type
	customer.customer_group = (
		frappe.db.get_single_value("Selling Settings", "customer_group")
		or "All Customer Groups"
	)
	customer.territory = (
		frappe.db.get_single_value("Selling Settings", "territory")
		or "All Territories"
	)
	if company:
		customer.company = company
	customer.insert(ignore_permissions=True)

	contact = frappe.new_doc("Contact")
	contact.first_name = customer_name
	contact.append("phone_nos", {
		"phone": phone_number,
		"is_primary_mobile_no": 1
	})
	contact.append("links", {
		"link_doctype": "Customer",
		"link_name": customer.name
	})
	contact.insert(ignore_permissions=True)

	frappe.db.commit()

	return {
		"name": customer.name,
		"customer_name": customer.customer_name
	}


@frappe.whitelist()
def create_sales_invoice(maintenance_request):
	"""Create Sales Invoice from Maintenance Request."""
	mr = frappe.get_doc("Maintenance Request", maintenance_request)

	if mr.sales_invoice:
		frappe.throw(_("Sales Invoice already exists for this Maintenance Request"))

	if not mr.services or len(mr.services) == 0:
		frappe.throw(_("Please add services before creating invoice"))

	if not mr.customer:
		frappe.throw(_("Please set a customer before creating invoice"))

	si = frappe.new_doc("Sales Invoice")
	si.customer = mr.customer
	si.company = mr.company
	due_date = getdate(mr.expected_delivery_date) if mr.expected_delivery_date else getdate(today())
	if due_date < getdate(today()):
		due_date = getdate(today())
	si.due_date = due_date

	default_tax = frappe.db.get_value(
		"Sales Taxes and Charges Template",
		{"company": mr.company, "is_default": 1},
		"name"
	)
	if default_tax:
		si.taxes_and_charges = default_tax

	for service in mr.services:
		si.append("items", {
			"item_code": service.service_item,
			"item_name": service.description,
			"qty": service.qty,
			"rate": service.rate,
			"amount": service.amount
		})

	si.set_missing_values()
	si.insert()

	mr.db_set("sales_invoice", si.name)

	return si.name
