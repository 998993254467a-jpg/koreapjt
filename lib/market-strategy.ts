/**
 * market-strategy.ts
 * 4가지 전략 조합 엔진:
 * A. 시간대별 전략 전환 (Time-based Strategy Switching)
 * B. 손익비 최적화 (R:R Dynamic Optimization)
 * C. 변동성 조절 (Volatility Scaling)
 * D. 모멘텀 스코어 진입 필터 (Momentum Score Filter)
 */

// ─── A. 시간대별 세션 판별 ─────────────────────────────────────────────────────

export type MarketSession =
  | 'asia'        // 09:00~13:00 KST — 아시아 개장, 중간 변동성
  | 'europe_prep' // 14:00~21:00 KST — 유럽 개장 준비, 변동성 증가
  | 'us_open'     // 22:00~02:00 KST — 미국 개장, 최대 변동성
  | 'low_liq';    // 03:00~08:00 KST — 저유동성, 신규 진입 중단

export interface SessionParams {
  session: MarketSession;
  label: string;
  allowNewEntry: boolean;       // 신규 진입 허용 여부
  confidenceBonus: number;      // 신뢰도 기준 보정 (양수 = 기준 상향)
  positionSizeMultiplier: number; // 포지션 크기 배율 (1.0 = 기본)
  surgeBoost: boolean;          // 급등봇 강화 여부
}

const SESSION_TABLE: Record<MarketSession, SessionParams> = {
  asia: {
    session: 'asia',
    label: '🌏 아시아 세션',
    allowNewEntry: true,
    confidenceBonus: 2,       // 신뢰도 기준 +2% (82%+)
    positionSizeMultiplier: 1.0,
    surgeBoost: false,
  },
  europe_prep: {
    session: 'europe_prep',
    label: '🌍 유럽 준비 세션',
    allowNewEntry: true,
    confidenceBonus: 0,       // 신뢰도 기준 기본 (80%+)
    positionSizeMultiplier: 1.1,
    surgeBoost: true,
  },
  us_open: {
    session: 'us_open',
    label: '🌎 미국 세션',
    allowNewEntry: true,
    confidenceBonus: -2,      // 신뢰도 기준 -2% (78%+, 더 적극적 진입)
    positionSizeMultiplier: 1.5, // 포지션 크기 1.5배
    surgeBoost: true,
  },
  low_liq: {
    session: 'low_liq',
    label: '😴 저유동성 구간',
    allowNewEntry: false,     // 신규 진입 전면 차단
    confidenceBonus: 10,      // 사실상 진입 불가 수준
    positionSizeMultiplier: 0.5,
    surgeBoost: false,
  },
};

/**
 * 현재 KST 시간 기준으로 시장 세션을 반환합니다.
 */
export function getMarketSession(): SessionParams {
  // UTC+9 (KST)
  const now = new Date();
  const kstHour = (now.getUTCHours() + 9) % 24;

  if (kstHour >= 3 && kstHour < 9) {
    return SESSION_TABLE.low_liq;
  } else if (kstHour >= 9 && kstHour < 14) {
    return SESSION_TABLE.asia;
  } else if (kstHour >= 14 && kstHour < 22) {
    return SESSION_TABLE.europe_prep;
  } else {
    // 22:00~02:59 KST
    return SESSION_TABLE.us_open;
  }
}

// ─── C. 변동성 조절 ────────────────────────────────────────────────────────────

export type VolatilityLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';

export interface VolatilityParams {
  level: VolatilityLevel;
  label: string;
  leverageMultiplier: number;      // 레버리지 배율
  positionSizeMultiplier: number;  // 포지션 크기 배율
  trailingWidthMultiplier: number; // 트레일링 스탑 폭 배율
  slMultiplier: number;            // 손절 기준 배율
}

const VOLATILITY_TABLE: Record<VolatilityLevel, VolatilityParams> = {
  LOW: {
    level: 'LOW',
    label: '🟢 저변동성',
    leverageMultiplier: 1.2,       // 레버리지 +20%
    positionSizeMultiplier: 1.2,   // 포지션 크기 +20%
    trailingWidthMultiplier: 0.8,  // 트레일링 폭 축소 (더 빠른 청산)
    slMultiplier: 0.8,             // 손절 기준 축소
  },
  MEDIUM: {
    level: 'MEDIUM',
    label: '🟡 중변동성',
    leverageMultiplier: 1.0,
    positionSizeMultiplier: 1.0,
    trailingWidthMultiplier: 1.0,
    slMultiplier: 1.0,
  },
  HIGH: {
    level: 'HIGH',
    label: '🟠 고변동성',
    leverageMultiplier: 0.8,       // 레버리지 -20%
    positionSizeMultiplier: 0.8,   // 포지션 크기 -20%
    trailingWidthMultiplier: 1.3,  // 트레일링 폭 확대
    slMultiplier: 1.3,             // 손절 기준 확대
  },
  EXTREME: {
    level: 'EXTREME',
    label: '🔴 극단변동성',
    leverageMultiplier: 0.5,       // 레버리지 -50%
    positionSizeMultiplier: 0.5,   // 포지션 크기 -50%
    trailingWidthMultiplier: 1.8,
    slMultiplier: 1.8,
  },
};

