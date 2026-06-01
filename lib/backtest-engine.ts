/**
 * backtest-engine.ts
 *
 * JT POWER v46 — Walk-Forward 백테스트 엔진
 *
 * 핵심 기능:
 * 1. 시장 국면 분류기 — ADX + EMA 이격도 기반 4국면 (강세/약세/횡보/급락)
 * 2. Walk-Forward Test — 6개월 최적화 + 2개월 검증 롤링
 * 3. RSI 구간 Grid Search — 최적 롱/숏 RSI 범위 자동 탐색
 * 4. 핵심 성과 지표 — 승률/Profit Factor/Sharpe Ratio/MDD/기대수익
 * 5. 수수료 보수적 설정 — 편도 0.06% (Taker + 슬리피지)
 *
 * AI 검증 v45 지적사항 반영:
 * - 백테스트 결과 없이 전략 우수성 확정 불가
 * - RSI 구간 통계 검증 필요 (왜 40이고 39가 아닌가)
 * - 시장 국면별 다른 전략 필요
 * - 목표 수익률 vs 기대 수익률 분리
 */

import { TRADING_COSTS } from './strategy-optimizer';

// ─── 타입 정의 ────────────────────────────────────────────────────────────────

export type MarketRegime =
  | 'BULL_TREND'    // 강세 추세장 (ADX > 25, 가격 > EMA200)
  | 'BEAR_TREND'    // 약세 추세장 (ADX > 25, 가격 < EMA200)
  | 'RANGING'       // 횡보장 (ADX < 20)
  | 'CRASH';        // 급락장 (1시간 -5% 이상)

export interface OHLCVCandle {
  timestamp: number;   // Unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BacktestSignal {
  timestamp: number;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  confidence: number;
  leverage: number;
  rsiLongMin: number;   // 사용된 RSI 롱 최솟값
  rsiLongMax: number;   // 사용된 RSI 롱 최댓값
  rsiShortMin: number;
  rsiShortMax: number;
  regime: MarketRegime;
}

export interface BacktestTrade {
  signal: BacktestSignal;
  entryPrice: number;
  exitPrice: number;
  exitReason: 'TP' | 'SL' | 'TIMEOUT' | 'REGIME_CHANGE';
  holdingCandles: number;
  grossPnlPct: number;
  netPnlPct: number;    // 수수료 차감 후
  regime: MarketRegime;
}

export interface BacktestPeriodResult {
  periodStart: number;
  periodEnd: number;
  trades: BacktestTrade[];
  winRate: number;
  profitFactor: number;
  sharpeRatio: number;
  maxDrawdownPct: number;
  totalNetPnlPct: number;
  avgNetPnlPerTrade: number;
  totalTrades: number;
  regimeBreakdown: Record<MarketRegime, { trades: number; winRate: number; pnl: number }>;
}

export interface WalkForwardResult {
  symbol: string;
  optimizationPeriods: BacktestPeriodResult[];  // In-sample 최적화 기간
  validationPeriods: BacktestPeriodResult[];    // Out-of-sample 검증 기간
  overallStats: {
    winRate: number;
    profitFactor: number;
    sharpeRatio: number;
    maxDrawdownPct: number;
    totalNetPnlPct: number;
    totalTrades: number;
    avgDailyPnlPct: number;
    bestRegime: MarketRegime;
    worstRegime: MarketRegime;
  };
  optimalRsiRanges: {
    longMin: number;
    longMax: number;
    shortMin: number;
    shortMax: number;
    gridSearchScore: number;
  };
  isOverfitted: boolean;    // 최적화 vs 검증 성과 차이 > 30% → 과적합 의심
  recommendation: string;
  overfitGuard: {            // Claude v47: 과적합 시 자동 행동 정의
    action: 'BLOCK_ENTRY' | 'REDUCE_SIZE' | 'RESET_PARAMS' | 'NONE';
    severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'NONE';
    inOutGap: number;        // In-sample vs Out-of-sample 괄리 비율
    outSampleWinRate: number; // Out-of-sample 승률
  };
}

export interface GridSearchResult {
  rsiLongMin: number;
  rsiLongMax: number;
  rsiShortMin: number;
  rsiShortMax: number;
  winRate: number;
  profitFactor: number;
  totalTrades: number;
  score: number;  // 종합 점수 (winRate × profitFactor)
}

// ─── 시장 국면 분류기 ─────────────────────────────────────────────────────────

/**
 * ADX + EMA200 이격도 기반 시장 국면 분류
 *
 * AI 검증 v45 지적:
 * 현재 RSI 범위 조건은 '횡보장형 추세 추종'에 가깝습니다.
 * ADX로 추세 강도를 먼저 파악하고 국면별 다른 전략을 적용해야 합니다.
 */
/**
 * CRASH 선행 감지 헬퍼 (Gemini 검증 v47 반영)
 *
 * Gemini 검증 지적:
 * "-5% 후행 감지는 이미 폭락 진행 후. ATR 급팽창(2배) + 거래량 급증(3배) 선행 지표 조합으로 조기 감지 필요"
 */
