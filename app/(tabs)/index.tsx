import { useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  StyleSheet,
  Modal,
  Alert,
} from 'react-native';
import { ScreenContainer } from '@/components/screen-container';
import { type ScalpingSignal } from '@/lib/scalping-engine';
import { addToBotManually, previewBotEntry, loadBotState } from '@/lib/bot-engine';
import { trpc } from '@/lib/trpc';
import { ChartModal } from '@/components/chart-modal';

// ─── 색상 팔레트 ──────────────────────────────────────────────────────────────
const C = {
  bg: '#0D1117',
  surface: '#161B22',
  border: '#21262D',
  text: '#E6EDF3',
  muted: '#8B949E',
  green: '#3FB950',
  red: '#F85149',
  teal: '#00D4AA',
  yellow: '#D29922',
  blue: '#58A6FF',
  purple: '#BC8CFF',
  orange: '#FFA657',
};

// ─── 추천 섹션 타입 ───────────────────────────────────────────────────────────
type SectionType = 'top7' | 'surge' | 'presurge';

const SECTION_META: Record<SectionType, {
  emoji: string;
  title: string;
  badge: string;
  badgeColor: string;
  badgeBg: string;
  description: string;
}> = {
  top7: {
    emoji: '🏆',
    title: 'TOP 7 추천',
    badge: '추',
    badgeColor: C.teal,
    badgeBg: '#0A2A2A',
    description: '신뢰도 80%+ 스캘핑 추천',
  },
  surge: {
    emoji: '🚀',
    title: '급등락 TOP 7',
    badge: '급',
    badgeColor: C.orange,
    badgeBg: '#2A1500',
    description: '24h 변동률 절대값 최고 7종목',
  },
  presurge: {
    emoji: '⚡',
    title: '급등직전 TOP 10',
    badge: '직',
    badgeColor: '#FF6B9D',
    badgeBg: '#2A0A1A',
    description: 'BB스퀴즈·세력매집·OI급증 복합 탐지',
  },
};

// ─── 유틸 함수 ────────────────────────────────────────────────────────────────
function formatPrice(n: number): string {
  if (n <= 0) return '-';
  if (n >= 10000) return n.toFixed(1);
  if (n >= 100) return n.toFixed(2);
  if (n >= 1) return n.toFixed(3);
  return n.toFixed(5);
}

function formatVolume(v: number): string {
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toFixed(0);
}

// ─── 봇 추가 확인 모달 ────────────────────────────────────────────────────────
type PreviewInfo = {
  qty: string;
  stopLoss: number;
  takeProfit: number;
  leverage: number;
  notional: number;
  kellyPct: number;
};

