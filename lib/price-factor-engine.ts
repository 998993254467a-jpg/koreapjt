/**
 * price-factor-engine.ts
 *
 * 암호화폐 가격에 영향을 미치는 모든 요소를 8대 분류로 체계화하고
 * 수익 가능한 조합을 자동으로 계산하는 전략 엔진
 *
 * ─────────────────────────────────────────────────────────────────
 * 8대 분류:
 *
 * 1. 기술적 지표 (Technical)
 *    RSI, MACD, 볼린저밴드, 이동평균, ADX, Stochastic, ATR, 거래량
 *
 * 2. 온체인 데이터 (OnChain)
 *    고래 이동, 거래소 유입/유출, 채굴자 행동, 활성 주소 수
 *
 * 3. 파생상품 시장 (Derivatives)
 *    펀딩비, 미결제약정(OI), 청산 데이터, 옵션 Put/Call 비율
 *
 * 4. 매크로 경제 (Macro)
 *    미국 경제지표(CPI/PPI/NFP/GDP), 연준 금리, 달러 인덱스(DXY),
 *    금/원유 가격, 주식시장(S&P500/나스닥) 상관관계
 *
 * 5. 유명인/기관 영향 (Influencer & Institutional)
 *    일론 머스크/트럼프/마이클 세일러 등 발언,
 *    기관 매수(ETF 유입), 기업 BTC 보유 발표
 *
 * 6. 규제/정책 (Regulatory)
 *    SEC/CFTC 규제 발표, 국가별 암호화폐 정책,
 *    ETF 승인/거부, 거래소 제재
 *
 * 7. 시장 심리 (Sentiment)
 *    공포탐욕지수, 소셜 미디어 버즈, 검색 트렌드,
 *    롱/숏 비율, 청산 히트맵
 *
 * 8. 프로젝트 이벤트 (Project Events)
 *    하드포크, 메인넷 출시, 파트너십 발표, 해킹/보안 사고,
 *    토큰 락업 해제, 에어드롭
 * ─────────────────────────────────────────────────────────────────
 */

// ─── 타입 정의 ────────────────────────────────────────────────────────────────

export type FactorCategory =
  | 'TECHNICAL'
  | 'ONCHAIN'
  | 'DERIVATIVES'
  | 'MACRO'
  | 'INFLUENCER'
  | 'REGULATORY'
  | 'SENTIMENT'
  | 'PROJECT_EVENT';

export type FactorDirection = 'BULLISH' | 'BEARISH' | 'NEUTRAL';
export type FactorStrength = 'STRONG' | 'MODERATE' | 'WEAK';

export interface PriceFactor {
  category: FactorCategory;
  name: string;
  direction: FactorDirection;
  strength: FactorStrength;
  score: number;       // -100 ~ +100 (양수=상승, 음수=하락)
  weight: number;      // 0~1 (카테고리 내 가중치)
  description: string;
  timestamp: number;
}

export interface CategoryScore {
  category: FactorCategory;
  score: number;        // -100 ~ +100
  direction: FactorDirection;
  strength: FactorStrength;
  dominantFactor: string;
  factors: PriceFactor[];
}

export interface ComboScore {
  totalScore: number;           // -100 ~ +100 (전체 조합 점수)
  direction: FactorDirection;   // 최종 방향
  confidence: number;           // 0~100 (신뢰도)
  entryRecommended: boolean;    // 진입 권장 여부
  recommendedSide: 'Buy' | 'Sell' | null;
  categoryScores: CategoryScore[];
  bullishFactors: string[];     // 상승 요인 목록
  bearishFactors: string[];     // 하락 요인 목록
  conflictingFactors: string[]; // 상충 요인 (신뢰도 감소)
  optimalCombos: OptimalCombo[];// 수익 가능한 조합들
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
  summary: string;
}

export interface OptimalCombo {
  name: string;
  categories: FactorCategory[];
  alignment: number;   // 0~100 (조합 일치도)
  expectedReturn: number; // 예상 수익률 %
  description: string;
}

// ─── 카테고리 가중치 (시장 상황에 따라 동적 조정) ────────────────────────────

// AI 검증 v44 가중치 재조정:
// - 유명인 10% → 2% (단기 노이즈 많음, 실제 영향력 낙음)
// - 뉴스/이벤트 5% → 15% (ETF승인/규제/해킹 등 시장 수십% 이동)
// - 파생상품 20% → 25% (평당비/OI 실전 영향력 반영)
// - 온체인 8% → 15% (중기 신뢰도 상향)
// - 매크로 15% → 10% (스컈핑에서 중장기 지표 영향력 제한적)
const BASE_WEIGHTS: Record<FactorCategory, number> = {
  TECHNICAL:     0.25,  // 기술적 지표 — 항상 중요 (25% 유지)
  DERIVATIVES:   0.25,  // 파생상품 — 선물 시장 핵심 (+5%)
  ONCHAIN:       0.15,  // 온체인 — 중기 신뢰도 (+7%)
  REGULATORY:    0.15,  // 뉴스/이벤트 — ETF/규제/해킹 등 (+10%)
  MACRO:         0.10,  // 매크로 — 스컈핑에서 제한적 (-5%)
  SENTIMENT:     0.05,  // 시장 심리 — 단기 노이즈 많음 (-10%)
  PROJECT_EVENT: 0.03,  // 프로젝트 이벤트 — 종목별 특수 (+1%)
  INFLUENCER:    0.02,  // 유명인/기관 — 단기 노이즈 많음 (-8%)
};

// ─── 1. 기술적 지표 분석 ──────────────────────────────────────────────────────

export interface TechnicalInput {
  rsi: number;          // 0~100
  macd: number;         // MACD 히스토그램
  macdSignal: number;
  bbPosition: number;   // 볼린저밴드 위치 (-1~+1, 0=중앙)
  adx: number;          // 추세 강도 0~100
  stochK: number;       // Stochastic %K
  stochD: number;       // Stochastic %D
  atr: number;          // ATR
  price: number;
  ema20: number;
  ema50: number;
  ema200: number;
  volume: number;
  avgVolume: number;    // 평균 거래량
  tf15m?: string;       // '상승' | '하락' | '중립'
  tf1h?: string;
  tf4h?: string;
}

