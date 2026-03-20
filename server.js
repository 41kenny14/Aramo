import express from "express";
import cors from "cors";
import config from "./config.js";
import {
  getAllFuturesMarkets,
  getFuturesBalances,
  getMarketStatus,
  getMarketTicker,
  getCurrentPositions,
  setLeverage,
  placeFuturesOrder,
  closePosition,
  setPositionStopLoss,
  setPositionTakeProfit,
  cancelAllPendingOrders
} from "./coinex.js";
import { getSignalForSymbol } from "./signalEngine.js";
import { adviseTrade } from "./tradeAdvisor.js";
import { scanMarketBatch, getScannerState } from "./scannerEngine.js";
import { registerLearningTradeOpen, registerLearningTradeClose } from "./learningEngine.js";
import {
  resolveLeverage,
  canOpenNewTrade,
  sizeBySignal,
  isBlockedSymbol,
  isMemeSymbol,
  getSignalEdge
} from "./riskEngine.js";
import { logTradeOpen, logTradeClose, logAdvice, getOpenTrades, getTradingStatistics, logBotFeedback } from "./db.js";

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const runtime = {
  locked: false,
  status: "idle",
  lastError: null,
  lastAction: null,
  marginMode: config.coinex.defaultMarginMode,
  autoEnabled: Boolean(config.auto.enabled),
  reverseMode: false,
  accountState: {
    lossStreak: 0,
    wins: 0,
    losses: 0,
    closedTrades: 0,
    dailyPnlPct: 0,
    dailyTrades: 0,
    dailyWins: 0,
    dailyLosses: 0,
    dailyResetAt: new Date().setHours(0, 0, 0, 0),
    autoPauseUntil: 0,
    guardrailReason: null,
    lastTradeAt: 0,
    hourTradeTimestamps: [],
    dayTradeTimestamps: [],
    sniperMode: Boolean(config.strategy?.sniperMode),
    gridMode: Boolean(config.strategy?.gridModeEnabled),
    optimizer: { version: 1, lastRunAt: 0, lastSummary: null },
    autoExecutionMode: "SNIPER"
  }
};

function flipDirection(direction) {
  if (direction === "LONG") return "SHORT";
  if (direction === "SHORT") return "LONG";
  return direction;
}

function invertProbabilities(probabilities = {}) {
  return {
    ...probabilities,
    longProb: numberOrZero(probabilities.shortProb),
    shortProb: numberOrZero(probabilities.longProb)
  };
}

const marketsCache = {
  fetchedAt: 0,
  symbols: [],
  rawCount: 0
};

const draftTrades = new Map();
const activeTrades = new Map();
const autoOpenedTrades = [];
const autoClosedTrades = [];
const symbolState = new Map();
const symbolLocks = new Map();
const gridStates = new Map();
const autoEntryDiagnostics = {
  cycleStartedAt: 0,
  cycleFinishedAt: 0,
  findingsEvaluated: 0,
  rejectsByReason: {},
  lastRejectReason: null,
  lastRejectAt: 0
};
const externalSyncState = {
  running: false,
  lastRunAt: 0,
  lastError: null,
  imported: 0,
  closed: 0
};

const MAX_DRAFT_AGE_MS = 60 * 1000;

function getRiskThresholds() {
  return {
    minScore: numberOrZero(config.scanner?.minScore || 42),
    minEdge: numberOrZero(config.scanner?.minEdge || 3)
  };
}

function cleanupExpiredDrafts() {
  const now = Date.now();
  let removed = 0;

  for (const [draftId, preview] of draftTrades.entries()) {
    const createdAt = numberOrZero(preview?.trade?.createdAt);
    if (createdAt > 0 && now - createdAt > MAX_DRAFT_AGE_MS) {
      draftTrades.delete(draftId);
      removed += 1;
    }
  }

  return removed;
}

function resetAutoEntryDiagnosticsCycle() {
  autoEntryDiagnostics.cycleStartedAt = Date.now();
  autoEntryDiagnostics.cycleFinishedAt = 0;
  autoEntryDiagnostics.findingsEvaluated = 0;
  autoEntryDiagnostics.rejectsByReason = {};
}

function addAutoEntryReject(reason) {
  const normalized = String(reason || "UNKNOWN");
  autoEntryDiagnostics.lastRejectReason = normalized;
  autoEntryDiagnostics.lastRejectAt = Date.now();
  autoEntryDiagnostics.rejectsByReason[normalized] =
    numberOrZero(autoEntryDiagnostics.rejectsByReason[normalized]) + 1;
}


function canPassAntiOvertradingGuards() {
  const now = Date.now();
  const minGapMin = numberOrZero(config.strategy?.minMinutesBetweenTrades || 10);
  if (runtime.accountState.lastTradeAt > 0 && now - runtime.accountState.lastTradeAt < minGapMin * 60_000) {
    return { ok: false, reason: `Cooldown activo: esperar ${minGapMin} min entre trades.` };
  }

  runtime.accountState.hourTradeTimestamps = runtime.accountState.hourTradeTimestamps.filter((ts) => now - ts < 3_600_000);
  runtime.accountState.dayTradeTimestamps = runtime.accountState.dayTradeTimestamps.filter((ts) => now - ts < 86_400_000);

  if (runtime.accountState.hourTradeTimestamps.length >= numberOrZero(config.strategy?.maxTradesPerHour || 3)) {
    return { ok: false, reason: "Límite de trades por hora alcanzado." };
  }

  if (runtime.accountState.dayTradeTimestamps.length >= numberOrZero(config.strategy?.maxTradesPerDay || 12)) {
    return { ok: false, reason: "Límite global de trades por día alcanzado." };
  }

  if (numberOrZero(runtime.accountState.dailyPnlPct) <= -numberOrZero(config.strategy?.maxDailyDrawdownPct || 3)) {
    return { ok: false, reason: "Drawdown diario máximo alcanzado." };
  }

  if (numberOrZero(runtime.accountState.lossStreak) >= numberOrZero(config.strategy?.maxConsecutiveLossesPause || 3)) {
    runtime.accountState.autoPauseUntil = now + numberOrZero(config.strategy?.pauseMinutesAfterLossStreak || 90) * 60_000;
    return { ok: false, reason: "Pausa por racha negativa." };
  }

  return { ok: true, reason: "OK" };
}

function buildGridPlan({ signal, markPrice, marketInfo }) {
  const gridLevels = Math.max(2, Math.floor(numberOrZero(config.strategy?.gridLevels || 6)));
  const levelsEachSide = Math.max(1, Math.floor(gridLevels / 2));
  const atrPct15 = numberOrZero(signal?.metrics?.atrPct15 || 0.2);
  const stepPct = Math.max(
    numberOrZero(config.strategy?.gridStepPct || 0.25),
    atrPct15 * numberOrZero(config.strategy?.gridStepAtrMultiplier || 0.8)
  );

  const liqTop = numberOrZero(signal?.metrics?.liquidityBuySide);
  const liqBottom = numberOrZero(signal?.metrics?.liquiditySellSide);

  const fallbackTop = markPrice * (1 + ((stepPct * (levelsEachSide + 1)) / 100));
  const fallbackBottom = markPrice * (1 - ((stepPct * (levelsEachSide + 1)) / 100));

  const upperBound = liqTop > markPrice ? liqTop : fallbackTop;
  const lowerBound = liqBottom > 0 && liqBottom < markPrice ? liqBottom : fallbackBottom;

  const tick = numberOrZero(marketInfo?.tick_size || 0.0001);
  const buyLevels = [];
  const sellLevels = [];

  for (let i = 1; i <= levelsEachSide; i += 1) {
    buyLevels.push(fixedByTick(markPrice * (1 - ((stepPct * i) / 100)), tick));
    sellLevels.push(fixedByTick(markPrice * (1 + ((stepPct * i) / 100)), tick));
  }

  return {
    gridLevels,
    levelsEachSide,
    stepPct: Number(stepPct.toFixed(4)),
    atrPct15: Number(atrPct15.toFixed(4)),
    upperBound: Number(upperBound.toFixed(8)),
    lowerBound: Number(lowerBound.toFixed(8)),
    buyLevels,
    sellLevels
  };
}

