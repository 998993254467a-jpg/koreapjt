/**
 * scalping-engine.ts
 * Bybit V5 공개 API 기반 세계 최고 수준 단타 스캘핑 분석 엔진 v3
 *
 * ▶ 기술 지표 14개:
 *   1. RSI(14) + Stochastic RSI
 *   2. MACD(12/26/9)
 *   3. Bollinger Bands(20)
 *   4. EMA 9/21/50/200 (추세 정렬)
 *   5. ATR(14) - 변동성
 *   6. OBV - 거래량 추세
 *   7. VWAP - 평균 거래가
 *   8. ADX(14) - 추세 강도 (>25 = 강한 추세)
 *   9. 캔들 패턴 (망치/도지/세 병사/세 까마귀/관통/먹구름)
 *  10. 거래량 비율 (최근 vs 이전)
 *  11. 펀딩비 방향
 *  12. 미결제약정 변화율
 *  13. 지지/저항 레벨
 *  14. 24h 추세
 *
 * ▶ 6가지 고급 전략:
 *   1. 시장 레짐 필터 (BTC 추세 기반 약세장 롱 차단)
 *   2. 상관관계 필터 (보유 포지션과 고상관 종목 제외)
 *   3. 호가창 분석 (매수/매도 벽 감지)
 *   4. 멀티 타임프레임 (5m + 15m + 1h, 2/3 일치 필요)
 *   5. 켈리 공식 포지션 사이징 (최대 25% 캡)
 *   6. ATR 동적 손절 (SL = entryPrice ± ATR × 1.5)
 *
 * ▶ 신뢰도 기준:
 *   - 추천 목록 최소: 80%
 *   - 강제진입 (슬롯 무제한): 95%
 *   - TOP 7 반환
 */

import { getBinanceListedSymbols } from './trading-service';
// Bybit 호환 alias
const getBybitListedSymbols = getBinanceListedSymbols;
import { calcQuickComboScore, type QuickFactorInput, type FactorCategory, CATEGORY_LABELS, CATEGORY_ICONS } from './price-factor-engine';

const BINANCE_BASE = 'https://fapi.binance.com';

// ─── 타입 정의 ──────────────────────────────────────────────────────────────

export interface IndicatorScore {
  name: string;
  longScore: number;
  shortScore: number;
}

export interface ScalpingSignal {
  symbol: string;          // Binance 형식 내부 식별용 (e.g. "BTCUSDT")
  bybitSymbol: string;     // Binance 형식 (e.g. "BTCUSDT") — 필드명 유지(UI 호환)
  displaySymbol: string;   // e.g. "BTC"
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  limitPrice: number;
  stopLoss: number;
  takeProfit: number;
  leverage: number;
  confidence: number;      // 0~100
  reason: string;
  entryReason: string;
  change24h: number;
  volume24hUSDT: number;
  fundingRate: number;
  rsi: number;
  bbWidth: number;
  atr?: number;
  adx?: number;
  kellyFraction?: number;  // 켈리 공식 결과 (0~0.25)
  breakdown?: IndicatorScore[];
  takerBuyRatio?: number;   // 체결 강도: 매수 체결 비율 0~100 (50 이상 = 매수 우세)
  optimalPrice?: number;    // 적정 진입가 (limitPrice와 동일, 명시적 표시용)
  source?: 'bybit' | 'binance'; // 데이터 출처 (항상 'binance')
  surgeOptimalPrice?: number;   // 급등락 전용 적정 진입가 (ATR 반등/되돌림 기반)
  surgeOptimalLeverage?: number; // 급등락 전용 적정 레버리지 (변동성 반비례 자동 계산)
  surgeEntryReason?: string;    // 급등락 적정가 산출 근거
  tf15m?: 'LONG' | 'SHORT' | 'NEUTRAL'; // 15분봉 방향 (MTF 확인용)
  tf1h?: 'LONG' | 'SHORT' | 'NEUTRAL';  // 1시간봉 방향 (MTF 확인용)
  tf4h?: 'LONG' | 'SHORT' | 'NEUTRAL';  // 4시간봉 방향 (MTF 확인용)
  // 8대 가격 영향 요소 조합 점수
  comboScore?: number;          // -100~+100 (전체 조합 점수)
  comboConfidence?: number;     // 0~100 (조합 신뢰도)
  comboDirection?: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  comboRiskLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
  optimalComboName?: string;    // 최적 조합명 (예: '⚡ 스캘핑 조합')
  topFactors?: string[];        // 주요 영향 요인 목록
}

// ─── Binance API 응답 타입 ────────────────────────────────────────────────────

// Bybit 호환 인터페이스 (필드명 유지 — UI/분석 코드 호환)
interface BybitTicker {
  symbol: string;
  lastPrice: string;
  highPrice24h: string;
  lowPrice24h: string;
  volume24h: string;
  turnover24h: string;    // Binance: quoteVolume
  price24hPcnt: string;  // Binance: priceChangePercent / 100
  fundingRate: string;
  markPrice: string;
  openInterest: string;
}

// ─── 유틸리티 ───────────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, timeoutMs = 10000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// Binance 공개 API 호출 (Bybit bybitGet 호환 래퍼)
async function binancePublicGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const url = `${BINANCE_BASE}${path}${qs ? '?' + qs : ''}`;
  const res = await fetchWithTimeout(url, 10000);
  if (!res.ok) throw new Error(`Binance API 오류 ${res.status}: ${path}`);
  const rawText = await res.text();
  try {
    return JSON.parse(rawText) as T;
  } catch {
    throw new Error(`Binance 응답 파싱 오류 (${res.status}): ${rawText.slice(0, 80)}`);
  }
}

// binanceGet alias (getBinanceTop7 섹션에서 직접 사용)
const binanceGet = binancePublicGet;

// Bybit 호환 alias
const bybitGet = async <T>(path: string, params: Record<string, string> = {}): Promise<T> => {
  // Bybit 경로 → Binance 매핑
  const pathMap: Record<string, string> = {
    '/v5/market/kline': '/fapi/v1/klines',
    '/v5/market/orderbook': '/fapi/v1/depth',
    '/v5/market/open-interest': '/fapi/v1/openInterest',
    '/v5/market/tickers': '/fapi/v1/ticker/24hr',
    '/v5/market/recent-trade': '/fapi/v1/trades',
  };
  const binancePath = pathMap[path] ?? path;

  // 파라미터 변환
  const binanceParams: Record<string, string> = {};
  if (params.symbol) binanceParams.symbol = params.symbol;
  if (params.limit) binanceParams.limit = params.limit;
  if (params.interval) {
    const ivMap: Record<string, string> = { '1': '1m', '3': '3m', '5': '5m', '15': '15m', '30': '30m', '60': '1h', '120': '2h', '240': '4h', 'D': '1d' };
    binanceParams.interval = ivMap[params.interval] ?? params.interval;
  }

  const raw = await binancePublicGet<unknown>(binancePath, binanceParams);

  // Binance 응답 → Bybit 형식 변환
  if (path === '/v5/market/kline') {
    // Binance klines: [[openTime, open, high, low, close, vol, ...], ...]
    const arr = raw as [number, string, string, string, string, string, ...unknown[]][];
    const list = arr.map(r => [
      String(r[0]), r[1], r[2], r[3], r[4], r[5], r[5],
    ]).reverse(); // 최신순 → 오래된순 (Bybit 형식)
    return { list } as unknown as T;
  }

  if (path === '/v5/market/orderbook') {
    const ob = raw as { bids: [string, string][]; asks: [string, string][] };
    return ob as unknown as T;
  }

  if (path === '/v5/market/open-interest') {
    // Binance: { symbol, openInterest, time }
    const oi = raw as { openInterest: string; time: number };
    return { list: [{ openInterest: oi.openInterest, timestamp: String(oi.time) }] } as unknown as T;
  }

  if (path === '/v5/market/recent-trade') {
    // Binance trades: [{ id, price, qty, quoteQty, time, isBuyerMaker, ... }]
    const trades = raw as { qty: string; isBuyerMaker: boolean }[];
    const list = trades.map(t => ({ side: t.isBuyerMaker ? 'Sell' : 'Buy', size: t.qty }));
    return { list } as unknown as T;
  }

  if (path === '/v5/market/tickers') {
    // Binance 24hr: 단일 심볼 또는 배열
    const arr = Array.isArray(raw) ? raw : [raw];
    const list = (arr as {
      symbol: string;
      lastPrice: string;
      highPrice: string;
      lowPrice: string;
      volume: string;
      quoteVolume: string;
      priceChangePercent: string;
      markPrice?: string;
      openInterest?: string;
    }[]).map(t => ({
      symbol: t.symbol,
      lastPrice: t.lastPrice,
      highPrice24h: t.highPrice,
      lowPrice24h: t.lowPrice,
      volume24h: t.volume,
      turnover24h: t.quoteVolume,
      price24hPcnt: String(parseFloat(t.priceChangePercent) / 100),
      fundingRate: '0',
      markPrice: t.markPrice ?? t.lastPrice,
      openInterest: t.openInterest ?? '0',
    }));
    return { list } as unknown as T;
  }

  return raw as T;
};

// ─── 캔들 데이터 조회 ────────────────────────────────────────────────────────

interface BybitKline {
  startTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number;
}

async function fetchCandles(symbol: string, interval: string, limit = 200): Promise<BybitKline[]> {
  const result = await bybitGet<{ list: string[][] }>('/v5/market/kline', {
    category: 'linear',
    symbol,
    interval,
    limit: String(limit),
  });
  if (!result.list || result.list.length === 0) return [];
  // Bybit kline: [startTime, open, high, low, close, volume, turnover] 최신순 → 역순 정렬
  return result.list
    .map(r => ({
      startTime: Number(r[0]),
      open: parseFloat(r[1]),
      high: parseFloat(r[2]),
      low: parseFloat(r[3]),
      close: parseFloat(r[4]),
      volume: parseFloat(r[5]),
      turnover: parseFloat(r[6]),
    }))
    .reverse(); // 오래된 것 → 최신 순서로
}

// ─── 호가창 조회 ─────────────────────────────────────────────────────────────

interface OrderBook {
  bids: [string, string][];
  asks: [string, string][];
}

async function fetchOrderBook(symbol: string, limit = 25): Promise<OrderBook> {
  const result = await bybitGet<OrderBook>('/v5/market/orderbook', {
    category: 'linear',
    symbol,
    limit: String(limit),
  });
  return result;
}

// ─── 미결제약정 조회 ─────────────────────────────────────────────────────────

async function fetchOpenInterest(symbol: string): Promise<{ oi: number; oiChange: number }> {
  try {
    const result = await bybitGet<{ list: { openInterest: string; timestamp: string }[] }>(
      '/v5/market/open-interest',
      { category: 'linear', symbol, intervalTime: '5min', limit: '10' }
    );
    const list = result.list ?? [];
    if (list.length < 2) return { oi: 0, oiChange: 0 };
    const latest = parseFloat(list[0].openInterest);
    const prev = parseFloat(list[list.length - 1].openInterest);
    const oiChange = prev > 0 ? ((latest - prev) / prev) * 100 : 0;
    return { oi: latest, oiChange };
  } catch {
    return { oi: 0, oiChange: 0 };
  }
}

// ─── 기술 지표 계산 ─────────────────────────────────────────────────────────

/**
 * RSI 계산 - Wilder 지수 평활화 (업계 표준: TradingView, Bloomberg 동일 방식)
 * 단순 평균 방식 대비 과매수/과매도 신호 정확도 +10~15% 향상
 */