export function analyzeTechnical(input: TechnicalInput): CategoryScore {
  const factors: PriceFactor[] = [];

  // RSI 분석
  let rsiScore = 0;
  let rsiDesc = '';
  if (input.rsi <= 25) { rsiScore = 80; rsiDesc = `RSI ${input.rsi.toFixed(0)} — 극도 과매도 (강한 반등 신호)`; }
  else if (input.rsi <= 35) { rsiScore = 50; rsiDesc = `RSI ${input.rsi.toFixed(0)} — 과매도 (매수 기회)`; }
  else if (input.rsi >= 75) { rsiScore = -80; rsiDesc = `RSI ${input.rsi.toFixed(0)} — 극도 과매수 (하락 경고)`; }
  else if (input.rsi >= 65) { rsiScore = -50; rsiDesc = `RSI ${input.rsi.toFixed(0)} — 과매수 (조정 가능)`; }
  else if (input.rsi >= 50) { rsiScore = 20; rsiDesc = `RSI ${input.rsi.toFixed(0)} — 상승 모멘텀`; }
  else { rsiScore = -20; rsiDesc = `RSI ${input.rsi.toFixed(0)} — 하락 모멘텀`; }
  factors.push({ category: 'TECHNICAL', name: 'RSI', direction: rsiScore > 0 ? 'BULLISH' : rsiScore < 0 ? 'BEARISH' : 'NEUTRAL', strength: Math.abs(rsiScore) >= 70 ? 'STRONG' : Math.abs(rsiScore) >= 40 ? 'MODERATE' : 'WEAK', score: rsiScore, weight: 0.20, description: rsiDesc, timestamp: Date.now() });

  // MACD 분석
  const macdScore = input.macd > 0 && input.macd > input.macdSignal ? 40 :
                    input.macd > 0 ? 20 :
                    input.macd < 0 && input.macd < input.macdSignal ? -40 : -20;
  factors.push({ category: 'TECHNICAL', name: 'MACD', direction: macdScore > 0 ? 'BULLISH' : 'BEARISH', strength: Math.abs(macdScore) >= 35 ? 'STRONG' : 'MODERATE', score: macdScore, weight: 0.15, description: `MACD ${input.macd > 0 ? '골든크로스' : '데드크로스'} (히스토그램: ${input.macd.toFixed(4)})`, timestamp: Date.now() });

  // 이동평균 배열
  const emaScore = input.price > input.ema20 && input.ema20 > input.ema50 && input.ema50 > input.ema200 ? 60 :
                   input.price > input.ema20 && input.ema20 > input.ema50 ? 35 :
                   input.price > input.ema20 ? 15 :
                   input.price < input.ema20 && input.ema20 < input.ema50 && input.ema50 < input.ema200 ? -60 :
                   input.price < input.ema20 && input.ema20 < input.ema50 ? -35 : -15;
  factors.push({ category: 'TECHNICAL', name: 'EMA 배열', direction: emaScore > 0 ? 'BULLISH' : 'BEARISH', strength: Math.abs(emaScore) >= 50 ? 'STRONG' : Math.abs(emaScore) >= 30 ? 'MODERATE' : 'WEAK', score: emaScore, weight: 0.20, description: `EMA 20/50/200 ${emaScore > 0 ? '정배열' : '역배열'}`, timestamp: Date.now() });

  // 볼린저밴드
  const bbScore = input.bbPosition <= -0.8 ? 70 : input.bbPosition <= -0.5 ? 40 :
                  input.bbPosition >= 0.8 ? -70 : input.bbPosition >= 0.5 ? -40 : 0;
  factors.push({ category: 'TECHNICAL', name: '볼린저밴드', direction: bbScore > 0 ? 'BULLISH' : bbScore < 0 ? 'BEARISH' : 'NEUTRAL', strength: Math.abs(bbScore) >= 60 ? 'STRONG' : Math.abs(bbScore) >= 30 ? 'MODERATE' : 'WEAK', score: bbScore, weight: 0.15, description: `BB 위치 ${(input.bbPosition * 100).toFixed(0)}% (${input.bbPosition <= -0.8 ? '하단 터치 — 반등 기대' : input.bbPosition >= 0.8 ? '상단 터치 — 조정 기대' : '중앙 구간'})`, timestamp: Date.now() });

  // ADX 추세 강도
  const adxScore = input.adx >= 40 ? 30 : input.adx >= 25 ? 15 : 0; // 방향 무관, 추세 강도만
  factors.push({ category: 'TECHNICAL', name: 'ADX', direction: 'NEUTRAL', strength: input.adx >= 40 ? 'STRONG' : input.adx >= 25 ? 'MODERATE' : 'WEAK', score: adxScore, weight: 0.10, description: `ADX ${input.adx.toFixed(0)} — ${input.adx >= 40 ? '강한 추세' : input.adx >= 25 ? '추세 형성' : '추세 없음 (횡보)'}`, timestamp: Date.now() });

  // 거래량 분석
  const volRatio = input.avgVolume > 0 ? input.volume / input.avgVolume : 1;
  const volScore = volRatio >= 3 ? 50 : volRatio >= 2 ? 30 : volRatio >= 1.5 ? 15 : volRatio < 0.5 ? -20 : 0;
  factors.push({ category: 'TECHNICAL', name: '거래량', direction: volScore > 0 ? 'BULLISH' : volScore < 0 ? 'BEARISH' : 'NEUTRAL', strength: volRatio >= 3 ? 'STRONG' : volRatio >= 2 ? 'MODERATE' : 'WEAK', score: volScore, weight: 0.10, description: `거래량 평균 대비 ${volRatio.toFixed(1)}배 (${volRatio >= 2 ? '급증 — 강한 모멘텀' : volRatio < 0.5 ? '급감 — 관심 저하' : '정상'})`, timestamp: Date.now() });

  // 멀티 타임프레임 일치도
  const tfScores: number[] = [input.tf15m, input.tf1h, input.tf4h].map(tf =>
    tf === '상승' ? 1 : tf === '하락' ? -1 : 0
  );
  const tfSum: number = tfScores.reduce((a, b) => a + b, 0);
  const mtfScore = tfSum >= 3 ? 60 : tfSum >= 2 ? 35 : tfSum <= -3 ? -60 : tfSum <= -2 ? -35 : 0;
  factors.push({ category: 'TECHNICAL', name: 'MTF 일치도', direction: mtfScore > 0 ? 'BULLISH' : mtfScore < 0 ? 'BEARISH' : 'NEUTRAL', strength: Math.abs(mtfScore) >= 50 ? 'STRONG' : Math.abs(mtfScore) >= 30 ? 'MODERATE' : 'WEAK', score: mtfScore, weight: 0.10, description: `15분/1시간/4시간 ${mtfScore > 0 ? '상승 일치' : mtfScore < 0 ? '하락 일치' : '방향 불일치 (신뢰도 낮음)'}`, timestamp: Date.now() });

  return buildCategoryScore('TECHNICAL', factors);
}

// ─── 2. 파생상품 시장 분석 ────────────────────────────────────────────────────

export interface DerivativesInput {
  fundingRate: number;      // % (양수=롱 우세, 음수=숏 우세)
  openInterestChange: number; // OI 변화율 % (양수=증가)
  longShortRatio: number;   // 롱/숏 비율 (1.0 = 동일)
  liquidationLong: number;  // 롱 청산 금액 (USD)
  liquidationShort: number; // 숏 청산 금액 (USD)
  putCallRatio?: number;    // 옵션 Put/Call 비율 (>1 = 하락 베팅 많음)
}

export function analyzeDerivatives(input: DerivativesInput): CategoryScore {
  const factors: PriceFactor[] = [];

  // 펀딩비 분석
  const frAbs = Math.abs(input.fundingRate);
  let frScore = 0;
  let frDesc = '';
  if (input.fundingRate > 0.1) { frScore = -60; frDesc = `펀딩비 +${input.fundingRate.toFixed(3)}% — 롱 과열 (숏 유리)`; }
  else if (input.fundingRate > 0.05) { frScore = -30; frDesc = `펀딩비 +${input.fundingRate.toFixed(3)}% — 롱 우세 (주의)`; }
  else if (input.fundingRate < -0.1) { frScore = 60; frDesc = `펀딩비 ${input.fundingRate.toFixed(3)}% — 숏 과열 (롱 유리)`; }
  else if (input.fundingRate < -0.05) { frScore = 30; frDesc = `펀딩비 ${input.fundingRate.toFixed(3)}% — 숏 우세 (롱 기회)`; }
  else { frScore = 10; frDesc = `펀딩비 ${input.fundingRate.toFixed(3)}% — 균형 (중립)`; }
  factors.push({ category: 'DERIVATIVES', name: '펀딩비', direction: frScore > 0 ? 'BULLISH' : frScore < 0 ? 'BEARISH' : 'NEUTRAL', strength: frAbs >= 0.1 ? 'STRONG' : frAbs >= 0.05 ? 'MODERATE' : 'WEAK', score: frScore, weight: 0.30, description: frDesc, timestamp: Date.now() });

  // 미결제약정(OI) 변화
  const oiScore = input.openInterestChange > 20 ? 50 : input.openInterestChange > 10 ? 30 :
                  input.openInterestChange < -20 ? -50 : input.openInterestChange < -10 ? -30 : 0;
  factors.push({ category: 'DERIVATIVES', name: 'OI 변화', direction: oiScore > 0 ? 'BULLISH' : oiScore < 0 ? 'BEARISH' : 'NEUTRAL', strength: Math.abs(input.openInterestChange) >= 20 ? 'STRONG' : 'MODERATE', score: oiScore, weight: 0.25, description: `미결제약정 ${input.openInterestChange > 0 ? '+' : ''}${input.openInterestChange.toFixed(1)}% (${input.openInterestChange > 10 ? '신규 자금 유입 — 상승 지지' : input.openInterestChange < -10 ? '자금 이탈 — 하락 압력' : '보합'})`, timestamp: Date.now() });

  // 롱/숏 비율
  const lsScore = input.longShortRatio > 2.0 ? -50 : input.longShortRatio > 1.5 ? -25 :
                  input.longShortRatio < 0.5 ? 50 : input.longShortRatio < 0.7 ? 25 : 0;
  factors.push({ category: 'DERIVATIVES', name: '롱/숏 비율', direction: lsScore > 0 ? 'BULLISH' : lsScore < 0 ? 'BEARISH' : 'NEUTRAL', strength: Math.abs(lsScore) >= 40 ? 'STRONG' : 'MODERATE', score: lsScore, weight: 0.25, description: `롱/숏 비율 ${input.longShortRatio.toFixed(2)} (${input.longShortRatio > 2 ? '롱 극도 과열 — 역방향 주의' : input.longShortRatio < 0.5 ? '숏 극도 과열 — 숏스퀴즈 가능' : '균형'})`, timestamp: Date.now() });

  // 청산 데이터
  const liqRatio = input.liquidationShort > 0 ? input.liquidationLong / input.liquidationShort : 1;
  const liqScore = liqRatio > 3 ? -40 : liqRatio < 0.33 ? 40 : 0;
  factors.push({ category: 'DERIVATIVES', name: '청산 히트맵', direction: liqScore > 0 ? 'BULLISH' : liqScore < 0 ? 'BEARISH' : 'NEUTRAL', strength: Math.abs(liqScore) >= 35 ? 'STRONG' : 'WEAK', score: liqScore, weight: 0.20, description: `롱청산 $${(input.liquidationLong / 1e6).toFixed(1)}M vs 숏청산 $${(input.liquidationShort / 1e6).toFixed(1)}M`, timestamp: Date.now() });

  return buildCategoryScore('DERIVATIVES', factors);
}

