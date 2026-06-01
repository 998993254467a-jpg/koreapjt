/**
 * trading-service.ts
 * Binance FAPI (Futures) API 클라이언트 — React Native (Hermes) 호환
 *
 * - Cross 마진 모드, 시장가(Market) 주문
 * - 레버리지: 심볼별 Binance 최대치 자동 조회
 * - 주문 금액: 가용잔고(availableBalance) 3% 미만
 * - 전체 미체결 주문 취소 API
 * - 접속 오류 시 3회 재시도 (exponential backoff)
 * - HMAC-SHA256: 순수 JS (global.crypto 불필요, Android Hermes 완전 호환)
 */

// AsyncStorage: 서버(Node.js) 환경에서는 사용 불가 → 런타임에 안전하게 처리
let AsyncStorage: { getItem: (k: string) => Promise<string | null>; setItem: (k: string, v: string) => Promise<void>; removeItem: (k: string) => Promise<void> };
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  AsyncStorage = require('@react-native-async-storage/async-storage').default;
} catch {
  // 서버 환경: AsyncStorage 미지원 → 메모리 폴백
  const _mem: Record<string, string> = {};
  AsyncStorage = {
    getItem: async (k: string) => _mem[k] ?? null,
    setItem: async (k: string, v: string) => { _mem[k] = v; },
    removeItem: async (k: string) => { delete _mem[k]; },
  };
}

const BINANCE_MAINNET = 'https://fapi.binance.com';
const BINANCE_TESTNET = 'https://testnet.binancefuture.com';
const CREDS_KEY = 'binance_creds_v1';

// ─── 타입 ────────────────────────────────────────────────────────────────────

export interface ApiCredentials {
  apiKey: string;
  secretKey: string;
  isTestnet: boolean;
  positionSizePct: number; // 가용잔고 대비 % (기본 3)
  leverageMin: number;
  leverageMax: number;
}

export interface BalanceInfo {
  totalBalance: number;
  availableBalance: number;
  mmrPct: number;           // Maintenance Margin Rate (%) - 0~100
  totalMaintenanceMargin: number;
  totalInitialMargin: number;
}

export interface PositionInfo {
  symbol: string;
  side: 'Buy' | 'Sell';
  size: string;
  entryPrice: string;
  avgPrice?: string;          // 평균단가
  unrealisedPnl: string;
  leverage: string;
  positionValue: string;
  markPrice: string;
  liqPrice: string;
}

export interface OrderResult {
  orderId: string;
  symbol: string;
  side: string;
}

// ─── 심볼 메타데이터 ──────────────────────────────────────────────────────────

export interface SymbolMeta {
  symbol: string;
  tickSize: number;
  qtyStep: number;
  minOrderQty: number;
  minNotionalValue: number;
  pricePrecision: number;
  qtyPrecision: number;
  maxLeverage: number;
}

let _symbolMetaCache: Map<string, SymbolMeta> | null = null;
let _symbolMetaLoadedAt = 0;
const SYMBOL_META_TTL = 30 * 60 * 1000;

function calcPrecision(step: number): number {
  if (step >= 1) return 0;
  return Math.round(-Math.log10(step));
}

// ─── NaN 방어 ────────────────────────────────────────────────────────────────

export function safeFloat(val: string | number | undefined | null, fallback = 0): number {
  if (val === undefined || val === null || val === '') return fallback;
  const n = typeof val === 'number' ? val : parseFloat(String(val));
  return Number.isFinite(n) ? n : fallback;
}

// ─── RN 호환 타임아웃 fetch ──────────────────────────────────────────────────

