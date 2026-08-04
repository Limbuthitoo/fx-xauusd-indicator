import { config } from "../../infrastructure/config.js";
import { query } from "../../infrastructure/db/client.js";
import { defaultLiquiditySweepConfiguration } from "@orb-guide/liquidity-sweep-engine";

const SEVEN_DAY_FIVE_MINUTE_CANDLES = 7 * 24 * 12;

export type RuntimeSettings = {
  symbol: string;
  timeframeMinutes: number;
  paperTradingEnabled: boolean;
  brokerExecution: false;
  orb: {
    timezone: "America/New_York";
    sessionStart: string;
    tradeWindowEnd: string;
    openingRangeMinutes: number;
    apiStartLeadMinutes: number;
  };
  feed: {
    name: "TWELVE_DATA";
    providerSymbol: string;
    pollSeconds: number;
    rawCandleStorage: boolean;
    cacheDays: number;
    startupBackfillCount: number;
    livePollCount: number;
  };
};

const defaults: RuntimeSettings = {
  symbol: "XAUUSD",
  timeframeMinutes: 5,
  paperTradingEnabled: true,
  brokerExecution: false,
  orb: {
    timezone: "America/New_York",
    sessionStart: "09:15",
    tradeWindowEnd: "16:00",
    openingRangeMinutes: 15,
    apiStartLeadMinutes: 15
  },
  feed: {
    name: "TWELVE_DATA",
    providerSymbol: config.twelveDataSymbol,
    pollSeconds: Math.max(config.twelveDataPollSeconds, 60),
    rawCandleStorage: true,
    cacheDays: 7,
    startupBackfillCount: SEVEN_DAY_FIVE_MINUTE_CANDLES,
    livePollCount: 2
  }
};

export async function getRuntimeSettings(tenantId?: string | null): Promise<RuntimeSettings> {
  const byKey = await settingsMap(tenantId);
  const tradingPaper = objectValue(byKey.get("trading.paperTrading"));
  const orbSession = objectValue(byKey.get("orb.session"));
  const feedProvider = objectValue(byKey.get("feed.provider"));

  return {
    symbol: stringValue(byKey.get("trading.symbol"), defaults.symbol),
    timeframeMinutes: supportedTimeframe(numberValue(byKey.get("trading.timeframeMinutes"), defaults.timeframeMinutes)),
    paperTradingEnabled: booleanValue(tradingPaper.enabled, defaults.paperTradingEnabled),
    brokerExecution: false,
    orb: {
      timezone: "America/New_York",
      sessionStart: timeValue(orbSession.sessionStart, defaults.orb.sessionStart),
      tradeWindowEnd: timeValue(orbSession.tradeWindowEnd, defaults.orb.tradeWindowEnd),
      openingRangeMinutes: positiveInteger(orbSession.openingRangeMinutes, defaults.orb.openingRangeMinutes, 240),
      apiStartLeadMinutes: positiveInteger(orbSession.apiStartLeadMinutes, defaults.orb.apiStartLeadMinutes, 240)
    },
    feed: {
      name: "TWELVE_DATA",
      providerSymbol: stringValue(feedProvider.providerSymbol, config.twelveDataSymbol),
      pollSeconds: Math.max(positiveInteger(feedProvider.pollSeconds, defaults.feed.pollSeconds, 3600), 60),
      rawCandleStorage: true,
      cacheDays: positiveInteger(feedProvider.cacheDays, defaults.feed.cacheDays, 30),
      startupBackfillCount: Math.max(
        SEVEN_DAY_FIVE_MINUTE_CANDLES,
        positiveInteger(feedProvider.startupBackfillCount, defaults.feed.startupBackfillCount, 5000)
      ),
      livePollCount: positiveInteger(feedProvider.livePollCount, defaults.feed.livePollCount, 100)
    }
  };
}

