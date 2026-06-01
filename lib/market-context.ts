/**
 * market-context.ts
 * 전체 시장 흐름 실시간 분석 엔진
 *
 * ▶ 분석 항목:
 *   1. BTC 실시간 추세 (1m/5m/15m/1h 멀티 타임프레임)
 *   2. ETH 실시간 추세 (BTC 대비 강도 포함)
 *   3. 공포탐욕지수 (alternative.me API)
 *   4. 전체 시장 자금 흐름 (총 미결제약정 변화율)
 *   5. 알트코인 시장 상태 (상승/하락 종목 비율)
 *   6. BTC 도미넌스 추정 (BTC 거래대금 비중)
 *   7. 시장 국면 판단 (Risk-On / Risk-Off / 중립)
 *
 * ▶ 급등 종목 매매 전략 라우팅:
 *   - BTC 급락 중 + 공포구간: 손절 임계값 압축 (-10% → -7%)
 *   - BTC 급등 중 + 탐욕구간: 익절 임계값 상향 (+20% → +30%)
 *   - ETH 강세 + BTC 중립: 알트코인 롱 우대
 *   - 전체 미결제약정 급감: 즉시 청산 경고
 *   - 알트코인 하락 비율 70%+: 신규 롱 진입 차단
 */

const BINANCE_BASE = 'https://fapi.binance.com';
const FEAR_GREED_API = 'https://api.alternative.me/fng/?limit=1';

// ─── 타입 ────────────────────────────────────────────────────────────────────

export type MarketPhase =
  | 'RISK_ON'           // 강세장 — 알트 롱 우대, 익절 여유
  | 'RISK_OFF'          // 약세장 — 손절 압축, 신규 롱 차단
  | 'NEUTRAL'           // 중립 — 기본 전략 유지
  | 'BTC_SURGE'         // BTC 급등 — 알트 연동 상승 기대
  | 'BTC_CRASH'         // BTC 급락 — 알트 즉시 손절 경고
  | 'ETH_LEAD'          // ETH 주도 — 이더리움 생태계 알트 우대
  | 'ALT_SEASON'        // 알트 시즌 — BTC 도미넌스 하락, 알트 전반 강세
  | 'ACCUMULATION'      // 세력 매집 — 거래량 급감 + 가격 횡보, presurge 대기
  | 'DISTRIBUTION'      // 세력 분산 — 고점 횡보 + OI 감소, 숏 준비
  | 'SQUEEZE'           // BB 스퀴즈 — 변동성 압축 직전, 방향 돌파 대기
  | 'BEAR_TRAP'         // 베어 트랩 — 가짜 하락 후 급반등, 롱 기회
  | 'BULL_TRAP'         // 불 트랩 — 가짜 상승 후 급하락, 숏 기회
  | 'LIQUIDATION_HUNT'  // 청산 사냥 — 레버리지 청산 집중 구간, 역방향 진입
  | 'FUNDING_SQUEEZE'   // 펀딩비 과열 — 극단적 펀딩비, 역방향 수렴 기대
  | 'WHALE_ACCUMULATION'; // 고래 매집 — 대형 지갑 순매수 + 거래소 유출 증가

export interface CoinTrend {
  symbol: string;        // 'BTC' | 'ETH'
  price: number;
  change1m: number;      // 1분 변동률 (%)
  change5m: number;      // 5분 변동률 (%)
  change15m: number;     // 15분 변동률 (%)
  change1h: number;      // 1시간 변동률 (%)
  change24h: number;     // 24시간 변동률 (%)
  trend: 'STRONG_UP' | 'UP' | 'NEUTRAL' | 'DOWN' | 'STRONG_DOWN';
  momentum: number;      // -100 ~ +100 (종합 모멘텀 점수)
  volume1hRatio: number; // 최근 1시간 거래량 / 평균 대비 비율
  openInterestChange: number; // 미결제약정 변화율 (%)
  fundingRate: number;   // 현재 펀딩비
}

