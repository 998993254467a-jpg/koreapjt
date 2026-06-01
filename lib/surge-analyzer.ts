/**
 * surge-analyzer.ts
 * 멀티소스 급등 신호 종합 분석 엔진
 *
 * ▶ 분석 소스 7가지:
 *   1. 뉴스 감성 분석 (CryptoPanic RSS + CoinDesk RSS — 무료, API 키 불필요)
 *   2. 세력 매집 감지 (OBV 급증 + 거래량 이상 + 가격 횡보 패턴)
 *   3. 오더북 불균형 (매수벽/매도벽 비율, Bybit 호가창)
 *   4. 펀딩비 역전 신호 (극단적 펀딩비 → 반전 가능성)
 *   5. 미결제약정 급증 (신규 자금 유입 = 강한 방향성)
 *   6. 체결 강도 (Taker Buy Ratio — 매수 체결 우세 여부)
 *   7. 시장 컨텍스트 연동 (BTC/ETH 추세 + 공포탐욕지수)
 *
 * ▶ 뉴스 이벤트 분류:
 *   - BULLISH_MACRO: ETF 승인, 기관 매수, 규제 완화, 반감기
 *   - BEARISH_MACRO: 규제 강화, 거래소 해킹, 고래 대량 매도, 전쟁/위기
 *   - BULLISH_SPECIFIC: 특정 종목 호재 (파트너십, 업그레이드, 상장)
 *   - BEARISH_SPECIFIC: 특정 종목 악재 (해킹, 스캠, 상장폐지)
 *   - NEUTRAL: 일반 뉴스
 */

import { getMarketContext, type MarketContext } from './market-context';

const BINANCE_BASE = 'https://fapi.binance.com';

// ─── 타입 ────────────────────────────────────────────────────────────────────

export type NewsEventType =
  | 'BULLISH_MACRO'
  | 'BEARISH_MACRO'
  | 'BULLISH_SPECIFIC'
  | 'BEARISH_SPECIFIC'
  | 'NEUTRAL';

export interface NewsEvent {
  title: string;
  url: string;
  publishedAt: number;      // Unix timestamp (ms)
  sentiment: NewsEventType;
  impactScore: number;      // 0~10 (시장 영향력)
  relatedSymbols: string[]; // 관련 종목 (빈 배열 = 전체 시장)
  source: string;           // 'cryptopanic' | 'coindesk' | 'cointelegraph'
}

export interface SurgeSignalSource {
  name: string;
  score: number;      // 0~100 (해당 소스의 급등 신호 강도)
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  detail: string;     // 근거 설명
}

export interface SurgeAnalysisResult {
  symbol: string;
  bybitSymbol: string;
  totalScore: number;         // 0~100 (7개 소스 종합 점수)
  direction: 'LONG' | 'SHORT';
  confidence: number;         // 0~100
  sources: SurgeSignalSource[];
  newsEvents: NewsEvent[];    // 관련 뉴스
  marketImpact: string;       // 시장 컨텍스트 영향 설명
  entryReason: string;        // 진입 근거 한 줄 요약
  urgency: 'HIGH' | 'MEDIUM' | 'LOW'; // 진입 긴급도
}

// ─── 뉴스 캐시 ───────────────────────────────────────────────────────────────

let _newsCache: NewsEvent[] = [];
let _newsCacheAt = 0;
const NEWS_CACHE_TTL = 3 * 60 * 1000; // 3분 캐시

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
  return res.json() as Promise<T>;
}

// ─── 뉴스 감성 분석 ──────────────────────────────────────────────────────────

// 강세 키워드 (영문)
const BULLISH_KEYWORDS = [
  'etf approved', 'etf approval', 'institutional buy', 'institutional investment',
  'sec approved', 'halving', 'all-time high', 'ath', 'bull run', 'rally',
  'partnership', 'upgrade', 'mainnet launch', 'listing', 'adoption',
  'whale buy', 'accumulation', 'breakout', 'surge', 'soar', 'moon',
  'regulatory clarity', 'legal tender', 'reserve', 'treasury',
];