async function runGridExecutionForSymbol(item, availableUsdt) {
  const symbol = item.symbol;
  const market = buildMarket(symbol);
  const signal = item?.rawSignal || null;
  if (!signal) return;

  const marketState = String(signal?.marketState || "AMBIGUOUS");
  const atrRatio = numberOrZero(signal?.metrics?.atrRatio);
  const squeeze = Boolean(signal?.metrics?.squeeze);

  const existingGrid = gridStates.get(symbol);

  const shouldDisableGrid =
    marketState !== "LATERAL_RANGE" ||
    atrRatio >= 1.35 ||
    squeeze;

  if (shouldDisableGrid) {
    if (existingGrid?.active) {
      await cancelAllPendingOrders(market);
      gridStates.delete(symbol);
      runtime.lastAction = `grid_disabled_${symbol}`;
    }
    return;
  }

  const now = Date.now();
  if (existingGrid?.lastPlacedAt && now - existingGrid.lastPlacedAt < 45_000) {
    return;
  }

  const hasOpenTrade = [...activeTrades.values()].some((t) => t.symbol === symbol && t.status === "OPEN");
  if (hasOpenTrade) return;

  const [marketInfo, tickerList] = await Promise.all([
    getMarketStatus(market),
    getMarketTicker(market)
  ]);

  if (!marketInfo?.is_market_available || !marketInfo?.is_api_trading_available) return;

  const ticker = Array.isArray(tickerList) ? tickerList[0] : null;
  const markPrice = numberOrZero(ticker?.mark_price || ticker?.last);
  if (markPrice <= 0) return;

  const leverage = resolveLeverage(marketInfo, signal, symbol);
  await setLeverage({ market, leverage, marginMode: runtime.marginMode });

  const basePrecision = Number(marketInfo.base_ccy_precision);
  const minAmount = numberOrZero(marketInfo.min_amount);

  const plan = buildGridPlan({ signal, markPrice, marketInfo });
  const safePercent = Math.min(getAdaptiveAutoPercent(symbol), 18);
  const totalUsdtBudget = availableUsdt * (safePercent / 100);

  if (totalUsdtBudget <= 0) return;

  const perOrderMargin = totalUsdtBudget / (plan.buyLevels.length + plan.sellLevels.length);
  const perOrderNotional = perOrderMargin * leverage;
  if (perOrderNotional <= 0) return;

  await cancelAllPendingOrders(market);

  for (const priceText of plan.buyLevels) {
    const price = numberOrZero(priceText);
    if (price <= 0) continue;
    const amountRaw = perOrderNotional / price;
    const amount = Number(fixedByDecimals(Math.max(amountRaw, minAmount), basePrecision));
    await placeFuturesOrder({
      market,
      side: "buy",
      type: "limit",
      price,
      amount,
      clientId: makeId(`GRID_B_${symbol}`)
    });
  }

  for (const priceText of plan.sellLevels) {
    const price = numberOrZero(priceText);
    if (price <= 0) continue;
    const amountRaw = perOrderNotional / price;
    const amount = Number(fixedByDecimals(Math.max(amountRaw, minAmount), basePrecision));
    await placeFuturesOrder({
      market,
      side: "sell",
      type: "limit",
      price,
      amount,
      clientId: makeId(`GRID_S_${symbol}`)
    });
  }

  gridStates.set(symbol, {
    active: true,
    lastPlacedAt: now,
    plan
  });

  runtime.lastAction = `grid_orders_placed_${symbol}`;
}

function buildLimitPlan({ signal, markPrice, marketInfo, direction, entryOverride }) {
  const atrPct15 = numberOrZero(signal?.metrics?.atrPct15 || 0.25);
  const spreadBufferPct = Math.max(atrPct15 * 0.12, 0.05);
  const offsetPct = Math.max(atrPct15 * 0.35, spreadBufferPct);
  const tick = numberOrZero(marketInfo?.tick_size || 0.0001);
  const manualEntry = numberOrZero(entryOverride);

  if (manualEntry > 0) {
    return {
      entryPrice: fixedByTick(manualEntry, tick),
      offsetPct: Number(offsetPct.toFixed(4)),
      atrPct15: Number(atrPct15.toFixed(4)),
      spreadBufferPct: Number(spreadBufferPct.toFixed(4)),
      fillProbability: 0.65,
      entrySource: "MANUAL",
      zoneType: signal?.entryPlan?.zoneType || "NONE",
      zoneStrength: Number(numberOrZero(signal?.entryPlan?.zoneStrength).toFixed(2))
    };
  }

  const fallbackEntryPrice = direction === "LONG"
    ? fixedByTick(markPrice * (1 - offsetPct / 100), tick)
    : fixedByTick(markPrice * (1 + offsetPct / 100), tick);

  const zoneEnabled = Boolean(signal?.entryPlan?.enabled);
  const zonePrice = numberOrZero(signal?.entryPlan?.zonePrice);

  const validZoneForLong = direction === "LONG" && zonePrice > 0 && zonePrice < markPrice;
  const validZoneForShort = direction === "SHORT" && zonePrice > 0 && zonePrice > markPrice;
  const useInterestZone = zoneEnabled && (validZoneForLong || validZoneForShort);

  const rawEntryPrice = useInterestZone ? zonePrice : fallbackEntryPrice;
  const entryPrice = fixedByTick(rawEntryPrice, tick);

  return {
    entryPrice,
    offsetPct: Number(offsetPct.toFixed(4)),
    atrPct15: Number(atrPct15.toFixed(4)),
    spreadBufferPct: Number(spreadBufferPct.toFixed(4)),
    fillProbability: useInterestZone ? 0.78 : (offsetPct <= atrPct15 ? 0.72 : 0.55),
    entrySource: useInterestZone ? "INTEREST_ZONE" : "ATR_OFFSET",
    zoneType: signal?.entryPlan?.zoneType || "NONE",
    zoneStrength: Number(numberOrZero(signal?.entryPlan?.zoneStrength).toFixed(2))
  };
}

function resetDailyAccountStateIfNeeded() {
  const todayStart = new Date().setHours(0, 0, 0, 0);
  if (numberOrZero(runtime.accountState.dailyResetAt) === todayStart) return;

  runtime.accountState.dailyResetAt = todayStart;
  runtime.accountState.dailyPnlPct = 0;
  runtime.accountState.dailyTrades = 0;
  runtime.accountState.dailyWins = 0;
  runtime.accountState.dailyLosses = 0;
}

function updateAccountStatsOnClose(pnlPct) {
  resetDailyAccountStateIfNeeded();

  const pnl = numberOrZero(pnlPct);
  runtime.accountState.closedTrades += 1;
  runtime.accountState.dailyTrades += 1;
  runtime.accountState.dailyPnlPct += pnl;

  if (pnl < 0) {
    runtime.accountState.losses += 1;
    runtime.accountState.dailyLosses += 1;
  } else {
    runtime.accountState.wins += 1;
    runtime.accountState.dailyWins += 1;
  }
}

function maybePauseAutoByGuardrails() {
  resetDailyAccountStateIfNeeded();

  const now = Date.now();
  if (numberOrZero(runtime.accountState.autoPauseUntil) > now) {
    return {
      ok: false,
      reason: `Auto pausado hasta ${new Date(runtime.accountState.autoPauseUntil).toLocaleTimeString()}`
    };
  }

  const maxDailyLossPct = numberOrZero(config.auto.autoMaxDailyLossPct || 2.5);
  const maxConsecutiveLosses = numberOrZero(config.auto.autoMaxConsecutiveLosses || 4);
  const maxTradesPerDay = numberOrZero(config.auto.autoMaxTradesPerDay || 12);
  const minWinRateSample = numberOrZero(config.auto.autoMinWinRateSample || 12);
  const minWinRatePct = numberOrZero(config.auto.autoMinWinRatePct || 45);

  const closed = numberOrZero(runtime.accountState.closedTrades);
  const wins = numberOrZero(runtime.accountState.wins);
  const winRatePct = closed > 0 ? (wins / closed) * 100 : 100;

  let reason = null;

  if (numberOrZero(runtime.accountState.dailyPnlPct) <= -maxDailyLossPct) {
    reason = `Guardrail: pérdida diaria límite (${runtime.accountState.dailyPnlPct.toFixed(2)}%).`;
  } else if (numberOrZero(runtime.accountState.lossStreak) >= maxConsecutiveLosses) {
    reason = `Guardrail: racha de pérdidas (${runtime.accountState.lossStreak}).`;
  } else if (numberOrZero(runtime.accountState.dailyTrades) >= maxTradesPerDay) {
    reason = `Guardrail: máximo de trades diarios (${runtime.accountState.dailyTrades}).`;
  } else if (closed >= minWinRateSample && winRatePct < minWinRatePct) {
    reason = `Guardrail: win rate global bajo (${winRatePct.toFixed(1)}%).`;
  }

  if (!reason) {
    runtime.accountState.guardrailReason = null;
    return { ok: true, reason: "OK" };
  }

  const pauseMinutes = numberOrZero(config.auto.autoPauseMinutesAfterGuardrail || 120);
  runtime.accountState.autoPauseUntil = now + pauseMinutes * 60 * 1000;
  runtime.accountState.guardrailReason = reason;

  return { ok: false, reason };
}

function getAdaptiveAutoPercent(symbol) {
  const basePercent = isMemeSymbol(symbol)
    ? Math.min(config.auto.defaultPercent, 10)
    : config.auto.defaultPercent;

  const lossStreak = numberOrZero(runtime.accountState.lossStreak);
  const closed = numberOrZero(runtime.accountState.closedTrades);
  const wins = numberOrZero(runtime.accountState.wins);
  const winRatePct = closed > 0 ? (wins / closed) * 100 : 100;

  let factor = 1;
  if (lossStreak >= 3) factor *= 0.45;
  else if (lossStreak === 2) factor *= 0.6;
  else if (lossStreak === 1) factor *= 0.8;

  if (closed >= numberOrZero(config.auto.autoMinWinRateSample || 12)) {
    if (winRatePct < 45) factor *= 0.55;
    else if (winRatePct < 55) factor *= 0.75;
  }

  const pct = Math.max(5, Math.min(basePercent, Math.round(basePercent * factor)));
  return pct;
}

