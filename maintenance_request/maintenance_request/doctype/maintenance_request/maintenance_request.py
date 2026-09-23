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
MAINTENANCE_ROLES = {"Maintenance Manager", "Maintenance User", "System Manager"}
MAINTENANCE_MANAGER_ROLES = {"Maintenance Manager", "System Manager"}


def _has_maintenance_role():
	return bool(MAINTENANCE_ROLES.intersection(set(frappe.get_roles(frappe.session.user))))


def _is_maintenance_manager():
	return bool(MAINTENANCE_MANAGER_ROLES.intersection(set(frappe.get_roles(frappe.session.user))))

class MaintenanceRequest(Document):
	def before_save(self):
		self._auto_set_receivers()
		self.calculate_totals()
		self.calculate_warranty_end_date()

	def on_update(self):
		old_doc = self.get_doc_before_save()
		old_status = old_doc.status if old_doc else None
		if not old_status or old_status != self.status:
			self._try_send_auto_whatsapp(old_status, self.status)

	def _try_send_auto_whatsapp(self, old_status, new_status):
		try:
			send_status_whatsapp_notification(self, old_status, new_status)
		except Exception as e:
			frappe.log_error(title=f"Maintenance WhatsApp Error ({self.name})", message=str(e))

	def validate(self):
		self._sync_status_with_inspection()
		self.validate_new_request_status()
		self.validate_status_transition()
		self.validate_stage_requirements()
		self.validate_not_repairable_lock()
		self.validate_invoice_lock()
		self.validate_amounts()
		self.calculate_totals()
		self.calculate_warranty_end_date()

	def validate_new_request_status(self):
		"""New requests must start at intake."""
		if self.is_new() and self.status != "Pending":
			frappe.throw(_("New Maintenance Requests must start with Pending status"))

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

	def validate_not_repairable_lock(self):
		"""Only managers can modify requests after they are marked Not Repairable."""
		if self.is_new() or _is_maintenance_manager():
			return

		old_doc = self.get_doc_before_save()
		if old_doc and old_doc.status == "Not Repairable":
			frappe.throw(
				_("This request is locked because it is Not Repairable. Only a maintenance manager can edit it."),
				frappe.PermissionError,
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

	def validate_amounts(self):
		"""Reject negative quantities, rates, and payments."""
		if flt(self.estimated_cost) < 0:
			frappe.throw(_("Estimated Cost cannot be negative"))
		if flt(self.advance_paid) < 0:
			frappe.throw(_("Advance Paid cannot be negative"))
		if flt(self.warranty_days) < 0:
			frappe.throw(_("Warranty Days cannot be negative"))
		for row in self.services or []:
			if flt(row.qty) <= 0:
				frappe.throw(_("Service row {0}: Qty must be greater than zero").format(row.idx))
			if flt(row.rate) < 0:
				frappe.throw(_("Service row {0}: Rate cannot be negative").format(row.idx))


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
	"""Return list of device brand names."""
	brands = frappe.get_all(
		"Maintenance Device Brand",
		fields=["brand_name"],
		order_by="brand_name asc",
		limit_page_length=0,
	)
	return [b.brand_name for b in brands]


@frappe.whitelist()
def create_customer_quick(customer_name, customer_type="Individual", phone_number=None, company=None):
	"""Quick create customer from dashboard — phone number is mandatory."""
	if not _has_maintenance_role():
		frappe.throw(_("Not permitted"), frappe.PermissionError)
	if not frappe.has_permission("Customer", "create"):
		frappe.throw(_("Not permitted to create Customer"), frappe.PermissionError)
	if not frappe.has_permission("Contact", "create"):
		frappe.throw(_("Not permitted to create Contact"), frappe.PermissionError)

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
	customer.insert()

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
	contact.insert()

	customer.db_set("customer_primary_contact", contact.name)
	customer.db_set("mobile_no", phone_number)

	frappe.db.commit()

	return {
		"name": customer.name,
		"customer_name": customer.customer_name
	}


@frappe.whitelist()
def create_sales_invoice(maintenance_request):
	"""Create Sales Invoice from Maintenance Request."""
	if not _has_maintenance_role():
		frappe.throw(_("Not permitted"), frappe.PermissionError)
	if not frappe.has_permission("Sales Invoice", "create"):
		frappe.throw(_("Not permitted to create Sales Invoice"), frappe.PermissionError)

	mr = frappe.get_doc("Maintenance Request", maintenance_request)
	mr.check_permission("write")

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


# ── WhatsApp Notification Helpers ─────────────────────────────────────

def clean_phone_for_whatsapp(phone):
	"""Clean and normalize phone number for WhatsApp (Saudi/International)."""
	if not phone:
		return ""
	digits = "".join([c for c in str(phone) if c.isdigit()])
	if not digits:
		return ""
	# Saudi numbers: 05XXXXXXXX -> 9665XXXXXXXX
	if digits.startswith("05") and len(digits) == 10:
		return "966" + digits[1:]
	if digits.startswith("5") and len(digits) == 9:
		return "966" + digits
	if digits.startswith("00"):
		return digits[2:]
	return digits


def build_whatsapp_message(doc, status=None):
	"""Build contextual Arabic message for customer based on request status."""
	if isinstance(doc, str):
		doc = frappe.get_doc("Maintenance Request", doc)

	cur_status = status or doc.status
	customer_name = doc.customer_name or frappe.db.get_value("Customer", doc.customer, "customer_name") or doc.customer or "العميل الكريم"
	device_info = f"{doc.device_type or ''} {doc.brand or ''} {doc.model or ''}".strip() or "الجهاز"
	company_name = doc.company or frappe.defaults.get_user_default("company") or "مركز الصيانة"

	if cur_status == "Pending":
		return (
			f"مرحباً بك {customer_name} 🌸\n"
			f"تم استلام جهازكم بنجاح في *{company_name}*.\n\n"
			f"📋 *رقم طلب الصيانة:* {doc.name}\n"
			f"📱 *الجهاز:* {device_info}\n"
			f"⚙️ *المشكلة المسجلة:* {doc.problem_description or 'فحص وصيانة'}\n"
			f"📅 *تاريخ الاستلام:* {doc.received_date or today()}\n\n"
			f"سيتم إشعاركم فور الانتهاء من الفحص أو الصيانة. شكراً لثقتكم بنا! ✨"
		)
	elif cur_status == "In Progress":
		cost_info = f"\n💰 *التكلفة المقدرة:* {flt(doc.estimated_cost):,.2f} SAR" if flt(doc.estimated_cost) > 0 else ""
		diag = f"\n🔍 *التشخيص:* {doc.diagnosis}" if doc.diagnosis else ""
		return (
			f"مرحباً {customer_name} 🌸\n"
			f"إشعار من *{company_name}* بخصوص طلب الصيانة رقم *{doc.name}*.\n"
			f"الجهاز الآن *قيد التنفيذ / الصيانة* 🛠️\n"
			f"📱 *الجهاز:* {device_info}{diag}{cost_info}\n\n"
			f"سنوافيكم بتأكيد الجاهزية فور اكتمال العمل. شكراً لصبركم!"
		)
	elif cur_status == "Ready for Delivery":
		outstanding = flt(doc.outstanding_amount)
		pay_text = f"💰 *المبلغ المتبقي للسداد:* {outstanding:,.2f} SAR\n" if outstanding > 0 else "✅ *الحساب مدفوع بالكامل.*\n"
		return (
			f"مرحباً {customer_name} 🎉\n"
			f"يسرنا إبلاغكم بأن جهازكم *جاهز للاستلام* في *{company_name}*!\n\n"
			f"📋 *رقم الطلب:* {doc.name}\n"
			f"📱 *الجهاز:* {device_info}\n"
			f"{pay_text}\n"
			f"نتشرف بزيارتكم في الفرع لاستلام الجهاز. أهلاً وسهلاً بكم! 🌸"
		)
	elif cur_status == "Delivered":
		w_text = f"\n🛡️ *فترة الضمان:* {doc.warranty_days} يوم (حتى {doc.warranty_end_date})" if doc.warranty_days else ""
		return (
			f"مرحباً {customer_name} 🌸\n"
			f"تم تسليم جهازكم بنجاح (طلب رقم: *{doc.name}*).\n"
			f"📱 *الجهاز:* {device_info}{w_text}\n\n"
			f"سعدنا بخدمتكم في *{company_name}* ونتمنى لكم تجربة ممتازة! ✨"
		)
	elif cur_status == "Not Repairable":
		reason = f"\n⚠️ *السبب:* {doc.not_repairable_reason}" if doc.not_repairable_reason else ""
		return (
			f"مرحباً {customer_name}\n"
			f"إفادة بخصوص طلب الصيانة رقم *{doc.name}* (جهاز: {device_info}).\n"
			f"بعد الفحص الفني، تعذر إتمام الإصلاح.{reason}\n\n"
			f"يرجى مراجعة الفرع لاستلام جهازكم. نعتذر لعدم تمكننا من خدمتكم هذه المرة."
		)
	else:
		return (
			f"مرحباً {customer_name}\n"
			f"تحديث بخصوص طلب الصيانة رقم *{doc.name}* ({device_info}):\n"
			f"الحالة الحالية: *{cur_status}*.\n"
			f"*{company_name}*"
		)


def send_status_whatsapp_notification(doc, old_status, new_status):
	"""Attempt sending automated WhatsApp via frappe_whatsapp safely."""
	# Only notify on meaningful transitions
	if new_status not in ["Pending", "In Progress", "Ready for Delivery", "Delivered", "Not Repairable"]:
		return

	phone = doc.phone_number
	if not phone and doc.customer:
		c_info = get_customer_contact_info(doc.customer)
		phone = c_info.get("phone")

	clean_phone = clean_phone_for_whatsapp(phone)
	if not clean_phone:
		return

	# Check if frappe_whatsapp app is installed and configured
	if "frappe_whatsapp" not in frappe.get_installed_apps():
		return

	# Check for active WhatsApp account
	try:
		if not frappe.db.table_exists("WhatsApp Account"):
			return

		accounts = frappe.get_all(
			"WhatsApp Account",
			filters={"status": "Active"},
			limit=1
		)
		if not accounts:
			return

		msg_text = build_whatsapp_message(doc, new_status)

		# Try sending via frappe_whatsapp if available
		if hasattr(frappe.get_module("frappe_whatsapp"), "send_message"):
			frappe.get_module("frappe_whatsapp").send_message(
				recipient=clean_phone,
				message=msg_text,
				reference_doctype="Maintenance Request",
				reference_name=doc.name
			)
	except Exception as e:
		# Gracefully log and proceed without blocking the user
		frappe.log_error(title=f"Auto WhatsApp send failed for {doc.name}", message=str(e))


@frappe.whitelist()
def get_whatsapp_share_data(docname, status=None):
	"""Return WhatsApp share payload (URL and text) for manual one-click sending."""
	if not _has_maintenance_role():
		frappe.throw(_("Not permitted"), frappe.PermissionError)

	doc = frappe.get_doc("Maintenance Request", docname)
	phone = doc.phone_number
	if not phone and doc.customer:
		c_info = get_customer_contact_info(doc.customer)
		phone = c_info.get("phone")

	clean_phone = clean_phone_for_whatsapp(phone)
	msg_text = build_whatsapp_message(doc, status)

	import urllib.parse
	encoded_text = urllib.parse.quote(msg_text)
	wa_url = f"https://wa.me/{clean_phone}?text={encoded_text}" if clean_phone else f"https://wa.me/?text={encoded_text}"

	return {
		"phone": phone or "",
		"clean_phone": clean_phone or "",
		"message": msg_text,
		"wa_url": wa_url,
		"has_whatsapp_installed": "frappe_whatsapp" in frappe.get_installed_apps()
	}


# ── Device History & Warranty Checking ─────────────────────────────────

@frappe.whitelist()
def check_device_and_customer_history(serial_number=None, customer=None, phone_number=None, exclude_name=None):
	"""Check prior maintenance history and active warranty for device or customer."""
	if not _has_maintenance_role():
		frappe.throw(_("Not permitted"), frappe.PermissionError)

	today_date = getdate(today())
	device_records = []
	customer_records = []
	has_active_warranty = False
	active_warranty_details = None

	# 1. Search by Serial / IMEI Number
	if serial_number and str(serial_number).strip():
		s_clean = str(serial_number).strip()
		query = """
			SELECT
				name, status, received_date, device_type, brand, model, serial_number,
				problem_description, diagnosis, actual_delivery_date, warranty_days, warranty_end_date,
				estimated_cost, total_amount, customer
			FROM `tabMaintenance Request`
			WHERE serial_number = %s
		"""
		params = [s_clean]
		if exclude_name:
			query += " AND name != %s"
			params.append(exclude_name)
		query += " ORDER BY creation DESC LIMIT 10"

		rows = frappe.db.sql(query, tuple(params), as_dict=True)
		for r in rows:
			w_end = getdate(r.warranty_end_date) if r.warranty_end_date else None
			is_active_w = bool(w_end and w_end >= today_date and r.status == "Delivered")
			days_left = (w_end - today_date).days if is_active_w else 0

			item = {
				"name": r.name,
				"status": r.status,
				"received_date": str(r.received_date or ""),
				"device_type": r.device_type or "",
				"brand": r.brand or "",
				"model": r.model or "",
				"serial_number": r.serial_number or "",
				"problem": r.problem_description or "",
				"diagnosis": r.diagnosis or "",
				"delivered_date": str(r.actual_delivery_date or ""),
				"warranty_days": r.warranty_days or 0,
				"warranty_end_date": str(r.warranty_end_date or ""),
				"is_under_warranty": is_active_w,
				"warranty_days_left": days_left,
				"total_amount": flt(r.total_amount)
			}
			device_records.append(item)

			if is_active_w and not has_active_warranty:
				has_active_warranty = True
				active_warranty_details = item

	# 2. Search recent requests by Customer or Phone
	if customer or phone_number:
		filters = []
		if customer:
			filters.append("customer = %(cust)s")
		if phone_number:
			filters.append("phone_number = %(phone)s")

		where_clause = " OR ".join(filters)
		params = {"cust": customer or "", "phone": phone_number or ""}
		if exclude_name:
			where_clause = f"({where_clause}) AND name != %(exclude)s"
			params["exclude"] = exclude_name

		c_query = f"""
			SELECT
				name, status, received_date, device_type, brand, model, serial_number,
				problem_description, actual_delivery_date, warranty_days, warranty_end_date
			FROM `tabMaintenance Request`
			WHERE {where_clause}
			ORDER BY creation DESC LIMIT 5
		"""
		c_rows = frappe.db.sql(c_query, params, as_dict=True)
		for cr in c_rows:
			w_end = getdate(cr.warranty_end_date) if cr.warranty_end_date else None
			is_active_w = bool(w_end and w_end >= today_date and cr.status == "Delivered")
			customer_records.append({
				"name": cr.name,
				"status": cr.status,
				"received_date": str(cr.received_date or ""),
				"device": f"{cr.device_type or ''} {cr.brand or ''} {cr.model or ''}".strip(),
				"serial_number": cr.serial_number or "",
				"problem": cr.problem_description or "",
				"is_under_warranty": is_active_w,
				"warranty_end_date": str(cr.warranty_end_date or "")
			})

	return {
		"device_history": device_records,
		"customer_history": customer_records,
		"has_active_warranty": has_active_warranty,
		"active_warranty_details": active_warranty_details
	}


# ── Thermal Sticker Print Data ────────────────────────────────────────

@frappe.whitelist()
def get_sticker_print_data(docname):
	"""Get formatted payload for thermal label / barcode sticker printing (50x30mm)."""
	if not _has_maintenance_role():
		frappe.throw(_("Not permitted"), frappe.PermissionError)

	doc = frappe.get_doc("Maintenance Request", docname)
	customer_name = doc.customer_name or frappe.db.get_value("Customer", doc.customer, "customer_name") or doc.customer or ""
	company_name = doc.company or frappe.defaults.get_user_default("company") or "Maintenance"

	return {
		"name": doc.name,
		"customer_name": customer_name,
		"phone": doc.phone_number or "",
		"device": f"{doc.device_type or ''} {doc.brand or ''} {doc.model or ''}".strip(),
		"device_type": doc.device_type or "",
		"brand": doc.brand or "",
		"model": doc.model or "",
		"serial_number": doc.serial_number or "",
		"problem": (doc.problem_description or "")[:80],
		"received_date": str(doc.received_date or today()),
		"branch": doc.branch or "",
		"company": company_name,
		"estimated_cost": flt(doc.estimated_cost),
		"advance_paid": flt(doc.advance_paid)
	}
