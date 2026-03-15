import dotenv from "dotenv";

dotenv.config();

function envStr(name, fallback = "") {
  const v = process.env[name];
  return typeof v === "string" ? v.trim() : fallback;
}

function envNum(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name, fallback = false) {
  const raw = envStr(name, "");
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function envList(name, fallback = []) {
  const raw = envStr(name, "");
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);
}

const config = {
  port: envNum("PORT", 3000),
  nodeEnv: envStr("NODE_ENV", "development"),

  coinex: {
    accessId: envStr("COINEX_ACCESS_ID", ""),
    secretKey: envStr("COINEX_SECRET_KEY", ""),
    baseUrl: envStr("COINEX_BASE_URL", "https://api.coinex.com"),
    windowTime: envNum("COINEX_WINDOWTIME", 5000),
    defaultMarginMode: envStr("DEFAULT_MARGIN_MODE", "isolated"),
    defaultTriggerPriceType: envStr("DEFAULT_TRIGGER_PRICE_TYPE", "mark_price"),
    marketsCacheMs: envNum("MARKETS_CACHE_MS", 120000),
    requestTimeoutMs: envNum("COINEX_REQUEST_TIMEOUT_MS", 12000),
    publicRetryCount: envNum("COINEX_PUBLIC_RETRY_COUNT", 2),
    },

   risk: {
        maxLeverageCap: envNum("MAX_LEVERAGE_CAP", 5),
        maxConcurrentTrades: envNum("MAX_CONCURRENT_TRADES", 4),
        maxTradesPerBucket: envNum("MAX_TRADES_PER_BUCKET", 2),
        maxAccountExposurePct: envNum("MAX_ACCOUNT_EXPOSURE_PCT", 45),
        maxConcurrentMemeTrades: envNum("MAX_CONCURRENT_MEME_TRADES", 1),
        maxLossStreakToBlock: envNum("MAX_LOSS_STREAK_TO_BLOCK", 4),
        maxRiskPctPerTrade: envNum("MAX_RISK_PCT_PER_TRADE", 8),

        symbolFilters: {
        blocked: envList("BLOCKED_SYMBOLS", []),
        memeReducedSize: envList("REDUCED_SIZE_SYMBOLS", []),
        minMinutesBetweenTradesPerSymbol: envNum("MIN_MINUTES_BETWEEN_TRADES_PER_SYMBOL", 10),
        minMinutesBetweenTradesPerMeme: envNum("MIN_MINUTES_BETWEEN_TRADES_PER_MEME", 20),
        maxConsecutiveLossesBeforeCooldown: envNum("MAX_CONSECUTIVE_LOSSES_BEFORE_COOLDOWN", 3),
        cooldownMinutesAfterLossStreak: envNum("COOLDOWN_MINUTES_AFTER_LOSS_STREAK", 60)
        }
    },

  scanner: {
    batchSize: envNum("SCANNER_BATCH_SIZE", 68),
    intervalMs: envNum("SCANNER_INTERVAL_MS", 5000),
    signalPeriod: envStr("SCANNER_SIGNAL_PERIOD", "5min"),
    minProbability: envNum("SCANNER_MIN_PROBABILITY", 52),
    minScore: envNum("SCANNER_MIN_SCORE", 42),
    minEdge: envNum("SCANNER_MIN_EDGE", 3),
    maxFindings: envNum("SCANNER_MAX_FINDINGS", 20),
    findingTtlMs: envNum("SCANNER_FINDING_TTL_MS", 90000),
    debug: envBool("SCANNER_DEBUG", false),
    debugMaxErrors: envNum("SCANNER_DEBUG_MAX_ERRORS", 25),
    minAdx15: envNum("SCANNER_MIN_ADX15", 14),
    maxAbsDistEma20_5: envNum("SCANNER_MAX_ABS_DIST_EMA20_5", 1.1),
    minBodyStrength5: envNum("SCANNER_MIN_BODY_STRENGTH_5", 0.35),
    maxOppositeWickRatio: envNum("SCANNER_MAX_OPPOSITE_WICK_RATIO", 0.45),
    allowTransitionRegime: envBool("SCANNER_ALLOW_TRANSITION_REGIME", true)
  },
  auto: {
    enabled: envBool("AUTO_ENABLED", false),
    autoEntryProbability: envNum("AUTO_ENTRY_PROBABILITY", 58),
    autoMinScore: envNum("AUTO_MIN_SCORE", 45),
    autoMinEdge: envNum("AUTO_MIN_EDGE", 6),
    autoTakeProfitRoe: envNum("AUTO_TAKE_PROFIT_ROE", 10),
    autoScanIntervalMs: envNum("AUTO_SCAN_INTERVAL_MS", 5000),
    defaultPercent: envNum("AUTO_DEFAULT_PERCENT", 25),
    defaultStopLossPct: envNum("AUTO_DEFAULT_STOP_LOSS_PCT", 0.5),
    defaultTakeProfitPct: envNum("AUTO_DEFAULT_TAKE_PROFIT_PCT", 1.2),
    defaultSignalPeriod: envStr("AUTO_DEFAULT_SIGNAL_PERIOD", "5min")
  },

  dbPath: envStr("DB_PATH", "./coinex_pro_bot.db")
};