export async function listTenantSettings(tenantId: string) {
  const { rows } = await query(
    `SELECT
       s.key,
       COALESCE(ts.value, s.value) AS value,
       s.category,
       s.description,
       ts.updated_at,
       ts.updated_by,
       ts.value IS NOT NULL AS tenant_override
     FROM app_settings s
     LEFT JOIN tenant_settings ts ON ts.key = s.key AND ts.tenant_id = $1
     ORDER BY s.category, s.key`,
    [tenantId]
  );
  return rows;
}

export async function updateTenantSetting(tenantId: string, key: string, value: unknown, adminUserId: string | null) {
  const global = await query("SELECT category, description FROM app_settings WHERE key = $1", [key]);
  if (!global.rows[0]) {
    const error = new Error("Unknown setting key.") as Error & { statusCode?: number };
    error.statusCode = 404;
    throw error;
  }
  const validated = validateSetting(key, value);
  const { rows } = await query(
    `INSERT INTO tenant_settings (tenant_id, key, value, category, description, updated_by, updated_at)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6,now())
     ON CONFLICT (tenant_id, key) DO UPDATE SET
       value = EXCLUDED.value,
       category = EXCLUDED.category,
       description = EXCLUDED.description,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()
     RETURNING *`,
    [tenantId, key, JSON.stringify(validated), global.rows[0].category, global.rows[0].description, adminUserId]
  );
  return rows[0];
}

export async function listTenantModuleSettings(tenantId: string, moduleCode: string) {
  const existing = await query(
    `SELECT key, value, category, description, updated_at, updated_by
     FROM tenant_module_settings
     WHERE tenant_id = $1 AND module_code = $2
     ORDER BY category, key`,
    [tenantId, moduleCode]
  );
  if (existing.rows.length > 0) return existing.rows;

  if (moduleCode === "high_probability_strategy_2") {
    const fallback = await defaultModuleStrategyConfiguration("high_probability_strategy_2");
    return [
      {
        key: "liquiditySweep.strategy",
        value: { ...defaultLiquiditySweepConfiguration(), ...fallback },
        category: "Liquidity Sweep + BOS",
        description: "User-account Module 2 thresholds for XAUUSD New York liquidity sweep + BOS paper-trade automation.",
        updated_at: null,
        updated_by: null
      }
    ];
  }
  if (moduleCode === "strategy_lab_3") {
    const fallback = await defaultModuleStrategyConfiguration("strategy_lab_3");
    return [
      {
        key: "vwapOpeningDrive.strategy",
        value: fallback,
        category: "VWAP Opening Drive",
        description: "User-account Module 3 thresholds for XAUUSD New York VWAP opening-drive pullback paper-trade automation.",
        updated_at: null,
        updated_by: null
      }
    ];
  }

  const fallback = await defaultModuleStrategyConfiguration("orb_max_options");
  return [
    {
      key: "orb.strategy",
      value: fallback,
      category: "ORB MAX",
      description: "User-account ORB MAX Options strategy thresholds and automatic paper-trade rules.",
      updated_at: null,
      updated_by: null
    }
  ];
}

export async function updateTenantModuleSetting(tenantId: string, moduleCode: string, key: string, value: unknown, adminUserId: string | null) {
  const validated = validateModuleSetting(moduleCode, key, value);
  const description = moduleSettingDescription(moduleCode, key);
  const { rows } = await query(
    `INSERT INTO tenant_module_settings (tenant_id, module_code, key, value, category, description, updated_by, updated_at)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,now())
     ON CONFLICT (tenant_id, module_code, key) DO UPDATE SET
       value = EXCLUDED.value,
       category = EXCLUDED.category,
       description = EXCLUDED.description,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()
     RETURNING *`,
    [tenantId, moduleCode, key, JSON.stringify(validated), moduleCategory(moduleCode), description, adminUserId]
  );
  return rows[0];
}

