import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHmac, createHash } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../../infrastructure/config.js";
import { query } from "../../infrastructure/db/client.js";
import { recordOperationalEvent } from "../../infrastructure/observability/operational-events.js";
import { redisClient } from "../../infrastructure/redis/client.js";
import { createCheckoutSession, handleBillingWebhook } from "../billing/provider.js";
import { tenantPlanUsage } from "../billing/limits.js";

const scrypt = promisify(scryptCallback);
const TOKEN_TTL_MS = Math.max(config.adminTokenTtlMinutes, 15) * 60 * 1000;
const TOKEN_SECRET = config.adminSessionSecret || `${config.databaseUrl}:${config.adminPassword}`;
const loginAttempts = new Map<string, { attempts: number; firstAttemptAt: number; lockedUntil: number }>();
const revokedTokenSignatures = new Map<string, number>();
const AUTH_COOKIE_NAME = "xauusd_admin_session";

type AdminSession = {
  sub: string;
  role: "ADMIN";
  displayName: string;
  email: string;
  tenantId: string | null;
  platformSuperAdmin: boolean;
  permissions: string[];
  sid?: string;
  exp: number;
};

export async function authRoutes(app: FastifyInstance) {
  app.post("/api/auth/login", async (request, reply) => {
    await ensureDefaultAdmin();
    const body = request.body as { email?: string; password?: string; pin?: string };
    const email = (body.email || config.adminEmail).toLowerCase().trim();
    const password = body.password || body.pin || "";
    const passwordPolicyError = productionCredentialError(password);
    if (adminUsesBootstrapEmail(email) && passwordPolicyError) {
      await recordSecurityEvent({
        eventType: "AUTH_WEAK_BOOTSTRAP_PASSWORD_BLOCKED",
        email,
        request,
        metadata: { reason: passwordPolicyError }
      });
      return reply.code(403).send({ message: "Production admin password does not meet security policy." });
    }
    const rate = await loginRateStatus(request, email);
    if (rate.locked) {
      await recordSecurityEvent({
        eventType: "AUTH_RATE_LIMITED",
        email,
        request,
        metadata: { lockedUntil: new Date(rate.lockedUntil).toISOString() }
      });
      return reply.code(429).send({ message: "Too many login attempts. Try again later.", retryAfterSeconds: Math.ceil((rate.lockedUntil - Date.now()) / 1000) });
    }
    const { rows } = await query("SELECT * FROM admin_users WHERE lower(email) = $1 AND status = 'ACTIVE' LIMIT 1", [email]);
    const admin = rows[0];
    if (!admin || !(await verifyPassword(password, admin.password_hash))) {
      const failed = await registerFailedLogin(request, email);
      await recordSecurityEvent({
        eventType: failed.locked ? "AUTH_LOGIN_LOCKED" : "AUTH_LOGIN_FAILED",
        email,
        request,
        metadata: { attempts: failed.attempts, lockedUntil: failed.lockedUntil ? new Date(failed.lockedUntil).toISOString() : null }
      });
      return reply.code(401).send({ message: "Invalid admin credentials." });
    }

    await resetLoginRate(request, email);
    const permissions = await permissionsForAdmin(admin.id);
    await query("UPDATE admin_users SET last_login_at = now(), updated_at = now() WHERE id = $1", [admin.id]);
    await writeAudit(admin.id, "AUTH_LOGIN", "admin_user", admin.id, null, { email: admin.email });
    await recordSecurityEvent({
      adminUserId: admin.id,
      eventType: "AUTH_LOGIN_SUCCESS",
      email: admin.email,
      request,
      metadata: { platformSuperAdmin: admin.platform_super_admin === true, tenantId: admin.tenant_id ?? null }
    });

    const sessionId = randomUUID();
    const session: AdminSession = {
      sub: admin.id,
      role: "ADMIN",
      displayName: admin.display_name,
      email: admin.email,
      tenantId: admin.tenant_id ?? null,
      platformSuperAdmin: admin.platform_super_admin === true,
      permissions,
      sid: sessionId,
      exp: Date.now() + TOKEN_TTL_MS
    };

    const token = signSession(session);
    await persistAdminSession(session, token, request);
    setAuthCookie(reply, token, session.exp);
    return { token, user: session };
  });

  app.post("/api/auth/refresh", async (request, reply) => {
    const session = verifyAdminSession(request);
    if (!session) return reply.code(401).send({ message: "Authentication required." });
    const refreshed = { ...session, exp: Date.now() + TOKEN_TTL_MS };
    const token = signSession(refreshed);
    await persistAdminSession(refreshed, token, request);
    await recordSecurityEvent({
      adminUserId: session.sub,
      eventType: "AUTH_SESSION_REFRESH",
      email: session.email,
      request,
      metadata: { platformSuperAdmin: session.platformSuperAdmin, tenantId: session.tenantId }
    });
    setAuthCookie(reply, token, refreshed.exp);
    return { token, user: refreshed };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = tokenFromRequest(request);
    const session = verifyAdminSession(request);
    if (token) {
      revokeToken(token);
      await query("UPDATE admin_sessions SET revoked_at = now(), last_seen_at = now() WHERE token_hash = $1", [tokenHash(token)]).catch(() => undefined);
    }
    if (session) {
      await recordSecurityEvent({
        adminUserId: session.sub,
        eventType: "AUTH_LOGOUT",
        email: session.email,
        request,
        metadata: { platformSuperAdmin: session.platformSuperAdmin, tenantId: session.tenantId }
      });
    }
    clearAuthCookie(reply);
    return { status: "ok" };
  });

  app.get("/api/auth/me", async (request, reply) => {
    const session = verifyAdminSession(request);
    if (!session) return reply.code(401).send({ message: "Authentication required." });
    return { user: session };
  });

  app.get("/api/tenant/context", async (request) => {
    const session = requireAdmin(request);
    if (!session.tenantId) {
      return {
        tenant: null,
        subscription: null,
        modules: [],
        availableModules: [],
        usage: null,
        invoices: [],
        latestCheckoutSession: null,
        platformSuperAdmin: session.platformSuperAdmin
      };
    }
    const tenant = await query("SELECT * FROM platform_tenants WHERE id = $1", [session.tenantId]);
    const subscription = await query(
      `SELECT
         s.*,
         p.code AS plan_code,
         p.name AS plan_name,
         p.price_usd,
         p.billing_period,
         p.provider_code AS plan_provider_code,
         p.provider_price_id,
         p.checkout_enabled,
         p.max_admin_users,
         p.max_notifications_per_month,
         p.max_report_history_months,
         p.automation_included
       FROM tenant_subscriptions s
       JOIN subscription_plans p ON p.id = s.plan_id
       WHERE s.tenant_id = $1
       ORDER BY s.created_at DESC
       LIMIT 1`,
      [session.tenantId]
    );
    const modules = await query(
      `SELECT m.*, tm.status AS tenant_module_status
       FROM tenant_modules tm
       JOIN platform_strategy_modules m ON m.id = tm.module_id
       WHERE tm.tenant_id = $1
       ORDER BY m.sort_order, m.name`,
      [session.tenantId]
    );
    const availableModules = await query(
      `SELECT
         m.*,
         tm.status AS tenant_module_status,
         pm.module_id IS NOT NULL AS plan_included
       FROM platform_strategy_modules m
       LEFT JOIN tenant_modules tm ON tm.module_id = m.id AND tm.tenant_id = $1
       LEFT JOIN subscription_plan_modules pm ON pm.module_id = m.id AND pm.plan_id = $2
       ORDER BY m.sort_order, m.name`,
      [session.tenantId, subscription.rows[0]?.plan_id ?? null]
    );
    const invoices = await query(
      `SELECT i.*, p.name AS plan_name, p.code AS plan_code
       FROM subscription_invoices i
       LEFT JOIN subscription_plans p ON p.id = i.plan_id
       WHERE i.tenant_id = $1
       ORDER BY i.created_at DESC
       LIMIT 12`,
      [session.tenantId]
    );
    const latestCheckoutSession = await query(
      `SELECT c.*, p.name AS plan_name, p.code AS plan_code
       FROM subscription_checkout_sessions c
       JOIN subscription_plans p ON p.id = c.plan_id
       WHERE c.tenant_id = $1
       ORDER BY c.created_at DESC
       LIMIT 1`,
      [session.tenantId]
    );
    const usage = await tenantPlanUsage(session.tenantId);
    const supportInfo = await query("SELECT value FROM app_settings WHERE key = 'platform.business' LIMIT 1");
    return {
      tenant: tenant.rows[0] ?? null,
      subscription: subscription.rows[0] ?? null,
      modules: modules.rows,
      availableModules: availableModules.rows,
      usage,
      invoices: invoices.rows,
      latestCheckoutSession: latestCheckoutSession.rows[0] ?? null,
      supportInfo: supportInfo.rows[0]?.value ?? null,
      platformSuperAdmin: session.platformSuperAdmin
    };
  });

  app.post("/api/billing/checkout", async (request) => {
    const session = requireAdmin(request);
    if (!session.tenantId) {
      const error = new Error("User account context required.") as Error & { statusCode?: number };
      error.statusCode = 403;
      throw error;
    }
    const body = request.body as { planCode?: string; mode?: string };
    const checkout = await createCheckoutSession({
      tenantId: session.tenantId,
      adminUserId: session.sub,
      planCode: body.planCode ?? "starter_orb",
      mode: body.mode?.toUpperCase() === "RENEWAL" ? "RENEWAL" : "SUBSCRIPTION"
    }) as any;
    await writeAudit(session.sub, "BILLING_CHECKOUT_CREATED", "subscription_checkout_session", checkout.id, null, checkout);
    return checkout;
  });

  app.post("/api/billing/webhook", async (request) => {
    if (config.billingWebhookSecret) {
      const provided = String(request.headers["x-billing-webhook-secret"] ?? "");
      if (provided !== config.billingWebhookSecret) {
        const error = new Error("Invalid billing webhook secret.") as Error & { statusCode?: number };
        error.statusCode = 401;
        throw error;
      }
    }
    const body = request.body as { provider?: string; checkoutSessionId?: string; invoiceId?: string; status?: string };
    return handleBillingWebhook(body);
  });
}