function getAdaptiveAutoRisk(item) {
  const defaultStopLossPct = numberOrZero(config.auto.defaultStopLossPct);
  const defaultTakeProfitPct = numberOrZero(config.auto.defaultTakeProfitPct);

  const rr = defaultStopLossPct > 0
    ? defaultTakeProfitPct / defaultStopLossPct
    : 1;

  const atrPct15 = numberOrZero(item?.rawSignal?.metrics?.atrPct15);
  const setupType = String(item?.setupType || "NONE");
  const atrMultiplier = setupType.startsWith("BREAKOUT") ? 1.35 : 1.1;

  const volatilityFloor = atrPct15 > 0 ? atrPct15 * atrMultiplier : 0;
  const stopLossPct = Number(
    Math.min(Math.max(defaultStopLossPct, volatilityFloor), 3).toFixed(3)
  );

  const takeProfitPct = Number(
    Math.max(defaultTakeProfitPct, stopLossPct * Math.max(rr, 1)).toFixed(3)
  );

  return {
    stopLossPct,
    takeProfitPct,
    atrPct15: Number(atrPct15.toFixed(4))
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function numberOrZero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalizeSymbol(raw) {
  return String(raw || "").trim().toUpperCase();
}

function buildMarket(symbol) {
  return `${symbol}USDT`;
}

function hasOpenPosition(position) {
  return position && numberOrZero(position.open_interest) > 0;
}

function roundToTick(value, tickSize) {
  const tick = Number(tickSize);
  if (!Number.isFinite(value) || !Number.isFinite(tick) || tick <= 0) return value;
  return Math.round(value / tick) * tick;
}

function getTickDecimals(tickSize) {
  const tickNum = Number(tickSize);
  if (!Number.isFinite(tickNum) || tickNum <= 0) return 8;

  const tickRaw = String(tickSize).trim().toLowerCase();
  if (tickRaw.includes("e-")) {
    const exp = Number(tickRaw.split("e-")[1]);
    if (Number.isFinite(exp) && exp >= 0) return Math.min(12, exp);
  }

  if (tickRaw.includes(".")) {
    const fraction = tickRaw.split(".")[1] || "";
    if (!fraction) return 0;
    return Math.min(12, fraction.replace(/0+$/, "").length || fraction.length);
  }

  const normalized = tickNum.toString();
  if (normalized.includes("e-")) {
    const exp = Number(normalized.split("e-")[1]);
    if (Number.isFinite(exp) && exp >= 0) return Math.min(12, exp);
  }

  if (normalized.includes(".")) {
    const fraction = normalized.split(".")[1] || "";
    return Math.min(12, fraction.replace(/0+$/, "").length || fraction.length);
  }

  return 0;
}

function fixedByTick(value, tickSize) {
  const decimals = getTickDecimals(tickSize);
  return roundToTick(value, tickSize).toFixed(decimals);
}

function fixedByDecimals(value, decimals) {
  return Number(value).toFixed(decimals);
}

function makeId(prefix = "ID") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getOrCreateSymbolState(symbol) {
  if (!symbolState.has(symbol)) {
    symbolState.set(symbol, {
      consecutiveLosses: 0,
      lastTradeAt: 0,
      cooldownUntil: 0
    });
  }
  return symbolState.get(symbol);
}

function markSymbolTradeOpen(symbol) {
  const state = getOrCreateSymbolState(symbol);
  state.lastTradeAt = Date.now();
}

function markSymbolTradeClose(symbol, pnlPct = 0) {
  const state = getOrCreateSymbolState(symbol);
  state.lastTradeAt = Date.now();

  if (pnlPct < 0) {
    state.consecutiveLosses += 1;
    runtime.accountState.lossStreak += 1;
  } else {
    state.consecutiveLosses = 0;
    runtime.accountState.lossStreak = 0;
  }

  if (state.consecutiveLosses >= config.risk.symbolFilters.maxConsecutiveLossesBeforeCooldown) {
    state.cooldownUntil =
      Date.now() + config.risk.symbolFilters.cooldownMinutesAfterLossStreak * 60 * 1000;
  }

  updateAccountStatsOnClose(pnlPct);
}

function calcRoePctFromPosition(position) {
  const unrealizedPnl = numberOrZero(position?.unrealized_pnl);
  const marginAvbl = numberOrZero(position?.margin_avbl);

  if (marginAvbl <= 0) return 0;
  return (unrealizedPnl / marginAvbl) * 100;
}

function calcEstimatedPnlPct(trade, currentPosition) {
  const mark = numberOrZero(currentPosition?.mark_price || currentPosition?.last);
  const entry = numberOrZero(trade?.entryPrice);

  if (entry <= 0 || mark <= 0) return 0;

  return trade.direction === "LONG"
    ? ((mark - entry) / entry) * 100
    : ((entry - mark) / entry) * 100;
}

function acquireSymbolLock(symbol) {
  if (symbolLocks.get(symbol)) return false;
  symbolLocks.set(symbol, true);
  return true;
}

function releaseSymbolLock(symbol) {
  symbolLocks.delete(symbol);
}

function buildAdjustedSizing({
  marketInfo,
  entryPrice,
  leverage,
  usdtAvailable,
  sizing
}) {
  const minAmount = numberOrZero(marketInfo?.min_amount);

  let finalAmount = numberOrZero(sizing?.amount);
  let finalEffectivePercent = numberOrZero(sizing?.effectivePercent);
  let finalUsableMargin = numberOrZero(sizing?.usableMargin);
  let finalNotional = numberOrZero(sizing?.notional);

  if (finalAmount < minAmount) {
    const minNotional = minAmount * entryPrice;
    const minUsableMargin = leverage > 0 ? minNotional / leverage : minNotional;
    const minEffectivePercent = usdtAvailable > 0 ? (minUsableMargin / usdtAvailable) * 100 : 0;

    if (minUsableMargin > usdtAvailable) {
      throw new Error(
        `No alcanza balance para llegar al min_amount ${minAmount}. Requiere margen aprox ${minUsableMargin.toFixed(6)} USDT.`
      );
    }

    finalAmount = minAmount;
    finalNotional = Number(minNotional.toFixed(6));
    finalUsableMargin = Number(minUsableMargin.toFixed(6));
    finalEffectivePercent = Number(minEffectivePercent.toFixed(2));
  }

  return {
    minAmount,
    finalAmount,
    finalEffectivePercent,
    finalUsableMargin,
    finalNotional
  };
}

function validateSignalPeriod(period) {
  const validPeriods = new Set([
    "1min", "3min", "5min", "15min", "30min",
    "1hour", "2hour", "4hour", "6hour", "12hour",
    "1day", "3day", "1week"
  ]);

  if (!validPeriods.has(period)) throw new Error("Período inválido.");
}

function toBoundedNumber(value, { min, max, name }) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`${name} debe ser numérico.`);
  }
  if (n < min || n > max) {
    throw new Error(`${name} fuera de rango (${min} - ${max}).`);
  }
  return n;
}

function getRuntimeConfigSnapshot() {
  return {
    scanner: {
      intervalMs: numberOrZero(config.scanner?.intervalMs),
      minProbability: numberOrZero(config.scanner?.minProbability),
      minScore: numberOrZero(config.scanner?.minScore),
      minEdge: numberOrZero(config.scanner?.minEdge)
    },
    auto: {
      autoScanIntervalMs: numberOrZero(config.auto?.autoScanIntervalMs),
      autoEntryProbability: numberOrZero(config.auto?.autoEntryProbability),
      autoMinScore: numberOrZero(config.auto?.autoMinScore),
      autoMinEdge: numberOrZero(config.auto?.autoMinEdge)
    }
  };
}

function validatePreviewPayload(body, allowedSymbols) {
  const symbol = normalizeSymbol(body.symbol);
  const percent = Number(body.percent);
  const useStopLoss = body.useStopLoss !== false;
  const useTakeProfit = body.useTakeProfit !== false;
  const stopLossPct = useStopLoss ? Number(body.stopLossPct) : null;
  const takeProfitPct = useTakeProfit ? Number(body.takeProfitPct) : null;
  const entryPriceRaw = Number(body.entryPrice);
  const entryPrice = Number.isFinite(entryPriceRaw) && entryPriceRaw > 0 ? entryPriceRaw : null;
  const signalPeriod = String(body.signalPeriod || "5min");
  const directionMode = String(body.directionMode || "AUTO").toUpperCase();

  if (!allowedSymbols.includes(symbol)) {
    throw new Error("Símbolo inválido o no disponible en USDT.");
  }

  const validPercents = new Set([5, 10, 15, 20, 25, 50, 75, 100]);
  if (!validPercents.has(percent)) throw new Error("Porcentaje inválido.");
  if (useStopLoss && (!Number.isFinite(stopLossPct) || stopLossPct <= 0)) throw new Error("Stop Loss % inválido.");
  if (useTakeProfit && (!Number.isFinite(takeProfitPct) || takeProfitPct <= 0)) throw new Error("Take Profit % inválido.");
  if (useStopLoss && useTakeProfit) {
    const rr = takeProfitPct / stopLossPct;
    if (rr < 1.25) throw new Error("Riesgo/beneficio insuficiente: TP/SL debe ser >= 1.25.");
  }

  validateSignalPeriod(signalPeriod);

  const validDirectionModes = new Set(["AUTO", "ORIGINAL", "INVERTED"]);
  if (!validDirectionModes.has(directionMode)) {
    throw new Error("Modo de dirección inválido.");
  }

  return {
    symbol,
    percent,
    stopLossPct,
    takeProfitPct,
    useStopLoss,
    useTakeProfit,
    entryPrice,
    signalPeriod,
    directionMode
  };
}

