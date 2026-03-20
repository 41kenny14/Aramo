import config from "./config.js";
import { getSignalForSymbol } from "./signalEngine.js";

const scannerState = {
  running: false,
  lastRunAt: 0,
  findings: [],
  batchOffset: 0,
  lastStats: null,
  lastErrors: []
};

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function confRank(confidence) {
  if (confidence === "HIGH") return 3;
  if (confidence === "MEDIUM") return 2;
  return 1;
}

function setupRank(setupType) {
  if (setupType === "PULLBACK_LONG" || setupType === "PULLBACK_SHORT") return 3;
  if (setupType === "BREAKOUT_LONG" || setupType === "BREAKOUT_SHORT") return 2;
  return 1;
}

function getEdge(signal) {
  const longProb = num(signal?.probabilities?.longProb);
  const shortProb = num(signal?.probabilities?.shortProb);
  return Math.abs(longProb - shortProb);
}

function getScannerConfig() {
  return {
    batchSize: num(config.scanner?.batchSize || 68),
    intervalMs: num(config.scanner?.intervalMs || 5000),
    signalPeriod: config.scanner?.signalPeriod || "5min",
    minProbability: num(config.scanner?.minProbability || 52),
    minScore: num(config.scanner?.minScore || 38),
    minEdge: num(config.scanner?.minEdge || 3),
    maxFindings: num(config.scanner?.maxFindings || 20),
    findingTtlMs: num(config.scanner?.findingTtlMs || 90000),
    debug: Boolean(config.scanner?.debug || false),
    debugMaxErrors: num(config.scanner?.debugMaxErrors || 25),

    // filtros finos para timing corto
    minAdx15: num(config.scanner?.minAdx15 || 14),
    maxAbsDistEma20_5: num(config.scanner?.maxAbsDistEma20_5 || 1.1),
    minBodyStrength5: num(config.scanner?.minBodyStrength5 || 0.35),
    maxOppositeWickRatio: num(config.scanner?.maxOppositeWickRatio || 0.45),
    allowTransitionRegime: Boolean(config.scanner?.allowTransitionRegime ?? true)
  };
}

function normalizeFinding(item, signal, activeTrades) {
  const longProb = num(signal?.probabilities?.longProb);
  const shortProb = num(signal?.probabilities?.shortProb);
  const direction = signal?.suggestedAction || "NO_TRADE";
  const score = num(signal?.score);
  const confidence = signal?.confidence || "LOW";
  const regime = signal?.regime || "TRANSITION";
  const edge = getEdge(signal);

  const bullishCloseConfirmation = Boolean(signal?.setup?.bullishCloseConfirmation);
  const bearishCloseConfirmation = Boolean(signal?.setup?.bearishCloseConfirmation);

  const bodyStrength5 = num(signal?.metrics?.bodyStrength5);
  const upperWick5 = num(signal?.metrics?.upperWick5);
  const lowerWick5 = num(signal?.metrics?.lowerWick5);

  const setupType = signal?.setup?.type || "NONE";

  return {
    symbol: item.symbol,
    market: item.market,
    direction,
    probability: Number(Math.max(longProb, shortProb).toFixed(1)),
    longProb: Number(longProb.toFixed(1)),
    shortProb: Number(shortProb.toFixed(1)),
    edge: Number(edge.toFixed(1)),
    score: Number(score.toFixed(2)),
    confidence,
    regime,

    bias1h: signal?.mtf?.bias1h || "NEUTRAL",
    bias15m: signal?.mtf?.bias15m || "NEUTRAL",
    triggerBias: signal?.mtf?.triggerBias || "NEUTRAL",

    trend5mBias: signal?.trend?.trend5mBias || "NEUTRAL",
    trend15mBias: signal?.trend?.trend15mBias || "NEUTRAL",
    trend1hBias: signal?.trend?.trend1hBias || "NEUTRAL",

    adx15: Number(num(signal?.metrics?.adx15).toFixed(2)),
    distEma20_5: Number(num(signal?.metrics?.distEma20_5).toFixed(3)),
    oiConfirmation: signal?.metrics?.oiConfirmation || "NEUTRAL",

    setupType,
    validLong: Boolean(signal?.setup?.validLong),
    validShort: Boolean(signal?.setup?.validShort),
    bullishCloseConfirmation,
    bearishCloseConfirmation,

    bodyStrength5: Number(bodyStrength5.toFixed(3)),
    upperWick5: Number(upperWick5.toFixed(3)),
    lowerWick5: Number(lowerWick5.toFixed(3)),

    alreadyActive: activeTrades.some((t) => t.symbol === item.symbol && t.status === "OPEN"),
    isNoTrade: direction === "NO_TRADE",
    rawSignal: signal,
    timestamp: Date.now()
  };
}

