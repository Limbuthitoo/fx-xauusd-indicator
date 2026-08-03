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


MIN_SAMPLE_FOR_CHANGE = 20
MIN_BUCKET_SAMPLE = 3


def run_learning(database_url: str, tenant_id: str, module_code: str, source: str | None = None) -> dict[str, Any]:
    learning_source = source or f"{module_code.upper()}_PAPER_TRADES"
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            module_name = load_module_name(cur, module_code)
            run_id = create_run(cur, tenant_id, module_code, learning_source)
            try:
                trades = load_trades(cur, tenant_id, module_code)
                failures = load_failures(cur, tenant_id, module_code)
                recommendations = build_recommendations(module_code, module_name, trades, failures)
                summary = build_summary(module_code, module_name, trades, failures, recommendations)
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
                conn.commit()
                return {
                    "runId": str(run_id),
                    "status": "COMPLETED",
                    "moduleCode": module_code,
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
                conn.commit()
                raise


def load_module_name(cur, module_code: str) -> str:
    cur.execute("SELECT name FROM platform_strategy_modules WHERE code = %s LIMIT 1", (module_code,))
    row = cur.fetchone()
    return row["name"] if row else pretty(module_code)


def create_run(cur, tenant_id: str, module_code: str, source: str):
    cur.execute(
        """
        INSERT INTO module_learning_runs (tenant_id, module_code, source, status)
        VALUES (%s, %s, %s, 'RUNNING')
        RETURNING id
        """,
        (tenant_id, module_code, source),
    )
    return cur.fetchone()["id"]


def load_trades(cur, tenant_id: str, module_code: str) -> list[dict[str, Any]]:
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
        (tenant_id, module_code),
    )
    return list(cur.fetchall())


def load_failures(cur, tenant_id: str, module_code: str) -> list[dict[str, Any]]:
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
        (tenant_id, module_code),
    )
    return list(cur.fetchall())


def build_summary(
    module_code: str,
    module_name: str,
    trades: list[dict[str, Any]],
    failures: list[dict[str, Any]],
    recommendations: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "moduleCode": module_code,
        "moduleName": module_name,
        "overall": metrics_for(trades),
        "bySetupTier": bucket_metrics(trades, lambda row: row.get("setup_tier") or "FULL"),
        "byGrade": bucket_metrics(trades, lambda row: row.get("favorability_grade") or "UNKNOWN"),
        "byDirection": bucket_metrics(trades, lambda row: row.get("direction") or "UNKNOWN"),
        "byScenario": bucket_metrics(trades, lambda row: row.get("scenario") or "UNKNOWN"),
        "failureRules": failures[:12],
        "recommendations": len(recommendations),
        "sampleWarning": len(trades) < MIN_SAMPLE_FOR_CHANGE,
    }