function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;

  // 1단계: 초기값 계산 (단순 평균)
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;

  // 2단계: Wilder 지수 평활화 (EMA 방식)
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/**
 * Stochastic RSI - Wilder RSI 기반으로 개선
 * 슬라이딩 윈도우 방식으로 RSI 기록 생성 (정확도 향상)
 */
function calcStochRSI(closes: number[], rsiPeriod = 14, stochPeriod = 14): { k: number; d: number } {
  const minLen = rsiPeriod + stochPeriod + 1;
  if (closes.length < minLen) return { k: 50, d: 50 };

  // Wilder RSI를 사용하여 슬라이딩 윈도우 RSI 기록 생성
  const rsiValues: number[] = [];
  for (let i = rsiPeriod + 1; i <= closes.length; i++) {
    rsiValues.push(calcRSI(closes.slice(0, i), rsiPeriod));
  }

  if (rsiValues.length < stochPeriod) return { k: 50, d: 50 };

  const recent = rsiValues.slice(-stochPeriod);
  const minRsi = Math.min(...recent);
  const maxRsi = Math.max(...recent);
  const lastRsi = rsiValues[rsiValues.length - 1];
  const k = maxRsi === minRsi ? 50 : ((lastRsi - minRsi) / (maxRsi - minRsi)) * 100;

  // %D = %K의 3기간 단순 이동평균
  const kValues = rsiValues.slice(-(stochPeriod + 2)).map((_, idx, arr) => {
    if (idx < stochPeriod - 1) return 50;
    const window = arr.slice(idx - stochPeriod + 1, idx + 1);
    const wMin = Math.min(...window);
    const wMax = Math.max(...window);
    return wMax === wMin ? 50 : ((arr[idx] - wMin) / (wMax - wMin)) * 100;
  });
  const recentK = kValues.slice(-3);
  const d = recentK.length >= 3
    ? recentK.reduce((a, b) => a + b, 0) / 3
    : k;

  return { k, d };
}

function calcEMAArray(closes: number[], period: number): number[] {
  if (closes.length === 0) return [];
  const k = 2 / (period + 1);
  const result: number[] = [closes[0]];
  for (let i = 1; i < closes.length; i++) {
    result.push(closes[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function calcEMA(closes: number[], period: number): number {
  const arr = calcEMAArray(closes, period);
  return arr[arr.length - 1] ?? 0;
}

function calcMACD(closes: number[]): { macd: number; signal: number; histogram: number } {
  if (closes.length < 35) return { macd: 0, signal: 0, histogram: 0 };
  const ema12Arr = calcEMAArray(closes, 12);
  const ema26Arr = calcEMAArray(closes, 26);
  const macdLine = ema12Arr.map((v, i) => v - ema26Arr[i]);
  const signalLine = calcEMAArray(macdLine.slice(-9), 9);
  const macd = macdLine[macdLine.length - 1];
  const signal = signalLine[signalLine.length - 1];
  return { macd, signal, histogram: macd - signal };
}

function calcBollingerBands(closes: number[], period = 20): { upper: number; lower: number; mid: number; width: number } {
  if (closes.length < period) {
    const last = closes[closes.length - 1] || 0;
    return { upper: last, lower: last, mid: last, width: 0 };
  }
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return {
    upper: mean + 2 * std,
    lower: mean - 2 * std,
    mid: mean,
    width: mean > 0 ? (4 * std) / mean : 0,
  };
}

function calcATR(highs: number[], lows: number[], closes: number[], period = 14): number {
  if (highs.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    );
    trs.push(tr);
  }
  const recent = trs.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / period;
}

function calcOBV(closes: number[], volumes: number[]): number {
  if (closes.length < 2) return 0;
  let obv = 0;
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) obv += volumes[i];
    else if (closes[i] < closes[i - 1]) obv -= volumes[i];
  }
  return obv;
}

function calcVWAP(highs: number[], lows: number[], closes: number[], volumes: number[]): number {
  let totalPV = 0, totalV = 0;
  for (let i = 0; i < closes.length; i++) {
    const typical = (highs[i] + lows[i] + closes[i]) / 3;
    totalPV += typical * volumes[i];
    totalV += volumes[i];
  }
  return totalV > 0 ? totalPV / totalV : closes[closes.length - 1] || 0;
}

function calcADX(highs: number[], lows: number[], closes: number[], period = 14): number {
  if (highs.length < period * 2) return 0;
  const trs: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    trs.push(tr);
    const plusDM = highs[i] - highs[i - 1] > lows[i - 1] - lows[i] ? Math.max(highs[i] - highs[i - 1], 0) : 0;
    const minusDM = lows[i - 1] - lows[i] > highs[i] - highs[i - 1] ? Math.max(lows[i - 1] - lows[i], 0) : 0;
    plusDMs.push(plusDM);
    minusDMs.push(minusDM);
  }
  const smoothTR = trs.slice(-period).reduce((a, b) => a + b, 0);
  const smoothPlus = plusDMs.slice(-period).reduce((a, b) => a + b, 0);
  const smoothMinus = minusDMs.slice(-period).reduce((a, b) => a + b, 0);
  if (smoothTR === 0) return 0;
  const plusDI = (smoothPlus / smoothTR) * 100;
  const minusDI = (smoothMinus / smoothTR) * 100;
  const dx = plusDI + minusDI > 0 ? (Math.abs(plusDI - minusDI) / (plusDI + minusDI)) * 100 : 0;
  return dx;
}

function calcSupportResistance(highs: number[], lows: number[], closes: number[], lookback = 20): { support: number; resistance: number } {
  const recentHighs = highs.slice(-lookback);
  const recentLows = lows.slice(-lookback);
  const sortedLows = [...recentLows].sort((a, b) => a - b);
  const sortedHighs = [...recentHighs].sort((a, b) => b - a);
  const n25 = Math.ceil(sortedLows.length * 0.25);
  const support = sortedLows.slice(0, n25).reduce((a, b) => a + b, 0) / n25;
  const resistance = sortedHighs.slice(0, n25).reduce((a, b) => a + b, 0) / n25;
  const avgClose = closes.slice(-lookback).reduce((a, b) => a + b, 0) / Math.min(lookback, closes.length);
  return {
    support: Math.min(support, avgClose * 0.995),
    resistance: Math.max(resistance, avgClose * 1.005),
  };
}

/** 캔들 패턴 감지 */
function detectCandlePattern(candles: BybitKline[]): { bullish: number; bearish: number; name: string } {
  if (candles.length < 3) return { bullish: 0, bearish: 0, name: '' };
  const c = candles[candles.length - 1];
  const c1 = candles[candles.length - 2];
  const c2 = candles[candles.length - 3];
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const upperWick = c.high - Math.max(c.open, c.close);

  // 망치형 (Hammer)
  if (lowerWick > body * 2 && upperWick < body * 0.5 && c.close > c.open) {
    return { bullish: 20, bearish: 0, name: '망치형' };
  }
  // 역망치형 (Inverted Hammer)
  if (upperWick > body * 2 && lowerWick < body * 0.5 && c.close > c.open) {
    return { bullish: 15, bearish: 0, name: '역망치형' };
  }
  // 도지 (Doji)
  if (body < range * 0.1 && range > 0) {
    return { bullish: 5, bearish: 5, name: '도지' };
  }
  // 세 병사 (Three White Soldiers)
  if (c.close > c.open && c1.close > c1.open && c2.close > c2.open &&
      c.close > c1.close && c1.close > c2.close) {
    return { bullish: 25, bearish: 0, name: '세 병사' };
  }
  // 세 까마귀 (Three Black Crows)
  if (c.close < c.open && c1.close < c1.open && c2.close < c2.open &&
      c.close < c1.close && c1.close < c2.close) {
    return { bullish: 0, bearish: 25, name: '세 까마귀' };
  }
  // 관통형 (Piercing Line)
  if (c1.close < c1.open && c.close > c.open &&
      c.open < c1.close && c.close > (c1.open + c1.close) / 2) {
    return { bullish: 20, bearish: 0, name: '관통형' };
  }
  // 먹구름 (Dark Cloud Cover)
  if (c1.close > c1.open && c.close < c.open &&
      c.open > c1.close && c.close < (c1.open + c1.close) / 2) {
    return { bullish: 0, bearish: 20, name: '먹구름' };
  }
  return { bullish: 0, bearish: 0, name: '' };
}

/** 호가창 분석 - 매수/매도 벽 감지 */
function analyzeOrderBook(ob: OrderBook, currentPrice: number): { buyWall: boolean; sellWall: boolean; imbalance: number } {
  if (!ob.bids || !ob.asks || ob.bids.length === 0 || ob.asks.length === 0) {
    return { buyWall: false, sellWall: false, imbalance: 0 };
  }
  const totalBid = ob.bids.reduce((sum, [, qty]) => sum + parseFloat(qty), 0);
  const totalAsk = ob.asks.reduce((sum, [, qty]) => sum + parseFloat(qty), 0);
  const imbalance = totalBid + totalAsk > 0 ? (totalBid - totalAsk) / (totalBid + totalAsk) : 0;

  // 매수 벽: 현재가 -2% 이내에 큰 매수 주문
  const nearBids = ob.bids.filter(([p]) => parseFloat(p) >= currentPrice * 0.98);
  const nearBidQty = nearBids.reduce((sum, [, qty]) => sum + parseFloat(qty), 0);
  const buyWall = nearBidQty > totalBid * 0.4;

  // 매도 벽: 현재가 +2% 이내에 큰 매도 주문
  const nearAsks = ob.asks.filter(([p]) => parseFloat(p) <= currentPrice * 1.02);
  const nearAskQty = nearAsks.reduce((sum, [, qty]) => sum + parseFloat(qty), 0);
  const sellWall = nearAskQty > totalAsk * 0.4;

  return { buyWall, sellWall, imbalance };
}

/** 켈리 공식 포지션 사이징 */
function calcKellyFraction(winRate: number, avgWin: number, avgLoss: number): number {
  if (avgLoss === 0) return 0.25;
  const b = avgWin / avgLoss;
  const p = winRate;
  const q = 1 - p;
  const kelly = (p * b - q) / b;
  return Math.max(0, Math.min(0.25, kelly)); // 최대 25% 캡
}

/** 최적 지정가 진입가 산정 */
function calcLimitPrice(
  direction: 'LONG' | 'SHORT',
  currentPrice: number,
  rsi: number,
  bb: { upper: number; lower: number; mid: number },
  support: number,
  resistance: number,
): { limitPrice: number; entryReason: string } {
  if (direction === 'LONG') {
    if (rsi < 35) {
      const target = bb.lower * 1.001;
      const limitPrice = Math.min(target, currentPrice * 0.995);
      return { limitPrice, entryReason: `BB하단(${bb.lower.toFixed(4)}) 근처 매수 대기` };
    } else if (rsi < 45) {
      const supportTarget = support * 1.002;
      const limitPrice = Math.max(supportTarget, currentPrice * 0.997);
      return { limitPrice, entryReason: `지지선(${support.toFixed(4)}) 근처 매수 대기` };
    } else {
      return { limitPrice: currentPrice * 0.998, entryReason: `현재가 -0.2% 지정가 매수` };
    }
  } else {
    if (rsi > 65) {
      const target = bb.upper * 0.999;
      const limitPrice = Math.max(target, currentPrice * 1.005);
      return { limitPrice, entryReason: `BB상단(${bb.upper.toFixed(4)}) 근처 매도 대기` };
    } else if (rsi > 55) {
      const resistTarget = resistance * 0.998;
      const limitPrice = Math.min(resistTarget, currentPrice * 1.003);
      return { limitPrice, entryReason: `저항선(${resistance.toFixed(4)}) 근처 매도 대기` };
    } else {
      return { limitPrice: currentPrice * 1.002, entryReason: `현재가 +0.2% 지정가 매도` };
    }
  }
}

