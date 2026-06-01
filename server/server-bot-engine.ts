/**
 * server-bot-engine.ts
 * 서버 사이드 자동매매 봇 엔진
 *
 * - Node.js 서버에서 실행 → 앱이 꺼져 있어도 24시간 자동매매
 * - 인메모리 상태 관리 (서버 재시작 시 초기화)
 * - 1분 setInterval 기반 봇 틱 루프
 * - 자격증명은 앱에서 서버로 전송하여 메모리에 보관
 */

import {
  getTopScalpingSignals,
  getSurgeDropTop7,
  getPreSurgeTop10,
  analyzeSymbolLive,
  type ScalpingSignal,
} from '../lib/scalping-engine';
import {
  getMarketContext,
  getCachedMarketContext,
  type MarketContext,
} from '../lib/market-context';
import {
  buildStrategyContext,
  calcMomentumScore,
  extractMomentumInput,
  type StrategyContext,
} from '../lib/market-strategy';
import { detectUrgentNewsEvents, type NewsEvent } from '../lib/surge-analyzer';
import {
  getMacroState,
  canEnterNewPosition,
  getShockSlPct,
  getMacroSummary,
  getUpcomingWarning,
  type MacroState,
} from '../lib/macro-news';
import {
  analyzeNewsForEntry,
  type NewsDirectionAnalysis,
} from '../lib/price-factor-engine';
import {
  getCurrentComboParams,
  getSessionProfile,
  getSessionSummary,
  getComboParams,
  getCurrentSession,
  type ComboParams,
} from '../lib/time-pattern';
import { notifyOwner } from './notification';
import {
  checkLiquidationSafety,
  calcSafeLeverage,
  calcPortfolioLiqRisk,
  calcCompoundingState,
  analyzeLossPattern,
  getConsecutiveLossLevel,
  applyStrategyAdjustments,
  calcSafeWithdrawal,
  calcStrategyStats,
  updateSignalAccuracy,
  adjustConfidenceByAccuracy,
  type TradeOutcome,
  type SignalAccuracy,
  type WithdrawalSafetyResult,
} from '../lib/strategy-optimizer';
import {
  detectPositionMode,
  isPositionModeDetected,
  resetPositionModeDetection,
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
  loadAllSymbolMeta,
  syncServerTime,
  type ApiCredentials,
  type PositionInfo,
} from '../lib/trading-service';

// ─── 타입 ────────────────────────────────────────────────────────────────────

export type SectionType = 'top7' | 'surge' | 'presurge';

export interface BotPosition {
  symbol: string;
  bybitSymbol: string;
  displaySymbol: string;
  side: 'Buy' | 'Sell';
  entryPrice: number;
  avgPrice: number;
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
  filled: boolean;
  lastAnalyzedPnlPct?: number;
  isReverse?: boolean;
  isExternal?: boolean;
  forceEntry?: boolean;
  confidence?: number;
  kellyFraction?: number;
  nextActionPct?: number;
  reverseCount?: number;
  tpHitCount?: number;
  partialTpCount?: number;
  initialMarginUsdt?: number;
  initialSize?: number;
  lastPartialTpPnlPct?: number;
  breakEvenActivated?: boolean;
  trailingActivated?: boolean;
  trailingHighPct?: number;
  trailingStopWidth?: number;
  lastLiveAnalysisAt?: number;
  liveSignalDirection?: string;
  liveSignalConfidence?: number;
  liveAnalysisCount?: number;
  liveSignalReason?: string;
  liveSignalRsi?: number;
  liveSignalAdx?: number;
  liveSignalTf15m?: string;
  liveSignalTf1h?: string;
  liveSignalUpdatedAt?: number;
  sourceType?: SectionType;
  pyramidCount?: number;
  lastPyramidPnlPct?: number;
  addCountStrict?: number;
  lastAddAt?: number;
  mtfConfirmed?: boolean;
}

export interface BotLog {
  time: number;
  level: 'INFO' | 'WARN' | 'ERROR' | 'TRADE';
  message: string;
}

export interface TradeRecord {
  id: string;
  date: string;
  symbol: string;
  side: 'Buy' | 'Sell';
  direction: 'LONG' | 'SHORT';
  avgPrice: number;
  entryPrice: number;
  closePrice: number;
  pnl: number;
  pnlNet: number;
  fee: number;
  pnlPct: number;
  leverage: number;
  closedAt: number;
  sourceType?: SectionType;
  holdingMinutes?: number;
}

export interface BotState {
  running: boolean;
  positions: BotPosition[];
  logs: BotLog[];
  lastTickAt: number;
  totalPnl: number;
  autoEntry: boolean;
  normalRunning: boolean;
  surgeRunning: boolean;
  presurgeRunning: boolean;
  dailyStartBalance?: number;
  dailyPnl?: number;
  dailyPnlPct?: number;
  conservativeMode?: boolean;
  dailyReportDate?: string;
  lastDailyReportSentDate?: string;
  dailyTradeCount?: number;
  dailyWinCount?: number;
  marketContextSummary?: string;
  marketPhase?: string;
  marketStrategyReason?: string;
  urgentNewsCount?: number;
  lastMarketContextAt?: number;
  currentSession?: string;
  currentVolatility?: string;
  currentVolatilityLevel?: string;
  effectiveConfidenceMin?: number;
  effectivePosMultiplier?: number;
  allowNewEntryBySession?: boolean;
  // ── 복리/성과 추적 ──
  baseBalance?: number;           // 봇 최초 시작 잔고 (복리 기준)
  compoundMultiplier?: number;    // 복리 배수
  totalPnlPctAll?: number;        // 전체 누적 수익률
  portfolioLiqRisk?: number;      // 포트폴리오 강제청산 위험도 (0~100)
  consecutiveLosses?: number;     // 연속 손실 횟수
  lossLevelMessage?: string;      // 연속 손실 경보 메시지
  autoAdjusted?: boolean;         // 전략 자동 조정 여부
  autoAdjustLog?: string[];       // 자동 조정 로그
  withdrawalSafety?: WithdrawalSafetyResult; // 안전 인출 정보
  // ── 24시간 최소 5% 수익 보장 ──
  dailyTargetPct: number;          // 일일 목표 수익률 (5%)
  dailyMode: 'AGGRESSIVE' | 'CONSERVATIVE' | 'SPRINT'; // 현재 운용 모드
  dailyModeReason?: string;        // 모드 전환 이유
  sprintActivatedAt?: number;      // 마감 스프린트 시작 시간
  dailyTargetAchievedAt?: number;  // 5% 달성 시각
  // ── 8대 요소 조합 점수 현황 ──
  lastComboScore?: number;         // 최신 조합 점수
  lastComboDirection?: string;     // 최신 조합 방향
  lastOptimalComboName?: string;   // 최적 조합명
}

export interface BotConfig {
  maxPositions: number;
  slThreshold: number;
  slStep: number;
  slForceThreshold: number;
  surgeLeverage?: number;
  defaultLeverage?: number;
  normalTakeProfitPct?: number;
  entryConfidenceMin?: number;
  positionSizePct?: number;
  trailingWidthNormal?: number;
  trailingWidthSurge?: number;
  trailingWidthPresurge?: number;
  btcDropGuard?: boolean;
  btcDropThresholdPct?: number;
  // ── 고급 전략 설정 ──
  fundingRateFilter?: boolean;         // 펀딩비 필터 (±0.1% 초과 시 해당 방향 차단)
  fundingRateThreshold?: number;       // 펀딩비 임계값 (기본 0.1)
  mtfStrictMode?: boolean;             // 다중 타임프레임 엄격 모드 (3개 모두 일치)
  dailyProfitTarget?: number;          // 일일 수익 목표 % (달성 시 보수 모드)
  dailyLossLimit?: number;             // 일일 손실 한도 % (달성 시 봇 자동 정지)
  nightSessionReduction?: boolean;     // 야간 세션 포지션 크기 축소
  nightSessionReductionPct?: number;   // 야간 포지션 축소 비율 (기본 50%)
  partialTpEnabled?: boolean;          // Partial TP 활성화 (일반봇 포함)
  partialTpTriggerMultiplier?: number; // Partial TP 트리거 배율 (기본 1.0)
  presurgeLeverage?: number;           // 급등직전봇 전용 레버리지
  presurgeMaxPositions?: number;       // 급등직전봇 최대 포지션 수
  autoReverseEnabled?: boolean;        // 청산 후 역방향 자동 재진입
}

// ─── 서버 인메모리 상태 ──────────────────────────────────────────────────────

const DEFAULT_CONFIG: BotConfig = {
  maxPositions: 10,
  slThreshold: 30,
  slStep: 10,
  slForceThreshold: 100,
  normalTakeProfitPct: 50,
  entryConfidenceMin: 80,
  positionSizePct: 2,
  trailingWidthNormal: 5,
  trailingWidthSurge: 5,
  trailingWidthPresurge: 8,
  btcDropGuard: true,
  btcDropThresholdPct: 3,
  // 고급 전략 기본값
  fundingRateFilter: true,
  fundingRateThreshold: 0.1,
  mtfStrictMode: false,
  dailyProfitTarget: 30,
  dailyLossLimit: 15,
  nightSessionReduction: true,
  nightSessionReductionPct: 50,
  partialTpEnabled: true,
  partialTpTriggerMultiplier: 1.0,
  presurgeLeverage: 5,
  presurgeMaxPositions: 5,
  autoReverseEnabled: true,
};

let _serverCreds: ApiCredentials | null = null;
let _serverConfig: BotConfig = { ...DEFAULT_CONFIG };
let _serverState: BotState = {
  running: false,
  normalRunning: false,
  surgeRunning: false,
  presurgeRunning: false,
  positions: [],
  logs: [],
  lastTickAt: 0,
  totalPnl: 0,
  autoEntry: true,
  // AI 검증 v44: 일일 목표 현실화
  // 5%/일은 연간 54억배 증가 → 헤지펀드도 불가능
  // 1.5% 안정 목표, 3% 적극 목표, 5% 최상 시나리오
  dailyTargetPct: 1.5,
  dailyMode: 'AGGRESSIVE',
  dailyModeReason: '일일 1.5% 목표 공격 모드',
};
let _tradeHistory: TradeRecord[] = [];
let _tradeOutcomes: TradeOutcome[] = [];  // strategy-optimizer 전용 성과 기록
let _signalAccuracyMap: Map<string, SignalAccuracy> = new Map();
let _excludeList: string[] = [];
let _manualBlacklist: Record<string, number> = {};

// 신호 캐시
const SIGNAL_REFRESH_INTERVAL = 2 * 60 * 1000;
let _lastSignalFetchAt = 0;
let _cachedSignals: ScalpingSignal[] = [];
let _cachedSurgeSignals: (ScalpingSignal & { _sectionType: SectionType })[] = [];
let _cachedPresurgeSignals: ScalpingSignal[] = [];

// 매크로 뉴스 + 시간대 조합 캐시
let _lastMacroState: MacroState | null = null;
let _lastMacroCheckAt = 0;
let _lastComboParams: ComboParams | null = null;
const MACRO_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5분마다 체크
// 긴급 뉴스 캐시 (Claude v47: 방향성 분석용)
let _lastUrgentNews: import('../lib/surge-analyzer').NewsEvent[] = [];

