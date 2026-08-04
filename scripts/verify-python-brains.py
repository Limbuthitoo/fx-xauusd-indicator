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
from app.brain.module3_vwap_drive_brain import (  # noqa: E402
    MANDATORY_RULES as MODULE3_MANDATORY,
    QUALITY_RULES as MODULE3_QUALITY,
    decide as decide_module3,
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
        {"mandatoryChecklistMatched": True, "fullChecklistMatched": True, "setupTier": "FULL"},
    ),
    None,
    HEALTH,
)

module3_rules = [
    *MODULE3_MANDATORY,
    "EMA_ALIGNMENT",
    "HTF_15M_BIAS",
    "VWAP_DATA_QUALITY",
    "SIGNAL_SCORE",
    *MODULE3_QUALITY[:3],
]
module3 = decide_module3(
    setup(
        "strategy_lab_3",
        "LONG",
        module3_rules,
        {"mandatoryChecklistMatched": True, "fullChecklistMatched": True, "setupTier": "FULL"},
    ),
    None,
    HEALTH,
)

module2_incomplete = decide_module2(
    setup("high_probability_strategy_2", "SHORT", MODULE2_MANDATORY[:-1], {}),
    None,
    HEALTH,
)
module3_proxy_only = decide_module3(
    setup("strategy_lab_3", "LONG", [*MODULE3_MANDATORY, "SIGNAL_SCORE", *MODULE3_QUALITY[:3]], {"mandatoryChecklistMatched": True}),
    None,
    HEALTH,
)

assert module1["shouldOpenPaperTrade"] and module1["action"] == "BUY"
assert module2["shouldOpenPaperTrade"] and module2["action"] == "SELL"
assert module2["checklist"]["mandatoryPassed"] and module2["checklist"]["fullPassed"]
assert module3["shouldOpenPaperTrade"] and module3["action"] == "BUY"
assert module3["checklist"]["mandatoryPassed"] and module3["checklist"]["fullPassed"]
assert not module2_incomplete["shouldOpenPaperTrade"]
assert module3_proxy_only["shouldOpenPaperTrade"]
assert not module3_proxy_only["checklist"]["fullPassed"]

print(
    json.dumps(
        {
            "status": "PASS",
            "module1": module1["decisionType"],
            "module2": module2["decisionType"],
            "module3": module3["decisionType"],
            "negativeChecks": [module2_incomplete["decisionType"], module3_proxy_only["decisionType"]],
        },
        indent=2,
    )
)