function evaluateFinding(finding, cfg) {
  if (finding.isNoTrade) {
    return { ok: false, reason: "NO_TRADE" };
  }

  if (finding.probability < cfg.minProbability) {
    return { ok: false, reason: "LOW_PROBABILITY" };
  }

  if (finding.score < cfg.minScore) {
    return { ok: false, reason: "LOW_SCORE" };
  }

  if (finding.edge < cfg.minEdge) {
    return { ok: false, reason: "LOW_EDGE" };
  }

  if (finding.confidence === "LOW") {
    return { ok: false, reason: "LOW_CONFIDENCE" };
  }

  if (finding.adx15 < cfg.minAdx15) {
    return { ok: false, reason: "LOW_ADX" };
  }

  if (Math.abs(finding.distEma20_5) > cfg.maxAbsDistEma20_5) {
    return { ok: false, reason: "TOO_EXTENDED" };
  }

  if (finding.bodyStrength5 < cfg.minBodyStrength5) {
    return { ok: false, reason: "WEAK_CANDLE" };
  }

  if (!cfg.allowTransitionRegime && finding.regime === "TRANSITION") {
    return { ok: false, reason: "TRANSITION_BLOCKED" };
  }

  if (finding.regime === "COMPRESSION") {
    return { ok: false, reason: "COMPRESSION" };
  }

  // Confirmación direccional mínima
  if (finding.direction === "LONG") {
    if (!finding.validLong) {
      return { ok: false, reason: "INVALID_LONG_SETUP" };
    }
    if (!finding.bullishCloseConfirmation) {
      return { ok: false, reason: "NO_BULL_CONFIRM" };
    }
    if (finding.upperWick5 > cfg.maxOppositeWickRatio) {
      return { ok: false, reason: "BAD_UPPER_WICK" };
    }
  }

  if (finding.direction === "SHORT") {
    if (!finding.validShort) {
      return { ok: false, reason: "INVALID_SHORT_SETUP" };
    }
    if (!finding.bearishCloseConfirmation) {
      return { ok: false, reason: "NO_BEAR_CONFIRM" };
    }
    if (finding.lowerWick5 > cfg.maxOppositeWickRatio) {
      return { ok: false, reason: "BAD_LOWER_WICK" };
    }
  }

  // Breakouts más estrictos que los pullbacks
  if (finding.setupType === "BREAKOUT_LONG" && finding.upperWick5 > 0.35) {
    return { ok: false, reason: "DIRTY_BREAKOUT_LONG" };
  }

  if (finding.setupType === "BREAKOUT_SHORT" && finding.lowerWick5 > 0.35) {
    return { ok: false, reason: "DIRTY_BREAKOUT_SHORT" };
  }

  return { ok: true, reason: "ACCEPTED" };
}

function sortFindings(a, b) {
  if (a.alreadyActive !== b.alreadyActive) {
    return a.alreadyActive ? 1 : -1;
  }

  const aSetup = setupRank(a.setupType);
  const bSetup = setupRank(b.setupType);
  if (bSetup !== aSetup) return bSetup - aSetup;

  const aConf = confRank(a.confidence);
  const bConf = confRank(b.confidence);
  if (bConf !== aConf) return bConf - aConf;

  if (b.edge !== a.edge) return b.edge - a.edge;
  if (b.score !== a.score) return b.score - a.score;
  if (b.bodyStrength5 !== a.bodyStrength5) return b.bodyStrength5 - a.bodyStrength5;
  if (b.probability !== a.probability) return b.probability - a.probability;

  return a.symbol.localeCompare(b.symbol);
}

function buildEmptyStats(cfg, symbolsCount, activeTradesCount) {
  return {
    at: Date.now(),
    config: {
      batchSize: cfg.batchSize,
      intervalMs: cfg.intervalMs,
      signalPeriod: cfg.signalPeriod,
      minProbability: cfg.minProbability,
      minScore: cfg.minScore,
      minEdge: cfg.minEdge,
      maxFindings: cfg.maxFindings,
      findingTtlMs: cfg.findingTtlMs,
      minAdx15: cfg.minAdx15,
      maxAbsDistEma20_5: cfg.maxAbsDistEma20_5,
      minBodyStrength5: cfg.minBodyStrength5,
      maxOppositeWickRatio: cfg.maxOppositeWickRatio,
      allowTransitionRegime: cfg.allowTransitionRegime
    },
    universeSize: symbolsCount,
    activeTrades: activeTradesCount,
    batch: {
      start: 0,
      end: 0,
      size: 0
    },
    totals: {
      inspected: 0,
      fulfilled: 0,
      rejected: 0,
      accepted: 0,
      requestErrors: 0,
      keptAfterMerge: 0
    },
    rejectedBy: {
      NO_TRADE: 0,
      LOW_PROBABILITY: 0,
      LOW_SCORE: 0,
      LOW_EDGE: 0,
      LOW_CONFIDENCE: 0,
      LOW_ADX: 0,
      TOO_EXTENDED: 0,
      WEAK_CANDLE: 0,
      COMPRESSION: 0,
      TRANSITION_BLOCKED: 0,
      INVALID_LONG_SETUP: 0,
      INVALID_SHORT_SETUP: 0,
      NO_BULL_CONFIRM: 0,
      NO_BEAR_CONFIRM: 0,
      BAD_UPPER_WICK: 0,
      BAD_LOWER_WICK: 0,
      DIRTY_BREAKOUT_LONG: 0,
      DIRTY_BREAKOUT_SHORT: 0
    }
  };
}

