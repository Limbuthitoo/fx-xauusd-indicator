from __future__ import annotations

import argparse
import json
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

try:
    import psycopg
    from psycopg.rows import dict_row
except ImportError as exc:  # pragma: no cover
    raise SystemExit("Missing dependency: install apps/quant/requirements.txt so psycopg is available.") from exc


MODULE_CODE = "strategy_lab_3"
MIN_SAMPLE_FOR_CHANGE = 20
MIN_BUCKET_SAMPLE = 3


def run_learning(database_url: str, tenant_id: str, source: str = "MODULE3_PAPER_TRADES") -> dict[str, Any]:
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            run_id = create_run(cur, tenant_id, source)
            try:
                trades = load_trades(cur, tenant_id)
                failures = load_failures(cur, tenant_id)
                recommendations = build_recommendations(trades, failures)
                summary = build_summary(trades, failures, recommendations)
                for item in recommendations:
                    insert_recommendation(cur, run_id, item)
                cur.execute(
                    """
                    UPDATE module_learning_runs
                    SET status = 'COMPLETED', completed_at = now(), sample_size = %s, summary = %s::jsonb
                    WHERE id = %s
                    """,
                    (len(trades), json.dumps(summary, default=str), run_id),
                )
                conn.commit()
                return {
                    "runId": str(run_id),
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
                    (json.dumps({"error": str(exc)}), run_id),
                )
                conn.commit()
                raise


def create_run(cur, tenant_id: str, source: str):
    cur.execute(
        """
        INSERT INTO module_learning_runs (tenant_id, module_code, source, status)
        VALUES (%s, %s, %s, 'RUNNING')
        RETURNING id
        """,
        (tenant_id, MODULE_CODE, source),
    )
    return cur.fetchone()["id"]


def load_trades(cur, tenant_id: str) -> list[dict[str, Any]]:
    cur.execute(
        """
        SELECT
          sc.id AS setup_id,
          sc.scenario,
          sc.direction,
          sc.favorability_score,
          sc.favorability_grade,
          sc.scenario_flags,
          COALESCE(sc.scenario_flags->>'setupTier', 'FULL') AS setup_tier,
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
        ORDER BY COALESCE(t.closed_at, t.opened_at)
        """,
        (tenant_id, MODULE_CODE),
    )
    return list(cur.fetchall())


