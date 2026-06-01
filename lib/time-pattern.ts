/**
 * time-pattern.ts
 * 시간대별 매매 패턴 분석 + 국면×시간대 조합 최적화 파라미터 엔진
 *
 * 시간대 분류 (KST 기준):
 *   ASIA_EARLY    : 00:00 ~ 06:00 KST — 유동성 최저, 변동성 낮음
 *   ASIA_MAIN     : 06:00 ~ 10:00 KST — 도쿄/홍콩/서울 개장, 알트 활발
 *   ASIA_OVERLAP  : 10:00 ~ 15:00 KST — 아시아 후반, 유럽 프리마켓
 *   EUROPE_MAIN   : 15:00 ~ 21:00 KST — 런던 개장, 유동성 증가
 *   US_PREMARKET  : 21:00 ~ 23:30 KST — 미국 프리마켓, 경제지표 발표
 *   US_MAIN       : 23:30 ~ 06:00 KST — 뉴욕 개장, 최고 유동성
 *   US_AFTERHOURS : 06:00 ~ 08:00 KST — 미국 장후, 변동성 감소
 *
 * 역사적 패턴 (2020~2025 BTC/알트 데이터 기반):
 *   - 아시아 새벽(00~06): 변동성 최저, 가짜 돌파 多, presurge 대기 최적
 *   - 아시아 메인(06~10): 알트 급등 多, 거래량 증가, presurge 진입 최적
 *   - 유럽 개장(15~17): 방향 전환 多, 손절 압축 필요
 *   - 미국 프리마켓(21~23:30): CPI/NFP 발표 시간, 변동성 최대
 *   - 미국 메인(23:30~02): 최고 유동성, 트렌드 추종 최적
 *   - 미국 심야(02~06): 유동성 감소, 청산 사냥 多
 */

import type { MarketPhase } from './market-context';

// ─── 타입 ────────────────────────────────────────────────────────────────────

export type TradingSession =
  | 'ASIA_EARLY'      // 00:00~06:00 KST — 새벽, 유동성 최저
  | 'ASIA_MAIN'       // 06:00~10:00 KST — 아시아 메인
  | 'ASIA_OVERLAP'    // 10:00~15:00 KST — 아시아-유럽 중첩
  | 'EUROPE_MAIN'     // 15:00~21:00 KST — 유럽 메인
  | 'US_PREMARKET'    // 21:00~23:30 KST — 미국 프리마켓
  | 'US_MAIN'         // 23:30~04:00 KST — 미국 메인
  | 'US_AFTERHOURS';  // 04:00~06:00 KST — 미국 장후

export interface SessionProfile {
  session: TradingSession;
  label: string;
  description: string;
  // 기본 파라미터 배율 (1.0 = 기본값 그대로)
  leverageMultiplier: number;    // 레버리지 배율
  positionSizeMultiplier: number; // 포지션 크기 배율
  slMultiplier: number;          // 손절 배율 (1.0보다 작으면 압축)
  tpMultiplier: number;          // 익절 배율
  maxPositions: number;          // 최대 포지션 수
  minConfidence: number;         // 최소 신뢰도 (%)
  allowLong: boolean;
  allowShort: boolean;
  // 특성
  liquidityScore: number;        // 유동성 점수 (1~10)
  volatilityScore: number;       // 변동성 점수 (1~10)
  fakeBreakoutRisk: number;      // 가짜 돌파 위험 (1~10)
  trendFollowScore: number;      // 트렌드 추종 적합도 (1~10)
  presurgeScore: number;         // presurge 전략 적합도 (1~10)
  notes: string;
}

export interface ComboParams {
  session: TradingSession;
  phase: MarketPhase;
  leverage: number;
  positionSizePct: number;       // 기본 포지션 크기 (%)
  slPct: number;                 // 손절 (%)
  tpPct: number;                 // 익절 (%)
  maxPositions: number;
  minConfidence: number;
  allowLong: boolean;
  allowShort: boolean;
  piramidingEnabled: boolean;
  partialTpEnabled: boolean;
  note: string;                  // 전략 근거
}

