# maintenance_dashboard.py

import frappe
from frappe import _
from frappe.utils import today, flt, cint
import json


PAGE_SIZE = 25

SEARCH_FIELDS = ["name", "customer", "customer_name", "phone_number", "device_type", "brand", "serial_number", "intake_receiver"]

REQUEST_LIST_FIELDS = [
	"name", "customer", "customer_name", "phone_number", "device_type",
	"brand", "model", "problem_description", "status",
	"received_date", "expected_delivery_date", "technician", "branch",
	"estimated_cost", "sales_invoice", "intake_receiver", "delivery_receiver",
	"inspection_decision",
]

REPORT_FIELDS = REQUEST_LIST_FIELDS + ["total_amount", "advance_paid", "outstanding_amount"]


def _build_filters(status=None, branch=None, search=None):
	"""Build filters and or_filters dicts for Frappe ORM queries."""
	filters = {}
	or_filters = {}

	if status and status != "all":
		filters["status"] = status
	if branch:
		filters["branch"] = branch

	if search:
		search_term = f"%{search}%"
		for field in SEARCH_FIELDS:
			or_filters[field] = ["like", search_term]

	return filters, or_filters


def _get_count(doctype, filters, or_filters):
	"""Get document count using ORM."""
	if or_filters:
		return len(frappe.get_all(
			doctype,
			filters=filters,
			or_filters=or_filters,
			fields=["name"],
			limit_page_length=0,
		))
	return frappe.db.count(doctype, filters=filters)


@frappe.whitelist()
def get_dashboard_data(branch=None, status=None, search=None, page=1):
	page = cint(page) or 1
	stats = get_statistics(branch)
	result = get_requests(branch=branch, status=status, search=search, page=page)
	return {
		"stats": stats,
		"requests": result["requests"],
		"total_count": result["total_count"],
		"page": page,
		"page_size": PAGE_SIZE,
		"total_pages": result["total_pages"],
	}


def get_statistics(branch=None):
	filters = {}
	if branch:
		filters["branch"] = branch

	counts = frappe.get_all(
		"Maintenance Request",
		filters=filters,
		fields=["status", "count(name) as count"],
		group_by="status",
	)

	status_map = {
		"Pending": "pending",
		"In Progress": "in_progress",
		"Completed": "completed",
		"Not Repairable": "not_repairable",
		"Ready for Delivery": "ready_for_delivery",
		"Delivered": "delivered",
	}

	stats = {v: 0 for v in status_map.values()}
	for row in counts:
		key = status_map.get(row.status)
		if key:
			stats[key] = cint(row["count"])

	stats["total"] = sum(stats.values())
	return stats