function validateSignalForEntry(signal) {
  if (!signal) throw new Error("No hay señal.");
  if (signal.suggestedAction === "NO_TRADE") {
    throw new Error("Setup descartado: señal NO_TRADE.");
  }

  const edge = getSignalEdge(signal);

  const { minScore, minEdge } = getRiskThresholds();

  if (numberOrZero(signal.score) < minScore) {
    throw new Error(`Setup descartado: score bajo (${signal.score}).`);
  }

  if (edge < minEdge) {
    throw new Error(`Setup descartado: ventaja direccional insuficiente (${edge.toFixed(1)}).`);
  }

  if ((signal.confidence || "LOW") === "LOW") {
    throw new Error("Setup descartado: confidence LOW.");
  }

  const setupType = signal?.setup?.type || "NONE";
  const adx15 = numberOrZero(signal?.metrics?.adx15);
  const distEma20 = Math.abs(numberOrZero(signal?.metrics?.distEma20_5));
  const bodyStrength = numberOrZero(signal?.metrics?.bodyStrength5);
  const upperWick = numberOrZero(signal?.metrics?.upperWick5);
  const lowerWick = numberOrZero(signal?.metrics?.lowerWick5);

  if (adx15 < 14) {
    throw new Error(`Setup descartado: ADX bajo (${adx15.toFixed(2)}).`);
  }

  if (distEma20 > 1.1) {
    throw new Error(`Setup descartado: entrada muy extendida respecto a EMA20 (${distEma20.toFixed(3)}%).`);
  }

  if (bodyStrength < 0.35) {
    throw new Error(`Setup descartado: vela débil (${bodyStrength.toFixed(3)}).`);
  }

  if (setupType === "BREAKOUT_LONG" && upperWick > 0.35) {
    throw new Error("Setup descartado: breakout long con rechazo superior alto.");
  }

  if (setupType === "BREAKOUT_SHORT" && lowerWick > 0.35) {
    throw new Error("Setup descartado: breakout short con rechazo inferior alto.");
  }

  if (signal.suggestedAction === "LONG" && !signal?.setup?.bullishCloseConfirmation) {
    throw new Error("Setup descartado: falta confirmación alcista de vela.");
  }

  if (signal.suggestedAction === "SHORT" && !signal?.setup?.bearishCloseConfirmation) {
    throw new Error("Setup descartado: falta confirmación bajista de vela.");
  }

  return {
    edge,
    setupType,
    adx15,
    distEma20,
    bodyStrength,
    upperWick,
    lowerWick
  };
}

function resolveAutoExecutionMode(item) {
  const signal = item?.rawSignal || {};
  const marketState = String(signal?.marketState || item?.marketState || "AMBIGUOUS");
  const atrRatio = numberOrZero(signal?.metrics?.atrRatio || item?.atrRatio || 0);
  const squeeze = Boolean(signal?.metrics?.squeeze);

  if (
    runtime.accountState.gridMode &&
    marketState === "LATERAL_RANGE" &&
    atrRatio > 0.8 &&
    atrRatio < 1.25 &&
    !squeeze
  ) {
    return "GRID";
  }

  if (runtime.accountState.sniperMode) return "SNIPER";
  return "STANDARD";
}

function validateScannerFindingForAuto(item, mode = "STANDARD") {
  if (!item) return { ok: false, reason: "Finding vacía." };

  if (!item.direction || item.direction === "NO_TRADE") {
    return { ok: false, reason: "NO_TRADE" };
  }

  const minProb = mode === "SNIPER"
    ? Math.max(numberOrZero(config.auto.autoEntryProbability || 58), 60)
    : numberOrZero(config.auto.autoEntryProbability || 58);

  if (numberOrZero(item.probability) < minProb) {
    return { ok: false, reason: "Probabilidad insuficiente." };
  }

  if ((item.confidence || "LOW") === "LOW") {
    return { ok: false, reason: "Confidence LOW." };
  }

  const minScore = Math.max(
    getRiskThresholds().minScore,
    numberOrZero(config.auto.autoMinScore || 45),
    mode === "SNIPER" ? 58 : 45
  );
  const minEdge = Math.max(
    getRiskThresholds().minEdge,
    numberOrZero(config.auto.autoMinEdge || 6),
    mode === "SNIPER" ? 10 : 6
  );

  if (numberOrZero(item.score) < minScore) {
    return { ok: false, reason: "Score bajo." };
  }

  if (numberOrZero(item.edge) < minEdge) {
    return { ok: false, reason: "Edge bajo." };
  }

  if (numberOrZero(item.adx15) < 14) {
    return { ok: false, reason: "ADX bajo." };
  }

  if (Math.abs(numberOrZero(item.distEma20_5)) > 1.1) {
    return { ok: false, reason: "Muy extendido respecto a EMA20." };
  }

  if (numberOrZero(item.bodyStrength5) < 0.35) {
    return { ok: false, reason: "Vela débil." };
  }

  const regime = String(item.regime || "TRANSITION");
  if (regime === "COMPRESSION") {
    return { ok: false, reason: "Régimen de compresión." };
  }

  if (regime === "TRANSITION" && numberOrZero(item.score) < (minScore + 8)) {
    return { ok: false, reason: "TRANSITION con score insuficiente." };
  }

  if (String(item.confidence || "LOW") === "MEDIUM" && numberOrZero(item.edge) < (minEdge + 2)) {
    return { ok: false, reason: "MEDIUM confidence con edge insuficiente." };
  }

  const setupType = String(item.setupType || "NONE");
  if (setupType === "NONE") {
    return { ok: false, reason: "Sin setup operativo." };
  }

  const bias1h = String(item.bias1h || "NEUTRAL");
  const bias15m = String(item.bias15m || "NEUTRAL");

  if (item.direction === "LONG" && (bias1h !== "BULL" || bias15m !== "BULL")) {
    return { ok: false, reason: "MTF no alineado para LONG." };
  }

  if (item.direction === "SHORT" && (bias1h !== "BEAR" || bias15m !== "BEAR")) {
    return { ok: false, reason: "MTF no alineado para SHORT." };
  }

  if (item.direction === "LONG" && numberOrZero(item.upperWick5) > 0.45) {
    return { ok: false, reason: "Long con rechazo superior alto." };
  }

  if (item.direction === "SHORT" && numberOrZero(item.lowerWick5) > 0.45) {
    return { ok: false, reason: "Short con rechazo inferior alto." };
  }

  return { ok: true, reason: "OK" };
}

async function getDynamicSymbols(forceRefresh = false) {
  const now = Date.now();

  if (
    !forceRefresh &&
    marketsCache.symbols.length > 0 &&
    now - marketsCache.fetchedAt < config.coinex.marketsCacheMs
  ) {
    return marketsCache.symbols;
  }

  const allMarkets = await getAllFuturesMarkets();

  const operational = (allMarkets || []).filter(
    (m) => m?.is_market_available && m?.is_api_trading_available
  );

  const usdtBases = new Set();

  for (const item of operational) {
    const market = String(item.market || "").toUpperCase();
    if (market.endsWith("USDT")) usdtBases.add(market.slice(0, -4));
  }

  const symbols = [...usdtBases]
    .filter((base) => /^[A-Z0-9]{2,20}$/.test(base))
    .sort((a, b) => a.localeCompare(b))
    .map((symbol) => ({
      symbol,
      memeLike: isMemeSymbol(symbol),
      market: `${symbol}USDT`
    }));

  marketsCache.fetchedAt = now;
  marketsCache.symbols = symbols;
  marketsCache.rawCount = operational.length;

  return symbols;
}

async function findOpenPositionByMarket(market) {
  const list = await getCurrentPositions(market);
  return (list || []).find((p) => p.market === market && hasOpenPosition(p)) || null;
}

function inferOpenedAtFromPosition(position) {
  const candidates = [
    position?.created_at,
    position?.create_time,
    position?.open_time,
    position?.updated_at
  ];

  for (const raw of candidates) {
    const value = numberOrZero(raw);
    if (value > 0) {
      return value > 1e12 ? value : value * 1000;
    }
  }

  return Date.now();
}

async function registerExternalTradeFromPosition(position) {
  const market = String(position?.market || "").toUpperCase();
  if (!market || !market.endsWith("USDT")) return null;

  const symbol = market.slice(0, -4);
  const direction = String(position?.side || "").toLowerCase() === "sell" ? "SHORT" : "LONG";
  const tradeId = makeId(`EXT_${symbol}`);
  const openedAt = inferOpenedAtFromPosition(position);
  const entryPrice = numberOrZero(position?.avg_entry_price || position?.open_price || position?.mark_price || position?.last);
  const signalPeriod = config.auto.defaultSignalPeriod || "5min";

  let signal = null;
  try {
    signal = await getSignalForSymbol(symbol, signalPeriod);
  } catch (error) {
    console.error("External sync signal error:", symbol, error.message);
  }

  const tradeRecord = {
    tradeId,
    symbol,
    market,
    side: direction === "LONG" ? "buy" : "sell",
    direction,
    confidence: signal?.confidence || "LOW",
    score: numberOrZero(signal?.score),
    edge: numberOrZero(getSignalEdge(signal || {})),
    regime: signal?.regime || "UNKNOWN",
    probabilities: signal?.probabilities || null,
    setupType: signal?.setup?.type || "NONE",
    adx15: numberOrZero(signal?.metrics?.adx15),
    distEma20_5: numberOrZero(signal?.metrics?.distEma20_5),
    bodyStrength5: numberOrZero(signal?.metrics?.bodyStrength5),
    upperWick5: numberOrZero(signal?.metrics?.upperWick5),
    lowerWick5: numberOrZero(signal?.metrics?.lowerWick5),
    leverage: Math.max(1, Math.round(numberOrZero(position?.leverage || 1))),
    percent: 0,
    requestedPercent: 0,
    usableMargin: numberOrZero(position?.margin_avbl),
    notional: numberOrZero(position?.position_value),
    amount: String(position?.open_interest || "0"),
    entryPrice,
    stopLoss: "",
    takeProfit: "",
    useStopLoss: false,
    useTakeProfit: false,
    signalPeriod,
    openedAt,
    status: "OPEN",
    autoOpened: false,
    autoOpenedAt: null,
    autoCloseTargetRoe: null,
    closeReason: null,
    externalTracked: true,
    details: {
      source: "COINEX_EXTERNAL_POSITION",
      importedAt: Date.now(),
      coinex: position || {}
    }
  };

  activeTrades.set(tradeId, tradeRecord);
  markSymbolTradeOpen(tradeRecord.symbol);
  logTradeOpen(tradeRecord);

  const learningOpen = registerLearningTradeOpen({
    trade: tradeRecord,
    signal: signal || {},
    learningMode: true,
    mode: "externo"
  });
  if (learningOpen?.feedback) {
    console.log(learningOpen.feedback);
  }

  return tradeRecord;
}

