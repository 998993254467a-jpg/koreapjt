/**
 * bot-engine.ts
 * 자동매매 봇 엔진 (전면 개편 v5)
 *
 * 규칙:
 *  - 시장가(Market) 주문, Cross 마진, 레버리지 최대치 자동 적용
 *  - 봇 시작 시 전체 미체결 주문 취소
 *  - 주문 대기 중(pending) 신규 진입 금지
 *  - 보유 종목(포지션 있는 심볼) 매매 금지 (봇 + Bybit 직접 보유 모두)
 *  - 신뢰도 85% 이상만 진입 (scalping-engine에서 필터링)
 *  - 신뢰도 95% 이상은 슬롯 초과여도 무조건 진입
 *  - 주문 금액: 가용잔고(availableBalance) 3% 미만
 *  - 진입 전 Bybit 심볼 유효성 사전 검증 (10001 오류 근본 차단)
 *
 * 손절 로직 (v5):
 *  - 손실 50% 도달 시 추세 분석
 *    → 방향성 다름: 즉시 손절
 *    → 방향성 같음: 보유량의 30% 추가매수 (addCount 증가)
 *  - 손실 100% 도달 시: 방향성 무관 강제 손절
 *
 * 익절 로직 (v5):
 *  - 이익 50% 이상부터 10% 단위마다 분석 (50%, 60%, 70%, 80%, ...)
 *    → 방향성 다름: 즉시 청산
 *    → 방향성 같음: 계속 보유
 *  - 매매기록 날짜별 AsyncStorage 저장
 *  - 접속 오류 시 3회 재시도 (trading-service에서 처리)
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getTopScalpingSignals, getSurgeDropTop7, getPreSurgeTop10, analyzeSymbolLive, type ScalpingSignal } from './scalping-engine';
import { getMarketContext, getCachedMarketContext, type MarketContext, type SurgeStrategy } from './market-context';
import {
  buildStrategyContext,
  calcMomentumScore,
  extractMomentumInput,
  calcRiskReward,
  detectTrendStrength,
  type StrategyContext,
} from './market-strategy';
import { detectUrgentNewsEvents, type NewsEvent } from './surge-analyzer';
import {
  detectPositionMode,
  isPositionModeDetected,
  resetPositionModeDetection,
  loadCredentials,
  getBalance,
  getPositions,
  placeOrder,
  closePosition,
  closePartialPosition,
  addToPosition,
  cancelAllOpenOrders,
  calcQty,
  getSymbolMeta,
  isSymbolValid,
  safeFloat,
  getPositionBySymbol,
  type ApiCredentials,
  type PositionInfo,
} from './trading-service';

// ─── 타입 ────────────────────────────────────────────────────────────────────

export type SectionType = 'top7' | 'surge' | 'presurge';

export interface BotPosition {
  symbol: string;        // Gate.io 형식 (BTC_USDT) - 내부 식별용
  bybitSymbol: string;   // Bybit 형식 (BTCUSDT) - API 호출용
  displaySymbol: string;
  side: 'Buy' | 'Sell';
  entryPrice: number;    // 진입 시 시장가 (참고용)
  avgPrice: number;      // 평균단가 (Bybit에서 조회)
  size: string;
  leverage: number;
  stopLoss: number;
  takeProfit: number;
  addCount: number;
  openedAt: number;
  markPrice: number;
  liqPrice: number;
  unrealisedPnl: number;
  pnlPct: number;
  filled: boolean;       // 시장가는 즉시 체결
  lastAnalyzedPnlPct?: number; // 마지막 분석 시점의 pnlPct (10% 단위 중복 방지)
  isReverse?: boolean;    // 역방향 진입 여부
  isExternal?: boolean;   // Bybit 외부 직접매매 여부
  forceEntry?: boolean;   // 95%+ 강제진입 여부
  confidence?: number;    // 진입 시 신뢰도
  kellyFraction?: number; // 켈리 공식 포지션 비율
  nextActionPct?: number; // 다음 손절/익절 분석 기준 (%)
  reverseCount?: number;  // 역방향 재진입 횟수 (최대 2회 제한)
  tpHitCount?: number;     // 목표가 도달 횟수 (rolling TP 추적)
  // ── 단계적 부분 청산 (Partial TP) 필드 ──
  partialTpCount?: number;     // 부분 청산 완료 단계 수 (0 = 미실행)
  initialMarginUsdt?: number;  // 진입 시 보증금 (USDT) — 수익금=보증금 조건 계산용
  initialSize?: number;        // 진입 시 총 수량 (부분 청산 비율 계산 기준)
  lastPartialTpPnlPct?: number; // 마지막 부분 청산 시점의 pnlPct (중복 방지)
  // ── 손익분기점 자동 이동 + 트레일링 스탭 필드 ──
  breakEvenActivated?: boolean;   // 1차 TP 도달 후 손익분기점 이동 여부
  trailingActivated?: boolean;    // 트레일링 스탭 활성화 여부
  trailingHighPct?: number;       // 1차 TP 도달 후 추적한 최고 수익률 (%)
  trailingStopWidth?: number;     // 트레일링 폭 (%) — 모드별 차이: 일반 10%, 급등 8%, 급등직전 12%
  lastLiveAnalysisAt?: number;    // 마지막 실시간 분석 시각 (ms)
  liveSignalDirection?: string;   // 최신 실시간 분석 방향 (LONG/SHORT)
  liveSignalConfidence?: number;  // 최신 실시간 분석 신뢰도
  liveAnalysisCount?: number;     // 실시간 분석 누적 횟수
  liveSignalReason?: string;      // 실시간 분석 주요 신호 (예: MACD 강세 · EMA 정렬)
  liveSignalRsi?: number;         // 실시간 분석 RSI 값
  liveSignalAdx?: number;         // 실시간 분석 ADX (추세 강도)
  liveSignalTf15m?: string;       // 15분봉 방향
  liveSignalTf1h?: string;        // 1시간봉 방향
  liveSignalUpdatedAt?: number;   // 마지막 분석 완료 시각 (표시용)
  sourceType?: SectionType;        // 추천 섹션 출처 (추/바/급/집 배지)
  // ── 피라미딩 + 추가매수 필드 ──
  pyramidCount?: number;          // 피라미딩 실행 횟수 (수익 구간 추가매수, 최대 2회)
  lastPyramidPnlPct?: number;     // 마지막 피라미딩 시점 pnlPct (중복 방지)
  addCountStrict?: number;        // 손실 구간 추가매수 횟수 (최대 2회)
  lastAddAt?: number;             // 마지막 추가매수 시각 (30분 쿨다운)
  mtfConfirmed?: boolean;         // MTF 3개 타임프레임 일치 여부 (진입 시 기록)
}

export interface BotLog {
  time: number;
  level: 'INFO' | 'WARN' | 'ERROR' | 'TRADE';
  message: string;
}

export interface TradeRecord {
  id: string;
  date: string;          // YYYY-MM-DD
  symbol: string;
  side: 'Buy' | 'Sell';
  direction: 'LONG' | 'SHORT';
  avgPrice: number;      // 평균단가
  entryPrice: number;    // 진입가
  closePrice: number;    // 청산가
  pnl: number;           // 수익금 (USDT) - 수수료 차감 전
  pnlNet: number;        // 수익금 (USDT) - 수수료 포함 실현수익
  fee: number;           // 총 수수료 (진입 + 청산, USDT)
  pnlPct: number;        // 수익률 (%) - 수수료 포함
  leverage: number;
  closedAt: number;
      sourceType?: SectionType;   // 출처 섹션 (top7/surge/presurge)
  holdingMinutes?: number;    // 보유 시간 (분)
}

// 봇 모드 타입
export type BotMode = 'normal' | 'surge';

export interface BotState {
  running: boolean;
  positions: BotPosition[];
  logs: BotLog[];
  lastTickAt: number;
  totalPnl: number;
  autoEntry: boolean;          // 자동 신규진입 ON/OFF (기본 true)
  // 이원화 봇 ON/OFF (normalRunning: 일반봇, surgeRunning: 급등봇)
  normalRunning: boolean;      // 일반봇 ON/OFF (top7 섹션)
  surgeRunning: boolean;       // 급등봇 ON/OFF (surge/presurge 섹션)
  // 일일 30%+ 복리 전략
  dailyStartBalance?: number;  // 오늘 시작 잔고 (USDT)
  dailyPnl?: number;           // 오늘 실현 수익 (USDT)
  dailyPnlPct?: number;        // 오늘 수익률 (%)
  conservativeMode?: boolean;  // 보수 모드 (30% 목표 달성 후 활성화)
  dailyReportDate?: string;    // 마지막 보고서 생성 날짜 (YYYY-MM-DD)
  // 시장 컨텍스트 (BTC/ETH 추세 + 뉴스)
  marketContextSummary?: string;   // 시장 현황 한 줄 요약
  marketPhase?: string;            // 시장 국면 (RISK_ON/RISK_OFF/BTC_SURGE 등)
  marketStrategyReason?: string;   // 현재 적용 중인 전략 근거
  urgentNewsCount?: number;        // 긴급 뉴스 건수
  lastMarketContextAt?: number;    // 마지막 시장 분석 시각
  // ── 4가지 전략 조합 컨텍스트 ──
  currentSession?: string;          // 현재 시장 세션 라벨 (🌏 아시아 세션 등)
  currentVolatility?: string;       // 현재 변동성 레벨 라벨 (🟢 저변동성 등)
  currentVolatilityLevel?: string;  // LOW/MEDIUM/HIGH/EXTREME
  effectiveConfidenceMin?: number;  // 현재 적용 중인 신뢰도 기준
  effectivePosMultiplier?: number;  // 현재 포지션 크기 배율
  allowNewEntryBySession?: boolean; // 세션 기반 신규 진입 허용 여부
}

export interface BotConfig {
  maxPositions: number;
  slThreshold: number;       // 손절/익절 첫 분석 시작 임계값 (%) - 기본 30
  slStep: number;            // 분석 반복 단위 (%) - 기본 10
  slForceThreshold: number;  // 손절 강제 임계값 (%) - 기본 100 (방향 유지 시만)
  surgeLeverage?: number;        // 급등락 전용 레버리지 (기본 10)
  defaultLeverage?: number;      // 일반 레버리지 (기본 설정값 사용)
  normalTakeProfitPct?: number;  // 일반봇 목표가 (%) - 기본 50, 도달 시 신뢰도 기반 유지/청산
  // ── 고속 진입 + 적정 분산 전략 설정 ──
  entryConfidenceMin?: number;   // 진입 최소 신뢰도 (%) - 기본 80
  positionSizePct?: number;      // 종목당 투입 비율 (%) - 기본 2
  trailingWidthNormal?: number;  // 일반봇 트레일링 폭 (%) - 기본 5
  trailingWidthSurge?: number;   // 급등봇 트레일링 폭 (%) - 기본 5
  trailingWidthPresurge?: number;// 급등직전봇 트레일링 폭 (%) - 기본 8
  btcDropGuard?: boolean;        // BTC -3% 급락 시 신규 진입 중단 (true=활성)
  btcDropThresholdPct?: number;  // BTC 급락 차단 기준 (%) - 기본 3
}

const STATE_KEY = 'bot_state_v5';
const MANUAL_TRADE_KEY = 'manual_trade_blacklist_v1';
const BOT_EXCLUDE_KEY = 'bot_exclude_list_v1'; // 사용자 영구 제외 목록

// ─── 자동봇 제외 목록 ────────────────────────────────────────────────────────

export async function loadBotExcludeList(): Promise<string[]> {
  const raw = await AsyncStorage.getItem(BOT_EXCLUDE_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw) as string[]; } catch { return []; }
}

export async function saveBotExcludeList(list: string[]): Promise<void> {
  await AsyncStorage.setItem(BOT_EXCLUDE_KEY, JSON.stringify(list));
}

export async function addToBotExcludeList(bybitSymbol: string): Promise<void> {
  const list = await loadBotExcludeList();
  if (!list.includes(bybitSymbol)) {
    list.push(bybitSymbol);
    await saveBotExcludeList(list);
  }
}

/** 자동봇 상태에서 특정 종목 포지션을 즉시 제거 (제외 버튼 클릭 시 화면 즉시 반영) */
export async function removePositionFromBot(bybitSymbol: string): Promise<void> {
  const state = await loadBotState();
  const before = state.positions.length;
  state.positions = state.positions.filter(p => p.bybitSymbol !== bybitSymbol);
  if (state.positions.length !== before) {
    await saveBotState(state);
  }
}

export async function removeFromBotExcludeList(bybitSymbol: string): Promise<void> {
  const list = await loadBotExcludeList();
  await saveBotExcludeList(list.filter(s => s !== bybitSymbol));
}

export async function isInBotExcludeList(bybitSymbol: string): Promise<boolean> {
  const list = await loadBotExcludeList();
  return list.includes(bybitSymbol);
}

// ─── 직접매매 블랙리스트 (30분 추천 중지) ────────────────────────────────────

const MANUAL_COOLDOWN_MS = 30 * 60 * 1000; // 30분

export async function loadManualBlacklist(): Promise<Record<string, number>> {
  const raw = await AsyncStorage.getItem(MANUAL_TRADE_KEY);
  if (!raw) return {};
  try { return JSON.parse(raw) as Record<string, number>; } catch { return {}; }
}

export async function saveManualBlacklist(list: Record<string, number>): Promise<void> {
  await AsyncStorage.setItem(MANUAL_TRADE_KEY, JSON.stringify(list));
}

export async function isManualBlacklisted(bybitSymbol: string): Promise<boolean> {
  const list = await loadManualBlacklist();
  const ts = list[bybitSymbol];
  if (!ts) return false;
  return Date.now() - ts < MANUAL_COOLDOWN_MS;
}

export async function cleanExpiredManualBlacklist(): Promise<void> {
  const list = await loadManualBlacklist();
  const now = Date.now();
  const cleaned: Record<string, number> = {};
  for (const [sym, ts] of Object.entries(list)) {
    if (now - ts < MANUAL_COOLDOWN_MS) cleaned[sym] = ts;
  }
  await saveManualBlacklist(cleaned);
}

const CONFIG_KEY = 'bot_config_v4';
const TRADE_HISTORY_KEY = 'trade_history_v1';

const DEFAULT_CONFIG: BotConfig = {
  maxPositions: 10,            // 슬롯 10개 (고속 진입 + 적정 분산)
  slThreshold: 30,             // 30% 손실/이익부터 시작
  slStep: 10,                  // 10% 단위마다 반복
  slForceThreshold: 100,       // 100% 손실 + 방향 유지 시 강제 손절
  normalTakeProfitPct: 50,     // 일반봇 목표가 50% (도달 시 신뢰도 85%+ 유지, 미만 청산)
  // ── 고속 진입 + 적정 분산 전략 기본값 ──
  entryConfidenceMin: 80,      // 진입 최소 신뢰도 80%
  positionSizePct: 2,          // 종목당 투입 비율 2%
  trailingWidthNormal: 5,      // 일반봇 트레일링 5%
  trailingWidthSurge: 5,       // 급등봇 트레일링 5%
  trailingWidthPresurge: 8,    // 급등직전봇 트레일링 8%
  btcDropGuard: true,          // BTC 급락 차단 활성
  btcDropThresholdPct: 3,      // BTC -3% 이상 하락 시 신규 진입 중단
};

