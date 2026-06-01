import { COOKIE_NAME } from "../shared/const.js";
import { getSessionCookieOptions } from "./cookies";
import { systemRouter } from "./systemRouter";
import { publicProcedure, router } from "./trpc";
import { invokeLLM } from "./llm";
import {
  getServerBotState,
  getServerTradeHistory,
  getServerConfig,
  getServerExcludeList,
  setServerCredentials,
  setServerConfig,
  addToServerExcludeList,
  removeFromServerExcludeList,
  removeServerPosition,
  convertServerPositionToSurge,
  startServerNormalBot,
  stopServerNormalBot,
  startServerSurgeBot,
  stopServerSurgeBot,
  startServerPresurgeBot,
  stopServerPresurgeBot,
  stopAllServerBots,
  toggleServerAutoEntry,
  triggerServerManualTick,
  getServerCredentials,
  type BotConfig,
} from './server-bot-engine';
import {
  calcSafeWithdrawal,
  validateWithdrawalAmount,
  analyzeLossPattern,
  calcStrategyStats,
  type TradeOutcome,
} from '../lib/strategy-optimizer';
import { getMacroState, getUpcomingWarning } from '../lib/macro-news';
import {
  runWalkForwardTest,
  runRSIGridSearch,
  generateMockCandles,
  fetchBybitKlines,
  runMonteCarlo,
  classifyMarketRegime,
  getRegimeStrategy,
  type WalkForwardResult,
  type MarketRegime,
} from '../lib/backtest-engine';
import {
  analyzeNewsImpact,
  classifyNewsImportance,
  type NewsItem as PriceFactorNewsItem,
  type NewsImportance,
} from '../lib/price-factor-engine';
import { getCurrentSession, getSessionSummary, getComboParams } from '../lib/time-pattern';
import { getMarketContext, getPhaseLabel, getPhaseColor } from '../lib/market-context';
import { getBalance } from '../lib/trading-service';
import type { ApiCredentials } from '../lib/trading-service';
import {
  getTopScalpingSignals,
  getSurgeDropTop7,
  getPreSurgeTop10,
  analyzeSymbolLive,
} from '../lib/scalping-engine';

// ─── 보유 종목 뉴스 캐시 (3분) ──────────────────────────────────────────────────
const _posNewsCache = new Map<string, { bullish: NewsItem[]; bearish: NewsItem[]; at: number }>();
const POS_NEWS_TTL = 3 * 60 * 1000;