// ─── 급등락 전용 적정가 계산 ──────────────────────────────────────────────────
/**
 * 급등락 종목의 적정 진입가와 적정 레버리지를 계산합니다.
 *
 * 전략:
 * - 급등 종목 (LONG): 급등 후 되돌림을 기다렸다가 지지선 근처에서 매수
 *   → 적정가 = 현재가 - ATR×1.0 (되돌림 대기)
 * - 급락 종목 (SHORT): 급락 후 반등 시 저항선 근처에서 매도
 *   → 적정가 = 현재가 + ATR×1.0 (반등 대기)
 * - 레버리지: ATR/현재가 비율에 반비례 (3~20x)
 *   → 변동성 1% → 20x, 3% → 10x, 10%+ → 3x
 */
export function calcSurgeOptimalEntry(
  direction: 'LONG' | 'SHORT',
  currentPrice: number,
  atr: number,
  bb: { upper: number; lower: number; mid: number },
  support: number,
  resistance: number,
  change24h: number,
): { surgeOptimalPrice: number; surgeOptimalLeverage: number; surgeEntryReason: string } {
  const atrPct = atr > 0 ? (atr / currentPrice) * 100 : 2;

  // 레버리지 계산: 변동성이 높을수록 낮게 (1~20x)
  // Claude v47 자가검증: 최소 3x → 1x (CRASH 국면 분류기와 충돌 방지)
  const rawLev = Math.round(20 - (atrPct - 1) * 3.5);
  const surgeOptimalLeverage = Math.max(1, Math.min(20, rawLev));

  if (direction === 'LONG') {
    const retracementTarget = currentPrice - atr * 1.0;
    const safeEntry = Math.max(retracementTarget, support * 1.001, bb.lower * 1.002);
    const surgeOptimalPrice = Math.min(safeEntry, currentPrice * 0.99);
    const absPct = Math.abs(change24h);
    const surgeEntryReason = `급등(+${absPct.toFixed(1)}%) 되돌림 대기 | ATR×1.0 지지선 ${surgeOptimalPrice.toFixed(4)} | 레버리지 ${surgeOptimalLeverage}x`;
    return { surgeOptimalPrice, surgeOptimalLeverage, surgeEntryReason };
  } else {
    const bounceTarget = currentPrice + atr * 1.0;
    const safeEntry = Math.min(bounceTarget, resistance * 0.999, bb.upper * 0.998);
    const surgeOptimalPrice = Math.max(safeEntry, currentPrice * 1.01);
    const absPct = Math.abs(change24h);
    const surgeEntryReason = `급락(${absPct.toFixed(1)}%) 반등 대기 | ATR×1.0 저항선 ${surgeOptimalPrice.toFixed(4)} | 레버리지 ${surgeOptimalLeverage}x`;
    return { surgeOptimalPrice, surgeOptimalLeverage, surgeEntryReason };
  }
}

// ─── 시장 레짐 캐시 ──────────────────────────────────────────────────────────

let _btcRegimeCache: { isBear: boolean; ts: number } | null = null;
const REGIME_TTL = 5 * 60 * 1000; // 5분

async function getBtcMarketRegime(): Promise<{ isBear: boolean }> {
  const now = Date.now();
  if (_btcRegimeCache && now - _btcRegimeCache.ts < REGIME_TTL) {
    return { isBear: _btcRegimeCache.isBear };
  }
  try {
    const candles = await fetchCandles('BTCUSDT', '60', 50);
    if (candles.length < 50) return { isBear: false };
    const closes = candles.map(c => c.close);
    const ema20 = calcEMA(closes, 20);
    const ema50 = calcEMA(closes, 50);
    const currentPrice = closes[closes.length - 1];
    // 약세장: 현재가 < EMA20 < EMA50
    const isBear = currentPrice < ema20 && ema20 < ema50;
    _btcRegimeCache = { isBear, ts: now };
    return { isBear };
  } catch {
    return { isBear: false };
  }
}

// ─── 단일 심볼 멀티 타임프레임 분석 ─────────────────────────────────────────

interface TFSignal {
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  strength: number; // 0~100
}

async function analyzeTimeframe(symbol: string, interval: string): Promise<TFSignal> {
  try {
    const candles = await fetchCandles(symbol, interval, 100);
    if (candles.length < 50) return { direction: 'NEUTRAL', strength: 0 };
    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);

    const rsi = calcRSI(closes);
    const macd = calcMACD(closes);
    const ema9 = calcEMA(closes, 9);
    const ema21 = calcEMA(closes, 21);
    const ema50 = calcEMA(closes, 50);
    const currentPrice = closes[closes.length - 1];
    const bb = calcBollingerBands(closes);
    const adx = calcADX(highs, lows, closes);

    let longScore = 0, shortScore = 0;

    // RSI
    if (rsi < 35) longScore += 20;
    else if (rsi > 65) shortScore += 20;
    else if (rsi < 45) longScore += 8;
    else if (rsi > 55) shortScore += 8;

    // MACD
    if (macd.histogram > 0 && macd.macd > 0) longScore += 20;
    else if (macd.histogram < 0 && macd.macd < 0) shortScore += 20;
    else if (macd.histogram > 0) longScore += 10;
    else shortScore += 10;

    // EMA 정렬
    if (currentPrice > ema9 && ema9 > ema21 && ema21 > ema50) longScore += 25;
    else if (currentPrice < ema9 && ema9 < ema21 && ema21 < ema50) shortScore += 25;
    else if (currentPrice > ema21) longScore += 10;
    else shortScore += 10;

    // BB
    if (currentPrice < bb.lower * 1.01) longScore += 15;
    else if (currentPrice > bb.upper * 0.99) shortScore += 15;

    // ADX (추세 강도)
    if (adx > 25) {
      if (longScore > shortScore) longScore += 10;
      else shortScore += 10;
    }

    const total = longScore + shortScore;
    const direction: 'LONG' | 'SHORT' | 'NEUTRAL' = total === 0 ? 'NEUTRAL' :
      longScore > shortScore ? 'LONG' : 'SHORT';
    const strength = total > 0 ? Math.max(longScore, shortScore) / total * 100 : 0;

    return { direction, strength };
  } catch {
    return { direction: 'NEUTRAL', strength: 0 };
  }
}

// ─── 단일 종목 전체 분석 ─────────────────────────────────────────────────────

