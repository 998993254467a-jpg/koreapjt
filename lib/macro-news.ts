/**
 * macro-news.ts
 * 미국 경제지표 / 뉴스 / 정치 이벤트 실시간 감지 + 즉각 충격 대응 패턴 엔진
 *
 * 감지 대상:
 *   - CPI / PPI / PCE / NFP / GDP / ISM / 소매판매 등 주요 경제지표
 *   - FOMC 금리 결정 / 연준 의장 발언
 *   - 미국 대통령 / 정치인 암호화폐 관련 발언
 *   - 암호화폐 규제 뉴스 (SEC / CFTC / 의회)
 *   - 지정학적 리스크 (전쟁, 제재, 에너지 위기)
 *
 * 충격 대응 패턴:
 *   SPIKE_LONG   : 즉각 급등 → 롱 추격 진입
 *   SPIKE_SHORT  : 즉각 급락 → 숏 추격 진입
 *   PAUSE        : 신규 진입 일시 중단 (방향 불명확)
 *   TIGHTEN_SL   : 손절 압축 (기존 포지션 보호)
 *   CLOSE_ALL    : 전체 포지션 즉시 청산 (극단 리스크)
 *   WAIT_REVERSAL: 초기 충격 후 역방향 수렴 대기
 *   PYRAMID_LONG : 상승 확인 후 피라미딩 롱
 *   PYRAMID_SHORT: 하락 확인 후 피라미딩 숏
 */

// ─── 타입 ────────────────────────────────────────────────────────────────────

export type MacroShockLevel = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

export type MacroResponsePattern =
  | 'SPIKE_LONG'       // 즉각 급등 → 롱 추격
  | 'SPIKE_SHORT'      // 즉각 급락 → 숏 추격
  | 'PAUSE'            // 방향 불명확 → 신규 진입 중단
  | 'TIGHTEN_SL'       // 손절 압축 (기존 포지션 보호)
  | 'CLOSE_ALL'        // 전체 청산 (극단 리스크)
  | 'WAIT_REVERSAL'    // 초기 충격 후 역방향 수렴 대기
  | 'PYRAMID_LONG'     // 상승 확인 후 피라미딩
  | 'PYRAMID_SHORT';   // 하락 확인 후 피라미딩

export type MacroEventType =
  | 'CPI'              // 소비자물가지수
  | 'PPI'              // 생산자물가지수
  | 'PCE'              // 개인소비지출 물가
  | 'NFP'              // 비농업고용지수
  | 'GDP'              // GDP 성장률
  | 'FOMC'             // 연준 금리 결정
  | 'FED_SPEECH'       // 연준 의장/위원 발언
  | 'ISM'              // ISM 제조업/서비스업 지수
  | 'RETAIL_SALES'     // 소매판매
  | 'UNEMPLOYMENT'     // 실업률
  | 'CRYPTO_REGULATION'// 암호화폐 규제 뉴스
  | 'POLITICAL'        // 정치 이벤트 (대통령 발언 등)
  | 'GEOPOLITICAL'     // 지정학적 리스크
  | 'EXCHANGE_HACK'    // 거래소 해킹/파산
  | 'WHALE_MOVE'       // 고래 대규모 이동
  | 'ETF_FLOW'         // 비트코인 ETF 자금 흐름
  | 'STABLECOIN'       // 스테이블코인 이슈
  | 'OTHER';

export interface MacroEvent {
  id: string;
  type: MacroEventType;
  title: string;
  summary: string;
  shockLevel: MacroShockLevel;
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'UNKNOWN';
  responsePattern: MacroResponsePattern;
  responseDetail: string;       // 구체적 대응 지침
  pauseDurationMs: number;      // 신규 진입 중단 시간 (ms)
  slTightenPct?: number;        // 손절 압축 비율 (예: -8)
  detectedAt: number;           // 감지 시각 (ms)
  source: string;               // 뉴스 출처
  url?: string;
}

export interface MacroState {
  activeEvents: MacroEvent[];   // 현재 활성 이벤트
  lastCheckedAt: number;
  isShockActive: boolean;       // 충격 활성 여부
  currentShockLevel: MacroShockLevel;
  currentPattern: MacroResponsePattern | null;
  pauseUntil: number;           // 신규 진입 중단 종료 시각
  upcomingEvents: UpcomingEvent[]; // 예정 이벤트 (30분 이내)
}

