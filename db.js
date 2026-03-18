import Database from "better-sqlite3";
import config from "./config.js";

const db = new Database(config.dbPath);

db.pragma("journal_mode = WAL");

function safeAlter(sql) {
  try {
    db.exec(sql);
  } catch {}
}

db.exec(`
CREATE TABLE IF NOT EXISTS signal_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  market TEXT NOT NULL,
  period TEXT NOT NULL,
  score REAL NOT NULL,
  label TEXT NOT NULL,
  confidence TEXT NOT NULL,
  suggested_action TEXT NOT NULL,
  long_prob REAL NOT NULL,
  short_prob REAL NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trade_logs (
  trade_id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  market TEXT NOT NULL,
  side TEXT NOT NULL,
  direction TEXT NOT NULL,
  confidence TEXT NOT NULL,
  leverage INTEGER NOT NULL,
  percent REAL NOT NULL,
  amount TEXT NOT NULL,
  entry_price REAL NOT NULL,
  stop_loss TEXT NOT NULL,
  take_profit TEXT NOT NULL,
  signal_period TEXT NOT NULL,
  status TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER
);

CREATE TABLE IF NOT EXISTS trade_advice_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  reason TEXT NOT NULL,
  pnl_pct REAL NOT NULL,
  score REAL NOT NULL,
  prob_for_side REAL NOT NULL,
  prob_against_side REAL NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS optimization_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_feedback_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id TEXT,
  symbol TEXT NOT NULL,
  source TEXT NOT NULL,
  event_type TEXT NOT NULL,
  rating INTEGER,
  outcome TEXT,
  notes TEXT,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

safeAlter(`ALTER TABLE trade_logs ADD COLUMN details_json TEXT`);
safeAlter(`ALTER TABLE trade_logs ADD COLUMN closed_price REAL`);
safeAlter(`ALTER TABLE trade_logs ADD COLUMN close_reason TEXT`);

const insertSignalStmt = db.prepare(`
INSERT INTO signal_logs (
  symbol, market, period, score, label, confidence, suggested_action,
  long_prob, short_prob, payload_json, created_at
) VALUES (
  @symbol, @market, @period, @score, @label, @confidence, @suggested_action,
  @long_prob, @short_prob, @payload_json, @created_at
)
`);

const insertTradeStmt = db.prepare(`
INSERT OR REPLACE INTO trade_logs (
  trade_id, symbol, market, side, direction, confidence, leverage, percent, amount,
  entry_price, stop_loss, take_profit, signal_period, status, opened_at, closed_at, details_json, closed_price, close_reason
) VALUES (
  @trade_id, @symbol, @market, @side, @direction, @confidence, @leverage, @percent, @amount,
  @entry_price, @stop_loss, @take_profit, @signal_period, @status, @opened_at, @closed_at, @details_json, @closed_price, @close_reason
)
`);

const updateTradeStatusStmt = db.prepare(`
UPDATE trade_logs
SET status = @status, closed_at = @closed_at, close_reason = @close_reason, closed_price = @closed_price
WHERE trade_id = @trade_id
`);

const insertAdviceStmt = db.prepare(`
INSERT INTO trade_advice_logs (
  trade_id, recommendation, reason, pnl_pct, score, prob_for_side, prob_against_side, created_at
) VALUES (
  @trade_id, @recommendation, @reason, @pnl_pct, @score, @prob_for_side, @prob_against_side, @created_at
)
`);

const selectOpenTradesStmt = db.prepare(`
SELECT
  trade_id,
  symbol,
  market,
  side,
  direction,
  confidence,
  leverage,
  percent,
  amount,
  entry_price,
  stop_loss,
  take_profit,
  signal_period,
  status,
  opened_at,
  closed_at,
  details_json,
  closed_price,
  close_reason
FROM trade_logs
WHERE status = 'OPEN'
ORDER BY opened_at DESC
`);

const getTradeStatsSummaryStmt = db.prepare(`
WITH trade_stats AS (
  SELECT
    trade_id,
    symbol,
    direction,
    leverage,
    entry_price,
    closed_price,
    close_reason,
    opened_at,
    closed_at,
    CASE
      WHEN closed_at IS NULL OR closed_price IS NULL OR entry_price <= 0 THEN NULL
      WHEN direction = 'LONG' THEN ((closed_price - entry_price) / entry_price) * 100 * leverage
      WHEN direction = 'SHORT' THEN ((entry_price - closed_price) / entry_price) * 100 * leverage
      ELSE ((closed_price - entry_price) / entry_price) * 100
    END AS pnl_pct,
    CASE
      WHEN closed_at IS NULL THEN NULL
      ELSE (closed_at - opened_at) / 60000.0
    END AS duration_min
  FROM trade_logs
  WHERE opened_at >= @since
    AND (@symbol = '' OR symbol = @symbol)
)
SELECT
  COUNT(*) AS total,
  SUM(CASE WHEN closed_at IS NOT NULL THEN 1 ELSE 0 END) AS closed,
  SUM(CASE WHEN closed_at IS NULL THEN 1 ELSE 0 END) AS open,
  ROUND(AVG(CASE WHEN pnl_pct IS NOT NULL THEN pnl_pct END), 4) AS avg_pnl_pct,
  ROUND(AVG(CASE WHEN duration_min IS NOT NULL THEN duration_min END), 2) AS avg_duration_min,
  ROUND(MAX(CASE WHEN pnl_pct IS NOT NULL THEN pnl_pct END), 4) AS best_pnl_pct,
  ROUND(MIN(CASE WHEN pnl_pct IS NOT NULL THEN pnl_pct END), 4) AS worst_pnl_pct,
  SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) AS wins,
  SUM(CASE WHEN pnl_pct < 0 THEN 1 ELSE 0 END) AS losses,
  ROUND(
    CASE
      WHEN SUM(CASE WHEN pnl_pct IS NOT NULL THEN 1 ELSE 0 END) = 0 THEN NULL
      ELSE (SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) * 100.0) / SUM(CASE WHEN pnl_pct IS NOT NULL THEN 1 ELSE 0 END)
    END,
    2
  ) AS win_rate
