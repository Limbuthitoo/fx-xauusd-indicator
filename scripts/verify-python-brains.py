#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "quant"))

from app.brain.module1_orb_brain import decide as decide_module1  # noqa: E402
from app.brain.module2_sweep_bos_brain import (  # noqa: E402
    CONFIRMATION_RULES as MODULE2_CONFIRMATIONS,
    MANDATORY_RULES as MODULE2_MANDATORY,
    QUALITY_RULES as MODULE2_QUALITY,
    decide as decide_module2,
)


HEALTH = {"status": "LIVE"}


def evaluations(codes: list[str]) -> list[dict[str, object]]:
    return [
        {"rule_code": code, "name": code.replace("_", " ").title(), "status": "PASS", "blocking": True}
        for code in codes
    ]


def setup(module_code: str, direction: str, rules: list[str], flags: dict[str, object]) -> dict[str, object]:
    return {
        "id": f"{module_code}-setup",
        "module_code": module_code,
        "scenario": "DETERMINISTIC_CONTRACT_TEST",
        "direction": direction,
        "status": "LONG SETUP READY" if direction == "LONG" else "SHORT SETUP READY",
        "entry_price": 4050.0,
        "stop_price": 4045.0 if direction == "LONG" else 4055.0,
        "target_price": 4060.0 if direction == "LONG" else 4040.0,
        "favorability_score": 90,
        "favorability_grade": "A",
        "scenario_flags": flags,
        "evaluations": evaluations(rules),
        "trade_id": None,
    }


module1_rules = [
    "ORB_LOCKED",
    "INSIDE_SIGNAL_WINDOW",
    "ENTRY_NOT_OVEREXTENDED",
    "RISK_PERMISSION",
    "CLOSE_ABOVE_ORB_HIGH",
]
module1 = decide_module1(
    setup("orb_max_options", "LONG", module1_rules, {"mandatoryChecklistMatched": True, "setupTier": "FULL"}),
    None,
    HEALTH,
)

module1_horizontal_rules = [
    "HORIZONTAL_RANGE_LOCKED",
    "HORIZONTAL_BREAKOUT_CONFIRMED",
    "HORIZONTAL_RETEST_CONFIRMED",
    "HORIZONTAL_CONFLICT_CLEAR",
    "ENTRY_NOT_OVEREXTENDED",
    "RISK_PERMISSION",
]
module1_horizontal = decide_module1(
    {
        **setup(
            "orb_max_options",
            "SHORT",
            module1_horizontal_rules,
            {"mandatoryChecklistMatched": True, "setupTier": "HORIZONTAL", "horizontalRangeSignal": True},
        ),
        "scenario": "HORIZONTAL_RANGE_BREAKOUT_SELL",
    },
    None,
    HEALTH,
)

module2_rules = [
    *MODULE2_MANDATORY,
    *[code for code in MODULE2_CONFIRMATIONS if code != "CONFIRMATION_COUNT"][:3],
    *[code for code in MODULE2_QUALITY if code != "QUALITY_FILTER_COUNT"][:3],
]
module2 = decide_module2(
    setup(
        "high_probability_strategy_2",
        "SHORT",
        module2_rules,
        {
            "mandatoryChecklistMatched": True,
            "fullChecklistMatched": True,
            "setupTier": "FULL",
            "module2Variant": {
                "code": "SWEEP_MSS_RETEST",
                "name": "F. Sweep + MSS + Retest",
                "paperEligible": True,
                "approvalStatus": "PRODUCTION_APPROVED",
            },
        },
    ),
    None,
    HEALTH,
)