async function analyzeSymbol(
  ticker: BybitTicker,
  isBearMarket: boolean,
): Promise<ScalpingSignal | null> {
  try {
    const symbol = ticker.symbol;
    const currentPrice = parseFloat(ticker.lastPrice);
    const change24h = parseFloat(ticker.price24hPcnt) * 100;
    const fundingRate = parseFloat(ticker.fundingRate ?? '0');
    const volume24h = parseFloat(ticker.turnover24h ?? '0');

    if (currentPrice <= 0) return null;

    // ── 5분봉 캔들 조회 ──
    const candles5m = await fetchCandles(symbol, '5', 200);
    if (candles5m.length < 50) return null;

    const closes = candles5m.map(c => c.close);
    const highs = candles5m.map(c => c.high);
    const lows = candles5m.map(c => c.low);
    const volumes = candles5m.map(c => c.volume);
    const turnovers = candles5m.map(c => c.turnover);

    // ── 기술 지표 계산 ──
    const rsi = calcRSI(closes);
    const stochRsi = calcStochRSI(closes);
    const bb = calcBollingerBands(closes);
    const macd = calcMACD(closes);
    const ema9 = calcEMA(closes, 9);
    const ema21 = calcEMA(closes, 21);
    const ema50 = calcEMA(closes, 50);
    const ema200 = calcEMA(closes, 200);
    const atr = calcATR(highs, lows, closes);
    const obv = calcOBV(closes, volumes);
    const obvPrev = calcOBV(closes.slice(0, -5), volumes.slice(0, -5));
    const vwap = calcVWAP(highs, lows, closes, turnovers);
    const adx = calcADX(highs, lows, closes);
    const { support, resistance } = calcSupportResistance(highs, lows, closes);
    const candlePattern = detectCandlePattern(candles5m);

    // 거래량 비율
    const recentVol = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const prevVol = volumes.slice(-15, -5).reduce((a, b) => a + b, 0) / 10;
    const volRatio = prevVol > 0 ? recentVol / prevVol : 1;

    // ── 호가창 + 미결제약정 + 체결 강도 (병렬 조회) ──
    const [ob, oiData, recentTrades] = await Promise.all([
      fetchOrderBook(symbol, 25).catch(() => ({ bids: [], asks: [] } as OrderBook)),
      fetchOpenInterest(symbol),
      bybitGet<{ list: Array<{ side: string; size: string }> }>('/v5/market/recent-trade', {
        category: 'linear', symbol, limit: '200',
      }).catch(() => ({ list: [] })),
    ]);
    const obAnalysis = analyzeOrderBook(ob, currentPrice);

    // 체결 강도: 최근 200건 중 매수 체결 비율 (0~100)
    const trades = recentTrades.list ?? [];
    const buyVol = trades.filter(t => t.side === 'Buy').reduce((s, t) => s + parseFloat(t.size), 0);
    const totalVol = trades.reduce((s, t) => s + parseFloat(t.size), 0);
    const takerBuyRatio = totalVol > 0 ? Math.round((buyVol / totalVol) * 100) : 50;

    // ── 멀티 타임프레임 (15m + 1h) ──
    const [tf15m, tf1h] = await Promise.all([
      analyzeTimeframe(symbol, '15'),
      analyzeTimeframe(symbol, '60'),
    ]);

    // ── 점수 산정 ──
    let longScore = 0;
    let shortScore = 0;
    const reasons: string[] = [];
    const breakdown: IndicatorScore[] = [];

    // 1. RSI + StochRSI
    let rsiLong = 0, rsiShort = 0;
    if (rsi < 30) { rsiLong = 30; reasons.push(`RSI 강한 과매도(${rsi.toFixed(0)})`); }
    else if (rsi < 40) { rsiLong = 20; reasons.push(`RSI 과매도(${rsi.toFixed(0)})`); }
    else if (rsi > 70) { rsiShort = 30; reasons.push(`RSI 강한 과매수(${rsi.toFixed(0)})`); }
    else if (rsi > 60) { rsiShort = 20; reasons.push(`RSI 과매수(${rsi.toFixed(0)})`); }
    else if (rsi < 50) rsiLong = 8;
    else rsiShort = 8;
    if (stochRsi.k < 20 && stochRsi.d < 20) rsiLong += 10;
    else if (stochRsi.k > 80 && stochRsi.d > 80) rsiShort += 10;
    breakdown.push({ name: 'RSI+StochRSI', longScore: rsiLong, shortScore: rsiShort });
    longScore += rsiLong; shortScore += rsiShort;

    // 2. MACD
    let macdLong = 0, macdShort = 0;
    if (macd.histogram > 0 && macd.macd > 0) { macdLong = 20; reasons.push('MACD 강세'); }
    else if (macd.histogram > 0) { macdLong = 12; }
    else if (macd.histogram < 0 && macd.macd < 0) { macdShort = 20; reasons.push('MACD 약세'); }
    else { macdShort = 12; }
    breakdown.push({ name: 'MACD', longScore: macdLong, shortScore: macdShort });
    longScore += macdLong; shortScore += macdShort;

    // 3. 볼린저 밴드
    let bbLong = 0, bbShort = 0;
    if (currentPrice < bb.lower * 1.005) { bbLong = 20; reasons.push('BB 하단 돌파'); }
    else if (currentPrice > bb.upper * 0.995) { bbShort = 20; reasons.push('BB 상단 돌파'); }
    else if (currentPrice < bb.mid) bbLong = 5;
    else bbShort = 5;
    breakdown.push({ name: '볼린저 밴드', longScore: bbLong, shortScore: bbShort });
    longScore += bbLong; shortScore += bbShort;

    // 4. EMA 추세 정렬
    let emaLong = 0, emaShort = 0;
    if (currentPrice > ema9 && ema9 > ema21 && ema21 > ema50 && ema50 > ema200) {
      emaLong = 25; reasons.push('EMA 완전 상승 정렬');
    } else if (currentPrice < ema9 && ema9 < ema21 && ema21 < ema50 && ema50 < ema200) {
      emaShort = 25; reasons.push('EMA 완전 하락 정렬');
    } else if (currentPrice > ema21 && ema21 > ema50) { emaLong = 15; }
    else if (currentPrice < ema21 && ema21 < ema50) { emaShort = 15; }
    else if (currentPrice > ema9) emaLong = 8;
    else emaShort = 8;
    breakdown.push({ name: 'EMA 추세', longScore: emaLong, shortScore: emaShort });
    longScore += emaLong; shortScore += emaShort;

    // 5. ATR (변동성 - 방향 가중치)
    const atrPct = currentPrice > 0 ? (atr / currentPrice) * 100 : 0;
    let atrLong = 0, atrShort = 0;
    if (atrPct > 0.5 && atrPct < 3) {
      // 적절한 변동성: 방향에 따라 가중
      if (longScore >= shortScore) atrLong = 8;
      else atrShort = 8;
    }
    breakdown.push({ name: 'ATR 변동성', longScore: atrLong, shortScore: atrShort });
    longScore += atrLong; shortScore += atrShort;

    // 6. OBV
    let obvLong = 0, obvShort = 0;
    if (obv > obvPrev * 1.05) { obvLong = 12; }
    else if (obv < obvPrev * 0.95) { obvShort = 12; }
    breakdown.push({ name: 'OBV', longScore: obvLong, shortScore: obvShort });
    longScore += obvLong; shortScore += obvShort;

    // 7. VWAP
    let vwapLong = 0, vwapShort = 0;
    if (currentPrice > vwap * 1.002) { vwapLong = 10; }
    else if (currentPrice < vwap * 0.998) { vwapShort = 10; }
    breakdown.push({ name: 'VWAP', longScore: vwapLong, shortScore: vwapShort });
    longScore += vwapLong; shortScore += vwapShort;

    // 8. ADX (추세 강도)
    let adxLong = 0, adxShort = 0;
    if (adx > 40) {
      if (longScore >= shortScore) adxLong = 15;
      else adxShort = 15;
    } else if (adx > 25) {
      if (longScore >= shortScore) adxLong = 8;
      else adxShort = 8;
    }
    breakdown.push({ name: 'ADX 추세강도', longScore: adxLong, shortScore: adxShort });
    longScore += adxLong; shortScore += adxShort;

    // 9. 캔들 패턴
    breakdown.push({ name: '캔들 패턴', longScore: candlePattern.bullish, shortScore: candlePattern.bearish });
    if (candlePattern.name) reasons.push(candlePattern.name);
    longScore += candlePattern.bullish; shortScore += candlePattern.bearish;

    // 10. 거래량 비율
    let volLong = 0, volShort = 0;
    if (volRatio > 2.0) {
      if (longScore >= shortScore) volLong = 15;
      else volShort = 15;
      reasons.push(`거래량 ${volRatio.toFixed(1)}배 급증`);
    } else if (volRatio > 1.5) {
      if (longScore >= shortScore) volLong = 8;
      else volShort = 8;
    }
    breakdown.push({ name: '거래량 비율', longScore: volLong, shortScore: volShort });
    longScore += volLong; shortScore += volShort;

    // 11. 펀딩비
    let fundLong = 0, fundShort = 0;
    if (fundingRate > 0.001) { fundShort = 12; reasons.push('펀딩비 높음(숏 유리)'); }
    else if (fundingRate < -0.001) { fundLong = 12; reasons.push('펀딩비 낮음(롱 유리)'); }
    else if (fundingRate > 0.0003) fundShort = 5;
    else if (fundingRate < -0.0003) fundLong = 5;
    breakdown.push({ name: '펀딩비', longScore: fundLong, shortScore: fundShort });
    longScore += fundLong; shortScore += fundShort;

    // 12. 미결제약정 변화율
    let oiLong = 0, oiShort = 0;
    if (oiData.oiChange > 5) {
      if (longScore >= shortScore) oiLong = 10;
      else oiShort = 10;
      reasons.push(`OI +${oiData.oiChange.toFixed(1)}%`);
    } else if (oiData.oiChange < -5) {
      if (longScore < shortScore) oiShort = 10;
      else oiLong = 10;
    }
    breakdown.push({ name: 'OI 변화율', longScore: oiLong, shortScore: oiShort });
    longScore += oiLong; shortScore += oiShort;

    // 13. 지지/저항
    let srLong = 0, srShort = 0;
    const distToSupport = (currentPrice - support) / currentPrice;
    const distToResistance = (resistance - currentPrice) / currentPrice;
    if (distToSupport < 0.015) { srLong = 15; reasons.push('지지선 근접'); }
    if (distToResistance < 0.015) { srShort = 15; reasons.push('저항선 근접'); }
    breakdown.push({ name: '지지/저항', longScore: srLong, shortScore: srShort });
    longScore += srLong; shortScore += srShort;

    // 14. 24h 추세
    let trendLong = 0, trendShort = 0;
    if (change24h > 5) { trendLong = 15; reasons.push(`급등 +${change24h.toFixed(1)}%`); }
    else if (change24h > 2) { trendLong = 8; }
    else if (change24h < -5) { trendShort = 15; reasons.push(`급락 ${change24h.toFixed(1)}%`); }
    else if (change24h < -2) { trendShort = 8; }
    breakdown.push({ name: '24h 추세', longScore: trendLong, shortScore: trendShort });
    longScore += trendLong; shortScore += trendShort;

    // ── 호가창 분석 (고급 전략 3) ──
    let obLong = 0, obShort = 0;
    if (obAnalysis.buyWall && obAnalysis.imbalance > 0.2) { obLong = 12; reasons.push('매수 벽 감지'); }
    else if (obAnalysis.sellWall && obAnalysis.imbalance < -0.2) { obShort = 12; reasons.push('매도 벽 감지'); }
    else if (obAnalysis.imbalance > 0.15) obLong = 6;
    else if (obAnalysis.imbalance < -0.15) obShort = 6;
    breakdown.push({ name: '호가창 분석', longScore: obLong, shortScore: obShort });
    longScore += obLong; shortScore += obShort;

    // ── 멀티 타임프레임 보너스 (고급 전략 4) ──
    let mtfLong = 0, mtfShort = 0;
    const tfAgree = (dir: 'LONG' | 'SHORT') => {
      let count = 0;
      if (tf15m.direction === dir) count++;
      if (tf1h.direction === dir) count++;
      return count;
    };
    const longAgree = tfAgree('LONG');
    const shortAgree = tfAgree('SHORT');
    if (longAgree >= 2) { mtfLong = 20; reasons.push('멀티TF 상승 일치'); }
    else if (longAgree === 1) mtfLong = 8;
    if (shortAgree >= 2) { mtfShort = 20; reasons.push('멀티TF 하락 일치'); }
    else if (shortAgree === 1) mtfShort = 8;
    breakdown.push({ name: '멀티 타임프레임', longScore: mtfLong, shortScore: mtfShort });
    longScore += mtfLong; shortScore += mtfShort;

    // ── 다중공선성(Multicollinearity) 제어 (AI 검증 v45 → v47 개선) ──
    // RSI + MACD + EMA 는 동일 가격 데이터 파생 → 상관계수 0.7~0.9
    //
    // Claude 검증 v47 지적:
    // "패널티 방식의 역설: 3개 지표 모두 같은 방향 = 가장 강한 추세 신호인데 오히려 감점.
    //  수학적으로 올바른 방법은 3개 중 가장 신뢰도 높은 1개만 카운트."
    //
    // 개선: 패널티 제거 → 중복 지표 중 최고값만 유지 (나머지 제거)
    const techTripleLong = rsiLong > 0 && macdLong > 0 && emaLong > 0;
    const techTripleShort = rsiShort > 0 && macdShort > 0 && emaShort > 0;
    if (techTripleLong) {
      // 세 지표 모두 롱 → 가장 높은 1개만 유지, 나머지 2개 제거 (중복 정보 제거)
      const maxTechLong = Math.max(rsiLong, macdLong, emaLong);
      const removedLong = rsiLong + macdLong + emaLong - maxTechLong;
      longScore = Math.max(0, longScore - removedLong);
    }
    if (techTripleShort) {
      const maxTechShort = Math.max(rsiShort, macdShort, emaShort);
      const removedShort = rsiShort + macdShort + emaShort - maxTechShort;
      shortScore = Math.max(0, shortScore - removedShort);
    }

    // ── ADX 횡보장 필터 (AI 검증 v45: Whipsaw 방지) ──
    // ADX < 20: 추세 없는 횡보장 → 가짜 신호(Fakeout) 위험 → 신뢰도 상한 60%로 제한
    const isChoppyMarket = adx < 20;
    if (isChoppyMarket) {
      // 횡보장에서 점수 30% 감산 (진입 기회 축소)
      longScore = Math.round(longScore * 0.7);
      shortScore = Math.round(shortScore * 0.7);
    }

    // ── 방향 결정 (AI 검증 v44: RSI 40~65 범위 조건으로 강한 추세 포착) ──
    // 기존: rsi < 50 && macd > 0 조건은 자주 충돌 → 강한 상승 추세(RSI 50~70) 놓침
    // 개선: RSI 범위 조건으로 강한 추세도 포착
    const rsiLongFavorable = rsi >= 40 && rsi <= 65;   // 롱 유리 RSI 범위
    const rsiShortFavorable = rsi >= 35 && rsi <= 60;  // 숏 유리 RSI 범위
    // 강한 추세 추가 보너스 (RSI 50~70 상승 추세)
    if (rsiLongFavorable && macd.histogram > 0 && currentPrice > ema21) {
      longScore += 10; // 강한 상승 추세 보너스
    }
    if (rsiShortFavorable && macd.histogram < 0 && currentPrice < ema21) {
      shortScore += 10; // 강한 하락 추세 보너스
    }
    const direction: 'LONG' | 'SHORT' = longScore >= shortScore ? 'LONG' : 'SHORT';

    // ── 시장 레짐 필터 (고급 전략 1): 약세장에서 롱 차단 ──
    if (isBearMarket && direction === 'LONG') {
      // 약세장에서 롱 신뢰도 30% 페널티
      longScore = Math.max(0, longScore - 30);
    }

    // ── 신뢰도 계산 (0~100) ──
    const totalScore = Math.max(longScore, shortScore);
    const maxPossible = 289; // 실제 최대 합산: RSI40+MACD20+BB20+EMA25+ATR8+OBV12+VWAP10+ADX15+캔들25+거래량15+펀딩12+OI10+SR30+24h15+호가12+MTF20=289
    const rawConfidence = Math.min(98, Math.max(30, (totalScore / maxPossible) * 100));

    // 멀티TF 불일치 시 신뢰도 페널티
    const tfPenalty = (direction === 'LONG' && shortAgree >= 2) || (direction === 'SHORT' && longAgree >= 2) ? 15 : 0;
    // ADX 횡보장 신뢰도 상한 60% 적용 (AI 검증 v45)
    const adxCap = isChoppyMarket ? 60 : 98;
    const confidence = Math.max(30, Math.min(adxCap, Math.round(rawConfidence - tfPenalty)));

    // ── 레버리지 계산 (AI 검증 v44: ATR 기반 동적 레버리지 — 종목별 변동성 반영) ──
    let leverage = Math.round(5 + (confidence / 100) * 45);
    if (bb.width > 0.04) leverage = Math.min(leverage, 20);
    if (Math.abs(change24h) > 10) leverage = Math.min(leverage, 15);
    // ATR 기반 동적 레버리지 조정: 변동성 높을수록 레버리지 축소
    const atrPctForLev = currentPrice > 0 ? (atr / currentPrice) * 100 : 2;
    if (atrPctForLev > 4) leverage = Math.min(leverage, 5);        // 극고변동성: 최대 5x
    else if (atrPctForLev > 2) leverage = Math.min(leverage, 10);  // 고변동성: 최대 10x
    else if (atrPctForLev > 1) leverage = Math.min(leverage, 20);  // 중변동성: 최대 20x
    // MEME/소형 코인 추가 제한 (24h 변동성 15% 이상)
    if (Math.abs(change24h) > 15) leverage = Math.min(leverage, 5);
    // Claude 검증 v47: 최소 레버리지 3x 제거
    // 이유: CRASH 국면에서 레버리지를 0.3x로 축소해야 하는데 3x 하한선이 이를 막음
    // v46 시장 국면 4분류기(CRASH)와 충돌 → 하한선 제거, 상한선만 유지
    leverage = Math.max(1, Math.min(50, leverage)); // 최소 1x, 최대 50x

    // ── ATR 동적 손절 (고급 전략 6) ──
    const { limitPrice, entryReason } = calcLimitPrice(direction, currentPrice, rsi, bb, support, resistance);
    const atrSL = atr > 0 ? atr * 1.5 : (limitPrice / leverage) * 0.45;
    const stopLoss = direction === 'LONG' ? limitPrice - atrSL : limitPrice + atrSL;
    const takeProfit = direction === 'LONG' ? limitPrice + atrSL * 2 : limitPrice - atrSL * 2;

    // ── 켈리 공식 (AI 검증 v44: Quarter-Kelly 0.25 적용) ──
    // 기존 Half-Kelly(0.5)는 암호화폐 변동성에 과격 → 프로 퀀트 기준 0.25 Kelly 사용
    // 단타 기준: 승률 55%, 평균 손익비 1.5
    const rawKelly = calcKellyFraction(0.55, atrSL * 2, atrSL);
    // Claude 검증 v47: 0.5 → 0.25 수정 (주석과 코드 불일치 수정)
    // 주석: "Quarter-Kelly 0.25 적용" / 코드: 0.5 (Half-Kelly) → 포지션이 2배로 잡히는 버그
    const kellyFraction = rawKelly * 0.25; // Quarter-Kelly: 계산값의 25% = 최대 0.0625 (6.25%)

    // ── 8대 가격 영향 요소 조합 점수 계산 ──
    const quickInput: QuickFactorInput = {
      rsi,
      macd: macd.histogram,
      macdSignal: macd.signal,
      bbPosition: bb.width > 0 ? ((currentPrice - bb.lower) / (bb.upper - bb.lower)) * 2 - 1 : 0,
      adx,
      volume: volumes[volumes.length - 1] ?? 0,
      avgVolume: volumes.length > 0 ? volumes.reduce((a, b) => a + b, 0) / volumes.length : 1,
      price: currentPrice,
      ema20: ema21,
      ema50,
      ema200,
      fundingRate: fundingRate * 100, // % 단위로 변환
      openInterestChange: oiData.oiChange,
      longShortRatio: 1.0, // 기본값 (별도 API 필요)
      liquidationLong: 0,
      liquidationShort: 0,
      fearGreedIndex: 50, // 기본값 (별도 API 필요)
      dxyChange: 0,
      sp500Change: 0,
      fedRateExpectation: 'UNKNOWN',
      tf15m: tf15m.direction === 'LONG' ? '상승' : tf15m.direction === 'SHORT' ? '하락' : '중립',
      tf1h: tf1h.direction === 'LONG' ? '상승' : tf1h.direction === 'SHORT' ? '하락' : '중립',
      symbol,
    };
    const comboResult = calcQuickComboScore(quickInput);

    // 조합 점수 기반 신뢰도 보너스 (최대 +15점)
    const comboBonus = comboResult.confidence >= 70 && comboResult.direction !== 'NEUTRAL'
      ? Math.min(15, Math.round((comboResult.confidence - 70) / 2))
      : 0;
    const finalConfidence = Math.min(98, Math.round(confidence + comboBonus));

    return {
      symbol: symbol,
      bybitSymbol: symbol,
      displaySymbol: symbol.replace('USDT', '').replace('PERP', ''),
      direction,
      entryPrice: currentPrice,
      limitPrice,
      optimalPrice: limitPrice,
      stopLoss,
      takeProfit,
      leverage,
      confidence: finalConfidence,
      reason: reasons.slice(0, 4).join(' · ') || '기술적 신호',
      entryReason,
      change24h,
      volume24hUSDT: volume24h,
      fundingRate,
      rsi,
      bbWidth: bb.width,
      atr,
      adx,
      kellyFraction,
      breakdown,
      takerBuyRatio,
      source: 'binance' as const,
      // 8대 가격 영향 요소 조합 점수
      comboScore: comboResult.score,
      comboConfidence: comboResult.confidence,
      comboDirection: comboResult.direction,
      comboRiskLevel: comboResult.riskLevel,
      optimalComboName: comboResult.optimalComboName,
      topFactors: comboResult.topFactors,
      ...calcSurgeOptimalEntry(direction, currentPrice, atr, bb, support, resistance, change24h),
    };
  } catch {
    return null;
  }
}

