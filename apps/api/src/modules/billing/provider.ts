import { randomUUID } from "node:crypto";
import { config } from "../../infrastructure/config.js";
import { query } from "../../infrastructure/db/client.js";

type CheckoutInput = {
  tenantId: string;
  adminUserId: string;
  planCode: string;
  mode: "SUBSCRIPTION" | "RENEWAL";
};

type WebhookInput = {
  provider?: string;
  checkoutSessionId?: string;
  invoiceId?: string;
  status?: string;
};

export function activeBillingProvider() {
  if (["manual", "stripe", "paddle"].includes(config.billingProvider)) return config.billingProvider;
  return "manual";
}

export async function createCheckoutSession(input: CheckoutInput) {
  const provider = activeBillingProvider();
  if (provider !== "manual") return createProviderPlaceholderCheckout(input, provider);
  return createProviderPlaceholderCheckout(input, "manual");
}

export async function handleBillingWebhook(input: WebhookInput) {
  const provider = input.provider?.toLowerCase() || activeBillingProvider();
  if (!["manual", "stripe", "paddle"].includes(provider)) {
    const error = new Error("Unsupported billing provider.") as Error & { statusCode?: number };
    error.statusCode = 400;
    throw error;
  }
  const status = String(input.status ?? "PAID").toUpperCase();
  if (status === "PAID" || status === "COMPLETED") return markCheckoutOrInvoicePaid(input);
  if (status === "PAST_DUE" || status === "FAILED") return markCheckoutOrInvoicePastDue(input);
  if (status === "CANCELED" || status === "EXPIRED") return markCheckoutCanceled(input);
  return { handled: false, reason: "Webhook status ignored.", status };
}

async function createProviderPlaceholderCheckout(input: CheckoutInput, provider: string) {
  const plan = await query("SELECT * FROM subscription_plans WHERE code = $1 AND status = 'ACTIVE' LIMIT 1", [input.planCode]);
  if (!plan.rows[0]) {
    const error = new Error("Subscription plan not found.") as Error & { statusCode?: number };
    error.statusCode = 404;
    throw error;
  }
  if (plan.rows[0].checkout_enabled === false) {
    const error = new Error("Checkout is not enabled for this plan.") as Error & { statusCode?: number };
    error.statusCode = 409;
    throw error;
  }
  const subscription = await query(
    `SELECT id FROM tenant_subscriptions
     WHERE tenant_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [input.tenantId]
  );
  const id = randomUUID();
  const checkoutUrl = provider === "manual" ? `/checkout/${id}` : `${config.billingSuccessUrl}&checkout=${id}&provider=${provider}`;
  const checkout = await query(
    `INSERT INTO subscription_checkout_sessions (
       id, tenant_id, plan_id, subscription_id, provider_code, provider_session_id, status,
       mode, amount_usd, currency, checkout_url, expires_at, created_by
     )
     VALUES ($1,$2,$3,$4,$5,$6,'PENDING',$7,$8,'USD',$9,now() + interval '30 minutes',$10)
     RETURNING *`,
    [
      id,
      input.tenantId,
      plan.rows[0].id,
      subscription.rows[0]?.id ?? null,
      provider,
      `${provider}_${id}`,
      input.mode,
      plan.rows[0].price_usd ?? 0,
      checkoutUrl,
      input.adminUserId
    ]
  );
  const invoice = await query(
    `INSERT INTO subscription_invoices (
       tenant_id, subscription_id, plan_id, provider_code, provider_invoice_id, invoice_number,
       status, amount_due_usd, amount_paid_usd, currency, period_start, period_end, due_at,
       hosted_invoice_url
     )
     VALUES ($1,$2,$3,$4,$5,$6,'OPEN',$7,0,'USD',now(),now() + interval '1 month',now() + interval '7 days',$8)
     RETURNING *`,
    [
      input.tenantId,
      subscription.rows[0]?.id ?? null,
      plan.rows[0].id,
      provider,
      `${provider}_invoice_${id}`,
      `INV-${Date.now()}`,
      plan.rows[0].price_usd ?? 0,
      checkoutUrl
    ]
  );
  if (subscription.rows[0]?.id) {
    await query("UPDATE tenant_subscriptions SET latest_invoice_id = $2, updated_at = now() WHERE id = $1", [subscription.rows[0].id, invoice.rows[0].id]);
  }
  return { ...checkout.rows[0], invoice: invoice.rows[0] };
}

async function markCheckoutOrInvoicePaid(input: WebhookInput) {
  const invoice = await findInvoice(input);
  if (!invoice) return { handled: false, reason: "Invoice not found." };
  const paid = await query(
    `UPDATE subscription_invoices
     SET status = 'PAID', amount_paid_usd = amount_due_usd, paid_at = now(), updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [invoice.id]
  );
  if (input.checkoutSessionId) {
    await query("UPDATE subscription_checkout_sessions SET status = 'COMPLETED', completed_at = now(), updated_at = now() WHERE id = $1", [input.checkoutSessionId]);
  }
  if (invoice.subscription_id) {
    await query(
      `UPDATE tenant_subscriptions
       SET status = 'ACTIVE',
           plan_id = COALESCE($2, plan_id),
           current_period_start = COALESCE($3, now()),
           current_period_end = COALESCE($4, now() + interval '1 month'),
           renews_at = COALESCE($4, now() + interval '1 month'),
           latest_invoice_id = $5,
           updated_at = now()
       WHERE id = $1`,
      [invoice.subscription_id, invoice.plan_id, invoice.period_start, invoice.period_end, paid.rows[0].id]
    );
    await resumeAutomation(invoice.tenant_id, "Invoice paid. Subscription active.");
  }
  return { handled: true, invoice: paid.rows[0] };
}

