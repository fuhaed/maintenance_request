// Copyright (c) 2025, HIGH SPEED IT and contributors
// For license information, please see license.txt

// ── Stage Locking Configuration ────────────────────────────────────
const STAGE_1_FIELDS = [
	"customer", "phone_number", "secondary_phone", "device_type", "brand",
	"model", "serial_number", "device_condition", "problem_description",
	"intake_receiver", "expected_delivery_date", "received_date", "branch", "company",
	"images_before",
];
const STAGE_2_FIELDS = [
	"inspection_decision", "technician", "diagnosis", "repair_notes", "not_repairable_reason",
];
const STAGE_3_FIELDS = [
	"services", "estimated_cost", "advance_paid",
];
const STAGE_4_FIELDS = [
	"actual_delivery_date", "delivery_receiver", "warranty_days", "warranty_terms", "images_after",
];

const LOCKED_STAGES = {
	"Pending": [],
	"In Progress": [STAGE_1_FIELDS],
	"Completed": [STAGE_1_FIELDS, STAGE_2_FIELDS],
	"Not Repairable": [STAGE_1_FIELDS, STAGE_2_FIELDS],
	"Ready for Delivery": [STAGE_1_FIELDS, STAGE_2_FIELDS, STAGE_3_FIELDS],
	"Delivered": [STAGE_1_FIELDS, STAGE_2_FIELDS, STAGE_3_FIELDS, STAGE_4_FIELDS],
};

const ALLOWED_TRANSITIONS = {
	"Pending": ["In Progress"],
	"In Progress": ["Completed", "Not Repairable"],
	"Completed": ["Ready for Delivery"],
	"Not Repairable": ["Ready for Delivery"],
	"Ready for Delivery": ["Delivered"],
};


frappe.ui.form.on("Maintenance Request", {
	setup(frm) {
		// Filter services to show only non-stock items
		frm.set_query("service_item", "services", function() {
			return { filters: { "is_stock_item": 0 } };
		});

		// Custom customer search: by name, ID, or phone
		frm.set_query("customer", function() {
			return {
				query: "maintenance_request.maintenance_request.doctype.maintenance_request.maintenance_request.get_customer_list"
			};
		});
	},

	onload(frm) {
		// Auto-set branch from employee
		if (frm.is_new() && !frm.doc.branch) {
			frappe.call({
				method: "maintenance_request.maintenance_request.doctype.maintenance_request.maintenance_request.get_user_branch",
				callback: function(r) {
					if (r.message) {
						frm.set_value("branch", r.message);
					}
				}
			});
		}

		// Auto-set company
		if (frm.is_new() && !frm.doc.company) {
			frm.set_value("company", frappe.defaults.get_user_default("Company"));
		}

		// Auto-set intake_receiver to current user on new docs
		if (frm.is_new() && !frm.doc.intake_receiver) {
			frm.set_value("intake_receiver", frappe.session.user_fullname || frappe.session.user);
		}

		// Populate Brand select options from Brand DocType
		load_brand_options(frm);
	},

	refresh(frm) {
		set_status_color(frm);
		apply_stage_locking(frm);
		toggle_inspection_fields(frm);

		// Intake/Delivery receiver are auto-set by system — always read-only
		frm.set_df_property("intake_receiver", "read_only", 1);
		frm.set_df_property("delivery_receiver", "read_only", 1);

		// Lock form if invoice exists
		if (frm.doc.sales_invoice) {
			frm.set_read_only();
			frm.set_intro(
				__('This request is locked because Sales Invoice <a href="/app/sales-invoice/{0}">{0}</a> has been issued.', [frm.doc.sales_invoice]),
				'yellow'
			);
			// Allow only delivery-related changes
			frm.set_df_property('actual_delivery_date', 'read_only', 0);
			frm.set_df_property('delivery_receiver', 'read_only', 0);
			frm.set_df_property('warranty_days', 'read_only', 0);
			frm.enable_save();
		}

		// Add Create Invoice button
		if (!frm.is_new() && !frm.doc.sales_invoice && frm.doc.total_amount > 0) {
			frm.add_custom_button(__("Create Invoice"), function() {
				frappe.call({
					method: "maintenance_request.maintenance_request.doctype.maintenance_request.maintenance_request.create_sales_invoice",
					args: { maintenance_request: frm.doc.name },
					callback: function(r) {
						if (r.message) {
							frm.reload_doc();
							frappe.show_alert({
								message: __("Sales Invoice {0} created", [r.message]),
								indicator: "green"
							});
						}
					}
				});
			}, __("Actions"));
		}

		// Link to existing invoice
		if (frm.doc.sales_invoice) {
			frm.add_custom_button(__("View Invoice"), function() {
				frappe.set_route("Form", "Sales Invoice", frm.doc.sales_invoice);
			}, __("Actions"));
		}

		// Quick status change buttons
		if (!frm.is_new()) {
			add_status_buttons(frm);
		}
	},

	customer(frm) {
		// Always fetch and fill phone when customer changes
		if (frm.doc.customer) {
			frappe.call({
				method: "maintenance_request.maintenance_request.doctype.maintenance_request.maintenance_request.get_customer_contact_info",
				args: { customer: frm.doc.customer },
				callback: function(r) {
					if (r.message) {
						if (r.message.phone) {
							frm.set_value("phone_number", r.message.phone);
						}
						if (r.message.secondary_phone) {
							frm.set_value("secondary_phone", r.message.secondary_phone);
						}
					}
				}
			});
		}
	},

	inspection_decision(frm) {
		toggle_inspection_fields(frm);
	},

	status(frm) {
		set_status_color(frm);
	},

	advance_paid(frm) {
		calculate_outstanding(frm);
	}
});