async function fetchPositionNews(symbols: string[]): Promise<{ symbol: string; bullish: NewsItem[]; bearish: NewsItem[] }[]> {
  if (symbols.length === 0) return [];
  const now = Date.now();
  const results: { symbol: string; bullish: NewsItem[]; bearish: NewsItem[] }[] = [];

  for (const sym of symbols) {
    const cached = _posNewsCache.get(sym);
    if (cached && now - cached.at < POS_NEWS_TTL) {
      results.push({ symbol: sym, bullish: cached.bullish, bearish: cached.bearish });
      continue;
    }

    // CryptoPanic RSS에서 심볼 검색
    const rssUrl = `https://cryptopanic.com/news/rss/?currencies=${sym}`;
    let rawItems: { title: string; url: string; publishedAt: string }[] = [];
    try {
      const ctrl1 = new AbortController();
      const t1 = setTimeout(() => ctrl1.abort(), 8000);
      const res = await fetch(rssUrl, { signal: ctrl1.signal }).finally(() => clearTimeout(t1));
      const xml = await res.text();
      const items = xml.match(/<item>([\s\S]*?)<\/item>/g) ?? [];
      for (const item of items.slice(0, 10)) {
        const titleMatch = item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ??
                           item.match(/<title>([\s\S]*?)<\/title>/);
        const linkMatch = item.match(/<link>([\s\S]*?)<\/link>/);
        const dateMatch = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
        if (titleMatch?.[1]) {
          rawItems.push({
            title: titleMatch[1].trim(),
            url: linkMatch?.[1]?.trim() ?? '',
            publishedAt: dateMatch?.[1]?.trim() ?? '',
          });
        }
      }
    } catch (e) {
      console.warn(`[PositionNews] ${sym} RSS 실패:`, e);
    }

    if (rawItems.length === 0) {
      _posNewsCache.set(sym, { bullish: [], bearish: [], at: now });
      results.push({ symbol: sym, bullish: [], bearish: [] });
      continue;
    }

    try {
      const titlesJson = JSON.stringify(rawItems.map((r, i) => ({ id: i, title: r.title })));
      const llmRes = await invokeLLM({
        messages: [
          {
            role: 'system',
            content: `You are a crypto news analyst. Translate each title to Korean and classify as "bullish" or "bearish" for the ${sym} token. Return JSON: {"items":[{"id":number,"korean":string,"sentiment":"bullish"|"bearish"}]}`,
          },
          { role: 'user', content: titlesJson },
        ],
        response_format: { type: 'json_object' },
      });
      const rawContent = llmRes.choices?.[0]?.message?.content ?? '{}';
      const content = typeof rawContent === 'string' ? rawContent : '{}';
      const parsed = JSON.parse(content) as { items?: { id: number; korean: string; sentiment: string }[] };
      const arr = parsed.items ?? [];
      const translated: NewsItem[] = arr.map(a => ({
        title: a.korean ?? rawItems[a.id]?.title ?? '',
        url: rawItems[a.id]?.url ?? '',
        publishedAt: rawItems[a.id]?.publishedAt ?? '',
        sentiment: (a.sentiment === 'bullish' ? 'bullish' : 'bearish') as 'bullish' | 'bearish',
      }));
      const entry = {
        bullish: translated.filter(n => n.sentiment === 'bullish').slice(0, 5),
        bearish: translated.filter(n => n.sentiment === 'bearish').slice(0, 5),
        at: now,
      };
      _posNewsCache.set(sym, entry);
      results.push({ symbol: sym, bullish: entry.bullish, bearish: entry.bearish });
    } catch (e) {
      console.warn(`[PositionNews] ${sym} LLM 실패:`, e);
      _posNewsCache.set(sym, { bullish: [], bearish: [], at: now });
      results.push({ symbol: sym, bullish: [], bearish: [] });
    }
  }
  return results;
}

// ─── 뉴스 캐시 (5분) ─────────────────────────────────────────────────────────
interface NewsItem {
  title: string;
  url: string;
  publishedAt: string;
  sentiment: 'bullish' | 'bearish';
}
let _newsCache: NewsItem[] | null = null;
let _newsCacheAt = 0;
const NEWS_TTL = 5 * 60 * 1000;

async function fetchAndTranslateNews(): Promise<NewsItem[]> {
  const now = Date.now();
  if (_newsCache && now - _newsCacheAt < NEWS_TTL) return _newsCache;

  // CryptoPanic RSS (무료, 인증 불필요)
  const rssUrl = 'https://cryptopanic.com/news/rss/';
  let rawItems: { title: string; url: string; publishedAt: string }[] = [];

  try {
    const ctrl2 = new AbortController();
    const t2 = setTimeout(() => ctrl2.abort(), 10000);
    const res = await fetch(rssUrl, { signal: ctrl2.signal }).finally(() => clearTimeout(t2));
    const xml = await res.text();
    const items = xml.match(/<item>([\s\S]*?)<\/item>/g) ?? [];
    for (const item of items.slice(0, 20)) {
      const titleMatch = item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ??
                         item.match(/<title>([\s\S]*?)<\/title>/);
      const linkMatch = item.match(/<link>([\s\S]*?)<\/link>/);
      const dateMatch = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
      if (titleMatch?.[1]) {
        rawItems.push({
          title: titleMatch[1].trim(),
          url: linkMatch?.[1]?.trim() ?? '',
          publishedAt: dateMatch?.[1]?.trim() ?? '',
        });
      }
    }
  } catch (e) {
    console.warn('[News] RSS 조회 실패:', e);
  }

  if (rawItems.length === 0) {
    _newsCache = [];
    _newsCacheAt = now;
    return [];
  }

  // LLM으로 번역 + 상승/하락 분류 (한 번에 처리)
  try {
    const titlesJson = JSON.stringify(rawItems.map((r, i) => ({ id: i, title: r.title })));
    const llmRes = await invokeLLM({
      messages: [
        {
          role: 'system',
          content: `You are a crypto news analyst. Given a JSON array of news titles, translate each to Korean and classify sentiment as "bullish" or "bearish". Return JSON array: [{"id":number,"korean":string,"sentiment":"bullish"|"bearish"}]. No markdown, pure JSON only.`,
        },
        { role: 'user', content: titlesJson },
      ],
      response_format: { type: 'json_object' },
    });

    const rawContent = llmRes.choices?.[0]?.message?.content ?? '{}';
    const content = typeof rawContent === 'string' ? rawContent : '{}';
    const parsed = JSON.parse(content) as { items?: { id: number; korean: string; sentiment: string }[] } | { id: number; korean: string; sentiment: string }[];
    const arr: { id: number; korean: string; sentiment: string }[] = Array.isArray(parsed) ? parsed : (parsed as { items?: { id: number; korean: string; sentiment: string }[] }).items ?? [];

    const result: NewsItem[] = arr.map((a) => ({
      title: a.korean ?? rawItems[a.id]?.title ?? '',
      url: rawItems[a.id]?.url ?? '',
      publishedAt: rawItems[a.id]?.publishedAt ?? '',
      sentiment: (a.sentiment === 'bullish' ? 'bullish' : 'bearish') as 'bullish' | 'bearish',
    }));

    _newsCache = result;
    _newsCacheAt = now;
    return result;
  } catch (e) {
    console.warn('[News] LLM 번역 실패:', e);
    // 번역 실패 시 원문 + 감성 없이 반환
    const fallback: NewsItem[] = rawItems.map(r => ({ ...r, sentiment: 'bullish' as const }));
    _newsCache = fallback;
    _newsCacheAt = now;
    return fallback;
  }
}