// 2분마다 스캘핑 분석 (ms)
const SIGNAL_REFRESH_INTERVAL = 2 * 60 * 1000;
let _lastSignalFetchAt = 0;
let _cachedSignals: import('./scalping-engine').ScalpingSignal[] = [];
// 급등봇 전용 신호 캐시 (급등락 + 급등직전)
let _cachedSurgeSignals: (import('./scalping-engine').ScalpingSignal & { _sectionType: SectionType })[] = [];

// ─── 상태 관리 ────────────────────────────────────────────────────────────────

export async function loadBotState(): Promise<BotState> {
  const raw = await AsyncStorage.getItem(STATE_KEY);
  if (!raw) {
    // 구버전 키도 확인
    const oldRaw = await AsyncStorage.getItem('bot_state_v4');
    if (oldRaw) {
      try {
        const parsed = JSON.parse(oldRaw) as BotState;
        return {
          ...parsed,
          running: false, // 구버전 상태는 정지로 초기화
          positions: [],
          logs: Array.isArray(parsed.logs) ? parsed.logs.slice(0, 300) : [],
          lastTickAt: 0,
          totalPnl: typeof parsed.totalPnl === 'number' ? parsed.totalPnl : 0,
        };
      } catch { /* 무시 */ }
    }
    return { running: false, normalRunning: false, surgeRunning: false, positions: [], logs: [], lastTickAt: 0, totalPnl: 0, autoEntry: true };
  }
  try {
    const parsed = JSON.parse(raw) as BotState;
    const safePositions = Array.isArray(parsed.positions)
      ? parsed.positions.filter(p =>
          p && typeof p === 'object' &&
          typeof p.symbol === 'string' &&
          typeof p.entryPrice === 'number' &&
          typeof p.size === 'string'
        )
      : [];
    return {
      ...parsed,
      running: parsed.running === true,
      positions: safePositions,
      logs: Array.isArray(parsed.logs) ? parsed.logs.slice(0, 300) : [],
      lastTickAt: typeof parsed.lastTickAt === 'number' ? parsed.lastTickAt : 0,
      totalPnl: typeof parsed.totalPnl === 'number' ? parsed.totalPnl : 0,
      dailyStartBalance: typeof parsed.dailyStartBalance === 'number' ? parsed.dailyStartBalance : undefined,
      dailyPnl: typeof parsed.dailyPnl === 'number' ? parsed.dailyPnl : 0,
      dailyPnlPct: typeof parsed.dailyPnlPct === 'number' ? parsed.dailyPnlPct : 0,
      conservativeMode: parsed.conservativeMode === true,
      dailyReportDate: typeof parsed.dailyReportDate === 'string' ? parsed.dailyReportDate : undefined,
      autoEntry: parsed.autoEntry !== false, // undefined/true → true, false → false
      normalRunning: parsed.normalRunning === true,
      surgeRunning: parsed.surgeRunning === true,
    };
  } catch {
    return { running: false, normalRunning: false, surgeRunning: false, positions: [], logs: [], lastTickAt: 0, totalPnl: 0, autoEntry: true };
  }
}

export async function saveBotState(state: BotState): Promise<void> {
  await AsyncStorage.setItem(STATE_KEY, JSON.stringify(state));
}

export async function loadConfig(): Promise<BotConfig> {
  const raw = await AsyncStorage.getItem(CONFIG_KEY);
  if (!raw) return { ...DEFAULT_CONFIG };
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(raw) }; } catch { return { ...DEFAULT_CONFIG }; }
}

export async function saveConfig(config: BotConfig): Promise<void> {
  await AsyncStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

// ─── 매매기록 관리 ────────────────────────────────────────────────────────────

export async function loadTradeHistory(): Promise<TradeRecord[]> {
  const raw = await AsyncStorage.getItem(TRADE_HISTORY_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw) as TradeRecord[]; } catch { return []; }
}

async function saveTradeRecord(record: TradeRecord): Promise<void> {
  const history = await loadTradeHistory();
  history.unshift(record);
  await AsyncStorage.setItem(TRADE_HISTORY_KEY, JSON.stringify(history.slice(0, 500)));
}

// ─── 로그 ────────────────────────────────────────────────────────────────────

function addLog(state: BotState, level: BotLog['level'], message: string): void {
  state.logs.unshift({ time: Date.now(), level, message });
  if (state.logs.length > 300) state.logs = state.logs.slice(0, 300);
}

// ─── 포지션 진입 (시장가) ─────────────────────────────────────────────────────

async function enterPosition(
  creds: ApiCredentials,
  signal: ScalpingSignal,
  state: BotState,
  config: BotConfig,
  forceEntry = false,
  liveBybitSymbols?: Set<string>, // Bybit 실시간 보유 심볼
  sectionType?: SectionType,
): Promise<void> {
  // 봇 보유 종목 매매 금지
  const existingPos = state.positions.find(p => p.bybitSymbol === signal.bybitSymbol);
  if (existingPos) return;

  // Bybit 직접 보유 종목 매매 금지
  if (liveBybitSymbols && liveBybitSymbols.has(signal.bybitSymbol)) {
    addLog(state, 'INFO', `[스킵] ${signal.displaySymbol} — Bybit 직접 보유 중`);
    return;
  }

  // 슬롯 체크
  if (!forceEntry && state.positions.length >= config.maxPositions) return;

  // ── 10001 근본 차단: 진입 전 Bybit 심볼 유효성 사전 검증 ──
  const valid = await isSymbolValid(signal.bybitSymbol, creds.isTestnet);
  if (!valid) {
    addLog(state, 'WARN', `[심볼 무효] ${signal.displaySymbol} (${signal.bybitSymbol}) — Bybit 미상장, 진입 취소`);
    return;
  }

  try {
    const balance = await getBalance(creds);
    const meta = await getSymbolMeta(signal.bybitSymbol, creds.isTestnet);

    // ── 포지션 사이징 (고속 진입 + 적정 분산 전략) ──
    // config.positionSizePct 기본 2% 사용
    // 신뢰도 95%+ 슬롯 초과 진입은 기본의 1.5배 (3%) 적용
    const kellyFraction = signal.kellyFraction ?? 0;
    const conf = signal.confidence;
    const baseSizePct = config.positionSizePct ?? 2; // 기본 2%
    const maxSizePct = forceEntry ? baseSizePct * 1.5 : baseSizePct; // 강제진입 시 1.5배
    const kellyPct = kellyFraction > 0
      ? Math.min(kellyFraction * 100, maxSizePct) // 켈리 공식 값 사용
      : maxSizePct; // config 기본 비율

    const qty = calcQty(
      balance.availableBalance,
      kellyPct,
      signal.entryPrice,
      meta.maxLeverage,
      meta.minOrderQty,
      meta.qtyStep,
      meta.qtyPrecision,
    );

    if (qty === null) {
      addLog(state, 'WARN',
        `[${signal.displaySymbol}] 1개 단위 가격(${signal.entryPrice.toFixed(2)} USDT)이 가용잔고 3%를 초과 → 진입 차단`);
      return;
    }

    const notional = safeFloat(qty) * signal.entryPrice;
    if (notional < meta.minNotionalValue) {
      addLog(state, 'WARN',
        `[${signal.displaySymbol}] 주문금액 부족 (${notional.toFixed(2)} USDT < ${meta.minNotionalValue} USDT)`);
      return;
    }

    const side: 'Buy' | 'Sell' = signal.direction === 'LONG' ? 'Buy' : 'Sell';

    // ATR 동적 손절 (고급 전략 6): ATR이 있으면 ATR×1.5, 없으면 레버리지 기반
    const atrSL = signal.atr && signal.atr > 0
      ? signal.atr * 1.5
      : (signal.entryPrice / meta.maxLeverage) * 0.55;
    const tpDist = atrSL * 2.0;
    const stopLoss = side === 'Buy'
      ? signal.entryPrice - atrSL
      : signal.entryPrice + atrSL;
    const takeProfit = side === 'Buy'
      ? signal.entryPrice + tpDist
      : signal.entryPrice - tpDist;

    // 급등락 전용 레버리지: surgeOptimalLeverage 우선, 없으면 config.surgeLeverage, 기본 maxLeverage
    const isSurge = sectionType === 'surge';
    const useLeverage = isSurge
      ? Math.min(
          signal.surgeOptimalLeverage ?? config.surgeLeverage ?? 10,
          meta.maxLeverage
        )
      : meta.maxLeverage;

    await placeOrder(
      creds,
      signal.bybitSymbol,
      side,
      qty,
      useLeverage,
      stopLoss.toString(),
      takeProfit.toString(),
    );

    state.positions.push({
      symbol: signal.symbol,
      bybitSymbol: signal.bybitSymbol,
      displaySymbol: signal.displaySymbol,
      side,
      entryPrice: signal.entryPrice,
      avgPrice: signal.entryPrice,
      size: qty,
      leverage: useLeverage,
      stopLoss,
      takeProfit,
      addCount: 0,
      openedAt: Date.now(),
      markPrice: signal.entryPrice,
      liqPrice: 0,
      unrealisedPnl: 0,
      pnlPct: 0,
      filled: true,
      lastAnalyzedPnlPct: undefined,
      forceEntry,
      confidence: signal.confidence,
      kellyFraction: signal.kellyFraction,
      nextActionPct: 30,
      sourceType: sectionType,
      partialTpCount: 0,
      initialSize: safeFloat(qty),
      // initialMarginUsdt: 진입 수량 xd7 시장가 / 레버리지 (보증금 = 명목가치 / 레버리지)
      initialMarginUsdt: (safeFloat(qty) * signal.entryPrice) / useLeverage,
    });

    const label = forceEntry ? '[강제진입 95%+]' : '[진입]';
    const levLabel = isSurge ? `급등락 ${useLeverage}x` : `${useLeverage}x`;
    addLog(state, 'TRADE',
      `${label} ${signal.displaySymbol} ${side === 'Buy' ? '롱' : '숏'} | 평단가: ${signal.entryPrice.toFixed(meta.pricePrecision)} | ${levLabel} | 신뢰도 ${signal.confidence}%`);
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    addLog(state, 'ERROR', `[진입 실패] ${signal.displaySymbol}: ${errMsg}`);

    // 10001: position idx 불일치 → 포지션 모드 강제 재감지
    if (errMsg.includes('10001')) {
      resetPositionModeDetection();
      addLog(state, 'INFO', `[포지션 모드 재감지] 10001 오류로 인해 포지션 모드를 재확인합니다.`);
    }

    // 약관 동의 필요 종목 → 영구 블랙리스트 추가
    const agreementCodes = ['110123', 'sign the required agreement', 'agreement', '약관'];
    if (agreementCodes.some(code => errMsg.toLowerCase().includes(code.toLowerCase()))) {
      const blacklist = await loadManualBlacklist();
      // 영구 블랙리스트: 99년 후 만료 (사실상 영구)
      blacklist[signal.bybitSymbol] = Date.now() + 99 * 365 * 24 * 60 * 60 * 1000;
      await AsyncStorage.setItem(MANUAL_TRADE_KEY, JSON.stringify(blacklist));
      addLog(state, 'WARN', `[약관 블랙리스트] ${signal.displaySymbol} — 약관 동의 필요 종목으로 영구 제외`);
    }
  }
}

// ─── 포지션 실시간 업데이트 ──────────────────────────────────────────────────

async function refreshPositions(creds: ApiCredentials, state: BotState): Promise<string[]> {
  if (state.positions.length === 0) return [];
  const closedSymbols: string[] = [];

  try {
    const liveList = await getPositions(creds);
    const liveMap = new Map<string, PositionInfo>(liveList.map(p => [p.symbol, p]));

    for (const pos of state.positions) {
      const live = liveMap.get(pos.bybitSymbol);
      if (!live || safeFloat(live.size) === 0) {
        closedSymbols.push(pos.symbol);
        state.totalPnl += pos.unrealisedPnl;

        const today = new Date().toISOString().slice(0, 10);
        const positionValue = safeFloat(pos.size) * pos.avgPrice;
        const feeRate = 0.00055;
        const totalFee = positionValue * feeRate * 2;
        const pnlNet = pos.unrealisedPnl - totalFee;
        const margin = positionValue / Math.max(pos.leverage, 1);
        const pnlPctNet = margin > 0 ? (pnlNet / margin) * 100 : pos.pnlPct;

        const holdingMs = pos.openedAt ? Date.now() - pos.openedAt : 0;
        await saveTradeRecord({
          id: `${pos.bybitSymbol}_${Date.now()}`,
          date: today,
          symbol: pos.displaySymbol,
          side: pos.side,
          direction: pos.side === 'Buy' ? 'LONG' : 'SHORT',
          avgPrice: pos.avgPrice,
          entryPrice: pos.entryPrice,
          closePrice: pos.markPrice,
          pnl: pos.unrealisedPnl,
          pnlNet,
          fee: totalFee,
          pnlPct: pnlPctNet,
          leverage: pos.leverage,
          closedAt: Date.now(),
          sourceType: pos.sourceType,
          holdingMinutes: holdingMs > 0 ? Math.round(holdingMs / 60000) : undefined,
        });

        // 일일 수익 누적 (30%+ 복리 전략)
        state.dailyPnl = (state.dailyPnl ?? 0) + pnlNet;
        if (state.dailyStartBalance && state.dailyStartBalance > 0) {
          state.dailyPnlPct = (state.dailyPnl / state.dailyStartBalance) * 100;
          // 30% 목표 달성 시 보수 모드 전환
          if (!state.conservativeMode && state.dailyPnlPct >= 30) {
            state.conservativeMode = true;
            addLog(state, 'INFO',
              `[하루 목표 달성!] 일일 수익률 ${state.dailyPnlPct.toFixed(1)}% → 보수 모드 전환 (신뢰도 90%+ 전용, 포지션 최대 3개)`);
          }
        }

        addLog(state, 'TRADE',
          `[정산] ${pos.displaySymbol} | 순이익(수수료제외): ${pnlNet >= 0 ? '+' : ''}${pnlNet.toFixed(2)} USDT (${pnlPctNet.toFixed(1)}%) | 수수료: -${totalFee.toFixed(3)} USDT | 오늘 누적: ${(state.dailyPnlPct ?? 0).toFixed(1)}%`);
      } else {
        const liveAvg = safeFloat(live.avgPrice ?? live.entryPrice, pos.avgPrice);
        if (liveAvg > 0) pos.avgPrice = liveAvg;
        pos.markPrice = safeFloat(live.markPrice, pos.markPrice);
        pos.liqPrice = safeFloat(live.liqPrice, pos.liqPrice);
        pos.unrealisedPnl = safeFloat(live.unrealisedPnl, pos.unrealisedPnl);
        const margin = safeFloat(live.positionValue) / Math.max(pos.leverage, 1);
        pos.pnlPct = margin > 0 ? (pos.unrealisedPnl / margin) * 100 : pos.pnlPct;
      }
    }

    state.positions = state.positions.filter(p => !closedSymbols.includes(p.symbol));
  } catch (e) {
    addLog(state, 'WARN', `포지션 업데이트 오류: ${e instanceof Error ? e.message : String(e)}`);
  }

  return closedSymbols;
}