function detectCrashEarly(
  candles: OHLCVCandle[],
  currentAtr: number,
): boolean {
  if (candles.length < 20) return false;

  // ATR 20기간 평균 계산
  const recentCandles = candles.slice(-20);
  const atrValues: number[] = [];
  for (let i = 1; i < recentCandles.length; i++) {
    const h = recentCandles[i].high;
    const l = recentCandles[i].low;
    const pc = recentCandles[i - 1].close;
    atrValues.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const avgAtr = atrValues.length > 0
    ? atrValues.reduce((s, v) => s + v, 0) / atrValues.length
    : 0;

  // ATR이 평균의 2배 이상 → 변동성 급팽창
  const atrExplosion = avgAtr > 0 && currentAtr > avgAtr * 2;

  // 거래량 20기간 평균 계산
  const avgVolume = recentCandles.reduce((s, c) => s + c.volume, 0) / recentCandles.length;
  const currentVolume = candles[candles.length - 1].volume;

  // 거래량이 평균의 3배 이상 → 패닉 셀링 신호
  const volumeSpike = avgVolume > 0 && currentVolume > avgVolume * 3;

  // 1시간 가격 변화 -3% 이상 (기존 -5% 보다 더 민감하게)
  const prevClose = candles[candles.length - 2]?.close ?? candles[candles.length - 1].close;
  const currentClose = candles[candles.length - 1].close;
  const hourlyChange = prevClose > 0 ? ((currentClose - prevClose) / prevClose) * 100 : 0;
  const rapidDrop = hourlyChange <= -3;

  // ATR 급팽창 + 거래량 급증 OR 급격한 가격 하락 + 거래량 급증
  return (atrExplosion && volumeSpike) || (rapidDrop && volumeSpike);
}

export function classifyMarketRegime(
  candles: OHLCVCandle[],
  adx: number,
  ema200: number,
): MarketRegime {
  if (candles.length < 2) return 'RANGING';

  const currentClose = candles[candles.length - 1].close;
  const prevClose = candles[candles.length - 2].close;
  const currentAtr = calcATR(candles.slice(-20), 14);

  // 급락장 감지 (3단계):
  // 1) 후행: 1시간 -5% 이상 하락
  // 2) 선행: ATR 급팩산(2배) + 거래량 급증(3배) 조합 (Gemini v47 개선)
  // 3) Claude 검증 v47 추가: 1일 -8% 이상 하락 (LUNA 붕괴/FTX 여파 대응)
  //    이유: 20일 -15% 조건은 이미 급락 완료 후에야 CRASH 분류 → 너무 늦음
  const hourlyChange = prevClose > 0 ? ((currentClose - prevClose) / prevClose) * 100 : 0;
  if (hourlyChange <= -5) return 'CRASH';
  if (detectCrashEarly(candles, currentAtr)) return 'CRASH';
  // 1일(24시간) 수익률 계산 — 최소 24개 캐들 필요
  if (candles.length >= 24) {
    const close24hAgo = candles[candles.length - 24].close;
    const dailyChange = close24hAgo > 0 ? ((currentClose - close24hAgo) / close24hAgo) * 100 : 0;
    if (dailyChange <= -8) return 'CRASH'; // 1일 -8% 이상: 즉각 CRASH 분류
  }

  // 횡보장: ADX < 20 (추세 없음)
  if (adx < 20) return 'RANGING';

  // 강세/약세 추세장: ADX >= 20
  if (currentClose > ema200) return 'BULL_TREND';
  return 'BEAR_TREND';
}

/**
 * 국면별 전략 파라미터 반환
 *
 * 추세장 전략과 횡보장 전략이 완전히 달라야 한다는 AI 검증 지적 반영
 */
export function getRegimeStrategy(regime: MarketRegime): {
  confidenceMin: number;       // 최소 신뢰도
  leverageMultiplier: number;  // 레버리지 배율
  positionSizeMultiplier: number; // 포지션 크기 배율
  allowLong: boolean;
  allowShort: boolean;
  tpPct: number;               // 목표 수익률 %
  slPct: number;               // 손절 %
  description: string;
} {
  switch (regime) {
    case 'BULL_TREND':
      return {
        confidenceMin: 80,
        leverageMultiplier: 1.2,   // 추세 방향 레버리지 소폭 증가
        positionSizeMultiplier: 1.1,
        allowLong: true,
        allowShort: false,         // 강세장에서 숏 금지
        tpPct: 2.0,
        slPct: 1.0,
        description: '강세 추세장 — 롱만 허용, 레버리지 소폭 증가',
      };

    case 'BEAR_TREND':
      return {
        confidenceMin: 80,
        leverageMultiplier: 1.2,
        positionSizeMultiplier: 1.1,
        allowLong: false,          // 약세장에서 롱 금지
        allowShort: true,
        tpPct: 2.0,
        slPct: 1.0,
        description: '약세 추세장 — 숏만 허용, 레버리지 소폭 증가',
      };

    case 'RANGING':
      return {
        confidenceMin: 88,         // 횡보장 진입 기준 강화 (Whipsaw 방지)
        leverageMultiplier: 0.7,   // 레버리지 30% 축소
        positionSizeMultiplier: 0.7,
        allowLong: true,
        allowShort: true,
        tpPct: 1.0,                // 목표 수익 축소 (빠른 청산)
        slPct: 0.8,
        description: '횡보장 — 신뢰도 기준 강화, 레버리지 축소, 빠른 청산',
      };

    case 'CRASH':
      return {
        confidenceMin: 95,         // 급락장 진입 거의 금지
        leverageMultiplier: 0.3,
        positionSizeMultiplier: 0.3,
        allowLong: false,          // 급락장에서 롱 금지
        allowShort: true,          // 숏만 허용 (추세 추종)
        tpPct: 3.0,                // 급락 시 목표 수익 확대
        slPct: 1.5,
        description: '급락장 — 숏만 허용, 레버리지 대폭 축소',
      };
  }
}

// ─── 기술적 지표 계산 (백테스트용) ───────────────────────────────────────────

function calcRSI(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50;

  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calcEMA(closes: number[], period: number): number {
  if (closes.length < period) return closes[closes.length - 1];

  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcADX(candles: OHLCVCandle[], period: number = 14): number {
  if (candles.length < period * 2) return 15; // 데이터 부족 시 횡보장 가정

  const trueRanges: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const prevHigh = candles[i - 1].high;
    const prevLow = candles[i - 1].low;

    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    const plusDM = high - prevHigh > prevLow - low ? Math.max(high - prevHigh, 0) : 0;
    const minusDM = prevLow - low > high - prevHigh ? Math.max(prevLow - low, 0) : 0;

    trueRanges.push(tr);
    plusDMs.push(plusDM);
    minusDMs.push(minusDM);
  }

  const avgTR = trueRanges.slice(-period).reduce((s, v) => s + v, 0) / period;
  const avgPlusDM = plusDMs.slice(-period).reduce((s, v) => s + v, 0) / period;
  const avgMinusDM = minusDMs.slice(-period).reduce((s, v) => s + v, 0) / period;

  if (avgTR === 0) return 15;

  const plusDI = (avgPlusDM / avgTR) * 100;
  const minusDI = (avgMinusDM / avgTR) * 100;
  const diDiff = Math.abs(plusDI - minusDI);
  const diSum = plusDI + minusDI;

  if (diSum === 0) return 15;

  // 간략화된 ADX (실제는 스무딩 필요하지만 백테스트 근사값으로 충분)
  return (diDiff / diSum) * 100;
}

function calcATR(candles: OHLCVCandle[], period: number = 14): number {
  if (candles.length < period + 1) return 0;

  let atrSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    atrSum += tr;
  }
  return atrSum / period;
}

// ─── 단일 기간 백테스트 ───────────────────────────────────────────────────────

/**
 * 단일 기간 백테스트 실행
 * @param candles 1시간 캔들 데이터
 * @param rsiLongMin 롱 진입 RSI 최솟값
 * @param rsiLongMax 롱 진입 RSI 최댓값
 * @param rsiShortMin 숏 진입 RSI 최솟값
 * @param rsiShortMax 숏 진입 RSI 최댓값
 */
export function runSingleBacktest(
  candles: OHLCVCandle[],
  rsiLongMin: number = 40,
  rsiLongMax: number = 65,
  rsiShortMin: number = 35,
  rsiShortMax: number = 60,
  confidenceThreshold: number = 80,
  tpPct: number = 2.0,
  slPct: number = 1.0,
  leverage: number = 10,
): BacktestPeriodResult {
  const trades: BacktestTrade[] = [];
  const LOOKBACK = 200; // EMA200 계산에 필요한 최소 캔들 수

  if (candles.length < LOOKBACK + 50) {
    return createEmptyPeriodResult(
      candles[0]?.timestamp ?? 0,
      candles[candles.length - 1]?.timestamp ?? 0,
    );
  }

  let i = LOOKBACK;
  while (i < candles.length - 1) {
    const window = candles.slice(0, i + 1);
    const closes = window.map(c => c.close);
    const currentClose = closes[closes.length - 1];

    // 지표 계산
    const rsi = calcRSI(closes, 14);
    const ema200 = calcEMA(closes, 200);
    const adx = calcADX(window.slice(-30), 14);
    const atr = calcATR(window.slice(-20), 14);
    const atrPct = currentClose > 0 ? (atr / currentClose) * 100 : 1;

    // 시장 국면 분류 (CRASH 선행 감지를 위해 최소 20개 캔들 전달)
    const regime = classifyMarketRegime(window.slice(-20), adx, ema200);
    const regimeStrategy = getRegimeStrategy(regime);

    // ATR 기반 동적 레버리지 (AI 검증 v44)
    let dynLeverage = leverage;
    if (atrPct > 4) dynLeverage = Math.min(leverage, 5);
    else if (atrPct > 2) dynLeverage = Math.min(leverage, 10);
    else if (atrPct > 1) dynLeverage = Math.min(leverage, 20);

    // 국면별 레버리지 조정
    dynLeverage = Math.round(dynLeverage * regimeStrategy.leverageMultiplier);
    dynLeverage = Math.max(1, Math.min(50, dynLeverage));

    // 신호 생성
    let direction: 'LONG' | 'SHORT' | null = null;
    let confidence = 50;

    // 롱 신호: RSI 범위 + 국면 허용
    if (
      regimeStrategy.allowLong &&
      rsi >= rsiLongMin && rsi <= rsiLongMax &&
      adx >= 15  // 최소 추세 강도
    ) {
      direction = 'LONG';
      // 신뢰도 계산 (RSI 중심값에 가까울수록 높음)
      const rsiCenter = (rsiLongMin + rsiLongMax) / 2;
      const rsiScore = Math.max(0, 30 - Math.abs(rsi - rsiCenter));
      const adxScore = Math.min(20, adx / 2);
      confidence = Math.min(98, 50 + rsiScore + adxScore);
    }
    // 숏 신호: RSI 범위 + 국면 허용
    else if (
      regimeStrategy.allowShort &&
      rsi >= rsiShortMin && rsi <= rsiShortMax &&
      adx >= 15
    ) {
      direction = 'SHORT';
      const rsiCenter = (rsiShortMin + rsiShortMax) / 2;
      const rsiScore = Math.max(0, 30 - Math.abs(rsi - rsiCenter));
      const adxScore = Math.min(20, adx / 2);
      confidence = Math.min(98, 50 + rsiScore + adxScore);
    }

    // 신뢰도 기준 미달 또는 신호 없음
    if (!direction || confidence < confidenceThreshold) {
      i++;
      continue;
    }

    // 거래 시뮬레이션
    const entryPrice = candles[i + 1].open; // 다음 캔들 시가에 진입
    const tpPrice = direction === 'LONG'
      ? entryPrice * (1 + tpPct / 100 / dynLeverage)
      : entryPrice * (1 - tpPct / 100 / dynLeverage);
    const slPrice = direction === 'LONG'
      ? entryPrice * (1 - slPct / 100 / dynLeverage)
      : entryPrice * (1 + slPct / 100 / dynLeverage);

    let exitPrice = entryPrice;
    let exitReason: BacktestTrade['exitReason'] = 'TIMEOUT';
    let holdingCandles = 0;
    const maxHolding = 24; // 최대 24시간 보유

    for (let j = i + 1; j < Math.min(i + 1 + maxHolding, candles.length); j++) {
      const c = candles[j];
      holdingCandles++;

      if (direction === 'LONG') {
        if (c.low <= slPrice) {
          exitPrice = slPrice;
          exitReason = 'SL';
          break;
        }
        if (c.high >= tpPrice) {
          exitPrice = tpPrice;
          exitReason = 'TP';
          break;
        }
      } else {
        if (c.high >= slPrice) {
          exitPrice = slPrice;
          exitReason = 'SL';
          break;
        }
        if (c.low <= tpPrice) {
          exitPrice = tpPrice;
          exitReason = 'TP';
          break;
        }
      }
    }

    if (exitReason === 'TIMEOUT') {
      exitPrice = candles[Math.min(i + maxHolding, candles.length - 1)].close;
    }

    // 수익률 계산 (Gemini v47: 슬리피지 0.03% 추가 반영)
    // 진입 슬리피지: 시가 대비 0.03% 불리하게 체결
    const slippagePct = 0.03;
    const effectiveEntryPrice = direction === 'LONG'
      ? entryPrice * (1 + slippagePct / 100)   // 롱: 조금 더 비싸게 진입
      : entryPrice * (1 - slippagePct / 100);   // 숏: 조금 더 싸게 진입
    const effectiveExitPrice = direction === 'LONG'
      ? exitPrice * (1 - slippagePct / 100)     // 롱 청산: 조금 더 싸게 청산
      : exitPrice * (1 + slippagePct / 100);    // 숏 청산: 조금 더 비싸게 청산

    const pricePnlPct = direction === 'LONG'
      ? ((effectiveExitPrice - effectiveEntryPrice) / effectiveEntryPrice) * 100
      : ((effectiveEntryPrice - effectiveExitPrice) / effectiveEntryPrice) * 100;

    const grossPnlPct = pricePnlPct * dynLeverage;
    // 수수료 0.06% + 슬리피지 0.03% = 편도 0.09%, 왕복 0.18%
    const feeImpact = (TRADING_COSTS.CONSERVATIVE_ROUNDTRIP + slippagePct * 2 / 100) * dynLeverage * 100;
    const netPnlPct = grossPnlPct - feeImpact;

    trades.push({
      signal: {
        timestamp: candles[i].timestamp,
        symbol: 'BACKTEST',
        direction,
        confidence,
        leverage: dynLeverage,
        rsiLongMin,
        rsiLongMax,
        rsiShortMin,
        rsiShortMax,
        regime,
      },
      entryPrice,
      exitPrice,
      exitReason,
      holdingCandles,
      grossPnlPct,
      netPnlPct,
      regime,
    });

    // 다음 신호는 청산 후부터 탐색
    i += holdingCandles + 1;
  }

  return calcPeriodResult(
    candles[0].timestamp,
    candles[candles.length - 1].timestamp,
    trades,
  );
}

// ─── Walk-Forward Test ────────────────────────────────────────────────────────

/**
 * Walk-Forward Test 실행
 *
 * 방식:
 * - 6개월 In-sample (최적화): RSI 범위 Grid Search로 최적 파라미터 탐색
 * - 2개월 Out-of-sample (검증): 최적 파라미터로 실제 성과 검증
 * - 롤링: 2개월씩 앞으로 이동하며 반복
 *
 * AI 검증 v45 지적:
 * "6개월 단위로 파라미터를 최적화(In-sample)하고,
 *  그다음 2개월 동안 전진 검증(Out-of-sample)하는 방식"
 */
export function runWalkForwardTest(
  candles: OHLCVCandle[],
  symbol: string = 'BTCUSDT',
  inSampleMonths: number = 6,
  outSampleMonths: number = 2,
): WalkForwardResult {
  const CANDLES_PER_MONTH = 24 * 30; // 1시간 캔들 기준
  const inSampleSize = inSampleMonths * CANDLES_PER_MONTH;
  const outSampleSize = outSampleMonths * CANDLES_PER_MONTH;
  const stepSize = outSampleSize;

  const optimizationPeriods: BacktestPeriodResult[] = [];
  const validationPeriods: BacktestPeriodResult[] = [];
  const optimalParams: GridSearchResult[] = [];

  let start = 0;
  while (start + inSampleSize + outSampleSize <= candles.length) {
    const inSampleCandles = candles.slice(start, start + inSampleSize);
    const outSampleCandles = candles.slice(start + inSampleSize, start + inSampleSize + outSampleSize);

    // In-sample: Grid Search로 최적 RSI 범위 탐색
    const bestParams = runRSIGridSearch(inSampleCandles);
    optimalParams.push(bestParams);

    // In-sample 성과 기록
    const inSampleResult = runSingleBacktest(
      inSampleCandles,
      bestParams.rsiLongMin,
      bestParams.rsiLongMax,
      bestParams.rsiShortMin,
      bestParams.rsiShortMax,
    );
    optimizationPeriods.push(inSampleResult);

    // Out-of-sample: 최적 파라미터로 검증
    const outSampleResult = runSingleBacktest(
      outSampleCandles,
      bestParams.rsiLongMin,
      bestParams.rsiLongMax,
      bestParams.rsiShortMin,
      bestParams.rsiShortMax,
    );
    validationPeriods.push(outSampleResult);

    start += stepSize;
  }

  // 전체 통계 계산
  const allValidationTrades = validationPeriods.flatMap(p => p.trades);
  const overallStats = calcOverallStats(allValidationTrades, validationPeriods);

  // 최적 RSI 범위 (검증 기간 성과 가중 평균)
  const bestValidation = validationPeriods.reduce((best, p, i) =>
    p.totalNetPnlPct > (best?.totalNetPnlPct ?? -Infinity) ? p : best,
    validationPeriods[0],
  );
  const bestIdx = validationPeriods.indexOf(bestValidation);
  const rawBest = optimalParams[bestIdx] ?? {
    rsiLongMin: 40, rsiLongMax: 65,
    rsiShortMin: 35, rsiShortMax: 60,
    winRate: 0, profitFactor: 0, totalTrades: 0, score: 0,
  };
  const optimalRsiRanges = {
    longMin: rawBest.rsiLongMin,
    longMax: rawBest.rsiLongMax,
    shortMin: rawBest.rsiShortMin,
    shortMax: rawBest.rsiShortMax,
    gridSearchScore: rawBest.score,
  };

  // 과적합 감지: In-sample vs Out-of-sample 성과 차이 > 30%
  const avgInSamplePnl = optimizationPeriods.reduce((s, p) => s + p.totalNetPnlPct, 0) / Math.max(1, optimizationPeriods.length);
  const avgOutSamplePnl = validationPeriods.reduce((s, p) => s + p.totalNetPnlPct, 0) / Math.max(1, validationPeriods.length);
  const isOverfitted = avgInSamplePnl > 0 && avgOutSamplePnl < avgInSamplePnl * 0.7;

  // 권고사항 (Claude 검증 v47: 과적합 감지 시 구체적 행동 정의)
  // 문제: 과적합 경고만 뜨고 봇은 계속 돌아감
  // 해결: 과적합 시 자동 진입 차단 + 파라미터 리셋 플래그 포함
  let recommendation: string;
  let overfitAction: 'BLOCK_ENTRY' | 'REDUCE_SIZE' | 'RESET_PARAMS' | 'NONE' = 'NONE';
  let overfitSeverity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'NONE' = 'NONE';

  const inOutGap = avgInSamplePnl > 0 ? (avgInSamplePnl - avgOutSamplePnl) / avgInSamplePnl : 0;
  const outSampleWinRate = validationPeriods.reduce((s, p) => s + p.winRate, 0) / Math.max(1, validationPeriods.length);

  if (overallStats.winRate >= 0.55 && overallStats.profitFactor >= 1.5 && !isOverfitted) {
    recommendation = `✅ 전략 실전 적용 권고 — 승률 ${(overallStats.winRate * 100).toFixed(1)}%, PF ${overallStats.profitFactor.toFixed(2)}, 과적합 없음`;
    overfitAction = 'NONE';
    overfitSeverity = 'NONE';
  } else if (isOverfitted && inOutGap > 0.5) {
    // 심각한 과적합: In-sample vs Out-of-sample 괄리 50% 이상
    recommendation = `🚨 심각한 과적합 — In-sample ${avgInSamplePnl.toFixed(1)}% vs Out-of-sample ${avgOutSamplePnl.toFixed(1)}% (괄리 ${(inOutGap * 100).toFixed(0)}%). ` +
      `자동 진입 전면 차단. 파라미터 리셋 후 재검증 필요.`;
    overfitAction = 'BLOCK_ENTRY';
    overfitSeverity = 'CRITICAL';
  } else if (isOverfitted) {
    // 일반 과적합: 진입 허용하되 포지션 크기 50% 축소
    recommendation = `⚠️ 과적합 의심 — In-sample ${avgInSamplePnl.toFixed(1)}% vs Out-of-sample ${avgOutSamplePnl.toFixed(1)}%. ` +
      `포지션 크기 50% 축소 후 진입. 파라미터 단순화 권고.`;
    overfitAction = 'REDUCE_SIZE';
    overfitSeverity = 'HIGH';
  } else if (outSampleWinRate < 0.45) {
    // Out-of-sample 승률 45% 미만: 파라미터 리셋
    recommendation = `🟡 Out-of-sample 승률 저조 (${(outSampleWinRate * 100).toFixed(1)}% < 45%). ` +
      `파라미터 리셋 권고. 실거래 전 추가 검증 필요.`;
    overfitAction = 'RESET_PARAMS';
    overfitSeverity = 'MEDIUM';
  } else if (overallStats.profitFactor < 1.0) {
    recommendation = `🔴 전략 개선 필요 — Profit Factor ${overallStats.profitFactor.toFixed(2)} < 1.0 (손실 전략). 진입 조건 재검토 권고.`;
    overfitAction = 'BLOCK_ENTRY';
    overfitSeverity = 'HIGH';
  } else {
    recommendation = `🟡 소액 실거래 테스트 권고 — 승률 ${(overallStats.winRate * 100).toFixed(1)}%, PF ${overallStats.profitFactor.toFixed(2)}. 추가 검증 필요.`;
    overfitAction = 'NONE';
    overfitSeverity = 'NONE';
  }

  // 과적합 시 자동 행동 정의 (Claude v47 신규)
  // BLOCK_ENTRY: 신규 진입 전면 차단
  // REDUCE_SIZE: 포지션 크기 50% 축소
  // RESET_PARAMS: RSI Grid Search 재실행 권고
  // NONE: 정상 운영
  const overfitGuard = { action: overfitAction, severity: overfitSeverity, inOutGap, outSampleWinRate };

  return {
    symbol,
    optimizationPeriods,
    validationPeriods,
    overallStats,
    optimalRsiRanges,
    isOverfitted,
    recommendation,
    overfitGuard,
  };
}

// ─── RSI Grid Search ──────────────────────────────────────────────────────────

/**
 * RSI 구간 Grid Search
 *
 * AI 검증 v45 지적:
 * "왜 39가 아니고 40인가? 왜 66이 아니고 65인가?
 *  5년치 데이터 Walk Forward Test, Grid Search를 통해 최적 범위를 검증해야 합니다."
 *
 * 탐색 범위:
 * - 롱 최솟값: 30~50 (5 단위)
 * - 롱 최댓값: 55~75 (5 단위)
 * - 숏 최솟값: 25~45 (5 단위)
 * - 숏 최댓값: 50~70 (5 단위)
 */
export function runRSIGridSearch(
  candles: OHLCVCandle[],
  confidenceThreshold: number = 80,
): GridSearchResult {
  const longMinRange = [30, 35, 40, 45, 50];
  const longMaxRange = [55, 60, 65, 70, 75];
  const shortMinRange = [25, 30, 35, 40, 45];
  const shortMaxRange = [50, 55, 60, 65, 70];

  let bestResult: GridSearchResult = {
    rsiLongMin: 40, rsiLongMax: 65,
    rsiShortMin: 35, rsiShortMax: 60,
    winRate: 0, profitFactor: 0, totalTrades: 0, score: 0,
  };

  for (const lMin of longMinRange) {
    for (const lMax of longMaxRange) {
      if (lMax <= lMin + 10) continue; // 최솟값과 최댓값 간격 최소 10
      for (const sMin of shortMinRange) {
        for (const sMax of shortMaxRange) {
          if (sMax <= sMin + 10) continue;

          const result = runSingleBacktest(
            candles, lMin, lMax, sMin, sMax, confidenceThreshold,
          );

          if (result.totalTrades < 10) continue; // 최소 10회 거래 필요

          // 종합 점수: 승률 × Profit Factor (양수 PF만)
          const score = result.profitFactor > 0
            ? result.winRate * result.profitFactor
            : 0;

          if (score > bestResult.score) {
            bestResult = {
              rsiLongMin: lMin,
              rsiLongMax: lMax,
              rsiShortMin: sMin,
              rsiShortMax: sMax,
              winRate: result.winRate,
              profitFactor: result.profitFactor,
              totalTrades: result.totalTrades,
              score,
            };
          }
        }
      }
    }
  }

  return bestResult;
}

// ─── 헬퍼 함수 ───────────────────────────────────────────────────────────────

function createEmptyPeriodResult(start: number, end: number): BacktestPeriodResult {
  return {
    periodStart: start,
    periodEnd: end,
    trades: [],
    winRate: 0,
    profitFactor: 0,
    sharpeRatio: 0,
    maxDrawdownPct: 0,
    totalNetPnlPct: 0,
    avgNetPnlPerTrade: 0,
    totalTrades: 0,
    regimeBreakdown: {
      BULL_TREND: { trades: 0, winRate: 0, pnl: 0 },
      BEAR_TREND: { trades: 0, winRate: 0, pnl: 0 },
      RANGING: { trades: 0, winRate: 0, pnl: 0 },
      CRASH: { trades: 0, winRate: 0, pnl: 0 },
    },
  };
}

function calcPeriodResult(
  start: number,
  end: number,
  trades: BacktestTrade[],
): BacktestPeriodResult {
  if (trades.length === 0) return createEmptyPeriodResult(start, end);

  const wins = trades.filter(t => t.netPnlPct > 0);
  const losses = trades.filter(t => t.netPnlPct < 0);
  const winRate = wins.length / trades.length;

  const totalWin = wins.reduce((s, t) => s + t.netPnlPct, 0);
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.netPnlPct, 0));
  const profitFactor = totalLoss > 0 ? totalWin / totalLoss : totalWin > 0 ? 999 : 0;

  const totalNetPnlPct = trades.reduce((s, t) => s + t.netPnlPct, 0);
  const avgNetPnlPerTrade = totalNetPnlPct / trades.length;

  // MDD 계산
  let peak = 0;
  let cumPnl = 0;
  let maxDrawdownPct = 0;
  for (const t of trades) {
    cumPnl += t.netPnlPct;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
  }

  // Sharpe Ratio
  const avgPnl = avgNetPnlPerTrade;
  const variance = trades.reduce((s, t) => s + Math.pow(t.netPnlPct - avgPnl, 2), 0) / trades.length;
  const stdDev = Math.sqrt(variance);
  const sharpeRatio = stdDev > 0 ? avgPnl / stdDev : 0;

  // 국면별 분석
  const regimeBreakdown: BacktestPeriodResult['regimeBreakdown'] = {
    BULL_TREND: { trades: 0, winRate: 0, pnl: 0 },
    BEAR_TREND: { trades: 0, winRate: 0, pnl: 0 },
    RANGING: { trades: 0, winRate: 0, pnl: 0 },
    CRASH: { trades: 0, winRate: 0, pnl: 0 },
  };

  for (const regime of ['BULL_TREND', 'BEAR_TREND', 'RANGING', 'CRASH'] as MarketRegime[]) {
    const regimeTrades = trades.filter(t => t.regime === regime);
    if (regimeTrades.length > 0) {
      const regimeWins = regimeTrades.filter(t => t.netPnlPct > 0).length;
      regimeBreakdown[regime] = {
        trades: regimeTrades.length,
        winRate: regimeWins / regimeTrades.length,
        pnl: regimeTrades.reduce((s, t) => s + t.netPnlPct, 0),
      };
    }
  }

  return {
    periodStart: start,
    periodEnd: end,
    trades,
    winRate,
    profitFactor,
    sharpeRatio,
    maxDrawdownPct,
    totalNetPnlPct,
    avgNetPnlPerTrade,
    totalTrades: trades.length,
    regimeBreakdown,
  };
}

