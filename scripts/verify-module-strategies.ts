import assert from "node:assert/strict";
import { buildLiquidityAwareStop, buildOpeningRange, evaluateModule1MarketChallenger, evaluateSetup } from "../packages/strategy-engine/src/index.js";
import { evaluateLiquiditySweepSetup, validTradeGeometry } from "../packages/liquidity-sweep-engine/src/index.js";
import {
  FalseBreakoutEngine,
  HorizontalRangeDetector,
  MaxOptionsOrbRangeDetector,
  RANGE_BREAKOUT_PROFILES,
  RangeConflictResolver,
  RangeDecisionEngine,
  RetestEngine,
  evaluateBreakoutRetestLifecycle,
  evaluateRangeBreakout
} from "../packages/range-engine/src/index.js";
import type { Candle } from "../packages/shared-types/src/index.js";
import { applyModule1NewsGate, buildHorizontalRangeSetupDecision, buildModule1RangeEngineMetadata, calculateCatchupRequestCount, calculatePostStopShadowObservation, isModule1ActiveOrbPreset, isNewYorkWeekend, isScheduledTwelveDataTrigger, sharedNewYorkFeedWindow } from "../apps/api/src/modules/market-data/routes.js";
import { evaluateHorizontalBreakoutShadow } from "../apps/api/src/modules/market-data/horizontal-breakout-shadow.js";
import { fetchOfficialUsCalendar, parseBeaSchedule, parseBlsCalendar, parseCensusSchedule, parseFedSchedule } from "../apps/api/src/modules/news/official-us-calendar.js";
import { calendarFreshness, classifyEconomicEvents } from "../apps/api/src/modules/news/service.js";
import { brainRejectsPrediction, predictionProbability } from "../apps/api/src/modules/setups/routes.js";
import { buildPaperTargetPlan, PAPER_MANAGEMENT_POLICY_PRODUCTION, PAPER_MANAGEMENT_POLICY_V1, PAPER_MANAGEMENT_POLICY_V2, PAPER_MANAGEMENT_POLICY_V3, paperManagedStop, paperReplayCursor, paperSettlement, paperTargetTouches, shouldStartPostStopObservation, type PaperTarget } from "../apps/api/src/modules/trades/paper-target-plan.js";
import { paperTargetManagementSummary } from "../apps/api/src/modules/trades/paper-targets.js";
import { evaluateSignalExecutionQuality, evaluateSignalGeometryQuality, signalsAreCorrelated } from "../packages/risk-engine/src/index.js";
import { redactSensitiveText, redactSensitiveValue } from "../apps/api/src/infrastructure/security/redaction.js";
import { validateModuleSetting } from "../apps/api/src/modules/admin/settings.js";
import { candleReachesXauUsdDailyClose, isXauUsdTradableCandle, xauUsdDailyMarketClose } from "../apps/api/src/infrastructure/time.js";
import { module1StrategyProfile, normalizeModule1ProfileMode, resolveModule1ProfilePolicy } from "../apps/api/src/modules/market-data/module1-profiles.js";
import { buildModule1StopShadowCandidates, evaluateModule1StopShadowCandle } from "../apps/api/src/modules/trades/module1-stop-shadow.js";

assert.equal(isXauUsdTradableCandle("XAUUSD", "2026-09-07T20:55:00Z"), true, "The final pre-maintenance XAU/USD candle must remain tradable during New York daylight time");
assert.equal(isXauUsdTradableCandle("XAUUSD", "2026-09-07T21:05:00Z"), false, "Synthetic candles inside the XAU/USD daily maintenance hour must be excluded");
assert.equal(isXauUsdTradableCandle("XAUUSD", "2026-09-07T22:00:00Z"), true, "The provider reopening bucket must remain visible after the maintenance gap");
assert.equal(candleReachesXauUsdDailyClose("XAUUSD", "2026-09-07T20:55:00Z", 5), true, "The 16:55 New York candle must trigger an intraday market-break exit");
assert.equal(xauUsdDailyMarketClose("2026-12-07T15:00:00Z")?.toISOString(), "2026-12-07T22:00:00.000Z", "XAU/USD market close calculation must follow New York standard time");
assert.equal(xauUsdDailyMarketClose("2026-09-07T22:30:00Z")?.toISOString(), "2026-09-08T21:00:00.000Z", "A post-reopen Tokyo-session entry must use the following New York market close");
assert.equal(isXauUsdTradableCandle("EURUSD", "2026-09-07T21:05:00Z"), true, "The metals calendar must not filter unrelated symbols");

