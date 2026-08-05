from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any


MODULE2_RULES: dict[str, dict[str, str]] = {
    "NY_SESSION_ACTIVE": {
        "indicator": "New York session",
        "meaning": "Only evaluate entries inside the configured NY trading window.",
        "treatment": "Hard gate. Outside the session means no paper entry.",
    },
    "LIQUIDITY_LEVEL_IDENTIFIED": {
        "indicator": "Liquidity level",
        "meaning": "A previous high/low, Asian/London high/low, or equal high/low where stops may be resting.",
        "treatment": "Hard gate. Without a meaningful level, a sweep has no useful reference.",
    },
    "LIQUIDITY_SWEEP_CONFIRMED": {
        "indicator": "Liquidity sweep",
        "meaning": "Price runs beyond a liquidity level and closes back inside, showing a possible stop run.",
        "treatment": "Hard gate. A wick without close-back is only a break, not a confirmed sweep.",
    },
    "SWEEP_REJECTION_CONFIRMED": {
        "indicator": "Sweep rejection",
        "meaning": "The sweep candle must reject or quickly reclaim the liquidity level instead of accepting beyond it.",
        "treatment": "Hard gate. Prefer wick rejection or a fast delayed close-back; ignore simple stop-run labels without rejection.",
    },
    "SWEEP_ACCEPTANCE_BLOCK": {
        "indicator": "Acceptance filter",
        "meaning": "Multiple closes or a strong close beyond the swept level means breakout/continuation risk.",
        "treatment": "Hard gate. Block paper entries when price accepts beyond liquidity instead of rejecting it.",
    },
    "DOUBLE_SWEEP_FILTER": {
        "indicator": "Double sweep filter",
        "meaning": "Both buy-side and sell-side liquidity were swept in a tight window, making direction unreliable.",
        "treatment": "Hard gate. Wait for one side to produce displacement and structure confirmation cleanly.",
    },
    "DISPLACEMENT_CONFIRMED": {
        "indicator": "Displacement",
        "meaning": "A strong body-driven candle after the sweep, showing urgency in the reversal direction.",
        "treatment": "Hard gate. Weak overlapping movement is ignored because it often becomes chop.",
    },
    "PROTECTED_POINT_CONFIDENCE": {
        "indicator": "Protected high / protected low",
        "meaning": "The confirmed swing point whose candle-close break validates a market structure shift after the sweep.",
        "treatment": "Hard gate. Automatic paper entries require a medium/high confidence protected point so wick-only structure breaks do not trigger trades.",
    },
    "BOS_CHOCH_CONFIRMED": {
        "indicator": "BOS / CHoCH",
        "meaning": "A candle closes beyond internal structure after displacement, confirming a structure shift.",
        "treatment": "Hard gate. The setup is only watched until market structure is broken.",
    },
    "ENTRY_ZONE_READY": {
        "indicator": "FVG / Order block zone",
        "meaning": "A fresh imbalance or last opposing candle creates the pullback zone for entry.",
        "treatment": "Hard gate for planned entries. Prefer first-touch fresh zones.",
    },
    "ENTRY_ZONE_RETRACE": {
        "indicator": "Zone retrace",
        "meaning": "Price returns into the FVG/order-block zone instead of chasing the displacement candle.",
        "treatment": "Hard gate. No retrace means no clean risk definition.",
    },
    "CONFIRM_ENTRY_CANDLE": {
        "indicator": "Entry confirmation candle",
        "meaning": "The latest completed candle reacts from the zone in the intended direction.",
        "treatment": "Hard gate for paper entry. It converts candidate evidence into an actionable setup.",
    },
    "CONFIRM_EMA_200": {
        "indicator": "200 EMA alignment",
        "meaning": "Trend context agrees with the intended trade direction.",
        "treatment": "Confirmation. Helps grade the setup, but should not be the only reason to trade.",
    },
    "CONFIRM_VWAP": {
        "indicator": "VWAP alignment",
        "meaning": "Price is on the preferred side of session VWAP for the intended direction.",
        "treatment": "Confirmation. Improves quality when aligned with sweep and structure.",
    },
    "CONFIRM_FRESH_FVG": {
        "indicator": "Fresh FVG",
        "meaning": "A three-candle imbalance remains available after displacement.",
        "treatment": "Confirmation and entry-zone evidence. Stronger when first touch and near an order block.",
    },
    "CONFIRM_ORDER_BLOCK_RETEST": {
        "indicator": "Order block retest",
        "meaning": "Price revisits the last opposing candle before displacement.",
        "treatment": "Confirmation. Stronger when the order block overlaps an FVG.",
    },
    "QUALITY_RR": {
        "indicator": "Reward-to-risk",
        "meaning": "The planned TP is far enough from entry compared with SL.",
        "treatment": "Quality gate. Below 2R should stay watch-only.",
    },
    "QUALITY_STOP_SIZE": {
        "indicator": "Stop size",
        "meaning": "The SL distance is not too large relative to ATR.",
        "treatment": "Quality gate. Large stops reduce practical expectancy.",
    },
}


def playbook_for(module_code: str) -> dict[str, dict[str, str]]:
    if module_code == "high_probability_strategy_2":
        return MODULE2_RULES
    return {}


def indicator_summary(module_code: str, rows: list[dict[str, Any]]) -> dict[str, Any]:
    playbook = playbook_for(module_code)
    counts: dict[str, Counter] = defaultdict(Counter)
    examples: dict[str, str] = {}
    for row in rows:
        rule_code = str(row.get("rule_code") or "")
        status = str(row.get("status") or "UNKNOWN")
        if not rule_code:
            continue
        counts[rule_code][status] += int(row.get("count") or 1)
        if row.get("explanation") and rule_code not in examples:
            examples[rule_code] = str(row["explanation"])

    indicators = []
    for rule_code, statuses in sorted(counts.items()):
        meta = playbook.get(rule_code, {})
        total = sum(statuses.values())
        passed = statuses.get("PASS", 0)
        indicators.append(
            {
                "ruleCode": rule_code,
                "indicator": meta.get("indicator", rule_code.replace("_", " ").title()),
                "meaning": meta.get("meaning", "Saved strategy rule evidence."),
                "treatment": meta.get("treatment", "Review in context with the module checklist."),
                "total": total,
                "passed": passed,
                "failedOrWaiting": total - passed,
                "passRate": passed / total if total else 0,
                "statuses": dict(statuses),
                "example": examples.get(rule_code),
            }
        )
    return {
        "moduleCode": module_code,
        "indicators": indicators,
        "weakestIndicators": sorted(indicators, key=lambda item: (item["passRate"], -item["total"]))[:8],
    }
