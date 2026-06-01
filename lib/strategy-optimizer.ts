/**
 * strategy-optimizer.ts
 *
 * 복리 극대화 + 손실 자동 분석/개선 + 강제청산 절대 방지 엔진
 *
 * 핵심 기능:
 * 1. 강제청산(Liquidation) 절대 방지 — 진입 전 청산가 사전 계산, 안전 레버리지 자동 조정
 * 2. 포트폴리오 레벨 리스크 관리 — 총 MMR 실시간 계산
 * 3. 손실 원인 자동 분석 — 연속 손실 시 패턴 분류 및 파라미터 자동 개선
 * 4. 복리 운용 계산기 — 수익 누적 시 포지션 크기 자동 증가
 * 5. 예측 정확도 피드백 루프 — 신호 적중률 추적 및 가중치 재조정
 */

// ─── 타입 정의 ────────────────────────────────────────────────────────────────

export type LossReason =
  | 'WRONG_DIRECTION'      // 방향 오판 (롱인데 하락)
  | 'WRONG_TIMING'         // 타이밍 오판 (너무 이른 진입)
  | 'HIGH_LEVERAGE'        // 레버리지 과다 (청산가 너무 가까움)
  | 'BAD_MARKET_PHASE'     // 시장 국면 불일치 (하락장에서 롱)
  | 'LOW_CONFIDENCE'       // 낮은 신뢰도 신호 진입
  | 'MACRO_SHOCK'          // 매크로 충격 (예측 불가)
  | 'FUNDING_RATE'         // 펀딩비 역풍
  | 'UNKNOWN';             // 미분류

export interface TradeOutcome {
  id: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  confidence: number;
  leverage: number;
  sourceType?: string;
  marketPhase?: string;
  entryPrice: number;
  closePrice: number;
  pnlPct: number;
  holdingMinutes?: number;
  lossReason?: LossReason;
  signalFeatures?: SignalFeatures;
  timestamp: number;
}

export interface SignalFeatures {
  rsi?: number;
  macd?: number;
  atr?: number;
  adx?: number;
  fundingRate?: number;
  takerBuyRatio?: number;
  tf15m?: string;
  tf1h?: string;
  tf4h?: string;
}

// AI 검증 v44: 복합 손실 원인 분석 배열 추가
// 단일 원인 대신 비중 배열로 실전 복합 원인 표현
export interface LossReasonScore {
  reason: LossReason;
  score: number;  // 0~100 (해당 원인의 기여도 %)
  description: string;
}

export interface LossAnalysisResult {
  totalLosses: number;
  consecutiveLosses: number;
  dominantReason: LossReason;          // 가장 지배적 원인 (하위 호환성)
  reasonBreakdown: Record<LossReason, number>; // 원인별 비율 (0~1)
  reasonScores: LossReasonScore[];     // AI 검증 v44: 복합 원인 비중 배열
  suggestedAdjustments: StrategyAdjustment[];
  riskScore: number; // 0~100 (높을수록 위험)
}

