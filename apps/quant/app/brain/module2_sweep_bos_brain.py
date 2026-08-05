from __future__ import annotations

from typing import Any


MODULE_CODE = "high_probability_strategy_2"
MODULE_NAME = "Module 2 Liquidity Sweep + MSS + Retest"

MANDATORY_RULES = [
    "NY_SESSION_ACTIVE",
    "DAILY_TRADE_LIMIT",
    "LIQUIDITY_LEVEL_IDENTIFIED",
    "LIQUIDITY_SWEEP_CONFIRMED",
    "SWEEP_REJECTION_CONFIRMED",
    "SWEEP_ACCEPTANCE_BLOCK",
    "PROTECTED_POINT_CONFIDENCE",
    "BOS_CHOCH_CONFIRMED",
    "MSS_STRENGTH",
    "ENTRY_ZONE_READY",
    "ENTRY_ZONE_RETRACE",
    "CONFIRM_ENTRY_CANDLE",
    "RISK_OK",
    "SIGNAL_SCORE",
    "VARIANT_SELECTED",
]

CONFIRMATION_RULES = [
    "CONFIRM_EMA_200",
    "CONFIRM_VWAP",
    "CONFIRM_FRESH_FVG",
    "CONFIRM_ORDER_BLOCK_RETEST",
    "CONFIRMATION_COUNT",
]

QUALITY_RULES = [
    "QUALITY_ATR_VOLATILITY",
    "QUALITY_SPREAD",
    "QUALITY_NEWS",
    "QUALITY_RR",
    "QUALITY_STOP_SIZE",
    "QUALITY_FRESH_SETUP",
    "QUALITY_FILTER_COUNT",
]


def decide(setup: dict[str, Any] | None, trade: dict[str, Any] | None, candle_health: dict[str, Any]) -> dict[str, Any]:
    evaluations = setup.get("evaluations", []) if setup else []
    checklist = checklist_summary(evaluations)
    if trade and trade.get("outcome") == "ACTIVE":
        setup_status = str(setup.get("status") or "") if setup else ""
        if not setup or not checklist["mandatoryPassed"] or setup_status != "PAPER_TRADE_OPENED":
            return payload("ACTIVE_TRADE_CHECKLIST_MISMATCH", "MANAGE", trade.get("direction"), setup, trade, checklist, candle_health, "ERROR", "Module 2 has an active paper trade whose originating setup did not pass the authoritative Ultimate Liquidity Sweep checklist.", False)
        return payload("TRADE_ACTIVE", "MANAGE", trade.get("direction"), setup, trade, checklist, candle_health, "INFO", "Module 2 paper trade is active. Manage the TP/SL lifecycle.", False)
    if not setup:
        return payload("WAITING_FOR_SWEEP_MSS_RETEST_SETUP", "WAIT", None, None, None, checklist, candle_health, "INFO", "Module 2 is waiting for a New York liquidity sweep, close-back rejection, reversal MSS, and protected-structure retest.", False)

    direction = setup.get("direction")
    action = "BUY" if direction == "LONG" else "SELL" if direction == "SHORT" else "WAIT"
    status = str(setup.get("status") or "")
    flags = setup.get("scenario_flags") or {}
    mandatory = checklist["mandatoryPassed"]
    full = checklist["fullPassed"]
    has_trade_plan = all(setup.get(key) is not None for key in ("entry_price", "stop_price", "target_price"))

    if status in ("LONG SETUP READY", "SHORT SETUP READY", "PAPER_TRADE_OPENED") and mandatory and has_trade_plan:
        should_open = not setup.get("trade_id") and status != "PAPER_TRADE_OPENED"
        setup_tier = "FULL" if full else "MANDATORY"
        decision_type = "SWEEP_MSS_RETEST_FULL_ENTRY_READY" if full else "SWEEP_MSS_RETEST_MANDATORY_ENTRY_READY"
        reason = (
            f"Module 2 {setup_tier} setup passed. {action} plan is ready from liquidity sweep, "
            "close-back rejection, reversal MSS, protected-structure retest, and confirmation candle."
        )
        return payload(decision_type if should_open else "SWEEP_MSS_RETEST_SETUP_HANDLED", action, direction, setup, trade, checklist, candle_health, "WARN" if should_open else "INFO", reason, should_open)

    if status in ("LONG SETUP READY", "SHORT SETUP READY") and not mandatory:
        return payload("SWEEP_MSS_RETEST_CHECKLIST_MISMATCH", "WAIT", direction, setup, trade, checklist, candle_health, "ERROR", "Module 2 setup is marked ready but the mandatory Sweep + MSS + Retest checklist is not fully passed.", False)

    blocker = first_blocker(checklist)
    reason = setup.get("final_reason") or "Module 2 is waiting for mandatory Ultimate Sweep rules."
    if blocker:
        reason = f"{reason} Current blocker: {blocker['ruleCode']}."
    return payload("SWEEP_MSS_RETEST_WAITING_FOR_RULES", "WAIT", direction, setup, trade, checklist, candle_health, "INFO", reason, False)