def load_failures(cur, tenant_id: str) -> list[dict[str, Any]]:
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
          AND sc.status <> 'TEST_CLEARED'
          AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'
          AND sre.status <> 'PASS'
        GROUP BY sre.rule_code, sre.name, sre.status, sre.blocking
        ORDER BY count(*) DESC
        LIMIT 30
        """,
        (tenant_id, MODULE_CODE),
    )
    return list(cur.fetchall())


def build_summary(trades: list[dict[str, Any]], failures: list[dict[str, Any]], recommendations: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "overall": metrics_for(trades),
        "bySetupTier": bucket_metrics(trades, lambda row: row.get("setup_tier") or "FULL"),
        "byGrade": bucket_metrics(trades, lambda row: row.get("favorability_grade") or "UNKNOWN"),
        "byDirection": bucket_metrics(trades, lambda row: row.get("direction") or "UNKNOWN"),
        "byDriveStrength": bucket_metrics(trades, drive_strength_bucket),
        "byPullbackZone": bucket_metrics(trades, pullback_zone_bucket),
        "failureRules": failures[:12],
        "recommendations": len(recommendations),
        "sampleWarning": len(trades) < MIN_SAMPLE_FOR_CHANGE,
    }


def build_recommendations(trades: list[dict[str, Any]], failures: list[dict[str, Any]]) -> list[dict[str, Any]]:
    overall = metrics_for(trades)
    recommendations: list[dict[str, Any]] = []
    if overall["trades"] == 0:
        return [
            recommendation(
                "DATA_REQUIRED",
                "LOW",
                "Collect Module 3 paper-trade outcomes",
                "No completed non-QA Module 3 paper trades were found. Keep paper trading active before changing VWAP-drive thresholds.",
                overall,
                {"action": "COLLECT_RESULTS", "minimumClosedTrades": MIN_SAMPLE_FOR_CHANGE},
            )
        ]
    if overall["trades"] < MIN_SAMPLE_FOR_CHANGE:
        recommendations.append(
            recommendation(
                "DATA_REQUIRED",
                "LOW",
                "Keep Module 3 in learning mode",
                f"Only {overall['trades']} completed Module 3 results are available. Treat output as QA guidance only.",
                overall,
                {"action": "COLLECT_MORE_RESULTS", "minimumClosedTrades": MIN_SAMPLE_FOR_CHANGE},
            )
        )

    for bucket_name, rows in bucket_rows(trades, lambda row: row.get("direction") or "UNKNOWN").items():
        metrics = metrics_for(rows)
        if metrics["trades"] >= MIN_BUCKET_SAMPLE and metrics["expectancy"] < -0.15:
            recommendations.append(
                recommendation(
                    "REVIEW_DIRECTION",
                    confidence(metrics["trades"]),
                    f"Review {bucket_name} VWAP opening-drive entries",
                    f"{bucket_name} has {metrics['trades']} trades and {metrics['expectancy']:.2f}R expectancy.",
                    metrics,
                    {"action": "REVIEW_DIRECTION_FILTERS", "direction": bucket_name},
                )
            )

    for tier, rows in bucket_rows(trades, lambda row: row.get("setup_tier") or "FULL").items():
        metrics = metrics_for(rows)
        if metrics["trades"] < MIN_BUCKET_SAMPLE:
            continue
        if tier == "MANDATORY" and metrics["expectancy"] < -0.15:
            recommendations.append(
                recommendation(
                    "REVIEW_MANDATORY_TIER",
                    confidence(metrics["trades"]),
                    "Review mandatory-only Module 3 entries",
                    f"Mandatory-tier Module 3 trades have {metrics['trades']} results and {metrics['expectancy']:.2f}R expectancy.",
                    metrics,
                    {"action": "REVIEW_SETUP_TIER", "setupTier": tier, "moduleCode": MODULE_CODE},
                )
            )
        if tier == "FULL" and metrics["expectancy"] > 0.2 and metrics["winRate"] >= 0.5:
            recommendations.append(
                recommendation(
                    "FAVOR_FULL_TIER",
                    confidence(metrics["trades"]),
                    "Favor full-checklist Module 3 entries",
                    f"Full-tier Module 3 trades have {metrics['trades']} results, {metrics['winRate']:.1%} win rate, and {metrics['expectancy']:.2f}R expectancy.",
                    metrics,
                    {"action": "PRIORITIZE_SETUP_TIER", "setupTier": tier, "moduleCode": MODULE_CODE},
                )
            )

    for bucket_name, rows in bucket_rows(trades, drive_strength_bucket).items():
        metrics = metrics_for(rows)
        if metrics["trades"] >= MIN_BUCKET_SAMPLE and metrics["expectancy"] > 0.2:
            recommendations.append(
                recommendation(
                    "FAVOR_DRIVE_STRENGTH",
                    confidence(metrics["trades"]),
                    f"Favor {bucket_name} opening drives",
                    f"{bucket_name} has {metrics['trades']} trades, {metrics['winRate']:.1%} win rate, and {metrics['expectancy']:.2f}R expectancy.",
                    metrics,
                    {"action": "PRIORITIZE_DRIVE_BUCKET", "bucket": bucket_name},
                )
            )

    top_failure = failures[0] if failures else None
    if top_failure:
        recommendations.append(
            recommendation(
                "RULE_FAILURE_FOCUS",
                "MEDIUM" if int(top_failure["count"]) >= 5 else "LOW",
                f"Focus Module 3 tuning on {pretty(top_failure['rule_code'])}",
                f"This is the most common failed Module 3 rule in saved evaluations: {top_failure['count']} occurrences.",
                {"ruleCode": top_failure["rule_code"], "count": top_failure["count"], "blocking": top_failure["blocking"]},
                {"action": "REVIEW_RULE", "ruleCode": top_failure["rule_code"]},
            )
        )

    if overall["trades"] >= MIN_SAMPLE_FOR_CHANGE and overall["winRate"] >= 0.55 and overall["expectancy"] > 0.15:
        recommendations.append(
            recommendation(
                "PRODUCTION_READY",
                "HIGH",
                "Current Module 3 logic is eligible for production-style monitoring",
                f"Sample size is {overall['trades']}, win rate is {overall['winRate']:.1%}, and expectancy is {overall['expectancy']:.2f}R.",
                overall,
                {"action": "ALLOW_PROMOTION_REVIEW"},
            )
        )

    return recommendations[:20]


def recommendation(kind: str, conf: str, title: str, rationale: str, metrics: dict[str, Any], action: dict[str, Any]) -> dict[str, Any]:
    return {
        "recommendationType": kind,
        "confidence": conf,
        "title": title,
        "rationale": rationale,
        "metrics": metrics,
        "suggestedAction": action,
    }


def insert_recommendation(cur, run_id, item: dict[str, Any]) -> None:
    cur.execute(
        """
        INSERT INTO module_learning_recommendations (
          learning_run_id, module_code, recommendation_type, confidence,
          title, rationale, metrics, suggested_action
        ) VALUES (%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb)
        """,
        (
            run_id,
            MODULE_CODE,
            item["recommendationType"],
            item["confidence"],
            item["title"],
            item["rationale"],
            json.dumps(item["metrics"], default=str),
            json.dumps(item["suggestedAction"], default=str),
        ),
    )


def metrics_for(rows: list[dict[str, Any]]) -> dict[str, Any]:
    trades = len(rows)
    wins = sum(1 for row in rows if row.get("outcome") == "WIN")
    losses = sum(1 for row in rows if row.get("outcome") == "LOSS")
    breakeven = sum(1 for row in rows if row.get("outcome") == "BREAKEVEN")
    total_r = sum(float(row.get("result_r") or 0) for row in rows)
    return {
        "trades": trades,
        "wins": wins,
        "losses": losses,
        "breakeven": breakeven,
        "winRate": wins / trades if trades else 0,
        "totalR": total_r,
        "expectancy": total_r / trades if trades else 0,
    }


def bucket_rows(rows: list[dict[str, Any]], key_fn) -> dict[str, list[dict[str, Any]]]:
    buckets: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        buckets[str(key_fn(row))].append(row)
    return buckets


def bucket_metrics(rows: list[dict[str, Any]], key_fn) -> dict[str, Any]:
    return {key: metrics_for(value) for key, value in bucket_rows(rows, key_fn).items()}


def drive_strength_bucket(row: dict[str, Any]) -> str:
    flags = row.get("scenario_flags") or {}
    drive = flags.get("drive") or {}
    high = float(drive.get("high") or 0)
    low = float(drive.get("low") or 0)
    if high <= 0 or low <= 0:
        return "UNKNOWN"
    size = high - low
    if size >= 6:
        return "STRONG_DRIVE"
    if size >= 3:
        return "NORMAL_DRIVE"
    return "WEAK_DRIVE"


def pullback_zone_bucket(row: dict[str, Any]) -> str:
    flags = row.get("scenario_flags") or {}
    zone = flags.get("entryZone") or {}
    if not zone:
        return "NO_ZONE"
    width = float(zone.get("high") or 0) - float(zone.get("low") or 0)
    if width <= 0:
        return "INVALID_ZONE"
    if width <= 1:
        return "TIGHT_ZONE"
    if width <= 3:
        return "NORMAL_ZONE"
    return "WIDE_ZONE"


def confidence(sample_size: int) -> str:
    if sample_size >= 50:
        return "HIGH"
    if sample_size >= 20:
        return "MEDIUM"
    return "LOW"


def pretty(value: Any) -> str:
    return str(value or "UNKNOWN").replace("_", " ").title()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database-url", required=True)
    parser.add_argument("--tenant-id", required=True)
    args = parser.parse_args()
    print(json.dumps(run_learning(args.database_url, args.tenant_id), default=str))


if __name__ == "__main__":
    main()