function BotAddModal({
  visible,
  signal,
  sectionType,
  preview,
  loading,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  signal: ScalpingSignal | null;
  sectionType: SectionType;
  preview: PreviewInfo | null;
  loading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!signal) return null;
  const isLong = signal.direction === 'LONG';
  const meta = SECTION_META[sectionType];
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={modalStyles.overlay}>
        <View style={modalStyles.container}>
          {/* 헤더 */}
          <View style={modalStyles.header}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <View style={[modalStyles.sourceBadge, { backgroundColor: meta.badgeBg, borderColor: meta.badgeColor }]}>
                <Text style={[modalStyles.sourceBadgeText, { color: meta.badgeColor }]}>{meta.badge}</Text>
              </View>
              <Text style={modalStyles.title}>자동봇에 추가</Text>
            </View>
            <Text style={[modalStyles.symbol, { color: isLong ? C.green : C.red }]}>
              {signal.displaySymbol} {isLong ? '▲ 롱' : '▼ 숏'}
            </Text>
          </View>

          {/* 안내 */}
          <View style={modalStyles.infoBox}>
            <Text style={modalStyles.infoText}>자동매매와 완전히 동일한 규칙으로 진입합니다.</Text>
            <Text style={[modalStyles.infoText, { color: C.teal, marginTop: 2 }]}>
              켈리 공식 포지션 사이징 · ATR 동적 손절 · Cross 마진
            </Text>
          </View>

          {/* 예상 진입 정보 */}
          {preview ? (
            <View style={modalStyles.previewBox}>
              <View style={modalStyles.previewRow}>
                <Text style={modalStyles.previewLabel}>신뢰도</Text>
                <Text style={[modalStyles.previewValue, { color: signal.confidence >= 90 ? C.green : C.teal }]}>
                  {signal.confidence}%
                </Text>
              </View>
              <View style={modalStyles.previewRow}>
                <Text style={modalStyles.previewLabel}>레버리지</Text>
                <Text style={[modalStyles.previewValue, { color: C.teal }]}>{preview.leverage}x</Text>
              </View>
              <View style={modalStyles.previewRow}>
                <Text style={modalStyles.previewLabel}>켈리 비율</Text>
                <Text style={[modalStyles.previewValue, { color: C.teal }]}>{preview.kellyPct.toFixed(1)}%</Text>
              </View>
              <View style={modalStyles.previewRow}>
                <Text style={modalStyles.previewLabel}>주문 수량</Text>
                <Text style={[modalStyles.previewValue, { color: C.text }]}>{preview.qty}</Text>
              </View>
              <View style={modalStyles.previewRow}>
                <Text style={modalStyles.previewLabel}>주문 금액</Text>
                <Text style={[modalStyles.previewValue, { color: C.text }]}>{preview.notional.toFixed(2)} USDT</Text>
              </View>
              <View style={[modalStyles.previewRow, { marginTop: 6 }]}>
                <Text style={modalStyles.previewLabel}>손절가 (ATR)</Text>
                <Text style={[modalStyles.previewValue, { color: C.red }]}>{formatPrice(preview.stopLoss)}</Text>
              </View>
              <View style={modalStyles.previewRow}>
                <Text style={modalStyles.previewLabel}>익절가 (ATR×2)</Text>
                <Text style={[modalStyles.previewValue, { color: C.green }]}>{formatPrice(preview.takeProfit)}</Text>
              </View>
            </View>
          ) : (
            <View style={modalStyles.previewBox}>
              <ActivityIndicator size="small" color={C.teal} />
              <Text style={{ color: C.muted, fontSize: 12, marginTop: 8, textAlign: 'center' }}>잔고 및 수량 계산 중...</Text>
            </View>
          )}

          {/* 버튼 */}
          <View style={modalStyles.btnRow}>
            <TouchableOpacity style={modalStyles.cancelBtn} onPress={onCancel} disabled={loading}>
              <Text style={modalStyles.cancelBtnText}>취소</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[modalStyles.confirmBtn, (!preview || loading) && { opacity: 0.5 }]}
              onPress={onConfirm}
              disabled={!preview || loading}
            >
              {loading
                ? <ActivityIndicator size="small" color="#fff" />
                : <Text style={modalStyles.confirmBtnText}>✅ 봇에 추가</Text>
              }
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ─── SignalCard (컴팩트 표시 방식) ────────────────────────────────────────────
function SignalCard({
  signal,
  rank,
  sectionType,
  onAddToBot,
}: {
  signal: ScalpingSignal;
  rank: number;
  sectionType: SectionType;
  onAddToBot?: (signal: ScalpingSignal, section: SectionType) => void;
}) {
  const [chartVisible, setChartVisible] = useState(false);
  const isLong = signal.direction === 'LONG';
  const meta = SECTION_META[sectionType];
  const confColor = signal.confidence >= 90 ? C.green : signal.confidence >= 80 ? C.teal : C.yellow;

  return (
    <>
    <ChartModal
      visible={chartVisible}
      symbol={signal.bybitSymbol ?? signal.symbol.replace('_', '')}
      displaySymbol={signal.displaySymbol}
      side={isLong ? 'LONG' : 'SHORT'}
      onClose={() => setChartVisible(false)}
    />
    <View style={[styles.card, { borderLeftWidth: 3, borderLeftColor: isLong ? C.green : C.red }]}>
      {/* 메인 행: 종목명 + 포지션 + 신뢰도 */}
      <View style={styles.cardMain}>
        {/* 왼쪽: 순위 + 종목명 (클릭 시 차트) */}
        <TouchableOpacity
          style={styles.cardLeft}
          onPress={() => setChartVisible(true)}
          activeOpacity={0.7}
        >
          <Text style={styles.rankText}>#{rank}</Text>
          <Text style={[styles.symbolText, { textDecorationLine: 'underline', textDecorationColor: C.teal }]}>{signal.displaySymbol}</Text>
          <Text style={{ fontSize: 9, color: C.teal }}>📈</Text>
        </TouchableOpacity>

        {/* 중앙: 현재가 + 등락률 */}
        <View style={styles.cardCenter}>
          <Text style={styles.priceText}>{formatPrice(signal.entryPrice)}</Text>
          <Text style={[styles.changeText, { color: signal.change24h >= 0 ? C.green : C.red }]}>
            {signal.change24h >= 0 ? '+' : ''}{signal.change24h.toFixed(2)}%
          </Text>
        </View>

        {/* 오른쪽: 포지션 + 신뢰도 */}
        <View style={styles.cardRight}>
          <View style={[styles.dirBadge, { backgroundColor: isLong ? '#1A3A2A' : '#3A1A1A' }]}>
            <Text style={[styles.dirBadgeText, { color: isLong ? C.green : C.red }]}>
              {isLong ? '▲ LONG' : '▼ SHORT'}
            </Text>
          </View>
          <Text style={[styles.confText, { color: confColor }]}>신뢰도 {signal.confidence}%</Text>
        </View>
      </View>

      {/* 적정가 + 체결강도 행 */}
      <View style={styles.cardExtra}>
        {signal.optimalPrice != null && signal.optimalPrice > 0 && (
          <View style={styles.extraItem}>
            <Text style={styles.extraLabel}>적정가</Text>
            <Text style={[styles.extraValue, { color: isLong ? C.green : C.red }]}>
              {formatPrice(signal.optimalPrice)}
            </Text>
          </View>
        )}
        {signal.takerBuyRatio != null && (
          <View style={styles.extraItem}>
            <Text style={styles.extraLabel}>체결강도</Text>
            <Text style={[
              styles.extraValue,
              { color: signal.takerBuyRatio >= 60 ? C.green : signal.takerBuyRatio <= 40 ? C.red : C.muted }
            ]}>
              매수 {signal.takerBuyRatio}%
            </Text>
          </View>
        )}
        {signal.fundingRate !== undefined && (
          <View style={styles.extraItem}>
            <Text style={styles.extraLabel}>펜딩비</Text>
            <Text style={[styles.extraValue, { color: signal.fundingRate >= 0 ? C.yellow : C.blue }]}>
              {signal.fundingRate >= 0 ? '+' : ''}{(signal.fundingRate * 100).toFixed(4)}%
            </Text>
          </View>
        )}
        {signal.volume24hUSDT != null && signal.volume24hUSDT > 0 && (
          <View style={styles.extraItem}>
            <Text style={styles.extraLabel}>거래량</Text>
            <Text style={[styles.extraValue, { color: C.muted }]}>
              {formatVolume(signal.volume24hUSDT)}
            </Text>
          </View>
        )}
      </View>

      {/* 급등락 종목 특화 대응 전략 안내 */}
      {sectionType === 'surge' && (
        <View style={styles.surgeStrategyBox}>
          <Text style={styles.surgeStrategyTitle}>⚡ 급등락 대응 전략</Text>
          <View style={styles.surgeStrategyRow}>
            <Text style={styles.surgeStrategyItem}>🔴 손절 -15%</Text>
            <Text style={styles.surgeStrategyItem}>🟢 익절 +20%</Text>
            <Text style={styles.surgeStrategyItem}>⚡ 전환 40%+ 즉시청산</Text>
          </View>
          <Text style={styles.surgeStrategyNote}>30초 간격 실시간 분석 · 빠른 대응 전략 적용</Text>
        </View>
      )}

      {/* 봇에 추가 버튼 */}
      {onAddToBot && (
        <TouchableOpacity
          style={[styles.addBotBtn, { backgroundColor: meta.badgeBg, borderColor: meta.badgeColor }]}
          onPress={() => onAddToBot(signal, sectionType)}
        >
          <View style={[styles.addBotBadge, { backgroundColor: meta.badgeColor }]}>
            <Text style={styles.addBotBadgeText}>{meta.badge}</Text>
          </View>
          <Text style={[styles.addBotBtnText, { color: meta.badgeColor }]}>
            자동봇에 추가 · {isLong ? '롱' : '숏'} {signal.confidence}%
          </Text>
        </TouchableOpacity>
      )}
    </View>
    </>
  );
}

