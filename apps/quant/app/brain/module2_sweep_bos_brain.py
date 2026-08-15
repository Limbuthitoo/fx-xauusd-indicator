from __future__ import annotations

from typing import Any


MODULE_CODE = "high_probability_strategy_2"
MODULE_NAME = "Module 2 Ultimate Liquidity Sweep"
XAUUSD_PIP_SIZE = 0.01
MINIMUM_SIGNAL_SCORE = 80
MINIMUM_TP1_PIPS = 100
MINIMUM_FINAL_RR = 2.0

MANDATORY_RULES = [
    "DATA_HEALTHY",
    "MARKET_CONTEXT_READY",
    "MARKET_REGIME_CLASSIFIED",
    "NY_SESSION_ACTIVE",
    "RISK_LIMITS_CLEAR",
    "MANUAL_CONFIRMATION_COMPLETED",
    "LIQUIDITY_LEVEL_IDENTIFIED",
    "LIQUIDITY_SWEEP_CONFIRMED",
    "SWEEP_REJECTION_CONFIRMED",
    "SWEEP_ACCEPTANCE_BLOCK",
    "DIRECTIONAL_CONFLICT_CLEAR",
    "TRADE_GEOMETRY_VALID",
    "RISK_OK",
    "SIGNAL_SCORE",
    "VARIANT_SELECTED",
]

CORE_SETUP_RULES = [
    "LIQUIDITY_LEVEL_IDENTIFIED",
    "LIQUIDITY_SWEEP_CONFIRMED",
    "SWEEP_REJECTION_CONFIRMED",
    "SWEEP_ACCEPTANCE_BLOCK",
]

CORE_SAFETY_RULES = [
    "DATA_HEALTHY",
    "NY_SESSION_ACTIVE",
    "RISK_LIMITS_CLEAR",
    "MANUAL_CONFIRMATION_COMPLETED",
    "DIRECTIONAL_CONFLICT_CLEAR",
    "RISK_OK",
]

SIGNAL_BLOCKING_RULES = [
    *CORE_SETUP_RULES,
    *CORE_SAFETY_RULES,
    "VARIANT_SELECTED",
]

CONFIRMATION_RULES = [
    "CONFIRM_EMA_200",
    "CONFIRM_VWAP",
    "CONFIRM_FRESH_FVG",
    "CONFIRM_ORDER_BLOCK_RETEST",
    "CONFIRM_ENGULFING",
    "CONFIRM_PIN_BAR",
    "CONFIRM_INSIDE_BAR_BREAK",
    "CONFIRM_DOJI_REJECTION",
    "CONFIRM_VOLUME_EXPANSION",
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
    "EMA_FILTER_MODE",
    "VOLUME_FILTER_MODE",
    "DISPLACEMENT_FILTER_MODE",
    "DOUBLE_SWEEP_FILTER",
]