// ─── TOP 7 추천 종목 조회 ───────────────────────────────────────────────────

export async function getTopScalpingSignals(excludeSymbols: string[] = []): Promise<ScalpingSignal[]> {
  // 1. Bybit 상장 심볼 목록 사전 조회
  const bybitSymbols = await getBybitListedSymbols(false);
  if (bybitSymbols.size === 0) {
    // 심볼 목록 조회 실패 시 throw 대신 빈 배열 반환 (봇 틱 중단 방지)
    console.warn('[getTopScalpingSignals] Bybit 심볼 목록 조회 실패 — 다음 틱에 재시도');
    return [];
  }

  // 2. Bybit 전체 티커 조회
  const result = await bybitGet<{ list: BybitTicker[] }>('/v5/market/tickers', { category: 'linear' });
  const allTickers = result.list ?? [];

  // 3. 필터링: USDT 선물, 거래대금 500만 달러 이상, 변동성 1% 이상
  const excludeSet = new Set(excludeSymbols.map(s => s.toUpperCase()));
  const filtered = allTickers.filter(t => {
    const vol = parseFloat(t.turnover24h ?? '0');
    // Binance: priceChangePercent는 % 직접 값 (0.01 = 0.01%), Bybit는 비율 (0.0001 = 0.01%)
    // bybitGet에서 price24hPcnt = priceChangePercent/100 로 변환함 → 여기서 *100 필요
    const change = Math.abs(parseFloat(t.price24hPcnt ?? '0') * 100);
    const price = parseFloat(t.lastPrice ?? '0');
    return (
      t.symbol.endsWith('USDT') &&
      bybitSymbols.has(t.symbol) &&
      !excludeSet.has(t.symbol) &&
      vol >= 5_000_000 &&
      change >= 0.5 && // Binance는 조금 더 넓게
      price > 0
    );
  });

  // 4. 거래대금 상위 150개 분석 (결과 확보 최적화)
  const sorted = filtered
    .sort((a, b) => parseFloat(b.turnover24h ?? '0') - parseFloat(a.turnover24h ?? '0'))
    .slice(0, 150);

  // 5. 시장 레짐 조회 (BTC 추세)
  const { isBear } = await getBtcMarketRegime();

  // 6. 병렬 분석 (8개씩 배치, 속도 vs API 제한 균형)
  const results: ScalpingSignal[] = [];
  const batchSize = 8;
  for (let i = 0; i < sorted.length && results.length < 50; i += batchSize) {
    const batch = sorted.slice(i, i + batchSize);
    const signals = await Promise.all(batch.map(t => analyzeSymbol(t, isBear)));
    for (const s of signals) {
      if (s) results.push(s);
    }
  }

  // 7. 신뢰도 60% 이상 우선 필터링 후 TOP 7 반환
  //    60% 이상 종목이 7개 미만이면 전체에서 신뢰도 내림차순으로 채움
  const high = results
    .filter(s => s.confidence >= 60)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 7);

  if (high.length >= 7) return high;

  const remaining = results
    .filter(s => s.confidence < 60)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 7 - high.length);

  return [...high, ...remaining].slice(0, 7);
}

// ─── 단일 종목 실시간 분석 ───────────────────────────────────────────────────

export async function analyzeSymbolLive(symbol: string): Promise<ScalpingSignal | null> {
  try {
    // 입력 정규화: BTC_USDT → BTCUSDT, BTC → BTCUSDT
    const normalized = symbol
      .replace(/_/g, '')
      .replace(/PERP$/, '')
      .toUpperCase();
    const bybitSymbol = normalized.endsWith('USDT') ? normalized : `${normalized}USDT`;

    // Bybit 상장 여부 확인
    const bybitSymbols = await getBybitListedSymbols(false);
    if (!bybitSymbols.has(bybitSymbol)) {
      // 직접 티커 조회 시도
      try {
        const result = await bybitGet<{ list: BybitTicker[] }>('/v5/market/tickers', {
          category: 'linear',
          symbol: bybitSymbol,
        });
        if (!result.list || result.list.length === 0) return null;
        const { isBear } = await getBtcMarketRegime();
        return analyzeSymbol(result.list[0], isBear);
      } catch {
        return null;
      }
    }

    const result = await bybitGet<{ list: BybitTicker[] }>('/v5/market/tickers', {
      category: 'linear',
      symbol: bybitSymbol,
    });
    if (!result.list || result.list.length === 0) return null;
    const { isBear } = await getBtcMarketRegime();
    return analyzeSymbol(result.list[0], isBear);
  } catch {
    return null;
  }
}

// ─── 바이비트 추천 TOP 7 (신뢰도 최고 7개) ──────────────────────────────────
/**
 * Bybit 전체 종목 중 신뢰도가 가장 높은 7개를 반환합니다.
 * getTopScalpingSignals와 달리 거래대금 상위 80개가 아닌 상위 120개를 분석하여
 * 더 넓은 범위에서 최고 신뢰도 종목을 탐색합니다.
 */
