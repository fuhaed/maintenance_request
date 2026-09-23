// maintenance_dashboard.js

var dashboard_page = null;
var selected_branch = '';
var selected_status = 'all';
var search_text = '';
var from_date = '';
var to_date = '';
var current_page = 1;
var total_pages = 1;
var total_count = 0;
var branches_list = [];
var brands_options = [];
var search_timer = null;

// ── Stage Locking Configuration ────────────────────────────────────
var STAGE_1_FIELDS = [
	"mr_customer", "mr_phone_number", "mr_secondary_phone", "mr_device_type", "mr_brand",
	"mr_model", "mr_serial_number", "mr_device_condition", "mr_problem_description",
	"mr_expected_delivery_date", "mr_received_date", "mr_branch",
];
var STAGE_2_FIELDS = [
	"mr_inspection_decision", "mr_technician", "mr_diagnosis", "mr_repair_notes", "mr_not_repairable_reason",
];
var STAGE_3_FIELDS = [
	"mr_estimated_cost", "mr_advance_paid",
];
var STAGE_4_FIELDS = [
	"mr_actual_delivery_date", "mr_warranty_days", "mr_warranty_terms",
];

var LOCKED_STAGES = {
	"Pending": [],
	"In Progress": [STAGE_1_FIELDS],
	"Completed": [STAGE_1_FIELDS, STAGE_2_FIELDS],
	"Not Repairable": [STAGE_1_FIELDS, STAGE_2_FIELDS],
	"Ready for Delivery": [STAGE_1_FIELDS, STAGE_2_FIELDS, STAGE_3_FIELDS],
	"Delivered": [STAGE_1_FIELDS, STAGE_2_FIELDS, STAGE_3_FIELDS, STAGE_4_FIELDS],
};

var ALLOWED_TRANSITIONS = {
	"Pending": ["In Progress"],
	"In Progress": ["Completed", "Not Repairable"],
	"Completed": ["Ready for Delivery"],
	"Not Repairable": ["Ready for Delivery"],
	"Ready for Delivery": ["Delivered"],
};

// ── Wizard Step Configuration ─────────────────────────────────────
var current_wizard_step = 'intake';

var WIZARD_STEPS = [
	{ id: 'intake', label: __('Intake'), icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
	  completed_at: ['In Progress', 'Completed', 'Not Repairable', 'Ready for Delivery', 'Delivered'],
	  active_at: ['Pending'], show_for_new: true },
	{ id: 'inspection', label: __('Inspection'), icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
	  completed_at: ['Completed', 'Not Repairable', 'Ready for Delivery', 'Delivered'],
	  active_at: ['In Progress'], show_for_new: false },
	{ id: 'services', label: __('Services'), icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
	  completed_at: ['Ready for Delivery', 'Delivered'],
	  active_at: ['Completed', 'Not Repairable'], show_for_new: false },
	{ id: 'financials', label: __('Financials'), icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="2" y="4" width="20" height="16" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>',
	  completed_at: ['Ready for Delivery', 'Delivered'],
	  active_at: ['Completed', 'Not Repairable'], show_for_new: false },
	{ id: 'delivery', label: __('Delivery'), icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
	  completed_at: ['Delivered'],
	  active_at: ['Ready for Delivery'], show_for_new: false },
];

function get_step_state(step, status, is_edit) {
	if (!is_edit) return step.id === 'intake' ? 'active' : 'disabled';
	if (step.completed_at.indexOf(status) >= 0) return 'completed';
	if (step.active_at.indexOf(status) >= 0) return 'active';
	return 'available';
}

function get_auto_step(status) {
	var map = {
		'Pending': 'intake',
		'In Progress': 'inspection',
		'Completed': 'services',
		'Not Repairable': 'services',
		'Ready for Delivery': 'delivery',
		'Delivered': 'delivery',
	};
	return map[status] || 'intake';
}

function can_manage_locked_request() {
	return frappe.user.has_role('Maintenance Manager') || frappe.user.has_role('System Manager');
}

function get_visible_wizard_steps() {
	var is_edit = !!$('#mr_name').val();
	return is_edit ? WIZARD_STEPS : WIZARD_STEPS.filter(function(step) {
		return step.show_for_new;
	});
}

function get_wizard_step_index(step_id) {
	var steps = get_visible_wizard_steps();
	for (var i = 0; i < steps.length; i++) {
		if (steps[i].id === step_id) return i;
	}
	return 0;
}

function update_wizard_nav() {
	var steps = get_visible_wizard_steps();
	var idx = get_wizard_step_index(current_wizard_step);
	var step = steps[idx] || steps[0];
	$('.mr-dialog .wizard-current-step-value').text(step ? step.label : '');
	$('#wizard_prev_btn').prop('disabled', idx <= 0);
	$('#wizard_next_btn').prop('disabled', idx >= steps.length - 1);
}

function move_wizard_step(direction) {
	var steps = get_visible_wizard_steps();
	var idx = get_wizard_step_index(current_wizard_step);
	var next_idx = idx + direction;
	if (next_idx < 0 || next_idx >= steps.length) return;
	switch_wizard_step(steps[next_idx].id);
}

function switch_wizard_step(step_id) {
	current_wizard_step = step_id;
	$('.mr-dialog .wizard-tab').removeClass('active');
	$('.mr-dialog .wizard-tab[data-step="' + step_id + '"]').addClass('active');
	$('.mr-dialog .wizard-step-panel').removeClass('active');
	$('.mr-dialog .wizard-step-panel[data-step="' + step_id + '"]').addClass('active');
	update_wizard_nav();

	// Unlock fields in the active step panel for editing (if not locked and not Delivered)
	var $panel = $('.mr-dialog .wizard-step-panel[data-step="' + step_id + '"]');
	var current_status = $('#mr_status').val() || $('.mr-dialog').data('status');
	if ($panel.length && !$('.mr-dialog').data('invoice-locked') && !$('.mr-dialog').data('not-repairable-locked') && current_status !== 'Delivered') {
		$panel.find('input, select, textarea').prop('disabled', false).css('background', '');
		// Re-enable searchable dropdowns in this panel
		$panel.find('.searchable-dropdown').each(function() {
			var disable_fn = $(this).data('sd-disable');
			if (disable_fn) disable_fn(false);
		});
		// Keep intake_receiver and delivery_receiver always read-only
		$('#mr_intake_receiver').prop('disabled', true).css('background', '#f0f0f0');
		$('#mr_delivery_receiver').prop('disabled', true).css('background', '#f0f0f0');
		// Re-enable add buttons in active panel
		$panel.find('#add_customer_btn, #add_brand_btn, #add_device_type_btn, #add_service_btn').show();
		$panel.find('.delete-service-row').show();
	}
}

function build_wizard_tabs_html(status, is_edit) {
	var steps = is_edit ? WIZARD_STEPS : WIZARD_STEPS.filter(function(s) { return s.show_for_new; });
	var html = '<div class="wizard-tabs">';
	steps.forEach(function(step, idx) {
		var state = get_step_state(step, status, is_edit);
		if (idx > 0) {
			var prev_state = get_step_state(steps[idx - 1], status, is_edit);
			var conn_cls = prev_state === 'completed' ? ' completed' : '';
			html += '<div class="wizard-tab-connector' + conn_cls + '"></div>';
		}
		html += '<div class="wizard-tab ' + state + '" data-step="' + step.id + '">';
		html += '<div class="wizard-tab-indicator">';
		html += '<span class="wizard-tab-icon">' + step.icon + '</span>';
		html += '<svg class="wizard-tab-check" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>';
		html += '</div>';
		html += '<span class="wizard-tab-label">' + step.label + '</span>';
		html += '</div>';
	});
	html += '</div>';
	return html;
}

frappe.pages['maintenance-dashboard'].on_page_load = function(wrapper) {
	var page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __('Maintenance Dashboard'),
		single_column: true
	});

	dashboard_page = page;

	page.set_primary_action(__('New Request'), () => {
		show_request_dialog();
	}, 'add');

	page.set_secondary_action(__('Refresh'), () => {
		current_page = 1;
		load_dashboard(dashboard_page);
	}, 'refresh');

	// Load branches once
	try {
		frappe.call({
			method: 'frappe.client.get_list',
			args: { doctype: 'Branch', limit_page_length: 0, fields: ['name'], order_by: 'name asc' },
			async: false,
			callback: function(r) {
				branches_list = (r && r.message) || [];
			}
		});
	} catch(e) {
		branches_list = [];
	}

	load_dashboard(page);
};

frappe.pages['maintenance-dashboard'].refresh = function(wrapper) {
	if (dashboard_page) {
		load_dashboard(dashboard_page);
	}
};

function load_dashboard(page, partial) {
	if (!page || !page.body) return;

	// If not partial update, show loading spinner
	if (!partial) {
		$(page.body).empty();
		$(page.body).html('<div class="text-center p-5"><div class="spinner-border text-primary"></div></div>');
	}

	var args = {
		branch: selected_branch || '',
		page: current_page || 1,
		from_date: from_date || '',
		to_date: to_date || ''
	};

	if (selected_status && selected_status !== 'all') {
		args.status = selected_status;
	}

	if (search_text) {
		args.search = search_text;
	}

	frappe.call({
		method: 'maintenance_request.maintenance_request.page.maintenance_dashboard.maintenance_dashboard.get_dashboard_data',
		args: args,
		callback: function(r) {
			if (r && r.message) {
				total_pages = r.message.total_pages || 1;
				total_count = r.message.total_count || 0;
				current_page = r.message.page || 1;

				if (partial && $('.maintenance-dashboard').length) {
					update_dashboard_partial(r.message);
				} else {
					render_dashboard(page, r.message);
				}
			} else {
				$(page.body).html('<div class="text-center p-5 text-muted">' + __('Failed to load dashboard data') + '</div>');
			}
		},
		error: function() {
			$(page.body).html('<div class="text-center p-5 text-muted">' + __('Failed to load dashboard data') + '</div>');
		}
	});
}

function update_dashboard_partial(data) {
	// Update stats numbers
	$('.stat-card.all .stat-info h3').text(data.stats.total || 0);
	$('.stat-card.pending .stat-info h3').text(data.stats.pending || 0);
	$('.stat-card.in-progress .stat-info h3').text(data.stats.in_progress || 0);
	$('.stat-card.completed .stat-info h3').text(data.stats.completed || 0);
	$('.stat-card.ready .stat-info h3').text(data.stats.ready_for_delivery || 0);
	$('.stat-card.delivered .stat-info h3').text(data.stats.delivered || 0);
	$('.stat-card.not-repairable .stat-info h3').text(data.stats.not_repairable || 0);

	// Update active statistics filter
	$('.stat-card').removeClass('active');
	$('.stat-card[data-status="' + (selected_status || 'all') + '"]').addClass('active');

	// Update table rows
	$('#requests-tbody').html(render_table_rows(data.requests));

	// Update pagination
	$('.pagination-container').remove();
	$('.table-container').after(render_pagination(data));

	// Re-bind row and view button events
	$('.request-row').on('dblclick', function() {
		show_request_dialog($(this).data('name'));
	});
	$('.btn-view').on('click', function(e) {
		e.stopPropagation();
		show_request_dialog($(this).data('name'));
	});
	$('.btn-row-whatsapp').on('click', function(e) {
		e.stopPropagation();
		open_whatsapp_share_dialog($(this).data('name'));
	});
	$('.btn-row-label').on('click', function(e) {
		e.stopPropagation();
		print_thermal_sticker($(this).data('name'));
	});
	$('.btn-row-print').on('click', function(e) {
		e.stopPropagation();
		var name = $(this).data('name');
		if (name) {
			window.open('/printview?doctype=Maintenance%20Request&name=' + encodeURIComponent(name), '_blank');
		}
	});
	$('.page-btn, .page-nav-btn').on('click', function() {
		if ($(this).prop('disabled')) return;
		var pg = parseInt($(this).data('page'));
		if (pg && pg !== current_page) {
			current_page = pg;
			load_dashboard(dashboard_page, true);
			$('.table-container')[0]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
		}
	});
}

