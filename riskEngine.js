import config from "./config.js";

const MEME_SET = new Set([
  "DOGE", "SHIB", "PEPE", "FLOKI", "BONK", "WIF", "BOME", "MEME",
  "TURBO", "PONKE", "BRETT", "MOG", "NEIRO", "BABYDOGE", "POPCAT",
  "CAT", "PENGU", "MOODENG", "TRUMP", "PNUT", "GOAT", "MEW"
]);

const BLOCKED_SET = new Set(config.risk.symbolFilters?.blocked || []);
const REDUCED_SET = new Set(config.risk.symbolFilters?.memeReducedSize || []);

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

export function isBlockedSymbol(symbol) {
  return BLOCKED_SET.has(symbol);
}

export function isMemeSymbol(symbol) {
  return MEME_SET.has(symbol);
}

export function classifyBucket(symbol) {
  return isMemeSymbol(symbol) ? "MEME" : "MAJOR_OR_ALT";
}

export function getSignalEdge(signal) {
  const longProb = num(signal?.probabilities?.longProb);
  const shortProb = num(signal?.probabilities?.shortProb);
  return Math.abs(longProb - shortProb);
}

export function isTradableSignal(signal) {
  const score = num(signal?.score);
  const confidence = signal?.confidence || "LOW";
  const suggestedAction = signal?.suggestedAction || "NO_TRADE";
  const edge = getSignalEdge(signal);

  if (suggestedAction === "NO_TRADE") {
    return { ok: false, reason: "Señal marcada como NO_TRADE." };
  }

  const minScore = num(config.scanner?.minScore || 42);
  const minEdge = num(config.scanner?.minEdge || 3);

  if (score < minScore) {
    return { ok: false, reason: `Score insuficiente (${score}).` };
  }

  if (edge < minEdge) {
    return { ok: false, reason: `Edge insuficiente (${edge.toFixed(1)}).` };
  }

  if (confidence === "LOW") {
    return { ok: false, reason: "Confidence LOW." };
  }

  return { ok: true, reason: "OK" };
}

export function resolveLeverage(marketInfo, signal, symbol) {
  const supported = (marketInfo?.leverage || [])
    .map((x) => Number(x))
    .filter(Number.isFinite);

  if (!supported.length) {
    throw new Error("No hay leverage soportado para el mercado.");
  }

  const marketMaxLev = Math.max(...supported);
  const cap = Math.min(marketMaxLev, num(config.risk.maxLeverageCap || 5));

  const score = num(signal?.score);
  const edge = getSignalEdge(signal);
  const confidence = signal?.confidence || "LOW";
  const regime = signal?.regime || "TRANSITION";

  let lev = 1;

  if (confidence === "HIGH" && score >= 75 && edge >= 18) {
    lev = 20;
  } else if (confidence === "MEDIUM" && score >= 65 && edge >= 12) {
    lev = 10;
  } else if (score >= 58 && edge >= 10) {
    lev = 5;
  } else {
    lev = 3;
  }

  if (regime === "COMPRESSION") lev = Math.min(lev, 3);
  if (regime === "TRANSITION") lev = Math.min(lev, 5);

  if (isMemeSymbol(symbol) || REDUCED_SET.has(symbol)) {
    lev = Math.min(lev, 5);
  }

  return clamp(lev, 1, cap);
}