function pushDebugError(errors, item, error, cfg) {
  errors.push({
    symbol: item?.symbol || null,
    market: item?.market || null,
    message: error?.message || String(error),
    at: Date.now()
  });

  if (errors.length > cfg.debugMaxErrors) {
    errors.splice(0, errors.length - cfg.debugMaxErrors);
  }
}

function logScannerDebug(stats, errors, findings, cfg) {
  if (!cfg.debug) return;

  console.log("[scanner] stats", JSON.stringify(stats, null, 2));

  if (errors.length) {
    console.log("[scanner] recent errors", JSON.stringify(errors.slice(-10), null, 2));
  }

  if (findings.length) {
    console.log(
      "[scanner] top findings",
      JSON.stringify(
        findings.slice(0, 10).map((x) => ({
          symbol: x.symbol,
          direction: x.direction,
          probability: x.probability,
          edge: x.edge,
          score: x.score,
          confidence: x.confidence,
          regime: x.regime,
          adx15: x.adx15,
          setupType: x.setupType,
          bodyStrength5: x.bodyStrength5,
          upperWick5: x.upperWick5,
          lowerWick5: x.lowerWick5,
          distEma20_5: x.distEma20_5,
          alreadyActive: x.alreadyActive
        })),
        null,
        2
      )
    );
  } else {
    console.log("[scanner] no findings accepted in this pass");
  }
}

function sanitizeFindingForState(finding) {
  const { rawSignal, ...rest } = finding;
  return rest;
}

export async function scanMarketBatch(symbols, activeTrades) {
  if (scannerState.running) return scannerState.findings;

  scannerState.running = true;

  try {
    const cfg = getScannerConfig();
    const now = Date.now();
    const elapsedSinceLastRun = now - num(scannerState.lastRunAt);
    const shouldThrottle = scannerState.lastRunAt > 0 && elapsedSinceLastRun < cfg.intervalMs;

    if (shouldThrottle) {
      return scannerState.findings;
    }

    const stats = buildEmptyStats(cfg, symbols.length, activeTrades.length);

    const start = scannerState.batchOffset;
    const end = Math.min(start + cfg.batchSize, symbols.length);
    const slice = symbols.slice(start, end);

    stats.batch.start = start;
    stats.batch.end = end;
    stats.batch.size = slice.length;

    if (slice.length === 0) {
      scannerState.batchOffset = 0;
      scannerState.lastRunAt = Date.now();
      scannerState.lastStats = stats;
      return scannerState.findings;
    }

    const results = await Promise.allSettled(
      slice.map((item) => getSignalForSymbol(item.symbol, cfg.signalPeriod))
    );

    const freshFindings = [];
    const debugErrors = [...scannerState.lastErrors];

    for (let i = 0; i < slice.length; i += 1) {
      const item = slice[i];
      const result = results[i];

      stats.totals.inspected += 1;

      if (result.status !== "fulfilled") {
        stats.totals.requestErrors += 1;
        pushDebugError(debugErrors, item, result.reason, cfg);
        continue;
      }

      stats.totals.fulfilled += 1;

      const signal = result.value;
      const finding = normalizeFinding(item, signal, activeTrades);
      const verdict = evaluateFinding(finding, cfg);

      if (!verdict.ok) {
        stats.totals.rejected += 1;
        if (stats.rejectedBy[verdict.reason] !== undefined) {
          stats.rejectedBy[verdict.reason] += 1;
        }
        continue;
      }

      stats.totals.accepted += 1;
      freshFindings.push(finding);
    }

    const previousFresh = (scannerState.findings || []).filter(
      (x) => now - num(x.timestamp) <= cfg.findingTtlMs
    );

    const merged = [
      ...previousFresh,
      ...freshFindings.map(sanitizeFindingForState)
    ].sort(sortFindings);

    const dedup = [];
    const seen = new Set();

    for (const item of merged) {
      if (seen.has(item.symbol)) continue;
      seen.add(item.symbol);
      dedup.push(item);
    }

    scannerState.findings = dedup.slice(0, cfg.maxFindings);
    scannerState.lastRunAt = now;
    scannerState.lastStats = {
      ...stats,
      totals: {
        ...stats.totals,
        keptAfterMerge: scannerState.findings.length
      }
    };
    scannerState.lastErrors = debugErrors;
    scannerState.batchOffset = end >= symbols.length ? 0 : end;

    logScannerDebug(scannerState.lastStats, scannerState.lastErrors, scannerState.findings, cfg);

    return scannerState.findings;
  } finally {
    scannerState.running = false;
  }
}

export function getScannerState() {
  return scannerState;
}
