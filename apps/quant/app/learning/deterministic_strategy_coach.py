from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Any

try:
    import psycopg
    from psycopg.rows import dict_row
except ImportError as exc:  # pragma: no cover
    raise SystemExit("Missing dependency: install apps/quant/requirements.txt so psycopg is available.") from exc


MODULE_NAMES = {
    "orb_max_options": "Module 1 ORB",
    "high_probability_strategy_2": "Module 2 Sweep + BOS",
    "strategy_lab_3": "Module 3 VWAP Drive",
}

MIN_RESULTS_FOR_TUNING = 20
MIN_READY_SETUPS_FOR_AUTOMATION_AUDIT = 1


def run_coach(database_url: str, tenant_id: str, module_code: str | None = None) -> dict[str, Any]:
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            modules = [module_code] if module_code else enabled_modules(cur, tenant_id)
            runs = [coach_module(cur, tenant_id, code) for code in modules]
            conn.commit()
            return {
                "status": "COMPLETED",
                "generatedAt": utc_now(),
                "tenantId": tenant_id,
                "modules": runs,
                "summary": {
                    "modulesAnalyzed": len(runs),
                    "recommendations": sum(item["recommendations"] for item in runs),
                    "readySetupsWithoutPaperTrade": sum(item["summary"].get("automation", {}).get("readyWithoutPaperTrade", 0) for item in runs),
                    "closedPaperTrades": sum(item["summary"].get("outcomes", {}).get("trades", 0) for item in runs),
                },
            }


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
    return rows or ["orb_max_options", "high_probability_strategy_2", "strategy_lab_3"]


def coach_module(cur, tenant_id: str, module_code: str) -> dict[str, Any]:
    run_id = create_run(cur, tenant_id, module_code)
    try:
        setups = load_setups(cur, tenant_id, module_code)
        trades = load_trades(cur, tenant_id, module_code)
        evaluations = load_evaluations(cur, tenant_id, module_code)
        backtest_trades = load_latest_backtest_trades(cur, tenant_id, module_code)
        candles = load_candle_profile(cur)
        summary = build_summary(module_code, setups, trades, evaluations, backtest_trades, candles)
        recommendations = build_recommendations(module_code, summary, setups, trades, evaluations, backtest_trades)
        for item in recommendations:
            insert_recommendation(cur, run_id, module_code, item)
        cur.execute(
            """
            UPDATE module_learning_runs
            SET status = 'COMPLETED', completed_at = now(), sample_size = %s, summary = %s::jsonb
            WHERE id = %s
            """,
            (len(trades), json.dumps(summary, default=str), run_id),
        )
        return {
            "runId": str(run_id),
            "moduleCode": module_code,
            "status": "COMPLETED",
            "sampleSize": len(trades),
            "recommendations": len(recommendations),
            "summary": summary,
        }
    except Exception as exc:
        cur.execute(
            """
            UPDATE module_learning_runs
            SET status = 'FAILED', completed_at = now(), summary = %s::jsonb
            WHERE id = %s
            """,
            (json.dumps({"error": str(exc), "moduleCode": module_code}), run_id),
        )
        raise


def create_run(cur, tenant_id: str, module_code: str):
    cur.execute(
        """
        INSERT INTO module_learning_runs (tenant_id, module_code, source, status)
        VALUES (%s, %s, 'DETERMINISTIC_STRATEGY_COACH', 'RUNNING')
        RETURNING id
        """,
        (tenant_id, module_code),
    )
    return cur.fetchone()["id"]


def load_setups(cur, tenant_id: str, module_code: str) -> list[dict[str, Any]]:
    cur.execute(
        """
        SELECT
          sc.id,
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
          tp.id AS trade_plan_id,
          t.id AS trade_id,
          t.outcome,
          t.result_r::float AS result_r
        FROM setup_candidates sc
        LEFT JOIN trade_plans tp ON tp.setup_candidate_id = sc.id
        LEFT JOIN trades t ON t.trade_plan_id = tp.id
        WHERE sc.tenant_id = %s
          AND sc.module_code = %s
          AND sc.scenario <> 'QA_TEST_SIGNAL'
          AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'
        ORDER BY sc.detected_at DESC
        LIMIT 500
        """,
        (tenant_id, module_code),
    )
    return [normalize_json(row) for row in cur.fetchall()]