async function syncExternalPositions() {
  if (externalSyncState.running) return;
  externalSyncState.running = true;

  try {
    const positions = await getCurrentPositions();
    const openPositions = (positions || []).filter((p) => hasOpenPosition(p));
    const openMarkets = new Set(openPositions.map((p) => String(p.market || "").toUpperCase()));
    const openPositionsByMarket = new Map(
      openPositions.map((p) => [String(p.market || "").toUpperCase(), p])
    );
    let imported = 0;
    let closed = 0;

    for (const position of openPositions) {
      const market = String(position?.market || "").toUpperCase();
      if (!market) continue;

      const alreadyTracked = [...activeTrades.values()].some(
        (trade) => trade.market === market && trade.status === "OPEN"
      );
      if (alreadyTracked) continue;

      const importedTrade = await registerExternalTradeFromPosition(position);
      if (importedTrade) imported += 1;
    }

    for (const trade of [...activeTrades.values()]) {
      if (trade.status !== "OPEN") continue;
      if (!openMarkets.has(trade.market)) {
        trade.status = "CLOSED";
        trade.closedAt = Date.now();
        trade.closeReason = "EXTERNAL_CLOSED";
        const latestPosition = openPositionsByMarket.get(trade.market);
        const closedPrice = numberOrZero(latestPosition?.mark_price || latestPosition?.last || trade.entryPrice);
        const pnlPct = trade.entryPrice > 0
          ? (trade.direction === "LONG"
            ? ((closedPrice - trade.entryPrice) / trade.entryPrice) * 100
            : ((trade.entryPrice - closedPrice) / trade.entryPrice) * 100)
          : 0;
        trade.pnlPct = Number(pnlPct.toFixed(4));

        activeTrades.delete(trade.tradeId);
        markSymbolTradeClose(trade.symbol, trade.pnlPct);
        logTradeClose(trade.tradeId, { closeReason: trade.closeReason, closedPrice });
        registerLearningTradeClose({
          trade,
          closeReason: trade.closeReason,
          closedPrice,
          pnlPct: trade.pnlPct,
          closeTimestamp: trade.closedAt,
          exitType: "externo"
        });
        closed += 1;
      }
    }

    externalSyncState.lastRunAt = Date.now();
    externalSyncState.lastError = null;
    externalSyncState.imported = imported;
    externalSyncState.closed = closed;
  } catch (error) {
    externalSyncState.lastRunAt = Date.now();
    externalSyncState.lastError = error.message;
    console.error("External sync error:", error.message);
  } finally {
    externalSyncState.running = false;
  }
}

async function waitForPosition({ market, retries = 12, delayMs = 500, attempts, intervalMs }) {
  const finalRetries = numberOrZero(attempts) > 0 ? Math.floor(numberOrZero(attempts)) : retries;
  const finalDelayMs = numberOrZero(intervalMs) > 0 ? numberOrZero(intervalMs) : delayMs;

  for (let i = 0; i < finalRetries; i += 1) {
    const position = await findOpenPositionByMarket(market);
    if (position) return position;
    await sleep(finalDelayMs);
  }
  return null;
}

async function buildTradePreview(params) {
  cleanupExpiredDrafts();

  const {
    symbol,
    percent,
    stopLossPct,
    takeProfitPct,
    useStopLoss = true,
    useTakeProfit = true,
    entryPrice,
    signalPeriod,
    directionMode = "AUTO"
  } = params;
  const market = buildMarket(symbol);

  const active = [...activeTrades.values()];
  const [marketInfo, balances, signal, tickerList] = await Promise.all([
    getMarketStatus(market),
    getFuturesBalances(),
    getSignalForSymbol(symbol, signalPeriod),
    getMarketTicker(market)
  ]);

  const gate = canOpenNewTrade({
    symbol,
    activeTrades: active,
    symbolState,
    signal,
    availableUsdt: numberOrZero(balances?.USDT?.available),
    accountState: runtime.accountState,
    totalAccountUsdt: numberOrZero(balances?.USDT?.available) + active
      .filter((t) => t.status === "OPEN")
      .reduce((acc, t) => acc + numberOrZero(t.marginUsed || t.usableMargin || 0), 0)
  });
  if (!gate.ok) throw new Error(gate.reason);

  const antiOvertrade = canPassAntiOvertradingGuards();
  if (!antiOvertrade.ok) throw new Error(antiOvertrade.reason);

  const { edge } = validateSignalForEntry(signal);

  if (!marketInfo?.is_market_available) throw new Error(`${market}: mercado no disponible.`);
  if (!marketInfo?.is_api_trading_available) throw new Error(`${market}: trading por API no disponible.`);

  const leverage = resolveLeverage(marketInfo, signal, symbol);

  const usdt = balances.USDT;
  if (!usdt) throw new Error("No se encontró balance USDT en futures.");

  const usdtAvailable = numberOrZero(usdt.available);
  if (usdtAvailable <= 0) throw new Error("No hay balance USDT disponible.");

  const ticker = Array.isArray(tickerList) ? tickerList[0] : null;
  if (!ticker) throw new Error("No se pudo obtener ticker del mercado.");

  const markPrice = numberOrZero(ticker.mark_price || ticker.last);
  if (markPrice <= 0) throw new Error("Mark price inválido.");
  const previewEntryReference = numberOrZero(entryPrice) > 0 ? numberOrZero(entryPrice) : markPrice;

  const existingPosition = await findOpenPositionByMarket(market);
  if (existingPosition) {
    throw new Error("Ya existe una posición abierta en ese símbolo.");
  }

  const basePrecision = Number(marketInfo.base_ccy_precision);

  const sizing = sizeBySignal({
    symbol,
    availableUsdt: usdtAvailable,
    percentRequested: percent,
    leverage,
    entryPrice: previewEntryReference,
    basePrecision,
    signal,
    accountState: runtime.accountState,
    activeTrades: active,
    totalAccountUsdt: usdtAvailable + active
      .filter((t) => t.status === "OPEN")
      .reduce((acc, t) => acc + numberOrZero(t.marginUsed || t.usableMargin || 0), 0)
  });

  if (sizing.blocked || numberOrZero(sizing.amount) <= 0) {
    throw new Error(sizing.reason || "Sizing inválido.");
  }

  const adjustedSizing = buildAdjustedSizing({
    marketInfo,
    entryPrice: previewEntryReference,
    leverage,
    usdtAvailable,
    sizing
  });

  if (signal.marketState === "AMBIGUOUS") {
    throw new Error("Mercado ambiguo: no se permite entrada.");
  }

  const signalDirection = signal.suggestedAction;
  if (signalDirection !== "LONG" && signalDirection !== "SHORT") {
    throw new Error(`Dirección inválida de señal: ${signalDirection}`);
  }

  const effectiveDirectionMode = directionMode === "AUTO"
    ? (runtime.reverseMode ? "INVERTED" : "ORIGINAL")
    : directionMode;

  const direction = effectiveDirectionMode === "INVERTED"
    ? flipDirection(signalDirection)
    : signalDirection;

  const side = direction === "LONG" ? "buy" : "sell";

  const stopLoss = useStopLoss
    ? (
      direction === "LONG"
        ? fixedByTick(previewEntryReference * (1 - stopLossPct / 100), marketInfo.tick_size)
        : fixedByTick(previewEntryReference * (1 + stopLossPct / 100), marketInfo.tick_size)
    )
    : null;

  const takeProfit = useTakeProfit
    ? (
      direction === "LONG"
        ? fixedByTick(previewEntryReference * (1 + takeProfitPct / 100), marketInfo.tick_size)
        : fixedByTick(previewEntryReference * (1 - takeProfitPct / 100), marketInfo.tick_size)
    )
    : null;

  const draftId = makeId("DRAFT");

  const preview = {
    draftId,
    allowed: true,
    signal,
    trade: {
      draftId,
      symbol,
      market,
      side,
      direction,
      confidence: signal.confidence,
      score: signal.score,
      edge,
      regime: signal.regime,
      probabilities: effectiveDirectionMode === "INVERTED" ? invertProbabilities(signal.probabilities) : signal.probabilities,
      signalDirection,
      directionMode: effectiveDirectionMode,
      setupType: signal?.setup?.type || "NONE",
      adx15: numberOrZero(signal?.metrics?.adx15),
      distEma20_5: numberOrZero(signal?.metrics?.distEma20_5),
      bodyStrength5: numberOrZero(signal?.metrics?.bodyStrength5),
      upperWick5: numberOrZero(signal?.metrics?.upperWick5),
      lowerWick5: numberOrZero(signal?.metrics?.lowerWick5),
      leverage,
      requestedPercent: percent,
      effectivePercent: adjustedSizing.finalEffectivePercent,
      usableMargin: adjustedSizing.finalUsableMargin,
      notional: adjustedSizing.finalNotional,
      amount: fixedByDecimals(adjustedSizing.finalAmount, basePrecision),
      rawAmount: sizing.amount,
      minAmount: adjustedSizing.minAmount,
      entryReference: previewEntryReference,
      entryType: "limit",
      stopLoss,
      takeProfit,
      stopLossPct,
      takeProfitPct,
      useStopLoss,
      useTakeProfit,
      signalPeriod,
      createdAt: Date.now()
    }
  };

  draftTrades.set(draftId, preview);
  return preview;
}