export function canOpenNewTrade({
  symbol,
  activeTrades,
  symbolState,
  signal,
  availableUsdt,
  accountState,
  totalAccountUsdt
}) {
  if (isBlockedSymbol(symbol)) {
    return { ok: false, reason: `Símbolo bloqueado: ${symbol}` };
  }

  const signalCheck = isTradableSignal(signal);
  if (!signalCheck.ok) {
    return { ok: false, reason: signalCheck.reason };
  }

  if (activeTrades.length >= num(config.risk.maxConcurrentTrades || 3)) {
    return { ok: false, reason: "Máximo de trades concurrentes alcanzado." };
  }

  const bucket = classifyBucket(symbol);
  const sameBucketCount = activeTrades.filter(
    (t) => classifyBucket(t.symbol) === bucket && t.status === "OPEN"
  ).length;

  if (sameBucketCount >= num(config.risk.maxTradesPerBucket || 2)) {
    return { ok: false, reason: `Máximo de trades para bucket ${bucket} alcanzado.` };
  }

  const sameSymbol = activeTrades.some(
    (t) => t.symbol === symbol && t.status === "OPEN"
  );
  if (sameSymbol) {
    return { ok: false, reason: "Ya hay un trade activo en ese símbolo." };
  }

  const state = symbolState?.get(symbol);
  if (state?.cooldownUntil && Date.now() < state.cooldownUntil) {
    return {
      ok: false,
      reason: `Símbolo en cooldown hasta ${new Date(state.cooldownUntil).toLocaleTimeString()}`
    };
  }

  if (state?.lastTradeAt) {
    const minMinutes = isMemeSymbol(symbol)
      ? num(config.risk.symbolFilters?.minMinutesBetweenTradesPerMeme || 60)
      : num(config.risk.symbolFilters?.minMinutesBetweenTradesPerSymbol || 20);

    const diffMs = Date.now() - state.lastTradeAt;
    if (diffMs < minMinutes * 60 * 1000) {
      return { ok: false, reason: `Reentrada demasiado rápida en ${symbol}` };
    }
  }

  // exposición total por margen abierto
  const totalOpenMargin = activeTrades
    .filter((t) => t.status === "OPEN")
    .reduce((acc, t) => acc + num(t.marginUsed || t.usableMargin || 0), 0);

  const maxAccountExposurePct = num(config.risk.maxAccountExposurePct || 45);
  const accountCapitalUsdt = num(totalAccountUsdt) > 0
    ? num(totalAccountUsdt)
    : num(availableUsdt) + totalOpenMargin;
  const maxExposureUsdt = accountCapitalUsdt * (maxAccountExposurePct / 100);

  if (totalOpenMargin >= maxExposureUsdt) {
    return {
      ok: false,
      reason: "Exposición máxima total de cuenta alcanzada."
    };
  }

  // límite extra para memes
  const memeOpenCount = activeTrades.filter(
    (t) => t.status === "OPEN" && isMemeSymbol(t.symbol)
  ).length;

  if (isMemeSymbol(symbol) && memeOpenCount >= num(config.risk.maxConcurrentMemeTrades || 1)) {
    return {
      ok: false,
      reason: "Máximo de trades MEME concurrentes alcanzado."
    };
  }

  // reducción por racha
  const lossStreak = num(accountState?.lossStreak || 0);
  const maxLossStreakToBlock = num(config.risk.maxLossStreakToBlock || 4);

  if (lossStreak >= maxLossStreakToBlock) {
    return {
      ok: false,
      reason: `Bloqueado por racha negativa (${lossStreak}).`
    };
  }

  return { ok: true, reason: "OK" };
}

function getConfidenceMultiplier(confidence) {
  if (confidence === "HIGH") return 1.0;
  if (confidence === "MEDIUM") return 0.72;
  return 0.45;
}

function getScoreMultiplier(score) {
  if (score >= 80) return 1.0;
  if (score >= 72) return 0.85;
  if (score >= 65) return 0.7;
  if (score >= 58) return 0.55;
  return 0.35;
}

function getEdgeMultiplier(edge) {
  if (edge >= 22) return 1.0;
  if (edge >= 18) return 0.85;
  if (edge >= 14) return 0.7;
  if (edge >= 10) return 0.55;
  return 0.3;
}

function getSymbolMultiplier(symbol) {
  if (REDUCED_SET.has(symbol) || isMemeSymbol(symbol)) return 0.35;
  return 1;
}

function getRegimeMultiplier(regime) {
  if (regime === "TRENDING_UP_EXPANSION" || regime === "TRENDING_DOWN_EXPANSION") {
    return 1;
  }
  if (regime === "TRANSITION") return 0.7;
  if (regime === "COMPRESSION") return 0.4;
  return 0.75;
}

function getLossStreakMultiplier(lossStreak = 0) {
  if (lossStreak <= 0) return 1;
  if (lossStreak === 1) return 0.85;
  if (lossStreak === 2) return 0.7;
  if (lossStreak === 3) return 0.5;
  return 0.25;
}

