from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from typing import Any

from .module1_orb_brain import decide as decide_module1
from .module2_sweep_bos_brain import decide as decide_module2

try:
    import psycopg
    from psycopg.rows import dict_row
except ImportError as exc:  # pragma: no cover
    raise SystemExit("Missing dependency: install apps/quant/requirements.txt so psycopg is available.") from exc


MODULES = {
    "orb_max_options": "Module 1 ORB",
    "high_probability_strategy_2": "Module 2 Ultimate Sweep",
}

MODULE_BRAINS = {
    "orb_max_options": decide_module1,
    "high_probability_strategy_2": decide_module2,
}


def run_main_brain(database_url: str, tenant_id: str, module_code: str | None = None, persist: bool = True, proof_mode: bool = False, setup_id: str | None = None) -> dict[str, Any]:
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            modules = [module_code] if module_code else enabled_modules(cur, tenant_id)
            candles = candle_health(cur)
            decisions = [decide_module(cur, tenant_id, code, candles, proof_mode=proof_mode, setup_id=setup_id) for code in modules]
            summary = {
                "modules": len(decisions),
                "buySignals": sum(1 for item in decisions if item["action"] == "BUY"),
                "sellSignals": sum(1 for item in decisions if item["action"] == "SELL"),
                "activeTrades": sum(1 for item in decisions if item["decisionType"] == "TRADE_ACTIVE"),
                "signalsReady": sum(1 for item in decisions if item.get("shouldEmitSignal")),
                "paperTrackingNeeded": sum(1 for item in decisions if item.get("shouldTrackPaperTrade") or item.get("shouldOpenPaperTrade")),
                "warnings": sum(1 for item in decisions if item["severity"] in ("WARN", "ERROR", "CRITICAL")),
            }
            result = {
                "status": "COMPLETED",
                "generatedAt": utc_now(),
                "tenantId": tenant_id,
                "proofMode": proof_mode,
                "candleHealth": candles,
                "summary": summary,
                "decisions": decisions,
            }
            if persist:
                persist_run(cur, tenant_id, result)
                for decision in decisions:
                    persist_decision(cur, tenant_id, decision)
                conn.commit()
            return result


def enabled_modules(cur, tenant_id: str) -> list[str]:
    cur.execute(
        """
        SELECT m.code
        FROM tenant_modules tm
        JOIN platform_strategy_modules m ON m.id = tm.module_id
        WHERE tm.tenant_id = %s
          AND tm.status = 'ENABLED'
        ORDER BY m.sort_order
        """,
        (tenant_id,),
    )
    rows = [row["code"] for row in cur.fetchall()]
    return [row for row in rows if row in MODULES] or list(MODULES.keys())


def candle_health(cur) -> dict[str, Any]:
    cur.execute(
        """
        SELECT
          count(*)::int AS candles,
          max(timestamp_utc) AS latest_candle,
          extract(epoch FROM (now() - max(timestamp_utc))) / 60.0 AS age_minutes
        FROM candles
        WHERE symbol = 'XAUUSD'
          AND timeframe_minutes = 5
          AND timestamp_utc >= now() - interval '14 days'
        """
    )
    row = cur.fetchone() or {}
    age = number(row.get("age_minutes"))
    return {
        "symbol": "XAUUSD",
        "timeframeMinutes": 5,
        "candles": int(row.get("candles") or 0),
        "latestCandle": iso(row.get("latest_candle")),
        "ageMinutes": age,
        "status": "LIVE" if age is not None and age <= 10 else "STALE" if age is not None else "EMPTY",
    }


def decide_module(cur, tenant_id: str, module_code: str, candles: dict[str, Any], proof_mode: bool = False, setup_id: str | None = None) -> dict[str, Any]:
    setup = latest_setup(cur, tenant_id, module_code, proof_mode=proof_mode, setup_id=setup_id)
    trade = latest_trade(cur, tenant_id, module_code, proof_mode=proof_mode, setup_id=setup_id)
    brain = MODULE_BRAINS.get(module_code)
    if brain:
        return brain(setup, trade, candles)
    return {
        "moduleCode": module_code,
        "moduleName": MODULES.get(module_code, module_code),
        "decisionType": "UNKNOWN_MODULE_BRAIN",
        "action": "WAIT",
        "direction": None,
        "severity": "ERROR",
        "reason": f"No Python strategy brain is registered for module {module_code}.",
        "shouldEmitSignal": False,
        "shouldTrackPaperTrade": False,
        "shouldOpenPaperTrade": False,
        "mvpPriority": "SIGNAL_FIRST",
        "entry": None,
        "stop": None,
        "target": None,
        "score": None,
        "grade": None,
        "scenario": setup.get("scenario") if setup else None,
        "setupStatus": setup.get("status") if setup else None,
        "setupId": str(setup.get("id")) if setup and setup.get("id") else None,
        "tradeId": str(trade.get("id")) if trade and trade.get("id") else None,
        "candleStatus": candles.get("status"),
        "checklist": {"moduleCode": module_code, "mandatoryPassed": False, "rows": []},
    }


