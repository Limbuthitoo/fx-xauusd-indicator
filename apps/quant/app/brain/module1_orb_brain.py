from __future__ import annotations

from typing import Any


MODULE_CODE = "orb_max_options"
MODULE_NAME = "Module 1 ORB"


def decide(setup: dict[str, Any] | None, trade: dict[str, Any] | None, candle_health: dict[str, Any]) -> dict[str, Any]:
    evaluations = setup.get("evaluations", []) if setup else []
    checklist = checklist_summary(evaluations)
    if not setup:
        if trade and trade.get("outcome") == "ACTIVE":
            return payload("TRADE_ACTIVE", "MANAGE", trade.get("direction"), None, trade, checklist, candle_health, "INFO", "Module 1 paper tracking is monitoring TP/SL while the signal engine waits for a new setup.", False)
        return payload("WAITING_FOR_ORB_SETUP", "WAIT", None, None, None, checklist, candle_health, "INFO", "Module 1 is waiting for a completed session ORB or horizontal-range signal candle.", False)

    direction = setup.get("direction")
    action = "BUY" if direction == "LONG" else "SELL" if direction == "SHORT" else "WAIT"
    status = str(setup.get("status") or "")
    flags = setup.get("scenario_flags") or {}
    mandatory = checklist["mandatoryPassed"]
    has_trade_plan = all(setup.get(key) is not None for key in ("entry_price", "stop_price", "target_price"))

    if status in ("LONG SETUP READY", "SHORT SETUP READY", "PAPER_TRADE_OPENED") and mandatory and has_trade_plan:
        should_track = not setup.get("trade_id") and status != "PAPER_TRADE_OPENED"
        tier = setup_tier(flags, checklist)
        profile = "Horizontal Range" if is_horizontal_setup(setup) else "ORB"
        reason = f"Module 1 {tier} {profile} setup passed. {action} plan is ready with entry, SL, and TP."
        return payload("ORB_SIGNAL_READY" if should_track else "ORB_SIGNAL_HANDLED", action, direction, setup, trade, checklist, candle_health, "WARN" if should_track else "INFO", reason, should_track)

    if trade and trade.get("outcome") == "ACTIVE":
        if setup.get("trade_id") and status == "PAPER_TRADE_OPENED" and mandatory:
            return payload("TRADE_ACTIVE", "MANAGE", trade.get("direction"), setup, trade, checklist, candle_health, "INFO", "Module 1 paper tracking is monitoring TP/SL while the signal engine continues evaluating completed candles.", False)
        return payload("ACTIVE_TRADE_NEW_SETUP_WAIT", "WAIT", direction, setup, trade, checklist, candle_health, "INFO", setup.get("final_reason") or "An older paper trade remains active, but the newest Module 1 setup is not signal-ready.", False)

    if status in ("LONG SETUP READY", "SHORT SETUP READY") and not mandatory:
        return payload("ORB_CHECKLIST_MISMATCH", "WAIT", direction, setup, trade, checklist, candle_health, "ERROR", "Module 1 setup is marked ready but ORB mandatory checklist is not fully passed.", False)

    blocker = first_blocker(checklist)
    reason = setup.get("final_reason") or "Module 1 is waiting for ORB rules."
    if blocker:
        reason = f"{reason} Current blocker: {blocker['ruleCode']}."
    return payload("ORB_WAITING_FOR_RULES", "WAIT", direction, setup, trade, checklist, candle_health, "INFO", reason, False)


def required_rules() -> list[str]:
    return ["ORB_LOCKED", "INSIDE_SIGNAL_WINDOW", "ENTRY_NOT_OVEREXTENDED", "RISK_PERMISSION"]


def horizontal_required_rules() -> list[str]:
    return [
        "HORIZONTAL_RANGE_LOCKED",
        "HORIZONTAL_BREAKOUT_CONFIRMED",
        "HORIZONTAL_RETEST_CONFIRMED",
        "HORIZONTAL_CONFLICT_CLEAR",
        "ENTRY_NOT_OVEREXTENDED",
        "RISK_PERMISSION",
    ]