export interface UpcomingEvent {
  type: MacroEventType;
  title: string;
  scheduledAt: number;          // 예정 시각 (ms)
  expectedImpact: MacroShockLevel;
  warningMessage: string;
}

// ─── 충격 대응 패턴 매트릭스 ─────────────────────────────────────────────────

/**
 * 이벤트 유형 × 방향 → 최적 대응 패턴
 *
 * 실제 역사적 데이터 기반:
 * - CPI 예상보다 낮음(긍정) → BTC 즉각 +3~8% → SPIKE_LONG
 * - CPI 예상보다 높음(부정) → BTC 즉각 -3~10% → SPIKE_SHORT (초기) → WAIT_REVERSAL (30분 후)
 * - FOMC 금리 동결/인하 → SPIKE_LONG → PYRAMID_LONG
 * - FOMC 금리 인상 → SPIKE_SHORT → WAIT_REVERSAL (시장 과잉반응 후 회복)
 * - NFP 강함 → 혼재 (인플레 우려 vs 경기 호조) → PAUSE
 * - 규제 뉴스 부정 → CLOSE_ALL (극단 리스크)
 * - 거래소 해킹 → CLOSE_ALL
 */
const RESPONSE_MATRIX: Record<MacroEventType, {
  bullish: MacroResponsePattern;
  bearish: MacroResponsePattern;
  neutral: MacroResponsePattern;
  pauseMs: number;
  slTighten?: number;
}> = {
  CPI: {
    bullish: 'SPIKE_LONG',      // 낮은 CPI → 금리 인하 기대 → 롱
    bearish: 'SPIKE_SHORT',     // 높은 CPI → 금리 인상 우려 → 숏
    neutral: 'PAUSE',
    pauseMs: 15 * 60 * 1000,    // 15분 대기
    slTighten: -8,
  },
  PPI: {
    bullish: 'SPIKE_LONG',
    bearish: 'TIGHTEN_SL',
    neutral: 'PAUSE',
    pauseMs: 10 * 60 * 1000,
    slTighten: -10,
  },
  PCE: {
    bullish: 'SPIKE_LONG',
    bearish: 'SPIKE_SHORT',
    neutral: 'PAUSE',
    pauseMs: 15 * 60 * 1000,
    slTighten: -8,
  },
  NFP: {
    bullish: 'PAUSE',           // 강한 고용 = 금리 인상 우려 혼재
    bearish: 'SPIKE_LONG',      // 약한 고용 = 금리 인하 기대 → 롱
    neutral: 'PAUSE',
    pauseMs: 20 * 60 * 1000,
    slTighten: -10,
  },
  GDP: {
    bullish: 'PYRAMID_LONG',
    bearish: 'TIGHTEN_SL',
    neutral: 'PAUSE',
    pauseMs: 10 * 60 * 1000,
  },
  FOMC: {
    bullish: 'PYRAMID_LONG',    // 금리 인하/동결 → 강한 롱
    bearish: 'WAIT_REVERSAL',   // 금리 인상 → 초기 급락 후 회복 대기
    neutral: 'PAUSE',
    pauseMs: 30 * 60 * 1000,    // 30분 대기 (가장 큰 이벤트)
    slTighten: -7,
  },
  FED_SPEECH: {
    bullish: 'SPIKE_LONG',
    bearish: 'TIGHTEN_SL',
    neutral: 'PAUSE',
    pauseMs: 10 * 60 * 1000,
    slTighten: -10,
  },
  ISM: {
    bullish: 'SPIKE_LONG',
    bearish: 'TIGHTEN_SL',
    neutral: 'PAUSE',
    pauseMs: 8 * 60 * 1000,
  },
  RETAIL_SALES: {
    bullish: 'SPIKE_LONG',
    bearish: 'PAUSE',
    neutral: 'PAUSE',
    pauseMs: 8 * 60 * 1000,
  },
  UNEMPLOYMENT: {
    bullish: 'PAUSE',
    bearish: 'SPIKE_LONG',      // 실업률 상승 = 금리 인하 기대
    neutral: 'PAUSE',
    pauseMs: 10 * 60 * 1000,
  },
  CRYPTO_REGULATION: {
    bullish: 'PYRAMID_LONG',    // 긍정 규제 (ETF 승인 등) → 강한 롱
    bearish: 'CLOSE_ALL',       // 부정 규제 → 전체 청산
    neutral: 'TIGHTEN_SL',
    pauseMs: 60 * 60 * 1000,    // 1시간 대기
    slTighten: -6,
  },
  POLITICAL: {
    bullish: 'SPIKE_LONG',
    bearish: 'TIGHTEN_SL',
    neutral: 'PAUSE',
    pauseMs: 15 * 60 * 1000,
    slTighten: -10,
  },
  GEOPOLITICAL: {
    bullish: 'PAUSE',
    bearish: 'CLOSE_ALL',       // 전쟁/제재 → 전체 청산
    neutral: 'TIGHTEN_SL',
    pauseMs: 30 * 60 * 1000,
    slTighten: -8,
  },
  EXCHANGE_HACK: {
    bullish: 'PAUSE',
    bearish: 'CLOSE_ALL',       // 거래소 해킹 → 즉시 전체 청산
    neutral: 'CLOSE_ALL',
    pauseMs: 2 * 60 * 60 * 1000, // 2시간 대기
    slTighten: -5,
  },
  WHALE_MOVE: {
    bullish: 'PYRAMID_LONG',    // 고래 대규모 매수 → 피라미딩
    bearish: 'TIGHTEN_SL',      // 고래 대규모 매도 → 손절 압축
    neutral: 'PAUSE',
    pauseMs: 5 * 60 * 1000,
  },
  ETF_FLOW: {
    bullish: 'PYRAMID_LONG',    // ETF 대규모 유입 → 강한 롱
    bearish: 'SPIKE_SHORT',     // ETF 대규모 유출 → 숏
    neutral: 'PAUSE',
    pauseMs: 10 * 60 * 1000,
  },
  STABLECOIN: {
    bullish: 'PAUSE',
    bearish: 'CLOSE_ALL',       // 스테이블코인 디페깅 → 전체 청산
    neutral: 'TIGHTEN_SL',
    pauseMs: 60 * 60 * 1000,
    slTighten: -6,
  },
  OTHER: {
    bullish: 'PAUSE',
    bearish: 'TIGHTEN_SL',
    neutral: 'PAUSE',
    pauseMs: 5 * 60 * 1000,
  },
};