const subscriberTradeSetup = validateModuleSetting("orb_max_options", "orb.strategy", {
  tradeSetup: { enabledSessionPresets: ["TOKYO_ORB", "LONDON_ORB"], maximumSignalsPerDay: 9 },
  risk: { minimumStopAtr: 0.5, liquidityBufferAtr: 0.05 }
}) as any;
assert.deepEqual(subscriberTradeSetup.tradeSetup.enabledSessionPresets, ["TOKYO_ORB"], "Subscriber automation must use one explicit session preset");
assert.equal(subscriberTradeSetup.tradeSetup.maximumSignalsPerDay, 3, "Subscriber daily signals must stay inside the production cap");
assert.equal(subscriberTradeSetup.tradeSetup.profileMode, "ORB_ONLY", "Non-New-York sessions must be normalized to the supported ORB-only profile");
assert.equal(subscriberTradeSetup.strategyProfiles.orb.maximumSignalsPerDay, 1, "ORB must have an independent daily signal cap");
assert.equal(subscriberTradeSetup.strategyProfiles.horizontal.maximumSignalsPerDay, 1, "Horizontal Breakout must have an independent daily signal cap");
assert.equal(subscriberTradeSetup.risk.minimumStopAtr, 2, "Module 1 settings must preserve the volatility stop floor");
assert.equal(subscriberTradeSetup.risk.liquidityBufferAtr, 0.25, "Module 1 settings must preserve the structural liquidity buffer");
assert.equal(subscriberTradeSetup.newsFilter.enabled, true, "Module 1 economic-event protection must default on");
assert.equal(subscriberTradeSetup.newsFilter.mode, "BLOCK", "Legacy high-impact news mode must normalize to a real blocking mode");
assert.equal(normalizeModule1ProfileMode("horizontal_only"), "HORIZONTAL_ONLY", "Profile mode normalization must accept the supported modes");
assert.equal(normalizeModule1ProfileMode("invalid"), "ORB_AND_HORIZONTAL", "Invalid profile modes must fall back safely");
assert.equal(module1StrategyProfile({ strategy_profile: "HORIZONTAL_RANGE_BREAKOUT", scenario: "ORB_BREAKOUT" }), "HORIZONTAL_RANGE_BREAKOUT", "Persisted Module 1 profile identity must take priority over scenario parsing");
const separatedSession = {
  session_date: "2026-09-08",
  session_preset: "NEW_YORK_ORB",
  opening_range_end_at: "2026-09-08T13:30:00Z",
  signal_window_end_at: "2026-09-08T20:00:00Z"
};
const newYorkTradeSetup = validateModuleSetting("orb_max_options", "orb.strategy", { tradeSetup: { enabledSessionPresets: ["NEW_YORK_ORB"] } }) as any;
assert.equal(newYorkTradeSetup.tradeSetup.profileMode, "ORB_AND_HORIZONTAL", "New York must default to the separated combined profile mode");
const normalizedOverlap = validateModuleSetting("orb_max_options", "orb.strategy", {
  tradeSetup: { enabledSessionPresets: ["NEW_YORK_ORB"], profileMode: "ORB_AND_HORIZONTAL" },
  strategyProfiles: { orb: { signalWindowEnd: "12:00" }, horizontal: { signalWindowStart: "10:00" } }
}) as any;
assert.equal(normalizedOverlap.strategyProfiles.horizontal.signalWindowStart, "12:00", "Combined profile windows must never overlap");
const openingOrbPolicy = resolveModule1ProfilePolicy({ configuration: newYorkTradeSetup, session: separatedSession, timestamp: "2026-09-08T14:55:00Z", profile: "ORB_BREAKOUT" });
const openingHorizontalPolicy = resolveModule1ProfilePolicy({ configuration: newYorkTradeSetup, session: separatedSession, timestamp: "2026-09-08T14:55:00Z", profile: "HORIZONTAL_RANGE_BREAKOUT" });
assert.equal(openingOrbPolicy.eligible, true, "ORB must own the opening window before 11:00 New York");
assert.equal(openingHorizontalPolicy.eligible, false, "Horizontal Breakout must observe without signaling during the ORB window");
const continuationOrbPolicy = resolveModule1ProfilePolicy({ configuration: newYorkTradeSetup, session: separatedSession, timestamp: "2026-09-08T15:05:00Z", profile: "ORB_BREAKOUT" });
const continuationHorizontalPolicy = resolveModule1ProfilePolicy({ configuration: newYorkTradeSetup, session: separatedSession, timestamp: "2026-09-08T15:05:00Z", profile: "HORIZONTAL_RANGE_BREAKOUT" });
assert.equal(continuationOrbPolicy.eligible, false, "ORB must stop producing entries after its exclusive window");
assert.equal(continuationHorizontalPolicy.eligible, true, "Horizontal Breakout must own the continuation window after 11:00 New York");
const postgresDateSession = {
  ...separatedSession,
  session_date: new Date("2026-09-08T00:00:00.000Z"),
  opening_range_end_at: new Date(separatedSession.opening_range_end_at),
  signal_window_end_at: new Date(separatedSession.signal_window_end_at)
};
const postgresDateHorizontalPolicy = resolveModule1ProfilePolicy({ configuration: newYorkTradeSetup, session: postgresDateSession, timestamp: new Date("2026-09-08T15:05:00Z"), profile: "HORIZONTAL_RANGE_BREAKOUT" });
assert.equal(postgresDateHorizontalPolicy.eligible, true, "Module 1 policy dates returned by PostgreSQL must preserve Horizontal Breakout eligibility");
assert.equal(postgresDateHorizontalPolicy.windowStartAt, "2026-09-08T15:00:00.000Z", "PostgreSQL date values must normalize to the New York session date");
const tokyoHorizontalPolicy = resolveModule1ProfilePolicy({ configuration: newYorkTradeSetup, session: { ...separatedSession, session_preset: "TOKYO_ORB" }, timestamp: "2026-09-08T15:05:00Z", profile: "HORIZONTAL_RANGE_BREAKOUT" });
assert.equal(tokyoHorizontalPolicy.enabled, false, "Horizontal Breakout must remain New York only");
const stopCandidates = buildModule1StopShadowCandidates({
  direction: "LONG",
  entry: 100,
  baselineStop: 96,
  structuralInvalidation: 96.5,
  atr: 2,
  spread: 0,
  baselineMinimumStopAtr: 2,
  baselineLiquidityBufferAtr: 0.25
});
assert.deepEqual(
  stopCandidates.map((candidate) => candidate.code),
  ["BASELINE_CURRENT", "STRUCTURAL_ATR_2_25", "STRUCTURAL_ATR_2_50", "SWING_BUFFER_0_50", "MAX_STOP_3_ATR"],
  "Stop calibration must compare a stable candidate set"
);
assert.equal(stopCandidates.find((candidate) => candidate.code === "STRUCTURAL_ATR_2_50")!.riskDistance >= 5, true, "The 2.50 ATR challenger must be wider than the current 2 ATR floor");
assert.equal(
  buildModule1StopShadowCandidates({ direction: "LONG", entry: 100, baselineStop: 93, structuralInvalidation: 94, atr: 2 })
    .find((candidate) => candidate.code === "MAX_STOP_3_ATR")!.tradeAccepted,
  false,
  "The maximum-stop policy must skip a setup whose required stop exceeds 3 ATR"
);
const shadowBase = {
  direction: "LONG" as const,
  entry: 100,
  stop: 95,
  target: 110,
  riskDistance: 5,
  realizedR: 0,
  remainingFraction: 1,
  maximumFavorableExcursionR: 0,
  maximumAdverseExcursionR: 0,
  observationUntil: "2026-09-08T20:00:00Z"
};
const shadowAfterTp1 = evaluateModule1StopShadowCandle(
  { ...shadowBase, targetHitIndex: 0 },
  { timestampUtc: "2026-09-08T14:00:00Z", high: 105.5, low: 99, close: 105 }
);
assert.equal(shadowAfterTp1.completed, false, "TP1 must leave the shadow runner active on its structural stop");
assert.equal(shadowAfterTp1.targetHitIndex, 1, "TP1 must be recorded once");
const shadowStoppedAfterTp1 = evaluateModule1StopShadowCandle(
  { ...shadowBase, targetHitIndex: 1, realizedR: shadowAfterTp1.realizedR, remainingFraction: shadowAfterTp1.remainingFraction },
  { timestampUtc: "2026-09-08T14:05:00Z", high: 104, low: 94.5, close: 96 }
);
assert.equal(shadowStoppedAfterTp1.resultR, -0.3333, "A stop after TP1 must preserve the booked third and lose only the remaining two thirds");
const shadowAfterTp2 = evaluateModule1StopShadowCandle(
  { ...shadowBase, targetHitIndex: 1, realizedR: 0.3333, remainingFraction: 2 / 3 },
  { timestampUtc: "2026-09-08T14:10:00Z", high: 108, low: 101, close: 107 }
);
const shadowBreakevenAfterTp2 = evaluateModule1StopShadowCandle(
  { ...shadowBase, targetHitIndex: 2, realizedR: shadowAfterTp2.realizedR, remainingFraction: shadowAfterTp2.remainingFraction },
  { timestampUtc: "2026-09-08T14:15:00Z", high: 106, low: 99.5, close: 101 }
);
assert.equal(shadowBreakevenAfterTp2.resultR, 0.8333, "The runner may move to entry only after TP2, preserving +0.83R");
const shadowTp3 = evaluateModule1StopShadowCandle(
  { ...shadowBase, targetHitIndex: 2, realizedR: 0.8333, remainingFraction: 1 / 3 },
  { timestampUtc: "2026-09-08T14:20:00Z", high: 110.5, low: 101, close: 110 }
);
assert.equal(shadowTp3.resultR, 1.5, "The complete equal-third target ladder must settle at +1.50R");
const ambiguousShadow = evaluateModule1StopShadowCandle(
  { ...shadowBase, targetHitIndex: 0 },
  { timestampUtc: "2026-09-08T14:25:00Z", high: 106, low: 94, close: 101 }
);
assert.equal(ambiguousShadow.resultR, -1, "A candle touching TP1 and stop must use conservative stop-first sequencing");
assert.equal(ambiguousShadow.ambiguous, true, "Ambiguous shadow exits must remain visible in calibration evidence");
const fetchedAt = new Date("2026-08-01T00:00:00Z");
const blsFixture = `BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:cpi-2026-08\nDTSTART;TZID=US-Eastern:20260812T083000\nSUMMARY:Consumer Price Index\nEND:VEVENT\nBEGIN:VEVENT\nUID:minor\nDTSTART;TZID=US-Eastern:20260813T100000\nSUMMARY:Productivity and Costs\nEND:VEVENT\nEND:VCALENDAR`;
const blsCalendar = parseBlsCalendar(blsFixture, fetchedAt);
assert.equal(blsCalendar.events.length, 1, "BLS synchronization must retain only the curated market-moving releases");
assert.equal(blsCalendar.events[0].eventTimeUtc, "2026-08-12T12:30:00.000Z", "BLS Eastern release time must convert to UTC with DST");
const beaCalendar = parseBeaSchedule(`<table id="release-schedule-table"><thead><tr><th>Year 2026</th></tr></thead><tbody><tr><td class="release-date">August 27</td><td class="release-title">Gross Domestic Product, 2nd Quarter and Corporate Profits (Second Estimate)</td><td><small class="text-muted">8:30 AM</small></td></tr><tr><td class="release-date">August 28</td><td class="release-title">GDP by State</td><td><small class="text-muted">10:00 AM</small></td></tr></tbody></table>`, fetchedAt);
assert.equal(beaCalendar.events.length, 1, "BEA synchronization must exclude regional GDP releases");
const censusCalendar = parseCensusSchedule(`<table id="calendar"><tbody><tr><td>Advance Monthly Sales for Retail and Food Services</td><td sorttable_customkey="202608140830">August 14, 2026</td><td>8:30 AM</td></tr><tr><td>Construction Spending</td><td sorttable_customkey="202608151000">August 15, 2026</td><td>10:00 AM</td></tr></tbody></table>`, fetchedAt);
assert.equal(censusCalendar.events.length, 1, "Census synchronization must retain retail sales and exclude lower-impact releases");
const fedCalendar = parseFedSchedule(`<div class="panel"><div class="panel-heading">2026 FOMC Meetings</div><div class="fomc-meeting"><div class="fomc-meeting__month"><strong>September</strong></div><div class="fomc-meeting__date">15-16*</div></div></div>`, fetchedAt);
assert.equal(fedCalendar.events[0].eventTimeUtc, "2026-09-16T18:00:00.000Z", "FOMC statements must use the final meeting day at 2 PM Eastern");
const partialCalendar = await fetchOfficialUsCalendar(async (input) =>
  String(input).includes("bls.gov")
    ? new Response(blsFixture, { status: 200 })
    : new Response("unavailable", { status: 503 })
, fetchedAt);
assert.deepEqual(partialCalendar.successful.map((source) => source.sourceCode), ["BLS"], "A healthy agency source must remain usable during a partial outage");
assert.equal(partialCalendar.failures.length, 3, "Every failed official source must remain visible to the fail-closed synchronization state");
assert.deepEqual(
  calendarFreshness({ evaluatedAt: "2026-08-10T12:00:00Z", lastSuccessAt: "2026-08-10T11:00:00Z", coverageEndAt: "2026-08-12T00:00:00Z", staleHours: 30 }),
  { stale: false, staleByAge: false, staleByCoverage: false },
  "Fresh calendar coverage must remain tradable"
);
assert.equal(
  calendarFreshness({ evaluatedAt: "2026-08-10T12:00:00Z", lastSuccessAt: "2026-08-08T00:00:00Z", coverageEndAt: "2026-08-12T00:00:00Z", staleHours: 30 }).stale,
  true,
  "A stale automated calendar must trigger the fail-safe"
);