// ─── 포지션 관리 (손절/익절 v6 통합) ─────────────────────────────────────────
// 손절: 손실 30%부터 10% 단위마다 분석
//   방향 바뀜 → 손절 후 역방향 50% 진입 (슬롯 제한 없음)
//   방향 유지 → 보유량 30% 추가매수
//   방향 유지 + 손실 100% → 강제 손절
// 익절: 이익 30%부터 10% 단위마다 분석
//   방향 바뀜 → 청산 후 역방향 50% 진입 (슬롯 제한 없음)
//   방향 유지 → 계속 보유

// 실시간 분석 주기: 포지션당 최대 1분마다 1회
// (여러 포지션이 있으면 API 호출이 많아지므로 최소 간격 유지)
const LIVE_ANALYSIS_INTERVAL_MS = 60 * 1000; // 1분

async function managePositions(
  creds: ApiCredentials,
  state: BotState,
  config: BotConfig,
): Promise<void> {
  // 제외 목록에 있는 포지션은 관리 대상에서 완전 제외 (손절/익절/추가매수 모두 차단)
  const excludeListForManage = await loadBotExcludeList();
  const excludeSetForManage = new Set(excludeListForManage);
  for (const pos of [...state.positions]) {
    try {
      // 제외 목록에 있는 포지션은 완전히 무시 (Bybit에 있어도 손절/익절/추가매수 모두 차단)
      if (excludeSetForManage.has(pos.bybitSymbol)) continue;

      const absPnl = Math.abs(pos.pnlPct);
      const step = config.slStep ?? 10;

      // ── 급등락(surge) 종목 특화 전략 ──
      // surge 소스 포지션: 빠른 손절(-15%), 빠른 익절(+20%), 방향전환 신호 40%+ 즉시 청산
      if (pos.sourceType === 'surge') {
        // 빠른 손절: -15% 도달 시 즉시 청산 (일반 손절보다 빠름)
        if (pos.pnlPct <= -15) {
          await closePosition(creds, pos.bybitSymbol, pos.side, pos.size);
          addLog(state, 'TRADE',
            `[급등락-손절] ${pos.displaySymbol} | 손실 ${pos.pnlPct.toFixed(1)}% → 빠른 손절 (-15% 기준)`);
          state.positions = state.positions.filter(p => p.bybitSymbol !== pos.bybitSymbol);
          continue;
        }
        // 빠른 익절: +20% 도달 시 즉시 청산
        if (pos.pnlPct >= 20) {
          await closePosition(creds, pos.bybitSymbol, pos.side, pos.size);
          addLog(state, 'TRADE',
            `[급등락-익절] ${pos.displaySymbol} | 수익 ${pos.pnlPct.toFixed(1)}% → 빠른 익절 (+20% 기준)`);
          state.positions = state.positions.filter(p => p.bybitSymbol !== pos.bybitSymbol);
          continue;
        }
        // 방향 전환 신호 40%+ 시 즉시 청산 (일반 60%보다 빠름)
        const surgeNow = Date.now();
        const surgeLastAnalysis = pos.lastLiveAnalysisAt ?? 0;
        if (surgeNow - surgeLastAnalysis >= 30 * 1000) { // 30초마다 분석
          try {
            const surgeLive = await analyzeSymbolLive(pos.symbol);
            pos.lastLiveAnalysisAt = surgeNow;
            if (surgeLive) {
              pos.liveSignalDirection = surgeLive.direction;
              pos.liveSignalConfidence = surgeLive.confidence;
              const surgePosDir = pos.side === 'Buy' ? 'LONG' : 'SHORT';
              const surgeSameDir = surgeLive.direction === surgePosDir;
              if (!surgeSameDir && surgeLive.confidence >= 40) {
                await closePosition(creds, pos.bybitSymbol, pos.side, pos.size);
                addLog(state, 'TRADE',
                  `[급등락-전환] ${pos.displaySymbol} | 방향전환 감지 (신뢰도 ${surgeLive.confidence}%, 40%+ 기준) → 즉시 청산`);
                state.positions = state.positions.filter(p => p.bybitSymbol !== pos.bybitSymbol);
                continue;
              }
            }
          } catch (_) { /* 분석 실패 시 일반 로직으로 진행 */ }
        }
      }

      // ── 실시간 분석 레이어: 매 틱마다 보유 포지션 방향성 감지 ──
      // 기존 손절/익절 임계값 로직은 유지, 그 위에 방향성 전환 감지 레이어 추가
      // 조건: 1분에 1회 분석, 임계값 도달 전이라도 방향성 전환 시 즉각 대응
      const now = Date.now();
      const lastAnalysis = pos.lastLiveAnalysisAt ?? 0;
      const shouldAnalyze = now - lastAnalysis >= LIVE_ANALYSIS_INTERVAL_MS;

      if (shouldAnalyze) {
        try {
          const liveSignal = await analyzeSymbolLive(pos.symbol);
          pos.lastLiveAnalysisAt = now;
          pos.liveAnalysisCount = (pos.liveAnalysisCount ?? 0) + 1;

          if (liveSignal) {
            pos.liveSignalDirection = liveSignal.direction;
            pos.liveSignalConfidence = liveSignal.confidence;
            pos.liveSignalReason = liveSignal.reason ?? undefined;
            pos.liveSignalRsi = liveSignal.rsi ?? undefined;
            pos.liveSignalAdx = liveSignal.adx ?? undefined;
            pos.liveSignalTf15m = (liveSignal as any).tf15m ?? undefined;
            pos.liveSignalTf1h = (liveSignal as any).tf1h ?? undefined;
            pos.liveSignalUpdatedAt = now;

            const posDir = pos.side === 'Buy' ? 'LONG' : 'SHORT';
            const sameDir = liveSignal.direction === posDir;

            // 방향성 전환 감지: 임계값 도달 전이라도 즉각 대응
            // 신뢰도 60%+ 시 전량 청산 후 원래 보유량의 50%만 역방향 진입
            if (!sameDir) {
              const dynamicThreshold = Math.min(
                config.slThreshold,
                Math.max(3, Math.round((100 / (pos.leverage || 10)) * 1.5))
              );
              const isInActionZone = pos.pnlPct <= -dynamicThreshold || pos.pnlPct >= config.slThreshold;
              const isHighConfidenceReversal = liveSignal.confidence >= 60;

              if (isInActionZone || isHighConfidenceReversal) {
                // 임계값 도달에서 방향 전환: 기존 손절/익절 로직에서 수행
                // 임계값 미달 + 신뢰도 60%+: 조기 대응 — 전량 청산 + 50% 역방향 진입
                const actionLabel = isInActionZone ? '임계값도달' : '조기전환(60%+)';
                addLog(state, 'INFO',
                  `[실시간분석] ${pos.displaySymbol} | ${posDir}→${liveSignal.direction} 방향전환 감지 (${actionLabel}) | 신뢰도 ${liveSignal.confidence}% | 수익 ${pos.pnlPct.toFixed(1)}%`);

                // 임계값 미달 + 신뢰도 60%+: 전량 청산 후 50% 역방향 진입
                if (!isInActionZone && isHighConfidenceReversal) {
                  const earlyReverseCount = pos.reverseCount ?? 0;
                  if (earlyReverseCount >= 2) {
                    addLog(state, 'WARN',
                      `[역방향제한] ${pos.displaySymbol} | 역방향 재진입 ${earlyReverseCount}회 이미 실행 → 수수료 누적 방지를 위해 신규 진입 중지`);
                  } else {
                    try {
                      const origSize = safeFloat(pos.size);
                      const newSide: 'Buy' | 'Sell' = pos.side === 'Buy' ? 'Sell' : 'Buy';
                      // 항상 원래 보유량의 50%만 역방향 진입
                      const earlyRatio = 0.5;
                      const earlyLabel = '50%';
                      await closePosition(creds, pos.bybitSymbol, pos.side, pos.size);
                      addLog(state, 'TRADE',
                        `[조기청산] ${pos.displaySymbol} | 수익 ${pos.pnlPct.toFixed(1)}% + 방향전환 (${liveSignal.direction}, 신뢰도 ${liveSignal.confidence}%) → 전량청산 완료, 역방향 ${earlyLabel} 진입 준비`);
                      state.positions = state.positions.filter(p => p.bybitSymbol !== pos.bybitSymbol);

                      // 청산 체결 재확인: Bybit에서 포지션이 실제로 소멸됐는지 확인
                      const earlyCheckPos = await getPositionBySymbol(creds, pos.bybitSymbol).catch(() => null);
                      if (earlyCheckPos && safeFloat(earlyCheckPos.size) > 0) {
                        addLog(state, 'WARN',
                          `[조기청산 미체결] ${pos.displaySymbol} | Bybit 포지션 잔존 (size: ${earlyCheckPos.size}) → 역방향 진입 취소`);
                        continue;
                      }

                      const earlyMeta = await getSymbolMeta(pos.bybitSymbol, creds.isTestnet);
                      const earlyQtyRaw = origSize * earlyRatio;
                      const earlyQtyStr = Math.max(earlyMeta.minOrderQty,
                        Math.floor(earlyQtyRaw / earlyMeta.qtyStep) * earlyMeta.qtyStep)
                        .toFixed(earlyMeta.qtyPrecision);
                      const earlyPrice = liveSignal.entryPrice;
                      const earlyAtrSL = liveSignal.atr && liveSignal.atr > 0
                        ? liveSignal.atr * 1.5
                        : (earlyPrice / pos.leverage) * 0.55;
                      const earlySL = newSide === 'Buy' ? earlyPrice - earlyAtrSL : earlyPrice + earlyAtrSL;
                      const earlyTP = newSide === 'Buy' ? earlyPrice + earlyAtrSL * 2 : earlyPrice - earlyAtrSL * 2;

                      await placeOrder(creds, pos.bybitSymbol, newSide, earlyQtyStr, pos.leverage, earlySL.toString(), earlyTP.toString());
                      state.positions.push({
                        symbol: pos.symbol, bybitSymbol: pos.bybitSymbol, displaySymbol: pos.displaySymbol,
                        side: newSide, entryPrice: earlyPrice, avgPrice: earlyPrice,
                        size: earlyQtyStr, leverage: pos.leverage, stopLoss: earlySL, takeProfit: earlyTP,
                        addCount: 0, openedAt: Date.now(), markPrice: earlyPrice,
                        liqPrice: 0, unrealisedPnl: 0, pnlPct: 0, filled: true,
                        lastAnalyzedPnlPct: undefined, isReverse: true,
                        reverseCount: earlyReverseCount + 1,
                        confidence: liveSignal.confidence, kellyFraction: liveSignal.kellyFraction, nextActionPct: 30,
                      });
                      addLog(state, 'TRADE',
                        `[조기역방향] ${pos.displaySymbol} ${newSide === 'Buy' ? '롱' : '숏'} | ${earlyQtyStr} (${earlyLabel}) | ${pos.leverage}x | ATR손절 | 신뢰도 ${liveSignal.confidence}%`);
                    } catch (earlyErr) {
                      addLog(state, 'WARN',
                        `[조기역방향 실패] ${pos.displaySymbol}: ${earlyErr instanceof Error ? earlyErr.message : String(earlyErr)}`);
                    }
                  }
                  // 임계값 도달 시는 기존 손절/익절 로직에서 처리
                }
              } else {
                // 임계값 미달 + 신뢰도 60% 미만: 로그만 기록
                addLog(state, 'INFO',
                  `[실시간분석] ${pos.displaySymbol} | 방향전환 감지되었으나 신뢰도 ${liveSignal.confidence}% 미달(임계값 도달 대기) | 수익 ${pos.pnlPct.toFixed(1)}%`);
              }
            } else {
              // 방향 유지
              addLog(state, 'INFO',
                `[실시간분석] ${pos.displaySymbol} | ${posDir} 방향 유지 확인 | 신뢰도 ${liveSignal.confidence}% | 수익 ${pos.pnlPct.toFixed(1)}%`);
            }
          }
        } catch {
          // 실시간 분석 실패 시 조용히 무시 (API 오류 등)
        }
      }

      // ── 레버리지 연동 동적 손절 임계값 계산 ──
      // 레버리지가 높을수록 더 빠른 시점에 손절 분석 시작 (100/leverage 기반)
      // 예: 10x → 15%, 20x → 10%, 50x → 5%, 100x → 3%
      // 최소 3%, 최대 30% (저레버리지 보호)
      const dynamicSlThreshold = Math.min(
        config.slThreshold,
        Math.max(3, Math.round((100 / (pos.leverage || 10)) * 1.5))
      );

      // ── 손절 1차: 레버리지 연동 임계값 도달 → 추세 분석 ──
      if (pos.pnlPct <= -dynamicSlThreshold) {
        // 이미 이 구간에서 분석했으면 스킵 (중복 추가매수 방지)
        const alreadyAnalyzed = pos.lastAnalyzedPnlPct !== undefined &&
          pos.lastAnalyzedPnlPct <= -dynamicSlThreshold &&
          Math.abs(pos.pnlPct - pos.lastAnalyzedPnlPct) < step; // step% 이내 변화면 재분석 안 함

        if (!alreadyAnalyzed) {
          const signal = await analyzeSymbolLive(pos.symbol);
          pos.lastAnalyzedPnlPct = pos.pnlPct;

          if (signal) {
            const sameDir = (signal.direction === 'LONG' && pos.side === 'Buy') ||
                            (signal.direction === 'SHORT' && pos.side === 'Sell');

            if (!sameDir) {
              // 방향성 다름 → 손절 후 역방향 진입 (신뢰도 85%+ → 100%, 미만 → 50%)
              const currentReverseCount = pos.reverseCount ?? 0;
              const origSize = safeFloat(pos.size);
              const revSide: 'Buy' | 'Sell' = pos.side === 'Buy' ? 'Sell' : 'Buy';
              const revRatio = signal.confidence >= 85 ? 1.0 : 0.5;
              const revLabel = signal.confidence >= 85 ? '100%' : '50%';
              await closePosition(creds, pos.bybitSymbol, pos.side, pos.size);
              addLog(state, 'TRADE',
                `[손절] ${pos.displaySymbol} | 손실 ${Math.abs(pos.pnlPct).toFixed(1)}% + 추세 반전 → 손절 체결 완료, 역방향 ${revLabel} 진입 준비 (신뢰도 ${signal.confidence}%, 역방향 ${currentReverseCount + 1}/2회)`);
              state.positions = state.positions.filter(p => p.bybitSymbol !== pos.bybitSymbol);

              // 청산 체결 재확인: Bybit에서 포지션이 실제로 소멸됐는지 확인
              const slCheckPos = await getPositionBySymbol(creds, pos.bybitSymbol).catch(() => null);
              if (slCheckPos && safeFloat(slCheckPos.size) > 0) {
                addLog(state, 'WARN',
                  `[손절 미체결] ${pos.displaySymbol} | Bybit 포지션 잔존 (size: ${slCheckPos.size}) → 역방향 진입 취소`);
                continue;
              }

              // 역방향 재진입 최대 2회 제한
              if (currentReverseCount >= 2) {
                addLog(state, 'WARN',
                  `[역방향 제한] ${pos.displaySymbol} | 역방향 재진입 ${currentReverseCount}회 이미 실행 → 수수료 누적 방지를 위해 신규 진입 중지`);
              } else {
                try {
                  const revMeta = await getSymbolMeta(pos.bybitSymbol, creds.isTestnet);
                  const revQtyRaw = origSize * revRatio;
                  const revQtyStr = Math.max(revMeta.minOrderQty,
                    Math.floor(revQtyRaw / revMeta.qtyStep) * revMeta.qtyStep)
                    .toFixed(revMeta.qtyPrecision);
                  const revPrice = signal.entryPrice;
                  const revAtrSL = signal.atr && signal.atr > 0
                    ? signal.atr * 1.5
                    : (revPrice / pos.leverage) * 0.55;
                  const revSL = revSide === 'Buy' ? revPrice - revAtrSL : revPrice + revAtrSL;
                  const revTP = revSide === 'Buy' ? revPrice + revAtrSL * 2 : revPrice - revAtrSL * 2;
                  await placeOrder(creds, pos.bybitSymbol, revSide, revQtyStr, pos.leverage, revSL.toString(), revTP.toString());
                  state.positions.push({
                    symbol: pos.symbol, bybitSymbol: pos.bybitSymbol, displaySymbol: pos.displaySymbol,
                    side: revSide, entryPrice: revPrice, avgPrice: revPrice,
                    size: revQtyStr, leverage: pos.leverage, stopLoss: revSL, takeProfit: revTP,
                    addCount: 0, openedAt: Date.now(), markPrice: revPrice,
                    liqPrice: 0, unrealisedPnl: 0, pnlPct: 0, filled: true,
                    lastAnalyzedPnlPct: undefined, isReverse: true,
                    reverseCount: currentReverseCount + 1,
                    confidence: signal.confidence, kellyFraction: signal.kellyFraction, nextActionPct: 30,
                  });
                  addLog(state, 'TRADE',
                    `[역방향-손절] ${pos.displaySymbol} ${revSide === 'Buy' ? '롱' : '숏'} | ${revQtyStr} (${revLabel}) | ${pos.leverage}x | ATR손절 | 역방향 ${currentReverseCount + 1}/2회`);
                } catch (revErr) {
                  addLog(state, 'WARN',
                    `[역방향-손절 실패] ${pos.displaySymbol}: ${revErr instanceof Error ? revErr.message : String(revErr)}`);
                }
              }
            } else {
              // 방향성 같음 → 강화된 조건의 추가매수
              // 조건: 추가매수 최대 2회 + 30분 쿨다운 + 신뢰도 75%+ + 타임프레임 일치
              const addCountStrict = pos.addCountStrict ?? 0;
              const lastAddAt = pos.lastAddAt ?? 0;
              const addCooldownMs = 30 * 60 * 1000; // 30분
              const addCooldownOk = Date.now() - lastAddAt >= addCooldownMs;
              const addMaxOk = addCountStrict < 2;
              const addConfOk = signal.confidence >= 75;
              // 타임프레임 일치: tf15m + tf1h 두 개 이상 방향 일치
              const posDirStr = pos.side === 'Buy' ? 'LONG' : 'SHORT';
              const tf15mOk = !signal.tf15m || signal.tf15m === posDirStr;
              const tf1hOk = !signal.tf1h || signal.tf1h === posDirStr;
              const tfMatchCount = (tf15mOk ? 1 : 0) + (tf1hOk ? 1 : 0);
              const tfOk = tfMatchCount >= 1; // 최소 1개 타임프레임 일치

              if (addMaxOk && addCooldownOk && addConfOk && tfOk) {
                const currentSize = safeFloat(pos.size);
                const addQty = currentSize * 0.2; // 30% → 20%로 감소
                const meta = await getSymbolMeta(pos.bybitSymbol, creds.isTestnet);
                const addQtyRaw = Math.ceil(addQty / meta.qtyStep) * meta.qtyStep; // 소수점 올림
                const addQtyStr = Math.max(meta.minOrderQty, addQtyRaw).toFixed(meta.qtyPrecision);

                try {
                  await addToPosition(creds, pos.bybitSymbol, pos.side, addQtyStr);
                  pos.addCount += 1;
                  pos.addCountStrict = addCountStrict + 1;
                  pos.lastAddAt = Date.now();
                  try {
                    const updatedPos = await getPositionBySymbol(creds, pos.bybitSymbol);
                    if (updatedPos && safeFloat(updatedPos.size) > 0) {
                      pos.size = updatedPos.size;
                      pos.avgPrice = safeFloat(updatedPos.avgPrice ?? updatedPos.entryPrice);
                      pos.entryPrice = safeFloat(updatedPos.entryPrice);
                    }
                  } catch { /* 조회 실패 시 기존 값 유지 */ }
                  addLog(state, 'TRADE',
                    `[추가매수] ${pos.displaySymbol} | 손실 ${Math.abs(pos.pnlPct).toFixed(1)}% + 신뢰도 ${signal.confidence}% + TF${tfMatchCount}일치 → +${addQtyStr} (20%) | ${addCountStrict + 1}/2회`);
                } catch (addErr) {
                  addLog(state, 'WARN',
                    `[추가매수 실패] ${pos.displaySymbol}: ${addErr instanceof Error ? addErr.message : String(addErr)}`);
                }
              } else {
                const reason = !addMaxOk ? `추가매수 ${addCountStrict}/2회 제한` :
                               !addCooldownOk ? `쿨다운 ${Math.round((addCooldownMs - (Date.now() - lastAddAt)) / 60000)}분 남음` :
                               !addConfOk ? `신뢰도 ${signal.confidence}% 미달(75%)` :
                               `TF 일치 부족(${tfMatchCount}/2)`;
                addLog(state, 'INFO',
                  `[추가매수 보류] ${pos.displaySymbol} | 손실 ${Math.abs(pos.pnlPct).toFixed(1)}% + 추세 유지 | ${reason}`);
              }
            }
          } else {
            // 분석 실패 → 보수적으로 손절
            await closePosition(creds, pos.bybitSymbol, pos.side, pos.size);
            addLog(state, 'TRADE',
              `[손절] ${pos.displaySymbol} | 손실 ${Math.abs(pos.pnlPct).toFixed(1)}% + 분석 불가 → 손절`);
            state.positions = state.positions.filter(p => p.bybitSymbol !== pos.bybitSymbol);
          }
        }
        continue;
      }

      // ── 일반봇 목표가(TP) 도달 시 신뢰도 기반 유지/청산 ──
      // 일반봇(top7) 전용: surge/presurge 소스는 급등락 전략 사용
      const isNormalSource = pos.sourceType === 'top7' || pos.sourceType === undefined;
      const normalTpPct = config.normalTakeProfitPct ?? 50; // 기본 50%

      if (isNormalSource && pos.pnlPct >= normalTpPct) {
        // 목표가 도달 횟수 추적
        const prevTpHit = pos.tpHitCount ?? 0;
        // 다음 목표가 = 기본 TP + (10% xd7 도달 횟수)
        const nextTpPct = normalTpPct + prevTpHit * 10;

        if (pos.pnlPct >= nextTpPct) {
          // 실시간 분석: 신뢰도 기반 유지/청산 판단
          try {
            const tpSignal = await analyzeSymbolLive(pos.symbol);
            pos.lastLiveAnalysisAt = Date.now();
            pos.liveAnalysisCount = (pos.liveAnalysisCount ?? 0) + 1;

            if (tpSignal) {
              pos.liveSignalDirection = tpSignal.direction;
              pos.liveSignalConfidence = tpSignal.confidence;
              pos.liveSignalUpdatedAt = Date.now();

              const posDir = pos.side === 'Buy' ? 'LONG' : 'SHORT';
              const sameDir = tpSignal.direction === posDir;

              if (sameDir && tpSignal.confidence >= 85) {
                // 신뢰도 85%+ + 방향 유지 → 목표가 +10% 상향 후 계속 보유
                pos.tpHitCount = prevTpHit + 1;
                pos.lastAnalyzedPnlPct = pos.pnlPct;
                const newNextTp = normalTpPct + pos.tpHitCount * 10;
                addLog(state, 'INFO',
                  `[목표가 유지] ${pos.displaySymbol} | +${pos.pnlPct.toFixed(1)}% 도달 | 신뢰도 ${tpSignal.confidence}% (방향 유지) → 다음 목표 +${newNextTp.toFixed(0)}% 대기 | ${pos.tpHitCount}잔 연장`);
              } else if (sameDir && tpSignal.confidence < 85) {
                // 신뢰도 85% 미만 + 방향 유지 → 수익 확정 청산
                await closePosition(creds, pos.bybitSymbol, pos.side, pos.size);
                addLog(state, 'TRADE',
                  `[목표가 청산] ${pos.displaySymbol} | +${pos.pnlPct.toFixed(1)}% | 신뢰도 ${tpSignal.confidence}% (방향 유지이나 신뢰도 미달 85%) → 수익 확정 청산`);
                state.positions = state.positions.filter(p => p.bybitSymbol !== pos.bybitSymbol);
                continue;
              } else {
                // 방향 전환 → 청산 후 역방향 진입 판단
                const tpRevCount = pos.reverseCount ?? 0;
                const tpRevRatio = tpSignal.confidence >= 85 ? 1.0 : 0.5;
                const tpRevLabel = tpSignal.confidence >= 85 ? '100%' : '50%';
                const tpOrigSize = safeFloat(pos.size);
                const tpNewSide: 'Buy' | 'Sell' = pos.side === 'Buy' ? 'Sell' : 'Buy';

                await closePosition(creds, pos.bybitSymbol, pos.side, pos.size);
                addLog(state, 'TRADE',
                  `[목표가 전환청산] ${pos.displaySymbol} | +${pos.pnlPct.toFixed(1)}% | 방향전환 (${tpSignal.direction}, 신뢰도 ${tpSignal.confidence}%) → 역방향 ${tpRevLabel} 진입 준비`);
                state.positions = state.positions.filter(p => p.bybitSymbol !== pos.bybitSymbol);

                const tpCheckPos = await getPositionBySymbol(creds, pos.bybitSymbol).catch(() => null);
                if (tpCheckPos && safeFloat(tpCheckPos.size) > 0) {
                  addLog(state, 'WARN', `[목표가 청산 미체결] ${pos.displaySymbol} → 역방향 진입 취소`);
                  continue;
                }

                if (tpRevCount >= 2) {
                  addLog(state, 'WARN', `[역방향 제한] ${pos.displaySymbol} | 역방향 ${tpRevCount}회 이미 실행 → 신규 진입 중지`);
                } else {
                  try {
                    const tpRevMeta = await getSymbolMeta(pos.bybitSymbol, creds.isTestnet);
                    const tpRevQtyRaw = tpOrigSize * tpRevRatio;
                    const tpRevQtyStr = Math.max(tpRevMeta.minOrderQty,
                      Math.floor(tpRevQtyRaw / tpRevMeta.qtyStep) * tpRevMeta.qtyStep)
                      .toFixed(tpRevMeta.qtyPrecision);
                    const tpRevPrice = tpSignal.entryPrice;
                    const tpRevAtrSL = tpSignal.atr && tpSignal.atr > 0
                      ? tpSignal.atr * 1.5 : (tpRevPrice / pos.leverage) * 0.55;
                    const tpRevSL = tpNewSide === 'Buy' ? tpRevPrice - tpRevAtrSL : tpRevPrice + tpRevAtrSL;
                    const tpRevTP = tpNewSide === 'Buy' ? tpRevPrice + tpRevAtrSL * 2 : tpRevPrice - tpRevAtrSL * 2;

                    await placeOrder(creds, pos.bybitSymbol, tpNewSide, tpRevQtyStr, pos.leverage, tpRevSL.toString(), tpRevTP.toString());
                    state.positions.push({
                      symbol: pos.symbol, bybitSymbol: pos.bybitSymbol, displaySymbol: pos.displaySymbol,
                      side: tpNewSide, entryPrice: tpRevPrice, avgPrice: tpRevPrice,
                      size: tpRevQtyStr, leverage: pos.leverage, stopLoss: tpRevSL, takeProfit: tpRevTP,
                      addCount: 0, openedAt: Date.now(), markPrice: tpRevPrice,
                      liqPrice: 0, unrealisedPnl: 0, pnlPct: 0, filled: true,
                      lastAnalyzedPnlPct: undefined, isReverse: true,
                      reverseCount: tpRevCount + 1,
                      confidence: tpSignal.confidence, kellyFraction: tpSignal.kellyFraction, nextActionPct: 30,
                    });
                    addLog(state, 'TRADE',
                      `[목표가-역방향] ${pos.displaySymbol} ${tpNewSide === 'Buy' ? '롱' : '숙'} | ${tpRevQtyStr} (${tpRevLabel}) | ${pos.leverage}x | 신뢰도 ${tpSignal.confidence}%`);
                  } catch (tpRevErr) {
                    addLog(state, 'WARN', `[목표가-역방향 실패] ${pos.displaySymbol}: ${tpRevErr instanceof Error ? tpRevErr.message : String(tpRevErr)}`);
                  }
                }
                continue;
              }
            } else {
              // 분석 실패 → 목표가 도달 시 보수적 청산
              await closePosition(creds, pos.bybitSymbol, pos.side, pos.size);
              addLog(state, 'TRADE',
                `[목표가 청산] ${pos.displaySymbol} | +${pos.pnlPct.toFixed(1)}% | 분석 불가 → 보수적 청산`);
              state.positions = state.positions.filter(p => p.bybitSymbol !== pos.bybitSymbol);
              continue;
            }
          } catch (tpErr) {
            addLog(state, 'WARN', `[목표가 분석 오류] ${pos.displaySymbol}: ${tpErr instanceof Error ? tpErr.message : String(tpErr)}`);
          }
        }
      }

      // ── 손익분기점 자동 이동 + 트레일링 스탑 ──
      // 1차 TP(normalTpPct 또는 surge +20%) 도달 후 활성화
      // breakEvenActivated: 손절 기준을 진입가+0.5%로 이동 (원금 보호)
      // trailingActivated: 최고점 대비 -8%/-10%/-12% 하락 시 청산
      if (pos.breakEvenActivated || pos.trailingActivated) {
        // 트레일링 최고점 갱신
        if (pos.pnlPct > (pos.trailingHighPct ?? 0)) {
          pos.trailingHighPct = pos.pnlPct;
        }
        // 트레일링 폭: 급등 8%, 급등직전 12%, 일반 10%
        const trailWidth = pos.trailingStopWidth ??
          (pos.sourceType === 'surge' ? 8 : pos.sourceType === 'presurge' ? 12 : 10);
        const trailHigh = pos.trailingHighPct ?? pos.pnlPct;
        const trailDrop = trailHigh - pos.pnlPct;

        // 손익분기점 이동: 수익이 0% 아래로 내려가면 즉시 청산 (원금 보호)
        if (pos.breakEvenActivated && pos.pnlPct <= 0.5) {
          await closePosition(creds, pos.bybitSymbol, pos.side, pos.size);
          addLog(state, 'TRADE',
            `[손익분기점] ${pos.displaySymbol} | 수익 ${pos.pnlPct.toFixed(1)}% → 손익분기점 이탈, 원금 보호 청산`);
          state.positions = state.positions.filter(p => p.bybitSymbol !== pos.bybitSymbol);
          continue;
        }

        // 트레일링 스탑: 최고점 대비 trailWidth% 이상 하락 시 청산
        if (pos.trailingActivated && trailDrop >= trailWidth) {
          await closePosition(creds, pos.bybitSymbol, pos.side, pos.size);
          addLog(state, 'TRADE',
            `[트레일링 스탑] ${pos.displaySymbol} | 최고 +${trailHigh.toFixed(1)}% → 현재 +${pos.pnlPct.toFixed(1)}% | -${trailDrop.toFixed(1)}% 하락 (기준 -${trailWidth}%) → 청산`);
          state.positions = state.positions.filter(p => p.bybitSymbol !== pos.bybitSymbol);
          continue;
        }
      }

      // ── 피라미딩: 수익 구간 추가매수 (최대 2회) ──
      // +10% 수익 + 신뢰도 80%+ → 보유량 20% 추가 (1차)
      // +20% 수익 + 신뢰도 80%+ → 보유량 10% 추가 (2차)
      const pyramidCount = pos.pyramidCount ?? 0;
      const pyramidThresholds = [10, 20]; // 1차: +10%, 2차: +20%
      const pyramidRatios = [0.2, 0.1];   // 1차: 20%, 2차: 10%
      if (pyramidCount < 2 && pos.pnlPct >= pyramidThresholds[pyramidCount]) {
        const lastPyramidPnl = pos.lastPyramidPnlPct ?? -Infinity;
        const alreadyPyramided = Math.abs(pos.pnlPct - lastPyramidPnl) < 3; // 3% 이내 중복 방지
        if (!alreadyPyramided) {
          try {
            const pyrSignal = await analyzeSymbolLive(pos.symbol);
            if (pyrSignal) {
              const pyrSameDir = (pyrSignal.direction === 'LONG' && pos.side === 'Buy') ||
                                 (pyrSignal.direction === 'SHORT' && pos.side === 'Sell');
              if (pyrSameDir && pyrSignal.confidence >= 80) {
                const pyrMeta = await getSymbolMeta(pos.bybitSymbol, creds.isTestnet);
                const pyrOrigSize = safeFloat(pos.size);
                const pyrRatio = pyramidRatios[pyramidCount];
                const pyrQtyRaw = Math.ceil(pyrOrigSize * pyrRatio / pyrMeta.qtyStep) * pyrMeta.qtyStep;
                const pyrQtyStr = Math.max(pyrMeta.minOrderQty, pyrQtyRaw).toFixed(pyrMeta.qtyPrecision);
                await addToPosition(creds, pos.bybitSymbol, pos.side, pyrQtyStr);
                pos.pyramidCount = pyramidCount + 1;
                pos.lastPyramidPnlPct = pos.pnlPct;
                // 피라미딩 후 평균단가 업데이트
                try {
                  const pyrUpdated = await getPositionBySymbol(creds, pos.bybitSymbol);
                  if (pyrUpdated && safeFloat(pyrUpdated.size) > 0) {
                    pos.size = pyrUpdated.size;
                    pos.avgPrice = safeFloat(pyrUpdated.avgPrice ?? pyrUpdated.entryPrice);
                  }
                } catch { /* 조회 실패 시 기존 값 유지 */ }
                addLog(state, 'TRADE',
                  `[피라미딩 ${pyramidCount + 1}차] ${pos.displaySymbol} | +${pos.pnlPct.toFixed(1)}% 수익 + 신뢰도 ${pyrSignal.confidence}% → +${pyrQtyStr} (${(pyrRatio * 100).toFixed(0)}%) 추가매수`);
              } else {
                addLog(state, 'INFO',
                  `[피라미딩 보류] ${pos.displaySymbol} | +${pos.pnlPct.toFixed(1)}% 수익 | 신뢰도 ${pyrSignal?.confidence ?? 0}% 미달(80%) 또는 방향 불일치`);
              }
            }
          } catch (pyrErr) {
            addLog(state, 'WARN', `[피라미딩 오류] ${pos.displaySymbol}: ${pyrErr instanceof Error ? pyrErr.message : String(pyrErr)}`);
          }
        }
      }

      // ── 익절: 이익 30% 이상부터 10% 단위마다 분석 ──
      if (pos.pnlPct >= config.slThreshold) {
        // 현재 구간 계산 (30, 40, 50, ...)
        const currentBand = Math.floor(pos.pnlPct / step) * step; // e.g. 73% → 70

        // 이미 이 구간에서 분석했으면 스킵
        const lastBand = pos.lastAnalyzedPnlPct !== undefined && pos.lastAnalyzedPnlPct > 0
          ? Math.floor(pos.lastAnalyzedPnlPct / step) * step
          : -Infinity;

        if (currentBand > lastBand) {
          const signal = await analyzeSymbolLive(pos.symbol);
          pos.lastAnalyzedPnlPct = pos.pnlPct;

          if (signal) {
            const sameDir = (signal.direction === 'LONG' && pos.side === 'Buy') ||
                            (signal.direction === 'SHORT' && pos.side === 'Sell');

            if (!sameDir) {
              // 방향성 다름 → 청산 후 역방향 진입 (신뢰도 85%+ → 100%, 미만 → 50%)
              const tpReverseCount = pos.reverseCount ?? 0;
              const origSize = safeFloat(pos.size);
              const newSide: 'Buy' | 'Sell' = pos.side === 'Buy' ? 'Sell' : 'Buy';
              const newSymbol = pos.symbol;
              const newBybitSymbol = pos.bybitSymbol;
              const newDisplay = pos.displaySymbol;
              const newLeverage = pos.leverage;
              const tpRevRatio = signal.confidence >= 85 ? 1.0 : 0.5;
              const tpRevLabel = signal.confidence >= 85 ? '100%' : '50%';

              await closePosition(creds, newBybitSymbol, pos.side, pos.size);
              addLog(state, 'TRADE',
                `[익절 청산] ${newDisplay} | 이익 ${pos.pnlPct.toFixed(1)}% + 추세 반전 → 청산 체결 완료, 역방향 ${tpRevLabel} 진입 준비 (신뢰도 ${signal.confidence}%, 역방향 ${tpReverseCount + 1}/2회)`);
              state.positions = state.positions.filter(p => p.bybitSymbol !== newBybitSymbol);

              // 청산 체결 재확인: Bybit에서 포지션이 실제로 소멸됐는지 확인
              const tpCheckPos = await getPositionBySymbol(creds, newBybitSymbol).catch(() => null);
              if (tpCheckPos && safeFloat(tpCheckPos.size) > 0) {
                addLog(state, 'WARN',
                  `[익절 청산 미체결] ${newDisplay} | Bybit 포지션 잔존 (size: ${tpCheckPos.size}) → 역방향 진입 취소`);
                continue;
              }

              // 역방향 재진입 최대 2회 제한
              if (tpReverseCount >= 2) {
                addLog(state, 'WARN',
                  `[역방향 제한] ${newDisplay} | 역방향 재진입 ${tpReverseCount}회 이미 실행 → 수수료 누적 방지를 위해 신규 진입 중지`);
              } else {
              // 역방향 진입 (신뢰도 기반 비율)
              try {
                const meta = await getSymbolMeta(newBybitSymbol, creds.isTestnet);
                const halfQty = origSize * tpRevRatio;
                const newQtyStr = Math.max(meta.minOrderQty, Math.floor(halfQty / meta.qtyStep) * meta.qtyStep)
                  .toFixed(meta.qtyPrecision);
                const newPrice = signal.entryPrice;
                const newAtrSL = signal.atr && signal.atr > 0
                  ? signal.atr * 1.5
                  : (newPrice / newLeverage) * 0.55;
                const newSL = newSide === 'Buy' ? newPrice - newAtrSL : newPrice + newAtrSL;
                const newTP = newSide === 'Buy' ? newPrice + newAtrSL * 2 : newPrice - newAtrSL * 2;

                await placeOrder(creds, newBybitSymbol, newSide, newQtyStr, newLeverage, newSL.toString(), newTP.toString());

                state.positions.push({
                  symbol: newSymbol,
                  bybitSymbol: newBybitSymbol,
                  displaySymbol: newDisplay,
                  side: newSide,
                  entryPrice: newPrice,
                  avgPrice: newPrice,
                  size: newQtyStr,
                  leverage: newLeverage,
                  stopLoss: newSL,
                  takeProfit: newTP,
                  addCount: 0,
                  openedAt: Date.now(),
                  markPrice: newPrice,
                  liqPrice: 0,
                  unrealisedPnl: 0,
                  pnlPct: 0,
                  filled: true,
                  lastAnalyzedPnlPct: undefined,
                  isReverse: true,
                  reverseCount: tpReverseCount + 1,
                  confidence: signal.confidence,
                  kellyFraction: signal.kellyFraction,
                  nextActionPct: 30,
                });
                addLog(state, 'TRADE',
                  `[역방향-익절] ${newDisplay} ${newSide === 'Buy' ? '롱' : '숏'} | ${newQtyStr} (${tpRevLabel}) | ${newLeverage}x | ATR손절 | 신뢰도 ${signal.confidence}%`);
              } catch (revErr) {
                addLog(state, 'WARN',
                  `[역방향 진입 실패] ${newDisplay}: ${revErr instanceof Error ? revErr.message : String(revErr)}`);
              }
              } // end else (reverseCount < 2)
            } else {
              // 방향성 같음 → 계속 보유 + BE/트레일링 자동 활성화
              if (!pos.breakEvenActivated) {
                pos.breakEvenActivated = true;
                addLog(state, 'INFO',
                  `[트레일링 활성화] ${pos.displaySymbol} | +${pos.pnlPct.toFixed(1)}% 도달 → 손익분기점 이동 + 트레일링 스탭 활성화`);
              }
              if (!pos.trailingActivated) {
                pos.trailingActivated = true;
                pos.trailingHighPct = pos.pnlPct;
                // 트레일링 폭: config 값 우선 적용
                pos.trailingStopWidth = pos.sourceType === 'surge'
                  ? (config.trailingWidthSurge ?? 5)
                  : pos.sourceType === 'presurge'
                    ? (config.trailingWidthPresurge ?? 8)
                    : (config.trailingWidthNormal ?? 5);
              }
              addLog(state, 'INFO',
                `[익절 유지] ${pos.displaySymbol} | 이익 ${pos.pnlPct.toFixed(1)}% + 추세 유지 → 계속 보유 (트레일링 ${pos.trailingStopWidth ?? 5}% 적용중)`);
            }
          } else {
            // 분석 실패 → 보수적으로 청산
            await closePosition(creds, pos.bybitSymbol, pos.side, pos.size);
            addLog(state, 'TRADE',
              `[익절 청산] ${pos.displaySymbol} | 이익 ${pos.pnlPct.toFixed(1)}% + 분석 불가 → 청산`);
            state.positions = state.positions.filter(p => p.bybitSymbol !== pos.bybitSymbol);
          }
        }
      }
    } catch (e) {
      addLog(state, 'WARN', `[관리 오류] ${pos.displaySymbol}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// ─── MMR 위험 관리 ────────────────────────────────────────────────────────────

async function manageMmrRisk(creds: ApiCredentials, state: BotState): Promise<void> {
  try {
    const balance = await getBalance(creds);
    if (balance.mmrPct < 80) return;
    addLog(state, 'WARN',
      `[MMR 경보] 유지증거금률 ${balance.mmrPct.toFixed(1)}% → 수익률 하위 종목부터 청산 시작`);
    const sorted = [...state.positions].sort((a, b) => a.pnlPct - b.pnlPct);
    for (const pos of sorted) {
      const freshBal = await getBalance(creds);
      if (freshBal.mmrPct <= 40) {
        addLog(state, 'INFO', `[MMR 정상화] ${freshBal.mmrPct.toFixed(1)}% → 40% 이하 달성`);
        break;
      }
      await closePosition(creds, pos.bybitSymbol, pos.side, pos.size);
      addLog(state, 'TRADE',
        `[MMR 청산] ${pos.displaySymbol} | 수익 ${pos.pnlPct.toFixed(1)}% | MMR ${freshBal.mmrPct.toFixed(1)}% 초과`);
      state.positions = state.positions.filter(p => p.bybitSymbol !== pos.bybitSymbol);
    }
  } catch (e) {
    addLog(state, 'WARN', `MMR 관리 오류: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ─── 직접매매 감지 + Bybit 보유 심볼 수집 ────────────────────────────────────

async function detectManualTrades(
  creds: ApiCredentials,
  state: BotState,
): Promise<Set<string>> {
  const liveBybitSymbols = new Set<string>();
  try {
    const livePositions = await getPositions(creds);
    const botSymbols = new Set(state.positions.map(p => p.bybitSymbol));
    // 제외 목록 로드 - 제외된 종목은 자동 등록 및 관리 완전 차단
    const excludeListForDetect = await loadBotExcludeList();
    const excludeSetForDetect = new Set(excludeListForDetect);

    for (const live of livePositions) {
      const size = safeFloat(live.size);
      if (size <= 0) continue;

      // 제외 목록에 있는 종목은 liveBybitSymbols에도 추가하지 않음
      // → 추천 필터링에서도 제외되고, 봇 관리에서도 완전히 무시됨
      if (excludeSetForDetect.has(live.symbol)) continue;

      liveBybitSymbols.add(live.symbol);

      if (!botSymbols.has(live.symbol)) {
        // 봇에 없는 Bybit 포지션 → 자동 등록 (슬롯 제한 없음)
        const displaySymbol = live.symbol.replace('USDT', '').replace('PERP', '');
        const entryPrice = safeFloat(live.avgPrice ?? live.entryPrice);
        const markPrice = safeFloat(live.markPrice);
        const leverage = safeFloat(live.leverage) || 10;
        const unrealisedPnl = safeFloat(live.unrealisedPnl);
        const posValue = safeFloat(live.positionValue) || (entryPrice * size);
        const pnlPct = posValue > 0 ? (unrealisedPnl / (posValue / leverage)) * 100 : 0;

        state.positions.push({
          symbol: live.symbol.replace('USDT', '_USDT'),
          bybitSymbol: live.symbol,
          displaySymbol,
          side: live.side,
          entryPrice,
          avgPrice: entryPrice,
          size: live.size,
          leverage,
          stopLoss: 0,
          takeProfit: 0,
          addCount: 0,
          openedAt: Date.now(),
          markPrice,
          liqPrice: safeFloat(live.liqPrice),
          unrealisedPnl,
          pnlPct,
          filled: true,
          isExternal: true,
        });
        botSymbols.add(live.symbol);
        addLog(state, 'INFO',
          `[외부진입 등록] ${displaySymbol} ${live.side === 'Buy' ? '롱' : '숏'} | ${live.size} | ${leverage}x | 슬롯 제한 없음`);
      }
    }

    // 봇에 있지만 Bybit에서 사라진 외부 포지션 제거
    const toRemove = state.positions.filter(
      p => p.isExternal && !liveBybitSymbols.has(p.bybitSymbol)
    );
    for (const p of toRemove) {
      state.positions = state.positions.filter(x => x.bybitSymbol !== p.bybitSymbol);
      addLog(state, 'INFO', `[외부진입 해제] ${p.displaySymbol} 포지션 청산 감지`);
    }
  } catch { /* 무시 */ }
  return liveBybitSymbols;
}

// ─── 봇 틱 ────────────────────────────────────────────────────────────────────

export async function botTick(onUpdate: (state: BotState) => void): Promise<void> {
  const state = await loadBotState();
  if (!state.running) return;

  const creds = await loadCredentials();
  if (!creds?.apiKey) {
    addLog(state, 'ERROR', 'API 키 없음. 설정 탭에서 입력하세요.');
    await saveBotState(state);
    onUpdate({ ...state });
    return;
  }

  if (!isPositionModeDetected()) {
    await detectPositionMode(creds);
  }

  const config = await loadConfig();
  state.lastTickAt = Date.now();

  // ── 일일 잔고 초기화 (날짜 변경 시 리셋) ──
  const todayStr = new Date().toISOString().slice(0, 10);
  const lastResetDate = state.dailyReportDate ?? '';
  if (lastResetDate !== todayStr) {
    // 새로운 날: 일일 데이터 리셋
    try {
      const bal = await getBalance(creds);
      state.dailyStartBalance = bal.totalBalance > 0 ? bal.totalBalance : bal.availableBalance;
      state.dailyPnl = 0;
      state.dailyPnlPct = 0;
      state.conservativeMode = false;
      state.dailyReportDate = todayStr;
      const startBal = state.dailyStartBalance ?? 0;
      addLog(state, 'INFO',
        `[일일 리셋] ${todayStr} | 시작 잔고: ${startBal.toFixed(2)} USDT | 목표: +30%`);
    } catch { /* 잔고 조회 실패 시 스킵 */ }
  }

  try {
    // 0. 시장 컨텍스트 갱신 (5분마다)
    const MARKET_CTX_INTERVAL = 5 * 60 * 1000;
    const lastCtxAt = state.lastMarketContextAt ?? 0;
    let marketCtx: MarketContext | null = getCachedMarketContext();
    if (Date.now() - lastCtxAt >= MARKET_CTX_INTERVAL || !marketCtx) {
      try {
        marketCtx = await getMarketContext();
        state.lastMarketContextAt = Date.now();
        state.marketPhase = marketCtx.phase;
        state.marketContextSummary = marketCtx.summary;
        state.marketStrategyReason = marketCtx.surgeStrategy.reason;
        // 실시간 뉴스 감지
        const urgentNews = await detectUrgentNewsEvents();
        state.urgentNewsCount = urgentNews.length;
        if (urgentNews.length > 0) {
          const newsLog = urgentNews.slice(0, 3).map((n: NewsEvent) => `[${n.impactScore}] ${n.title}`).join(' | ');
          addLog(state, 'WARN', `⚠️ 긴급뉴스 ${urgentNews.length}건: ${newsLog}`);
        }
        addLog(state, 'INFO',
          `[시장상황] ${marketCtx.phase} | BTC ${marketCtx.btc.change1h >= 0 ? '+' : ''}${marketCtx.btc.change1h.toFixed(2)}%/1h | ETH ${marketCtx.eth.change1h >= 0 ? '+' : ''}${marketCtx.eth.change1h.toFixed(2)}%/1h | 전략: ${marketCtx.surgeStrategy.reason}`);
      } catch { /* 시장 컨텍스트 실패 시 무시 */ }
    }

    // 시장 위험 신호: RISK_OFF 또는 긴급뉴스 3건+ 시 자동진입 일시 중단
    const isMarketDangerous = marketCtx?.phase === 'RISK_OFF' || (state.urgentNewsCount ?? 0) >= 3;
    if (isMarketDangerous && state.autoEntry !== false) {
      addLog(state, 'WARN',
        `[시장위험] ${marketCtx?.phase ?? 'RISK_OFF'} 국면 / 긴급뉴스 ${state.urgentNewsCount ?? 0}건 → 신규진입 일시 중단 (기존 포지션 유지)`);
    }

    // ── BTC 급락 차단 (btcDropGuard) ──
    // BTC가 설정한 임계값 이상 하락 시 신규 진입 중단
    let isBtcDropBlocked = false;
    if (config.btcDropGuard !== false) {
      const btcThreshold = -(config.btcDropThresholdPct ?? 3);
      const btcChange1h = marketCtx?.btc?.change1h ?? 0;
      if (btcChange1h <= btcThreshold) {
        isBtcDropBlocked = true;
        addLog(state, 'WARN',
          `[BTC급락차단] BTC 1h ${btcChange1h.toFixed(2)}% (${btcThreshold}% 이하) → 신규 진입 중단`);
      }
    }

    // ── 4가지 전략 조합: 시간대 + 변동성 + 모멘텀 + 손익비 ──
    const btcChange24hVal = marketCtx?.btc?.change24h ?? 0;
    const stratCtx: StrategyContext = buildStrategyContext(
      btcChange24hVal,
      config.entryConfidenceMin ?? 80,
    );

    // 세션 기반 신규 진입 허용 여부 (저유동성 구간 차단)
    const allowEntryBySession = stratCtx.allowNewEntry;
    if (!allowEntryBySession) {
      addLog(state, 'INFO',
        `[세션차단] ${stratCtx.sessionLabel} — 저유동성 구간 신규 진입 중단 (기존 포지션 관리만)`);
    }

    // 상태에 전략 컨텍스트 저장 (UI 표시용)
    state.currentSession = stratCtx.sessionLabel;
    state.currentVolatility = stratCtx.volatilityLabel;
    state.currentVolatilityLevel = stratCtx.volatility.level;
    state.effectiveConfidenceMin = stratCtx.effectiveConfidenceMin;
    state.effectivePosMultiplier = stratCtx.effectivePosMultiplier;
    state.allowNewEntryBySession = allowEntryBySession;

    // 1. 직접매매 감지 + Bybit 보유 심볼 수집
    const liveBybitSymbols = await detectManualTrades(creds, state);

    // 2. 포지션 실시간 업데이트
    const closed = await refreshPositions(creds, state);

    // 3. MMR 위험 관리
    await manageMmrRisk(creds, state);

    // 4. 포지션 관리 (손절 50%/100% / 익절 50%+10% 단위)
    await managePositions(creds, state, config);

    // 5. 스캘핑 분석 (2분 주기)
    const now = Date.now();
    if (now - _lastSignalFetchAt >= SIGNAL_REFRESH_INTERVAL || _cachedSignals.length === 0) {
      // 일반봇 ON 시 일반 신호 갱신
      if (state.normalRunning) {
        addLog(state, 'INFO', '[일반봇] TOP7 스캘핑 분석 중 (신뢰도 85%+)...');
        _cachedSignals = await getTopScalpingSignals();
        addLog(state, 'INFO', `[일반봇] 분석 완료 | ${_cachedSignals.length}개`);
      }
      // 급등봇 ON 시 급등 신호 갱신
      if (state.surgeRunning) {
        addLog(state, 'INFO', '[급등봇] 급등락+급등직전 분석 중...');
        const [surgeSignals, preSurgeSignals] = await Promise.all([
          getSurgeDropTop7(),
          getPreSurgeTop10(),
        ]);
        _cachedSurgeSignals = [
          ...surgeSignals.map(s => ({ ...s, _sectionType: 'surge' as SectionType })),
          ...preSurgeSignals.map(s => ({ ...s, _sectionType: 'presurge' as SectionType })),
        ];
        addLog(state, 'INFO', `[급등봇] 분석 완료 | 급등락 ${surgeSignals.length}개 + 급등직전 ${preSurgeSignals.length}개`);
      }
      _lastSignalFetchAt = now;
    }

    // 6. 블랙리스트 + Bybit 보유 종목 필터링 + 상관관계 필터
    const manualList = await loadManualBlacklist();
    const excludeList = await loadBotExcludeList(); // 사용자 영구 제외 목록
    const excludeSet = new Set(excludeList);
    const now2 = Date.now();

    // 상관관계 필터 (고급 전략 2): 보유 포지션과 동일 방향 중 유사 종목 제외
    // 20슬롯 기준: 동일 방향 알트코인 최대 8개 제한 (BTC/ETH/BNB 제외)
    // 롱/숏 균형 유지: 한쪽 방향이 전체의 70% 초과 시 신규 진입 제한
    const longCount = state.positions.filter(p => p.side === 'Buy').length;
    const shortCount = state.positions.filter(p => p.side === 'Sell').length;
    const totalCount = state.positions.length;
    const MAJOR_COINS = new Set(['BTCUSDT', 'ETHUSDT', 'BNBUSDT']);
    // 한쪽 방향이 전체의 70% 초과 시 해당 방향 신규 진입 제한 (포트폴리오 균형)
    const longRatio = totalCount > 0 ? longCount / totalCount : 0;
    const shortRatio = totalCount > 0 ? shortCount / totalCount : 0;

    const filteredSignals = _cachedSignals.filter(s => {
      // Bybit 직접 보유 종목 제외 (포지션 있으면 무조건 차단)
      if (liveBybitSymbols.has(s.bybitSymbol)) return false;
      // 봇 보유 종목 제외 (포지션 있으면 무조건 차단)
      if (state.positions.some(p => p.bybitSymbol === s.bybitSymbol)) return false;

      // 사용자 영구 제외 목록 — 절대 거래 중지 (어떤 조건에서도 진입 불가)
      if (excludeSet.has(s.bybitSymbol)) return false;

      // 직접매매 블랙리스트 제외
      if (manualList[s.bybitSymbol] && now2 - manualList[s.bybitSymbol] < MANUAL_COOLDOWN_MS) return false;
      // 상관관계 필터: 대형코인 제외, 동일 방향 알트코인 8개 초과 시 제한
      if (!MAJOR_COINS.has(s.bybitSymbol)) {
        if (s.direction === 'LONG' && longCount >= 8) return false;
        if (s.direction === 'SHORT' && shortCount >= 8) return false;
      }
      // 포트폴리오 균형 필터: 한쪽 방향이 70% 초과 시 해당 방향 제한 (총 4개 이상 보유 시)
      if (totalCount >= 4) {
        if (s.direction === 'LONG' && longRatio > 0.7) return false;
        if (s.direction === 'SHORT' && shortRatio > 0.7) return false;
      }
      return true;
    });

    const usedSymbols = new Set(state.positions.map(p => p.bybitSymbol));

    // ── 보수 모드 적용 (30% 목표 달성 후) ──
    const isConservative = state.conservativeMode === true;
    const effectiveMaxPositions = isConservative ? 5 : config.maxPositions; // 보수 모드: 최대 5개
    const effectiveMinConfidence = isConservative ? 90 : 80;

    if (isConservative) {
      addLog(state, 'INFO',
        `[보수 모드] 일일 ${(state.dailyPnlPct ?? 0).toFixed(1)}% 달성 | 신뢰도 90%+ 전용, 최대 5개`);
    }

    // ── 자동 신규진입 ON/OFF 체크 ──
    if (state.autoEntry === false) {
      addLog(state, 'INFO', '[자동진입 OFF] 신규 진입 건너끄 — 기존 포지션 관리만 진행');
    } else if (isBtcDropBlocked || isMarketDangerous) {
      // BTC 급락 또는 시장위험 시 신규 진입 전면 중단
      addLog(state, 'WARN', `[진입차단] BTC급락=${isBtcDropBlocked} / 시장위험=${isMarketDangerous} → 신규 진입 전면 중단`);
    } else if (!allowEntryBySession) {
      // 세션 차단 (저유동성 구간)
      addLog(state, 'INFO', `[세션차단] ${stratCtx.sessionLabel} → 신규 진입 중단`);
    } else {
      // ── 4가지 전략 조합 적용 진입 로직 ──
      // 활성 신뢰도 기준: 세션+변동성 조정된 stratCtx.effectiveConfidenceMin 사용
      const minConf = isConservative ? 90 : stratCtx.effectiveConfidenceMin;

      // 신뢰도 95% 이상 우선 진입 (슬롯 초과여도 진입 — 기존 규칙 유지)
      const highConf = filteredSignals.filter(s => s.confidence >= 95 && !usedSymbols.has(s.bybitSymbol));
      for (const sig of highConf) {
        await enterPosition(creds, sig, state, config, true, liveBybitSymbols);
        usedSymbols.add(sig.bybitSymbol);
      }

      // 일반 진입: 슬롯 여유 + 신뢰도 + 모멘텀 스코어 필터
      const currentSlots = effectiveMaxPositions - state.positions.length;
      if (currentSlots > 0) {
        // 모멘텀 스코어 필터 + 신뢰도 기준 적용
        const normal = filteredSignals.filter(s => {
          if (s.confidence < minConf || s.confidence >= 95) return false;
          if (usedSymbols.has(s.bybitSymbol)) return false;
          // 모멘텀 스코어 계산 (D등급 제외)
          const momentumInput = extractMomentumInput(s);
          const momentumScore = calcMomentumScore(momentumInput);
          if (momentumScore.grade === 'D') return false; // 모멘텀 미흡 제외
          return true;
        });

        // 모멘텀 스코어 내림차순 정렬 (S > A > B > C)
        const sortedByMomentum = normal.sort((a, b) => {
          const scoreA = calcMomentumScore(extractMomentumInput(a)).total;
          const scoreB = calcMomentumScore(extractMomentumInput(b)).total;
          return scoreB - scoreA;
        });

        for (const sig of sortedByMomentum.slice(0, currentSlots)) {
          // 변동성 배율 적용: config에 positionSizePct 임시 수정
          const volAdjustedConfig: BotConfig = {
            ...config,
            positionSizePct: Math.max(0.5, Math.min(4,
              (config.positionSizePct ?? 2) * stratCtx.effectivePosMultiplier
            )),
          };
          await enterPosition(creds, sig, state, volAdjustedConfig, false, liveBybitSymbols);
          usedSymbols.add(sig.bybitSymbol);
        }

        if (sortedByMomentum.length > 0) {
          addLog(state, 'INFO',
            `[전략] ${stratCtx.sessionLabel} | ${stratCtx.volatilityLabel} | 신뢰도 ${minConf}%+ | 포지션 배율 ${stratCtx.effectivePosMultiplier.toFixed(1)}x`);
        }
      }
    }

    addLog(state, 'INFO',
      `틱 완료 | 활성 ${state.positions.length}개 | 청산 ${closed.length}개 | 오늘 ${(state.dailyPnlPct ?? 0).toFixed(1)}% (${isConservative ? '보수' : '일반'} 모드)`);
  } catch (e) {
    addLog(state, 'ERROR', `틱 오류: ${e instanceof Error ? e.message : String(e)}`);
  }

  await saveBotState(state);
  onUpdate({ ...state });
}

// ─── 봇 시작 ─────────────────────────────────────────────────────────────────

export async function startBot(onUpdate: (state: BotState) => void): Promise<void> {
  const state = await loadBotState();
  if (state.running) return;

  const creds = await loadCredentials();
  if (!creds?.apiKey) {
    addLog(state, 'ERROR', 'API 키 없음. 설정 탭에서 입력하세요.');
    await saveBotState(state);
    onUpdate({ ...state });
    return;
  }

  state.running = true;
  state.positions = [];
  addLog(state, 'INFO', '봇 시작 — 초기화 중...');
  await saveBotState(state);
  onUpdate({ ...state });

  await detectPositionMode(creds);

  try {
    const cancelled = await cancelAllOpenOrders(creds);
    if (cancelled > 0) {
      addLog(state, 'INFO', `미체결 주문 ${cancelled}개 취소 완료`);
    }
  } catch (e) {
    addLog(state, 'WARN', `미체결 취소 오류: ${e instanceof Error ? e.message : String(e)}`);
  }

  addLog(state, 'INFO', 'TOP 7 추천 종목 분석 중 (신뢰도 85%+, Bybit 상장 종목만)...');
  await saveBotState(state);
  onUpdate({ ...state });

  const config = await loadConfig();

  // Bybit 실시간 보유 포지션 자동 등록
  const liveBybitSymbols = await detectManualTrades(creds, state);
  if (liveBybitSymbols.size > 0) {
    addLog(state, 'INFO', `Bybit 보유 종목 ${liveBybitSymbols.size}개 자동 등록 완료`);
    await saveBotState(state);
    onUpdate({ ...state });
  }

  try {
    const signals = await getTopScalpingSignals();
    addLog(state, 'INFO', `신뢰도 85%+ 종목 ${signals.length}개 확인`);
    onUpdate({ ...state });

    // Bybit 보유 종목 + 제외 목록 필터링
    const startExcludeList = await loadBotExcludeList();
    const startExcludeSet = new Set(startExcludeList);
    const filteredSignals = signals.filter(s =>
      !liveBybitSymbols.has(s.bybitSymbol) &&
      !startExcludeSet.has(s.bybitSymbol) // 제외 목록 절대 거래 중지
    );

    const usedSymbols = new Set<string>();

    const highConf = filteredSignals.filter(s => s.confidence >= 95);
    for (const sig of highConf) {
      await enterPosition(creds, sig, state, config, true, liveBybitSymbols);
      usedSymbols.add(sig.bybitSymbol);
      onUpdate({ ...state });
    }

    const remaining = filteredSignals.filter(s => s.confidence < 95 && !usedSymbols.has(s.bybitSymbol));
    const slots = config.maxPositions - state.positions.length;
    for (const sig of remaining.slice(0, Math.max(0, slots))) {
      await enterPosition(creds, sig, state, config, false, liveBybitSymbols);
      onUpdate({ ...state });
    }

    addLog(state, 'INFO', `봇 가동 | 활성 포지션 ${state.positions.length}개`);
  } catch (e) {
    addLog(state, 'ERROR', `시작 오류: ${e instanceof Error ? e.message : String(e)}`);
  }

  await saveBotState(state);
  onUpdate({ ...state });
}

// ─── 봇 정지 ─────────────────────────────────────────────────────────────────

export async function stopBot(onUpdate: (state: BotState) => void): Promise<void> {
  const state = await loadBotState();
  state.running = false;
  addLog(state, 'INFO', '봇 정지. 기존 포지션은 유지됩니다.');
  await saveBotState(state);
  onUpdate({ ...state });
}

// ─── 홈 화면에서 분석 결과를 봇에 수동 추가 ─────────────────────────────────────

/**
 * 홈 화면에서 직접 분석한 종목을 자동매매 봇에 추가합니다.
 * 자동매매와 완전히 동일한 규칙 적용:
 *  - 켈리 공식 포지션 사이징 (신뢰도별 상한: 95%+→4%, 90~94%→3%, 80~89%→2%)
 *  - ATR 동적 손절/익절
 *  - 슬롯 체크 (95%+ 신뢰도는 슬롯 초과 허용)
 *  - 중복 포지션 체크
 *  - Bybit 심볼 유효성 검증
 * @returns 성공 시 예상 수량/손절/익절 정보, 실패 시 오류 메시지
 */
export async function addToBotManually(
  signal: ScalpingSignal,
  sourceType?: SectionType,
): Promise<{ success: boolean; message: string; qty?: string; stopLoss?: number; takeProfit?: number; leverage?: number; notional?: number }> {
  const creds = await loadCredentials();
  if (!creds?.apiKey) {
    return { success: false, message: 'API 키가 설정되지 않았습니다. 설정 탭에서 입력하세요.' };
  }

  const state = await loadBotState();

  // 중복 포지션 체크
  const existingPos = state.positions.find(p => p.bybitSymbol === signal.bybitSymbol);
  if (existingPos) {
    const dir = existingPos.side === 'Buy' ? '롱' : '숏';
    return { success: false, message: `${signal.displaySymbol}은(는) 이미 봇에서 ${dir} 포지션 보유 중입니다.` };
  }

  // 수동 추가 시 제외 목록에서 자동 제거 (사용자가 명시적으로 선택했으므로 제외 해제)
  const excludeListNow = await loadBotExcludeList();
  if (excludeListNow.includes(signal.bybitSymbol)) {
    await saveBotExcludeList(excludeListNow.filter(s => s !== signal.bybitSymbol));
  }

  // 슬롯 체크 (95%+ 신뢰도는 슬롯 초과 허용)
  const config = await loadConfig();
  const forceEntry = signal.confidence >= 95;
  if (!forceEntry && state.positions.length >= config.maxPositions) {
    return { success: false, message: `슬롯이 가득 찼습니다 (${state.positions.length}/${config.maxPositions}). 신뢰도 95%+ 종목만 추가 가능합니다.` };
  }

  // Bybit 심볼 유효성 검증
  const valid = await isSymbolValid(signal.bybitSymbol, creds.isTestnet);
  if (!valid) {
    return { success: false, message: `${signal.displaySymbol} (${signal.bybitSymbol})은(는) Bybit 미상장 종목입니다.` };
  }

  // 포지션 모드 감지 (필요 시)
  if (!isPositionModeDetected()) {
    await detectPositionMode(creds);
  }

  try {
    const balance = await getBalance(creds);
    const meta = await getSymbolMeta(signal.bybitSymbol, creds.isTestnet);

    // ── 자동매매와 동일한 포지션 사이징 (켈리 공식 + 신뢰도별 상한) ──
    const kellyFraction = signal.kellyFraction ?? 0;
    const conf = signal.confidence;
    const maxSizePct = conf >= 95 ? 4 : conf >= 90 ? 3 : 2;
    const kellyPct = kellyFraction > 0
      ? Math.min(kellyFraction * 100, maxSizePct)
      : Math.min(creds.positionSizePct, maxSizePct);

    const qty = calcQty(
      balance.availableBalance,
      kellyPct,
      signal.entryPrice,
      meta.maxLeverage,
      meta.minOrderQty,
      meta.qtyStep,
      meta.qtyPrecision,
    );

    if (qty === null) {
      return { success: false, message: `1개 단위 가격(${signal.entryPrice.toFixed(2)} USDT)이 가용잔고 3%를 초과합니다. 이 종목은 잔고가 더 충분할 때 진입 가능합니다.` };
    }

    const notional = safeFloat(qty) * signal.entryPrice;
    if (notional < meta.minNotionalValue) {
      return { success: false, message: `주문 금액 부족 (${notional.toFixed(2)} USDT < 최소 ${meta.minNotionalValue} USDT). 잔고를 확인하세요.` };
    }

    const side: 'Buy' | 'Sell' = signal.direction === 'LONG' ? 'Buy' : 'Sell';

    // ── ATR 동적 손절 (자동매매와 동일) ──
    const atrSL = signal.atr && signal.atr > 0
      ? signal.atr * 1.5
      : (signal.entryPrice / meta.maxLeverage) * 0.55;
    const tpDist = atrSL * 2.0;
    const stopLoss = side === 'Buy' ? signal.entryPrice - atrSL : signal.entryPrice + atrSL;
    const takeProfit = side === 'Buy' ? signal.entryPrice + tpDist : signal.entryPrice - tpDist;

    // 실제 주문 실행
    await placeOrder(creds, signal.bybitSymbol, side, qty, meta.maxLeverage, stopLoss.toString(), takeProfit.toString());

    // 봇 상태에 포지션 등록
    state.positions.push({
      symbol: signal.symbol,
      bybitSymbol: signal.bybitSymbol,
      displaySymbol: signal.displaySymbol,
      side,
      entryPrice: signal.entryPrice,
      avgPrice: signal.entryPrice,
      size: qty,
      leverage: meta.maxLeverage,
      stopLoss,
      takeProfit,
      addCount: 0,
      openedAt: Date.now(),
      markPrice: signal.entryPrice,
      liqPrice: 0,
      unrealisedPnl: 0,
      pnlPct: 0,
      filled: true,
      lastAnalyzedPnlPct: undefined,
      forceEntry,
      confidence: signal.confidence,
      kellyFraction: signal.kellyFraction,
      nextActionPct: 30,
      sourceType: sourceType ?? 'top7',
      // 분석 결과 즉시 저장
      liveSignalDirection: signal.direction,
      liveSignalConfidence: signal.confidence,
      liveSignalReason: signal.reason,
      liveSignalRsi: signal.rsi,
      liveSignalAdx: signal.adx,
      liveSignalUpdatedAt: Date.now(),
      lastLiveAnalysisAt: Date.now(),
      liveAnalysisCount: 1,
    });

    const label = forceEntry ? '[수동강제진입 95%+]' : '[수동진입]';
    addLog(state, 'TRADE',
      `${label} ${signal.displaySymbol} ${side === 'Buy' ? '롱' : '숏'} | ${qty} | ${meta.maxLeverage}x | 신뢰도 ${signal.confidence}% | 켈리 ${kellyPct.toFixed(1)}% | 손절 ${stopLoss.toFixed(meta.pricePrecision)} | 익절 ${takeProfit.toFixed(meta.pricePrecision)}`);

    await saveBotState(state);

    return {
      success: true,
      message: `${signal.displaySymbol} ${side === 'Buy' ? '롱' : '숏'} 진입 완료! (${meta.maxLeverage}x, 신뢰도 ${signal.confidence}%)`,
      qty,
      stopLoss,
      takeProfit,
      leverage: meta.maxLeverage,
      notional,
    };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    // 10001 오류 시 포지션 모드 재감지
    if (errMsg.includes('10001')) {
      resetPositionModeDetection();
    }
    return { success: false, message: `진입 실패: ${errMsg}` };
  }
}

/**
 * 홈 화면에서 분석 결과의 예상 진입 정보를 미리 계산합니다 (실제 주문 없음).
 * 확인 모달에서 수량/손절/익절을 표시하기 위해 사용합니다.
 */
export async function previewBotEntry(
  signal: ScalpingSignal,
): Promise<{ qty: string; stopLoss: number; takeProfit: number; leverage: number; notional: number; kellyPct: number; error?: string } | null> {
  try {
    const creds = await loadCredentials();
    if (!creds?.apiKey) return null;
    const balance = await getBalance(creds);
    const meta = await getSymbolMeta(signal.bybitSymbol, creds.isTestnet);

    const kellyFraction = signal.kellyFraction ?? 0;
    const conf = signal.confidence;
    const maxSizePct = conf >= 95 ? 4 : conf >= 90 ? 3 : 2;
    const kellyPct = kellyFraction > 0
      ? Math.min(kellyFraction * 100, maxSizePct)
      : Math.min(creds.positionSizePct, maxSizePct);

    const qty = calcQty(
      balance.availableBalance,
      kellyPct,
      signal.entryPrice,
      meta.maxLeverage,
      meta.minOrderQty,
      meta.qtyStep,
      meta.qtyPrecision,
    );
    if (qty === null) return null; // 1개 단위 가격 초과 → 미리보기 불가
    const notional = safeFloat(qty) * signal.entryPrice;
    const side: 'Buy' | 'Sell' = signal.direction === 'LONG' ? 'Buy' : 'Sell';
    const atrSL = signal.atr && signal.atr > 0
      ? signal.atr * 1.5
      : (signal.entryPrice / meta.maxLeverage) * 0.55;
    const tpDist = atrSL * 2.0;
    const stopLoss = side === 'Buy' ? signal.entryPrice - atrSL : signal.entryPrice + atrSL;
    const takeProfit = side === 'Buy' ? signal.entryPrice + tpDist : signal.entryPrice - tpDist;

    return { qty, stopLoss, takeProfit, leverage: meta.maxLeverage, notional, kellyPct };
  } catch {
    return null;
  }
}

// ─── 일일 보고서 생성 ─────────────────────────────────────────────────────────

/**
 * 특정 날짜의 매매기록을 기반으로 텍스트 보고서를 생성합니다.
 * @param date YYYY-MM-DD 형식 날짜 (미입력 시 오늘)
 * @returns 보고서 텍스트 문자열
 */
export async function generateDailyReport(date?: string): Promise<string> {
  const targetDate = date ?? new Date().toISOString().slice(0, 10);
  const history = await loadTradeHistory();
  const dayRecords = history.filter(r => r.date === targetDate);

  const lines: string[] = [];
  const sep = '═'.repeat(52);
  const thin = '─'.repeat(52);

  lines.push(sep);
  lines.push(`  📊 Bybit 스캘핑 봇 일일 매매 보고서`);
  lines.push(`  날짜: ${targetDate}`);
  lines.push(`  생성: ${new Date().toLocaleString('ko-KR')}`);
  lines.push(sep);

  if (dayRecords.length === 0) {
    lines.push('');
    lines.push('  해당 날짜의 매매기록이 없습니다.');
    lines.push('');
    lines.push(sep);
    return lines.join('\n');
  }

  // 통계 계산
  const totalPnlNet = dayRecords.reduce((s, r) => s + r.pnlNet, 0);
  const totalPnlGross = dayRecords.reduce((s, r) => s + r.pnl, 0);
  const totalFee = dayRecords.reduce((s, r) => s + r.fee, 0);
  const wins = dayRecords.filter(r => r.pnlNet >= 0);
  const losses = dayRecords.filter(r => r.pnlNet < 0);
  const winRate = (wins.length / dayRecords.length * 100).toFixed(1);
  const avgWin = wins.length > 0
    ? (wins.reduce((s, r) => s + r.pnlPct, 0) / wins.length).toFixed(2)
    : '0.00';
  const avgLoss = losses.length > 0
    ? (losses.reduce((s, r) => s + r.pnlPct, 0) / losses.length).toFixed(2)
    : '0.00';
  const bestTrade = dayRecords.reduce((best, r) => r.pnlNet > best.pnlNet ? r : best, dayRecords[0]);
  const worstTrade = dayRecords.reduce((worst, r) => r.pnlNet < worst.pnlNet ? r : worst, dayRecords[0]);
  const profitFactor = losses.length > 0 && Math.abs(losses.reduce((s, r) => s + r.pnlNet, 0)) > 0
    ? (wins.reduce((s, r) => s + r.pnlNet, 0) / Math.abs(losses.reduce((s, r) => s + r.pnlNet, 0))).toFixed(2)
    : 'N/A';

  lines.push('');
  lines.push('  ▶ 종합 성과');
  lines.push(thin);
  lines.push(`  총 매매 건수   : ${dayRecords.length}건 (승 ${wins.length} / 패 ${losses.length})`);
  lines.push(`  승률           : ${winRate}%`);
  lines.push(`  순 수익 (수수료 포함) : ${totalPnlNet >= 0 ? '+' : ''}${totalPnlNet.toFixed(4)} USDT`);
  lines.push(`  총 수익 (수수료 전)  : ${totalPnlGross >= 0 ? '+' : ''}${totalPnlGross.toFixed(4)} USDT`);
  lines.push(`  총 수수료      : -${totalFee.toFixed(4)} USDT`);
  lines.push(`  평균 수익 거래  : +${avgWin}%`);
  lines.push(`  평균 손실 거래  : ${avgLoss}%`);
  lines.push(`  수익 팩터      : ${profitFactor}`);
  lines.push('');

  lines.push('  ▶ 주요 거래');
  lines.push(thin);
  lines.push(`  최고 수익: ${bestTrade.symbol} ${bestTrade.direction} ${bestTrade.leverage}x`);
  lines.push(`    → ${bestTrade.pnlNet >= 0 ? '+' : ''}${bestTrade.pnlNet.toFixed(4)} USDT (${bestTrade.pnlPct >= 0 ? '+' : ''}${bestTrade.pnlPct.toFixed(2)}%)`);
  lines.push(`  최대 손실: ${worstTrade.symbol} ${worstTrade.direction} ${worstTrade.leverage}x`);
  lines.push(`    → ${worstTrade.pnlNet >= 0 ? '+' : ''}${worstTrade.pnlNet.toFixed(4)} USDT (${worstTrade.pnlPct >= 0 ? '+' : ''}${worstTrade.pnlPct.toFixed(2)}%)`);
  lines.push('');

  lines.push('  ▶ 매매 상세 기록');
  lines.push(thin);

  for (const r of dayRecords) {
    const time = new Date(r.closedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    const dir = r.direction === 'LONG' ? '▲롱' : '▼숏';
    const pnlSign = r.pnlNet >= 0 ? '+' : '';
    lines.push(`  ${time} | ${r.symbol.padEnd(10)} ${dir} ${String(r.leverage).padStart(3)}x`);
    lines.push(`         매입가: ${r.entryPrice.toFixed(4)}  정산가: ${r.closePrice.toFixed(4)}`);
    lines.push(`         수수료: -${r.fee.toFixed(4)} USDT | 순이익(수수료제외): ${pnlSign}${r.pnlNet.toFixed(4)} USDT (${pnlSign}${r.pnlPct.toFixed(2)}%)`);
  }

  lines.push('');
  lines.push(sep);
  lines.push(`  ※ 본 보고서는 Bybit 스캘핑 봇 자동 생성 문서입니다.`);
  lines.push(`  ※ 실제 Bybit 계정 수익과 소수점 차이가 있을 수 있습니다.`);
  lines.push(sep);

  return lines.join('\n');
}

/**
 * 전체 기간 매매기록 보고서를 생성합니다.
 */
export async function generateFullReport(): Promise<string> {
  const history = await loadTradeHistory();
  if (history.length === 0) {
    return '매매기록이 없습니다.';
  }

  // 날짜별 그룹화
  const grouped: Record<string, TradeRecord[]> = {};
  for (const r of history) {
    if (!grouped[r.date]) grouped[r.date] = [];
    grouped[r.date].push(r);
  }
  const dates = Object.keys(grouped).sort((a, b) => b.localeCompare(a));

  const lines: string[] = [];
  const sep = '═'.repeat(52);

  lines.push(sep);
  lines.push(`  📊 Bybit 스캘핑 봇 전체 매매 보고서`);
  lines.push(`  기간: ${dates[dates.length - 1]} ~ ${dates[0]}`);
  lines.push(`  생성: ${new Date().toLocaleString('ko-KR')}`);
  lines.push(sep);

  const totalPnlNet = history.reduce((s, r) => s + r.pnlNet, 0);
  const totalFee = history.reduce((s, r) => s + r.fee, 0);
  const wins = history.filter(r => r.pnlNet >= 0);
  const winRate = (wins.length / history.length * 100).toFixed(1);

  lines.push('');
  lines.push('  ▶ 전체 종합 성과');
  lines.push('─'.repeat(52));
  lines.push(`  총 매매 건수   : ${history.length}건 (승 ${wins.length} / 패 ${history.length - wins.length})`);
  lines.push(`  전체 승률      : ${winRate}%`);
  lines.push(`  전체 순 수익   : ${totalPnlNet >= 0 ? '+' : ''}${totalPnlNet.toFixed(4)} USDT`);
  lines.push(`  전체 수수료    : -${totalFee.toFixed(4)} USDT`);
  lines.push('');

  // 날짜별 요약
  lines.push('  ▶ 날짜별 요약');
  lines.push('─'.repeat(52));
  for (const date of dates) {
    const recs = grouped[date];
    const dayPnl = recs.reduce((s, r) => s + r.pnlNet, 0);
    const dayWins = recs.filter(r => r.pnlNet >= 0).length;
    const dayWr = (dayWins / recs.length * 100).toFixed(0);
    const sign = dayPnl >= 0 ? '+' : '';
    lines.push(`  ${date}  ${String(recs.length).padStart(3)}건  승률${dayWr}%  ${sign}${dayPnl.toFixed(4)} USDT`);
  }

  lines.push('');
  lines.push(sep);

  return lines.join('\n');
}

// ─── 포지션 급등락 전략 전환 ─────────────────────────────────────────────────

/**
 * 기존 봇 포지션을 급등락(surge) 전략으로 전환합니다.
 *
 * 전환 시 적용되는 규칙:
 *  - sourceType → 'surge'
 *  - 손절 임계값: -15% (일반 -30% 대신)
 *  - 익절 임계값: +20% (일반 +30% 대신)
 *  - 방향전환 40%+ 수익 시 즉시 청산
 *  - nextActionPct: 15 (첫 분석 기준 15%)
 *
 * @param bybitSymbol 전환할 포지션의 Bybit 심볼 (예: BTCUSDT)
 * @returns 성공 여부 및 메시지
 */
export async function convertPositionToSurge(
  bybitSymbol: string,
): Promise<{ success: boolean; message: string }> {
  try {
    const state = await loadBotState();
    const pos = state.positions.find(p => p.bybitSymbol === bybitSymbol);
    if (!pos) {
      return { success: false, message: '해당 포지션을 찾을 수 없습니다.' };
    }
    if (pos.sourceType === 'surge') {
      return { success: false, message: '이미 급등락 전략으로 운영 중입니다.' };
    }

    const prevType = pos.sourceType ?? 'top7';
    pos.sourceType = 'surge';
    // 급등락 전략: 손절 기준 15%, 익절 기준 20%로 재설정
    pos.nextActionPct = 15;
    // stopLoss/takeProfit은 기존 값 유지 (ATR 기반이므로 그대로 사용)
    // 단, lastAnalyzedPnlPct 리셋하여 새 기준으로 재분석 시작
    pos.lastAnalyzedPnlPct = undefined;

    addLog(state, 'INFO',
      `[급등락 전환] ${pos.displaySymbol} | ${prevType} → surge | 손절 -15% / 익절 +20% / 방향전환 40%+ 즉시청산 적용`);

    await saveBotState(state);
    return {
      success: true,
      message: `${pos.displaySymbol} 급등락 전략 전환 완료!\n손절 -15% · 익절 +20% · 방향전환 40%+ 즉시청산`,
    };
  } catch (e) {
    return { success: false, message: `전환 실패: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ─── 일반봇 독립 시작/중지 ────────────────────────────────────────────────────

export async function startNormalBot(onUpdate: (state: BotState) => void): Promise<void> {
  const state = await loadBotState();
  if (state.normalRunning) return;

  const creds = await loadCredentials();
  if (!creds?.apiKey) {
    addLog(state, 'ERROR', 'API 키 없음. 설정 탭에서 입력하세요.');
    await saveBotState(state);
    onUpdate({ ...state });
    return;
  }

  state.normalRunning = true;
  state.running = true; // 전체 틱도 활성화
  addLog(state, 'INFO', '[일반봇] 시작 — TOP7 스캘핑 분석 중...');
  await saveBotState(state);
  onUpdate({ ...state });

  await detectPositionMode(creds);

  try {
    const cancelled = await cancelAllOpenOrders(creds);
    if (cancelled > 0) addLog(state, 'INFO', `미체결 주문 ${cancelled}개 취소 완료`);
  } catch (e) {
    addLog(state, 'WARN', `미체결 취소 오류: ${e instanceof Error ? e.message : String(e)}`);
  }

  const config = await loadConfig();
  const liveBybitSymbols = await detectManualTrades(creds, state);
  if (liveBybitSymbols.size > 0) {
    addLog(state, 'INFO', `Bybit 보유 종목 ${liveBybitSymbols.size}개 자동 등록 완료`);
  }

  try {
    const signals = await getTopScalpingSignals();
    addLog(state, 'INFO', `[일반봇] 신뢰도 85%+ 종목 ${signals.length}개 확인`);
    const normalExcludeList = await loadBotExcludeList();
    const normalExcludeSet = new Set(normalExcludeList);
    const filteredSignals = signals.filter(s =>
      !liveBybitSymbols.has(s.bybitSymbol) &&
      !normalExcludeSet.has(s.bybitSymbol) // 제외 목록 절대 거래 중지
    );
    const usedSymbols = new Set<string>();

    const highConf = filteredSignals.filter(s => s.confidence >= 95);
    for (const sig of highConf) {
      await enterPosition(creds, sig, state, config, true, liveBybitSymbols);
      usedSymbols.add(sig.bybitSymbol);
      onUpdate({ ...state });
    }
    const remaining = filteredSignals.filter(s => s.confidence < 95 && !usedSymbols.has(s.bybitSymbol));
    const slots = config.maxPositions - state.positions.length;
    for (const sig of remaining.slice(0, Math.max(0, slots))) {
      await enterPosition(creds, sig, state, config, false, liveBybitSymbols);
      onUpdate({ ...state });
    }
    addLog(state, 'INFO', `[일반봇] 가동 | 활성 포지션 ${state.positions.length}개`);
  } catch (e) {
    addLog(state, 'ERROR', `[일반봇] 시작 오류: ${e instanceof Error ? e.message : String(e)}`);
  }

  await saveBotState(state);
  onUpdate({ ...state });
}

export async function stopNormalBot(onUpdate: (state: BotState) => void): Promise<void> {
  const state = await loadBotState();
  state.normalRunning = false;
  // 급등봇도 꺼져 있으면 전체 틱 중지
  if (!state.surgeRunning) state.running = false;
  addLog(state, 'INFO', '[일반봇] 정지. 기존 포지션은 유지됩니다.');
  await saveBotState(state);
  onUpdate({ ...state });
}

// ─── 급등봇 독립 시작/중지 ────────────────────────────────────────────────────

export async function startSurgeBot(onUpdate: (state: BotState) => void): Promise<void> {
  const state = await loadBotState();
  if (state.surgeRunning) return;

  const creds = await loadCredentials();
  if (!creds?.apiKey) {
    addLog(state, 'ERROR', 'API 키 없음. 설정 탭에서 입력하세요.');
    await saveBotState(state);
    onUpdate({ ...state });
    return;
  }

  state.surgeRunning = true;
  state.running = true; // 전체 틱도 활성화
  addLog(state, 'INFO', '[급등봇] 시작 — 급등락+급등직전 분석 중...');
  await saveBotState(state);
  onUpdate({ ...state });

  await detectPositionMode(creds);

  const config = await loadConfig();
  const liveBybitSymbols = await detectManualTrades(creds, state);

  try {
    const [surgeSignals, preSurgeSignals] = await Promise.all([
      getSurgeDropTop7(),
      getPreSurgeTop10(),
    ]);
    const allSurgeSignals = [
      ...surgeSignals.map(s => ({ ...s, _sectionType: 'surge' as SectionType })),
      ...preSurgeSignals.map(s => ({ ...s, _sectionType: 'presurge' as SectionType })),
    ];
    _cachedSurgeSignals = allSurgeSignals;
    addLog(state, 'INFO', `[급등봇] 급등락 ${surgeSignals.length}개 + 급등직전 ${preSurgeSignals.length}개 확인`);

    const surgeExcludeList = await loadBotExcludeList();
    const surgeExcludeSet = new Set(surgeExcludeList);
    const filteredSurge = allSurgeSignals.filter(s =>
      !liveBybitSymbols.has(s.bybitSymbol) &&
      !state.positions.some(p => p.bybitSymbol === s.bybitSymbol) &&
      !surgeExcludeSet.has(s.bybitSymbol) // 제외 목록 절대 거래 중지
    );
    const usedSymbols = new Set<string>();
    const slots = config.maxPositions - state.positions.length;
    for (const sig of filteredSurge.slice(0, Math.max(0, slots))) {
      await enterPosition(creds, sig, state, config, sig.confidence >= 95, liveBybitSymbols);
      usedSymbols.add(sig.bybitSymbol);
      onUpdate({ ...state });
    }
    addLog(state, 'INFO', `[급등봇] 가동 | 활성 포지션 ${state.positions.length}개`);
  } catch (e) {
    addLog(state, 'ERROR', `[급등봇] 시작 오류: ${e instanceof Error ? e.message : String(e)}`);
  }

  await saveBotState(state);
  onUpdate({ ...state });
}

export async function stopSurgeBot(onUpdate: (state: BotState) => void): Promise<void> {
  const state = await loadBotState();
  state.surgeRunning = false;
  // 일반봇도 꺼져 있으면 전체 틱 중지
  if (!state.normalRunning) state.running = false;
  addLog(state, 'INFO', '[급등봇] 정지. 기존 포지션은 유지됩니다.');
  await saveBotState(state);
  onUpdate({ ...state });
}