// ─── 충격 강도 판단 ───────────────────────────────────────────────────────────

const SHOCK_LEVEL_BY_TYPE: Record<MacroEventType, MacroShockLevel> = {
  FOMC: 'CRITICAL',
  CPI: 'CRITICAL',
  NFP: 'HIGH',
  PCE: 'HIGH',
  CRYPTO_REGULATION: 'CRITICAL',
  EXCHANGE_HACK: 'CRITICAL',
  STABLECOIN: 'CRITICAL',
  GEOPOLITICAL: 'HIGH',
  GDP: 'HIGH',
  PPI: 'MEDIUM',
  FED_SPEECH: 'MEDIUM',
  ISM: 'MEDIUM',
  RETAIL_SALES: 'LOW',
  UNEMPLOYMENT: 'MEDIUM',
  POLITICAL: 'MEDIUM',
  WHALE_MOVE: 'MEDIUM',
  ETF_FLOW: 'HIGH',
  OTHER: 'LOW',
};

// ─── 키워드 감지 ──────────────────────────────────────────────────────────────

interface KeywordRule {
  type: MacroEventType;
  keywords: string[];
  bullishKeywords: string[];
  bearishKeywords: string[];
}

const KEYWORD_RULES: KeywordRule[] = [
  {
    type: 'CPI',
    keywords: ['CPI', 'consumer price', '소비자물가', 'inflation data', 'core CPI'],
    bullishKeywords: ['lower than expected', 'cooler', 'decline', 'fell', 'eased', '하락', '둔화'],
    bearishKeywords: ['higher than expected', 'hotter', 'surge', 'rose', 'accelerated', '상승', '가속'],
  },
  {
    type: 'PPI',
    keywords: ['PPI', 'producer price', '생산자물가'],
    bullishKeywords: ['lower', 'fell', 'decline', '하락'],
    bearishKeywords: ['higher', 'rose', 'surge', '상승'],
  },
  {
    type: 'PCE',
    keywords: ['PCE', 'personal consumption expenditure', '개인소비지출'],
    bullishKeywords: ['lower', 'fell', 'eased', '하락'],
    bearishKeywords: ['higher', 'rose', 'accelerated', '상승'],
  },
  {
    type: 'NFP',
    keywords: ['NFP', 'nonfarm payroll', 'jobs report', '비농업고용', 'payrolls'],
    bullishKeywords: ['weak', 'missed', 'below expectations', '예상 하회', '부진'],
    bearishKeywords: ['strong', 'beat', 'above expectations', '예상 상회', '강함'],
  },
  {
    type: 'GDP',
    keywords: ['GDP', 'gross domestic product', '국내총생산'],
    bullishKeywords: ['growth', 'beat', 'above', '성장', '상회'],
    bearishKeywords: ['contraction', 'recession', 'below', '침체', '하회'],
  },
  {
    type: 'FOMC',
    keywords: ['FOMC', 'Federal Reserve', 'Fed rate', '연준', '금리 결정', 'interest rate decision', 'rate hike', 'rate cut'],
    bullishKeywords: ['rate cut', 'pause', 'hold', 'dovish', '금리 인하', '동결', '비둘기'],
    bearishKeywords: ['rate hike', 'hawkish', 'tighten', '금리 인상', '매파'],
  },
  {
    type: 'FED_SPEECH',
    keywords: ['Powell', 'Fed chair', 'Federal Reserve statement', 'FOMC minutes', '파월', '연준 발언'],
    bullishKeywords: ['dovish', 'cut', 'pause', 'supportive', '비둘기', '인하'],
    bearishKeywords: ['hawkish', 'hike', 'tighten', 'inflation concern', '매파', '인상'],
  },
  {
    type: 'CRYPTO_REGULATION',
    keywords: ['SEC', 'CFTC', 'crypto regulation', 'bitcoin ETF', 'crypto ban', '암호화폐 규제', 'crypto law'],
    bullishKeywords: ['approved', 'approval', 'positive', 'legal', '승인', '허용', '합법'],
    bearishKeywords: ['banned', 'rejected', 'crackdown', 'lawsuit', '금지', '거부', '단속'],
  },
  {
    type: 'POLITICAL',
    keywords: ['Trump', 'Biden', 'White House', 'Congress', 'Senate', '트럼프', '바이든', '의회', 'executive order'],
    bullishKeywords: ['pro-crypto', 'support', 'positive', '친암호화폐', '지지'],
    bearishKeywords: ['anti-crypto', 'ban', 'tax', 'restrict', '반암호화폐', '세금', '제한'],
  },
  {
    type: 'GEOPOLITICAL',
    keywords: ['war', 'conflict', 'sanctions', 'military', '전쟁', '분쟁', '제재', '군사'],
    bullishKeywords: ['ceasefire', 'peace', 'resolved', '휴전', '평화'],
    bearishKeywords: ['escalation', 'attack', 'invasion', '확전', '공격', '침공'],
  },
  {
    type: 'EXCHANGE_HACK',
    keywords: ['hack', 'hacked', 'exploit', 'stolen', 'breach', '해킹', '해킹 당함', '탈취'],
    bullishKeywords: [],
    bearishKeywords: ['hack', 'stolen', 'exploit', '해킹', '탈취'],
  },
  {
    type: 'WHALE_MOVE',
    keywords: ['whale', 'large transfer', 'exchange inflow', 'exchange outflow', '고래', '대규모 이동'],
    bullishKeywords: ['outflow', 'accumulation', 'buy', '유출', '매집', '매수'],
    bearishKeywords: ['inflow', 'sell', 'dump', '유입', '매도', '덤핑'],
  },
  {
    type: 'ETF_FLOW',
    keywords: ['ETF inflow', 'ETF outflow', 'bitcoin ETF', 'spot ETF', 'ETF 유입', 'ETF 유출'],
    bullishKeywords: ['inflow', 'record', 'surge', '유입', '기록'],
    bearishKeywords: ['outflow', 'redemption', '유출', '환매'],
  },
  {
    type: 'STABLECOIN',
    keywords: ['USDT', 'USDC', 'stablecoin', 'depeg', 'Tether', '스테이블코인', '디페깅'],
    bullishKeywords: ['stable', 'recovered', '안정', '회복'],
    bearishKeywords: ['depeg', 'collapse', 'insolvent', '디페깅', '붕괴', '지급불능'],
  },
];