// 약세 키워드 (영문)
const BEARISH_KEYWORDS = [
  'hack', 'hacked', 'exploit', 'rug pull', 'scam', 'fraud', 'ponzi',
  'ban', 'banned', 'crackdown', 'regulation', 'sec charges', 'lawsuit',
  'crash', 'collapse', 'bankrupt', 'insolvency', 'delisting',
  'whale sell', 'dump', 'bear', 'correction', 'selloff',
  'war', 'crisis', 'recession', 'inflation',
];

// 고영향 키워드 (임팩트 스코어 +3)
const HIGH_IMPACT_KEYWORDS = [
  'etf', 'sec', 'federal reserve', 'fed', 'blackrock', 'fidelity',
  'coinbase', 'binance', 'bybit', 'hack', 'exploit', 'ban',
  'bitcoin', 'ethereum', 'btc', 'eth',
];

function analyzeNewsSentiment(title: string, description: string = ''): {
  sentiment: NewsEventType;
  impactScore: number;
} {
  const text = (title + ' ' + description).toLowerCase();

  let bullishCount = 0;
  let bearishCount = 0;
  let impactScore = 3; // 기본 임팩트

  for (const kw of BULLISH_KEYWORDS) {
    if (text.includes(kw)) bullishCount++;
  }
  for (const kw of BEARISH_KEYWORDS) {
    if (text.includes(kw)) bearishCount++;
  }
  for (const kw of HIGH_IMPACT_KEYWORDS) {
    if (text.includes(kw)) impactScore = Math.min(10, impactScore + 1);
  }

  if (bullishCount === 0 && bearishCount === 0) {
    return { sentiment: 'NEUTRAL', impactScore: Math.min(impactScore, 4) };
  }

  const sentiment: NewsEventType = bullishCount > bearishCount ? 'BULLISH_MACRO' : 'BEARISH_MACRO';
  return { sentiment, impactScore: Math.min(10, impactScore + Math.max(bullishCount, bearishCount)) };
}

function extractRelatedSymbols(text: string): string[] {
  const symbols: string[] = [];
  const knownSymbols = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA', 'DOGE', 'AVAX', 'DOT', 'MATIC', 'LINK', 'UNI', 'ATOM', 'LTC', 'BCH', 'FIL', 'APT', 'ARB', 'OP', 'SUI'];
  const upper = text.toUpperCase();
  for (const sym of knownSymbols) {
    if (upper.includes(sym)) symbols.push(sym);
  }
  return [...new Set(symbols)];
}

// CryptoPanic 공개 RSS (API 키 불필요)
async function fetchCryptoPanicNews(): Promise<NewsEvent[]> {
  try {
    const res = await fetchWithTimeout(
      'https://cryptopanic.com/api/v1/posts/?auth_token=public&public=true&kind=news&filter=hot',
      6000
    );
    if (!res.ok) return [];
    const json = await res.json() as { results?: Array<{ title: string; url: string; published_at: string; source: { title: string } }> };
    const items = json.results ?? [];
    return items.slice(0, 20).map(item => {
      const { sentiment, impactScore } = analyzeNewsSentiment(item.title);
      return {
        title: item.title,
        url: item.url,
        publishedAt: new Date(item.published_at).getTime(),
        sentiment,
        impactScore,
        relatedSymbols: extractRelatedSymbols(item.title),
        source: 'cryptopanic',
      };
    });
  } catch {
    return [];
  }
}