const liquidityAwareLongStop = buildLiquidityAwareStop({
  direction: "LONG",
  entry: 4445.40598,
  structuralInvalidation: 4439.288862,
  atr: 3.50548,
  spread: 0,
  minimumStopAtr: 2,
  liquidityBufferAtr: 0.25
});
assert.equal(liquidityAwareLongStop.stop < 4439.252, true, "Module 1 stop must survive the observed shallow horizontal liquidity sweep");
assert.equal((liquidityAwareLongStop.stopDistanceAtr ?? 0) >= 2, true, "Module 1 stop must stay at least 2 ATR from entry");
assert.equal(liquidityAwareLongStop.bufferedStructuralStop < 4439.288862, true, "Module 1 stop must sit beyond structural invalidation, not on the visible boundary");
const liquidityAwareShortStop = buildLiquidityAwareStop({ direction: "SHORT", entry: 4500, structuralInvalidation: 4505, atr: 2, spread: 0.2 });
assert.equal(liquidityAwareShortStop.stop > 4505, true, "Module 1 short stop must sit above structural invalidation");
assert.equal((liquidityAwareShortStop.stopDistanceAtr ?? 0) >= 2, true, "Module 1 short stop must enforce the same volatility floor");
const longShadow = calculatePostStopShadowObservation(
  { direction: "LONG", actual_entry: 100, actual_stop: 95, initial_risk_distance: 5 },
  candle("2026-08-10T10:05:00Z", 99, 110, 94, 108)
)!;
assert.equal(longShadow.favorableR, 2, "Post-stop LONG shadow must measure favorable excursion in original R");
assert.equal(longShadow.adverseR, 1.2, "Post-stop LONG shadow must measure adverse excursion before recovery");
assert.equal(Boolean(longShadow.tp1At && longShadow.tp2At && longShadow.tp3At), true, "Post-stop LONG shadow must detect the complete original target ladder");
const shortShadow = calculatePostStopShadowObservation(
  { direction: "SHORT", actual_entry: 100, actual_stop: 105, initial_risk_distance: 5 },
  candle("2026-08-10T10:05:00Z", 101, 106, 90, 92)
)!;
assert.equal(shortShadow.favorableR, 2, "Post-stop SHORT shadow must measure favorable excursion symmetrically");
assert.equal(shortShadow.adverseR, 1.2, "Post-stop SHORT shadow must measure adverse excursion symmetrically");
assert.equal(shouldStartPostStopObservation("STOP", "2026-08-10T19:00:00Z", "2026-08-10T20:00:00Z"), true, "A stop before session end must start shadow observation");
assert.equal(shouldStartPostStopObservation("STOP", "2026-08-10T20:05:00Z", "2026-08-10T20:00:00Z"), false, "A stale stop after session end must not create an impossible shadow window");
assert.equal(shouldStartPostStopObservation("TARGET", "2026-08-10T19:00:00Z", "2026-08-10T20:00:00Z"), false, "A target exit must not start post-stop observation");
const directBreakoutShadow = evaluateHorizontalBreakoutShadow(
  { direction: "LONG", entry: 100, stop: 96, tp1: 104, tp2: 106, tp3: 108 },
  candle("2026-08-10T10:10:00Z", 101, 106.5, 99, 105)
);
assert.equal(directBreakoutShadow.status, "TP2_HIT", "Direct-breakout shadow must retain each reached target without creating a trade");
assert.equal(directBreakoutShadow.maxFavorableExcursionR, 1.625, "Direct-breakout shadow must measure favorable excursion in initial R");
const ambiguousDirectBreakoutShadow = evaluateHorizontalBreakoutShadow(
  { direction: "LONG", entry: 100, stop: 96, tp1: 104, tp2: 106, tp3: 108 },
  candle("2026-08-10T10:15:00Z", 100, 105, 95, 101)
);
assert.equal(ambiguousDirectBreakoutShadow.status, "STOPPED", "Ambiguous shadow candles must use conservative stop-first ordering");
assert.equal(ambiguousDirectBreakoutShadow.tp1HitAt, null, "A target touched on an ambiguous stop candle must not be credited");
assert.equal(ambiguousDirectBreakoutShadow.maxFavorableExcursionR, 0, "An ambiguous stop-first candle must not receive post-stop favorable excursion credit");

const sampleDatabaseUrl = "postgresql://orb_user:do-not-leak@example.internal:5432/orb_guide";
const redactedCommand = redactSensitiveText(`Command failed: python --database-url ${sampleDatabaseUrl} --tenant-id tenant-1`);
assert.equal(redactedCommand.includes("do-not-leak"), false, "Subprocess errors must redact database passwords");
assert.equal(redactedCommand.includes(sampleDatabaseUrl), false, "Subprocess errors must redact complete database URLs");
assert.deepEqual(
  redactSensitiveValue({ nested: { error: `DATABASE_URL=${sampleDatabaseUrl}` } }, [sampleDatabaseUrl]),
  { nested: { error: "DATABASE_URL=[REDACTED]" } },
  "Operational-event metadata must be redacted recursively"
);

