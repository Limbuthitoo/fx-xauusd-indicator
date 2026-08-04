from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from typing import Any

try:
    import psycopg
    from psycopg.rows import dict_row
except ImportError as exc:  # pragma: no cover
    raise SystemExit("Missing dependency: install apps/quant/requirements.txt so psycopg is available.") from exc

from .indicator_playbook import indicator_summary, playbook_for


MODULES = ("high_probability_strategy_2", "strategy_lab_3")


def run_indicator_audit(database_url: str, tenant_id: str, module_code: str | None = None) -> dict[str, Any]:
    modules = [module_code] if module_code else list(MODULES)
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            return {
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "tenantId": tenant_id,
                "modules": [audit_module(cur, tenant_id, code) for code in modules],
            }


def audit_module(cur, tenant_id: str, module_code: str) -> dict[str, Any]:
    evaluations = load_evaluations(cur, tenant_id, module_code)
    setups = load_latest_setups(cur, tenant_id, module_code)
    backtest_trades = load_latest_backtest_trades(cur, tenant_id, module_code)
    overlays = [overlay_from_setup(setup) for setup in setups]
    return {
        "moduleCode": module_code,
        "playbook": playbook_for(module_code),
        "indicatorSummary": indicator_summary(module_code, evaluations),
        "latestSetups": [setup_snapshot(setup) for setup in setups],
        "latestBacktestTrades": [backtest_snapshot(row) for row in backtest_trades],
        "chartOverlays": overlays,
        "treatmentRules": treatment_rules(module_code),
    }


def load_evaluations(cur, tenant_id: str, module_code: str) -> list[dict[str, Any]]:
    cur.execute(
        """
        SELECT
          sre.rule_code,
          sre.name,
          sre.status,
          sre.blocking,
          max(sre.explanation) AS explanation,
          count(*)::int AS count
        FROM setup_rule_evaluations sre
        JOIN setup_candidates sc ON sc.id = sre.setup_candidate_id
        WHERE sc.tenant_id = %s
          AND sc.module_code = %s
          AND sc.status <> 'TEST_CLEARED'
          AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'
        GROUP BY sre.rule_code, sre.name, sre.status, sre.blocking
        ORDER BY sre.rule_code, count(*) DESC
        """,
        (tenant_id, module_code),
    )
    return list(cur.fetchall())


def load_latest_setups(cur, tenant_id: str, module_code: str) -> list[dict[str, Any]]:
    cur.execute(
        """
        SELECT id, scenario, direction, status, detected_at, entry_price, stop_price,
               target_price, final_reason, favorability_score, favorability_grade,
               scenario_flags
        FROM setup_candidates
        WHERE tenant_id = %s
          AND module_code = %s
          AND scenario <> 'QA_TEST_SIGNAL'
          AND COALESCE(scenario_flags->>'replay', 'false') <> 'true'
        ORDER BY detected_at DESC
        LIMIT 25
        """,
        (tenant_id, module_code),
    )
    return list(cur.fetchall())


def load_latest_backtest_trades(cur, tenant_id: str, module_code: str) -> list[dict[str, Any]]:
    cur.execute(
        """
        SELECT bt.session_date, bt.scenario, bt.direction, bt.entry_price, bt.stop_price,
               bt.target_price, bt.result_r, bt.outcome, bt.details
        FROM backtest_trades bt
        JOIN backtest_runs br ON br.id = bt.backtest_run_id
        WHERE br.tenant_id = %s
          AND COALESCE(br.module_code, br.parameters->>'moduleCode') = %s
        ORDER BY br.completed_at DESC NULLS LAST, bt.session_date DESC
        LIMIT 25
        """,
        (tenant_id, module_code),
    )
    return list(cur.fetchall())