def load_trades(cur, tenant_id: str, module_code: str) -> list[dict[str, Any]]:
    cur.execute(
        """
        SELECT
          sc.scenario,
          sc.direction,
          COALESCE(sc.scenario_flags->>'setupTier', 'FULL') AS setup_tier,
          sc.favorability_score,
          sc.favorability_grade,
          t.outcome,
          t.result_r::float AS result_r,
          t.opened_at,
          t.closed_at
        FROM trades t
        JOIN trade_plans tp ON tp.id = t.trade_plan_id
        JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
        WHERE sc.tenant_id = %s
          AND sc.module_code = %s
          AND t.outcome IN ('WIN', 'LOSS', 'BREAKEVEN')
          AND sc.scenario <> 'QA_TEST_SIGNAL'
          AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'
        ORDER BY COALESCE(t.closed_at, t.opened_at) DESC
        LIMIT 500
        """,
        (tenant_id, module_code),
    )
    return [normalize_json(row) for row in cur.fetchall()]


def load_evaluations(cur, tenant_id: str, module_code: str) -> list[dict[str, Any]]:
    cur.execute(
        """
        SELECT
          sre.rule_code,
          sre.name,
          sre.status,
          sre.blocking,
          count(*)::int AS count
        FROM setup_rule_evaluations sre
        JOIN setup_candidates sc ON sc.id = sre.setup_candidate_id
        WHERE sc.tenant_id = %s
          AND sc.module_code = %s
          AND sc.scenario <> 'QA_TEST_SIGNAL'
          AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'
        GROUP BY sre.rule_code, sre.name, sre.status, sre.blocking
        ORDER BY count(*) DESC
        LIMIT 100
        """,
        (tenant_id, module_code),
    )
    return [dict(row) for row in cur.fetchall()]


def load_latest_backtest_trades(cur, tenant_id: str, module_code: str) -> list[dict[str, Any]]:
    cur.execute(
        """
        SELECT bt.scenario, bt.direction, bt.outcome, bt.result_r::float AS result_r, bt.details
        FROM backtest_trades bt
        JOIN backtest_runs br ON br.id = bt.backtest_run_id
        WHERE br.tenant_id = %s
          AND COALESCE(br.module_code, br.parameters->>'moduleCode') = %s
        ORDER BY br.completed_at DESC NULLS LAST, bt.session_date DESC
        LIMIT 300
        """,
        (tenant_id, module_code),
    )
    return [normalize_json(row) for row in cur.fetchall()]


def load_candle_profile(cur) -> dict[str, Any]:
    cur.execute(
        """
        SELECT
          count(*)::int AS candles,
          min(timestamp_utc) AS first_candle,
          max(timestamp_utc) AS last_candle,
          count(DISTINCT date(timestamp_utc AT TIME ZONE 'America/New_York'))::int AS ny_days
        FROM candles
        WHERE symbol = 'XAUUSD'
          AND timeframe_minutes = 5
          AND timestamp_utc >= now() - interval '14 days'
        """
    )
    row = cur.fetchone() or {}
    return {
        "candles": int(row.get("candles") or 0),
        "firstCandle": iso(row.get("first_candle")),
        "lastCandle": iso(row.get("last_candle")),
        "newYorkDays": int(row.get("ny_days") or 0),
    }