frappe.ui.form.on("Maintenance Request Service", {
	service_item(frm, cdt, cdn) {
		let row = locals[cdt][cdn];
		if (row.service_item) {
			frappe.db.get_value("Item", row.service_item, ["item_name", "standard_rate"], function(r) {
				if (r) {
					frappe.model.set_value(cdt, cdn, "description", r.item_name);
					frappe.model.set_value(cdt, cdn, "rate", r.standard_rate || 0);
					calculate_row_amount(frm, cdt, cdn);
				}
			});
		}
	},

	qty(frm, cdt, cdn) {
		calculate_row_amount(frm, cdt, cdn);
	},

	rate(frm, cdt, cdn) {
		calculate_row_amount(frm, cdt, cdn);
	},

	services_remove(frm, cdt, cdn) {
		calculate_totals(frm);
	}
});


// ── Helper Functions ───────────────────────────────────────────────

function load_brand_options(frm) {
	frappe.call({
		method: "maintenance_request.maintenance_request.doctype.maintenance_request.maintenance_request.get_brand_options",
		callback: function(r) {
			if (r.message) {
				var options = [""].concat(r.message);
				frm.set_df_property("brand", "options", options.join("\n"));
				frm.refresh_field("brand");
			}
		}
	});
}

function toggle_inspection_fields(frm) {
	var decision = frm.doc.inspection_decision;

	frm.toggle_display("diagnosis", decision === "Repairable");
	frm.toggle_display("repair_notes", decision === "Repairable");
	frm.toggle_display("not_repairable_reason", decision === "Not Repairable");

	frm.toggle_reqd("diagnosis", decision === "Repairable");
	frm.toggle_reqd("not_repairable_reason", decision === "Not Repairable");
}

function apply_stage_locking(frm) {
	if (frm.is_new()) return;

	var status = frm.doc.status;
	var locked_groups = LOCKED_STAGES[status] || [];

	var locked_fields = [];
	locked_groups.forEach(function(group) {
		locked_fields = locked_fields.concat(group);
	});

	locked_fields.forEach(function(fieldname) {
		frm.set_df_property(fieldname, "read_only", 1);
	});

	// If Delivered, lock everything
	if (status === "Delivered") {
		STAGE_4_FIELDS.forEach(function(fieldname) {
			frm.set_df_property(fieldname, "read_only", 1);
		});
	}
}

function calculate_row_amount(frm, cdt, cdn) {
	let row = locals[cdt][cdn];
	let amount = flt(row.qty) * flt(row.rate);
	frappe.model.set_value(cdt, cdn, "amount", amount);
	calculate_totals(frm);
}

function calculate_totals(frm) {
	let total = 0;
	(frm.doc.services || []).forEach(function(row) {
		total += flt(row.amount);
	});
	frm.set_value("total_amount", total);
	calculate_outstanding(frm);
}

function calculate_outstanding(frm) {
	let outstanding = flt(frm.doc.total_amount) - flt(frm.doc.advance_paid);
	frm.set_value("outstanding_amount", outstanding);
}

function set_status_color(frm) {
	const status_colors = {
		"Pending": "orange",
		"In Progress": "blue",
		"Completed": "green",
		"Not Repairable": "red",
		"Ready for Delivery": "purple",
		"Delivered": "green"
	};
	let color = status_colors[frm.doc.status] || "gray";
	frm.page.set_indicator(frm.doc.status, color);
}

function add_status_buttons(frm) {
	var next_statuses = ALLOWED_TRANSITIONS[frm.doc.status];
	if (!next_statuses) return;

	next_statuses.forEach(function(status) {
		frm.add_custom_button(__(status), function() {
			// Auto-set delivery_receiver when transitioning to Delivered
			if (status === "Delivered") {
				if (!frm.doc.delivery_receiver) {
					frm.set_value("delivery_receiver", frappe.session.user_fullname || frappe.session.user);
				}
				if (!frm.doc.actual_delivery_date) {
					frm.set_value("actual_delivery_date", frappe.datetime.get_today());
				}
			}
			var errors = validate_before_transition(frm, status);
			if (errors.length > 0) {
				frappe.msgprint({
					title: __("Missing Required Fields"),
					message: errors.join("<br>"),
					indicator: "red"
				});
				return;
			}
			frm.set_value("status", status);
			frm.save();
		}, __("Change Status"));
	});
}

function validate_before_transition(frm, target_status) {
	var errors = [];

	if (target_status === "In Progress") {
		if (!frm.doc.inspection_decision) {
			errors.push(__("Inspection Decision is required"));
		}
		if (!frm.doc.technician) {
			errors.push(__("Technician is required"));
		}
		if (frm.doc.inspection_decision === "Repairable" && !frm.doc.diagnosis) {
			errors.push(__("Diagnosis is required when device is Repairable"));
		}
		if (frm.doc.inspection_decision === "Not Repairable" && !frm.doc.not_repairable_reason) {
			errors.push(__("Reason is required when device is Not Repairable"));
		}
	}

	if (target_status === "Delivered") {
		if (!frm.doc.actual_delivery_date) {
			errors.push(__("Actual Delivery Date is required"));
		}
		if (!frm.doc.delivery_receiver) {
			errors.push(__("Delivery Receiver is required"));
		}
	}

	return errors;
}
