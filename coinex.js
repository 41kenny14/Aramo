import crypto from "crypto";
import config from "./config.js";

const BASE_URL = String(config.coinex.baseUrl || "").replace(/\/+$/, "");
const API_PREFIX = "/v2";
const REQUEST_TIMEOUT_MS = Number(config.coinex.requestTimeoutMs || 10000);
const PUBLIC_RETRY_COUNT = Number(config.coinex.publicRetryCount || 1);
const MAX_PRIVATE_TONCE_RETRIES = 1;
let coinexTimeOffsetMs = 0;

function nowMs(applyOffset = false) {
  const base = Date.now();
  const withOffset = applyOffset ? base + coinexTimeOffsetMs : base;
  return Math.max(0, Math.trunc(withOffset)).toString();
}

function updateCoinexTimeOffsetFromDateHeader(dateHeader) {
  const serverMs = Date.parse(String(dateHeader || ""));
  if (!Number.isFinite(serverMs)) return false;

  coinexTimeOffsetMs = serverMs - Date.now();
  return true;
}

function isTonceWindowError(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("tonce") ||
    message.includes("timestamp") ||
    message.includes("windowtime")
  );
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function assertNonEmptyString(name, value) {
  if (!String(value || "").trim()) {
    throw new Error(`${name} es requerido.`);
  }
}

function assertPositiveNumber(name, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} debe ser un número > 0.`);
  }
}

function assertOneOf(name, value, allowed) {
  if (!allowed.includes(value)) {
    throw new Error(`${name} inválido: ${value}. Permitidos: ${allowed.join(", ")}`);
  }
}

function compactObject(obj = {}) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined)
  );
}

function buildQueryString(query = {}) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.append(key, String(value));
  }

  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function signRequest(method, pathWithQuery, bodyString, timestamp, secretKey) {
  const prepared = `${method.toUpperCase()}${pathWithQuery}${bodyString || ""}${timestamp}`;
  return crypto.createHmac("sha256", secretKey).update(prepared).digest("hex").toLowerCase();
}

async function parseJsonSafe(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Respuesta no JSON de CoinEx: ${text}`);
  }
}