async function executeDraftTrade(draftId, meta = {}) {
  const preview = draftTrades.get(draftId);
  if (!preview?.allowed || !preview?.trade) {
    throw new Error("No hay preview válida para ejecutar.");
  }

  const draft = preview.trade;
  const market = draft.market;

  if (Date.now() - numberOrZero(draft.createdAt) > MAX_DRAFT_AGE_MS) {
    draftTrades.delete(draftId);
    throw new Error("La preview expiró. Generá una nueva.");
  }

  if (!acquireSymbolLock(draft.symbol)) {
    throw new Error(`El símbolo ${draft.symbol} está ocupado por otra operación.`);
  }

  const useGlobalLock = !meta.allowConcurrent;

  if (useGlobalLock && runtime.locked) {
    throw new Error("Hay una operación en curso.");
  }

  if (useGlobalLock) {
    runtime.locked = true;
    runtime.status = "executing_trade";
    runtime.lastError = null;
    runtime.lastAction = "execute_trade";
  }

  let orderPlaced = false;

  try {
    const [marketInfo, balances, freshSignal, tickerList] = await Promise.all([
      getMarketStatus(market),
      getFuturesBalances(),
      getSignalForSymbol(draft.symbol, draft.signalPeriod),
      getMarketTicker(market)
    ]);

    if (!marketInfo?.is_market_available || !marketInfo?.is_api_trading_available) {
      throw new Error(`${market}: no está disponible para operar.`);
    }

    const { edge: freshEdge } = validateSignalForEntry(freshSignal);

    const expectedDirection = draft.directionMode === "INVERTED"
      ? flipDirection(freshSignal.suggestedAction)
      : freshSignal.suggestedAction;

    if (expectedDirection !== draft.direction) {
      throw new Error(
        `La dirección cambió antes de ejecutar (${draft.direction} -> ${expectedDirection}).`
      );
    }

    const usdtAvailable = numberOrZero(balances?.USDT?.available);
    if (usdtAvailable <= 0) {
      throw new Error("No hay balance USDT disponible al ejecutar.");
    }

    const ticker = Array.isArray(tickerList) ? tickerList[0] : null;
    if (!ticker) throw new Error("No se pudo obtener ticker al ejecutar.");

    const liveMarkPrice = numberOrZero(ticker.mark_price || ticker.last);
    if (liveMarkPrice <= 0) throw new Error("Mark price inválido al ejecutar.");

    const driftPct =
      draft.entryReference > 0
        ? Math.abs(((liveMarkPrice - draft.entryReference) / draft.entryReference) * 100)
        : 0;

    if (driftPct > 0.8) {
      throw new Error(`El precio cambió demasiado desde la preview (${driftPct.toFixed(2)}%).`);
    }

    const existingPosition = await findOpenPositionByMarket(market);
    if (existingPosition) {
      throw new Error("Ya existe una posición abierta en este mercado.");
    }

    const leverage = resolveLeverage(marketInfo, freshSignal, draft.symbol);
    const basePrecision = Number(marketInfo.base_ccy_precision);

    const freshSizing = sizeBySignal({
      symbol: draft.symbol,
      availableUsdt: usdtAvailable,
      percentRequested: draft.requestedPercent,
      leverage,
      entryPrice: liveMarkPrice,
      basePrecision,
      signal: freshSignal,
      accountState: runtime.accountState,
      activeTrades: [...activeTrades.values()],
      totalAccountUsdt: usdtAvailable + [...activeTrades.values()]
        .filter((t) => t.status === "OPEN")
        .reduce((acc, t) => acc + numberOrZero(t.marginUsed || t.usableMargin || 0), 0)
    });

    if (freshSizing.blocked || numberOrZero(freshSizing.amount) <= 0) {
      throw new Error(freshSizing.reason || "Sizing inválido al ejecutar.");
    }

    const adjustedSizing = buildAdjustedSizing({
      marketInfo,
      entryPrice: liveMarkPrice,
      leverage,
      usdtAvailable,
      sizing: freshSizing
    });

    await setLeverage({
      market,
      leverage,
      marginMode: runtime.marginMode
    });

    const limitPlan = buildLimitPlan({
      signal: freshSignal,
      markPrice: liveMarkPrice,
      marketInfo,
      direction: draft.direction,
      entryOverride: draft.entryReference
    });

    await placeFuturesOrder({
      market,
      side: draft.side,
      type: "limit",
      price: limitPlan.entryPrice,
      amount: fixedByDecimals(adjustedSizing.finalAmount, basePrecision),
      clientId: makeId(`${draft.direction}_LMT`)
    });

    orderPlaced = true;

    let position = await waitForPosition({ market, attempts: 18, intervalMs: 1200 });
    if (!position) {
      await cancelAllPendingOrders(market);

      if (meta.autoOpened) {
        await placeFuturesOrder({
          market,
          side: draft.side,
          type: "market",
          amount: fixedByDecimals(adjustedSizing.finalAmount, basePrecision),
          clientId: makeId(`${draft.direction}_MKT_FALLBACK`)
        });

        position = await waitForPosition({ market, attempts: 10, intervalMs: 700 });
      }
    }

    if (!position) {
      throw new Error("La orden límite no se ejecutó a tiempo y no se pudo confirmar entrada.");
    }

    const entryPrice = numberOrZero(position.avg_entry_price) || liveMarkPrice;

    const stopLoss = draft.useStopLoss
      ? (
        draft.direction === "LONG"
          ? fixedByTick(entryPrice * (1 - draft.stopLossPct / 100), marketInfo.tick_size)
          : fixedByTick(entryPrice * (1 + draft.stopLossPct / 100), marketInfo.tick_size)
      )
      : null;

    const takeProfit = draft.useTakeProfit
      ? (
        draft.direction === "LONG"
          ? fixedByTick(entryPrice * (1 + draft.takeProfitPct / 100), marketInfo.tick_size)
          : fixedByTick(entryPrice * (1 - draft.takeProfitPct / 100), marketInfo.tick_size)
      )
      : null;

    if (draft.useStopLoss && stopLoss) {
      await setPositionStopLoss({
        market,
        stopLossType: config.coinex.defaultTriggerPriceType,
        stopLossPrice: stopLoss
      });
    }

    if (draft.useTakeProfit && takeProfit) {
      await setPositionTakeProfit({
        market,
        takeProfitType: config.coinex.defaultTriggerPriceType,
        takeProfitPrice: takeProfit
      });
    }

    const tradeId = makeId("TRADE");

    const tradeRecord = {
      tradeId,
      symbol: draft.symbol,
      market,
      side: draft.side,
      direction: draft.direction,
      confidence: freshSignal.confidence,
      score: freshSignal.score,
      edge: freshEdge,
      regime: freshSignal.regime,
      probabilities: freshSignal.probabilities,
      setupType: freshSignal?.setup?.type || "NONE",
      adx15: numberOrZero(freshSignal?.metrics?.adx15),
      distEma20_5: numberOrZero(freshSignal?.metrics?.distEma20_5),
      bodyStrength5: numberOrZero(freshSignal?.metrics?.bodyStrength5),
      upperWick5: numberOrZero(freshSignal?.metrics?.upperWick5),
      lowerWick5: numberOrZero(freshSignal?.metrics?.lowerWick5),
      leverage,
      percent: adjustedSizing.finalEffectivePercent,
      requestedPercent: draft.requestedPercent,
      usableMargin: adjustedSizing.finalUsableMargin,
      notional: adjustedSizing.finalNotional,
      amount: fixedByDecimals(adjustedSizing.finalAmount, basePrecision),
      entryPrice,
      stopLoss,
      takeProfit,
      useStopLoss: Boolean(draft.useStopLoss),
      useTakeProfit: Boolean(draft.useTakeProfit),
      signalPeriod: draft.signalPeriod,
      openedAt: Date.now(),
      status: "OPEN",
      autoOpened: Boolean(meta.autoOpened),
      autoOpenedAt: meta.autoOpened ? Date.now() : null,
      autoCloseTargetRoe: meta.autoOpened ? config.auto.autoTakeProfitRoe : null,
      closeReason: null,
      details: {}
    };

    activeTrades.set(tradeId, tradeRecord);
    runtime.accountState.lastTradeAt = Date.now();
    runtime.accountState.hourTradeTimestamps.push(Date.now());
    runtime.accountState.dayTradeTimestamps.push(Date.now());
    markSymbolTradeOpen(tradeRecord.symbol);

    if (tradeRecord.autoOpened) {
      autoOpenedTrades.unshift({
        tradeId: tradeRecord.tradeId,
        symbol: tradeRecord.symbol,
        direction: tradeRecord.direction,
        leverage: tradeRecord.leverage,
        score: tradeRecord.score,
        edge: tradeRecord.edge,
        setupType: tradeRecord.setupType,
        openedAt: tradeRecord.openedAt
      });

      if (autoOpenedTrades.length > 100) {
        autoOpenedTrades.length = 100;
      }
    }

    draftTrades.delete(draftId);
    logTradeOpen(tradeRecord);
    const learningOpen = registerLearningTradeOpen({
      trade: tradeRecord,
      signal: freshSignal,
      learningMode: !runtime.autoEnabled,
      mode: tradeRecord.autoOpened ? "automático" : "manual"
    });
    if (learningOpen?.feedback) {
      console.log(learningOpen.feedback);
    }

    if (useGlobalLock) runtime.status = "running";
    runtime.lastAction = "trade_opened";

    return {
      ok: true,
      message: `${draft.direction} abierto correctamente.`,
      learning: learningOpen || null,
      trade: tradeRecord,
      position
    };
  } catch (error) {
    if (orderPlaced) {
      try {
        await closePosition({
          market,
          clientId: makeId("ROLLBACK_CLOSE")
        });
      } catch (rollbackError) {
        console.error("Rollback close error:", draft.symbol, rollbackError.message);
      }
    }

    if (useGlobalLock) runtime.status = "error";
    runtime.lastError = error.message;
    runtime.lastAction = "trade_open_failed";
    throw error;
  } finally {
    releaseSymbolLock(draft.symbol);
    if (useGlobalLock) runtime.locked = false;
  }
}