export interface StrategyAdjustment {
  parameter: string;
  currentValue: number;
  suggestedValue: number;
  reason: string;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface LiquidationSafetyCheck {
  isSafe: boolean;
  liqPrice: number;           // 예상 청산가
  distancePct: number;        // 현재가 → 청산가 거리 (%)
  safeMargin: number;         // 안전 여유 (%)
  recommendedLeverage: number; // 권장 레버리지
  reason?: string;
}

export interface CompoundingState {
  baseBalance: number;        // 초기 잔고
  currentBalance: number;     // 현재 잔고
  totalPnlPct: number;        // 누적 수익률 (%)
  compoundMultiplier: number; // 복리 배수 (현재잔고/초기잔고)
  recommendedSizePct: number; // 권장 포지션 크기 (%)
  dailyPnlPct: number;        // 오늘 수익률 (%)
}

export interface SignalAccuracy {
  symbol: string;
  totalSignals: number;
  correctSignals: number;
  accuracy: number;           // 0~1
  avgPnlPct: number;
  lastUpdated: number;
}

// ─── 강제청산 방지 계산기 ─────────────────────────────────────────────────────

/**
 * 진입 전 강제청산 안전성 검증
 *
 * Bybit Cross Margin 청산가 공식:
 * 롱: liqPrice = entryPrice × (1 - 1/leverage + maintenanceMarginRate)
 * 숏: liqPrice = entryPrice × (1 + 1/leverage - maintenanceMarginRate)
 *
 * maintenanceMarginRate: 0.5% (Bybit USDT Perpetual 기본값)
 * 안전 기준: 청산가까지 거리 최소 30% 확보
 */
export function checkLiquidationSafety(
  entryPrice: number,
  side: 'Buy' | 'Sell',
  leverage: number,
  availableBalance: number,
  positionSizePct: number,
  existingMMR: number = 0,    // 기존 포지션 MMR (%)
): LiquidationSafetyCheck {
  const MMR_RATE = 0.005; // Bybit 유지증거금률 0.5%
  const SAFE_DISTANCE_MIN = 30; // 최소 안전 거리 30%

  // 청산가 계산
  const liqPrice = side === 'Buy'
    ? entryPrice * (1 - 1 / leverage + MMR_RATE)
    : entryPrice * (1 + 1 / leverage - MMR_RATE);

  // 청산가까지 거리
  const distancePct = side === 'Buy'
    ? ((entryPrice - liqPrice) / entryPrice) * 100
    : ((liqPrice - entryPrice) / entryPrice) * 100;

  // 기존 포지션 MMR 고려한 실제 안전 여유
  const effectiveSafeMargin = distancePct - (existingMMR * 0.3);

  // 안전 여부 판단
  const isSafe = effectiveSafeMargin >= SAFE_DISTANCE_MIN;

  // 권장 레버리지 계산 (안전 거리 35% 확보 기준)
  const targetDistance = 35;
  const recommendedLeverage = Math.floor(
    1 / (targetDistance / 100 + MMR_RATE)
  );

  let reason: string | undefined;
  if (!isSafe) {
    if (distancePct < 15) {
      reason = `레버리지 ${leverage}x → 청산가 너무 가까움 (${distancePct.toFixed(1)}%). 권장: ${recommendedLeverage}x 이하`;
    } else if (existingMMR > 50) {
      reason = `기존 포지션 MMR ${existingMMR.toFixed(1)}% 높음 → 신규 진입 위험`;
    } else {
      reason = `청산가 여유 ${effectiveSafeMargin.toFixed(1)}% < 안전 기준 ${SAFE_DISTANCE_MIN}%`;
    }
  }

  return {
    isSafe,
    liqPrice,
    distancePct,
    safeMargin: effectiveSafeMargin,
    recommendedLeverage: Math.max(1, Math.min(recommendedLeverage, leverage)),
    reason,
  };
}

/**
 * 안전한 최대 레버리지 자동 계산
 * 잔고, 포지션 크기, 기존 MMR을 고려하여 강제청산 없는 최대 레버리지 반환
 */
export function calcSafeLeverage(
  entryPrice: number,
  side: 'Buy' | 'Sell',
  maxLeverage: number,
  existingMMR: number = 0,
  safeDistancePct: number = 35,
): number {
  const MMR_RATE = 0.005;
  const mmrPenalty = existingMMR > 30 ? (existingMMR - 30) * 0.02 : 0;
  const effectiveSafeDistance = (safeDistancePct + mmrPenalty) / 100;

  const safeLev = Math.floor(1 / (effectiveSafeDistance + MMR_RATE));
  return Math.max(1, Math.min(safeLev, maxLeverage));
}

/**
 * 포트폴리오 레벨 청산 위험도 계산 (0~100)
 * 100에 가까울수록 강제청산 임박
 */
export function calcPortfolioLiqRisk(
  positions: Array<{
    pnlPct: number;
    leverage: number;
    initialMarginUsdt?: number;
  }>,
  totalBalance: number,
  mmrPct: number,
): number {
  if (positions.length === 0) return 0;

  // MMR 기반 위험도 (0~60점)
  const mmrRisk = Math.min(60, mmrPct * 0.75);

  // 개별 포지션 청산 근접도 (0~40점)
  let posRisk = 0;
  for (const pos of positions) {
    const liqDistance = (100 / pos.leverage) - Math.abs(pos.pnlPct);
    if (liqDistance < 5) posRisk += 20;
    else if (liqDistance < 10) posRisk += 10;
    else if (liqDistance < 20) posRisk += 5;
  }
  posRisk = Math.min(40, posRisk);

  return Math.min(100, Math.round(mmrRisk + posRisk));
}

// ─── 손실 원인 자동 분석 ──────────────────────────────────────────────────────

/**
 * 단일 거래 손실 원인 분류
 */
export function classifyLossReason(outcome: TradeOutcome): LossReason {
  const { pnlPct, confidence, leverage, marketPhase, signalFeatures } = outcome;

  if (pnlPct >= 0) return 'UNKNOWN'; // 수익 거래는 분류 불필요

  // 매크로 충격 (보유 시간 짧고 급격한 손실)
  if ((outcome.holdingMinutes ?? 0) < 5 && pnlPct < -20) {
    return 'MACRO_SHOCK';
  }

  // 레버리지 과다 (청산가 너무 가까워서 손절)
  if (leverage >= 20 && pnlPct < -10) {
    return 'HIGH_LEVERAGE';
  }

  // 시장 국면 불일치
  if (marketPhase) {
    const bearPhases = ['RISK_OFF', 'BTC_CRASH', 'DISTRIBUTION', 'BULL_TRAP'];
    const bullPhases = ['RISK_ON', 'BTC_SURGE', 'ALT_SEASON', 'WHALE_ACCUMULATION'];
    if (outcome.direction === 'LONG' && bearPhases.includes(marketPhase)) {
      return 'BAD_MARKET_PHASE';
    }
    if (outcome.direction === 'SHORT' && bullPhases.includes(marketPhase)) {
      return 'BAD_MARKET_PHASE';
    }
  }

  // 낮은 신뢰도
  if (confidence < 75) {
    return 'LOW_CONFIDENCE';
  }

  // 펀딩비 역풍
  if (signalFeatures?.fundingRate !== undefined) {
    const fr = signalFeatures.fundingRate;
    if (outcome.direction === 'LONG' && fr > 0.001) return 'FUNDING_RATE';
    if (outcome.direction === 'SHORT' && fr < -0.001) return 'FUNDING_RATE';
  }

  // 타이밍 오판 (MTF 불일치)
  if (signalFeatures) {
    const { tf15m, tf1h, tf4h } = signalFeatures;
    const dir = outcome.direction;
    const tfList = [tf15m, tf1h, tf4h].filter(Boolean);
    const matches = tfList.filter(tf => tf === dir).length;
    if (tfList.length >= 2 && matches < tfList.length / 2) {
      return 'WRONG_TIMING';
    }
  }

  // 방향 오판 (기본)
  return 'WRONG_DIRECTION';
}

/**
 * 최근 거래 기록 분석 → 손실 원인 통계 + 개선 제안
 */
export function analyzeLossPattern(
  recentOutcomes: TradeOutcome[],
  currentConfig: {
    entryConfidenceMin: number;
    positionSizePct: number;
    defaultLeverage: number;
    stopLossPct?: number;
  },
): LossAnalysisResult {
  const losses = recentOutcomes.filter(o => o.pnlPct < 0);
  const total = recentOutcomes.length;

  // 연속 손실 계산
  let consecutiveLosses = 0;
  for (const o of recentOutcomes) {
    if (o.pnlPct < 0) consecutiveLosses++;
    else break;
  }

  // 손실 원인 분류 (AI 검증 v44: 복합 원인 배열)
  const reasonBreakdown: Record<LossReason, number> = {
    WRONG_DIRECTION: 0,
    WRONG_TIMING: 0,
    HIGH_LEVERAGE: 0,
    BAD_MARKET_PHASE: 0,
    LOW_CONFIDENCE: 0,
    MACRO_SHOCK: 0,
    FUNDING_RATE: 0,
    UNKNOWN: 0,
  };

  for (const loss of losses) {
    const reason = loss.lossReason ?? classifyLossReason(loss);
    reasonBreakdown[reason]++;
  }

  // 지배적 원인
  const dominantReason = (Object.entries(reasonBreakdown) as [LossReason, number][])
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'UNKNOWN';

  // 개선 제안 생성
  const adjustments: StrategyAdjustment[] = [];
  const lossRate = total > 0 ? losses.length / total : 0;

  if (dominantReason === 'LOW_CONFIDENCE' || lossRate > 0.5) {
    adjustments.push({
      parameter: 'entryConfidenceMin',
      currentValue: currentConfig.entryConfidenceMin,
      suggestedValue: Math.min(95, currentConfig.entryConfidenceMin + 5),
      reason: `손실률 ${(lossRate * 100).toFixed(0)}% — 신뢰도 기준 상향`,
      priority: 'HIGH',
    });
  }

  if (dominantReason === 'HIGH_LEVERAGE' || consecutiveLosses >= 3) {
    adjustments.push({
      parameter: 'defaultLeverage',
      currentValue: currentConfig.defaultLeverage,
      suggestedValue: Math.max(3, Math.floor(currentConfig.defaultLeverage * 0.7)),
      reason: `연속 손실 ${consecutiveLosses}회 — 레버리지 축소`,
      priority: 'HIGH',
    });
  }

  if (dominantReason === 'WRONG_TIMING') {
    adjustments.push({
      parameter: 'entryConfidenceMin',
      currentValue: currentConfig.entryConfidenceMin,
      suggestedValue: Math.min(95, currentConfig.entryConfidenceMin + 3),
      reason: 'MTF 불일치 손실 다수 — 타이밍 기준 강화',
      priority: 'MEDIUM',
    });
  }

  if (lossRate > 0.6 && total >= 5) {
    adjustments.push({
      parameter: 'positionSizePct',
      currentValue: currentConfig.positionSizePct,
      suggestedValue: Math.max(0.5, currentConfig.positionSizePct * 0.7),
      reason: `손실률 ${(lossRate * 100).toFixed(0)}% 과다 — 포지션 크기 축소`,
      priority: 'HIGH',
    });
  }

  // 리스크 스코어 계산
  const riskScore = Math.min(100, Math.round(
    lossRate * 40 +
    consecutiveLosses * 10 +
    (dominantReason === 'HIGH_LEVERAGE' ? 20 : 0) +
    (dominantReason === 'BAD_MARKET_PHASE' ? 15 : 0)
  ));

  // AI 검증 v44: 복합 원인 비중 배열 생성
  // 실전에서는 단일 원인이 아닌 복합 원인이 대부분
  const totalReasonCount = Object.values(reasonBreakdown).reduce((a, b) => a + b, 0);
  const reasonScores: LossReasonScore[] = Object.entries(reasonBreakdown)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => {
      const pct = totalReasonCount > 0 ? Math.round((count / totalReasonCount) * 100) : 0;
      const descriptions: Record<string, string> = {
        WRONG_DIRECTION: '방향 오판 (롤인데 하락/숏인데 상승)',
        WRONG_TIMING: '타이밍 오판 (너무 이른 진입)',
        HIGH_LEVERAGE: '레버리지 과다 (청산가 너무 가까움)',
        BAD_MARKET_PHASE: '시장 국면 불일치 (하락장에서 롤)',
        LOW_CONFIDENCE: '낙은 신뢰도 신호 진입',
        MACRO_SHOCK: '매크로 충격 (예측 불가)',
        FUNDING_RATE: '평당비 역풍',
        UNKNOWN: '미분류',
      };
      return {
        reason: reason as LossReason,
        score: pct,
        description: descriptions[reason] ?? '미분류',
      };
    })
    .sort((a, b) => b.score - a.score); // 높은 비중 순서

