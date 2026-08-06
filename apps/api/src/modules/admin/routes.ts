import { randomBytes, createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "../../infrastructure/config.js";
import { poolStats, query } from "../../infrastructure/db/client.js";
import { redisClient, redisHealth } from "../../infrastructure/redis/client.js";
import { hashPassword, requireAdmin, requirePermission, requireTenantModule, writeAudit } from "../auth/routes.js";
import { handleBillingWebhook } from "../billing/provider.js";
import { pushProviderHealth, sendTenantPush } from "../notifications/push.js";
import { runOrbLearningPython } from "./learning.js";
import { listTenantModuleSettings, listTenantSettings, updateTenantModuleSetting, updateTenantSetting, validateSetting } from "./settings.js";

export async function adminRoutes(app: FastifyInstance) {
  app.get("/api/platform/overview", async (request) => {
    requirePlatformSuperAdmin(request);
    const [tenants, modules, plans, billing] = await Promise.all([
      query(`
        SELECT
          t.*,
          s.id AS subscription_id,
          s.status AS subscription_status,
          s.starts_at AS subscription_starts_at,
          s.renews_at AS subscription_renews_at,
          p.code AS plan_code,
          p.name AS plan_name,
          p.price_usd,
          p.billing_period,
          p.max_admin_users,
          p.max_notifications_per_month,
          p.max_report_history_months,
          p.automation_included,
          owner_login.email AS primary_login_email,
          owner_login.display_name AS primary_login_name,
          owner_login.status AS primary_login_status,
          owner_login.last_login_at AS primary_login_last_login_at,
          tas.enabled AS automation_enabled,
          tas.running AS automation_running,
          tas.phase AS automation_phase,
          tas.latest_reason AS automation_reason,
          tas.latest_candle_at AS automation_latest_candle_at,
          (
            SELECT count(*)::int
            FROM admin_users au
            WHERE au.tenant_id = t.id
              AND au.status = 'ACTIVE'
              AND au.platform_super_admin = false
          ) AS active_admin_users,
          (
            SELECT count(*)::int
            FROM notifications n
            WHERE n.tenant_id = t.id
              AND n.created_at >= date_trunc('month', now())
          ) AS notifications_used_this_month,
          COALESCE(jsonb_agg(
            jsonb_build_object('code', m.code, 'name', m.name, 'status', tm.status)
            ORDER BY m.sort_order
          ) FILTER (WHERE m.id IS NOT NULL), '[]'::jsonb) AS modules
        FROM platform_tenants t
        LEFT JOIN LATERAL (
          SELECT * FROM tenant_subscriptions
          WHERE tenant_id = t.id
          ORDER BY created_at DESC
          LIMIT 1
       ) s ON true
        LEFT JOIN subscription_plans p ON p.id = s.plan_id
        LEFT JOIN LATERAL (
          SELECT u.email, u.display_name, u.status, u.last_login_at
          FROM admin_users u
          WHERE u.tenant_id = t.id
            AND u.platform_super_admin = false
          ORDER BY
            CASE WHEN lower(u.email) = lower(COALESCE(t.owner_email, '')) THEN 0 ELSE 1 END,
            u.created_at ASC
          LIMIT 1
        ) owner_login ON true
        LEFT JOIN LATERAL (
          SELECT
            bool_or(enabled) AS enabled,
            bool_or(running) AS running,
            COALESCE(
              (array_agg(phase ORDER BY running DESC, updated_at DESC) FILTER (WHERE phase IS NOT NULL))[1],
              'WAITING'
            ) AS phase,
            COALESCE(
              (array_agg(latest_reason ORDER BY running DESC, updated_at DESC) FILTER (WHERE latest_reason IS NOT NULL))[1],
              'No automation heartbeat yet.'
            ) AS latest_reason,
            max(latest_candle_at) AS latest_candle_at
          FROM tenant_automation_states
          WHERE tenant_id = t.id
        ) tas ON true
        LEFT JOIN tenant_modules tm ON tm.tenant_id = t.id
        LEFT JOIN platform_strategy_modules m ON m.id = tm.module_id AND m.status = 'ACTIVE'
        GROUP BY
          t.id, s.id, s.status, s.starts_at, s.renews_at,
          p.code, p.name, p.price_usd, p.billing_period, p.max_admin_users,
          p.max_notifications_per_month, p.max_report_history_months, p.automation_included,
          owner_login.email, owner_login.display_name, owner_login.status, owner_login.last_login_at,
          tas.enabled, tas.running, tas.phase, tas.latest_reason, tas.latest_candle_at
        ORDER BY t.created_at DESC
      `),
      query(`
        SELECT
          m.*,
          count(tm.tenant_id)::int AS assigned_tenants
        FROM platform_strategy_modules m
        LEFT JOIN tenant_modules tm ON tm.module_id = m.id AND tm.status = 'ENABLED'
        WHERE m.status = 'ACTIVE'
        GROUP BY m.id
        ORDER BY m.sort_order, m.name
      `),
      query(`
        SELECT
          p.*,
          COALESCE(jsonb_agg(
            jsonb_build_object('code', m.code, 'name', m.name)
            ORDER BY m.sort_order
          ) FILTER (WHERE m.id IS NOT NULL), '[]'::jsonb) AS modules
        FROM subscription_plans p
        LEFT JOIN subscription_plan_modules pm ON pm.plan_id = p.id
        LEFT JOIN platform_strategy_modules m ON m.id = pm.module_id AND m.status = 'ACTIVE'
        GROUP BY p.id
        ORDER BY p.price_usd, p.name
      `),
      platformBillingSummary()
    ]);
    return {
      tenants: tenants.rows,
      modules: modules.rows,
      plans: plans.rows,
      billing,
      metrics: {
        tenants: tenants.rows.length,
        activeTenants: tenants.rows.filter((tenant: any) => tenant.status === "ACTIVE").length,
        modules: modules.rows.length,
        plans: plans.rows.length
      }
    };
  });

  app.get("/api/platform/system-health", async (request) => {
    requirePlatformSuperAdmin(request);
    return platformSystemHealth();
  });

  app.get("/api/platform/business-settings", async (request) => {
    requirePlatformSuperAdmin(request);
    return platformBusinessSettings();
  });

  app.get("/api/platform/push/overview", async (request) => {
    requirePlatformSuperAdmin(request);
    return platformPushOverview();
  });

  app.get("/api/platform/mobile-app/releases", async (request) => {
    requirePlatformSuperAdmin(request);
    const { rows } = await query(
      `SELECT *
       FROM mobile_app_releases
       WHERE status = 'ACTIVE'
       ORDER BY created_at DESC
       LIMIT 20`
    );
    return rows;
  });

  app.post("/api/platform/mobile-app/releases", { bodyLimit: 220 * 1024 * 1024 }, async (request) => {
    const session = requirePlatformSuperAdmin(request);
    const upload = await parseMobileAppReleaseUpload(request);
    const body = upload.fields as {
      fileName?: string;
      contentBase64?: string;
      changelog?: string;
      versionName?: string;
      versionCode?: number | string | null;
      packageName?: string;
      platform?: string;
    };
    const fileName = safeApkFileName(upload.fileName ?? body.fileName);
    if (!fileName || !upload.buffer.length) {
      const error = new Error("APK file is required.") as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }
    const buffer = upload.buffer;
    if (!buffer.length || buffer.subarray(0, 2).toString("utf8") !== "PK") {
      const error = new Error("Uploaded file must be a valid APK archive.") as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }
    const detected = detectApkVersion(buffer, fileName);
    const fallbackVersionCode = Math.floor(Date.now() / 1000);
    const versionName = String(body.versionName ?? detected.versionName ?? `0.1.${fallbackVersionCode}`).trim();
    const versionCode = Number(body.versionCode ?? detected.versionCode ?? inferVersionCodeFromName(versionName) ?? fallbackVersionCode);
    const packageName = String(body.packageName ?? detected.packageName ?? "").trim() || null;
    const platform = String(body.platform ?? "android").toLowerCase() === "android" ? "android" : "android";
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const previousReleases = await query(
      `SELECT id, storage_path
       FROM mobile_app_releases
       WHERE platform = $1`,
      [platform]
    );
    const releasesDir = resolve(process.cwd(), "../../data/mobile-releases");
    await mkdir(releasesDir, { recursive: true });
    const storedFileName = `${Date.now()}-${versionName.replace(/[^a-zA-Z0-9._-]/g, "_")}-${fileName}`;
    const storagePath = resolve(releasesDir, storedFileName);
    await writeFile(storagePath, buffer, { mode: 0o640 });
    const downloadPath = `/api/mobile/app-releases/${storedFileName}`;
    const result = await query(
      `INSERT INTO mobile_app_releases (
         platform, version_name, version_code, package_name, file_name, storage_path, download_path,
         file_size_bytes, sha256, changelog, uploaded_by_admin_user_id
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        platform,
        versionName,
        Number.isFinite(versionCode) ? versionCode : null,
        packageName,
        fileName,
        storagePath,
        downloadPath,
        buffer.length,
        sha256,
        body.changelog ?? "",
        session.sub
      ]
    );
    await query(
      `UPDATE mobile_app_releases
       SET status = 'SUPERSEDED'
       WHERE platform = $1
         AND status = 'ACTIVE'
         AND id <> $2`,
      [platform, result.rows[0].id]
    );
    await removeSupersededApkFiles(previousReleases.rows.map((row: any) => row.storage_path), storagePath);
    await query(
      `DELETE FROM mobile_app_releases
       WHERE platform = $1
         AND id <> $2`,
      [platform, result.rows[0].id]
    );
    await redisClient()?.del("platform:bundle:v1").catch(() => undefined);
    await writeAudit(session.sub, "MOBILE_APP_RELEASE_UPLOADED", "mobile_app_release", result.rows[0].id, null, {
      versionName,
      versionCode: Number.isFinite(versionCode) ? versionCode : null,
      packageName,
      fileName,
      bytes: buffer.length,
      sha256
    });
    return result.rows[0];
  });

  app.post("/api/platform/push/test", async (request) => {
    const session = requirePlatformSuperAdmin(request);
    const latest = await query(
      `SELECT tenant_id
       FROM mobile_push_tokens
       WHERE enabled = true
       ORDER BY last_seen_at DESC
       LIMIT 1`
    );
    if (!latest.rows[0]?.tenant_id) return { sent: 0, skipped: true, reason: "NO_ACTIVE_DEVICE" };
    const eventKey = `platform-push-test-${Date.now()}`;
    const result = await sendTenantPush({
      tenantId: latest.rows[0].tenant_id,
      title: "Platform push test",
      body: "Firebase/Expo push delivery is connected from Platform Admin.",
      eventKey,
      eventType: "PLATFORM_PUSH_TEST",
      force: true,
      data: { eventKey, eventType: "PLATFORM_PUSH_TEST", actorId: session.sub }
    });
    await writeAudit(session.sub, "PLATFORM_PUSH_TEST", "mobile_push", eventKey, null, result);
    return result;
  });

  app.put("/api/platform/business-settings", async (request) => {
    const session = requirePlatformSuperAdmin(request);
    const body = request.body as { value?: unknown };
    const validated = validateSetting("platform.business", body.value);
    const before = await query("SELECT * FROM app_settings WHERE key = 'platform.business'");
    const { rows } = await query(
      `UPDATE app_settings
       SET value = $1::jsonb, updated_by = $2, updated_at = now()
       WHERE key = 'platform.business'
       RETURNING value`,
      [JSON.stringify(validated), session.sub]
    );
    await writeAudit(session.sub, "PLATFORM_BUSINESS_SETTINGS_UPDATE", "app_setting", "platform.business", before.rows[0] ?? null, rows[0] ?? null);
    return rows[0]?.value ?? validated;
  });

  app.get("/api/support-info", async (request) => {
    requirePermission(request, "dashboard.view");
    return platformBusinessSettings();
  });

  app.post("/api/platform/tenants", async (request) => {
    const session = requirePlatformSuperAdmin(request);
    const body = request.body as { name?: string; ownerEmail?: string; password?: string; planCode?: string; moduleCodes?: string[] };
    const name = body.name?.trim();
    if (!name) return { error: "Subscriber name is required." };
    const ownerEmail = body.ownerEmail?.toLowerCase().trim();
    if (!ownerEmail) return { error: "Subscriber email is required." };
    const password = body.password?.trim();
    if (!password) return { error: "Subscriber password is required." };
    const slug = slugify(name);
    const planCode = body.planCode ?? "starter_orb";
    const tenant = await query(
      `INSERT INTO platform_tenants (name, slug, owner_email)
       VALUES ($1,$2,$3)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, owner_email = EXCLUDED.owner_email, updated_at = now()
       RETURNING *`,
      [name, slug, ownerEmail]
    );
    await assignPlanAndModules(tenant.rows[0].id, planCode, body.moduleCodes ?? [], session.sub);
    const login = await upsertSubscriberLogin(tenant.rows[0].id, {
      email: ownerEmail,
      displayName: name,
      password,
      roleCode: "owner_admin"
    });
    await writeAudit(session.sub, "SUBSCRIBER_UPSERT", "platform_tenant", tenant.rows[0].id, null, { ...tenant.rows[0], planCode, moduleCodes: body.moduleCodes ?? [], loginEmail: login.email });
    return { ...tenant.rows[0], primaryLogin: login };
  });

  app.put("/api/platform/tenants/:id/modules", async (request) => {
    const session = requirePlatformSuperAdmin(request);
    const { id } = request.params as { id: string };
    const body = request.body as { planCode?: string; moduleCodes?: string[] };
    await assignPlanAndModules(id, body.planCode ?? "starter_orb", body.moduleCodes ?? [], session.sub);
    await writeAudit(session.sub, "TENANT_MODULES_UPDATE", "platform_tenant", id, null, body);
    return { tenantId: id, planCode: body.planCode, moduleCodes: body.moduleCodes ?? [] };
  });

  app.put("/api/platform/tenants/:id/status", async (request) => {
    const session = requirePlatformSuperAdmin(request);
    const { id } = request.params as { id: string };
    const body = request.body as { status?: string };
    const status = subscriberStatus(body.status);
    const before = await query("SELECT * FROM platform_tenants WHERE id = $1 LIMIT 1", [id]);
    if (!before.rows[0]) {
      const error = new Error("Subscriber not found.") as Error & { statusCode?: number };
      error.statusCode = 404;
      throw error;
    }
    const { rows } = await query(
      `UPDATE platform_tenants
       SET status = $2, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, status]
    );
    const loginStatus = status === "ACTIVE" ? "ACTIVE" : status === "PAUSED" ? "SUSPENDED" : "DISABLED";
    await query("UPDATE admin_users SET status = $2, updated_at = now() WHERE tenant_id = $1 AND platform_super_admin = false", [id, loginStatus]);
    await query(
      `UPDATE admin_sessions
       SET revoked_at = now(), last_seen_at = now()
       WHERE admin_user_id IN (
         SELECT id FROM admin_users WHERE tenant_id = $1 AND platform_super_admin = false
       )
       AND revoked_at IS NULL`,
      [id]
    );
    if (status === "ACTIVE") {
      await query(
        `UPDATE tenant_automation_states
         SET enabled = true,
             running = false,
             phase = CASE WHEN phase = 'PAUSED' THEN 'STARTING' ELSE phase END,
             latest_reason = 'Subscriber account is active. Automation will resume on the next heartbeat.',
             updated_at = now()
         WHERE tenant_id = $1`,
        [id]
      );
    } else {
      const reason = status === "PAUSED"
        ? "Subscriber account is paused by platform admin. Login and automation are disabled."
        : "Subscriber account is removed by platform admin. Login and automation are disabled.";
      await query(
        `UPDATE tenant_automation_states
         SET enabled = false,
             running = false,
             phase = 'PAUSED',
             latest_reason = $2,
             updated_at = now()
         WHERE tenant_id = $1`,
        [id, reason]
      );
    }
    if (status === "REMOVED") {
      await query(
        `UPDATE tenant_subscriptions
         SET status = 'CANCELED', updated_at = now()
         WHERE tenant_id = $1
           AND id = (
             SELECT id FROM tenant_subscriptions
             WHERE tenant_id = $1
             ORDER BY created_at DESC
             LIMIT 1
           )`,
        [id]
      );
    }
    await writeAudit(session.sub, "SUBSCRIBER_STATUS_UPDATE", "platform_tenant", id, before.rows[0], rows[0]);
    return rows[0];
  });

  app.delete("/api/platform/tenants/:id", async (request) => {
    const session = requirePlatformSuperAdmin(request);
    const { id } = request.params as { id: string };
    const before = await query("SELECT * FROM platform_tenants WHERE id = $1 LIMIT 1", [id]);
    if (!before.rows[0]) {
      const error = new Error("Subscriber not found.") as Error & { statusCode?: number };
      error.statusCode = 404;
      throw error;
    }
    const loginUsers = await query("SELECT id FROM admin_users WHERE tenant_id = $1 AND platform_super_admin = false", [id]);
    await query(
      `UPDATE admin_sessions
       SET revoked_at = now(), last_seen_at = now()
       WHERE admin_user_id IN (
         SELECT id FROM admin_users WHERE tenant_id = $1 AND platform_super_admin = false
       )
       AND revoked_at IS NULL`,
      [id]
    );
    await query("DELETE FROM admin_users WHERE tenant_id = $1 AND platform_super_admin = false", [id]);
    const deleted = await query("DELETE FROM platform_tenants WHERE id = $1 RETURNING *", [id]);
    await writeAudit(session.sub, "SUBSCRIBER_DELETE", "platform_tenant", id, before.rows[0], {
      deleted: deleted.rows[0] ?? null,
      loginUsersDeleted: loginUsers.rows.length
    });
    return { deleted: true, tenant: deleted.rows[0], loginUsersDeleted: loginUsers.rows.length };
  });

  app.put("/api/platform/tenants/:id/subscription", async (request) => {
    const session = requirePlatformSuperAdmin(request);
    const { id } = request.params as { id: string };
    const body = request.body as { status?: string; renewsAt?: string | null };
    const status = subscriptionStatus(body.status);
    const before = await query(
      `SELECT s.*
       FROM tenant_subscriptions s
       WHERE s.tenant_id = $1
       ORDER BY s.created_at DESC
       LIMIT 1`,
      [id]
    );
    if (!before.rows[0]) {
      const error = new Error("Tenant subscription not found.") as Error & { statusCode?: number };
      error.statusCode = 404;
      throw error;
    }
    const { rows } = await query(
      `UPDATE tenant_subscriptions
       SET status = $2, renews_at = $3::timestamptz, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [before.rows[0].id, status, body.renewsAt || null]
    );
    if (!["TRIAL", "ACTIVE"].includes(status)) {
      await query(
        `INSERT INTO tenant_automation_states (tenant_id, enabled, running, phase, latest_reason, updated_at)
         VALUES ($1,false,false,'PAUSED','Subscription is inactive. Automation paused.',now())
         ON CONFLICT (tenant_id) DO UPDATE SET
           enabled = false,
           running = false,
           phase = 'PAUSED',
           latest_reason = 'Subscription is inactive. Automation paused.',
           updated_at = now()`,
        [id]
      );
    } else {
      await query(
        `INSERT INTO tenant_automation_states (tenant_id, enabled, running, phase, latest_reason, updated_at)
         VALUES ($1,true,false,'STARTING','Subscription is active. Automation will resume on the next heartbeat.',now())
         ON CONFLICT (tenant_id) DO UPDATE SET
           enabled = true,
           phase = CASE WHEN tenant_automation_states.phase = 'PAUSED' THEN 'STARTING' ELSE tenant_automation_states.phase END,
           latest_reason = 'Subscription is active. Automation will resume on the next heartbeat.',
           updated_at = now()`,
        [id]
      );
    }
    await writeAudit(session.sub, "TENANT_SUBSCRIPTION_UPDATE", "tenant_subscription", rows[0].id, before.rows[0], rows[0]);
    return rows[0];
  });

  app.post("/api/platform/billing/invoices/:id/status", async (request) => {
    const session = requirePlatformSuperAdmin(request);
    const { id } = request.params as { id: string };
    const body = request.body as { status?: string };
    const status = String(body.status ?? "").toUpperCase();
    if (!["PAID", "PAST_DUE", "CANCELED"].includes(status)) {
      const error = new Error("Invoice status must be PAID, PAST_DUE, or CANCELED.") as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }
    const before = await query("SELECT * FROM subscription_invoices WHERE id = $1", [id]);
    const result = await handleBillingWebhook({ provider: "manual", invoiceId: id, status });
    await writeAudit(session.sub, "MANUAL_INVOICE_STATUS_UPDATE", "subscription_invoice", id, before.rows[0] ?? null, result);
    return result;
  });

  app.get("/api/platform/tenants/:id/settings", async (request) => {
    requirePlatformSuperAdmin(request);
    const { id } = request.params as { id: string };
    return listTenantSettings(id);
  });

  app.post("/api/platform/tenants/:id/admin-users", async (request) => {
    const session = requirePlatformSuperAdmin(request);
    const { id } = request.params as { id: string };
    const body = request.body as { email?: string; displayName?: string; password?: string };
    const email = body.email?.toLowerCase().trim();
    if (!email) return { error: "Email is required." };
    const login = await upsertSubscriberLogin(id, {
      email,
      displayName: body.displayName?.trim() || email,
      password: body.password?.trim() || "ChangeMe123!",
      roleCode: "owner_admin"
    });
    await writeAudit(session.sub, "SUBSCRIBER_LOGIN_UPSERT", "admin_user", login.id, null, { ...login, temporaryPasswordSet: true });
    return login;
  });

  app.put("/api/platform/tenants/:id/owner-password", async (request) => {
    const session = requirePlatformSuperAdmin(request);
    const { id } = request.params as { id: string };
    const body = request.body as { password?: string };
    const password = body.password?.trim();
    if (!password || password.length < 4) {
      const error = new Error("Temporary password must be at least 4 characters.") as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }
    const before = await query(
      `SELECT *
       FROM admin_users
       WHERE tenant_id = $1
         AND platform_super_admin = false
       ORDER BY created_at ASC
       LIMIT 1`,
      [id]
    );
    if (!before.rows[0]) {
      const error = new Error("Subscriber login not found.") as Error & { statusCode?: number };
      error.statusCode = 404;
      throw error;
    }
    const passwordHash = await hashPassword(password);
    const { rows } = await query(
      `UPDATE admin_users
       SET password_hash = $2,
           password_change_required = true,
           updated_at = now()
       WHERE id = $1
       RETURNING id, email, display_name, status, tenant_id, password_change_required, updated_at`,
      [before.rows[0].id, passwordHash]
    );
    await query("UPDATE admin_sessions SET revoked_at = now(), last_seen_at = now() WHERE admin_user_id = $1 AND revoked_at IS NULL", [before.rows[0].id]);
    await writeAudit(session.sub, "SUBSCRIBER_PASSWORD_RESET", "admin_user", before.rows[0].id, { email: before.rows[0].email }, { email: rows[0].email, temporaryPasswordSet: true });
    return rows[0];
  });

  app.get("/api/platform/tenants/:id/activity", async (request) => {
    requirePlatformSuperAdmin(request);
    const { id } = request.params as { id: string };
    const [audit, tickets, invoices] = await Promise.all([
      query(
        `SELECT l.*, u.email, u.display_name
         FROM admin_audit_logs l
         LEFT JOIN admin_users u ON u.id = l.admin_user_id
         WHERE l.resource_id = $1
            OR l.new_value @> $2::jsonb
            OR l.old_value @> $2::jsonb
         ORDER BY l.created_at DESC
         LIMIT 50`,
        [id, JSON.stringify({ tenant_id: id })]
      ),
      query(
        `SELECT st.*, m.name AS requested_module_name, u.email AS created_by_email
         FROM platform_support_tickets st
         LEFT JOIN platform_strategy_modules m ON m.code = st.requested_module_code
         LEFT JOIN admin_users u ON u.id = st.created_by
         WHERE st.tenant_id = $1
         ORDER BY st.created_at DESC
         LIMIT 50`,
        [id]
      ),
      query(
        `SELECT i.*, p.name AS plan_name
         FROM subscription_invoices i
         LEFT JOIN subscription_plans p ON p.id = i.plan_id
         WHERE i.tenant_id = $1
         ORDER BY i.created_at DESC
         LIMIT 20`,
        [id]
      )
    ]);
    return { audit: audit.rows, tickets: tickets.rows, invoices: invoices.rows };
  });

  app.get("/api/platform/support-tickets", async (request) => {
    requirePlatformSuperAdmin(request);
    const { rows } = await query(
      `SELECT
         st.*,
         t.name AS tenant_name,
         t.owner_email,
         m.name AS requested_module_name,
         creator.email AS created_by_email,
         resolver.email AS resolved_by_email
       FROM platform_support_tickets st
       JOIN platform_tenants t ON t.id = st.tenant_id
       LEFT JOIN platform_strategy_modules m ON m.code = st.requested_module_code
       LEFT JOIN admin_users creator ON creator.id = st.created_by
       LEFT JOIN admin_users resolver ON resolver.id = st.resolved_by
       ORDER BY
         CASE st.status
           WHEN 'OPEN' THEN 0
           WHEN 'IN_PROGRESS' THEN 1
           WHEN 'WAITING_USER' THEN 2
           WHEN 'RESOLVED' THEN 3
           ELSE 4
         END,
         CASE st.priority
           WHEN 'URGENT' THEN 0
           WHEN 'HIGH' THEN 1
           WHEN 'NORMAL' THEN 2
           ELSE 3
         END,
         st.created_at DESC
       LIMIT 200`
    );
    return rows;
  });

  app.post("/api/tenant/support-tickets", async (request) => {
    const session = requireAdmin(request);
    if (session.platformSuperAdmin || !session.tenantId) {
      const error = new Error("Subscriber account required.") as Error & { statusCode?: number };
      error.statusCode = 403;
      throw error;
    }
    const body = request.body as { ticketType?: string; priority?: string; title?: string; description?: string; requestedModuleCode?: string | null };
    const title = body.title?.trim();
    if (!title) return { error: "Ticket title is required." };
    const ticketType = supportTicketType(body.ticketType);
    const priority = supportTicketPriority(body.priority ?? (ticketType === "FORGOT_PASSWORD" ? "HIGH" : "NORMAL"));
    const { rows } = await query(
      `INSERT INTO platform_support_tickets (
        tenant_id, ticket_type, priority, title, description, requested_module_code, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *`,
      [
        session.tenantId,
        ticketType,
        priority,
        title,
        body.description?.trim() || null,
        ticketType === "MODULE_UPGRADE" ? body.requestedModuleCode || null : null,
        session.sub
      ]
    );
    await writeAudit(session.sub, "TENANT_SUPPORT_TICKET_CREATE", "platform_support_ticket", rows[0].id, null, rows[0]);
    return rows[0];
  });

  app.put("/api/platform/support-tickets/:ticketId", async (request) => {
    const session = requirePlatformSuperAdmin(request);
    const { ticketId } = request.params as { ticketId: string };
    const body = request.body as { status?: string; priority?: string };
    const before = await query("SELECT * FROM platform_support_tickets WHERE id = $1", [ticketId]);
    if (!before.rows[0]) {
      const error = new Error("Support ticket not found.") as Error & { statusCode?: number };
      error.statusCode = 404;
      throw error;
    }
    const status = supportTicketStatus(body.status);
    const priority = supportTicketPriority(body.priority ?? before.rows[0].priority);
    const { rows } = await query(
      `UPDATE platform_support_tickets
       SET status = $2,
           priority = $3,
           resolved_by = CASE WHEN $2 IN ('RESOLVED','CLOSED') THEN $4 ELSE resolved_by END,
           resolved_at = CASE WHEN $2 IN ('RESOLVED','CLOSED') THEN now() ELSE resolved_at END,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [ticketId, status, priority, session.sub]
    );
    await writeAudit(session.sub, "SUPPORT_TICKET_UPDATE", "platform_support_ticket", ticketId, before.rows[0], rows[0]);
    return rows[0];
  });

  app.get("/api/tenant/admin-users", async (request) => {
    requirePermission(request, "permissions.manage");
    const error = new Error("Subscriber accounts are managed by the platform admin.") as Error & { statusCode?: number };
    error.statusCode = 403;
    throw error;
  });

  app.post("/api/tenant/admin-users", async (request) => {
    requirePermission(request, "permissions.manage");
    const error = new Error("Subscriber accounts are managed by the platform admin.") as Error & { statusCode?: number };
    error.statusCode = 403;
    throw error;
  });

  app.put("/api/tenant/admin-users/:id", async (request) => {
    requirePermission(request, "permissions.manage");
    const error = new Error("Subscriber accounts are managed by the platform admin.") as Error & { statusCode?: number };
    error.statusCode = 403;
    throw error;
  });

  app.get("/api/tenant/settings", async (request) => {
    const session = requirePermission(request, "settings.manage");
    if (!session.tenantId) return [];
    return listTenantSettings(session.tenantId);
  });

  app.put("/api/tenant/settings/:key", async (request) => {
    const session = requirePermission(request, "settings.manage");
    if (!session.tenantId) {
      const error = new Error("Tenant context required.") as Error & { statusCode?: number };
      error.statusCode = 403;
      throw error;
    }
    const { key } = request.params as { key: string };
    const body = request.body as { value?: unknown };
    const before = await query("SELECT * FROM tenant_settings WHERE tenant_id = $1 AND key = $2", [session.tenantId, key]);
    const saved = await updateTenantSetting(session.tenantId, key, body.value, session.sub);
    await writeAudit(session.sub, "TENANT_SETTING_UPDATE", "tenant_setting", `${session.tenantId}:${key}`, before.rows[0] ?? null, saved);
    return saved;
  });

  app.get("/api/tenant/modules/:moduleCode/settings", async (request) => {
    const { moduleCode } = request.params as { moduleCode: string };
    const session = await requireTenantModule(request, moduleCode);
    if (!session.tenantId) return [];
    return listTenantModuleSettings(session.tenantId, moduleCode);
  });

  app.put("/api/tenant/modules/:moduleCode/settings/:key", async (request) => {
    const { moduleCode, key } = request.params as { moduleCode: string; key: string };
    const session = await requireTenantModule(request, moduleCode);
    if (!session.tenantId) {
      const error = new Error("Tenant context required.") as Error & { statusCode?: number };
      error.statusCode = 403;
      throw error;
    }
    const body = request.body as { value?: unknown };
    if (moduleCode === "high_probability_strategy_2" && key === "liquiditySweep.strategy") {
      const active = await query(
        `SELECT id
         FROM trading_sessions
         WHERE tenant_id = $1
           AND module_code = $2
           AND now() >= session_start_at
           AND now() <= signal_window_end_at
           AND state NOT IN ('SESSION_EXPIRED','SESSION_COMPLETED','TRADE_CLOSED')
         LIMIT 1`,
        [session.tenantId, moduleCode]
      );
      if (active.rows[0]) {
        const error = new Error("Module 2 settings are locked while the strategy cycle is active. Change them after the active cycle closes.") as Error & { statusCode?: number };
        error.statusCode = 423;
        throw error;
      }
      const minimumRiskReward = Number((body.value as any)?.minimumRiskReward ?? 2);
      if (Number.isFinite(minimumRiskReward) && minimumRiskReward < 2) {
        const error = new Error("Module 2 minimum R:R cannot be lower than 2:1.") as Error & { statusCode?: number };
        error.statusCode = 400;
        throw error;
      }
    }
    const before = await query(
      "SELECT * FROM tenant_module_settings WHERE tenant_id = $1 AND module_code = $2 AND key = $3",
      [session.tenantId, moduleCode, key]
    );
    const saved = await updateTenantModuleSetting(session.tenantId, moduleCode, key, body.value, session.sub);
    if (moduleCode === "high_probability_strategy_2" && key === "liquiditySweep.strategy") {
      await query(
        `INSERT INTO notifications (tenant_id, event_key, event_type, title, body, priority)
         VALUES ($1,$2,'MODULE2_REHEARSAL_REQUIRED','Module 2 rehearsal required','Module 2 settings changed. Run launch rehearsal before trusting the next all-session signal.','HIGH')
         ON CONFLICT (event_key) DO NOTHING`,
        [session.tenantId, `module2-rehearsal-required-${session.tenantId}-${Date.now()}`]
      );
    }
    await writeAudit(session.sub, "TENANT_MODULE_SETTING_UPDATE", "tenant_module_setting", `${session.tenantId}:${moduleCode}:${key}`, before.rows[0] ?? null, saved);
    return saved;
  });

  app.get("/api/admin/permissions", async (request) => {
    requirePlatformSuperAdmin(request);
    const [roles, permissions, users] = await Promise.all([
      query(`
        SELECT
          r.*,
          COALESCE(jsonb_agg(p.code ORDER BY p.code) FILTER (WHERE p.code IS NOT NULL), '[]'::jsonb) AS permissions
        FROM admin_roles r
        LEFT JOIN admin_role_permissions rp ON rp.role_id = r.id
        LEFT JOIN admin_permissions p ON p.code = rp.permission_code
        GROUP BY r.id
        ORDER BY r.system_role DESC, r.name
      `),
      query("SELECT * FROM admin_permissions ORDER BY category, name"),
      query(`
        SELECT
          u.id, u.email, u.display_name, u.status, u.last_login_at, u.created_at,
          COALESCE(jsonb_agg(r.code ORDER BY r.code) FILTER (WHERE r.code IS NOT NULL), '[]'::jsonb) AS roles
        FROM admin_users u
        LEFT JOIN admin_user_roles ur ON ur.user_id = u.id
        LEFT JOIN admin_roles r ON r.id = ur.role_id
        GROUP BY u.id
        ORDER BY u.created_at DESC
      `)
    ]);
    return { roles: roles.rows, permissions: permissions.rows, users: users.rows };
  });

  app.post("/api/admin/roles", async (request) => {
    const session = requirePlatformSuperAdmin(request);
    const body = request.body as { name?: string; description?: string; permissions?: string[] };
    const code = slugify(body.name ?? "");
    if (!code) return { error: "Role name is required." };
    const { rows } = await query(
      `INSERT INTO admin_roles (code, name, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, updated_at = now()
       RETURNING *`,
      [code, body.name, body.description ?? null]
    );
    await replaceRolePermissions(rows[0].id, body.permissions ?? []);
    await writeAudit(session.sub, "ROLE_UPSERT", "admin_role", rows[0].id, null, { ...rows[0], permissions: body.permissions ?? [] });
    return rows[0];
  });

  app.put("/api/admin/roles/:id/permissions", async (request) => {
    const session = requirePlatformSuperAdmin(request);
    const { id } = request.params as { id: string };
    const body = request.body as { permissions?: string[] };
    const before = await query("SELECT permission_code FROM admin_role_permissions WHERE role_id = $1 ORDER BY permission_code", [id]);
    await replaceRolePermissions(id, body.permissions ?? []);
    await writeAudit(session.sub, "ROLE_PERMISSIONS_UPDATE", "admin_role", id, before.rows, body.permissions ?? []);
    return { id, permissions: body.permissions ?? [] };
  });

  app.get("/api/admin/settings", async (request) => {
    requirePermission(request, "settings.manage");
    const { rows } = await query("SELECT * FROM app_settings ORDER BY category, key");
    return rows;
  });

  app.put("/api/admin/settings/:key", async (request) => {
    const session = requirePermission(request, "settings.manage");
    const { key } = request.params as { key: string };
    const body = request.body as { value?: unknown };
    const validatedValue = validateSetting(key, body.value);
    const before = await query("SELECT * FROM app_settings WHERE key = $1", [key]);
    const { rows } = await query(
      `UPDATE app_settings
       SET value = $2::jsonb, updated_by = $3, updated_at = now()
       WHERE key = $1
       RETURNING *`,
      [key, JSON.stringify(validatedValue), session.sub]
    );
    await writeAudit(session.sub, "SETTING_UPDATE", "app_setting", key, before.rows[0] ?? null, rows[0] ?? null);
    return rows[0];
  });

  app.get("/api/admin/audit-logs", async (request) => {
    requirePermission(request, "settings.manage");
    const { rows } = await query(
      `SELECT l.*, u.email, u.display_name
       FROM admin_audit_logs l
       LEFT JOIN admin_users u ON u.id = l.admin_user_id
       ORDER BY l.created_at DESC
       LIMIT 100`
    );
    return rows;
  });

  app.get("/api/platform/security-audit", async (request) => {
    requirePlatformSuperAdmin(request);
    const [security, actions, sessions, mfa] = await Promise.all([
      query(
        `SELECT se.*, u.email AS admin_email, u.display_name
         FROM security_events se
         LEFT JOIN admin_users u ON u.id = se.admin_user_id
         ORDER BY se.created_at DESC
         LIMIT 100`
      ),
      query(
        `SELECT l.*, u.email, u.display_name
         FROM admin_audit_logs l
         LEFT JOIN admin_users u ON u.id = l.admin_user_id
         WHERE l.action LIKE 'SUBSCRIBER_%'
            OR l.action LIKE 'TENANT_%'
            OR l.action LIKE 'MANUAL_%'
            OR l.action LIKE 'ROLE_%'
            OR l.action = 'AUTH_LOGIN'
         ORDER BY l.created_at DESC
         LIMIT 100`
      ),
      query(
        `SELECT
           s.id,
           s.admin_user_id,
           u.email,
           u.display_name,
           u.platform_super_admin,
           s.ip_address,
           s.user_agent,
           s.expires_at,
           s.revoked_at,
           s.created_at,
           s.last_seen_at
         FROM admin_sessions s
         JOIN admin_users u ON u.id = s.admin_user_id
         ORDER BY s.last_seen_at DESC
         LIMIT 100`
      ),
      query(
        `SELECT
           count(*)::int AS total_admins,
           count(*) FILTER (WHERE mfa_enabled = true)::int AS mfa_enabled,
           count(*) FILTER (WHERE platform_super_admin = true)::int AS platform_super_admins,
           count(*) FILTER (WHERE platform_super_admin = true AND mfa_enabled = true)::int AS platform_super_admins_with_mfa
         FROM admin_users
         WHERE status = 'ACTIVE'`
      )
    ]);
    return { security: security.rows, actions: actions.rows, sessions: sessions.rows, mfa: mfa.rows[0] ?? {} };
  });

  app.post("/api/platform/admin-users/:id/password-reset-token", async (request) => {
    const session = requirePlatformSuperAdmin(request);
    const params = request.params as { id: string };
    const { rows } = await query("SELECT id, email FROM admin_users WHERE id = $1 AND status = 'ACTIVE' LIMIT 1", [params.id]);
    const admin = rows[0];
    if (!admin) {
      const error = new Error("Admin user not found.") as Error & { statusCode?: number };
      error.statusCode = 404;
      throw error;
    }
    const resetToken = randomBytes(32).toString("base64url");
    await query(
      `INSERT INTO admin_password_reset_tokens (admin_user_id, token_hash, expires_at, requested_ip_address, requested_user_agent)
       VALUES ($1, $2, now() + interval '30 minutes', $3, $4)`,
      [admin.id, createHash("sha256").update(resetToken).digest("hex"), request.ip ?? null, String(request.headers["user-agent"] ?? "")]
    );
    await writeAudit(session.sub, "ADMIN_PASSWORD_RESET_TOKEN_CREATED", "admin_user", admin.id, null, { email: admin.email });
    return { adminUserId: admin.id, email: admin.email, resetToken, expiresInMinutes: 30 };
  });

  app.get("/api/platform/operational-events", async (request) => {
    requirePlatformSuperAdmin(request);
    const search = request.query as { category?: string; severity?: string; limit?: string };
    const limit = Math.min(Math.max(Number(search.limit ?? 80), 10), 200);
    const params: unknown[] = [];
    const filters = [];
    if (search.category) {
      params.push(search.category);
      filters.push(`category = $${params.length}`);
    }
    if (search.severity) {
      params.push(search.severity);
      filters.push(`severity = $${params.length}`);
    }
    params.push(limit);
    const { rows } = await query(
      `SELECT *
       FROM operational_events
       ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params
    );
    return {
      retentionDays: config.operationalEventRetentionDays,
      slowRequestThresholdMs: config.slowRequestThresholdMs,
      events: rows
    };
  });

  app.get("/api/platform/backups/status", async (request) => {
    requirePlatformSuperAdmin(request);
    return backupStatus();
  });

  app.get("/api/admin/orb-learning/latest", async (request) => {
    const session = requirePermission(request, "reports.view");
    if (!session.tenantId) throw tenantContextRequired();
    const run = await query("SELECT * FROM orb_learning_runs WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT 1", [session.tenantId]);
    if (!run.rows[0]) return null;
    const recommendations = await query(
      `SELECT *
       FROM orb_learning_recommendations
       WHERE learning_run_id = $1
       ORDER BY
         CASE confidence WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
         created_at DESC`,
      [run.rows[0].id]
    );
    return { ...run.rows[0], recommendations: recommendations.rows };
  });

  app.post("/api/admin/orb-learning/run", async (request) => {
    const session = requirePermission(request, "reports.view");
    if (!session.tenantId) throw tenantContextRequired();
    const result = await runOrbLearningPython(session.tenantId);
    await writeAudit(session.sub, "ORB_LEARNING_RUN", "orb_learning_run", result.runId ?? null, null, result);
    return result;
  });
}

function tenantContextRequired() {
  const error = new Error("Subscriber account context required for Module 1 learning.") as Error & { statusCode?: number };
  error.statusCode = 403;
  return error;
}

async function platformBusinessSettings() {
  const { rows } = await query("SELECT value FROM app_settings WHERE key = 'platform.business' LIMIT 1");
  return validateSetting("platform.business", rows[0]?.value ?? {});
}

async function platformPushOverview() {
  const [devices, delivery, latest] = await Promise.all([
    query(
      `SELECT
         count(*)::int AS total_devices,
         count(*) FILTER (WHERE enabled = true)::int AS active_devices,
         count(*) FILTER (WHERE enabled = true AND fcm_token IS NOT NULL)::int AS firebase_devices,
         count(*) FILTER (WHERE enabled = true AND expo_push_token IS NOT NULL AND expo_push_token NOT LIKE 'fcm:%')::int AS expo_devices,
         max(last_seen_at) AS latest_seen_at
       FROM mobile_push_tokens`
    ),
    query(
      `SELECT status, count(*)::int AS count
       FROM mobile_push_delivery_logs
       WHERE created_at >= now() - interval '7 days'
       GROUP BY status
       ORDER BY count DESC`
    ),
    query(
      `SELECT l.*, t.name AS subscriber_name
       FROM mobile_push_delivery_logs l
       LEFT JOIN platform_tenants t ON t.id = l.tenant_id
       ORDER BY l.created_at DESC
       LIMIT 20`
    )
  ]);
  return {
    health: pushProviderHealth(),
    devices: devices.rows[0] ?? {},
    delivery: delivery.rows,
    latest: latest.rows
  };
}

function safeApkFileName(value?: string) {
  const fileName = String(value ?? "").split(/[\\/]/).pop()?.replace(/[^a-zA-Z0-9._-]/g, "_") ?? "";
  if (!fileName.toLowerCase().endsWith(".apk")) return "";
  return fileName;
}

function detectApkVersion(buffer: Buffer, fileName: string) {
  const ascii = buffer.toString("latin1");
  const fileVersion = fileName.match(/(?:^|[-_v])(\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9._-]+)?)(?:[-_.]|$)/)?.[1];
  const textVersion =
    ascii.match(/versionName[^\d]{0,32}(\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9._-]+)?)/i)?.[1] ??
    ascii.match(/expo\.version[^\d]{0,32}(\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9._-]+)?)/i)?.[1] ??
    fileVersion;
  const textCode =
    ascii.match(/versionCode[^\d]{0,32}(\d{1,10})/i)?.[1] ??
    fileName.match(/(?:code|vc)[-_]?(\d{1,10})/i)?.[1];
  const packageName =
    ascii.match(/package[^\w.]{0,32}([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){2,})/i)?.[1] ??
    ascii.match(/applicationId[^\w.]{0,32}([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){2,})/i)?.[1] ??
    "com.onehub.fxindicator";
  return {
    versionName: textVersion,
    versionCode: textCode ? Number(textCode) : null,
    packageName
  };
}

function inferVersionCodeFromName(versionName: string) {
  const parts = String(versionName).split(/[.+-]/).map((part) => Number(part));
  const last = parts[parts.length - 1];
  return Number.isFinite(last) && last > 0 ? last : null;
}

async function removeSupersededApkFiles(paths: string[], currentPath: string) {
  const uniquePaths = [...new Set(paths.filter((path) => path && path !== currentPath))];
  await Promise.all(uniquePaths.map((path) => unlink(path).catch(() => undefined)));
}

async function parseMobileAppReleaseUpload(request: any): Promise<{ fileName?: string; buffer: Buffer; fields: Record<string, any> }> {
  const fields: Record<string, any> = {};
  if (typeof request.isMultipart === "function" && request.isMultipart()) {
    let fileName = "";
    let buffer = Buffer.alloc(0);
    const parts = request.parts({
      limits: {
        files: 1,
        fileSize: 220 * 1024 * 1024
      }
    });
    for await (const part of parts) {
      if (part.type === "file") {
        fileName = part.filename ?? "";
        buffer = await part.toBuffer();
      } else {
        fields[part.fieldname] = part.value;
      }
    }
    return { fileName, buffer, fields };
  }

  const body = (request.body ?? {}) as { fileName?: string; contentBase64?: string };
  return {
    fileName: body.fileName,
    buffer: body.contentBase64 ? Buffer.from(body.contentBase64, "base64") : Buffer.alloc(0),
    fields: body as Record<string, any>
  };
}

function requirePlatformSuperAdmin(request: Parameters<typeof requirePermission>[0]) {
  const session = requirePermission(request, "platform.manage");
  if (!session.platformSuperAdmin) {
    const error = new Error("Platform super-admin access required.") as Error & { statusCode?: number };
    error.statusCode = 403;
    throw error;
  }
  return session;
}

async function platformBillingSummary() {
  const [revenue, statusCounts, planDistribution, invoices, pendingRequests, auditTrail] = await Promise.all([
    query(`
      SELECT
        COALESCE(sum(amount_paid_usd), 0)::numeric AS paid_revenue,
        COALESCE(sum(amount_due_usd) FILTER (WHERE status IN ('OPEN','PAST_DUE')), 0)::numeric AS outstanding_revenue,
        count(*) FILTER (WHERE status = 'PAID')::int AS paid_invoices,
        count(*) FILTER (WHERE status IN ('OPEN','PAST_DUE'))::int AS open_invoices
      FROM subscription_invoices
    `),
    query(`
      SELECT COALESCE(s.status, 'NO_SUBSCRIPTION') AS status, count(*)::int
      FROM platform_tenants t
      LEFT JOIN LATERAL (
        SELECT status
        FROM tenant_subscriptions
        WHERE tenant_id = t.id
        ORDER BY created_at DESC
        LIMIT 1
      ) s ON true
      GROUP BY COALESCE(s.status, 'NO_SUBSCRIPTION')
      ORDER BY status
    `),
    query(`
      SELECT p.code, p.name, count(s.id)::int AS subscribers
      FROM subscription_plans p
      LEFT JOIN tenant_subscriptions s ON s.plan_id = p.id
      GROUP BY p.id
      ORDER BY p.price_usd, p.name
    `),
    query(`
      SELECT i.*, t.name AS subscriber_name, p.name AS plan_name
      FROM subscription_invoices i
      JOIN platform_tenants t ON t.id = i.tenant_id
      LEFT JOIN subscription_plans p ON p.id = i.plan_id
      ORDER BY i.created_at DESC
      LIMIT 10
    `),
    query(`
      SELECT
        c.*,
        t.name AS subscriber_name,
        t.owner_email AS subscriber_email,
        p.name AS plan_name,
        p.code AS plan_code,
        i.id AS invoice_id,
        i.invoice_number,
        i.status AS invoice_status
      FROM subscription_checkout_sessions c
      JOIN platform_tenants t ON t.id = c.tenant_id
      JOIN subscription_plans p ON p.id = c.plan_id
      LEFT JOIN LATERAL (
        SELECT *
        FROM subscription_invoices
        WHERE tenant_id = c.tenant_id
          AND plan_id = c.plan_id
          AND provider_code = c.provider_code
          AND created_at >= c.created_at - interval '2 seconds'
        ORDER BY created_at DESC
        LIMIT 1
      ) i ON true
      WHERE c.status = 'PENDING'
      ORDER BY c.created_at DESC
      LIMIT 20
    `),
    query(`
      SELECT l.*, u.email, u.display_name
      FROM admin_audit_logs l
      LEFT JOIN admin_users u ON u.id = l.admin_user_id
      WHERE l.action IN ('BILLING_CHECKOUT_CREATED','MANUAL_INVOICE_STATUS_UPDATE')
      ORDER BY l.created_at DESC
      LIMIT 12
    `)
  ]);
  return {
    revenue: revenue.rows[0] ?? {},
    statusCounts: statusCounts.rows,
    planDistribution: planDistribution.rows,
    recentInvoices: invoices.rows,
    pendingRequests: pendingRequests.rows,
    auditTrail: auditTrail.rows
  };
}

function subscriptionStatus(value: string | undefined) {
  const normalized = String(value ?? "TRIAL").toUpperCase();
  if (["TRIAL", "ACTIVE", "PAST_DUE", "CANCELED", "EXPIRED"].includes(normalized)) return normalized;
  throw new Error("Subscription status must be TRIAL, ACTIVE, PAST_DUE, CANCELED, or EXPIRED.");
}

function subscriberStatus(value: string | undefined) {
  const normalized = String(value ?? "ACTIVE").toUpperCase();
  if (["ACTIVE", "PAUSED", "REMOVED"].includes(normalized)) return normalized;
  throw new Error("Subscriber status must be ACTIVE, PAUSED, or REMOVED.");
}

function supportTicketType(value?: string) {
  const normalized = String(value ?? "GENERAL").toUpperCase();
  if (["FORGOT_PASSWORD", "MODULE_UPGRADE", "BILLING", "TECHNICAL", "GENERAL"].includes(normalized)) return normalized;
  throw new Error("Support ticket type is invalid.");
}

function supportTicketPriority(value?: string) {
  const normalized = String(value ?? "NORMAL").toUpperCase();
  if (["LOW", "NORMAL", "HIGH", "URGENT"].includes(normalized)) return normalized;
  throw new Error("Support ticket priority is invalid.");
}

function supportTicketStatus(value?: string) {
  const normalized = String(value ?? "OPEN").toUpperCase();
  if (["OPEN", "IN_PROGRESS", "WAITING_USER", "RESOLVED", "CLOSED"].includes(normalized)) return normalized;
  throw new Error("Support ticket status is invalid.");
}

function adminUserStatus(value: string | undefined) {
  const normalized = String(value ?? "ACTIVE").toUpperCase();
  if (["ACTIVE", "INACTIVE"].includes(normalized)) return normalized;
  throw new Error("Admin user status must be ACTIVE or INACTIVE.");
}

function sanitizeTenantRoleCodes(roleCodes?: string[]) {
  const allowed = new Set(["owner_admin", "trader_operator", "analyst", "data_admin"]);
  const requested = (roleCodes ?? ["trader_operator"]).filter((role) => allowed.has(role));
  return [...new Set(requested.length > 0 ? requested : ["trader_operator"])];
}

async function tenantAdminLimits(tenantId: string) {
  const { rows } = await query(
    `SELECT
       p.max_admin_users,
       count(u.id) FILTER (WHERE u.status = 'ACTIVE' AND u.platform_super_admin = false)::int AS active_admin_users
     FROM platform_tenants t
     LEFT JOIN LATERAL (
       SELECT *
       FROM tenant_subscriptions
       WHERE tenant_id = t.id
       ORDER BY created_at DESC
       LIMIT 1
     ) s ON true
     LEFT JOIN subscription_plans p ON p.id = s.plan_id
     LEFT JOIN admin_users u ON u.tenant_id = t.id
     WHERE t.id = $1
     GROUP BY p.max_admin_users`,
    [tenantId]
  );
  return rows[0] ?? { max_admin_users: null, active_admin_users: 0 };
}

async function assertTenantAdminLimit(tenantId: string, email: string) {
  const existing = await query("SELECT id, status, tenant_id, platform_super_admin FROM admin_users WHERE lower(email) = lower($1) LIMIT 1", [email]);
  if (existing.rows[0] && (existing.rows[0].tenant_id !== tenantId || existing.rows[0].platform_super_admin === true)) {
    const error = new Error("Email is already assigned outside this user account.") as Error & { statusCode?: number };
    error.statusCode = 409;
    throw error;
  }
  if (existing.rows[0]?.status === "ACTIVE") return;
  const limits = await tenantAdminLimits(tenantId);
  const max = limits.max_admin_users == null ? null : Number(limits.max_admin_users);
  const active = Number(limits.active_admin_users ?? 0);
  if (max != null && active >= max) {
    const error = new Error(`Plan allows ${max} active user login(s). Deactivate a login or upgrade the plan.`) as Error & { statusCode?: number };
    error.statusCode = 402;
    throw error;
  }
}

async function upsertSubscriberLogin(
  tenantId: string,
  input: { email: string; displayName: string; password: string; roleCode: "owner_admin" | "trader_operator" | "analyst" | "data_admin" }
) {
  await assertTenantAdminLimit(tenantId, input.email);
  const passwordHash = await hashPassword(input.password);
  const { rows } = await query(
    `INSERT INTO admin_users (email, display_name, password_hash, tenant_id, platform_super_admin, status, password_change_required)
     VALUES ($1,$2,$3,$4,false,'ACTIVE',true)
     ON CONFLICT (email) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       password_hash = EXCLUDED.password_hash,
       tenant_id = EXCLUDED.tenant_id,
       platform_super_admin = false,
       status = 'ACTIVE',
       password_change_required = true,
       updated_at = now()
     RETURNING id, email, display_name, status, tenant_id, platform_super_admin, password_change_required, created_at, updated_at, last_login_at`,
    [input.email, input.displayName, passwordHash, tenantId]
  );
  await query("UPDATE admin_sessions SET revoked_at = now(), last_seen_at = now() WHERE admin_user_id = $1 AND revoked_at IS NULL", [rows[0].id]);
  await query(
    `INSERT INTO admin_user_roles (user_id, role_id)
     SELECT $1, id FROM admin_roles WHERE code = $2
     ON CONFLICT DO NOTHING`,
    [rows[0].id, input.roleCode]
  );
  return rows[0];
}

async function tenantAssignableRoles() {
  const { rows } = await query(
    `SELECT id, code, name, description
     FROM admin_roles
     WHERE code IN ('owner_admin', 'trader_operator', 'analyst', 'data_admin')
     ORDER BY CASE code
       WHEN 'owner_admin' THEN 1
       WHEN 'trader_operator' THEN 2
       WHEN 'analyst' THEN 3
       ELSE 4
     END`
  );
  return rows;
}

async function tenantAdminUsers(tenantId: string) {
  const { rows } = await query(
    `SELECT
       u.id, u.email, u.display_name, u.status, u.last_login_at, u.created_at, u.updated_at,
       COALESCE(jsonb_agg(r.code ORDER BY r.code) FILTER (WHERE r.code IS NOT NULL), '[]'::jsonb) AS roles
     FROM admin_users u
     LEFT JOIN admin_user_roles ur ON ur.user_id = u.id
     LEFT JOIN admin_roles r ON r.id = ur.role_id
     WHERE u.tenant_id = $1
       AND u.platform_super_admin = false
     GROUP BY u.id
     ORDER BY u.created_at DESC`,
    [tenantId]
  );
  return rows;
}

async function replaceAdminUserRoles(adminUserId: string, roleCodes: string[]) {
  await query("DELETE FROM admin_user_roles WHERE user_id = $1", [adminUserId]);
  for (const roleCode of roleCodes) {
    await query(
      `INSERT INTO admin_user_roles (user_id, role_id)
       SELECT $1, id FROM admin_roles WHERE code = $2
       ON CONFLICT DO NOTHING`,
      [adminUserId, roleCode]
    );
  }
}

async function assignPlanAndModules(tenantId: string, planCode: string, moduleCodes: string[], adminUserId: string) {
  const plan = await query("SELECT * FROM subscription_plans WHERE code = $1 LIMIT 1", [planCode]);
  if (!plan.rows[0]) throw new Error("Subscription plan not found.");
  const latestSubscription = await query(
    `SELECT id FROM tenant_subscriptions
     WHERE tenant_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [tenantId]
  );
  if (latestSubscription.rows[0]) {
    await query("UPDATE tenant_subscriptions SET plan_id = $2, updated_at = now() WHERE id = $1", [latestSubscription.rows[0].id, plan.rows[0].id]);
  } else {
    await query(
      `INSERT INTO tenant_subscriptions (tenant_id, plan_id, status, renews_at)
       VALUES ($1,$2,'TRIAL', now() + interval '14 days')`,
      [tenantId, plan.rows[0].id]
    );
  }
  const allowed = await query(
    `SELECT m.code
     FROM subscription_plan_modules pm
     JOIN platform_strategy_modules m ON m.id = pm.module_id
     WHERE pm.plan_id = $1 AND m.status = 'ACTIVE'`,
    [plan.rows[0].id]
  );
  const allowedCodes = new Set(allowed.rows.map((row: any) => row.code));
  const requested = moduleCodes.length > 0 ? moduleCodes.filter((code) => allowedCodes.has(code)) : [...allowedCodes];
  await query("DELETE FROM tenant_modules WHERE tenant_id = $1", [tenantId]);
  for (const moduleCode of requested) {
    await query(
      `INSERT INTO tenant_modules (tenant_id, module_id, assigned_by)
       SELECT $1, id, $3 FROM platform_strategy_modules WHERE code = $2 AND status = 'ACTIVE'
       ON CONFLICT (tenant_id, module_id) DO UPDATE SET status = 'ENABLED', assigned_by = EXCLUDED.assigned_by, assigned_at = now()`,
      [tenantId, moduleCode, adminUserId]
    );
  }
}

async function replaceRolePermissions(roleId: string, permissions: string[]) {
  await query("DELETE FROM admin_role_permissions WHERE role_id = $1", [roleId]);
  for (const permission of [...new Set(permissions)]) {
    await query(
      `INSERT INTO admin_role_permissions (role_id, permission_code)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [roleId, permission]
    );
  }
}

function slugify(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

async function platformSystemHealth() {
  const checkedAt = new Date().toISOString();
  const api = {
    status: "HEALTHY",
    service: "personal-xauusd-orb-guide-api",
    uptimeSeconds: Math.round(process.uptime()),
    pid: process.pid,
    port: config.port
  };

  const database = await databaseHealth();
  const worker = await workerHealth();
  const feed = await feedHealth();
  const configuration = configurationHealth();
  const backups = await backupStatus();
  const redis = await redisHealth();
  const services = [
    healthItem("API", api.status, "Fastify API is accepting requests.", api),
    healthItem("PostgreSQL", database.status, database.message, database),
    healthItem("Redis", redis.status, redis.message, redis),
    healthItem("Market-data worker", worker.status, worker.message, worker),
    healthItem("Twelve Data guardrail", feed.status, feed.message, feed),
    healthItem("Production configuration", configuration.status, configuration.message, configuration),
    healthItem("PostgreSQL backups", backups.status, backupHealthMessage(backups), backups)
  ];
  const overall = services.some((service) => service.status === "DOWN" || service.status === "CRITICAL")
    ? "CRITICAL"
    : services.some((service) => service.status === "DEGRADED" || service.status === "WARN" || service.status === "STALE")
      ? "DEGRADED"
      : "HEALTHY";

  return {
    checkedAt,
    overall,
    services,
    recovery: recoveryGuidance(services),
    endpoints: {
      apiHealth: "/api/health",
      platformSystemHealth: "/api/platform/system-health",
      platformUsage: "/api/platform/usage/twelve-data",
      frontend: "http://localhost:3000",
      api: `http://localhost:${config.port}`
    }
  };
}

async function backupStatus() {
  const backupDir = resolve(process.cwd(), "../..", config.backupDir);
  await mkdir(backupDir, { recursive: true });
  const files = await readdir(backupDir);
  const backups = [];
  for (const file of files.filter((name) => /^orb_guide_\d{8}T\d{6}Z\.dump$/.test(name))) {
    const absolutePath = resolve(backupDir, file);
    const info = await stat(absolutePath);
    backups.push({
      file,
      path: absolutePath,
      sizeBytes: info.size,
      createdAt: info.mtime.toISOString(),
      ageHours: Math.round((Date.now() - info.mtime.getTime()) / 36_000) / 100
    });
  }
  backups.sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  const latest = backups[0] ?? null;
  const staleAfterHours = 24;
  const status = !latest
    ? "MISSING"
    : latest.ageHours > staleAfterHours
      ? "STALE"
      : "HEALTHY";
  return {
    status,
    backupDir,
    retentionDays: config.backupRetentionDays,
    staleAfterHours,
    count: backups.length,
    totalSizeBytes: backups.reduce((total, item) => total + item.sizeBytes, 0),
    latest,
    recent: backups.slice(0, 8),
    commands: {
      backup: "npm run db:backup",
      restore: "npm run db:restore -- <backup-file.dump>",
      cleanup: "npm run db:backup:retention"
    }
  };
}

async function databaseHealth() {
  const started = Date.now();
  try {
    await query("SELECT 1");
    const latencyMs = Date.now() - started;
    const stats = poolStats();
    const status = stats.waiting > 0 || latencyMs > 1_000 ? "DEGRADED" : "HEALTHY";
    return {
      status,
      message: status === "HEALTHY"
        ? `PostgreSQL responded in ${latencyMs}ms.`
        : `PostgreSQL responded in ${latencyMs}ms with ${stats.waiting} waiting client(s).`,
      latencyMs,
      pool: stats
    };
  } catch (error) {
    return {
      status: "CRITICAL",
      message: "PostgreSQL is unavailable or too slow.",
      latencyMs: Date.now() - started,
      pool: poolStats(),
      error: (error as Error).message
    };
  }
}

async function workerHealth() {
  try {
    const { rows } = await query(
      `SELECT worker_name, status, started_at, heartbeat_at, pid, metadata, last_error
       FROM worker_heartbeats
       WHERE worker_name = 'market-data-worker'
       LIMIT 1`
    );
    const row = rows[0] as any;
    if (!row) {
      return {
        status: "STALE",
        message: "Market-data worker heartbeat has not been recorded yet.",
        stale: true,
        heartbeatAgeSeconds: null,
        staleAfterSeconds: Math.max(config.autoRunSupervisorSeconds * 2, 45)
      };
    }
    const heartbeatAgeSeconds = Math.max(0, Math.round((Date.now() - new Date(row.heartbeat_at).getTime()) / 1000));
    const staleAfterSeconds = Math.max(config.autoRunSupervisorSeconds * 2, 45);
    const stale = heartbeatAgeSeconds > staleAfterSeconds;
    return {
      status: stale ? "STALE" : row.status === "ERROR" ? "CRITICAL" : "HEALTHY",
      message: stale
        ? `Market-data worker heartbeat is stale (${heartbeatAgeSeconds}s old).`
        : `Market-data worker heartbeat is fresh (${heartbeatAgeSeconds}s old).`,
      workerName: row.worker_name,
      workerStatus: row.status,
      startedAt: row.started_at,
      heartbeatAt: row.heartbeat_at,
      heartbeatAgeSeconds,
      staleAfterSeconds,
      stale,
      pid: row.pid,
      metadata: row.metadata,
      lastError: row.last_error
    };
  } catch (error) {
    return {
      status: "CRITICAL",
      message: "Worker heartbeat could not be read from PostgreSQL.",
      error: (error as Error).message
    };
  }
}

async function feedHealth() {
  try {
    const [today, minute, recentErrors] = await Promise.all([
      query(
        `SELECT COALESCE(sum(credits_used), 0)::int AS credits
         FROM api_usage_events
         WHERE provider = 'TWELVE_DATA'
           AND created_at >= date_trunc('day', now())`
      ),
      query(
        `SELECT COALESCE(sum(credits_used), 0)::int AS credits
         FROM api_usage_events
         WHERE provider = 'TWELVE_DATA'
           AND created_at >= now() - interval '1 minute'`
      ),
      query(
        `SELECT count(*)::int AS errors
         FROM api_usage_events
         WHERE provider = 'TWELVE_DATA'
           AND status = 'ERROR'
           AND created_at >= now() - interval '30 minutes'`
      )
    ]);
    const creditsToday = Number(today.rows[0]?.credits ?? 0);
    const creditsLastMinute = Number(minute.rows[0]?.credits ?? 0);
    const errorsLast30Minutes = Number(recentErrors.rows[0]?.errors ?? 0);
    const status = creditsToday >= config.twelveDataStopCredits || errorsLast30Minutes >= 3
      ? "CRITICAL"
      : creditsToday >= config.twelveDataDangerCredits || creditsLastMinute >= config.twelveDataMinuteCreditLimit
        ? "DEGRADED"
        : creditsToday >= config.twelveDataWarnCredits
          ? "WARN"
          : "HEALTHY";
    return {
      status,
      message: `${creditsToday}/${config.twelveDataDailyCreditLimit} Twelve Data credits used today; ${errorsLast30Minutes} errors in 30 minutes.`,
      creditsToday,
      creditsLastMinute,
      dailyLimit: config.twelveDataDailyCreditLimit,
      minuteLimit: config.twelveDataMinuteCreditLimit,
      warnAt: config.twelveDataWarnCredits,
      dangerAt: config.twelveDataDangerCredits,
      stopAt: config.twelveDataStopCredits,
      errorsLast30Minutes
    };
  } catch (error) {
    return {
      status: "CRITICAL",
      message: "Twelve Data usage health could not be calculated.",
      error: (error as Error).message
    };
  }
}

function healthItem(name: string, status: string, message: string, detail: Record<string, unknown>) {
  return { name, status, message, detail };
}

function configurationHealth() {
  const issues = [
    config.nodeEnv === "production" && !config.adminSessionSecret ? "ADMIN_SESSION_SECRET is required in production." : null,
    config.nodeEnv === "production" && ["1234", "change-this-password"].includes(config.adminPassword) ? "ADMIN_PASSWORD must be changed in production." : null,
    config.nodeEnv === "production" && config.billingProvider !== "manual" && !config.billingWebhookSecret ? "BILLING_WEBHOOK_SECRET is required when billing provider is external." : null,
    config.twelveDataStopCredits >= config.twelveDataDailyCreditLimit ? "TWELVE_DATA_STOP_CREDITS should be below the daily limit." : null
  ].filter(Boolean);
  return {
    status: issues.length > 0 ? (config.nodeEnv === "production" ? "CRITICAL" : "WARN") : "HEALTHY",
    message: issues.length > 0 ? issues.join(" ") : "Security-sensitive runtime configuration looks acceptable.",
    nodeEnv: config.nodeEnv,
    tokenTtlMinutes: config.adminTokenTtlMinutes,
    loginRateLimitMaxAttempts: config.loginRateLimitMaxAttempts,
    loginRateLimitWindowSeconds: config.loginRateLimitWindowSeconds,
    loginRateLimitLockoutSeconds: config.loginRateLimitLockoutSeconds,
    issues
  };
}

function backupHealthMessage(backups: Awaited<ReturnType<typeof backupStatus>>) {
  if (!backups.latest) return "No PostgreSQL backup dump has been found yet.";
  return `Latest PostgreSQL backup is ${backups.latest.ageHours} hour(s) old; ${backups.count} backup(s) retained.`;
}

function recoveryGuidance(services: Array<{ name: string; status: string; message: string }>) {
  const guidance = [];
  if (services.some((service) => service.name === "PostgreSQL" && service.status !== "HEALTHY")) {
    guidance.push("Check PostgreSQL container/process first, then rerun migrations if schema errors appear.");
  }
  if (services.some((service) => service.name === "Market-data worker" && service.status !== "HEALTHY")) {
    guidance.push("Restart the dedicated market-data worker. The API should stay in no-worker mode.");
  }
  if (services.some((service) => service.name === "Twelve Data guardrail" && service.status !== "HEALTHY")) {
    guidance.push("Review Twelve Data usage before forcing sync. The guardrail is protecting daily credits.");
  }
  if (services.some((service) => service.name === "Production configuration" && service.status !== "HEALTHY")) {
    guidance.push("Review environment variables before production deployment.");
  }
  if (services.some((service) => service.name === "PostgreSQL backups" && service.status !== "HEALTHY")) {
    guidance.push("Run npm run db:backup and confirm the backup appears in Platform Admin.");
  }
  if (services.some((service) => service.name === "Redis" && service.status === "CRITICAL")) {
    guidance.push("Start Redis or set REDIS_REQUIRED=false for local fallback mode.");
  }
  return guidance.length > 0 ? guidance : ["No recovery action needed."];
}
