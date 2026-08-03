from __future__ import annotations

import argparse
import json
import os
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

try:
    import psycopg
    from psycopg.rows import dict_row
except ImportError as exc:  # pragma: no cover - helpful runtime message
    raise SystemExit("Missing dependency: install apps/quant/requirements.txt so psycopg is available.") from exc


MIN_TRADES_FOR_CONFIDENCE = 10
MIN_TRADES_FOR_DIRECTIONAL_HINT = 5
MODULE_CODE = "orb_max_options"


@dataclass
class Recommendation:
    recommendation_type: str
    scenario: str | None
    direction: str | None
    confidence: str
    title: str
    rationale: str
    metrics: dict[str, Any]
    suggested_action: dict[str, Any]


def run_learning(database_url: str, source: str = "PAPER_AND_BACKTEST") -> dict[str, Any]:
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            run_id = create_run(cur, source)
            try:
                rows = load_results(cur)
                recommendations = build_recommendations(rows)
                for item in recommendations:
                    insert_recommendation(cur, run_id, item)
                summary = build_summary(rows, recommendations)
                cur.execute(
                    """
                    UPDATE orb_learning_runs
                    SET status = 'COMPLETED', completed_at = now(), sample_size = %s, summary = %s::jsonb
                    WHERE id = %s
                    """,
                    (len(rows), json.dumps(summary), run_id),
                )
                conn.commit()
                return {"runId": str(run_id), "status": "COMPLETED", "sampleSize": len(rows), "recommendations": len(recommendations), "summary": summary}
            except Exception as exc:
                cur.execute(
                    """
                    UPDATE orb_learning_runs
                    SET status = 'FAILED', completed_at = now(), summary = %s::jsonb
                    WHERE id = %s
                    """,
                    (json.dumps({"error": str(exc)}), run_id),
                )
                conn.commit()
                raise


def create_run(cur, source: str):
    cur.execute(
        "INSERT INTO orb_learning_runs (source, status) VALUES (%s, 'RUNNING') RETURNING id",
        (source,),
    )
    return cur.fetchone()["id"]


def load_results(cur) -> list[dict[str, Any]]:
    cur.execute(
        """
        SELECT
          'PAPER' AS source,
          sc.scenario,
          sc.direction,
          sc.favorability_score,
          sc.favorability_grade,
          COALESCE(sc.scenario_flags->>'setupTier', 'FULL') AS setup_tier,
          t.outcome,
          t.result_r::float AS result_r,
          t.opened_at AS occurred_at
        FROM trades t
        JOIN trade_plans tp ON tp.id = t.trade_plan_id
        JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
        WHERE t.outcome IN ('WIN', 'LOSS', 'BREAKEVEN')
          AND sc.module_code = %s
          AND sc.scenario <> 'QA_TEST_SIGNAL'
          AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'
        UNION ALL
        SELECT
          'BACKTEST' AS source,
          bt.scenario,
          bt.direction,
          NULL AS favorability_score,
          NULL AS favorability_grade,
          'BACKTEST' AS setup_tier,
          bt.outcome,
          bt.result_r::float AS result_r,
          br.completed_at AS occurred_at
        FROM backtest_trades bt
        JOIN backtest_runs br ON br.id = bt.backtest_run_id
        WHERE bt.outcome IN ('WIN', 'LOSS', 'BREAKEVEN')
          AND COALESCE(br.module_code, %s) = %s
        ORDER BY occurred_at NULLS LAST
        """,
        (MODULE_CODE, MODULE_CODE, MODULE_CODE),
    )
    return list(cur.fetchall())