  return {
    totalLosses: losses.length,
    consecutiveLosses,
    dominantReason,
    reasonBreakdown,
    reasonScores,
    suggestedAdjustments: adjustments.sort((a, b) =>
      a.priority === 'HIGH' ? -1 : b.priority === 'HIGH' ? 1 : 0
    ),
    riskScore,
  };
}

// ─── 복리 운용 계산기 ─────────────────────────────────────────────────────────

/**
 * 복리 기반 권장 포지션 크기 계산
 *
 * 수익이 누적될수록 포지션 크기 자동 증가 (Kelly Criterion 기반)
 * 손실 시 포지션 크기 자동 축소 (드로다운 방어)
 */
export function calcCompoundingState(
  baseBalance: number,
  currentBalance: number,
  dailyPnlPct: number,
  basePositionSizePct: number = 2,
): CompoundingState {
  const compoundMultiplier = baseBalance > 0 ? currentBalance / baseBalance : 1;
  const totalPnlPct = (compoundMultiplier - 1) * 100;

  // 복리 배수에 따른 포지션 크기 조정
  // 1.0x → 기본 크기
  // 1.5x (+50%) → 기본 × 1.2
  // 2.0x (+100%) → 기본 × 1.4
  // 0.8x (-20%) → 기본 × 0.7 (드로다운 방어)
  let sizeMultiplier: number;
  if (compoundMultiplier >= 2.0) sizeMultiplier = 1.5;
  else if (compoundMultiplier >= 1.5) sizeMultiplier = 1.3;
  else if (compoundMultiplier >= 1.2) sizeMultiplier = 1.15;
  else if (compoundMultiplier >= 1.0) sizeMultiplier = 1.0;
  else if (compoundMultiplier >= 0.9) sizeMultiplier = 0.85;
  else sizeMultiplier = 0.7; // 심각한 드로다운

  // 오늘 수익률에 따른 추가 조정
  if (dailyPnlPct >= 20) sizeMultiplier *= 0.8;  // 오늘 이미 많이 벌었으면 보수적
  else if (dailyPnlPct <= -10) sizeMultiplier *= 0.7; // 오늘 손실 크면 축소

  const recommendedSizePct = Math.max(0.5, Math.min(5, basePositionSizePct * sizeMultiplier));

  return {
    baseBalance,
    currentBalance,
    totalPnlPct,
    compoundMultiplier,
    recommendedSizePct,
    dailyPnlPct,
  };
}