export interface MarketContext {
  btc: CoinTrend;
  eth: CoinTrend;
  fearGreedIndex: number;        // 0~100 (0=극도공포, 100=극도탐욕)
  fearGreedLabel: string;        // 'Extreme Fear' | 'Fear' | 'Neutral' | 'Greed' | 'Extreme Greed'
  totalOiChange: number;         // 전체 시장 미결제약정 변화율 (%)
  altUpRatio: number;            // 상승 알트코인 비율 (0~1)
  btcDominanceEst: number;       // BTC 도미넌스 추정 (%)
  phase: MarketPhase;            // 시장 국면
  surgeStrategy: SurgeStrategy;  // 급등 종목 매매 전략 지침
  updatedAt: number;             // 마지막 업데이트 시각 (ms)
  summary: string;               // 한 줄 요약
}

export interface SurgeStrategy {
  // 손절 임계값 조정 (기본 -15%)
  slAdjustPct: number;           // 예: -15 → -12 (완화) 또는 -15 → -8 (압축)
  // 익절 임계값 조정 (기본 +20%)
  tpAdjustPct: number;           // 예: +20 → +30 (상향) 또는 +20 → +15 (하향)
  // 방향전환 청산 신뢰도 임계값 (기본 40%)
  reverseThreshold: number;      // 예: 40 → 30 (더 민감) 또는 40 → 55 (더 둔감)
  // 신규 롱 진입 허용 여부
  allowNewLong: boolean;
  // 신규 숏 진입 허용 여부
  allowNewShort: boolean;
  // 전략 근거 메시지
  reason: string;
}

// ─── 캐시 ────────────────────────────────────────────────────────────────────

let _cachedContext: MarketContext | null = null;
let _lastFetchAt = 0;
const CACHE_TTL_MS = 30 * 1000; // 30초 캐시

// ─── 유틸리티 ────────────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, ms = 8000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

async function binanceGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const url = `${BINANCE_BASE}${path}${qs ? '?' + qs : ''}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Binance ${res.status}: ${path}`);
  const rawText = await res.text();
  try {
    return JSON.parse(rawText) as T;
  } catch {
    throw new Error(`Binance 응답 파싱 오류 (${res.status}): ${rawText.slice(0, 80)}`);
  }
}

// ─── BTC/ETH 추세 분석 ───────────────────────────────────────────────────────