// CoinDesk RSS
async function fetchCoinDeskNews(): Promise<NewsEvent[]> {
  try {
    const res = await fetchWithTimeout('https://www.coindesk.com/arc/outboundfeeds/rss/', 6000);
    if (!res.ok) return [];
    const text = await res.text();
    // RSS XML 파싱 (간단한 정규식)
    const items: NewsEvent[] = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(text)) !== null && items.length < 15) {
      const itemText = match[1];
      const titleMatch = /<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/.exec(itemText);
      const linkMatch = /<link>(.*?)<\/link>/.exec(itemText);
      const pubDateMatch = /<pubDate>(.*?)<\/pubDate>/.exec(itemText);
      const title = titleMatch?.[1] ?? titleMatch?.[2] ?? '';
      const url = linkMatch?.[1] ?? '';
      const pubDate = pubDateMatch?.[1] ? new Date(pubDateMatch[1]).getTime() : Date.now();
      if (!title) continue;
      const { sentiment, impactScore } = analyzeNewsSentiment(title);
      items.push({
        title, url, publishedAt: pubDate, sentiment, impactScore,
        relatedSymbols: extractRelatedSymbols(title),
        source: 'coindesk',
      });
    }
    return items;
  } catch {
    return [];
  }
}

// CoinTelegraph RSS
async function fetchCoinTelegraphNews(): Promise<NewsEvent[]> {
  try {
    const res = await fetchWithTimeout('https://cointelegraph.com/rss', 6000);
    if (!res.ok) return [];
    const text = await res.text();
    const items: NewsEvent[] = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(text)) !== null && items.length < 15) {
      const itemText = match[1];
      const titleMatch = /<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/.exec(itemText);
      const linkMatch = /<link>(.*?)<\/link>/.exec(itemText);
      const pubDateMatch = /<pubDate>(.*?)<\/pubDate>/.exec(itemText);
      const title = titleMatch?.[1] ?? titleMatch?.[2] ?? '';
      const url = linkMatch?.[1] ?? '';
      const pubDate = pubDateMatch?.[1] ? new Date(pubDateMatch[1]).getTime() : Date.now();
      if (!title) continue;
      const { sentiment, impactScore } = analyzeNewsSentiment(title);
      items.push({
        title, url, publishedAt: pubDate, sentiment, impactScore,
        relatedSymbols: extractRelatedSymbols(title),
        source: 'cointelegraph',
      });
    }
    return items;
  } catch {
    return [];
  }
}

/**
 * 전체 뉴스 조회 (3개 소스 병렬, 3분 캐시)
 */
export async function fetchLatestNews(forceRefresh = false): Promise<NewsEvent[]> {
  const now = Date.now();
  if (!forceRefresh && _newsCache.length > 0 && now - _newsCacheAt < NEWS_CACHE_TTL) {
    return _newsCache;
  }
  try {
    const [cp, cd, ct] = await Promise.all([
      fetchCryptoPanicNews(),
      fetchCoinDeskNews(),
      fetchCoinTelegraphNews(),
    ]);
    // 중복 제거 + 최신순 정렬
    const all = [...cp, ...cd, ...ct]
      .sort((a, b) => b.publishedAt - a.publishedAt)
      .filter((item, idx, arr) => arr.findIndex(x => x.title === item.title) === idx)
      .slice(0, 50);
    _newsCache = all;
    _newsCacheAt = now;
    return all;
  } catch {
    return _newsCache;
  }
}

/**
 * 특정 종목 관련 뉴스 필터링
 */
export function getNewsForSymbol(news: NewsEvent[], displaySymbol: string): NewsEvent[] {
  const sym = displaySymbol.toUpperCase();
  return news.filter(n =>
    n.relatedSymbols.includes(sym) ||
    n.relatedSymbols.length === 0 && (n.sentiment === 'BULLISH_MACRO' || n.sentiment === 'BEARISH_MACRO')
  );
}

/**
 * 뉴스 기반 시장 영향 점수 계산 (-100 ~ +100)
 * 양수 = 강세, 음수 = 약세
 */
