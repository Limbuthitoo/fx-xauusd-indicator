export type SessionState =
  | "SESSION_NOT_STARTED"
  | "PRE_SESSION"
  | "OPENING_RANGE_FORMING"
  | "OPENING_RANGE_LOCKED"
  | "WAITING_FOR_SETUP"
  | "BREAKOUT_CANDIDATE"
  | "WAITING_FOR_RETEST"
  | "REVERSAL_CANDIDATE"
  | "SETUP_READY"
  | "TRADE_PLANNED"
  | "TRADE_ACTIVE"
  | "TRADE_CLOSED"
  | "NO_TRADE"
  | "SESSION_EXPIRED"
  | "SESSION_COMPLETED";

export type RuleStatus = "PASS" | "FAIL" | "WAITING" | "NOT_APPLICABLE";
export type Direction = "LONG" | "SHORT";
export type NewsStatus = "CLEAR" | "UPCOMING_WARNING" | "BLOCKED_BEFORE_EVENT" | "BLOCKED_AFTER_EVENT" | "MANUAL_OVERRIDE";
export type RiskPermissionStatus = "PERMITTED" | "WARNING" | "BLOCKED";

export interface Candle {
  timestampUtc: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
  spread?: number | null;
}

export interface OpeningRange {
  status: "FORMING" | "LOCKED" | "INVALID";
  high: number | null;
  low: number | null;
  midpoint: number | null;
  width: number | null;
  widthTicks: number | null;
  widthAtrPercent?: number | null;
  sourceCandleCount: number;
  dataQualityStatus: string;
  invalidReason?: string | null;
  lockedAt?: string | null;
}

export interface TradingSession {
  id?: string;
  symbol: string;
  strategyVersionId: string;
  sessionDate: string;
  sessionPreset: string;
  state: SessionState;
  sessionStartAt: string;
  openingRangeEndAt: string;
  signalWindowEndAt: string;
  dataStatus: string;
}

export interface RuleEvaluation {
  ruleCode: string;
  name: string;
  status: RuleStatus;
  blocking: boolean;
  source: "AUTOMATIC" | "MANUAL";
  ruleLayer?: "STATE" | "MANDATORY" | "CONFIRMATION" | "QUALITY" | "FINAL" | "EVIDENCE";
  requiredForEntry?: boolean;
  actualValue?: string | number | boolean | null;
  requiredValue?: string | number | boolean | null;
  explanation: string;
}

export interface RuleContext {
  now: string;
  symbol: string;
  strategyVersionId: string;
  session: TradingSession;
  openingRange: OpeningRange;
  currentCandle: Candle;
  previousCandles: Candle[];
  spread?: number;
  newsStatus: NewsStatus;
  riskStatus: RiskPermissionStatus;
  configuration: StrategyConfiguration;
}

export interface StrategyConfiguration {
  name: string;
  version: string;
  status: string;
  symbol: string;
  timezone: string;
  sessionStart: string;
  openingRangeMinutes: number;
  signalTimeframeMinutes: number;
  tradeWindowEnd: string;
  enabledScenarios: Record<string, unknown>;
  breakout: {
    requireCompletedCandle: boolean;
    requireCloseOutside: boolean;
    allowWickOnly: boolean;
    minimumBodyRatio: number;
    minimumCloseLocationRatio: number;
    maximumEntryExtensionPercentOfRange: number;
  };
  retest: {
    enabled: boolean;
    zonePercentOfRange: number;
    maximumCandles: number;
    confirmationRequired: boolean;
  };
  rangeFilter: {
    mode: "OFF" | "WARN_ONLY" | "BLOCK";
    minimumWidth: number | null;
    maximumWidth: number | null;
  };
  newsFilter: {
    enabled: boolean;
    mode: "OFF" | "WARN_ONLY" | "BLOCK";
    manualEvents: boolean;
  };
  risk: {
    riskPerTradePercent: number;
    maximumDailyLossPercent: number;
    maximumWeeklyLossPercent: number;
    maximumTradesPerSession: number;
    maximumConsecutiveLosses: number;
    mandatoryStopLoss: boolean;
    minimumRewardToRisk: number;
    allowMartingale: boolean;
    allowAddingToLoss: boolean;
  };
  favorability?: {
    minimumScoreForPaperTrade?: number;
    minimumTrendLookbackCandles?: number;
    preferredSpreadPercentOfRange?: number;
    minimumAtrPercentOfRange?: number;
  };
  paperTrading?: {
    enabled?: boolean;
    maximumTradesPerSession?: number;
    conservativeSameCandleExit?: boolean;
  };
}

export interface SetupDecision {
  scenario: string;
  direction: Direction | null;
  status:
    | "WAIT"
    | "POTENTIAL LONG"
    | "POTENTIAL SHORT"
    | "WAIT FOR RETEST"
    | "LONG SETUP READY"
    | "SHORT SETUP READY"
    | "REVERSAL CANDIDATE"
    | "NO TRADE"
    | "BLOCKED"
    | "EXPIRED";
  entryPrice?: number;
  stopPrice?: number;
  targetPrice?: number;
  finalReason: string;
  evaluations: RuleEvaluation[];
  scenarioFlags: Record<string, unknown>;
  favorabilityScore: number;
  favorabilityGrade: "A" | "B" | "C" | "D";
  favorabilityReasons: string[];
}

export interface RiskInput {
  accountBalance: number;
  accountEquity: number;
  riskPerTradePercent: number;
  entry: number;
  stop: number;
  target: number;
  contractSize: number;
  tickSize: number;
  tickValue: number;
  minimumLot: number;
  lotStep: number;
  maximumLot: number;
  spread: number;
  commissionPerLot: number;
  minimumRewardToRisk: number;
  existingDailyLossPercent?: number;
  existingWeeklyLossPercent?: number;
  maximumDailyLossPercent?: number;
  maximumWeeklyLossPercent?: number;
}

export interface RiskResult {
  plannedRiskAmount: number;
  stopDistance: number;
  suggestedLotSize: number;
  estimatedSpreadCost: number;
  estimatedCommission: number;
  targetReward: number;
  rewardToRisk: number;
  maximumPossibleLoss: number;
  status: RiskPermissionStatus;
  reasons: string[];
}