module2_flexible_variant = decide_module2(
    setup(
        "high_probability_strategy_2",
        "LONG",
        [
            "DATA_HEALTHY",
            "ACTIVE_SETUP_CONFLICT_CLEAR",
            "NO_ACTIVE_TRADE_CONFLICT",
            "RISK_LIMITS_CLEAR",
            "MANUAL_CONFIRMATION_COMPLETED",
            "LIQUIDITY_LEVEL_IDENTIFIED",
            "LIQUIDITY_SWEEP_CONFIRMED",
            "SWEEP_REJECTION_CONFIRMED",
            "SWEEP_ACCEPTANCE_BLOCK",
            "RISK_OK",
            "SIGNAL_SCORE",
            "VARIANT_SELECTED",
        ],
        {
            "mandatoryChecklistMatched": True,
            "fullChecklistMatched": False,
            "setupTier": "MANDATORY",
            "module2Variant": {
                "code": "SWEEP_CLOSE_BACK_INSIDE",
                "name": "A. Sweep + Close Back Inside",
                "paperEligible": True,
                "approvalStatus": "PAPER_APPROVED",
            },
        },
    ),
    None,
    HEALTH,
)

module2_signal_without_paper_slot = decide_module2(
    setup(
        "high_probability_strategy_2",
        "LONG",
        module2_rules,
        {
            "mandatoryChecklistMatched": True,
            "fullChecklistMatched": True,
            "paperTrackingEligible": False,
            "paperTrackingBlockers": ["NO_ACTIVE_TRADE_CONFLICT"],
            "setupTier": "FULL",
            "module2Variant": {
                "code": "SWEEP_MSS_RETEST",
                "name": "F. Sweep + MSS + Retest",
                "paperEligible": True,
                "approvalStatus": "PRODUCTION_APPROVED",
            },
        },
    ),
    None,
    HEALTH,
)

module2_incomplete = decide_module2(
    setup("high_probability_strategy_2", "SHORT", MODULE2_MANDATORY[:-1], {"mandatoryChecklistMatched": True, "fullChecklistMatched": True}),
    None,
    HEALTH,
)
module1_incomplete = decide_module1(
    setup("orb_max_options", "LONG", module1_rules[:-1], {"mandatoryChecklistMatched": True, "setupTier": "FULL"}),
    None,
    HEALTH,
)
legacy_active = decide_module1(
    setup("orb_max_options", "LONG", module1_rules[:-1], {"mandatoryChecklistMatched": True}),
    {"id": "legacy-trade", "outcome": "ACTIVE", "direction": "LONG"},
    HEALTH,
)

assert module1["shouldEmitSignal"] and module1["shouldTrackPaperTrade"] and module1["action"] == "BUY"
assert module1_horizontal["shouldEmitSignal"] and module1_horizontal["shouldTrackPaperTrade"] and module1_horizontal["action"] == "SELL"
assert module1_horizontal["checklist"]["horizontalMandatoryPassed"]
assert module2["shouldEmitSignal"] and module2["shouldTrackPaperTrade"] and module2["action"] == "SELL"
assert module2_flexible_variant["shouldEmitSignal"] and module2_flexible_variant["shouldTrackPaperTrade"] and module2_flexible_variant["action"] == "BUY"
assert module2_signal_without_paper_slot["shouldEmitSignal"] and not module2_signal_without_paper_slot["shouldTrackPaperTrade"]
assert module2_flexible_variant["decisionType"] == "LIQUIDITY_SWEEP_VARIANT_SIGNAL_READY"
assert module2["checklist"]["mandatoryPassed"] and module2["checklist"]["fullPassed"]
assert not module1_incomplete["shouldEmitSignal"] and not module1_incomplete["shouldTrackPaperTrade"]
assert not module2_incomplete["shouldEmitSignal"] and not module2_incomplete["shouldTrackPaperTrade"]
assert legacy_active["decisionType"] == "ACTIVE_TRADE_CHECKLIST_MISMATCH"

print(
    json.dumps(
        {
            "status": "PASS",
            "module1": module1["decisionType"],
            "module1Horizontal": module1_horizontal["decisionType"],
            "module2": module2["decisionType"],
            "module2FlexibleVariant": module2_flexible_variant["decisionType"],
            "module2SignalWithoutPaperSlot": module2_signal_without_paper_slot["decisionType"],
            "mvpPriority": module2["mvpPriority"],
            "negativeChecks": [module1_incomplete["decisionType"], module2_incomplete["decisionType"], legacy_active["decisionType"]],
        },
        indent=2,
    )
)