// ─── 캐시 ────────────────────────────────────────────────────────────────────

let _macroState: MacroState = {
  activeEvents: [],
  lastCheckedAt: 0,
  isShockActive: false,
  currentShockLevel: 'NONE',
  currentPattern: null,
  pauseUntil: 0,
  upcomingEvents: [],
};

const CHECK_INTERVAL_MS = 3 * 60 * 1000; // 3분마다 뉴스 체크

// ─── 뉴스 소스 ───────────────────────────────────────────────────────────────

interface NewsItem {
  title: string;
  summary: string;
  publishedAt: number;
  source: string;
  url: string;
}

async function fetchCryptoNews(): Promise<NewsItem[]> {
  const items: NewsItem[] = [];
  try {
    // CryptoPanic API (무료, 키 불필요)
    const res = await fetch(
      'https://cryptopanic.com/api/free/v1/posts/?auth_token=free&filter=hot&currencies=BTC,ETH&kind=news',
      { signal: AbortSignal.timeout(8000) }
    );
    if (res.ok) {
      const data = await res.json() as { results?: Array<{ title: string; published_at: string; source: { title: string }; url: string }> };
      for (const item of (data.results ?? []).slice(0, 20)) {
        items.push({
          title: item.title,
          summary: item.title,
          publishedAt: new Date(item.published_at).getTime(),
          source: item.source?.title ?? 'CryptoPanic',
          url: item.url,
        });
      }
    }
  } catch { /* 무시 */ }

  try {
    // CoinDesk RSS (CORS 우회용 공개 API)
    const res = await fetch(
      'https://api.rss2json.com/v1/api.json?rss_url=https://www.coindesk.com/arc/outboundfeeds/rss/',
      { signal: AbortSignal.timeout(8000) }
    );
    if (res.ok) {
      const data = await res.json() as { items?: Array<{ title: string; description: string; pubDate: string; link: string }> };
      for (const item of (data.items ?? []).slice(0, 10)) {
        items.push({
          title: item.title,
          summary: item.description?.replace(/<[^>]+>/g, '').slice(0, 200) ?? item.title,
          publishedAt: new Date(item.pubDate).getTime(),
          source: 'CoinDesk',
          url: item.link,
        });
      }
    }
  } catch { /* 무시 */ }

  return items.sort((a, b) => b.publishedAt - a.publishedAt);
}