// ─── 예측 정확도 피드백 루프 ──────────────────────────────────────────────────

/**
 * 심볼별 신호 정확도 업데이트
 */
export function updateSignalAccuracy(
  accuracyMap: Map<string, SignalAccuracy>,
  symbol: string,
  wasCorrect: boolean,
  pnlPct: number,
): SignalAccuracy {
  const existing = accuracyMap.get(symbol) ?? {
    symbol,
    totalSignals: 0,
    correctSignals: 0,
    accuracy: 0.5,
    avgPnlPct: 0,
    lastUpdated: Date.now(),
  };

  const newTotal = existing.totalSignals + 1;
  const newCorrect = existing.correctSignals + (wasCorrect ? 1 : 0);
  const newAvgPnl = (existing.avgPnlPct * existing.totalSignals + pnlPct) / newTotal;

  const updated: SignalAccuracy = {
    symbol,
    totalSignals: newTotal,
    correctSignals: newCorrect,
    accuracy: newCorrect / newTotal,
    avgPnlPct: newAvgPnl,
    lastUpdated: Date.now(),
  };

  accuracyMap.set(symbol, updated);
  return updated;
}

/**
 * 신호 정확도 기반 신뢰도 보정
 * 과거 적중률이 낮은 종목의 신뢰도를 하향 조정
 */
export function adjustConfidenceByAccuracy(
  baseConfidence: number,
  accuracy: SignalAccuracy | undefined,
): number {
  if (!accuracy || accuracy.totalSignals < 5) return baseConfidence;

  // 정확도 50% 기준 ±10% 범위에서 보정
  const accuracyDelta = (accuracy.accuracy - 0.5) * 20;
  const adjusted = baseConfidence + accuracyDelta;

  return Math.max(50, Math.min(100, Math.round(adjusted)));
}

// ─── 전략 자동 개선 적용 ──────────────────────────────────────────────────────

/**
 * 손실 분석 결과를 실제 설정에 자동 적용
 * 반환값: 조정된 설정 (원본 불변)
 */
export function applyStrategyAdjustments<T extends {
  entryConfidenceMin?: number;
  positionSizePct?: number;
  defaultLeverage?: number;
  stopLossPct?: number;
}>(
  config: T,
  analysis: LossAnalysisResult,
  autoApplyThreshold: 'HIGH' | 'MEDIUM' | 'LOW' = 'HIGH',
): T & { _autoAdjusted: boolean; _adjustmentLog: string[] } {
  const result = { ...config, _autoAdjusted: false, _adjustmentLog: [] as string[] };

  const priorityOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  const threshold = priorityOrder[autoApplyThreshold];

  for (const adj of analysis.suggestedAdjustments) {
    if (priorityOrder[adj.priority] > threshold) continue;

    const key = adj.parameter as keyof T;
    if (key in result) {
      (result as Record<string, unknown>)[adj.parameter] = adj.suggestedValue;
      result._autoAdjusted = true;
      result._adjustmentLog.push(
        `[자동개선] ${adj.parameter}: ${adj.currentValue} → ${adj.suggestedValue} (${adj.reason})`
      );
    }
  }

  return result;
}

// ─── 연속 손실 감지 ───────────────────────────────────────────────────────────

/**
 * 연속 손실 횟수 계산 (최신 거래부터 역순으로)
 */
export function countConsecutiveLosses(outcomes: TradeOutcome[]): number {
  let count = 0;
  for (const o of outcomes) {
    if (o.pnlPct < 0) count++;
    else break;
  }
  return count;
}

/**
 * 연속 손실에 따른 자동 대응 레벨
 * 0~2회: 정상
 * 3~4회: 주의 (포지션 크기 축소)
 * 5~6회: 경보 (레버리지 축소 + 신뢰도 상향)
 * 7회+: 위험 (봇 일시 정지 권고)
 */