const module1OpeningCandles: Candle[] = [
  candle("2026-08-10T13:30:00Z", 100.0, 100.8, 99.4, 100.5),
  candle("2026-08-10T13:35:00Z", 100.5, 101.0, 99.8, 100.1),
  candle("2026-08-10T13:40:00Z", 100.1, 100.7, 99.6, 100.2)
];
const module1Range = buildOpeningRange(module1OpeningCandles, 0.01, 3);
const module1Signal = candle("2026-08-10T13:45:00Z", 100.8, 101.9, 100.7, 101.55);
const module1 = evaluateSetup({
  now: module1Signal.timestampUtc,
  symbol: "XAUUSD",
  strategyVersionId: "module1-contract",
  session: {
    id: "module1-session",
    symbol: "XAUUSD",
    strategyVersionId: "module1-contract",
    sessionDate: "2026-08-10",
    sessionPreset: "NEW_YORK_ORB",
    state: "OPENING_RANGE_LOCKED",
    sessionStartAt: "2026-08-10T13:30:00Z",
    openingRangeEndAt: "2026-08-10T13:45:00Z",
    signalWindowEndAt: "2026-08-10T20:00:00Z",
    dataStatus: "READY"
  },
  openingRange: module1Range,
  currentCandle: module1Signal,
  previousCandles: [],
  spread: 0.01,
  newsStatus: "CLEAR",
  riskStatus: "PERMITTED",
  configuration: {
    name: "Module 1 ORB",
    version: "module1-contract",
    status: "ACTIVE",
    symbol: "XAUUSD",
    timezone: "America/New_York",
    sessionStart: "09:30",
    openingRangeMinutes: 15,
    signalTimeframeMinutes: 5,
    tradeWindowEnd: "16:00",
    enabledScenarios: { doubleSidedSweep: "BLOCK_CONTINUATION" },
    breakout: {
      requireCompletedCandle: true,
      requireCloseOutside: true,
      allowWickOnly: false,
      minimumBodyRatio: 0.45,
      minimumCloseLocationRatio: 0.65,
      maximumEntryExtensionPercentOfRange: 1
    },
    retest: {
      enabled: true,
      zonePercentOfRange: 0.1,
      maximumCandles: 6,
      confirmationRequired: false
    },
    rangeFilter: {
      mode: "OFF",
      minimumWidth: null,
      maximumWidth: null
    },
    newsFilter: {
      enabled: false,
      mode: "OFF",
      manualEvents: false
    },
    risk: {
      riskPerTradePercent: 1,
      maximumDailyLossPercent: 3,
      maximumWeeklyLossPercent: 6,
      maximumTradesPerSession: 1,
      maximumConsecutiveLosses: 2,
      mandatoryStopLoss: true,
      minimumRewardToRisk: 2,
      allowMartingale: false,
      allowAddingToLoss: false
    },
    favorability: {
      minimumScoreForPaperTrade: 100,
      preferredSpreadPercentOfRange: 0.12,
      minimumAtrPercentOfRange: 0.1
    },
    paperTrading: {
      enabled: true,
      maximumTradesPerSession: 1,
      conservativeSameCandleExit: true
    }
  }
});
const blockedNews = classifyEconomicEvents([
  {
    id: "event-cpi",
    title: "US CPI",
    affected_currency: "USD",
    impact: "HIGH",
    event_time_utc: "2026-08-10T14:00:00Z",
    block_before_minutes: 15,
    block_after_minutes: 15
  }
], "2026-08-10T13:50:00Z");
assert.equal(blockedNews.status, "BLOCKED_BEFORE_EVENT", "High-impact USD events must block inside their pre-event window");
const newsBlockedModule1 = applyModule1NewsGate(module1, blockedNews.status, { enabled: true, mode: "BLOCK" }, blockedNews.reason, blockedNews.activeEvent);
assert.equal(newsBlockedModule1.status, "BLOCKED", "Automatic Module 1 entries must obey the economic-event gate");
assert.equal((newsBlockedModule1.scenarioFlags as any).economicEventGuard.activeEventId, "event-cpi", "Blocked setup must retain event evidence");
const warningNews = classifyEconomicEvents([
  {
    title: "FOMC",
    affected_currency: "USD",
    impact: "HIGH",
    event_time_utc: "2026-08-10T14:40:00Z",
    block_before_minutes: 15,
    block_after_minutes: 15
  }
], "2026-08-10T13:50:00Z");
assert.equal(warningNews.status, "UPCOMING_WARNING", "Events outside the block window but within one hour must warn");
assert.equal(applyModule1NewsGate(module1, warningNews.status, { enabled: true, mode: "BLOCK" }, warningNews.reason).status, module1.status, "Upcoming warnings must not suppress an otherwise valid setup");
const marketChallenger = evaluateModule1MarketChallenger({
  direction: module1.direction,
  scenario: module1.scenario,
  entry: module1.entryPrice,
  target: module1.targetPrice,
  openingRangeWidth: module1Range.width,
  openingRangeMidpoint: module1Range.midpoint,
  candles: [...module1OpeningCandles, module1Signal],
  signalWindowEndAt: "2026-08-10T20:00:00Z",
  timeframeMinutes: 5
});
assert.equal(marketChallenger.mode, "OBSERVE", "Regime challenger must not silently change production entries");
assert.equal(typeof marketChallenger.wouldPass, "boolean", "Regime challenger must emit a deterministic recommendation");
assert.equal(module1Range.status, "LOCKED", "Module 1 opening range must lock from three 5m candles");
assert.equal(isModule1ActiveOrbPreset("NEW_YORK_ORB"), true, "Module 1 must actively evaluate New York ORB");
assert.equal(isModule1ActiveOrbPreset("LONDON_ORB"), true, "Module 1 must support subscriber-selected London ORB");
assert.equal(isModule1ActiveOrbPreset("TOKYO_ORB"), true, "Module 1 must support subscriber-selected Tokyo ORB");
assert.equal(isModule1ActiveOrbPreset("SYDNEY_ORB"), true, "Module 1 must support subscriber-selected Sydney ORB");
assert.equal(isModule1ActiveOrbPreset("UNSUPPORTED_ORB"), false, "Module 1 must reject unsupported session presets");
assert.equal(module1.status, "LONG SETUP READY", `Module 1 should produce a long setup, got ${module1.scenario}: ${module1.finalReason}`);
assert.ok(module1.favorabilityScore < 100, "Module 1 regression setup must remain below the legacy confidence threshold");
assert.equal(module1.scenario.includes("LOW_FAVORABILITY"), false, "Module 1 confidence must not veto a valid strategy profile");
const monitoringBrain = { action: "WAIT", decisionType: "ORB_WAITING_FOR_RULES", severity: "INFO" };
assert.equal(brainRejectsPrediction(monitoringBrain), false, "A nonterminal Python-brain WAIT must not reject an upcoming prediction");
assert.equal(predictionProbability({}, [], 85, false, false, monitoringBrain), 85, "A Python-brain WAIT must not cap 80%+ prediction confidence");
const blockingBrain = { action: "WAIT", decisionType: "ORB_CHECKLIST_MISMATCH", severity: "ERROR" };
assert.equal(brainRejectsPrediction(blockingBrain), true, "A terminal Python-brain safety mismatch must reject prediction promotion");
assert.equal(predictionProbability({}, [], 85, false, false, blockingBrain), 79, "A terminal Python-brain rejection must stay below the visible prediction threshold");
assert.equal((module1.scenarioFlags.matrix as any)?.mandatoryChecklistMatched, true, "Module 1 mandatory checklist must be complete");
assert.equal(module1.scenarioFlags.breakoutAt, module1Signal.timestampUtc, "Module 1 must persist the first candle timestamp for a breakout episode");
assertTradePlan(module1, "LONG", "Module 1");
const orbDetector = new MaxOptionsOrbRangeDetector();
const orbRangeResult = orbDetector.detect({
  symbol: "XAUUSD",
  now: module1Signal.timestampUtc,
  timezone: "America/New_York",
  candles5m: module1OpeningCandles,
  sessionContext: {
    sessionName: "New York",
    sessionTimezone: "America/New_York",
    rangeStart: "2026-08-10T13:30:00Z",
    rangeEnd: "2026-08-10T13:45:00Z",
    signalWindowEnd: "2026-08-10T20:00:00Z"
  },
  activeRanges: [],
  strategyVersion: "module1-contract"
});
assert.equal(orbRangeResult.status, "VALID", "ORB adapter must produce a valid normalized TradingRange");
assert.equal(orbRangeResult.range?.source, "MAX_OPTIONS_NY_ORB", "ORB adapter must preserve time-based ORB source");
assert.equal(orbRangeResult.range?.detectorVersion, "ORB_ADAPTER_V1", "ORB adapter must keep the ORB detector version");
assert.equal(orbRangeResult.range?.high, module1Range.high, "ORB adapter high must match old ORB");
assert.equal(orbRangeResult.range?.low, module1Range.low, "ORB adapter low must match old ORB");
assert.equal(orbRangeResult.range?.midpoint, module1Range.midpoint, "ORB adapter midpoint must match old ORB");
const orbBreakout = evaluateRangeBreakout(orbRangeResult.range!, module1Signal, { source: "MAX_OPTIONS_NY_ORB", requireCompletedCandle: true, requireCloseOutside: true, minimumBodyRatio: 0.45, minimumCloseLocationRatio: 0.6, maximumOppositeWickRatio: 1, minimumBreakDistanceAtr: 0, maximumDirectEntryExtensionRatio: 1, entryModel: "SOURCE_SPECIFIC", stopModel: "SOURCE_SPECIFIC", targetModel: "SOURCE_SPECIFIC" });
assert.equal(orbBreakout.confirmed, true, "Generic breakout engine must confirm the same ORB breakout candle");
const orbDecision = new RangeDecisionEngine().decide({ range: orbRangeResult.range!, breakout: orbBreakout, dataHealthy: true, riskPermitted: true, signalMode: "ACTIVE_SIGNAL" });
assert.equal(orbDecision.status, "BUY_READY", "Generic decision engine must produce BUY_READY for valid ORB long breakout");

