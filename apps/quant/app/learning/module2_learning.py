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


MODULE_CODE = "high_probability_strategy_2"
MIN_SAMPLE_FOR_CHANGE = 20
MIN_BUCKET_SAMPLE = 3


def run_learning(database_url: str, tenant_id: str, source: str = "MODULE2_PAPER_TRADES") -> dict[str, Any]:
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            run_id = create_run(cur, tenant_id, source)
            try:
                trades = load_module2_trades(cur, tenant_id)
                setup_failures = load_setup_failures(cur, tenant_id)
                recommendations = build_recommendations(trades, setup_failures)
                summary = build_summary(trades, setup_failures, recommendations)
                for recommendation in recommendations:
                    insert_recommendation(cur, run_id, recommendation)
                cur.execute(
                    """
                    UPDATE module_learning_runs
                    SET status = 'COMPLETED', completed_at = now(), sample_size = %s, summary = %s::jsonb
                    WHERE id = %s
                    """,
                    (len(trades), json.dumps(summary), run_id),
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


def load_module2_trades(cur, tenant_id: str) -> list[dict[str, Any]]:
    cur.execute(
        """
        SELECT
          sc.id AS setup_id,
          sc.scenario,
          sc.direction,
          sc.favorability_score,
          sc.favorability_grade,
          sc.scenario_flags,
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


def load_setup_failures(cur, tenant_id: str) -> list[dict[str, Any]]:
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
        "byGrade": bucket_metrics(trades, lambda row: row.get("favorability_grade") or "UNKNOWN"),
        "byDirection": bucket_metrics(trades, lambda row: row.get("direction") or "UNKNOWN"),
        "byLiquidity": bucket_metrics(trades, liquidity_bucket),
        "failureRules": failures[:12],
        "recommendations": len(recommendations),
        "sampleWarning": len(trades) < MIN_SAMPLE_FOR_CHANGE,
    }


def build_recommendations(trades: list[dict[str, Any]], failures: list[dict[str, Any]]) -> list[dict[str, Any]]:
    recommendations: list[dict[str, Any]] = []
    overall = metrics_for(trades)
    if overall["trades"] == 0:
        return [
            recommendation(
                "DATA_REQUIRED",
                "LOW",
                "Collect Module 2 paper-trade outcomes",
                "No completed non-QA Module 2 paper trades were found. Keep paper trading active before changing rules.",
                overall,
                {"action": "COLLECT_RESULTS", "minimumClosedTrades": MIN_SAMPLE_FOR_CHANGE},
            )
        ]
    if overall["trades"] < MIN_SAMPLE_FOR_CHANGE:
        recommendations.append(
            recommendation(
                "DATA_REQUIRED",
                "LOW",
                "Keep learning before promoting rule changes",
                f"Only {overall['trades']} completed Module 2 results are available. Treat recommendations as QA guidance only.",
                overall,
                {"action": "COLLECT_MORE_RESULTS", "minimumClosedTrades": MIN_SAMPLE_FOR_CHANGE},
            )
        )

    for bucket_name, rows in bucket_rows(trades, lambda row: row.get("direction") or "UNKNOWN").items():
        metrics = metrics_for(rows)
        if metrics["trades"] < MIN_BUCKET_SAMPLE:
            continue
        if metrics["expectancy"] > 0.25 and metrics["winRate"] >= 0.5:
            recommendations.append(
                recommendation(
                    "FAVOR_DIRECTION",
                    confidence(metrics["trades"]),
                    f"Favor {bucket_name} setups after checklist pass",
                    f"{bucket_name} has {metrics['trades']} trades, {metrics['winRate']:.1%} win rate, and {metrics['expectancy']:.2f}R expectancy.",
                    metrics,
                    {"action": "PRIORITIZE_DIRECTION", "direction": bucket_name},
                )
            )
        elif metrics["expectancy"] < -0.15:
            recommendations.append(
                recommendation(
                    "REVIEW_DIRECTION",
                    confidence(metrics["trades"]),
                    f"Review {bucket_name} setups",
                    f"{bucket_name} has negative expectancy at {metrics['expectancy']:.2f}R.",
                    metrics,
                    {"action": "REVIEW_DIRECTION_FILTERS", "direction": bucket_name},
                )
            )

    grade_rows = bucket_rows(trades, lambda row: row.get("favorability_grade") or "UNKNOWN")
    for grade, rows in grade_rows.items():
        metrics = metrics_for(rows)
        if metrics["trades"] >= MIN_BUCKET_SAMPLE and grade in {"B", "C", "D"} and metrics["expectancy"] < 0:
            recommendations.append(
                recommendation(
                    "RAISE_QUALITY_THRESHOLD",
                    confidence(metrics["trades"]),
                    f"Keep grade {grade} in QA until performance improves",
                    f"Grade {grade} has {metrics['trades']} trades and {metrics['expectancy']:.2f}R expectancy.",
                    metrics,
                    {"action": "RESTRICT_GRADE", "grade": grade, "minimumGrade": "A"},
                )
            )

    top_failure = failures[0] if failures else None
    if top_failure:
        recommendations.append(
            recommendation(
                "RULE_FAILURE_FOCUS",
                "MEDIUM" if int(top_failure["count"]) >= 5 else "LOW",
                f"Focus tuning on {pretty(top_failure['rule_code'])}",
                f"This is the most common failed rule in saved Module 2 evaluations: {top_failure['count']} occurrences.",
                {"ruleCode": top_failure["rule_code"], "count": top_failure["count"], "blocking": top_failure["blocking"]},
                {"action": "REVIEW_RULE", "ruleCode": top_failure["rule_code"]},
            )
        )

    if overall["trades"] >= MIN_SAMPLE_FOR_CHANGE and overall["winRate"] >= 0.55 and overall["expectancy"] > 0.15:
        recommendations.append(
            recommendation(
                "PRODUCTION_READY",
                "HIGH",
                "Current Module 2 logic is eligible for production-style monitoring",
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
          learning_run_id, module_code, recommendation_type, confidence, title,
          rationale, metrics, suggested_action
        ) VALUES (%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb)
        """,
        (
            run_id,
            MODULE_CODE,
            item["recommendationType"],
            item["confidence"],
            item["title"],
            item["rationale"],
            json.dumps(item["metrics"]),
            json.dumps(item["suggestedAction"]),
        ),
    )


def bucket_metrics(rows: list[dict[str, Any]], key_fn) -> dict[str, dict[str, Any]]:
    return {key: metrics_for(group) for key, group in bucket_rows(rows, key_fn).items()}


def bucket_rows(rows: list[dict[str, Any]], key_fn) -> dict[str, list[dict[str, Any]]]:
    buckets: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        buckets[str(key_fn(row))].append(row)
    return dict(buckets)


def metrics_for(rows: list[dict[str, Any]]) -> dict[str, Any]:
    values = [float(row.get("result_r") or 0) for row in rows]
    wins = [value for value in values if value > 0]
    losses = [value for value in values if value < 0]
    breakeven = [value for value in values if value == 0]
    total = sum(values)
    trades = len(values)
    gross_win = sum(wins)
    gross_loss = abs(sum(losses))
    return {
        "trades": trades,
        "wins": len(wins),
        "losses": len(losses),
        "breakeven": len(breakeven),
        "winRate": len(wins) / trades if trades else 0,
        "totalR": total,
        "expectancy": total / trades if trades else 0,
        "profitFactor": gross_win / gross_loss if gross_loss else None,
    }


def liquidity_bucket(row: dict[str, Any]) -> str:
    flags = row.get("scenario_flags") or {}
    if isinstance(flags, str):
        try:
            flags = json.loads(flags)
        except json.JSONDecodeError:
            flags = {}
    return (((flags.get("sweep") or {}).get("level") or {}).get("type") or "UNKNOWN")


def confidence(sample_size: int) -> str:
    if sample_size >= 30:
        return "HIGH"
    if sample_size >= 10:
        return "MEDIUM"
    return "LOW"


def pretty(value: str) -> str:
    return value.replace("_", " ").title()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database-url", required=True)
    parser.add_argument("--tenant-id", required=True)
    parser.add_argument("--source", default="MODULE2_PAPER_TRADES")
    args = parser.parse_args()
    print(json.dumps(run_learning(args.database_url, args.tenant_id, args.source), default=str))


if __name__ == "__main__":
    main()