def checklist_summary(evaluations: list[dict[str, Any]]) -> dict[str, Any]:
    statuses = {code(row): str(row.get("status")) for row in evaluations}
    close_passed = statuses.get("CLOSE_ABOVE_ORB_HIGH") == "PASS" or statuses.get("CLOSE_BELOW_ORB_LOW") == "PASS"
    orb_mandatory = close_passed and all(statuses.get(item) == "PASS" for item in required_rules())
    horizontal_mandatory = all(statuses.get(item) == "PASS" for item in horizontal_required_rules())
    mandatory = orb_mandatory or horizontal_mandatory
    rows = [
        {
            "ruleCode": code(row),
            "name": row.get("name"),
            "status": row.get("status"),
            "blocking": bool(row.get("blocking")),
            "requiredForEntry": code(row) in required_rules()
            or code(row) in horizontal_required_rules()
            or code(row) in ("CLOSE_ABOVE_ORB_HIGH", "CLOSE_BELOW_ORB_LOW"),
        }
        for row in evaluations
    ]
    return {
        "moduleCode": MODULE_CODE,
        "requiredRules": [*required_rules(), "CLOSE_ABOVE_ORB_HIGH_OR_BELOW_ORB_LOW"],
        "horizontalRequiredRules": horizontal_required_rules(),
        "mandatoryPassed": mandatory,
        "orbMandatoryPassed": orb_mandatory,
        "horizontalMandatoryPassed": horizontal_mandatory,
        "requiredPassed": sum(1 for row in rows if row["requiredForEntry"] and row["status"] == "PASS"),
        "requiredTotal": len([row for row in rows if row["requiredForEntry"]]),
        "blockingFailures": [row for row in rows if row["blocking"] and row["status"] != "PASS"],
        "rows": rows,
    }


def is_horizontal_setup(setup: dict[str, Any] | None) -> bool:
    if not setup:
        return False
    scenario = str(setup.get("scenario") or "")
    flags = setup.get("scenario_flags") or {}
    return scenario.startswith("HORIZONTAL_RANGE_") or bool(flags.get("horizontalRangeSignal"))


def payload(decision_type: str, action: str, direction: str | None, setup: dict[str, Any] | None, trade: dict[str, Any] | None, checklist: dict[str, Any], candle_health: dict[str, Any], severity: str, reason: str, should_track: bool) -> dict[str, Any]:
    return base_payload(MODULE_CODE, MODULE_NAME, decision_type, action, direction, setup, trade, checklist, candle_health, severity, reason, should_track)


def base_payload(module_code: str, module_name: str, decision_type: str, action: str, direction: str | None, setup: dict[str, Any] | None, trade: dict[str, Any] | None, checklist: dict[str, Any], candle_health: dict[str, Any], severity: str, reason: str, should_track: bool) -> dict[str, Any]:
    entry = number(setup.get("entry_price")) if setup else None
    stop = number(setup.get("stop_price")) if setup else None
    target = number(setup.get("target_price")) if setup else None
    setup_tier_value = setup_tier(setup.get("scenario_flags") or {}, checklist) if setup else None
    title_action = "BUY" if direction == "LONG" else "SELL" if direction == "SHORT" else action
    emits_signal = action in ("BUY", "SELL") and checklist.get("mandatoryPassed") and entry is not None and stop is not None and target is not None
    return {
        "moduleCode": module_code,
        "moduleName": module_name,
        "decisionType": decision_type,
        "action": action,
        "direction": direction,
        "severity": severity,
        "reason": reason,
        "shouldEmitSignal": bool(emits_signal),
        "shouldTrackPaperTrade": should_track,
        "shouldOpenPaperTrade": should_track,
        "mvpPriority": "SIGNAL_FIRST",
        "paperTrackingPurpose": "WIN_RATE_MEASUREMENT",
        "entry": entry,
        "stop": stop,
        "target": target,
        "score": number(setup.get("favorability_score")) if setup else None,
        "grade": setup.get("favorability_grade") if setup else None,
        "scenario": setup.get("scenario") if setup else None,
        "setupStatus": setup.get("status") if setup else None,
        "setupTier": setup_tier_value,
        "setupId": str(setup.get("id")) if setup and setup.get("id") else None,
        "tradeId": str(trade.get("id")) if trade and trade.get("id") else None,
        "candleStatus": candle_health.get("status"),
        "checklist": checklist,
        "notification": {
            "title": f"{module_name}: {title_action} {direction or ''}".strip(),
            "body": notification_body(setup_tier_value, setup, entry, stop, target),
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
                "setupTier": setup_tier_value,
                "finalReason": setup.get("final_reason") if setup else reason,
            },
        },
    }


def notification_body(setup_tier: Any, setup: dict[str, Any] | None, entry: float | None, stop: float | None, target: float | None) -> str:
    if not setup:
        return "Waiting for valid setup."
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


def setup_tier(flags: dict[str, Any], checklist: dict[str, Any]) -> str:
    matrix = flags.get("matrix") if isinstance(flags.get("matrix"), dict) else {}
    saved = flags.get("setupTier") or matrix.get("setupTier")
    if saved:
        return str(saved)
    if checklist.get("mandatoryPassed"):
        return "MANDATORY" if checklist.get("blockingFailures") else "FULL"
    return "WATCH"


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