async function fetchWithTimeout(url: string, ms: number, options?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// ─── HMAC-SHA256 (순수 JS — Hermes/Android 완전 호환) ────────────────────────

function sha256Pure(data: Uint8Array): Uint8Array {
  const K = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ];
  const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const len = data.length;
  const bitLen = len * 8;
  const padLen = ((len + 9 + 63) & ~63);
  const padded = new Uint8Array(padLen);
  padded.set(data);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padLen - 4, bitLen >>> 0, false);
  dv.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let i = 0; i < padLen; i += 64) {
    const W: number[] = [];
    for (let j = 0; j < 16; j++) W[j] = dv.getUint32(i + j * 4, false);
    for (let j = 16; j < 64; j++) {
      const s0 = rotr(W[j-15],7)^rotr(W[j-15],18)^(W[j-15]>>>3);
      const s1 = rotr(W[j-2],17)^rotr(W[j-2],19)^(W[j-2]>>>10);
      W[j] = (W[j-16]+s0+W[j-7]+s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,h] = H;
    for (let j = 0; j < 64; j++) {
      const S1 = rotr(e,6)^rotr(e,11)^rotr(e,25);
      const ch = (e&f)^(~e&g);
      const temp1 = (h+S1+ch+K[j]+W[j]) >>> 0;
      const S0 = rotr(a,2)^rotr(a,13)^rotr(a,22);
      const maj = (a&b)^(a&c)^(b&c);
      const temp2 = (S0+maj) >>> 0;
      h=g; g=f; f=e; e=(d+temp1)>>>0; d=c; c=b; b=a; a=(temp1+temp2)>>>0;
    }
    H[0]=(H[0]+a)>>>0; H[1]=(H[1]+b)>>>0; H[2]=(H[2]+c)>>>0; H[3]=(H[3]+d)>>>0;
    H[4]=(H[4]+e)>>>0; H[5]=(H[5]+f)>>>0; H[6]=(H[6]+g)>>>0; H[7]=(H[7]+h)>>>0;
  }
  const out = new Uint8Array(32);
  const outDv = new DataView(out.buffer);
  H.forEach((v, i) => outDv.setUint32(i * 4, v, false));
  return out;
}

function hmacSha256(message: string, secret: string): string {
  const enc = new TextEncoder();
  let key = enc.encode(secret);
  if (key.length > 64) key = new Uint8Array(sha256Pure(key).buffer as ArrayBuffer);
  const ipad = new Uint8Array(64);
  const opad = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    ipad[i] = (key[i] ?? 0) ^ 0x36;
    opad[i] = (key[i] ?? 0) ^ 0x5c;
  }
  const msg = enc.encode(message);
  const inner = new Uint8Array(64 + msg.length);
  inner.set(ipad); inner.set(msg, 64);
  const innerHash = sha256Pure(inner);
  const outer = new Uint8Array(64 + 32);
  outer.set(opad); outer.set(innerHash, 64);
  const result = sha256Pure(outer);
  return Array.from(result).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── 서버 시간 동기화 ─────────────────────────────────────────────────────────

let _timeDiff = 0;

export async function syncServerTime(isTestnet: boolean): Promise<void> {
  try {
    const base = isTestnet ? BINANCE_TESTNET : BINANCE_MAINNET;
    const res = await fetchWithTimeout(`${base}/fapi/v1/time`, 8000);
    const rawText = await res.text();
    let data: { serverTime: number };
    try {
      data = JSON.parse(rawText) as { serverTime: number };
    } catch {
      return;
    }
    if (data.serverTime) {
      _timeDiff = data.serverTime - Date.now();
    }
  } catch { _timeDiff = 0; }
}

function now(): string {
  return (Date.now() + _timeDiff).toString();
}

// ─── 공통 서명 요청 (접속 오류 3회 재시도) ───────────────────────────────────