// ─── 3. 매크로 경제 분석 ──────────────────────────────────────────────────────

export interface MacroInput {
  dxyChange: number;        // 달러 인덱스 변화율 % (양수=달러 강세)
  sp500Change: number;      // S&P500 변화율 %
  goldChange: number;       // 금 가격 변화율 %
  fearGreedIndex: number;   // 공포탐욕지수 0~100
  fedRateExpectation: 'HIKE' | 'HOLD' | 'CUT' | 'UNKNOWN';
  inflationTrend: 'UP' | 'DOWN' | 'STABLE';
  upcomingEvent?: string;   // 예정된 경제지표 발표
  eventImpact?: 'HIGH' | 'MEDIUM' | 'LOW';
}

export function analyzeMacro(input: MacroInput): CategoryScore {
  const factors: PriceFactor[] = [];

  // 달러 인덱스 (DXY) — 역상관
  const dxyScore = input.dxyChange > 1 ? -60 : input.dxyChange > 0.5 ? -30 :
                   input.dxyChange < -1 ? 60 : input.dxyChange < -0.5 ? 30 : 0;
  factors.push({ category: 'MACRO', name: 'DXY 달러지수', direction: dxyScore > 0 ? 'BULLISH' : dxyScore < 0 ? 'BEARISH' : 'NEUTRAL', strength: Math.abs(input.dxyChange) >= 1 ? 'STRONG' : 'MODERATE', score: dxyScore, weight: 0.25, description: `달러지수 ${input.dxyChange > 0 ? '+' : ''}${input.dxyChange.toFixed(2)}% (달러 ${input.dxyChange > 0 ? '강세 → 암호화폐 하락 압력' : '약세 → 암호화폐 상승 지지'})`, timestamp: Date.now() });

  // S&P500 상관관계
  const spScore = input.sp500Change > 1.5 ? 40 : input.sp500Change > 0.5 ? 20 :
                  input.sp500Change < -1.5 ? -40 : input.sp500Change < -0.5 ? -20 : 0;
  factors.push({ category: 'MACRO', name: 'S&P500', direction: spScore > 0 ? 'BULLISH' : spScore < 0 ? 'BEARISH' : 'NEUTRAL', strength: Math.abs(input.sp500Change) >= 1.5 ? 'STRONG' : 'MODERATE', score: spScore, weight: 0.20, description: `S&P500 ${input.sp500Change > 0 ? '+' : ''}${input.sp500Change.toFixed(2)}% (위험자산 ${input.sp500Change > 0 ? '선호 → 암호화폐 동반 상승' : '회피 → 암호화폐 동반 하락'})`, timestamp: Date.now() });

  // 공포탐욕지수
  const fgScore = input.fearGreedIndex <= 20 ? 70 : input.fearGreedIndex <= 35 ? 40 :
                  input.fearGreedIndex >= 80 ? -70 : input.fearGreedIndex >= 65 ? -40 : 0;
  factors.push({ category: 'MACRO', name: '공포탐욕지수', direction: fgScore > 0 ? 'BULLISH' : fgScore < 0 ? 'BEARISH' : 'NEUTRAL', strength: Math.abs(fgScore) >= 60 ? 'STRONG' : Math.abs(fgScore) >= 30 ? 'MODERATE' : 'WEAK', score: fgScore, weight: 0.20, description: `공포탐욕지수 ${input.fearGreedIndex} (${input.fearGreedIndex <= 20 ? '극도 공포 — 역발상 매수 기회' : input.fearGreedIndex >= 80 ? '극도 탐욕 — 고점 경고' : input.fearGreedIndex <= 35 ? '공포 구간' : input.fearGreedIndex >= 65 ? '탐욕 구간' : '중립'})`, timestamp: Date.now() });

  // 연준 금리 기대
  const fedScore = input.fedRateExpectation === 'CUT' ? 50 : input.fedRateExpectation === 'HOLD' ? 10 :
                   input.fedRateExpectation === 'HIKE' ? -50 : 0;
  factors.push({ category: 'MACRO', name: '연준 금리 기대', direction: fedScore > 0 ? 'BULLISH' : fedScore < 0 ? 'BEARISH' : 'NEUTRAL', strength: input.fedRateExpectation !== 'UNKNOWN' ? 'STRONG' : 'WEAK', score: fedScore, weight: 0.20, description: `연준 금리 ${input.fedRateExpectation === 'CUT' ? '인하 기대 → 유동성 확대 호재' : input.fedRateExpectation === 'HIKE' ? '인상 우려 → 위험자산 회피' : '동결 예상 → 중립'}`, timestamp: Date.now() });

  // 예정 이벤트 리스크
  if (input.upcomingEvent && input.eventImpact) {
    const evScore = input.eventImpact === 'HIGH' ? -30 : input.eventImpact === 'MEDIUM' ? -15 : -5;
    factors.push({ category: 'MACRO', name: '예정 이벤트', direction: 'NEUTRAL', strength: input.eventImpact === 'HIGH' ? 'STRONG' : 'MODERATE', score: evScore, weight: 0.15, description: `⚠️ ${input.upcomingEvent} 발표 예정 — 변동성 확대 주의`, timestamp: Date.now() });
  }

  return buildCategoryScore('MACRO', factors);
}

// ─── 4. 유명인/기관 영향 분석 ────────────────────────────────────────────────

export type InfluencerType =
  | 'ELON_MUSK'           // 일론 머스크 (DOGE/BTC 직접 영향)
  | 'TRUMP'               // 트럼프 (친암호화폐 정책)
  | 'MICHAEL_SAYLOR'      // 마이클 세일러 (BTC 매수 발표)
  | 'VITALIK'             // 비탈릭 부테린 (ETH 관련)
  | 'WARREN_BUFFETT'      // 워런 버핏 (부정적 발언)
  | 'CATHIE_WOOD'         // 캐시 우드 (ARK 투자)
  | 'INSTITUTIONAL_BUY'   // 기관 대규모 매수
  | 'ETF_INFLOW'          // 비트코인 ETF 유입
  | 'CORPORATE_ADOPTION'  // 기업 BTC 보유 발표
  | 'CELEBRITY_TWEET'     // 연예인/인플루언서 트윗
  | 'UNKNOWN';

export interface InfluencerEvent {
  type: InfluencerType;
  sentiment: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
  magnitude: 'MAJOR' | 'MODERATE' | 'MINOR'; // 영향 크기
  targetSymbol?: string;  // 특정 종목 (없으면 전체 시장)
  description: string;
  timestamp: number;
  hoursAgo: number;       // 발생 후 경과 시간 (시간이 지날수록 영향 감소)
}

export function analyzeInfluencer(events: InfluencerEvent[], targetSymbol: string): CategoryScore {
  const factors: PriceFactor[] = [];

  // 영향력 매핑
  const INFLUENCER_POWER: Record<InfluencerType, number> = {
    ELON_MUSK: 90,
    TRUMP: 85,
    INSTITUTIONAL_BUY: 80,
    ETF_INFLOW: 75,
    MICHAEL_SAYLOR: 70,
    CORPORATE_ADOPTION: 65,
    CATHIE_WOOD: 55,
    VITALIK: 60,
    CELEBRITY_TWEET: 40,
    WARREN_BUFFETT: 50,
    UNKNOWN: 20,
  };

  const MAGNITUDE_MULT: Record<string, number> = { MAJOR: 1.0, MODERATE: 0.6, MINOR: 0.3 };

  for (const event of events) {
    // 시간 감쇠 (24시간 후 50%, 72시간 후 10%)
    const timeDecay = Math.max(0.1, 1 - (event.hoursAgo / 72) * 0.9);
    const power = INFLUENCER_POWER[event.type] ?? 20;
    const magnitude = MAGNITUDE_MULT[event.magnitude] ?? 0.5;
    const sentimentMult = event.sentiment === 'POSITIVE' ? 1 : event.sentiment === 'NEGATIVE' ? -1 : 0;

    // 특정 종목 vs 전체 시장
    const symbolRelevance = !event.targetSymbol || event.targetSymbol === targetSymbol ? 1.0 :
                            event.targetSymbol === 'BTC' ? 0.6 : 0.3;

    const rawScore = power * magnitude * sentimentMult * timeDecay * symbolRelevance;
    const score = Math.max(-100, Math.min(100, rawScore));

    factors.push({
      category: 'INFLUENCER',
      name: event.type.replace(/_/g, ' '),
      direction: score > 5 ? 'BULLISH' : score < -5 ? 'BEARISH' : 'NEUTRAL',
      strength: Math.abs(score) >= 60 ? 'STRONG' : Math.abs(score) >= 30 ? 'MODERATE' : 'WEAK',
      score,
      weight: 1 / Math.max(1, events.length),
      description: `${event.description} (${event.hoursAgo.toFixed(0)}시간 전, 영향력 ${(timeDecay * 100).toFixed(0)}% 유지)`,
      timestamp: event.timestamp,
    });
  }

  if (factors.length === 0) {
    factors.push({ category: 'INFLUENCER', name: '유명인 이벤트', direction: 'NEUTRAL', strength: 'WEAK', score: 0, weight: 1, description: '최근 유명인/기관 이벤트 없음', timestamp: Date.now() });
  }

  return buildCategoryScore('INFLUENCER', factors);
}