export function requireAdmin(request: FastifyRequest) {
  const session = verifyAdminSession(request);
  if (!session) {
    const error = new Error("Authentication required.") as Error & { statusCode?: number };
    error.statusCode = 401;
    throw error;
  }
  return session;
}

export function requirePermission(request: FastifyRequest, permission: string) {
  const session = requireAdmin(request);
  if (!session.permissions.includes(permission)) {
    const error = new Error("Permission denied.") as Error & { statusCode?: number };
    error.statusCode = 403;
    throw error;
  }
  return session;
}

export async function requireTenantModule(request: FastifyRequest, moduleCode: string) {
  const session = requireAdmin(request);
  if (session.platformSuperAdmin) return session;
  if (!session.tenantId) {
    const error = new Error("User account context required.") as Error & { statusCode?: number };
    error.statusCode = 403;
    throw error;
  }
  const { rows } = await query(
    `SELECT 1
     FROM tenant_modules tm
     JOIN platform_strategy_modules m ON m.id = tm.module_id
     JOIN platform_tenants t ON t.id = tm.tenant_id
     LEFT JOIN LATERAL (
       SELECT status
       FROM tenant_subscriptions
       WHERE tenant_id = t.id
       ORDER BY created_at DESC
       LIMIT 1
     ) s ON true
     WHERE tm.tenant_id = $1
       AND m.code = $2
       AND tm.status = 'ENABLED'
       AND t.status = 'ACTIVE'
       AND COALESCE(s.status, 'ACTIVE') IN ('TRIAL', 'ACTIVE')`,
    [session.tenantId, moduleCode]
  );
  if (!rows[0]) {
    const error = new Error("User account module access denied.") as Error & { statusCode?: number };
    error.statusCode = 403;
    throw error;
  }
  return session;
}