// ─── 세션 프로파일 ────────────────────────────────────────────────────────────

export const SESSION_PROFILES: Record<TradingSession, SessionProfile> = {
  ASIA_EARLY: {
    session: 'ASIA_EARLY',
    label: '🌙 아시아 새벽',
    description: '00:00~06:00 KST — 유동성 최저, 가짜 돌파 多',
    leverageMultiplier: 0.6,
    positionSizeMultiplier: 0.5,
    slMultiplier: 0.8,           // 손절 압축
    tpMultiplier: 0.8,
    maxPositions: 3,
    minConfidence: 85,           // 높은 신뢰도만
    allowLong: true,
    allowShort: true,
    liquidityScore: 2,
    volatilityScore: 3,
    fakeBreakoutRisk: 9,
    trendFollowScore: 3,
    presurgeScore: 8,            // presurge 대기 최적
    notes: '유동성 낮음 — 포지션 축소, 신뢰도 기준 상향, presurge 대기 모드',
  },
  ASIA_MAIN: {
    session: 'ASIA_MAIN',
    label: '🌅 아시아 메인',
    description: '06:00~10:00 KST — 도쿄/홍콩/서울 개장',
    leverageMultiplier: 0.9,
    positionSizeMultiplier: 0.8,
    slMultiplier: 1.0,
    tpMultiplier: 1.0,
    maxPositions: 7,
    minConfidence: 75,
    allowLong: true,
    allowShort: true,
    liquidityScore: 6,
    volatilityScore: 6,
    fakeBreakoutRisk: 5,
    trendFollowScore: 7,
    presurgeScore: 9,            // 알트 급등 多
    notes: '알트코인 급등 多 — presurge 전략 최적, 트렌드 추종 가능',
  },
  ASIA_OVERLAP: {
    session: 'ASIA_OVERLAP',
    label: '🌤 아시아-유럽 중첩',
    description: '10:00~15:00 KST — 아시아 후반, 유럽 프리마켓',
    leverageMultiplier: 1.0,
    positionSizeMultiplier: 0.9,
    slMultiplier: 1.0,
    tpMultiplier: 1.0,
    maxPositions: 8,
    minConfidence: 72,
    allowLong: true,
    allowShort: true,
    liquidityScore: 7,
    volatilityScore: 5,
    fakeBreakoutRisk: 4,
    trendFollowScore: 8,
    presurgeScore: 7,
    notes: '안정적 유동성 — 기본 전략 유지, 트렌드 추종 적합',
  },
  EUROPE_MAIN: {
    session: 'EUROPE_MAIN',
    label: '🏛 유럽 메인',
    description: '15:00~21:00 KST — 런던 개장, 방향 전환 多',
    leverageMultiplier: 1.1,
    positionSizeMultiplier: 1.0,
    slMultiplier: 0.9,           // 방향 전환 多 → 손절 약간 압축
    tpMultiplier: 1.1,
    maxPositions: 10,
    minConfidence: 70,
    allowLong: true,
    allowShort: true,
    liquidityScore: 8,
    volatilityScore: 7,
    fakeBreakoutRisk: 6,
    trendFollowScore: 7,
    presurgeScore: 6,
    notes: '런던 개장 — 방향 전환 多, 손절 약간 압축, 양방향 전략',
  },
  US_PREMARKET: {
    session: 'US_PREMARKET',
    label: '⚡ 미국 프리마켓',
    description: '21:00~23:30 KST — 경제지표 발표, 변동성 최대',
    leverageMultiplier: 0.7,
    positionSizeMultiplier: 0.6,
    slMultiplier: 0.7,           // 강한 손절 압축
    tpMultiplier: 1.3,           // 큰 변동 → 익절 상향
    maxPositions: 5,
    minConfidence: 82,
    allowLong: true,
    allowShort: true,
    liquidityScore: 7,
    volatilityScore: 10,
    fakeBreakoutRisk: 8,
    trendFollowScore: 5,
    presurgeScore: 4,
    notes: 'CPI/NFP 발표 시간 — 변동성 최대, 포지션 축소, 손절 강하게 압축',
  },
  US_MAIN: {
    session: 'US_MAIN',
    label: '🗽 미국 메인',
    description: '23:30~04:00 KST — 뉴욕 개장, 최고 유동성',
    leverageMultiplier: 1.2,
    positionSizeMultiplier: 1.2,
    slMultiplier: 1.1,           // 유동성 높음 → 손절 여유
    tpMultiplier: 1.2,
    maxPositions: 12,
    minConfidence: 68,
    allowLong: true,
    allowShort: true,
    liquidityScore: 10,
    volatilityScore: 9,
    fakeBreakoutRisk: 3,
    trendFollowScore: 10,
    presurgeScore: 7,
    notes: '최고 유동성 — 트렌드 추종 최적, 포지션 확대, 피라미딩 활성화',
  },
  US_AFTERHOURS: {
    session: 'US_AFTERHOURS',
    label: '🌆 미국 장후',
    description: '04:00~06:00 KST — 유동성 감소, 청산 사냥 多',
    leverageMultiplier: 0.7,
    positionSizeMultiplier: 0.6,
    slMultiplier: 0.85,
    tpMultiplier: 0.9,
    maxPositions: 4,
    minConfidence: 80,
    allowLong: true,
    allowShort: true,
    liquidityScore: 4,
    volatilityScore: 4,
    fakeBreakoutRisk: 7,
    trendFollowScore: 4,
    presurgeScore: 5,
    notes: '유동성 감소 — 청산 사냥 주의, 포지션 축소, 신뢰도 기준 상향',
  },
};