// ─── 이벤트 분석 ──────────────────────────────────────────────────────────────

function analyzeNewsItem(item: NewsItem): MacroEvent | null {
  const text = `${item.title} ${item.summary}`.toLowerCase();
  const now = Date.now();

  // 5분 이내 뉴스만 처리 (오래된 뉴스 무시)
  if (now - item.publishedAt > 5 * 60 * 1000) return null;

  for (const rule of KEYWORD_RULES) {
    const hasKeyword = rule.keywords.some(k => text.includes(k.toLowerCase()));
    if (!hasKeyword) continue;

    const isBullish = rule.bullishKeywords.some(k => text.includes(k.toLowerCase()));
    const isBearish = rule.bearishKeywords.some(k => text.includes(k.toLowerCase()));

    const direction: MacroEvent['direction'] =
      isBullish && !isBearish ? 'BULLISH' :
      isBearish && !isBullish ? 'BEARISH' :
      isBullish && isBearish ? 'NEUTRAL' : 'UNKNOWN';

    const matrix = RESPONSE_MATRIX[rule.type];
    const responsePattern =
      direction === 'BULLISH' ? matrix.bullish :
      direction === 'BEARISH' ? matrix.bearish :
      matrix.neutral;

    const shockLevel = SHOCK_LEVEL_BY_TYPE[rule.type];

    const responseDetail = buildResponseDetail(rule.type, direction, responsePattern, matrix.pauseMs);

    return {
      id: `${rule.type}_${item.publishedAt}`,
      type: rule.type,
      title: item.title,
      summary: item.summary,
      shockLevel,
      direction,
      responsePattern,
      responseDetail,
      pauseDurationMs: matrix.pauseMs,
      slTightenPct: matrix.slTighten,
      detectedAt: now,
      source: item.source,
      url: item.url,
    };
  }

  return null;
}