export function calcNewsImpactScore(news: NewsEvent[], symbol?: string): number {
  const now = Date.now();
  const recent = news.filter(n => now - n.publishedAt < 2 * 60 * 60 * 1000); // 최근 2시간
  const relevant = symbol
    ? recent.filter(n => n.relatedSymbols.includes(symbol) || n.relatedSymbols.length === 0)
    : recent;

  let score = 0;
  for (const n of relevant) {
    // 시간 가중치: 최근일수록 높음 (최대 1.0, 2시간 전 0.1)
    const ageHours = (now - n.publishedAt) / (1000 * 60 * 60);
    const timeWeight = Math.max(0.1, 1 - ageHours / 2);
    const impact = n.impactScore * timeWeight;

    if (n.sentiment === 'BULLISH_MACRO' || n.sentiment === 'BULLISH_SPECIFIC') score += impact;
    else if (n.sentiment === 'BEARISH_MACRO' || n.sentiment === 'BEARISH_SPECIFIC') score -= impact;
  }
  return Math.max(-100, Math.min(100, score * 5));
}

// ─── 오더북 불균형 분석 ──────────────────────────────────────────────────────

interface OrderBookData {
  bids: [string, string][];
  asks: [string, string][];
}

async function fetchOrderBook(bybitSymbol: string): Promise<{ imbalanceRatio: number; hasBidWall: boolean; hasAskWall: boolean }> {
  try {
    const result = await binanceGet<OrderBookData>(
      '/fapi/v1/depth',
      { symbol: bybitSymbol, limit: '50' }
    );
    const bids = result.bids ?? [];
    const asks = result.asks ?? [];

    const bidTotal = bids.reduce((s, [, qty]) => s + parseFloat(qty), 0);
    const askTotal = asks.reduce((s, [, qty]) => s + parseFloat(qty), 0);
    const total = bidTotal + askTotal;
    const imbalanceRatio = total > 0 ? (bidTotal - askTotal) / total : 0; // -1~+1

    // 매수벽/매도벽 감지: 상위 5개 호가 중 단일 호가가 전체의 30% 이상
    const topBidQtys = bids.slice(0, 5).map(([, q]) => parseFloat(q));
    const topAskQtys = asks.slice(0, 5).map(([, q]) => parseFloat(q));
    const maxBidQty = Math.max(...topBidQtys);
    const maxAskQty = Math.max(...topAskQtys);
    const hasBidWall = bidTotal > 0 && maxBidQty / bidTotal >= 0.3;
    const hasAskWall = askTotal > 0 && maxAskQty / askTotal >= 0.3;

    return { imbalanceRatio, hasBidWall, hasAskWall };
  } catch {
    return { imbalanceRatio: 0, hasBidWall: false, hasAskWall: false };
  }
}

// ─── 세력 매집 감지 ──────────────────────────────────────────────────────────

interface KlineCandle {
  open: number; high: number; low: number; close: number; volume: number;
}

async function fetchCandles(bybitSymbol: string, interval: string, limit: number): Promise<KlineCandle[]> {
  // Bybit interval → Binance interval 변환
  const ivMap: Record<string, string> = { '1': '1m', '3': '3m', '5': '5m', '15': '15m', '30': '30m', '60': '1h', '120': '2h', '240': '4h', 'D': '1d' };
  const binanceInterval = ivMap[interval] ?? interval;
  try {
    const result = await binanceGet<[number, string, string, string, string, string, ...unknown[]][]>(
      '/fapi/v1/klines',
      { symbol: bybitSymbol, interval: binanceInterval, limit: String(limit) }
    );
    // Binance: 오래된순 정렬 (역순 불필요)
    return result.map(c => ({
      open: parseFloat(c[1] as string), high: parseFloat(c[2] as string), low: parseFloat(c[3] as string),
      close: parseFloat(c[4] as string), volume: parseFloat(c[5] as string),
    }));
  } catch {
    return [];
  }
}

