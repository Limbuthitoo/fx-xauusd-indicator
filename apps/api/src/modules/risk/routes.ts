import { calculateRisk } from "@orb-guide/risk-engine";
import type { FastifyInstance } from "fastify";
import { query } from "../../infrastructure/db/client.js";

export async function riskRoutes(app: FastifyInstance) {
  app.post("/api/risk/calculate", async (request) => {
    const result = calculateRisk(request.body as any);
    return result;
  });

  app.get("/api/risk/status", async () => {
    const { rows } = await query("SELECT * FROM risk_profiles WHERE is_active = true ORDER BY created_at DESC LIMIT 1");
    return rows[0] ?? null;
  });

  app.post("/api/risk/profiles", async (request) => {
    const body = request.body as any;
    const { rows } = await query(
      `INSERT INTO risk_profiles (
        user_id, name, account_balance, account_equity, account_currency, risk_per_trade_percent,
        maximum_daily_loss_percent, maximum_weekly_loss_percent, maximum_trades_per_session,
        maximum_consecutive_losses, mandatory_stop_loss, minimum_reward_to_risk
      ) VALUES ((SELECT id FROM users LIMIT 1), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        body.name,
        body.accountBalance,
        body.accountEquity,
        body.accountCurrency,
        body.riskPerTradePercent,
        body.maximumDailyLossPercent,
        body.maximumWeeklyLossPercent,
        body.maximumTradesPerSession,
        body.maximumConsecutiveLosses,
        body.mandatoryStopLoss,
        body.minimumRewardToRisk
      ]
    );
    return rows[0];
  });

  app.put("/api/risk/profiles/:id", async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as any;
    const { rows } = await query(
      `UPDATE risk_profiles SET
        account_balance = COALESCE($2, account_balance),
        account_equity = COALESCE($3, account_equity),
        risk_per_trade_percent = COALESCE($4, risk_per_trade_percent),
        minimum_reward_to_risk = COALESCE($5, minimum_reward_to_risk)
      WHERE id = $1 RETURNING *`,
      [id, body.accountBalance, body.accountEquity, body.riskPerTradePercent, body.minimumRewardToRisk]
    );
    return rows[0];
  });
}