def build_recommendations(
    module_code: str,
    module_name: str,
    trades: list[dict[str, Any]],
    failures: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    recommendations: list[dict[str, Any]] = []
    overall = metrics_for(trades)
    if overall["trades"] == 0:
        return [
            recommendation(
                "DATA_REQUIRED",
                "LOW",
                f"Collect {module_name} paper-trade outcomes",
                f"No completed non-QA paper trades were found for {module_name}. Keep paper trading active before changing strategy rules.",
                overall,
                {"action": "COLLECT_RESULTS", "moduleCode": module_code, "minimumClosedTrades": MIN_SAMPLE_FOR_CHANGE},
            )
        ]

    if overall["trades"] < MIN_SAMPLE_FOR_CHANGE:
        recommendations.append(
            recommendation(
                "DATA_REQUIRED",
                "LOW",
                f"Keep {module_name} in learning mode",
                f"Only {overall['trades']} completed results are available for {module_name}. Treat recommendations as QA guidance only.",
                overall,
                {"action": "COLLECT_MORE_RESULTS", "moduleCode": module_code, "minimumClosedTrades": MIN_SAMPLE_FOR_CHANGE},
            )
        )

    recommendations.extend(analyze_bucket(module_code, "SETUP_TIER", "setupTier", trades, lambda row: row.get("setup_tier") or "FULL"))
    recommendations.extend(analyze_bucket(module_code, "DIRECTION", "direction", trades, lambda row: row.get("direction") or "UNKNOWN"))
    recommendations.extend(analyze_bucket(module_code, "GRADE", "grade", trades, lambda row: row.get("favorability_grade") or "UNKNOWN"))
    recommendations.extend(analyze_bucket(module_code, "SCENARIO", "scenario", trades, lambda row: row.get("scenario") or "UNKNOWN"))

    top_failure = failures[0] if failures else None
    if top_failure:
        recommendations.append(
            recommendation(
                "RULE_FAILURE_FOCUS",
                "MEDIUM" if int(top_failure["count"]) >= 5 else "LOW",
                f"Focus {module_name} tuning on {pretty(top_failure['rule_code'])}",
                f"This is the most common failed checklist rule for {module_name}: {top_failure['count']} occurrences.",
                {"ruleCode": top_failure["rule_code"], "count": top_failure["count"], "blocking": top_failure["blocking"]},
                {"action": "REVIEW_RULE", "moduleCode": module_code, "ruleCode": top_failure["rule_code"]},
            )
        )

    if overall["trades"] >= MIN_SAMPLE_FOR_CHANGE and overall["winRate"] >= 0.55 and overall["expectancy"] > 0.15:
        recommendations.append(
            recommendation(
                "PRODUCTION_READY",
                "HIGH",
                f"{module_name} is eligible for production-style monitoring",
                f"Sample size is {overall['trades']}, win rate is {overall['winRate']:.1%}, and expectancy is {overall['expectancy']:.2f}R.",
                overall,
                {"action": "ALLOW_PROMOTION_REVIEW", "moduleCode": module_code},
            )
        )

    return recommendations[:20]


def analyze_bucket(module_code: str, category: str, action_key: str, trades: list[dict[str, Any]], key_fn) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for bucket, rows in bucket_rows(trades, key_fn).items():
        metrics = metrics_for(rows)
        if metrics["trades"] < MIN_BUCKET_SAMPLE:
            continue
        action_payload = {"moduleCode": module_code, action_key: bucket}
        if metrics["expectancy"] > 0.2 and metrics["winRate"] >= 0.5:
            items.append(
                recommendation(
                    f"FAVOR_{category}",
                    confidence(metrics["trades"]),
                    f"Favor {pretty(bucket)} {pretty(category)}",
                    f"{pretty(bucket)} has {metrics['trades']} trades, {metrics['winRate']:.1%} win rate, and {metrics['expectancy']:.2f}R expectancy.",
                    metrics,
                    {"action": f"PRIORITIZE_{category}", **action_payload},
                )
            )
        elif metrics["expectancy"] < -0.15:
            items.append(
                recommendation(
                    f"REVIEW_{category}",
                    confidence(metrics["trades"]),
                    f"Review {pretty(bucket)} {pretty(category)}",
                    f"{pretty(bucket)} has {metrics['trades']} trades and {metrics['expectancy']:.2f}R expectancy.",
                    metrics,
                    {"action": f"REVIEW_{category}", **action_payload},
                )
            )
    return items


def recommendation(kind: str, conf: str, title: str, rationale: str, metrics: dict[str, Any], action: dict[str, Any]) -> dict[str, Any]:
    return {
        "recommendationType": kind,
        "confidence": conf,
        "title": title,
        "rationale": rationale,
        "metrics": metrics,
        "suggestedAction": action,
    }


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


def bucket_rows(rows: list[dict[str, Any]], key_fn) -> dict[str, list[dict[str, Any]]]:
    buckets: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        buckets[str(key_fn(row))].append(row)
    return dict(buckets)


def bucket_metrics(rows: list[dict[str, Any]], key_fn) -> dict[str, dict[str, Any]]:
    return {key: metrics_for(group) for key, group in bucket_rows(rows, key_fn).items()}


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


def confidence(sample_size: int) -> str:
    if sample_size >= 30:
        return "HIGH"
    if sample_size >= 10:
        return "MEDIUM"
    return "LOW"


def pretty(value: str) -> str:
    return value.replace("_", " ").title()


def main() -> None:
    parser = argparse.ArgumentParser(description="Generic learning automation for any strategy module using paper-trade outcomes.")
    parser.add_argument("--database-url", required=True)
    parser.add_argument("--tenant-id", required=True)
    parser.add_argument("--module-code", required=True)
    parser.add_argument("--source", default=None)
    args = parser.parse_args()
    print(json.dumps(run_learning(args.database_url, args.tenant_id, args.module_code, args.source), default=str))


if __name__ == "__main__":
    main()
