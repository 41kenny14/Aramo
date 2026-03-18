let allSymbols = [];
let currentSignal = null;
let manualPreviewDirectionMode = "ORIGINAL";
let reverseModeEnabled = false;

const loading = {
  health: false,
  balances: false,
  signal: false,
  scanner: false,
  status: false,
  autoStatus: false,
  autoHistory: false,
  statistics: false
};

const queuedReload = {
  health: false,
  balances: false,
  signal: false,
  scanner: false,
  status: false,
  autoStatus: false,
  autoHistory: false,
  statistics: false
};

function qs(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const el = qs(id);
  if (el) el.textContent = value;
}

function setHTML(id, value) {
  const el = qs(id);
  if (el) el.innerHTML = value;
}

function setResult(message, isError = false) {
  const box = qs("resultBox");
  if (!box) return;

  box.classList.remove("hidden");
  box.classList.toggle("error", isError);
  box.classList.toggle("success", !isError);
  box.textContent = message;
}

function formatNum(v, digits = 8) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  return n.toLocaleString("es-AR", { maximumFractionDigits: digits });
}

function formatTimeAgo(timestamp) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return "—";

  const diffMs = Date.now() - ts;
  if (diffMs < 0) return "recién";

  const sec = Math.floor(diffMs / 1000);
  if (sec < 5) return "hace unos segundos";
  if (sec < 60) return `hace ${sec} seg`;

  const min = Math.floor(sec / 60);
  if (min < 60) return `hace ${min} min`;

  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `hace ${hrs} h`;

  const days = Math.floor(hrs / 24);
  return `hace ${days} d`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}


function formatPct(v, digits = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  const prefix = n > 0 ? "+" : "";
  return `${prefix}${n.toLocaleString("es-AR", { maximumFractionDigits: digits })}%`;
}

function renderStatsTradeList(items = []) {
  if (!items.length) {
    return `<div class="empty-state small">Sin datos.</div>`;
  }

  return items
    .map((item) => `
      <div class="list-card">
        <div class="title-row">
          <strong>${escapeHtml(item.symbol)} · ${escapeHtml(item.direction)}</strong>
          <span class="tag">${escapeHtml(formatPct(item.pnl_pct, 3))}</span>
        </div>
        <div class="info-grid">
          <div class="info-row"><span>Trade ID</span><strong>${escapeHtml(item.trade_id)}</strong></div>
          <div class="info-row"><span>Leverage</span><strong>${escapeHtml(item.leverage)}x</strong></div>
          <div class="info-row"><span>Duración</span><strong>${escapeHtml(formatNum(item.duration_min, 2))} min</strong></div>
          <div class="info-row"><span>Cierre</span><strong>${escapeHtml(item.close_reason || "UNKNOWN")}</strong></div>
        </div>
      </div>
    `)
    .join("");
}

function setActiveSection(section) {
  const isStats = section === "stats";

  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.section === section);
  });

  qs("dashboardSection")?.classList.toggle("hidden", isStats);
  qs("dashboardSection")?.classList.toggle("active", !isStats);
  qs("statsSection")?.classList.toggle("hidden", !isStats);
  qs("statsSection")?.classList.toggle("active", isStats);

  setText("topbarSubtitle", isStats ? "KPIs avanzados desde SQLite" : "Monitor general del sistema");
  setText("topbarTitle", isStats ? "Estadísticas" : "Dashboard");

  const topbarRight = document.querySelector(".topbar-right");
  if (topbarRight) topbarRight.classList.toggle("hidden", isStats);

  if (isStats) {
    loadStatistics();
  }
}

async function loadStatistics() {
  await guardedLoad("statistics", async () => {
    try {
      const days = Number(qs("statsDays")?.value || 30);
      const symbol = (qs("statsSymbol")?.value || "").trim().toUpperCase();
      const params = new URLSearchParams({ days: String(days), limit: "8" });
      if (symbol) params.set("symbol", symbol);

      const data = await api(`/api/statistics?${params.toString()}`);
      const summary = data.summary || {};
      const signalSummary = data.signalSummary || {};

      setText("statsTotalTrades", formatNum(summary.total, 0));
      setText("statsClosedTrades", formatNum(summary.closed, 0));
      setText("statsOpenTrades", formatNum(summary.open, 0));
      setText("statsWinRate", formatPct(summary.win_rate, 2));
      setText("statsAvgPnl", formatPct(summary.avg_pnl_pct, 3));
      setText("statsAvgDuration", `${formatNum(summary.avg_duration_min, 2)} min`);
      setText("statsBestTrade", formatPct(summary.best_pnl_pct, 3));
      setText("statsWorstTrade", formatPct(summary.worst_pnl_pct, 3));
      setText("statsSignalsTotal", formatNum(signalSummary.total_signals, 0));
      setText("statsAvgSignalScore", formatNum(signalSummary.avg_score, 2));

      setHTML("statsBestTrades", renderStatsTradeList(data.bestTrades || []));
      setHTML("statsWorstTrades", renderStatsTradeList(data.worstTrades || []));
      setHTML("statsLongestTrades", renderStatsTradeList(data.longestTrades || []));

      setText(
        "statsExtraData",
        JSON.stringify(
          {
            filtros: {
              dias: data.windowDays,
              simbolo: data.symbol || "ALL"
            },
            closeReasons: data.closeReasons || [],
            topSymbols: data.topSymbols || []
          },
          null,
          2
        )
      );
    } catch (e) {
      setText("statsExtraData", `Error cargando estadísticas: ${e.message}`);
    }
  });
}