export async function binanceRequest(
  creds: ApiCredentials,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  params: Record<string, unknown> = {},
  retries = 3,
): Promise<unknown> {
  const base = creds.isTestnet ? BINANCE_TESTNET : BINANCE_MAINNET;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const ts = now();
      const recvWindow = '10000';

      const allParams: Record<string, string> = {
        ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
        timestamp: ts,
        recvWindow,
      };

      const qs = new URLSearchParams(allParams).toString();
      const signature = hmacSha256(qs, creds.secretKey);
      const signedQs = `${qs}&signature=${signature}`;

      let url: string;
      let fetchOptions: RequestInit;

      if (method === 'GET' || method === 'DELETE') {
        url = `${base}${path}?${signedQs}`;
        fetchOptions = {
          method,
          headers: { 'X-MBX-APIKEY': creds.apiKey },
        };
      } else {
        url = `${base}${path}`;
        fetchOptions = {
          method: 'POST',
          headers: {
            'X-MBX-APIKEY': creds.apiKey,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: signedQs,
        };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      let res: Response;
      try {
        res = await fetch(url, { ...fetchOptions, signal: controller.signal });
        clearTimeout(timer);
      } catch (fetchErr) {
        clearTimeout(timer);
        if (attempt < retries - 1) {
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
          continue;
        }
        throw new Error(`네트워크 접속 오류: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`);
      }

      const rawText = await res.text();

      let data: unknown;
      try {
        data = JSON.parse(rawText);
      } catch {
        throw new Error(`응답 파싱 오류 (${res.status}): ${rawText.slice(0, 100)}`);
      }

      // Binance 오류 코드 처리
      if (typeof data === 'object' && data !== null && 'code' in data) {
        const errData = data as { code: number; msg: string };
        if (errData.code < 0) {
          const guide: Record<number, string> = {
            // 인증/권한 오류
            '-1100': '\nAPI 파라미터 오류를 확인하세요.',
            '-1121': '\n심볼이 유효하지 않습니다.',
            '-2014': '\nAPI 키가 잘못되었습니다.',
            '-2015': '\nAPI 키 또는 Secret Key를 확인하세요.',
            '-1003': '\n요청 한도 초과. 잠시 후 재시도하세요.',
            // 잔고/주문 오류
            '-2019': '\n잔고가 부족합니다.',
            '-4046': '\n이미 Cross 마진 모드입니다. (정상)',
            '-4028': '\n레버리지가 이미 동일하게 설정되어 있습니다. (정상)',
          };
          const codeStr = String(errData.code);
          throw new Error(`Binance 오류 (${errData.code}): ${errData.msg}${guide[errData.code] ?? guide[codeStr as unknown as number] ?? ''}`);
        }
      }

      return data;
    } catch (e) {
      if (attempt < retries - 1) {
        const msg = e instanceof Error ? e.message : String(e);
        // 재시도 불필요한 오류는 즉시 throw
        const noRetryPatterns = ['-1121', '-2014', '-2015', '-4046', '-4028'];
        if (noRetryPatterns.some(code => msg.includes(code))) {
          throw e;
        }
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
        continue;
      }
      throw e;
    }
  }
  throw new Error('요청 실패 (재시도 초과)');
}

// Bybit 호환 alias (server-bot-engine 호환)
export const bybitRequest = binanceRequest;

// ─── 자격증명 관리 ────────────────────────────────────────────────────────────

export async function saveCredentials(creds: ApiCredentials): Promise<void> {
  await AsyncStorage.setItem(CREDS_KEY, JSON.stringify(creds));
}

export async function loadCredentials(): Promise<ApiCredentials | null> {
  const raw = await AsyncStorage.getItem(CREDS_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as ApiCredentials; } catch { return null; }
}

export async function deleteCredentials(): Promise<void> {
  await AsyncStorage.removeItem(CREDS_KEY);
}

// ─── 심볼 메타 캐시 ──────────────────────────────────────────────────────────