function render_dashboard(page, data) {
	let html = `
		<div class="maintenance-dashboard">
			<div class="stats-container">
				<div class="stat-card all ${selected_status === 'all' ? 'active' : ''}" data-status="all" onclick="filter_by_status('all')">
					<div class="stat-icon"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg></div>
					<div class="stat-info"><h3>${data.stats.total || 0}</h3><p>${__('All')}</p></div>
				</div>
				<div class="stat-card pending ${selected_status === 'Pending' ? 'active' : ''}" data-status="Pending" onclick="filter_by_status('Pending')">
					<div class="stat-icon"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg></div>
					<div class="stat-info"><h3>${data.stats.pending || 0}</h3><p>${__('Pending')}</p></div>
				</div>
				<div class="stat-card in-progress ${selected_status === 'In Progress' ? 'active' : ''}" data-status="In Progress" onclick="filter_by_status('In Progress')">
					<div class="stat-icon"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"></path></svg></div>
					<div class="stat-info"><h3>${data.stats.in_progress || 0}</h3><p>${__('In Progress')}</p></div>
				</div>
				<div class="stat-card completed ${selected_status === 'Completed' ? 'active' : ''}" data-status="Completed" onclick="filter_by_status('Completed')">
					<div class="stat-icon"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg></div>
					<div class="stat-info"><h3>${data.stats.completed || 0}</h3><p>${__('Completed')}</p></div>
				</div>
				<div class="stat-card ready ${selected_status === 'Ready for Delivery' ? 'active' : ''}" data-status="Ready for Delivery" onclick="filter_by_status('Ready for Delivery')">
					<div class="stat-icon"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="3" width="15" height="13"></rect><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon><circle cx="5.5" cy="18.5" r="2.5"></circle><circle cx="18.5" cy="18.5" r="2.5"></circle></svg></div>
					<div class="stat-info"><h3>${data.stats.ready_for_delivery || 0}</h3><p>${__('Ready')}</p></div>
				</div>
				<div class="stat-card delivered ${selected_status === 'Delivered' ? 'active' : ''}" data-status="Delivered" onclick="filter_by_status('Delivered')">
					<div class="stat-icon"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg></div>
					<div class="stat-info"><h3>${data.stats.delivered || 0}</h3><p>${__('Delivered')}</p></div>
				</div>
				<div class="stat-card not-repairable ${selected_status === 'Not Repairable' ? 'active' : ''}" data-status="Not Repairable" onclick="filter_by_status('Not Repairable')">
					<div class="stat-icon"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg></div>
					<div class="stat-info"><h3>${data.stats.not_repairable || 0}</h3><p>${__('Not Repairable')}</p></div>
				</div>
			</div>
			<div class="filter-search-row">
				<div class="filter-right">
					<select id="branch-filter" class="branch-select">
						<option value="">${__('All Branches')}</option>
					</select>
					<input type="date" class="date-input" id="from-date-filter" value="${esc_attr(from_date)}" title="${__('From Date')}">
					<input type="date" class="date-input" id="to-date-filter" value="${esc_attr(to_date)}" title="${__('To Date')}">
					<input type="text" class="search-input" placeholder="${__('Search...')}" id="request-search" value="${search_text || ''}">
					<button class="btn-print-report" id="print-report-btn" title="${__('Print Report')}">
						<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"></polyline><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect x="6" y="14" width="12" height="8"></rect></svg>
						${__('Print Report')}
					</button>
				</div>
			</div>
			<div class="table-container">
				<table class="requests-table">
					<thead>
						<tr>
							<th>${__('Request #')}</th>
							<th>${__('Customer')}</th>
							<th>${__('Phone')}</th>
							<th>${__('Device')}</th>
							<th>${__('Problem')}</th>
							<th>${__('Est. Cost')}</th>
							<th>${__('Date')}</th>
							<th>${__('Status')}</th>
							<th>${__('Actions')}</th>
						</tr>
					</thead>
					<tbody id="requests-tbody">${render_table_rows(data.requests)}</tbody>
				</table>
			</div>
			${render_pagination(data)}
		</div>
	`;
	$(page.body).html(html);
	load_branch_filter();
	bind_events();
}

function render_pagination(data) {
	if (!data.total_count || data.total_count <= data.page_size) {
		return '';
	}

	var tp = data.total_pages || 1;
	var cp = data.page || 1;
	var start_record = ((cp - 1) * data.page_size) + 1;
	var end_record = Math.min(cp * data.page_size, data.total_count);

	// Build page numbers
	var pages_html = '';
	var max_visible = 5;
	var start_page = Math.max(1, cp - Math.floor(max_visible / 2));
	var end_page = Math.min(tp, start_page + max_visible - 1);

	if (end_page - start_page < max_visible - 1) {
		start_page = Math.max(1, end_page - max_visible + 1);
	}

	// First page + ellipsis
	if (start_page > 1) {
		pages_html += `<button class="page-btn" data-page="1">1</button>`;
		if (start_page > 2) {
			pages_html += `<span class="page-ellipsis">...</span>`;
		}
	}

	for (var i = start_page; i <= end_page; i++) {
		pages_html += `<button class="page-btn ${i === cp ? 'active' : ''}" data-page="${i}">${i}</button>`;
	}

	// Last page + ellipsis
	if (end_page < tp) {
		if (end_page < tp - 1) {
			pages_html += `<span class="page-ellipsis">...</span>`;
		}
		pages_html += `<button class="page-btn" data-page="${tp}">${tp}</button>`;
	}

	return `
		<div class="pagination-container">
			<div class="pagination-info">
				${__('Showing {0} to {1} of {2} records', [start_record, end_record, data.total_count])}
			</div>
			<div class="pagination-controls">
				<button class="page-nav-btn" id="page-first" ${cp <= 1 ? 'disabled' : ''} data-page="1" title="${__('First Page')}">
					<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="11 17 6 12 11 7"></polyline><polyline points="18 17 13 12 18 7"></polyline></svg>
				</button>
				<button class="page-nav-btn" id="page-prev" ${cp <= 1 ? 'disabled' : ''} data-page="${cp - 1}" title="${__('Previous Page')}">
					<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"></polyline></svg>
				</button>
				${pages_html}
				<button class="page-nav-btn" id="page-next" ${cp >= tp ? 'disabled' : ''} data-page="${cp + 1}" title="${__('Next Page')}">
					<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>
				</button>
				<button class="page-nav-btn" id="page-last" ${cp >= tp ? 'disabled' : ''} data-page="${tp}" title="${__('Last Page')}">
					<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="13 17 18 12 13 7"></polyline><polyline points="6 17 11 12 6 7"></polyline></svg>
				</button>
			</div>
		</div>
	`;
}