// ─── 5. 규제/정책 분석 ───────────────────────────────────────────────────────

export interface RegulatoryEvent {
  country: string;
  type: 'BAN' | 'RESTRICTION' | 'APPROVAL' | 'ETF_APPROVAL' | 'ETF_REJECTION' | 'TAX' | 'POSITIVE_POLICY' | 'NEUTRAL';
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  description: string;
  hoursAgo: number;
}

export function analyzeRegulatory(events: RegulatoryEvent[]): CategoryScore {
  const factors: PriceFactor[] = [];

  const TYPE_SCORE: Record<string, number> = {
    ETF_APPROVAL: 90, POSITIVE_POLICY: 60, APPROVAL: 50,
    NEUTRAL: 0, TAX: -30, RESTRICTION: -60, BAN: -90, ETF_REJECTION: -70,
  };

  const SEVERITY_MULT: Record<string, number> = { HIGH: 1.0, MEDIUM: 0.6, LOW: 0.3 };
  const COUNTRY_WEIGHT: Record<string, number> = { '미국': 1.0, '한국': 0.7, '유럽': 0.8, '중국': 0.9, '일본': 0.6, '기타': 0.4 };

  for (const event of events) {
    const timeDecay = Math.max(0.1, 1 - (event.hoursAgo / 168) * 0.9); // 7일 감쇠
    const baseScore = TYPE_SCORE[event.type] ?? 0;
    const severity = SEVERITY_MULT[event.severity] ?? 0.5;
    const countryWeight = COUNTRY_WEIGHT[event.country] ?? 0.4;
    const score = Math.max(-100, Math.min(100, baseScore * severity * countryWeight * timeDecay));

    factors.push({
      category: 'REGULATORY',
      name: `${event.country} 규제`,
      direction: score > 5 ? 'BULLISH' : score < -5 ? 'BEARISH' : 'NEUTRAL',
      strength: Math.abs(score) >= 60 ? 'STRONG' : Math.abs(score) >= 30 ? 'MODERATE' : 'WEAK',
      score,
      weight: 1 / Math.max(1, events.length),
      description: event.description,
      timestamp: Date.now(),
    });
  }

  if (factors.length === 0) {
    factors.push({ category: 'REGULATORY', name: '규제 이벤트', direction: 'NEUTRAL', strength: 'WEAK', score: 0, weight: 1, description: '최근 규제 이벤트 없음', timestamp: Date.now() });
  }

  return buildCategoryScore('REGULATORY', factors);
}

// ─── 6. 시장 심리 분석 ───────────────────────────────────────────────────────

export interface SentimentInput {
  socialBuzz: number;       // 소셜 미디어 버즈 점수 0~100 (높을수록 관심)
  searchTrend: number;      // 구글 트렌드 0~100
  redditSentiment: number;  // Reddit 감성 -100~+100
  twitterSentiment: number; // Twitter 감성 -100~+100
  fearGreedIndex: number;   // 0~100
  longBiasRatio: number;    // 0~1 (1=모두 롱)
}

export function analyzeSentiment(input: SentimentInput): CategoryScore {
  const factors: PriceFactor[] = [];

  // 소셜 버즈 (관심도 급증 = 단기 상승 모멘텀)
  const buzzScore = input.socialBuzz >= 80 ? 50 : input.socialBuzz >= 60 ? 25 : input.socialBuzz <= 20 ? -20 : 0;
  factors.push({ category: 'SENTIMENT', name: '소셜 버즈', direction: buzzScore > 0 ? 'BULLISH' : buzzScore < 0 ? 'BEARISH' : 'NEUTRAL', strength: input.socialBuzz >= 80 ? 'STRONG' : 'MODERATE', score: buzzScore, weight: 0.20, description: `소셜 관심도 ${input.socialBuzz}/100 (${input.socialBuzz >= 80 ? '급증 — 단기 상승 모멘텀' : input.socialBuzz <= 20 ? '저조 — 관심 없음' : '보통'})`, timestamp: Date.now() });

  // 소셜 감성 (Reddit + Twitter 평균)
  const avgSentiment = (input.redditSentiment + input.twitterSentiment) / 2;
  const sentScore = avgSentiment > 50 ? 60 : avgSentiment > 20 ? 30 : avgSentiment < -50 ? -60 : avgSentiment < -20 ? -30 : 0;
  factors.push({ category: 'SENTIMENT', name: '소셜 감성', direction: sentScore > 0 ? 'BULLISH' : sentScore < 0 ? 'BEARISH' : 'NEUTRAL', strength: Math.abs(avgSentiment) >= 50 ? 'STRONG' : 'MODERATE', score: sentScore, weight: 0.30, description: `Reddit/Twitter 감성 ${avgSentiment.toFixed(0)} (${avgSentiment > 20 ? '긍정적' : avgSentiment < -20 ? '부정적' : '중립'})`, timestamp: Date.now() });

  // 공포탐욕지수 (역발상)
  const fgScore = input.fearGreedIndex <= 20 ? 70 : input.fearGreedIndex <= 35 ? 35 :
                  input.fearGreedIndex >= 80 ? -70 : input.fearGreedIndex >= 65 ? -35 : 0;
  factors.push({ category: 'SENTIMENT', name: '공포탐욕 역발상', direction: fgScore > 0 ? 'BULLISH' : fgScore < 0 ? 'BEARISH' : 'NEUTRAL', strength: Math.abs(fgScore) >= 60 ? 'STRONG' : 'MODERATE', score: fgScore, weight: 0.30, description: `공포탐욕 ${input.fearGreedIndex} — ${input.fearGreedIndex <= 20 ? '극도 공포 = 역발상 매수' : input.fearGreedIndex >= 80 ? '극도 탐욕 = 역발상 매도' : '중립'}`, timestamp: Date.now() });

  // 롱 편향 비율 (역발상)
  const lbScore = input.longBiasRatio > 0.8 ? -40 : input.longBiasRatio > 0.7 ? -20 :
                  input.longBiasRatio < 0.2 ? 40 : input.longBiasRatio < 0.3 ? 20 : 0;
  factors.push({ category: 'SENTIMENT', name: '롱 편향 역발상', direction: lbScore > 0 ? 'BULLISH' : lbScore < 0 ? 'BEARISH' : 'NEUTRAL', strength: Math.abs(lbScore) >= 35 ? 'STRONG' : 'MODERATE', score: lbScore, weight: 0.20, description: `롱 편향 ${(input.longBiasRatio * 100).toFixed(0)}% (${input.longBiasRatio > 0.8 ? '과도한 롱 — 숏스퀴즈 위험' : input.longBiasRatio < 0.2 ? '과도한 숏 — 숏스퀴즈 가능' : '균형'})`, timestamp: Date.now() });

  return buildCategoryScore('SENTIMENT', factors);
}

// ─── 7. 온체인 데이터 분석 ───────────────────────────────────────────────────

export interface OnChainInput {
  exchangeNetflow: number;    // 거래소 순유입 (양수=유입=매도 압력, 음수=유출=매수 압력)
  whaleTransactions: number;  // 고래 거래 건수 (100BTC+ 이동)
  activeAddresses: number;    // 활성 주소 수 변화율 %
  minerOutflow: number;       // 채굴자 유출 (양수=매도 압력)
  nvtRatio?: number;          // NVT 비율 (높을수록 고평가)
}