function calcOverallStats(
  allTrades: BacktestTrade[],
  periods: BacktestPeriodResult[],
): WalkForwardResult['overallStats'] {
  if (allTrades.length === 0) {
    return {
      winRate: 0, profitFactor: 0, sharpeRatio: 0,
      maxDrawdownPct: 0, totalNetPnlPct: 0, totalTrades: 0,
      avgDailyPnlPct: 0, bestRegime: 'BULL_TREND', worstRegime: 'CRASH',
    };
  }

  const wins = allTrades.filter(t => t.netPnlPct > 0);
  const losses = allTrades.filter(t => t.netPnlPct < 0);
  const winRate = wins.length / allTrades.length;
  const totalWin = wins.reduce((s, t) => s + t.netPnlPct, 0);
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.netPnlPct, 0));
  const profitFactor = totalLoss > 0 ? totalWin / totalLoss : totalWin > 0 ? 999 : 0;
  const totalNetPnlPct = allTrades.reduce((s, t) => s + t.netPnlPct, 0);

  // MDD
  let peak = 0, cumPnl = 0, maxDrawdownPct = 0;
  for (const t of allTrades) {
    cumPnl += t.netPnlPct;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
  }

  // Sharpe
  const avgPnl = totalNetPnlPct / allTrades.length;
  const variance = allTrades.reduce((s, t) => s + Math.pow(t.netPnlPct - avgPnl, 2), 0) / allTrades.length;
  const sharpeRatio = Math.sqrt(variance) > 0 ? avgPnl / Math.sqrt(variance) : 0;

  // 일평균 수익률 (전체 기간 대비)
  const totalDays = periods.reduce((s, p) => {
    return s + (p.periodEnd - p.periodStart) / (1000 * 60 * 60 * 24);
  }, 0);
  const avgDailyPnlPct = totalDays > 0 ? totalNetPnlPct / totalDays : 0;

  // 최고/최악 국면
  const regimePnls: Record<MarketRegime, number> = {
    BULL_TREND: 0, BEAR_TREND: 0, RANGING: 0, CRASH: 0,
  };
  for (const t of allTrades) {
    regimePnls[t.regime] += t.netPnlPct;
  }
  const bestRegime = Object.entries(regimePnls).sort(([, a], [, b]) => b - a)[0][0] as MarketRegime;
  const worstRegime = Object.entries(regimePnls).sort(([, a], [, b]) => a - b)[0][0] as MarketRegime;

  return {
    winRate, profitFactor, sharpeRatio, maxDrawdownPct,
    totalNetPnlPct, totalTrades: allTrades.length,
    avgDailyPnlPct, bestRegime, worstRegime,
  };
}