async function markCheckoutOrInvoicePastDue(input: WebhookInput) {
  const invoice = await findInvoice(input);
  if (!invoice) return { handled: false, reason: "Invoice not found." };
  const updated = await query("UPDATE subscription_invoices SET status = 'PAST_DUE', updated_at = now() WHERE id = $1 RETURNING *", [invoice.id]);
  if (invoice.subscription_id) {
    await query("UPDATE tenant_subscriptions SET status = 'PAST_DUE', updated_at = now() WHERE id = $1", [invoice.subscription_id]);
    await pauseAutomation(invoice.tenant_id, "Payment is past due. Automation paused.");
  }
  return { handled: true, invoice: updated.rows[0] };
}

async function markCheckoutCanceled(input: WebhookInput) {
  if (input.invoiceId) {
    const invoice = await findInvoice(input);
    if (!invoice) return { handled: false, reason: "Invoice not found." };
    const updated = await query("UPDATE subscription_invoices SET status = 'CANCELED', updated_at = now() WHERE id = $1 RETURNING *", [invoice.id]);
    if (invoice.subscription_id) {
      await query("UPDATE tenant_subscriptions SET status = 'CANCELED', updated_at = now() WHERE id = $1", [invoice.subscription_id]);
      await pauseAutomation(invoice.tenant_id, "Invoice canceled. Subscription inactive.");
    }
    return { handled: true, invoice: updated.rows[0] };
  }
  if (!input.checkoutSessionId) return { handled: false, reason: "Checkout session id or invoice id required." };
  const { rows } = await query("UPDATE subscription_checkout_sessions SET status = 'CANCELED', updated_at = now() WHERE id = $1 RETURNING *", [input.checkoutSessionId]);
  return { handled: Boolean(rows[0]), checkoutSession: rows[0] ?? null };
}

async function findInvoice(input: WebhookInput) {
  if (input.invoiceId) {
    const { rows } = await query("SELECT * FROM subscription_invoices WHERE id = $1 LIMIT 1", [input.invoiceId]);
    return rows[0] ?? null;
  }
  if (input.checkoutSessionId) {
    const { rows } = await query(
      `SELECT i.*
       FROM subscription_checkout_sessions c
       JOIN subscription_invoices i
         ON i.tenant_id = c.tenant_id
        AND i.plan_id = c.plan_id
        AND i.provider_code = c.provider_code
       WHERE c.id = $1
       ORDER BY i.created_at DESC
       LIMIT 1`,
      [input.checkoutSessionId]
    );
    return rows[0] ?? null;
  }
  return null;
}

async function pauseAutomation(tenantId: string, reason: string) {
  await query(
    `INSERT INTO tenant_automation_states (tenant_id, enabled, running, phase, latest_reason, updated_at)
     VALUES ($1,false,false,'PAUSED',$2,now())
     ON CONFLICT (tenant_id) DO UPDATE SET enabled = false, running = false, phase = 'PAUSED', latest_reason = $2, updated_at = now()`,
    [tenantId, reason]
  );
}

async function resumeAutomation(tenantId: string, reason: string) {
  await query(
    `INSERT INTO tenant_automation_states (tenant_id, enabled, running, phase, latest_reason, updated_at)
     VALUES ($1,true,false,'STARTING',$2,now())
     ON CONFLICT (tenant_id) DO UPDATE SET enabled = true, phase = CASE WHEN tenant_automation_states.phase = 'PAUSED' THEN 'STARTING' ELSE tenant_automation_states.phase END, latest_reason = $2, updated_at = now()`,
    [tenantId, reason]
  );
}