export function analyzeOnChain(input: OnChainInput): CategoryScore {
  const factors: PriceFactor[] = [];

  // 거래소 순유입 (음수=유출=매수 압력)
  const netflowScore = input.exchangeNetflow < -1000 ? 60 : input.exchangeNetflow < -500 ? 30 :
                       input.exchangeNetflow > 1000 ? -60 : input.exchangeNetflow > 500 ? -30 : 0;
  factors.push({ category: 'ONCHAIN', name: '거래소 순유입', direction: netflowScore > 0 ? 'BULLISH' : netflowScore < 0 ? 'BEARISH' : 'NEUTRAL', strength: Math.abs(input.exchangeNetflow) >= 1000 ? 'STRONG' : 'MODERATE', score: netflowScore, weight: 0.35, description: `거래소 순유입 ${input.exchangeNetflow > 0 ? '+' : ''}${input.exchangeNetflow.toFixed(0)} BTC (${input.exchangeNetflow < 0 ? '유출 → 장기 보유 신호 (상승)' : '유입 → 매도 압력 (하락)'})`, timestamp: Date.now() });

  // 고래 거래
  const whaleScore = input.whaleTransactions > 20 ? 40 : input.whaleTransactions > 10 ? 20 : 0;
  factors.push({ category: 'ONCHAIN', name: '고래 활동', direction: whaleScore > 0 ? 'BULLISH' : 'NEUTRAL', strength: input.whaleTransactions > 20 ? 'STRONG' : 'WEAK', score: whaleScore, weight: 0.30, description: `고래 거래 ${input.whaleTransactions}건 (${input.whaleTransactions > 10 ? '대규모 이동 감지 — 변동성 주의' : '정상'})`, timestamp: Date.now() });

  // 활성 주소 수
  const addrScore = input.activeAddresses > 20 ? 40 : input.activeAddresses > 10 ? 20 :
                    input.activeAddresses < -20 ? -40 : input.activeAddresses < -10 ? -20 : 0;
  factors.push({ category: 'ONCHAIN', name: '활성 주소', direction: addrScore > 0 ? 'BULLISH' : addrScore < 0 ? 'BEARISH' : 'NEUTRAL', strength: Math.abs(input.activeAddresses) >= 20 ? 'STRONG' : 'MODERATE', score: addrScore, weight: 0.20, description: `활성 주소 ${input.activeAddresses > 0 ? '+' : ''}${input.activeAddresses.toFixed(1)}% (${input.activeAddresses > 10 ? '네트워크 활성화 — 상승 신호' : input.activeAddresses < -10 ? '네트워크 위축 — 하락 신호' : '정상'})`, timestamp: Date.now() });

  // 채굴자 유출
  const minerScore = input.minerOutflow > 500 ? -30 : input.minerOutflow > 200 ? -15 : 0;
  factors.push({ category: 'ONCHAIN', name: '채굴자 유출', direction: minerScore < 0 ? 'BEARISH' : 'NEUTRAL', strength: input.minerOutflow >= 500 ? 'MODERATE' : 'WEAK', score: minerScore, weight: 0.15, description: `채굴자 유출 ${input.minerOutflow.toFixed(0)} BTC (${input.minerOutflow > 200 ? '채굴자 매도 압력' : '정상'})`, timestamp: Date.now() });

  return buildCategoryScore('ONCHAIN', factors);
}

// ─── 8. 프로젝트 이벤트 분석 ─────────────────────────────────────────────────

export interface ProjectEvent {
  type: 'MAINNET_LAUNCH' | 'PARTNERSHIP' | 'HACK' | 'AIRDROP' | 'TOKEN_UNLOCK' | 'LISTING' | 'DELISTING' | 'UPGRADE' | 'BURN' | 'UNKNOWN';
  sentiment: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
  magnitude: 'MAJOR' | 'MODERATE' | 'MINOR';
  description: string;
  hoursAgo: number;
}

export function analyzeProjectEvents(events: ProjectEvent[]): CategoryScore {
  const factors: PriceFactor[] = [];

  const TYPE_SCORE: Record<string, number> = {
    MAINNET_LAUNCH: 80, LISTING: 70, BURN: 60, UPGRADE: 50, PARTNERSHIP: 40, AIRDROP: 30,
    UNKNOWN: 0, TOKEN_UNLOCK: -40, DELISTING: -80, HACK: -90,
  };

  for (const event of events) {
    const timeDecay = Math.max(0.1, 1 - (event.hoursAgo / 48) * 0.9);
    const baseScore = TYPE_SCORE[event.type] ?? 0;
    const sentMult = event.sentiment === 'POSITIVE' ? 1 : event.sentiment === 'NEGATIVE' ? -1 : 0;
    const magMult = event.magnitude === 'MAJOR' ? 1 : event.magnitude === 'MODERATE' ? 0.6 : 0.3;
    const score = Math.max(-100, Math.min(100, baseScore * sentMult * magMult * timeDecay));

    factors.push({
      category: 'PROJECT_EVENT',
      name: event.type.replace(/_/g, ' '),
      direction: score > 5 ? 'BULLISH' : score < -5 ? 'BEARISH' : 'NEUTRAL',
      strength: Math.abs(score) >= 60 ? 'STRONG' : Math.abs(score) >= 30 ? 'MODERATE' : 'WEAK',
      score,
      weight: 1 / Math.max(1, events.length),
      description: event.description,
      timestamp: Date.now(),
    });
  }

  if (factors.length === 0) {
    factors.push({ category: 'PROJECT_EVENT', name: '프로젝트 이벤트', direction: 'NEUTRAL', strength: 'WEAK', score: 0, weight: 1, description: '최근 프로젝트 이벤트 없음', timestamp: Date.now() });
  }

  return buildCategoryScore('PROJECT_EVENT', factors);
}

// ─── 카테고리 점수 계산 헬퍼 ─────────────────────────────────────────────────

function buildCategoryScore(category: FactorCategory, factors: PriceFactor[]): CategoryScore {
  const totalWeight = factors.reduce((s, f) => s + f.weight, 0);
  const weightedScore = totalWeight > 0
    ? factors.reduce((s, f) => s + f.score * (f.weight / totalWeight), 0)
    : 0;

  const dominant = factors.reduce((best, f) =>
    Math.abs(f.score) > Math.abs(best.score) ? f : best, factors[0]);

  return {
    category,
    score: Math.max(-100, Math.min(100, weightedScore)),
    direction: weightedScore > 10 ? 'BULLISH' : weightedScore < -10 ? 'BEARISH' : 'NEUTRAL',
    strength: Math.abs(weightedScore) >= 50 ? 'STRONG' : Math.abs(weightedScore) >= 25 ? 'MODERATE' : 'WEAK',
    dominantFactor: dominant?.name ?? '-',
    factors,
  };
}

// ─── 전체 조합 점수 계산 (핵심 함수) ─────────────────────────────────────────

export interface AllFactorInput {
  technical: TechnicalInput;
  derivatives: DerivativesInput;
  macro: MacroInput;
  sentiment: SentimentInput;
  onChain: OnChainInput;
  influencerEvents?: InfluencerEvent[];
  regulatoryEvents?: RegulatoryEvent[];
  projectEvents?: ProjectEvent[];
  symbol: string;
}