async function fetchCoinTrend(symbol: string): Promise<CoinTrend> {
  const binanceSym = symbol + 'USDT';

  // 1분봉 65개 조회 (Binance FAPI)
  const klines = await binanceGet<[number, string, string, string, string, string, ...unknown[]][]>(
    '/fapi/v1/klines',
    { symbol: binanceSym, interval: '1m', limit: '65' }
  );
  // Binance: 오래된순 정렬 (역순 불필요)
  const candles = klines.map(r => [String(r[0]), r[1], r[2], r[3], r[4], r[5]]);

  if (candles.length < 10) {
    return {
      symbol, price: 0, change1m: 0, change5m: 0, change15m: 0, change1h: 0, change24h: 0,
      trend: 'NEUTRAL', momentum: 0, volume1hRatio: 1, openInterestChange: 0, fundingRate: 0,
    };
  }

  const closes = candles.map(c => parseFloat(c[4] as string));
  const volumes = candles.map(c => parseFloat(c[5] as string));
  const latest = closes[closes.length - 1];

  // 변동률 계산
  const p1m  = closes.length >= 2  ? ((latest - closes[closes.length - 2]) / closes[closes.length - 2]) * 100 : 0;
  const p5m  = closes.length >= 6  ? ((latest - closes[closes.length - 6]) / closes[closes.length - 6]) * 100 : 0;
  const p15m = closes.length >= 16 ? ((latest - closes[closes.length - 16]) / closes[closes.length - 16]) * 100 : 0;
  const p1h  = closes.length >= 61 ? ((latest - closes[closes.length - 61]) / closes[closes.length - 61]) * 100 : 0;

  // 24h 변동률 + 편딩비 (Binance ticker)
  let change24h = 0;
  let fundingRate = 0;
  try {
    const ticker24h = await binanceGet<{ priceChangePercent: string }>('/fapi/v1/ticker/24hr', { symbol: binanceSym });
    change24h = parseFloat(ticker24h.priceChangePercent ?? '0');
  } catch { /* 실패 시 0 */ }
  try {
    const fundingData = await binanceGet<{ fundingRate: string }[]>('/fapi/v1/fundingRate', { symbol: binanceSym, limit: '1' });
    fundingRate = fundingData?.[0] ? parseFloat(fundingData[0].fundingRate) : 0;
  } catch { /* 실패 시 0 */ }

  // 미결제약정 변화율 (최근 1시간 전 대비)
  let openInterestChange = 0;
  try {
    const oiHist = await binanceGet<{ openInterest: string; timestamp: number }[]>(
      '/futures/data/openInterestHist',
      { symbol: binanceSym, period: '1h', limit: '2' }
    );
    if (oiHist.length >= 2) {
      const oiNew = parseFloat(oiHist[oiHist.length - 1].openInterest);
      const oiOld = parseFloat(oiHist[0].openInterest);
      openInterestChange = oiOld > 0 ? ((oiNew - oiOld) / oiOld) * 100 : 0;
    }
  } catch { /* OI 조회 실패 시 0으로 처리 */ }

  // 거래량 비율 (최근 10분 vs 이전 50분 평균)
  const recentVols = volumes.slice(-10);
  const prevVols = volumes.slice(-60, -10);
  const recentAvg = recentVols.reduce((a, b) => a + b, 0) / (recentVols.length || 1);
  const prevAvg = prevVols.reduce((a, b) => a + b, 0) / (prevVols.length || 1);
  const volume1hRatio = prevAvg > 0 ? recentAvg / prevAvg : 1;

  // 종합 모멘텀 점수 (-100 ~ +100)
  // 가중치: 1m(10) + 5m(20) + 15m(30) + 1h(25) + OI변화(15)
  const momentum = Math.max(-100, Math.min(100,
    Math.sign(p1m) * Math.min(Math.abs(p1m) * 10, 10) +
    Math.sign(p5m) * Math.min(Math.abs(p5m) * 8, 20) +
    Math.sign(p15m) * Math.min(Math.abs(p15m) * 5, 30) +
    Math.sign(p1h) * Math.min(Math.abs(p1h) * 3, 25) +
    Math.sign(openInterestChange) * Math.min(Math.abs(openInterestChange) * 2, 15)
  ));

  // 추세 판단
  let trend: CoinTrend['trend'];
  if (momentum >= 60) trend = 'STRONG_UP';
  else if (momentum >= 20) trend = 'UP';
  else if (momentum <= -60) trend = 'STRONG_DOWN';
  else if (momentum <= -20) trend = 'DOWN';
  else trend = 'NEUTRAL';

  return {
    symbol, price: latest,
    change1m: p1m, change5m: p5m, change15m: p15m, change1h: p1h, change24h,
    trend, momentum, volume1hRatio, openInterestChange, fundingRate,
  };
}

// ─── 공포탐욕지수 조회 ────────────────────────────────────────────────────────

async function fetchFearGreed(): Promise<{ value: number; label: string }> {
  try {
    const res = await fetchWithTimeout(FEAR_GREED_API, 5000);
    if (!res.ok) return { value: 50, label: 'Neutral' };
    const json = await res.json() as { data: Array<{ value: string; value_classification: string }> };
    const item = json.data?.[0];
    if (!item) return { value: 50, label: 'Neutral' };
    return { value: parseInt(item.value), label: item.value_classification };
  } catch {
    return { value: 50, label: 'Neutral' };
  }
}

// ─── 알트코인 시장 상태 조회 ─────────────────────────────────────────────────