const horizontalCandles = [
  candle("2026-08-10T09:00:00Z", 100.0, 101.0, 99.0, 100.2),
  candle("2026-08-10T09:05:00Z", 100.2, 100.8, 99.2, 99.8),
  candle("2026-08-10T09:10:00Z", 99.8, 100.9, 99.1, 100.3),
  candle("2026-08-10T09:15:00Z", 100.3, 100.7, 99.3, 99.9),
  candle("2026-08-10T09:20:00Z", 99.9, 101.1, 99.0, 100.4),
  candle("2026-08-10T09:25:00Z", 100.4, 100.9, 99.2, 99.7),
  candle("2026-08-10T09:30:00Z", 99.7, 100.8, 99.1, 100.1),
  candle("2026-08-10T09:35:00Z", 100.1, 100.7, 99.2, 99.8),
  candle("2026-08-10T09:40:00Z", 99.8, 101.0, 99.0, 100.2),
  candle("2026-08-10T09:45:00Z", 100.2, 100.8, 99.1, 99.9),
  candle("2026-08-10T09:50:00Z", 99.9, 100.9, 99.2, 100.3),
  candle("2026-08-10T09:55:00Z", 100.3, 100.7, 99.1, 99.8)
];
const horizontalConfig = { enabled: true, observationOnly: true, timeframe: "5min" as const, minimumRangeCandles: 12, maximumRangeCandles: 12, minimumUpperTouches: 2, minimumLowerTouches: 2, minimumBarsBetweenTouches: 2, boundaryReactionCount: 3, boundaryToleranceAtr: 0.12, minimumContainmentRatio: 0.7, maximumEfficiencyRatio: 0.4, maximumBoundarySlopeAtrPerBar: 0.2, minimumWidthAtr: 0.5, maximumWidthAtr: 4, minimumMidpointCrosses: 2, minimumQualityScore: 60, lockAfterValidation: true, expireAfterCandles: 60 };
const horizontal = new HorizontalRangeDetector(horizontalConfig).detect({
  symbol: "XAUUSD",
  now: horizontalCandles.at(-1)!.timestampUtc,
  timezone: "America/New_York",
  candles5m: horizontalCandles,
  activeRanges: [],
  strategyVersion: "horizontal-observation"
});
assert.equal(horizontal.status, "VALID", "Horizontal detector must identify valid rectangular consolidation in observation mode");
assert.equal(horizontal.range?.formationMethod, "PRICE_BASED", "Horizontal range must remain price-based");
assert.equal(horizontal.range?.detectorVersion, "HORIZONTAL_RANGE_DETECTOR_V1", "Horizontal range must use the active detector version");
const trendingCandidate = new HorizontalRangeDetector(horizontalConfig).detect({
  symbol: "XAUUSD",
  now: "2026-08-10T10:00:00Z",
  timezone: "America/New_York",
  candles5m: Array.from({ length: 12 }, (_, index) => candle(at("2026-08-10T09:00:00Z", index), 100 + index * 0.4, 100.5 + index * 0.4, 99.8 + index * 0.4, 100.4 + index * 0.4)),
  activeRanges: [],
  strategyVersion: "horizontal-trend-rejection"
});
assert.equal(trendingCandidate.status, "NONE", "Horizontal detector must reject directional trends as non-horizontal structure");
assert.equal(trendingCandidate.evidence.structureClassification, "ASCENDING_CHANNEL", "Rejected trend must be classified instead of silently ignored");
assert.equal(trendingCandidate.failures.length > 0, true, "Rejected horizontal candidates must retain their exact failed detector rules");
const acceptedBreakoutCandidate = new HorizontalRangeDetector(horizontalConfig).detect({
  symbol: "XAUUSD",
  now: "2026-08-10T10:00:00Z",
  timezone: "America/New_York",
  candles5m: [...horizontalCandles.slice(0, 11), candle("2026-08-10T09:55:00Z", 100.3, 102.0, 99.2, 101.8)],
  activeRanges: [],
  strategyVersion: "horizontal-accepted-breakout-rejection"
});
assert.equal(acceptedBreakoutCandidate.status, "NONE", "Horizontal detector must reject ranges that already accepted a breakout close");
assert.equal(acceptedBreakoutCandidate.failures.some((item) => item.ruleCode === "HORIZONTAL_NO_ACCEPTED_BREAKOUT"), true, "Near-candidate evidence must identify an accepted close inside the formation window");
const wickFalseBreak = new FalseBreakoutEngine().evaluate(horizontal.range!, candle("2026-08-10T10:00:00Z", 100.2, horizontal.range!.high + 0.5, 99.8, horizontal.range!.high - 0.1));
assert.equal(wickFalseBreak.falseBreakout, true, "False-breakout engine must reject wick-only boundary breaks");
const retest = new RetestEngine().evaluate(horizontal.range!, "LONG", candle("2026-08-10T10:05:00Z", horizontal.range!.high - 0.1, horizontal.range!.high + 0.8, horizontal.range!.high - 0.2, horizontal.range!.high + 0.5));
assert.equal(retest.confirmed, true, "Retest engine must confirm a clean post-breakout boundary retest");
const expiredRetest = new RetestEngine().evaluate(
  horizontal.range!,
  "LONG",
  candle("2026-08-10T10:40:00Z", horizontal.range!.high + 1.6, horizontal.range!.high + 1.9, horizontal.range!.high + 1.4, horizontal.range!.high + 1.7),
  undefined,
  Array.from({ length: 8 }, (_, index) => candle(at("2026-08-10T10:00:00Z", index), horizontal.range!.high + 1.0, horizontal.range!.high + 1.4, horizontal.range!.high + 0.8, horizontal.range!.high + 1.2))
);
assert.equal(expiredRetest.status, "EXPIRED", "Horizontal breakout retest must expire after the configured candle limit");
const horizontalBreakout = evaluateRangeBreakout(horizontal.range!, candle("2026-08-10T10:05:00Z", horizontal.range!.high - 0.1, horizontal.range!.high + 0.8, horizontal.range!.high - 0.2, horizontal.range!.high + 0.5));
const expiredDecision = new RangeDecisionEngine().decide({ range: horizontal.range!, breakout: { ...horizontalBreakout, directEntryBlocked: true }, retest: expiredRetest, dataHealthy: true, riskPermitted: true, signalMode: "ACTIVE_SIGNAL" });
assert.equal(expiredDecision.status, "EXPIRED", "Expired horizontal retest must stop the MVP entry path");
const horizontalDecision = new RangeDecisionEngine().decide({ range: horizontal.range!, breakout: horizontalBreakout, retest, dataHealthy: true, riskPermitted: true, signalMode: "ACTIVE_SIGNAL" });
assert.equal(horizontalDecision.status, "BUY_READY", "Active horizontal range breakout/retest must be able to trigger the Module 1 MVP chain");
const lifecycleBreakout = candle("2026-08-10T10:00:00Z", horizontal.range!.high - 0.1, horizontal.range!.high + 0.8, horizontal.range!.high - 0.2, horizontal.range!.high + 0.5);
const lifecycleRetest = candle("2026-08-10T10:05:00Z", horizontal.range!.high - 0.05, horizontal.range!.high + 0.7, horizontal.range!.high - 0.15, horizontal.range!.high + 0.55);
const recoveredHorizontal = new HorizontalRangeDetector({ ...horizontalConfig, observationOnly: false }).detect({
  symbol: "XAUUSD",
  now: lifecycleRetest.timestampUtc,
  timezone: "America/New_York",
  candles5m: [...horizontalCandles, lifecycleBreakout, lifecycleRetest],
  activeRanges: [],
  strategyVersion: "horizontal-live-lifecycle"
});
assert.equal(recoveredHorizontal.status, "VALID", "Horizontal detector must recover a locked range after its breakout candle");
assert.equal(recoveredHorizontal.range?.sourceEvidence.endCandleId, horizontalCandles.at(-1)!.timestampUtc, "Recovered range formation must end before the breakout candle");
const recoveredLifecycle = evaluateBreakoutRetestLifecycle(
  recoveredHorizontal.range!,
  [...horizontalCandles, lifecycleBreakout, lifecycleRetest],
  RANGE_BREAKOUT_PROFILES.HORIZONTAL_CONSOLIDATION
);
assert.equal(recoveredLifecycle.breakout?.status, "CONFIRMED", "Recovered horizontal lifecycle must retain the original completed-candle breakout");
assert.equal(recoveredLifecycle.breakoutCandle?.timestampUtc, lifecycleBreakout.timestampUtc, "Horizontal lifecycle must preserve the original breakout timestamp");
assert.equal(recoveredLifecycle.retest?.status, "CONFIRMED", "A later boundary rejection candle must confirm the horizontal retest");
assert.equal(recoveredLifecycle.rangeState, "RETEST_CONFIRMED", "Confirmed breakout and retest must advance the horizontal range lifecycle");
assert.equal(
  new RangeDecisionEngine().decide({ range: { ...recoveredHorizontal.range!, state: recoveredLifecycle.rangeState }, breakout: recoveredLifecycle.breakout, falseBreakout: recoveredLifecycle.falseBreakout, retest: recoveredLifecycle.retest, dataHealthy: true, riskPermitted: true, signalMode: "ACTIVE_SIGNAL" }).status,
  "BUY_READY",
  "Recovered full-session horizontal lifecycle must produce BUY_READY"
);
const module1HorizontalRuntime = buildModule1RangeEngineMetadata(
  {
    id: "module1-horizontal-session",
    symbol: "XAUUSD",
    strategy_version_id: "module1-horizontal-version",
    session_preset: "NEW_YORK_ORB",
    session_start_at: horizontalCandles[0].timestampUtc,
    opening_range_end_at: horizontalCandles[2].timestampUtc,
    signal_window_end_at: "2026-08-10T20:00:00Z",
    data_status: "READY"
  },
  {
    high: module1Range.high,
    low: module1Range.low,
    midpoint: module1Range.midpoint,
    width: module1Range.width,
    module1RangeSessionPreset: "NEW_YORK_ORB",
    module1RangeSessionStartAt: horizontalCandles[0].timestampUtc,
    module1RangeOpeningRangeEndAt: horizontalCandles[2].timestampUtc
  },
  lifecycleRetest,
  [...horizontalCandles, lifecycleBreakout],
  { timezone: "America/New_York", rangeEngine: { horizontalRange: { ...horizontalConfig, observationOnly: false, signalMode: "ACTIVE_SIGNAL" } } }
);
assert.equal(module1HorizontalRuntime.horizontal.signalMode, "ACTIVE_SIGNAL", "Module 1 runtime must expose the horizontal profile as active");
assert.equal(module1HorizontalRuntime.horizontal.decision.status, "BUY_READY", "Module 1 worker wiring must promote a recovered horizontal breakout/retest");
const horizontalSetup = buildHorizontalRangeSetupDecision(module1HorizontalRuntime, lifecycleRetest, { id: "module1-horizontal-session" }) as any;
assert.equal(horizontalSetup.status, "LONG SETUP READY", "Horizontal runtime must produce a complete long setup");
assert.equal(horizontalSetup.scenarioFlags.horizontalRangeSignal.tradePlan.stopDistanceAtr >= 2, true, "Horizontal setup must enforce the shared 2 ATR floor");
assert.equal(horizontalSetup.scenarioFlags.horizontalRangeSignal.tradePlan.liquidityBufferAtr >= 0.25, true, "Horizontal setup must enforce the shared liquidity buffer");
assert.equal(horizontalSetup.stopPrice < horizontalSetup.scenarioFlags.horizontalRangeSignal.tradePlan.structuralInvalidation, true, "Horizontal long stop must sit beyond structural invalidation");
const sellBreakout = candle("2026-08-10T10:00:00Z", horizontal.range!.low + 0.1, horizontal.range!.low + 0.2, horizontal.range!.low - 0.8, horizontal.range!.low - 0.5);
const sellRetest = candle("2026-08-10T10:05:00Z", horizontal.range!.low + 0.05, horizontal.range!.low + 0.15, horizontal.range!.low - 0.7, horizontal.range!.low - 0.55);
const sellLifecycle = evaluateBreakoutRetestLifecycle(horizontal.range!, [...horizontalCandles, sellBreakout, sellRetest], RANGE_BREAKOUT_PROFILES.HORIZONTAL_CONSOLIDATION);
assert.equal(sellLifecycle.breakout?.direction, "SHORT", "Horizontal lifecycle must support downside breakouts");
assert.equal(sellLifecycle.retest?.status, "CONFIRMED", "A later bearish rejection candle must confirm the downside retest");
assert.equal(
  new RangeDecisionEngine().decide({ range: { ...horizontal.range!, state: sellLifecycle.rangeState }, breakout: sellLifecycle.breakout, falseBreakout: sellLifecycle.falseBreakout, retest: sellLifecycle.retest, dataHealthy: true, riskPermitted: true, signalMode: "ACTIVE_SIGNAL" }).status,
  "SELL_READY",
  "Recovered full-session horizontal lifecycle must produce SELL_READY"
);
const conflict = new RangeConflictResolver().resolve([orbRangeResult.range!, horizontal.range!], "LONG");
assert.notEqual(conflict.status, "CONFLICT", "Aligned/same-direction range evidence must not block ORB");
const oppositeHorizontal = { ...horizontal.range!, id: `${horizontal.range!.id}:opposite`, breakoutDirection: "SHORT" as const };
const oppositeConflict = new RangeConflictResolver().resolve([{ ...horizontal.range!, breakoutDirection: "LONG" as const }, oppositeHorizontal], "LONG");
assert.equal(oppositeConflict.status, "CONFLICT", "Opposite-direction locked horizontal ranges must block duplicate MVP entries");