// ─── 추천 섹션 컴포넌트 ────────────────────────────────────────────────────────
function RecommendSection({
  sectionType,
  signals,
  loading,
  error,
  onLoad,
  onAddToBot,
}: {
  sectionType: SectionType;
  signals: ScalpingSignal[];
  loading: boolean;
  error: string | null;
  onLoad: () => void;
  onAddToBot: (signal: ScalpingSignal, section: SectionType) => void;
}) {
  const meta = SECTION_META[sectionType];

  return (
    <View style={styles.section}>
      {/* 섹션 헤더 */}
      <View style={styles.sectionHeader}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={[styles.sectionBadge, { backgroundColor: meta.badgeBg, borderColor: meta.badgeColor }]}>
            <Text style={[styles.sectionBadgeText, { color: meta.badgeColor }]}>{meta.badge}</Text>
          </View>
          <View>
            <Text style={styles.sectionTitle}>{meta.emoji} {meta.title}</Text>
            <Text style={styles.sectionDesc}>{meta.description}</Text>
          </View>
        </View>
        <TouchableOpacity onPress={onLoad} disabled={loading}>
          <Text style={styles.refreshText}>{loading ? '로딩...' : '새로고침'}</Text>
        </TouchableOpacity>
      </View>

      {/* 오류 */}
      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>⚠ {error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={onLoad}>
            <Text style={styles.retryBtnText}>다시 시도</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* 로딩 */}
      {loading && signals.length === 0 && (
        <View style={styles.loadingBox}>
          <ActivityIndicator size="small" color={meta.badgeColor} />
          <Text style={[styles.loadingText, { color: meta.badgeColor }]}>분석 중...</Text>
        </View>
      )}

      {/* 빈 상태 */}
      {!loading && !error && signals.length === 0 && (
        <View style={styles.emptyBox}>
          <Text style={styles.emptyText}>버튼을 눌러 불러오세요</Text>
          <TouchableOpacity style={[styles.loadBtn, { backgroundColor: meta.badgeColor }]} onPress={onLoad}>
            <Text style={styles.loadBtnText}>{meta.emoji} 불러오기</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* 종목 목록 */}
      {signals.map((signal, i) => (
        <SignalCard
          key={`${sectionType}-${signal.symbol}`}
          signal={signal}
          rank={i + 1}
          sectionType={sectionType}
          onAddToBot={onAddToBot}
        />
      ))}
    </View>
  );
}

// ─── 메인 화면 ────────────────────────────────────────────────────────────────
export default function AnalysisScreen() {
  const [top7, setTop7] = useState<ScalpingSignal[]>([]);
  const [surge7, setSurge7] = useState<ScalpingSignal[]>([]);
  const [preSurge10, setPreSurge10] = useState<ScalpingSignal[]>([]);

  const [loadingTop7, setLoadingTop7] = useState(false);
  const [loadingSurge, setLoadingSurge] = useState(false);
  const [loadingPreSurge, setLoadingPreSurge] = useState(false);

  const [errorTop7, setErrorTop7] = useState<string | null>(null);
  const [errorSurge, setErrorSurge] = useState<string | null>(null);
  const [errorPreSurge, setErrorPreSurge] = useState<string | null>(null);

  const [searchSymbol, setSearchSymbol] = useState('');
  const [searchResult, setSearchResult] = useState<ScalpingSignal | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // 현재 봇에서 보유 중인 종목 심볼 목록 (추천 제외용)
  const [heldSymbols, setHeldSymbols] = useState<string[]>([]);

  // 서버 tRPC mutation 후크 (서버 IP를 통해 Bybit API 호출 → IP 허용 목록 문제 해결)
  const serverGetTopSignals = trpc.bot.getTopSignals.useMutation();
  const serverGetSurgeSignals = trpc.bot.getSurgeSignals.useMutation();
  const serverGetPreSurgeSignals = trpc.bot.getPreSurgeSignals.useMutation();
  const serverAnalyzeSymbol = trpc.bot.analyzeSymbol.useMutation();

  // 봇 포지션 심볼 목록 로드 (화면 진입 시 1회)
  const refreshHeldSymbols = useCallback(async () => {
    try {
      const state = await loadBotState();
      setHeldSymbols(state.positions.map(p => p.bybitSymbol));
    } catch { /* 무시 */ }
  }, []);

  // 봇 추가 모달 상태
  const [botModalSignal, setBotModalSignal] = useState<ScalpingSignal | null>(null);
  const [botModalSection, setBotModalSection] = useState<SectionType>('top7');
  const [botPreview, setBotPreview] = useState<PreviewInfo | null>(null);
  const [botAdding, setBotAdding] = useState(false);

  const handleAddToBot = useCallback(async (signal: ScalpingSignal, section: SectionType) => {
    setBotModalSignal(signal);
    setBotModalSection(section);
    setBotPreview(null);
    try {
      const prev = await previewBotEntry(signal);
      if (prev) setBotPreview(prev);
    } catch { /* 잔고 없으면 null */ }
  }, []);

  const handleBotConfirm = useCallback(async () => {
    if (!botModalSignal) return;
    setBotAdding(true);
    try {
      const result = await addToBotManually(botModalSignal, botModalSection);
      setBotModalSignal(null);
      setBotPreview(null);
      Alert.alert(
        result.success ? '✅ 봇 추가 완료' : '❌ 봇 추가 실패',
        result.message,
        [{ text: '확인' }]
      );
    } catch (e) {
      Alert.alert('오류', e instanceof Error ? e.message : '봇 추가 실패');
    } finally {
      setBotAdding(false);
    }
  }, [botModalSignal, botModalSection]);

  const loadTop7 = useCallback(async () => {
    setLoadingTop7(true);
    setErrorTop7(null);
    try {
      await refreshHeldSymbols();
      const signals = await new Promise<ScalpingSignal[]>((resolve, reject) => {
        serverGetTopSignals.mutate(undefined, {
          onSuccess: (data) => resolve(data),
          onError: (e) => reject(e),
        });
      });
      setTop7(signals);
    } catch (e) {
      setErrorTop7(e instanceof Error ? e.message : '데이터 로딩 실패');
    } finally {
      setLoadingTop7(false);
    }
  }, [refreshHeldSymbols, serverGetTopSignals]);

  const loadSurge7 = useCallback(async () => {
    setLoadingSurge(true);
    setErrorSurge(null);
    try {
      await refreshHeldSymbols();
      const signals = await new Promise<ScalpingSignal[]>((resolve, reject) => {
        serverGetSurgeSignals.mutate(undefined, {
          onSuccess: (data) => resolve(data),
          onError: (e) => reject(e),
        });
      });
      setSurge7(signals);
    } catch (e) {
      setErrorSurge(e instanceof Error ? e.message : '데이터 로딩 실패');
    } finally {
      setLoadingSurge(false);
    }
  }, [refreshHeldSymbols, serverGetSurgeSignals]);

  const loadPreSurge10 = useCallback(async () => {
    setLoadingPreSurge(true);
    setErrorPreSurge(null);
    try {
      await refreshHeldSymbols();
      const signals = await new Promise<ScalpingSignal[]>((resolve, reject) => {
        serverGetPreSurgeSignals.mutate(undefined, {
          onSuccess: (data) => resolve(data),
          onError: (e) => reject(e),
        });
      });
      setPreSurge10(signals);
    } catch (e) {
      setErrorPreSurge(e instanceof Error ? e.message : '데이터 로딩 실패');
    } finally {
      setLoadingPreSurge(false);
    }
  }, [refreshHeldSymbols, serverGetPreSurgeSignals]);

  const handleSearch = useCallback(async () => {
    const sym = searchSymbol.trim().toUpperCase();
    if (!sym) return;
    const normalized = sym.replace(/_/g, '').replace(/PERP$/, '');
    const bybitSymbol = normalized.endsWith('USDT') ? normalized : `${normalized}USDT`;
    setSearching(true);
    setSearchError(null);
    setSearchResult(null);
    try {
      const result = await new Promise<ScalpingSignal | null>((resolve, reject) => {
        serverAnalyzeSymbol.mutate({ symbol: bybitSymbol }, {
          onSuccess: (data) => resolve(data),
          onError: (e) => reject(e),
        });
      });
      if (result) setSearchResult(result);
      else setSearchError(`${bybitSymbol} 분석 결과 없음 (거래량 부족 또는 Bybit 미상장 종목)`);
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : '분석 실패');
    } finally {
      setSearching(false);
    }
  }, [searchSymbol, serverAnalyzeSymbol]);

  return (
    <ScreenContainer containerClassName="bg-[#0D1117]">
      <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* 헤더 */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>⚡ JT POWER</Text>
          <Text style={styles.headerSub}>급등락 특화 스캘핑 분석</Text>
        </View>

        {/* 종목 검색 */}
        <View style={styles.searchBox}>
          <TextInput
            style={styles.searchInput}
            value={searchSymbol}
            onChangeText={setSearchSymbol}
            placeholder="종목 입력 (예: BTC, ETH)"
            placeholderTextColor={C.muted}
            autoCapitalize="characters"
            returnKeyType="search"
            onSubmitEditing={handleSearch}
          />
          <TouchableOpacity style={styles.searchBtn} onPress={handleSearch} disabled={searching}>
            {searching
              ? <ActivityIndicator size="small" color={C.bg} />
              : <Text style={styles.searchBtnText}>분석</Text>
            }
          </TouchableOpacity>
        </View>

        {/* 빠른 선택 */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.quickRow}>
          {['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'DOT'].map(s => (
            <TouchableOpacity
              key={s}
              style={styles.quickChip}
              onPress={async () => {
                const bybitSym = `${s}USDT`;
                setSearchSymbol(s);
                setSearching(true);
                setSearchError(null);
                setSearchResult(null);
                try {
                  const result = await new Promise<ScalpingSignal | null>((resolve, reject) => {
                    serverAnalyzeSymbol.mutate({ symbol: bybitSym }, {
                      onSuccess: (data) => resolve(data),
                      onError: (e) => reject(e),
                    });
                  });
                  if (result) setSearchResult(result);
                  else setSearchError(`${bybitSym} 분석 결과 없음`);
                } catch (e) {
                  setSearchError(e instanceof Error ? e.message : '분석 실패');
                } finally {
                  setSearching(false);
                }
              }}
            >
              <Text style={styles.quickChipText}>{s}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* 검색 결과 */}
        {searchError && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>⚠ {searchError}</Text>
          </View>
        )}
        {searchResult && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>🔍 검색 결과</Text>
            <SignalCard
              signal={searchResult}
              rank={1}
              sectionType="top7"
              onAddToBot={handleAddToBot}
            />
          </View>
        )}

        {/* ① TOP 7 추천 */}
        <RecommendSection
          sectionType="top7"
          signals={top7}
          loading={loadingTop7}
          error={errorTop7}
          onLoad={loadTop7}
          onAddToBot={handleAddToBot}
        />

        {/* ② 급등락 TOP 7 */}
        <RecommendSection
          sectionType="surge"
          signals={surge7}
          loading={loadingSurge}
          error={errorSurge}
          onLoad={loadSurge7}
          onAddToBot={handleAddToBot}
        />

        {/* ④ 급등직전 TOP 10 */}
        <RecommendSection
          sectionType="presurge"
          signals={preSurge10}
          loading={loadingPreSurge}
          error={errorPreSurge}
          onLoad={loadPreSurge10}
          onAddToBot={handleAddToBot}
        />

        <View style={{ height: 32 }} />
      </ScrollView>

      {/* 봇 추가 확인 모달 */}
      <BotAddModal
        visible={botModalSignal !== null}
        signal={botModalSignal}
        sectionType={botModalSection}
        preview={botPreview}
        loading={botAdding}
        onConfirm={handleBotConfirm}
        onCancel={() => { setBotModalSignal(null); setBotPreview(null); }}
      />
    </ScreenContainer>
  );
}