def latest_setup(cur, tenant_id: str, module_code: str, proof_mode: bool = False, setup_id: str | None = None) -> dict[str, Any] | None:
    replay_filter = "AND COALESCE(sc.scenario_flags->>'productionProof', 'false') = 'true'" if proof_mode else "AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'"
    freshness_filter = "" if proof_mode or setup_id else """
          AND (
            t.outcome = 'ACTIVE'
            OR sc.detected_at >= (
              SELECT max(c.timestamp_utc) - interval '90 minutes'
              FROM candles c
              WHERE c.symbol = sc.symbol
                AND c.timeframe_minutes = 5
                AND c.source LIKE %s
            )
          )
    """
    setup_filter = "AND sc.id = %s" if setup_id else ""
    query_params: tuple[Any, ...] = (tenant_id, module_code)
    if setup_id:
        query_params += (setup_id,)
    if not proof_mode:
        query_params += ("TWELVE_DATA%",)
    cur.execute(
        f"""
        SELECT
          sc.id,
          sc.module_code,
          sc.scenario,
          sc.direction,
          sc.status,
          sc.detected_at,
          sc.entry_price,
          sc.stop_price,
          sc.target_price,
          sc.final_reason,
          sc.favorability_score,
          sc.favorability_grade,
          sc.scenario_flags,
          t.id AS trade_id,
          COALESCE(json_agg(sre ORDER BY sre.evaluated_at) FILTER (WHERE sre.id IS NOT NULL), '[]'::json) AS evaluations
        FROM setup_candidates sc
        LEFT JOIN trade_plans tp ON tp.setup_candidate_id = sc.id
        LEFT JOIN trades t ON t.trade_plan_id = tp.id
        LEFT JOIN setup_rule_evaluations sre ON sre.setup_candidate_id = sc.id
        WHERE sc.tenant_id = %s
          AND sc.module_code = %s
          AND sc.scenario <> 'QA_TEST_SIGNAL'
          {replay_filter}
          {setup_filter}
          {freshness_filter}
        GROUP BY sc.id, t.id
        ORDER BY sc.detected_at DESC
        LIMIT 1
        """,
        query_params,
    )
    row = cur.fetchone()
    return normalize(row) if row else None


def latest_trade(cur, tenant_id: str, module_code: str, proof_mode: bool = False, setup_id: str | None = None) -> dict[str, Any] | None:
    replay_filter = "AND COALESCE(sc.scenario_flags->>'productionProof', 'false') = 'true'" if proof_mode else "AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'"
    setup_filter = "AND sc.id = %s" if setup_id else ""
    cur.execute(
        f"""
        SELECT
          t.id,
          t.outcome,
          t.actual_entry,
          t.actual_stop,
          t.actual_target,
          t.opened_at,
          t.closed_at,
          sc.direction,
          sc.scenario,
          sc.status AS setup_status
        FROM trades t
        JOIN trade_plans tp ON tp.id = t.trade_plan_id
        JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
        WHERE sc.tenant_id = %s
          AND sc.module_code = %s
          AND sc.scenario <> 'QA_TEST_SIGNAL'
          {replay_filter}
          {setup_filter}
        ORDER BY CASE WHEN t.outcome = 'ACTIVE' THEN 0 ELSE 1 END, COALESCE(t.opened_at, t.closed_at) DESC
        LIMIT 1
        """,
        (tenant_id, module_code, setup_id) if setup_id else (tenant_id, module_code),
    )
    row = cur.fetchone()
    return normalize(row) if row else None


def persist_run(cur, tenant_id: str, result: dict[str, Any]) -> None:
    cur.execute(
        """
        INSERT INTO operational_events (severity, category, event_type, source, tenant_id, message, metadata)
        VALUES (%s, 'SYSTEM', 'MAIN_BRAIN_RUN', 'python-main-brain', %s, %s, %s::jsonb)
        """,
        ("WARN" if result["summary"]["warnings"] else "INFO", tenant_id, "Main brain completed module decision sweep.", json.dumps(result, default=str)),
    )


def persist_decision(cur, tenant_id: str, item: dict[str, Any]) -> None:
    cur.execute(
        """
        INSERT INTO operational_events (severity, category, event_type, source, tenant_id, message, metadata)
        VALUES (%s, 'SYSTEM', 'MAIN_BRAIN_DECISION', 'python-main-brain', %s, %s, %s::jsonb)
        """,
        (item["severity"], tenant_id, f"{item['moduleName']}: {item['decisionType']} / {item['action']}", json.dumps(item, default=str)),
    )


def normalize(row: dict[str, Any]) -> dict[str, Any]:
    result = dict(row)
    flags = result.get("scenario_flags")
    if isinstance(flags, str):
        result["scenario_flags"] = json.loads(flags)
    evaluations = result.get("evaluations")
    if isinstance(evaluations, str):
        result["evaluations"] = json.loads(evaluations)
    return result


def number(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def main() -> None:
    parser = argparse.ArgumentParser(description="Main deterministic command brain for live XAUUSD strategy modules.")
    parser.add_argument("--database-url", required=True)
    parser.add_argument("--tenant-id", required=True)
    parser.add_argument("--module-code", default=None)
    parser.add_argument("--no-persist", action="store_true")
    parser.add_argument("--proof-mode", action="store_true")
    parser.add_argument("--setup-id", default=None)
    args = parser.parse_args()
    print(json.dumps(run_main_brain(args.database_url, args.tenant_id, args.module_code, persist=not args.no_persist, proof_mode=args.proof_mode, setup_id=args.setup_id), default=str))


if __name__ == "__main__":
    main()