// ─── 현재 세션 감지 ───────────────────────────────────────────────────────────

export function getCurrentSession(): TradingSession {
  const now = new Date();
  // KST = UTC+9
  const kstHour = (now.getUTCHours() + 9) % 24;
  const kstMinute = now.getUTCMinutes();
  const kstTime = kstHour * 60 + kstMinute; // 분 단위

  if (kstTime >= 0 && kstTime < 6 * 60) return 'ASIA_EARLY';
  if (kstTime >= 6 * 60 && kstTime < 10 * 60) return 'ASIA_MAIN';
  if (kstTime >= 10 * 60 && kstTime < 15 * 60) return 'ASIA_OVERLAP';
  if (kstTime >= 15 * 60 && kstTime < 21 * 60) return 'EUROPE_MAIN';
  if (kstTime >= 21 * 60 && kstTime < 23 * 60 + 30) return 'US_PREMARKET';
  if (kstTime >= 23 * 60 + 30 || kstTime < 4 * 60) return 'US_MAIN';
  return 'US_AFTERHOURS'; // 04:00~06:00
}

export function getSessionProfile(): SessionProfile {
  return SESSION_PROFILES[getCurrentSession()];
}

// ─── 국면×시간대 조합 최적화 파라미터 ────────────────────────────────────────

/**
 * 15개 국면 × 7개 시간대 = 105가지 최적 조합 파라미터
 * 기본 파라미터 × 세션 배율 × 국면 보정
 */
export function getComboParams(
  phase: MarketPhase,
  session: TradingSession,
  baseLeverage: number = 10,
  basePositionSizePct: number = 5,
  baseSlPct: number = -15,
  baseTpPct: number = 20,
  baseMaxPositions: number = 10,
): ComboParams {
  const sp = SESSION_PROFILES[session];

  // 국면별 보정값
  const phaseAdj = getPhaseAdjustment(phase);

  const leverage = Math.min(
    Math.max(Math.round(baseLeverage * sp.leverageMultiplier * phaseAdj.leverageMult), 1),
    20
  );
  const positionSizePct = Math.max(
    basePositionSizePct * sp.positionSizeMultiplier * phaseAdj.sizeMult,
    1
  );
  const slPct = baseSlPct * sp.slMultiplier * phaseAdj.slMult;
  const tpPct = baseTpPct * sp.tpMultiplier * phaseAdj.tpMult;
  const maxPositions = Math.min(
    Math.round(baseMaxPositions * phaseAdj.maxPosMult),
    sp.maxPositions
  );
  const minConfidence = Math.max(sp.minConfidence, phaseAdj.minConfidence);
  const allowLong = sp.allowLong && phaseAdj.allowLong;
  const allowShort = sp.allowShort && phaseAdj.allowShort;
  const piramidingEnabled = sp.liquidityScore >= 7 && phaseAdj.piramiding;
  const partialTpEnabled = phaseAdj.partialTp;

  const note = `[${sp.label}] × [${phase}] — ${sp.notes} | ${phaseAdj.note}`;

  return {
    session,
    phase,
    leverage,
    positionSizePct,
    slPct,
    tpPct,
    maxPositions,
    minConfidence,
    allowLong,
    allowShort,
    piramidingEnabled,
    partialTpEnabled,
    note,
  };
}