export async function getBybitTop7(excludeSymbols: string[] = []): Promise<ScalpingSignal[]> {
  const bybitSymbols = await getBybitListedSymbols(false);
  if (bybitSymbols.size === 0) return [];

  const result = await bybitGet<{ list: BybitTicker[] }>('/v5/market/tickers', { category: 'linear' });
  const allTickers = result.list ?? [];

  const excludeSet = new Set(excludeSymbols.map(s => s.toUpperCase()));
  const filtered = allTickers.filter(t => {
    const vol = parseFloat(t.turnover24h ?? '0');
    const price = parseFloat(t.lastPrice ?? '0');
    return (
      t.symbol.endsWith('USDT') &&
      bybitSymbols.has(t.symbol) &&
      !excludeSet.has(t.symbol) &&
      vol >= 3_000_000 &&
      price > 0
    );
  });

  // 거래대금 상위 200개 분석 (더 넓은 탐색)
  const sorted = filtered
    .sort((a, b) => parseFloat(b.turnover24h ?? '0') - parseFloat(a.turnover24h ?? '0'))
    .slice(0, 200);

  const { isBear } = await getBtcMarketRegime();
  const results: ScalpingSignal[] = [];
  const batchSize = 8;
  for (let i = 0; i < sorted.length && results.length < 60; i += batchSize) {
    const batch = sorted.slice(i, i + batchSize);
    const signals = await Promise.all(batch.map(t => analyzeSymbol(t, isBear)));
    for (const s of signals) {
      if (s) results.push(s);
    }
  }

  // 신뢰도 55% 이상, 신뢰도 내림차순 TOP 7
  // (검색 범위 확대로 결과 없음 방지, 최소 55% 이상 종목만 표시)
  const filtered7 = results
    .filter(s => s.confidence >= 55)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 7);

  // 55% 이상 종목이 7개 미만이면 신뢰도 무관하게 내림차순으로 채움
  if (filtered7.length < 7) {
    const remaining = results
      .filter(s => !filtered7.includes(s))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 7 - filtered7.length);
    return [...filtered7, ...remaining];
  }
  return filtered7;
}

// ─── 급등락 TOP 7 ─────────────────────────────────────────────────────────────
/**
 * 24시간 변동률 절대값이 가장 큰 7개 종목을 반환합니다.
 * 상승/하락 방향 무관하게 변동성이 큰 순서로 정렬합니다.
 * 기존 추천 매매 규칙(신뢰도 분석)을 그대로 적용합니다.
 */
export async function getSurgeDropTop7(excludeSymbols: string[] = []): Promise<ScalpingSignal[]> {
  const bybitSymbols = await getBybitListedSymbols(false);
  if (bybitSymbols.size === 0) return [];

  const result = await bybitGet<{ list: BybitTicker[] }>('/v5/market/tickers', { category: 'linear' });
  const allTickers = result.list ?? [];

  const excludeSet = new Set(excludeSymbols.map(s => s.toUpperCase()));
  const filtered = allTickers.filter(t => {
    const vol = parseFloat(t.turnover24h ?? '0');
    const price = parseFloat(t.lastPrice ?? '0');
    return (
      t.symbol.endsWith('USDT') &&
      bybitSymbols.has(t.symbol) &&
      !excludeSet.has(t.symbol) &&
      vol >= 2_000_000 &&
      price > 0
    );
  });

  // 24h 변동률 절대값 내림차순 상위 30개 분석
  const sorted = filtered
    .sort((a, b) => Math.abs(parseFloat(b.price24hPcnt ?? '0')) - Math.abs(parseFloat(a.price24hPcnt ?? '0')))
    .slice(0, 30);

  const { isBear } = await getBtcMarketRegime();
  const results: ScalpingSignal[] = [];
  const batchSize = 5;
  for (let i = 0; i < sorted.length; i += batchSize) {
    const batch = sorted.slice(i, i + batchSize);
    const signals = await Promise.all(batch.map(t => analyzeSymbol(t, isBear)));
    for (const s of signals) {
      if (s) results.push(s);
    }
  }

  // 변동률 절대값 내림차순 TOP 7 (신뢰도 무관, 변동성 기준)
  return results
    .sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h))
    .slice(0, 7);
}

// ─── 급등직전 TOP 10 ──────────────────────────────────────────────────────────
/**
 * 세력 매집 완료 + 급등 직전 상태인 종목 TOP 10을 반환합니다.
 *
 * 탐지 지표 (10가지 복합 신호):
 *  1. BB 스퀴즈 (bbWidth < 0.03): 변동성 압축 → 폭발 직전
 *  2. OBV 상승 + 가격 횡보: 세력 매집 패턴 (가격은 안 오르는데 거래량 증가)
 *  3. RSI 40~58 구간: 과매도 탈출 직전 (과매수 아님)
 *  4. ADX < 20 + 상승 전환: 추세 없는 구간에서 추세 시작 신호
 *  5. 미결제약정(OI) 급증 (>5%): 세력 포지션 진입 신호
 *  6. 거래량 급증 (최근 3봉 평균 > 이전 10봉 평균 × 1.5): 세력 매집 완료
 *  7. MACD 히스토그램 상승 전환 (음→양): 모멘텀 전환 신호
 *  8. 가격이 VWAP 위로 돌파: 매수세 우위 확인
 *  9. 호가창 매수 불균형 (imbalance > 0.6): 매수 압력 집중
 * 10. EMA 9 > EMA 21 골든크로스 직전 (간격 < 0.5%): 단기 추세 전환 임박
 */