function esc(value) {
	return String(value == null ? '' : value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function esc_attr(value) {
	return esc(value);
}

function latin_digits(value) {
	return String(value == null ? '' : value)
		.replace(/[٠-٩]/g, function(d) { return '٠١٢٣٤٥٦٧٨٩'.indexOf(d); })
		.replace(/[۰-۹]/g, function(d) { return '۰۱۲۳۴۵۶۷۸۹'.indexOf(d); });
}

function render_table_rows(requests) {
	if (!requests || requests.length === 0) {
		return `<tr><td colspan="9" class="text-center py-4">${__('No maintenance requests found')}</td></tr>`;
	}
	let html = '';
	const colors = {'Pending':'orange','In Progress':'blue','Completed':'green','Not Repairable':'red','Ready for Delivery':'purple','Delivered':'teal'};
	requests.forEach(req => {
		let problem_text = '';
		if (req.problem_description) {
			let clean = req.problem_description.replace(/<[^>]+>/g, '');
			problem_text = clean.length > 30 ? clean.substring(0, 30) + '...' : clean;
			problem_text = esc(problem_text);
		}
		let invoice_html = '';
		if (req.sales_invoice) {
			invoice_html = `<div class="invoice-indicator">
				<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>
				<a href="/app/sales-invoice/${esc_attr(req.sales_invoice)}" class="invoice-link" onclick="event.stopPropagation()">${esc(req.sales_invoice)}</a>
			</div>`;
		}
		html += `
			<tr class="request-row" data-name="${esc_attr(req.name)}" data-status="${esc_attr(req.status || '')}">
				<td class="req-id">
					${esc(req.name)}
					${invoice_html}
				</td>
				<td>${esc(req.customer_name)}</td>
				<td>${esc(req.phone_number)}</td>
				<td>${esc(req.device_type)}${req.brand ? ' - ' + esc(req.brand) : ''}</td>
				<td class="problem">${problem_text}</td>
				<td class="est-cost">${fmt(req.estimated_cost)}</td>
				<td>${req.received_date ? latin_digits(frappe.datetime.str_to_user(req.received_date)) : ''}</td>
				<td><span class="status-badge ${colors[req.status] || 'gray'}">${esc(__(req.status || 'Pending'))}</span></td>
				<td>
					<div class="action-cell">
						<button class="btn-action-icon btn-view" data-name="${esc_attr(req.name)}" title="${__('View / Edit Request')}">
							<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
						</button>
						<button class="btn-action-icon btn-row-whatsapp" data-name="${esc_attr(req.name)}" title="${__('WhatsApp Message')}">
							<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
						</button>
						<button class="btn-action-icon btn-row-label" data-name="${esc_attr(req.name)}" title="${__('Print Device Label')}">
							<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line></svg>
						</button>
						<button class="btn-action-icon btn-row-print" data-name="${esc_attr(req.name)}" title="${__('Print Request')}">
							<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"></polyline><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect x="6" y="14" width="12" height="8"></rect></svg>
						</button>
					</div>
				</td>
			</tr>
		`;
	});
	return html;
}

function load_branch_filter() {
	let $select = $('#branch-filter');
	branches_list.forEach(function(item) {
		let sel = selected_branch === item.name ? 'selected' : '';
		$select.append(`<option value="${item.name}" ${sel}>${item.name}</option>`);
	});
}

function bind_events() {
	// Branch filter
	$('#branch-filter').on('change', function() {
		selected_branch = $(this).val();
		current_page = 1;
		load_dashboard(dashboard_page, true);
	});

	// Search with debounce
	$('#request-search').on('keyup', function() {
		var val = $(this).val().trim();
		if (search_timer) clearTimeout(search_timer);
		search_timer = setTimeout(function() {
			search_text = val;
			current_page = 1;
			load_dashboard(dashboard_page, true);
		}, 400);
	});

	$('#from-date-filter, #to-date-filter').on('change', function() {
		from_date = $('#from-date-filter').val();
		to_date = $('#to-date-filter').val();
		if (from_date && to_date && from_date > to_date) {
			frappe.msgprint(__('From Date cannot be after To Date'));
			return;
		}
		current_page = 1;
		load_dashboard(dashboard_page, true);
	});

	// Row double click
	$('.request-row').on('dblclick', function() {
		show_request_dialog($(this).data('name'));
	});

	// View button
	$('.btn-view').on('click', function(e) {
		e.stopPropagation();
		show_request_dialog($(this).data('name'));
	});

	$('.btn-row-whatsapp').on('click', function(e) {
		e.stopPropagation();
		open_whatsapp_share_dialog($(this).data('name'));
	});

	$('.btn-row-label').on('click', function(e) {
		e.stopPropagation();
		print_thermal_sticker($(this).data('name'));
	});

	$('.btn-row-print').on('click', function(e) {
		e.stopPropagation();
		var name = $(this).data('name');
		if (name) {
			window.open('/printview?doctype=Maintenance%20Request&name=' + encodeURIComponent(name), '_blank');
		}
	});

	// Pagination buttons
	$('.page-btn, .page-nav-btn').on('click', function() {
		if ($(this).prop('disabled')) return;
		var page = parseInt($(this).data('page'));
		if (page && page !== current_page) {
			current_page = page;
			load_dashboard(dashboard_page, true);
			// Scroll to top of table
			$('.table-container')[0]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
		}
	});

	// Print report button
	$('#print-report-btn').on('click', function() {
		print_filtered_report();
	});
}

function filter_by_status(status) {
	selected_status = status || 'all';
	current_page = 1;
	load_dashboard(dashboard_page, true);
}

function search_requests(search) {
	// Now handled server-side via load_dashboard
}

// ============================================
// PRINT REPORT
// ============================================
function print_filtered_report() {
	var args = {
		branch: selected_branch || '',
		status: (selected_status && selected_status !== 'all') ? selected_status : '',
		search: search_text || '',
		from_date: from_date || '',
		to_date: to_date || ''
	};

	frappe.call({
		method: 'maintenance_request.maintenance_request.page.maintenance_dashboard.maintenance_dashboard.get_print_report_data',
		args: args,
		freeze: true,
		freeze_message: __('Preparing Report...'),
		callback: function(r) {
			if (r.message) {
				open_print_window(r.message);
			}
		}
	});
}

function open_print_window(data) {
	var status_labels = {
		'Pending': __('Pending'),
		'In Progress': __('In Progress'),
		'Completed': __('Completed'),
		'Not Repairable': __('Not Repairable'),
		'Ready for Delivery': __('Ready for Delivery'),
		'Delivered': __('Delivered')
	};

	var filter_desc = [];
	if (data.filters.branch && data.filters.branch !== __('All Branches')) {
		filter_desc.push(__('Branch') + ': ' + esc(data.filters.branch));
	}
	if (data.filters.status && data.filters.status !== __('All Statuses')) {
		filter_desc.push(__('Status') + ': ' + esc(status_labels[data.filters.status] || data.filters.status));
	}
	if (data.filters.search) {
		filter_desc.push(__('Search') + ': ' + esc(data.filters.search));
	}
	if (data.filters.from_date) {
		filter_desc.push(__('From Date') + ': ' + esc(latin_digits(frappe.datetime.str_to_user(data.filters.from_date))));
	}
	if (data.filters.to_date) {
		filter_desc.push(__('To Date') + ': ' + esc(latin_digits(frappe.datetime.str_to_user(data.filters.to_date))));
	}

	var rows_html = '';
	data.requests.forEach(function(req, idx) {
		rows_html += `
			<tr>
				<td style="text-align:center">${latin_digits(idx + 1)}</td>
					<td>${esc(req.name)}</td>
					<td>${esc(req.customer_name)}</td>
					<td>${esc(req.phone_number)}</td>
					<td>${esc(req.device_type)}${req.brand ? ' - ' + esc(req.brand) : ''}</td>
					<td>${esc(req.branch)}</td>
					<td style="text-align:center">${req.received_date ? latin_digits(frappe.datetime.str_to_user(req.received_date)) : ''}</td>
					<td style="text-align:center">${esc(status_labels[req.status] || req.status)}</td>
				<td style="text-align:right">${latin_digits(fmt_number(req.estimated_cost))}</td>
				<td style="text-align:right">${latin_digits(fmt_number(req.total_amount))}</td>
				<td style="text-align:right">${latin_digits(fmt_number(req.advance_paid))}</td>
				<td style="text-align:right">${latin_digits(fmt_number(req.outstanding_amount))}</td>
			</tr>
		`;
	});

	var print_html = `
		<!DOCTYPE html>
		<html dir="auto">
		<head>
			<meta charset="UTF-8">
			<title>${__('Maintenance Requests Report')}</title>
			<style>
				* { margin: 0; padding: 0; box-sizing: border-box; }
				body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #333; padding: 15px; direction: ltr; }
				[dir="rtl"] body { direction: rtl; }
				.report-header { text-align: center; margin-bottom: 15px; border-bottom: 2px solid #333; padding-bottom: 10px; }
				.report-header h1 { font-size: 18px; margin-bottom: 3px; }
				.report-header .company-name { font-size: 14px; color: #555; margin-bottom: 3px; }
				.report-header .report-date { font-size: 10px; color: #888; }
				.filters-info { background: #f5f5f5; padding: 6px 10px; border-radius: 4px; margin-bottom: 10px; font-size: 10px; color: #555; }
				table { width: 100%; border-collapse: collapse; margin-bottom: 15px; }
				th { background: #f0f0f0; padding: 6px 8px; text-align: left; font-size: 10px; font-weight: 700; border: 1px solid #ccc; white-space: nowrap; }
				td { padding: 5px 8px; border: 1px solid #ddd; font-size: 10px; }
				tr:nth-child(even) { background: #fafafa; }
				.summary-row { background: #e8e8e8 !important; font-weight: 700; }
				.summary-section { margin-top: 10px; display: flex; justify-content: flex-end; gap: 20px; }
				.summary-item { text-align: center; }
				.summary-item .label { font-size: 9px; color: #888; text-transform: uppercase; }
				.summary-item .value { font-size: 14px; font-weight: 700; }
				@media print {
					body { padding: 0; }
					@page { margin: 10mm; size: landscape; }
				}
			</style>
		</head>
		<body>
			<div class="report-header">
					${data.company_name ? '<div class="company-name">' + esc(data.company_name) + '</div>' : ''}
				<h1>${__('Maintenance Requests Report')}</h1>
				<div class="report-date">${__('Printed on')}: ${latin_digits(frappe.datetime.str_to_user(data.print_date))} | ${__('Total Records')}: ${latin_digits(data.summary.total_records)}</div>
			</div>
			${filter_desc.length > 0 ? '<div class="filters-info">' + __('Filters') + ': ' + filter_desc.join(' | ') + '</div>' : ''}
			<table>
				<thead>
					<tr>
						<th style="text-align:center">#</th>
						<th>${__('Request #')}</th>
						<th>${__('Customer')}</th>
						<th>${__('Phone')}</th>
						<th>${__('Device')}</th>
						<th>${__('Branch')}</th>
						<th style="text-align:center">${__('Date')}</th>
						<th style="text-align:center">${__('Status')}</th>
						<th style="text-align:right">${__('Estimated')}</th>
						<th style="text-align:right">${__('Total')}</th>
						<th style="text-align:right">${__('Paid')}</th>
						<th style="text-align:right">${__('Outstanding')}</th>
					</tr>
				</thead>
				<tbody>
					${rows_html}
					<tr class="summary-row">
						<td colspan="8" style="text-align:right; font-weight:700;">${__('Totals')}</td>
						<td style="text-align:right">${fmt_number(data.summary.total_estimated)}</td>
						<td style="text-align:right">${fmt_number(data.summary.total_amount)}</td>
						<td style="text-align:right">${fmt_number(data.summary.total_paid)}</td>
						<td style="text-align:right">${fmt_number(data.summary.total_outstanding)}</td>
					</tr>
				</tbody>
			</table>
		</body>
		</html>
	`;

	var print_window = window.open('', '_blank');
	if (print_window) {
		print_window.document.write(print_html);
		print_window.document.close();
		print_window.focus();
		setTimeout(function() {
			print_window.print();
		}, 500);
	} else {
		frappe.msgprint(__('Please allow popups for this site to print the report'));
	}
}

function get_request_barcode_value(request_name) {
	var digits = String(request_name || '').replace(/\D/g, '');
	if (!digits) return '00000';
	return digits.slice(-5).padStart(5, '0');
}

function code39_svg(value) {
	var patterns = {
		'0': 'nnnwwnwnn',
		'1': 'wnnwnnnnw',
		'2': 'nnwwnnnnw',
		'3': 'wnwwnnnnn',
		'4': 'nnnwwnnnw',
		'5': 'wnnwwnnnn',
		'6': 'nnwwwnnnn',
		'7': 'nnnwnnwnw',
		'8': 'wnnwnnwnn',
		'9': 'nnwwnnwnn',
		'*': 'nwnnwnwnn'
	};
	var encoded = '*' + String(value || '').replace(/\D/g, '') + '*';
	var narrow = 2;
	var wide = 5;
	var gap = narrow;
	var height = 46;
	var x = 0;
	var bars = '';

	encoded.split('').forEach(function(ch) {
		var pattern = patterns[ch];
		if (!pattern) return;
		for (var i = 0; i < pattern.length; i++) {
			var width = pattern[i] === 'w' ? wide : narrow;
			if (i % 2 === 0) {
				bars += '<rect x="' + x + '" y="0" width="' + width + '" height="' + height + '"></rect>';
			}
			x += width;
		}
		x += gap;
	});

	return '<svg class="label-barcode" viewBox="0 0 ' + x + ' ' + height + '" preserveAspectRatio="none" aria-label="' + esc_attr(value) + '">' + bars + '</svg>';
}

function print_device_label(data) {
	if (!data || !data.name) return;

	var barcode_value = get_request_barcode_value(data.name);
	var phone = data.phone_number || '';
	var branch = data.branch || '';
	var device = data.device_type || '';
	var brand = data.brand || '';
	var device_text = brand ? brand + ' ' + device : device;

	var label_html = `
		<!DOCTYPE html>
		<html dir="rtl">
		<head>
			<meta charset="UTF-8">
			<title>${esc(__('Device Label'))} ${esc(data.name)}</title>
			<style>
				@page { size: 50mm 25mm; margin: 0; }
				* { box-sizing: border-box; }
				html, body {
					width: 50mm;
					height: 25mm;
					margin: 0;
					padding: 0;
					background: #fff;
					color: #111;
					font-family: Arial, Tahoma, sans-serif;
				}
				.label {
					width: 50mm;
					height: 25mm;
					padding: 1.8mm 2.4mm 1.6mm;
					overflow: hidden;
					display: grid;
					grid-template-rows: 10.5mm 5mm 5.5mm;
					row-gap: 0.6mm;
				}
				.barcode-wrap {
					direction: ltr;
					width: 100%;
					height: 10.5mm;
					display: flex;
					justify-content: center;
					align-items: stretch;
				}
				.label-barcode {
					width: 42mm;
					height: 9.8mm;
					fill: #111;
				}
				.mid-row,
				.bottom-row {
					display: grid;
					grid-template-columns: 1fr 1fr;
					align-items: center;
					column-gap: 2mm;
					font-weight: 700;
					line-height: 1;
				}
				.phone {
					direction: ltr;
					text-align: left;
					font-size: 11pt;
					letter-spacing: 0.2px;
				}
				.device {
					text-align: right;
					font-size: 8pt;
					white-space: nowrap;
					overflow: hidden;
					text-overflow: ellipsis;
				}
				.branch {
					justify-self: start;
					border: 0.35mm solid #111;
					padding: 0.8mm 2mm;
					font-size: 8pt;
					line-height: 1;
					max-width: 25mm;
					white-space: nowrap;
					overflow: hidden;
					text-overflow: ellipsis;
				}
				.request-code {
					direction: ltr;
					text-align: right;
					font-size: 9pt;
					font-weight: 700;
				}
			</style>
		</head>
		<body>
			<div class="label">
				<div class="barcode-wrap">${code39_svg(barcode_value)}</div>
				<div class="mid-row">
					<div class="phone">${esc(phone)}</div>
					<div class="device">${esc(device_text)}</div>
				</div>
				<div class="bottom-row">
					<div class="branch">${esc(branch)}</div>
					<div class="request-code">${esc(barcode_value)}</div>
				</div>
			</div>
		</body>
		</html>
	`;

	var print_window = window.open('', '_blank');
	if (print_window) {
		print_window.document.write(label_html);
		print_window.document.close();
		print_window.focus();
		setTimeout(function() {
			print_window.print();
		}, 250);
	} else {
		frappe.msgprint(__('Please allow popups for this site to print the label'));
	}
}

function fmt_number(v) {
	return (parseFloat(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ============================================
// REQUEST DIALOG
// ============================================
var current_services = [];

function show_request_dialog(request_name = null) {
	$('.mr-dialog, #mr-dialog-style').remove();
	$('body').removeClass('modal-open');
	current_services = [];
	
	$('head').append(`
		<style id="mr-dialog-style">
			.mr-dialog{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(15,23,42,0.72);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);z-index:1050;display:flex;align-items:center;justify-content:center;padding:16px;animation:mrFadeIn 0.22s cubic-bezier(0.16,1,0.3,1)}
			@keyframes mrFadeIn{from{opacity:0;transform:scale(0.97)}to{opacity:1;transform:scale(1)}}
			.mr-dialog,.mr-dialog input,.mr-dialog select,.mr-dialog textarea{font-variant-numeric:tabular-nums;-webkit-locale:"en-US"}
			.mr-dialog input[type="date"],.mr-dialog input[type="number"],.mr-dialog .val,.mr-dialog .service-amount{direction:ltr;unicode-bidi:plaintext}
			.mr-dialog .dialog-box{background:#f8fafc;border-radius:16px;width:96%;max-width:1120px;max-height:92vh;overflow:hidden;box-shadow:0 25px 60px -15px rgba(15,23,42,0.45),0 0 0 1px rgba(255,255,255,0.1);position:relative;border:1px solid #e2e8f0;display:flex;flex-direction:column}
			.mr-dialog .dialog-header{padding:16px 24px;background:linear-gradient(135deg,#0f172a 0%,#1e1b4b 50%,#312e81 100%);display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(255,255,255,0.12)}
			.mr-dialog .dialog-title{color:#fff;font-size:16px;font-weight:800;margin:0;display:flex;align-items:center;gap:12px;letter-spacing:-0.2px}
			.mr-dialog .dialog-title .badge{background:rgba(255,255,255,0.14);backdrop-filter:blur(6px);padding:4px 12px;border-radius:7px;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;letter-spacing:0.5px;border:1px solid rgba(255,255,255,0.22);color:#e0e7ff}
			.mr-dialog .close-btn{width:32px;height:32px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.15);border-radius:8px;color:#fff;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.2s cubic-bezier(0.16,1,0.3,1)}
			.mr-dialog .close-btn:hover{background:rgba(239,68,68,0.9);border-color:rgba(239,68,68,1);transform:rotate(90deg)}
			.mr-dialog .dialog-body{padding:20px 24px;background:#f8fafc;overflow-y:auto;max-height:calc(92vh - 145px);flex:1}
			.mr-dialog .dialog-body::-webkit-scrollbar{width:6px}
			.mr-dialog .dialog-body::-webkit-scrollbar-track{background:#f1f5f9;border-radius:4px}
			.mr-dialog .dialog-body::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:4px}
			.mr-dialog .dialog-body::-webkit-scrollbar-thumb:hover{background:#94a3b8}
			.mr-dialog .dialog-footer{padding:14px 24px;background:#ffffff;border-top:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;border-radius:0 0 16px 16px;gap:10px;flex-wrap:wrap}
			.mr-dialog .row{display:grid;grid-template-columns:repeat(4,1fr);gap:14px 16px;background:#ffffff;padding:16px 18px;border-radius:12px;margin-bottom:14px;border:1px solid #e2e8f0;box-shadow:0 1px 3px rgba(15,23,42,0.02)}
			.mr-dialog .row.cols-3{grid-template-columns:repeat(3,1fr)}
			.mr-dialog .row.cols-2{grid-template-columns:repeat(2,1fr)}
			.mr-dialog .field{display:flex;flex-direction:column;position:relative}
			.mr-dialog .field.full{grid-column:1/-1}
			.mr-dialog .field label{font-size:12px;font-weight:700;color:#475569;margin-bottom:6px;display:flex;align-items:center;gap:4px}
			.mr-dialog .field label .req{color:#ef4444}
			.mr-dialog .field input,.mr-dialog .field textarea,.mr-dialog .field select{padding:9px 13px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:13px;transition:all 0.2s cubic-bezier(0.16,1,0.3,1);width:100%;box-sizing:border-box;background:#fff;color:#0f172a}
			.mr-dialog .field input:focus,.mr-dialog .field textarea:focus,.mr-dialog .field select:focus{outline:none;border-color:#6366f1;box-shadow:0 0 0 3.5px rgba(99,102,241,0.15);background:#fff}
			.mr-dialog .field textarea{min-height:76px;resize:vertical;line-height:1.55}
			.mr-dialog .btn{padding:8px 14px;border:1px solid transparent;border-radius:8px;font-size:12.5px;font-weight:700;cursor:pointer;transition:all 0.2s cubic-bezier(0.16,1,0.3,1);min-height:36px;display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap}
			.mr-dialog .btn:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(15,23,42,0.1)}
			.mr-dialog .btn:active{transform:translateY(0)}
			.mr-dialog .btn-primary{background:linear-gradient(135deg,#4f46e5 0%,#6366f1 100%);color:#fff;border-color:transparent}
			.mr-dialog .btn-primary:hover{background:linear-gradient(135deg,#4338ca 0%,#4f46e5 100%)}
			.mr-dialog .btn-secondary{background:#64748b;color:#fff;border-color:transparent}
			.mr-dialog .btn-secondary:hover{background:#475569}
			.mr-dialog .btn-success{background:linear-gradient(135deg,#059669 0%,#10b981 100%);color:#fff;border-color:transparent}
			.mr-dialog .btn-success:hover{background:linear-gradient(135deg,#047857 0%,#059669 100%)}
			.mr-dialog .btn-info{background:linear-gradient(135deg,#2563eb 0%,#3b82f6 100%);color:#fff;border-color:transparent}
			.mr-dialog .btn-info:hover{background:linear-gradient(135deg,#1d4ed8 0%,#2563eb 100%)}
			.mr-dialog .btn-warning{background:linear-gradient(135deg,#d97706 0%,#f59e0b 100%);color:#fff;border-color:transparent}
			.mr-dialog .btn-warning:hover{background:linear-gradient(135deg,#b45309 0%,#d97706 100%)}
			.mr-dialog .btn-danger{background:linear-gradient(135deg,#dc2626 0%,#ef4444 100%);color:#fff;border-color:transparent}
			.mr-dialog .btn-danger:hover{background:linear-gradient(135deg,#b91c1c 0%,#dc2626 100%)}
			.mr-dialog .btn-whatsapp{background:linear-gradient(135deg,#059669 0%,#22c55e 100%);color:#fff;border-color:transparent}
			.mr-dialog .btn-whatsapp:hover{background:linear-gradient(135deg,#047857 0%,#16a34a 100%)}
			.mr-dialog .btn-invoice{background:linear-gradient(135deg,#0f766e 0%,#14b8a6 100%);color:#fff;border-color:transparent}
			.mr-dialog .btn-invoice:hover{background:linear-gradient(135deg,#115e59 0%,#0f766e 100%)}
			.mr-dialog .btn-light{background:#f8fafc;color:#475569;border-color:#e2e8f0}
			.mr-dialog .btn-light:hover{background:#f1f5f9;color:#1e293b;border-color:#cbd5e1}
			.mr-dialog .btn:disabled{opacity:0.45;cursor:not-allowed;transform:none;box-shadow:none}
			.mr-dialog .btn-sm{padding:5px 11px;font-size:11.5px;min-height:30px}
			
			/* Financials KPI Cards */
			.mr-dialog .totals{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:14px;padding:16px 18px;background:#fff;border-radius:12px;border:1px solid #e2e8f0;box-shadow:0 1px 3px rgba(15,23,42,0.02)}
			.mr-dialog .totals .item{text-align:center;padding:12px 10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;transition:all 0.2s}
			.mr-dialog .totals .item:hover{background:#f1f5f9;border-color:#cbd5e1}
			.mr-dialog .totals .item label{font-size:11px;font-weight:700;color:#64748b;display:block;text-transform:uppercase;margin-bottom:6px;letter-spacing:0.3px}
			.mr-dialog .totals .item .val{font-size:18px;font-weight:800;color:#312e81}
			.mr-dialog .totals .item .val.red{color:#dc2626}
			.mr-dialog .totals .item .val.green{color:#059669}
			.mr-dialog .left-btns,.mr-dialog .right-btns,.mr-dialog .wizard-nav-btns{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
			
			/* Services Table */
			.mr-dialog .services-section{background:#fff;padding:18px 20px;border-radius:12px;margin-bottom:14px;border:1px solid #e2e8f0;box-shadow:0 1px 3px rgba(15,23,42,0.02)}
			.mr-dialog .services-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
			.mr-dialog .services-header h4{margin:0;font-size:14.5px;font-weight:800;color:#0f172a}
			.mr-dialog .services-table{width:100%;border-collapse:separate;border-spacing:0;font-size:12.5px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden}
			.mr-dialog .services-table th{background:#f8fafc;padding:10px 12px;text-align:right;font-weight:800;border-bottom:1.5px solid #e2e8f0;color:#475569}
			.mr-dialog .services-table td{padding:8px 10px;border-bottom:1px solid #f1f5f9;vertical-align:middle}
			.mr-dialog .services-table tr:last-child td{border-bottom:none}
			.mr-dialog .services-table input,.mr-dialog .services-table select{padding:7px 9px;font-size:12px;border:1px solid #d9e0e8;border-radius:6px}
			.mr-dialog .services-table .col-service{width:40%}
			.mr-dialog .services-table .col-qty{width:15%}
			.mr-dialog .services-table .col-rate{width:20%}
			.mr-dialog .services-table .col-amount{width:15%;text-align:center;font-weight:800;color:#4338ca}
			.mr-dialog .services-table .col-action{width:10%;text-align:center}
			.mr-dialog .no-services{text-align:center;padding:18px;color:#94a3b8;font-size:13px}
			.mr-dialog .delete-service-row{width:28px;height:28px;padding:0;display:inline-flex;align-items:center;justify-content:center;border-radius:6px}

			/* Searchable Dropdown */
			.mr-dialog .searchable-dropdown{position:relative;width:100%;flex:1;min-width:0}
			.mr-dialog .searchable-dropdown .sd-display{padding:9px 12px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:13px;width:100%;box-sizing:border-box;cursor:pointer;background:#fff;display:flex;justify-content:space-between;align-items:center;min-height:38px;transition:all 0.2s}
			.mr-dialog .searchable-dropdown .sd-display:hover{border-color:#cbd5e1}
			.mr-dialog .searchable-dropdown .sd-display.focused{border-color:#6366f1;box-shadow:0 0 0 3.5px rgba(99,102,241,0.15)}
			.mr-dialog .searchable-dropdown .sd-display .sd-text{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#0f172a}
			.mr-dialog .searchable-dropdown .sd-display .sd-text.placeholder{color:#94a3b8}
			.mr-dialog .searchable-dropdown .sd-panel{position:absolute;top:100%;left:0;right:0;background:#fff;border:1px solid #e2e8f0;border-radius:8px;box-shadow:0 12px 28px rgba(15,23,42,0.15);z-index:3000;display:none;margin-top:4px;max-height:250px;overflow:hidden;flex-direction:column}
			.mr-dialog .searchable-dropdown .sd-panel.open{display:flex}
			.mr-dialog .searchable-dropdown .sd-search{padding:8px 10px;border-bottom:1px solid #f1f5f9;background:#f8fafc}
			.mr-dialog .searchable-dropdown .sd-search input{width:100%;padding:7px 10px;border:1px solid #e2e8f0;border-radius:6px;font-size:12.5px;outline:none}
			.mr-dialog .searchable-dropdown .sd-options{overflow-y:auto;max-height:200px}
			.mr-dialog .searchable-dropdown .sd-option{padding:9px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid #f8fafc;transition:background 0.15s}
			.mr-dialog .searchable-dropdown .sd-option:hover{background:#f5f3ff;color:#4f46e5}
			.mr-dialog .searchable-dropdown .sd-option.selected{background:#4f46e5;color:#fff}

			/* Wizard Timeline Tabs */
			.mr-dialog .wizard-tabs{display:flex;align-items:center;justify-content:center;padding:14px 20px;margin-bottom:14px;background:#ffffff;border-radius:12px;border:1px solid #e2e8f0;box-shadow:0 1px 3px rgba(15,23,42,0.02)}
			.mr-dialog .wizard-tab{display:flex;flex-direction:column;align-items:center;gap:6px;cursor:pointer;padding:6px 12px;border-radius:8px;transition:all 0.2s ease;min-width:80px}
			.mr-dialog .wizard-tab:hover:not(.disabled){background:#f5f3ff}
			.mr-dialog .wizard-tab-indicator{width:38px;height:38px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:13px;border:1.5px solid #e2e8f0;background:#f8fafc;color:#64748b;transition:all 0.25s cubic-bezier(0.4,0,0.2,1)}
			.mr-dialog .wizard-tab-label{font-size:12px;font-weight:700;color:#64748b;white-space:nowrap;transition:color 0.2s ease}
			.mr-dialog .wizard-tab-check{display:none}
			.mr-dialog .wizard-tab-icon{display:inline-flex}
			.mr-dialog .wizard-tab.active .wizard-tab-indicator{border-color:#6366f1;background:linear-gradient(135deg,#4f46e5 0%,#6366f1 100%);color:#ffffff;box-shadow:0 4px 14px rgba(79,70,229,0.35);transform:scale(1.06)}
			.mr-dialog .wizard-tab.active .wizard-tab-label{color:#4f46e5;font-weight:800}
			.mr-dialog .wizard-tab.completed .wizard-tab-indicator{border-color:#10b981;background:linear-gradient(135deg,#059669 0%,#10b981 100%);color:#ffffff;box-shadow:0 4px 12px rgba(16,185,129,0.25)}
			.mr-dialog .wizard-tab.completed .wizard-tab-label{color:#059669}
			.mr-dialog .wizard-tab.completed .wizard-tab-icon{display:none}
			.mr-dialog .wizard-tab.completed .wizard-tab-check{display:block}
			.mr-dialog .wizard-tab.disabled{cursor:not-allowed;opacity:0.4}
			.mr-dialog .wizard-tab-connector{flex:1;height:3px;background:#e2e8f0;min-width:20px;max-width:60px;margin:0 -4px 22px;border-radius:2px;transition:background 0.3s ease}
			.mr-dialog .wizard-tab-connector.completed{background:linear-gradient(90deg,#10b981 0%,#34d399 100%)}
			.mr-dialog .wizard-current-step{display:flex;align-items:center;justify-content:center;gap:8px;background:linear-gradient(135deg,#f5f3ff 0%,#ede9fe 100%);border:1px solid #ddd6fe;color:#5b21b6;border-radius:10px;padding:9px 18px;margin:0 0 14px;font-size:13px;font-weight:700}
			.mr-dialog .wizard-current-step-value{color:#4338ca;font-weight:800}
			.mr-dialog .wizard-step-panel{display:none}
			.mr-dialog .wizard-step-panel.active{display:block}
			.mr-dialog .status-badge{display:inline-flex;align-items:center;gap:4px;padding:4px 12px;border-radius:7px;font-size:12px;font-weight:800}
			.mr-dialog .status-badge.pending{background:#fff7ed;color:#c2410c;border:1px solid #ffedd5}
			.mr-dialog .status-badge.in-progress{background:#eff6ff;color:#1d4ed8;border:1px solid #dbeafe}
			.mr-dialog .status-badge.completed{background:#ecfdf5;color:#047857;border:1px solid #d1fae5}
			.mr-dialog .status-badge.not-repairable{background:#fef2f2;color:#b91c1c;border:1px solid #fee2e2}
			.mr-dialog .status-badge.ready-for-delivery{background:#faf5ff;color:#7e22ce;border:1px solid #f3e8ff}
			.mr-dialog .status-badge.delivered{background:#f0fdfa;color:#0f766e;border:1px solid #ccfbf1}
			@media (max-width: 900px){
				.mr-dialog{padding:8px}
				.mr-dialog .dialog-box{width:100%;max-height:96vh}
				.mr-dialog .row{grid-template-columns:repeat(2,1fr)}
				.mr-dialog .dialog-footer{flex-direction:column;align-items:stretch}
				.mr-dialog .wizard-tabs{overflow-x:auto;justify-content:flex-start}
			}
			@media (max-width: 560px){
				.mr-dialog .row{grid-template-columns:1fr}
				.mr-dialog .totals{grid-template-columns:1fr 1fr}
			}
		</style>
		`);

		if (request_name) {
			render_request_loading_dialog(request_name);
			frappe.call({
				method: 'maintenance_request.maintenance_request.page.maintenance_dashboard.maintenance_dashboard.get_request_details',
				args: { request_name: request_name },
			callback: function(r) { 
				if (r.message) {
					current_services = r.message.services || [];
					render_dialog(r.message); 
				}
			}
		});
	} else {
		render_dialog(null);
		}
	}

	function render_request_loading_dialog(request_name) {
		var html = `
			<div class="mr-dialog">
				<div class="dialog-box">
					<div class="dialog-header">
						<h5 class="dialog-title">${__('Loading')} <span class="badge">${esc(request_name)}</span></h5>
						<button class="close-btn" id="close_btn">&times;</button>
					</div>
					<div class="dialog-body" style="min-height:260px;display:flex;align-items:center;justify-content:center;background:#fff">
						<div class="text-center">
							<div class="spinner-border text-primary"></div>
							<div style="margin-top:12px;color:#666;font-size:13px">${__('Loading')}...</div>
						</div>
					</div>
				</div>
			</div>
		`;
		$('body').append(html).addClass('modal-open');
		$('#close_btn').on('click', close_dialog);
	}

	function render_dialog(data) {
		$('.mr-dialog').remove();
		const is_edit = data !== null;
	const has_invoice = is_edit && data.sales_invoice;
	const title = is_edit ? __('Edit Request') : __('New Request');
	const save_txt = is_edit ? __('Save') : __('Create');
	const request_name = is_edit ? data.name : '';
	const status = is_edit ? (data.status || 'Pending') : 'Pending';
	const is_not_repairable_locked = is_edit && status === 'Not Repairable' && !can_manage_locked_request();

	// Status badge helper
	var status_css = status.toLowerCase().replace(/ /g, '-');
	var status_badge = is_edit ? `<span class="status-badge ${status_css}">${esc(__(status))}</span>` : '';

	let html = `
		<div class="mr-dialog">
			<div class="dialog-box">
				<div class="dialog-header">
						<h5 class="dialog-title">${title} ${is_edit ? `<span class="badge">${esc(data.name)}</span>` : ''} ${status_badge}</h5>
					<button class="close-btn" id="close_btn">&times;</button>
				</div>
				<div class="dialog-body">
						<input type="hidden" id="mr_name" value="${esc_attr(request_name)}">
						<input type="hidden" id="mr_status" value="${esc_attr(status)}">
					${has_invoice ? `<div style="background:#fff3e0;padding:8px 12px;border-radius:6px;margin-bottom:8px;font-size:12px;color:#e65100;display:flex;align-items:center;gap:8px">
						<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
							${__('This request is locked because invoice {0} has been issued.', ['<a href="/app/sales-invoice/' + esc_attr(data.sales_invoice) + '" onclick="event.stopPropagation()">' + esc(data.sales_invoice) + '</a>'])}
					</div>` : ''}
					${is_not_repairable_locked ? `<div style="background:#ffebee;padding:8px 12px;border-radius:6px;margin-bottom:8px;font-size:12px;color:#b71c1c;display:flex;align-items:center;gap:8px">
						<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
						${__('This request is locked because it is Not Repairable. Only a maintenance manager can edit it.')}
					</div>` : ''}

					${build_wizard_tabs_html(status, is_edit)}
					<div class="wizard-current-step">
						<span>${__('Current Step')}</span>
						<span class="wizard-current-step-value"></span>
					</div>

					<div class="wizard-step-content">
						<!-- STEP 1: Intake -->
						<div class="wizard-step-panel active" data-step="intake">
							<div id="mr_history_banner_container"></div>
							<div class="row">
								<div class="field">
									<label>${__('Customer')} <span class="req">*</span></label>
									<div style="display: flex; gap: 5px;">
										<select id="mr_customer" style="flex: 1;"><option value="">${__('Select')}</option></select>
										<button type="button" class="btn btn-sm btn-success" id="add_customer_btn" title="${__('Add New Customer')}" style="padding: 8px 12px;">+</button>
									</div>
								</div>
								<div class="field">
									<label>${__('Phone')}</label>
										<input type="text" id="mr_phone_number" value="${is_edit ? esc_attr(data.phone_number) : ''}">
								</div>
								<div class="field">
									<label>${__('Phone 2')}</label>
										<input type="text" id="mr_secondary_phone" value="${is_edit ? esc_attr(data.secondary_phone) : ''}">
								</div>
								<div class="field">
									<label>${__('Intake Receiver')} <span class="req">*</span></label>
										<input type="text" id="mr_intake_receiver" value="${is_edit ? esc_attr(data.intake_receiver) : esc_attr(frappe.session.user_fullname)}" readonly style="background:#f0f0f0;cursor:not-allowed">
								</div>
							</div>
							<div class="row">
								<div class="field">
									<label>${__('Branch')} <span class="req">*</span></label>
									<select id="mr_branch"><option value="">${__('Select')}</option></select>
								</div>
								<div class="field">
									<label>${__('Device')} <span class="req">*</span></label>
									<div style="display: flex; gap: 5px;">
										<select id="mr_device_type" style="flex: 1;"><option value="">${__('Select')}</option></select>
										<button type="button" class="btn btn-sm btn-success" id="add_device_type_btn" title="${__('Add New Device Type')}" style="padding: 8px 12px;">+</button>
									</div>
								</div>
								<div class="field">
									<label>${__('Brand')} <span class="req">*</span></label>
									<div style="display: flex; gap: 5px;">
										<select id="mr_brand" style="flex: 1;"><option value="">${__('Select')}</option></select>
										<button type="button" class="btn btn-sm btn-success" id="add_brand_btn" title="${__('Add New Brand')}" style="padding: 8px 12px;">+</button>
									</div>
								</div>
								<div class="field">
									<label>${__('Model')}</label>
										<input type="text" id="mr_model" value="${is_edit ? esc_attr(data.model) : ''}">
								</div>
							</div>
							<div class="row">
								<div class="field">
									<label>${__('Serial')}</label>
										<input type="text" id="mr_serial_number" value="${is_edit ? esc_attr(data.serial_number) : ''}">
								</div>
								<div class="field">
									<label>${__('Condition')}</label>
										<input type="text" id="mr_device_condition" value="${is_edit ? esc_attr(data.device_condition) : ''}">
								</div>
								<div class="field">
									<label>${__('Received')}</label>
										<input type="date" id="mr_received_date" value="${is_edit ? esc_attr(data.received_date) : frappe.datetime.get_today()}">
								</div>
								<div class="field">
									<label>${__('Expected Delivery')} <span class="req">*</span></label>
										<input type="date" id="mr_expected_delivery_date" value="${is_edit ? esc_attr(data.expected_delivery_date) : ''}">
								</div>
							</div>
							<div class="row">
								<div class="field full">
									<label>${__('Problem')} <span class="req">*</span></label>
										<textarea id="mr_problem_description" rows="3">${is_edit ? esc(data.problem_description) : ''}</textarea>
								</div>
							</div>
						</div>

						${is_edit ? `
						<!-- STEP 2: Inspection -->
						<div class="wizard-step-panel" data-step="inspection">
							<div class="row cols-2">
								<div class="field">
									<label>${__('Technician')}</label>
									<select id="mr_technician"><option value="">${__('Select')}</option></select>
								</div>
								<div class="field">
									<label>${__('Inspection Decision')}</label>
									<select id="mr_inspection_decision">
										<option value="">${__('Select')}</option>
										<option value="Repairable" ${data.inspection_decision==='Repairable'?'selected':''}>${__('Repairable')}</option>
										<option value="Not Repairable" ${data.inspection_decision==='Not Repairable'?'selected':''}>${__('Not Repairable')}</option>
									</select>
								</div>
							</div>
							<div class="row" id="diagnosis_field" style="${data.inspection_decision==='Repairable'?'':'display:none'}">
								<div class="field full">
									<label>${__('Diagnosis')}</label>
										<textarea id="mr_diagnosis" rows="3">${esc(data.diagnosis)}</textarea>
								</div>
							</div>
							<div class="row" id="repair_notes_field" style="${data.inspection_decision==='Repairable'?'':'display:none'}">
								<div class="field full">
									<label>${__('Repair Notes')}</label>
										<textarea id="mr_repair_notes" rows="3">${esc(data.repair_notes)}</textarea>
								</div>
							</div>
							<div class="row" id="not_repairable_reason_field" style="${data.inspection_decision==='Not Repairable'?'':'display:none'}">
								<div class="field full">
									<label>${__('Reason (Not Repairable)')}</label>
										<textarea id="mr_not_repairable_reason" rows="3">${esc(data.not_repairable_reason)}</textarea>
								</div>
							</div>
						</div>

						<!-- STEP 3: Services -->
						<div class="wizard-step-panel" data-step="services">
							<div class="services-section">
								<div class="services-header">
									<h4>${__('Services')}</h4>
									<button class="btn btn-success btn-sm" id="add_service_btn">+ ${__('Add Service')}</button>
								</div>
								<table class="services-table">
									<thead>
										<tr>
											<th class="col-service">${__('Service')}</th>
											<th class="col-qty">${__('Qty')}</th>
											<th class="col-rate">${__('Rate')}</th>
											<th class="col-amount">${__('Amount')}</th>
											<th class="col-action"></th>
										</tr>
									</thead>
									<tbody id="services_tbody">
										${render_services_rows()}
									</tbody>
								</table>
							</div>
						</div>

						<!-- STEP 4: Financials -->
						<div class="wizard-step-panel" data-step="financials">
							<div class="row cols-2">
								<div class="field">
									<label>${__('Estimated Cost')}</label>
										<input type="number" id="mr_estimated_cost" value="${esc_attr(data.estimated_cost||0)}" step="0.01">
								</div>
								<div class="field">
									<label>${__('Advance Paid')}</label>
										<input type="number" id="mr_advance_paid" value="${esc_attr(data.advance_paid||0)}" step="0.01">
								</div>
							</div>
							<div class="totals">
								<div class="item"><label>${__('Estimated')}</label><div class="val green">${fmt(data.estimated_cost)}</div></div>
								<div class="item"><label>${__('Total')}</label><div class="val" id="total_display">${fmt(data.total_amount)}</div></div>
								<div class="item"><label>${__('Paid')}</label><div class="val">${fmt(data.advance_paid)}</div></div>
								<div class="item"><label>${__('Due')}</label><div class="val red" id="due_display">${fmt(data.outstanding_amount)}</div></div>
							</div>
						</div>

						<!-- STEP 5: Delivery -->
						<div class="wizard-step-panel" data-step="delivery">
							<div class="row">
								<div class="field">
									<label>${__('Actual Delivery Date')}</label>
										<input type="date" id="mr_actual_delivery_date" value="${esc_attr(data.actual_delivery_date)}">
								</div>
								<div class="field">
									<label>${__('Delivery Receiver')}</label>
										<input type="text" id="mr_delivery_receiver" value="${esc_attr(data.delivery_receiver)}" readonly style="background:#f0f0f0;cursor:not-allowed">
								</div>
								<div class="field">
									<label>${__('Warranty Days')}</label>
										<input type="number" id="mr_warranty_days" value="${esc_attr(data.warranty_days||0)}">
								</div>
								<div class="field">
									<label>${__('Warranty Terms')}</label>
										<input type="text" id="mr_warranty_terms" value="${esc_attr(data.warranty_terms)}">
								</div>
							</div>
						</div>
						` : ''}
					</div>
				</div>
				<div class="dialog-footer">
					<div class="left-btns">
						${is_edit ? `
							<button class="btn btn-info" id="print_btn" data-name="${esc_attr(data.name)}">
								<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="6 9 6 2 18 2 18 9"></polyline><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect x="6" y="14" width="12" height="8"></rect></svg>
								${__('Print')}
							</button>
							<button class="btn btn-warning" id="label_btn" data-name="${esc_attr(data.name)}">
								<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line></svg>
								${__('Device Label')}
							</button>
							<button class="btn btn-whatsapp" id="whatsapp_btn" data-name="${esc_attr(data.name)}">
								<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
								${__('WhatsApp')}
							</button>
							${!data.sales_invoice && !is_not_repairable_locked ? `
								<button class="btn btn-invoice" id="invoice_btn" data-name="${esc_attr(data.name)}">
									<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
									${__('Invoice')}
								</button>
							` : ''}
							${!is_not_repairable_locked ? render_status_buttons(data.status, data.name) : ''}
						` : ''}
					</div>
					<div class="wizard-nav-btns">
						<button class="btn btn-light" id="wizard_prev_btn" type="button">
							<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="9 18 15 12 9 6"></polyline></svg>
							${__('Previous')}
						</button>
						<button class="btn btn-light" id="wizard_next_btn" type="button">
							${__('Next')}
							<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="15 18 9 12 15 6"></polyline></svg>
						</button>
					</div>
					<div class="right-btns">
						<button class="btn btn-secondary" id="cancel_btn">${__('Cancel')}</button>
						${!has_invoice && !is_not_repairable_locked ? `
							<button class="btn btn-primary" id="save_btn">
								<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>
								${save_txt}
							</button>
						` : ''}
					</div>
				</div>
			</div>
		</div>
	`;

	$('body').append(html);
	$('body').addClass('modal-open');

	load_select_options(is_edit ? data : null);

	// Initialize searchable dropdowns (must be after options are loaded)
	init_searchable_dropdowns();

	// Apply stage locking for existing requests
	if (is_edit && !has_invoice) {
		apply_dialog_stage_locking(data.status);
		update_searchable_disabled();
	}

	// Lock all fields if invoice exists (except delivery fields)
	if (has_invoice) {
		$('.mr-dialog').data('invoice-locked', true);
		$('.mr-dialog input, .mr-dialog select, .mr-dialog textarea').prop('disabled', true);
		$('.mr-dialog #add_customer_btn, .mr-dialog #add_brand_btn, .mr-dialog #add_device_type_btn, .mr-dialog #add_service_btn').hide();
		$('.mr-dialog .delete-service-row').hide();
		// Allow delivery-related changes
		$('#mr_actual_delivery_date, #mr_delivery_receiver, #mr_warranty_days').prop('disabled', false);
		// Disable all searchable dropdowns
		update_searchable_disabled();
	}

	if (is_not_repairable_locked) {
		$('.mr-dialog').data('not-repairable-locked', true);
		$('.mr-dialog input, .mr-dialog select, .mr-dialog textarea').prop('disabled', true).css('background', '#f0f0f0');
		$('.mr-dialog #add_customer_btn, .mr-dialog #add_brand_btn, .mr-dialog #add_device_type_btn, .mr-dialog #add_service_btn').hide();
		$('.mr-dialog .delete-service-row').hide();
		update_searchable_disabled();
	}

	// Auto-select the correct wizard step based on status
	if (is_edit) {
		switch_wizard_step(get_auto_step(data.status));
	} else {
		switch_wizard_step('intake');
	}

	if (!is_edit) {
		frappe.call({
			method: 'maintenance_request.maintenance_request.doctype.maintenance_request.maintenance_request.get_user_branch',
			callback: function(r) { if (r.message) $('#mr_branch').val(r.message); }
		});
	}

	// ── Events ────────────────────────────────────────────────────────
	$('#close_btn, #cancel_btn').on('click', close_dialog);
	$('.mr-dialog').on('click', function(e) { if ($(e.target).hasClass('mr-dialog')) close_dialog(); });
	$('#save_btn').on('click', function() { is_edit ? update_request() : create_request(); });

	// Wizard tab navigation
	$('.mr-dialog .wizard-tab').on('click', function() {
		var $tab = $(this);
		if ($tab.hasClass('disabled')) return;
		switch_wizard_step($tab.data('step'));
	});
	$('#wizard_prev_btn').on('click', function() {
		move_wizard_step(-1);
	});
	$('#wizard_next_btn').on('click', function() {
		move_wizard_step(1);
	});

	// Add Brand button
	$('#add_brand_btn').on('click', function() {
		show_add_brand_dialog();
	});

	// Add Device Type button
	$('#add_device_type_btn').on('click', function() {
		show_add_device_type_dialog();
	});

	// Add Customer button
	$('#add_customer_btn').on('click', function() {
		show_add_customer_dialog();
	});

	// Customer change - always fetch and fill phone & check history
	$('#mr_customer').on('change', function() {
		var customer = $(this).val();
		if (customer) {
			frappe.call({
				method: 'maintenance_request.maintenance_request.doctype.maintenance_request.maintenance_request.get_customer_contact_info',
				args: { customer: customer },
				callback: function(r) {
					if (r.message) {
						if (r.message.phone) {
							$('#mr_phone_number').val(r.message.phone);
						}
						if (r.message.secondary_phone) {
							$('#mr_secondary_phone').val(r.message.secondary_phone);
						}
					}
					trigger_history_and_warranty_check(data ? data.name : null);
				}
			});
		} else {
			trigger_history_and_warranty_check(data ? data.name : null);
		}
	});

	// Serial number change/blur - check history and warranty
	$('#mr_serial_number').on('blur change', function() {
		trigger_history_and_warranty_check(data ? data.name : null);
	});

	// Initial history check if editing or customer/serial present
	if (is_edit && (data.serial_number || data.customer || data.phone_number)) {
		setTimeout(function() {
			trigger_history_and_warranty_check(data.name);
		}, 300);
	}

	// Inspection decision change - toggle fields
	$('#mr_inspection_decision').on('change', function() {
		var decision = $(this).val();
		$('#diagnosis_field').toggle(decision === 'Repairable');
		$('#repair_notes_field').toggle(decision === 'Repairable');
		$('#not_repairable_reason_field').toggle(decision === 'Not Repairable');
	});

	// Status change buttons
	$('.status-change-btn').on('click', function() {
		var new_status = $(this).data('status');
		var req_name = $(this).data('name');

		// Auto-set delivery_receiver and actual_delivery_date when transitioning to Delivered
		if (new_status === 'Delivered') {
			if (!$('#mr_delivery_receiver').val()) {
				$('#mr_delivery_receiver').val(frappe.session.user_fullname);
			}
			if (!$('#mr_actual_delivery_date').val()) {
				$('#mr_actual_delivery_date').val(frappe.datetime.get_today());
			}
		}

		var errors = validate_status_transition(new_status);
		if (errors.length > 0) {
			frappe.msgprint({
				title: __('Missing Required Fields'),
				message: errors.join('<br>'),
				indicator: 'red'
			});
			return;
		}
		frappe.call({
			method: 'maintenance_request.maintenance_request.page.maintenance_dashboard.maintenance_dashboard.update_status',
			args: { request_name: req_name, new_status: new_status },
			freeze: true,
			freeze_message: __('Updating status...'),
			callback: function(r) {
				if (r.message && r.message.success) {
					close_dialog();
					frappe.show_alert({ message: __('Status updated to {0}', [new_status]), indicator: 'green' });
					load_dashboard(dashboard_page);
				}
			}
		});
	});

		$('#print_btn').on('click', function() {
			var name = $(this).data('name');
			if (name) {
				window.open('/printview?doctype=Maintenance%20Request&name=' + encodeURIComponent(name), '_blank');
			}
		});

		$('#label_btn').on('click', function() {
			print_thermal_sticker(data ? data.name : null);
		});

		$('#whatsapp_btn').on('click', function() {
			open_whatsapp_share_dialog(data ? data.name : null);
		});

	$('#invoice_btn').on('click', function() {
		var name = $(this).data('name');
		if (current_services.length === 0) {
			frappe.msgprint(__('Please add services before creating invoice'));
			return;
		}
		if (name) {
			frappe.call({
				method: 'maintenance_request.maintenance_request.doctype.maintenance_request.maintenance_request.create_sales_invoice',
				args: { maintenance_request: name },
				freeze: true,
				freeze_message: __('Creating Invoice...'),
				callback: function(r) {
					if (r.message) {
						close_dialog();
						frappe.set_route('Form', 'Sales Invoice', r.message);
					}
				}
			});
		}
	});

	// Add Service button
	$('#add_service_btn').on('click', function() {
		add_service_row();
	});

	// Delete service row - using event delegation
	$('#services_tbody').on('click', '.delete-service-row', function() {
		var idx = $(this).data('idx');
		current_services.splice(idx, 1);
		refresh_services_table();
	});

	// Update amount on qty/rate change
	$('#services_tbody').on('change', '.service-qty, .service-rate', function() {
		var $row = $(this).closest('tr');
		var idx = $row.data('idx');
		var qty = parseFloat($row.find('.service-qty').val()) || 0;
		var rate = parseFloat($row.find('.service-rate').val()) || 0;
		var amount = qty * rate;

		current_services[idx].qty = qty;
		current_services[idx].rate = rate;
		current_services[idx].amount = amount;

		$row.find('.service-amount').text(fmt(amount));
		update_totals();
	});

		// Update service item
		$('#services_tbody').on('change', '.service-item', function() {
			update_service_item($(this), $(this).val());
		});
}

function render_services_rows() {
	if (current_services.length === 0) {
		return `<tr class="no-services-row"><td colspan="5" class="no-services">${__('No services added yet')}</td></tr>`;
	}
	
	let html = '';
	current_services.forEach((service, idx) => {
		html += `
				<tr data-idx="${idx}">
					<td><select class="service-item" style="width:100%" data-idx="${idx}"><option value="">${__('Select')}</option></select></td>
					<td><input type="number" class="service-qty" value="${esc_attr(service.qty || 1)}" min="1" style="width:100%"></td>
					<td><input type="number" class="service-rate" value="${esc_attr(service.rate || 0)}" step="0.01" style="width:100%"></td>
				<td class="service-amount">${fmt(service.amount || 0)}</td>
				<td><button class="btn btn-danger btn-sm delete-service-row" data-idx="${idx}" title="${__('Delete')}"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button></td>
			</tr>
		`;
	});
	return html;
}

function add_service_row() {
	current_services.push({
		service_item: '',
		qty: 1,
		rate: 0,
		amount: 0
	});
	refresh_services_table();
}

	function refresh_services_table() {
		$('#services_tbody').html(render_services_rows());
		load_items_options();
		// Make each service-item select searchable
		$('#services_tbody .service-item').each(function() {
			var $sel = $(this);
			if (!$sel.data('sd-init')) {
				make_searchable($sel, {
					placeholder: __('Select Service'),
					onChange: function(value) {
						update_service_item($sel, value);
					}
				});
			}
		});
		update_totals();
	}

	function update_service_item($select, item) {
		var $row = $select.closest('tr');
		var idx = parseInt($row.data('idx'), 10);
		if (!current_services[idx]) return;

		current_services[idx].service_item = item || '';
		if (!item) {
			current_services[idx].rate = 0;
			current_services[idx].amount = 0;
			$row.find('.service-rate').val(0);
			$row.find('.service-amount').text(fmt(0));
			update_totals();
			return;
		}

		get_service_rate_client(item, function(rate) {
			$row.find('.service-rate').val(rate).trigger('change');
			if (!rate) {
				frappe.show_alert({
					message: __('No price found for selected item'),
					indicator: 'orange'
				});
			}
		});
	}

	function get_service_rate_client(item, done) {
		frappe.call({
			method: 'frappe.client.get_list',
			args: {
				doctype: 'Item Price',
				filters: {
					item_code: item,
					selling: 1
				},
				fields: ['price_list_rate'],
				order_by: 'valid_from desc, modified desc',
				limit_page_length: 1
			},
			callback: function(r) {
				var price = r.message && r.message.length ? parseFloat(r.message[0].price_list_rate) || 0 : 0;
				if (price > 0) {
					done(price);
					return;
				}

				frappe.call({
					method: 'frappe.client.get_value',
					args: {
						doctype: 'Item',
						filters: { name: item },
						fieldname: ['standard_rate', 'valuation_rate', 'last_purchase_rate']
					},
					callback: function(item_response) {
						var row = item_response.message || {};
						var fallback = parseFloat(row.standard_rate) || parseFloat(row.valuation_rate) || parseFloat(row.last_purchase_rate) || 0;
						done(fallback);
					}
				});
			}
		});
	}

function load_items_options() {
	frappe.call({
		method: 'frappe.client.get_list',
		args: {
			doctype: 'Item',
			filters: { is_sales_item: 1, disabled: 0 },
			fields: ['name', 'item_name'],
			limit_page_length: 0
		},
		async: false,
		callback: function(r) {
			if (r.message) {
				$('.service-item').each(function() {
					var $select = $(this);
					var idx = $select.data('idx');
					var current_val = current_services[idx]?.service_item || '';
					
					r.message.forEach(function(item) {
						var selected = item.name === current_val ? 'selected' : '';
							$select.append(`<option value="${esc_attr(item.name)}" ${selected}>${esc(item.item_name || item.name)}</option>`);
					});
				});
			}
		}
	});
}

// Load brands list as select options
function load_brands_list(selected_brand) {
	frappe.call({
		method: 'frappe.client.get_list',
		args: {
				doctype: 'Maintenance Device Brand',
				fields: ['name', 'brand_name'],
			limit_page_length: 0,
			order_by: 'name asc'
		},
		async: false,
		callback: function(r) {
			if (r.message) {
				brands_options = r.message;
				let $select = $('#mr_brand');
				$select.find('option:not(:first)').remove();
				r.message.forEach(function(item) {
					let label = item.brand_name || item.name;
					let sel = selected_brand && selected_brand === item.name ? 'selected' : '';
					$select.append(`<option value="${esc_attr(item.name)}" ${sel}>${esc(label)}</option>`);
				});
				if (selected_brand) {
					$select.val(selected_brand);
				}
				// Refresh searchable dropdown if initialized
				var $wrapper = $select.next('.searchable-dropdown');
				if ($wrapper.length && $wrapper.data('sd-update')) {
					var new_opts = [{value: '', label: __('Select')}];
					r.message.forEach(function(item) {
						new_opts.push({value: item.name, label: item.brand_name || item.name});
					});
					$wrapper.data('sd-update')(new_opts, selected_brand || $select.val());
				}
			}
		}
	});
}


// Show dialog to add new brand
function show_add_brand_dialog() {
	frappe.prompt(
		{
			label: __('Brand Name'),
			fieldname: 'brand_name',
			fieldtype: 'Data',
			reqd: 1
		},
		function(values) {
			frappe.call({
				method: 'frappe.client.insert',
				args: {
					doc: {
							doctype: 'Maintenance Device Brand',
						brand_name: values.brand_name
					}
				},
				freeze: true,
				freeze_message: __('Creating Brand...'),
				callback: function(r) {
					if (r.message) {
						frappe.show_alert({
							message: __('Brand "{0}" created successfully', [values.brand_name]),
							indicator: 'green'
						});
						// Reload brands select and set the new value
						load_brands_list(values.brand_name);
					}
				},
				error: function(r) {
					frappe.msgprint(__('Error creating brand. It may already exist.'));
				}
			});
		},
		__('Add New Brand'),
		__('Add')
	);
}

// Show dialog to add new device type
function show_add_device_type_dialog() {
	frappe.prompt(
		[
			{
				label: __('Device Name'),
				fieldname: 'device_name',
				fieldtype: 'Data',
				reqd: 1
			},
			{
				label: __('Description'),
				fieldname: 'description',
				fieldtype: 'Small Text'
			}
		],
		function(values) {
			frappe.call({
				method: 'frappe.client.insert',
				args: {
					doc: {
						doctype: 'Device Type',
						device_name: values.device_name,
						description: values.description || ''
					}
				},
				freeze: true,
				freeze_message: __('Creating Device Type...'),
				callback: function(r) {
					if (r.message) {
						frappe.show_alert({
							message: __('Device Type "{0}" created successfully', [values.device_name]),
							indicator: 'green'
						});
						// Add new option to select and set it
							$('#mr_device_type').append(
								`<option value="${esc_attr(r.message.name)}" selected>${esc(r.message.name)}</option>`
							);
						$('#mr_device_type').val(r.message.name);
					}
				},
				error: function() {
					frappe.msgprint(__('Error creating device type. It may already exist.'));
				}
			});
		},
		__('Add New Device Type'),
		__('Add')
	);
}

// Show dialog to add new customer
function show_add_customer_dialog() {
	frappe.prompt(
		[
			{
				label: __('Customer Name'),
				fieldname: 'customer_name',
				fieldtype: 'Data',
				reqd: 1
			},
			{
				label: __('Customer Type'),
				fieldname: 'customer_type',
				fieldtype: 'Select',
				options: 'Individual\nCompany',
				default: 'Individual'
			},
			{
				label: __('Phone Number'),
				fieldname: 'phone_number',
				fieldtype: 'Data',
				options: 'Phone',
				reqd: 1
			}
		],
		function(values) {
			frappe.call({
				method: 'maintenance_request.maintenance_request.doctype.maintenance_request.maintenance_request.create_customer_quick',
				args: {
					customer_name: values.customer_name,
					customer_type: values.customer_type || 'Individual',
					phone_number: values.phone_number || '',
					company: frappe.defaults.get_user_default('Company')
				},
				freeze: true,
				freeze_message: __('Creating Customer...'),
				callback: function(r) {
					if (r.message) {
						frappe.show_alert({
							message: __('Customer "{0}" created successfully', [values.customer_name]),
							indicator: 'green'
						});
						// Add new option to select and set it
						var display = r.message.customer_name || r.message.name;
							$('#mr_customer').append(
								`<option value="${esc_attr(r.message.name)}" selected>${esc(display)}</option>`
							);
						$('#mr_customer').val(r.message.name);
						// Set phone if provided
						if (values.phone_number) {
							$('#mr_phone_number').val(values.phone_number);
						}
					}
				},
				error: function() {
					frappe.msgprint(__('Error creating customer. It may already exist.'));
				}
			});
		},
		__('Add New Customer'),
		__('Add')
	);
}

function update_totals() {
	var total = 0;
	current_services.forEach(function(s) {
		total += (s.amount || 0);
	});
	
	var advance = parseFloat($('#mr_advance_paid').val()) || 0;
	var due = total - advance;
	
	$('#total_display').text(fmt(total));
	$('#due_display').text(fmt(due));
}

	function load_select_options(data) {
		let $customer_select = $('#mr_customer');
		if (data && data.customer) {
			$customer_select.append(
				$('<option></option>')
					.val(data.customer)
					.text(data.customer_name || data.customer)
					.attr('selected', true)
			);
		} else {
			// New requests can load customers in the background; editing a request
			// should not block on thousands of customer rows.
			frappe.call({
				method: 'maintenance_request.maintenance_request.page.maintenance_dashboard.maintenance_dashboard.get_customer_options',
				callback: function(r) {
					if (r.message) {
						var customer_options = [{value: '', label: __('Select')}];
						r.message.forEach(function(item) {
							let display = item.customer_name || item.name;
							var $opt = $('<option></option>').val(item.name).text(display);
							if (item.phones && item.phones.length) {
								$opt.attr('data-phones', item.phones.join(','));
							}
							$customer_select.append($opt);
							customer_options.push({value: item.name, label: display, phones: (item.phones || []).join(',')});
						});
						var $wrapper = $customer_select.next('.searchable-dropdown');
						if ($wrapper.length && $wrapper.data('sd-update')) {
							$wrapper.data('sd-update')(customer_options, $customer_select.val());
						}
					}
				}
			});
		}

		frappe.call({
		method: 'frappe.client.get_list',
		args: { doctype: 'Branch', limit_page_length: 0, fields: ['name'], order_by: 'name asc' },
		async: false,
		callback: function(r) {
			if (r.message) {
				let $select = $('#mr_branch');
				r.message.forEach(function(item) {
					let selected = data && data.branch === item.name ? 'selected' : '';
						$select.append(`<option value="${esc_attr(item.name)}" ${selected}>${esc(item.name)}</option>`);
				});
			}
		}
	});

	frappe.call({
		method: 'frappe.client.get_list',
		args: { doctype: 'Device Type', limit_page_length: 0, fields: ['name'], order_by: 'name asc' },
		async: false,
		callback: function(r) {
			if (r.message) {
				let $select = $('#mr_device_type');
				r.message.forEach(function(item) {
					let selected = data && data.device_type === item.name ? 'selected' : '';
						$select.append(`<option value="${esc_attr(item.name)}" ${selected}>${esc(item.name)}</option>`);
				});
			}
		}
	});

	frappe.call({
		method: 'frappe.client.get_list',
		args: { 
			doctype: 'User', 
			limit_page_length: 0, 
			fields: ['name', 'full_name'],
			filters: { enabled: 1, user_type: 'System User' },
			order_by: 'full_name asc' 
		},
		async: false,
		callback: function(r) {
			if (r.message) {
				let $select = $('#mr_technician');
				r.message.forEach(function(item) {
					let selected = data && data.technician === item.name ? 'selected' : '';
					let display = item.full_name || item.name;
						$select.append(`<option value="${esc_attr(item.name)}" ${selected}>${esc(display)}</option>`);
				});
			}
		}
	});

	// Load brands as select options
	load_brands_list(data ? data.brand : null);

	// Load items for services
	if (data) {
		load_items_options();
	}
}

function close_dialog() {
	// Clean up all searchable dropdown document listeners
	$('.mr-dialog .searchable-dropdown').each(function() {
		var ns = $(this).data('sd-ns');
		if (ns) $(document).off(ns);
	});
	$('.mr-dialog, #mr-dialog-style').remove();
	$('body').removeClass('modal-open');
	current_services = [];
}

function get_form_data() {
	// Temporarily enable all disabled fields to read their values
	var $disabled = $('.mr-dialog input:disabled, .mr-dialog select:disabled, .mr-dialog textarea:disabled');
	$disabled.prop('disabled', false);
	var data = {
		customer: $('#mr_customer').val(),
		phone_number: $('#mr_phone_number').val(),
		secondary_phone: $('#mr_secondary_phone').val(),
		intake_receiver: $('#mr_intake_receiver').val(),
		branch: $('#mr_branch').val(),
		device_type: $('#mr_device_type').val(),
		brand: $('#mr_brand').val(),
		model: $('#mr_model').val(),
		serial_number: $('#mr_serial_number').val(),
		received_date: $('#mr_received_date').val(),
		expected_delivery_date: $('#mr_expected_delivery_date').val(),
		status: $('#mr_status').val(),
		technician: $('#mr_technician').val(),
		device_condition: $('#mr_device_condition').val(),
		estimated_cost: $('#mr_estimated_cost').val() || 0,
		warranty_days: $('#mr_warranty_days').val() || 0,
		advance_paid: $('#mr_advance_paid').val() || 0,
		problem_description: $('#mr_problem_description').val(),
		inspection_decision: $('#mr_inspection_decision').val() || '',
		delivery_receiver: $('#mr_delivery_receiver').val() || '',
		not_repairable_reason: $('#mr_not_repairable_reason').val() || '',
		warranty_terms: $('#mr_warranty_terms').val() || '',
	};
	// Include actual_delivery_date if field exists
	if ($('#mr_actual_delivery_date').length) {
		data.actual_delivery_date = $('#mr_actual_delivery_date').val() || '';
	}
	// Re-disable the fields
	$disabled.prop('disabled', true);
	return data;
}

function validate_form(d) {
	var missing = [];
	if (!d.customer) missing.push(__('Customer'));
	if (!d.branch) missing.push(__('Branch'));
	if (!d.device_type) missing.push(__('Device Type'));
	if (!d.brand) missing.push(__('Brand'));
	if (!d.expected_delivery_date) missing.push(__('Expected Delivery Date'));
	if (!d.problem_description) missing.push(__('Problem'));

	if (missing.length > 0) {
		frappe.msgprint({
			title: __('Required Fields'),
			message: __('Please fill: {0}', [missing.join(', ')]),
			indicator: 'orange'
		});
		return false;
	}
	return true;
}

function create_request() {
	let d = get_form_data();
	if (!validate_form(d)) return;

	frappe.call({
		method: 'maintenance_request.maintenance_request.page.maintenance_dashboard.maintenance_dashboard.create_request',
		args: { data: d },
		freeze: true,
		freeze_message: __('Creating...'),
		callback: function(r) {
			if (r.message) {
				frappe.show_alert({ message: __('Created {0}', [r.message]), indicator: 'green' });
				current_page = 1;
				load_dashboard(dashboard_page);
				close_dialog();
				show_request_dialog(r.message);
			}
		}
	});
}

function update_request() {
	let d = get_form_data();
	d.name = $('#mr_name').val();
	d.diagnosis = $('#mr_diagnosis').val() || '';
	d.repair_notes = $('#mr_repair_notes').val() || '';
	d.services = current_services;

	if (!validate_form(d)) return;

	// Validate services have items selected
	for (let i = 0; i < current_services.length; i++) {
		if (!current_services[i].service_item) {
			frappe.msgprint(__('Please select service item for row {0}', [i + 1]));
			return;
		}
	}

	frappe.call({
		method: 'maintenance_request.maintenance_request.page.maintenance_dashboard.maintenance_dashboard.update_request',
		args: { data: d },
		freeze: true,
		freeze_message: __('Saving...'),
		callback: function(r) {
			if (r.message) {
				close_dialog();
				frappe.show_alert({ message: __('Updated {0}', [d.name]), indicator: 'green' });
				load_dashboard(dashboard_page);
			}
		}
	});
}

// ── Stage Locking & Status Transition Helpers ──────────────────────

function render_status_buttons(current_status, request_name) {
	var next_statuses = ALLOWED_TRANSITIONS[current_status];
	if (!next_statuses || next_statuses.length === 0) return '';

	var btn_configs = {
		'In Progress': {
			cls: 'btn-info',
			icon: '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>'
		},
		'Completed': {
			cls: 'btn-success',
			icon: '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>'
		},
		'Not Repairable': {
			cls: 'btn-danger',
			icon: '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>'
		},
		'Ready for Delivery': {
			cls: 'btn-info',
			icon: '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>'
		},
		'Delivered': {
			cls: 'btn-success',
			icon: '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>'
		},
	};

	var html = '';
	next_statuses.forEach(function(status) {
		var cfg = btn_configs[status] || { cls: 'btn-secondary', icon: '' };
		html += `<button class="btn ${cfg.cls} btn-sm status-change-btn" data-status="${esc_attr(status)}" data-name="${esc_attr(request_name)}">${cfg.icon} ${esc(__(status))}</button>`;
	});
	return html;
}

function apply_dialog_stage_locking(status) {
	var locked_groups = LOCKED_STAGES[status] || [];
	var locked_ids = [];
	locked_groups.forEach(function(group) {
		locked_ids = locked_ids.concat(group);
	});

	locked_ids.forEach(function(field_id) {
		var $el = $('#' + field_id);
		if ($el.length) {
			$el.prop('disabled', true).css('background', '#f0f0f0');
		}
	});

	// Also disable add buttons for locked stages
	if (locked_ids.indexOf('mr_customer') >= 0) {
		$('#add_customer_btn').hide();
	}
	if (locked_ids.indexOf('mr_brand') >= 0) {
		$('#add_brand_btn').hide();
	}
	if (locked_ids.indexOf('mr_device_type') >= 0) {
		$('#add_device_type_btn').hide();
	}

	// If Delivered, lock everything
	if (status === 'Delivered') {
		STAGE_4_FIELDS.forEach(function(field_id) {
			$('#' + field_id).prop('disabled', true).css('background', '#f0f0f0');
		});
		$('#add_service_btn').hide();
		$('.delete-service-row').hide();
	}
}

function validate_status_transition(target_status) {
	var errors = [];

	if (target_status === 'In Progress') {
		if (!$('#mr_inspection_decision').val()) {
			errors.push(__('Inspection Decision is required'));
		}
		if (!$('#mr_technician').val()) {
			errors.push(__('Technician is required'));
		}
		if ($('#mr_inspection_decision').val() === 'Repairable' && !$('#mr_diagnosis').val()) {
			errors.push(__('Diagnosis is required when device is Repairable'));
		}
		if ($('#mr_inspection_decision').val() === 'Not Repairable' && !$('#mr_not_repairable_reason').val()) {
			errors.push(__('Reason is required when device is Not Repairable'));
		}
	}

	if (target_status === 'Delivered') {
		if (!$('#mr_actual_delivery_date').val()) {
			errors.push(__('Actual Delivery Date is required'));
		}
		// delivery_receiver is auto-set by the system
	}

	return errors;
}

// ── Searchable Dropdown Widget ──────────────────────────────────────

/**
 * Convert a <select> into a searchable dropdown.
 * @param {string} selector - jQuery selector for the <select> element
 * @param {object} opts - Options: { placeholder, onChange }
 */
function make_searchable(selector, opts) {
	opts = opts || {};
	var $select = (selector instanceof $) ? selector : $(selector);
	if (!$select.length || $select.data('sd-init')) return;
	$select.data('sd-init', true);

	// Gather options from the select (include data-phones for search)
	var options = [];
	$select.find('option').each(function() {
		var o = { value: $(this).val(), label: $(this).text() };
		var phones = $(this).attr('data-phones');
		if (phones) o.phones = phones;
		options.push(o);
	});

	var current_val = $select.val() || '';
	var current_label = '';
	options.forEach(function(o) { if (o.value === current_val) current_label = o.label; });

	// Hide the original select
	$select.hide();

	// Build the searchable dropdown widget
	var placeholder = opts.placeholder || __('Select');
	var $wrapper = $('<div class="searchable-dropdown"></div>');
	var display_class = current_val ? 'sd-text' : 'sd-text placeholder';
	var display_text = current_val ? current_label : placeholder;

	$wrapper.html(`
		<div class="sd-display" tabindex="0">
				<span class="${display_class}">${esc(display_text)}</span>
			<span class="sd-arrow">&#9662;</span>
		</div>
		<div class="sd-panel">
				<div class="sd-search"><input type="text" placeholder="${esc_attr(__('Search...'))}"></div>
			<div class="sd-options"></div>
		</div>
	`);
	$select.after($wrapper);

	var $display = $wrapper.find('.sd-display');
	var $panel = $wrapper.find('.sd-panel');
	var $search_input = $wrapper.find('.sd-search input');
	var $options_container = $wrapper.find('.sd-options');

	function render_options(filter_text) {
		filter_text = (filter_text || '').toLowerCase();
		var html = '';
		var count = 0;
		options.forEach(function(o) {
			if (!o.value && !filter_text) {
				// Skip empty placeholder option when not filtering
				return;
			}
			var phones_match = o.phones && o.phones.toLowerCase().indexOf(filter_text) >= 0;
			if (filter_text && o.label.toLowerCase().indexOf(filter_text) === -1 &&
				o.value.toLowerCase().indexOf(filter_text) === -1 &&
				!phones_match) {
				return;
			}
			var sel_cls = o.value === current_val ? ' selected' : '';
			var phone_hint = '';
			if (o.phones && filter_text && phones_match) {
				// Show the matching phone number
				var matched_phone = '';
				o.phones.split(',').forEach(function(p) {
					if (p.indexOf(filter_text) >= 0 && !matched_phone) matched_phone = p;
				});
					if (matched_phone) phone_hint = ' <span class="sd-option-phone">(' + esc(matched_phone) + ')</span>';
				}
				html += '<div class="sd-option' + sel_cls + '" data-value="' + esc_attr(o.value) + '">' + esc(o.label) + phone_hint + '</div>';
			count++;
		});
		if (count === 0) {
			html = '<div class="sd-no-results">' + __('No results found') + '</div>';
		}
		$options_container.html(html);
	}

	function open_panel() {
		if ($wrapper.hasClass('disabled')) return;
		$panel.removeClass('open-up').addClass('open');
		$display.addClass('focused');
		$search_input.val('');
		render_options('');
		var display_rect = $display[0].getBoundingClientRect();
		var footer_top = $('.mr-dialog .dialog-footer')[0]?.getBoundingClientRect().top || window.innerHeight;
		var available_below = Math.min(window.innerHeight, footer_top) - display_rect.bottom - 12;
		var available_above = display_rect.top - 12;
		if (available_below < 230 && available_above > available_below) {
			$panel.addClass('open-up');
		}
		setTimeout(function() { $search_input.focus(); }, 50);
	}

	function close_panel() {
		$panel.removeClass('open open-up');
		$display.removeClass('focused');
	}

	function select_value(val) {
		current_val = val;
		$select.val(val).trigger('change');
		var label = '';
		options.forEach(function(o) { if (o.value === val) label = o.label; });
		if (val) {
			$display.find('.sd-text').text(label).removeClass('placeholder');
		} else {
			$display.find('.sd-text').text(placeholder).addClass('placeholder');
		}
		close_panel();
	}

	// Events
	$display.on('click', function(e) {
		e.stopPropagation();
		if ($panel.hasClass('open')) {
			close_panel();
		} else {
			// Close all other panels first
			$('.sd-panel.open').removeClass('open');
			$('.sd-display.focused').removeClass('focused');
			open_panel();
		}
	});

	$search_input.on('input', function() {
		render_options($(this).val());
	});

	$search_input.on('click mousedown mouseup keydown keyup keypress', function(e) {
		e.stopPropagation();
	});

	$search_input.on('mousedown', function() {
		var input = this;
		setTimeout(function() { input.focus(); }, 0);
	});

		$options_container.on('click', '.sd-option', function(e) {
			e.stopPropagation();
			select_value($(this).attr('data-value'));
		});

	// Close panel on outside click
	var sd_ns = 'click.sd_' + ($select.attr('id') || 'svc_' + Math.random().toString(36).substr(2, 6));
	$(document).on(sd_ns, function(e) {
		if (!$wrapper[0].contains(e.target)) {
			close_panel();
		}
	});
	$wrapper.data('sd-ns', sd_ns);

	// Public API: update options
	$wrapper.data('sd-update', function(new_options, new_val) {
		options = new_options;
		if (new_val !== undefined) {
			current_val = new_val;
			$select.val(new_val);
		}
		var label = '';
		options.forEach(function(o) { if (o.value === current_val) label = o.label; });
		if (current_val) {
			$display.find('.sd-text').text(label).removeClass('placeholder');
		} else {
			$display.find('.sd-text').text(placeholder).addClass('placeholder');
		}
	});

	// Public API: disable/enable
	$wrapper.data('sd-disable', function(disabled) {
		if (disabled) {
			$wrapper.addClass('disabled');
			close_panel();
		} else {
			$wrapper.removeClass('disabled');
		}
	});

	return $wrapper;
}

/**
 * Initialize all searchable dropdowns after dialog is rendered.
 */
function init_searchable_dropdowns() {
	make_searchable('#mr_customer', { placeholder: __('Select Customer') });
	make_searchable('#mr_branch', { placeholder: __('Select Branch') });
	make_searchable('#mr_device_type', { placeholder: __('Select Device') });
	make_searchable('#mr_brand', { placeholder: __('Select Brand') });
	make_searchable('#mr_technician', { placeholder: __('Select Technician') });
	make_searchable('#mr_inspection_decision', { placeholder: __('Select Decision') });
}

/**
 * Update searchable dropdown disable state based on stage locking.
 */
function update_searchable_disabled() {
	['mr_customer', 'mr_branch', 'mr_device_type', 'mr_brand', 'mr_technician', 'mr_inspection_decision'].forEach(function(id) {
		var $select = $('#' + id);
		var $wrapper = $select.next('.searchable-dropdown');
		if ($wrapper.length && $wrapper.data('sd-disable')) {
			$wrapper.data('sd-disable')($select.prop('disabled'));
		}
	});
}

function fmt(v) {
	return (parseFloat(v) || 0).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}) + ' SAR';
}

// =====================================================================
// LIVE DEVICE HISTORY & WARRANTY CHECKER
// =====================================================================
function trigger_history_and_warranty_check(exclude_name) {
	var serial = $('#mr_serial_number').val() || '';
	var customer = $('#mr_customer').val() || '';
	var phone = $('#mr_phone_number').val() || '';

	if (!serial && !customer && !phone) {
		$('#mr_history_banner_container').empty();
		return;
	}

	frappe.call({
		method: 'maintenance_request.maintenance_request.doctype.maintenance_request.maintenance_request.check_device_and_customer_history',
		args: {
			serial_number: serial,
			customer: customer,
			phone_number: phone,
			exclude_name: exclude_name || $('#mr_name').val() || ''
		},
		callback: function(r) {
			if (r && r.message) {
				render_history_and_warranty_banner(r.message);
			}
		}
	});
}

function render_history_and_warranty_banner(data) {
	var $container = $('#mr_history_banner_container');
	$container.empty();

	if (!data.has_active_warranty && (!data.device_history || data.device_history.length === 0) && (!data.customer_history || data.customer_history.length === 0)) {
		return;
	}

	var html = '';

	if (data.has_active_warranty && data.active_warranty_details) {
		var w = data.active_warranty_details;
		html += `
			<div class="warranty-banner active-warranty">
				<div style="font-size:20px;line-height:1">🛡️</div>
				<div style="flex:1">
					<div style="font-weight:800;font-size:14px">${__('Active Warranty Found!')}</div>
					<div>${__('This device has an active warranty from previous request {0}', [`<strong>${esc(w.name)}</strong>`])}. ${__('Remaining')}: <strong>${esc(w.warranty_days_left)} ${__('Days')}</strong> (${__('Ends at')} ${esc(w.warranty_end_date)}).</div>
					<div style="font-size:11px;margin-top:4px;color:#047857">${__('Previous Problem')}: ${esc(w.problem)}</div>
				</div>
			</div>
		`;
	} else if (data.device_history && data.device_history.length > 0) {
		var first = data.device_history[0];
		html += `
			<div class="warranty-banner info">
				<div style="font-size:18px;line-height:1">ℹ️</div>
				<div style="flex:1">
					<div style="font-weight:700">${__('Device Maintenance History')} (${data.device_history.length} ${__('Previous Requests')})</div>
					<div style="font-size:12px">${__('Last request {0} on {1} - Status: {2}', [`<strong>${esc(first.name)}</strong>`, esc(first.received_date), `<strong>${esc(__(first.status))}</strong>`])}</div>
					<div class="history-records-list">
						${data.device_history.slice(0, 3).map(function(item) {
							return `<div class="history-record-item"><span>📋 ${esc(item.name)} (${esc(item.received_date)}) - ${esc(item.problem)}</span><span class="badge" style="background:#e0e7ff;color:#3730a3">${esc(__(item.status))}</span></div>`;
						}).join('')}
					</div>
				</div>
			</div>
		`;
	}

	$container.html(html);
}


// =====================================================================
// WHATSAPP SHARE & AUTOMATION MODAL
// =====================================================================
function open_whatsapp_share_dialog(docname) {
	if (!docname) return;

	frappe.call({
		method: 'maintenance_request.maintenance_request.doctype.maintenance_request.maintenance_request.get_whatsapp_share_data',
		args: { docname: docname },
		freeze: true,
		freeze_message: __('Loading WhatsApp Details...'),
		callback: function(r) {
			if (r && r.message) {
				show_whatsapp_modal(docname, r.message);
			}
		}
	});
}

function show_whatsapp_modal(docname, data) {
	$('.mr-whatsapp-dialog').remove();

	var html = `
		<div class="mr-dialog mr-whatsapp-dialog" style="z-index:1060">
			<div class="dialog-box" style="max-width:550px">
				<div class="dialog-header" style="background:#128c7e">
					<h5 class="dialog-title">
						<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
						${__('Send WhatsApp Notification')} - <span class="badge">${esc(docname)}</span>
					</h5>
					<button class="close-btn" id="wa_close_btn">&times;</button>
				</div>
				<div class="dialog-body" style="background:#fff;padding:18px">
					<div class="field" style="margin-bottom:12px">
						<label style="font-weight:700;font-size:12px;color:#374151">${__('Recipient Phone')}</label>
						<input type="text" id="wa_phone_input" value="${esc_attr(data.phone || '')}" placeholder="05XXXXXXXX / 9665XXXXXXXX" style="direction:ltr;font-weight:700;padding:9px;border:1px solid #d1d5db;border-radius:5px;width:100%">
					</div>
					<div class="field" style="margin-bottom:14px">
						<label style="font-weight:700;font-size:12px;color:#374151">${__('Message Preview')}</label>
						<textarea id="wa_message_input" style="min-height:160px;padding:10px;border:1px solid #d1d5db;border-radius:5px;width:100%;font-size:13px;line-height:1.6;background:#f9fafb">${esc(data.message || '')}</textarea>
					</div>
					<div style="font-size:11px;color:#6b7280;margin-bottom:10px">
						💡 ${__('You can customize the message above before sending directly via WhatsApp Web/App.')}
					</div>
				</div>
				<div class="dialog-footer" style="background:#f9fafb;justify-content:space-between;padding:12px 18px">
					<button class="btn btn-light" id="wa_copy_btn">📋 ${__('Copy Text')}</button>
					<div style="display:flex;gap:8px">
						<button class="btn btn-secondary" id="wa_cancel_btn">${__('Close')}</button>
						<button class="btn btn-whatsapp" id="wa_open_btn" style="background:#25d366;color:#fff;font-weight:700">
							<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
							${__('Open WhatsApp')}
						</button>
					</div>
				</div>
			</div>
		</div>
	`;

	$('body').append(html);

	$('#wa_close_btn, #wa_cancel_btn').on('click', function() {
		$('.mr-whatsapp-dialog').remove();
	});

	$('#wa_copy_btn').on('click', function() {
		var text = $('#wa_message_input').val();
		navigator.clipboard.writeText(text).then(function() {
			frappe.show_alert({ message: __('Message copied to clipboard!'), indicator: 'green' });
		});
	});

	$('#wa_open_btn').on('click', function() {
		var raw_phone = $('#wa_phone_input').val().trim();
		var digits = raw_phone.replace(/\D/g, '');
		if (digits.startsWith('05') && digits.length === 10) digits = '966' + digits.substring(1);
		if (digits.startsWith('5') && digits.length === 9) digits = '966' + digits;

		var msg = $('#wa_message_input').val();
		var url = 'https://wa.me/' + (digits || '') + '?text=' + encodeURIComponent(msg);
		window.open(url, '_blank');
		$('.mr-whatsapp-dialog').remove();
	});
}


// =====================================================================
// ENHANCED THERMAL BARCODE STICKER PRINT (50x30mm)
// =====================================================================
function print_thermal_sticker(docname) {
	if (!docname) return;

	frappe.call({
		method: 'maintenance_request.maintenance_request.doctype.maintenance_request.maintenance_request.get_sticker_print_data',
		args: { docname: docname },
		freeze: true,
		freeze_message: __('Preparing Sticker...'),
		callback: function(r) {
			if (r && r.message) {
				render_and_print_thermal_label(r.message);
			}
		}
	});
}

function render_and_print_thermal_label(d) {
	var barcode_val = get_request_barcode_value(d.name);
	var barcode_svg = code39_svg(barcode_val);
	var win = window.open('', '_blank', 'width=450,height=350');
	if (!win) {
		frappe.msgprint(__('Please allow popups to print thermal labels.'));
		return;
	}

	var html = `
		<!DOCTYPE html>
		<html dir="rtl">
		<head>
			<meta charset="UTF-8">
			<title>${esc(d.name)}</title>
			<style>
				@page { size: 50mm 25mm; margin: 0; }
				* { box-sizing: border-box; margin: 0; padding: 0; }
				html, body {
					width: 50mm;
					height: 25mm;
					background: #fff;
					color: #000;
					font-family: Arial, Tahoma, sans-serif;
					font-size: 7.5pt;
					line-height: 1.15;
					overflow: hidden;
				}
				.sticker {
					width: 50mm;
					height: 25mm;
					padding: 1.2mm 2mm 0.8mm;
					display: flex;
					flex-direction: column;
					justify-content: space-between;
					box-sizing: border-box;
				}
				.header-row {
					display: flex;
					justify-content: space-between;
					align-items: center;
					border-bottom: 0.35mm solid #000;
					padding-bottom: 0.5mm;
				}
				.company-name { font-weight: 800; font-size: 7.5pt; max-width: 30mm; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
				.rec-date { font-size: 7pt; font-family: monospace; direction: ltr; font-weight: 600; }
				.main-info {
					display: flex;
					flex-direction: column;
					gap: 0.4mm;
					margin: 0.4mm 0;
				}
				.cust-row {
					display: flex;
					justify-content: space-between;
					align-items: center;
					font-weight: 700;
				}
				.cust-name { font-size: 8pt; font-weight: 800; max-width: 27mm; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
				.cust-phone { font-size: 8pt; font-weight: 800; font-family: monospace; direction: ltr; }
				.device-row {
					font-size: 7.5pt;
					font-weight: 700;
					white-space: nowrap;
					overflow: hidden;
					text-overflow: ellipsis;
					color: #111;
				}
				.barcode-container {
					display: flex;
					flex-direction: column;
					align-items: center;
					justify-content: center;
					padding-top: 0.4mm;
					border-top: 0.35mm solid #000;
				}
				.label-barcode {
					width: 44mm;
					height: 6.8mm;
					display: block;
					fill: #000;
				}
				.req-code {
					font-size: 7.5pt;
					font-weight: 800;
					font-family: monospace;
					letter-spacing: 0.5px;
					direction: ltr;
					text-align: center;
					line-height: 1;
					margin-top: 0.2mm;
				}
			</style>
		</head>
		<body>
			<div class="sticker">
				<div class="header-row">
					<span class="company-name">${esc(d.company || 'Maintenance')}</span>
					<span class="rec-date">${esc(d.received_date)}</span>
				</div>
				<div class="main-info">
					<div class="cust-row">
						<span class="cust-name">${esc(d.customer_name)}</span>
						<span class="cust-phone">${esc(d.phone)}</span>
					</div>
					<div class="device-row">📱 ${esc(d.device)}</div>
				</div>
				<div class="barcode-container">
					${barcode_svg}
					<span class="req-code">${esc(d.name)}</span>
				</div>
			</div>
			<script>
				window.onload = function() {
					window.print();
					setTimeout(function() { window.close(); }, 750);
				};
			</script>
		</body>
		</html>
	`;

	win.document.open();
	win.document.write(html);
	win.document.close();
}