export async function getTenantOrbStrategyConfiguration(tenantId?: string | null, baseConfiguration?: unknown) {
  const base = objectValue(baseConfiguration) as Record<string, unknown>;
  if (!tenantId) return base;
  const { rows } = await query(
    `SELECT value
     FROM tenant_module_settings
     WHERE tenant_id = $1 AND module_code = 'orb_max_options' AND key = 'orb.strategy'
     LIMIT 1`,
    [tenantId]
  );
  const override = rows[0]?.value;
  return mergeObjects(base, objectValue(override));
}

export async function getTenantModuleStrategyConfiguration(tenantId: string | null | undefined, moduleCode: string, settingKey: string, baseConfiguration?: unknown) {
  const base = objectValue(baseConfiguration) as Record<string, unknown>;
  if (!tenantId) return base;
  const { rows } = await query(
    `SELECT value
     FROM tenant_module_settings
     WHERE tenant_id = $1 AND module_code = $2 AND key = $3
     LIMIT 1`,
    [tenantId, moduleCode, settingKey]
  );
  return mergeObjects(base, objectValue(rows[0]?.value));
}

export function validateSetting(key: string, value: unknown) {
  if (key === "trading.symbol") {
    if (typeof value !== "string" || !/^[A-Z0-9]{3,12}$/.test(value)) throw new Error("Symbol must look like XAUUSD.");
    return value;
  }
  if (key === "trading.timeframeMinutes") return supportedTimeframe(numberValue(value, 5));
  if (key === "trading.paperTrading") {
    const input = objectValue(value);
    return {
      enabled: booleanValue(input.enabled, true),
      brokerExecution: false
    };
  }
  if (key === "orb.session") {
    const input = objectValue(value);
    return {
      timezone: "America/New_York",
      sessionStart: timeValue(input.sessionStart, defaults.orb.sessionStart),
      tradeWindowEnd: timeValue(input.tradeWindowEnd, defaults.orb.tradeWindowEnd),
      openingRangeMinutes: positiveInteger(input.openingRangeMinutes, defaults.orb.openingRangeMinutes, 240),
      apiStartLeadMinutes: positiveInteger(input.apiStartLeadMinutes, defaults.orb.apiStartLeadMinutes, 240)
    };
  }
  if (key === "feed.provider") {
    const input = objectValue(value);
    return {
      name: "TWELVE_DATA",
      providerSymbol: stringValue(input.providerSymbol, config.twelveDataSymbol),
      pollSeconds: Math.max(positiveInteger(input.pollSeconds, defaults.feed.pollSeconds, 3600), 60),
      rawCandleStorage: true,
      cacheDays: positiveInteger(input.cacheDays, defaults.feed.cacheDays, 30),
      startupBackfillCount: Math.max(
        SEVEN_DAY_FIVE_MINUTE_CANDLES,
        positiveInteger(input.startupBackfillCount, defaults.feed.startupBackfillCount, 5000)
      ),
      livePollCount: positiveInteger(input.livePollCount, defaults.feed.livePollCount, 100)
    };
  }
  if (key === "notifications.browser") {
    const input = objectValue(value);
    return { enabled: booleanValue(input.enabled, true) };
  }
  if (key === "platform.business") {
    const input = objectValue(value);
    return {
      brandName: stringValue(input.brandName, "XAUUSD Signal"),
      supportPhone: stringValue(input.supportPhone, ""),
      supportEmail: stringValue(input.supportEmail, ""),
      businessAddress: stringValue(input.businessAddress, ""),
      websiteUrl: stringValue(input.websiteUrl, ""),
      whatsappUrl: stringValue(input.whatsappUrl, ""),
      supportHours: stringValue(input.supportHours, ""),
      helpText: stringValue(input.helpText, "")
    };
  }
  return value;
}