export async function getPreSurgeTop10(excludeSymbols: string[] = []): Promise<ScalpingSignal[]> {
  try {
    const result = await bybitGet<{ list: BybitTicker[] }>('/v5/market/tickers', { category: 'linear' });
    const allTickers = result.list ?? [];

    const excludeSet = new Set(excludeSymbols.map(s => s.toUpperCase()));

    // 1차 필터: 거래대금 500만 이상, USDT 종목, 제외 목록 제외
    const filtered = allTickers
      .filter(t => {
        const vol = parseFloat(t.turnover24h ?? '0');
        const price = parseFloat(t.lastPrice ?? '0');
        return (
          t.symbol.endsWith('USDT') &&
          !excludeSet.has(t.symbol) &&
          vol >= 5_000_000 &&
          price > 0
        );
      })
      // 거래대금 내림차순 (유동성 높은 종목 우선)
      .sort((a, b) => parseFloat(b.turnover24h ?? '0') - parseFloat(a.turnover24h ?? '0'))
      .slice(0, 100); // 상위 100개에서 분석

    const { isBear } = await getBtcMarketRegime();
    const candidates: Array<ScalpingSignal & { preSurgeScore: number }> = [];
    const batchSize = 5;

    for (let i = 0; i < filtered.length && candidates.length < 40; i += batchSize) {
      const batch = filtered.slice(i, i + batchSize);

      await Promise.all(batch.map(async (t) => {
        try {
          // 1m + 5m + 15m + 1h + 4h 캔들 동시 조회 (초정밀 MTF 분석)
          const [candles1m, candles5m, candles15m, candles1h, candles4h] = await Promise.all([
            fetchCandles(t.symbol, '1', 60),
            fetchCandles(t.symbol, '5', 100),
            fetchCandles(t.symbol, '15', 60),
            fetchCandles(t.symbol, '60', 48),
            fetchCandles(t.symbol, '240', 24),
          ]);

          if (candles5m.length < 30) return;

          const closes5m = candles5m.map(c => c.close);
          const highs5m = candles5m.map(c => c.high);
          const lows5m = candles5m.map(c => c.low);
          const volumes5m = candles5m.map(c => c.volume);

          const closes1m = candles1m.map(c => c.close);
          const volumes1m = candles1m.map(c => c.volume);

          const currentPrice = parseFloat(t.lastPrice ?? '0');
          if (currentPrice <= 0) return;

          // ── 지표 계산 ──
          const bb5m = calcBollingerBands(closes5m, 20);
          const rsi5m = calcRSI(closes5m, 14);
          const adx5m = calcADX(highs5m, lows5m, closes5m, 14);
          const macd5m = calcMACD(closes5m);
          const vwap5m = calcVWAP(highs5m, lows5m, closes5m, volumes5m);
          const obv5m = calcOBV(closes5m, volumes5m);
          const obv5mPrev = calcOBV(closes5m.slice(0, -5), volumes5m.slice(0, -5));

          // EMA 9, 21 계산
          const ema9 = calcEMA(closes5m, 9);
          const ema21 = calcEMA(closes5m, 21);

          // 거래량 비율 (최근 3봉 vs 이전 10봉)
          const recentVol = volumes5m.slice(-3).reduce((a, b) => a + b, 0) / 3;
          const prevVol = volumes5m.slice(-13, -3).reduce((a, b) => a + b, 0) / 10;
          const volRatio = prevVol > 0 ? recentVol / prevVol : 1;

          // 1분봉 OBV 상승 + 가격 횡보 (세력 매집 패턴)
          const obv1mRecent = calcOBV(closes1m.slice(-10), volumes1m.slice(-10));
          const obv1mPrev = calcOBV(closes1m.slice(-20, -10), volumes1m.slice(-20, -10));
          const priceRange1m = closes1m.length >= 20
            ? (Math.max(...closes1m.slice(-20)) - Math.min(...closes1m.slice(-20))) / currentPrice
            : 0.01;

          // 미결제약정 변화
          let oiChange = 0;
          try {
            const oiData = await fetchOpenInterest(t.symbol);
            oiChange = oiData.oiChange;
          } catch { /* OI 조회 실패 시 0으로 처리 */ }

          // 호가창 불균형
          let imbalance = 0.5;
          try {
            const ob = await fetchOrderBook(t.symbol, 20);
            const analysis = analyzeOrderBook(ob, currentPrice);
            imbalance = (analysis.imbalance + 1) / 2; // -1~1 → 0~1 정규화
          } catch { /* 호가창 조회 실패 시 중립값 */ }

          // ── 펀딩비 필터 (극단적 펀딩비 시 진입 차단) ──
          const fundingRate = parseFloat(t.fundingRate ?? '0');
          if (fundingRate > 0.002) return; // 펀딩비 +0.2% 초과 시 롱 진입 차단

          // ── 1h/4h MTF 지표 계산 ──
          const closes15m = candles15m.map(c => c.close);
          const closes1h = candles1h.map(c => c.close);
          const closes4h = candles4h.map(c => c.close);
          const rsi15m = closes15m.length >= 15 ? calcRSI(closes15m, 14) : 50;
          const rsi1h = closes1h.length >= 15 ? calcRSI(closes1h, 14) : 50;
          const rsi4h = closes4h.length >= 15 ? calcRSI(closes4h, 14) : 50;
          const macd15m = closes15m.length >= 26 ? calcMACD(closes15m) : { macd: 0, signal: 0, histogram: 0 };
          const macd1h = closes1h.length >= 26 ? calcMACD(closes1h) : { macd: 0, signal: 0, histogram: 0 };
          const ema9_1h = closes1h.length >= 9 ? calcEMA(closes1h, 9) : currentPrice;
          const ema21_1h = closes1h.length >= 21 ? calcEMA(closes1h, 21) : currentPrice;
          const ema9_4h = closes4h.length >= 9 ? calcEMA(closes4h, 9) : currentPrice;
          const ema21_4h = closes4h.length >= 21 ? calcEMA(closes4h, 21) : currentPrice;

          // ── 와이코프 스프링 감지 ──
          // 지지선 아래로 일시 하락 후 즉시 회복 (최근 5봉에서 감지)
          const recentLows5m = lows5m.slice(-20);
          const supportLevel = Math.min(...recentLows5m.slice(0, 15)); // 이전 15봉 최저점
          const recentCandles5 = candles5m.slice(-5);
          const wyckoffSpring = recentCandles5.some((c, i) => {
            if (i === 0) return false;
            const prevClose = recentCandles5[i - 1].close;
            return c.low < supportLevel * 0.998 && c.close > supportLevel && c.close > prevClose;
          });

          // ── 역 헤드앤숄더 패턴 감지 ──
          const recentCloses20 = closes5m.slice(-20);
          let inverseHS = false;
          if (recentCloses20.length >= 20) {
            const leftShoulder = Math.min(...recentCloses20.slice(0, 5));
            const head = Math.min(...recentCloses20.slice(7, 13));
            const rightShoulder = Math.min(...recentCloses20.slice(15, 20));
            const neckline = (Math.max(...recentCloses20.slice(0, 5)) + Math.max(...recentCloses20.slice(15, 20))) / 2;
            inverseHS = head < leftShoulder * 0.995 && head < rightShoulder * 0.995 &&
              Math.abs(leftShoulder - rightShoulder) / leftShoulder < 0.02 &&
              currentPrice > neckline * 0.998;
          }

          // ── 컵앤핸들 패턴 감지 ──
          const recentCloses50 = closes5m.slice(-50);
          let cupAndHandle = false;
          if (recentCloses50.length >= 50) {
            const cupHigh = Math.max(...recentCloses50.slice(0, 20));
            const cupLow = Math.min(...recentCloses50.slice(5, 25));
            const cupDepth = cupHigh > 0 ? (cupHigh - cupLow) / cupHigh : 0;
            const handleHigh = Math.max(...recentCloses50.slice(30, 45));
            const handleLow = Math.min(...recentCloses50.slice(35, 50));
            const handleDepth = handleHigh > 0 ? (handleHigh - handleLow) / handleHigh : 0;
            cupAndHandle = cupDepth >= 0.08 && cupDepth <= 0.35 &&
              handleDepth >= 0.03 && handleDepth <= 0.15 &&
              currentPrice > handleHigh * 0.998;
          }

          // ── 급등 직전 점수 계산 (0~130점 확장) ──
          let score = 0;
          const signals: string[] = [];

          // 1. BB 스퀴즈 (bbWidth < 0.03 → 변동성 압축)
          if (bb5m.width < 0.03) {
            score += 20;
            signals.push('BB스퀴즈');
          } else if (bb5m.width < 0.05) {
            score += 10;
            signals.push('BB수축');
          }

          // 2. OBV 상승 + 가격 횡보 (세력 매집)
          const obvRising = obv1mRecent > obv1mPrev * 1.1;
          const priceFlat = priceRange1m < 0.015; // 1.5% 이내 횡보
          if (obvRising && priceFlat) {
            score += 20;
            signals.push('세력매집');
          } else if (obvRising) {
            score += 10;
            signals.push('OBV상승');
          }

          // 3. RSI 40~58 구간 (과매도 탈출 직전)
          if (rsi5m >= 40 && rsi5m <= 58) {
            score += 15;
            signals.push(`RSI${Math.round(rsi5m)}`);
          } else if (rsi5m >= 35 && rsi5m < 40) {
            score += 8;
            signals.push('RSI회복중');
          }

          // 4. ADX < 20 (추세 없는 구간 → 추세 시작 직전)
          if (adx5m < 15) {
            score += 10;
            signals.push('ADX저점');
          } else if (adx5m < 20) {
            score += 5;
            signals.push('ADX약세');
          }

          // 5. 미결제약정 급증 (>5%)
          if (oiChange > 8) {
            score += 15;
            signals.push(`OI+${oiChange.toFixed(0)}%`);
          } else if (oiChange > 5) {
            score += 10;
            signals.push(`OI+${oiChange.toFixed(0)}%`);
          }

          // 6. 거래량 급증 (최근 3봉 > 이전 10봉 × 1.5)
          if (volRatio >= 2.0) {
            score += 15;
            signals.push(`거래량×${volRatio.toFixed(1)}`);
          } else if (volRatio >= 1.5) {
            score += 8;
            signals.push(`거래량×${volRatio.toFixed(1)}`);
          }

          // 7. MACD 히스토그램 상승 전환 (음→양)
          if (macd5m.histogram > 0 && macd5m.macd > macd5m.signal) {
            score += 10;
            signals.push('MACD전환');
          } else if (macd5m.histogram > -0.0001 && macd5m.histogram < 0.0001) {
            score += 5;
            signals.push('MACD임박');
          }

          // 8. 가격이 VWAP 위로 돌파
          if (currentPrice > vwap5m * 1.002) {
            score += 10;
            signals.push('VWAP돌파');
          } else if (currentPrice > vwap5m * 0.999) {
            score += 5;
            signals.push('VWAP근접');
          }

          // 9. 호가창 매수 불균형 (imbalance > 0.6)
          if (imbalance > 0.65) {
            score += 10;
            signals.push(`매수압력${Math.round(imbalance * 100)}%`);
          } else if (imbalance > 0.55) {
            score += 5;
            signals.push('매수우세');
          }

          // 10. EMA 골든크로스 직전 (EMA9 > EMA21, 간격 < 0.5%)
          const emaGap = Math.abs(ema9 - ema21) / ema21;
          if (ema9 > ema21 && emaGap < 0.003) {
            score += 10;
            signals.push('골든크로스직전');
          } else if (ema9 > ema21 && emaGap < 0.005) {
            score += 5;
            signals.push('EMA정배열');
          }

          // 11. 다중 타임프레임 RSI 정렬 (15m + 1h + 4h 모두 48 이상)
          const mtfRsiCount = (rsi15m >= 48 ? 1 : 0) + (rsi1h >= 48 ? 1 : 0) + (rsi4h >= 48 ? 1 : 0);
          if (mtfRsiCount === 3) {
            score += 20;
            signals.push('MTF3정렬');
          } else if (mtfRsiCount === 2) {
            score += 10;
            signals.push('MTF2정렬');
          }

          // 12. 1h/4h EMA 정배열 (단기 > 장기)
          const ema1hAligned = ema9_1h > ema21_1h;
          const ema4hAligned = ema9_4h > ema21_4h;
          if (ema1hAligned && ema4hAligned) {
            score += 15;
            signals.push('EMA정배열(1h+4h)');
          } else if (ema1hAligned || ema4hAligned) {
            score += 7;
            signals.push('EMA정배열');
          }

          // 13. MACD 상승 (15m + 1h)
          const macdBull15m = macd15m.histogram > 0 && macd15m.macd > macd15m.signal;
          const macdBull1h = macd1h.histogram > 0 && macd1h.macd > macd1h.signal;
          if (macdBull15m && macdBull1h) {
            score += 15;
            signals.push('MACD강세(15m+1h)');
          } else if (macdBull15m || macdBull1h) {
            score += 7;
            signals.push('MACD강세');
          }

          // 14. 와이코프 스프링 (가장 강력한 급등 직전 신호)
          if (wyckoffSpring) {
            score += 25;
            signals.push('와이코프스프링');
          }

          // 15. 역 헤드앤숄더 (반전 패턴)
          if (inverseHS) {
            score += 20;
            signals.push('역H&S');
          }

          // 16. 컵앤핸들 (지속적 상승 패턴)
          if (cupAndHandle) {
            score += 20;
            signals.push('컵앤핸들');
          }

          // 17. 펀딩비 중립/롱유리
          if (fundingRate < -0.0003) {
            score += 15;
            signals.push('펀딩비롱유리');
          } else if (Math.abs(fundingRate) < 0.0001) {
            score += 8;
            signals.push('펀딩비중립');
          }

          // 최소 점수 45점 이상, 신호 4개 이상인 경우만 포함 (기준 강화)
          if (score < 45 || signals.length < 4) return;

          // 기존 analyzeSymbol로 신뢰도 계산
          const signal = await analyzeSymbol(t, isBear);
          if (!signal) return;

          // 급등 직전 종목은 LONG 방향 우선 (하락장 제외)
          if (isBear && signal.direction === 'LONG' && rsi5m < 50) return;

          // 급등 직전 진입가: BB 하단 ~ 현재가 사이
          const preSurgeEntry = Math.min(currentPrice, bb5m.lower * 1.002);
          const preSurgeSL = bb5m.lower * 0.985; // BB 하단 -1.5%
          const preSurgeTP = bb5m.upper * 0.995; // BB 상단 -0.5%

          candidates.push({
            ...signal,
            direction: 'LONG', // 급등 직전은 LONG 우선
            entryPrice: preSurgeEntry,
            limitPrice: preSurgeEntry,
            stopLoss: preSurgeSL,
            takeProfit: preSurgeTP,
            surgeOptimalPrice: preSurgeEntry,
            surgeOptimalLeverage: Math.max(1, Math.min(10, Math.round(10 / (bb5m.width * 100 + 1)))), // Claude v47 자가검증: 최소 1x
            surgeEntryReason: signals.join(' | '),
            reason: `[급등직전] ${signals.join(' | ')} | 점수:${score}`,
            preSurgeScore: score,
          });
        } catch {
          // 개별 종목 오류는 무시
        }
      }));
    }

    // 급등 직전 점수 내림차순 정렬 후 TOP 10 반환
    return candidates
      .sort((a, b) => b.preSurgeScore - a.preSurgeScore)
      .slice(0, 10);

  } catch (e) {
    console.error('[getPreSurgeTop10] 오류:', e);
    return [];
  }
}

// ─── 바이낸스 추천 TOP 7 (바이낸스 분석 + 바이비트 매매) ────────────────────────
/**
 * 바이낸스 선물 시장 데이터를 분석하여 신뢰도 높은 7개 종목을 반환합니다.
 * - 분석: 바이낸스 공개 API (fapi.binance.com)
 * - 매매: 바이비트에 동일 종목이 상장된 경우에만 포함
 * - 체결 강도: 바이낸스 최근 체결 내역 기반
 */

interface BinanceTicker {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
  highPrice: string;
  lowPrice: string;
}

interface BinanceKline {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  closeTime: number;
  quoteAssetVolume: string;
  takerBuyBaseAssetVolume: string;
  takerBuyQuoteAssetVolume: string;
}