export async function writeAudit(adminUserId: string | null, action: string, resourceType: string, resourceId: string | null, oldValue: unknown, newValue: unknown) {
  await query(
    `INSERT INTO admin_audit_logs (admin_user_id, action, resource_type, resource_id, old_value, new_value)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
    [adminUserId, action, resourceType, resourceId, JSON.stringify(oldValue), JSON.stringify(newValue)]
  );
}

async function ensureDefaultAdmin() {
  const policyError = productionCredentialError(config.adminPassword);
  if (policyError) {
    throw new Error(`ADMIN_PASSWORD is not production safe: ${policyError}`);
  }
  if (config.nodeEnv === "production" && config.adminSessionSecret.length < 32) {
    throw new Error("ADMIN_SESSION_SECRET must be at least 32 characters in production.");
  }
  const existing = await query("SELECT id FROM admin_users WHERE lower(email) = lower($1) LIMIT 1", [config.adminEmail]);
  if (existing.rows.length > 0) return;

  const passwordHash = await hashPassword(config.adminPassword);
  const { rows } = await query(
    `INSERT INTO admin_users (email, display_name, password_hash, tenant_id, platform_super_admin)
     VALUES ($1, $2, $3, (SELECT id FROM platform_tenants WHERE slug = 'default-orb-tenant'), true)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id`,
    [config.adminEmail.toLowerCase(), "Owner Admin", passwordHash]
  );
  await query(
    `INSERT INTO admin_user_roles (user_id, role_id)
     SELECT $1, id FROM admin_roles WHERE code = 'owner_admin'
     ON CONFLICT DO NOTHING`,
    [rows[0].id]
  );
}

async function permissionsForAdmin(adminUserId: string) {
  const { rows } = await query(
    `SELECT DISTINCT p.code
     FROM admin_user_roles ur
     JOIN admin_role_permissions rp ON rp.role_id = ur.role_id
     JOIN admin_permissions p ON p.code = rp.permission_code
     WHERE ur.user_id = $1
     ORDER BY p.code`,
    [adminUserId]
  );
  return rows.map((row) => row.code as string);
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${derived.toString("hex")}`;
}

export function validateStrongPassword(password: string) {
  if (password.length < 12) return "Password must be at least 12 characters.";
  if (!/[a-z]/.test(password)) return "Password must include a lowercase letter.";
  if (!/[A-Z]/.test(password)) return "Password must include an uppercase letter.";
  if (!/[0-9]/.test(password)) return "Password must include a number.";
  if (!/[^A-Za-z0-9]/.test(password)) return "Password must include a symbol.";
  if (/change-this|password|admin|1234/i.test(password)) return "Password contains a blocked weak phrase.";
  return null;
}

async function verifyPassword(password: string, stored: string) {
  const [scheme, salt, hash] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  const storedBuffer = Buffer.from(hash, "hex");
  return storedBuffer.length === derived.length && timingSafeEqual(storedBuffer, derived);
}

function signSession(session: AdminSession) {
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  const signature = createHmac("sha256", TOKEN_SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyAdminSession(request: FastifyRequest): AdminSession | null {
  const token = tokenFromRequest(request);
  if (!token || isTokenRevoked(token)) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;

  const expected = createHmac("sha256", TOKEN_SECRET).update(payload).digest("base64url");
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AdminSession;
    if (session.exp < Date.now()) return null;
    if (session.role !== "ADMIN") return null;
    touchAdminSession(session, token);
    return session;
  } catch {
    return null;
  }
}

function tokenFromRequest(request: FastifyRequest) {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length);
  const cookieHeader = String(request.headers.cookie ?? "");
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === AUTH_COOKIE_NAME) return decodeURIComponent(rawValue.join("="));
  }
  return null;
}