export function validateModuleSetting(moduleCode: string, key: string, value: unknown) {
  if (moduleCode === "high_probability_strategy_2" && key === "liquiditySweep.strategy") {
    const input = objectValue(value) as Record<string, any>;
    const paperTrading = objectValue(input.paperTrading);
    return {
      ...input,
      moduleCode: "high_probability_strategy_2",
      symbol: stringValue(input.symbol, defaults.symbol),
      timezone: "America/New_York",
      newYorkStartTime: timeValue(input.newYorkStartTime, "09:30"),
      newYorkEndTime: timeValue(input.newYorkEndTime, "16:00"),
      biasTimeframe: supportedTimeframe(numberValue(input.biasTimeframe, 15)),
      setupTimeframe: supportedTimeframe(numberValue(input.setupTimeframe, 5)),
      entryTimeframe: supportedTimeframe(numberValue(input.entryTimeframe, 5)),
      maximumTradesPerSession: positiveInteger(input.maximumTradesPerSession, 1, 10),
      minimumSweepDistanceATR: positiveNumber(input.minimumSweepDistanceATR, 0.1, 5),
      maximumSweepDistanceATR: positiveNumber(input.maximumSweepDistanceATR, 1, 10),
      closeBackMaximumBars: positiveInteger(input.closeBackMaximumBars, 3, 10),
      minimumDisplacementRangeATR: positiveNumber(input.minimumDisplacementRangeATR, 1.2, 5),
      minimumBodyPercentage: ratioValue(input.minimumBodyPercentage, 0.6),
      maximumBarsAfterSweep: positiveInteger(input.maximumBarsAfterSweep, 5, 20),
      pivotLeftBars: positiveInteger(input.pivotLeftBars, 2, 10),
      pivotRightBars: positiveInteger(input.pivotRightBars, 2, 10),
      minimumBosCloseDistanceATR: positiveNumber(input.minimumBosCloseDistanceATR, 0.05, 2),
      maximumBarsAfterSweepForBos: positiveInteger(input.maximumBarsAfterSweepForBos, 10, 50),
      maximumBarsAfterBosForEntry: positiveInteger(input.maximumBarsAfterBosForEntry, 15, 50),
      minimumFvgSizeATR: positiveNumber(input.minimumFvgSizeATR, 0.1, 5),
      entryAtFvgPercentage: Math.min(Math.max(numberValue(input.entryAtFvgPercentage, 50), 0), 100),
      minimumRiskReward: positiveNumber(input.minimumRiskReward, 2, 10),
      maximumStopATR: positiveNumber(input.maximumStopATR, 1.25, 10),
      stopBufferATR: positiveNumber(input.stopBufferATR, 0.1, 2),
      minimumSignalScore: positiveInteger(input.minimumSignalScore, 80, 110),
      maximumSpread: positiveNumber(input.maximumSpread, 0.8, 20),
      enableNewsFilter: booleanValue(input.enableNewsFilter, true),
      requireHtfBias: booleanValue(input.requireHtfBias, true),
      paperTrading: {
        ...paperTrading,
        enabled: booleanValue(paperTrading.enabled, true),
        maximumTradesPerSession: positiveInteger(paperTrading.maximumTradesPerSession, 1, 10),
        conservativeSameCandleExit: booleanValue(paperTrading.conservativeSameCandleExit, true)
      }
    };
  }
  if (moduleCode === "strategy_lab_3" && key === "vwapOpeningDrive.strategy") {
    const input = objectValue(value) as Record<string, any>;
    const paperTrading = objectValue(input.paperTrading);
    return {
      ...input,
      moduleCode: "strategy_lab_3",
      symbol: stringValue(input.symbol, defaults.symbol),
      timezone: "America/New_York",
      newYorkStartTime: timeValue(input.newYorkStartTime, "09:30"),
      newYorkEndTime: timeValue(input.newYorkEndTime, "16:00"),
      setupTimeframe: supportedTimeframe(numberValue(input.setupTimeframe, 5)),
      biasTimeframe: supportedTimeframe(numberValue(input.biasTimeframe, 15)),
      maximumTradesPerSession: positiveInteger(input.maximumTradesPerSession, 1, 10),
      openingDriveMinutes: positiveInteger(input.openingDriveMinutes, 30, 90),
      minimumDriveRangeATR: positiveNumber(input.minimumDriveRangeATR, 1, 5),
      minimumDriveBodyPercent: ratioValue(input.minimumDriveBodyPercent, 0.55),
      minimumVwapDistanceATR: positiveNumber(input.minimumVwapDistanceATR, 0.05, 2),
      pullbackMaxBars: positiveInteger(input.pullbackMaxBars, 12, 40),
      pullbackZoneAtr: positiveNumber(input.pullbackZoneAtr, 0.35, 2),
      confirmationBodyPercent: ratioValue(input.confirmationBodyPercent, 0.45),
      emaPeriod: positiveInteger(input.emaPeriod, 20, 200),
      minimumRiskReward: positiveNumber(input.minimumRiskReward, 2, 10),
      maximumStopATR: positiveNumber(input.maximumStopATR, 1.35, 10),
      stopBufferATR: positiveNumber(input.stopBufferATR, 0.12, 2),
      maximumSpread: positiveNumber(input.maximumSpread, 0.8, 20),
      enableNewsFilter: booleanValue(input.enableNewsFilter, true),
      minimumSignalScore: positiveInteger(input.minimumSignalScore, 80, 100),
      paperTrading: {
        ...paperTrading,
        enabled: booleanValue(paperTrading.enabled, true),
        maximumTradesPerSession: positiveInteger(paperTrading.maximumTradesPerSession, 1, 10),
        conservativeSameCandleExit: booleanValue(paperTrading.conservativeSameCandleExit, true)
      }
    };
  }
  if (moduleCode !== "orb_max_options" || key !== "orb.strategy") return value;
  const input = objectValue(value) as Record<string, any>;
  const base = objectValue(input);
  const breakout = objectValue(base.breakout);
  const retest = objectValue(base.retest);
  const risk = objectValue(base.risk);
  const favorability = objectValue(base.favorability);
  const paperTrading = objectValue(base.paperTrading);

  return {
    ...base,
    symbol: stringValue(base.symbol, defaults.symbol),
    timezone: "America/New_York",
    sessionStart: timeValue(base.sessionStart, defaults.orb.sessionStart),
    tradeWindowEnd: timeValue(base.tradeWindowEnd, defaults.orb.tradeWindowEnd),
    openingRangeMinutes: positiveInteger(base.openingRangeMinutes, defaults.orb.openingRangeMinutes, 240),
    signalTimeframeMinutes: supportedTimeframe(numberValue(base.signalTimeframeMinutes, defaults.timeframeMinutes)),
    breakout: {
      ...breakout,
      requireCompletedCandle: booleanValue(breakout.requireCompletedCandle, true),
      requireCloseOutside: booleanValue(breakout.requireCloseOutside, true),
      allowWickOnly: false,
      minimumBodyRatio: ratioValue(breakout.minimumBodyRatio, 0.45),
      minimumCloseLocationRatio: ratioValue(breakout.minimumCloseLocationRatio, 0.6),
      maximumEntryExtensionPercentOfRange: ratioValue(breakout.maximumEntryExtensionPercentOfRange, 0.25)
    },
    retest: {
      ...retest,
      enabled: booleanValue(retest.enabled, true),
      zonePercentOfRange: ratioValue(retest.zonePercentOfRange, 0.1),
      maximumCandles: positiveInteger(retest.maximumCandles, 4, 50),
      confirmationRequired: booleanValue(retest.confirmationRequired, true)
    },
    risk: {
      ...risk,
      riskPerTradePercent: positiveNumber(risk.riskPerTradePercent, 0.5, 10),
      maximumDailyLossPercent: positiveNumber(risk.maximumDailyLossPercent, 2, 25),
      maximumWeeklyLossPercent: positiveNumber(risk.maximumWeeklyLossPercent, 5, 50),
      maximumTradesPerSession: positiveInteger(risk.maximumTradesPerSession, 1, 20),
      mandatoryStopLoss: true,
      minimumRewardToRisk: positiveNumber(risk.minimumRewardToRisk, 2, 10),
      allowMartingale: false,
      allowAddingToLoss: false
    },
    favorability: {
      ...favorability,
      minimumScoreForPaperTrade: positiveInteger(favorability.minimumScoreForPaperTrade, 70, 100),
      preferredSpreadPercentOfRange: ratioValue(favorability.preferredSpreadPercentOfRange, 0.12),
      minimumAtrPercentOfRange: ratioValue(favorability.minimumAtrPercentOfRange, 0.4)
    },
    paperTrading: {
      ...paperTrading,
      enabled: booleanValue(paperTrading.enabled, true),
      maximumTradesPerSession: positiveInteger(paperTrading.maximumTradesPerSession, 1, 20),
      conservativeSameCandleExit: booleanValue(paperTrading.conservativeSameCandleExit, true)
    }
  };
}