export async function loadAllSymbolMeta(isTestnet = false): Promise<Map<string, SymbolMeta>> {
  const now_ms = Date.now();
  if (_symbolMetaCache && now_ms - _symbolMetaLoadedAt < SYMBOL_META_TTL) {
    return _symbolMetaCache;
  }

  const base = isTestnet ? BINANCE_TESTNET : BINANCE_MAINNET;
  const map = new Map<string, SymbolMeta>();

  try {
    const res = await fetchWithTimeout(`${base}/fapi/v1/exchangeInfo`, 15000);
    const data = await res.json() as {
      symbols: {
        symbol: string;
        status: string;
        pricePrecision: number;
        quantityPrecision: number;
        filters: { filterType: string; tickSize?: string; stepSize?: string; minQty?: string; notional?: string; minNotional?: string }[];
      }[];
    };

    for (const sym of data.symbols) {
      if (!sym.symbol.endsWith('USDT')) continue;
      if (sym.status !== 'TRADING') continue;

      const priceFilter = sym.filters.find(f => f.filterType === 'PRICE_FILTER');
      const lotFilter = sym.filters.find(f => f.filterType === 'LOT_SIZE');
      const minNotionalFilter = sym.filters.find(f => f.filterType === 'MIN_NOTIONAL' || f.filterType === 'NOTIONAL');

      const tickSize = parseFloat(priceFilter?.tickSize ?? '0.01');
      const qtyStep = parseFloat(lotFilter?.stepSize ?? '0.001');
      const minOrderQty = parseFloat(lotFilter?.minQty ?? '0.001');
      const minNotionalValue = parseFloat(minNotionalFilter?.notional ?? minNotionalFilter?.minNotional ?? '5');

      map.set(sym.symbol, {
        symbol: sym.symbol,
        tickSize,
        qtyStep,
        minOrderQty,
        minNotionalValue,
        pricePrecision: sym.pricePrecision,
        qtyPrecision: sym.quantityPrecision,
        maxLeverage: 125, // 기본값
      });
    }
  } catch (e) {
    console.warn('[loadAllSymbolMeta] 조회 실패:', e);
    if (_symbolMetaCache && _symbolMetaCache.size > 0) {
      return _symbolMetaCache;
    }
  }

  if (map.size === 0 && _symbolMetaCache && _symbolMetaCache.size > 0) {
    return _symbolMetaCache;
  }

  _symbolMetaCache = map;
  _symbolMetaLoadedAt = Date.now();
  console.log(`[SymbolMeta] ${map.size}개 심볼 캐시 완료`);
  return map;
}

export async function getBinanceListedSymbols(isTestnet = false): Promise<Set<string>> {
  const meta = await loadAllSymbolMeta(isTestnet);
  return new Set(meta.keys());
}

// Bybit 호환 alias
export async function getBybitListedSymbols(isTestnet = false): Promise<Set<string>> {
  return getBinanceListedSymbols(isTestnet);
}

export async function isSymbolValid(symbol: string, isTestnet = false): Promise<boolean> {
  const cache = await loadAllSymbolMeta(isTestnet);
  return cache.has(symbol);
}

export async function getSymbolMeta(symbol: string, isTestnet = false): Promise<SymbolMeta> {
  const cache = await loadAllSymbolMeta(isTestnet);
  if (cache.has(symbol)) return cache.get(symbol)!;

  return {
    symbol,
    tickSize: 0.01,
    qtyStep: 0.001,
    minOrderQty: 0.001,
    minNotionalValue: 5,
    pricePrecision: 2,
    qtyPrecision: 3,
    maxLeverage: 125,
  };
}

// ─── tickSize 정규화 ──────────────────────────────────────────────────────────

function roundToTickSize(price: number, tickSize: number, precision: number): string {
  if (tickSize <= 0 || !Number.isFinite(price)) return price.toFixed(precision);
  const rounded = Math.round(price / tickSize) * tickSize;
  return rounded.toFixed(precision);
}

// ─── 잔고 조회 ────────────────────────────────────────────────────────────────

export async function getBalance(creds: ApiCredentials): Promise<BalanceInfo> {
  await syncServerTime(creds.isTestnet);

  type AccountInfo = {
    totalWalletBalance: string;
    availableBalance: string;
    totalMaintMargin: string;
    totalInitialMargin: string;
    totalUnrealizedProfit: string;
  };

  const data = await binanceRequest(creds, 'GET', '/fapi/v2/account') as AccountInfo;

  const totalBalance = safeFloat(data.totalWalletBalance);
  const availableBalance = safeFloat(data.availableBalance);
  const totalMM = safeFloat(data.totalMaintMargin);
  const totalIM = safeFloat(data.totalInitialMargin);
  const mmrPct = totalIM > 0 ? (totalMM / totalIM) * 100 : 0;

  return {
    totalBalance,
    availableBalance,
    mmrPct: Math.min(mmrPct, 100),
    totalMaintenanceMargin: totalMM,
    totalInitialMargin: totalIM,
  };
}

