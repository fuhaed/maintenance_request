import frappe

def execute():
    try:
        frappe.reload_doc("maintenance_request", "workspace", "maintenance", force=True)
    except Exception as e:
        frappe.log_error(f"Error reloading workspace: {e}", "sync_workspace")
