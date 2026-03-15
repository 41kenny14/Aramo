function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function getTimeStopMinutes(period, setupType = "NONE") {
  // Más corto para scalping / micro-follow-through
  switch (period) {
    case "1min":
      return setupType.startsWith("BREAKOUT") ? 2.5 : 3.5;
    case "3min":
      return setupType.startsWith("BREAKOUT") ? 4 : 5;
    case "5min":
      return setupType.startsWith("BREAKOUT") ? 6 : 8;
    case "15min":
      return setupType.startsWith("BREAKOUT") ? 12 : 15;
    case "30min":
      return setupType.startsWith("BREAKOUT") ? 20 : 24;
    case "1hour":
      return setupType.startsWith("BREAKOUT") ? 35 : 45;
    default:
      return 8;
  }
}

export function adviseTrade({ trade, signal, currentPosition }) {
  const entry = num(trade?.entryPrice);
  const positionMark = num(currentPosition?.mark_price || currentPosition?.last);
  const signalMark = num(signal?.metrics?.markPrice);
  const mark = positionMark || signalMark || entry || 0;

  const side = trade?.direction || "LONG";
  const setupType = signal?.setup?.type || trade?.setupType || "NONE";

  const pnlPct =
    entry > 0
      ? side === "LONG"
        ? ((mark - entry) / entry) * 100
        : ((entry - mark) / entry) * 100
      : 0;

  const longProb = num(signal?.probabilities?.longProb || 50);
  const shortProb = num(signal?.probabilities?.shortProb || 50);
  const suggested = signal?.suggestedAction || "NO_TRADE";
  const score = num(signal?.score || 0);
  const confidence = signal?.confidence || "LOW";
  const regime = signal?.regime || "TRANSITION";

  const bias1h = signal?.mtf?.bias1h || "NEUTRAL";
  const bias15m = signal?.mtf?.bias15m || "NEUTRAL";
  const triggerBias = signal?.mtf?.triggerBias || "NEUTRAL";

  const adx15 = num(signal?.metrics?.adx15);
  const distEma20_5 = num(signal?.metrics?.distEma20_5);
  const bodyStrength5 = num(signal?.metrics?.bodyStrength5);
  const upperWick5 = num(signal?.metrics?.upperWick5);
  const lowerWick5 = num(signal?.metrics?.lowerWick5);

  const bullishCloseConfirmation = Boolean(signal?.setup?.bullishCloseConfirmation);
  const bearishCloseConfirmation = Boolean(signal?.setup?.bearishCloseConfirmation);

  const isNoTrade = suggested === "NO_TRADE";
  const aligned =
    (side === "LONG" && suggested === "LONG") ||
    (side === "SHORT" && suggested === "SHORT");

  const probForSide = side === "LONG" ? longProb : shortProb;
  const probAgainstSide = side === "LONG" ? shortProb : longProb;
  const edge = probForSide - probAgainstSide;
  const absoluteEdge = Math.abs(longProb - shortProb);

  const ageMin = trade?.openedAt ? (Date.now() - trade.openedAt) / 60000 : 0;
  const timeStopMin = getTimeStopMinutes(trade?.signalPeriod, setupType);

  const unrealizedPnl = num(currentPosition?.unrealized_pnl);
  const roePct =
    num(currentPosition?.margin_avbl) > 0
      ? (unrealizedPnl / num(currentPosition?.margin_avbl)) * 100
      : 0;

  const mtfAlignedLong = bias1h === "BULL" && bias15m === "BULL";
  const mtfAlignedShort = bias1h === "BEAR" && bias15m === "BEAR";
  const mtfAlignedWithTrade =
    (side === "LONG" && mtfAlignedLong) ||
    (side === "SHORT" && mtfAlignedShort);

  const candleConfirmsTrade =
    (side === "LONG" && bullishCloseConfirmation) ||
    (side === "SHORT" && bearishCloseConfirmation);

  const oppositeWickBad =
    (side === "LONG" && upperWick5 > 0.45) ||
    (side === "SHORT" && lowerWick5 > 0.45);

  const tooExtendedAgainstGoodHold =
    (side === "LONG" && distEma20_5 > 1.0) ||
    (side === "SHORT" && distEma20_5 < -1.0);

  let recommendation = "ESPERAR";
  let severity = "INFO";
  let reason = "La tesis sigue vigente.";

  // 1) invalidación fuerte: giro claro en contra
  if (!isNoTrade && !aligned && edge <= -8) {
    recommendation = "CERRAR";
    severity = "EXIT";
    reason = "La señal se giró claramente en contra de la posición.";
  }

  // 2) NO_TRADE + pérdida o falta de follow-through
  else if (isNoTrade && pnlPct <= -0.15) {
    recommendation = "CERRAR";
    severity = "EXIT";
    reason = "La señal pasó a NO_TRADE y la posición ya va en contra.";
  } else if (isNoTrade && ageMin >= Math.max(2, timeStopMin * 0.6) && pnlPct < 0.10) {
    recommendation = "CERRAR";
    severity = "EXIT";
    reason = "La señal pasó a NO_TRADE y no hubo continuación suficiente.";
  }

  // 3) cierre por deterioro rápido de timing
  else if (ageMin >= Math.min(3, timeStopMin * 0.5) && pnlPct <= -0.18 && (!candleConfirmsTrade || oppositeWickBad)) {
    recommendation = "CERRAR";
    severity = "EXIT";
    reason = "La entrada perdió timing muy rápido y la vela actual no acompaña.";
  }

  // 4) pérdida relevante + deterioro de contexto
  else if (pnlPct <= -0.30 && (!aligned || !mtfAlignedWithTrade || score < 50 || adx15 < 14)) {
    recommendation = "CERRAR";
    severity = "EXIT";
    reason = "La pérdida crece y el contexto dejó de acompañar.";
  }

  // 5) breakout que no confirma rápido
  else if (
    setupType.startsWith("BREAKOUT") &&
    ageMin >= Math.min(4, timeStopMin) &&
    pnlPct < 0.08
  ) {
    recommendation = "CERRAR";
    severity = "EXIT";
    reason = "El breakout no tuvo follow-through rápido.";
  }

  // 6) time stop contextual
  else if (ageMin >= timeStopMin && pnlPct < 0.08 && !mtfAlignedWithTrade) {
    recommendation = "CERRAR";
    severity = "EXIT";
    reason = "No hubo follow-through en el tiempo esperado y la alineación se degradó.";
  } else if (ageMin >= timeStopMin && pnlPct < 0.08) {
    recommendation = "VIGILAR";
    severity = "WATCH";
    reason = "La operación sigue lenta; vigilar si no acelera pronto.";
  }

  // 7) proteger antes, porque el bot busca micro-gain
  else if (pnlPct >= 0.25 && (confidence !== "HIGH" || score < 56 || edge < 6 || oppositeWickBad)) {
    recommendation = "PROTEGER GANANCIA";
    severity = "PROTECT";
    reason = "Hay ganancia abierta, pero la convicción actual bajó o apareció rechazo.";
  }

  // 8) cerrar ganancia si ya hubo recorrido útil y la ventaja cae
  else if (pnlPct >= 0.45 && (isNoTrade || !aligned || edge < 5 || oppositeWickBad)) {
    recommendation = "CERRAR";
    severity = "EXIT";
    reason = "Ya hubo recorrido útil y la ventaja actual se debilitó.";
  }

  // 9) si va bien pero ya muy extendido, proteger
  else if (pnlPct >= 0.35 && tooExtendedAgainstGoodHold) {
    recommendation = "PROTEGER GANANCIA";
    severity = "PROTECT";
    reason = "Ya hay ganancia y el precio quedó demasiado extendido.";
  }

  // 10) mantener solo si sigue realmente sano
  else if (
    aligned &&
    mtfAlignedWithTrade &&
    candleConfirmsTrade &&
    edge >= 8 &&
    score >= 56 &&
    adx15 >= 16 &&
    pnlPct > 0.05 &&
    !oppositeWickBad
  ) {
    recommendation = "ESPERAR";
    severity = "INFO";
    reason = "La dirección sigue alineada y todavía conserva ventaja.";
  }

  // 11) vigilancia por deterioro suave
  else if (
    score < 52 ||
    absoluteEdge < 6 ||
    regime === "COMPRESSION" ||
    bodyStrength5 < 0.30 ||
    oppositeWickBad
  ) {
    recommendation = "VIGILAR";
    severity = "WATCH";
    reason = "El contexto perdió calidad, apareció rechazo o la vela perdió fuerza.";
  }

  return {
    recommendation,
    severity,
    reason,
    pnlPct: Number(pnlPct.toFixed(3)),
    roePct: Number(roePct.toFixed(3)),
    aligned,
    isNoTrade,
    mtfAlignedWithTrade,
    candleConfirmsTrade,
    setupType,
    score,
    confidence,
    regime,
    adx15: Number(adx15.toFixed(2)),
    distEma20_5: Number(distEma20_5.toFixed(3)),
    bodyStrength5: Number(bodyStrength5.toFixed(3)),
    upperWick5: Number(upperWick5.toFixed(3)),
    lowerWick5: Number(lowerWick5.toFixed(3)),
    probForSide: Number(probForSide.toFixed(1)),
    probAgainstSide: Number(probAgainstSide.toFixed(1)),
    edge: Number(edge.toFixed(1)),
    absoluteEdge: Number(absoluteEdge.toFixed(1)),
    liveSideFromSignal: suggested,
    currentMarkPrice: mark,
    openInterest: currentPosition?.open_interest || null,
    unrealizedPnl: Number(unrealizedPnl.toFixed(6)),
    ageMin: Number(ageMin.toFixed(2)),
    timeStopMin: Number(timeStopMin.toFixed(2))
  };
}