def build_summary(
    module_code: str,
    setups: list[dict[str, Any]],
    trades: list[dict[str, Any]],
    evaluations: list[dict[str, Any]],
    backtest_trades: list[dict[str, Any]],
    candles: dict[str, Any],
) -> dict[str, Any]:
    ready = [row for row in setups if row.get("status") in ("LONG SETUP READY", "SHORT SETUP READY", "PAPER_TRADE_OPENED")]
    ready_without_trade = [row for row in ready if not row.get("trade_id")]
    blocked_or_wait = [row for row in setups if row.get("status") in ("WAIT", "BLOCKED", "NO TRADE", "WAIT FOR RETEST")]
    checklist = checklist_profile(evaluations)
    return {
        "generatedAt": utc_now(),
        "moduleCode": module_code,
        "moduleName": MODULE_NAMES.get(module_code, module_code),
        "candles": candles,
        "setups": {
            "total": len(setups),
            "ready": len(ready),
            "blockedOrWait": len(blocked_or_wait),
            "paperOpened": sum(1 for row in setups if row.get("trade_id")),
        },
        "automation": {
            "readyWithoutPaperTrade": len(ready_without_trade),
            "examples": [setup_brief(row) for row in ready_without_trade[:8]],
        },
        "outcomes": metrics_for(trades),
        "backtest": metrics_for(backtest_trades),
        "byScenario": bucket_metrics(trades, lambda row: row.get("scenario") or "UNKNOWN"),
        "byDirection": bucket_metrics(trades, lambda row: row.get("direction") or "UNKNOWN"),
        "byTier": bucket_metrics(trades, lambda row: row.get("setup_tier") or "FULL"),
        "checklist": checklist,
        "sampleWarning": len(trades) < MIN_RESULTS_FOR_TUNING,
    }