def build_recommendations(rows: list[dict[str, Any]]) -> list[Recommendation]:
    recommendations: list[Recommendation] = []
    overall = metrics_for(rows)
    if overall["trades"] == 0:
        return [
            Recommendation(
                recommendation_type="DATA_REQUIRED",
                scenario=None,
                direction=None,
                confidence="LOW",
                title="Collect more paper-trade results",
                rationale="No closed ORB paper trades or backtest trades were found. The system needs completed outcomes before it can learn useful filters.",
                metrics=overall,
                suggested_action={"action": "KEEP_PAPER_TRADING", "minimumClosedTrades": MIN_TRADES_FOR_CONFIDENCE},
            )
        ]

    if overall["trades"] < MIN_TRADES_FOR_CONFIDENCE:
        recommendations.append(
            Recommendation(
                recommendation_type="DATA_REQUIRED",
                scenario=None,
                direction=None,
                confidence="LOW",
                title="Keep learning before changing rules",
                rationale=f"Only {overall['trades']} completed results are available. Treat current performance as early evidence, not a final strategy conclusion.",
                metrics=overall,
                suggested_action={"action": "COLLECT_MORE_RESULTS", "minimumClosedTrades": MIN_TRADES_FOR_CONFIDENCE},
            )
        )

    grouped: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[(row.get("scenario") or "UNKNOWN", row.get("direction") or "UNKNOWN", row.get("setup_tier") or "FULL")].append(row)

    for (scenario, direction, setup_tier), group in sorted(grouped.items()):
        metrics = metrics_for(group)
        if metrics["trades"] < MIN_TRADES_FOR_DIRECTIONAL_HINT:
            continue

        if metrics["expectancy"] > 0.25 and metrics["win_rate"] >= 0.5:
            recommendations.append(
                Recommendation(
                    recommendation_type="FAVOR",
                    scenario=scenario,
                    direction=direction,
                    confidence=confidence_for(metrics["trades"]),
                    title=f"Favor {direction} {pretty(scenario)} ({setup_tier})",
                    rationale=f"This scenario/direction/tier has {metrics['trades']} results, {metrics['win_rate']:.1%} win rate, and {metrics['expectancy']:.2f}R expectancy.",
                    metrics=metrics,
                    suggested_action={"action": "PRIORITIZE_SCENARIO", "scenario": scenario, "direction": direction, "setupTier": setup_tier},
                )
            )
        elif metrics["expectancy"] < -0.15 or metrics["win_rate"] < 0.35:
            recommendations.append(
                Recommendation(
                    recommendation_type="AVOID_OR_REVIEW",
                    scenario=scenario,
                    direction=direction,
                    confidence=confidence_for(metrics["trades"]),
                    title=f"Review {direction} {pretty(scenario)} ({setup_tier})",
                    rationale=f"This scenario/direction/tier has weak evidence: {metrics['win_rate']:.1%} win rate and {metrics['expectancy']:.2f}R expectancy.",
                    metrics=metrics,
                    suggested_action={"action": "REVIEW_FILTERS", "scenario": scenario, "direction": direction, "setupTier": setup_tier},
                )
            )

    return recommendations[:20]


def metrics_for(rows: list[dict[str, Any]]) -> dict[str, Any]:
    values = [float(row.get("result_r") or 0) for row in rows]
    wins = [value for value in values if value > 0]
    losses = [value for value in values if value < 0]
    breakeven = [value for value in values if value == 0]
    total = sum(values)
    equity = 0.0
    high = 0.0
    max_drawdown = 0.0
    for value in values:
        equity += value
        high = max(high, equity)
        max_drawdown = min(max_drawdown, equity - high)
    gross_win = sum(wins)
    gross_loss = abs(sum(losses))
    trades = len(values)
    return {
        "trades": trades,
        "wins": len(wins),
        "losses": len(losses),
        "breakeven": len(breakeven),
        "win_rate": len(wins) / trades if trades else 0,
        "total_r": total,
        "expectancy": total / trades if trades else 0,
        "profit_factor": gross_win / gross_loss if gross_loss else None,
        "maximum_drawdown_r": max_drawdown,
    }


def build_summary(rows: list[dict[str, Any]], recommendations: list[Recommendation]) -> dict[str, Any]:
    by_source: dict[str, int] = defaultdict(int)
    by_setup_tier: dict[str, int] = defaultdict(int)
    for row in rows:
        by_source[row.get("source") or "UNKNOWN"] += 1
        by_setup_tier[row.get("setup_tier") or "FULL"] += 1
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "overall": metrics_for(rows),
        "bySource": dict(by_source),
        "bySetupTier": dict(by_setup_tier),
        "recommendations": len(recommendations),
    }


def insert_recommendation(cur, run_id, item: Recommendation) -> None:
    cur.execute(
        """
        INSERT INTO orb_learning_recommendations (
          learning_run_id, recommendation_type, scenario, direction, confidence,
          title, rationale, metrics, suggested_action
        ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb)
        """,
        (
            run_id,
            item.recommendation_type,
            item.scenario,
            item.direction,
            item.confidence,
            item.title,
            item.rationale,
            json.dumps(item.metrics),
            json.dumps(item.suggested_action),
        ),
    )


def confidence_for(trades: int) -> str:
    if trades >= 30:
        return "HIGH"
    if trades >= MIN_TRADES_FOR_CONFIDENCE:
        return "MEDIUM"
    return "LOW"


def pretty(value: str) -> str:
    return value.replace("_", " ").title()


def main() -> None:
    parser = argparse.ArgumentParser(description="Learn from ORB paper/backtest results and write recommendations to PostgreSQL.")
    parser.add_argument("--database-url", default=os.getenv("DATABASE_URL"))
    parser.add_argument("--source", default="PAPER_AND_BACKTEST")
    args = parser.parse_args()
    if not args.database_url:
        raise SystemExit("DATABASE_URL is required.")
    print(json.dumps(run_learning(args.database_url, args.source), indent=2))


if __name__ == "__main__":
    main()