export function calcComboScore(input: AllFactorInput): ComboScore {
  // 각 카테고리 분석
  const techScore = analyzeTechnical(input.technical);
  const derivScore = analyzeDerivatives(input.derivatives);
  const macroScore = analyzeMacro(input.macro);
  const sentScore = analyzeSentiment(input.sentiment);
  const onChainScore = analyzeOnChain(input.onChain);
  const influScore = analyzeInfluencer(input.influencerEvents ?? [], input.symbol);
  const regScore = analyzeRegulatory(input.regulatoryEvents ?? []);
  const projScore = analyzeProjectEvents(input.projectEvents ?? []);

  const categoryScores = [techScore, derivScore, macroScore, sentScore, onChainScore, influScore, regScore, projScore];

  // 가중 평균 총점
  // Claude 검증 v47: 뉴스 API 미연동 시 가중치 재정규화 로직 추가
  // 문제: 뉴스 점수가 0으로 고정되면 전체 신뢰도가 구조적으로 15% 낙게 산출
  // 해결: 뉴스 점수가 0(NEUTRAL)이면 해당 가중치를 나머지 항목에 재분배
  const isNewsAvailable = Math.abs(regScore.score) > 0; // REGULATORY 점수가 0이면 뉴스 미연동
  let weights = { ...BASE_WEIGHTS };
  if (!isNewsAvailable) {
    // 뉴스 가중치(REGULATORY 15%)를 나머지 항목에 비례 재분배
    const newsWeight = BASE_WEIGHTS.REGULATORY; // 0.15
    const remainingTotal = 1 - newsWeight; // 0.85
    const scaleFactor = 1 / remainingTotal; // 1.176...
    weights = {
      TECHNICAL:     BASE_WEIGHTS.TECHNICAL * scaleFactor,
      DERIVATIVES:   BASE_WEIGHTS.DERIVATIVES * scaleFactor,
      ONCHAIN:       BASE_WEIGHTS.ONCHAIN * scaleFactor,
      REGULATORY:    0, // 뉴스 미연동 시 0으로 설정
      MACRO:         BASE_WEIGHTS.MACRO * scaleFactor,
      SENTIMENT:     BASE_WEIGHTS.SENTIMENT * scaleFactor,
      PROJECT_EVENT: BASE_WEIGHTS.PROJECT_EVENT * scaleFactor,
      INFLUENCER:    BASE_WEIGHTS.INFLUENCER * scaleFactor,
    };
  }
  const totalScore =
    techScore.score * weights.TECHNICAL +
    derivScore.score * weights.DERIVATIVES +
    macroScore.score * weights.MACRO +
    sentScore.score * weights.SENTIMENT +
    onChainScore.score * weights.ONCHAIN +
    influScore.score * weights.INFLUENCER +
    regScore.score * weights.REGULATORY +
    projScore.score * weights.PROJECT_EVENT;

  // 방향 일치도 계산 (신뢰도)
  const bullishCount = categoryScores.filter(c => c.direction === 'BULLISH').length;
  const bearishCount = categoryScores.filter(c => c.direction === 'BEARISH').length;
  const neutralCount = categoryScores.filter(c => c.direction === 'NEUTRAL').length;
  const maxAligned = Math.max(bullishCount, bearishCount);
  const alignmentRatio = maxAligned / categoryScores.length;

  // 신뢰도 = 방향 일치도 × 점수 강도
  const baseConfidence = Math.min(100, Math.abs(totalScore) * 0.8 + alignmentRatio * 30);
  // 상충 요인이 많으면 신뢰도 감소
  const conflictPenalty = Math.min(30, (neutralCount + Math.min(bullishCount, bearishCount)) * 5);
  const confidence = Math.max(0, Math.min(100, baseConfidence - conflictPenalty));

  // 상승/하락 요인 목록
  const bullishFactors: string[] = [];
  const bearishFactors: string[] = [];
  const conflictingFactors: string[] = [];

  for (const cat of categoryScores) {
    for (const f of cat.factors) {
      if (f.strength !== 'WEAK') {
        if (f.direction === 'BULLISH') bullishFactors.push(`${f.name}: ${f.description}`);
        else if (f.direction === 'BEARISH') bearishFactors.push(`${f.name}: ${f.description}`);
      }
    }
    // 카테고리 내 상충 감지
    const catBull = cat.factors.filter(f => f.direction === 'BULLISH').length;
    const catBear = cat.factors.filter(f => f.direction === 'BEARISH').length;
    if (catBull > 0 && catBear > 0) {
      conflictingFactors.push(`${cat.category}: 상충 신호 (상승 ${catBull}개 vs 하락 ${catBear}개)`);
    }
  }

  // 수익 가능한 조합 계산
  const optimalCombos = calcOptimalCombos(categoryScores, totalScore);

  // 리스크 레벨
  const riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME' =
    conflictingFactors.length >= 4 || Math.abs(totalScore) < 20 ? 'EXTREME' :
    conflictingFactors.length >= 2 || Math.abs(totalScore) < 40 ? 'HIGH' :
    conflictingFactors.length >= 1 ? 'MEDIUM' : 'LOW';

  // 진입 권장
  const entryRecommended = confidence >= 65 && riskLevel !== 'EXTREME' && Math.abs(totalScore) >= 30;
  const recommendedSide: 'Buy' | 'Sell' | null = entryRecommended
    ? (totalScore > 0 ? 'Buy' : 'Sell')
    : null;

  // 요약
  const summary = buildSummary(totalScore, confidence, bullishFactors.slice(0, 3), bearishFactors.slice(0, 3), riskLevel);

  return {
    totalScore: Math.max(-100, Math.min(100, totalScore)),
    direction: totalScore > 10 ? 'BULLISH' : totalScore < -10 ? 'BEARISH' : 'NEUTRAL',
    confidence,
    entryRecommended,
    recommendedSide,
    categoryScores,
    bullishFactors,
    bearishFactors,
    conflictingFactors,
    optimalCombos,
    riskLevel,
    summary,
  };
}

// ─── 수익 가능한 조합 계산 ────────────────────────────────────────────────────

function calcOptimalCombos(categoryScores: CategoryScore[], totalScore: number): OptimalCombo[] {
  const combos: OptimalCombo[] = [];

  // 조합 1: 기술 + 파생상품 (단기 스캘핑 최적)
  const techDeriv = categoryScores.filter(c => c.category === 'TECHNICAL' || c.category === 'DERIVATIVES');
  const tdAlignment = calcAlignment(techDeriv);
  if (tdAlignment >= 60) {
    combos.push({
      name: '⚡ 스캘핑 조합',
      categories: ['TECHNICAL', 'DERIVATIVES'],
      alignment: tdAlignment,
      expectedReturn: Math.min(30, tdAlignment * 0.3),
      description: '기술 지표 + 파생상품 일치 — 단기 스캘핑 최적 조합',
    });
  }

  // 조합 2: 기술 + 심리 + 파생 (모멘텀 트레이딩)
  const momentumCats = categoryScores.filter(c => ['TECHNICAL', 'SENTIMENT', 'DERIVATIVES'].includes(c.category));
  const momAlignment = calcAlignment(momentumCats);
  if (momAlignment >= 65) {
    combos.push({
      name: '🚀 모멘텀 조합',
      categories: ['TECHNICAL', 'SENTIMENT', 'DERIVATIVES'],
      alignment: momAlignment,
      expectedReturn: Math.min(50, momAlignment * 0.5),
      description: '기술 + 심리 + 파생 일치 — 강한 모멘텀 트레이딩',
    });
  }

  // 조합 3: 매크로 + 온체인 + 기술 (중기 트렌드)
  const trendCats = categoryScores.filter(c => ['MACRO', 'ONCHAIN', 'TECHNICAL'].includes(c.category));
  const trendAlignment = calcAlignment(trendCats);
  if (trendAlignment >= 60) {
    combos.push({
      name: '📈 트렌드 조합',
      categories: ['MACRO', 'ONCHAIN', 'TECHNICAL'],
      alignment: trendAlignment,
      expectedReturn: Math.min(40, trendAlignment * 0.4),
      description: '매크로 + 온체인 + 기술 일치 — 중기 추세 추종',
    });
  }

  // 조합 4: 유명인 이벤트 + 기술 (이벤트 드리븐)
  const influCat = categoryScores.find(c => c.category === 'INFLUENCER');
  const techCat = categoryScores.find(c => c.category === 'TECHNICAL');
  if (influCat && techCat && Math.abs(influCat.score) >= 40 && Math.abs(techCat.score) >= 30) {
    const sameDir = (influCat.score > 0) === (techCat.score > 0);
    if (sameDir) {
      combos.push({
        name: '🌟 이벤트 드리븐 조합',
        categories: ['INFLUENCER', 'TECHNICAL'],
        alignment: 75,
        expectedReturn: Math.min(60, Math.abs(influCat.score) * 0.6),
        description: '유명인/기관 이벤트 + 기술 지표 일치 — 단기 급등 기회',
      });
    }
  }

  // 조합 5: 전체 일치 (최강 조합)
  const allAlignment = calcAlignment(categoryScores);
  if (allAlignment >= 70) {
    combos.push({
      name: '💎 전체 일치 조합',
      categories: ['TECHNICAL', 'DERIVATIVES', 'MACRO', 'SENTIMENT', 'ONCHAIN', 'INFLUENCER', 'REGULATORY', 'PROJECT_EVENT'],
      alignment: allAlignment,
      expectedReturn: Math.min(100, allAlignment * 0.8),
      description: '8대 요소 전체 방향 일치 — 최고 신뢰도 진입 기회',
    });
  }

  return combos.sort((a, b) => b.alignment - a.alignment).slice(0, 3);
}

function calcAlignment(scores: CategoryScore[]): number {
  if (scores.length === 0) return 0;
  const bullCount = scores.filter(s => s.direction === 'BULLISH').length;
  const bearCount = scores.filter(s => s.direction === 'BEARISH').length;
  const maxAligned = Math.max(bullCount, bearCount);
  return Math.round((maxAligned / scores.length) * 100);
}

// ─── 요약 문자열 생성 ─────────────────────────────────────────────────────────

function buildSummary(
  totalScore: number,
  confidence: number,
  topBullish: string[],
  topBearish: string[],
  riskLevel: string,
): string {
  const direction = totalScore > 30 ? '강한 상승' : totalScore > 10 ? '약한 상승' :
                    totalScore < -30 ? '강한 하락' : totalScore < -10 ? '약한 하락' : '횡보';
  const risk = riskLevel === 'LOW' ? '저위험' : riskLevel === 'MEDIUM' ? '중위험' : riskLevel === 'HIGH' ? '고위험' : '극고위험';

  let summary = `[${direction}] 종합점수 ${totalScore.toFixed(0)}/100, 신뢰도 ${confidence.toFixed(0)}%, ${risk}`;
  if (topBullish.length > 0) summary += ` | 상승요인: ${topBullish[0].split(':')[0]}`;
  if (topBearish.length > 0) summary += ` | 하락요인: ${topBearish[0].split(':')[0]}`;
  return summary;
}

// ─── 실시간 간소화 분석 (서버 봇에서 호출용) ─────────────────────────────────
// 온체인/규제/프로젝트 이벤트 없이 빠른 분석