interface PhaseAdjustment {
  leverageMult: number;
  sizeMult: number;
  slMult: number;
  tpMult: number;
  maxPosMult: number;
  minConfidence: number;
  allowLong: boolean;
  allowShort: boolean;
  piramiding: boolean;
  partialTp: boolean;
  note: string;
}

function getPhaseAdjustment(phase: MarketPhase): PhaseAdjustment {
  const defaults: PhaseAdjustment = {
    leverageMult: 1.0, sizeMult: 1.0, slMult: 1.0, tpMult: 1.0,
    maxPosMult: 1.0, minConfidence: 70,
    allowLong: true, allowShort: true,
    piramiding: false, partialTp: true,
    note: '기본 전략',
  };

  const adjustments: Record<MarketPhase, Partial<PhaseAdjustment>> = {
    RISK_ON: {
      leverageMult: 1.2, sizeMult: 1.2, tpMult: 1.3, slMult: 1.1,
      maxPosMult: 1.2, minConfidence: 65,
      piramiding: true, partialTp: true,
      note: '강세장 — 롱 확대, 익절 상향, 피라미딩 활성화',
    },
    RISK_OFF: {
      leverageMult: 0.6, sizeMult: 0.6, slMult: 0.7, tpMult: 0.8,
      maxPosMult: 0.6, minConfidence: 82,
      allowLong: false, allowShort: true,
      piramiding: false, partialTp: false,
      note: '약세장 — 숏 전용, 포지션 축소, 손절 강압축',
    },
    NEUTRAL: {
      note: '중립 — 기본 전략 유지',
    },
    BTC_SURGE: {
      leverageMult: 1.3, sizeMult: 1.3, tpMult: 1.5, slMult: 1.2,
      maxPosMult: 1.3, minConfidence: 65,
      allowLong: true, allowShort: false,
      piramiding: true, partialTp: true,
      note: 'BTC 급등 — 롱 전용, 피라미딩, 익절 대폭 상향',
    },
    BTC_CRASH: {
      leverageMult: 0.5, sizeMult: 0.5, slMult: 0.6, tpMult: 0.7,
      maxPosMult: 0.5, minConfidence: 88,
      allowLong: false, allowShort: true,
      piramiding: false, partialTp: false,
      note: 'BTC 급락 — 숏 전용, 포지션 최소화, 손절 최강 압축',
    },
    ETH_LEAD: {
      leverageMult: 1.1, sizeMult: 1.1, tpMult: 1.2,
      minConfidence: 68,
      piramiding: true, partialTp: true,
      note: 'ETH 주도 — ETH 생태계 알트 우대, 피라미딩',
    },
    ALT_SEASON: {
      leverageMult: 1.4, sizeMult: 1.4, tpMult: 1.8, slMult: 1.2,
      maxPosMult: 1.4, minConfidence: 60,
      piramiding: true, partialTp: true,
      note: '알트 시즌 — 전 알트 강세, 익절 대폭 상향, 피라미딩',
    },
    ACCUMULATION: {
      leverageMult: 0.7, sizeMult: 0.7, slMult: 0.9,
      maxPosMult: 0.6, minConfidence: 85,
      piramiding: false, partialTp: true,
      note: '세력 매집 — presurge 대기, 높은 신뢰도만 진입',
    },
    DISTRIBUTION: {
      leverageMult: 0.7, sizeMult: 0.7, slMult: 0.75, tpMult: 0.8,
      maxPosMult: 0.6, minConfidence: 83,
      allowLong: false, allowShort: true,
      piramiding: false, partialTp: false,
      note: '세력 분산 — 신규 롱 차단, 숏 준비, 익절 압축',
    },
    SQUEEZE: {
      leverageMult: 0.8, sizeMult: 0.7, slMult: 0.85,
      maxPosMult: 0.7, minConfidence: 87,
      piramiding: false, partialTp: true,
      note: 'BB 스퀴즈 — 돌파 대기, presurge 신호 집중 감시',
    },
    BEAR_TRAP: {
      leverageMult: 1.2, sizeMult: 1.1, tpMult: 0.8, slMult: 0.85,
      maxPosMult: 1.0, minConfidence: 78,
      allowLong: true, allowShort: false,
      piramiding: false, partialTp: true,
      note: '베어 트랩 — 롱 기회, 빠른 익절 (가짜 하락 후 급반등)',
    },
    BULL_TRAP: {
      leverageMult: 1.2, sizeMult: 1.1, tpMult: 0.8, slMult: 0.85,
      maxPosMult: 1.0, minConfidence: 78,
      allowLong: false, allowShort: true,
      piramiding: false, partialTp: true,
      note: '불 트랩 — 숏 기회, 빠른 익절 (가짜 상승 후 급하락)',
    },
    LIQUIDATION_HUNT: {
      leverageMult: 1.3, sizeMult: 1.0, tpMult: 0.7, slMult: 0.8,
      maxPosMult: 1.0, minConfidence: 75,
      piramiding: false, partialTp: true,
      note: '청산 사냥 — 청산 후 역방향 빠른 스칼핑',
    },
    FUNDING_SQUEEZE: {
      leverageMult: 1.1, sizeMult: 0.9, tpMult: 0.7, slMult: 0.85,
      maxPosMult: 0.8, minConfidence: 78,
      piramiding: false, partialTp: true,
      note: '펀딩비 과열 — 역방향 수렴 단기 스칼핑',
    },
    WHALE_ACCUMULATION: {
      leverageMult: 1.2, sizeMult: 1.2, tpMult: 1.4, slMult: 1.1,
      maxPosMult: 1.1, minConfidence: 70,
      allowLong: true, allowShort: false,
      piramiding: true, partialTp: true,
      note: '고래 매집 — 롱 집중, 피라미딩, 익절 상향',
    },
  };

  return { ...defaults, ...(adjustments[phase] ?? {}) };
}