/**
 * BTC 24시간 변동률(%)을 기반으로 변동성 레벨을 반환합니다.
 * @param btcChange24hPct BTC 24시간 변동률 (절대값 기준)
 */
export function getVolatilityLevel(btcChange24hPct: number): VolatilityParams {
  const abs = Math.abs(btcChange24hPct);
  if (abs < 2) return VOLATILITY_TABLE.LOW;
  if (abs < 5) return VOLATILITY_TABLE.MEDIUM;
  if (abs < 10) return VOLATILITY_TABLE.HIGH;
  return VOLATILITY_TABLE.EXTREME;
}

// ─── B. 손익비 최적화 ──────────────────────────────────────────────────────────

export type TrendStrength = 'STRONG' | 'MODERATE' | 'WEAK' | 'SURGE';

export interface RiskRewardParams {
  slPct: number;   // 손절 기준 (%)
  tpPct: number;   // 익절 기준 (%)
  rrRatio: number; // R:R 비율 (tpPct / slPct)
  label: string;
}

/**
 * 추세 강도와 섹션 타입에 따라 최적 손익비를 반환합니다.
 * @param trendStrength 추세 강도
 * @param isSurge 급등봇 여부
 * @param isPresurge 급등직전봇 여부
 */
export function calcRiskReward(
  trendStrength: TrendStrength,
  isSurge: boolean,
  isPresurge: boolean
): RiskRewardParams {
  if (isPresurge) {
    // 급등직전봇: 장기보유 — 넓은 손절, 큰 익절
    return { slPct: 20, tpPct: 60, rrRatio: 3.0, label: '장기보유 1:3' };
  }

  if (isSurge) {
    switch (trendStrength) {
      case 'SURGE':
        return { slPct: 12, tpPct: 45, rrRatio: 3.75, label: '급등 1:3.75' };
      case 'STRONG':
        return { slPct: 15, tpPct: 40, rrRatio: 2.67, label: '강추세 1:2.67' };
      case 'MODERATE':
        return { slPct: 15, tpPct: 30, rrRatio: 2.0, label: '중추세 1:2' };
      default:
        return { slPct: 15, tpPct: 20, rrRatio: 1.33, label: '약추세 1:1.33' };
    }
  }

  // 일반봇
  switch (trendStrength) {
    case 'STRONG':
      return { slPct: 15, tpPct: 45, rrRatio: 3.0, label: '강추세 1:3' };
    case 'MODERATE':
      return { slPct: 20, tpPct: 40, rrRatio: 2.0, label: '중추세 1:2' };
    case 'WEAK':
      return { slPct: 10, tpPct: 20, rrRatio: 2.0, label: '약추세 1:2' };
    default:
      return { slPct: 20, tpPct: 40, rrRatio: 2.0, label: '기본 1:2' };
  }
}

/**
 * 신뢰도와 변동성 기반으로 추세 강도를 판별합니다.
 */
export function detectTrendStrength(
  confidence: number,
  volatilityLevel: VolatilityLevel,
  isSurgeSignal: boolean
): TrendStrength {
  if (isSurgeSignal && confidence >= 88) return 'SURGE';
  if (confidence >= 90 && volatilityLevel !== 'EXTREME') return 'STRONG';
  if (confidence >= 82) return 'MODERATE';
  return 'WEAK';
}

// ─── D. 모멘텀 스코어 ──────────────────────────────────────────────────────────

export interface MomentumInput {
  // 가격 모멘텀 (30점)
  priceChange5mPct: number;   // 5분 변동률
  priceChange15mPct: number;  // 15분 변동률
  priceChange1hPct: number;   // 1시간 변동률

  // 거래량 (25점)
  volumeRatio: number;        // 현재 거래량 / 평균 거래량 (1.0 = 평균)

  // OI 미결제약정 (20점)
  oiChangeRatio: number;      // OI 변화율 (1.0 = 변화 없음, 1.2 = 20% 증가)

  // 오더북 매수벽 (15점)
  bidAskRatio: number;        // 매수잔량 / 매도잔량 (1.0 = 균형)

  // 펀딩비 (10점)
  fundingRatePct: number;     // 펀딩비 (%) — 중립(0~0.01%)이 유리
}

export interface MomentumScore {
  total: number;              // 총점 (0~100)
  priceScore: number;         // 가격 모멘텀 점수 (0~30)
  volumeScore: number;        // 거래량 점수 (0~25)
  oiScore: number;            // OI 점수 (0~20)
  orderBookScore: number;     // 오더북 점수 (0~15)
  fundingScore: number;       // 펀딩비 점수 (0~10)
  grade: 'S' | 'A' | 'B' | 'C' | 'D'; // 등급
}

/**
 * 5개 지표를 합산하여 모멘텀 스코어(0~100)를 계산합니다.
 * 80점 이상만 진입 허용.
 */