export interface QuickFactorInput {
  rsi: number;
  macd: number;
  macdSignal: number;
  bbPosition: number;
  adx: number;
  volume: number;
  avgVolume: number;
  price: number;
  ema20: number;
  ema50: number;
  ema200: number;
  fundingRate: number;
  openInterestChange: number;
  longShortRatio: number;
  liquidationLong: number;
  liquidationShort: number;
  fearGreedIndex: number;
  dxyChange: number;
  sp500Change: number;
  fedRateExpectation: 'HIKE' | 'HOLD' | 'CUT' | 'UNKNOWN';
  tf15m?: string;
  tf1h?: string;
  tf4h?: string;
  socialBuzz?: number;
  redditSentiment?: number;
  twitterSentiment?: number;
  symbol: string;
  influencerEvents?: InfluencerEvent[];
}

export function calcQuickComboScore(input: QuickFactorInput): {
  score: number;
  confidence: number;
  direction: FactorDirection;
  recommendedSide: 'Buy' | 'Sell' | null;
  topFactors: string[];
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
  optimalComboName?: string;
} {
  const fullInput: AllFactorInput = {
    symbol: input.symbol,
    technical: {
      rsi: input.rsi,
      macd: input.macd,
      macdSignal: input.macdSignal,
      bbPosition: input.bbPosition,
      adx: input.adx,
      stochK: 50, stochD: 50,
      atr: 0,
      price: input.price,
      ema20: input.ema20,
      ema50: input.ema50,
      ema200: input.ema200,
      volume: input.volume,
      avgVolume: input.avgVolume,
      tf15m: input.tf15m,
      tf1h: input.tf1h,
      tf4h: input.tf4h,
    },
    derivatives: {
      fundingRate: input.fundingRate,
      openInterestChange: input.openInterestChange,
      longShortRatio: input.longShortRatio,
      liquidationLong: input.liquidationLong,
      liquidationShort: input.liquidationShort,
    },
    macro: {
      dxyChange: input.dxyChange,
      sp500Change: input.sp500Change,
      goldChange: 0,
      fearGreedIndex: input.fearGreedIndex,
      fedRateExpectation: input.fedRateExpectation,
      inflationTrend: 'STABLE',
    },
    sentiment: {
      socialBuzz: input.socialBuzz ?? 50,
      searchTrend: 50,
      redditSentiment: input.redditSentiment ?? 0,
      twitterSentiment: input.twitterSentiment ?? 0,
      fearGreedIndex: input.fearGreedIndex,
      longBiasRatio: input.longShortRatio / (1 + input.longShortRatio),
    },
    onChain: {
      exchangeNetflow: 0,
      whaleTransactions: 0,
      activeAddresses: 0,
      minerOutflow: 0,
    },
    influencerEvents: input.influencerEvents ?? [],
    regulatoryEvents: [],
    projectEvents: [],
  };

  const combo = calcComboScore(fullInput);

  const topFactors = [
    ...combo.bullishFactors.slice(0, 2),
    ...combo.bearishFactors.slice(0, 2),
  ].map(f => f.split(':')[0]);

  return {
    score: combo.totalScore,
    confidence: combo.confidence,
    direction: combo.direction,
    recommendedSide: combo.recommendedSide,
    topFactors,
    riskLevel: combo.riskLevel,
    optimalComboName: combo.optimalCombos[0]?.name,
  };
}

// ─── 카테고리 한국어 이름 ─────────────────────────────────────────────────────

export const CATEGORY_LABELS: Record<FactorCategory, string> = {
  TECHNICAL: '기술적 지표',
  DERIVATIVES: '파생상품',
  MACRO: '매크로 경제',
  SENTIMENT: '시장 심리',
  ONCHAIN: '온체인',
  INFLUENCER: '유명인/기관',
  REGULATORY: '규제/정책',
  PROJECT_EVENT: '프로젝트 이벤트',
};

export const CATEGORY_ICONS: Record<FactorCategory, string> = {
  TECHNICAL: '📊',
  DERIVATIVES: '📉',
  MACRO: '🌐',
  SENTIMENT: '💭',
  ONCHAIN: '⛓',
  INFLUENCER: '🌟',
  REGULATORY: '⚖️',
  PROJECT_EVENT: '🔧',
};

// ─── 뉴스 중요도 3단계 분류 (AI 검증 v45) ────────────────────────────────────

/**
 * AI 검증 v45 지적:
 * "ETF 승인, 거래소 해킹, 금리 발표의 영향력이 서로 다릅니다.
 *  현재는 모두 뉴스 15%로 묶여 있습니다.
 *  실전에서는 중요 뉴스 / 일반 뉴스 / 루머를 분리해야 합니다."
 *
 * 3단계 분류:
 * - CRITICAL: ETF 승인/거부, 거래소 해킹, 주요국 규제, 연준 금리 결정
 *   → 즉각 15~50% 가격 이동 가능, 가중치 3.0배
 * - NORMAL: 기업 BTC 매수, 파트너십, 업그레이드 발표
 *   → 5~15% 가격 이동, 가중치 1.0배
 * - RUMOR: 미확인 정보, SNS 루머, 익명 소스
 *   → 노이즈 많음, 가중치 0.2배 (신뢰도 낮음)
 */

export type NewsImportance = 'CRITICAL' | 'NORMAL' | 'RUMOR';

export interface NewsItem {
  id: string;
  title: string;
  importance: NewsImportance;
  direction: FactorDirection;
  impactPct: number;        // 예상 가격 영향 % (절댓값)
  hoursAgo: number;
  source: string;           // 출처 (공식/언론/SNS)
  isVerified: boolean;      // 공식 확인 여부
}

export interface NewsAnalysisResult {
  overallScore: number;     // -100 ~ +100
  criticalCount: number;    // 중요 뉴스 수
  normalCount: number;      // 일반 뉴스 수
  rumorCount: number;       // 루머 수
  topNews: NewsItem[];      // 상위 3개 뉴스
  alertLevel: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
  alertMessage: string;
}

// 뉴스 중요도별 가중치
const NEWS_IMPORTANCE_WEIGHT: Record<NewsImportance, number> = {
  CRITICAL: 3.0,   // 중요 뉴스: 3배 가중
  NORMAL: 1.0,     // 일반 뉴스: 기본
  RUMOR: 0.2,      // 루머: 80% 차감 (노이즈 필터)
};

// 뉴스 중요도 자동 분류 (키워드 기반)
export function classifyNewsImportance(title: string, source: string, isVerified: boolean): NewsImportance {
  const titleLower = title.toLowerCase();

  // 루머 판별: 미확인 + SNS 출처
  if (!isVerified && (source.includes('Twitter') || source.includes('Reddit') || source.includes('Telegram'))) {
    return 'RUMOR';
  }

  // 중요 뉴스 키워드
  const criticalKeywords = [
    'etf', 'sec', 'cftc', 'fed', 'federal reserve', 'interest rate',
    'hack', 'hacked', 'exploit', 'stolen', 'breach',
    'ban', 'banned', 'illegal', 'shutdown',
    'approval', 'approved', 'reject', 'rejected',
    'fomc', 'cpi', 'inflation', 'gdp',
    '해킹', 'etf 승인', 'etf 거부', '금리', '규제', '금지', '승인',
  ];

  if (criticalKeywords.some(kw => titleLower.includes(kw))) {
    return 'CRITICAL';
  }

  return 'NORMAL';
}

/**
 * 뉴스 목록 분석 → 가격 영향 점수 계산
 */
export function analyzeNewsImpact(newsItems: NewsItem[]): NewsAnalysisResult {
  if (newsItems.length === 0) {
    return {
      overallScore: 0,
      criticalCount: 0,
      normalCount: 0,
      rumorCount: 0,
      topNews: [],
      alertLevel: 'NONE',
      alertMessage: '최근 주요 뉴스 없음',
    };
  }

  let weightedScore = 0;
  let totalWeight = 0;
  let criticalCount = 0;
  let normalCount = 0;
  let rumorCount = 0;

  for (const news of newsItems) {
    const importanceWeight = NEWS_IMPORTANCE_WEIGHT[news.importance];
    const timeDecay = Math.max(0.1, 1 - (news.hoursAgo / 72) * 0.9); // 3일 감쇠
    const directionSign = news.direction === 'BULLISH' ? 1 : news.direction === 'BEARISH' ? -1 : 0;
    const score = directionSign * news.impactPct * importanceWeight * timeDecay;

    weightedScore += score;
    totalWeight += importanceWeight * timeDecay;

    if (news.importance === 'CRITICAL') criticalCount++;
    else if (news.importance === 'NORMAL') normalCount++;
    else rumorCount++;
  }

  const overallScore = totalWeight > 0
    ? Math.max(-100, Math.min(100, weightedScore / totalWeight))
    : 0;

  // 상위 3개 뉴스 (중요도 + 최신 순)
  const topNews = [...newsItems]
    .sort((a, b) => {
      const importanceOrder = { CRITICAL: 0, NORMAL: 1, RUMOR: 2 };
      const iDiff = importanceOrder[a.importance] - importanceOrder[b.importance];
      if (iDiff !== 0) return iDiff;
      return a.hoursAgo - b.hoursAgo;
    })
    .slice(0, 3);

  // 알림 레벨
  let alertLevel: NewsAnalysisResult['alertLevel'] = 'NONE';
  let alertMessage = '';

  if (criticalCount > 0 && Math.abs(overallScore) >= 50) {
    alertLevel = 'HIGH';
    alertMessage = `⚠️ 중요 뉴스 ${criticalCount}건 — 즉각적인 가격 변동 가능. 포지션 주의`;
  } else if (criticalCount > 0) {
    alertLevel = 'MEDIUM';
    alertMessage = `📢 중요 뉴스 ${criticalCount}건 감지 — 시장 반응 모니터링 중`;
  } else if (normalCount >= 3) {
    alertLevel = 'LOW';
    alertMessage = `📰 일반 뉴스 ${normalCount}건 — 점진적 영향 가능`;
  }

  return {
    overallScore,
    criticalCount,
    normalCount,
    rumorCount,
    topNews,
    alertLevel,
    alertMessage,
  };
}

