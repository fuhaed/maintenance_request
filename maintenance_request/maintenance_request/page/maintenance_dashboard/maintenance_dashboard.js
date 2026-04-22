// maintenance_dashboard.js

var dashboard_page = null;
var selected_branch = '';
var selected_status = 'all';
var search_text = '';
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
	{ id: 'intake', label: __('Intake'), icon: '1',
	  completed_at: ['In Progress', 'Completed', 'Not Repairable', 'Ready for Delivery', 'Delivered'],
	  active_at: ['Pending'], show_for_new: true },
	{ id: 'inspection', label: __('Inspection'), icon: '2',
	  completed_at: ['Completed', 'Not Repairable', 'Ready for Delivery', 'Delivered'],
	  active_at: ['In Progress'], show_for_new: false },
	{ id: 'services', label: __('Services'), icon: '3',
	  completed_at: ['Ready for Delivery', 'Delivered'],
	  active_at: ['Completed', 'Not Repairable'], show_for_new: false },
	{ id: 'financials', label: __('Financials'), icon: '4',
	  completed_at: ['Ready for Delivery', 'Delivered'],
	  active_at: ['Completed', 'Not Repairable'], show_for_new: false },
	{ id: 'delivery', label: __('Delivery'), icon: '5',
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

function switch_wizard_step(step_id) {
	current_wizard_step = step_id;
	$('.mr-dialog .wizard-tab').removeClass('active');
	$('.mr-dialog .wizard-tab[data-step="' + step_id + '"]').addClass('active');
	$('.mr-dialog .wizard-step-panel').removeClass('active');
	$('.mr-dialog .wizard-step-panel[data-step="' + step_id + '"]').addClass('active');

	// Unlock fields in the active step panel for editing (if not invoice-locked and not Delivered)
	var $panel = $('.mr-dialog .wizard-step-panel[data-step="' + step_id + '"]');
	var current_status = $('#mr_status').val() || $('.mr-dialog').data('status');
	if ($panel.length && !$('.mr-dialog').data('invoice-locked') && current_status !== 'Delivered') {
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
		html += '<span class="wizard-tab-number">' + (idx + 1) + '</span>';
		html += '<svg class="wizard-tab-check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>';
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
		page: current_page || 1
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
	$('.stat-card.pending .stat-info h3').text(data.stats.pending || 0);
	$('.stat-card.in-progress .stat-info h3').text(data.stats.in_progress || 0);
	$('.stat-card.completed .stat-info h3').text(data.stats.completed || 0);
	$('.stat-card.ready .stat-info h3').text(data.stats.ready_for_delivery || 0);
	$('.stat-card.delivered .stat-info h3').text(data.stats.delivered || 0);
	$('.stat-card.not-repairable .stat-info h3').text(data.stats.not_repairable || 0);

	// Update filter tab counts
	$('.filter-btn[data-status="all"]').html(__('All') + ' (' + (data.stats.total || 0) + ')');
	$('.filter-btn[data-status="Pending"]').html(__('Pending') + ' (' + (data.stats.pending || 0) + ')');
	$('.filter-btn[data-status="In Progress"]').html(__('In Progress') + ' (' + (data.stats.in_progress || 0) + ')');
	$('.filter-btn[data-status="Completed"]').html(__('Completed') + ' (' + (data.stats.completed || 0) + ')');
	$('.filter-btn[data-status="Ready for Delivery"]').html(__('Ready') + ' (' + (data.stats.ready_for_delivery || 0) + ')');
	$('.filter-btn[data-status="Delivered"]').html(__('Delivered') + ' (' + (data.stats.delivered || 0) + ')');
	$('.filter-btn[data-status="Not Repairable"]').html(__('Not Repairable') + ' (' + (data.stats.not_repairable || 0) + ')');

	// Update active filter button
	$('.filter-btn').removeClass('active');
	$('.filter-btn[data-status="' + (selected_status || 'all') + '"]').addClass('active');

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
				<div class="stat-card pending" onclick="filter_by_status('Pending')">
					<div class="stat-icon"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg></div>
					<div class="stat-info"><h3>${data.stats.pending || 0}</h3><p>${__('Pending')}</p></div>
				</div>
				<div class="stat-card in-progress" onclick="filter_by_status('In Progress')">
					<div class="stat-icon"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"></path></svg></div>
					<div class="stat-info"><h3>${data.stats.in_progress || 0}</h3><p>${__('In Progress')}</p></div>
				</div>
				<div class="stat-card completed" onclick="filter_by_status('Completed')">
					<div class="stat-icon"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg></div>
					<div class="stat-info"><h3>${data.stats.completed || 0}</h3><p>${__('Completed')}</p></div>
				</div>
				<div class="stat-card ready" onclick="filter_by_status('Ready for Delivery')">
					<div class="stat-icon"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="3" width="15" height="13"></rect><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon><circle cx="5.5" cy="18.5" r="2.5"></circle><circle cx="18.5" cy="18.5" r="2.5"></circle></svg></div>
					<div class="stat-info"><h3>${data.stats.ready_for_delivery || 0}</h3><p>${__('Ready')}</p></div>
				</div>
				<div class="stat-card delivered" onclick="filter_by_status('Delivered')">
					<div class="stat-icon"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg></div>
					<div class="stat-info"><h3>${data.stats.delivered || 0}</h3><p>${__('Delivered')}</p></div>
				</div>
				<div class="stat-card not-repairable" onclick="filter_by_status('Not Repairable')">
					<div class="stat-icon"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg></div>
					<div class="stat-info"><h3>${data.stats.not_repairable || 0}</h3><p>${__('Not Repairable')}</p></div>
				</div>
			</div>
			<div class="filter-search-row">
				<div class="filter-tabs">
					<button class="filter-btn ${selected_status === 'all' ? 'active' : ''}" data-status="all">${__('All')} (${data.stats.total || 0})</button>
					<button class="filter-btn ${selected_status === 'Pending' ? 'active' : ''}" data-status="Pending">${__('Pending')} (${data.stats.pending || 0})</button>
					<button class="filter-btn ${selected_status === 'In Progress' ? 'active' : ''}" data-status="In Progress">${__('In Progress')} (${data.stats.in_progress || 0})</button>
					<button class="filter-btn ${selected_status === 'Completed' ? 'active' : ''}" data-status="Completed">${__('Completed')} (${data.stats.completed || 0})</button>
					<button class="filter-btn ${selected_status === 'Ready for Delivery' ? 'active' : ''}" data-status="Ready for Delivery">${__('Ready')} (${data.stats.ready_for_delivery || 0})</button>
					<button class="filter-btn ${selected_status === 'Delivered' ? 'active' : ''}" data-status="Delivered">${__('Delivered')} (${data.stats.delivered || 0})</button>
					<button class="filter-btn ${selected_status === 'Not Repairable' ? 'active' : ''}" data-status="Not Repairable">${__('Not Repairable')} (${data.stats.not_repairable || 0})</button>
				</div>
				<div class="filter-right">
					<select id="branch-filter" class="branch-select">
						<option value="">${__('All Branches')}</option>
					</select>
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
		}
		let invoice_html = '';
		if (req.sales_invoice) {
			invoice_html = `<div class="invoice-indicator">
				<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>
				<a href="/app/sales-invoice/${req.sales_invoice}" class="invoice-link" onclick="event.stopPropagation()">${req.sales_invoice}</a>
			</div>`;
		}
		html += `
			<tr class="request-row" data-name="${req.name}" data-status="${req.status || ''}">
				<td class="req-id">
					${req.name || ''}
					${invoice_html}
				</td>
				<td>${req.customer_name || ''}</td>
				<td>${req.phone_number || ''}</td>
				<td>${req.device_type || ''}${req.brand ? ' - ' + req.brand : ''}</td>
				<td class="problem">${problem_text}</td>
				<td class="est-cost">${fmt(req.estimated_cost)}</td>
				<td>${req.received_date ? frappe.datetime.str_to_user(req.received_date) : ''}</td>
				<td><span class="status-badge ${colors[req.status] || 'gray'}">${__(req.status || 'Pending')}</span></td>
				<td><button class="btn-view" data-name="${req.name}">${__('View')}</button></td>
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
	// Status filter buttons
	$('.filter-btn').on('click', function() {
		$('.filter-btn').removeClass('active');
		$(this).addClass('active');
		selected_status = $(this).data('status');
		current_page = 1;
		load_dashboard(dashboard_page, true);
	});

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

	// Row double click
	$('.request-row').on('dblclick', function() {
		show_request_dialog($(this).data('name'));
	});

	// View button
	$('.btn-view').on('click', function(e) {
		e.stopPropagation();
		show_request_dialog($(this).data('name'));
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
	selected_status = status;
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
		search: search_text || ''
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
		filter_desc.push(__('Branch') + ': ' + data.filters.branch);
	}
	if (data.filters.status && data.filters.status !== __('All Statuses')) {
		filter_desc.push(__('Status') + ': ' + (status_labels[data.filters.status] || data.filters.status));
	}
	if (data.filters.search) {
		filter_desc.push(__('Search') + ': ' + data.filters.search);
	}

	var rows_html = '';
	data.requests.forEach(function(req, idx) {
		rows_html += `
			<tr>
				<td style="text-align:center">${idx + 1}</td>
				<td>${req.name}</td>
				<td>${req.customer_name || ''}</td>
				<td>${req.phone_number || ''}</td>
				<td>${req.device_type || ''}${req.brand ? ' - ' + req.brand : ''}</td>
				<td>${req.branch || ''}</td>
				<td style="text-align:center">${req.received_date ? frappe.datetime.str_to_user(req.received_date) : ''}</td>
				<td style="text-align:center">${status_labels[req.status] || req.status}</td>
				<td style="text-align:right">${fmt_number(req.estimated_cost)}</td>
				<td style="text-align:right">${fmt_number(req.total_amount)}</td>
				<td style="text-align:right">${fmt_number(req.advance_paid)}</td>
				<td style="text-align:right">${fmt_number(req.outstanding_amount)}</td>
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
				${data.company_name ? '<div class="company-name">' + data.company_name + '</div>' : ''}
				<h1>${__('Maintenance Requests Report')}</h1>
				<div class="report-date">${__('Printed on')}: ${frappe.datetime.str_to_user(data.print_date)} | ${__('Total Records')}: ${data.summary.total_records}</div>
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

function fmt_number(v) {
	return (parseFloat(v) || 0).toLocaleString('en-SA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
			.mr-dialog{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:1050;display:flex;align-items:center;justify-content:center}
			.mr-dialog .dialog-box{background:#fff;border-radius:10px;width:95%;max-width:950px;max-height:92vh;overflow:visible;box-shadow:0 15px 50px rgba(0,0,0,0.3);position:relative}
			.mr-dialog .dialog-header{padding:12px 16px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);display:flex;justify-content:space-between;align-items:center;border-radius:10px 10px 0 0}
			.mr-dialog .dialog-title{color:#fff;font-size:15px;font-weight:600;margin:0}
			.mr-dialog .dialog-title .badge{background:rgba(255,255,255,0.25);padding:3px 10px;border-radius:4px;font-size:12px;margin-left:10px}
			.mr-dialog .close-btn{background:none;border:none;color:#fff;font-size:24px;cursor:pointer;line-height:1;opacity:0.9}
			.mr-dialog .close-btn:hover{opacity:1}
			.mr-dialog .dialog-body{padding:12px 16px;background:#f8f9fa;overflow-y:auto;max-height:calc(92vh - 120px);overflow-x:visible}
			.mr-dialog .dialog-footer{padding:10px 16px;background:#fff;border-top:1px solid #e0e0e0;display:flex;justify-content:space-between;border-radius:0 0 10px 10px}
			.mr-dialog .row{display:grid;grid-template-columns:repeat(4,1fr);gap:8px 12px;background:#fff;padding:10px 12px;border-radius:6px;margin-bottom:8px;position:relative}
			.mr-dialog .row.cols-3{grid-template-columns:repeat(3,1fr)}
			.mr-dialog .row.cols-2{grid-template-columns:repeat(2,1fr)}
			.mr-dialog .field{display:flex;flex-direction:column;position:relative}
			.mr-dialog .field.full{grid-column:1/-1}
			.mr-dialog .field label{font-size:11px;font-weight:600;color:#555;margin-bottom:4px}
			.mr-dialog .field label .req{color:#e74c3c}
			.mr-dialog .field input,.mr-dialog .field textarea,.mr-dialog .field select{padding:8px 10px;border:1px solid #ddd;border-radius:5px;font-size:13px;transition:border-color 0.2s;width:100%;box-sizing:border-box}
			.mr-dialog .field input:focus,.mr-dialog .field textarea:focus,.mr-dialog .field select:focus{outline:none;border-color:#667eea;box-shadow:0 0 0 3px rgba(102,126,234,0.1)}
			.mr-dialog .field textarea{min-height:50px;resize:vertical}
			.mr-dialog .btn{padding:8px 18px;border:none;border-radius:5px;font-size:13px;font-weight:500;cursor:pointer;transition:opacity 0.2s}
			.mr-dialog .btn:hover{opacity:0.9}
			.mr-dialog .btn-primary{background:linear-gradient(135deg,#667eea,#764ba2);color:#fff}
			.mr-dialog .btn-secondary{background:#6c757d;color:#fff}
			.mr-dialog .btn-success{background:#27ae60;color:#fff}
			.mr-dialog .btn-info{background:#3498db;color:#fff}
			.mr-dialog .btn-sm{padding:5px 10px;font-size:11px}
			.mr-dialog .btn-danger{background:#e74c3c;color:#fff}
			.mr-dialog .totals{display:flex;justify-content:flex-end;gap:20px;padding:10px 12px;background:#fff;border-radius:6px}
			.mr-dialog .totals .item{text-align:right}
			.mr-dialog .totals .item label{font-size:10px;color:#888;display:block;text-transform:uppercase}
			.mr-dialog .totals .item .val{font-size:16px;font-weight:700;color:#667eea}
			.mr-dialog .totals .item .val.red{color:#e74c3c}
			.mr-dialog .totals .item .val.green{color:#27ae60}
			.mr-dialog .left-btns,.mr-dialog .right-btns{display:flex;gap:8px}
			
			/* Services Table */
			.mr-dialog .services-section{background:#fff;padding:10px 12px;border-radius:6px;margin-bottom:8px}
			.mr-dialog .services-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
			.mr-dialog .services-header h4{margin:0;font-size:13px;font-weight:600;color:#333}
			.mr-dialog .services-table{width:100%;border-collapse:collapse;font-size:12px}
			.mr-dialog .services-table th{background:#f0f0f0;padding:8px;text-align:right;font-weight:600;border:1px solid #ddd}
			.mr-dialog .services-table td{padding:6px 8px;border:1px solid #ddd;vertical-align:middle}
			.mr-dialog .services-table input,.mr-dialog .services-table select{padding:5px;font-size:12px;border:1px solid #ddd;border-radius:3px}
			.mr-dialog .services-table .col-service{width:40%}
			.mr-dialog .services-table .col-qty{width:15%}
			.mr-dialog .services-table .col-rate{width:20%}
			.mr-dialog .services-table .col-amount{width:15%;text-align:center;font-weight:bold}
			.mr-dialog .services-table .col-action{width:10%;text-align:center}
			.mr-dialog .no-services{text-align:center;padding:15px;color:#999;font-size:12px}
			.mr-dialog .services-table .searchable-dropdown{width:100%}
			.mr-dialog .services-table .searchable-dropdown .sd-display{padding:5px 8px;font-size:12px;min-height:30px}
			.mr-dialog .services-table .searchable-dropdown .sd-panel{min-width:250px}

			/* Searchable Dropdown */
			.mr-dialog .searchable-dropdown{position:relative;width:100%;flex:1;min-width:0}
			.mr-dialog .searchable-dropdown .sd-display{padding:8px 10px;border:1px solid #ddd;border-radius:5px;font-size:13px;width:100%;box-sizing:border-box;cursor:pointer;background:#fff;display:flex;justify-content:space-between;align-items:center;min-height:38px;transition:border-color 0.2s}
			.mr-dialog .searchable-dropdown .sd-display:hover{border-color:#aaa}
			.mr-dialog .searchable-dropdown .sd-display.focused{border-color:#667eea;box-shadow:0 0 0 3px rgba(102,126,234,0.1)}
			.mr-dialog .searchable-dropdown .sd-display .sd-text{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#333}
			.mr-dialog .searchable-dropdown .sd-display .sd-text.placeholder{color:#999}
			.mr-dialog .searchable-dropdown .sd-display .sd-arrow{margin-left:6px;color:#888;font-size:10px;flex-shrink:0}
			.mr-dialog .searchable-dropdown .sd-panel{position:absolute;top:100%;left:0;right:0;background:#fff;border:1px solid #ddd;border-radius:5px;box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:1100;display:none;margin-top:2px;max-height:250px;overflow:hidden;flex-direction:column}
			.mr-dialog .searchable-dropdown .sd-panel.open{display:flex}
			.mr-dialog .searchable-dropdown .sd-search{padding:8px;border-bottom:1px solid #eee;flex-shrink:0}
			.mr-dialog .searchable-dropdown .sd-search input{width:100%;padding:6px 10px;border:1px solid #ddd;border-radius:4px;font-size:13px;outline:none;box-sizing:border-box}
			.mr-dialog .searchable-dropdown .sd-search input:focus{border-color:#667eea}
			.mr-dialog .searchable-dropdown .sd-options{overflow-y:auto;max-height:200px;flex:1}
			.mr-dialog .searchable-dropdown .sd-option{padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid #f5f5f5;transition:background 0.15s}
			.mr-dialog .searchable-dropdown .sd-option:hover{background:#f0f4ff}
			.mr-dialog .searchable-dropdown .sd-option.selected{background:#667eea;color:#fff}
			.mr-dialog .searchable-dropdown .sd-option.selected:hover{background:#5a6fd6}
			.mr-dialog .searchable-dropdown .sd-no-results{padding:12px;text-align:center;color:#999;font-size:12px}
			.mr-dialog .searchable-dropdown.disabled .sd-display{background:#f0f0f0;cursor:not-allowed;color:#888}

			/* Wizard Tabs */
			.mr-dialog .wizard-tabs{display:flex;align-items:center;justify-content:center;padding:16px 12px 8px;margin-bottom:10px;gap:0;background:#fff;border-radius:6px}
			.mr-dialog .wizard-tab{display:flex;flex-direction:column;align-items:center;gap:4px;cursor:pointer;padding:6px 14px;border-radius:6px;transition:all 0.2s;min-width:70px}
			.mr-dialog .wizard-tab:hover:not(.disabled){background:#f0f4ff}
			.mr-dialog .wizard-tab-indicator{width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;border:2px solid #ddd;background:#fff;color:#999;transition:all 0.25s}
			.mr-dialog .wizard-tab-label{font-size:11px;font-weight:600;color:#999;white-space:nowrap;transition:color 0.2s}
			.mr-dialog .wizard-tab-check{display:none}
			.mr-dialog .wizard-tab-number{display:inline}
			.mr-dialog .wizard-tab.active .wizard-tab-indicator{border-color:#667eea;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff}
			.mr-dialog .wizard-tab.active .wizard-tab-label{color:#667eea;font-weight:700}
			.mr-dialog .wizard-tab.completed .wizard-tab-indicator{border-color:#27ae60;background:#27ae60;color:#fff}
			.mr-dialog .wizard-tab.completed .wizard-tab-label{color:#27ae60}
			.mr-dialog .wizard-tab.completed .wizard-tab-number{display:none}
			.mr-dialog .wizard-tab.completed .wizard-tab-check{display:block}
			.mr-dialog .wizard-tab.available .wizard-tab-indicator{border-color:#bbb;color:#888}
			.mr-dialog .wizard-tab.available .wizard-tab-label{color:#888}
			.mr-dialog .wizard-tab.disabled{cursor:not-allowed;opacity:0.4}
			.mr-dialog .wizard-tab-connector{flex:1;height:2px;background:#ddd;min-width:16px;max-width:50px;margin:0 -2px;margin-bottom:20px;transition:background 0.2s}
			.mr-dialog .wizard-tab-connector.completed{background:#27ae60}
			.mr-dialog .wizard-step-panel{display:none}
			.mr-dialog .wizard-step-panel.active{display:block}
			.mr-dialog .wizard-step-content{min-height:200px}
			.mr-dialog .status-badge{display:inline-block;padding:2px 10px;border-radius:4px;font-size:12px;font-weight:600;margin-left:8px}
			.mr-dialog .status-badge.pending{background:#fff3e0;color:#f57c00}
			.mr-dialog .status-badge.in-progress{background:#e3f2fd;color:#1976d2}
			.mr-dialog .status-badge.completed{background:#e8f5e9;color:#388e3c}
			.mr-dialog .status-badge.not-repairable{background:#ffebee;color:#d32f2f}
			.mr-dialog .status-badge.ready-for-delivery{background:#f3e5f5;color:#7b1fa2}
			.mr-dialog .status-badge.delivered{background:#e0f2f1;color:#00897b}
		</style>
	`);

	if (request_name) {
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

function render_dialog(data) {
	const is_edit = data !== null;
	const has_invoice = is_edit && data.sales_invoice;
	const title = is_edit ? __('Edit Request') : __('New Request');
	const save_txt = is_edit ? __('Save') : __('Create');
	const request_name = is_edit ? data.name : '';
	const status = is_edit ? (data.status || 'Pending') : 'Pending';

	// Status badge helper
	var status_css = status.toLowerCase().replace(/ /g, '-');
	var status_badge = is_edit ? `<span class="status-badge ${status_css}">${__(status)}</span>` : '';

	let html = `
		<div class="mr-dialog">
			<div class="dialog-box">
				<div class="dialog-header">
					<h5 class="dialog-title">${title} ${is_edit ? `<span class="badge">${data.name}</span>` : ''} ${status_badge}</h5>
					<button class="close-btn" id="close_btn">&times;</button>
				</div>
				<div class="dialog-body">
					<input type="hidden" id="mr_name" value="${request_name}">
					<input type="hidden" id="mr_status" value="${status}">
					${has_invoice ? `<div style="background:#fff3e0;padding:8px 12px;border-radius:6px;margin-bottom:8px;font-size:12px;color:#e65100;display:flex;align-items:center;gap:8px">
						<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
						${__('This request is locked because invoice {0} has been issued.', ['<a href="/app/sales-invoice/' + data.sales_invoice + '" onclick="event.stopPropagation()">' + data.sales_invoice + '</a>'])}
					</div>` : ''}

					${build_wizard_tabs_html(status, is_edit)}

					<div class="wizard-step-content">
						<!-- STEP 1: Intake -->
						<div class="wizard-step-panel active" data-step="intake">
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
									<input type="text" id="mr_phone_number" value="${is_edit ? (data.phone_number||'') : ''}">
								</div>
								<div class="field">
									<label>${__('Phone 2')}</label>
									<input type="text" id="mr_secondary_phone" value="${is_edit ? (data.secondary_phone||'') : ''}">
								</div>
								<div class="field">
									<label>${__('Intake Receiver')} <span class="req">*</span></label>
									<input type="text" id="mr_intake_receiver" value="${is_edit ? (data.intake_receiver||'') : frappe.session.user_fullname}" readonly style="background:#f0f0f0;cursor:not-allowed">
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
									<input type="text" id="mr_model" value="${is_edit ? (data.model||'') : ''}">
								</div>
							</div>
							<div class="row">
								<div class="field">
									<label>${__('Serial')}</label>
									<input type="text" id="mr_serial_number" value="${is_edit ? (data.serial_number||'') : ''}">
								</div>
								<div class="field">
									<label>${__('Condition')}</label>
									<input type="text" id="mr_device_condition" value="${is_edit ? (data.device_condition||'') : ''}">
								</div>
								<div class="field">
									<label>${__('Received')}</label>
									<input type="date" id="mr_received_date" value="${is_edit ? (data.received_date||'') : frappe.datetime.get_today()}">
								</div>
								<div class="field">
									<label>${__('Expected Delivery')} <span class="req">*</span></label>
									<input type="date" id="mr_expected_delivery_date" value="${is_edit ? (data.expected_delivery_date||'') : ''}">
								</div>
							</div>
							<div class="row">
								<div class="field full">
									<label>${__('Problem')} <span class="req">*</span></label>
									<textarea id="mr_problem_description" rows="3">${is_edit ? (data.problem_description||'') : ''}</textarea>
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
									<textarea id="mr_diagnosis" rows="3">${data.diagnosis||''}</textarea>
								</div>
							</div>
							<div class="row" id="repair_notes_field" style="${data.inspection_decision==='Repairable'?'':'display:none'}">
								<div class="field full">
									<label>${__('Repair Notes')}</label>
									<textarea id="mr_repair_notes" rows="3">${data.repair_notes||''}</textarea>
								</div>
							</div>
							<div class="row" id="not_repairable_reason_field" style="${data.inspection_decision==='Not Repairable'?'':'display:none'}">
								<div class="field full">
									<label>${__('Reason (Not Repairable)')}</label>
									<textarea id="mr_not_repairable_reason" rows="3">${data.not_repairable_reason||''}</textarea>
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
									<input type="number" id="mr_estimated_cost" value="${data.estimated_cost||0}" step="0.01">
								</div>
								<div class="field">
									<label>${__('Advance Paid')}</label>
									<input type="number" id="mr_advance_paid" value="${data.advance_paid||0}" step="0.01">
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
									<input type="date" id="mr_actual_delivery_date" value="${data.actual_delivery_date||''}">
								</div>
								<div class="field">
									<label>${__('Delivery Receiver')}</label>
									<input type="text" id="mr_delivery_receiver" value="${data.delivery_receiver||''}" readonly style="background:#f0f0f0;cursor:not-allowed">
								</div>
								<div class="field">
									<label>${__('Warranty Days')}</label>
									<input type="number" id="mr_warranty_days" value="${data.warranty_days||0}">
								</div>
								<div class="field">
									<label>${__('Warranty Terms')}</label>
									<input type="text" id="mr_warranty_terms" value="${data.warranty_terms||''}">
								</div>
							</div>
						</div>
						` : ''}
					</div>
				</div>
				<div class="dialog-footer">
					<div class="left-btns">
						${is_edit ? `
							<button class="btn btn-info" id="print_btn" data-name="${data.name}">${__('Print')}</button>
							${!data.sales_invoice ? `<button class="btn btn-success" id="invoice_btn" data-name="${data.name}">${__('Invoice')}</button>` : ''}
							${render_status_buttons(data.status, data.name)}
						` : ''}
					</div>
					<div class="right-btns">
						<button class="btn btn-secondary" id="cancel_btn">${__('Cancel')}</button>
						${!has_invoice ? `<button class="btn btn-primary" id="save_btn">${save_txt}</button>` : ''}
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

	// Auto-select the correct wizard step based on status
	if (is_edit) {
		switch_wizard_step(get_auto_step(data.status));
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

	// Customer change - always fetch and fill phone
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
				}
			});
		}
	});

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
		var $row = $(this).closest('tr');
		var idx = $row.data('idx');
		var item = $(this).val();

		current_services[idx].service_item = item;

		// Get item rate
		if (item) {
			frappe.call({
				method: 'frappe.client.get_value',
				args: {
					doctype: 'Item',
					filters: { name: item },
					fieldname: ['standard_rate']
				},
				callback: function(r) {
					if (r.message && r.message.standard_rate) {
						$row.find('.service-rate').val(r.message.standard_rate).trigger('change');
					}
				}
			});
		}
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
				<td><input type="number" class="service-qty" value="${service.qty || 1}" min="1" style="width:100%"></td>
				<td><input type="number" class="service-rate" value="${service.rate || 0}" step="0.01" style="width:100%"></td>
				<td class="service-amount">${fmt(service.amount || 0)}</td>
				<td><button class="btn btn-danger btn-sm delete-service-row" data-idx="${idx}">&times;</button></td>
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
			make_searchable($sel, { placeholder: __('Select Service') });
		}
	});
	update_totals();
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
						$select.append(`<option value="${item.name}" ${selected}>${item.item_name || item.name}</option>`);
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
			doctype: 'Brand',
			fields: ['name'],
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
					let sel = selected_brand && selected_brand === item.name ? 'selected' : '';
					$select.append(`<option value="${item.name}" ${sel}>${item.name}</option>`);
				});
				if (selected_brand) {
					$select.val(selected_brand);
				}
				// Refresh searchable dropdown if initialized
				var $wrapper = $select.next('.searchable-dropdown');
				if ($wrapper.length && $wrapper.data('sd-update')) {
					var new_opts = [{value: '', label: __('Select')}];
					r.message.forEach(function(item) {
						new_opts.push({value: item.name, label: item.name});
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
						doctype: 'Brand',
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
							`<option value="${r.message.name}" selected>${r.message.name}</option>`
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
							`<option value="${r.message.name}" selected>${display}</option>`
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
	// Load customers with phone numbers for search
	frappe.call({
		method: 'maintenance_request.maintenance_request.page.maintenance_dashboard.maintenance_dashboard.get_customer_options',
		async: false,
		callback: function(r) {
			if (r.message) {
				let $select = $('#mr_customer');
				r.message.forEach(function(item) {
					let selected = data && data.customer === item.name ? 'selected' : '';
					let display = item.customer_name || item.name;
					var $opt = $('<option></option>').val(item.name).text(display).attr('selected', selected ? true : false);
					if (item.phones && item.phones.length) {
						$opt.attr('data-phones', item.phones.join(','));
					}
					$select.append($opt);
				});
			}
		}
	});

	frappe.call({
		method: 'frappe.client.get_list',
		args: { doctype: 'Branch', limit_page_length: 0, fields: ['name'], order_by: 'name asc' },
		async: false,
		callback: function(r) {
			if (r.message) {
				let $select = $('#mr_branch');
				r.message.forEach(function(item) {
					let selected = data && data.branch === item.name ? 'selected' : '';
					$select.append(`<option value="${item.name}" ${selected}>${item.name}</option>`);
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
					$select.append(`<option value="${item.name}" ${selected}>${item.name}</option>`);
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
					$select.append(`<option value="${item.name}" ${selected}>${display}</option>`);
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

	var btn_colors = {
		'In Progress': 'btn-info',
		'Completed': 'btn-success',
		'Not Repairable': 'btn-danger',
		'Ready for Delivery': 'btn-info',
		'Delivered': 'btn-success',
	};

	var html = '';
	next_statuses.forEach(function(status) {
		var cls = btn_colors[status] || 'btn-secondary';
		html += `<button class="btn ${cls} btn-sm status-change-btn" data-status="${status}" data-name="${request_name}">${__(status)}</button>`;
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
			<span class="${display_class}">${display_text}</span>
			<span class="sd-arrow">&#9662;</span>
		</div>
		<div class="sd-panel">
			<div class="sd-search"><input type="text" placeholder="${__('Search...')}"></div>
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
				if (matched_phone) phone_hint = ' <small style="color:#888">(' + matched_phone + ')</small>';
			}
			html += '<div class="sd-option' + sel_cls + '" data-value="' + o.value + '">' + o.label + phone_hint + '</div>';
			count++;
		});
		if (count === 0) {
			html = '<div class="sd-no-results">' + __('No results found') + '</div>';
		}
		$options_container.html(html);
	}

	function open_panel() {
		if ($wrapper.hasClass('disabled')) return;
		$panel.addClass('open');
		$display.addClass('focused');
		$search_input.val('');
		render_options('');
		setTimeout(function() { $search_input.focus(); }, 50);
	}

	function close_panel() {
		$panel.removeClass('open');
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

	$search_input.on('click', function(e) {
		e.stopPropagation();
	});

	$options_container.on('click', '.sd-option', function(e) {
		e.stopPropagation();
		select_value($(this).data('value'));
		if (opts.onChange) opts.onChange($(this).data('value'));
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
	return (parseFloat(v) || 0).toLocaleString('en-SA', {minimumFractionDigits:2, maximumFractionDigits:2}) + ' SAR';
}