def build_recommendations(
    module_code: str,
    summary: dict[str, Any],
    setups: list[dict[str, Any]],
    trades: list[dict[str, Any]],
    evaluations: list[dict[str, Any]],
    backtest_trades: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    module_name = summary["moduleName"]
    outcomes = summary["outcomes"]
    automation = summary["automation"]
    checklist = summary["checklist"]

    if summary["candles"]["candles"] < 100:
        items.append(rec("DATA_REQUIRED", "LOW", f"Collect more 5M XAUUSD candles for {module_name}", "The coach needs more PostgreSQL candle history before missed-opportunity analysis is reliable.", summary["candles"], {"action": "COLLECT_CANDLES", "moduleCode": module_code, "minimumCandles": 100}))

    if outcomes["trades"] == 0:
        items.append(rec("PAPER_TRADING_REQUIRED", "LOW", f"Keep {module_name} in paper-learning mode", "No closed paper trades were found. The system cannot tune win-rate or expectancy until TP/SL outcomes exist.", outcomes, {"action": "KEEP_PAPER_TRADING_ON", "moduleCode": module_code}))
    elif outcomes["trades"] < MIN_RESULTS_FOR_TUNING:
        items.append(rec("SAMPLE_TOO_SMALL", "LOW", f"Do not tune {module_name} thresholds yet", f"Only {outcomes['trades']} closed paper outcomes exist. Use recommendations as QA guidance only.", outcomes, {"action": "COLLECT_MORE_RESULTS", "moduleCode": module_code, "minimumClosedTrades": MIN_RESULTS_FOR_TUNING}))

    if automation["readyWithoutPaperTrade"] >= MIN_READY_SETUPS_FOR_AUTOMATION_AUDIT:
        items.append(rec("AUTOMATION_MISSED_READY_SETUP", "HIGH", f"Audit {module_name} paper-trade trigger", f"{automation['readyWithoutPaperTrade']} ready setup(s) did not have a linked paper trade. This is an automation wiring issue, not a strategy edge issue.", automation, {"action": "AUDIT_PAPER_TRADE_GATE", "moduleCode": module_code}))

    top_blocker = first_blocker(checklist)
    if top_blocker:
        items.append(rec("RULE_BOTTLENECK", "MEDIUM" if top_blocker["count"] >= 5 else "LOW", f"Focus {module_name} QA on {pretty(top_blocker['ruleCode'])}", f"{pretty(top_blocker['ruleCode'])} is the most common failed/waiting blocking rule. Review whether this is protecting quality or missing valid trades.", top_blocker, {"action": "REVIEW_RULE_BOTTLENECK", "moduleCode": module_code, "ruleCode": top_blocker["ruleCode"]}))

    for bucket in weak_buckets(summary["byScenario"], "scenario", module_code):
        items.append(bucket)
    for bucket in strong_buckets(summary["byScenario"], "scenario", module_code):
        items.append(bucket)

    backtest = metrics_for(backtest_trades)
    if backtest["trades"] == 0:
        items.append(rec("BACKTEST_REQUIRED", "MEDIUM", f"Run {module_name} backtest before threshold changes", "No latest backtest trades were found. Use backtest + paper outcomes together before approving any strategy setting change.", {"backtestTrades": 0}, {"action": "RUN_BACKTEST", "moduleCode": module_code}))

    if outcomes["trades"] >= MIN_RESULTS_FOR_TUNING and outcomes["winRate"] >= 0.55 and outcomes["expectancy"] > 0.15:
        items.append(rec("EDGE_CONFIRMED_FOR_REVIEW", "HIGH", f"{module_name} has positive paper expectancy", f"Closed paper results show {outcomes['winRate']:.1%} win rate and {outcomes['expectancy']:.2f}R expectancy. Review for promotion, but keep hard rules unchanged.", outcomes, {"action": "PROMOTION_REVIEW", "moduleCode": module_code, "requiresAdminApproval": True}))

    return items[:20]


def checklist_profile(rows: list[dict[str, Any]]) -> dict[str, Any]:
    counts: dict[str, Counter] = defaultdict(Counter)
    names: dict[str, str] = {}
    blocking: dict[str, bool] = {}
    for row in rows:
        code = str(row.get("rule_code") or "")
        if not code:
            continue
        counts[code][str(row.get("status") or "UNKNOWN")] += int(row.get("count") or 0)
        names[code] = str(row.get("name") or code)
        blocking[code] = bool(row.get("blocking"))
    rules = []
    for code, statuses in counts.items():
        total = sum(statuses.values())
        passed = statuses.get("PASS", 0)
        failed_waiting = total - passed
        rules.append(
            {
                "ruleCode": code,
                "name": names.get(code, code),
                "blocking": blocking.get(code, False),
                "total": total,
                "passed": passed,
                "failedOrWaiting": failed_waiting,
                "passRate": passed / total if total else 0,
                "statuses": dict(statuses),
            }
        )
    return {
        "rules": sorted(rules, key=lambda item: (-int(item["blocking"]), item["passRate"], -item["total"])),
        "blockingFailures": [rule for rule in rules if rule["blocking"] and rule["failedOrWaiting"] > 0],
    }


def first_blocker(checklist: dict[str, Any]) -> dict[str, Any] | None:
    blockers = sorted(checklist.get("blockingFailures", []), key=lambda item: (-item["failedOrWaiting"], item["passRate"]))
    if not blockers:
        return None
    item = blockers[0]
    return {"ruleCode": item["ruleCode"], "name": item["name"], "count": item["failedOrWaiting"], "passRate": item["passRate"], "blocking": item["blocking"]}


def weak_buckets(buckets: dict[str, dict[str, Any]], bucket_name: str, module_code: str) -> list[dict[str, Any]]:
    items = []
    for name, metrics in buckets.items():
        if metrics["trades"] >= 3 and metrics["expectancy"] < -0.15:
            items.append(rec("REVIEW_WEAK_BUCKET", confidence(metrics["trades"]), f"Review weak {bucket_name}: {pretty(name)}", f"{pretty(name)} has {metrics['trades']} trades and {metrics['expectancy']:.2f}R expectancy.", metrics, {"action": "REVIEW_BUCKET", "moduleCode": module_code, bucket_name: name}))
    return items


def strong_buckets(buckets: dict[str, dict[str, Any]], bucket_name: str, module_code: str) -> list[dict[str, Any]]:
    items = []
    for name, metrics in buckets.items():
        if metrics["trades"] >= 3 and metrics["expectancy"] > 0.2 and metrics["winRate"] >= 0.5:
            items.append(rec("FAVOR_STRONG_BUCKET", confidence(metrics["trades"]), f"Favor strong {bucket_name}: {pretty(name)}", f"{pretty(name)} has {metrics['trades']} trades, {metrics['winRate']:.1%} win rate, and {metrics['expectancy']:.2f}R expectancy.", metrics, {"action": "FAVOR_BUCKET", "moduleCode": module_code, bucket_name: name}))
    return items


def insert_recommendation(cur, run_id, module_code: str, item: dict[str, Any]) -> None:
    cur.execute(
        """
        INSERT INTO module_learning_recommendations (
          learning_run_id, module_code, recommendation_type, confidence, title,
          rationale, metrics, suggested_action
        ) VALUES (%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb)
        """,
        (
            run_id,
            module_code,
            item["recommendationType"],
            item["confidence"],
            item["title"],
            item["rationale"],
            json.dumps(item["metrics"], default=str),
            json.dumps(item["suggestedAction"], default=str),
        ),
    )


def rec(kind: str, confidence_value: str, title: str, rationale: str, metrics: dict[str, Any], action: dict[str, Any]) -> dict[str, Any]:
    return {
        "recommendationType": kind,
        "confidence": confidence_value,
        "title": title,
        "rationale": rationale,
        "metrics": metrics,
        "suggestedAction": {**action, "mode": "REVIEW_ONLY", "autoApply": False},
    }


def metrics_for(rows: list[dict[str, Any]]) -> dict[str, Any]:
    trades = len(rows)
    wins = sum(1 for row in rows if row.get("outcome") == "WIN")
    losses = sum(1 for row in rows if row.get("outcome") == "LOSS")
    breakeven = sum(1 for row in rows if row.get("outcome") == "BREAKEVEN")
    total_r = sum(float(row.get("result_r") or 0) for row in rows)
    gross_win = sum(float(row.get("result_r") or 0) for row in rows if float(row.get("result_r") or 0) > 0)
    gross_loss = abs(sum(float(row.get("result_r") or 0) for row in rows if float(row.get("result_r") or 0) < 0))
    return {
        "trades": trades,
        "wins": wins,
        "losses": losses,
        "breakeven": breakeven,
        "winRate": wins / trades if trades else 0,
        "totalR": total_r,
        "expectancy": total_r / trades if trades else 0,
        "profitFactor": gross_win / gross_loss if gross_loss else None,
    }


def bucket_metrics(rows: list[dict[str, Any]], key_fn) -> dict[str, dict[str, Any]]:
    buckets: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        buckets[str(key_fn(row))].append(row)
    return {key: metrics_for(group) for key, group in buckets.items()}


def setup_brief(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(row.get("id")),
        "scenario": row.get("scenario"),
        "direction": row.get("direction"),
        "status": row.get("status"),
        "detectedAt": iso(row.get("detected_at")),
        "entry": number(row.get("entry_price")),
        "stop": number(row.get("stop_price")),
        "target": number(row.get("target_price")),
    }


def normalize_json(row: dict[str, Any]) -> dict[str, Any]:
    result = dict(row)
    flags = result.get("scenario_flags")
    if isinstance(flags, str):
        result["scenario_flags"] = json.loads(flags)
    return result


def confidence(sample_size: int) -> str:
    if sample_size >= 30:
        return "HIGH"
    if sample_size >= 10:
        return "MEDIUM"
    return "LOW"


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


def pretty(value: str) -> str:
    return str(value).replace("_", " ").title()


def main() -> None:
    parser = argparse.ArgumentParser(description="Deterministic strategy coach for all enabled XAUUSD modules.")
    parser.add_argument("--database-url", required=True)
    parser.add_argument("--tenant-id", required=True)
    parser.add_argument("--module-code", default=None)
    args = parser.parse_args()
    print(json.dumps(run_coach(args.database_url, args.tenant_id, args.module_code), default=str))


if __name__ == "__main__":
    main()
