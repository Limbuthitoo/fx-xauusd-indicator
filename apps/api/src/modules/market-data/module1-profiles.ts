import { zonedDateTimeToUtc } from "../../infrastructure/time.js";

export const MODULE1_PROFILE_MODES = ["ORB_AND_HORIZONTAL", "ORB_ONLY", "HORIZONTAL_ONLY"] as const;
export type Module1ProfileMode = typeof MODULE1_PROFILE_MODES[number];
export type Module1StrategyProfile = "ORB_BREAKOUT" | "HORIZONTAL_RANGE_BREAKOUT";

export type Module1ProfilePolicy = {
  mode: Module1ProfileMode;
  profile: Module1StrategyProfile;
  enabled: boolean;
  eligible: boolean;
  maximumSignalsPerDay: number;
  windowStartAt: string;
  windowEndAt: string;
  reason: string;
};

type ProfilePolicyInput = {
  configuration?: Record<string, any> | null;
  session: {
    session_date?: string | Date;
    session_preset?: string;
    opening_range_end_at: string | Date;
    signal_window_end_at: string | Date;
  };
  timestamp: string | Date;
  profile: Module1StrategyProfile;
};

export function normalizeModule1ProfileMode(value: unknown): Module1ProfileMode {
  const mode = String(value ?? "ORB_AND_HORIZONTAL").toUpperCase();
  return MODULE1_PROFILE_MODES.includes(mode as Module1ProfileMode)
    ? mode as Module1ProfileMode
    : "ORB_AND_HORIZONTAL";
}

export function module1StrategyProfile(value: { strategy_profile?: unknown; scenario?: unknown } | null | undefined): Module1StrategyProfile {
  const persisted = String(value?.strategy_profile ?? "").toUpperCase();
  if (persisted === "HORIZONTAL_RANGE_BREAKOUT") return "HORIZONTAL_RANGE_BREAKOUT";
  if (persisted === "ORB_BREAKOUT") return "ORB_BREAKOUT";
  return String(value?.scenario ?? "").toUpperCase().includes("HORIZONTAL")
    ? "HORIZONTAL_RANGE_BREAKOUT"
    : "ORB_BREAKOUT";
}

export function resolveModule1ProfilePolicy(input: ProfilePolicyInput): Module1ProfilePolicy {
  const configuration = input.configuration ?? {};
  const tradeSetup = objectRecord(configuration.tradeSetup);
  const strategyProfiles = objectRecord(configuration.strategyProfiles);
  const orbProfile = objectRecord(strategyProfiles.orb);
  const horizontalProfile = objectRecord(strategyProfiles.horizontal);
  const mode = normalizeModule1ProfileMode(tradeSetup.profileMode);
  const timestamp = new Date(input.timestamp);
  const sessionDate = isoDateValue(input.session.session_date);
  const sessionStart = new Date(input.session.opening_range_end_at);
  const sessionEnd = new Date(input.session.signal_window_end_at);
  const isNewYork = ["NEW_YORK_ORB", "NY_0915", "NY_0930"].includes(String(input.session.session_preset));

  if (input.profile === "ORB_BREAKOUT") {
    const configuredEnd = timeValue(orbProfile.signalWindowEnd, "11:00");
    const windowEnd = sessionDate ? zonedDateTimeToUtc(sessionDate, configuredEnd, "America/New_York") : sessionEnd;
    const enabled = mode !== "HORIZONTAL_ONLY" && orbProfile.enabled !== false;
    const eligible = enabled && timestamp >= sessionStart && timestamp < windowEnd && timestamp < sessionEnd;
    return {
      mode,
      profile: input.profile,
      enabled,
      eligible,
      maximumSignalsPerDay: boundedInteger(orbProfile.maximumSignalsPerDay, 1, 2),
      windowStartAt: sessionStart.toISOString(),
      windowEndAt: windowEnd.toISOString(),
      reason: !enabled
        ? "ORB signals are disabled by the selected Module 1 profile mode."
        : eligible
          ? `ORB owns the opening signal window until ${configuredEnd} New York.`
          : `ORB signal eligibility ended at ${configuredEnd} New York.`
    };
  }

  const configuredStart = timeValue(horizontalProfile.signalWindowStart, "11:00");
  const windowStart = sessionDate ? zonedDateTimeToUtc(sessionDate, configuredStart, "America/New_York") : sessionStart;
  const configuredEnabled = objectRecord(objectRecord(configuration.rangeEngine).horizontalRange).enabled !== false;
  const enabled = mode !== "ORB_ONLY" && horizontalProfile.enabled !== false && configuredEnabled && isNewYork;
  const eligible = enabled && timestamp >= windowStart && timestamp < sessionEnd;
  return {
    mode,
    profile: input.profile,
    enabled,
    eligible,
    maximumSignalsPerDay: boundedInteger(horizontalProfile.maximumSignalsPerDay, 1, 2),
    windowStartAt: windowStart.toISOString(),
    windowEndAt: sessionEnd.toISOString(),
    reason: !isNewYork
      ? "Horizontal Breakout is currently restricted to the New York session."
      : !enabled
        ? "Horizontal Breakout signals are disabled by the selected Module 1 profile mode."
        : eligible
          ? `Horizontal Breakout owns the continuation window from ${configuredStart} New York.`
          : `Horizontal Breakout becomes signal-eligible at ${configuredStart} New York.`
  };
}

function objectRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function boundedInteger(value: unknown, fallback: number, maximum: number) {
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function timeValue(value: unknown, fallback: string) {
  const text = String(value ?? "");
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : fallback;
}

function isoDateValue(value: unknown) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const parsed = value instanceof Date ? value : new Date(String(value ?? ""));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : "";
}