// ─── 포지션 조회 ──────────────────────────────────────────────────────────────

type BinancePosition = {
  symbol: string;
  positionSide: string;
  positionAmt: string;
  entryPrice: string;
  unrealizedProfit: string;
  leverage: string;
  notional: string;
  markPrice: string;
  liquidationPrice: string;
};

function mapPosition(p: BinancePosition): PositionInfo {
  const amt = parseFloat(p.positionAmt);
  return {
    symbol: p.symbol,
    side: amt >= 0 ? 'Buy' : 'Sell',
    size: Math.abs(amt).toString(),
    entryPrice: p.entryPrice,
    avgPrice: p.entryPrice,
    unrealisedPnl: p.unrealizedProfit,
    leverage: p.leverage,
    positionValue: p.notional,
    markPrice: p.markPrice,
    liqPrice: p.liquidationPrice,
  };
}

export async function getPositions(creds: ApiCredentials): Promise<PositionInfo[]> {
  const data = await binanceRequest(creds, 'GET', '/fapi/v2/positionRisk') as BinancePosition[];
  return (data ?? [])
    .filter(p => parseFloat(p.positionAmt) !== 0)
    .map(mapPosition);
}

export async function getPositionBySymbol(
  creds: ApiCredentials,
  symbol: string,
): Promise<PositionInfo | null> {
  const data = await binanceRequest(creds, 'GET', '/fapi/v2/positionRisk', { symbol }) as BinancePosition[];
  const pos = (data ?? []).find(p => parseFloat(p.positionAmt) !== 0);
  return pos ? mapPosition(pos) : null;
}

// ─── 포지션 모드 감지 ─────────────────────────────────────────────────────────

let _positionModeDetected = false;
let _isDualSidePosition = false; // false = 단방향, true = 헤지
let _detectingPromise: Promise<void> | null = null;
let _positionModeLastDetected = 0;
const POSITION_MODE_TTL = 5 * 60 * 1000;

export function isPositionModeDetected(): boolean { return _positionModeDetected; }

export function resetPositionModeDetection(): void {
  _positionModeDetected = false;
  _detectingPromise = null;
  _positionModeLastDetected = 0;
}

export function getPositionIdx(side: 'Buy' | 'Sell'): 0 | 1 | 2 {
  if (_isDualSidePosition) return side === 'Buy' ? 1 : 2;
  return 0;
}

export async function detectPositionMode(creds: ApiCredentials): Promise<void> {
  const now_ms = Date.now();
  if (_positionModeDetected && (now_ms - _positionModeLastDetected) < POSITION_MODE_TTL) return;
  if (_detectingPromise) return _detectingPromise;
  _positionModeDetected = false;

  _detectingPromise = (async () => {
    try {
      const data = await binanceRequest(creds, 'GET', '/fapi/v1/positionSide/dual') as { dualSidePosition: boolean };
      _isDualSidePosition = data.dualSidePosition;
      _positionModeDetected = true;
      _positionModeLastDetected = Date.now();
    } catch {
      _isDualSidePosition = false;
      _positionModeDetected = true;
      _positionModeLastDetected = Date.now();
    } finally {
      _detectingPromise = null;
    }
  })();

  return _detectingPromise;
}

// ─── Cross 마진 + 레버리지 설정 ──────────────────────────────────────────────