export function calcMomentumScore(input: MomentumInput): MomentumScore {
  // 가격 모멘텀 (30점)
  // 5분/15분/1시간 모두 같은 방향이면 만점
  const allUp = input.priceChange5mPct > 0 && input.priceChange15mPct > 0 && input.priceChange1hPct > 0;
  const allDown = input.priceChange5mPct < 0 && input.priceChange15mPct < 0 && input.priceChange1hPct < 0;
  const priceConsistency = allUp || allDown ? 1.0 : 0.5;
  const avgAbsChange = (Math.abs(input.priceChange5mPct) + Math.abs(input.priceChange15mPct) + Math.abs(input.priceChange1hPct)) / 3;
  const priceScore = Math.min(30, priceConsistency * Math.min(30, avgAbsChange * 6));

  // 거래량 (25점)
  // 2배 이상 = 만점, 1배 = 0점
  const volumeScore = Math.min(25, Math.max(0, (input.volumeRatio - 1.0) * 25));

  // OI (20점)
  // 10% 증가 이상 = 만점
  const oiScore = Math.min(20, Math.max(0, (input.oiChangeRatio - 1.0) * 200));

  // 오더북 매수벽 (15점)
  // 매수잔량이 매도잔량의 1.5배 이상 = 만점
  const orderBookScore = Math.min(15, Math.max(0, (input.bidAskRatio - 1.0) * 30));

  // 펀딩비 (10점)
  // 중립(0~0.01%) = 만점, 극단적 양수(0.05%+) = 0점 (과열)
  const absFunding = Math.abs(input.fundingRatePct);
  const fundingScore = absFunding <= 0.01
    ? 10
    : absFunding <= 0.03
    ? 7
    : absFunding <= 0.05
    ? 3
    : 0;

  const total = Math.round(priceScore + volumeScore + oiScore + orderBookScore + fundingScore);

  const grade: MomentumScore['grade'] =
    total >= 90 ? 'S' :
    total >= 80 ? 'A' :
    total >= 70 ? 'B' :
    total >= 60 ? 'C' : 'D';

  return {
    total,
    priceScore: Math.round(priceScore),
    volumeScore: Math.round(volumeScore),
    oiScore: Math.round(oiScore),
    orderBookScore: Math.round(orderBookScore),
    fundingScore,
    grade,
  };
}

/**
 * 신호 데이터에서 모멘텀 입력값을 추출합니다.
 * scalping-engine의 ScalpingSignal과 호환.
 */
export function extractMomentumInput(signal: {
  change?: number;
  change1h?: number;
  volumeRatio?: number;
  oiChangeRatio?: number;
  bidAskRatio?: number;
  fundingRate?: number;
}): MomentumInput {
  return {
    priceChange5mPct: signal.change ?? 0,
    priceChange15mPct: (signal.change ?? 0) * 0.8, // 15분 근사값
    priceChange1hPct: signal.change1h ?? 0,
    volumeRatio: signal.volumeRatio ?? 1.0,
    oiChangeRatio: signal.oiChangeRatio ?? 1.0,
    bidAskRatio: signal.bidAskRatio ?? 1.0,
    fundingRatePct: signal.fundingRate ?? 0,
  };
}

// ─── 통합 전략 컨텍스트 ────────────────────────────────────────────────────────

export interface StrategyContext {
  session: SessionParams;
  volatility: VolatilityParams;
  btcChange24h: number;

  // 최종 조정된 파라미터
  effectiveConfidenceMin: number;  // 최종 신뢰도 기준
  effectivePosMultiplier: number;  // 최종 포지션 크기 배율
  effectiveLevMultiplier: number;  // 최종 레버리지 배율
  allowNewEntry: boolean;          // 신규 진입 허용 여부
  sessionLabel: string;
  volatilityLabel: string;
}

/**
 * 시간대 + 변동성을 조합하여 최종 전략 컨텍스트를 반환합니다.
 * @param btcChange24hPct BTC 24시간 변동률
 * @param baseConfidenceMin 기본 신뢰도 기준 (기본 80)
 */
export function buildStrategyContext(
  btcChange24hPct: number,
  baseConfidenceMin = 80
): StrategyContext {
  const session = getMarketSession();
  const volatility = getVolatilityLevel(btcChange24hPct);

  // 신뢰도 기준: 기본값 + 세션 보정
  const effectiveConfidenceMin = Math.max(75, Math.min(92,
    baseConfidenceMin + session.confidenceBonus
  ));

  // 포지션 크기 배율: 세션 × 변동성
  const effectivePosMultiplier = Math.max(0.3, Math.min(2.0,
    session.positionSizeMultiplier * volatility.positionSizeMultiplier
  ));

  // 레버리지 배율: 변동성만 적용 (세션은 크기로 조절)
  const effectiveLevMultiplier = Math.max(0.3, Math.min(1.5,
    volatility.leverageMultiplier
  ));

  return {
    session,
    volatility,
    btcChange24h: btcChange24hPct,
    effectiveConfidenceMin,
    effectivePosMultiplier,
    effectiveLevMultiplier,
    allowNewEntry: session.allowNewEntry && volatility.level !== 'EXTREME',
    sessionLabel: session.label,
    volatilityLabel: volatility.label,
  };
}