FROM trade_stats
`);

const getTradeExtremesStmt = db.prepare(`
WITH closed_stats AS (
  SELECT
    trade_id,
    symbol,
    direction,
    leverage,
    entry_price,
    closed_price,
    close_reason,
    opened_at,
    closed_at,
    CASE
      WHEN closed_price IS NULL OR entry_price <= 0 THEN NULL
      WHEN direction = 'LONG' THEN ((closed_price - entry_price) / entry_price) * 100 * leverage
      WHEN direction = 'SHORT' THEN ((entry_price - closed_price) / entry_price) * 100 * leverage
      ELSE ((closed_price - entry_price) / entry_price) * 100
    END AS pnl_pct,
    (closed_at - opened_at) / 60000.0 AS duration_min
  FROM trade_logs
  WHERE closed_at IS NOT NULL
    AND opened_at >= @since
    AND (@symbol = '' OR symbol = @symbol)
)
SELECT
  trade_id,
  symbol,
  direction,
  leverage,
  entry_price,
  closed_price,
  close_reason,
  opened_at,
  closed_at,
  ROUND(pnl_pct, 4) AS pnl_pct,
  ROUND(duration_min, 2) AS duration_min
FROM closed_stats
WHERE pnl_pct IS NOT NULL
ORDER BY CASE WHEN @mode = 'best' THEN pnl_pct END DESC,
         CASE WHEN @mode = 'worst' THEN pnl_pct END ASC,
         closed_at DESC
LIMIT @limit
`);

const getTradeDurationsStmt = db.prepare(`
SELECT
  trade_id,
  symbol,
  direction,
  opened_at,
  closed_at,
  ROUND((closed_at - opened_at) / 60000.0, 2) AS duration_min,
  close_reason
FROM trade_logs
WHERE closed_at IS NOT NULL
  AND opened_at >= @since
  AND (@symbol = '' OR symbol = @symbol)
ORDER BY duration_min DESC
LIMIT @limit
`);

const getCloseReasonsStmt = db.prepare(`
SELECT
  COALESCE(close_reason, 'UNKNOWN') AS reason,
  COUNT(*) AS total
FROM trade_logs
WHERE closed_at IS NOT NULL
  AND opened_at >= @since
  AND (@symbol = '' OR symbol = @symbol)