function assertRange(name, value, { min = -Infinity, max = Infinity } = {}) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} inválido: ${value}`);
  }
}

function assertOneOf(name, value, allowed) {
  if (!allowed.includes(value)) {
    throw new Error(`${name} debe ser uno de: ${allowed.join(", ")}`);
  }
}

function assertConfig() {
  if (!config.coinex.accessId) {
    throw new Error("Falta COINEX_ACCESS_ID en .env");
  }

  if (!config.coinex.secretKey) {
    throw new Error("Falta COINEX_SECRET_KEY en .env");
  }

  assertOneOf("DEFAULT_MARGIN_MODE", config.coinex.defaultMarginMode, [
    "isolated",
    "cross"
  ]);

  assertOneOf("DEFAULT_TRIGGER_PRICE_TYPE", config.coinex.defaultTriggerPriceType, [
    "mark_price",
    "latest_price",
    "index_price"
  ]);

  assertOneOf("AUTO_DEFAULT_SIGNAL_PERIOD", config.auto.defaultSignalPeriod, [
    "1min", "3min", "5min", "15min", "30min",
    "1hour", "2hour", "4hour", "6hour", "12hour",
    "1day", "3day", "1week"
  ]);
    assertOneOf("SCANNER_SIGNAL_PERIOD", config.scanner.signalPeriod, [
    "1min", "3min", "5min", "15min", "30min",
    "1hour", "2hour", "4hour", "6hour", "12hour",
    "1day", "3day", "1week"
    ]);

    assertRange("SCANNER_MIN_PROBABILITY", config.scanner.minProbability, { min: 1, max: 99 });
    assertRange("SCANNER_MIN_SCORE", config.scanner.minScore, { min: 1, max: 100 });
    assertRange("SCANNER_MIN_EDGE", config.scanner.minEdge, { min: 0, max: 99 });
    assertRange("SCANNER_MAX_FINDINGS", config.scanner.maxFindings, { min: 1, max: 100 });
    assertRange("SCANNER_FINDING_TTL_MS", config.scanner.findingTtlMs, { min: 1000, max: 3600000 });
    assertRange("PORT", config.port, { min: 1, max: 65535 });
    assertRange("COINEX_WINDOWTIME", config.coinex.windowTime, { min: 1000, max: 60000 });
    assertRange("MARKETS_CACHE_MS", config.coinex.marketsCacheMs, { min: 1000, max: 3600000 });

    assertRange("MAX_LEVERAGE_CAP", config.risk.maxLeverageCap, { min: 1, max: 100 });
    assertRange("MAX_CONCURRENT_TRADES", config.risk.maxConcurrentTrades, { min: 1, max: 50 });
    assertRange("MAX_TRADES_PER_BUCKET", config.risk.maxTradesPerBucket, { min: 1, max: 20 });
    assertRange("MAX_ACCOUNT_EXPOSURE_PCT", config.risk.maxAccountExposurePct, { min: 1, max: 100 });
    assertRange("MAX_CONCURRENT_MEME_TRADES", config.risk.maxConcurrentMemeTrades, { min: 0, max: 10 });
    assertRange("MAX_LOSS_STREAK_TO_BLOCK", config.risk.maxLossStreakToBlock, { min: 1, max: 20 });
    assertRange("MAX_RISK_PCT_PER_TRADE", config.risk.maxRiskPctPerTrade, { min: 0.1, max: 100 });
    assertRange("COINEX_REQUEST_TIMEOUT_MS", config.coinex.requestTimeoutMs, { min: 1000, max: 60000 });
    assertRange("COINEX_PUBLIC_RETRY_COUNT", config.coinex.publicRetryCount, { min: 0, max: 10 });

    assertRange("SCANNER_DEBUG_MAX_ERRORS", config.scanner.debugMaxErrors, { min: 1, max: 500 });
    assertRange("SCANNER_MIN_ADX15", config.scanner.minAdx15, { min: 0, max: 100 });
    assertRange("SCANNER_MAX_ABS_DIST_EMA20_5", config.scanner.maxAbsDistEma20_5, { min: 0.01, max: 20 });
    assertRange("SCANNER_MIN_BODY_STRENGTH_5", config.scanner.minBodyStrength5, { min: 0, max: 1 });
    assertRange("SCANNER_MAX_OPPOSITE_WICK_RATIO", config.scanner.maxOppositeWickRatio, { min: 0, max: 1 });
  assertRange(
    "MIN_MINUTES_BETWEEN_TRADES_PER_SYMBOL",
    config.risk.symbolFilters.minMinutesBetweenTradesPerSymbol,
    { min: 0, max: 1440 }
  );
  assertRange(
    "MIN_MINUTES_BETWEEN_TRADES_PER_MEME",
    config.risk.symbolFilters.minMinutesBetweenTradesPerMeme,
    { min: 0, max: 1440 }
  );
  assertRange(
    "MAX_CONSECUTIVE_LOSSES_BEFORE_COOLDOWN",
    config.risk.symbolFilters.maxConsecutiveLossesBeforeCooldown,
    { min: 1, max: 20 }
  );
  assertRange(
    "COOLDOWN_MINUTES_AFTER_LOSS_STREAK",
    config.risk.symbolFilters.cooldownMinutesAfterLossStreak,
    { min: 1, max: 10080 }
  );

  assertRange("SCANNER_BATCH_SIZE", config.scanner.batchSize, { min: 1, max: 500 });
  assertRange("SCANNER_INTERVAL_MS", config.scanner.intervalMs, { min: 500, max: 3600000 });

  assertRange("AUTO_ENTRY_PROBABILITY", config.auto.autoEntryProbability, { min: 1, max: 99 });
  assertRange("AUTO_MIN_SCORE", config.auto.autoMinScore, { min: 1, max: 100 });
  assertRange("AUTO_MIN_EDGE", config.auto.autoMinEdge, { min: 0, max: 99 });
  assertRange("AUTO_TAKE_PROFIT_ROE", config.auto.autoTakeProfitRoe, { min: 0.1, max: 500 });
  assertRange("AUTO_SCAN_INTERVAL_MS", config.auto.autoScanIntervalMs, { min: 1000, max: 3600000 });
  assertRange("AUTO_DEFAULT_PERCENT", config.auto.defaultPercent, { min: 1, max: 100 });
  assertRange("AUTO_DEFAULT_STOP_LOSS_PCT", config.auto.defaultStopLossPct, { min: 0.01, max: 50 });
  assertRange("AUTO_DEFAULT_TAKE_PROFIT_PCT", config.auto.defaultTakeProfitPct, { min: 0.01, max: 100 });

  if (config.auto.defaultTakeProfitPct <= config.auto.defaultStopLossPct) {
    console.warn(
      "[config] Advertencia: AUTO_DEFAULT_TAKE_PROFIT_PCT es menor o igual al stop loss por defecto."
    );
  }

  if (config.nodeEnv === "production" && config.auto.enabled) {
    console.warn("[config] AUTO_ENABLED=true en producción.");
  }
}

assertConfig();

export default config;