export function sizeBySignal({
  symbol,
  availableUsdt,
  percentRequested,
  leverage,
  entryPrice,
  basePrecision,
  signal,
  accountState,
  activeTrades,
  totalAccountUsdt
}) {
  const score = num(signal?.score || 0);
  const confidence = signal?.confidence || "LOW";
  const regime = signal?.regime || "TRANSITION";
  const edge = getSignalEdge(signal);
  const suggestedAction = signal?.suggestedAction || "NO_TRADE";

  if (suggestedAction === "NO_TRADE") {
    return {
      effectivePercent: 0,
      usableMargin: 0,
      notional: 0,
      amount: 0,
      blocked: true,
      reason: "NO_TRADE"
    };
  }

  const confidenceMultiplier = getConfidenceMultiplier(confidence);
  const scoreMultiplier = getScoreMultiplier(score);
  const edgeMultiplier = getEdgeMultiplier(edge);
  const symbolMultiplier = getSymbolMultiplier(symbol);
  const regimeMultiplier = getRegimeMultiplier(regime);
  const lossStreakMultiplier = getLossStreakMultiplier(num(accountState?.lossStreak || 0));

  // reducción por exposición ya abierta
  const totalOpenMargin = (activeTrades || [])
    .filter((t) => t.status === "OPEN")
    .reduce((acc, t) => acc + num(t.marginUsed || t.usableMargin || 0), 0);

  const capitalBaseUsdt = num(totalAccountUsdt) > 0
    ? num(totalAccountUsdt)
    : num(availableUsdt) + totalOpenMargin;

  const exposurePct = capitalBaseUsdt > 0 ? (totalOpenMargin / capitalBaseUsdt) * 100 : 0;

  let exposureMultiplier = 1;
  if (exposurePct >= 35) exposureMultiplier = 0.45;
  else if (exposurePct >= 25) exposureMultiplier = 0.6;
  else if (exposurePct >= 15) exposureMultiplier = 0.8;

  const requestedFraction = percentRequested / 100;

  let effectiveFraction =
    requestedFraction *
    confidenceMultiplier *
    scoreMultiplier *
    edgeMultiplier *
    symbolMultiplier *
    regimeMultiplier *
    lossStreakMultiplier *
    exposureMultiplier;

  // cap duro por trade
  const maxRiskPctPerTrade = num(config.risk.maxRiskPctPerTrade || 8);
  effectiveFraction = Math.min(effectiveFraction, maxRiskPctPerTrade / 100);
  effectiveFraction = clamp(effectiveFraction, 0, requestedFraction);

  const usableMargin = availableUsdt * effectiveFraction;
  const notional = usableMargin * leverage;
  const rawAmount = entryPrice > 0 ? notional / entryPrice : 0;

  const factor = 10 ** basePrecision;
  const amount = Math.floor(rawAmount * factor) / factor;

    let blocked = false;
    let reason = "OK";

    if (suggestedAction === "NO_TRADE") {
    blocked = true;
    reason = "NO_TRADE";
    } else if (usableMargin <= 0) {
    blocked = true;
    reason = "Margen utilizable demasiado bajo";
    } else if (notional <= 0) {
    blocked = true;
    reason = "Notional calculado inválido";
    } else if (rawAmount <= 0) {
    blocked = true;
    reason = "Raw amount calculado inválido";
    } else if (amount <= 0) {
    blocked = true;
    reason = `Amount redondeado a 0 por precision/basePrecision (${basePrecision})`;
    }

    return {
    effectivePercent: Number((effectiveFraction * 100).toFixed(2)),
    usableMargin: Number(usableMargin.toFixed(6)),
    notional: Number(notional.toFixed(6)),
    rawAmount: Number(rawAmount.toFixed(12)),
    amount,
    blocked,
    reason,
    multipliers: {
        confidenceMultiplier: Number(confidenceMultiplier.toFixed(3)),
        scoreMultiplier: Number(scoreMultiplier.toFixed(3)),
        edgeMultiplier: Number(edgeMultiplier.toFixed(3)),
        symbolMultiplier: Number(symbolMultiplier.toFixed(3)),
        regimeMultiplier: Number(regimeMultiplier.toFixed(3)),
        lossStreakMultiplier: Number(lossStreakMultiplier.toFixed(3)),
        exposureMultiplier: Number(exposureMultiplier.toFixed(3))
    }
  };
}