GROUP BY COALESCE(close_reason, 'UNKNOWN')
ORDER BY total DESC
LIMIT 10
`);

const getTopSymbolsStmt = db.prepare(`
WITH closed_stats AS (
  SELECT
    symbol,
    CASE
      WHEN closed_price IS NULL OR entry_price <= 0 THEN NULL
      WHEN direction = 'LONG' THEN ((closed_price - entry_price) / entry_price) * 100 * leverage
      WHEN direction = 'SHORT' THEN ((entry_price - closed_price) / entry_price) * 100 * leverage
      ELSE ((closed_price - entry_price) / entry_price) * 100
    END AS pnl_pct
  FROM trade_logs
  WHERE closed_at IS NOT NULL
    AND opened_at >= @since
    AND (@symbol = '' OR symbol = @symbol)
)
SELECT
  symbol,
  COUNT(*) AS trades,
  ROUND(AVG(CASE WHEN pnl_pct IS NOT NULL THEN pnl_pct END), 4) AS avg_pnl_pct,
  ROUND(SUM(CASE WHEN pnl_pct IS NOT NULL THEN pnl_pct ELSE 0 END), 4) AS net_pnl_pct
FROM closed_stats
GROUP BY symbol
ORDER BY trades DESC, net_pnl_pct DESC
LIMIT 8
`);

const getSignalSummaryStmt = db.prepare(`
SELECT
  COUNT(*) AS total_signals,
  ROUND(AVG(score), 2) AS avg_score,
  ROUND(AVG(long_prob), 2) AS avg_long_prob,
  ROUND(AVG(short_prob), 2) AS avg_short_prob,
  SUM(CASE WHEN suggested_action = 'LONG' THEN 1 ELSE 0 END) AS long_signals,
  SUM(CASE WHEN suggested_action = 'SHORT' THEN 1 ELSE 0 END) AS short_signals,
  SUM(CASE WHEN suggested_action = 'NO_TRADE' THEN 1 ELSE 0 END) AS no_trade_signals
FROM signal_logs
WHERE created_at >= @since
  AND (@symbol = '' OR symbol = @symbol)
`);

const insertBotFeedbackStmt = db.prepare(`
INSERT INTO bot_feedback_logs (
  trade_id, symbol, source, event_type, rating, outcome, notes, payload_json, created_at
) VALUES (
  @trade_id, @symbol, @source, @event_type, @rating, @outcome, @notes, @payload_json, @created_at
)
`);

const getFeedbackSummaryStmt = db.prepare(`
SELECT
  COUNT(*) AS total_feedback,
  ROUND(AVG(CASE WHEN rating IS NOT NULL THEN rating END), 2) AS avg_rating,
  SUM(CASE WHEN rating >= 4 THEN 1 ELSE 0 END) AS positive_feedback,
  SUM(CASE WHEN rating <= 2 THEN 1 ELSE 0 END) AS negative_feedback
FROM bot_feedback_logs
WHERE created_at >= @since
  AND (@symbol = '' OR symbol = @symbol)
`);

const getFeedbackOutcomesStmt = db.prepare(`
SELECT
  COALESCE(outcome, 'UNSPECIFIED') AS outcome,
  COUNT(*) AS total
FROM bot_feedback_logs
WHERE created_at >= @since
  AND (@symbol = '' OR symbol = @symbol)