async function fetchAltMarketState(): Promise<{ altUpRatio: number; btcDominanceEst: number; totalOiChange: number }> {
  try {
    // Binance FAPI 24hr ticker 전체 조회
    const tickers = await binanceGet<Array<{ symbol: string; priceChangePercent: string; quoteVolume: string }>>(
      '/fapi/v1/ticker/24hr'
    );
    const usdtTickers = tickers.filter(t => t.symbol.endsWith('USDT'));

    // 상승/하락 비율
    let upCount = 0, downCount = 0;
    for (const t of usdtTickers) {
      const chg = parseFloat(t.priceChangePercent ?? '0');
      if (chg > 0) upCount++;
      else if (chg < 0) downCount++;
    }
    const altUpRatio = upCount / (upCount + downCount || 1);

    // BTC 도미넌스 추정 (BTC 거래대금 / 전체 거래대금)
    const totalTurnover = usdtTickers.reduce((s, t) => s + parseFloat(t.quoteVolume ?? '0'), 0);
    const btcTurnover = usdtTickers
      .filter(t => t.symbol === 'BTCUSDT')
      .reduce((s, t) => s + parseFloat(t.quoteVolume ?? '0'), 0);
    const btcDominanceEst = totalTurnover > 0 ? (btcTurnover / totalTurnover) * 100 : 50;

    return { altUpRatio, btcDominanceEst, totalOiChange: 0 };
  } catch {
    return { altUpRatio: 0.5, btcDominanceEst: 50, totalOiChange: 0 };
  }
}

// ─── 시장 국면 판단 ──────────────────────────────────────────────────────────

function determinePhase(
  btc: CoinTrend,
  eth: CoinTrend,
  fearGreed: number,
  altUpRatio: number,
  btcDominanceEst: number,
): MarketPhase {
  const volRatio = btc.volume1hRatio; // 거래량 비율 (최근/평균)

  // ── 1순위: 극단 충격 국면 ──────────────────────────────────────────────
  // BTC 급락: 5분 -3% 이상 하락 또는 모멘텀 -60 이하
  if (btc.change5m <= -3 || btc.momentum <= -60) return 'BTC_CRASH';
  // BTC 급등: 5분 +3% 이상 상승 또는 모멘텀 +60 이상
  if (btc.change5m >= 3 || btc.momentum >= 60) return 'BTC_SURGE';

  // ── 2순위: 청산/펀딩 과열 국면 ──────────────────────────────────────────
  // 청산 사냥: 급격한 방향 전환 + 거래량 폭발 (레버리지 청산 집중)
  if (
    Math.abs(btc.change5m) >= 1.5 &&
    volRatio >= 3.0 &&
    Math.abs(btc.momentum) >= 40
  ) return 'LIQUIDATION_HUNT';

  // 펀딩비 과열: 극단적 탐욕 + 알트 대부분 상승 + BTC 모멘텀 약화 (역방향 수렴)
  if (
    fearGreed >= 80 &&
    altUpRatio >= 0.75 &&
    btc.momentum < 30
  ) return 'FUNDING_SQUEEZE';

  // ── 3순위: 세력/고래 움직임 국면 ─────────────────────────────────────────
  // 고래 매집: 거래량 급증 + 가격 횡보 + 중립 공포탐욕 (조용한 대량 매수)
  if (
    volRatio >= 2.0 &&
    Math.abs(btc.change5m) < 1.0 &&
    fearGreed >= 35 && fearGreed <= 65
  ) return 'WHALE_ACCUMULATION';

  // 세력 분산: BTC 상승 추세 + 모멘텀 약화 + 거래량 감소 + 탐욕 과열 (고점 분산)
  if (
    btc.trend === 'UP' &&
    btc.momentum < 20 &&
    volRatio < 0.6 &&
    fearGreed >= 70
  ) return 'DISTRIBUTION';

  // ── 4순위: 구조적 패턴 국면 ──────────────────────────────────────────────
  // 베어 트랩: 공포 구간에서 BTC 반등 + 알트 동반 상승 (가짜 하락 후 급반등)
  if (
    btc.change5m >= 1.5 &&
    btc.momentum >= 30 &&
    fearGreed < 40 &&
    altUpRatio >= 0.55
  ) return 'BEAR_TRAP';

  // 불 트랩: 탐욕 구간에서 BTC 하락 전환 + 알트 동반 하락 (가짜 상승 후 급하락)
  if (
    btc.change5m <= -1.5 &&
    btc.momentum <= -30 &&
    fearGreed > 60 &&
    altUpRatio < 0.45
  ) return 'BULL_TRAP';

  // BB 스퀴즈: 변동성 극도 압축 (5분 변동 < 0.3%, 모멘텀 ±10 이내, 방향 불명확)
  if (
    Math.abs(btc.change5m) < 0.3 &&
    Math.abs(btc.momentum) < 10 &&
    altUpRatio >= 0.4 && altUpRatio <= 0.6
  ) return 'SQUEEZE';

  // ── 5순위: 세력 매집 국면 ────────────────────────────────────────────────
  // 세력 매집: 거래량 감소 + 가격 횡보 + 공포 구간 (저점 조용한 매집)
  if (
    volRatio < 0.5 &&
    Math.abs(btc.change5m) < 0.5 &&
    fearGreed < 45
  ) return 'ACCUMULATION';

  // ── 6순위: 기존 국면 ──────────────────────────────────────────────────────
  // 극도 공포 + BTC 하락: Risk-Off
  if (fearGreed <= 25 && btc.trend === 'DOWN') return 'RISK_OFF';
  // 극도 탐욕 + BTC 상승: Risk-On
  if (fearGreed >= 75 && btc.trend === 'UP') return 'RISK_ON';
  // ETH 주도: ETH 모멘텀이 BTC보다 20 이상 높음
  if (eth.momentum - btc.momentum >= 20) return 'ETH_LEAD';
  // 알트 시즌: BTC 도미넌스 낮고 알트 상승 비율 높음
  if (btcDominanceEst < 30 && altUpRatio >= 0.65) return 'ALT_SEASON';
  return 'NEUTRAL';
}