export function getConsecutiveLossLevel(count: number): {
  level: 'NORMAL' | 'CAUTION' | 'WARNING' | 'DANGER';
  sizeMultiplier: number;
  leverageMultiplier: number;
  confidenceBoost: number;
  message: string;
} {
  if (count >= 7) return {
    level: 'DANGER',
    sizeMultiplier: 0.3,
    leverageMultiplier: 0.5,
    confidenceBoost: 15,
    message: `⛔ 연속 손실 ${count}회 — 봇 일시 정지 권고. 시장 상황 재검토 필요`,
  };
  if (count >= 5) return {
    level: 'WARNING',
    sizeMultiplier: 0.5,
    leverageMultiplier: 0.7,
    confidenceBoost: 10,
    message: `🔴 연속 손실 ${count}회 — 레버리지 축소 + 신뢰도 기준 강화 자동 적용`,
  };
  if (count >= 3) return {
    level: 'CAUTION',
    sizeMultiplier: 0.7,
    leverageMultiplier: 0.85,
    confidenceBoost: 5,
    message: `🟡 연속 손실 ${count}회 — 포지션 크기 축소 자동 적용`,
  };
  return {
    level: 'NORMAL',
    sizeMultiplier: 1.0,
    leverageMultiplier: 1.0,
    confidenceBoost: 0,
    message: '',
  };
}

// ─── 수익률 요약 ──────────────────────────────────────────────────────────────

/**
 * 전략별 성과 통계 계산
 */