def decide(setup: dict[str, Any] | None, trade: dict[str, Any] | None, candle_health: dict[str, Any]) -> dict[str, Any]:
    evaluations = setup.get("evaluations", []) if setup else []
    flags = setup.get("scenario_flags") if setup else {}
    checklist = checklist_summary(evaluations, flags if isinstance(flags, dict) else {})
    if not setup:
        if trade and trade.get("outcome") == "ACTIVE":
            return payload("TRADE_ACTIVE", "MANAGE", trade.get("direction"), None, trade, checklist, candle_health, "INFO", "Module 2 paper tracking is monitoring TP/SL while the signal engine waits for a new setup.", False)
        return payload("WAITING_FOR_LIQUIDITY_SWEEP_SETUP", "WAIT", None, None, None, checklist, candle_health, "INFO", "Module 2 is waiting for a New York-session liquidity sweep plus one signal-approved confirmation profile.", False)

    direction = setup.get("direction")
    action = "BUY" if direction == "LONG" else "SELL" if direction == "SHORT" else "WAIT"
    status = str(setup.get("status") or "")
    mandatory = checklist["mandatoryPassed"]
    full = checklist["fullPassed"]
    has_trade_plan = all(setup.get(key) is not None for key in ("entry_price", "stop_price", "target_price"))
    geometry_valid = valid_trade_geometry(direction, setup) if has_trade_plan else False
    quality = signal_quality(setup) if has_trade_plan else {"passed": False, "reason": "Trade geometry is incomplete."}

    if status in ("LONG SETUP READY", "SHORT SETUP READY", "PAPER_TRADE_OPENED") and has_trade_plan and not geometry_valid:
        return payload("LIQUIDITY_SWEEP_TRADE_GEOMETRY_MISMATCH", "WAIT", direction, setup, trade, checklist, candle_health, "ERROR", "Module 2 selected an entry plan whose stop or target is on the wrong side of entry.", False)

    if status in ("LONG SETUP READY", "SHORT SETUP READY", "PAPER_TRADE_OPENED") and has_trade_plan and not quality["passed"]:
        return payload("LIQUIDITY_SWEEP_SIGNAL_QUALITY_BLOCK", "WAIT", direction, setup, trade, checklist, candle_health, "INFO", str(quality["reason"]), False)

    if status in ("LONG SETUP READY", "SHORT SETUP READY", "PAPER_TRADE_OPENED") and mandatory and has_trade_plan and geometry_valid and quality["passed"]:
        paper_tracking_eligible = flags.get("paperTrackingEligible") is not False
        should_track = paper_tracking_eligible and not setup.get("trade_id") and status != "PAPER_TRADE_OPENED"
        setup_tier = "FULL" if full else "MANDATORY"
        selected_variant = selected_variant_name(flags)
        decision_type = "LIQUIDITY_SWEEP_FULL_SIGNAL_READY" if full else "LIQUIDITY_SWEEP_VARIANT_SIGNAL_READY"
        reason = (
            f"Module 2 {setup_tier} setup passed through {selected_variant}. {action} plan is ready from "
            "liquidity sweep, close-back rejection, selected profile confirmation, and risk approval."
        )
        return payload(decision_type if should_track else "LIQUIDITY_SWEEP_SIGNAL_HANDLED", action, direction, setup, trade, checklist, candle_health, "WARN" if should_track else "INFO", reason, should_track)

    if trade and trade.get("outcome") == "ACTIVE":
        if setup.get("trade_id") and status == "PAPER_TRADE_OPENED" and mandatory:
            return payload("TRADE_ACTIVE", "MANAGE", trade.get("direction"), setup, trade, checklist, candle_health, "INFO", "Module 2 paper tracking is monitoring TP/SL while the signal engine continues evaluating completed candles.", False)
        return payload("ACTIVE_TRADE_NEW_SETUP_WAIT", "WAIT", direction, setup, trade, checklist, candle_health, "INFO", setup.get("final_reason") or "An older paper trade remains active, but the newest Module 2 setup is not signal-ready.", False)

    if status in ("LONG SETUP READY", "SHORT SETUP READY") and not mandatory:
        return payload("LIQUIDITY_SWEEP_CHECKLIST_MISMATCH", "WAIT", direction, setup, trade, checklist, candle_health, "ERROR", "Module 2 setup is marked ready but the selected liquidity-sweep variant checklist is not fully passed.", False)

    blocker = first_blocker(checklist)
    reason = setup.get("final_reason") or "Module 2 is waiting for a selected signal-approved liquidity-sweep profile."
    if blocker:
        reason = f"{reason} Current blocker: {blocker['ruleCode']}."
    return payload("LIQUIDITY_SWEEP_WAITING_FOR_RULES", "WAIT", direction, setup, trade, checklist, candle_health, "INFO", reason, False)


def signal_quality(setup: dict[str, Any]) -> dict[str, Any]:
    entry = number(setup.get("entry_price"))
    stop = number(setup.get("stop_price"))
    target = number(setup.get("target_price"))
    score = number(setup.get("favorability_score"))
    direction = str(setup.get("direction") or "")
    if entry is None or stop is None or target is None:
        return {"passed": False, "reason": "Entry, structural SL, and final target are required."}
    geometry_valid = stop < entry < target if direction == "LONG" else target < entry < stop if direction == "SHORT" else False
    risk = abs(entry - stop)
    tp1_pips = risk / XAUUSD_PIP_SIZE
    final_rr = abs(target - entry) / risk if geometry_valid and risk > 0 else 0
    reasons = []
    if not geometry_valid:
        reasons.append("Directional trade geometry is invalid.")
    if score is None or score < MINIMUM_SIGNAL_SCORE:
        reasons.append(f"Evidence score must be at least {MINIMUM_SIGNAL_SCORE}/100.")
    if tp1_pips + 0.0001 < MINIMUM_TP1_PIPS:
        reasons.append(f"TP1 must be at least {MINIMUM_TP1_PIPS} XAUUSD pips from entry.")
    if final_rr + 0.0001 < MINIMUM_FINAL_RR:
        reasons.append(f"Final target must be at least {MINIMUM_FINAL_RR:.2f}R.")
    return {"passed": len(reasons) == 0, "reason": " ".join(reasons) if reasons else "Signal quality policy passed."}