// ─── 뉴스 방향성 자동 분류 (ChatGPT 검증 v47 반영) ──────────────────────────────

/**
 * ChatGPT 검증 v47 핵심 지적:
 * "뉴스 중요도 ≠ 방향성. ETF 승인 뉴스 → 상승이지만,
 *  ETF 승인 후 차익실현 → 폭락 가능. CRITICAL 뉴스도 방향성을 별도 분류해야 함."
 *
 * 이 함수는 뉴스 제목을 분석하여 BULLISH/BEARISH/NEUTRAL을 자동 분류.
 * 중요도(CRITICAL/NORMAL/RUMOR)와 방향성(BULLISH/BEARISH)을 완전히 분리.
 */
export function classifyNewsDirection(
  title: string,
  source: string = '',
): FactorDirection {
  const t = title.toLowerCase();

  // ─── 강한 상승 신호 ───────────────────────────────────────────────────────
  const bullishKeywords = [
    // ETF/기관
    'etf approved', 'etf approval', 'etf 승인', 'etf 허가',
    'institutional buy', 'institutional purchase', '기관 매수',
    'bitcoin reserve', 'btc reserve', '비트코인 준비금',
    // 규제 완화
    'legalized', 'legal tender', 'regulation approved', '합법화', '법정화폐',
    // 기술 호재
    'mainnet launch', 'upgrade complete', '메인넷 출시', '업그레이드 완료',
    'partnership', 'integration', '파트너십', '통합',
    // 매수
    'buys bitcoin', 'purchases bitcoin', 'adds bitcoin', 'accumulates',
    'btc 매수', '비트코인 매수',
    // 금리 인하
    'rate cut', 'interest rate cut', '금리 인하', 'dovish',
    // 긍정적 경제
    'inflation falls', 'cpi lower', '인플레이션 하락',
  ];

  // ─── 강한 하락 신호 ───────────────────────────────────────────────────────
  const bearishKeywords = [
    // ETF/규제 거부
    'etf rejected', 'etf denial', 'etf 거부', 'etf 반려',
    'sec sues', 'cftc charges', 'sec 소송', '규제 당국 소송',
    // 해킹/보안
    'hacked', 'hack', 'exploit', 'stolen', 'breach', 'vulnerability',
    '해킹', '해킹 당함', '도난', '취약점',
    // 규제 강화
    'ban', 'banned', 'illegal', 'shutdown', 'crackdown',
    '금지', '불법', '단속', '폐쇄',
    // 매도
    'sells bitcoin', 'dumps bitcoin', 'offloads', '비트코인 매도', '투매',
    // 금리 인상
    'rate hike', 'interest rate hike', '금리 인상', 'hawkish',
    // 부정적 경제
    'inflation rises', 'cpi higher', '인플레이션 상승', 'recession',
    // 거래소 문제
    'exchange collapse', 'exchange bankrupt', 'withdrawal suspended',
    '거래소 파산', '출금 중단',
  ];

  // ─── 방향성 점수 계산 ─────────────────────────────────────────────────────
  let bullScore = 0;
  let bearScore = 0;

  for (const kw of bullishKeywords) {
    if (t.includes(kw)) bullScore++;
  }
  for (const kw of bearishKeywords) {
    if (t.includes(kw)) bearScore++;
  }

  // 출처 신뢰도 가중치 (공식 > 언론 > SNS)
  const officialSources = ['sec.gov', 'federalreserve', 'whitehouse', 'congress', 'bitcoin.org'];
  const isOfficial = officialSources.some(s => source.toLowerCase().includes(s));
  if (isOfficial) {
    bullScore *= 1.5;
    bearScore *= 1.5;
  }

  if (bullScore > bearScore) return 'BULLISH';
  if (bearScore > bullScore) return 'BEARISH';
  return 'NEUTRAL';
}

/**
 * 뉴스 방향성 + 중요도 통합 분석
 *
 * ChatGPT v47 지적 반영:
 * CRITICAL 뉴스라도 방향성이 NEUTRAL이면 진입 차단 (방향 불명확)
 * CRITICAL BULLISH → 롱 진입 허용
 * CRITICAL BEARISH → 숏 진입 허용 (또는 롱 차단)
 */
export interface NewsDirectionAnalysis {
  direction: FactorDirection;
  importance: NewsImportance;
  shouldBlockLong: boolean;    // 롱 진입 차단 여부
  shouldBlockShort: boolean;   // 숏 진입 차단 여부
  shouldBlockAll: boolean;     // 전체 진입 차단 (방향 불명확 CRITICAL)
  blockDurationMinutes: number; // 차단 지속 시간 (분)
  reason: string;
}

export function analyzeNewsForEntry(
  newsItems: NewsItem[],
): NewsDirectionAnalysis {
  // 최근 30분 이내 뉴스만 분석
  const recentNews = newsItems.filter(n => n.hoursAgo <= 0.5);

  const defaultResult: NewsDirectionAnalysis = {
    direction: 'NEUTRAL',
    importance: 'NORMAL',
    shouldBlockLong: false,
    shouldBlockShort: false,
    shouldBlockAll: false,
    blockDurationMinutes: 0,
    reason: '최근 30분 내 주요 뉴스 없음',
  };

  if (recentNews.length === 0) return defaultResult;

  // 가장 중요한 뉴스 선택
  const topNews = recentNews.sort((a, b) => {
    const order = { CRITICAL: 0, NORMAL: 1, RUMOR: 2 };
    return order[a.importance] - order[b.importance];
  })[0];

  const direction = topNews.direction !== 'NEUTRAL'
    ? topNews.direction
    : classifyNewsDirection(topNews.title, topNews.source);

  if (topNews.importance === 'CRITICAL') {
    if (direction === 'NEUTRAL') {
      // CRITICAL + 방향 불명확 → 전체 차단 30분
      return {
        direction: 'NEUTRAL',
        importance: 'CRITICAL',
        shouldBlockLong: true,
        shouldBlockShort: true,
        shouldBlockAll: true,
        blockDurationMinutes: 30,
        reason: `⚠️ 중요 뉴스 방향 불명확: "${topNews.title.slice(0, 50)}" — 30분 전체 진입 차단`,
      };
    }
    if (direction === 'BULLISH') {
      // CRITICAL BULLISH → 숏 차단 30분 (롱 허용)
      return {
        direction: 'BULLISH',
        importance: 'CRITICAL',
        shouldBlockLong: false,
        shouldBlockShort: true,
        shouldBlockAll: false,
        blockDurationMinutes: 30,
        reason: `📈 중요 상승 뉴스: "${topNews.title.slice(0, 50)}" — 숏 진입 30분 차단`,
      };
    }
    // CRITICAL BEARISH → 롱 차단 30분 (숏 허용)
    return {
      direction: 'BEARISH',
      importance: 'CRITICAL',
      shouldBlockLong: true,
      shouldBlockShort: false,
      shouldBlockAll: false,
      blockDurationMinutes: 30,
      reason: `📉 중요 하락 뉴스: "${topNews.title.slice(0, 50)}" — 롱 진입 30분 차단`,
    };
  }

  if (topNews.importance === 'NORMAL' && direction !== 'NEUTRAL') {
    // 일반 뉴스 방향성 → 10분 차단
    return {
      direction,
      importance: 'NORMAL',
      shouldBlockLong: direction === 'BEARISH',
      shouldBlockShort: direction === 'BULLISH',
      shouldBlockAll: false,
      blockDurationMinutes: 10,
      reason: `📰 일반 뉴스: "${topNews.title.slice(0, 50)}" — ${direction === 'BULLISH' ? '숏' : '롱'} 진입 10분 차단`,
    };
  }

  return defaultResult;
}