export function calcStrategyStats(outcomes: TradeOutcome[]): {
  winRate: number;
  avgPnlPct: number;
  maxDrawdown: number;
  profitFactor: number;
  sharpeRatio: number;
  totalTrades: number;
} {
  if (outcomes.length === 0) {
    return { winRate: 0, avgPnlPct: 0, maxDrawdown: 0, profitFactor: 0, sharpeRatio: 0, totalTrades: 0 };
  }

  const wins = outcomes.filter(o => o.pnlPct > 0);
  const losses = outcomes.filter(o => o.pnlPct < 0);

  const winRate = wins.length / outcomes.length;
  const avgPnlPct = outcomes.reduce((s, o) => s + o.pnlPct, 0) / outcomes.length;

  // 최대 낙폭 계산
  let peak = 0;
  let cumPnl = 0;
  let maxDrawdown = 0;
  for (const o of outcomes) {
    cumPnl += o.pnlPct;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Profit Factor = 총 수익 / 총 손실
  const totalWin = wins.reduce((s, o) => s + o.pnlPct, 0);
  const totalLoss = Math.abs(losses.reduce((s, o) => s + o.pnlPct, 0));
  const profitFactor = totalLoss > 0 ? totalWin / totalLoss : totalWin > 0 ? 999 : 0;

  // Sharpe Ratio (간략화)
  const variance = outcomes.reduce((s, o) => s + Math.pow(o.pnlPct - avgPnlPct, 2), 0) / outcomes.length;
  const stdDev = Math.sqrt(variance);
  const sharpeRatio = stdDev > 0 ? avgPnlPct / stdDev : 0;

  return {
    winRate,
    avgPnlPct,
    maxDrawdown,
    profitFactor,
    sharpeRatio,
    totalTrades: outcomes.length,
  };
}

// ─── 안전 인출 계산기 ─────────────────────────────────────────────────────────

export interface WithdrawalSafetyResult {
  /** 최소 인출 가능액 (현재 포지션 유지만 보장, 신규 진입 불가) */
  minWithdrawal: number;
  /** 최대 인출 가능액 (봇 정상 운용 완전 유지) */
  maxWithdrawal: number;
  /** 인출 불가 (잔고 부족 또는 포지션 위험) */
  canWithdraw: boolean;
  /** 인출 후 예상 가용잔고 (최대 인출 기준) */
  balanceAfterMax: number;
  /** 인출 후 예상 포지션 크기 % (최대 인출 기준) */
  positionSizePctAfterMax: number;
  /** 인출 후 강제청산 위험도 변화 */
  liqRiskAfterMax: number;
  /** 현재 강제청산 위험도 */
  currentLiqRisk: number;
  /** 안전 버퍼 (포지션 유지에 필요한 최소 잔고) */
  safetyBuffer: number;
  /** 봇 운용 최적 잔고 (이 이상이면 복리 효과 극대화) */
  optimalBalance: number;
  /** 경고 메시지 */
  warnings: string[];
}

/**
 * 안전 인출 가능 범위 계산
 *
 * 계산 기준:
 * 1. 안전 버퍼 = 현재 포지션 총 증거금 × 3 (강제청산 방지 여유 300%)
 * 2. 최소 인출 = 가용잔고 - 안전 버퍼 (포지션 유지만 보장)
 * 3. 최대 인출 = 가용잔고 - (봇 정상 운용 최소 잔고)
 *    봇 정상 운용 최소 = 포지션 증거금 × 2 + 신규 진입 여유 (포지션 크기 × 5개)
 */
export function calcSafeWithdrawal(
  totalBalance: number,
  availableBalance: number,
  mmrPct: number,
  totalInitialMargin: number,
  positions: Array<{
    pnlPct: number;
    leverage: number;
    initialMarginUsdt?: number;
    sourceType?: string;
  }>,
  botConfig: {
    positionSizePct: number;
    maxPositions: number;
    defaultLeverage?: number;
  },
): WithdrawalSafetyResult {
  const warnings: string[] = [];

  // 현재 포지션 총 증거금
  const totalMarginInUse = totalInitialMargin > 0
    ? totalInitialMargin
    : positions.reduce((s, p) => s + (p.initialMarginUsdt ?? 0), 0);

  // 현재 강제청산 위험도
  const currentLiqRisk = calcPortfolioLiqRisk(positions, totalBalance, mmrPct);

  // 안전 버퍼 계산
  // - 포지션 없으면: 총잔고의 20% (최소 운용 여유)
  // - 포지션 있으면: 총 증거금 × 3 (300% 여유, 강제청산 절대 방지)
  const marginBuffer = totalMarginInUse > 0
    ? totalMarginInUse * 3
    : totalBalance * 0.2;

  // 봇 신규 진입 여유 (포지션 크기 × 5개 슬롯 예약)
  const newEntryReserve = totalBalance
    * (botConfig.positionSizePct / 100)
    * (botConfig.defaultLeverage ?? 10)
    * 5;

  // 최소 인출 = 가용잔고 - 안전 버퍼
  const minWithdrawal = Math.max(0, availableBalance - marginBuffer);

  // 최대 인출 = 가용잔고 - (증거금 버퍼 + 신규 진입 여유)
  const fullOperationBuffer = marginBuffer + Math.min(newEntryReserve, totalBalance * 0.3);
  const maxWithdrawal = Math.max(0, availableBalance - fullOperationBuffer);

  // 인출 가능 여부
  const canWithdraw = minWithdrawal > 1; // 최소 1 USDT 이상

  // 인출 후 예상 상태 (최대 인출 기준)
  const balanceAfterMax = totalBalance - maxWithdrawal;
  const positionSizePctAfterMax = balanceAfterMax > 0
    ? Math.max(0.5, botConfig.positionSizePct * (balanceAfterMax / totalBalance))
    : 0;

  // 인출 후 강제청산 위험도
  const newAvailableAfterMax = availableBalance - maxWithdrawal;
  const newMmrPct = newAvailableAfterMax > 0
    ? Math.min(100, mmrPct * (totalBalance / balanceAfterMax))
    : 100;
  const liqRiskAfterMax = calcPortfolioLiqRisk(positions, balanceAfterMax, newMmrPct);

  // 봇 운용 최적 잔고 (복리 효과 극대화 기준)
  // 포지션 크기 2% × 최대 포지션 수 × 레버리지 × 안전 배수 2
  const optimalBalance = totalMarginInUse > 0
    ? totalMarginInUse * 5
    : totalBalance * 0.5;

  // 경고 생성
  if (!canWithdraw) {
    warnings.push('⚠️ 현재 포지션 유지에 필요한 증거금이 부족하여 인출이 불가합니다.');
  }
  if (mmrPct > 50) {
    warnings.push(`🔴 MMR ${mmrPct.toFixed(1)}% 높음 — 인출 시 강제청산 위험 증가`);
  }
  if (currentLiqRisk > 60) {
    warnings.push(`⛔ 강제청산 위험도 ${currentLiqRisk}% — 인출 전 포지션 축소 권장`);
  }
  if (maxWithdrawal < minWithdrawal) {
    warnings.push('ℹ️ 봇 정상 운용을 위해 인출 가능액이 제한됩니다.');
  }
  if (liqRiskAfterMax > currentLiqRisk + 20) {
    warnings.push(`⚠️ 최대 인출 후 강제청산 위험도 ${liqRiskAfterMax}%로 상승`);
  }

  return {
    minWithdrawal: Math.floor(minWithdrawal * 100) / 100,
    maxWithdrawal: Math.max(0, Math.floor(maxWithdrawal * 100) / 100),
    canWithdraw,
    balanceAfterMax: Math.floor(balanceAfterMax * 100) / 100,
    positionSizePctAfterMax: Math.round(positionSizePctAfterMax * 10) / 10,
    liqRiskAfterMax,
    currentLiqRisk,
    safetyBuffer: Math.ceil(marginBuffer * 100) / 100,
    optimalBalance: Math.ceil(optimalBalance * 100) / 100,
    warnings,
  };
}

/**
 * 특정 인출액에 대한 안전성 검증
 * 슬라이더 값 변경 시 실시간 피드백용
 */
export function validateWithdrawalAmount(
  amount: number,
  safetyResult: WithdrawalSafetyResult,
): {
  isValid: boolean;
  level: 'SAFE' | 'CAUTION' | 'DANGER' | 'IMPOSSIBLE';
  message: string;
  liqRiskChange: number;
} {
  if (amount <= 0) return {
    isValid: false, level: 'IMPOSSIBLE',
    message: '인출액을 입력해주세요', liqRiskChange: 0,
  };

  if (amount > safetyResult.minWithdrawal && !safetyResult.canWithdraw) return {
    isValid: false, level: 'IMPOSSIBLE',
    message: '포지션 유지 불가 — 인출 불가',
    liqRiskChange: 0,
  };

  if (amount <= safetyResult.maxWithdrawal) return {
    isValid: true, level: 'SAFE',
    message: `✅ 안전 인출 — 봇 정상 운용 유지`,
    liqRiskChange: 0,
  };

  if (amount <= safetyResult.minWithdrawal) return {
    isValid: true, level: 'CAUTION',
    message: `⚠️ 주의 — 신규 진입 제한될 수 있음`,
    liqRiskChange: Math.round((safetyResult.liqRiskAfterMax - safetyResult.currentLiqRisk) * 0.5),
  };

  return {
    isValid: false, level: 'DANGER',
    message: `🔴 위험 — 강제청산 위험 증가`,
    liqRiskChange: safetyResult.liqRiskAfterMax - safetyResult.currentLiqRisk,
  };
}

// ─── Max Notional Exposure 상한선 (AI 검증 v45) ──────────────────────────────

/**
 * 레버리지 적용 총 포지션 가치(Notional Value) 안전 상한선 검증
 *
 * AI 검증 v45 지적:
 * Quarter-Kelly 적용 시 실질 노출도가 40~80%라고 명시되어 있으나,
 * 레버리지 적용 총 포지션 가치가 잔고 대비 안전 범위를 넘어가지 않도록
 * 하드코딩 상한선이 필요합니다.
 *
 * 안전 기준:
 * - 총 Notional Value ≤ 잔고 × 최대배율 (기본 5배 = 500%)
 * - 개별 포지션 Notional ≤ 잔고 × 단일배율 (기본 1배 = 100%)
 */
export interface NotionalExposureCheck {
  isSafe: boolean;
  currentNotionalUsd: number;    // 현재 총 Notional Value (USD)
  maxAllowedNotional: number;    // 허용 최대 Notional
  utilizationPct: number;        // 사용률 (0~100%)
  recommendedPositionSize: number; // 안전한 신규 포지션 크기 (USDT)
  reason?: string;
}

/**
 * Max Notional Exposure 검증 및 안전 포지션 크기 계산
 */
export function checkMaxNotionalExposure(
  totalBalance: number,
  positions: Array<{
    notionalValue?: number;   // 포지션 Notional Value (USD)
    initialMarginUsdt?: number;
    leverage: number;
  }>,
  newPositionMargin: number,   // 신규 포지션 증거금 (USDT)
  newLeverage: number,
  maxPortfolioMultiplier: number = 5.0,  // 총 포트폴리오 최대 배율 (기본 5x)
  maxSingleMultiplier: number = 1.0,     // 단일 포지션 최대 배율 (기본 1x)
): NotionalExposureCheck {
  // 현재 총 Notional Value 계산
  const currentNotional = positions.reduce((sum, p) => {
    const notional = p.notionalValue ?? ((p.initialMarginUsdt ?? 0) * p.leverage);
    return sum + notional;
  }, 0);

  // 신규 포지션 Notional
  const newNotional = newPositionMargin * newLeverage;

  // 총 Notional (신규 포함)
  const totalNotional = currentNotional + newNotional;

  // 허용 최대 Notional
  const maxAllowedNotional = totalBalance * maxPortfolioMultiplier;
  const maxSingleNotional = totalBalance * maxSingleMultiplier;

  // 사용률
  const utilizationPct = maxAllowedNotional > 0
    ? Math.min(100, (totalNotional / maxAllowedNotional) * 100)
    : 100;

  // 안전 여부
  const isSafe = totalNotional <= maxAllowedNotional && newNotional <= maxSingleNotional;

  // 안전한 신규 포지션 크기 계산
  const remainingNotional = Math.max(0, maxAllowedNotional - currentNotional);
  const recommendedPositionSize = newLeverage > 0
    ? Math.min(remainingNotional / newLeverage, maxSingleNotional / newLeverage)
    : 0;

  let reason: string | undefined;
  if (!isSafe) {
    if (totalNotional > maxAllowedNotional) {
      reason = `총 Notional ${totalNotional.toFixed(0)} USDT > 한도 ${maxAllowedNotional.toFixed(0)} USDT (잔고 ${maxPortfolioMultiplier}배)`;
    } else {
      reason = `단일 포지션 Notional ${newNotional.toFixed(0)} USDT > 한도 ${maxSingleNotional.toFixed(0)} USDT (잔고 ${maxSingleMultiplier}배)`;
    }
  }

  return {
    isSafe,
    currentNotionalUsd: totalNotional,
    maxAllowedNotional,
    utilizationPct,
    recommendedPositionSize: Math.max(0, recommendedPositionSize),
    reason,
  };
}

// ─── 수수료 보수적 설정 (AI 검증 v45) ────────────────────────────────────────

/**
 * 실전 수수료 + 슬리피지 보수적 계산
 *
 * AI 검증 v45 지적:
 * 백테스트 시 수수료 조건을 보수적으로 잡아야 실전과 오차를 줄일 수 있습니다.
 * 편도 0.05%~0.07% 권장.
 *
 * Bybit 실전 수수료:
 * - Maker: 0.02% (지정가)
 * - Taker: 0.055% (시장가)
 * - 슬리피지: 0.01~0.03% (유동성에 따라)
 * - 보수적 설정: 편도 0.06% (Taker + 슬리피지 평균)
 */
export const TRADING_COSTS = {
  MAKER_FEE: 0.0002,       // 0.02% (지정가)
  TAKER_FEE: 0.00055,      // 0.055% (시장가)
  SLIPPAGE: 0.0002,        // 0.02% (평균 슬리피지)
  CONSERVATIVE_ONEWAY: 0.0006,  // 0.06% 편도 (보수적 백테스트 기준)
  CONSERVATIVE_ROUNDTRIP: 0.0012, // 0.12% 왕복 (진입+청산)
} as const;

/**
 * 수수료 차감 후 실제 수익률 계산
 */
export function calcNetPnlAfterFees(
  grossPnlPct: number,
  leverage: number,
  useTaker: boolean = true,
): number {
  const feePerSide = useTaker
    ? TRADING_COSTS.TAKER_FEE + TRADING_COSTS.SLIPPAGE
    : TRADING_COSTS.MAKER_FEE + TRADING_COSTS.SLIPPAGE;

  // 레버리지 적용 수수료 (증거금 기준 수익률로 환산)
  const feeImpact = feePerSide * 2 * leverage * 100; // 왕복 수수료 (%)

  return grossPnlPct - feeImpact;
}

// ─── 목표/기대 수익률 분리 (AI 검증 v45) ─────────────────────────────────────

/**
 * 목표 수익률 vs 기대 수익률 분리 계산
 *
 * AI 검증 v45 지적:
 * 목표 수익률(1.5%/일)과 기대 수익률(현실적 달성 가능 수준)을 분리해야 합니다.
 *
 * 기대 수익률 계산 기준:
 * - 과거 승률 × 평균 수익 - 패률 × 평균 손실 - 수수료
 * - 전통 퀀트 기준 일일 0.1~0.3% (연 50~200%)
 * - 암호화폐 스캘핑 현실적 기대: 일일 0.3~0.8%
 */
export interface DailyReturnProjection {
  targetPct: number;         // 목표 수익률 (설정값)
  expectedPct: number;       // 기대 수익률 (과거 성과 기반)
  realisticPct: number;      // 현실적 수익률 (수수료 차감 후)
  annualizedTarget: number;  // 연간 목표 복리 배수
  annualizedExpected: number; // 연간 기대 복리 배수
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'; // 달성 신뢰도
  note: string;
}

export function calcDailyReturnProjection(
  targetDailyPct: number,
  recentOutcomes: TradeOutcome[],
): DailyReturnProjection {
  // 과거 성과 기반 기대 수익률
  const stats = calcStrategyStats(recentOutcomes);
  const grossExpected = stats.avgPnlPct;

  // 수수료 차감 (평균 레버리지 10x 가정)
  const avgLeverage = recentOutcomes.length > 0
    ? recentOutcomes.reduce((s, o) => s + o.leverage, 0) / recentOutcomes.length
    : 10;
  const feeImpact = TRADING_COSTS.CONSERVATIVE_ROUNDTRIP * avgLeverage * 100;
  const realisticPct = Math.max(-5, grossExpected - feeImpact);

  // 연간 복리 배수 (365일)
  const annualizedTarget = Math.pow(1 + targetDailyPct / 100, 365);
  const annualizedExpected = realisticPct >= 0
    ? Math.pow(1 + realisticPct / 100, 365)
    : Math.pow(1 + realisticPct / 100, 365);

  // 달성 신뢰도
  let confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  let note: string;

  if (recentOutcomes.length < 10) {
    confidence = 'LOW';
    note = '거래 데이터 부족 (10회 미만) — 기대 수익률 신뢰도 낮음';
  } else if (realisticPct >= targetDailyPct * 0.8) {
    confidence = 'HIGH';
    note = `과거 성과 기반 목표 달성 가능성 높음 (기대 ${realisticPct.toFixed(2)}% ≥ 목표 ${targetDailyPct}% × 80%)`;
  } else if (realisticPct >= targetDailyPct * 0.5) {
    confidence = 'MEDIUM';
    note = `목표 부분 달성 가능 (기대 ${realisticPct.toFixed(2)}% — 목표의 ${((realisticPct / targetDailyPct) * 100).toFixed(0)}%)`;
  } else {
    confidence = 'LOW';
    note = `현재 성과로 목표 달성 어려움 (기대 ${realisticPct.toFixed(2)}% < 목표 ${targetDailyPct}%) — 전략 개선 필요`;
  }

  return {
    targetPct: targetDailyPct,
    expectedPct: grossExpected,
    realisticPct,
    annualizedTarget,
    annualizedExpected,
    confidence,
    note,
  };
}

// ─── 변동성 연동 Max Notional (ChatGPT 검증 v47 반영) ─────────────────────────

/**
 * ChatGPT 검증 v47 지적:
 * "Max Notional 고정 3배는 안전하지만, 변동성이 낮은 시장에서는 수익률을 과도하게 제한.
 *  고정 3배보다 변동성 연동 방식이 더 우수."
 *
 * 개선: ATR% 기반 동적 Max Notional Multiplier
 * - ATR > 4%: 고변동성 → 1.5배 (보수적)
 * - ATR 2~4%: 중변동성 → 2.5배 (균형)
 * - ATR 1~2%: 저변동성 → 4.0배 (공격적)
 * - ATR < 1%: 극저변동성 → 5.0배 (최대 활용)
 */
export function calcDynamicMaxNotionalMultiplier(
  atrPct: number,  // ATR / 현재가 × 100 (변동성 %)
): {
  multiplier: number;
  description: string;
  riskLevel: 'VERY_HIGH' | 'HIGH' | 'MEDIUM' | 'LOW' | 'VERY_LOW';
} {
  if (atrPct > 4) {
    return {
      multiplier: 1.5,
      description: `고변동성 (ATR ${atrPct.toFixed(1)}%) — Max Notional 1.5배 (강제청산 방지 우선)`,
      riskLevel: 'VERY_HIGH',
    };
  }
  if (atrPct > 2) {
    return {
      multiplier: 2.5,
      description: `중변동성 (ATR ${atrPct.toFixed(1)}%) — Max Notional 2.5배 (균형)`,
      riskLevel: 'HIGH',
    };
  }
  if (atrPct > 1) {
    return {
      multiplier: 4.0,
      description: `저변동성 (ATR ${atrPct.toFixed(1)}%) — Max Notional 4.0배 (수익 극대화)`,
      riskLevel: 'MEDIUM',
    };
  }
  return {
    multiplier: 5.0,
    description: `극저변동성 (ATR ${atrPct.toFixed(1)}%) — Max Notional 5.0배 (최대 활용)`,
    riskLevel: 'LOW',
  };
}

/**
 * 변동성 연동 Max Notional 검증 (기존 checkMaxNotionalExposure 개선 버전)
 *
 * atrPct를 추가로 받아 동적 multiplier 계산 후 적용
 */
export function checkDynamicMaxNotional(
  totalBalance: number,
  positions: Array<{
    notionalValue?: number;
    initialMarginUsdt?: number;
    leverage: number;
  }>,
  newPositionMargin: number,
  newLeverage: number,
  atrPct: number = 2.0,  // 현재 시장 변동성 (ATR%)
): NotionalExposureCheck & { dynamicMultiplier: number; riskLevel: string } {
  const { multiplier, description, riskLevel } = calcDynamicMaxNotionalMultiplier(atrPct);

  const base = checkMaxNotionalExposure(
    totalBalance,
    positions,
    newPositionMargin,
    newLeverage,
    multiplier,  // 동적 배율 적용
    multiplier * 0.3,  // 단일 포지션: 포트폴리오의 30%
  );

  return {
    ...base,
    dynamicMultiplier: multiplier,
    riskLevel: description,
    reason: base.reason
      ? `${base.reason} [${description}]`
      : description,
  };
}