function enrichError(error, context = {}) {
  error.context = context;
  return error;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Timeout de red tras ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function shouldRetryPublicRequest(error) {
  const status = num(error?.httpStatus);
  const msg = String(error?.message || "").toLowerCase();

  if (status >= 500) return true;
  if (msg.includes("timeout")) return true;
  if (msg.includes("502 bad gateway")) return true;
  if (msg.includes("503")) return true;
  if (msg.includes("504")) return true;
  if (msg.includes("fetch failed")) return true;

  return false;
}
async function coinexRequest({
  method = "GET",
  path,
  query = null,
  body = null,
  auth = false,
  timeoutMs = REQUEST_TIMEOUT_MS,
  useCoinexTimeOffset = false
}) {
  assertNonEmptyString("path", path);

  const qs = buildQueryString(query || {});
  const pathWithQuery = `${API_PREFIX}${path}${qs}`;
  const url = `${BASE_URL}${pathWithQuery}`;
  const bodyPayload = body ? compactObject(body) : null;
  const bodyString = bodyPayload ? JSON.stringify(bodyPayload) : "";

  const headers = {
    "Content-Type": "application/json"
  };

  if (auth) {
    const timestamp = nowMs(useCoinexTimeOffset);
    const sign = signRequest(method, pathWithQuery, bodyString, timestamp, config.coinex.secretKey);

    headers["X-COINEX-KEY"] = config.coinex.accessId;
    headers["X-COINEX-SIGN"] = sign;
    headers["X-COINEX-TIMESTAMP"] = timestamp;
    headers["X-COINEX-WINDOWTIME"] = String(config.coinex.windowTime);
  }

  try {
    const res = await fetchWithTimeout(
      url,
      {
        method,
        headers,
        body: bodyPayload ? bodyString : undefined
      },
      timeoutMs
    );

    const serverDateHeader = res.headers.get("date");
    const payload = await parseJsonSafe(res);

    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} - ${payload?.message || "Error HTTP"}`);
      err.httpStatus = res.status;
      err.coinexCode = payload?.code;
      err.coinexServerDate = serverDateHeader;
      throw err;
    }

    if (payload?.code !== 0) {
      const err = new Error(payload?.message || "Error CoinEx");
      err.httpStatus = res.status;
      err.coinexCode = payload?.code;
      err.coinexServerDate = serverDateHeader;
      throw err;
    }

    return payload.data;
  } catch (error) {
    throw enrichError(error, {
      method,
      path,
      pathWithQuery,
      auth,
      url
    });
  }
}

async function publicRequest(args) {
  let lastError = null;
  const attempts = 1 + PUBLIC_RETRY_COUNT;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await coinexRequest({ ...args, auth: false });
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !shouldRetryPublicRequest(error)) {
        throw error;
      }
    }
  }

  throw lastError;
}

async function privateRequest(args) {
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_PRIVATE_TONCE_RETRIES; attempt += 1) {
    try {
      return await coinexRequest({
        ...args,
        auth: true,
        useCoinexTimeOffset: attempt > 0
      });
    } catch (error) {
      lastError = error;
      if (attempt >= MAX_PRIVATE_TONCE_RETRIES || !isTonceWindowError(error)) {
        throw error;
      }

      const updated = updateCoinexTimeOffsetFromDateHeader(error?.coinexServerDate);
      if (!updated) throw error;
    }
  }

  throw lastError;
}

export async function getAllFuturesMarkets() {
  return publicRequest({
    method: "GET",
    path: "/futures/market"
  });
}

export async function getMarketStatus(market) {
  assertNonEmptyString("market", market);

  const data = await publicRequest({
    method: "GET",
    path: "/futures/market",
    query: { market }
  });

  return Array.isArray(data) ? data[0] || null : null;
}

export async function getPositionLevels(market) {
  assertNonEmptyString("market", market);

  const data = await publicRequest({
    method: "GET",
    path: "/futures/position-level",
    query: { market }
  });

  return Array.isArray(data) ? data[0] || null : null;
}

export async function getMarketTicker(markets) {
  const market = Array.isArray(markets) ? markets.join(",") : markets;
  assertNonEmptyString("market", market);

  return publicRequest({
    method: "GET",
    path: "/futures/ticker",
    query: { market }
  });
}

export async function getMarketKline({
  market,
  period = "5min",
  limit = 120,
  priceType = "latest_price"
}) {
  assertNonEmptyString("market", market);
  assertOneOf("period", period, [
    "1min", "3min", "5min", "15min", "30min",
    "1hour", "2hour", "4hour", "6hour", "12hour",
    "1day", "3day", "1week"
  ]);
  assertPositiveNumber("limit", limit);
  assertOneOf("priceType", priceType, ["latest_price", "mark_price", "index_price"]);

  return publicRequest({
    method: "GET",
    path: "/futures/kline",
    query: {
      market,
      period,
      limit,
      price_type: priceType
    }
  });
}

export async function getFuturesBalances() {
  const data = await privateRequest({
    method: "GET",
    path: "/assets/futures/balance"
  });

  const map = {};
  for (const item of data || []) {
    map[item.ccy] = item;
  }
  return map;
}

export async function getCurrentPositions(market = "", page = 1, limit = 100) {
  return privateRequest({
    method: "GET",
    path: "/futures/pending-position",
    query: compactObject({
      market,
      market_type: "FUTURES",
      page,
      limit
    })
  });
}

export async function setLeverage({ market, leverage, marginMode }) {
  assertNonEmptyString("market", market);
  assertPositiveNumber("leverage", leverage);
  assertOneOf("marginMode", marginMode, ["isolated", "cross"]);

  return privateRequest({
    method: "POST",
    path: "/futures/adjust-position-leverage",
    body: {
      market,
      market_type: "FUTURES",
      margin_mode: marginMode,
      leverage
    }
  });
}

export async function placeFuturesOrder({ market, side, type = "market", amount, clientId, price }) {
  assertNonEmptyString("market", market);
  assertOneOf("side", side, ["buy", "sell"]);
  assertOneOf("type", type, ["market", "limit"]);
  assertPositiveNumber("amount", amount);
  assertNonEmptyString("clientId", clientId);
  if (type === "limit") assertPositiveNumber("price", price);

  return privateRequest({
    method: "POST",
    path: "/futures/order",
    body: {
      market,
      market_type: "FUTURES",
      side,
      type,
      amount: String(amount),
      price: type === "limit" ? String(price) : undefined,
      client_id: clientId
    }
  });
}

export async function cancelAllPendingOrders(market) {
  assertNonEmptyString("market", market);

  return privateRequest({
    method: "POST",
    path: "/futures/cancel-all-order",
    body: {
      market,
      market_type: "FUTURES"
    }
  });
}

export async function closePosition({ market, amount = null, clientId = null }) {
  assertNonEmptyString("market", market);
  if (amount !== null) assertPositiveNumber("amount", amount);

  return privateRequest({
    method: "POST",
    path: "/futures/close-position",
    body: {
      market,
      market_type: "FUTURES",
      type: "market",
      amount: amount === null ? undefined : String(amount),
      client_id: clientId || undefined
    }
  });
}

export async function setPositionStopLoss({ market, stopLossType, stopLossPrice }) {
  assertNonEmptyString("market", market);
  assertOneOf("stopLossType", stopLossType, ["mark_price", "latest_price", "index_price"]);
  assertPositiveNumber("stopLossPrice", stopLossPrice);

  return privateRequest({
    method: "POST",
    path: "/futures/set-position-stop-loss",
    body: {
      market,
      market_type: "FUTURES",
      stop_loss_type: stopLossType,
      stop_loss_price: String(stopLossPrice)
    }
  });
}

export async function setPositionTakeProfit({ market, takeProfitType, takeProfitPrice }) {
  assertNonEmptyString("market", market);
  assertOneOf("takeProfitType", takeProfitType, ["mark_price", "latest_price", "index_price"]);
  assertPositiveNumber("takeProfitPrice", takeProfitPrice);

  return privateRequest({
    method: "POST",
    path: "/futures/set-position-take-profit",
    body: {
      market,
      market_type: "FUTURES",
      take_profit_type: takeProfitType,
      take_profit_price: String(takeProfitPrice)
    }
  });
}