async function closeTradeById(tradeId, reason = "AUTO_CLOSE") {
  const trade = activeTrades.get(tradeId);
  if (!trade) return false;

  if (!acquireSymbolLock(trade.symbol)) {
    throw new Error(`El símbolo ${trade.symbol} está ocupado por otra operación.`);
  }

  try {
    const currentPosition = await findOpenPositionByMarket(trade.market);
    const pnlPct = currentPosition ? calcEstimatedPnlPct(trade, currentPosition) : 0;

    if (currentPosition) {
      await closePosition({
        market: trade.market,
        clientId: makeId("AUTO_CLOSE")
      });
    }

    trade.closeReason = reason;
    trade.closedAt = Date.now();
    trade.pnlPct = Number(pnlPct.toFixed(4));
    trade.status = "CLOSED";

    activeTrades.delete(tradeId);
    markSymbolTradeClose(trade.symbol, pnlPct);
    const closedPrice = numberOrZero(currentPosition?.mark_price || currentPosition?.last);
    logTradeClose(tradeId, { closeReason: reason, closedPrice });
    const learningClose = registerLearningTradeClose({
      trade,
      closeReason: reason,
      closedPrice,
      pnlPct: trade.pnlPct,
      closeTimestamp: trade.closedAt
    });
    if (learningClose?.feedback) {
      console.log(learningClose.feedback);
    }
    trade.learningClose = learningClose || null;

    autoClosedTrades.unshift({
      tradeId: trade.tradeId,
      symbol: trade.symbol,
      direction: trade.direction,
      reason,
      pnlPct: trade.pnlPct,
      openedAt: trade.openedAt,
      closedAt: trade.closedAt
    });

    if (autoClosedTrades.length > 100) {
      autoClosedTrades.length = 100;
    }

    runtime.lastAction = "auto_close_trade";
    return {
      ok: true,
      learning: trade.learningClose || null
    };
  } finally {
    releaseSymbolLock(trade.symbol);
  }
}

async function enrichTrade(trade) {
  const currentPosition = await findOpenPositionByMarket(trade.market);

  if (!currentPosition) {
    activeTrades.delete(trade.tradeId);
    logTradeClose(trade.tradeId);
    return null;
  }

  const signal = await getSignalForSymbol(trade.symbol, trade.signalPeriod);
  const advice = adviseTrade({ trade, signal, currentPosition });
  logAdvice(trade.tradeId, advice);

  return {
    ...trade,
    livePosition: currentPosition,
    signal,
    advice,
    roePct: Number(calcRoePctFromPosition(currentPosition).toFixed(3))
  };
}

async function reconcileActiveTrades() {
  const trades = [...activeTrades.values()];

  for (const trade of trades) {
    try {
      const currentPosition = await findOpenPositionByMarket(trade.market);
      if (!currentPosition) {
        activeTrades.delete(trade.tradeId);
        logTradeClose(trade.tradeId);
      }
    } catch (error) {
      console.error("Reconcile error:", trade.symbol, error.message);
    }
  }
}

async function runAutoCloseCycle() {
  const trades = [...activeTrades.values()];

  for (const trade of trades) {
    try {
      const position = await findOpenPositionByMarket(trade.market);

      if (!position) {
        activeTrades.delete(trade.tradeId);
        logTradeClose(trade.tradeId);
        continue;
      }

      const signal = await getSignalForSymbol(trade.symbol, trade.signalPeriod);
      const advice = adviseTrade({ trade, signal, currentPosition: position });
      const roePct = calcRoePctFromPosition(position);

      if (advice.recommendation === "CERRAR") {
        await closeTradeById(trade.tradeId, "ADVISOR_EXIT");
        continue;
      }

      if (roePct >= config.auto.autoTakeProfitRoe) {
        await closeTradeById(trade.tradeId, "AUTO_TP_ROE");
      }
    } catch (error) {
      console.error("Auto close error:", trade.symbol, error.message);
    }
  }
}

async function runAutoEntryCycle() {
  resetAutoEntryDiagnosticsCycle();
  cleanupExpiredDrafts();

  const guardrail = maybePauseAutoByGuardrails();
  if (!guardrail.ok) {
    addAutoEntryReject(guardrail.reason);
    autoEntryDiagnostics.cycleFinishedAt = Date.now();
    runtime.lastAction = "auto_guardrail_pause";
    return;
  }

  const symbols = await getDynamicSymbols(false);
  const findings = await scanMarketBatch(symbols, [...activeTrades.values()]);
  const balances = await getFuturesBalances();
  const availableUsdt = numberOrZero(balances?.USDT?.available);
  const maxConcurrentTrades = numberOrZero(config.risk?.maxConcurrentTrades || 3);
  const openTradesCount = [...activeTrades.values()].filter((t) => t.status === "OPEN").length;
  let remainingSlots = Math.max(0, maxConcurrentTrades - openTradesCount);
  const pendingExecutions = [];

  for (const item of findings) {
    try {
      autoEntryDiagnostics.findingsEvaluated += 1;
      if (isBlockedSymbol(item.symbol)) continue;

      const mode = resolveAutoExecutionMode(item);
      runtime.accountState.autoExecutionMode = mode;

      if (mode === "GRID") {
        await runGridExecutionForSymbol(item, availableUsdt);
        continue;
      }

      const findingCheck = validateScannerFindingForAuto(item, mode);
      if (!findingCheck.ok) {
        addAutoEntryReject(findingCheck.reason);
        continue;
      }

      if (remainingSlots <= 0) break;

      const active = [...activeTrades.values()];
      const gate = canOpenNewTrade({
        symbol: item.symbol,
        activeTrades: active,
        symbolState,
        signal: {
          score: item.score,
          confidence: item.confidence,
          suggestedAction: item.direction || "NO_TRADE",
          probabilities: {
            longProb: Number(item.longProb || 0),
            shortProb: Number(item.shortProb || 0)
          }
        },
        availableUsdt,
        accountState: runtime.accountState,
        totalAccountUsdt: availableUsdt + active
          .filter((t) => t.status === "OPEN")
          .reduce((acc, t) => acc + numberOrZero(t.marginUsed || t.usableMargin || 0), 0)
      });

      if (!gate.ok) {
        addAutoEntryReject(gate.reason);
        continue;
      }

      const alreadyDrafted = [...draftTrades.values()].some(
        (d) => d.trade?.symbol === item.symbol
      );
      if (alreadyDrafted) {
        addAutoEntryReject("Ya existe draft para símbolo.");
        continue;
      }

      const autoRisk = getAdaptiveAutoRisk(item);

      const preview = await buildTradePreview({
        symbol: item.symbol,
        percent: getAdaptiveAutoPercent(item.symbol),
        stopLossPct: autoRisk.stopLossPct,
        takeProfitPct: autoRisk.takeProfitPct,
        signalPeriod: config.auto.defaultSignalPeriod
      });

      if (preview?.allowed && preview?.draftId) {
        remainingSlots -= 1;
        pendingExecutions.push(
          executeDraftTrade(preview.draftId, { autoOpened: true, allowConcurrent: true })
            .catch((error) => {
              remainingSlots += 1;
              addAutoEntryReject(error.message || "Error de ejecución auto.");
              console.error("Auto entry execution error:", item.symbol, error.message);
            })
        );
      } else {
        addAutoEntryReject(preview?.reason || "Preview no permitido.");
      }
    } catch (error) {
      addAutoEntryReject(error.message || "Error auto entry.");
      console.error("Auto entry error:", item.symbol, error.message);
    }
  }

  if (pendingExecutions.length > 0) {
    await Promise.allSettled(pendingExecutions);
  }
  autoEntryDiagnostics.cycleFinishedAt = Date.now();
}

async function autoTradingLoop() {
  await syncExternalPositions();
  if (!runtime.autoEnabled) return;
  if (runtime.locked) return;

  try {
    await reconcileActiveTrades();
    await runAutoCloseCycle();
    await runAutoEntryCycle();
  } catch (error) {
    console.error("Auto trading loop error:", error.message);
  }
}

function startAutoLoop() {
  async function runner() {
    await autoTradingLoop();
    setTimeout(runner, config.auto.autoScanIntervalMs);
  }
  runner();
}

app.get("/api/health", async (_req, res) => {
  res.json({
    ok: true,
    uptimeSec: Math.floor(process.uptime()),
    botStatus: runtime.status,
    env: config.nodeEnv,
    autoEnabled: runtime.autoEnabled,
    autoEntryProbability: config.auto.autoEntryProbability,
    autoTakeProfitRoe: config.auto.autoTakeProfitRoe,
    guardrailReason: runtime.accountState.guardrailReason,
    autoPauseUntil: runtime.accountState.autoPauseUntil,
    autoExecutionMode: runtime.accountState.autoExecutionMode,
    autoEntryDiagnostics,
    reverseMode: runtime.reverseMode
  });
});