export const appRouter = router({
  // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  news: router({
    getCryptoNews: publicProcedure.query(async () => {
      const items = await fetchAndTranslateNews();
      return {
        bullish: items.filter(n => n.sentiment === 'bullish').slice(0, 5),
        bearish: items.filter(n => n.sentiment === 'bearish').slice(0, 5),
        updatedAt: _newsCacheAt,
      };
    }),
    getPositionNews: publicProcedure
      .input((val: unknown) => {
        if (!Array.isArray(val)) throw new Error('symbols must be array');
        return (val as string[]).filter(s => typeof s === 'string').slice(0, 10);
      })
      .query(async ({ input }) => {
        return fetchPositionNews(input);
      }),
  }),
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  bot: router({
    // ── 상태 조회 ──
    getState: publicProcedure.query(() => {
      return getServerBotState();
    }),
    getConfig: publicProcedure.query(() => {
      return getServerConfig();
    }),
    getTradeHistory: publicProcedure.query(() => {
      return getServerTradeHistory();
    }),
    getExcludeList: publicProcedure.query(() => {
      return getServerExcludeList();
    }),

    // ── 자격증명 설정 ──
    setCredentials: publicProcedure
      .input((val: unknown) => {
        const v = val as ApiCredentials;
        if (!v || typeof v.apiKey !== 'string' || typeof v.secretKey !== 'string') {
          throw new Error('apiKey, secretKey은 필수입니다.');
        }
        return v;
      })
      .mutation(({ input }) => {
        setServerCredentials(input);
        return { success: true, message: '서버 자격증명 설정 완료' };
      }),

    // ── 설정 업데이트 ──
    updateConfig: publicProcedure
      .input((val: unknown) => val as Partial<BotConfig>)
      .mutation(({ input }) => {
        setServerConfig(input);
        return { success: true, message: '서버 봇 설정 업데이트 완료' };
      }),

    // ── 봇 시작/정지 ──
    startNormalBot: publicProcedure.mutation(async () => {
      return startServerNormalBot();
    }),
    stopNormalBot: publicProcedure.mutation(async () => {
      return stopServerNormalBot();
    }),
    startSurgeBot: publicProcedure.mutation(async () => {
      return startServerSurgeBot();
    }),
    stopSurgeBot: publicProcedure.mutation(async () => {
      return stopServerSurgeBot();
    }),
    stopAll: publicProcedure.mutation(async () => {
      return stopAllServerBots();
    }),

    // ── 포지션 관리 ──
    removePosition: publicProcedure
      .input((val: unknown) => {
        if (typeof val !== 'string') throw new Error('bybitSymbol은 string이어야 합니다.');
        return val;
      })
      .mutation(({ input }) => {
        removeServerPosition(input);
        return { success: true };
      }),
    convertToSurge: publicProcedure
      .input((val: unknown) => {
        if (typeof val !== 'string') throw new Error('bybitSymbol은 string이어야 합니다.');
        return val;
      })
      .mutation(({ input }) => {
        return convertServerPositionToSurge(input);
      }),

    // ── 제외 목록 ──
    addExclude: publicProcedure
      .input((val: unknown) => {
        if (typeof val !== 'string') throw new Error('bybitSymbol은 string이어야 합니다.');
        return val;
      })
      .mutation(({ input }) => {
        addToServerExcludeList(input);
        return { success: true };
      }),
    removeExclude: publicProcedure
      .input((val: unknown) => {
        if (typeof val !== 'string') throw new Error('bybitSymbol은 string이어야 합니다.');
        return val;
      })
      .mutation(({ input }) => {
        removeFromServerExcludeList(input);
        return { success: true };
      }),

    // ── 자동 진입 토글 ──
    toggleAutoEntry: publicProcedure.mutation(() => {
      return toggleServerAutoEntry();
    }),

    // ── 수동 틱 트리거 ──
    manualTick: publicProcedure.mutation(async () => {
      return triggerServerManualTick();
    }),

    // ── 급상승직전봇 ──
    startPresurgeBot: publicProcedure.mutation(async () => {
      return startServerPresurgeBot();
    }),
    stopPresurgeBot: publicProcedure.mutation(async () => {
      return stopServerPresurgeBot();
    }),

    // ── 안전 인출 계산 ──
    getWithdrawalSafety: publicProcedure.query(() => {
      // 현재 봇 상태에서 안전 인출 정보 반환 (매 틱마다 업데이트됨)
      const state = getServerBotState();
      return state.withdrawalSafety ?? null;
    }),

    validateWithdrawal: publicProcedure
      .input((val: unknown) => {
        const v = val as { amount: number };
        if (typeof v?.amount !== 'number') throw new Error('amount는 number이어야 합니다.');
        return v;
      })
      .query(({ input }) => {
        const state = getServerBotState();
        if (!state.withdrawalSafety) return null;
        return validateWithdrawalAmount(input.amount, state.withdrawalSafety);
      }),

    // ── 전략 성과 통계 ──
    getStrategyStats: publicProcedure.query(() => {
      const history = getServerTradeHistory();
      const outcomes: TradeOutcome[] = history.map(r => ({
        id: r.id,
        symbol: r.symbol,
        direction: r.direction,
        confidence: 80,
        leverage: r.leverage,
        sourceType: r.sourceType,
        entryPrice: r.entryPrice,
        closePrice: r.closePrice,
        pnlPct: r.pnlPct,
        holdingMinutes: r.holdingMinutes,
        timestamp: r.closedAt,
      }));

      const all = calcStrategyStats(outcomes);
      const normal = calcStrategyStats(outcomes.filter(o => o.sourceType === 'top7'));
      const surge = calcStrategyStats(outcomes.filter(o => o.sourceType === 'surge'));
      const presurge = calcStrategyStats(outcomes.filter(o => o.sourceType === 'presurge'));

      const state = getServerBotState();
      return {
        all,
        normal,
        surge,
        presurge,
        consecutiveLosses: state.consecutiveLosses ?? 0,
        lossLevelMessage: state.lossLevelMessage ?? '',
        autoAdjusted: state.autoAdjusted ?? false,
        autoAdjustLog: state.autoAdjustLog ?? [],
        compoundMultiplier: state.compoundMultiplier ?? 1,
        totalPnlPctAll: state.totalPnlPctAll ?? 0,
        portfolioLiqRisk: state.portfolioLiqRisk ?? 0,
      };
    }),

    // ── 손실 원인 분석 ──
    getLossAnalysis: publicProcedure.query(() => {
      const history = getServerTradeHistory();
      const config = getServerConfig();
      const outcomes: TradeOutcome[] = history.slice(0, 20).map(r => ({
        id: r.id,
        symbol: r.symbol,
        direction: r.direction,
        confidence: 80,
        leverage: r.leverage,
        sourceType: r.sourceType,
        entryPrice: r.entryPrice,
        closePrice: r.closePrice,
        pnlPct: r.pnlPct,
        holdingMinutes: r.holdingMinutes,
        timestamp: r.closedAt,
      }));
      return analyzeLossPattern(outcomes, {
        entryConfidenceMin: config.entryConfidenceMin ?? 80,
        positionSizePct: config.positionSizePct ?? 2,
        defaultLeverage: config.defaultLeverage ?? 10,
      });
    }),

    // ── 서버 측 연결 테스트 (잔고 조회) ──
    testConnection: publicProcedure.mutation(async () => {
      const creds = getServerCredentials();
      if (!creds) throw new Error('자격증명이 설정되지 않았습니다. 설정 탭에서 API 키를 먼저 저장하세요.');
      const balance = await getBalance(creds);
      return { success: true, balance };
    }),

    // ── 서버 측 스캘핑 신호 조회 ──
    getTopSignals: publicProcedure.mutation(async () => {
      const creds = getServerCredentials();
      if (!creds) throw new Error('자격증명이 설정되지 않았습니다.');
      const excludeList = getServerExcludeList();
      return getTopScalpingSignals(excludeList);
    }),

    // ── 서버 측 급등락 신호 조회 ──
    getSurgeSignals: publicProcedure.mutation(async () => {
      const creds = getServerCredentials();
      if (!creds) throw new Error('자격증명이 설정되지 않았습니다.');
      const excludeList = getServerExcludeList();
      return getSurgeDropTop7(excludeList);
    }),

    // ── 서버 측 급등직전 신호 조회 ──
    getPreSurgeSignals: publicProcedure.mutation(async () => {
      const creds = getServerCredentials();
      if (!creds) throw new Error('자격증명이 설정되지 않았습니다.');
      const excludeList = getServerExcludeList();
      return getPreSurgeTop10(excludeList);
    }),

    // ── 서버 측 개별 심볼 분석 ──
    analyzeSymbol: publicProcedure
      .input((val: unknown) => {
        const v = val as { symbol: string };
        if (!v?.symbol || typeof v.symbol !== 'string') throw new Error('symbol은 필수입니다.');
        return { symbol: v.symbol };
      })
      .mutation(async ({ input }) => {
        const creds = getServerCredentials();
        if (!creds) throw new Error('자격증명이 설정되지 않았습니다.');
        return analyzeSymbolLive(input.symbol);
      }),
  }),

  // ─── 매크로 뉴스 ─────────────────────────────────────────────────────────
  macro: router({
    getState: publicProcedure.query(async () => {
      const state = await getMacroState();
      const warning = getUpcomingWarning(state);
      return { ...state, upcomingWarning: warning };
    }),
  }),

  // ─── 백테스트 ──────────────────────────────────────────────────────────────
  backtest: router({
    // 모의 데이터로 Walk-Forward 백테스트 실행 (실제 API 연동 전 검증용)
    runMockWalkForward: publicProcedure
      .input((val: unknown) => {
        const v = val as { symbol?: string; years?: number } | undefined;
        return {
          symbol: v?.symbol ?? 'BTCUSDT',
          years: Math.min(5, Math.max(1, v?.years ?? 4)),
        };
      })
      .mutation(async ({ input }) => {
        // 모의 캔들 생성 (실제 Bybit API 연동 전 테스트)
        const totalCandles = 24 * 365 * input.years;
        const candles = generateMockCandles(30000, totalCandles, 0.015);
        const result = runWalkForwardTest(candles, input.symbol);
        return {
          symbol: result.symbol,
          totalTrades: result.overallStats.totalTrades,
          winRate: result.overallStats.winRate,
          profitFactor: result.overallStats.profitFactor,
          sharpeRatio: result.overallStats.sharpeRatio,
          maxDrawdownPct: result.overallStats.maxDrawdownPct,
          totalNetPnlPct: result.overallStats.totalNetPnlPct,
          avgDailyPnlPct: result.overallStats.avgDailyPnlPct,
          bestRegime: result.overallStats.bestRegime,
          worstRegime: result.overallStats.worstRegime,
          optimalRsiRanges: result.optimalRsiRanges,
          isOverfitted: result.isOverfitted,
          recommendation: result.recommendation,
          validationPeriods: result.validationPeriods.map(p => ({
            periodStart: p.periodStart,
            periodEnd: p.periodEnd,
            totalTrades: p.totalTrades,
            winRate: p.winRate,
            profitFactor: p.profitFactor,
            totalNetPnlPct: p.totalNetPnlPct,
            maxDrawdownPct: p.maxDrawdownPct,
            regimeBreakdown: p.regimeBreakdown,
          })),
          note: '⚠️ 모의 데이터 기반 결과입니다. 실제 Bybit 데이터로 검증이 필요합니다.',
        };
      }),

    // 실제 Bybit 데이터 Walk-Forward 백테스트 (ChatGPT v47 권고)
    runRealWalkForward: publicProcedure
      .input((val: unknown) => {
        const v = val as { symbol?: string; months?: number } | undefined;
        return {
          symbol: v?.symbol ?? 'BTCUSDT',
          months: Math.min(12, Math.max(4, v?.months ?? 8)),
        };
      })
      .mutation(async ({ input }) => {
        try {
          const now = Date.now();
          const startTime = now - input.months * 30 * 24 * 60 * 60 * 1000;
          const candles = await fetchBybitKlines(input.symbol, '60', startTime, now);

          const buildResult = (r: WalkForwardResult, mc: ReturnType<typeof runMonteCarlo>) => ({
            symbol: r.symbol,
            totalTrades: r.overallStats.totalTrades,
            winRate: r.overallStats.winRate,
            profitFactor: r.overallStats.profitFactor,
            sharpeRatio: r.overallStats.sharpeRatio,
            maxDrawdownPct: r.overallStats.maxDrawdownPct,
            totalNetPnlPct: r.overallStats.totalNetPnlPct,
            avgDailyPnlPct: r.overallStats.avgDailyPnlPct,
            bestRegime: r.overallStats.bestRegime,
            worstRegime: r.overallStats.worstRegime,
            optimalRsiRanges: r.optimalRsiRanges,
            isOverfitted: r.isOverfitted,
            recommendation: r.recommendation,
            validationPeriods: r.validationPeriods.map(p => ({
              periodStart: p.periodStart,
              periodEnd: p.periodEnd,
              totalTrades: p.totalTrades,
              winRate: p.winRate,
              profitFactor: p.profitFactor,
              totalNetPnlPct: p.totalNetPnlPct,
              maxDrawdownPct: p.maxDrawdownPct,
              regimeBreakdown: p.regimeBreakdown,
            })),
            monteCarlo: mc,
          });

          if (candles.length < 500) {
            // 데이터 부족 시 모의 데이터 폴백
            const mockCandles = generateMockCandles(30000, 24 * 365 * 2, 0.015);
            const result = runWalkForwardTest(mockCandles, input.symbol);
            const mc = runMonteCarlo(result.validationPeriods.flatMap(p => p.trades));
            return {
              ...buildResult(result, mc),
              dataSource: 'mock',
              candleCount: mockCandles.length,
              note: '⚠️ Bybit 데이터 부족(네트워크 오류 또는 데이터 미존). 모의 데이터로 대체 실행.',
            };
          }

          const result = runWalkForwardTest(candles, input.symbol);
          const mc = runMonteCarlo(result.validationPeriods.flatMap(p => p.trades));
          return {
            ...buildResult(result, mc),
            dataSource: 'bybit_real',
            candleCount: candles.length,
            note: `✅ Bybit 실제 데이터 ${candles.length}개 캐들 (${input.months}개월). Monte Carlo ${mc.simulations}회 시뮬레이션 완료.`,
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { error: msg, dataSource: 'error', candleCount: 0, note: '오류: ' + msg };
        }
      }),

    // RSI Grid Search 실행
    runRSIGridSearch: publicProcedure
      .input((val: unknown) => {
        const v = val as { candleCount?: number } | undefined;
        return { candleCount: Math.min(8760, Math.max(720, v?.candleCount ?? 4380)) };
      })
      .mutation(async ({ input }) => {
        const candles = generateMockCandles(30000, input.candleCount, 0.015);
        const result = runRSIGridSearch(candles);
        return {
          optimalLongMin: result.rsiLongMin,
          optimalLongMax: result.rsiLongMax,
          optimalShortMin: result.rsiShortMin,
          optimalShortMax: result.rsiShortMax,
          winRate: result.winRate,
          profitFactor: result.profitFactor,
          totalTrades: result.totalTrades,
          score: result.score,
          note: '⚠️ 모의 데이터 기반 최적값입니다. 실제 데이터로 재검증 필요.',
        };
      }),

    // 현재 시장 국면 조회
    getRegime: publicProcedure.query(async () => {
      try {
        const ctx = await getMarketContext();
        const phase = ctx?.phase ?? 'NEUTRAL';
        // 간략화된 국면 매핑 (실제 ADX/EMA200은 scalping-engine에서 계산)
        let regime: MarketRegime = 'RANGING';
        if (phase.includes('BULL') || phase.includes('BREAKOUT') || phase.includes('RECOVERY')) {
          regime = 'BULL_TREND';
        } else if (phase.includes('BEAR') || phase.includes('CRASH') || phase.includes('DUMP')) {
          regime = 'CRASH';
        } else if (phase.includes('DOWN') || phase.includes('WEAK')) {
          regime = 'BEAR_TREND';
        }
        const strategy = getRegimeStrategy(regime);
        return {
          regime,
          strategy,
          phase,
          updatedAt: Date.now(),
        };
      } catch {
        return {
          regime: 'RANGING' as MarketRegime,
          strategy: getRegimeStrategy('RANGING'),
          phase: 'NEUTRAL',
          updatedAt: Date.now(),
        };
      }
    }),

    // 뉴스 중요도 분석
    analyzeNews: publicProcedure
      .input((val: unknown) => {
        const items = val as Array<{
          id: string;
          title: string;
          importance?: string;
          direction?: string;
          impactPct?: number;
          hoursAgo?: number;
          source?: string;
          isVerified?: boolean;
        }>;
        if (!Array.isArray(items)) return [] as NewsItem[];
        return items.slice(0, 20).map(item => ({
          id: item.id ?? '',
          title: item.title ?? '',
          importance: (item.importance as NewsImportance) ??
            classifyNewsImportance(item.title ?? '', item.source ?? '', item.isVerified ?? false),
          direction: (item.direction as 'BULLISH' | 'BEARISH' | 'NEUTRAL') ?? 'NEUTRAL',
          impactPct: item.impactPct ?? 5,
          hoursAgo: item.hoursAgo ?? 0,
          source: item.source ?? '알 수 없음',
          isVerified: item.isVerified ?? false,
        })) as unknown as PriceFactorNewsItem[];
      })
      .mutation(({ input }) => {
        return analyzeNewsImpact(input as unknown as PriceFactorNewsItem[]);
      }),
  }),

  // ─── 시장 국면 + 세션 ───────────────────────────────────────────────────────
  market: router({
    getContext: publicProcedure.query(async () => {
      try {
        const ctx = await getMarketContext();
        const session = getCurrentSession();
        const sessionSummary = getSessionSummary();
        const phase = (ctx?.phase ?? 'NEUTRAL') as Parameters<typeof getComboParams>[0];
        const combo = getComboParams(phase, session);
        return {
          phase: ctx?.phase ?? 'NEUTRAL',
          phaseLabel: ctx ? getPhaseLabel(ctx.phase) : '중립',
          phaseColor: ctx ? getPhaseColor(ctx.phase) : '#888888',
          fearGreedIndex: ctx?.fearGreedIndex ?? 50,
          btcDominance: ctx?.btcDominanceEst ?? 50,
          session,
          sessionSummary,
          combo,
          updatedAt: Date.now(),
        };
      } catch {
        return {
          phase: 'NEUTRAL',
          phaseLabel: '중립',
          phaseColor: '#888888',
          fearGreedIndex: 50,
          btcDominance: 50,
          session: getCurrentSession(),
          sessionSummary: getSessionSummary(),
          combo: null,
          updatedAt: Date.now(),
        };
      }
    }),
  }),
});

export type AppRouter = typeof appRouter;