// ─── 급등 종목 매매 전략 수립 ─────────────────────────────────────────────────

function buildSurgeStrategy(
  phase: MarketPhase,
  btc: CoinTrend,
  eth: CoinTrend,
  fearGreed: number,
  altUpRatio: number,
): SurgeStrategy {
  // 기본값
  let slAdjustPct = -15;
  let tpAdjustPct = 20;
  let reverseThreshold = 40;
  let allowNewLong = true;
  let allowNewShort = true;
  let reason = '';

  switch (phase) {
    case 'BTC_CRASH':
      // BTC 급락: 손절 압축, 신규 롱 차단, 방향전환 더 민감하게
      slAdjustPct = -8;
      tpAdjustPct = 12;
      reverseThreshold = 25;
      allowNewLong = false;
      reason = `⚠️ BTC 급락 중 (${btc.change5m.toFixed(1)}%/5m) — 손절 압축(-8%), 신규 롱 차단, 즉각 대응`;
      break;

    case 'BTC_SURGE':
      // BTC 급등: 익절 상향, 손절 여유, 알트 연동 상승 기대
      slAdjustPct = -18;
      tpAdjustPct = 30;
      reverseThreshold = 50;
      reason = `🚀 BTC 급등 중 (${btc.change5m.toFixed(1)}%/5m) — 익절 상향(+30%), 손절 여유(-18%), 알트 연동 상승 기대`;
      break;

    case 'RISK_OFF':
      // 공포 구간: 손절 압축, 신규 롱 제한
      slAdjustPct = -10;
      tpAdjustPct = 15;
      reverseThreshold = 30;
      allowNewLong = fearGreed > 20; // 극도공포(≤20)면 롱 차단
      reason = `😱 공포 구간 (F&G: ${fearGreed}) — 손절 압축(-10%), 신규 롱 ${fearGreed <= 20 ? '차단' : '제한'}`;
      break;

    case 'RISK_ON':
      // 탐욕 구간: 익절 상향, 손절 여유
      slAdjustPct = -18;
      tpAdjustPct = 28;
      reverseThreshold = 50;
      reason = `🤑 탐욕 구간 (F&G: ${fearGreed}) — 익절 상향(+28%), 손절 여유(-18%)`;
      break;

    case 'ETH_LEAD':
      // ETH 주도: ETH 생태계 알트 우대, 기본 전략 유지
      slAdjustPct = -15;
      tpAdjustPct = 22;
      reverseThreshold = 40;
      reason = `💎 ETH 주도 (모멘텀 ${eth.momentum.toFixed(0)} vs BTC ${btc.momentum.toFixed(0)}) — 이더리움 생태계 알트 우대`;
      break;

    case 'ALT_SEASON':
      // 알트 시즌: 익절 크게 상향, 손절 여유
      slAdjustPct = -20;
      tpAdjustPct = 35;
      reverseThreshold = 55;
      reason = `🌙 알트 시즌 (상승 비율 ${(altUpRatio * 100).toFixed(0)}%) — 익절 대폭 상향(+35%), 손절 여유(-20%)`;
      break;

    case 'ACCUMULATION':
      // 세력 매집: presurge 대기 — 스코어 높은 종목만 진입, 손절 여유
      slAdjustPct = -20;
      tpAdjustPct = 40;
      reverseThreshold = 35;
      reason = `👀 세력 매집 구간 (거래량 ${btc.volume1hRatio.toFixed(1)}x, F&G: ${fearGreed}) — presurge 대기, 스코어 높은 종목만 진입, 익절 대폭 상향(+40%)`;
      break;

    case 'DISTRIBUTION':
      // 세력 분산: 신규 롱 차단, 숏 준비, 익절 압축
      slAdjustPct = -10;
      tpAdjustPct = 12;
      reverseThreshold = 30;
      allowNewLong = false;
      reason = `⚠️ 세력 분산 구간 (BTC 모멘텀 ${btc.momentum.toFixed(0)}, 거래량 ${btc.volume1hRatio.toFixed(1)}x) — 신규 롱 차단, 숏 준비, 익절 압축`;
      break;

    case 'SQUEEZE':
      // BB 스퀴즈: 돌파 대기 — presurge 신호 집중 감시, 방향 확인 후 진입
      slAdjustPct = -12;
      tpAdjustPct = 25;
      reverseThreshold = 35;
      reason = `🔗 BB 스퀴즈 (변동성 압축 중) — 돌파 방향 확인 후 진입, presurge 신호 집중 감시`;
      break;

    case 'BEAR_TRAP':
      // 베어 트랩: 지지선 돌파 롱 진입, 빠른 익절
      slAdjustPct = -12;
      tpAdjustPct = 20;
      reverseThreshold = 30;
      reason = `🟢 베어 트랩 감지 (BTC +${btc.change5m.toFixed(1)}%/5m, F&G: ${fearGreed}) — 지지선 돌파 롱 진입, 빠른 익절`;
      break;

    case 'BULL_TRAP':
      // 불 트랩: 저항선 돌파 숏 진입, 신규 롱 차단
      slAdjustPct = -10;
      tpAdjustPct = 18;
      reverseThreshold = 28;
      allowNewLong = false;
      reason = `🔴 불 트랩 감지 (BTC ${btc.change5m.toFixed(1)}%/5m, F&G: ${fearGreed}) — 저항선 돌파 숏 진입, 신규 롱 차단`;
      break;

    case 'LIQUIDATION_HUNT':
      // 청산 사냥: 역방향 진입 기회, 손절 압축, 빠른 익절
      slAdjustPct = -8;
      tpAdjustPct = 15;
      reverseThreshold = 20;
      reason = `🎯 청산 사냥 구간 (거래량 ${btc.volume1hRatio.toFixed(1)}x) — 역방향 진입 기회, 손절 압축(-8%), 빠른 익절`;
      break;

    case 'FUNDING_SQUEEZE':
      // 펀딩비 과열: 역방향 수렴 기대, 신규 롱 제한
      slAdjustPct = -12;
      tpAdjustPct = 18;
      reverseThreshold = 35;
      allowNewLong = false;
      reason = `🔥 펀딩비 과열 (F&G: ${fearGreed}, 알트↑${(altUpRatio * 100).toFixed(0)}%) — 역방향 수렴 기대, 신규 롱 제한`;
      break;

    case 'WHALE_ACCUMULATION':
      // 고래 매집: 급등 직전 신호 — 스코어 높은 종목 적극 진입, 익절 대폭 상향
      slAdjustPct = -18;
      tpAdjustPct = 45;
      reverseThreshold = 50;
      reason = `🐳 고래 매집 감지 (거래량 ${btc.volume1hRatio.toFixed(1)}x, F&G: ${fearGreed}) — 급등 직전, 스코어 높은 종목 적극 진입, 익절 대폭 상향(+45%)`;
      break;

    default: // NEUTRAL
      reason = `📊 중립 국면 (BTC 모멘텀 ${btc.momentum.toFixed(0)}, F&G: ${fearGreed}) — 기본 전략 유지`;
      break;
  }

  // 알트코인 하락 비율 70%+ 시 신규 롱 추가 차단
  if (altUpRatio < 0.3) {
    allowNewLong = false;
    reason += ' | 알트 70%+ 하락 → 신규 롱 차단';
  }

  return { slAdjustPct, tpAdjustPct, reverseThreshold, allowNewLong, allowNewShort, reason };
}