function detectAccumulation(candles: KlineCandle[]): { score: number; detail: string } {
  if (candles.length < 20) return { score: 0, detail: '데이터 부족' };

  const recent = candles.slice(-10);
  const prev = candles.slice(-20, -10);

  // 1. OBV 급증: 최근 거래량이 이전 대비 2배 이상
  const recentVol = recent.reduce((s, c) => s + c.volume, 0) / recent.length;
  const prevVol = prev.reduce((s, c) => s + c.volume, 0) / prev.length;
  const volRatio = prevVol > 0 ? recentVol / prevVol : 1;

  // 2. 가격 횡보: 최근 10개 캔들의 변동폭이 좁음 (ATR 기준)
  const priceRange = recent.reduce((s, c) => s + (c.high - c.low), 0) / recent.length;
  const avgPrice = recent.reduce((s, c) => s + c.close, 0) / recent.length;
  const volatility = avgPrice > 0 ? (priceRange / avgPrice) * 100 : 0;

  // 3. 거래량 증가 + 가격 횡보 = 세력 매집 패턴
  const isAccumulating = volRatio >= 1.5 && volatility < 3;

  // 4. 하락 후 거래량 급증 = 바닥 매집
  const recentTrend = (recent[recent.length - 1].close - recent[0].close) / recent[0].close * 100;
  const isBottomAccumulation = recentTrend < -5 && volRatio >= 2;

  let score = 0;
  let detail = '';

  if (isBottomAccumulation) {
    score = 80;
    detail = `바닥 매집 감지 (하락 ${recentTrend.toFixed(1)}% + 거래량 ${volRatio.toFixed(1)}배)`;
  } else if (isAccumulating) {
    score = 65;
    detail = `횡보 매집 감지 (변동성 ${volatility.toFixed(1)}% + 거래량 ${volRatio.toFixed(1)}배)`;
  } else if (volRatio >= 2) {
    score = 50;
    detail = `거래량 급증 (${volRatio.toFixed(1)}배)`;
  } else {
    score = 20;
    detail = `일반 거래량 (${volRatio.toFixed(1)}배)`;
  }

  return { score, detail };
}

// ─── 체결 강도 분석 ──────────────────────────────────────────────────────────

async function fetchTakerBuyRatio(bybitSymbol: string): Promise<{ ratio: number; detail: string }> {
  try {
    // 최근 체결 내역 조회 (Binance FAPI)
    const tradeList = (await binanceGet<Array<{ qty: string; isBuyerMaker: boolean }>>(
      '/fapi/v1/trades',
      { symbol: bybitSymbol, limit: '100' }
    )) ?? [];
    if (tradeList.length === 0) return { ratio: 50, detail: '체결 데이터 없음' };

    // Binance: isBuyerMaker=true → 매도 체결, false → 매수 체결
    const buyVol = tradeList.filter(t => !t.isBuyerMaker).reduce((s, t) => s + parseFloat(t.qty), 0);
    const totalVol = tradeList.reduce((s, t) => s + parseFloat(t.qty), 0);
    const ratio = totalVol > 0 ? (buyVol / totalVol) * 100 : 50;

    let detail = '';
    if (ratio >= 65) detail = `매수 체결 강세 (${ratio.toFixed(0)}%)`;
    else if (ratio <= 35) detail = `매도 체결 강세 (${(100 - ratio).toFixed(0)}%)`;
    else detail = `중립 체결 (매수 ${ratio.toFixed(0)}%)`;

    return { ratio, detail };
  } catch {
    return { ratio: 50, detail: '체결 조회 실패' };
  }
}

// ─── 메인 분석 함수 ──────────────────────────────────────────────────────────

/**
 * 단일 종목 급등 신호 종합 분석
 */