const module2Candles: Candle[] = Array.from({ length: 24 }, (_, index) => {
  const base = 103.6 + Math.sin(index / 2) * 0.35;
  return candle(at("2026-08-10T11:30:00Z", index), base, index === 10 ? 105 : base + 0.45, index === 18 ? 102.5 : base - 0.45, base + (index % 2 === 0 ? 0.12 : -0.12));
});
module2Candles.push(
  candle("2026-08-10T13:30:00Z", 104.6, 105.6, 103.8, 104.7),
  candle("2026-08-10T13:35:00Z", 104.6, 104.7, 102, 102.2),
  candle("2026-08-10T13:40:00Z", 102.1, 103.4, 101.8, 102.4),
  candle("2026-08-10T13:45:00Z", 103.3, 103.6, 102.7, 102.6)
);

const module2 = evaluateLiquiditySweepSetup({
  now: module2Candles.at(-1)!.timestampUtc,
  symbol: "XAUUSD",
  setupCandles: module2Candles,
  biasCandles: Array.from({ length: 30 }, (_, index) => candle(at("2026-08-10T06:00:00Z", index, 15), 110 - index * 0.2, 110.3 - index * 0.2, 109.5 - index * 0.2, 109.7 - index * 0.2)),
  spread: 0.01,
  newsStatus: "CLEAR",
  configuration: {
    minimumSweepDistanceATR: 0.05,
    maximumSweepDistanceATR: 2,
    minimumDisplacementRangeATR: 0.8,
    minimumBodyPercentage: 0.55,
    minimumBosCloseDistanceATR: 0,
    minimumFvgSizeATR: 0.05,
    minimumRiskReward: 0.01,
    maximumStopATR: 10,
    minimumSignalScore: 0,
    requireHtfBias: false
  }
});
assert.ok(["LONG SETUP READY", "SHORT SETUP READY"].includes(module2.status), `Module 2 should produce a selected-variant setup, got ${module2.scenario}: ${module2.finalReason}`);
assert.equal(module2.scenarioFlags.mandatoryChecklistMatched, true, "Module 2 mandatory sequence must be complete");
assert.equal(Boolean((module2.scenarioFlags.sweep as any)?.level), true, "Module 2 must retain swept liquidity evidence");
assert.equal(Boolean((module2.scenarioFlags.module2Variant as any)?.paperEligible), true, "Module 2 must select one paper-approved variant");
assert.equal((module2.scenarioFlags.module2Variant as any)?.approvalStatus, "PRODUCTION_APPROVED", "Live Module 2 must select only a production-approved variant");
assert.ok(
  Number((module2.scenarioFlags.confirmationLayer as any)?.count) >= Number((module2.scenarioFlags.confirmationLayer as any)?.productionRequired),
  "Live Module 2 must satisfy the production confirmation floor"
);
const module2Plan = module2.scenarioFlags.tradePlan as any;
const module2PlanCandidates = module2.scenarioFlags.tradePlanCandidates as any[];
assert.ok(module2Plan?.source, "Module 2 must expose the selected structural trade-plan source");
assert.ok(Array.isArray(module2PlanCandidates) && module2PlanCandidates.length >= 1, "Module 2 must retain ranked trade-plan candidates for audit");
assert.equal(module2PlanCandidates[0]?.source, module2Plan.source, "Module 2 must select the highest-ranked structural trade plan");
assert.ok(module2PlanCandidates.some((candidate) => candidate.source === "SWEEP_INVALIDATION"), "Module 2 must retain conservative sweep invalidation as a fallback");
assert.ok(module2PlanCandidates.filter((candidate) => candidate.riskApproved).every((candidate) => candidate.geometryValid && candidate.stopValid), "Every risk-approved Module 2 candidate must have valid geometry and stop size");
assert.ok(module2PlanCandidates.every((candidate) => candidate.stopDistanceAtr >= 1 - Number.EPSILON), "Every Module 2 stop must cover at least one 5-minute ATR");
assert.ok(
  module2PlanCandidates.every((candidate) => module2.direction === "LONG" ? candidate.stop <= candidate.structuralStop : candidate.stop >= candidate.structuralStop),
  "The volatility floor must never weaken structural invalidation"
);
assert.ok(
  new Date((module2.scenarioFlags.sweep as any).sweptAt).getTime() >= new Date((module2.scenarioFlags.sweep as any).level.confirmedAt).getTime(),
  "Module 2 must never use a sweep that occurred before its liquidity level was confirmed"
);
assertTradePlan(module2, module2.direction as "LONG" | "SHORT", "Module 2");
const module2BelowPredictionThreshold = evaluateLiquiditySweepSetup({
  now: module2Candles.at(-1)!.timestampUtc,
  symbol: "XAUUSD",
  setupCandles: module2Candles,
  biasCandles: Array.from({ length: 30 }, (_, index) => candle(at("2026-08-10T06:00:00Z", index, 15), 110 - index * 0.2, 110.3 - index * 0.2, 109.5 - index * 0.2, 109.7 - index * 0.2)),
  spread: 0.01,
  newsStatus: "CLEAR",
  configuration: {
    minimumSweepDistanceATR: 0.05,
    maximumSweepDistanceATR: 2,
    minimumDisplacementRangeATR: 0.8,
    minimumBodyPercentage: 0.55,
    minimumBosCloseDistanceATR: 0,
    minimumFvgSizeATR: 0.05,
    minimumRiskReward: 0.01,
    maximumStopATR: 10,
    minimumSignalScore: 110,
    requireHtfBias: false
  }
});
assert.ok(["LONG SETUP READY", "SHORT SETUP READY"].includes(module2BelowPredictionThreshold.status), "A risk-approved independent Module 2 variant must not be vetoed by the prediction score threshold");
const predictionScoreRule = module2BelowPredictionThreshold.evaluations.find((row) => row.ruleCode === "SIGNAL_SCORE");
assert.equal(predictionScoreRule?.status, "FAIL", "The below-threshold setup must remain excluded from 80%+ predictions");
assert.equal(predictionScoreRule?.blocking, false, "Prediction confidence must remain advisory for BUY/SELL promotion");
assert.equal(module2BelowPredictionThreshold.scenarioFlags.mandatoryChecklistMatched, true, "Prediction score must not invalidate a completed Module 2 strategy and risk contract");
assert.equal(validTradeGeometry("LONG", 100, 101, 102), false, "Module 2 must reject a LONG stop above entry");
assert.equal(validTradeGeometry("SHORT", 100, 99, 98), false, "Module 2 must reject a SHORT stop below entry");
assert.equal(validTradeGeometry("LONG", 100, 99, 102), true, "Module 2 must accept valid LONG geometry");
assert.equal(validTradeGeometry("SHORT", 100, 101, 98), true, "Module 2 must accept valid SHORT geometry");
const module2WithActivePaperTrade = evaluateLiquiditySweepSetup({
  now: module2Candles.at(-1)!.timestampUtc,
  symbol: "XAUUSD",
  setupCandles: module2Candles,
  biasCandles: Array.from({ length: 30 }, (_, index) => candle(at("2026-08-10T06:00:00Z", index, 15), 110 - index * 0.2, 110.3 - index * 0.2, 109.5 - index * 0.2, 109.7 - index * 0.2)),
  spread: 0.01,
  newsStatus: "CLEAR",
  currentOpenPositions: 2,
  configuration: {
    minimumSweepDistanceATR: 0.05,
    maximumSweepDistanceATR: 2,
    minimumDisplacementRangeATR: 0.8,
    minimumBodyPercentage: 0.55,
    minimumBosCloseDistanceATR: 0,
    minimumFvgSizeATR: 0.05,
    minimumRiskReward: 0.01,
    maximumStopATR: 10,
    minimumSignalScore: 0,
    requireHtfBias: false
  }
});
assert.ok(["LONG SETUP READY", "SHORT SETUP READY"].includes(module2WithActivePaperTrade.status), "An active paper trade must not hide a distinct valid Module 2 BUY/SELL signal");
assert.equal(module2WithActivePaperTrade.scenarioFlags.paperTrackingEligible, false, "An active paper trade must suppress only the duplicate paper-tracking row");
const module2OutsideNy = evaluateLiquiditySweepSetup({
  now: "2026-08-10T13:25:00Z",
  symbol: "XAUUSD",
  setupCandles: module2Candles.filter((row) => row.timestampUtc <= "2026-08-10T13:25:00Z"),
  biasCandles: [],
  configuration: { requireHtfBias: false }
});
assert.equal(module2OutsideNy.scenario, "SESSION_INACTIVE", "Module 2 must not evaluate entry profiles before the New York window");