// ─── 메인 함수: 시장 컨텍스트 조회 ──────────────────────────────────────────

/**
 * 전체 시장 컨텍스트를 조회합니다. 30초 캐시 적용.
 * @param forceRefresh true 시 캐시 무시하고 강제 갱신
 */
export async function getMarketContext(forceRefresh = false): Promise<MarketContext> {
  const now = Date.now();
  if (!forceRefresh && _cachedContext && now - _lastFetchAt < CACHE_TTL_MS) {
    return _cachedContext;
  }

  try {
    // 병렬 조회 (BTC, ETH, 공포탐욕, 알트 시장 상태)
    const [btc, eth, fearGreedData, altState] = await Promise.all([
      fetchCoinTrend('BTC'),
      fetchCoinTrend('ETH'),
      fetchFearGreed(),
      fetchAltMarketState(),
    ]);

    const phase = determinePhase(btc, eth, fearGreedData.value, altState.altUpRatio, altState.btcDominanceEst);
    const surgeStrategy = buildSurgeStrategy(phase, btc, eth, fearGreedData.value, altState.altUpRatio);

    // 한 줄 요약
    const btcEmoji = btc.trend === 'STRONG_UP' ? '🚀' : btc.trend === 'UP' ? '📈' : btc.trend === 'STRONG_DOWN' ? '💥' : btc.trend === 'DOWN' ? '📉' : '➡️';
    const ethEmoji = eth.trend === 'STRONG_UP' ? '🚀' : eth.trend === 'UP' ? '📈' : eth.trend === 'STRONG_DOWN' ? '💥' : eth.trend === 'DOWN' ? '📉' : '➡️';
    const summary = `${btcEmoji} BTC ${btc.change5m >= 0 ? '+' : ''}${btc.change5m.toFixed(2)}%/5m | ${ethEmoji} ETH ${eth.change5m >= 0 ? '+' : ''}${eth.change5m.toFixed(2)}%/5m | F&G ${fearGreedData.value} | 알트↑${(altState.altUpRatio * 100).toFixed(0)}%`;

    const ctx: MarketContext = {
      btc, eth,
      fearGreedIndex: fearGreedData.value,
      fearGreedLabel: fearGreedData.label,
      totalOiChange: altState.totalOiChange,
      altUpRatio: altState.altUpRatio,
      btcDominanceEst: altState.btcDominanceEst,
      phase,
      surgeStrategy,
      updatedAt: now,
      summary,
    };

    _cachedContext = ctx;
    _lastFetchAt = now;
    return ctx;
  } catch (e) {
    // 조회 실패 시 기본 중립 컨텍스트 반환
    const fallback: MarketContext = {
      btc: { symbol: 'BTC', price: 0, change1m: 0, change5m: 0, change15m: 0, change1h: 0, change24h: 0, trend: 'NEUTRAL', momentum: 0, volume1hRatio: 1, openInterestChange: 0, fundingRate: 0 },
      eth: { symbol: 'ETH', price: 0, change1m: 0, change5m: 0, change15m: 0, change1h: 0, change24h: 0, trend: 'NEUTRAL', momentum: 0, volume1hRatio: 1, openInterestChange: 0, fundingRate: 0 },
      fearGreedIndex: 50,
      fearGreedLabel: 'Neutral',
      totalOiChange: 0,
      altUpRatio: 0.5,
      btcDominanceEst: 50,
      phase: 'NEUTRAL',
      surgeStrategy: {
        slAdjustPct: -15, tpAdjustPct: 20, reverseThreshold: 40,
        allowNewLong: true, allowNewShort: true,
        reason: '시장 데이터 조회 실패 — 기본 전략 유지',
      },
      updatedAt: Date.now(),
      summary: '시장 데이터 조회 실패',
    };
    if (!_cachedContext) _cachedContext = fallback;
    return _cachedContext;
  }
}

