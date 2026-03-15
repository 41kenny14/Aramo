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
  setPositionTakeProfit
} from "./coinex.js";
import { getSignalForSymbol } from "./signalEngine.js";
import { adviseTrade } from "./tradeAdvisor.js";
import { scanMarketBatch, getScannerState } from "./scannerEngine.js";
import {
  resolveLeverage,
  canOpenNewTrade,
  sizeBySignal,
  isBlockedSymbol,
  isMemeSymbol,
  getSignalEdge
} from "./riskEngine.js";
import { logTradeOpen, logTradeClose, logAdvice, getOpenTrades } from "./db.js";

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
  accountState: {
    lossStreak: 0
  }
};

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

function fixedByTick(value, tickSize) {
  const tick = String(tickSize);
  const idx = tick.indexOf(".");
  const decimals = idx === -1 ? 0 : tick.length - idx - 1;
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

function validatePreviewPayload(body, allowedSymbols) {
  const symbol = normalizeSymbol(body.symbol);
  const percent = Number(body.percent);
  const stopLossPct = Number(body.stopLossPct);
  const takeProfitPct = Number(body.takeProfitPct);
  const signalPeriod = String(body.signalPeriod || "5min");

  if (!allowedSymbols.includes(symbol)) {
    throw new Error("Símbolo inválido o no disponible en USDT.");
  }

  const validPercents = new Set([5, 10, 15, 20, 25, 50, 75, 100]);
  if (!validPercents.has(percent)) throw new Error("Porcentaje inválido.");
  if (!Number.isFinite(stopLossPct) || stopLossPct <= 0) throw new Error("Stop Loss % inválido.");
  if (!Number.isFinite(takeProfitPct) || takeProfitPct <= 0) throw new Error("Take Profit % inválido.");

  validateSignalPeriod(signalPeriod);

  return { symbol, percent, stopLossPct, takeProfitPct, signalPeriod };
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

function validateScannerFindingForAuto(item) {
  if (!item) return { ok: false, reason: "Finding vacía." };

  if (!item.direction || item.direction === "NO_TRADE") {
    return { ok: false, reason: "NO_TRADE" };
  }

  if (numberOrZero(item.probability) < numberOrZero(config.auto.autoEntryProbability || 58)) {
    return { ok: false, reason: "Probabilidad insuficiente." };
  }

  if ((item.confidence || "LOW") === "LOW") {
    return { ok: false, reason: "Confidence LOW." };
  }

  const { minScore, minEdge } = getRiskThresholds();

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

async function waitForPosition({ market, retries = 12, delayMs = 500 }) {
  for (let i = 0; i < retries; i += 1) {
    const position = await findOpenPositionByMarket(market);
    if (position) return position;
    await sleep(delayMs);
  }
  return null;
}

async function buildTradePreview(params) {
  cleanupExpiredDrafts();

  const { symbol, percent, stopLossPct, takeProfitPct, signalPeriod } = params;
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
    entryPrice: markPrice,
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
    entryPrice: markPrice,
    leverage,
    usdtAvailable,
    sizing
  });

  const direction = signal.suggestedAction;
  if (direction !== "LONG" && direction !== "SHORT") {
    throw new Error(`Dirección inválida de señal: ${direction}`);
  }

  const side = direction === "LONG" ? "buy" : "sell";

  const stopLoss =
    direction === "LONG"
      ? fixedByTick(markPrice * (1 - stopLossPct / 100), marketInfo.tick_size)
      : fixedByTick(markPrice * (1 + stopLossPct / 100), marketInfo.tick_size);

  const takeProfit =
    direction === "LONG"
      ? fixedByTick(markPrice * (1 + takeProfitPct / 100), marketInfo.tick_size)
      : fixedByTick(markPrice * (1 - takeProfitPct / 100), marketInfo.tick_size);

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
      probabilities: signal.probabilities,
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
      entryReference: markPrice,
      stopLoss,
      takeProfit,
      stopLossPct,
      takeProfitPct,
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

  runtime.locked = true;
  runtime.status = "executing_trade";
  runtime.lastError = null;
  runtime.lastAction = "execute_trade";

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

    if (freshSignal.suggestedAction !== draft.direction) {
      throw new Error(
        `La dirección cambió antes de ejecutar (${draft.direction} -> ${freshSignal.suggestedAction}).`
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

    await placeFuturesOrder({
      market,
      side: draft.side,
      type: "market",
      amount: fixedByDecimals(adjustedSizing.finalAmount, basePrecision),
      clientId: makeId(draft.direction)
    });

    orderPlaced = true;

    const position = await waitForPosition({ market });
    if (!position) {
      throw new Error("La posición no se confirmó a tiempo.");
    }

    const stopLoss =
      draft.direction === "LONG"
        ? fixedByTick(liveMarkPrice * (1 - draft.stopLossPct / 100), marketInfo.tick_size)
        : fixedByTick(liveMarkPrice * (1 + draft.stopLossPct / 100), marketInfo.tick_size);

    const takeProfit =
      draft.direction === "LONG"
        ? fixedByTick(liveMarkPrice * (1 + draft.takeProfitPct / 100), marketInfo.tick_size)
        : fixedByTick(liveMarkPrice * (1 - draft.takeProfitPct / 100), marketInfo.tick_size);

    await setPositionStopLoss({
      market,
      stopLossType: config.coinex.defaultTriggerPriceType,
      stopLossPrice: stopLoss
    });

    await setPositionTakeProfit({
      market,
      takeProfitType: config.coinex.defaultTriggerPriceType,
      takeProfitPrice: takeProfit
    });

    const tradeId = makeId("TRADE");
    const entryPrice = numberOrZero(position.avg_entry_price) || liveMarkPrice;

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
      signalPeriod: draft.signalPeriod,
      openedAt: Date.now(),
      status: "OPEN",
      autoOpened: Boolean(meta.autoOpened),
      autoOpenedAt: meta.autoOpened ? Date.now() : null,
      autoCloseTargetRoe: meta.autoOpened ? config.auto.autoTakeProfitRoe : null,
      closeReason: null
    };

    activeTrades.set(tradeId, tradeRecord);
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

    runtime.status = "running";
    runtime.lastAction = "trade_opened";

    return {
      ok: true,
      message: `${draft.direction} abierto correctamente.`,
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

    runtime.status = "error";
    runtime.lastError = error.message;
    runtime.lastAction = "trade_open_failed";
    throw error;
  } finally {
    releaseSymbolLock(draft.symbol);
    runtime.locked = false;
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
    logTradeClose(tradeId);

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
    return true;
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
  cleanupExpiredDrafts();

  const symbols = await getDynamicSymbols(false);
  const findings = await scanMarketBatch(symbols, [...activeTrades.values()]);
  const balances = await getFuturesBalances();
  const availableUsdt = numberOrZero(balances?.USDT?.available);

  for (const item of findings) {
    try {
      if (isBlockedSymbol(item.symbol)) continue;

      const findingCheck = validateScannerFindingForAuto(item);
      if (!findingCheck.ok) continue;

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

      if (!gate.ok) continue;

      const alreadyDrafted = [...draftTrades.values()].some(
        (d) => d.trade?.symbol === item.symbol
      );
      if (alreadyDrafted) continue;

      const preview = await buildTradePreview({
        symbol: item.symbol,
        percent: isMemeSymbol(item.symbol)
          ? Math.min(config.auto.defaultPercent, 10)
          : config.auto.defaultPercent,
        stopLossPct: config.auto.defaultStopLossPct,
        takeProfitPct: config.auto.defaultTakeProfitPct,
        signalPeriod: config.auto.defaultSignalPeriod
      });

      if (preview?.allowed && preview?.draftId) {
        await executeDraftTrade(preview.draftId, { autoOpened: true });
      }
    } catch (error) {
      console.error("Auto entry error:", item.symbol, error.message);
    }
  }
}

async function autoTradingLoop() {
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
    autoTakeProfitRoe: config.auto.autoTakeProfitRoe
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
    autoTakeProfitRoe: config.auto.autoTakeProfitRoe
  });
});

app.get("/api/auto-history", async (_req, res) => {
  res.json({
    ok: true,
    autoOpenedTrades,
    autoClosedTrades
  });
});

app.post("/api/auto-toggle", async (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  runtime.autoEnabled = enabled;
  runtime.lastAction = enabled ? "auto_enabled" : "auto_disabled";

  res.json({
    ok: true,
    enabled: runtime.autoEnabled
  });
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
      auto: {
        enabled: runtime.autoEnabled,
        autoEntryProbability: config.auto.autoEntryProbability,
        autoTakeProfitRoe: config.auto.autoTakeProfitRoe
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

    await closeTradeById(tradeId, "MANUAL_CLOSE");
    runtime.lastAction = "manual_close_trade";

    res.json({
      ok: true,
      message: "Trade cerrada y removida del dashboard.",
      tradeId
    });
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
      closeReason: null
    });

    markSymbolTradeOpen(trade.symbol);
  }
}

hydrateStateFromDb();
startAutoLoop();

app.listen(config.port, () => {
  console.log(`CoinEx pro bot corriendo en http://localhost:${config.port}`);
});