function buildResponseDetail(
  type: MacroEventType,
  direction: MacroEvent['direction'],
  pattern: MacroResponsePattern,
  pauseMs: number,
): string {
  const pauseMin = Math.round(pauseMs / 60000);
  const dirLabel = direction === 'BULLISH' ? '긍정' : direction === 'BEARISH' ? '부정' : '불명확';

  const details: Record<MacroResponsePattern, string> = {
    SPIKE_LONG: `[${dirLabel}] 즉각 롱 진입 — BTC 방향 확인 후 신뢰도 85%+ 종목 우선 진입, 손절 -8%, 익절 +15%`,
    SPIKE_SHORT: `[${dirLabel}] 즉각 숏 진입 — BTC 하락 확인 후 신뢰도 85%+ 종목 우선 진입, 손절 -8%, 익절 +15%`,
    PAUSE: `[${dirLabel}] ${pauseMin}분간 신규 진입 중단 — 방향 확인 후 재개`,
    TIGHTEN_SL: `[${dirLabel}] 기존 포지션 손절 압축 — 현재가 기준 -8% 이내로 조정, ${pauseMin}분 대기`,
    CLOSE_ALL: `[${dirLabel}] ⚠️ 전체 포지션 즉시 청산 — ${type} 극단 리스크 감지, ${pauseMin}분 재진입 금지`,
    WAIT_REVERSAL: `[${dirLabel}] 초기 충격 후 역방향 수렴 대기 — ${pauseMin}분 후 반등/반락 신호 포착 시 진입`,
    PYRAMID_LONG: `[${dirLabel}] 상승 확인 후 피라미딩 롱 — 기존 포지션 유지 + 신규 롱 추가, 손절 -12%, 익절 +30%`,
    PYRAMID_SHORT: `[${dirLabel}] 하락 확인 후 피라미딩 숏 — 기존 포지션 유지 + 신규 숏 추가, 손절 -12%, 익절 +30%`,
  };

  return details[pattern];
}

// ─── 예정 이벤트 캘린더 ───────────────────────────────────────────────────────

/**
 * 미국 주요 경제지표 발표 일정 (매월 고정 패턴)
 * 실제 운영 시 Economic Calendar API 연동 권장
 */
function getUpcomingScheduledEvents(): UpcomingEvent[] {
  const now = new Date();
  const kstOffset = 9 * 60 * 60 * 1000; // KST = UTC+9
  const upcoming: UpcomingEvent[] = [];

  // 매월 첫째 주 금요일 22:30 KST = NFP 발표
  // 매월 둘째 주 수요일 21:30 KST = CPI 발표
  // FOMC: 연 8회, 수요일 03:00 KST
  // 이 함수는 현재 시각 기준 30분 이내 예정 이벤트만 반환

  const dayOfWeek = now.getDay(); // 0=일, 5=금
  const hour = now.getHours();    // KST 기준
  const minute = now.getMinutes();
  const currentMinutes = hour * 60 + minute;

  // NFP: 매월 첫째 주 금요일 22:30 KST
  if (dayOfWeek === 5) {
    const nfpMinutes = 22 * 60 + 30;
    if (nfpMinutes - currentMinutes > 0 && nfpMinutes - currentMinutes <= 30) {
      upcoming.push({
        type: 'NFP',
        title: '미국 비농업고용지수(NFP) 발표 임박',
        scheduledAt: Date.now() + (nfpMinutes - currentMinutes) * 60000,
        expectedImpact: 'HIGH',
        warningMessage: `⚠️ NFP 발표 ${nfpMinutes - currentMinutes}분 전 — 신규 진입 자제, 손절 압축 권장`,
      });
    }
  }

  // CPI: 매월 둘째 주 수요일 21:30 KST
  if (dayOfWeek === 3) {
    const cpiMinutes = 21 * 60 + 30;
    if (cpiMinutes - currentMinutes > 0 && cpiMinutes - currentMinutes <= 30) {
      upcoming.push({
        type: 'CPI',
        title: '미국 소비자물가지수(CPI) 발표 임박',
        scheduledAt: Date.now() + (cpiMinutes - currentMinutes) * 60000,
        expectedImpact: 'CRITICAL',
        warningMessage: `🚨 CPI 발표 ${cpiMinutes - currentMinutes}분 전 — 신규 진입 금지, 기존 포지션 손절 압축`,
      });
    }
  }

  // FOMC: 수요일 03:00 KST
  if (dayOfWeek === 3) {
    const fomcMinutes = 3 * 60;
    if (fomcMinutes - currentMinutes > 0 && fomcMinutes - currentMinutes <= 30) {
      upcoming.push({
        type: 'FOMC',
        title: 'FOMC 금리 결정 발표 임박',
        scheduledAt: Date.now() + (fomcMinutes - currentMinutes) * 60000,
        expectedImpact: 'CRITICAL',
        warningMessage: `🚨 FOMC 발표 ${fomcMinutes - currentMinutes}분 전 — 전체 포지션 점검, 신규 진입 금지`,
      });
    }
  }

  return upcoming;
}