export async function setCrossMarginAndMaxLeverage(
  creds: ApiCredentials,
  symbol: string,
): Promise<number> {
  const meta = await getSymbolMeta(symbol, creds.isTestnet);

  // Cross 마진 모드 설정
  try {
    await binanceRequest(creds, 'POST', '/fapi/v1/marginType', {
      symbol,
      marginType: 'CROSSED',
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // -4046: No need to change margin type (이미 Cross)
    if (!msg.includes('-4046') && !msg.includes('No need') && !msg.includes('정상')) {
      console.warn(`[Cross 전환 경고] ${symbol}: ${msg}`);
    }
  }

  // 레버리지 설정
  const targetLev = Math.min(meta.maxLeverage, creds.leverageMax || 20);
  try {
    await binanceRequest(creds, 'POST', '/fapi/v1/leverage', {
      symbol,
      leverage: String(targetLev),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('-4028') && !msg.includes('정상')) {
      console.warn(`[레버리지 설정 경고] ${symbol}: ${msg}`);
    }
  }

  return targetLev;
}

// ─── 전체 미체결 주문 취소 ────────────────────────────────────────────────────

export async function cancelAllOpenOrders(creds: ApiCredentials): Promise<number> {
  try {
    // Binance: 심볼별로만 전체 취소 가능 → 포지션 있는 심볼 대상
    const positions = await getPositions(creds);
    let count = 0;
    for (const pos of positions) {
      try {
        await binanceRequest(creds, 'DELETE', '/fapi/v1/allOpenOrders', { symbol: pos.symbol });
        count++;
      } catch { /* 개별 실패 무시 */ }
    }
    return count;
  } catch (e) {
    console.warn('[cancelAllOpenOrders] 실패:', e);
    return 0;
  }
}

// ─── 시장가 주문 실행 ─────────────────────────────────────────────────────────

export async function placeOrder(
  creds: ApiCredentials,
  symbol: string,
  side: 'Buy' | 'Sell',
  qty: string,
  leverage: number,
  _stopLoss?: string,   // 사용안함 - 앱 내부에서 손절 관리
  _takeProfit?: string, // 사용안함 - 앱 내부에서 익절 관리
): Promise<OrderResult> {
  if (!_positionModeDetected) {
    await detectPositionMode(creds);
  }

  await setCrossMarginAndMaxLeverage(creds, symbol);

  const binanceSide = side === 'Buy' ? 'BUY' : 'SELL';
  const orderParams: Record<string, unknown> = {
    symbol,
    side: binanceSide,
    type: 'MARKET',
    quantity: qty,
  };

  if (_isDualSidePosition) {
    orderParams.positionSide = side === 'Buy' ? 'LONG' : 'SHORT';
  }

  const result = await binanceRequest(creds, 'POST', '/fapi/v1/order', orderParams) as { orderId: number; symbol: string; side: string };
  return {
    orderId: String(result.orderId),
    symbol: result.symbol,
    side: result.side,
  };
}

// ─── 미체결 주문 조회 ─────────────────────────────────────────────────────────

export async function getOpenOrders(
  creds: ApiCredentials,
  symbol: string,
): Promise<{ orderId: string; orderStatus: string; price: string; side: string }[]> {
  const data = await binanceRequest(creds, 'GET', '/fapi/v1/openOrders', { symbol }) as {
    orderId: number; status: string; price: string; side: string;
  }[];
  return (data ?? []).map(o => ({
    orderId: String(o.orderId),
    orderStatus: o.status,
    price: o.price,
    side: o.side,
  }));
}

// ─── 주문 취소 ────────────────────────────────────────────────────────────────

export async function cancelOrder(
  creds: ApiCredentials,
  symbol: string,
  orderId: string,
): Promise<void> {
  await binanceRequest(creds, 'DELETE', '/fapi/v1/order', { symbol, orderId });
}

// ─── 추가매수 ─────────────────────────────────────────────────────────────────

export async function addToPosition(
  creds: ApiCredentials,
  symbol: string,
  side: 'Buy' | 'Sell',
  qty: string,
  _newStopLoss?: string, // 사용안함 - 앱 내부에서 손절 관리
): Promise<void> {
  if (!_positionModeDetected) await detectPositionMode(creds);

  const binanceSide = side === 'Buy' ? 'BUY' : 'SELL';
  const orderParams: Record<string, unknown> = {
    symbol,
    side: binanceSide,
    type: 'MARKET',
    quantity: qty,
  };
  if (_isDualSidePosition) {
    orderParams.positionSide = side === 'Buy' ? 'LONG' : 'SHORT';
  }
  await binanceRequest(creds, 'POST', '/fapi/v1/order', orderParams);
}

// ─── 포지션 청산 (체결 확인 포함) ────────────────────────────────────────────

export async function closePosition(
  creds: ApiCredentials,
  symbol: string,
  side: 'Buy' | 'Sell',
  size: string,
): Promise<void> {
  const closeSide = side === 'Buy' ? 'SELL' : 'BUY';
  const orderParams: Record<string, unknown> = {
    symbol,
    side: closeSide,
    type: 'MARKET',
    quantity: size,
    reduceOnly: 'true',
  };
  if (_isDualSidePosition) {
    delete orderParams.reduceOnly;
    orderParams.positionSide = side === 'Buy' ? 'LONG' : 'SHORT';
  }
  await binanceRequest(creds, 'POST', '/fapi/v1/order', orderParams);

  // 포지션 소멸 확인 (최대 15초, 500ms 간격 폴링)
  const maxWait = 15000;
  const interval = 500;
  const deadline = Date.now() + maxWait;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval));
    try {
      const pos = await getPositionBySymbol(creds, symbol);
      if (!pos || safeFloat(pos.size) === 0) return;
    } catch {
      // 조회 실패 시 계속 대기
    }
  }
  console.warn(`[closePosition] ${symbol} 청산 확인 타임아웃 (15s) — 계속 진행`);
}

