import { query } from "../../infrastructure/db/client.js";
import { buildPaperTargetPlan, paperTargetTouches, type PaperTarget } from "./paper-target-plan.js";

export { buildPaperTargetPlan, paperTargetTouches, type PaperTarget } from "./paper-target-plan.js";

export async function ensurePaperTradeTargets(tradeId: string) {
  await query(
    `UPDATE trades SET
       structural_stop = COALESCE(structural_stop, actual_stop),
       initial_risk_distance = COALESCE(initial_risk_distance, abs(actual_entry - actual_stop))
     WHERE id = $1`,
    [tradeId]
  );
  const tradeResult = await query(
    `SELECT t.id, t.actual_entry, COALESCE(t.structural_stop, t.actual_stop) AS actual_stop,
       t.actual_target, sc.direction
     FROM trades t
     JOIN trade_plans tp ON tp.id = t.trade_plan_id
     JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
     WHERE t.id = $1`,
    [tradeId]
  );
  const trade = tradeResult.rows[0] as any;
  if (!trade) return [];
  const plan = buildPaperTargetPlan(
    Number(trade.actual_entry),
    Number(trade.actual_stop),
    Number(trade.actual_target),
    String(trade.direction)
  );
  for (const target of plan) {
    await query(
      `INSERT INTO paper_trade_targets (trade_id, target_number, price, risk_multiple, metadata)
       VALUES ($1,$2,$3,$4,'{"source":"STRATEGY_RISK_PLAN"}'::jsonb)
       ON CONFLICT (trade_id, target_number) DO UPDATE SET
         price = EXCLUDED.price,
         risk_multiple = EXCLUDED.risk_multiple,
         updated_at = now()
       WHERE paper_trade_targets.status = 'PENDING'`,
      [tradeId, target.targetNumber, target.price, target.riskMultiple]
    );
  }
  return paperTradeTargets(tradeId);
}

export async function paperTradeTargets(tradeId: string): Promise<PaperTarget[]> {
  const result = await query(
    `SELECT id, target_number, price, risk_multiple, status, hit_at, hit_price
     FROM paper_trade_targets
     WHERE trade_id = $1
     ORDER BY target_number`,
    [tradeId]
  );
  return (result.rows as any[]).map((row) => ({
    ...row,
    target_number: Number(row.target_number),
    price: Number(row.price),
    risk_multiple: Number(row.risk_multiple),
    hit_price: row.hit_price == null ? null : Number(row.hit_price)
  }));
}

export function paperTargetPayload(targets: PaperTarget[]) {
  return targets.map((target) => ({
    targetNumber: target.target_number,
    price: target.price,
    riskMultiple: target.risk_multiple,
    status: target.status,
    hitAt: target.hit_at ?? null,
    hitPrice: target.hit_price ?? null
  }));
}

export async function evaluatePaperTargetMilestones(trade: any, candle: any) {
  const targets = await ensurePaperTradeTargets(String(trade.id));
  const { stopHit, ambiguous, pendingHit } = paperTargetTouches(trade, targets, candle);

  // A 5M OHLC candle has no intrabar ordering, so protect the audit result with stop-first handling.
  if (stopHit) return { stopHit: true, ambiguous, newlyHit: [], targets, finalTargetHit: false };

  const newlyHit: PaperTarget[] = [];
  for (const target of pendingHit) {
    const updated = await query(
      `UPDATE paper_trade_targets SET
         status = 'HIT', hit_at = $3, hit_price = price, updated_at = now()
       WHERE trade_id = $1 AND target_number = $2 AND status = 'PENDING'
       RETURNING id, target_number, price, risk_multiple, status, hit_at, hit_price`,
      [trade.id, target.target_number, candle.timestamp_utc ?? candle.timestampUtc]
    );
    if (!updated.rows[0]) continue;
    const hit = updated.rows[0] as any;
    newlyHit.push({
      ...hit,
      target_number: Number(hit.target_number),
      price: Number(hit.price),
      risk_multiple: Number(hit.risk_multiple),
      hit_price: Number(hit.hit_price)
    });
    await query(
      `INSERT INTO trade_events (trade_id, event_type, payload)
       VALUES ($1,$2,$3::jsonb)
       ON CONFLICT (trade_id, event_type)
       WHERE event_type IN ('PAPER_TP1_HIT', 'PAPER_TP2_HIT', 'PAPER_TP3_HIT', 'PAPER_SL_HIT')
       DO NOTHING`,
      [trade.id, `PAPER_TP${target.target_number}_HIT`, JSON.stringify({
        mode: "PAPER",
        targetNumber: target.target_number,
        targetPrice: target.price,
        riskMultiple: target.risk_multiple,
        candleTimestamp: candle.timestamp_utc ?? candle.timestampUtc
      })]
    );
  }
  const refreshed = newlyHit.length > 0 ? await paperTradeTargets(String(trade.id)) : targets;
  return {
    stopHit: false,
    ambiguous: false,
    newlyHit,
    targets: refreshed,
    finalTargetHit: refreshed.find((target) => target.target_number === 3)?.status === "HIT"
  };
}

export async function cancelPendingPaperTargets(tradeId: string, reason: string) {
  await query(
    `UPDATE paper_trade_targets SET
       status = 'CANCELLED', updated_at = now(), metadata = metadata || $2::jsonb
     WHERE trade_id = $1 AND status = 'PENDING'`,
    [tradeId, JSON.stringify({ cancelReason: reason })]
  );
  if (["STOP", "SL_HIT"].includes(reason.toUpperCase())) {
    await query(
      `INSERT INTO trade_events (trade_id, event_type, payload)
       VALUES ($1,'PAPER_SL_HIT',$2::jsonb)
       ON CONFLICT (trade_id, event_type)
       WHERE event_type IN ('PAPER_TP1_HIT', 'PAPER_TP2_HIT', 'PAPER_TP3_HIT', 'PAPER_SL_HIT')
       DO NOTHING`,
      [tradeId, JSON.stringify({ mode: "PAPER", reason: "STRUCTURAL_STOP_HIT" })]
    );
  }
}
