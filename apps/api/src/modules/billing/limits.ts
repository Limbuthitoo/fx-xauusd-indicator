import { query } from "../../infrastructure/db/client.js";

export async function tenantPlanUsage(tenantId: string | null) {
  if (!tenantId) return null;
  const { rows } = await query(
    `SELECT
       p.code AS plan_code,
       p.name AS plan_name,
       p.max_admin_users,
       p.max_notifications_per_month,
       p.max_report_history_months,
       p.automation_included,
       s.status AS subscription_status,
       count(DISTINCT au.id) FILTER (WHERE au.status = 'ACTIVE' AND au.platform_super_admin = false)::int AS active_admin_users,
       count(DISTINCT n.id) FILTER (WHERE n.created_at >= date_trunc('month', now()))::int AS notifications_used_this_month
     FROM platform_tenants t
     LEFT JOIN LATERAL (
       SELECT *
       FROM tenant_subscriptions
       WHERE tenant_id = t.id
       ORDER BY created_at DESC
       LIMIT 1
     ) s ON true
     LEFT JOIN subscription_plans p ON p.id = s.plan_id
     LEFT JOIN admin_users au ON au.tenant_id = t.id
     LEFT JOIN notifications n ON n.tenant_id = t.id
     WHERE t.id = $1
     GROUP BY p.id, s.status`,
    [tenantId]
  );
  return rows[0] ?? null;
}

export async function canCreateTenantNotification(tenantId: string | null, priority = "NORMAL") {
  if (!tenantId || ["HIGH", "CRITICAL"].includes(priority)) return true;
  const usage = await tenantPlanUsage(tenantId);
  const max = usage?.max_notifications_per_month == null ? null : Number(usage.max_notifications_per_month);
  if (max == null) return true;
  return Number(usage?.notifications_used_this_month ?? 0) < max;
}

export async function tenantReportHistoryMonths(tenantId: string | null) {
  if (!tenantId) return null;
  const usage = await tenantPlanUsage(tenantId);
  return usage?.max_report_history_months == null ? null : Number(usage.max_report_history_months);
}

export async function tenantAutomationIncluded(tenantId: string | null) {
  if (!tenantId) return false;
  const usage = await tenantPlanUsage(tenantId);
  return usage?.automation_included !== false && ["TRIAL", "ACTIVE"].includes(String(usage?.subscription_status ?? "ACTIVE"));
}
