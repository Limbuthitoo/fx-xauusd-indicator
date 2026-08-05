import type { Direction, RuleContext, RuleEvaluation } from "@orb-guide/shared-types";

const passFail = (passed: boolean, base: Omit<RuleEvaluation, "status">): RuleEvaluation => ({
  ...base,
  status: passed ? "PASS" : "FAIL"
});

function layer(ruleCode: string): Pick<RuleEvaluation, "ruleLayer" | "requiredForEntry"> {
  const mandatory = new Set(["ORB_LOCKED", "INSIDE_SIGNAL_WINDOW", "CLOSE_ABOVE_ORB_HIGH", "CLOSE_BELOW_ORB_LOW", "ENTRY_NOT_OVEREXTENDED", "RISK_PERMISSION"]);
  const confirmation = new Set(["BREAKOUT_BODY_RATIO", "CLOSE_LOCATION_RATIO"]);
  const quality = new Set(["NEWS_FILTER"]);
  if (mandatory.has(ruleCode)) return { ruleLayer: "MANDATORY", requiredForEntry: true };
  if (confirmation.has(ruleCode)) return { ruleLayer: "CONFIRMATION", requiredForEntry: false };
  if (quality.has(ruleCode)) return { ruleLayer: "QUALITY", requiredForEntry: false };
  return { ruleLayer: "EVIDENCE", requiredForEntry: false };
}

export function evaluateMandatoryBreakoutRules(context: RuleContext, direction: Direction): RuleEvaluation[] {
  const range = context.openingRange;
  const candle = context.currentCandle;
  const config = context.configuration.breakout;
  const newsEnabled = context.configuration.newsFilter.enabled && context.configuration.newsFilter.mode !== "OFF";
  const fullRange = candle.high - candle.low;
  const body = Math.abs(candle.close - candle.open);
  const bodyRatio = fullRange > 0 ? body / fullRange : 0;
  const closeLocationRatio =
    fullRange > 0
      ? direction === "LONG"
        ? (candle.close - candle.low) / fullRange
        : (candle.high - candle.close) / fullRange
      : 0;
  const boundary = direction === "LONG" ? range.high : range.low;
  const outsideClose = boundary == null ? false : direction === "LONG" ? candle.close > boundary : candle.close < boundary;
  const breakoutDistance = boundary == null ? 0 : Math.abs(candle.close - boundary);
  const extensionLimit = (range.width ?? 0) * config.maximumEntryExtensionPercentOfRange;

  return [
    {
      ruleCode: "ORB_LOCKED",
      name: "Opening range is locked",
      ...layer("ORB_LOCKED"),
      status: range.status === "LOCKED" ? "PASS" : "WAITING",
      blocking: true,
      source: "AUTOMATIC",
      actualValue: range.status,
      requiredValue: "LOCKED",
      explanation: range.status === "LOCKED" ? "The opening range is locked and cannot repaint." : "The opening range is not locked yet."
    },
    {
      ruleCode: "INSIDE_SIGNAL_WINDOW",
      name: "Current time is inside allowed signal window",
      ...layer("INSIDE_SIGNAL_WINDOW"),
      status:
        new Date(context.now) <= new Date(context.session.signalWindowEndAt) &&
        new Date(context.now) >= new Date(context.session.openingRangeEndAt)
          ? "PASS"
          : "FAIL",
      blocking: true,
      source: "AUTOMATIC",
      actualValue: context.now,
      requiredValue: `${context.session.openingRangeEndAt} to ${context.session.signalWindowEndAt}`,
      explanation: "Signals are evaluated only after ORB lock and before the configured session trade window ends."
    },
    passFail(outsideClose, {
      ruleCode: direction === "LONG" ? "CLOSE_ABOVE_ORB_HIGH" : "CLOSE_BELOW_ORB_LOW",
      name: direction === "LONG" ? "Candle closes above ORB high" : "Candle closes below ORB low",
      ...layer(direction === "LONG" ? "CLOSE_ABOVE_ORB_HIGH" : "CLOSE_BELOW_ORB_LOW"),
      blocking: true,
      source: "AUTOMATIC",
      actualValue: candle.close,
      requiredValue: boundary,
      explanation: outsideClose
        ? `The completed candle closed outside the ${direction === "LONG" ? "ORB high" : "ORB low"}.`
        : "The completed candle did not close outside the required ORB boundary."
    }),
    passFail(bodyRatio >= config.minimumBodyRatio, {
      ruleCode: "BREAKOUT_BODY_RATIO",
      name: "Breakout candle body ratio",
      ...layer("BREAKOUT_BODY_RATIO"),
      blocking: true,
      source: "AUTOMATIC",
      actualValue: Number(bodyRatio.toFixed(3)),
      requiredValue: config.minimumBodyRatio,
      explanation: bodyRatio >= config.minimumBodyRatio ? "The breakout candle body is strong enough." : "The breakout candle body is too small."
    }),
    passFail(closeLocationRatio >= config.minimumCloseLocationRatio, {
      ruleCode: "CLOSE_LOCATION_RATIO",
      name: "Breakout close location",
      ...layer("CLOSE_LOCATION_RATIO"),
      blocking: true,
      source: "AUTOMATIC",
      actualValue: Number(closeLocationRatio.toFixed(3)),
      requiredValue: config.minimumCloseLocationRatio,
      explanation:
        closeLocationRatio >= config.minimumCloseLocationRatio
          ? "The candle closed in the preferred portion of its range."
          : "The candle close location is not strong enough."
    }),
    passFail(breakoutDistance <= extensionLimit || extensionLimit === 0, {
      ruleCode: "ENTRY_NOT_OVEREXTENDED",
      name: "Entry is not overextended",
      ...layer("ENTRY_NOT_OVEREXTENDED"),
      blocking: true,
      source: "AUTOMATIC",
      actualValue: Number(breakoutDistance.toFixed(3)),
      requiredValue: Number(extensionLimit.toFixed(3)),
      explanation:
        breakoutDistance <= extensionLimit || extensionLimit === 0
          ? "The entry is within the configured extension limit."
          : "Price moved too far beyond the opening range boundary."
    }),
    {
      ruleCode: "NEWS_FILTER",
      name: "No blocked USD news",
      ...layer("NEWS_FILTER"),
      status: !newsEnabled ? "NOT_APPLICABLE" : context.newsStatus === "CLEAR" || context.newsStatus === "UPCOMING_WARNING" ? "PASS" : "FAIL",
      blocking: context.configuration.newsFilter.mode === "BLOCK",
      source: "AUTOMATIC",
      actualValue: context.newsStatus,
      requiredValue: newsEnabled ? "CLEAR" : "FILTER_ENABLED",
      explanation:
        !newsEnabled
          ? "The news filter is disabled for this strategy version."
          : context.newsStatus === "CLEAR"
          ? "No manually entered blocking news event is active."
          : "A news warning or block is active from manual event configuration."
    },
    {
      ruleCode: "RISK_PERMISSION",
      name: "Risk engine permits the trade",
      ...layer("RISK_PERMISSION"),
      status: context.riskStatus === "PERMITTED" ? "PASS" : "FAIL",
      blocking: true,
      source: "AUTOMATIC",
      actualValue: context.riskStatus,
      requiredValue: "PERMITTED",
      explanation:
        context.riskStatus === "PERMITTED"
          ? "Risk checks permit the trade plan."
          : "Risk checks do not permit the trade plan."
    }
  ];
}
