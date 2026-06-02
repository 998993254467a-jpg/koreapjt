/**
 * trading-service.ts
 * Bybit V5 (Linear Futures) API 클라이언트 — React Native (Hermes) 호환
 *
 * - Cross 마진 모드, 시장가(Market) 주문
 * - 레버리지: 심볼별 Bybit 최대치 자동 조회
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

const BYBIT_MAINNET = 'https://api.bybit.com';
const BYBIT_TESTNET = 'https://api-testnet.bybit.com';
const CREDS_KEY = 'bybit_creds_v1';

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
  avgPrice?: string;
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

function hmacSha256(message: string, key: string): string {
  const enc = (s: string) => {
    const bytes: number[] = [];
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) { bytes.push(0xc0|(c>>6)); bytes.push(0x80|(c&0x3f)); }
      else { bytes.push(0xe0|(c>>12)); bytes.push(0x80|((c>>6)&0x3f)); bytes.push(0x80|(c&0x3f)); }
    }
    return new Uint8Array(bytes);
  };
  const BLOCK = 64;
  let keyBytes = enc(key);
  if (keyBytes.length > BLOCK) keyBytes = sha256Pure(keyBytes);
  const kPad = new Uint8Array(BLOCK);
  kPad.set(keyBytes);
  const iKey = kPad.map(b => b ^ 0x36);
  const oKey = kPad.map(b => b ^ 0x5c);
  const msgBytes = enc(message);
  const inner = new Uint8Array(BLOCK + msgBytes.length);
  inner.set(iKey); inner.set(msgBytes, BLOCK);
  const innerHash = sha256Pure(inner);
  const outer = new Uint8Array(BLOCK + 32);
  outer.set(oKey); outer.set(innerHash, BLOCK);
  const result = sha256Pure(outer);
  return Array.from(result).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── 공통 서명 요청 (Bybit V5 방식) ─────────────────────────────────────────

export async function bybitRequest(
  creds: ApiCredentials,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  params: Record<string, unknown> = {},
  retries = 3,
): Promise<unknown> {
  const base = creds.isTestnet ? BYBIT_TESTNET : BYBIT_MAINNET;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const timestamp = Date.now().toString();
      const recvWindow = '10000';
      const apiKey = creds.apiKey;

      let signPayload: string;
      let url: string;
      let fetchOptions: RequestInit;

      if (method === 'GET' || method === 'DELETE') {
        const qs = new URLSearchParams(
          Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))
        ).toString();
        signPayload = timestamp + apiKey + recvWindow + qs;
        const signature = hmacSha256(signPayload, creds.secretKey);
        url = `${base}${path}${qs ? '?' + qs : ''}`;
        fetchOptions = {
          method,
          headers: {
            'X-BAPI-API-KEY': apiKey,
            'X-BAPI-SIGN': signature,
            'X-BAPI-SIGN-TYPE': '2',
            'X-BAPI-TIMESTAMP': timestamp,
            'X-BAPI-RECV-WINDOW': recvWindow,
          },
        };
      } else {
        const body = JSON.stringify(params);
        signPayload = timestamp + apiKey + recvWindow + body;
        const signature = hmacSha256(signPayload, creds.secretKey);
        url = `${base}${path}`;
        fetchOptions = {
          method: 'POST',
          headers: {
            'X-BAPI-API-KEY': apiKey,
            'X-BAPI-SIGN': signature,
            'X-BAPI-SIGN-TYPE': '2',
            'X-BAPI-TIMESTAMP': timestamp,
            'X-BAPI-RECV-WINDOW': recvWindow,
            'Content-Type': 'application/json',
          },
          body,
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

      // Bybit 오류 코드 처리
      if (typeof data === 'object' && data !== null && 'retCode' in data) {
        const d = data as { retCode: number; retMsg: string; result: unknown };
        if (d.retCode !== 0) {
          const guide: Record<number, string> = {
            10001: '\n파라미터 오류를 확인하세요.',
            10003: '\nAPI 키가 잘못되었습니다.',
            10004: '\n서명이 잘못되었습니다. Secret Key를 확인하세요.',
            10006: '\n요청 한도 초과. 잠시 후 재시도하세요.',
            110001: '\n심볼이 유효하지 않습니다.',
            110007: '\n잔고가 부족합니다.',
            110043: '\n레버리지가 이미 동일하게 설정되어 있습니다. (정상)',
            110026: '\n이미 Cross 마진 모드입니다. (정상)',
          };
          // 정상으로 처리할 코드
          if (d.retCode === 110043 || d.retCode === 110026) {
            return d.result;
          }
          throw new Error(`Bybit 오류 (${d.retCode}): ${d.retMsg}${guide[d.retCode] ?? ''}`);
        }
        return d.result;
      }

      return data;
    } catch (e) {
      if (attempt < retries - 1) {
        const msg = e instanceof Error ? e.message : String(e);
        const noRetryPatterns = ['10003', '10004', '110001'];
        if (noRetryPatterns.some(code => msg.includes(code))) throw e;
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
        continue;
      }
      throw e;
    }
  }
  throw new Error('요청 실패 (재시도 초과)');
}

// 하위 호환 alias
export const binanceRequest = bybitRequest;

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

// ─── 심볼 메타 캐시 (Bybit V5) ───────────────────────────────────────────────

export async function loadAllSymbolMeta(isTestnet = false): Promise<Map<string, SymbolMeta>> {
  const now_ms = Date.now();
  if (_symbolMetaCache && now_ms - _symbolMetaLoadedAt < SYMBOL_META_TTL) {
    return _symbolMetaCache;
  }

  const base = isTestnet ? BYBIT_TESTNET : BYBIT_MAINNET;
  const map = new Map<string, SymbolMeta>();

  try {
    const res = await fetchWithTimeout(
      `${base}/v5/market/instruments-info?category=linear&limit=1000`,
      15000,
    );
    const data = await res.json() as {
      retCode: number;
      result: {
        list: {
          symbol: string;
          status: string;
          lotSizeFilter: { qtyStep: string; minOrderQty: string; maxOrderQty: string };
          priceFilter: { tickSize: string };
          leverageFilter: { maxLeverage: string };
        }[];
        nextPageCursor?: string;
      };
    };

    const processPage = (list: typeof data.result.list) => {
      for (const sym of list) {
        if (!sym.symbol.endsWith('USDT')) continue;
        if (sym.status !== 'Trading') continue;

        const tickSize = parseFloat(sym.priceFilter?.tickSize ?? '0.01');
        const qtyStep = parseFloat(sym.lotSizeFilter?.qtyStep ?? '0.001');
        const minOrderQty = parseFloat(sym.lotSizeFilter?.minOrderQty ?? '0.001');
        const maxLeverage = parseFloat(sym.leverageFilter?.maxLeverage ?? '100');
        const pricePrecision = calcPrecision(tickSize);
        const qtyPrecision = calcPrecision(qtyStep);

        map.set(sym.symbol, {
          symbol: sym.symbol,
          tickSize,
          qtyStep,
          minOrderQty,
          minNotionalValue: 1,
          pricePrecision,
          qtyPrecision,
          maxLeverage,
        });
      }
    };

    processPage(data.result.list);

    // 페이지네이션 처리 (심볼 수가 많을 경우)
    let cursor = data.result.nextPageCursor;
    let pageCount = 0;
    while (cursor && pageCount < 5) {
      const nextRes = await fetchWithTimeout(
        `${base}/v5/market/instruments-info?category=linear&limit=1000&cursor=${encodeURIComponent(cursor)}`,
        15000,
      );
      const nextData = await nextRes.json() as typeof data;
      processPage(nextData.result.list);
      cursor = nextData.result.nextPageCursor;
      pageCount++;
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
  console.log(`[SymbolMeta] ${map.size}개 심볼 캐시 완료 (Bybit)`);
  return map;
}

export async function getBinanceListedSymbols(isTestnet = false): Promise<Set<string>> {
  const meta = await loadAllSymbolMeta(isTestnet);
  return new Set(meta.keys());
}

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
    minNotionalValue: 1,
    pricePrecision: 2,
    qtyPrecision: 3,
    maxLeverage: 100,
  };
}

// ─── tickSize 정규화 ──────────────────────────────────────────────────────────

function roundToTickSize(price: number, tickSize: number, precision: number): string {
  if (tickSize <= 0 || !Number.isFinite(price)) return price.toFixed(precision);
  const rounded = Math.round(price / tickSize) * tickSize;
  return rounded.toFixed(precision);
}

// ─── 잔고 조회 (Bybit V5) ────────────────────────────────────────────────────

export async function getBalance(creds: ApiCredentials): Promise<BalanceInfo> {
  type BybitWallet = {
    list: {
      accountType: string;
      totalWalletBalance: string;
      totalAvailableBalance: string;
      totalMaintenanceMargin: string;
      totalInitialMargin: string;
    }[];
  };

  const data = await bybitRequest(creds, 'GET', '/v5/account/wallet-balance', {
    accountType: 'UNIFIED',
  }) as BybitWallet;

  const account = data.list?.[0];
  if (!account) {
    // CONTRACT 계정 타입 시도
    const data2 = await bybitRequest(creds, 'GET', '/v5/account/wallet-balance', {
      accountType: 'CONTRACT',
    }) as BybitWallet;
    const account2 = data2.list?.[0];
    if (!account2) throw new Error('잔고 조회 실패');
    const totalBalance = safeFloat(account2.totalWalletBalance);
    const availableBalance = safeFloat(account2.totalAvailableBalance);
    const totalMM = safeFloat(account2.totalMaintenanceMargin);
    const totalIM = safeFloat(account2.totalInitialMargin);
    const mmrPct = totalIM > 0 ? (totalMM / totalIM) * 100 : 0;
    return { totalBalance, availableBalance, mmrPct: Math.min(mmrPct, 100), totalMaintenanceMargin: totalMM, totalInitialMargin: totalIM };
  }

  const totalBalance = safeFloat(account.totalWalletBalance);
  const availableBalance = safeFloat(account.totalAvailableBalance);
  const totalMM = safeFloat(account.totalMaintenanceMargin);
  const totalIM = safeFloat(account.totalInitialMargin);
  const mmrPct = totalIM > 0 ? (totalMM / totalIM) * 100 : 0;

  return {
    totalBalance,
    availableBalance,
    mmrPct: Math.min(mmrPct, 100),
    totalMaintenanceMargin: totalMM,
    totalInitialMargin: totalIM,
  };
}

// ─── 포지션 조회 (Bybit V5) ──────────────────────────────────────────────────

type BybitPosition = {
  symbol: string;
  side: string;
  size: string;
  avgPrice: string;
  unrealisedPnl: string;
  leverage: string;
  positionValue: string;
  markPrice: string;
  liqPrice: string;
};

function mapBybitPosition(p: BybitPosition): PositionInfo {
  return {
    symbol: p.symbol,
    side: p.side === 'Buy' ? 'Buy' : 'Sell',
    size: p.size,
    entryPrice: p.avgPrice,
    avgPrice: p.avgPrice,
    unrealisedPnl: p.unrealisedPnl,
    leverage: p.leverage,
    positionValue: p.positionValue,
    markPrice: p.markPrice,
    liqPrice: p.liqPrice,
  };
}

export async function getPositions(creds: ApiCredentials): Promise<PositionInfo[]> {
  type BybitPositionResult = { list: BybitPosition[] };
  const data = await bybitRequest(creds, 'GET', '/v5/position/list', {
    category: 'linear',
    settleCoin: 'USDT',
  }) as BybitPositionResult;

  return (data.list ?? [])
    .filter(p => safeFloat(p.size) !== 0)
    .map(mapBybitPosition);
}

export async function getPositionBySymbol(
  creds: ApiCredentials,
  symbol: string,
): Promise<PositionInfo | null> {
  type BybitPositionResult = { list: BybitPosition[] };
  const data = await bybitRequest(creds, 'GET', '/v5/position/list', {
    category: 'linear',
    symbol,
  }) as BybitPositionResult;

  const pos = (data.list ?? []).find(p => safeFloat(p.size) !== 0);
  return pos ? mapBybitPosition(pos) : null;
}

// ─── 포지션 모드 감지 (Bybit는 단방향/헤지 모드 지원) ────────────────────────

let _positionModeDetected = false;
let _isDualSidePosition = false;
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
      // Bybit: 포지션 모드 조회
      type ModeResult = { mode: number };
      const data = await bybitRequest(creds, 'GET', '/v5/position/switch-mode', {
        category: 'linear',
      }) as ModeResult;
      // mode: 0 = 단방향, 3 = 헤지
      _isDualSidePosition = data.mode === 3;
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

// ─── Cross 마진 + 레버리지 설정 (Bybit V5) ───────────────────────────────────

export async function setCrossMarginAndMaxLeverage(
  creds: ApiCredentials,
  symbol: string,
): Promise<number> {
  const meta = await getSymbolMeta(symbol, creds.isTestnet);
  const targetLev = Math.min(meta.maxLeverage, creds.leverageMax || 20);

  // Cross 마진 모드 설정
  try {
    await bybitRequest(creds, 'POST', '/v5/position/switch-isolated', {
      category: 'linear',
      symbol,
      tradeMode: 0, // 0 = Cross
      buyLeverage: String(targetLev),
      sellLeverage: String(targetLev),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('110026') && !msg.includes('정상') && !msg.includes('Cross')) {
      console.warn(`[Cross 전환 경고] ${symbol}: ${msg}`);
    }
  }

  // 레버리지 설정
  try {
    await bybitRequest(creds, 'POST', '/v5/position/set-leverage', {
      category: 'linear',
      symbol,
      buyLeverage: String(targetLev),
      sellLeverage: String(targetLev),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('110043') && !msg.includes('정상')) {
      console.warn(`[레버리지 설정 경고] ${symbol}: ${msg}`);
    }
  }

  return targetLev;
}

// ─── 전체 미체결 주문 취소 (Bybit V5) ────────────────────────────────────────

export async function cancelAllOpenOrders(creds: ApiCredentials): Promise<number> {
  try {
    await bybitRequest(creds, 'POST', '/v5/order/cancel-all', {
      category: 'linear',
      settleCoin: 'USDT',
    });
    return 1;
  } catch (e) {
    console.warn('[cancelAllOpenOrders] 실패:', e);
    return 0;
  }
}

// ─── 시장가 주문 실행 (Bybit V5) ─────────────────────────────────────────────

export async function placeOrder(
  creds: ApiCredentials,
  symbol: string,
  side: 'Buy' | 'Sell',
  qty: string,
  leverage: number,
  _stopLoss?: string,
  _takeProfit?: string,
): Promise<OrderResult> {
  if (!_positionModeDetected) {
    await detectPositionMode(creds);
  }

  await setCrossMarginAndMaxLeverage(creds, symbol);

  const orderParams: Record<string, unknown> = {
    category: 'linear',
    symbol,
    side,
    orderType: 'Market',
    qty,
    timeInForce: 'IOC',
  };

  if (_isDualSidePosition) {
    orderParams.positionIdx = side === 'Buy' ? 1 : 2;
  } else {
    orderParams.positionIdx = 0;
  }

  const result = await bybitRequest(creds, 'POST', '/v5/order/create', orderParams) as {
    orderId: string;
    symbol: string;
    side: string;
  };

  return {
    orderId: result.orderId,
    symbol: result.symbol ?? symbol,
    side: result.side ?? side,
  };
}

// ─── 미체결 주문 조회 (Bybit V5) ─────────────────────────────────────────────

export async function getOpenOrders(
  creds: ApiCredentials,
  symbol: string,
): Promise<{ orderId: string; orderStatus: string; price: string; side: string }[]> {
  type BybitOrder = { orderId: string; orderStatus: string; price: string; side: string };
  const data = await bybitRequest(creds, 'GET', '/v5/order/realtime', {
    category: 'linear',
    symbol,
  }) as { list: BybitOrder[] };

  return (data.list ?? []).map(o => ({
    orderId: o.orderId,
    orderStatus: o.orderStatus,
    price: o.price,
    side: o.side,
  }));
}

// ─── 주문 취소 (Bybit V5) ─────────────────────────────────────────────────────

export async function cancelOrder(
  creds: ApiCredentials,
  symbol: string,
  orderId: string,
): Promise<void> {
  await bybitRequest(creds, 'POST', '/v5/order/cancel', {
    category: 'linear',
    symbol,
    orderId,
  });
}

// ─── 추가매수 (Bybit V5) ──────────────────────────────────────────────────────

export async function addToPosition(
  creds: ApiCredentials,
  symbol: string,
  side: 'Buy' | 'Sell',
  qty: string,
  _newStopLoss?: string,
): Promise<void> {
  if (!_positionModeDetected) await detectPositionMode(creds);

  const orderParams: Record<string, unknown> = {
    category: 'linear',
    symbol,
    side,
    orderType: 'Market',
    qty,
    timeInForce: 'IOC',
    positionIdx: _isDualSidePosition ? (side === 'Buy' ? 1 : 2) : 0,
  };
  await bybitRequest(creds, 'POST', '/v5/order/create', orderParams);
}

// ─── 포지션 청산 (Bybit V5) ───────────────────────────────────────────────────

export async function closePosition(
  creds: ApiCredentials,
  symbol: string,
  side: 'Buy' | 'Sell',
  size: string,
): Promise<void> {
  const closeSide = side === 'Buy' ? 'Sell' : 'Buy';
  const orderParams: Record<string, unknown> = {
    category: 'linear',
    symbol,
    side: closeSide,
    orderType: 'Market',
    qty: size,
    timeInForce: 'IOC',
    reduceOnly: true,
    positionIdx: _isDualSidePosition ? (side === 'Buy' ? 1 : 2) : 0,
  };
  await bybitRequest(creds, 'POST', '/v5/order/create', orderParams);

  // 포지션 소멸 확인 (최대 15초)
  const maxWait = 15000;
  const interval = 500;
  const deadline = Date.now() + maxWait;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval));
    try {
      const pos = await getPositionBySymbol(creds, symbol);
      if (!pos || safeFloat(pos.size) === 0) return;
    } catch { /* 조회 실패 시 계속 대기 */ }
  }
  console.warn(`[closePosition] ${symbol} 청산 확인 타임아웃 (15s) — 계속 진행`);
}

// ─── 부분 청산 (Bybit V5) ─────────────────────────────────────────────────────

export async function closePartialPosition(
  creds: ApiCredentials,
  symbol: string,
  side: 'Buy' | 'Sell',
  partialQty: string,
): Promise<void> {
  const closeSide = side === 'Buy' ? 'Sell' : 'Buy';
  await bybitRequest(creds, 'POST', '/v5/order/create', {
    category: 'linear',
    symbol,
    side: closeSide,
    orderType: 'Market',
    qty: partialQty,
    timeInForce: 'IOC',
    reduceOnly: true,
    positionIdx: _isDualSidePosition ? (side === 'Buy' ? 1 : 2) : 0,
  });
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
  availableBalance: number,
  positionSizePct: number,
  price: number,
  leverage: number,
  minQty: number,
  qtyStep: number,
  qtyPrecision: number,
): string | null {
  const maxBudget = (availableBalance * Math.min(positionSizePct, 3)) / 100;
  const oneUnitCost = price * minQty;
  if (oneUnitCost > maxBudget * leverage) return null;

  const usdt = maxBudget;
  const raw = (usdt * leverage) / Math.max(price, 0.000001);
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

// Bybit 호환 alias (하위 호환)
export const bybitRequestAlias = bybitRequest;