async function settingsMap(tenantId?: string | null) {
  const { rows } = tenantId
    ? await query(
        `SELECT s.key, COALESCE(ts.value, s.value) AS value
         FROM app_settings s
         LEFT JOIN tenant_settings ts ON ts.key = s.key AND ts.tenant_id = $1`,
        [tenantId]
      )
    : await query("SELECT key, value FROM app_settings");
  return new Map(rows.map((row: any) => [row.key, row.value]));
}

async function defaultModuleStrategyConfiguration(moduleCode: string) {
  const { rows } = await query(
    `SELECT configuration_json
     FROM strategy_versions
     JOIN strategies s ON s.id = strategy_versions.strategy_id
     JOIN strategy_sources src ON src.id = s.source_id
     WHERE status = 'ACTIVE'
       AND COALESCE(configuration_json->>'moduleCode', src.metadata->>'moduleCode', 'orb_max_options') = $1
     ORDER BY activated_at DESC NULLS LAST, created_at DESC
     LIMIT 1`,
    [moduleCode]
  );
  return rows[0]?.configuration_json ?? {};
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberValue(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function positiveInteger(value: unknown, fallback: number, max: number) {
  const number = Math.round(numberValue(value, fallback));
  if (number <= 0) return fallback;
  return Math.min(number, max);
}

function positiveNumber(value: unknown, fallback: number, max: number) {
  const number = numberValue(value, fallback);
  if (number <= 0) return fallback;
  return Math.min(number, max);
}

function ratioValue(value: unknown, fallback: number) {
  const number = numberValue(value, fallback);
  if (number < 0) return fallback;
  return Math.min(number, 1);
}

function mergeObjects(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = result[key];
    result[key] =
      existing && typeof existing === "object" && !Array.isArray(existing) && value && typeof value === "object" && !Array.isArray(value)
        ? mergeObjects(existing as Record<string, unknown>, value as Record<string, unknown>)
        : value;
  }
  return result;
}

function moduleCategory(moduleCode: string) {
  if (moduleCode === "orb_max_options") return "ORB MAX";
  if (moduleCode === "high_probability_strategy_2") return "Liquidity Sweep + BOS";
  return "Strategy Module";
}

function moduleSettingDescription(moduleCode: string, key: string) {
  if (moduleCode === "orb_max_options" && key === "orb.strategy") {
    return "User-account ORB MAX Options strategy thresholds and automatic paper-trade rules.";
  }
  if (moduleCode === "high_probability_strategy_2" && key === "liquiditySweep.strategy") {
    return "User-account Module 2 thresholds for XAUUSD New York liquidity sweep + BOS paper-trade automation.";
  }
  return "User-account module configuration.";
}

function supportedTimeframe(value: number) {
  const normalized = Math.round(value);
  if ([1, 5, 15, 30, 45, 60].includes(normalized)) return normalized;
  throw new Error("Timeframe must be one of 1, 5, 15, 30, 45, or 60 minutes.");
}

function timeValue(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  if (!/^\d{2}:\d{2}$/.test(value)) throw new Error("Time must use HH:mm format.");
  const [hour, minute] = value.split(":").map(Number);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new Error("Time must be valid HH:mm.");
  return value;
}