function getSignalEdge(signal) {
  const longProb = Number(signal?.probabilities?.longProb || 0);
  const shortProb = Number(signal?.probabilities?.shortProb || 0);
  return Math.abs(longProb - shortProb);
}

function getSignalSetupType(signal) {
  return signal?.setup?.type || "NONE";
}

async function api(url, options = {}) {
  const controller = new AbortController();
  const timeoutMs = Number(options.timeoutMs || 12000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const { timeoutMs: _timeoutMs, ...fetchOptions } = options;
    const res = await fetch(url, { ...fetchOptions, signal: controller.signal });

    let data = null;
    try {
      data = await res.json();
    } catch {
      throw new Error(`Respuesta inválida (${res.status})`);
    }

    if (!res.ok || !data.ok) {
      throw new Error(data.error || "Error desconocido");
    }

    return data;
  } catch (e) {
    if (e?.name === "AbortError") {
      throw new Error("Timeout de conexión. Reintentá en unos segundos.");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function guardedLoad(key, fn) {
  if (loading[key]) {
    queuedReload[key] = true;
    return;
  }

  loading[key] = true;
  try {
    do {
      queuedReload[key] = false;
      await fn();
    } while (queuedReload[key]);
  } finally {
    loading[key] = false;
    queuedReload[key] = false;
  }
}

async function withButtonLock(buttonId, fn) {
  const btn = qs(buttonId);
  if (btn) btn.disabled = true;
  try {
    return await fn();
  } finally {
    if (btn) btn.disabled = false;
  }
}

function updateMarketPreview() {
  const symbol = qs("symbol")?.value || "-";
  setText("marketPreview", symbol === "-" ? "-" : `${symbol}USDT`);

  const item = allSymbols.find((x) => x.symbol === symbol);
  setText(
    "symbolHint",
    item
      ? item.memeLike
        ? "Detectado como meme-like."
        : "Disponible en futures USDT."
      : "Seleccioná un símbolo válido."
  );
}

function refillSymbolSelect() {
  const search = (qs("symbolSearch")?.value || "").trim().toUpperCase();
  const memeFilter = qs("memeOnly")?.value || "all";
  const select = qs("symbol");
  if (!select) return;

  const prev = select.value;
  let filtered = [...allSymbols];

  if (search) filtered = filtered.filter((x) => x.symbol.includes(search));
  if (memeFilter === "meme") filtered = filtered.filter((x) => x.memeLike);
  else if (memeFilter === "normal") filtered = filtered.filter((x) => !x.memeLike);

  select.innerHTML = "";

  for (const item of filtered) {
    const opt = document.createElement("option");
    opt.value = item.symbol;
    opt.textContent = item.memeLike ? `${item.symbol} 🔥` : item.symbol;
    select.appendChild(opt);
  }

  if (filtered.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Sin resultados";
    select.appendChild(opt);
  }

  if (filtered.some((x) => x.symbol === prev)) {
    select.value = prev;
  }

  setText("symbolsCount", `${filtered.length} / ${allSymbols.length}`);
  updateMarketPreview();
}

function setSignalAlertClass(action, confidence) {
  const el = qs("signalAlert");
  if (!el) return;

  el.className = "signal-alert";

  if (action === "LONG") {
    el.classList.add(confidence === "HIGH" ? "bull" : "watch");
  } else if (action === "SHORT") {
    el.classList.add(confidence === "HIGH" ? "bear" : "watch");
  } else {
    el.classList.add("neutral");
  }
}

function renderSignal(signal) {
  currentSignal = signal;
  if (!signal) return;

  const edge = getSignalEdge(signal);
  const isNoTrade = signal.suggestedAction === "NO_TRADE";
  const setupType = getSignalSetupType(signal);
  const adx15 = signal.metrics?.adx15;
  const distEma20 = signal.metrics?.distEma20_5;
  const bodyStrength5 = signal.metrics?.bodyStrength5;
  const upperWick5 = signal.metrics?.upperWick5;
  const lowerWick5 = signal.metrics?.lowerWick5;
  const bullConfirm = signal.setup?.bullishCloseConfirmation;
  const bearConfirm = signal.setup?.bearishCloseConfirmation;

  setText("signalScore", signal.score ?? "-");
  setText("signalLabel", signal.label ?? "-");
  setText(
    "signalAction",
    isNoTrade
      ? `NO_TRADE · ${signal.confidence}`
      : `${signal.suggestedAction} · ${signal.confidence}`
  );

  setText(
    "signalAlert",
    isNoTrade
      ? `Sin entrada. Long ${formatNum(signal.probabilities?.longProb, 1)}% / Short ${formatNum(signal.probabilities?.shortProb, 1)}% · Edge ${formatNum(edge, 1)} · Regime ${signal.regime} · Setup ${setupType}`
      : `Dirección sugerida: ${signal.suggestedAction}. Long ${formatNum(signal.probabilities?.longProb, 1)}% / Short ${formatNum(signal.probabilities?.shortProb, 1)}% · Edge ${formatNum(edge, 1)} · Regime ${signal.regime} · Setup ${setupType}`
  );

  setText("metricLongProb", `${formatNum(signal.probabilities?.longProb, 1)}%`);
  setText("metricShortProb", `${formatNum(signal.probabilities?.shortProb, 1)}%`);
  setText("metricRegime", `${signal.regime ?? "-"} · ${signal.marketState || "-"} (${formatNum(signal.marketStateConfidence,1)}%)`);
  setText("metricBias1h", signal.mtf?.bias1h ?? "-");
  setText("metricBias15m", signal.mtf?.bias15m ?? "-");
  setText("metricBiasTrigger", signal.mtf?.triggerBias ?? "-");

  setText("metricRsi5", formatNum(signal.metrics?.rsi5, 2));
  setText("metricRsi15", formatNum(signal.metrics?.rsi15, 2));
  setText("metricRsi1h", formatNum(signal.metrics?.rsi1h, 2));
  setText("metricAtrRatio", formatNum(signal.metrics?.atrRatio, 3));
  setText("metricOiRatio", formatNum(signal.metrics?.oiRatio, 3));
  setText("metricVolumeRatio", formatNum(signal.metrics?.volumeRatio, 3));
  setText("metricEdge", formatNum(edge, 1));

  const extra = qs("signalExtraInfo");
  if (extra) {
    extra.textContent =
      `ADX15 ${formatNum(adx15, 2)} · Dist EMA20 ${formatNum(distEma20, 3)}% · EDGE_SCORE ${formatNum(signal.edgeScore,2)} · Prob ${formatNum(signal.estimatedSuccessProb,1)}% · ` +
      `Body ${formatNum(bodyStrength5, 3)} · UpWick ${formatNum(upperWick5, 3)} · LowWick ${formatNum(lowerWick5, 3)} · ` +
      `Setup ${setupType} · BullConf ${bullConfirm ? "Sí" : "No"} · BearConf ${bearConfirm ? "Sí" : "No"} · ` +
      `OI ${signal.metrics?.oiConfirmation || "-"}`;
  }


  const summaryText = signal.reasoning?.summary || "Sin summary disponible todavía.";
  setText("botReasoningSummary", summaryText);

  const friendlyReason = isNoTrade
    ? `Ahora mismo no conviene entrar porque la señal todavía no está firme (${signal.confidence || "LOW"}). Lo más sano es esperar confirmación para evitar meterse en un trade flojo.`
    : `Pinta ${signal.suggestedAction} porque hay más probabilidad a favor (${formatNum(Math.max(signal.probabilities?.longProb || 0, signal.probabilities?.shortProb || 0), 1)}%) y el setup ${setupType} está acompañando. O sea, el contexto está más prolijo para intentar entrada.`;
  setText("botReasoningWhy", friendlyReason);

  const breakdown = {
    marketState: signal.marketState,
    confidence: signal.marketStateConfidence,
    edgeScore: signal.edgeScore,
    estimatedSuccessProb: signal.estimatedSuccessProb,
    summary: signal.reasoning?.summary,
    waitingFor: signal.reasoning?.waitingFor || [],
    nextLevels: signal.reasoning?.nextLevels || {}
  };
  setText("botReasoningBreakdown", JSON.stringify(breakdown, null, 2));

  setSignalAlertClass(signal.suggestedAction, signal.confidence);
}

function draftCardHtml(draft) {
  const t = draft.trade;
  return `
    <div class="list-card">
      <div class="title-row">
        <strong>${escapeHtml(t.symbol)} · ${escapeHtml(t.direction)}</strong>
        <span class="tag">${escapeHtml(t.confidence)}</span>
      </div>

      <div class="info-grid">
        <div class="info-row"><span>Leverage</span><strong>${escapeHtml(t.leverage)}x</strong></div>
        <div class="info-row"><span>Score</span><strong>${escapeHtml(t.score ?? "-")}</strong></div>
        <div class="info-row"><span>Edge</span><strong>${escapeHtml(formatNum(t.edge, 1))}</strong></div>
        <div class="info-row"><span>Setup</span><strong>${escapeHtml(t.setupType || "-")}</strong></div>
        <div class="info-row"><span>ADX15</span><strong>${escapeHtml(formatNum(t.adx15, 2))}</strong></div>
        <div class="info-row"><span>Dist EMA20</span><strong>${escapeHtml(formatNum(t.distEma20_5, 3))}%</strong></div>
        <div class="info-row"><span>Body</span><strong>${escapeHtml(formatNum(t.bodyStrength5, 3))}</strong></div>
        <div class="info-row"><span>Percent base</span><strong>${escapeHtml(t.requestedPercent)}%</strong></div>
        <div class="info-row"><span>Percent efectivo</span><strong>${escapeHtml(t.effectivePercent)}%</strong></div>
        <div class="info-row"><span>Notional</span><strong>${escapeHtml(t.notional)}</strong></div>
        <div class="info-row"><span>Cantidad</span><strong>${escapeHtml(t.amount)}</strong></div>
        <div class="info-row"><span>Raw amount</span><strong>${escapeHtml(t.rawAmount ?? "-")}</strong></div>
        <div class="info-row"><span>Min amount</span><strong>${escapeHtml(t.minAmount ?? "-")}</strong></div>
        <div class="info-row"><span>Entrada ref.</span><strong>${escapeHtml(t.entryReference)}</strong></div>
        <div class="info-row"><span>SL</span><strong>${escapeHtml(t.stopLoss)}</strong></div>
        <div class="info-row"><span>TP</span><strong>${escapeHtml(t.takeProfit)}</strong></div>
        <div class="info-row"><span>Modo</span><strong>${escapeHtml(t.directionMode || "ORIGINAL")}</strong></div>
      </div>

      <div class="card-actions">
        <button onclick="executeDraft('${escapeHtml(draft.draftId)}')" class="btn btn-primary">Iniciar</button>
        <button onclick="cancelDraft('${escapeHtml(draft.draftId)}')" class="btn btn-secondary">Cancelar</button>
      </div>
    </div>
  `;
}

function tradeCardHtml(trade) {
  const pos = trade.livePosition || {};
  const advice = trade.advice || {};

  return `
    <div class="list-card highlight">
      <div class="title-row">
        <strong>${escapeHtml(trade.symbol)} · ${escapeHtml(trade.direction)}</strong>
        <span class="tag">${escapeHtml(advice.recommendation || "-")}</span>
      </div>

      <div class="info-grid">
        <div class="info-row"><span>Trade ID</span><strong>${escapeHtml(trade.tradeId)}</strong></div>
        <div class="info-row"><span>Leverage</span><strong>${escapeHtml(trade.leverage)}x</strong></div>
        <div class="info-row"><span>Setup</span><strong>${escapeHtml(advice.setupType || trade.setupType || "-")}</strong></div>
        <div class="info-row"><span>Severity</span><strong>${escapeHtml(advice.severity || "-")}</strong></div>
        <div class="info-row"><span>Score</span><strong>${escapeHtml(trade.score ?? "-")}</strong></div>
        <div class="info-row"><span>Edge</span><strong>${escapeHtml(formatNum(trade.edge, 1))}</strong></div>
        <div class="info-row"><span>Entry</span><strong>${escapeHtml(trade.entryPrice)}</strong></div>
        <div class="info-row"><span>Mark</span><strong>${escapeHtml(advice.currentMarkPrice ?? "-")}</strong></div>
        <div class="info-row"><span>PnL %</span><strong>${escapeHtml(advice.pnlPct ?? "-")}</strong></div>
        <div class="info-row"><span>ROE %</span><strong>${escapeHtml(advice.roePct ?? "-")}</strong></div>
        <div class="info-row"><span>Edad</span><strong>${escapeHtml(advice.ageMin ?? "-")} min</strong></div>
        <div class="info-row"><span>Time stop</span><strong>${escapeHtml(advice.timeStopMin ?? "-")} min</strong></div>
        <div class="info-row"><span>Signal live</span><strong>${escapeHtml(advice.liveSideFromSignal ?? "-")}</strong></div>
        <div class="info-row"><span>Prob favor</span><strong>${escapeHtml(advice.probForSide ?? "-")}%</strong></div>
        <div class="info-row"><span>Prob contra</span><strong>${escapeHtml(advice.probAgainstSide ?? "-")}%</strong></div>
        <div class="info-row"><span>ADX15</span><strong>${escapeHtml(advice.adx15 ?? "-")}</strong></div>
        <div class="info-row"><span>Dist EMA20</span><strong>${escapeHtml(advice.distEma20_5 ?? "-")}%</strong></div>
        <div class="info-row"><span>Body</span><strong>${escapeHtml(advice.bodyStrength5 ?? "-")}</strong></div>
        <div class="info-row"><span>UpWick</span><strong>${escapeHtml(advice.upperWick5 ?? "-")}</strong></div>
        <div class="info-row"><span>LowWick</span><strong>${escapeHtml(advice.lowerWick5 ?? "-")}</strong></div>
        <div class="info-row"><span>Confirma vela</span><strong>${advice.candleConfirmsTrade ? "Sí" : "No"}</strong></div>
        <div class="info-row"><span>OI</span><strong>${escapeHtml(pos.open_interest ?? "-")}</strong></div>
        <div class="info-row"><span>Motivo</span><strong>${escapeHtml(advice.reason ?? "-")}</strong></div>
      </div>

      <div class="card-actions">
        <button onclick="closeTrade('${escapeHtml(trade.tradeId)}')" class="btn btn-danger">Cerrar</button>
      </div>
    </div>
  `;
}

function scannerCardHtml(item) {
  return `
    <div class="list-card highlight">
      <div class="title-row">
        <strong>${escapeHtml(item.symbol)} · ${escapeHtml(item.direction)}</strong>
        <span class="tag">${escapeHtml(formatNum(item.probability, 1))}%</span>
      </div>

      <div class="info-grid">
        <div class="info-row"><span>Score</span><strong>${escapeHtml(item.score)}</strong></div>
        <div class="info-row"><span>Edge</span><strong>${escapeHtml(formatNum(item.edge, 1))}</strong></div>
        <div class="info-row"><span>Confianza</span><strong>${escapeHtml(item.confidence)}</strong></div>
        <div class="info-row"><span>Regime</span><strong>${escapeHtml(item.regime)}</strong></div>
        <div class="info-row"><span>Setup</span><strong>${escapeHtml(item.setupType || "-")}</strong></div>
        <div class="info-row"><span>ADX15</span><strong>${escapeHtml(formatNum(item.adx15, 2))}</strong></div>
        <div class="info-row"><span>Dist EMA20</span><strong>${escapeHtml(formatNum(item.distEma20_5, 3))}%</strong></div>
        <div class="info-row"><span>Body</span><strong>${escapeHtml(formatNum(item.bodyStrength5, 3))}</strong></div>
        <div class="info-row"><span>UpWick</span><strong>${escapeHtml(formatNum(item.upperWick5, 3))}</strong></div>
        <div class="info-row"><span>LowWick</span><strong>${escapeHtml(formatNum(item.lowerWick5, 3))}</strong></div>
        <div class="info-row"><span>Bias 1h</span><strong>${escapeHtml(item.bias1h || "-")}</strong></div>
        <div class="info-row"><span>Bias 15m</span><strong>${escapeHtml(item.bias15m || "-")}</strong></div>
        <div class="info-row"><span>Conf vela</span><strong>${item.direction === "LONG" ? (item.bullishCloseConfirmation ? "Sí" : "No") : (item.bearishCloseConfirmation ? "Sí" : "No")}</strong></div>
        <div class="info-row"><span>Activa ya</span><strong>${item.alreadyActive ? "Sí" : "No"}</strong></div>
      </div>

      <div class="card-actions">
        <button onclick="focusScannerSymbol('${escapeHtml(item.symbol)}')" class="btn btn-primary">Ver ${escapeHtml(item.symbol)}</button>
      </div>
    </div>
  `;
}
function renderScannerStats(data) {
  const statsEl = qs("scannerStatsBox");
  if (!statsEl) return;

  const scanner = data?.scanner || {};
  const stats = scanner.lastStats || null;

  if (!stats) {
    statsEl.textContent = "Sin estadísticas de scanner todavía.";
    return;
  }

  const rejectedBy = stats.rejectedBy || {};
  const totals = stats.totals || {};
  const batch = stats.batch || {};
  const cfg = stats.config || {};

  statsEl.textContent =
    `Batch ${batch.start}-${batch.end} (${batch.size}) | ` +
    `inspected=${totals.inspected ?? 0} fulfilled=${totals.fulfilled ?? 0} accepted=${totals.accepted ?? 0} rejected=${totals.rejected ?? 0} errors=${totals.requestErrors ?? 0} kept=${totals.keptAfterMerge ?? 0}\n` +
    `cfg: prob>=${cfg.minProbability} score>=${cfg.minScore} edge>=${cfg.minEdge} period=${cfg.signalPeriod} adx>=${cfg.minAdx15 ?? "-"} dist<=${cfg.maxAbsDistEma20_5 ?? "-"} body>=${cfg.minBodyStrength5 ?? "-"}\n` +
    `rejectedBy: ` +
    `NO_TRADE=${rejectedBy.NO_TRADE ?? 0}, ` +
    `LOW_PROBABILITY=${rejectedBy.LOW_PROBABILITY ?? 0}, ` +
    `LOW_SCORE=${rejectedBy.LOW_SCORE ?? 0}, ` +
    `LOW_EDGE=${rejectedBy.LOW_EDGE ?? 0}, ` +
    `LOW_CONFIDENCE=${rejectedBy.LOW_CONFIDENCE ?? 0}, ` +
    `LOW_ADX=${rejectedBy.LOW_ADX ?? 0}, ` +
    `TOO_EXTENDED=${rejectedBy.TOO_EXTENDED ?? 0}, ` +
    `WEAK_CANDLE=${rejectedBy.WEAK_CANDLE ?? 0}, ` +
    `COMPRESSION=${rejectedBy.COMPRESSION ?? 0}, ` +
    `TRANSITION_BLOCKED=${rejectedBy.TRANSITION_BLOCKED ?? 0}, ` +
    `INVALID_LONG_SETUP=${rejectedBy.INVALID_LONG_SETUP ?? 0}, ` +
    `INVALID_SHORT_SETUP=${rejectedBy.INVALID_SHORT_SETUP ?? 0}, ` +
    `NO_BULL_CONFIRM=${rejectedBy.NO_BULL_CONFIRM ?? 0}, ` +
    `NO_BEAR_CONFIRM=${rejectedBy.NO_BEAR_CONFIRM ?? 0}, ` +
    `BAD_UPPER_WICK=${rejectedBy.BAD_UPPER_WICK ?? 0}, ` +
    `BAD_LOWER_WICK=${rejectedBy.BAD_LOWER_WICK ?? 0}, ` +
    `DIRTY_BREAKOUT_LONG=${rejectedBy.DIRTY_BREAKOUT_LONG ?? 0}, ` +
    `DIRTY_BREAKOUT_SHORT=${rejectedBy.DIRTY_BREAKOUT_SHORT ?? 0}`;
}
function renderScannerFindings(findings) {
  if (!findings || !findings.length) {
    setHTML("scannerAlertBox", `<div class="empty-state">Sin oportunidades destacadas.</div>`);
    return;
  }

  const currentSymbol = qs("symbol")?.value || "";
  const visible = findings.filter((f) => f.symbol !== currentSymbol);

  if (!visible.length) {
    setHTML("scannerAlertBox", `<div class="empty-state">No hay alertas externas al símbolo actual.</div>`);
    return;
  }

  setHTML("scannerAlertBox", visible.map(scannerCardHtml).join(""));
}
async function loadSymbols(forceRefresh = false) {
  const suffix = forceRefresh ? "?refresh=1" : "";
  const data = await api(`/api/symbols${suffix}`);
  allSymbols = data.symbols || [];
  refillSymbolSelect();
}

async function loadHealth() {
  await guardedLoad("health", async () => {
    try {
      const data = await api("/api/health");
      setText("healthBadge", `OK · ${data.botStatus}`);
    } catch {
      setText("healthBadge", "ERROR");
    }
  });
}

async function loadBalances() {
  await guardedLoad("balances", async () => {
    const data = await api("/api/balances");
    const usdt = data.usdt?.available ?? "-";
    setText("topUsdtBalance", formatNum(usdt));
  });
}

async function loadSignal() {
  await guardedLoad("signal", async () => {
    const symbol = qs("symbol")?.value;
    if (!symbol) return;

    try {
      const period = qs("signalPeriod")?.value || "5min";
      const data = await api(`/api/signal?symbol=${encodeURIComponent(symbol)}&period=${encodeURIComponent(period)}`);
      renderSignal(data.signal);
    } catch (e) {
      const msg = String(e.message || "");
      if (msg.includes("502 Bad Gateway") || msg.includes("CloudFront")) {
        setResult("CoinEx está respondiendo con error temporal (502). Reintentando en el próximo ciclo.", true);
      } else {
        setResult(`Señal: ${e.message}`, true);
      }
    }
  });
}

async function loadScanner() {
  await guardedLoad("scanner", async () => {
    try {
      const data = await api("/api/scan-opportunities");
      renderScannerFindings(data.findings || []);
      renderScannerStats(data);
      setText("scannerUpdatedAt", `Actualizado: ${formatTimeAgo(data.lastRunAt)}`);
    } catch (e) {
      console.error("Scanner error:", e.message);
      setText("scannerUpdatedAt", "Actualizado: error temporal");
    }
  });
}

async function loadStatus() {
  await guardedLoad("status", async () => {
    const data = await api("/api/status");
    const bot = data.bot || {};

    const botStatus = bot.status || "-";
    setText("botStatus", botStatus);
    setText("botStatusPanel", botStatus);
    setText("botAction", bot.lastAction || "-");
    setText("botError", bot.lastError || "-");
    setText("rawStatus", JSON.stringify(data, null, 2));

    const resetBtn = qs("resetBotBtn");
    if (resetBtn) {
      resetBtn.classList.toggle("hidden", botStatus !== "error");
    }
    const sniperOn = Boolean(bot?.accountState?.sniperMode);
    const gridOn = Boolean(bot?.accountState?.gridMode);
    const sniperBtn = qs("sniperModeBtn");
    const gridBtn = qs("gridModeBtn");
    if (sniperBtn) sniperBtn.textContent = sniperOn ? "SNIPER ON" : "SNIPER OFF";
    if (gridBtn) gridBtn.textContent = gridOn ? "GRID ON" : "GRID OFF";

    const drafts = data.drafts || [];
    setHTML(
      "draftsBox",
      drafts.length
        ? drafts.map(draftCardHtml).join("")
        : `<div class="empty-state">Sin previews.</div>`
    );

    const tradesData = await api("/api/trades");
    const trades = tradesData.trades || [];
    setHTML(
      "tradesBox",
      trades.length
        ? trades.map(tradeCardHtml).join("")
        : `<div class="empty-state">Sin trades activos.</div>`
    );
  });
}

async function refreshAll() {
  await Promise.allSettled([
    loadHealth(),
    loadBalances(),
    loadSignal(),
    loadScanner(),
    loadStatus(),
    loadAutoStatus(),
    loadAutoHistory(),
    loadStatistics()
  ]);
}

async function previewTrade() {
  const symbol = qs("symbol")?.value;
  if (!symbol) {
    setResult("No hay símbolo válido seleccionado.", true);
    return;
  }

  if (currentSignal?.suggestedAction === "NO_TRADE") {
    setResult("La señal actual está en NO_TRADE. No conviene crear preview.", true);
    return;
  }

  const payload = {
    symbol,
    percent: Number(qs("percent")?.value || 20),
    stopLossPct: Number(qs("sl")?.value || 0.6),
    takeProfitPct: Number(qs("tp")?.value || 0.8),
    signalPeriod: qs("signalPeriod")?.value || "5min",
    directionMode: manualPreviewDirectionMode
  };

  try {
    await withButtonLock("previewBtn", async () => {
      const data = await api("/api/preview-trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      setResult(`Preview creada para ${data.preview.trade.symbol}.`);
      await loadStatus();
    });
  } catch (e) {
    setResult(e.message, true);
  }
}

async function executeDraft(draftId) {
  try {
    const data = await api("/api/execute-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draftId })
    });

    setResult(data.message || "Trade iniciada.");
    await loadStatus();
    await loadBalances();
  } catch (e) {
    setResult(e.message, true);
  }
}

async function cancelDraft(draftId) {
  try {
    const data = await api("/api/cancel-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draftId })
    });

    setResult(data.message || "Preview cancelada.");
    await loadStatus();
  } catch (e) {
    setResult(e.message, true);
  }
}

async function closeTrade(tradeId) {
  try {
    const data = await api(`/api/close-trade/${encodeURIComponent(tradeId)}`, {
      method: "POST"
    });

    setResult(data.message || "Trade cerrada.");
    await loadStatus();
    await loadBalances();
  } catch (e) {
    setResult(e.message, true);
  }
}

async function focusScannerSymbol(symbol) {
  const select = qs("symbol");
  if (select) select.value = symbol;
  updateMarketPreview();
  await loadSignal();
}

function renderAutoStatus(enabled) {
  setText("autoStatusLabel", enabled ? "AUTO ON" : "AUTO OFF");

  const btn = qs("autoToggleBtn");
  if (btn) {
    btn.textContent = enabled ? "Desactivar" : "Activar";
  }
}

function renderManualPreviewMode() {
  const btn = qs("previewDirectionBtn");
  if (!btn) return;

  const inverted = manualPreviewDirectionMode === "INVERTED";
  btn.textContent = inverted ? "Original" : "Invertir";
  btn.classList.toggle("btn-warning", inverted);
}

function renderReverseMode(enabled) {
  reverseModeEnabled = Boolean(enabled);
  const btn = qs("reverseModeBtn");
  if (!btn) return;

  btn.textContent = reverseModeEnabled ? "Bot Invertido ON" : "Bot Invertido OFF";
  btn.classList.toggle("btn-warning", reverseModeEnabled);
}

async function togglePreviewDirectionMode() {
  manualPreviewDirectionMode = manualPreviewDirectionMode === "INVERTED" ? "ORIGINAL" : "INVERTED";
  renderManualPreviewMode();
}

async function toggleReverseMode() {
  try {
    await withButtonLock("reverseModeBtn", async () => {
      const data = await api("/api/reverse-mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !reverseModeEnabled })
      });

      renderReverseMode(Boolean(data.reverseMode));
      setResult(data.reverseMode ? "Modo invertido activado para el bot." : "Modo original restaurado para el bot.");
      await loadStatus();
    });
  } catch (e) {
    setResult(e.message, true);
  }
}

function autoOpenedCardHtml(item) {
  return `
    <div class="list-card">
      <div class="title-row">
        <strong>${escapeHtml(item.symbol)} · ${escapeHtml(item.direction)}</strong>
        <span class="tag">AUTO OPEN</span>
      </div>
      <div class="info-grid">
        <div class="info-row"><span>Trade ID</span><strong>${escapeHtml(item.tradeId)}</strong></div>
        <div class="info-row"><span>Leverage</span><strong>${escapeHtml(item.leverage)}x</strong></div>
        <div class="info-row"><span>Score</span><strong>${escapeHtml(item.score ?? "-")}</strong></div>
        <div class="info-row"><span>Edge</span><strong>${escapeHtml(formatNum(item.edge, 1))}</strong></div>
        <div class="info-row"><span>Abierta</span><strong>${new Date(item.openedAt).toLocaleString()}</strong></div>
      </div>
    </div>
  `;
}

function autoClosedCardHtml(item) {
  return `
    <div class="list-card">
      <div class="title-row">
        <strong>${escapeHtml(item.symbol)} · ${escapeHtml(item.direction)}</strong>
        <span class="tag">${escapeHtml(item.reason)}</span>
      </div>
      <div class="info-grid">
        <div class="info-row"><span>Trade ID</span><strong>${escapeHtml(item.tradeId)}</strong></div>
        <div class="info-row"><span>PnL %</span><strong>${escapeHtml(formatNum(item.pnlPct, 3))}</strong></div>
        <div class="info-row"><span>Abierta</span><strong>${new Date(item.openedAt).toLocaleString()}</strong></div>
        <div class="info-row"><span>Cerrada</span><strong>${new Date(item.closedAt).toLocaleString()}</strong></div>
      </div>
    </div>
  `;
}

async function loadAutoStatus() {
  await guardedLoad("autoStatus", async () => {
    try {
      const data = await api("/api/auto-status");
      renderAutoStatus(Boolean(data.enabled));
      renderReverseMode(Boolean(data.reverseMode));
    } catch (e) {
      console.error("Auto status error:", e.message);
    }
  });
}

async function loadAutoHistory() {
  await guardedLoad("autoHistory", async () => {
    try {
      const data = await api("/api/auto-history");

      setHTML(
        "autoOpenedBox",
        data.autoOpenedTrades?.length
          ? data.autoOpenedTrades.map(autoOpenedCardHtml).join("")
          : `<div class="empty-state">Sin aperturas automáticas.</div>`
      );

      setHTML(
        "autoClosedBox",
        data.autoClosedTrades?.length
          ? data.autoClosedTrades.map(autoClosedCardHtml).join("")
          : `<div class="empty-state">Sin cierres automáticos.</div>`
      );
    } catch (e) {
      console.error("Auto history error:", e.message);
    }
  });
}

async function toggleAutoTrading() {
  try {
    await withButtonLock("autoToggleBtn", async () => {
      const current = (qs("autoStatusLabel")?.textContent || "").includes("ON");
      const data = await api("/api/auto-toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !current })
      });

      renderAutoStatus(Boolean(data.enabled));
      renderReverseMode(Boolean(data.reverseMode));
      setResult(data.enabled ? "Auto trading activado." : "Auto trading desactivado.");
      await loadStatus();
    });
  } catch (e) {
    setResult(e.message, true);
  }
}


