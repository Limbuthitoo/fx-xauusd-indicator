import { query } from "../../infrastructure/db/client.js";
import { buildPaperTargetPlan, paperSettlement, paperTargetTouches, type PaperTarget } from "./paper-target-plan.js";

export { buildPaperTargetPlan, paperSettlement, paperTargetTouches, type PaperTarget } from "./paper-target-plan.js";

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
      `INSERT INTO paper_trade_targets (trade_id, target_number, price, risk_multiple, position_fraction, metadata)
       VALUES ($1,$2,$3,$4,$5,'{"source":"STRATEGY_RISK_PLAN","management":"EQUAL_THIRDS_TP1_BREAKEVEN"}'::jsonb)
       ON CONFLICT (trade_id, target_number) DO UPDATE SET
         price = EXCLUDED.price,
         risk_multiple = EXCLUDED.risk_multiple,
         position_fraction = EXCLUDED.position_fraction,
         updated_at = now()
       WHERE paper_trade_targets.status = 'PENDING'`,
      [tradeId, target.targetNumber, target.price, target.riskMultiple, target.positionFraction]
    );
  }
  return paperTradeTargets(tradeId);
}

export async function paperTradeTargets(tradeId: string): Promise<PaperTarget[]> {
  const result = await query(
    `SELECT id, target_number, price, risk_multiple, position_fraction, realized_r, status, hit_at, hit_price
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
    position_fraction: Number(row.position_fraction),
    realized_r: row.realized_r == null ? null : Number(row.realized_r),
    hit_price: row.hit_price == null ? null : Number(row.hit_price)
  }));
}

export function paperTargetPayload(targets: PaperTarget[]) {
  return targets.map((target) => ({
    targetNumber: target.target_number,
    price: target.price,
    riskMultiple: target.risk_multiple,
    positionFraction: target.position_fraction,
    realizedR: target.realized_r ?? null,
    status: target.status,
    hitAt: target.hit_at ?? null,
    hitPrice: target.hit_price ?? null
  }));
}

export async function evaluatePaperTargetMilestones(trade: any, candle: any) {
  const targets = await ensurePaperTradeTargets(String(trade.id));
  const currentState = await syncPaperTradeManagement(String(trade.id));
  const managedTrade = { ...trade, ...currentState };
  const { stopHit, ambiguous, pendingHit } = paperTargetTouches(managedTrade, targets, candle);

  // A 5M OHLC candle has no intrabar ordering, so protect the audit result with stop-first handling.
  if (stopHit) {
    const breakevenProtected = managedTrade.breakeven_activated_at != null || Math.abs(Number(managedTrade.actual_stop) - Number(managedTrade.actual_entry)) < 0.00001;
    return {
      stopHit: true,
      stopReason: breakevenProtected ? "BREAKEVEN_STOP" : "STOP",
      stopPrice: Number(managedTrade.actual_stop ?? managedTrade.structural_stop),
      breakevenProtected,
      ambiguous,
      newlyHit: [],
      targets,
      finalTargetHit: false,
      lockedR: Number(managedTrade.realized_r ?? 0),
      remainingFraction: Number(managedTrade.remaining_fraction ?? 1)
    };
  }

  const newlyHit: PaperTarget[] = [];
  for (const target of pendingHit) {
    const updated = await query(
      `UPDATE paper_trade_targets SET
         status = 'HIT', hit_at = $3, hit_price = price,
         realized_r = risk_multiple * position_fraction, updated_at = now()
       WHERE trade_id = $1 AND target_number = $2 AND status = 'PENDING'
       RETURNING id, target_number, price, risk_multiple, position_fraction, realized_r, status, hit_at, hit_price`,
      [trade.id, target.target_number, candle.timestamp_utc ?? candle.timestampUtc]
    );
    if (!updated.rows[0]) continue;
    const hit = updated.rows[0] as any;
    newlyHit.push({
      ...hit,
      target_number: Number(hit.target_number),
      price: Number(hit.price),
      risk_multiple: Number(hit.risk_multiple),
      position_fraction: Number(hit.position_fraction),
      realized_r: Number(hit.realized_r),
      hit_price: Number(hit.hit_price)
    });
    const managed = await syncPaperTradeManagement(String(trade.id));
    if (Number(hit.target_number) === 1 && managed) {
      await query(
        `INSERT INTO trade_events (trade_id, event_type, payload)
         SELECT $1, 'PAPER_STOP_TO_BREAKEVEN', $2::jsonb
         WHERE NOT EXISTS (
           SELECT 1 FROM trade_events WHERE trade_id = $1 AND event_type = 'PAPER_STOP_TO_BREAKEVEN'
         )`,
        [trade.id, JSON.stringify({
          mode: "PAPER",
          trigger: "TP1_HIT",
          previousStop: managedTrade.structural_stop ?? managedTrade.actual_stop,
          activeStop: Number(managed.actual_stop),
          lockedR: Number(managed.realized_r),
          remainingFraction: Number(managed.remaining_fraction),
          candleTimestamp: candle.timestamp_utc ?? candle.timestampUtc
        })]
      );
      await query(
        `UPDATE positions SET
           current_stop = $2,
           current_open_risk = 0,
           metadata = metadata || $3::jsonb,
           updated_at = now()
         WHERE trade_id = $1 AND state NOT LIKE 'CLOSED%'`,
        [trade.id, Number(managed.actual_stop), JSON.stringify({
          stopManagement: "BREAKEVEN_AFTER_TP1",
          breakevenActivatedAt: managed.breakeven_activated_at
        })]
      );
    }
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
        positionFraction: Number(hit.position_fraction),
        realizedR: Number(hit.realized_r),
        candleTimestamp: candle.timestamp_utc ?? candle.timestampUtc
      })]
    );
  }
  const refreshed = newlyHit.length > 0 ? await paperTradeTargets(String(trade.id)) : targets;
  const refreshedTrade = newlyHit.length > 0
    ? (await query("SELECT actual_stop, realized_r, remaining_fraction, breakeven_activated_at FROM trades WHERE id = $1", [trade.id])).rows[0]
    : managedTrade;
  return {
    stopHit: false,
    stopReason: null,
    stopPrice: Number(refreshedTrade.actual_stop ?? trade.actual_stop),
    breakevenProtected: refreshedTrade.breakeven_activated_at != null,
    ambiguous: false,
    newlyHit,
    targets: refreshed,
    finalTargetHit: refreshed.find((target) => target.target_number === 3)?.status === "HIT",
    lockedR: Number(refreshedTrade.realized_r ?? 0),
    remainingFraction: Number(refreshedTrade.remaining_fraction ?? 1)
  };
}

export async function paperTradeSettlement(trade: any, exitPrice: number) {
  return paperSettlement(trade, await paperTradeTargets(String(trade.id)), exitPrice);
}

async function syncPaperTradeManagement(tradeId: string) {
  const managed = await query(
    `WITH target_state AS (
       SELECT
         COALESCE(sum(realized_r) FILTER (WHERE status = 'HIT'), 0) AS locked_r,
         COALESCE(sum(position_fraction) FILTER (WHERE status = 'HIT'), 0) AS filled_fraction,
         min(hit_at) FILTER (WHERE target_number = 1 AND status = 'HIT') AS tp1_hit_at
       FROM paper_trade_targets
       WHERE trade_id = $1
     )
     UPDATE trades t SET
       realized_r = target_state.locked_r,
       remaining_fraction = CASE WHEN t.outcome = 'ACTIVE' THEN greatest(0, 1 - target_state.filled_fraction) ELSE 0 END,
       actual_stop = CASE WHEN target_state.tp1_hit_at IS NOT NULL THEN t.actual_entry ELSE t.actual_stop END,
       breakeven_activated_at = COALESCE(t.breakeven_activated_at, target_state.tp1_hit_at)
     FROM target_state
     WHERE t.id = $1
     RETURNING t.actual_entry, t.actual_stop, t.structural_stop, t.initial_risk_distance,
               t.realized_r, t.remaining_fraction, t.breakeven_activated_at`,
    [tradeId]
  );
  return managed.rows[0] ?? {};
}

export async function cancelPendingPaperTargets(tradeId: string, reason: string) {
  await query(
    `UPDATE paper_trade_targets SET
       status = 'CANCELLED', updated_at = now(), metadata = metadata || $2::jsonb
     WHERE trade_id = $1 AND status = 'PENDING'`,
    [tradeId, JSON.stringify({ cancelReason: reason })]
  );
  if (["STOP", "SL_HIT", "BREAKEVEN_STOP"].includes(reason.toUpperCase())) {
    await query(
      `INSERT INTO trade_events (trade_id, event_type, payload)
       VALUES ($1,'PAPER_SL_HIT',$2::jsonb)
       ON CONFLICT (trade_id, event_type)
       WHERE event_type IN ('PAPER_TP1_HIT', 'PAPER_TP2_HIT', 'PAPER_TP3_HIT', 'PAPER_SL_HIT')
       DO NOTHING`,
      [tradeId, JSON.stringify({
        mode: "PAPER",
        reason: reason.toUpperCase() === "BREAKEVEN_STOP" ? "BREAKEVEN_STOP_HIT" : "STRUCTURAL_STOP_HIT"
      })]
    );
  }
}