function setAuthCookie(reply: any, token: string, exp: number) {
  const maxAgeSeconds = Math.max(Math.floor((exp - Date.now()) / 1000), 0);
  const secure = config.nodeEnv === "production" ? "; Secure" : "";
  reply.header(
    "Set-Cookie",
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; SameSite=Lax${secure}`
  );
}

function clearAuthCookie(reply: any) {
  const secure = config.nodeEnv === "production" ? "; Secure" : "";
  reply.header("Set-Cookie", `${AUTH_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure}`);
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function revokeToken(token: string) {
  const signature = token.split(".")[1];
  if (!signature) return;
  revokedTokenSignatures.set(signature, Date.now() + TOKEN_TTL_MS);
  cleanupRevokedTokens();
}

function isTokenRevoked(token: string) {
  cleanupRevokedTokens();
  const signature = token.split(".")[1];
  return Boolean(signature && revokedTokenSignatures.has(signature));
}

function cleanupRevokedTokens() {
  const now = Date.now();
  for (const [signature, expiresAt] of revokedTokenSignatures) {
    if (expiresAt <= now) revokedTokenSignatures.delete(signature);
  }
}

async function persistAdminSession(session: AdminSession, token: string, request: FastifyRequest) {
  await query(
    `INSERT INTO admin_sessions (id, admin_user_id, token_hash, ip_address, user_agent, expires_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), now())
     ON CONFLICT (token_hash) DO UPDATE SET last_seen_at = now(), expires_at = EXCLUDED.expires_at`,
    [
      session.sid ?? randomUUID(),
      session.sub,
      tokenHash(token),
      request.ip ?? null,
      String(request.headers["user-agent"] ?? ""),
      session.exp
    ]
  ).catch(() => undefined);
}

function touchAdminSession(session: AdminSession, token: string) {
  query("UPDATE admin_sessions SET last_seen_at = now() WHERE admin_user_id = $1 AND token_hash = $2 AND revoked_at IS NULL", [session.sub, tokenHash(token)]).catch(() => undefined);
}

function adminUsesBootstrapEmail(email: string) {
  return email.toLowerCase() === config.adminEmail.toLowerCase();
}

function productionCredentialError(password: string) {
  if (config.nodeEnv !== "production") return null;
  return validateStrongPassword(password);
}

function loginRateKey(request: FastifyRequest, email: string) {
  return `${email}:${request.ip ?? "unknown"}`;
}

async function loginRateStatus(request: FastifyRequest, email: string) {
  const redisRate = await redisLoginRateStatus(request, email);
  if (redisRate) return redisRate;
  const now = Date.now();
  const record = loginAttempts.get(loginRateKey(request, email));
  if (!record) return { locked: false, lockedUntil: 0 };
  if (record.lockedUntil > now) return { locked: true, lockedUntil: record.lockedUntil };
  if (now - record.firstAttemptAt > config.loginRateLimitWindowSeconds * 1000) {
    loginAttempts.delete(loginRateKey(request, email));
    return { locked: false, lockedUntil: 0 };
  }
  return { locked: false, lockedUntil: 0 };
}

async function registerFailedLogin(request: FastifyRequest, email: string) {
  const redisRate = await redisRegisterFailedLogin(request, email);
  if (redisRate) return redisRate;
  const now = Date.now();
  const key = loginRateKey(request, email);
  const existing = loginAttempts.get(key);
  const withinWindow = existing && now - existing.firstAttemptAt <= config.loginRateLimitWindowSeconds * 1000;
  const next = {
    attempts: withinWindow ? existing.attempts + 1 : 1,
    firstAttemptAt: withinWindow ? existing.firstAttemptAt : now,
    lockedUntil: existing?.lockedUntil && existing.lockedUntil > now ? existing.lockedUntil : 0
  };
  if (next.attempts >= config.loginRateLimitMaxAttempts) {
    next.lockedUntil = now + config.loginRateLimitLockoutSeconds * 1000;
  }
  loginAttempts.set(key, next);
  return { ...next, locked: next.lockedUntil > now };
}

async function resetLoginRate(request: FastifyRequest, email: string) {
  const client = redisClient();
  if (client) {
    await client.del(redisLoginRateKey(request, email)).catch(() => undefined);
  }
  loginAttempts.delete(loginRateKey(request, email));
}

function redisLoginRateKey(request: FastifyRequest, email: string) {
  return `auth:login-rate:${loginRateKey(request, email)}`;
}

async function redisLoginRateStatus(request: FastifyRequest, email: string) {
  const client = redisClient();
  if (!client) return null;
  try {
    if (client.status === "wait" || client.status === "end") await client.connect();
    const data = await client.hgetall(redisLoginRateKey(request, email));
    if (!data || Object.keys(data).length === 0) return { locked: false, lockedUntil: 0 };
    const lockedUntil = Number(data.lockedUntil ?? 0);
    if (lockedUntil > Date.now()) return { locked: true, lockedUntil };
    return { locked: false, lockedUntil: 0 };
  } catch {
    return null;
  }
}

async function redisRegisterFailedLogin(request: FastifyRequest, email: string) {
  const client = redisClient();
  if (!client) return null;
  try {
    if (client.status === "wait" || client.status === "end") await client.connect();
    const key = redisLoginRateKey(request, email);
    const attempts = await client.hincrby(key, "attempts", 1);
    const now = Date.now();
    if (attempts === 1) {
      await client.hset(key, "firstAttemptAt", String(now), "lockedUntil", "0");
      await client.expire(key, config.loginRateLimitWindowSeconds);
    }
    const lockedUntil = attempts >= config.loginRateLimitMaxAttempts
      ? now + config.loginRateLimitLockoutSeconds * 1000
      : Number(await client.hget(key, "lockedUntil") ?? 0);
    if (lockedUntil > now) {
      await client.hset(key, "lockedUntil", String(lockedUntil));
      await client.expire(key, config.loginRateLimitLockoutSeconds);
    }
    return {
      attempts,
      firstAttemptAt: Number(await client.hget(key, "firstAttemptAt") ?? now),
      lockedUntil,
      locked: lockedUntil > now
    };
  } catch {
    return null;
  }
}

async function recordSecurityEvent(input: {
  adminUserId?: string | null;
  email?: string | null;
  eventType: string;
  request: FastifyRequest;
  metadata?: Record<string, unknown>;
}) {
  await query(
    `INSERT INTO security_events (admin_user_id, email, event_type, ip_address, user_agent, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      input.adminUserId ?? null,
      input.email ?? null,
      input.eventType,
      input.request.ip ?? null,
      String(input.request.headers["user-agent"] ?? ""),
      JSON.stringify(input.metadata ?? {})
    ]
  ).catch(() => undefined);
  await recordOperationalEvent({
    severity: input.eventType.includes("FAILED") || input.eventType.includes("LOCKED") || input.eventType.includes("RATE") ? "WARN" : "INFO",
    category: "AUTH",
    eventType: input.eventType,
    source: "auth",
    adminUserId: input.adminUserId ?? null,
    message: `${input.eventType} for ${input.email ?? "unknown user"}.`,
    metadata: {
      email: input.email ?? null,
      ipAddress: input.request.ip ?? null,
      userAgent: String(input.request.headers["user-agent"] ?? ""),
      ...(input.metadata ?? {})
    }
  });
}