export async function analyzeSurgeSignal(
  bybitSymbol: string,
  displaySymbol: string,
  marketCtx?: MarketContext,
): Promise<SurgeAnalysisResult> {
  // 병렬 조회
  const [candles15m, orderBook, takerBuy, news, ctx] = await Promise.all([
    fetchCandles(bybitSymbol, '15', 30),
    fetchOrderBook(bybitSymbol),
    fetchTakerBuyRatio(bybitSymbol),
    fetchLatestNews(),
    marketCtx ? Promise.resolve(marketCtx) : getMarketContext(),
  ]);

  const sources: SurgeSignalSource[] = [];

  // ── 소스 1: 뉴스 감성 ──
  const symbolNews = getNewsForSymbol(news, displaySymbol);
  const newsScore = calcNewsImpactScore(news, displaySymbol);
  const newsDir: 'LONG' | 'SHORT' | 'NEUTRAL' = newsScore > 10 ? 'LONG' : newsScore < -10 ? 'SHORT' : 'NEUTRAL';
  const recentBullish = symbolNews.filter(n => n.sentiment === 'BULLISH_MACRO' || n.sentiment === 'BULLISH_SPECIFIC').length;
  const recentBearish = symbolNews.filter(n => n.sentiment === 'BEARISH_MACRO' || n.sentiment === 'BEARISH_SPECIFIC').length;
  sources.push({
    name: '뉴스',
    score: Math.min(100, Math.abs(newsScore)),
    direction: newsDir,
    detail: `강세 ${recentBullish}건 / 약세 ${recentBearish}건 (2시간 내)`,
  });

  // ── 소스 2: 세력 매집 ──
  const accum = detectAccumulation(candles15m);
  sources.push({
    name: '세력매집',
    score: accum.score,
    direction: accum.score >= 50 ? 'LONG' : 'NEUTRAL',
    detail: accum.detail,
  });

  // ── 소스 3: 오더북 불균형 ──
  const obScore = Math.min(100, Math.abs(orderBook.imbalanceRatio) * 100);
  const obDir: 'LONG' | 'SHORT' | 'NEUTRAL' = orderBook.imbalanceRatio > 0.1 ? 'LONG' : orderBook.imbalanceRatio < -0.1 ? 'SHORT' : 'NEUTRAL';
  let obDetail = `불균형 ${(orderBook.imbalanceRatio * 100).toFixed(1)}%`;
  if (orderBook.hasBidWall) obDetail += ' | 매수벽 감지';
  if (orderBook.hasAskWall) obDetail += ' | 매도벽 감지';
  sources.push({ name: '오더북', score: obScore, direction: obDir, detail: obDetail });

  // ── 소스 4: 체결 강도 ──
  const takerScore = Math.abs(takerBuy.ratio - 50) * 2; // 0~100
  const takerDir: 'LONG' | 'SHORT' | 'NEUTRAL' = takerBuy.ratio >= 55 ? 'LONG' : takerBuy.ratio <= 45 ? 'SHORT' : 'NEUTRAL';
  sources.push({ name: '체결강도', score: takerScore, direction: takerDir, detail: takerBuy.detail });

  // ── 소스 5: BTC 추세 연동 ──
  const btcMomentum = ctx.btc.momentum;
  const btcScore = Math.min(100, Math.abs(btcMomentum));
  const btcDir: 'LONG' | 'SHORT' | 'NEUTRAL' = btcMomentum > 20 ? 'LONG' : btcMomentum < -20 ? 'SHORT' : 'NEUTRAL';
  sources.push({
    name: 'BTC추세',
    score: btcScore,
    direction: btcDir,
    detail: `BTC ${ctx.btc.change5m >= 0 ? '+' : ''}${ctx.btc.change5m.toFixed(2)}%/5m | 모멘텀 ${btcMomentum.toFixed(0)}`,
  });

  // ── 소스 6: ETH 추세 연동 ──
  const ethMomentum = ctx.eth.momentum;
  const ethScore = Math.min(100, Math.abs(ethMomentum));
  const ethDir: 'LONG' | 'SHORT' | 'NEUTRAL' = ethMomentum > 20 ? 'LONG' : ethMomentum < -20 ? 'SHORT' : 'NEUTRAL';
  sources.push({
    name: 'ETH추세',
    score: ethScore,
    direction: ethDir,
    detail: `ETH ${ctx.eth.change5m >= 0 ? '+' : ''}${ctx.eth.change5m.toFixed(2)}%/5m | 모멘텀 ${ethMomentum.toFixed(0)}`,
  });

  // ── 소스 7: 공포탐욕지수 ──
  const fgScore = Math.abs(ctx.fearGreedIndex - 50) * 2; // 0~100
  const fgDir: 'LONG' | 'SHORT' | 'NEUTRAL' = ctx.fearGreedIndex >= 60 ? 'LONG' : ctx.fearGreedIndex <= 40 ? 'SHORT' : 'NEUTRAL';
  sources.push({
    name: '공포탐욕',
    score: fgScore,
    direction: fgDir,
    detail: `${ctx.fearGreedLabel} (${ctx.fearGreedIndex})`,
  });

  // ── 종합 점수 계산 ──
  // 가중치: 뉴스(20) + 세력(20) + 오더북(15) + 체결강도(15) + BTC(15) + ETH(10) + F&G(5)
  const weights = [20, 20, 15, 15, 15, 10, 5];
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  let longScore = 0, shortScore = 0;
  sources.forEach((src, i) => {
    const w = weights[i] / totalWeight;
    if (src.direction === 'LONG') longScore += src.score * w;
    else if (src.direction === 'SHORT') shortScore += src.score * w;
  });

  const direction: 'LONG' | 'SHORT' = longScore >= shortScore ? 'LONG' : 'SHORT';
  const totalScore = Math.max(longScore, shortScore);
  const confidence = Math.min(95, Math.round(totalScore * 0.9 + 10));

  // ── 긴급도 판단 ──
  let urgency: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';
  const highUrgencySources = sources.filter(s => s.score >= 70 && s.direction === direction).length;
  if (highUrgencySources >= 4) urgency = 'HIGH';
  else if (highUrgencySources >= 2) urgency = 'MEDIUM';

  // ── 진입 근거 요약 ──
  const topSources = sources
    .filter(s => s.direction === direction && s.score >= 40)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(s => s.name);

  const entryReason = `${direction === 'LONG' ? '📈 롱' : '📉 숏'} | ${topSources.join(' + ')} 신호 | 신뢰도 ${confidence}%`;
  const marketImpact = ctx.surgeStrategy.reason;

  return {
    symbol: displaySymbol,
    bybitSymbol,
    totalScore,
    direction,
    confidence,
    sources,
    newsEvents: symbolNews.slice(0, 5),
    marketImpact,
    entryReason,
    urgency,
  };
}

/**
 * 시장 전체에 영향을 주는 긴급 뉴스 이벤트 감지
 * 임팩트 스코어 7 이상 + 최근 30분 이내 뉴스
 */
export async function detectUrgentNewsEvents(): Promise<NewsEvent[]> {
  const news = await fetchLatestNews();
  const now = Date.now();
  return news.filter(n =>
    n.impactScore >= 7 &&
    now - n.publishedAt < 30 * 60 * 1000 && // 30분 이내
    (n.sentiment === 'BULLISH_MACRO' || n.sentiment === 'BEARISH_MACRO')
  );
}

/**
 * 뉴스 이벤트 한국어 요약
 */
export function summarizeNewsEvent(event: NewsEvent): string {
  const ageMin = Math.round((Date.now() - event.publishedAt) / 60000);
  const emoji = event.sentiment === 'BULLISH_MACRO' || event.sentiment === 'BULLISH_SPECIFIC' ? '📈' : '📉';
  return `${emoji} [${event.source}] ${event.title.slice(0, 60)}... (${ageMin}분 전, 영향도 ${event.impactScore}/10)`;
}