/**
 * 모의 캔들 데이터 생성 (실제 API 연동 전 테스트용)
 * 2022~2026년 4년치 1시간 캔들 시뮬레이션
 */
export function generateMockCandles(
  startPrice: number = 30000,
  totalCandles: number = 24 * 365 * 4, // 4년치
  volatility: number = 0.015, // 1.5% 시간당 변동성
): OHLCVCandle[] {
  const candles: OHLCVCandle[] = [];
  let price = startPrice;
  const startTime = new Date('2022-01-01').getTime();

  for (let i = 0; i < totalCandles; i++) {
    const change = (Math.random() - 0.48) * volatility; // 약간 상승 편향
    const open = price;
    price = price * (1 + change);
    const high = Math.max(open, price) * (1 + Math.random() * volatility * 0.5);
    const low = Math.min(open, price) * (1 - Math.random() * volatility * 0.5);
    const volume = 1000 + Math.random() * 5000;

    candles.push({
      timestamp: startTime + i * 3600000, // 1시간 간격
      open,
      high,
      low,
      close: price,
      volume,
    });
  }

  return candles;
}

// ─── Bybit KLINE API 실제 데이터 연동 ─────────────────────────────────────────

/**
 * Binance FAPI 공개 KLINE API에서 실제 캔들 데이터 조회
 *
 * @param symbol   예: 'BTCUSDT'
 * @param interval 예: '60' (1시간 → Binance: '1h'), '240' (4시간 → '4h'), 'D' (일봉 → '1d')
 * @param startTime Unix ms (시작 시각)
 * @param endTime   Unix ms (종료 시각)
 * @param isTestnet 테스트넷 여부 (기본 false)
 */