def overlay_from_setup(setup: dict[str, Any]) -> dict[str, Any]:
    flags = setup.get("scenario_flags") or {}
    if isinstance(flags, str):
        flags = json.loads(flags)
    module_code = "strategy_lab_3" if "drive" in flags else "high_probability_strategy_2"
    if module_code == "strategy_lab_3":
        zone = flags.get("entryZone") or {}
        drive = flags.get("drive") or {}
        return {
            "setupId": str(setup["id"]),
            "moduleCode": module_code,
            "signal": setup.get("direction"),
            "levels": compact_levels(
                [
                    level("VWAP", flags.get("vwap"), "vwap"),
                    level("EMA", flags.get("ema"), "ema"),
                    level("Entry", setup.get("entry_price"), "entry"),
                    level("Stop", setup.get("stop_price"), "stop"),
                    level("Target", setup.get("target_price"), "target"),
                ]
            ),
            "boxes": compact_boxes([box("Opening Drive", drive.get("low"), drive.get("high"), drive.get("start", {}).get("timestampUtc"), drive.get("end", {}).get("timestampUtc")), box("VWAP Pullback Zone", zone.get("low"), zone.get("high"), None, setup.get("detected_at"))]),
        }
    sweep = flags.get("sweep") or {}
    displacement = flags.get("displacement") or {}
    bos = flags.get("bos") or {}
    zone = flags.get("entryZone") or {}
    return {
        "setupId": str(setup["id"]),
        "moduleCode": "high_probability_strategy_2",
        "signal": setup.get("direction"),
        "levels": compact_levels(
            [
                level(f"Liquidity {((sweep.get('level') or {}).get('type') or '').strip()}", (sweep.get("level") or {}).get("price"), "liquidity"),
                level("BOS / CHoCH", bos.get("level"), "bos"),
                level("Entry", setup.get("entry_price"), "entry"),
                level("Stop", setup.get("stop_price"), "stop"),
                level("Target", setup.get("target_price"), "target"),
            ]
        ),
        "boxes": compact_boxes(
            [
                box("Sweep zone", (sweep.get("level") or {}).get("price"), (sweep.get("level") or {}).get("price"), sweep.get("sweptAt"), sweep.get("closedBackAt")),
                box("Displacement candle", (displacement.get("candle") or {}).get("low"), (displacement.get("candle") or {}).get("high"), (displacement.get("candle") or {}).get("timestampUtc"), (displacement.get("candle") or {}).get("timestampUtc")),
                box("FVG / Order Block", zone.get("low"), zone.get("high"), zone.get("createdAt"), setup.get("detected_at")),
            ]
        ),
    }


def setup_snapshot(setup: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(setup["id"]),
        "scenario": setup.get("scenario"),
        "direction": setup.get("direction"),
        "status": setup.get("status"),
        "detectedAt": iso(setup.get("detected_at")),
        "entry": number(setup.get("entry_price")),
        "stop": number(setup.get("stop_price")),
        "target": number(setup.get("target_price")),
        "score": number(setup.get("favorability_score")),
        "grade": setup.get("favorability_grade"),
        "reason": setup.get("final_reason"),
    }


def backtest_snapshot(row: dict[str, Any]) -> dict[str, Any]:
    details = row.get("details") or {}
    return {
        "sessionDate": str(row.get("session_date")),
        "scenario": row.get("scenario"),
        "direction": row.get("direction"),
        "entry": number(row.get("entry_price")),
        "stop": number(row.get("stop_price")),
        "target": number(row.get("target_price")),
        "resultR": number(row.get("result_r")),
        "outcome": row.get("outcome"),
        "instruction": details.get("instruction"),
    }


def treatment_rules(module_code: str) -> list[str]:
    if module_code == "high_probability_strategy_2":
        return [
            "Do not trade a liquidity sweep unless price closes back inside the swept level.",
            "Displacement must show body commitment after the sweep; overlapping chop stays watch-only.",
            "BOS/CHoCH must be a candle-close break beyond a valid swing, not a wick-only break.",
            "Use fresh FVG/order-block retrace for entry definition; avoid chasing far from the zone.",
            "Mandatory setup can open a small paper trade; full confirmation upgrades confidence.",
        ]
    if module_code == "strategy_lab_3":
        return [
            "Do not enter before the opening-drive window completes.",
            "The drive must have real range/body expansion before VWAP pullback logic is valid.",
            "VWAP side and pullback-zone touch are mandatory; EMA is confirmation.",
            "Confirmation candle must leave the pullback zone in the drive direction.",
            "Mandatory setup can open a small paper trade; full confirmation upgrades confidence.",
        ]
    return []


def level(label: str, price: Any, tone: str) -> dict[str, Any] | None:
    value = number(price)
    if value is None:
        return None
    return {"label": label, "price": value, "tone": tone}


def box(label: str, low: Any, high: Any, start: Any, end: Any) -> dict[str, Any] | None:
    low_value = number(low)
    high_value = number(high)
    if low_value is None or high_value is None:
        return None
    return {"label": label, "low": min(low_value, high_value), "high": max(low_value, high_value), "start": iso(start), "end": iso(end)}


def compact_levels(rows: list[dict[str, Any] | None]) -> list[dict[str, Any]]:
    return [row for row in rows if row is not None]


def compact_boxes(rows: list[dict[str, Any] | None]) -> list[dict[str, Any]]:
    return [row for row in rows if row is not None]


def number(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return round(float(value), 5)
    except (TypeError, ValueError):
        return None


def iso(value: Any) -> str | None:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database-url", required=True)
    parser.add_argument("--tenant-id", required=True)
    parser.add_argument("--module-code", choices=MODULES)
    args = parser.parse_args()
    print(json.dumps(run_indicator_audit(args.database_url, args.tenant_id, args.module_code), default=str))


if __name__ == "__main__":
    main()