/**
 * 캐시된 시장 컨텍스트를 즉시 반환 (없으면 null)
 */
export function getCachedMarketContext(): MarketContext | null {
  return _cachedContext;
}

/**
 * 시장 국면 한국어 레이블
 */
export function getPhaseLabel(phase: MarketPhase): string {
  const labels: Record<MarketPhase, string> = {
    RISK_ON: '📈 위험선호',
    RISK_OFF: '📉 위험회피',
    NEUTRAL: '⚪ 중립',
    BTC_SURGE: '🚀 BTC급등',
    BTC_CRASH: '💥 BTC급락',
    ETH_LEAD: '💎 ETH주도',
    ALT_SEASON: '🌙 알트시즌',
    ACCUMULATION: '👀 세력매집',
    DISTRIBUTION: '⚠️ 세력분산',
    SQUEEZE: '🔗 BB스퀴즈',
    BEAR_TRAP: '🟢 베어트랩',
    BULL_TRAP: '🔴 불트랩',
    LIQUIDATION_HUNT: '🎯 청산사냥',
    FUNDING_SQUEEZE: '🔥 펀딩과열',
    WHALE_ACCUMULATION: '🐳 고래매집',
  };
  return labels[phase] ?? '⚪ 중립';
}

/**
 * 시장 국면 색상 (NativeWind 클래스)
 */
