import Database from "better-sqlite3";

const learningDb = new Database("./aprendizaje.db");
learningDb.pragma("journal_mode = WAL");

function n(v, fallback = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function r(v, digits = 6) {
  return Number(n(v).toFixed(digits));
}

function toIsoUtc(ts = Date.now()) {
  const ms = n(ts);
  if (ms <= 0) return null;
  return new Date(ms).toISOString();
}

function resolveSessionUTC(ts = Date.now()) {
  const d = new Date(n(ts));
  const hour = d.getUTCHours();
  if (hour >= 0 && hour < 8) return "Asia";
  if (hour >= 8 && hour < 14) return "Europa";
  return "USA";
}

function safeJson(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function parseJsonSafe(value, fallback = {}) {
  try {
    if (!value) return fallback;
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

learningDb.exec(`
CREATE TABLE IF NOT EXISTS trades_raw (
  trade_id TEXT PRIMARY KEY,
  timestamp_apertura INTEGER NOT NULL,
  timestamp_cierre INTEGER,
  simbolo TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  modo TEXT NOT NULL,
  tipo TEXT NOT NULL,
  precio_entrada REAL,
  precio_salida REAL,
  tamano_posicion REAL,
  apalancamiento REAL,
  stop_loss REAL,
  take_profit REAL,
  rsi REAL,
  momentum REAL,
  atr14 REAL,
  volumen_absoluto REAL,
  volumen_relativo REAL,
  open_interest REAL,
  funding_rate REAL,
  vwap REAL,
  medias_moviles TEXT,
  volatilidad REAL,
  spread REAL,
  liquidez_estimada REAL,
  distancia_soporte REAL,
  distancia_resistencia REAL,
  contexto_estructura TEXT,
  breakout_detectado INTEGER,
  pullback_detectado INTEGER,
  zona_liquidez_cercana INTEGER,
  compresion_volatilidad INTEGER,
  tendencia_multi_timeframe TEXT,
  estado_mercado TEXT,
  sesion TEXT,
  hora_utc TEXT,
  volatilidad_general_activo REAL,
  profit_absoluto REAL,
  profit_pct REAL,
  resultado TEXT,
  duracion_trade_seg INTEGER,
  mfe_pct REAL,
  mae_pct REAL,
  tipo_cierre TEXT,
  cierre_anticipado INTEGER,
  clasificacion_profit TEXT,
  clasificacion_duracion TEXT,
  tipo_patron TEXT,
  condiciones_clave TEXT,
  contexto_json TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trades_aprendidos (
  patron_id TEXT PRIMARY KEY,
  descripcion_patron TEXT NOT NULL,
  condiciones_clave TEXT NOT NULL,
  winrate REAL NOT NULL,
  profit_promedio REAL NOT NULL,
  duracion_promedio REAL NOT NULL,
  nivel_riesgo TEXT NOT NULL,
  cantidad_muestras INTEGER NOT NULL,
  score_confianza REAL NOT NULL
);
`);

const insertRawOpenStmt = learningDb.prepare(`
INSERT OR REPLACE INTO trades_raw (
  trade_id, timestamp_apertura, timestamp_cierre, simbolo, timeframe, modo, tipo,
  precio_entrada, precio_salida, tamano_posicion, apalancamiento, stop_loss, take_profit,
  rsi, momentum, atr14, volumen_absoluto, volumen_relativo, open_interest, funding_rate, vwap,
  medias_moviles, volatilidad, spread, liquidez_estimada, distancia_soporte, distancia_resistencia,
  contexto_estructura, breakout_detectado, pullback_detectado, zona_liquidez_cercana,
  compresion_volatilidad, tendencia_multi_timeframe, estado_mercado, sesion, hora_utc,
  volatilidad_general_activo, profit_absoluto, profit_pct, resultado, duracion_trade_seg,
  mfe_pct, mae_pct, tipo_cierre, cierre_anticipado, clasificacion_profit, clasificacion_duracion,
  tipo_patron, condiciones_clave, contexto_json, updated_at
) VALUES (
  @trade_id, @timestamp_apertura, @timestamp_cierre, @simbolo, @timeframe, @modo, @tipo,
  @precio_entrada, @precio_salida, @tamano_posicion, @apalancamiento, @stop_loss, @take_profit,
  @rsi, @momentum, @atr14, @volumen_absoluto, @volumen_relativo, @open_interest, @funding_rate, @vwap,
  @medias_moviles, @volatilidad, @spread, @liquidez_estimada, @distancia_soporte, @distancia_resistencia,
  @contexto_estructura, @breakout_detectado, @pullback_detectado, @zona_liquidez_cercana,
  @compresion_volatilidad, @tendencia_multi_timeframe, @estado_mercado, @sesion, @hora_utc,
  @volatilidad_general_activo, @profit_absoluto, @profit_pct, @resultado, @duracion_trade_seg,
  @mfe_pct, @mae_pct, @tipo_cierre, @cierre_anticipado, @clasificacion_profit, @clasificacion_duracion,
  @tipo_patron, @condiciones_clave, @contexto_json, @updated_at
)
`);

const selectRawByIdStmt = learningDb.prepare(`SELECT * FROM trades_raw WHERE trade_id = ?`);
const updateRawCloseStmt = learningDb.prepare(`
UPDATE trades_raw
SET
  timestamp_cierre = @timestamp_cierre,
  precio_salida = @precio_salida,
  profit_absoluto = @profit_absoluto,
  profit_pct = @profit_pct,
  resultado = @resultado,
  duracion_trade_seg = @duracion_trade_seg,
  mfe_pct = @mfe_pct,
  mae_pct = @mae_pct,
  tipo_cierre = @tipo_cierre,
  cierre_anticipado = @cierre_anticipado,
  clasificacion_profit = @clasificacion_profit,
  clasificacion_duracion = @clasificacion_duracion,
  tipo_patron = @tipo_patron,
  condiciones_clave = @condiciones_clave,
  contexto_json = @contexto_json,
  updated_at = @updated_at
WHERE trade_id = @trade_id
`);

const aggregatePatternStmt = learningDb.prepare(`
SELECT
  COUNT(*) AS total,
  AVG(COALESCE(profit_pct, 0)) AS avg_profit,
  AVG(COALESCE(duracion_trade_seg, 0)) AS avg_duration,
  SUM(CASE WHEN resultado = 'GANADOR' THEN 1 ELSE 0 END) AS wins
FROM trades_raw
WHERE tipo_patron = @tipo_patron
  AND tendencia_multi_timeframe = @tendencia_multi_timeframe
  AND estado_mercado = @estado_mercado
  AND sesion = @sesion
`);

const upsertPatternStmt = learningDb.prepare(`
INSERT INTO trades_aprendidos (
  patron_id, descripcion_patron, condiciones_clave, winrate, profit_promedio,
  duracion_promedio, nivel_riesgo, cantidad_muestras, score_confianza
) VALUES (
  @patron_id, @descripcion_patron, @condiciones_clave, @winrate, @profit_promedio,
  @duracion_promedio, @nivel_riesgo, @cantidad_muestras, @score_confianza
)
ON CONFLICT(patron_id) DO UPDATE SET
  descripcion_patron = excluded.descripcion_patron,
  condiciones_clave = excluded.condiciones_clave,
  winrate = excluded.winrate,
  profit_promedio = excluded.profit_promedio,
  duracion_promedio = excluded.duracion_promedio,
  nivel_riesgo = excluded.nivel_riesgo,
  cantidad_muestras = excluded.cantidad_muestras,
  score_confianza = excluded.score_confianza
`);

function classifyProfitLevel(profitPct) {
  const p = n(profitPct);
  if (p < 0.5) return "Bajo";
  if (p < 2) return "Medio";
  if (p < 4) return "Alto";
  return "Excepcional";
}

function classifyDuration(seconds) {
  const s = n(seconds);
  if (s <= 45 * 60) return "Scalping";
  if (s <= 8 * 60 * 60) return "Intradía";
  return "Swing corto";
}

function classifyPattern(ctx = {}) {
  const setup = String(ctx.setupType || "");
  const structure = String(ctx.structure || "");
  const breakout = Boolean(ctx.breakoutDetectado);
  const pullback = Boolean(ctx.pullbackDetectado);
  const liqGrab = n(ctx.lowerWick5) > 0.45 || n(ctx.upperWick5) > 0.45;

  if (setup.includes("BREAKOUT") && liqGrab) return "Fake breakout";
  if (liqGrab && breakout) return "Liquidity grab";
  if (setup.includes("BREAKOUT") || breakout) return "Breakout";
  if (setup.includes("PULLBACK") || pullback) return "Pullback";
  if (structure.includes("BULLISH") || structure.includes("BEARISH")) return "Momentum trade";
  if (ctx.marketState === "LATERAL_RANGE" || ctx.marketState === "ACCUMULATION") return "Rango";
  if (ctx.direction === "LONG" && String(ctx.contextoEstructura).includes("soporte")) return "Reversión en soporte";
  if (ctx.direction === "SHORT" && String(ctx.contextoEstructura).includes("resistencia")) return "Rechazo en resistencia";
  return "Momentum trade";
}

function computeTrendMtf(signal = {}) {
  const b1h = String(signal?.mtf?.bias1h || "NEUTRAL");
  const b15 = String(signal?.mtf?.bias15m || "NEUTRAL");
  if (b1h === "BULL" && b15 === "BULL") return "alcista";
  if (b1h === "BEAR" && b15 === "BEAR") return "bajista";
  return "lateral";
}

function computeMarketState(signal = {}) {
  const raw = String(signal?.marketState || "AMBIGUOUS");
  if (raw.includes("RANGE") || raw === "ACCUMULATION" || raw === "DISTRIBUTION") return "ranging";
  if (raw.includes("TREND")) return "trending";
  if (raw.includes("VOLATILITY")) return "volátil";
  return "volátil";
}

function inferStructureContext({ direction, signal }) {
  const mark = n(signal?.metrics?.markPrice);
  const support = n(signal?.metrics?.liquiditySellSide);
  const resistance = n(signal?.metrics?.liquidityBuySide);
  const distSupport = mark > 0 && support > 0 ? Math.abs(((mark - support) / mark) * 100) : 0;
  const distResistance = mark > 0 && resistance > 0 ? Math.abs(((resistance - mark) / mark) * 100) : 0;
  const zoneType = String(signal?.entryPlan?.zoneType || "").toUpperCase();

  let contexto = "rango";
  if (zoneType === "SUPPORT" || distSupport < 0.35) contexto = "soporte";
  else if (zoneType === "RESISTANCE" || distResistance < 0.35) contexto = "resistencia";
  else if (String(signal?.marketState).includes("TREND")) contexto = "tendencia";

  const breakout = Boolean(signal?.setup?.breakoutUp || signal?.setup?.breakoutDown);
  const pullback = Boolean(signal?.setup?.pullbackLong || signal?.setup?.pullbackShort);

  return {
    distanciaSoporte: r(distSupport, 4),
    distanciaResistencia: r(distResistance, 4),
    contextoEstructura: contexto,
    breakoutDetectado: breakout,
    pullbackDetectado: pullback,
    zonaLiquidezCercana: distSupport < 0.45 || distResistance < 0.45,
    compresionVolatilidad: Boolean(signal?.metrics?.squeeze)
  };
}

function computePatternId(raw) {
  const base = [raw.tipo_patron, raw.tendencia_multi_timeframe, raw.estado_mercado, raw.sesion].join("|");
  return `PAT_${Buffer.from(base).toString("base64").replace(/=/g, "").slice(0, 24)}`;
}

function buildOpenFeedback({ trade, raw }) {
  return [
    `📚 TRADE ${trade.tradeId} — REGISTRO DE APRENDIZAJE`,
    "Se ha detectado una nueva operación manual.",
    "Contexto capturado:",
    `• Tipo: ${trade.direction}`,
    `• Ubicación: ${raw.contexto_estructura}`,
    `• Tendencia: ${raw.tendencia_multi_timeframe}`,
    `• RSI: ${raw.rsi}`,
    `• Volatilidad: ${raw.estado_mercado}`,
    `• Sesión: ${raw.sesion}`,
    "🧠 Aprendizaje en progreso: se almacenará como posible patrón."
  ].join("\n");
}

function buildCloseFeedback({ row, riskLevel, confidenceScore, patternDescription, negative }) {
  const conclusion = negative
    ? "⚠️ Este contexto será marcado como potencialmente riesgoso."
    : "Patrón actualizado con la nueva muestra.";

  return [
    `📊 TRADE ${row.trade_id} — RESULTADO Y APRENDIZAJE`,
    `Resultado: ${r(row.profit_pct, 3)}% (${row.resultado})`,
    `Duración: ${Math.round(n(row.duracion_trade_seg) / 60)} minutos`,
    `Cierre: ${row.tipo_cierre || "otro"}`,
    "🧠 Conclusiones aprendidas:",
    `• Patrón detectado: ${patternDescription}`,
    `• Estado mercado: ${row.estado_mercado}`,
    `• Sesión: ${row.sesion}`,
    negative ? "• Aprendizaje negativo: configuración adversa detectada" : "• Aprendizaje positivo: condiciones favorables detectadas",
    conclusion,
    `Nivel de confianza del patrón: ${confidenceScore.toFixed(2)}%`,
    `Nivel de riesgo: ${riskLevel}`
  ].join("\n");
}

export function registerLearningTradeOpen({ trade, signal, learningMode = true, mode = "manual" } = {}) {
  if (!trade?.tradeId) return null;

  const structure = inferStructureContext({ direction: trade.direction, signal: signal || {} });
  const trendMtf = computeTrendMtf(signal);
  const marketState = computeMarketState(signal);
  const session = resolveSessionUTC(trade.openedAt || Date.now());

  const row = {
    trade_id: trade.tradeId,
    timestamp_apertura: n(trade.openedAt || Date.now()),
    timestamp_cierre: null,
    simbolo: String(trade.symbol || "").toUpperCase(),
    timeframe: String(trade.signalPeriod || signal?.period || "5min"),
    modo: learningMode ? String(mode || "manual") : "automático",
    tipo: String(trade.direction || "LONG"),
    precio_entrada: r(trade.entryPrice, 8),
    precio_salida: null,
    tamano_posicion: r(trade.amount, 8),
    apalancamiento: r(trade.leverage, 4),
    stop_loss: trade.stopLoss != null ? r(trade.stopLoss, 8) : null,
    take_profit: trade.takeProfit != null ? r(trade.takeProfit, 8) : null,
    rsi: r(signal?.metrics?.rsi5, 3),
    momentum: r(signal?.metrics?.move5, 4),
    atr14: r(signal?.metrics?.atr15, 8),
    volumen_absoluto: r(signal?.metrics?.volumeAbsolute || 0, 8),
    volumen_relativo: r(signal?.metrics?.volumeRatio, 6),
    open_interest: r(signal?.metrics?.oiRatio, 6),
    funding_rate: r(signal?.metrics?.fundingRate, 8),
    vwap: r(signal?.metrics?.vwap5, 8),
    medias_moviles: safeJson({
      ema20_15: signal?.metrics?.ema20_15,
      ema50_15: signal?.metrics?.ema50_15,
      ema20_1h: signal?.metrics?.ema20_1h,
      ema50_1h: signal?.metrics?.ema50_1h
    }),
    volatilidad: r(signal?.metrics?.atrPct15 || signal?.metrics?.atrRatio, 6),
    spread: r(signal?.metrics?.spread || 0, 8),
    liquidez_estimada: r(Math.max(n(signal?.metrics?.liquidityBuySide), n(signal?.metrics?.liquiditySellSide)), 8),
    distancia_soporte: structure.distanciaSoporte,
    distancia_resistencia: structure.distanciaResistencia,
    contexto_estructura: structure.contextoEstructura,
    breakout_detectado: structure.breakoutDetectado ? 1 : 0,
    pullback_detectado: structure.pullbackDetectado ? 1 : 0,
    zona_liquidez_cercana: structure.zonaLiquidezCercana ? 1 : 0,
    compresion_volatilidad: structure.compresionVolatilidad ? 1 : 0,
    tendencia_multi_timeframe: trendMtf,
    estado_mercado: marketState,
    sesion: session,
    hora_utc: toIsoUtc(trade.openedAt || Date.now()),
    volatilidad_general_activo: r(signal?.metrics?.atrRatio, 6),
    profit_absoluto: null,
    profit_pct: null,
    resultado: null,
    duracion_trade_seg: null,
    mfe_pct: 0,
    mae_pct: 0,
    tipo_cierre: null,
    cierre_anticipado: null,
    clasificacion_profit: null,
    clasificacion_duracion: null,
    tipo_patron: null,
    condiciones_clave: safeJson({
      setupType: signal?.setup?.type || "NONE",
      marketState: signal?.marketState,
      trendMtf,
      structure: signal?.metrics?.structure,
      score: signal?.score,
      edgeScore: signal?.edgeScore
    }),
    contexto_json: safeJson({ trade, signal, learningMode }),
    updated_at: Date.now()
  };

  insertRawOpenStmt.run(row);

  const feedback = buildOpenFeedback({ trade, raw: row });
  return {
    learningMode,
    feedback,
    snapshot: {
      tradeId: trade.tradeId,
      tipo: row.tipo,
      ubicacion: row.contexto_estructura,
      tendencia: row.tendencia_multi_timeframe,
      rsi: row.rsi,
      volatilidad: row.estado_mercado,
      sesion: row.sesion
    }
  };
}

export function registerLearningTradeClose({ trade, closeReason = "manual", closedPrice = null, pnlPct = 0, closeTimestamp = Date.now(), exitType = "manual" } = {}) {
  if (!trade?.tradeId) return null;

  const prev = selectRawByIdStmt.get(trade.tradeId);
  if (!prev) return null;

  const openedAt = n(prev.timestamp_apertura);
  const closedAt = n(closeTimestamp || Date.now());
  const durationSec = openedAt > 0 ? Math.max(0, Math.round((closedAt - openedAt) / 1000)) : 0;
  const profitPct = r(pnlPct, 6);
  const entry = n(prev.precio_entrada);
  const out = n(closedPrice);
  const profitAbs = entry > 0 && out > 0
    ? (String(prev.tipo) === "SHORT" ? (entry - out) : (out - entry)) * n(prev.tamano_posicion)
    : 0;

  const mfe = r(Math.max(n(prev.mfe_pct), profitPct), 6);
  const mae = r(Math.min(n(prev.mae_pct), profitPct), 6);

  const closeType = String(closeReason || exitType || "otro");
  const earlyClose = ["MANUAL_CLOSE", "manual", "ADVISOR_EXIT"].includes(closeType) ? 1 : 0;
  const result = profitPct >= 0 ? "GANADOR" : "PERDEDOR";

  const prevConditions = parseJsonSafe(prev.condiciones_clave, {});
  const prevContext = parseJsonSafe(prev.contexto_json, {});

  const inferredCtx = {
    setupType: prevConditions.setupType || "NONE",
    marketState: prev.estado_mercado,
    breakoutDetectado: prev.breakout_detectado === 1,
    pullbackDetectado: prev.pullback_detectado === 1,
    lowerWick5: prevContext.signal?.metrics?.lowerWick5,
    upperWick5: prevContext.signal?.metrics?.upperWick5,
    structure: prevContext.signal?.metrics?.structure,
    direction: prev.tipo,
    contextoEstructura: prev.contexto_estructura
  };

  const tipoPatron = classifyPattern(inferredCtx);

  const newRow = {
    trade_id: trade.tradeId,
    timestamp_cierre: closedAt,
    precio_salida: out > 0 ? r(out, 8) : null,
    profit_absoluto: r(profitAbs, 8),
    profit_pct: profitPct,
    resultado: result,
    duracion_trade_seg: durationSec,
    mfe_pct: mfe,
    mae_pct: mae,
    tipo_cierre: closeType,
    cierre_anticipado: earlyClose,
    clasificacion_profit: classifyProfitLevel(Math.abs(profitPct)),
    clasificacion_duracion: classifyDuration(durationSec),
    tipo_patron: tipoPatron,
    condiciones_clave: safeJson({
      tipo_patron: tipoPatron,
      tendencia_multi_timeframe: prev.tendencia_multi_timeframe,
      estado_mercado: prev.estado_mercado,
      sesion: prev.sesion,
      contexto_estructura: prev.contexto_estructura,
      breakout_detectado: prev.breakout_detectado,
      pullback_detectado: prev.pullback_detectado
    }),
    contexto_json: safeJson({
      ...prevContext,
      close: {
        reason: closeType,
        closedPrice: out,
        pnlPct: profitPct,
        result,
        duracionSeg: durationSec,
        clasificacionProfit: classifyProfitLevel(Math.abs(profitPct)),
        clasificacionDuracion: classifyDuration(durationSec)
      }
    }),
    updated_at: Date.now()
  };

  updateRawCloseStmt.run(newRow);

  const aggregate = aggregatePatternStmt.get({
    tipo_patron: tipoPatron,
    tendencia_multi_timeframe: prev.tendencia_multi_timeframe,
    estado_mercado: prev.estado_mercado,
    sesion: prev.sesion
  });

  const total = n(aggregate?.total);
  const wins = n(aggregate?.wins);
  const winrate = total > 0 ? (wins / total) * 100 : 0;
  const avgProfit = r(aggregate?.avg_profit, 6);
  const avgDuration = r(aggregate?.avg_duration, 2);
  const riskLevel = winrate >= 60 ? "bajo" : winrate >= 45 ? "medio" : "alto";
  const confidenceScore = Math.min(99, r((total / 30) * 100, 2));

  const patternSeed = {
    tipo_patron: tipoPatron,
    tendencia_multi_timeframe: prev.tendencia_multi_timeframe,
    estado_mercado: prev.estado_mercado,
    sesion: prev.sesion
  };

  const learnedRow = {
    tipo_patron: tipoPatron,
    tendencia_multi_timeframe: prev.tendencia_multi_timeframe,
    estado_mercado: prev.estado_mercado,
    sesion: prev.sesion
  };

  const patronId = computePatternId(learnedRow);
  const descripcion = `${tipoPatron} en contexto ${prev.contexto_estructura} (${prev.tendencia_multi_timeframe}/${prev.estado_mercado}/${prev.sesion})`;

  upsertPatternStmt.run({
    patron_id: patronId,
    descripcion_patron: descripcion,
    condiciones_clave: safeJson(patternSeed),
    winrate: r(winrate, 4),
    profit_promedio: avgProfit,
    duracion_promedio: avgDuration,
    nivel_riesgo: riskLevel,
    cantidad_muestras: Math.round(total),
    score_confianza: confidenceScore
  });

  const feedback = buildCloseFeedback({
    row: {
      ...prev,
      ...newRow,
      trade_id: trade.tradeId,
      estado_mercado: prev.estado_mercado,
      sesion: prev.sesion
    },
    riskLevel,
    confidenceScore,
    patternDescription: descripcion,
    negative: result === "PERDEDOR"
  });

  return {
    feedback,
    result,
    pattern: {
      patronId,
      tipoPatron,
      winrate: r(winrate, 2),
      profitPromedio: avgProfit,
      cantidadMuestras: Math.round(total),
      scoreConfianza: confidenceScore,
      nivelRiesgo: riskLevel
    }
  };
}

export default learningDb;