app.get("/api/balances", async (_req, res) => {
  try {
    const balances = await getFuturesBalances();
    res.json({
      ok: true,
      usdt: balances.USDT || null
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/symbols", async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === "1";
    const symbols = await getDynamicSymbols(forceRefresh);

    res.json({
      ok: true,
      count: symbols.length,
      fetchedAt: marketsCache.fetchedAt,
      rawOperationalMarkets: marketsCache.rawCount,
      symbols
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/signal", async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.query.symbol);
    const period = String(req.query.period || "5min");

    if (!symbol) throw new Error("Falta symbol.");
    validateSignalPeriod(period);

    const symbols = await getDynamicSymbols(false);
    const allowed = symbols.map((x) => x.symbol);
    if (!allowed.includes(symbol)) throw new Error("El símbolo no está disponible en USDT.");

    const signal = await getSignalForSymbol(symbol, period);

    res.json({
      ok: true,
      symbol,
      period,
      signal
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/preview-trade", async (req, res) => {
  if (runtime.locked) {
    return res.status(409).json({ ok: false, error: "Hay una operación en curso." });
  }

  try {
    const symbols = await getDynamicSymbols(false);
    const allowed = symbols.map((x) => x.symbol);

    const params = validatePreviewPayload(req.body, allowed);
    const preview = await buildTradePreview(params);

    runtime.lastAction = "preview_ready";

    res.json({
      ok: true,
      preview
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/execute-trade", async (req, res) => {
  if (runtime.locked) {
    return res.status(409).json({ ok: false, error: "Hay una operación en curso." });
  }

  try {
    const draftId = String(req.body?.draftId || "");
    if (!draftId) throw new Error("Falta draftId.");

    const result = await executeDraftTrade(draftId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/cancel-preview", async (req, res) => {
  const draftId = String(req.body?.draftId || "");
  if (!draftId) {
    return res.status(400).json({ ok: false, error: "Falta draftId." });
  }

  draftTrades.delete(draftId);
  runtime.lastAction = "preview_cancelled";

  res.json({
    ok: true,
    message: "Preview cancelada."
  });
});

app.get("/api/auto-status", async (_req, res) => {
  res.json({
    ok: true,
    enabled: runtime.autoEnabled,
    autoEntryProbability: config.auto.autoEntryProbability,
    autoTakeProfitRoe: config.auto.autoTakeProfitRoe,
    guardrailReason: runtime.accountState.guardrailReason,
    autoPauseUntil: runtime.accountState.autoPauseUntil,
    autoExecutionMode: runtime.accountState.autoExecutionMode,
    autoEntryDiagnostics,
    reverseMode: runtime.reverseMode
  });
});

app.get("/api/auto-history", async (_req, res) => {
  res.json({
    ok: true,
    autoOpenedTrades,
    autoClosedTrades
  });
});

app.get("/api/runtime-config", (_req, res) => {
  res.json({
    ok: true,
    config: getRuntimeConfigSnapshot()
  });
});

app.post("/api/runtime-config", (req, res) => {
  try {
    const scanner = req.body?.scanner || {};
    const auto = req.body?.auto || {};

    config.scanner.intervalMs = toBoundedNumber(scanner.intervalMs, {
      min: 500,
      max: 3_600_000,
      name: "scanner.intervalMs"
    });
    config.scanner.minProbability = toBoundedNumber(scanner.minProbability, {
      min: 1,
      max: 99,
      name: "scanner.minProbability"
    });
    config.scanner.minScore = toBoundedNumber(scanner.minScore, {
      min: 1,
      max: 100,
      name: "scanner.minScore"
    });
    config.scanner.minEdge = toBoundedNumber(scanner.minEdge, {
      min: 0,
      max: 99,
      name: "scanner.minEdge"
    });

    config.auto.autoScanIntervalMs = toBoundedNumber(auto.autoScanIntervalMs, {
      min: 1000,
      max: 3_600_000,
      name: "auto.autoScanIntervalMs"
    });
    config.auto.autoEntryProbability = toBoundedNumber(auto.autoEntryProbability, {
      min: 1,
      max: 99,
      name: "auto.autoEntryProbability"
    });
    config.auto.autoMinScore = toBoundedNumber(auto.autoMinScore, {
      min: 1,
      max: 100,
      name: "auto.autoMinScore"
    });
    config.auto.autoMinEdge = toBoundedNumber(auto.autoMinEdge, {
      min: 0,
      max: 99,
      name: "auto.autoMinEdge"
    });

    runtime.lastAction = "runtime_config_updated";

    res.json({
      ok: true,
      config: getRuntimeConfigSnapshot()
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/auto-toggle", async (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  runtime.autoEnabled = enabled;
  runtime.lastAction = enabled ? "auto_enabled" : "auto_disabled";

  res.json({
    ok: true,
    enabled: runtime.autoEnabled,
    reverseMode: runtime.reverseMode
  });
});

app.post("/api/reverse-mode", (req, res) => {
  try {
    const enabled = Boolean(req.body?.enabled);
    runtime.reverseMode = enabled;
    runtime.lastAction = enabled ? "reverse_mode_on" : "reverse_mode_off";

    res.json({ ok: true, reverseMode: runtime.reverseMode });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});


app.get("/api/statistics", async (req, res) => {
  try {
    const days = Number(req.query.days || 30);
    const symbol = String(req.query.symbol || "").trim().toUpperCase();
    const limit = Number(req.query.limit || 8);

    const stats = getTradingStatistics({ days, symbol, limit });

    res.json({
      ok: true,
      ...stats
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/bot-feedback", async (req, res) => {
  try {
    const symbol = String(req.body?.symbol || "").trim().toUpperCase();
    if (!symbol) {
      throw new Error("symbol es obligatorio.");
    }

    const rating = req.body?.rating;
    const tradeId = req.body?.tradeId ? String(req.body.tradeId) : null;
    const source = String(req.body?.source || "USER").trim().toUpperCase();
    const eventType = String(req.body?.eventType || "MANUAL_REVIEW").trim().toUpperCase();
    const outcome = req.body?.outcome ? String(req.body.outcome).trim().toUpperCase() : null;
    const notes = req.body?.notes ? String(req.body.notes) : null;
    const payload = req.body?.payload && typeof req.body.payload === "object" ? req.body.payload : {};

    logBotFeedback({
      tradeId,
      symbol,
      source,
      eventType,
      rating,
      outcome,
      notes,
      payload
    });

    res.json({ ok: true, message: "Feedback guardado." });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.get("/api/trades", async (_req, res) => {
  try {
    const items = [...activeTrades.values()];
    const enriched = [];

    for (const trade of items) {
      const result = await enrichTrade(trade);
      if (result) enriched.push(result);
    }

    res.json({
      ok: true,
      trades: enriched
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/scan-opportunities", async (_req, res) => {
  try {
    const symbols = await getDynamicSymbols(false);
    const findings = await scanMarketBatch(symbols, [...activeTrades.values()]);
    const scanner = getScannerState();

    res.json({
      ok: true,
      lastRunAt: scanner.lastRunAt,
      findings,
      scanner
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/reset-runtime", async (_req, res) => {
  try {
    runtime.locked = false;
    runtime.status = "idle";
    runtime.lastError = null;
    runtime.lastAction = "manual_reset";

    res.json({
      ok: true,
      message: "Runtime reseteado. El bot puede seguir operando.",
      bot: runtime
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/status", async (_req, res) => {
  try {
    cleanupExpiredDrafts();

    const drafts = [...draftTrades.values()];
    const tracked = [...activeTrades.values()];
    const scanner = getScannerState();

    res.json({
      ok: true,
      bot: runtime,
      drafts,
      trackedTrades: tracked,
      scanner,
      externalSync: externalSyncState,
      auto: {
        enabled: runtime.autoEnabled,
        autoEntryProbability: config.auto.autoEntryProbability,
        autoTakeProfitRoe: config.auto.autoTakeProfitRoe,
        guardrailReason: runtime.accountState.guardrailReason,
        autoPauseUntil: runtime.accountState.autoPauseUntil,
        autoExecutionMode: runtime.accountState.autoExecutionMode,
        reverseMode: runtime.reverseMode
      }
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message, bot: runtime });
  }
});

app.post("/api/close-trade/:tradeId", async (req, res) => {
  try {
    const tradeId = String(req.params.tradeId || "");
    const trade = activeTrades.get(tradeId);

    if (!trade) throw new Error("Trade no encontrada.");

    const closeResult = await closeTradeById(tradeId, "MANUAL_CLOSE");
    runtime.lastAction = "manual_close_trade";

    res.json({
      ok: true,
      message: "Trade cerrada y removida del dashboard.",
      tradeId,
      learning: closeResult?.learning || null
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});


app.post("/api/grid-mode", (req, res) => {
  try {
    const enabled = Boolean(req.body?.enabled);
    runtime.accountState.gridMode = enabled;
    runtime.lastAction = enabled ? "grid_mode_on" : "grid_mode_off";
    res.json({ ok: true, gridMode: runtime.accountState.gridMode });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/sniper-mode", (req, res) => {
  try {
    const enabled = Boolean(req.body?.enabled);
    runtime.accountState.sniperMode = enabled;
    runtime.lastAction = enabled ? "sniper_mode_on" : "sniper_mode_off";
    res.json({ ok: true, sniperMode: runtime.accountState.sniperMode });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

function hydrateStateFromDb() {
  const openTrades = getOpenTrades();

  for (const trade of openTrades) {
    activeTrades.set(trade.tradeId, {
      ...trade,
      requestedPercent: trade.percent,
      usableMargin: null,
      notional: null,
      score: 0,
      edge: 0,
      regime: "UNKNOWN",
      probabilities: null,
      setupType: "NONE",
      adx15: 0,
      distEma20_5: 0,
      bodyStrength5: 0,
      upperWick5: 0,
      lowerWick5: 0,
      autoOpened: false,
      autoOpenedAt: null,
      autoCloseTargetRoe: null,
      closeReason: trade.closeReason || null,
      details: trade.details || {}
    });

    markSymbolTradeOpen(trade.symbol);
  }
}

hydrateStateFromDb();
startAutoLoop();

app.listen(config.port, () => {
  console.log(`CoinEx pro bot corriendo en http://localhost:${config.port}`);
});