// 틱 루프 타이머
let _tickInterval: ReturnType<typeof setInterval> | null = null;
const BOT_TICK_INTERVAL_MS = 60 * 1000; // 1분
const MANUAL_COOLDOWN_MS = 30 * 60 * 1000;
const LIVE_ANALYSIS_INTERVAL_MS = 60 * 1000;

// ─── 자격증명 관리 ────────────────────────────────────────────────────────────

export function setServerCredentials(creds: ApiCredentials): void {
  _serverCreds = creds;
  console.log('[ServerBot] 자격증명 업데이트됨');
  // 서버 시간 동기화 (bybitRequest 서명 정확도 향상)
  syncServerTime(creds.isTestnet).catch(() => {});
}

export function getServerCredentials(): ApiCredentials | null {
  return _serverCreds;
}

export function clearServerCredentials(): void {
  _serverCreds = null;
}

// ─── 설정 관리 ───────────────────────────────────────────────────────────────

export function setServerConfig(config: Partial<BotConfig>): void {
  _serverConfig = { ...DEFAULT_CONFIG, ..._serverConfig, ...config };
}

export function getServerConfig(): BotConfig {
  return { ..._serverConfig };
}

// ─── 제외 목록 관리 ──────────────────────────────────────────────────────────

export function getServerExcludeList(): string[] {
  return [..._excludeList];
}

export function addToServerExcludeList(bybitSymbol: string): void {
  if (!_excludeList.includes(bybitSymbol)) {
    _excludeList.push(bybitSymbol);
  }
}

export function removeFromServerExcludeList(bybitSymbol: string): void {
  _excludeList = _excludeList.filter(s => s !== bybitSymbol);
}

// ─── 상태 조회 ───────────────────────────────────────────────────────────────

export function getServerBotState(): BotState {
  return { ..._serverState, positions: [..._serverState.positions] };
}

export function getServerTradeHistory(): TradeRecord[] {
  return [..._tradeHistory];
}

// ─── 로그 ────────────────────────────────────────────────────────────────────

function addLog(state: BotState, level: BotLog['level'], message: string): void {
  state.logs.unshift({ time: Date.now(), level, message });
  if (state.logs.length > 300) state.logs = state.logs.slice(0, 300);
  console.log(`[ServerBot][${level}] ${message}`);
}

// ─── 매매기록 저장 ────────────────────────────────────────────────────────────

function saveTradeRecord(record: TradeRecord): void {
  _tradeHistory.unshift(record);
  if (_tradeHistory.length > 500) _tradeHistory = _tradeHistory.slice(0, 500);

  // strategy-optimizer용 TradeOutcome 저장
  const outcome: TradeOutcome = {
    id: record.id,
    symbol: record.symbol,
    direction: record.direction,
    confidence: 80, // 기본값 (실제 신호 신뢰도는 pos에서 채움)
    leverage: record.leverage,
    sourceType: record.sourceType,
    entryPrice: record.entryPrice,
    closePrice: record.closePrice,
    pnlPct: record.pnlPct,
    holdingMinutes: record.holdingMinutes,
    timestamp: record.closedAt,
  };
  _tradeOutcomes.unshift(outcome);
  if (_tradeOutcomes.length > 200) _tradeOutcomes = _tradeOutcomes.slice(0, 200);

  // 신호 정확도 업데이트
  updateSignalAccuracy(_signalAccuracyMap, record.symbol, record.pnlPct > 0, record.pnlPct);

  // 연속 손실 감지 → 자동 전략 조정
  const recent = _tradeOutcomes.slice(0, 10);
  const analysis = analyzeLossPattern(recent, {
    entryConfidenceMin: _serverConfig.entryConfidenceMin ?? 80,
    positionSizePct: _serverConfig.positionSizePct ?? 2,
    defaultLeverage: _serverConfig.defaultLeverage ?? 10,
    stopLossPct: undefined,
  });
  _serverState.consecutiveLosses = analysis.consecutiveLosses;

  const lossLevel = getConsecutiveLossLevel(analysis.consecutiveLosses);
  if (lossLevel.level !== 'NORMAL') {
    _serverState.lossLevelMessage = lossLevel.message;
    // 자동 전략 조정 적용 (HIGH 우선순위만)
    if (lossLevel.level === 'WARNING' || lossLevel.level === 'DANGER') {
      const adjusted = applyStrategyAdjustments(_serverConfig, analysis, 'HIGH');
      if (adjusted._autoAdjusted) {
        _serverConfig = { ..._serverConfig, ...adjusted };
        _serverState.autoAdjusted = true;
        _serverState.autoAdjustLog = adjusted._adjustmentLog;
        for (const log of adjusted._adjustmentLog) {
          addLog(_serverState, 'WARN', log);
        }
      }
    }
  } else {
    _serverState.lossLevelMessage = undefined;
  }
}

// ─── 포지션 진입 ─────────────────────────────────────────────────────────────