// ─── 부분 청산 ────────────────────────────────────────────────────────────────

export async function closePartialPosition(
  creds: ApiCredentials,
  symbol: string,
  side: 'Buy' | 'Sell',
  partialQty: string,
): Promise<void> {
  const closeSide = side === 'Buy' ? 'SELL' : 'BUY';
  const orderParams: Record<string, unknown> = {
    symbol,
    side: closeSide,
    type: 'MARKET',
    quantity: partialQty,
    reduceOnly: 'true',
  };
  if (_isDualSidePosition) {
    delete orderParams.reduceOnly;
    orderParams.positionSide = side === 'Buy' ? 'LONG' : 'SHORT';
  }
  await binanceRequest(creds, 'POST', '/fapi/v1/order', orderParams);
  await new Promise(r => setTimeout(r, 500));
}

// ─── 익절가 업데이트 (앱 내부 관리) ─────────────────────────────────────────

export async function updateTakeProfit(
  _creds: ApiCredentials,
  _symbol: string,
  _side: 'Buy' | 'Sell',
  _takeProfit: string,
): Promise<void> {
  // 내부에서 직접 closePosition으로 관리
}

// ─── 수량 계산 (가용잔고 3% 미만) ────────────────────────────────────────────

export function calcQty(
  availableBalance: number,  // 가용잔고
  positionSizePct: number,   // 가용잔고 대비 % (기본 3)
  price: number,
  leverage: number,
  minQty: number,
  qtyStep: number,
  qtyPrecision: number,
): string | null {
  // 1개 단위 거래 규칙
  const maxBudget = (availableBalance * Math.min(positionSizePct, 3)) / 100;
  const oneUnitCost = price * minQty;
  if (oneUnitCost > maxBudget * leverage) {
    return null;
  }

  const usdt = maxBudget;
  const raw = (usdt * leverage) / Math.max(price, 0.000001);

  // 수량을 1개 단위(정수 * qtyStep)로 강제
  const steps = Math.floor(raw / qtyStep);
  if (steps < 1) return null;

  const qty = Math.max(minQty, steps * qtyStep);
  return qty.toFixed(qtyPrecision);
}

// ─── 손절가 계산 ──────────────────────────────────────────────────────────────

export function calcSafeStopLoss(
  entryPrice: number,
  side: 'Buy' | 'Sell',
  leverage: number,
  lossRatio: number,
): number {
  const slDist = (entryPrice / leverage) * lossRatio * 0.9;
  return side === 'Buy' ? entryPrice - slDist : entryPrice + slDist;
}

// ─── 하위 호환 ────────────────────────────────────────────────────────────────

export async function getSymbolLotFilter(
  creds: ApiCredentials,
  symbol: string,
): Promise<{ minOrderQty: number; qtyStep: number; minNotionalValue: number }> {
  const meta = await getSymbolMeta(symbol, creds.isTestnet);
  return {
    minOrderQty: meta.minOrderQty,
    qtyStep: meta.qtyStep,
    minNotionalValue: meta.minNotionalValue,
  };
}
