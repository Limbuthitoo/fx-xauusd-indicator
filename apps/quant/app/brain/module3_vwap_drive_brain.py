from __future__ import annotations

from typing import Any


MODULE_CODE = "strategy_lab_3"
MODULE_NAME = "Module 3 VWAP Drive"

MANDATORY_RULES = [
    "NY_SESSION_ACTIVE",
    "DAILY_TRADE_LIMIT",
    "OPENING_DRIVE_COMPLETE",
    "OPENING_DRIVE_STRONG",
    "VWAP_ALIGNMENT",
    "PULLBACK_ZONE_READY",
    "PULLBACK_ZONE_TOUCHED",
    "CONFIRMATION_CANDLE",
]

CONFIRMATION_RULES = ["EMA_ALIGNMENT", "SIGNAL_SCORE"]
QUALITY_RULES = ["QUALITY_SPREAD", "QUALITY_NEWS", "QUALITY_RR", "QUALITY_STOP_SIZE"]


def decide(setup: dict[str, Any] | None, trade: dict[str, Any] | None, candle_health: dict[str, Any]) -> dict[str, Any]:
    evaluations = setup.get("evaluations", []) if setup else []
    checklist = checklist_summary(evaluations)
    if trade and trade.get("outcome") == "ACTIVE":
        return payload("TRADE_ACTIVE", "MANAGE", trade.get("direction"), setup, trade, checklist, candle_health, "INFO", "Module 3 paper trade is active. Manage the TP/SL lifecycle.", False)
    if not setup:
        return payload("WAITING_FOR_VWAP_DRIVE_SETUP", "WAIT", None, None, None, checklist, candle_health, "INFO", "Module 3 is waiting for New York opening drive, VWAP alignment, pullback-zone touch, and confirmation candle.", False)

    direction = setup.get("direction")
    action = "BUY" if direction == "LONG" else "SELL" if direction == "SHORT" else "WAIT"
    status = str(setup.get("status") or "")
    flags = setup.get("scenario_flags") or {}
    mandatory = bool(flags.get("mandatoryChecklistMatched")) or checklist["mandatoryPassed"]
    full = bool(flags.get("fullChecklistMatched")) or checklist["fullPassed"]
    has_trade_plan = all(setup.get(key) is not None for key in ("entry_price", "stop_price", "target_price"))

    if status in ("LONG SETUP READY", "SHORT SETUP READY", "PAPER_TRADE_OPENED") and mandatory and has_trade_plan:
        should_open = not setup.get("trade_id") and status != "PAPER_TRADE_OPENED"
        setup_tier = "FULL" if full else "MANDATORY"
        decision_type = "VWAP_DRIVE_FULL_ENTRY_READY" if full else "VWAP_DRIVE_MANDATORY_ENTRY_READY"
        reason = f"Module 3 {setup_tier} setup passed. {action} plan is ready from NY drive, VWAP alignment, pullback, confirmation candle, SL, and TP."
        return payload(decision_type if should_open else "VWAP_DRIVE_SETUP_HANDLED", action, direction, setup, trade, checklist, candle_health, "WARN" if should_open else "INFO", reason, should_open)

    if status in ("LONG SETUP READY", "SHORT SETUP READY") and not mandatory:
        return payload("VWAP_DRIVE_CHECKLIST_MISMATCH", "WAIT", direction, setup, trade, checklist, candle_health, "ERROR", "Module 3 setup is marked ready but mandatory VWAP opening-drive checklist is not fully passed.", False)

    blocker = first_blocker(checklist)
    reason = setup.get("final_reason") or "Module 3 is waiting for mandatory VWAP opening-drive pullback rules."
    if blocker:
        reason = f"{reason} Current blocker: {blocker['ruleCode']}."
    return payload("VWAP_DRIVE_WAITING_FOR_RULES", "WAIT", direction, setup, trade, checklist, candle_health, "INFO", reason, False)


def checklist_summary(evaluations: list[dict[str, Any]]) -> dict[str, Any]:
    statuses = {code(row): str(row.get("status")) for row in evaluations}
    mandatory = all(statuses.get(item) == "PASS" for item in MANDATORY_RULES)
    quality_count = sum(1 for item in QUALITY_RULES if statuses.get(item) == "PASS")
    signal_score_ok = statuses.get("SIGNAL_SCORE") == "PASS"
    full = mandatory and quality_count >= 3 and signal_score_ok
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
        return "Waiting for valid VWAP opening-drive setup."
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