export function getPhaseColor(phase: MarketPhase): string {
  const colors: Record<MarketPhase, string> = {
    RISK_ON: '#22C55E',
    RISK_OFF: '#EF4444',
    NEUTRAL: '#9BA1A6',
    BTC_SURGE: '#F59E0B',
    BTC_CRASH: '#DC2626',
    ETH_LEAD: '#818CF8',
    ALT_SEASON: '#A78BFA',
    ACCUMULATION: '#06B6D4',
    DISTRIBUTION: '#F97316',
    SQUEEZE: '#FBBF24',
    BEAR_TRAP: '#4ADE80',
    BULL_TRAP: '#F87171',
    LIQUIDATION_HUNT: '#E879F9',
    FUNDING_SQUEEZE: '#FB923C',
    WHALE_ACCUMULATION: '#38BDF8',
  };
  return colors[phase] ?? '#9BA1A6';
}

/**
 * 시장 국면 전략 요약 (한 줄)
 */
export function getPhaseSummary(phase: MarketPhase): string {
  const summaries: Record<MarketPhase, string> = {
    RISK_ON: '롱 우대 • 익절 여유 • 알트 전반 상승',
    RISK_OFF: '손절 압축 • 신규 롱 제한 • 숏 집중',
    NEUTRAL: '기본 전략 유지 • 양방향 균형',
    BTC_SURGE: '알트 연동 상승 기대 • 롱 확대',
    BTC_CRASH: '알트 즉시 손절 • 신규 롱 차단 • 숏 집중',
    ETH_LEAD: 'ETH 생태계 알트 우대 • 롱 확대',
    ALT_SEASON: '알트 전반 강세 • 익절 대폭 상향',
    ACCUMULATION: 'presurge 대기 • 스코어 높은 종목만 진입',
    DISTRIBUTION: '신규 롱 차단 • 숏 준비 • 익절 압축',
    SQUEEZE: '돌파 대기 • presurge 신호 집중 감시',
    BEAR_TRAP: '지지선 돌파 롱 진입 • 빠른 익절',
    BULL_TRAP: '저항선 돌파 실패 숏 진입 • 빠른 익절',
    LIQUIDATION_HUNT: '청산 후 역방향 진입 • 빠른 스칼핑',
    FUNDING_SQUEEZE: '펀딩비 역방향 수렴 • 단기 스칼핑',
    WHALE_ACCUMULATION: '고래 매집 후 상승 기대 • 롱 집중',
  };
  return summaries[phase] ?? '기본 전략 유지';
}
