import { getMarketTicker, getMarketKline } from "./coinex.js";
import { logSignal } from "./db.js";

const oiStore = new Map();

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function sma(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function last(arr) {
  return arr[arr.length - 1];
}

function periodToMs(period) {
  const map = {
    "1min": 60_000,
    "3min": 180_000,
    "5min": 300_000,
    "15min": 900_000,
    "30min": 1_800_000,
    "1hour": 3_600_000,
    "2hour": 7_200_000,
    "4hour": 14_400_000,
    "6hour": 21_600_000,
    "12hour": 43_200_000,
    "1day": 86_400_000,
    "3day": 259_200_000,
    "1week": 604_800_000
  };

  return map[period] || 0;
}

function normalizeTimestamp(ts) {
  const raw = num(ts);
  if (!raw) return 0;
  return raw < 1e12 ? raw * 1000 : raw;
}

function toClosedCandles(candles, period) {
  if (!Array.isArray(candles) || candles.length < 2) return candles || [];

  const periodMs = periodToMs(period);
  if (!periodMs) return candles;

  const sorted = [...candles].sort((a, b) => num(a.created_at) - num(b.created_at));
  const lastTs = normalizeTimestamp(last(sorted)?.created_at);
  if (!lastTs) return sorted;

  const isOpenCandle = Date.now() - lastTs < periodMs;
  if (!isOpenCandle) return sorted;

  // Evita usar la vela en formación: reduce flicker/invalidaciones inmediatas.
  return sorted.slice(0, -1);
}

function calcTrueRange(curr, prevClose) {
  const high = num(curr.high);
  const low = num(curr.low);

  if (!Number.isFinite(prevClose) || prevClose <= 0) {
    return high - low;
  }

  return Math.max(
    high - low,
    Math.abs(high - prevClose),
    Math.abs(low - prevClose)
  );
}

function calcATR(candles, length = 14) {
  if (!candles || candles.length < length + 1) {
    return { currentATR: 0, atrSeries: [] };
  }

  const trs = [];
  for (let i = 0; i < candles.length; i += 1) {
    const prevClose = i > 0 ? num(candles[i - 1].close) : NaN;
    trs.push(calcTrueRange(candles[i], prevClose));
  }

  const atrSeries = [];
  for (let i = length - 1; i < trs.length; i += 1) {
    atrSeries.push(sma(trs.slice(i - length + 1, i + 1)));
  }

  return {
    currentATR: atrSeries.length ? last(atrSeries) : 0,
    atrSeries
  };
}

function calcRSI(candles, length = 14) {
  if (!candles || candles.length < length + 1) return 50;

  const closes = candles.map((c) => num(c.close));
  const gains = [];
  const losses = [];

  for (let i = 1; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? Math.abs(diff) : 0);
  }

  let avgGain = sma(gains.slice(0, length));
  let avgLoss = sma(losses.slice(0, length));

  for (let i = length; i < gains.length; i += 1) {
    avgGain = ((avgGain * (length - 1)) + gains[i]) / length;
    avgLoss = ((avgLoss * (length - 1)) + losses[i]) / length;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calcEMA(candles, length = 20, sourceKey = "close") {
  if (!candles || candles.length < length) {
    return { current: 0, prev: 0, series: [] };
  }

  const values = candles.map((c) => num(c[sourceKey]));
  const k = 2 / (length + 1);

  let ema = sma(values.slice(0, length));
  const series = [ema];

  for (let i = length; i < values.length; i += 1) {
    ema = (values[i] * k) + (ema * (1 - k));
    series.push(ema);
  }

  return {
    current: series.length ? last(series) : 0,
    prev: series.length > 1 ? series[series.length - 2] : series[0] || 0,
    series
  };
}

function calcADX(candles, length = 14) {
  if (!candles || candles.length < length * 2) {
    return { current: 0, plusDI: 0, minusDI: 0, adxSeries: [] };
  }

  const trs = [];
  const plusDMs = [];
  const minusDMs = [];

  for (let i = 1; i < candles.length; i += 1) {
    const curr = candles[i];
    const prev = candles[i - 1];

    const upMove = num(curr.high) - num(prev.high);
    const downMove = num(prev.low) - num(curr.low);

    const plusDM = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDM = downMove > upMove && downMove > 0 ? downMove : 0;

    trs.push(calcTrueRange(curr, num(prev.close)));
    plusDMs.push(plusDM);
    minusDMs.push(minusDM);
  }

  if (trs.length < length) {
    return { current: 0, plusDI: 0, minusDI: 0, adxSeries: [] };
  }

  let trSum = trs.slice(0, length).reduce((a, b) => a + b, 0);
  let plusDMSum = plusDMs.slice(0, length).reduce((a, b) => a + b, 0);
  let minusDMSum = minusDMs.slice(0, length).reduce((a, b) => a + b, 0);

  const dxSeries = [];
  const plusDISeries = [];
  const minusDISeries = [];

  for (let i = length; i < trs.length; i += 1) {
    const plusDI = trSum > 0 ? (plusDMSum / trSum) * 100 : 0;
    const minusDI = trSum > 0 ? (minusDMSum / trSum) * 100 : 0;
    const diSum = plusDI + minusDI;
    const dx = diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0;

    plusDISeries.push(plusDI);
    minusDISeries.push(minusDI);
    dxSeries.push(dx);

    trSum = trSum - (trSum / length) + trs[i];
    plusDMSum = plusDMSum - (plusDMSum / length) + plusDMs[i];
    minusDMSum = minusDMSum - (minusDMSum / length) + minusDMs[i];
  }

  if (!dxSeries.length) {
    return { current: 0, plusDI: 0, minusDI: 0, adxSeries: [] };
  }

  const adxSeries = [];
  const firstWindow = dxSeries.slice(0, Math.min(length, dxSeries.length));
  let adx = sma(firstWindow);
  adxSeries.push(adx);

  for (let i = length; i < dxSeries.length; i += 1) {
    adx = ((adx * (length - 1)) + dxSeries[i]) / length;
    adxSeries.push(adx);
  }

  return {
    current: adxSeries.length ? last(adxSeries) : adx,
    plusDI: plusDISeries.length ? last(plusDISeries) : 0,
    minusDI: minusDISeries.length ? last(minusDISeries) : 0,
    adxSeries
  };
}

function calcVolumeRatio(candles, lookback = 20) {
  if (!candles || candles.length < lookback + 1) return 1;
  const current = num(last(candles).volume);
  const avgVolume = sma(
    candles.slice(-(lookback + 1), -1).map((c) => num(c.volume))
  );
  return avgVolume > 0 ? current / avgVolume : 1;
}

function calcAtrRatio(candles, atrLength = 14, baselineLookback = 14) {
  const { atrSeries } = calcATR(candles, atrLength);
  if (atrSeries.length < baselineLookback + 1) return 1;
  const current = last(atrSeries);
  const avgATR = sma(atrSeries.slice(-(baselineLookback + 1), -1));
  return avgATR > 0 ? current / avgATR : 1;
}

function calcPriceExtension(candles, lookback = 10) {
  if (!candles || candles.length < lookback) return 0;
  const closes = candles.map((c) => num(c.close));
  const recent = closes.slice(-lookback);
  const avg = sma(recent);
  const current = last(recent);
  return avg > 0 ? ((current - avg) / avg) * 100 : 0;
}

function calcDistanceFromEMA(candles, emaLength = 20) {
  const ema = calcEMA(candles, emaLength);
  const close = num(last(candles)?.close);
  if (ema.current <= 0 || close <= 0) return 0;
  return ((close - ema.current) / ema.current) * 100;
}

function candleBodyStrength(candle) {
  const open = num(candle?.open);
  const close = num(candle?.close);
  const high = num(candle?.high);
  const low = num(candle?.low);

  const range = high - low;
  const body = Math.abs(close - open);

  return range > 0 ? body / range : 0;
}

function upperWickRatio(candle) {
  const open = num(candle?.open);
  const close = num(candle?.close);
  const high = num(candle?.high);
  const low = num(candle?.low);

  const top = Math.max(open, close);
  const range = high - low;

  return range > 0 ? (high - top) / range : 0;
}

function lowerWickRatio(candle) {
  const open = num(candle?.open);
  const close = num(candle?.close);
  const high = num(candle?.high);
  const low = num(candle?.low);

  const bottom = Math.min(open, close);
  const range = high - low;

  return range > 0 ? (bottom - low) / range : 0;
}

function getCandleConfirmation(candles) {
  if (!candles || candles.length < 2) {
    return {
      bullishCloseConfirmation: false,
      bearishCloseConfirmation: false,
      bodyStrength: 0,
      upperWick: 0,
      lowerWick: 0
    };
  }

  const curr = last(candles);
  const prev = candles[candles.length - 2];

  const bullishCloseConfirmation =
    num(curr.close) > num(curr.open) &&
    num(curr.close) > num(prev.close);

  const bearishCloseConfirmation =
    num(curr.close) < num(curr.open) &&
    num(curr.close) < num(prev.close);

  return {
    bullishCloseConfirmation,
    bearishCloseConfirmation,
    bodyStrength: candleBodyStrength(curr),
    upperWick: upperWickRatio(curr),
    lowerWick: lowerWickRatio(curr)
  };
}

function recordOiSnapshot(market, oi, price) {
  const arr = oiStore.get(market) || [];
  arr.push({ ts: Date.now(), oi: num(oi), price: num(price) });
  if (arr.length > 300) arr.splice(0, arr.length - 300);
  oiStore.set(market, arr);
}

function calcOiSignal(market) {
  const arr = oiStore.get(market) || [];
  if (arr.length < 6) {
    return { ratio: 1, changePct: 0, points: arr.length };
  }

  const current = last(arr).oi;
  const baselineSlice = arr.slice(Math.max(0, arr.length - 13), arr.length - 1);
  const avgOI = sma(baselineSlice.map((x) => x.oi));
  const oldest = baselineSlice.length ? baselineSlice[0].oi : current;
  const changePct = oldest > 0 ? ((current - oldest) / oldest) * 100 : 0;

  return {
    ratio: avgOI > 0 ? current / avgOI : 1,
    changePct,
    points: arr.length
  };
}

function getOiConfirmation(move15, oiChangePct) {
  if (move15 > 0.25 && oiChangePct > 1) return "BULL_CONFIRMED";
  if (move15 < -0.25 && oiChangePct > 1) return "BEAR_CONFIRMED";
  if (Math.abs(move15) > 0.25 && oiChangePct < -1) return "UNWIND";
  return "NEUTRAL";
}

function calcMovePct(candles, barsBack) {
  if (candles.length <= barsBack) return 0;
  const from = num(candles[candles.length - 1 - barsBack].close);
  const to = num(last(candles).close);
  return from > 0 ? ((to - from) / from) * 100 : 0;
}

function normalizeScorePart(v, scale, maxPart) {
  return clamp((v / scale) * maxPart, 0, maxPart);
}

function regimeLabel({ bias1h, atrRatio, volumeRatio, adx15 }) {
  if (adx15 >= 22 && atrRatio > 1.05 && volumeRatio > 1.05) {
    return bias1h === "BULL"
      ? "TRENDING_UP_EXPANSION"
      : bias1h === "BEAR"
        ? "TRENDING_DOWN_EXPANSION"
        : "NEUTRAL_EXPANSION";
  }
  if (adx15 < 16 || (atrRatio < 0.98 && volumeRatio < 1.0)) {
    return "COMPRESSION";
  }
  return "TRANSITION";
}

function getBiasFromRsiAndMove(rsi, movePct) {
  if (rsi >= 55 && movePct > 0) return "BULL";
  if (rsi <= 45 && movePct < 0) return "BEAR";
  return "NEUTRAL";
}

function getTrendContext(candles) {
  const ema20 = calcEMA(candles, 20);
  const ema50 = calcEMA(candles, 50);
  const close = num(last(candles)?.close);
  const ema20SlopePct = ema20.prev > 0 ? ((ema20.current - ema20.prev) / ema20.prev) * 100 : 0;

  const bull =
    close > ema20.current &&
    ema20.current > ema50.current &&
    ema20SlopePct > 0;

  const bear =
    close < ema20.current &&
    ema20.current < ema50.current &&
    ema20SlopePct < 0;

  return {
    close,
    ema20: ema20.current,
    ema50: ema50.current,
    ema20Prev: ema20.prev,
    ema20SlopePct,
    bias: bull ? "BULL" : bear ? "BEAR" : "NEUTRAL"
  };
}

function detectBreakoutOrPullback(candles, trendBias, volumeRatio, lookback = 8) {
  if (!candles || candles.length < lookback + 3) {
    return {
      type: "NONE",
      validLong: false,
      validShort: false,
      breakoutUp: false,
      breakoutDown: false,
      pullbackLong: false,
      pullbackShort: false
    };
  }

  const curr = last(candles);
  const prev = candles[candles.length - 2];
  const highs = candles.slice(-(lookback + 1), -1).map((c) => num(c.high));
  const lows = candles.slice(-(lookback + 1), -1).map((c) => num(c.low));

  const highestRecent = highs.length ? Math.max(...highs) : num(prev.high);
  const lowestRecent = lows.length ? Math.min(...lows) : num(prev.low);

  const close = num(curr.close);
  const prevClose = num(prev.close);

  const breakoutUp = close > highestRecent && close > prevClose && volumeRatio > 1.02;
  const breakoutDown = close < lowestRecent && close < prevClose && volumeRatio > 1.02;

  const ema20 = calcEMA(candles, 20).current;
  const distanceToEma20 = ema20 > 0 ? ((close - ema20) / ema20) * 100 : 0;

  const pullbackLong =
    trendBias === "BULL" &&
    close > ema20 &&
    distanceToEma20 > 0 &&
    distanceToEma20 < 0.35 &&
    close > prevClose;

  const pullbackShort =
    trendBias === "BEAR" &&
    close < ema20 &&
    distanceToEma20 < 0 &&
    distanceToEma20 > -0.35 &&
    close < prevClose;

  let type = "NONE";
  if (pullbackLong) type = "PULLBACK_LONG";
  else if (pullbackShort) type = "PULLBACK_SHORT";
  else if (breakoutUp) type = "BREAKOUT_LONG";
  else if (breakoutDown) type = "BREAKOUT_SHORT";

  return {
    type,
    validLong: breakoutUp || pullbackLong,
    validShort: breakoutDown || pullbackShort,
    breakoutUp,
    breakoutDown,
    pullbackLong,
    pullbackShort
  };
}

function classifyConfidence(score, edge) {
  if (score >= 75 && edge >= 18) return "HIGH";
  if (score >= 58 && edge >= 8) return "MEDIUM";
  return "LOW";
}

function isLateLongEntry({ rsi5, move5, extension5, atrRatio, distEma20_5 }) {
  return (
    (rsi5 > 72 && move5 > 0.6) ||
    extension5 > Math.max(0.8, atrRatio * 0.6) ||
    distEma20_5 > 0.85
  );
}

function isLateShortEntry({ rsi5, move5, extension5, atrRatio, distEma20_5 }) {
  return (
    (rsi5 < 28 && move5 < -0.6) ||
    extension5 < -Math.max(0.8, atrRatio * 0.6) ||
    distEma20_5 < -0.85
  );
}

function regimePenalty({ atrRatio, volumeRatio, adx15 }) {
  if (adx15 < 16) return 10;
  if (atrRatio < 0.95 && volumeRatio < 1.0) return 12;
  if (atrRatio > 2.1) return 8;
  return 0;
}

function buildProbabilities({
  trend1h,
  trend15m,
  triggerBias,
  rsi5,
  volumeRatio,
  atrRatio,
  adx15,
  oiRatio,
  oiChangePct,
  oiConfirmation,
  setup,
  distEma20_5,
  extension5,
  move5,
  move15,
  candleConfirm
}) {
  let longProb = 50;
  let shortProb = 50;

  if (trend1h.bias === "BULL") longProb += 14;
  if (trend1h.bias === "BEAR") shortProb += 14;

  if (trend15m.bias === "BULL") longProb += 12;
  if (trend15m.bias === "BEAR") shortProb += 12;

  if (trend1h.bias === trend15m.bias && trend1h.bias !== "NEUTRAL") {
    if (trend1h.bias === "BULL") longProb += 8;
    if (trend1h.bias === "BEAR") shortProb += 8;
  }

  if (adx15 >= 18) {
    if (trend15m.bias === "BULL") longProb += 6;
    if (trend15m.bias === "BEAR") shortProb += 6;
  }

  if (triggerBias === "BULL") longProb += 5;
  if (triggerBias === "BEAR") shortProb += 5;

  if (rsi5 >= 52 && rsi5 <= 66) longProb += 5;
  if (rsi5 <= 48 && rsi5 >= 34) shortProb += 5;
  if (rsi5 > 75) longProb -= 8;
  if (rsi5 < 25) shortProb -= 8;

  if (setup.type === "PULLBACK_LONG") longProb += 12;
  if (setup.type === "PULLBACK_SHORT") shortProb += 12;
  if (setup.type === "BREAKOUT_LONG") longProb += 7;
  if (setup.type === "BREAKOUT_SHORT") shortProb += 7;

  if (volumeRatio > 1.03) {
    if (setup.validLong) longProb += 4;
    if (setup.validShort) shortProb += 4;
  }

  if (atrRatio > 1.0 && atrRatio < 1.8) {
    if (trend15m.bias === "BULL") longProb += 4;
    if (trend15m.bias === "BEAR") shortProb += 4;
  }

  if (oiConfirmation === "BULL_CONFIRMED") longProb += 8;
  if (oiConfirmation === "BEAR_CONFIRMED") shortProb += 8;
  if (oiConfirmation === "UNWIND") {
    longProb -= 5;
    shortProb -= 5;
  }

  if (oiRatio > 1.03 && oiChangePct > 0.5) {
    if (trend15m.bias === "BULL") longProb += 3;
    if (trend15m.bias === "BEAR") shortProb += 3;
  }

  if (candleConfirm.bullishCloseConfirmation) longProb += 6;
  if (candleConfirm.bearishCloseConfirmation) shortProb += 6;

  if (candleConfirm.bodyStrength >= 0.5) {
    if (candleConfirm.bullishCloseConfirmation) longProb += 4;
    if (candleConfirm.bearishCloseConfirmation) shortProb += 4;
  }

  if (candleConfirm.upperWick > 0.35) longProb -= 7;
  if (candleConfirm.lowerWick > 0.35) shortProb -= 7;

  longProb += move5 > 0 ? Math.min(move5 * 2.5, 3) : 0;
  shortProb += move5 < 0 ? Math.min(Math.abs(move5) * 2.5, 3) : 0;

  longProb += move15 > 0 ? Math.min(move15 * 2, 3) : 0;
  shortProb += move15 < 0 ? Math.min(Math.abs(move15) * 2, 3) : 0;

  if (distEma20_5 > 0.85 || extension5 > 1.0) longProb -= 10;
  if (distEma20_5 < -0.85 || extension5 < -1.0) shortProb -= 10;

  if (trend1h.bias !== trend15m.bias) {
    longProb -= 8;
    shortProb -= 8;
  }

  if (trend1h.bias === "BULL" && triggerBias === "BEAR") longProb -= 8;
  if (trend1h.bias === "BEAR" && triggerBias === "BULL") shortProb -= 8;

  longProb = clamp(longProb, 1, 99);
  shortProb = clamp(shortProb, 1, 99);

  const total = longProb + shortProb;
  return {
    longProb: Number(((longProb / total) * 100).toFixed(1)),
    shortProb: Number(((shortProb / total) * 100).toFixed(1))
  };
}

function shouldSkipTrade({
  score,
  edge,
  trend1h,
  trend15m,
  triggerBias,
  volumeRatio,
  atrRatio,
  adx15,
  extension5,
  longProb,
  shortProb,
  setup,
  distEma20_5,
  candleConfirm,
  regime
}) {
  const alignedBull = trend1h.bias === "BULL" && trend15m.bias === "BULL";
  const alignedBear = trend1h.bias === "BEAR" && trend15m.bias === "BEAR";
  const oneSideAligned =
    (trend1h.bias === "BULL" && trend15m.bias !== "BEAR") ||
    (trend1h.bias === "BEAR" && trend15m.bias !== "BULL");

  const weakScore = score < 42;
  const weakEdge = edge < 4;
  const deadRegime = atrRatio < 0.92 && volumeRatio < 0.95;
  const weakTrend = adx15 < 14;
  const overextended = Math.abs(extension5) > Math.max(1.4, atrRatio * 1.0) || Math.abs(distEma20_5) > 1.1;
  const tooNeutral = longProb < 52 && shortProb < 52;
  const noSetup = !setup.validLong && !setup.validShort;

  if (weakScore) return true;
  if (weakEdge) return true;
  if (deadRegime) return true;
  if (weakTrend) return true;
  if (tooNeutral) return true;
  if (overextended) return true;
  if (noSetup) return true;
  if (regime === "TRANSITION" && score < 52) return true;

  if (!alignedBull && !alignedBear && !oneSideAligned) return true;

  if (alignedBull && triggerBias === "BEAR") return true;
  if (alignedBear && triggerBias === "BULL") return true;

  if (alignedBull && !setup.validLong) return true;
  if (alignedBear && !setup.validShort) return true;

  if (setup.type === "BREAKOUT_LONG") {
    if (!candleConfirm.bullishCloseConfirmation) return true;
    if (candleConfirm.bodyStrength < 0.45) return true;
    if (candleConfirm.upperWick > 0.35) return true;
  }

  if (setup.type === "BREAKOUT_SHORT") {
    if (!candleConfirm.bearishCloseConfirmation) return true;
    if (candleConfirm.bodyStrength < 0.45) return true;
    if (candleConfirm.lowerWick > 0.35) return true;
  }

  if (setup.type === "PULLBACK_LONG") {
    if (!candleConfirm.bullishCloseConfirmation) return true;
    if (candleConfirm.upperWick > 0.45) return true;
  }

  if (setup.type === "PULLBACK_SHORT") {
    if (!candleConfirm.bearishCloseConfirmation) return true;
    if (candleConfirm.lowerWick > 0.45) return true;
  }

  return false;
}

export async function getSignalForSymbol(symbol, triggerPeriod = "5min") {
  const market = `${String(symbol).toUpperCase()}USDT`;

  const [tickerList, kline5, kline15, kline1h] = await Promise.all([
    getMarketTicker(market),
    getMarketKline({
      market,
      period: triggerPeriod,
      limit: 161,
      priceType: "latest_price"
    }),
    getMarketKline({
      market,
      period: "15min",
      limit: 161,
      priceType: "latest_price"
    }),
    getMarketKline({
      market,
      period: "1hour",
      limit: 161,
      priceType: "latest_price"
    })
  ]);

  const ticker = Array.isArray(tickerList) ? tickerList[0] : null;
  if (!ticker) throw new Error(`No se pudo obtener ticker para ${market}`);

  const c5 = toClosedCandles(kline5, triggerPeriod);
  const c15 = toClosedCandles(kline15, "15min");
  const c1h = toClosedCandles(kline1h, "1hour");

  if (c5.length < 60 || c15.length < 60 || c1h.length < 60) {
    throw new Error(`No hay suficientes velas cerradas para analizar ${market}`);
  }

  recordOiSnapshot(market, ticker.open_interest_volume, ticker.mark_price || ticker.last);

  const rsi5 = calcRSI(c5, 14);
  const rsi15 = calcRSI(c15, 14);
  const rsi1h = calcRSI(c1h, 14);

  const move5 = calcMovePct(c5, 4);
  const move15 = calcMovePct(c15, 4);
  const move1h = calcMovePct(c1h, 4);

  const volumeRatio = calcVolumeRatio(c5, 20);
  const atrRatio = calcAtrRatio(c15, 14, 14);
  const extension5 = calcPriceExtension(c5, 10);
  const distEma20_5 = calcDistanceFromEMA(c5, 20);

  const adx15Obj = calcADX(c15, 14);
  const adx15 = adx15Obj.current;

  const oi = calcOiSignal(market);
  const oiConfirmation = getOiConfirmation(move15, oi.changePct);

  const triggerBias = getBiasFromRsiAndMove(rsi5, move5);

  const trend5m = getTrendContext(c5);
  const trend15m = getTrendContext(c15);
  const trend1h = getTrendContext(c1h);

  const setup = detectBreakoutOrPullback(c5, trend15m.bias, volumeRatio, 8);
  const candleConfirm = getCandleConfirmation(c5);

  const initialRegime = regimeLabel({
    bias1h: trend1h.bias,
    atrRatio,
    volumeRatio,
    adx15
  });

  const scoreTrendAlignment =
    trend1h.bias === trend15m.bias && trend1h.bias !== "NEUTRAL"
      ? 24
      : trend1h.bias !== "NEUTRAL" || trend15m.bias !== "NEUTRAL"
        ? 10
        : 0;

  const scoreTrendStrength = normalizeScorePart(adx15, 28, 18);

  const scoreSetup =
    setup.type === "PULLBACK_LONG" || setup.type === "PULLBACK_SHORT"
      ? 18
      : setup.type === "BREAKOUT_LONG" || setup.type === "BREAKOUT_SHORT"
        ? 10
        : 0;

  const scoreVolume = normalizeScorePart(volumeRatio, 1.8, 8);
  const scoreATR = normalizeScorePart(atrRatio, 1.5, 8);
  const scoreOI = normalizeScorePart(
    Math.max(oi.ratio - 0.95, 0) + Math.max(oi.changePct, 0) / 12,
    1.6,
    6
  );

  let scoreRsiTiming = 4;
  if (rsi5 >= 52 && rsi5 <= 66) scoreRsiTiming = 8;
  if (rsi5 <= 48 && rsi5 >= 34) scoreRsiTiming = 8;
  if (rsi5 > 74 || rsi5 < 26) scoreRsiTiming = 2;

  let scoreDistance = 8;
  if (Math.abs(distEma20_5) > 0.85) scoreDistance = 2;
  else if (Math.abs(distEma20_5) > 0.55) scoreDistance = 5;

  let scoreCandle = 0;
  if (candleConfirm.bodyStrength >= 0.45) scoreCandle += 6;
  else if (candleConfirm.bodyStrength >= 0.3) scoreCandle += 3;

  if (candleConfirm.upperWick <= 0.3 && candleConfirm.lowerWick <= 0.3) {
    scoreCandle += 4;
  } else if (candleConfirm.upperWick > 0.45 || candleConfirm.lowerWick > 0.45) {
    scoreCandle -= 2;
  }

  const latePenalty =
    (isLateLongEntry({ rsi5, move5, extension5, atrRatio, distEma20_5 }) ? 6 : 0) +
    (isLateShortEntry({ rsi5, move5, extension5, atrRatio, distEma20_5 }) ? 6 : 0);

  const baseScore =
    scoreTrendAlignment +
    scoreTrendStrength +
    scoreSetup +
    scoreVolume +
    scoreATR +
    scoreOI +
    scoreRsiTiming +
    scoreDistance +
    scoreCandle;

  const score = Number(
    clamp(
      baseScore -
        regimePenalty({ atrRatio, volumeRatio, adx15 }) -
        latePenalty,
      5,
      100
    ).toFixed(2)
  );

  const probabilities = buildProbabilities({
    trend1h,
    trend15m,
    triggerBias,
    rsi5,
    volumeRatio,
    atrRatio,
    adx15,
    oiRatio: oi.ratio,
    oiChangePct: oi.changePct,
    oiConfirmation,
    setup,
    distEma20_5,
    extension5,
    move5,
    move15,
    candleConfirm
  });

  const edge = Math.abs(probabilities.longProb - probabilities.shortProb);

  let suggestedAction = "NO_TRADE";

  if (
    !shouldSkipTrade({
      score,
      edge,
      trend1h,
      trend15m,
      triggerBias,
      volumeRatio,
      atrRatio,
      adx15,
      extension5,
      longProb: probabilities.longProb,
      shortProb: probabilities.shortProb,
      setup,
      distEma20_5,
      candleConfirm,
      regime: initialRegime
    })
  ) {
    suggestedAction =
      probabilities.longProb >= probabilities.shortProb ? "LONG" : "SHORT";
  }

  const confidence =
    suggestedAction === "NO_TRADE"
      ? "LOW"
      : classifyConfidence(score, edge);

  const label =
    score >= 78 ? "MUY FUERTE" :
    score >= 64 ? "FUERTE" :
    score >= 52 ? "MEDIA" :
    score >= 42 ? "DÉBIL" : "MUY DÉBIL";

  const signal = {
    market,
    period: triggerPeriod,
    score,
    label,
    confidence,
    suggestedAction,
    probabilities,
    regime: initialRegime,
    mtf: {
      bias1h: trend1h.bias,
      bias15m: trend15m.bias,
      triggerBias
    },
    metrics: {
      volumeRatio: Number(volumeRatio.toFixed(3)),
      atrRatio: Number(atrRatio.toFixed(3)),
      extension5: Number(extension5.toFixed(3)),
      distEma20_5: Number(distEma20_5.toFixed(3)),
      adx15: Number(adx15.toFixed(2)),
      plusDI15: Number(adx15Obj.plusDI.toFixed(2)),
      minusDI15: Number(adx15Obj.minusDI.toFixed(2)),
      oiRatio: Number(oi.ratio.toFixed(3)),
      oiChangePct: Number(oi.changePct.toFixed(3)),
      oiPoints: oi.points,
      oiConfirmation,
      rsi5: Number(rsi5.toFixed(2)),
      rsi15: Number(rsi15.toFixed(2)),
      rsi1h: Number(rsi1h.toFixed(2)),
      move5: Number(move5.toFixed(3)),
      move15: Number(move15.toFixed(3)),
      move1h: Number(move1h.toFixed(3)),
      ema20_15: Number(trend15m.ema20.toFixed(8)),
      ema50_15: Number(trend15m.ema50.toFixed(8)),
      ema20_1h: Number(trend1h.ema20.toFixed(8)),
      ema50_1h: Number(trend1h.ema50.toFixed(8)),
      bodyStrength5: Number(candleConfirm.bodyStrength.toFixed(3)),
      upperWick5: Number(candleConfirm.upperWick.toFixed(3)),
      lowerWick5: Number(candleConfirm.lowerWick.toFixed(3)),
      markPrice: Number(num(ticker.mark_price || ticker.last).toFixed(8))
    },
    setup: {
      type: setup.type,
      validLong: setup.validLong,
      validShort: setup.validShort,
      breakoutUp: setup.breakoutUp,
      breakoutDown: setup.breakoutDown,
      pullbackLong: setup.pullbackLong,
      pullbackShort: setup.pullbackShort,
      bullishCloseConfirmation: candleConfirm.bullishCloseConfirmation,
      bearishCloseConfirmation: candleConfirm.bearishCloseConfirmation
    },
    trend: {
      trend5mBias: trend5m.bias,
      trend15mBias: trend15m.bias,
      trend1hBias: trend1h.bias,
      ema20SlopePct15m: Number(trend15m.ema20SlopePct.toFixed(4)),
      ema20SlopePct1h: Number(trend1h.ema20SlopePct.toFixed(4))
    },
    components: {
      scoreTrendAlignment: Number(scoreTrendAlignment.toFixed(2)),
      scoreTrendStrength: Number(scoreTrendStrength.toFixed(2)),
      scoreSetup: Number(scoreSetup.toFixed(2)),
      scoreVolume: Number(scoreVolume.toFixed(2)),
      scoreATR: Number(scoreATR.toFixed(2)),
      scoreOI: Number(scoreOI.toFixed(2)),
      scoreRsiTiming: Number(scoreRsiTiming.toFixed(2)),
      scoreDistance: Number(scoreDistance.toFixed(2)),
      scoreCandle: Number(scoreCandle.toFixed(2)),
      latePenalty: Number(latePenalty.toFixed(2)),
      regimePenalty: Number(regimePenalty({ atrRatio, volumeRatio, adx15 }).toFixed(2))
    },
    timestamp: Date.now()
  };

  logSignal(symbol, signal);
  return signal;
}