def checklist_summary(evaluations: list[dict[str, Any]], flags: dict[str, Any] | None = None) -> dict[str, Any]:
    flags = flags or {}
    statuses = {code(row): str(row.get("status")) for row in evaluations}
    selected_variant = selected_variant_data(flags)
    paper_variant_selected = (
        bool(selected_variant.get("variantCode"))
        and selected_variant.get("variantCode") != "SWEEP_NO_CONFIRMATION"
        and selected_variant.get("variantPaperEligible") is not False
    )
    core_setup_passed = all(statuses.get(item) == "PASS" for item in CORE_SETUP_RULES)
    safety_passed = all(statuses.get(item) == "PASS" for item in CORE_SAFETY_RULES)
    flag_approved = bool(flags.get("mandatoryChecklistMatched")) and paper_variant_selected
    mandatory = flag_approved or (core_setup_passed and safety_passed and paper_variant_selected)
    confirmation_rows = [statuses.get(item) == "PASS" for item in CONFIRMATION_RULES if item != "CONFIRMATION_COUNT"]
    quality_rows = [statuses.get(item) == "PASS" for item in QUALITY_RULES if item != "QUALITY_FILTER_COUNT"]
    confirmation_count = sum(1 for item in confirmation_rows if item)
    quality_count = sum(1 for item in quality_rows if item)
    full = mandatory and (bool(flags.get("fullChecklistMatched")) or (confirmation_count >= 3 and quality_count >= 3))
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
        "requiredForEntry": rule_code in SIGNAL_BLOCKING_RULES,
            }
        )
    return {
        "moduleCode": MODULE_CODE,
        "requiredRules": SIGNAL_BLOCKING_RULES,
        "legacyMandatoryRules": MANDATORY_RULES,
        "mandatoryPassed": mandatory,
        "coreSetupPassed": core_setup_passed,
        "safetyPassed": safety_passed,
        "paperVariantSelected": paper_variant_selected,
        "selectedVariant": selected_variant,
        "fullPassed": full,
        "confirmationPassed": confirmation_count,
        "confirmationRequired": 3,
        "qualityPassed": quality_count,
        "qualityRequired": 3,
        "requiredPassed": sum(1 for row in rows if row["requiredForEntry"] and row["status"] == "PASS"),
        "requiredTotal": len([row for row in rows if row["requiredForEntry"]]),
        "blockingFailures": [
            row
            for row in rows
            if row["requiredForEntry"] and row["status"] not in ("PASS", "NOT_APPLICABLE")
        ],
        "rows": rows,
    }


def selected_variant_name(flags: dict[str, Any]) -> str:
    variant = flags.get("module2Variant") if isinstance(flags.get("module2Variant"), dict) else {}
    return str(variant.get("name") or flags.get("variantName") or flags.get("variantCode") or "the selected liquidity-sweep profile")


def selected_variant_data(flags: dict[str, Any]) -> dict[str, Any]:
    variant = flags.get("module2Variant") if isinstance(flags.get("module2Variant"), dict) else {}
    trade_plan = flags.get("tradePlan") if isinstance(flags.get("tradePlan"), dict) else {}
    return {
        "variantCode": variant.get("code") or flags.get("variantCode"),
        "variantName": variant.get("name") or flags.get("variantName"),
        "variantProfile": variant.get("profileKey"),
        "variantStatus": variant.get("approvalStatus") or variant.get("status"),
        "variantPaperEligible": variant.get("paperEligible"),
        "tradePlanSource": trade_plan.get("source"),
        "availableRewardRisk": trade_plan.get("availableRewardRisk"),
    }


def valid_trade_geometry(direction: str | None, setup: dict[str, Any]) -> bool:
    entry = number(setup.get("entry_price"))
    stop = number(setup.get("stop_price"))
    target = number(setup.get("target_price"))
    if entry is None or stop is None or target is None:
        return False
    if direction == "LONG":
        return stop < entry < target
    if direction == "SHORT":
        return target < entry < stop
    return False


def rule_layer(rule_code: str) -> str:
    if rule_code in SIGNAL_BLOCKING_RULES:
        return "MANDATORY"
    if rule_code in MANDATORY_RULES:
        return "EVIDENCE"
    if rule_code in CONFIRMATION_RULES:
        return "CONFIRMATION"
    if rule_code in QUALITY_RULES:
        return "QUALITY"
    if rule_code == "SIGNAL_SCORE":
        return "FINAL"
    return "EVIDENCE"


def payload(decision_type: str, action: str, direction: str | None, setup: dict[str, Any] | None, trade: dict[str, Any] | None, checklist: dict[str, Any], candle_health: dict[str, Any], severity: str, reason: str, should_track: bool) -> dict[str, Any]:
    return base_payload(MODULE_CODE, MODULE_NAME, decision_type, action, direction, setup, trade, checklist, candle_health, severity, reason, should_track)


def base_payload(module_code: str, module_name: str, decision_type: str, action: str, direction: str | None, setup: dict[str, Any] | None, trade: dict[str, Any] | None, checklist: dict[str, Any], candle_health: dict[str, Any], severity: str, reason: str, should_track: bool) -> dict[str, Any]:
    entry = number(setup.get("entry_price")) if setup else None
    stop = number(setup.get("stop_price")) if setup else None
    target = number(setup.get("target_price")) if setup else None
    flags = setup.get("scenario_flags") if setup else {}
    variant_data = selected_variant_data(flags if isinstance(flags, dict) else {})
    setup_tier = flags.get("setupTier") or ("FULL" if checklist.get("fullPassed") else "MANDATORY" if checklist.get("mandatoryPassed") else "WATCH")
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
                **variant_data,
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