async function enterPosition(
  creds: ApiCredentials,
  signal: ScalpingSignal,
  state: BotState,
  config: BotConfig,
  forceEntry = false,
  liveBybitSymbols?: Set<string>,
  sectionType?: SectionType,
): Promise<void> {
  const existingPos = state.positions.find(p => p.bybitSymbol === signal.bybitSymbol);
  if (existingPos) return;

  if (liveBybitSymbols && liveBybitSymbols.has(signal.bybitSymbol)) {
    addLog(state, 'INFO', `[스킵] ${signal.displaySymbol} — Bybit 직접 보유 중`);
    return;
  }

  if (!forceEntry && state.positions.length >= config.maxPositions) return;

  // ── 펀딩비 필터 ──
  if (!forceEntry && config.fundingRateFilter !== false) {
    const frThreshold = config.fundingRateThreshold ?? 0.1;
    const fr = signal.fundingRate ?? 0;
    const frPct = Math.abs(fr) * 100;
    if (frPct > frThreshold) {
      const frDir = fr > 0 ? 'LONG' : 'SHORT'; // 양수 펀딩비 = 롱 불리
      if (signal.direction === frDir) {
        addLog(state, 'INFO',
          `[펀딩비 차단] ${signal.displaySymbol} ${signal.direction} | 펀딩비 ${fr > 0 ? '+' : ''}${(fr * 100).toFixed(4)}% 초과 → 진입 취소`);
        return;
      }
    }
  }

  // ── MTF 엄격 모드 ──
  if (!forceEntry && config.mtfStrictMode) {
    const tf15m = signal.tf15m;
    const tf1h = signal.tf1h;
    const tf4h = signal.tf4h;
    const dir = signal.direction;
    const tfMatches = [tf15m, tf1h, tf4h].filter(tf => tf === dir).length;
    const tfTotal = [tf15m, tf1h, tf4h].filter(tf => tf && tf !== 'NEUTRAL').length;
    if (tfTotal >= 2 && tfMatches < tfTotal) {
      addLog(state, 'INFO',
        `[MTF 차단] ${signal.displaySymbol} ${dir} | 15m=${tf15m ?? '?'} 1h=${tf1h ?? '?'} 4h=${tf4h ?? '?'} → 타임프레임 불일치`);
      return;
    }
  }

  const valid = await isSymbolValid(signal.bybitSymbol, creds.isTestnet);
  if (!valid) {
    addLog(state, 'WARN', `[심볼 무효] ${signal.displaySymbol} (${signal.bybitSymbol}) — Bybit 미상장, 진입 취소`);
    return;
  }

  try {
    const balance = await getBalance(creds);
    const meta = await getSymbolMeta(signal.bybitSymbol, creds.isTestnet);

    const kellyFraction = signal.kellyFraction ?? 0;
    const conf = signal.confidence;
    const baseSizePct = config.positionSizePct ?? 2;
    const maxSizePct = forceEntry ? baseSizePct * 1.5 : baseSizePct;
    const kellyPct = kellyFraction > 0
      ? Math.min(kellyFraction * 100, maxSizePct)
      : Math.min(creds.positionSizePct, maxSizePct);

    // 전략별 레버리지 결정
    const isSurge = sectionType === 'surge' || (signal as ScalpingSignal & { _sectionType?: SectionType })._sectionType === 'surge';
    const isPresurge = sectionType === 'presurge';
    const rawLeverage = isSurge && config.surgeLeverage
      ? Math.min(config.surgeLeverage, meta.maxLeverage)
      : isPresurge && config.presurgeLeverage
        ? Math.min(config.presurgeLeverage, meta.maxLeverage)
        : config.defaultLeverage
          ? Math.min(config.defaultLeverage, meta.maxLeverage)
          : meta.maxLeverage;

    // ── 강제청산 방지 사전 검증 ──
    const side0: 'Buy' | 'Sell' = signal.direction === 'LONG' ? 'Buy' : 'Sell';
    const liqCheck = checkLiquidationSafety(
      signal.entryPrice,
      side0,
      rawLeverage,
      balance.availableBalance,
      kellyPct,
      balance.mmrPct,
    );
    let useLeverage = rawLeverage;
    if (!liqCheck.isSafe) {
      // 안전 레버리지로 자동 하향
      useLeverage = calcSafeLeverage(
        signal.entryPrice, side0, rawLeverage, balance.mmrPct, 35
      );
      addLog(state, 'WARN',
        `[강제청산 방지] ${signal.displaySymbol} | 레버리지 ${rawLeverage}x → ${useLeverage}x 자동 축소 | 청산여유 ${liqCheck.distancePct.toFixed(1)}% | ${liqCheck.reason ?? ''}`);
      if (useLeverage < 1) {
        addLog(state, 'WARN', `[진입 취소] ${signal.displaySymbol} — 안전 레버리지 계산 불가`);
        return;
      }
    }

    // ── 복리 포지션 크기 조정 ──
    const compoundState = state.baseBalance && state.baseBalance > 0
      ? calcCompoundingState(
          state.baseBalance,
          balance.totalBalance,
          state.dailyPnlPct ?? 0,
          config.positionSizePct ?? 2,
        )
      : null;
    const compoundSizePct = compoundState?.recommendedSizePct ?? kellyPct;

    // ── 연속 손실 레벨 적용 ──
    const lossLevelData = getConsecutiveLossLevel(state.consecutiveLosses ?? 0);
    const lossAdjustedSizePct = compoundSizePct * lossLevelData.sizeMultiplier;
    const lossAdjustedLeverage = Math.max(1, Math.floor(useLeverage * lossLevelData.leverageMultiplier));
    useLeverage = Math.min(useLeverage, lossAdjustedLeverage);

    // ── 야간 세션 포지션 크기 축소 ──
    const kstHour = (new Date().getUTCHours() + 9) % 24;
    const isNightSession = kstHour >= 0 && kstHour < 6;
    const nightReductionPct = config.nightSessionReduction !== false && isNightSession
      ? (config.nightSessionReductionPct ?? 50) / 100
      : 1.0;

    const effectiveSizePct = lossAdjustedSizePct * nightReductionPct;
    const qty = calcQty(
      balance.availableBalance,
      effectiveSizePct,
      signal.entryPrice,
      useLeverage,
      meta.minOrderQty,
      meta.qtyStep,
      meta.qtyPrecision,
    );

    if (!qty) {
      addLog(state, 'WARN', `[진입 취소] ${signal.displaySymbol} — 최소 주문 수량 미달`);
      return;
    }

    const side: 'Buy' | 'Sell' = signal.direction === 'LONG' ? 'Buy' : 'Sell';
    const atrSL = signal.atr && signal.atr > 0
      ? signal.atr * 1.5
      : (signal.entryPrice / useLeverage) * 0.55;
    const tpDist = atrSL * 2.0;
    const stopLoss = side === 'Buy' ? signal.entryPrice - atrSL : signal.entryPrice + atrSL;
    const takeProfit = side === 'Buy' ? signal.entryPrice + tpDist : signal.entryPrice - tpDist;

    await placeOrder(creds, signal.bybitSymbol, side, qty, useLeverage, stopLoss.toString(), takeProfit.toString());

    const notional = safeFloat(qty) * signal.entryPrice;
    const margin = notional / useLeverage;

    const resolvedSectionType: SectionType = sectionType ?? (signal as ScalpingSignal & { _sectionType?: SectionType })._sectionType ?? 'top7';

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
      forceEntry,
      confidence: signal.confidence,
      kellyFraction: signal.kellyFraction,
      nextActionPct: 30,
      sourceType: resolvedSectionType,
      initialMarginUsdt: margin,
      initialSize: safeFloat(qty),
    });

    const label = forceEntry ? '[강제진입]' : '[진입]';
    const levLabel = isSurge ? `급등락 ${useLeverage}x` : `${useLeverage}x`;
    addLog(state, 'TRADE',
      `${label} ${signal.displaySymbol} ${side === 'Buy' ? '롱' : '숏'} | 평단가: ${signal.entryPrice.toFixed(meta.pricePrecision)} | ${levLabel} | 신뢰도 ${signal.confidence}%`);
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    addLog(state, 'ERROR', `[진입 실패] ${signal.displaySymbol}: ${errMsg}`);
    if (errMsg.includes('10001')) {
      resetPositionModeDetection();
      addLog(state, 'INFO', `[포지션 모드 재감지] 10001 오류로 인해 포지션 모드를 재확인합니다.`);
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
        saveTradeRecord({
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

        state.dailyPnl = (state.dailyPnl ?? 0) + pnlNet;
        if (state.dailyStartBalance && state.dailyStartBalance > 0) {
          state.dailyPnlPct = (state.dailyPnl / state.dailyStartBalance) * 100;
          if (!state.conservativeMode && state.dailyPnlPct >= 30) {
            state.conservativeMode = true;
            addLog(state, 'INFO',
              `[하루 목표 달성!] 일일 수익률 ${state.dailyPnlPct.toFixed(1)}% → 보수 모드 전환`);
          }
        }

        addLog(state, 'TRADE',
          `[정산] ${pos.displaySymbol} | 순이익: ${pnlNet >= 0 ? '+' : ''}${pnlNet.toFixed(2)} USDT (${pnlPctNet.toFixed(1)}%) | 오늘 누적: ${(state.dailyPnlPct ?? 0).toFixed(1)}%`);
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

// ─── 직접매매 감지 ────────────────────────────────────────────────────────────

async function detectManualTrades(
  creds: ApiCredentials,
  state: BotState,
): Promise<Set<string>> {
  const liveBybitSymbols = new Set<string>();
  const excludeSet = new Set(_excludeList);

  try {
    const livePositions = await getPositions(creds);
    const botSymbols = new Set(state.positions.map(p => p.bybitSymbol));

    for (const live of livePositions) {
      const size = safeFloat(live.size);
      if (size <= 0) continue;
      if (excludeSet.has(live.symbol)) continue;

      liveBybitSymbols.add(live.symbol);

      if (!botSymbols.has(live.symbol)) {
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
          `[외부진입 등록] ${displaySymbol} ${live.side === 'Buy' ? '롱' : '숏'} | ${live.size} | ${leverage}x`);
      }
    }

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

// ─── 포지션 관리 ─────────────────────────────────────────────────────────────

async function managePositions(
  creds: ApiCredentials,
  state: BotState,
  config: BotConfig,
): Promise<void> {
  const excludeSet = new Set(_excludeList);
  for (const pos of [...state.positions]) {
    try {
      if (excludeSet.has(pos.bybitSymbol)) continue;

      const step = config.slStep ?? 10;

      // ── 급등직전(presurge) 장기보유 전략 ──
      if (pos.sourceType === 'presurge') {
        // 손절 -20%
        if (pos.pnlPct <= -20) {
          await closePosition(creds, pos.bybitSymbol, pos.side, pos.size);
          addLog(state, 'TRADE',
            `[급등직전-손절] ${pos.displaySymbol} | 손실 ${pos.pnlPct.toFixed(1)}% → 손절 (-20%)`);
          state.positions = state.positions.filter(p => p.bybitSymbol !== pos.bybitSymbol);
          continue;
        }
        // Partial TP: 수익금 ≥ 초기 보증금 시 30% 부분청산 (최대 3단계)
        const ptpCount = pos.partialTpCount ?? 0;
        const initMargin = pos.initialMarginUsdt ?? 0;
        const initSize = pos.initialSize ?? safeFloat(pos.size);
        if (ptpCount < 3 && initMargin > 0 && pos.unrealisedPnl >= initMargin * (ptpCount + 1)) {
          try {
            const ptpMeta = await getSymbolMeta(pos.bybitSymbol, creds.isTestnet);
            const ptpQtyRaw = Math.ceil(initSize * 0.3 / ptpMeta.qtyStep) * ptpMeta.qtyStep;
            const ptpQtyStr = Math.max(ptpMeta.minOrderQty, ptpQtyRaw).toFixed(ptpMeta.qtyPrecision);
            await closePartialPosition(creds, pos.bybitSymbol, pos.side, ptpQtyStr);
            pos.partialTpCount = ptpCount + 1;
            pos.lastPartialTpPnlPct = pos.pnlPct;
            addLog(state, 'TRADE',
              `[급등직전-부분청산 ${ptpCount + 1}단계] ${pos.displaySymbol} | 수익 ${pos.pnlPct.toFixed(1)}% | ${ptpQtyStr} (30%) 청산`);
          } catch (ptpErr) {
            addLog(state, 'WARN', `[부분청산 오류] ${pos.displaySymbol}: ${ptpErr instanceof Error ? ptpErr.message : String(ptpErr)}`);
          }
        }
        // 방향 전환 감지 → 전량 청산, 재진입 없음
        const presurgeNow = Date.now();
        const presurgeLastAnalysis = pos.lastLiveAnalysisAt ?? 0;
        if (presurgeNow - presurgeLastAnalysis >= 60 * 1000) {
          try {
            const presurgeLive = await analyzeSymbolLive(pos.symbol);
            pos.lastLiveAnalysisAt = presurgeNow;
            if (presurgeLive) {
              pos.liveSignalDirection = presurgeLive.direction;
              pos.liveSignalConfidence = presurgeLive.confidence;
              const presurgePosDir = pos.side === 'Buy' ? 'LONG' : 'SHORT';
              if (presurgeLive.direction !== presurgePosDir && presurgeLive.confidence >= 65) {
                await closePosition(creds, pos.bybitSymbol, pos.side, pos.size);
                addLog(state, 'TRADE',
                  `[급등직전-방향전환] ${pos.displaySymbol} | 신뢰도 ${presurgeLive.confidence}% → 전량 청산 (재진입 없음)`);
                state.positions = state.positions.filter(p => p.bybitSymbol !== pos.bybitSymbol);
                continue;
              }
            }
          } catch { /* 무시 */ }
        }
        // 트레일링 스탑 (presurge: -12%)
        if (pos.trailingActivated) {
          if (pos.pnlPct > (pos.trailingHighPct ?? 0)) pos.trailingHighPct = pos.pnlPct;
          const trailDrop = (pos.trailingHighPct ?? 0) - pos.pnlPct;
          const trailWidth = pos.trailingStopWidth ?? (config.trailingWidthPresurge ?? 12);
          if (trailDrop >= trailWidth) {
            await closePosition(creds, pos.bybitSymbol, pos.side, pos.size);
            addLog(state, 'TRADE',
              `[급등직전-트레일링] ${pos.displaySymbol} | 최고 +${(pos.trailingHighPct ?? 0).toFixed(1)}% → 현재 +${pos.pnlPct.toFixed(1)}% → 청산`);
            state.positions = state.positions.filter(p => p.bybitSymbol !== pos.bybitSymbol);
            continue;
          }
        }
        // 익절 구간 도달 → 트레일링 활성화
        const presurgeTpPct = config.normalTakeProfitPct ?? 50;
        if (!pos.trailingActivated && pos.pnlPct >= presurgeTpPct) {
          pos.trailingActivated = true;
          pos.trailingHighPct = pos.pnlPct;
          pos.trailingStopWidth = config.trailingWidthPresurge ?? 12;
          addLog(state, 'INFO',
            `[급등직전-트레일링 활성] ${pos.displaySymbol} | +${pos.pnlPct.toFixed(1)}% 도달 → 트레일링 시작`);
        }
        continue; // presurge는 아래 일반 로직 건너뜀
      }

      // ── 급등락(surge) 종목 특화 전략 ──
      if (pos.sourceType === 'surge') {
        if (pos.pnlPct <= -15) {
          await closePosition(creds, pos.bybitSymbol, pos.side, pos.size);
          addLog(state, 'TRADE',
            `[급등락-손절] ${pos.displaySymbol} | 손실 ${pos.pnlPct.toFixed(1)}% → 빠른 손절 (-15%)`);
          state.positions = state.positions.filter(p => p.bybitSymbol !== pos.bybitSymbol);
          continue;
        }
        if (pos.pnlPct >= 20) {
          await closePosition(creds, pos.bybitSymbol, pos.side, pos.size);
          addLog(state, 'TRADE',
            `[급등락-익절] ${pos.displaySymbol} | 수익 ${pos.pnlPct.toFixed(1)}% → 빠른 익절 (+20%)`);
          state.positions = state.positions.filter(p => p.bybitSymbol !== pos.bybitSymbol);
          continue;
        }
        const surgeNow = Date.now();
        const surgeLastAnalysis = pos.lastLiveAnalysisAt ?? 0;
        if (surgeNow - surgeLastAnalysis >= 30 * 1000) {
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
                  `[급등락-전환] ${pos.displaySymbol} | 방향전환 감지 (신뢰도 ${surgeLive.confidence}%) → 즉시 청산`);
                state.positions = state.positions.filter(p => p.bybitSymbol !== pos.bybitSymbol);
                continue;
              }
            }
          } catch (_) { /* 분석 실패 시 일반 로직으로 진행 */ }
        }
      }

      // ── 실시간 분석 레이어 ──
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

            if (!sameDir) {
              const dynamicThreshold = Math.min(
                config.slThreshold,
                Math.max(3, Math.round((100 / (pos.leverage || 10)) * 1.5))
              );
              const isInActionZone = pos.pnlPct <= -dynamicThreshold || pos.pnlPct >= config.slThreshold;
              const isHighConfidenceReversal = liveSignal.confidence >= 60;

              if (!isInActionZone && isHighConfidenceReversal) {
                const earlyReverseCount = pos.reverseCount ?? 0;
                if (earlyReverseCount < 2) {
                  try {
                    const origSize = safeFloat(pos.size);
                    const newSide: 'Buy' | 'Sell' = pos.side === 'Buy' ? 'Sell' : 'Buy';
                    await closePosition(creds, pos.bybitSymbol, pos.side, pos.size);
                    addLog(state, 'TRADE',
                      `[조기청산] ${pos.displaySymbol} | 수익 ${pos.pnlPct.toFixed(1)}% + 방향전환 → 전량청산`);
                    state.positions = state.positions.filter(p => p.bybitSymbol !== pos.bybitSymbol);

                    const earlyCheckPos = await getPositionBySymbol(creds, pos.bybitSymbol).catch(() => null);
                    if (earlyCheckPos && safeFloat(earlyCheckPos.size) > 0) continue;

                    const earlyMeta = await getSymbolMeta(pos.bybitSymbol, creds.isTestnet);
                    const earlyQtyRaw = origSize * 0.5;
                    const earlyQtyStr = Math.max(earlyMeta.minOrderQty,
                      Math.floor(earlyQtyRaw / earlyMeta.qtyStep) * earlyMeta.qtyStep)
                      .toFixed(earlyMeta.qtyPrecision);
                    const earlyPrice = liveSignal.entryPrice;
                    const earlyAtrSL = liveSignal.atr && liveSignal.atr > 0
                      ? liveSignal.atr * 1.5 : (earlyPrice / pos.leverage) * 0.55;
                    const earlySL = newSide === 'Buy' ? earlyPrice - earlyAtrSL : earlyPrice + earlyAtrSL;
                    const earlyTP = newSide === 'Buy' ? earlyPrice + earlyAtrSL * 2 : earlyPrice - earlyAtrSL * 2;

                    await placeOrder(creds, pos.bybitSymbol, newSide, earlyQtyStr, pos.leverage, earlySL.toString(), earlyTP.toString());
                    state.positions.push({
                      symbol: pos.symbol, bybitSymbol: pos.bybitSymbol, displaySymbol: pos.displaySymbol,
                      side: newSide, entryPrice: earlyPrice, avgPrice: earlyPrice,
                      size: earlyQtyStr, leverage: pos.leverage, stopLoss: earlySL, takeProfit: earlyTP,
                      addCount: 0, openedAt: Date.now(), markPrice: earlyPrice,
                      liqPrice: 0, unrealisedPnl: 0, pnlPct: 0, filled: true,
                      isReverse: true, reverseCount: earlyReverseCount + 1,
                      confidence: liveSignal.confidence, kellyFraction: liveSignal.kellyFraction, nextActionPct: 30,
                    });
                    addLog(state, 'TRADE',
                      `[조기역방향] ${pos.displaySymbol} ${newSide === 'Buy' ? '롱' : '숏'} | ${earlyQtyStr} (50%) | 신뢰도 ${liveSignal.confidence}%`);
                  } catch (earlyErr) {
                    addLog(state, 'WARN',
                      `[조기역방향 실패] ${pos.displaySymbol}: ${earlyErr instanceof Error ? earlyErr.message : String(earlyErr)}`);
                  }
                }
              }
            } else {
              addLog(state, 'INFO',
                `[실시간분석] ${pos.displaySymbol} | ${posDir} 방향 유지 | 신뢰도 ${liveSignal.confidence}% | 수익 ${pos.pnlPct.toFixed(1)}%`);
            }
          }
        } catch { /* 실시간 분석 실패 시 무시 */ }
      }
      // ── 레버리지 연동 동적 손절 임계값 ──
      const dynamicSlThreshold = Math.min(
        config.slThreshold,
        Math.max(3, Math.round((100 / (pos.leverage || 10)) * 1.5))
      );

      // ── 손절 ──
      if (pos.pnlPct <= -dynamicSlThreshold) {
        const alreadyAnalyzed = pos.lastAnalyzedPnlPct !== undefined &&
          pos.lastAnalyzedPnlPct <= -dynamicSlThreshold &&
          Math.abs(pos.pnlPct - pos.lastAnalyzedPnlPct) < step;

        if (!alreadyAnalyzed) {
          const signal = await analyzeSymbolLive(pos.symbol);
          pos.lastAnalyzedPnlPct = pos.pnlPct;

          if (signal) {
            const sameDir = (signal.direction === 'LONG' && pos.side === 'Buy') ||
                            (signal.direction === 'SHORT' && pos.side === 'Sell');

            if (!sameDir) {
              const currentReverseCount = pos.reverseCount ?? 0;
              const origSize = safeFloat(pos.size);
              const revSide: 'Buy' | 'Sell' = pos.side === 'Buy' ? 'Sell' : 'Buy';
              const revRatio = signal.confidence >= 85 ? 1.0 : 0.5;
              const revLabel = signal.confidence >= 85 ? '100%' : '50%';
              await closePosition(creds, pos.bybitSymbol, pos.side, pos.size);
              addLog(state, 'TRADE',
                `[손절] ${pos.displaySymbol} | 손실 ${Math.abs(pos.pnlPct).toFixed(1)}% + 추세 반전 → 손절, 역방향 ${revLabel} 진입 준비`);
              state.positions = state.positions.filter(p => p.bybitSymbol !== pos.bybitSymbol);

              const slCheckPos = await getPositionBySymbol(creds, pos.bybitSymbol).catch(() => null);
              if (slCheckPos && safeFloat(slCheckPos.size) > 0) continue;

              if (currentReverseCount < 2) {
                try {
                  const revMeta = await getSymbolMeta(pos.bybitSymbol, creds.isTestnet);
                  const revQtyRaw = origSize * revRatio;
                  const revQtyStr = Math.max(revMeta.minOrderQty,
                    Math.floor(revQtyRaw / revMeta.qtyStep) * revMeta.qtyStep)
                    .toFixed(revMeta.qtyPrecision);
                  const revPrice = signal.entryPrice;
                  const revAtrSL = signal.atr && signal.atr > 0
                    ? signal.atr * 1.5 : (revPrice / pos.leverage) * 0.55;
                  const revSL = revSide === 'Buy' ? revPrice - revAtrSL : revPrice + revAtrSL;
                  const revTP = revSide === 'Buy' ? revPrice + revAtrSL * 2 : revPrice - revAtrSL * 2;
                  await placeOrder(creds, pos.bybitSymbol, revSide, revQtyStr, pos.leverage, revSL.toString(), revTP.toString());
                  state.positions.push({
                    symbol: pos.symbol, bybitSymbol: pos.bybitSymbol, displaySymbol: pos.displaySymbol,
                    side: revSide, entryPrice: revPrice, avgPrice: revPrice,
                    size: revQtyStr, leverage: pos.leverage, stopLoss: revSL, takeProfit: revTP,
                    addCount: 0, openedAt: Date.now(), markPrice: revPrice,
                    liqPrice: 0, unrealisedPnl: 0, pnlPct: 0, filled: true,
                    isReverse: true, reverseCount: currentReverseCount + 1,
                    confidence: signal.confidence, kellyFraction: signal.kellyFraction, nextActionPct: 30,
                  });
                  addLog(state, 'TRADE',
                    `[역방향-손절] ${pos.displaySymbol} ${revSide === 'Buy' ? '롱' : '숏'} | ${revQtyStr} (${revLabel}) | ${pos.leverage}x`);
                } catch (revErr) {
                  addLog(state, 'WARN',
                    `[역방향-손절 실패] ${pos.displaySymbol}: ${revErr instanceof Error ? revErr.message : String(revErr)}`);
                }
              }
            } else {
              // 방향 같음 → 추가매수
              const addCountStrict = pos.addCountStrict ?? 0;
              const lastAddAt = pos.lastAddAt ?? 0;
              const addCooldownMs = 30 * 60 * 1000;
              const addCooldownOk = Date.now() - lastAddAt >= addCooldownMs;
              const addMaxOk = addCountStrict < 2;
              const addConfOk = signal.confidence >= 75;
              const posDirStr = pos.side === 'Buy' ? 'LONG' : 'SHORT';
              const tf15mOk = !(signal as any).tf15m || (signal as any).tf15m === posDirStr;
              const tf1hOk = !(signal as any).tf1h || (signal as any).tf1h === posDirStr;
              const tfMatchCount = (tf15mOk ? 1 : 0) + (tf1hOk ? 1 : 0);
              const tfOk = tfMatchCount >= 1;

              if (addMaxOk && addCooldownOk && addConfOk && tfOk) {
                const currentSize = safeFloat(pos.size);
                const addQty = currentSize * 0.2;
                const meta = await getSymbolMeta(pos.bybitSymbol, creds.isTestnet);
                const addQtyRaw = Math.ceil(addQty / meta.qtyStep) * meta.qtyStep;
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
                    }
                  } catch { /* 무시 */ }
                  addLog(state, 'TRADE',
                    `[추가매수] ${pos.displaySymbol} | 손실 ${Math.abs(pos.pnlPct).toFixed(1)}% + 신뢰도 ${signal.confidence}% → +${addQtyStr} (20%) | ${addCountStrict + 1}/2회`);
                } catch (addErr) {
                  addLog(state, 'WARN',
                    `[추가매수 실패] ${pos.displaySymbol}: ${addErr instanceof Error ? addErr.message : String(addErr)}`);
                }
              }
            }
          }
        }
      }

      // ── 손익분기점 자동 이동 + 트레일링 스탑 ──
      if (pos.breakEvenActivated || pos.trailingActivated) {
        if (pos.pnlPct > (pos.trailingHighPct ?? 0)) {
          pos.trailingHighPct = pos.pnlPct;
        }
        const _st = pos.sourceType as SectionType | undefined;
        const trailWidth = pos.trailingStopWidth ??
          (_st === 'surge' ? 8 : _st === 'presurge' ? 12 : 10);
        const trailHigh = pos.trailingHighPct ?? pos.pnlPct;
        const trailDrop = trailHigh - pos.pnlPct;

        if (pos.breakEvenActivated && pos.pnlPct <= 0.5) {
          await closePosition(creds, pos.bybitSymbol, pos.side, pos.size);
          addLog(state, 'TRADE',
            `[손익분기점] ${pos.displaySymbol} | 수익 ${pos.pnlPct.toFixed(1)}% → 손익분기점 이탈, 원금 보호 청산`);
          state.positions = state.positions.filter(p => p.bybitSymbol !== pos.bybitSymbol);
          continue;
        }

        if (pos.trailingActivated && trailDrop >= trailWidth) {
          await closePosition(creds, pos.bybitSymbol, pos.side, pos.size);
          addLog(state, 'TRADE',
            `[트레일링 스탑] ${pos.displaySymbol} | 최고 +${trailHigh.toFixed(1)}% → 현재 +${pos.pnlPct.toFixed(1)}% → 청산`);
          state.positions = state.positions.filter(p => p.bybitSymbol !== pos.bybitSymbol);
          continue;
        }
      }

      // ── 피라미딩 ──
      const pyramidCount = pos.pyramidCount ?? 0;
      const pyramidThresholds = [10, 20];
      const pyramidRatios = [0.2, 0.1];
      if (pyramidCount < 2 && pos.pnlPct >= pyramidThresholds[pyramidCount]) {
        const lastPyramidPnl = pos.lastPyramidPnlPct ?? -Infinity;
        const alreadyPyramided = Math.abs(pos.pnlPct - lastPyramidPnl) < 3;
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
                addLog(state, 'TRADE',
                  `[피라미딩 ${pyramidCount + 1}차] ${pos.displaySymbol} | +${pos.pnlPct.toFixed(1)}% + 신뢰도 ${pyrSignal.confidence}% → +${pyrQtyStr} 추가`);
              }
            }
          } catch (pyrErr) {
            addLog(state, 'WARN', `[피라미딩 오류] ${pos.displaySymbol}: ${pyrErr instanceof Error ? pyrErr.message : String(pyrErr)}`);
          }
        }
      }

      // ── Partial TP (일반봇 + presurge) ──
      if (config.partialTpEnabled !== false && pos.sourceType !== 'surge') {
        const ptpCount = pos.partialTpCount ?? 0;
        const ptpMultiplier = config.partialTpTriggerMultiplier ?? 1.0;
        const initialMargin = pos.initialMarginUsdt ?? 0;
        const currentPnl = pos.unrealisedPnl ?? 0;
        // 1단계: 수익금 = 보증금 × multiplier (30% 청산)
        // 2단계: 수익금 = 보증금 × 2 × multiplier (30% 추가 청산)
        // 3단계: 수익금 = 보증금 × 3 × multiplier (30% 추가 청산)
        const ptpTrigger = initialMargin * ptpMultiplier * (ptpCount + 1);
        const lastPtpPnlPct = pos.lastPartialTpPnlPct ?? -Infinity;
        const ptpCooldownOk = pos.pnlPct - lastPtpPnlPct >= 5;
        if (ptpCount < 3 && initialMargin > 0 && currentPnl >= ptpTrigger && ptpCooldownOk) {
          try {
            const ptpMeta = await getSymbolMeta(pos.bybitSymbol, creds.isTestnet);
            const ptpOrigSize = safeFloat(pos.size);
            const ptpQtyRaw = ptpOrigSize * 0.3;
            const ptpQtyStr = Math.max(ptpMeta.minOrderQty,
              Math.floor(ptpQtyRaw / ptpMeta.qtyStep) * ptpMeta.qtyStep)
              .toFixed(ptpMeta.qtyPrecision);
            await closePartialPosition(creds, pos.bybitSymbol, pos.side, ptpQtyStr);
            pos.partialTpCount = ptpCount + 1;
            pos.lastPartialTpPnlPct = pos.pnlPct;
            addLog(state, 'TRADE',
              `[Partial TP ${ptpCount + 1}단계] ${pos.displaySymbol} | 수익 ${pos.pnlPct.toFixed(1)}% | ${ptpQtyStr} (30%) 청산 → 나머지 트레일링`);
          } catch (ptpErr) {
            addLog(state, 'WARN', `[Partial TP 오류] ${pos.displaySymbol}: ${ptpErr instanceof Error ? ptpErr.message : String(ptpErr)}`);
          }
        }
      }

      // ── 포지션 수익률 마일스톤 알림 ──
      const notifyMilestones = [50, 100, 200, 300];
      for (const milestone of notifyMilestones) {
        const milestoneKey = `notified_${milestone}`;
        const posAny = pos as unknown as Record<string, unknown>;
        const alreadyNotified = posAny[milestoneKey];
        if (!alreadyNotified && pos.pnlPct >= milestone) {
          posAny[milestoneKey] = true;
          notifyOwner({
            title: `🚀 ${pos.displaySymbol} +${milestone}% 돌파!`,
            content: `${pos.displaySymbol} ${pos.side === 'Buy' ? '롱' : '숙'} 포지션이 +${pos.pnlPct.toFixed(1)}%에 도달했습니다. 익절 검토해보세요!`,
          }).catch(() => {});
          addLog(state, 'INFO', `[수익 마일스톤] ${pos.displaySymbol} +${milestone}% 돌파 → 알림 발송`);
          break;
        }
      }

      // ── 익절 ──
      if (pos.pnlPct >= config.slThreshold) {
        const currentBand = Math.floor(pos.pnlPct / step) * step;
        const lastBand = pos.lastAnalyzedPnlPct !== undefined && pos.lastAnalyzedPnlPct > 0
          ? Math.floor(pos.lastAnalyzedPnlPct / step) * step : -Infinity;

        if (currentBand > lastBand) {
          const signal = await analyzeSymbolLive(pos.symbol);
          pos.lastAnalyzedPnlPct = pos.pnlPct;

          if (signal) {
            const sameDir = (signal.direction === 'LONG' && pos.side === 'Buy') ||
                            (signal.direction === 'SHORT' && pos.side === 'Sell');

            if (!sameDir) {
              const tpReverseCount = pos.reverseCount ?? 0;
              const origSize = safeFloat(pos.size);
              const newSide: 'Buy' | 'Sell' = pos.side === 'Buy' ? 'Sell' : 'Buy';
              const tpRevRatio = signal.confidence >= 85 ? 1.0 : 0.5;
              const tpRevLabel = signal.confidence >= 85 ? '100%' : '50%';

              await closePosition(creds, pos.bybitSymbol, pos.side, pos.size);
              addLog(state, 'TRADE',
                `[익절 청산] ${pos.displaySymbol} | 이익 ${pos.pnlPct.toFixed(1)}% + 추세 반전 → 청산, 역방향 ${tpRevLabel} 준비`);
              state.positions = state.positions.filter(p => p.bybitSymbol !== pos.bybitSymbol);

              const tpCheckPos = await getPositionBySymbol(creds, pos.bybitSymbol).catch(() => null);
              if (tpCheckPos && safeFloat(tpCheckPos.size) > 0) continue;

              if (tpReverseCount < 2) {
                try {
                  const meta = await getSymbolMeta(pos.bybitSymbol, creds.isTestnet);
                  const halfQty = origSize * tpRevRatio;
                  const newQtyStr = Math.max(meta.minOrderQty, Math.floor(halfQty / meta.qtyStep) * meta.qtyStep)
                    .toFixed(meta.qtyPrecision);
                  const newPrice = signal.entryPrice;
                  const newAtrSL = signal.atr && signal.atr > 0
                    ? signal.atr * 1.5 : (newPrice / pos.leverage) * 0.55;
                  const newSL = newSide === 'Buy' ? newPrice - newAtrSL : newPrice + newAtrSL;
                  const newTP = newSide === 'Buy' ? newPrice + newAtrSL * 2 : newPrice - newAtrSL * 2;

                  await placeOrder(creds, pos.bybitSymbol, newSide, newQtyStr, pos.leverage, newSL.toString(), newTP.toString());
                  state.positions.push({
                    symbol: pos.symbol, bybitSymbol: pos.bybitSymbol, displaySymbol: pos.displaySymbol,
                    side: newSide, entryPrice: newPrice, avgPrice: newPrice,
                    size: newQtyStr, leverage: pos.leverage, stopLoss: newSL, takeProfit: newTP,
                    addCount: 0, openedAt: Date.now(), markPrice: newPrice,
                    liqPrice: 0, unrealisedPnl: 0, pnlPct: 0, filled: true,
                    isReverse: true, reverseCount: tpReverseCount + 1,
                    confidence: signal.confidence, kellyFraction: signal.kellyFraction, nextActionPct: 30,
                  });
                  addLog(state, 'TRADE',
                    `[역방향-익절] ${pos.displaySymbol} ${newSide === 'Buy' ? '롱' : '숏'} | ${newQtyStr} (${tpRevLabel}) | ${pos.leverage}x`);
                } catch (revErr) {
                  addLog(state, 'WARN',
                    `[역방향 진입 실패] ${pos.displaySymbol}: ${revErr instanceof Error ? revErr.message : String(revErr)}`);
                }
              }
            } else {
              // 방향 유지 → BE/트레일링 활성화
              if (!pos.breakEvenActivated) {
                pos.breakEvenActivated = true;
                addLog(state, 'INFO',
                  `[트레일링 활성화] ${pos.displaySymbol} | +${pos.pnlPct.toFixed(1)}% 도달 → 손익분기점 이동 + 트레일링 활성화`);
              }
              if (!pos.trailingActivated) {
                pos.trailingActivated = true;
                pos.trailingHighPct = pos.pnlPct;
                const _st2 = pos.sourceType as SectionType | undefined;
                pos.trailingStopWidth = _st2 === 'surge'
                  ? (config.trailingWidthSurge ?? 5)
                  : _st2 === 'presurge'
                    ? (config.trailingWidthPresurge ?? 8)
                    : (config.trailingWidthNormal ?? 5);
              }
              addLog(state, 'INFO',
                `[익절 유지] ${pos.displaySymbol} | 이익 ${pos.pnlPct.toFixed(1)}% + 추세 유지 → 계속 보유`);
            }
          } else {
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

// ─── 봇 틱 ────────────────────────────────────────────────────────────────────

export async function serverBotTick(): Promise<void> {
  const state = _serverState;
  if (!state.running) return;

  const creds = _serverCreds;
  if (!creds?.apiKey) {
    addLog(state, 'ERROR', 'API 키 없음. 앱 설정 탭에서 입력하세요.');
    return;
  }

  if (!isPositionModeDetected()) {
    await detectPositionMode(creds);
  }

  const config = _serverConfig;
  state.lastTickAt = Date.now();

  // 일일 잔고 초기화
  const todayStr = new Date().toISOString().slice(0, 10);
  const lastResetDate = state.dailyReportDate ?? '';
  if (lastResetDate !== todayStr) {
    // 자정 직전 일별 보고서 발송
    if (lastResetDate && lastResetDate !== state.lastDailyReportSentDate) {
      try {
        const winRate = (state.dailyTradeCount ?? 0) > 0
          ? Math.round(((state.dailyWinCount ?? 0) / (state.dailyTradeCount ?? 1)) * 100)
          : 0;
        const pnlSign = (state.dailyPnl ?? 0) >= 0 ? '+' : '';
        const pnlPctSign = (state.dailyPnlPct ?? 0) >= 0 ? '+' : '';
        await notifyOwner({
          title: `📊 일별 매매 보고서 (${lastResetDate})`,
          content: `수익: ${pnlSign}${(state.dailyPnl ?? 0).toFixed(2)} USDT (${pnlPctSign}${(state.dailyPnlPct ?? 0).toFixed(1)}%) | 거래 ${state.dailyTradeCount ?? 0}건 | 승률 ${winRate}%`,
        });
        state.lastDailyReportSentDate = lastResetDate;
        addLog(state, 'INFO', `[일별보고서] ${lastResetDate} 보고서 발송 완료`);
      } catch { /* 무시 */ }
    }
    try {
      const bal = await getBalance(creds);
      state.dailyStartBalance = bal.totalBalance > 0 ? bal.totalBalance : bal.availableBalance;
      state.dailyPnl = 0;
      state.dailyPnlPct = 0;
      state.dailyTradeCount = 0;
      state.dailyWinCount = 0;
      state.conservativeMode = false;
      state.dailyReportDate = todayStr;
      addLog(state, 'INFO',
        `[일일 리셋] ${todayStr} | 시작 잔고: ${(state.dailyStartBalance ?? 0).toFixed(2)} USDT`);
    } catch { /* 무시 */ }
  }

  // ── 일별 손실 한도 자동 정지 ──
  const dailyLossLimit = config.dailyLossLimit ?? 15;
  if ((state.dailyPnlPct ?? 0) <= -dailyLossLimit) {
    if (state.running) {
      state.running = false;
      state.normalRunning = false;
      state.surgeRunning = false;
      state.presurgeRunning = false;
      addLog(state, 'ERROR',
        `🛑 [일별 손실 한도] ${(state.dailyPnlPct ?? 0).toFixed(1)}% → 손실 한도 -${dailyLossLimit}% 도달 → 봇 자동 정지`);
      await notifyOwner({
        title: '🛑 봇 자동 정지 — 일별 손실 한도 도달',
        content: `오늘 손실이 -${(state.dailyPnlPct ?? 0).toFixed(1)}%에 도달했습니다. 봇이 자동 정지되었습니다.`,
      }).catch(() => {});
    }
    return;
  }

  // ── 일별 수익 목표 보수 모드 ──
  const dailyProfitTarget = config.dailyProfitTarget ?? 30;
  if ((state.dailyPnlPct ?? 0) >= dailyProfitTarget && !state.conservativeMode) {
    state.conservativeMode = true;
    addLog(state, 'INFO',
      `🎯 [보수 모드] 오늘 +${(state.dailyPnlPct ?? 0).toFixed(1)}% 달성 → 신뢰도 90%+, 최대 5개 포지션으로 전환`);
    await notifyOwner({
      title: '🎯 일별 수익 목표 달성 — 보수 모드 전환',
      content: `오늘 +${(state.dailyPnlPct ?? 0).toFixed(1)}% 달성! 보수 모드로 전환합니다.`,
    }).catch(() => {});
  }

  try {
    // 시장 컨텍스트 갱신 (5분마다)
    const MARKET_CTX_INTERVAL = 5 * 60 * 1000;
    const lastCtxAt = state.lastMarketContextAt ?? 0;
    let marketCtx = getCachedMarketContext();
    if (Date.now() - lastCtxAt >= MARKET_CTX_INTERVAL || !marketCtx) {
      try {
        marketCtx = await getMarketContext();
        state.lastMarketContextAt = Date.now();
        state.marketPhase = marketCtx.phase;
        state.marketContextSummary = marketCtx.summary;
        state.marketStrategyReason = marketCtx.surgeStrategy.reason;
        const urgentNews = await detectUrgentNewsEvents();
        _lastUrgentNews = urgentNews; // Claude v47: 방향성 분석을 위해 캐시
        state.urgentNewsCount = urgentNews.length;
        if (urgentNews.length > 0) {
          const newsLog = urgentNews.slice(0, 3).map((n: NewsEvent) => `[${n.impactScore}] ${n.title}`).join(' | ');
          addLog(state, 'WARN', `⚠️ 긴급뉴스 ${urgentNews.length}건: ${newsLog}`);
        }
        addLog(state, 'INFO',
          `[시장상황] ${marketCtx.phase} | BTC ${marketCtx.btc.change1h >= 0 ? '+' : ''}${marketCtx.btc.change1h.toFixed(2)}%/1h | 전략: ${marketCtx.surgeStrategy.reason}`);
      } catch { /* 무시 */ }
    }

    // ── 매크로 뉴스 충격 감지 (5분 주기) ──
    const macroNow = Date.now();
    if (macroNow - _lastMacroCheckAt >= MACRO_CHECK_INTERVAL_MS) {
      try {
        const macroState = await getMacroState();
        _lastMacroState = macroState;
        _lastMacroCheckAt = macroNow;
        if (macroState.isShockActive && macroState.currentShockLevel !== 'NONE') {
          const topEvent = macroState.activeEvents[0];
          const shockName = topEvent?.title ?? '매크로 이벤트';
          addLog(state, 'WARN',
            `📰 [매크로충격] ${macroState.currentShockLevel} | ${shockName} | 패턴: ${macroState.currentPattern ?? 'N/A'}`);
          await notifyOwner({
            title: `📰 매크로 충격 — ${macroState.currentShockLevel}`,
            content: `${shockName} | 패턴: ${macroState.currentPattern ?? 'N/A'} | 진입 ${macroState.pauseUntil > Date.now() ? '중단' : '가능'}`,
          }).catch(() => {});
        }
        const upcomingWarning = getUpcomingWarning(macroState);
        if (upcomingWarning) {
          addLog(state, 'INFO', `📅 ${upcomingWarning}`);
        }
        // 시간대×국면 조합 파라미터 갱신
        const phase = (marketCtx?.phase ?? 'NEUTRAL') as Parameters<typeof getComboParams>[0];
        const session = getCurrentSession();
        _lastComboParams = getComboParams(phase, session);
        addLog(state, 'INFO',
          `⚙️ [조합파라미터] ${getSessionSummary()} | 신뢰도 ${_lastComboParams.minConfidence}%+ | 포지션크기 ${_lastComboParams.positionSizePct.toFixed(1)}% | SL ${_lastComboParams.slPct}%`);
      } catch { /* 무시 */ }
    }

    // 매크로 충격 심각도에 따른 포지션 크기 조정
    const macroShockLevel = _lastMacroState?.currentShockLevel ?? 'NONE';
    const macroSizeMultiplier = macroShockLevel === 'CRITICAL' ? 0.2
      : macroShockLevel === 'HIGH' ? 0.4
      : macroShockLevel === 'MEDIUM' ? 0.65
      : macroShockLevel === 'LOW' ? 0.85
      : 1.0;
    const macroCanEnter = _lastMacroState ? canEnterNewPosition(_lastMacroState) : true;

    // ── 뉴스 방향성 차단 (Claude 검증 v47: CRITICAL 뉴스 30분 차단) ──
    // 문제: 기존 urgentNewsCount >= 3 조건은 방향성 무관하게 차단 → 상승 뉴스에서도 롱 차단
    // 해결: analyzeNewsForEntry()로 방향성 분리 → BULLISH 뉴스 시 숏만 차단, BEARISH 시 롱만 차단
    let newsDirectionBlock: NewsDirectionAnalysis | null = null;
    if (_lastUrgentNews && _lastUrgentNews.length > 0) {
      try {
        // NewsEvent → NewsItem 형식 변환 (analyzeNewsForEntry는 NewsItem 배열 수신)
        const newsItemsForAnalysis = _lastUrgentNews.map((n: NewsEvent) => ({
          id: `urgent-${n.publishedAt}-${n.source}`,
          title: n.title,
          source: n.source,
          url: n.url,
          publishedAt: n.publishedAt,
          hoursAgo: Math.max(0, (Date.now() - n.publishedAt) / 3600000),
          importance: (n.impactScore >= 7 ? 'CRITICAL' : n.impactScore >= 4 ? 'NORMAL' : 'RUMOR') as 'CRITICAL' | 'NORMAL' | 'RUMOR',
          direction: 'NEUTRAL' as 'BULLISH' | 'BEARISH' | 'NEUTRAL',
          impactPct: n.impactScore * 5, // 0~10 → 0~50% 스케일
          isVerified: n.source !== 'cryptopanic', // 공식 소스 여부
        }));
        newsDirectionBlock = analyzeNewsForEntry(newsItemsForAnalysis);
        if (newsDirectionBlock.shouldBlockAll) {
          addLog(state, 'WARN', `📰 [뉴스방향차단] ${newsDirectionBlock.reason}`);
        } else if (newsDirectionBlock.shouldBlockLong || newsDirectionBlock.shouldBlockShort) {
          addLog(state, 'INFO', `📰 [뉴스방향필터] ${newsDirectionBlock.reason}`);
        }
      } catch { /* 뉴스 분석 실패 시 무시 */ }
    }
    const newsBlockAll = newsDirectionBlock?.shouldBlockAll ?? false;
    const newsBlockLong = newsDirectionBlock?.shouldBlockLong ?? false;
    const newsBlockShort = newsDirectionBlock?.shouldBlockShort ?? false;

    const isMarketDangerous = marketCtx?.phase === 'RISK_OFF'
      || marketCtx?.phase === 'BTC_CRASH'
      || marketCtx?.phase === 'DISTRIBUTION'
      || marketCtx?.phase === 'BULL_TRAP'
      || (state.urgentNewsCount ?? 0) >= 3
      || macroShockLevel === 'CRITICAL'
      || !macroCanEnter
      || newsBlockAll; // Claude v47 자가검증: 뉴스 전체 차단 시 isMarketDangerous에 통합

    let isBtcDropBlocked = false;
    if (config.btcDropGuard !== false) {
      const btcThreshold = -(config.btcDropThresholdPct ?? 3);
      const btcChange1h = marketCtx?.btc?.change1h ?? 0;
      if (btcChange1h <= btcThreshold) {
        isBtcDropBlocked = true;
        addLog(state, 'WARN',
          `[BTC급락차단] BTC 1h ${btcChange1h.toFixed(2)}% → 신규 진입 중단`);
      }
    }

    const btcChange24hVal = marketCtx?.btc?.change24h ?? 0;
    const stratCtx: StrategyContext = buildStrategyContext(
      btcChange24hVal,
      config.entryConfidenceMin ?? 80,
    );

    const allowEntryBySession = stratCtx.allowNewEntry;
    state.currentSession = stratCtx.sessionLabel;
    state.currentVolatility = stratCtx.volatilityLabel;
    state.currentVolatilityLevel = stratCtx.volatility.level;
    state.effectiveConfidenceMin = stratCtx.effectiveConfidenceMin;
    state.effectivePosMultiplier = stratCtx.effectivePosMultiplier;
    state.allowNewEntryBySession = allowEntryBySession;

    // 직접매매 감지 + Bybit 보유 심볼 수집
    const liveBybitSymbols = await detectManualTrades(creds, state);

    // 포지션 실시간 업데이트
    const closed = await refreshPositions(creds, state);

    // MMR 위험 관리
    await manageMmrRisk(creds, state);

    // 포지션 관리
    await managePositions(creds, state, config);

    // 스캘핑 분석 (2분 주기)
    const now = Date.now();
    if (now - _lastSignalFetchAt >= SIGNAL_REFRESH_INTERVAL || _cachedSignals.length === 0) {
      if (state.normalRunning) {
        addLog(state, 'INFO', '[일반봇] TOP7 스캘핑 분석 중...');
        _cachedSignals = await getTopScalpingSignals();
        addLog(state, 'INFO', `[일반봇] 분석 완료 | ${_cachedSignals.length}개`);
      }
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

    // 블랙리스트 + 제외 목록 필터링
    const excludeSet = new Set(_excludeList);
    const now2 = Date.now();
    const longCount = state.positions.filter(p => p.side === 'Buy').length;
    const shortCount = state.positions.filter(p => p.side === 'Sell').length;
    const totalCount = state.positions.length;
    const MAJOR_COINS = new Set(['BTCUSDT', 'ETHUSDT', 'BNBUSDT']);
    const longRatio = totalCount > 0 ? longCount / totalCount : 0;
    const shortRatio = totalCount > 0 ? shortCount / totalCount : 0;

    const filteredSignals = _cachedSignals.filter(s => {
      if (liveBybitSymbols.has(s.bybitSymbol)) return false;
      if (state.positions.some(p => p.bybitSymbol === s.bybitSymbol)) return false;
      if (excludeSet.has(s.bybitSymbol)) return false;
      if (_manualBlacklist[s.bybitSymbol] && now2 - _manualBlacklist[s.bybitSymbol] < MANUAL_COOLDOWN_MS) return false;
      if (!MAJOR_COINS.has(s.bybitSymbol)) {
        if (s.direction === 'LONG' && longCount >= 8) return false;
        if (s.direction === 'SHORT' && shortCount >= 8) return false;
      }
      if (totalCount >= 4) {
        if (s.direction === 'LONG' && longRatio > 0.7) return false;
        if (s.direction === 'SHORT' && shortRatio > 0.7) return false;
      }
      return true;
    });

    const usedSymbols = new Set(state.positions.map(p => p.bybitSymbol));
    const isConservative = state.conservativeMode === true;
    const effectiveMaxPositions = isConservative ? 5 : config.maxPositions;

    if (state.autoEntry === false) {
      addLog(state, 'INFO', '[자동진입 OFF] 신규 진입 건너뜀 — 기존 포지션 관리만 진행');
    } else if (isBtcDropBlocked || isMarketDangerous) {
      addLog(state, 'WARN', `[진입차단] BTC급락=${isBtcDropBlocked} / 시장위험=${isMarketDangerous} → 신규 진입 전면 중단`);
    } else if (!allowEntryBySession) {
      addLog(state, 'INFO', `[세션차단] ${stratCtx.sessionLabel} → 신규 진입 중단`);
    } else {
      const minConf = isConservative ? 90 : stratCtx.effectiveConfidenceMin;

      // ── 시간대×국면 조합 파라미터 적용 ──
      const comboMinConf = _lastComboParams?.minConfidence ?? stratCtx.effectiveConfidenceMin;
      const comboSizePct = _lastComboParams?.positionSizePct ?? (config.positionSizePct ?? 2);
      const comboSlPct = _lastComboParams?.slPct;
      const comboMaxPos = _lastComboParams?.maxPositions ?? config.maxPositions;
      const effectiveMinConf = Math.max(comboMinConf, isConservative ? 90 : stratCtx.effectiveConfidenceMin);
      const effectiveMaxPos = Math.min(comboMaxPos, effectiveMaxPositions);

      // 신뢰도 95%+ 우선 진입 (Claude v47 자가검증: newsBlockLong/Short 방향성 필터 적용)
      const highConf = filteredSignals.filter(s => {
        if (s.confidence < 95 || usedSymbols.has(s.bybitSymbol)) return false;
        if (newsBlockLong && s.direction === 'LONG') return false;   // BEARISH 뉴스 → 롱 차단
        if (newsBlockShort && s.direction === 'SHORT') return false; // BULLISH 뉴스 → 숏 차단
        return true;
      });
      for (const sig of highConf) {
        await enterPosition(creds, sig, state, config, true, liveBybitSymbols);
        usedSymbols.add(sig.bybitSymbol);
      }

      // 일반 진입
      const currentSlots = effectiveMaxPositions - state.positions.length;
      if (currentSlots > 0) {
        const normal = filteredSignals.filter(s => {
          if (s.confidence < minConf || s.confidence >= 95) return false;
          if (usedSymbols.has(s.bybitSymbol)) return false;
          if (newsBlockLong && s.direction === 'LONG') return false;   // Claude v47 자가검증
          if (newsBlockShort && s.direction === 'SHORT') return false; // Claude v47 자가검증
          const momentumInput = extractMomentumInput(s);
          const momentumScore = calcMomentumScore(momentumInput);
          if (momentumScore.grade === 'D') return false;
          return true;
        });

        const sortedByMomentum = normal.sort((a, b) => {
          const scoreA = calcMomentumScore(extractMomentumInput(a)).total;
          const scoreB = calcMomentumScore(extractMomentumInput(b)).total;
          return scoreB - scoreA;
        });

        for (const sig of sortedByMomentum.slice(0, currentSlots)) {
          // 시간대×국면 조합 + 매크로충격 + 변동성 보정
          const finalSizePct = Math.max(0.5, Math.min(4,
            comboSizePct * macroSizeMultiplier * stratCtx.effectivePosMultiplier
          ));
          const volAdjustedConfig: BotConfig = {
            ...config,
            positionSizePct: finalSizePct,
            ...(comboSlPct ? { stopLossPct: comboSlPct } : {}),
          };
          await enterPosition(creds, sig, state, volAdjustedConfig, false, liveBybitSymbols);
          usedSymbols.add(sig.bybitSymbol);
        }
      }

      // 급등봇 신호 진입
      if (state.surgeRunning && _cachedSurgeSignals.length > 0) {
        const filteredSurge = _cachedSurgeSignals.filter(s =>
          !liveBybitSymbols.has(s.bybitSymbol) &&
          !state.positions.some(p => p.bybitSymbol === s.bybitSymbol) &&
          !excludeSet.has(s.bybitSymbol) &&
          !usedSymbols.has(s.bybitSymbol) &&
          !(newsBlockLong && s.direction === 'LONG') &&   // Claude v47 자가검증
          !(newsBlockShort && s.direction === 'SHORT')    // Claude v47 자가검증
        );
        const surgeSlots = effectiveMaxPositions - state.positions.length;
        for (const sig of filteredSurge.slice(0, Math.max(0, surgeSlots))) {
          await enterPosition(creds, sig, state, config, sig.confidence >= 95, liveBybitSymbols, sig._sectionType);
          usedSymbols.add(sig.bybitSymbol);
        }
      }
    }

    // ── 복리/포트폴리오 위험도/안전인출 상태 업데이트 ──
    try {
      const latestBal = await getBalance(creds);

      // 복리 상태
      if (state.baseBalance && state.baseBalance > 0) {
        const cs = calcCompoundingState(
          state.baseBalance,
          latestBal.totalBalance,
          state.dailyPnlPct ?? 0,
          _serverConfig.positionSizePct ?? 2,
        );
        state.compoundMultiplier = Math.round(cs.compoundMultiplier * 100) / 100;
        state.totalPnlPctAll = Math.round(cs.totalPnlPct * 10) / 10;
      }

      // 포트폴리오 강제청산 위험도
      state.portfolioLiqRisk = calcPortfolioLiqRisk(
        state.positions.map(p => ({
          pnlPct: p.pnlPct,
          leverage: p.leverage,
          initialMarginUsdt: p.initialMarginUsdt,
        })),
        latestBal.totalBalance,
        latestBal.mmrPct,
      );

      // 강제청산 위험도 경보
      if ((state.portfolioLiqRisk ?? 0) >= 70) {
        addLog(state, 'ERROR',
          `⛔ [강제청산 위험] 포트폴리오 위험도 ${state.portfolioLiqRisk}% — 즉각 포지션 축소 권고`);
        await notifyOwner({
          title: '⛔ 강제청산 위험 경보',
          content: `포트폴리오 위험도 ${state.portfolioLiqRisk}% — MMR ${latestBal.mmrPct.toFixed(1)}% | 포지션 ${state.positions.length}개`,
        }).catch(() => {});
      } else if ((state.portfolioLiqRisk ?? 0) >= 50) {
        addLog(state, 'WARN',
          `🟡 [위험 주의] 포트폴리오 위험도 ${state.portfolioLiqRisk}%`);
      }

      // 안전 인출 정보 업데이트
      state.withdrawalSafety = calcSafeWithdrawal(
        latestBal.totalBalance,
        latestBal.availableBalance,
        latestBal.mmrPct,
        state.positions.reduce((s, p) => s + (p.initialMarginUsdt ?? 0), 0),
        state.positions.map(p => ({
          pnlPct: p.pnlPct,
          leverage: p.leverage,
          initialMarginUsdt: p.initialMarginUsdt,
          sourceType: p.sourceType,
        })),
        {
          positionSizePct: _serverConfig.positionSizePct ?? 2,
          maxPositions: _serverConfig.maxPositions ?? 10,
          defaultLeverage: _serverConfig.defaultLeverage ?? 10,
        },
      );
    } catch { /* 무시 */ }

    // ── 24시간 일일 목표 모드 업데이트 (AI 검증 v44: 1.5% 안정 / 3% 적극 / 5% 최상) ──
    const nowHour = new Date().getHours();
    const nowMin = new Date().getMinutes();
    const minutesUntilMidnight = (23 - nowHour) * 60 + (60 - nowMin);
    const currentDailyPnlPct = state.dailyPnlPct ?? 0;
    const targetPct = state.dailyTargetPct ?? 5;
    const prevMode = state.dailyMode;

    if (currentDailyPnlPct >= targetPct) {
      // 목표 달성 → 보수 모드
      if (prevMode !== 'CONSERVATIVE') {
        state.dailyMode = 'CONSERVATIVE';
        state.dailyModeReason = `일일 ${targetPct}% 목표 달성 (${currentDailyPnlPct.toFixed(1)}%) → 보수 모드 전환`;
        state.dailyTargetAchievedAt = Date.now();
        addLog(state, 'INFO', `🎉 [${targetPct}% 목표 달성] ${currentDailyPnlPct.toFixed(1)}% 달성 → 보수 모드 전환 (신뢰도 90%+ 전용)`);
        await notifyOwner({
          title: `🎉 일일 ${targetPct}% 목표 달성!`,
          content: `오늘 수익 ${currentDailyPnlPct.toFixed(1)}% 달성 → 보수 모드로 전환하여 수익을 지킵니다`,
        }).catch(() => {});
      }
    } else if (minutesUntilMidnight <= 120 && currentDailyPnlPct < targetPct) {
      // 자정 2시간 전, 목표 미달 → 마감 스프린트
      if (prevMode !== 'SPRINT') {
        state.dailyMode = 'SPRINT';
        state.dailyModeReason = `자정 ${minutesUntilMidnight}분 전, ${currentDailyPnlPct.toFixed(1)}% / ${targetPct}% → 마감 스프린트`;
        state.sprintActivatedAt = Date.now();
        addLog(state, 'WARN', `⚡ [마감 스프린트] 자정 ${minutesUntilMidnight}분 남음 | ${currentDailyPnlPct.toFixed(1)}% / ${targetPct}% 진행 → 신뢰도 82%+, 포지션 4% 활성화`);
        await notifyOwner({
          title: '⚡ 마감 스프린트 활성화',
          content: `자정 ${minutesUntilMidnight}분 남음 | 현재 ${currentDailyPnlPct.toFixed(1)}% | 목표 ${targetPct}% 달성을 위해 스프린트 모드 진입`,
        }).catch(() => {});
      }
    } else if (prevMode !== 'AGGRESSIVE' && currentDailyPnlPct < targetPct && minutesUntilMidnight > 120) {
      // 일반 공격 모드
      state.dailyMode = 'AGGRESSIVE';
      state.dailyModeReason = `일일 ${currentDailyPnlPct.toFixed(1)}% / ${targetPct}% 진행 중 — 공격 모드`;
    }

    // 마감 스프린트 모드: 신뢰도 기준 82%+, 포지션 크기 4%
    // (실제 적용은 enterPosition 호출 시 config 오버라이드로 처리)
    if (state.dailyMode === 'SPRINT') {
      _serverConfig = { ..._serverConfig, entryConfidenceMin: 82, positionSizePct: 4 };
    } else if (state.dailyMode === 'CONSERVATIVE') {
      _serverConfig = { ..._serverConfig, entryConfidenceMin: 90, positionSizePct: 2 };
    } else {
      _serverConfig = { ..._serverConfig, entryConfidenceMin: 85, positionSizePct: _serverConfig.positionSizePct ?? 2 };
    }

    addLog(state, 'INFO',
      `틱 완료 | 활성 ${state.positions.length}개 | 청산 ${closed.length}개 | 오늘 ${currentDailyPnlPct.toFixed(1)}%/${targetPct}% [${state.dailyMode}] | 누적 ${(state.totalPnlPctAll ?? 0).toFixed(1)}% | 위험도 ${state.portfolioLiqRisk ?? 0}%`);
  } catch (e) {
    addLog(state, 'ERROR', `틱 오류: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ─── 봇 시작/정지 ────────────────────────────────────────────────────────────

export async function startServerNormalBot(): Promise<{ success: boolean; message: string }> {
  const state = _serverState;
  if (state.normalRunning) return { success: false, message: '일반봇이 이미 실행 중입니다.' };

  const creds = _serverCreds;
  if (!creds?.apiKey) return { success: false, message: 'API 키가 설정되지 않았습니다.' };

  state.normalRunning = true;
  state.running = true;
  addLog(state, 'INFO', '[일반봇] 시작 — TOP7 스캘핑 분석 중...');

  await detectPositionMode(creds);

  // 복리 기준점 설정 (최초 시작 시만)
  try {
    const bal = await getBalance(creds);
    if (!state.baseBalance || state.baseBalance <= 0) {
      state.baseBalance = bal.totalBalance;
      addLog(state, 'INFO', `[복리 기준] 초기 잔고 ${bal.totalBalance.toFixed(2)} USDT 설정`);
    }
  } catch (_) { /* ignore */ }

  try {
    const cancelled = await cancelAllOpenOrders(creds);
    if (cancelled > 0) addLog(state, 'INFO', `미체결 주문 ${cancelled}개 취소 완료`);
  } catch (e) {
    addLog(state, 'WARN', `미체결 취소 오류: ${e instanceof Error ? e.message : String(e)}`);
  }

  const config = _serverConfig;
  const liveBybitSymbols = await detectManualTrades(creds, state);

  try {
    const signals = await getTopScalpingSignals();
    addLog(state, 'INFO', `[일반봇] 신뢰도 85%+ 종목 ${signals.length}개 확인`);
    const excludeSet = new Set(_excludeList);
    const filteredSignals = signals.filter(s =>
      !liveBybitSymbols.has(s.bybitSymbol) && !excludeSet.has(s.bybitSymbol)
    );
    const usedSymbols = new Set<string>();
    const highConf = filteredSignals.filter(s => s.confidence >= 95);
    for (const sig of highConf) {
      await enterPosition(creds, sig, state, config, true, liveBybitSymbols);
      usedSymbols.add(sig.bybitSymbol);
    }
    const remaining = filteredSignals.filter(s => s.confidence < 95 && !usedSymbols.has(s.bybitSymbol));
    const slots = config.maxPositions - state.positions.length;
    for (const sig of remaining.slice(0, Math.max(0, slots))) {
      await enterPosition(creds, sig, state, config, false, liveBybitSymbols);
    }
    addLog(state, 'INFO', `[일반봇] 가동 | 활성 포지션 ${state.positions.length}개`);
  } catch (e) {
    addLog(state, 'ERROR', `[일반봇] 시작 오류: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { success: true, message: `일반봇 시작 완료. 활성 포지션 ${state.positions.length}개` };
}

export async function stopServerNormalBot(): Promise<{ success: boolean; message: string }> {
  const state = _serverState;
  state.normalRunning = false;
  if (!state.surgeRunning) state.running = false;
  addLog(state, 'INFO', '[일반봇] 정지. 기존 포지션은 유지됩니다.');
  return { success: true, message: '일반봇 정지 완료.' };
}

export async function startServerSurgeBot(): Promise<{ success: boolean; message: string }> {
  const state = _serverState;
  if (state.surgeRunning) return { success: false, message: '급등봇이 이미 실행 중입니다.' };

  const creds = _serverCreds;
  if (!creds?.apiKey) return { success: false, message: 'API 키가 설정되지 않았습니다.' };

  state.surgeRunning = true;
  state.running = true;
  addLog(state, 'INFO', '[급등봇] 시작 — 급등락+급등직전 분석 중...');

  await detectPositionMode(creds);

  const config = _serverConfig;
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

    const excludeSet = new Set(_excludeList);
    const filteredSurge = allSurgeSignals.filter(s =>
      !liveBybitSymbols.has(s.bybitSymbol) &&
      !state.positions.some(p => p.bybitSymbol === s.bybitSymbol) &&
      !excludeSet.has(s.bybitSymbol)
    );
    const slots = config.maxPositions - state.positions.length;
    for (const sig of filteredSurge.slice(0, Math.max(0, slots))) {
      await enterPosition(creds, sig, state, config, sig.confidence >= 95, liveBybitSymbols, sig._sectionType);
    }
    addLog(state, 'INFO', `[급등봇] 가동 | 활성 포지션 ${state.positions.length}개`);
  } catch (e) {
    addLog(state, 'ERROR', `[급등봇] 시작 오류: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { success: true, message: `급등봇 시작 완료. 활성 포지션 ${state.positions.length}개` };
}

export async function stopServerSurgeBot(): Promise<{ success: boolean; message: string }> {
  const state = _serverState;
  state.surgeRunning = false;
  if (!state.normalRunning) state.running = false;
  addLog(state, 'INFO', '[급등봇] 정지. 기존 포지션은 유지됩니다.');
  return { success: true, message: '급등봇 정지 완료.' };
}

export async function startServerPresurgeBot(): Promise<{ success: boolean; message: string }> {
  const state = _serverState;
  if (state.presurgeRunning) return { success: false, message: '급상승직전봇이 이미 실행 중입니다.' };

  const creds = _serverCreds;
  if (!creds?.apiKey) return { success: false, message: 'API 키가 설정되지 않았습니다.' };

  state.presurgeRunning = true;
  state.running = true;
  addLog(state, 'INFO', '[급상승직전봇] 시작 — 17가지 신호 스코어링 분석 중...');

  await detectPositionMode(creds);

  const config = _serverConfig;
  const liveBybitSymbols = await detectManualTrades(creds, state);

  try {
    const preSurgeSignals = await getPreSurgeTop10();
    _cachedPresurgeSignals = preSurgeSignals;
    addLog(state, 'INFO', `[급상승직전봇] 급상승직전 후보 ${preSurgeSignals.length}개 확인 (스코어 상위순)`);

    const excludeSet = new Set(_excludeList);
    // 신뢰도 80%+ 후보만 진입 (급상승직전봇는 장기보유 전략 — 신중하게 진입)
    const filteredPresurge = preSurgeSignals.filter(s =>
      s.confidence >= 80 &&
      !liveBybitSymbols.has(s.bybitSymbol) &&
      !state.positions.some(p => p.bybitSymbol === s.bybitSymbol) &&
      !excludeSet.has(s.bybitSymbol)
    );

    const presurgeConfig: BotConfig = {
      ...config,
      // 급상승직전봇 전용: 낙은 레버리지, 작은 포지션, 넓은 손절 허용
      presurgeLeverage: config.presurgeLeverage ?? 3,
      positionSizePct: 1.5,
      maxPositions: config.presurgeMaxPositions ?? 5,
    };

    const slots = presurgeConfig.maxPositions - state.positions.filter(p => p.sourceType === 'presurge').length;
    for (const sig of filteredPresurge.slice(0, Math.max(0, slots))) {
      await enterPosition(creds, sig, state, presurgeConfig, sig.confidence >= 90, liveBybitSymbols, 'presurge');
    }
    addLog(state, 'INFO', `[급상승직전봇] 가동 | 활성 포지션 ${state.positions.filter(p => p.sourceType === 'presurge').length}개`);
  } catch (e) {
    addLog(state, 'ERROR', `[급상승직전봇] 시작 오류: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { success: true, message: `급상승직전봇 시작 완료. 활성 포지션 ${state.positions.filter(p => p.sourceType === 'presurge').length}개` };
}

export async function stopServerPresurgeBot(): Promise<{ success: boolean; message: string }> {
  const state = _serverState;
  state.presurgeRunning = false;
  if (!state.normalRunning && !state.surgeRunning) state.running = false;
  addLog(state, 'INFO', '[급상승직전봇] 정지. 급상승직전 포지션은 장기보유 전략으로 유지됩니다.');
  return { success: true, message: '급상승직전봇 정지 완료.' };
}

export async function stopAllServerBots(): Promise<{ success: boolean; message: string }> {
  const state = _serverState;
  state.normalRunning = false;
  state.surgeRunning = false;
  state.running = false;
  addLog(state, 'INFO', '모든 봇 정지. 기존 포지션은 유지됩니다.');
  return { success: true, message: '모든 봇 정지 완료.' };
}

// ─── 포지션 수동 제거 ─────────────────────────────────────────────────────────

export function removeServerPosition(bybitSymbol: string): void {
  _serverState.positions = _serverState.positions.filter(p => p.bybitSymbol !== bybitSymbol);
}

// ─── 급등락 전략 전환 ─────────────────────────────────────────────────────────

export function convertServerPositionToSurge(bybitSymbol: string): { success: boolean; message: string } {
  const pos = _serverState.positions.find(p => p.bybitSymbol === bybitSymbol);
  if (!pos) return { success: false, message: '해당 포지션을 찾을 수 없습니다.' };
  if (pos.sourceType === 'surge') return { success: false, message: '이미 급등락 전략으로 운영 중입니다.' };
  pos.sourceType = 'surge';
  pos.nextActionPct = 15;
  pos.lastAnalyzedPnlPct = undefined;
  addLog(_serverState, 'INFO',
    `[급등락 전환] ${pos.displaySymbol} → surge | 손절 -15% / 익절 +20% 적용`);
  return { success: true, message: `${pos.displaySymbol} 급등락 전략 전환 완료!` };
}

// ─── 자동 신규진입 토글 ─────────────────────────────────────────────────────

export function toggleServerAutoEntry(): { autoEntry: boolean } {
  _serverState.autoEntry = !_serverState.autoEntry;
  addLog(_serverState, 'INFO',
    _serverState.autoEntry ? '[자동진입] 활성화' : '[자동진입] 일시정지 — 기존 포지션 관리만 계속');
  return { autoEntry: _serverState.autoEntry };
}

// ─── 수동 틱 트리거 ──────────────────────────────────────────────────────────

export async function triggerServerManualTick(): Promise<{ success: boolean; message: string }> {
  if (!_serverState.running) {
    return { success: false, message: '봇이 실행 중이 아닙니다.' };
  }
  try {
    await serverBotTick();
    return { success: true, message: '수동 분석 완료' };
  } catch (e) {
    return { success: false, message: `수동 분석 오류: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ─── 틱 루프 등록/해제 ───────────────────────────────────────────────────────

export function startServerBotLoop(): void {
  if (_tickInterval) return;
  console.log('[ServerBot] 봇 틱 루프 시작 (1분 간격)');
  // 서버 시작 시 심볼 메타 미리 로드 (첫 틱 오류 방지)
  loadAllSymbolMeta(false).then(meta => {
    console.log(`[ServerBot] 심볼 메타 warm-up 완료: ${meta.size}개`);
  }).catch(e => {
    console.warn('[ServerBot] 심볼 메타 warm-up 실패 (첫 틱에서 재시도):', e instanceof Error ? e.message : String(e));
  });
  _tickInterval = setInterval(async () => {
    try {
      await serverBotTick();
    } catch (e) {
      console.error('[ServerBot] 틱 루프 오류:', e);
    }
  }, BOT_TICK_INTERVAL_MS);
}

export function stopServerBotLoop(): void {
  if (_tickInterval) {
    clearInterval(_tickInterval);
    _tickInterval = null;
    console.log('[ServerBot] 봇 틱 루프 중지');
  }
}