def get_requests(status=None, branch=None, search=None, page=1):
	filters, or_filters = _build_filters(status, branch, search)

	total_count = _get_count("Maintenance Request", filters, or_filters)

	# Calculate pagination
	page = cint(page) or 1
	total_pages = max(1, -(-total_count // PAGE_SIZE))
	if page > total_pages:
		page = total_pages
	offset = (page - 1) * PAGE_SIZE

	query_args = {
		"doctype": "Maintenance Request",
		"filters": filters,
		"fields": REQUEST_LIST_FIELDS,
		"order_by": "creation desc",
		"limit_start": offset,
		"limit_page_length": PAGE_SIZE,
	}
	if or_filters:
		query_args["or_filters"] = or_filters

	requests = frappe.get_all(**query_args)

	return {
		"requests": requests,
		"total_count": total_count,
		"total_pages": total_pages,
	}


@frappe.whitelist()
def get_print_report_data(branch=None, status=None, search=None):
	"""Get all filtered data for print report (no pagination)."""
	filters, or_filters = _build_filters(status, branch, search)

	query_args = {
		"doctype": "Maintenance Request",
		"filters": filters,
		"fields": REPORT_FIELDS,
		"order_by": "creation desc",
		"limit_page_length": 0,
	}
	if or_filters:
		query_args["or_filters"] = or_filters

	requests = frappe.get_all(**query_args)

	# Calculate summary
	total_estimated = sum(flt(r.estimated_cost) for r in requests)
	total_amount = sum(flt(r.total_amount) for r in requests)
	total_paid = sum(flt(r.advance_paid) for r in requests)
	total_outstanding = sum(flt(r.outstanding_amount) for r in requests)

	# Get company info
	company = frappe.defaults.get_user_default("Company")
	company_name = ""
	if company:
		company_name = frappe.db.get_value("Company", company, "company_name") or company

	return {
		"requests": requests,
		"summary": {
			"total_records": len(requests),
			"total_estimated": total_estimated,
			"total_amount": total_amount,
			"total_paid": total_paid,
			"total_outstanding": total_outstanding,
		},
		"filters": {
			"branch": branch or _("All Branches"),
			"status": status or _("All Statuses"),
			"search": search or "",
		},
		"company_name": company_name,
		"print_date": today(),
	}


@frappe.whitelist()
def get_request_details(request_name):
	doc = frappe.get_doc("Maintenance Request", request_name)
	
	# Get services
	services = []
	if doc.services:
		for s in doc.services:
			services.append({
				"service_item": s.service_item,
				"service_name": s.description if s.description else s.service_item,
				"qty": s.qty,
				"rate": s.rate,
				"amount": s.amount
			})
	
	return {
		"name": doc.name,
		"customer": doc.customer,
		"customer_name": doc.customer_name,
		"phone_number": doc.phone_number,
		"secondary_phone": doc.secondary_phone,
		"branch": doc.branch,
		"company": doc.company,
		"device_type": doc.device_type,
		"brand": doc.brand,
		"model": doc.model,
		"serial_number": doc.serial_number,
		"device_condition": doc.device_condition,
		"problem_description": doc.problem_description,
		"diagnosis": doc.diagnosis,
		"repair_notes": doc.repair_notes,
		"not_repairable_reason": doc.not_repairable_reason,
		"status": doc.status,
		"technician": doc.technician,
		"intake_receiver": doc.intake_receiver,
		"delivery_receiver": doc.delivery_receiver,
		"inspection_decision": doc.inspection_decision,
		"received_date": str(doc.received_date) if doc.received_date else None,
		"expected_delivery_date": str(doc.expected_delivery_date) if doc.expected_delivery_date else None,
		"actual_delivery_date": str(doc.actual_delivery_date) if doc.actual_delivery_date else None,
		"estimated_cost": doc.estimated_cost or 0,
		"warranty_days": doc.warranty_days,
		"warranty_end_date": str(doc.warranty_end_date) if doc.warranty_end_date else None,
		"warranty_terms": doc.warranty_terms,
		"total_amount": doc.total_amount or 0,
		"advance_paid": doc.advance_paid or 0,
		"outstanding_amount": doc.outstanding_amount or 0,
		"sales_invoice": doc.sales_invoice,
		"services": services
	}


@frappe.whitelist()
def create_request(data):
	if isinstance(data, str):
		data = json.loads(data)
	
	doc = frappe.new_doc("Maintenance Request")
	doc.customer = data.get("customer")
	doc.phone_number = data.get("phone_number")
	doc.secondary_phone = data.get("secondary_phone")
	doc.branch = data.get("branch")
	doc.company = frappe.defaults.get_user_default("Company")
	doc.received_date = data.get("received_date") or today()
	doc.expected_delivery_date = data.get("expected_delivery_date") or None
	doc.intake_receiver = data.get("intake_receiver") or frappe.utils.get_fullname(frappe.session.user)
	doc.device_type = data.get("device_type")
	doc.brand = data.get("brand")
	doc.model = data.get("model")
	doc.serial_number = data.get("serial_number")
	doc.device_condition = data.get("device_condition")
	doc.problem_description = data.get("problem_description")
	doc.estimated_cost = data.get("estimated_cost") or 0
	doc.advance_paid = data.get("advance_paid") or 0
	doc.technician = data.get("technician") or None
	doc.warranty_days = data.get("warranty_days") or 0
	doc.status = data.get("status") or "Pending"
	
	doc.insert()
	frappe.db.commit()
	return doc.name


@frappe.whitelist()
def update_request(data):
	if isinstance(data, str):
		data = json.loads(data)
	
	doc = frappe.get_doc("Maintenance Request", data.get("name"))
	
	doc.customer = data.get("customer")
	doc.phone_number = data.get("phone_number")
	doc.secondary_phone = data.get("secondary_phone")
	doc.branch = data.get("branch")
	doc.received_date = data.get("received_date") or None
	doc.expected_delivery_date = data.get("expected_delivery_date") or None
	doc.intake_receiver = data.get("intake_receiver")
	doc.delivery_receiver = data.get("delivery_receiver")
	doc.inspection_decision = data.get("inspection_decision")
	doc.not_repairable_reason = data.get("not_repairable_reason")
	doc.device_type = data.get("device_type")
	doc.brand = data.get("brand")
	doc.model = data.get("model")
	doc.serial_number = data.get("serial_number")
	doc.device_condition = data.get("device_condition")
	doc.problem_description = data.get("problem_description")
	doc.diagnosis = data.get("diagnosis")
	doc.repair_notes = data.get("repair_notes")
	doc.estimated_cost = data.get("estimated_cost") or 0
	doc.advance_paid = data.get("advance_paid") or 0
	doc.technician = data.get("technician") or None
	doc.warranty_days = data.get("warranty_days") or 0
	doc.warranty_terms = data.get("warranty_terms") or ""
	doc.actual_delivery_date = data.get("actual_delivery_date") or None
	doc.status = data.get("status")

	# Update services
	services = data.get("services", [])
	
	# Clear existing services
	doc.services = []
	
	# Add new services
	for s in services:
		if s.get("service_item"):
			doc.append("services", {
				"service_item": s.get("service_item"),
				"qty": s.get("qty") or 1,
				"rate": s.get("rate") or 0,
				"amount": s.get("amount") or 0
			})
	
	doc.save()
	frappe.db.commit()
	return doc.name


@frappe.whitelist()
def get_customer_options():
	"""Get customer list with phone numbers for searchable dropdown."""
	customers = frappe.get_all(
		"Customer",
		filters={"disabled": 0},
		fields=["name", "customer_name"],
		order_by="customer_name asc",
		limit_page_length=0,
	)

	phone_map = {}

	# Source 1: Contact Phone linked to customers
	try:
		phone_data = frappe.db.sql("""
			SELECT dl.link_name AS customer, cp.phone
			FROM `tabContact Phone` cp
			JOIN `tabContact` ct ON ct.name = cp.parent
			JOIN `tabDynamic Link` dl ON dl.parent = ct.name
				AND dl.link_doctype = 'Customer'
			WHERE dl.link_name IN (SELECT name FROM `tabCustomer` WHERE disabled = 0)
			ORDER BY cp.is_primary_mobile_no DESC
		""", as_dict=True)
		for row in phone_data:
			if row.customer not in phone_map:
				phone_map[row.customer] = []
			if row.phone and row.phone not in phone_map[row.customer]:
				phone_map[row.customer].append(row.phone)
	except Exception:
		pass

	# Source 2: Phone numbers from Maintenance Request records
	try:
		mr_phones = frappe.db.sql("""
			SELECT customer, phone_number, secondary_phone
			FROM `tabMaintenance Request`
			WHERE customer IS NOT NULL AND phone_number IS NOT NULL AND phone_number != ''
			GROUP BY customer, phone_number, secondary_phone
		""", as_dict=True)
		for row in mr_phones:
			if row.customer not in phone_map:
				phone_map[row.customer] = []
			if row.phone_number and row.phone_number not in phone_map[row.customer]:
				phone_map[row.customer].append(row.phone_number)
			if row.secondary_phone and row.secondary_phone not in phone_map[row.customer]:
				phone_map[row.customer].append(row.secondary_phone)
	except Exception:
		pass

	result = []
	for c in customers:
		phones = phone_map.get(c.name, [])
		result.append({
			"name": c.name,
			"customer_name": c.customer_name,
			"phones": phones,
		})

	return result


@frappe.whitelist()
def update_status(request_name, new_status):
	doc = frappe.get_doc("Maintenance Request", request_name)
	doc.status = new_status

	# Auto-set delivery_receiver and actual_delivery_date when transitioning to Delivered
	if new_status == "Delivered":
		if not doc.delivery_receiver:
			doc.delivery_receiver = frappe.utils.get_fullname(frappe.session.user)
		if not doc.actual_delivery_date:
			doc.actual_delivery_date = today()

	doc.save()
	frappe.db.commit()
	return {"success": True, "status": new_status}