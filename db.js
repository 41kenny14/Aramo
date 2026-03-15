import Database from "better-sqlite3";
import config from "./config.js";

const db = new Database(config.dbPath);

db.pragma("journal_mode = WAL");

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
`);

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
  entry_price, stop_loss, take_profit, signal_period, status, opened_at, closed_at
) VALUES (
  @trade_id, @symbol, @market, @side, @direction, @confidence, @leverage, @percent, @amount,
  @entry_price, @stop_loss, @take_profit, @signal_period, @status, @opened_at, @closed_at
)
`);

const updateTradeStatusStmt = db.prepare(`
UPDATE trade_logs
SET status = @status, closed_at = @closed_at
WHERE trade_id = @trade_id
`);

const insertAdviceStmt = db.prepare(`
INSERT INTO trade_advice_logs (
  trade_id, recommendation, reason, pnl_pct, score, prob_for_side, prob_against_side, created_at
) VALUES (
  @trade_id, @recommendation, @reason, @pnl_pct, @score, @prob_for_side, @prob_against_side, @created_at
)
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
    closed_at: null
  });
}

export function logTradeClose(tradeId) {
  updateTradeStatusStmt.run({
    trade_id: tradeId,
    status: "CLOSED",
    closed_at: Date.now()
  });
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

export default db;