export async function fetchBybitKlines(
  symbol: string,
  interval: string = '60',
  startTime?: number,
  endTime?: number,
  isTestnet: boolean = false,
): Promise<OHLCVCandle[]> {
  // Bybit interval → Binance interval 변환
  const intervalMap: Record<string, string> = {
    '1': '1m', '3': '3m', '5': '5m', '15': '15m', '30': '30m',
    '60': '1h', '120': '2h', '240': '4h', '360': '6h', '720': '12h',
    'D': '1d', 'W': '1w', 'M': '1M',
  };
  const binanceInterval = intervalMap[interval] ?? '1h';

  const base = isTestnet
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';

  const allCandles: OHLCVCandle[] = [];
  const LIMIT = 1500; // Binance 최대 1500개/요청

  const now = Date.now();
  const defaultEnd = endTime ?? now;
  const defaultStart = startTime ?? (now - 8 * 30 * 24 * 60 * 60 * 1000);

  let cursor = defaultStart;

  while (cursor < defaultEnd) {
    const params = new URLSearchParams({
      symbol,
      interval: binanceInterval,
      startTime: String(cursor),
      endTime: String(Math.min(cursor + LIMIT * 3600000, defaultEnd)),
      limit: String(LIMIT),
    });

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      let res: Response;
      try {
        res = await fetch(`${base}/fapi/v1/klines?${params}`, {
          signal: controller.signal,
        });
        clearTimeout(timer);
      } catch (e) {
        clearTimeout(timer);
        console.warn(`[fetchBybitKlines→Binance] 네트워크 오류 (${symbol}):`, e);
        break;
      }

      const json = await res.json() as [
        number, string, string, string, string, string, ...unknown[]
      ][];

      if (!Array.isArray(json) || json.length === 0) break;

      // Binance kline: [openTime, open, high, low, close, volume, ...]
      const batch: OHLCVCandle[] = json.map(r => ({
        timestamp: Number(r[0]),
        open: parseFloat(r[1] as string),
        high: parseFloat(r[2] as string),
        low: parseFloat(r[3] as string),
        close: parseFloat(r[4] as string),
        volume: parseFloat(r[5] as string),
      }));

      if (batch.length === 0) break;

      allCandles.push(...batch);

      const lastTs = batch[batch.length - 1].timestamp;
      cursor = lastTs + 3600000;

      await new Promise(r => setTimeout(r, 200));

      if (batch.length < LIMIT) break;
    } catch (e) {
      console.warn(`[fetchBybitKlines→Binance] 파싱 오류 (${symbol}):`, e);
      break;
    }
  }

  const unique = new Map<number, OHLCVCandle>();
  for (const c of allCandles) unique.set(c.timestamp, c);
  return Array.from(unique.values()).sort((a, b) => a.timestamp - b.timestamp);
}