// ─── 스타일 ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: C.bg },
  header: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 10 },
  headerTitle: { fontSize: 22, fontWeight: '700', color: C.teal, letterSpacing: 0.5 },
  headerSub: { fontSize: 12, color: C.muted, marginTop: 2 },

  searchBox: { flexDirection: 'row', marginHorizontal: 16, marginBottom: 8, gap: 8 },
  searchInput: {
    flex: 1, height: 44, backgroundColor: C.surface, borderRadius: 10,
    paddingHorizontal: 14, color: C.text, fontSize: 14,
    borderWidth: 1, borderColor: C.border,
  },
  searchBtn: {
    width: 72, height: 44, backgroundColor: C.teal, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  searchBtnText: { color: C.bg, fontWeight: '700', fontSize: 14 },

  quickRow: { paddingLeft: 16, marginBottom: 12 },
  quickChip: {
    backgroundColor: C.surface, borderRadius: 20, paddingHorizontal: 14,
    paddingVertical: 6, marginRight: 8, borderWidth: 1, borderColor: C.border,
  },
  quickChipText: { color: C.text, fontSize: 12, fontWeight: '600' },

  section: { paddingHorizontal: 16, marginBottom: 8 },
  sectionHeader: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'flex-start', marginBottom: 10,
  },
  sectionBadge: {
    width: 28, height: 28, borderRadius: 6, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  sectionBadgeText: { fontSize: 13, fontWeight: '900' },
  sectionTitle: { fontSize: 14, fontWeight: '700', color: C.text },
  sectionDesc: { fontSize: 10, color: C.muted, marginTop: 1 },
  refreshText: { fontSize: 13, color: C.teal },

  // 카드
  card: {
    backgroundColor: C.surface, borderRadius: 12, padding: 12,
    marginBottom: 8, borderWidth: 1, borderColor: C.border,
  },
  cardMain: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  cardLeft: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 },
  cardCenter: { alignItems: 'center', flex: 1 },
  cardRight: { alignItems: 'flex-end', flex: 1, gap: 3 },
  rankText: { fontSize: 11, color: C.muted, fontWeight: '600' },
  symbolText: { fontSize: 16, fontWeight: '800', color: C.text },
  priceText: { fontSize: 13, fontWeight: '700', color: C.text },
  changeText: { fontSize: 11, fontWeight: '600' },
  dirBadge: { paddingHorizontal: 7, paddingVertical: 3, borderRadius: 5 },
  dirBadgeText: { fontSize: 11, fontWeight: '800' },
  confText: { fontSize: 11, fontWeight: '700' },

  // 적정가/체결강도 행
  cardExtra: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 10,
    marginTop: 8, paddingTop: 8,
    borderTopWidth: 1, borderTopColor: C.border,
  },
  extraItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  extraLabel: { fontSize: 10, color: C.muted, fontWeight: '600' },
  extraValue: { fontSize: 11, fontWeight: '700' },

  // 봇 추가 버튼
  addBotBtn: {
    marginTop: 10, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12,
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderWidth: 1,
  },
  addBotBadge: {
    width: 22, height: 22, borderRadius: 4,
    alignItems: 'center', justifyContent: 'center',
  },
  addBotBadgeText: { fontSize: 11, fontWeight: '900', color: C.bg },
  addBotBtnText: { fontSize: 13, fontWeight: '700' },

  // 공통
  errorBox: {
    backgroundColor: '#2D1B1B', borderRadius: 10, padding: 14,
    borderWidth: 1, borderColor: '#5A2020', marginBottom: 10,
  },
  errorText: { color: C.red, fontSize: 13 },
  retryBtn: { marginTop: 10, backgroundColor: C.red, borderRadius: 8, padding: 10, alignItems: 'center' },
  retryBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },

  loadingBox: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 16 },
  loadingText: { fontSize: 13, fontWeight: '600' },

  emptyBox: { alignItems: 'center', paddingVertical: 24, gap: 12 },
  emptyText: { color: C.muted, fontSize: 13 },
  loadBtn: { borderRadius: 10, paddingHorizontal: 20, paddingVertical: 10 },
  loadBtnText: { color: C.bg, fontWeight: '700', fontSize: 14 },

  // 급등락 대응 전략 박스
  surgeStrategyBox: {
    marginTop: 10, backgroundColor: '#1A1500', borderRadius: 8,
    padding: 10, borderWidth: 1, borderColor: '#FFA65733',
  },
  surgeStrategyTitle: { fontSize: 12, fontWeight: '800', color: C.orange, marginBottom: 6 },
  surgeStrategyRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginBottom: 4 },
  surgeStrategyItem: { fontSize: 11, fontWeight: '700', color: C.text },
  surgeStrategyNote: { fontSize: 10, color: C.muted, marginTop: 2 },
});