GROUP BY COALESCE(outcome, 'UNSPECIFIED')
ORDER BY total DESC
LIMIT 10
`);

export function logSignal(symbol, signal) {
  insertSignalStmt.run({
    symbol,
    market: signal.market,
    period: signal.period,
    score: signal.score,
    label: signal.label,
    confidence: signal.confidence,
    suggested_action: signal.suggestedAction,
    long_prob: signal.probabilities.longProb,
    short_prob: signal.probabilities.shortProb,
    payload_json: JSON.stringify(signal),
    created_at: Date.now()
  });
}

export function logTradeOpen(trade) {
  insertTradeStmt.run({
    trade_id: trade.tradeId,
    symbol: trade.symbol,
    market: trade.market,
    side: trade.side,
    direction: trade.direction,
    confidence: trade.confidence,
    leverage: trade.leverage,
    percent: trade.percent,
    amount: trade.amount,
    entry_price: trade.entryPrice,
    stop_loss: trade.stopLoss,
    take_profit: trade.takeProfit,
    signal_period: trade.signalPeriod,
    status: trade.status,
    opened_at: trade.openedAt,
    closed_at: null,
    details_json: JSON.stringify(trade.details || {}),
    closed_price: null,
    close_reason: null
  });
}

export function logTradeClose(tradeId, meta = {}) {
  updateTradeStatusStmt.run({
    trade_id: tradeId,
    status: "CLOSED",
    closed_at: Date.now(),
    close_reason: meta.closeReason || null,
    closed_price: meta.closedPrice ?? null
  });
}

export function getOpenTrades() {
  return selectOpenTradesStmt.all().map((row) => ({
    tradeId: row.trade_id,
    symbol: row.symbol,
    market: row.market,
    side: row.side,
    direction: row.direction,
    confidence: row.confidence,
    leverage: row.leverage,
    percent: row.percent,
    amount: row.amount,
    entryPrice: row.entry_price,
    stopLoss: row.stop_loss,
    takeProfit: row.take_profit,
    signalPeriod: row.signal_period,
    status: row.status,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    details: row.details_json ? JSON.parse(row.details_json) : {},
    closedPrice: row.closed_price,
    closeReason: row.close_reason
  }));
}

export function logAdvice(tradeId, advice) {
  insertAdviceStmt.run({
    trade_id: tradeId,
    recommendation: advice.recommendation,
    reason: advice.reason,
    pnl_pct: advice.pnlPct,
    score: advice.score,
    prob_for_side: advice.probForSide,
    prob_against_side: advice.probAgainstSide,
    created_at: Date.now()
  });
}

export function logBotFeedback(entry = {}) {
  const symbol = String(entry.symbol || "").trim().toUpperCase();
  if (!symbol) {
    throw new Error("symbol requerido para feedback.");
  }

  const ratingValue = Number(entry.rating);
  const safeRating = Number.isFinite(ratingValue)
    ? Math.max(1, Math.min(5, Math.round(ratingValue)))
    : null;

  insertBotFeedbackStmt.run({
    trade_id: entry.tradeId ? String(entry.tradeId) : null,
    symbol,
    source: String(entry.source || "SYSTEM"),
    event_type: String(entry.eventType || "GENERAL"),
    rating: safeRating,
    outcome: entry.outcome ? String(entry.outcome) : null,
    notes: entry.notes ? String(entry.notes).slice(0, 4000) : null,
    payload_json: JSON.stringify(entry.payload || {}),
    created_at: Date.now()
  });
}

export function getTradingStatistics({ days = 30, symbol = "", limit = 8 } = {}) {
  const parsedDays = Number.isFinite(Number(days)) ? Math.max(1, Math.min(365, Number(days))) : 30;
  const safeSymbol = String(symbol || "").trim().toUpperCase();
  const safeLimit = Number.isFinite(Number(limit)) ? Math.max(3, Math.min(20, Number(limit))) : 8;
  const since = Date.now() - parsedDays * 24 * 60 * 60 * 1000;
  const params = { since, symbol: safeSymbol, limit: safeLimit };

  const summary = getTradeStatsSummaryStmt.get(params);
  const bestTrades = getTradeExtremesStmt.all({ ...params, mode: "best" });
  const worstTrades = getTradeExtremesStmt.all({ ...params, mode: "worst" });
  const longestTrades = getTradeDurationsStmt.all(params);
  const closeReasons = getCloseReasonsStmt.all(params);
  const topSymbols = getTopSymbolsStmt.all(params);
  const signalSummary = getSignalSummaryStmt.get(params);
  const feedbackSummary = getFeedbackSummaryStmt.get(params);
  const feedbackOutcomes = getFeedbackOutcomesStmt.all(params);

  return {
    windowDays: parsedDays,
    symbol: safeSymbol || null,
    summary,
    signalSummary,
    feedbackSummary,
    feedbackOutcomes,
    bestTrades,
    worstTrades,
    longestTrades,
    closeReasons,
    topSymbols,
    generatedAt: Date.now()
  };
}

export default db;