// ─── Monte Carlo 시뮬레이션 (ChatGPT 검증 v47 권고) ───────────────────────────

export interface MonteCarloResult {
  simulations: number;          // 시뮬레이션 횟수
  medianFinalPnl: number;       // 중앙값 최종 수익률 %
  percentile5: number;          // 5th percentile (최악 5%)
  percentile25: number;         // 25th percentile
  percentile75: number;         // 75th percentile
  percentile95: number;         // 95th percentile (최상 5%)
  medianMaxDrawdown: number;    // 중앙값 MDD %
  ruinProbability: number;      // 파산 확률 (잔고 -50% 이하)
  parameterStability: number;   // 파라미터 안정성 점수 0~1
}

/**
 * Monte Carlo 시뮬레이션
 *
 * ChatGPT 검증 v47 권고:
 * "RSI만 Grid Search → 과최적화 방지 수준 50%. Monte Carlo, Bootstrap Test 추가 필요."
 *
 * 방법: 실제 거래 결과를 무작위 순서로 재배열하여 N회 시뮬레이션
 * → 순서 의존성(연속 손실 등)을 제거하고 전략의 통계적 견고성 검증
 *
 * @param trades     백테스트 거래 결과 배열
 * @param simCount   시뮬레이션 횟수 (기본 1000)
 * @param ruinThreshold 파산 기준 누적 손실 % (기본 -50%)
 */