def checklist_summary(evaluations: list[dict[str, Any]]) -> dict[str, Any]:
    statuses = {code(row): str(row.get("status")) for row in evaluations}
    mandatory = all(statuses.get(item) == "PASS" for item in MANDATORY_RULES)
    confirmation_rows = [statuses.get(item) == "PASS" for item in CONFIRMATION_RULES if item != "CONFIRMATION_COUNT"]
    quality_rows = [statuses.get(item) == "PASS" for item in QUALITY_RULES if item != "QUALITY_FILTER_COUNT"]
    confirmation_count = sum(1 for item in confirmation_rows if item)
    quality_count = sum(1 for item in quality_rows if item)
    full = mandatory and confirmation_count >= 3 and quality_count >= 3
    rows = []
    for row in evaluations:
        rule_code = code(row)
        rows.append(
            {
                "ruleCode": rule_code,
                "name": row.get("name"),
                "status": row.get("status"),
                "blocking": bool(row.get("blocking")),
                "ruleLayer": rule_layer(rule_code),
                "requiredForEntry": rule_code in MANDATORY_RULES,
            }
        )
    return {
        "moduleCode": MODULE_CODE,
        "requiredRules": MANDATORY_RULES,
        "mandatoryPassed": mandatory,
        "fullPassed": full,
        "confirmationPassed": confirmation_count,
        "confirmationRequired": 3,
        "qualityPassed": quality_count,
        "qualityRequired": 3,
        "requiredPassed": sum(1 for row in rows if row["requiredForEntry"] and row["status"] == "PASS"),
        "requiredTotal": len([row for row in rows if row["requiredForEntry"]]),
        "blockingFailures": [row for row in rows if row["blocking"] and row["status"] != "PASS"],
        "rows": rows,
    }


def rule_layer(rule_code: str) -> str:
    if rule_code in MANDATORY_RULES:
        return "MANDATORY"
    if rule_code in CONFIRMATION_RULES:
        return "CONFIRMATION"
    if rule_code in QUALITY_RULES:
        return "QUALITY"
    if rule_code == "SIGNAL_SCORE":
        return "FINAL"
    return "EVIDENCE"


def payload(decision_type: str, action: str, direction: str | None, setup: dict[str, Any] | None, trade: dict[str, Any] | None, checklist: dict[str, Any], candle_health: dict[str, Any], severity: str, reason: str, should_open: bool) -> dict[str, Any]:
    return base_payload(MODULE_CODE, MODULE_NAME, decision_type, action, direction, setup, trade, checklist, candle_health, severity, reason, should_open)


def base_payload(module_code: str, module_name: str, decision_type: str, action: str, direction: str | None, setup: dict[str, Any] | None, trade: dict[str, Any] | None, checklist: dict[str, Any], candle_health: dict[str, Any], severity: str, reason: str, should_open: bool) -> dict[str, Any]:
    entry = number(setup.get("entry_price")) if setup else None
    stop = number(setup.get("stop_price")) if setup else None
    target = number(setup.get("target_price")) if setup else None
    flags = setup.get("scenario_flags") if setup else {}
    setup_tier = flags.get("setupTier") or ("FULL" if checklist.get("fullPassed") else "MANDATORY" if checklist.get("mandatoryPassed") else "WATCH")
    title_action = "BUY" if direction == "LONG" else "SELL" if direction == "SHORT" else action
    return {
        "moduleCode": module_code,
        "moduleName": module_name,
        "decisionType": decision_type,
        "action": action,
        "direction": direction,
        "severity": severity,
        "reason": reason,
        "shouldOpenPaperTrade": should_open,
        "entry": entry,
        "stop": stop,
        "target": target,
        "score": number(setup.get("favorability_score")) if setup else None,
        "grade": setup.get("favorability_grade") if setup else None,
        "scenario": setup.get("scenario") if setup else None,
        "setupStatus": setup.get("status") if setup else None,
        "setupTier": setup_tier,
        "setupId": str(setup.get("id")) if setup and setup.get("id") else None,
        "tradeId": str(trade.get("id")) if trade and trade.get("id") else None,
        "candleStatus": candle_health.get("status"),
        "checklist": checklist,
        "notification": {
            "title": f"{module_name}: {title_action} {direction or ''}".strip(),
            "body": notification_body(setup_tier, setup, entry, stop, target),
            "data": {
                "moduleCode": module_code,
                "moduleName": module_name,
                "action": title_action,
                "direction": direction,
                "entry": entry,
                "stopLoss": stop,
                "takeProfit": target,
                "setupCandidateId": str(setup.get("id")) if setup and setup.get("id") else None,
                "tradeId": str(trade.get("id")) if trade and trade.get("id") else None,
                "scenario": setup.get("scenario") if setup else None,
                "setupTier": setup_tier,
                "finalReason": setup.get("final_reason") if setup else reason,
                "mandatoryPassed": checklist.get("mandatoryPassed"),
                "fullPassed": checklist.get("fullPassed"),
            },
        },
    }


def notification_body(setup_tier: Any, setup: dict[str, Any] | None, entry: float | None, stop: float | None, target: float | None) -> str:
    if not setup:
        return "Waiting for valid Ultimate Sweep setup."
    return " | ".join(
        str(item)
        for item in [
            setup_tier or "WATCH",
            setup.get("scenario"),
            f"Entry {price(entry)}",
            f"SL {price(stop)}",
            f"TP {price(target)}",
            f"Score {setup.get('favorability_score')}%" if setup.get("favorability_score") is not None else None,
        ]
        if item
    )


def first_blocker(checklist: dict[str, Any]) -> dict[str, Any] | None:
    failures = checklist.get("blockingFailures") or []
    return failures[0] if failures else None


def code(row: dict[str, Any]) -> str:
    return str(row.get("rule_code") or row.get("ruleCode") or "")


def number(value: Any) -> float | None:
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


def price(value: Any) -> str:
    number_value = number(value)
    return "--" if number_value is None else f"{number_value:.2f}"