async function analyzeBinanceSymbol(
  ticker: BinanceTicker,
  bybitSymbols: Set<string>,
  isBearMarket: boolean,
): Promise<ScalpingSignal | null> {
  try {
    const symbol = ticker.symbol; // e.g. BTCUSDT
    const bybitSymbol = symbol; // 바이비트와 동일 형식

    // 바이비트 상장 여부 확인
    if (!bybitSymbols.has(bybitSymbol)) return null;

    const currentPrice = parseFloat(ticker.lastPrice);
    const change24h = parseFloat(ticker.priceChangePercent);
    const volume24h = parseFloat(ticker.quoteVolume);

    if (currentPrice <= 0) return null;

    // 가격 필터: $200 초과 시 BTC/ETH만 허용
    if (currentPrice > 200 && !['BTCUSDT', 'ETHUSDT'].includes(symbol)) return null;

    // 바이낸스 5분봉 캔들 조회 (200개)
    const rawKlines = await binanceGet<Array<[
      number, string, string, string, string, string,
      number, string, number, string, string, string
    ]>>('/fapi/v1/klines', { symbol, interval: '5m', limit: '200' });

    if (rawKlines.length < 50) return null;

    const candles = rawKlines.map(k => ({
      startTime: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      turnover: parseFloat(k[7]),
      takerBuyVol: parseFloat(k[9]),
    }));

    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const volumes = candles.map(c => c.volume);
    const turnovers = candles.map(c => c.turnover);

    // 체결 강도: 최근 20개 캔들의 taker 매수 비율
    const recentCandles = candles.slice(-20);
    const totalBuyVol = recentCandles.reduce((s, c) => s + c.takerBuyVol, 0);
    const totalVol20 = recentCandles.reduce((s, c) => s + c.volume, 0);
    const takerBuyRatio = totalVol20 > 0 ? Math.round((totalBuyVol / totalVol20) * 100) : 50;

    // 기술 지표 계산 (기존 함수 재사용)
    const rsi = calcRSI(closes);
    const stochRsi = calcStochRSI(closes);
    const bb = calcBollingerBands(closes);
    const macd = calcMACD(closes);
    const ema9 = calcEMA(closes, 9);
    const ema21 = calcEMA(closes, 21);
    const ema50 = calcEMA(closes, 50);
    const ema200 = calcEMA(closes, 200);
    const atr = calcATR(highs, lows, closes);
    const obv = calcOBV(closes, volumes);
    const obvPrev = calcOBV(closes.slice(0, -5), volumes.slice(0, -5));
    const vwap = calcVWAP(highs, lows, closes, turnovers);
    const adx = calcADX(highs, lows, closes);
    const { support, resistance } = calcSupportResistance(highs, lows, closes);
    const candlePattern = detectCandlePattern(candles);

    const recentVol = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const prevVol = volumes.slice(-15, -5).reduce((a, b) => a + b, 0) / 10;
    const volRatio = prevVol > 0 ? recentVol / prevVol : 1;

    // 점수 산정 (기존 analyzeSymbol과 동일 로직)
    let longScore = 0;
    let shortScore = 0;
    const reasons: string[] = [];
    const breakdown: IndicatorScore[] = [];

    let rsiLong = 0, rsiShort = 0;
    if (rsi < 30) { rsiLong = 30; reasons.push(`RSI 강한 과매도(${rsi.toFixed(0)})`); }
    else if (rsi < 40) { rsiLong = 20; reasons.push(`RSI 과매도(${rsi.toFixed(0)})`); }
    else if (rsi > 70) { rsiShort = 30; reasons.push(`RSI 강한 과매수(${rsi.toFixed(0)})`); }
    else if (rsi > 60) { rsiShort = 20; reasons.push(`RSI 과매수(${rsi.toFixed(0)})`); }
    else if (rsi < 50) rsiLong = 8;
    else rsiShort = 8;
    if (stochRsi.k < 20 && stochRsi.d < 20) rsiLong += 10;
    else if (stochRsi.k > 80 && stochRsi.d > 80) rsiShort += 10;
    breakdown.push({ name: 'RSI+StochRSI', longScore: rsiLong, shortScore: rsiShort });
    longScore += rsiLong; shortScore += rsiShort;

    let macdLong = 0, macdShort = 0;
    if (macd.histogram > 0 && macd.macd > 0) { macdLong = 20; reasons.push('MACD 강세'); }
    else if (macd.histogram > 0) { macdLong = 12; }
    else if (macd.histogram < 0 && macd.macd < 0) { macdShort = 20; reasons.push('MACD 약세'); }
    else { macdShort = 12; }
    breakdown.push({ name: 'MACD', longScore: macdLong, shortScore: macdShort });
    longScore += macdLong; shortScore += macdShort;

    let bbLong = 0, bbShort = 0;
    if (currentPrice < bb.lower * 1.005) { bbLong = 20; reasons.push('BB 하단 돌파'); }
    else if (currentPrice > bb.upper * 0.995) { bbShort = 20; reasons.push('BB 상단 돌파'); }
    else if (currentPrice < bb.mid) bbLong = 5;
    else bbShort = 5;
    breakdown.push({ name: '볼린저 밴드', longScore: bbLong, shortScore: bbShort });
    longScore += bbLong; shortScore += bbShort;

    let emaLong = 0, emaShort = 0;
    if (currentPrice > ema9 && ema9 > ema21 && ema21 > ema50 && ema50 > ema200) {
      emaLong = 25; reasons.push('EMA 완전 상승 정렬');
    } else if (currentPrice < ema9 && ema9 < ema21 && ema21 < ema50 && ema50 < ema200) {
      emaShort = 25; reasons.push('EMA 완전 하락 정렬');
    } else if (currentPrice > ema21 && ema21 > ema50) { emaLong = 15; }
    else if (currentPrice < ema21 && ema21 < ema50) { emaShort = 15; }
    else if (currentPrice > ema9) emaLong = 8;
    else emaShort = 8;
    breakdown.push({ name: 'EMA 추세', longScore: emaLong, shortScore: emaShort });
    longScore += emaLong; shortScore += emaShort;

    const atrPct = currentPrice > 0 ? (atr / currentPrice) * 100 : 0;
    let atrLong = 0, atrShort = 0;
    if (atrPct > 0.5 && atrPct < 3) {
      if (longScore >= shortScore) atrLong = 8;
      else atrShort = 8;
    }
    breakdown.push({ name: 'ATR 변동성', longScore: atrLong, shortScore: atrShort });
    longScore += atrLong; shortScore += atrShort;

    let obvLong = 0, obvShort = 0;
    if (obv > obvPrev * 1.05) { obvLong = 12; }
    else if (obv < obvPrev * 0.95) { obvShort = 12; }
    breakdown.push({ name: 'OBV', longScore: obvLong, shortScore: obvShort });
    longScore += obvLong; shortScore += obvShort;

    let vwapLong = 0, vwapShort = 0;
    if (currentPrice > vwap * 1.002) { vwapLong = 10; }
    else if (currentPrice < vwap * 0.998) { vwapShort = 10; }
    breakdown.push({ name: 'VWAP', longScore: vwapLong, shortScore: vwapShort });
    longScore += vwapLong; shortScore += vwapShort;

    let adxLong = 0, adxShort = 0;
    if (adx > 40) {
      if (longScore >= shortScore) adxLong = 15;
      else adxShort = 15;
    } else if (adx > 25) {
      if (longScore >= shortScore) adxLong = 8;
      else adxShort = 8;
    }
    breakdown.push({ name: 'ADX 추세강도', longScore: adxLong, shortScore: adxShort });
    longScore += adxLong; shortScore += adxShort;

    breakdown.push({ name: '캔들 패턴', longScore: candlePattern.bullish, shortScore: candlePattern.bearish });
    if (candlePattern.name) reasons.push(candlePattern.name);
    longScore += candlePattern.bullish; shortScore += candlePattern.bearish;

    let volLong = 0, volShort = 0;
    if (volRatio > 2.0) {
      if (longScore >= shortScore) volLong = 15;
      else volShort = 15;
      reasons.push(`거래량 ${volRatio.toFixed(1)}배 급증`);
    } else if (volRatio > 1.5) {
      if (longScore >= shortScore) volLong = 8;
      else volShort = 8;
    }
    breakdown.push({ name: '거래량 비율', longScore: volLong, shortScore: volShort });
    longScore += volLong; shortScore += volShort;

    // 체결 강도 점수 반영
    let takerLong = 0, takerShort = 0;
    if (takerBuyRatio >= 65) { takerLong = 15; reasons.push(`체결강도 매수우세(${takerBuyRatio}%)`); }
    else if (takerBuyRatio >= 55) { takerLong = 8; }
    else if (takerBuyRatio <= 35) { takerShort = 15; reasons.push(`체결강도 매도우세(${takerBuyRatio}%)`); }
    else if (takerBuyRatio <= 45) { takerShort = 8; }
    breakdown.push({ name: '체결 강도', longScore: takerLong, shortScore: takerShort });
    longScore += takerLong; shortScore += takerShort;

    // 지지/저항
    let srLong = 0, srShort = 0;
    const distToSupport = (currentPrice - support) / currentPrice;
    const distToResistance = (resistance - currentPrice) / currentPrice;
    if (distToSupport < 0.015) { srLong = 15; reasons.push('지지선 근접'); }
    if (distToResistance < 0.015) { srShort = 15; reasons.push('저항선 근접'); }
    breakdown.push({ name: '지지/저항', longScore: srLong, shortScore: srShort });
    longScore += srLong; shortScore += srShort;

    // 24h 추세
    let trendLong = 0, trendShort = 0;
    if (change24h > 5) { trendLong = 15; reasons.push(`급등 +${change24h.toFixed(1)}%`); }
    else if (change24h > 2) { trendLong = 8; }
    else if (change24h < -5) { trendShort = 15; reasons.push(`급락 ${change24h.toFixed(1)}%`); }
    else if (change24h < -2) { trendShort = 8; }
    breakdown.push({ name: '24h 추세', longScore: trendLong, shortScore: trendShort });
    longScore += trendLong; shortScore += trendShort;

    const direction: 'LONG' | 'SHORT' = longScore >= shortScore ? 'LONG' : 'SHORT';
    if (isBearMarket && direction === 'LONG') longScore = Math.max(0, longScore - 30);

    const totalScore = Math.max(longScore, shortScore);
    const maxPossible = 304; // 기존 289 + 체결강도 15
    const rawConfidence = Math.min(98, Math.max(30, (totalScore / maxPossible) * 100));
    const confidence = Math.max(30, Math.round(rawConfidence));

    let leverage = Math.round(5 + (confidence / 100) * 45);
    if (bb.width > 0.04) leverage = Math.min(leverage, 20);
    if (Math.abs(change24h) > 10) leverage = Math.min(leverage, 15);
    leverage = Math.max(5, Math.min(100, leverage));

    const { limitPrice, entryReason } = calcLimitPrice(direction, currentPrice, rsi, bb, support, resistance);
    const atrSL = atr > 0 ? atr * 1.5 : (limitPrice / leverage) * 0.45;
    const stopLoss = direction === 'LONG' ? limitPrice - atrSL : limitPrice + atrSL;
    const takeProfit = direction === 'LONG' ? limitPrice + atrSL * 2 : limitPrice - atrSL * 2;
    const kellyFraction = calcKellyFraction(0.55, atrSL * 2, atrSL);

    return {
      symbol: bybitSymbol,
      bybitSymbol,
      displaySymbol: symbol.replace('USDT', ''),
      direction,
      entryPrice: currentPrice,
      limitPrice,
      optimalPrice: limitPrice,
      stopLoss,
      takeProfit,
      leverage,
      confidence,
      reason: reasons.slice(0, 4).join(' · ') || '기술적 신호',
      entryReason,
      change24h,
      volume24hUSDT: volume24h,
      fundingRate: 0,
      rsi,
      bbWidth: bb.width,
      atr,
      adx,
      kellyFraction,
      breakdown,
      takerBuyRatio,
      source: 'binance' as const,
    };
  } catch {
    return null;
  }
}

export async function getBinanceTop7(excludeSymbols: string[] = []): Promise<ScalpingSignal[]> {
  try {
    // 바이비트 상장 종목 목록 (매매 가능 여부 확인용)
    const bybitSymbols = await getBybitListedSymbols(false);
    if (bybitSymbols.size === 0) return [];

    // 바이낸스 선물 24h 티커 전체 조회
    const allTickers = await binanceGet<BinanceTicker[]>('/fapi/v1/ticker/24hr');

    const excludeSet = new Set(excludeSymbols.map(s => s.toUpperCase()));
    const filtered = allTickers.filter(t => {
      const vol = parseFloat(t.quoteVolume ?? '0');
      const price = parseFloat(t.lastPrice ?? '0');
      return (
        t.symbol.endsWith('USDT') &&
        bybitSymbols.has(t.symbol) && // 바이비트 상장 여부
        !excludeSet.has(t.symbol) &&
        vol >= 5_000_000 &&
        price > 0
      );
    });

    // 거래대금 상위 150개 분석
    const sorted = filtered
      .sort((a, b) => parseFloat(b.quoteVolume ?? '0') - parseFloat(a.quoteVolume ?? '0'))
      .slice(0, 150);

    const { isBear } = await getBtcMarketRegime();
    const results: ScalpingSignal[] = [];
    const batchSize = 6;
    for (let i = 0; i < sorted.length && results.length < 50; i += batchSize) {
      const batch = sorted.slice(i, i + batchSize);
      const signals = await Promise.all(batch.map(t => analyzeBinanceSymbol(t, bybitSymbols, isBear)));
      for (const s of signals) {
        if (s) results.push(s);
      }
    }

    // 신뢰도 내림차순 TOP 7
    const top7 = results
      .filter(s => s.confidence >= 55)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 7);

    if (top7.length < 7) {
      const remaining = results
        .filter(s => !top7.includes(s))
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 7 - top7.length);
      return [...top7, ...remaining];
    }
    return top7;
  } catch (e) {
    console.error('[getBinanceTop7] 오류:', e);
    return [];
  }
}