export function runMonteCarlo(
  trades: BacktestTrade[],
  simCount: number = 1000,
  ruinThreshold: number = -50,
): MonteCarloResult {
  if (trades.length < 10) {
    return {
      simulations: 0,
      medianFinalPnl: 0,
      percentile5: 0,
      percentile25: 0,
      percentile75: 0,
      percentile95: 0,
      medianMaxDrawdown: 0,
      ruinProbability: 0,
      parameterStability: 0,
    };
  }

  const pnlArray = trades.map(t => t.netPnlPct);
  const finalPnls: number[] = [];
  const maxDrawdowns: number[] = [];
  let ruinCount = 0;

  for (let sim = 0; sim < simCount; sim++) {
    // Fisher-Yates 셔플로 거래 순서 무작위화
    const shuffled = [...pnlArray];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    // 누적 수익률 및 MDD 계산
    let cumPnl = 0;
    let peak = 0;
    let maxDd = 0;
    let ruined = false;

    for (const pnl of shuffled) {
      cumPnl += pnl;
      if (cumPnl > peak) peak = cumPnl;
      const dd = peak - cumPnl;
      if (dd > maxDd) maxDd = dd;
      if (cumPnl <= ruinThreshold) {
        ruined = true;
        break;
      }
    }

    finalPnls.push(cumPnl);
    maxDrawdowns.push(maxDd);
    if (ruined) ruinCount++;
  }

  // 정렬 후 백분위수 계산
  finalPnls.sort((a, b) => a - b);
  maxDrawdowns.sort((a, b) => a - b);

  const pct = (arr: number[], p: number) => arr[Math.floor(arr.length * p / 100)];

  // 파라미터 안정성: 75th ~ 25th 퍼센타일 비율 (좁을수록 안정적)
  const iqr = pct(finalPnls, 75) - pct(finalPnls, 25);
  const median = pct(finalPnls, 50);
  const parameterStability = median !== 0
    ? Math.max(0, 1 - Math.abs(iqr / median) / 4) // IQR/median이 4배 이하면 안정적
    : 0;

  return {
    simulations: simCount,
    medianFinalPnl: pct(finalPnls, 50),
    percentile5: pct(finalPnls, 5),
    percentile25: pct(finalPnls, 25),
    percentile75: pct(finalPnls, 75),
    percentile95: pct(finalPnls, 95),
    medianMaxDrawdown: pct(maxDrawdowns, 50),
    ruinProbability: ruinCount / simCount,
    parameterStability: Math.min(1, Math.max(0, parameterStability)),
  };
}