async function toggleGridMode() {
  try {
    await withButtonLock("gridModeBtn", async () => {
      const isOn = (qs("gridModeBtn")?.textContent || "").includes("ON");
      const data = await api("/api/grid-mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !isOn })
      });
      setResult(data.gridMode ? "Grid mode activado." : "Grid mode desactivado.");
      await loadStatus();
    });
  } catch (e) {
    setResult(e.message, true);
  }
}

async function toggleSniperMode() {
  try {
    await withButtonLock("sniperModeBtn", async () => {
      const isOn = (qs("sniperModeBtn")?.textContent || "").includes("ON");
      const data = await api("/api/sniper-mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !isOn })
      });
      setResult(data.sniperMode ? "Sniper mode activado." : "Sniper mode desactivado.");
      await loadStatus();
    });
  } catch (e) {
    setResult(e.message, true);
  }
}


async function resetBotState() {
  try {
    await withButtonLock("resetBotBtn", async () => {
      const data = await api("/api/reset-runtime", { method: "POST" });
      setResult(data.message || "Bot reseteado.");
      await refreshAll();
    });
  } catch (e) {
    setResult(`No se pudo resetear: ${e.message}`, true);
  }
}

window.executeDraft = executeDraft;
window.cancelDraft = cancelDraft;
window.closeTrade = closeTrade;
window.focusScannerSymbol = focusScannerSymbol;