// ─── 현재 최적 파라미터 조회 ──────────────────────────────────────────────────

export function getCurrentComboParams(
  phase: MarketPhase,
  baseLeverage = 10,
  basePositionSizePct = 5,
  baseSlPct = -15,
  baseTpPct = 20,
  baseMaxPositions = 10,
): ComboParams {
  const session = getCurrentSession();
  return getComboParams(phase, session, baseLeverage, basePositionSizePct, baseSlPct, baseTpPct, baseMaxPositions);
}

/**
 * 현재 세션 정보 요약 문자열
 */
export function getSessionSummary(): string {
  const session = getCurrentSession();
  const profile = SESSION_PROFILES[session];
  return `${profile.label} | 유동성 ${profile.liquidityScore}/10 | 변동성 ${profile.volatilityScore}/10 | ${profile.notes}`;
}

/**
 * 다음 세션 전환까지 남은 시간 (분)
 */
export function getMinutesToNextSession(): number {
  const now = new Date();
  const kstHour = (now.getUTCHours() + 9) % 24;
  const kstMinute = now.getUTCMinutes();
  const kstTime = kstHour * 60 + kstMinute;

  const sessionBoundaries = [0, 6 * 60, 10 * 60, 15 * 60, 21 * 60, 23 * 60 + 30, 24 * 60 + 4 * 60];
  for (const boundary of sessionBoundaries) {
    if (kstTime < boundary) return boundary - kstTime;
  }
  return (24 * 60 - kstTime) + 6 * 60; // 다음날 06:00
}