const modalStyles = StyleSheet.create({
  overlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.75)',
    alignItems: 'center', justifyContent: 'center', padding: 20,
  },
  container: {
    width: '100%', backgroundColor: '#161B22', borderRadius: 16,
    padding: 20, borderWidth: 1, borderColor: '#30363D',
  },
  header: { alignItems: 'center', marginBottom: 14 },
  title: { fontSize: 16, fontWeight: '800', color: '#E6EDF3' },
  symbol: { fontSize: 20, fontWeight: '900' },
  sourceBadge: {
    width: 26, height: 26, borderRadius: 5, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  sourceBadgeText: { fontSize: 12, fontWeight: '900' },
  infoBox: {
    backgroundColor: '#0D1117', borderRadius: 8, padding: 10, marginBottom: 14,
    borderWidth: 1, borderColor: '#21262D',
  },
  infoText: { fontSize: 12, color: '#8B949E', textAlign: 'center' },
  previewBox: {
    backgroundColor: '#0D1117', borderRadius: 10, padding: 14, marginBottom: 16,
    borderWidth: 1, borderColor: '#21262D', gap: 6,
  },
  previewRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  previewLabel: { fontSize: 13, color: '#8B949E' },
  previewValue: { fontSize: 13, fontWeight: '700', color: '#E6EDF3' },
  btnRow: { flexDirection: 'row', gap: 10 },
  cancelBtn: {
    flex: 1, backgroundColor: '#21262D', borderRadius: 10,
    paddingVertical: 12, alignItems: 'center',
  },
  cancelBtnText: { color: '#8B949E', fontWeight: '700', fontSize: 14 },
  confirmBtn: {
    flex: 2, backgroundColor: '#238636', borderRadius: 10,
    paddingVertical: 12, alignItems: 'center',
  },
  confirmBtnText: { color: '#fff', fontWeight: '800', fontSize: 14 },
});