qs("previewBtn")?.addEventListener("click", previewTrade);
qs("refreshBtn")?.addEventListener("click", refreshAll);
qs("refreshSignalBtn")?.addEventListener("click", loadSignal);

qs("symbolSearch")?.addEventListener("input", refillSymbolSelect);
qs("memeOnly")?.addEventListener("change", refillSymbolSelect);

qs("symbol")?.addEventListener("change", async () => {
  updateMarketPreview();
  await loadSignal();
});

qs("autoToggleBtn")?.addEventListener("click", toggleAutoTrading);
qs("previewDirectionBtn")?.addEventListener("click", togglePreviewDirectionMode);
qs("reverseModeBtn")?.addEventListener("click", toggleReverseMode);
qs("signalPeriod")?.addEventListener("change", loadSignal);
qs("gridModeBtn")?.addEventListener("click", toggleGridMode);
qs("sniperModeBtn")?.addEventListener("click", toggleSniperMode);
qs("resetBotBtn")?.addEventListener("click", resetBotState);

qs("statsDays")?.addEventListener("change", loadStatistics);
qs("statsSymbol")?.addEventListener("change", loadStatistics);
qs("refreshStatsBtn")?.addEventListener("click", loadStatistics);

document.querySelectorAll(".nav-item").forEach((item) => {
  item.addEventListener("click", (e) => {
    e.preventDefault();
    setActiveSection(item.dataset.section || "dashboard");
  });
});

qs("reloadSymbolsBtn")?.addEventListener("click", async () => {
  try {
    await withButtonLock("reloadSymbolsBtn", async () => {
      await loadSymbols(true);
      setResult("Símbolos recargados desde CoinEx.");
      await loadSignal();
    });
  } catch (e) {
    setResult(e.message, true);
  }
});

renderManualPreviewMode();

(async function init() {
  try {
    await loadSymbols(false);
    await refreshAll();
  } catch (e) {
    setResult(e.message, true);
  }
})();

function startUiLoops() {
  setInterval(() => {
    loadHealth();
    loadBalances();
  }, 10000);

  setInterval(() => {
    loadSignal();
    loadScanner();
    loadStatus();
    loadAutoStatus();
    loadAutoHistory();

    if (!qs("statsSection")?.classList.contains("hidden")) {
      loadStatistics();
    }
  }, 5000);
}

startUiLoops();