assert.equal(calculateCatchupRequestCount({ latestAt: null, now: Date.now(), timeframeMinutes: 5, startupBackfillCount: 2016, firstWorkerSync: true }), 2016);
assert.equal(calculateCatchupRequestCount({ latestAt: 0, now: 5 * 60_000, timeframeMinutes: 5, startupBackfillCount: 2016, firstWorkerSync: false }), 8);
assert.equal(calculateCatchupRequestCount({ latestAt: 0, now: 10 * 60 * 60_000, timeframeMinutes: 5, startupBackfillCount: 2016, firstWorkerSync: false }), 122);
assert.equal(isNewYorkWeekend("2026-08-08"), true, "Saturday must block shared polling and live strategy evaluation");
assert.equal(isNewYorkWeekend("2026-08-09"), true, "Sunday must block shared polling and live strategy evaluation");
assert.equal(isNewYorkWeekend("2026-08-10"), false, "Monday must remain eligible");
assert.equal(isScheduledTwelveDataTrigger("MARKET_DATA_WORKER"), true);
assert.equal(isScheduledTwelveDataTrigger("MARKET_DATA_CATCH_UP"), true);
assert.equal(isScheduledTwelveDataTrigger("TENANT_CHART_SYNC"), false, "Chart refresh must never call Twelve Data");
assert.equal(isScheduledTwelveDataTrigger("TENANT_BACKFILL"), false, "Tenant readiness must never call Twelve Data");
const summerFeedWindow = sharedNewYorkFeedWindow("2026-08-10");
assert.equal(summerFeedWindow.startAt, "2026-08-10T13:30:00.000Z", "Shared live polling starts at 09:30 New York");
assert.equal(summerFeedWindow.endAt, "2026-08-10T20:00:00.000Z", "Shared live polling ends at 16:00 New York");
const longTargets = buildPaperTargetPlan(100, 95, 110, "LONG");
assert.deepEqual(longTargets.map((target) => target.price), [105, 107.5, 110], "LONG paper milestones must be 1R, 1.5R, and the strategy target");
const shortTargets = buildPaperTargetPlan(100, 105, 90, "SHORT");
assert.deepEqual(shortTargets.map((target) => target.price), [95, 92.5, 90], "SHORT paper milestones must be 1R, 1.5R, and the strategy target");
assert.deepEqual(buildPaperTargetPlan(100, 101, 110, "LONG"), [], "Invalid LONG stop geometry must not produce target milestones");
const buyQuality = evaluateSignalGeometryQuality({ direction: "LONG", entry: 4385, stop: 4384, target: 4387, pipSize: 0.01, minimumTp1Pips: 100, minimumFinalRewardToRisk: 2 });
assert.equal(buyQuality.passed, true, "A BUY with a 100-pip TP1 and 2R final target must pass signal geometry quality");
const sellQuality = evaluateSignalGeometryQuality({ direction: "SHORT", entry: 4385, stop: 4397, target: 4361, pipSize: 0.01, minimumTp1Pips: 100, minimumFinalRewardToRisk: 2 });
assert.equal(sellQuality.passed, true, "A structurally valid SELL with TP1 beyond 100 pips and a 2R final target must pass");
const undersizedQuality = evaluateSignalGeometryQuality({ direction: "SHORT", entry: 4386.6, stop: 4387.42, target: 4384.96, pipSize: 0.01, minimumTp1Pips: 100, minimumFinalRewardToRisk: 2 });
const freshExecution = evaluateSignalExecutionQuality({ direction: "LONG", entry: 4385, stop: 4380, currentPrice: 4386, evidenceScore: 88, maximumEntryChaseR: 0.35, maximumEntryDriftR: 0.5 });
assert.equal(freshExecution.passed, true, "A live price 0.20R beyond entry remains executable");
const chasedExecution = evaluateSignalExecutionQuality({ direction: "LONG", entry: 4385, stop: 4380, currentPrice: 4387, evidenceScore: 92, maximumEntryChaseR: 0.35, maximumEntryDriftR: 0.5 });
assert.equal(chasedExecution.passed, false, "A high score must not permit a signal chased beyond the entry limit");
assert.equal(signalsAreCorrelated(
  { direction: "LONG", entry: 4385, riskDistance: 5, signalAt: "2026-08-20T14:00:00Z" },
  { direction: "LONG", entry: 4386, riskDistance: 4, signalAt: "2026-08-20T14:20:00Z" },
  30,
  0.5
), true, "Near-simultaneous Module 1 and Module 2 exposure must be recognized as correlated");
assert.equal(signalsAreCorrelated(
  { direction: "LONG", entry: 4385, riskDistance: 5, signalAt: "2026-08-20T14:00:00Z" },
  { direction: "SHORT", entry: 4386, riskDistance: 4, signalAt: "2026-08-20T14:20:00Z" },
  30,
  0.5
), false, "Opposite-direction contracts are not duplicate exposure");
assert.equal(undersizedQuality.passed, false, "A signal with TP1 below 100 XAUUSD pips must be rejected even when its final target is 2R");
const pendingLongTargets: PaperTarget[] = longTargets.map((target) => ({
  target_number: target.targetNumber,
  price: target.price,
  risk_multiple: target.riskMultiple,
  position_fraction: target.positionFraction,
  status: "PENDING"
}));
const progressTouch = paperTargetTouches({ direction: "LONG", actual_stop: 95 }, pendingLongTargets, { high: 108, low: 99 });
assert.deepEqual(progressTouch.pendingHit.map((target) => target.target_number), [1, 2], "A completed candle may advance multiple reached milestones");
const tp1ManagedStop = paperManagedStop({ direction: "LONG", entry: 100, structuralStop: 95, currentStop: 95, tp1Hit: true, tp2Hit: false, managementPolicy: PAPER_MANAGEMENT_POLICY_V2 });
assert.equal(tp1ManagedStop.stop, 98.75, "TP1 must leave a 0.25R retest buffer beyond entry");
assert.equal(tp1ManagedStop.stage, "TP1_BUFFERED");
assert.equal(PAPER_MANAGEMENT_POLICY_PRODUCTION, PAPER_MANAGEMENT_POLICY_V3, "Production paper management must delay breakeven until TP2");
assert.equal(
  new Date(paperReplayCursor("2026-09-08T14:00:00.000Z", "2026-09-08T18:45:00.000Z")).toISOString(),
  "2026-09-08T18:45:00.000Z",
  "Ledger catch-up must resume after the latest evaluated candle instead of replaying old candles with a newer stop"
);
assert.equal(
  new Date(paperReplayCursor("2026-09-08T14:00:00.000Z", null)).toISOString(),
  "2026-09-08T14:00:00.000Z",
  "A never-evaluated trade must begin catch-up after its entry candle"
);
const productionManagedStop = paperManagedStop({ direction: "LONG", entry: 100, structuralStop: 95, currentStop: 95, tp1Hit: true, tp2Hit: false });
assert.equal(productionManagedStop.stop, 95, "The default production policy must retain the structural stop after TP1");
assert.equal(productionManagedStop.stage, "STRUCTURAL", "The default production TP1 stage must remain structural");
assert.equal(paperTargetTouches({ direction: "LONG", actual_stop: productionManagedStop.stop }, pendingLongTargets, { high: 108, low: 100 }).stopHit, false, "An entry retest after TP1 must not close the V3 runner");
const productionTp2ManagedStop = paperManagedStop({ direction: "LONG", entry: 100, structuralStop: 95, currentStop: 95, tp1Hit: true, tp2Hit: true });
assert.equal(productionTp2ManagedStop.stop, 100, "The default production policy must move the runner to exact breakeven after TP2");
assert.equal(productionTp2ManagedStop.stage, "BREAKEVEN", "The default production TP2 stage must be breakeven");
const productionTp2Settlement = paperSettlement(
  { direction: "LONG", actual_entry: 100, actual_stop: 100, structural_stop: 95, initial_risk_distance: 5 },
  pendingLongTargets.map((target, index) => ({
    ...target,
    status: index < 2 ? ("HIT" as const) : ("PENDING" as const),
    realized_r: index < 2 ? target.risk_multiple * target.position_fraction : null
  })),
  100
);
assert.equal(productionTp2Settlement.resultR, 0.8333, "TP2 followed by an entry retest must preserve both booked partial profits");
const productionShortTp1Stop = paperManagedStop({ direction: "SHORT", entry: 100, structuralStop: 105, currentStop: 105, tp1Hit: true, tp2Hit: false });
assert.equal(productionShortTp1Stop.stop, 105, "A SHORT runner must also retain its structural stop after TP1");
assert.equal(paperTargetTouches({ direction: "SHORT", actual_stop: productionShortTp1Stop.stop }, [], { high: 100, low: 96 }).stopHit, false, "A SHORT entry retest after TP1 must remain open under V3");
assert.equal(paperTargetManagementSummary(1, PAPER_MANAGEMENT_POLICY_V1), "The remaining runner is now protected at exact breakeven.", "V1 TP1 notification must describe exact breakeven");
assert.equal(paperTargetManagementSummary(1, PAPER_MANAGEMENT_POLICY_V2).includes("0.25R retest buffer"), true, "V2 TP1 notification must describe its versioned buffer");
assert.equal(paperTargetManagementSummary(1, PAPER_MANAGEMENT_POLICY_V3).includes("structural stop until TP2"), true, "V3 TP1 notification must describe delayed breakeven");
assert.equal(paperTargetTouches({ direction: "LONG", actual_stop: tp1ManagedStop.stop }, pendingLongTargets, { high: 104, low: 99 }).stopHit, false, "A normal entry retest must not stop a TP1 runner");
const tp1OnlyTargets = pendingLongTargets.map((target, index) => ({
  ...target,
  status: index === 0 ? ("HIT" as const) : ("PENDING" as const),
  realized_r: index === 0 ? target.risk_multiple * target.position_fraction : null
}));
const bufferedSettlement = paperSettlement(
  { direction: "LONG", actual_entry: 100, actual_stop: tp1ManagedStop.stop, structural_stop: 95, initial_risk_distance: 5 },
  tp1OnlyTargets,
  tp1ManagedStop.stop
);
assert.equal(bufferedSettlement.outcome, "WIN", "TP1 profit must outweigh the buffered runner exit");
assert.equal(bufferedSettlement.resultR, 0.1667, "TP1 plus a -0.25R runner exit must retain about +0.17R overall");
const tp2ManagedStop = paperManagedStop({ direction: "LONG", entry: 100, structuralStop: 95, currentStop: tp1ManagedStop.stop, tp1Hit: true, tp2Hit: true, managementPolicy: PAPER_MANAGEMENT_POLICY_V2 });
assert.equal(tp2ManagedStop.stop, 100, "TP2 must activate true breakeven");
pendingLongTargets[0].status = "HIT";
pendingLongTargets[1].status = "HIT";
pendingLongTargets[0].realized_r = pendingLongTargets[0].risk_multiple * pendingLongTargets[0].position_fraction;
pendingLongTargets[1].realized_r = pendingLongTargets[1].risk_multiple * pendingLongTargets[1].position_fraction;
const longFinalTouch = paperTargetTouches({ direction: "LONG", actual_stop: 95 }, pendingLongTargets, { high: 111, low: 99 });
assert.deepEqual(longFinalTouch.pendingHit.map((target) => target.target_number), [3], "LONG sequence must leave only TP3 pending after TP1 and TP2");
const longStopAfterProgress = paperTargetTouches({ direction: "LONG", actual_stop: 100, structural_stop: 95 }, pendingLongTargets, { high: 104, low: 99 });
assert.equal(longStopAfterProgress.stopHit, true, "A LONG runner at true breakeven must stop when entry is revisited after TP2");
const protectedLongSettlement = paperSettlement(
  { direction: "LONG", actual_entry: 100, actual_stop: 100, structural_stop: 95, initial_risk_distance: 5 },
  pendingLongTargets,
  100
);
assert.equal(protectedLongSettlement.outcome, "WIN", "TP1 and TP2 realized profit must keep a breakeven runner close classified as a win");
assert.equal(protectedLongSettlement.resultR, 0.8333, "Equal-third TP1 + TP2 + breakeven runner must settle near +0.83R");
const pendingShortTargets: PaperTarget[] = shortTargets.map((target) => ({
  target_number: target.targetNumber,
  price: target.price,
  risk_multiple: target.riskMultiple,
  position_fraction: target.positionFraction,
  status: "PENDING"
}));
const shortProgressTouch = paperTargetTouches({ direction: "SHORT", actual_stop: 105 }, pendingShortTargets, { high: 101, low: 92 });
assert.deepEqual(shortProgressTouch.pendingHit.map((target) => target.target_number), [1, 2], "SHORT sequence must recognize TP1 and TP2 in descending price order");
pendingShortTargets[0].status = "HIT";
pendingShortTargets[1].status = "HIT";
pendingShortTargets[0].realized_r = pendingShortTargets[0].risk_multiple * pendingShortTargets[0].position_fraction;
pendingShortTargets[1].realized_r = pendingShortTargets[1].risk_multiple * pendingShortTargets[1].position_fraction;
const shortFinalTouch = paperTargetTouches({ direction: "SHORT", actual_stop: 105 }, pendingShortTargets, { high: 101, low: 89 });
assert.deepEqual(shortFinalTouch.pendingHit.map((target) => target.target_number), [3], "SHORT sequence must leave only TP3 pending after TP1 and TP2");
const ambiguousTargets: PaperTarget[] = longTargets.map((target) => ({
  target_number: target.targetNumber,
  price: target.price,
  risk_multiple: target.riskMultiple,
  position_fraction: target.positionFraction,
  status: "PENDING"
}));
const ambiguousTouch = paperTargetTouches({ direction: "LONG", actual_stop: 95 }, ambiguousTargets, { high: 106, low: 94 });
assert.equal(ambiguousTouch.stopHit, true);
assert.equal(ambiguousTouch.ambiguous, true, "A candle touching stop and target must use the conservative stop-first policy");
const untouchedStop = paperSettlement(
  { direction: "LONG", actual_entry: 100, actual_stop: 95, structural_stop: 95, initial_risk_distance: 5 },
  ambiguousTargets,
  95
);
assert.equal(untouchedStop.resultR, -1, "A structural stop before any partial target remains a full -1R loss");
const completedTargets = pendingLongTargets.map((target) => ({
  ...target,
  status: "HIT" as const,
  realized_r: target.risk_multiple * target.position_fraction
}));
assert.equal(
  paperSettlement({ direction: "LONG", actual_entry: 100, structural_stop: 95, initial_risk_distance: 5 }, completedTargets, 110).resultR,
  1.5,
  "A complete equal-third 1R/1.5R/2R ladder must settle at +1.50R"
);
console.log(JSON.stringify({
  status: "PASS",
  module1: { scenario: module1.scenario, direction: module1.direction, score: module1.favorabilityScore },
  module2: { scenario: module2.scenario, direction: module2.direction, score: module2.favorabilityScore },
  catchup: "startup=2016, 5-minute gap=8, 10-hour gap=122",
  paperTargets: "PASS"
}, null, 2));

function candle(timestampUtc: string, open: number, high: number, low: number, close: number): Candle {
  return { timestampUtc, open, high, low, close, volume: 100, spread: 0.2 };
}

function at(start: string, index: number, timeframeMinutes = 5) {
  return new Date(new Date(start).getTime() + index * timeframeMinutes * 60_000).toISOString();
}

function assertTradePlan(decision: any, direction: "LONG" | "SHORT", moduleName: string) {
  assert.equal(decision.direction, direction, `${moduleName} direction`);
  assert.equal(Number.isFinite(decision.entryPrice), true, `${moduleName} entry`);
  assert.equal(Number.isFinite(decision.stopPrice), true, `${moduleName} stop`);
  assert.equal(Number.isFinite(decision.targetPrice), true, `${moduleName} target`);
  if (direction === "LONG") {
    assert.equal(decision.stopPrice < decision.entryPrice, true, `${moduleName} long stop below entry`);
    assert.equal(decision.targetPrice > decision.entryPrice, true, `${moduleName} long target above entry`);
  } else {
    assert.equal(decision.stopPrice > decision.entryPrice, true, `${moduleName} short stop above entry`);
    assert.equal(decision.targetPrice < decision.entryPrice, true, `${moduleName} short target below entry`);
  }
}