// ─── 메인 함수 ────────────────────────────────────────────────────────────────

/**
 * 매크로 뉴스 상태 조회 (3분 캐시)
 */
export async function getMacroState(forceRefresh = false): Promise<MacroState> {
  const now = Date.now();

  // 캐시 유효 + 강제 갱신 아님
  if (!forceRefresh && now - _macroState.lastCheckedAt < CHECK_INTERVAL_MS) {
    // 충격 만료 체크
    if (_macroState.isShockActive && now > _macroState.pauseUntil) {
      _macroState.isShockActive = false;
      _macroState.currentShockLevel = 'NONE';
      _macroState.currentPattern = null;
      _macroState.activeEvents = _macroState.activeEvents.filter(
        e => now - e.detectedAt < e.pauseDurationMs
      );
    }
    return _macroState;
  }

  try {
    const newsItems = await fetchCryptoNews();
    const newEvents: MacroEvent[] = [];

    for (const item of newsItems) {
      const event = analyzeNewsItem(item);
      if (!event) continue;

      // 중복 이벤트 제거 (같은 타입 5분 이내)
      const isDuplicate = _macroState.activeEvents.some(
        e => e.type === event.type && now - e.detectedAt < 5 * 60 * 1000
      );
      if (!isDuplicate) {
        newEvents.push(event);
      }
    }

    // 만료된 이벤트 제거
    const activeEvents = [
      ..._macroState.activeEvents.filter(e => now - e.detectedAt < e.pauseDurationMs),
      ...newEvents,
    ];

    // 가장 심각한 이벤트 기준으로 현재 상태 결정
    const shockOrder: MacroShockLevel[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NONE'];
    let topEvent: MacroEvent | null = null;
    for (const level of shockOrder) {
      const found = activeEvents.find(e => e.shockLevel === level);
      if (found) { topEvent = found; break; }
    }

    const isShockActive = activeEvents.length > 0;
    const currentShockLevel = topEvent?.shockLevel ?? 'NONE';
    const currentPattern = topEvent?.responsePattern ?? null;
    const pauseUntil = topEvent
      ? Math.max(_macroState.pauseUntil, topEvent.detectedAt + topEvent.pauseDurationMs)
      : _macroState.pauseUntil;

    const upcomingEvents = getUpcomingScheduledEvents();

    _macroState = {
      activeEvents,
      lastCheckedAt: now,
      isShockActive,
      currentShockLevel,
      currentPattern,
      pauseUntil,
      upcomingEvents,
    };
  } catch {
    _macroState.lastCheckedAt = now;
  }

  return _macroState;
}

/**
 * 현재 신규 진입 가능 여부
 */
export function canEnterNewPosition(state: MacroState): boolean {
  if (!state.isShockActive) return true;
  if (state.currentPattern === 'CLOSE_ALL') return false;
  if (state.currentPattern === 'PAUSE') return Date.now() > state.pauseUntil;
  if (state.currentPattern === 'TIGHTEN_SL') return true; // 진입 가능하되 손절 압축
  return true;
}

/**
 * 현재 충격 기반 손절 압축 비율 반환
 */
export function getShockSlPct(state: MacroState, defaultSl: number): number {
  if (!state.isShockActive) return defaultSl;
  const topEvent = state.activeEvents[0];
  if (!topEvent?.slTightenPct) return defaultSl;
  return Math.max(topEvent.slTightenPct, defaultSl); // 더 타이트한 쪽 적용
}

/**
 * 충격 이벤트 요약 문자열
 */
export function getMacroSummary(state: MacroState): string {
  if (!state.isShockActive) return '';
  const top = state.activeEvents[0];
  if (!top) return '';
  const remaining = Math.max(0, Math.round((top.detectedAt + top.pauseDurationMs - Date.now()) / 60000));
  return `${top.shockLevel === 'CRITICAL' ? '🚨' : '⚠️'} ${top.title.slice(0, 40)} — ${top.responseDetail.slice(0, 60)} (${remaining}분 남음)`;
}

/**
 * 예정 이벤트 경고 문자열 (30분 이내)
 */
export function getUpcomingWarning(state: MacroState): string {
  if (state.upcomingEvents.length === 0) return '';
  return state.upcomingEvents[0].warningMessage;
}
