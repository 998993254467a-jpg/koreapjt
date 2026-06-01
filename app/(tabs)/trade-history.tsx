/**
 * trade-history.tsx
 * 날짜별 매매기록 화면 - 전체 / 급등락 전용 탭 분리
 * + 날짜별 보고서 생성 & 공유 기능
 */

import { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Platform,
} from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { ScreenContainer } from '@/components/screen-container';
import {
  loadTradeHistory,
  generateDailyReport,
  generateFullReport,
  type TradeRecord,
} from '@/lib/bot-engine';

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
  orange: '#F0883E',
};

// ─── 유틸 ────────────────────────────────────────────────────────────────────

function formatPrice(n: number): string {
  if (!n || n <= 0) return '-';
  if (n >= 10000) return n.toFixed(1);
  if (n >= 100) return n.toFixed(2);
  if (n >= 1) return n.toFixed(3);
  return n.toFixed(5);
}

function formatDate(dateStr: string): string {
  const parts = dateStr.split('-');
  if (parts.length === 3) return `${parts[1]}/${parts[2]}`;
  return dateStr;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

function formatHolding(minutes?: number): string {
  if (!minutes || minutes <= 0) return '-';
  if (minutes < 60) return `${minutes}분`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}시간 ${m}분` : `${h}시간`;
}

function getSourceLabel(sourceType?: string): { label: string; color: string } {
  switch (sourceType) {
    case 'top7':     return { label: '추', color: '#00D4AA' };
    case 'surge':    return { label: '급', color: '#F0883E' };
    case 'presurge': return { label: '직', color: '#FF6B9D' };
    default:         return { label: '수', color: '#6B7280' };
  }
}

// ─── 보고서 공유 헬퍼 ─────────────────────────────────────────────────────────

async function shareReport(content: string, filename: string): Promise<void> {
  try {
    if (Platform.OS === 'web') {
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      return;
    }
    const fileUri = (FileSystem.documentDirectory ?? '') + filename;
    await FileSystem.writeAsStringAsync(fileUri, content, {
      encoding: FileSystem.EncodingType.UTF8,
    });
    const available = await Sharing.isAvailableAsync();
    if (!available) {
      Alert.alert('공유 불가', '이 기기에서는 파일 공유가 지원되지 않습니다.');
      return;
    }
    await Sharing.shareAsync(fileUri, {
      mimeType: 'text/plain',
      dialogTitle: `${filename} 저장/공유`,
    });
  } catch (e) {
    Alert.alert('오류', `보고서 생성 실패: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ─── 급등락 전용 보고서 생성 ──────────────────────────────────────────────────

function generateSurgeReport(records: TradeRecord[]): string {
  const surgeRecords = records.filter(r => r.sourceType === 'surge');
  if (surgeRecords.length === 0) return '급등락 매매 기록이 없습니다.';

  const totalPnl = surgeRecords.reduce((s, r) => s + r.pnlNet, 0);
  const totalFee = surgeRecords.reduce((s, r) => s + r.fee, 0);
  const wins = surgeRecords.filter(r => r.pnlNet >= 0).length;
  const avgHolding = surgeRecords.reduce((s, r) => s + (r.holdingMinutes ?? 0), 0) / surgeRecords.length;
  const sep = '═'.repeat(52);
  const lines: string[] = [];

  lines.push(sep);
  lines.push('  ⚡ 급등락 전용 매매 보고서');
  lines.push(sep);
  lines.push(`  총 거래: ${surgeRecords.length}건  승률: ${(wins / surgeRecords.length * 100).toFixed(1)}%`);
  lines.push(`  총 순이익: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} USDT`);
  lines.push(`  총 수수료: -${totalFee.toFixed(4)} USDT`);
  lines.push(`  평균 보유시간: ${formatHolding(Math.round(avgHolding))}`);
  lines.push(sep);

  // 날짜별 그룹
  const grouped: Record<string, TradeRecord[]> = {};
  for (const r of surgeRecords) {
    if (!grouped[r.date]) grouped[r.date] = [];
    grouped[r.date].push(r);
  }
  const dates = Object.keys(grouped).sort((a, b) => b.localeCompare(a));

  for (const date of dates) {
    const dayRecords = grouped[date];
    const dayPnl = dayRecords.reduce((s, r) => s + r.pnlNet, 0);
    lines.push(`\n  📅 ${date}  (${dayRecords.length}건 / ${dayPnl >= 0 ? '+' : ''}${dayPnl.toFixed(4)} USDT)`);
    lines.push('  ' + '─'.repeat(48));
    for (const r of dayRecords) {
      const dir = r.direction === 'LONG' ? '▲롱' : '▼숏';
      const pnlSign = r.pnlNet >= 0 ? '+' : '';
      lines.push(`  ${r.symbol.padEnd(12)} ${dir}  ${r.leverage}x`);
      lines.push(`    매입가: ${formatPrice(r.avgPrice).padEnd(12)} 판매가: ${formatPrice(r.entryPrice)}`);
      lines.push(`    정산가: ${formatPrice(r.closePrice).padEnd(12)} 보유: ${formatHolding(r.holdingMinutes)}`);
      lines.push(`    수수료: -${r.fee.toFixed(4)} USDT`);
      lines.push(`    순이익: ${pnlSign}${r.pnlNet.toFixed(4)} USDT (${pnlSign}${r.pnlPct.toFixed(2)}%)`);
      lines.push('');
    }
  }

  lines.push(sep);
  return lines.join('\n');
}

// ─── 매매기록 카드 ────────────────────────────────────────────────────────────

function TradeCard({ record, showSource }: { record: TradeRecord; showSource?: boolean }) {
  const isLong = record.direction === 'LONG';
  const isProfitable = record.pnlNet >= 0;
  const src = getSourceLabel(record.sourceType);

  return (
    <View style={[
      tradeStyles.card,
      { borderLeftColor: isProfitable ? C.green : C.red, borderLeftWidth: 3 },
    ]}>
      {/* 헤더 행 */}
      <View style={tradeStyles.cardHeader}>
        <View style={tradeStyles.cardLeft}>
          <Text style={tradeStyles.symbolText}>{record.symbol}</Text>
          <View style={[tradeStyles.dirBadge, { backgroundColor: isLong ? '#1A3A2A' : '#3A1A1A' }]}>
            <Text style={[tradeStyles.dirText, { color: isLong ? C.green : C.red }]}>
              {isLong ? '▲ 롱' : '▼ 숏'}
            </Text>
          </View>
          <Text style={tradeStyles.leverageText}>{record.leverage}x</Text>
          {showSource && (
            <View style={[tradeStyles.sourceBadge, { backgroundColor: src.color + '33' }]}>
              <Text style={[tradeStyles.sourceText, { color: src.color }]}>{src.label}</Text>
            </View>
          )}
        </View>
        <View style={tradeStyles.cardRight}>
          <Text style={[tradeStyles.pnlText, { color: isProfitable ? C.green : C.red }]}>
            {isProfitable ? '+' : ''}{record.pnlNet.toFixed(4)} USDT
          </Text>
          <Text style={[tradeStyles.pnlPctText, { color: isProfitable ? C.green : C.red }]}>
            ({isProfitable ? '+' : ''}{record.pnlPct.toFixed(2)}%)
          </Text>
        </View>
      </View>

      {/* 가격 행 */}
      <View style={tradeStyles.priceRow}>
        <PriceCol label="매입가" value={formatPrice(record.avgPrice)} color={C.text} />
        <PriceCol label="판매가" value={formatPrice(record.entryPrice)} color={C.teal} />
        <PriceCol label="정산가" value={formatPrice(record.closePrice)} color={isProfitable ? C.green : C.red} />
      </View>

      {/* 수수료 + 보유시간 행 */}
      <View style={tradeStyles.feeRow}>
        <Text style={tradeStyles.feeText}>
          수수료: -{record.fee.toFixed(4)} USDT{'  '}
          <Text style={{ color: isProfitable ? C.green : C.red }}>
            순이익: {isProfitable ? '+' : ''}{record.pnlNet.toFixed(4)} USDT
          </Text>
        </Text>
        <View style={tradeStyles.timeHolder}>
          {record.holdingMinutes != null && record.holdingMinutes > 0 && (
            <Text style={tradeStyles.holdingText}>⏱ {formatHolding(record.holdingMinutes)}</Text>
          )}
          <Text style={tradeStyles.timeText}>{formatTime(record.closedAt)}</Text>
        </View>
      </View>
    </View>
  );
}

function PriceCol({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={tradeStyles.priceCol}>
      <Text style={tradeStyles.priceLabel}>{label}</Text>
      <Text style={[tradeStyles.priceValue, { color }]}>{value}</Text>
    </View>
  );
}

// ─── 날짜 그룹 헤더 ───────────────────────────────────────────────────────────

function DateGroupHeader({
  date, records, onShareReport, sharing,
}: {
  date: string;
  records: TradeRecord[];
  onShareReport: (date: string) => void;
  sharing: boolean;
}) {
  const totalPnl = records.reduce((sum, r) => sum + r.pnlNet, 0);
  const winCount = records.filter(r => r.pnlNet >= 0).length;
  const isProfitable = totalPnl >= 0;
  const winRate = (winCount / records.length * 100).toFixed(0);

  return (
    <View style={tradeStyles.dateHeader}>
      <View style={tradeStyles.dateHeaderTop}>
        <View>
          <Text style={tradeStyles.dateText}>{date}</Text>
          <Text style={tradeStyles.dateSummaryText}>
            {records.length}건 · 승률 {winRate}% (승{winCount}/패{records.length - winCount})
          </Text>
        </View>
        <View style={tradeStyles.dateHeaderRight}>
          <Text style={[tradeStyles.datePnl, { color: isProfitable ? C.green : C.red }]}>
            {isProfitable ? '+' : ''}{totalPnl.toFixed(4)} USDT
          </Text>
          <TouchableOpacity
            style={[tradeStyles.reportBtn, sharing && { opacity: 0.5 }]}
            onPress={() => !sharing && onShareReport(date)}
            disabled={sharing}
          >
            <Text style={tradeStyles.reportBtnText}>
              {sharing ? '생성중...' : '📄 보고서'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

// ─── 급등락 전용 통계 카드 ────────────────────────────────────────────────────

function SurgeStatsCard({ records }: { records: TradeRecord[] }) {
  const totalPnl = records.reduce((s, r) => s + r.pnlNet, 0);
  const totalFee = records.reduce((s, r) => s + r.fee, 0);
  const wins = records.filter(r => r.pnlNet >= 0).length;
  const avgHolding = records.length > 0
    ? records.reduce((s, r) => s + (r.holdingMinutes ?? 0), 0) / records.length
    : 0;
  const winRate = records.length > 0 ? (wins / records.length * 100).toFixed(1) : '0';

  return (
    <View style={surgeStyles.statsCard}>
      <View style={surgeStyles.statsHeader}>
        <Text style={surgeStyles.statsTitle}>⚡ 급등락 전용 통계</Text>
        <Text style={surgeStyles.statsCount}>{records.length}건</Text>
      </View>
      <View style={surgeStyles.statsRow}>
        <SurgeStat label="총 순이익" value={`${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)}`} unit="USDT" color={totalPnl >= 0 ? C.green : C.red} />
        <SurgeStat label="총 수수료" value={`-${totalFee.toFixed(4)}`} unit="USDT" color={C.yellow} />
        <SurgeStat label="승률" value={`${winRate}%`} unit="" color={C.teal} />
        <SurgeStat label="평균보유" value={formatHolding(Math.round(avgHolding))} unit="" color={C.orange} />
      </View>
    </View>
  );
}

function SurgeStat({ label, value, unit, color }: { label: string; value: string; unit: string; color: string }) {
  return (
    <View style={surgeStyles.statItem}>
      <Text style={surgeStyles.statLabel}>{label}</Text>
      <Text style={[surgeStyles.statValue, { color }]}>{value}</Text>
      {unit ? <Text style={surgeStyles.statUnit}>{unit}</Text> : null}
    </View>
  );
}

// ─── 메인 화면 ────────────────────────────────────────────────────────────────

type TabType = 'all' | 'surge';

export default function TradeHistoryScreen() {
  const [records, setRecords] = useState<TradeRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<TabType>('all');
  const [filterDate, setFilterDate] = useState<string | null>(null);
  const [sharingDate, setSharingDate] = useState<string | null>(null);
  const [sharingAll, setSharingAll] = useState(false);
  const [sharingSurge, setSharingSurge] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const history = await loadTradeHistory();
      setRecords(history);
    } catch (e) {
      console.warn('[TradeHistory] 로드 실패:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // 탭별 필터링
  const displayRecords = activeTab === 'surge'
    ? records.filter(r => r.sourceType === 'surge')
    : records;

  // 날짜별 그룹화
  const grouped = displayRecords.reduce<Record<string, TradeRecord[]>>((acc, r) => {
    if (!acc[r.date]) acc[r.date] = [];
    acc[r.date].push(r);
    return acc;
  }, {});

  const dates = Object.keys(grouped).sort((a, b) => b.localeCompare(a));
  const filteredDates = filterDate ? dates.filter(d => d === filterDate) : dates;

  // 전체 통계
  const totalPnl = displayRecords.reduce((sum, r) => sum + r.pnlNet, 0);
  const totalFee = displayRecords.reduce((sum, r) => sum + r.fee, 0);
  const winCount = displayRecords.filter(r => r.pnlNet >= 0).length;
  const winRate = displayRecords.length > 0 ? (winCount / displayRecords.length * 100).toFixed(1) : '0';

  // 날짜별 보고서 공유
  const handleShareDailyReport = useCallback(async (date: string) => {
    setSharingDate(date);
    try {
      const content = await generateDailyReport(date);
      await shareReport(content, `scalping_report_${date}.txt`);
    } finally {
      setSharingDate(null);
    }
  }, []);

  // 전체 보고서 공유
  const handleShareFullReport = useCallback(async () => {
    setSharingAll(true);
    try {
      const content = await generateFullReport();
      const today = new Date().toISOString().slice(0, 10);
      await shareReport(content, `scalping_full_report_${today}.txt`);
    } finally {
      setSharingAll(false);
    }
  }, []);

  // 급등락 전용 보고서 공유
  const handleShareSurgeReport = useCallback(async () => {
    setSharingSurge(true);
    try {
      const content = generateSurgeReport(records);
      const today = new Date().toISOString().slice(0, 10);
      await shareReport(content, `surge_report_${today}.txt`);
    } finally {
      setSharingSurge(false);
    }
  }, [records]);

  const surgeCount = records.filter(r => r.sourceType === 'surge').length;

  return (
    <ScreenContainer containerClassName="bg-[#0D1117]">
      <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* 헤더 */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>📋 매매기록</Text>
          <View style={styles.headerActions}>
            {records.length > 0 && (
              <TouchableOpacity
                style={[styles.fullReportBtn, sharingAll && { opacity: 0.5 }]}
                onPress={handleShareFullReport}
                disabled={sharingAll}
              >
                <Text style={styles.fullReportBtnText}>
                  {sharingAll ? '생성중...' : '📊 전체 보고서'}
                </Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={load} disabled={loading}>
              <Text style={styles.refreshBtn}>{loading ? '로딩...' : '새로고침'}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* 탭 선택 */}
        <View style={styles.tabRow}>
          <TouchableOpacity
            style={[styles.tabBtn, activeTab === 'all' && styles.tabBtnActive]}
            onPress={() => { setActiveTab('all'); setFilterDate(null); }}
          >
            <Text style={[styles.tabText, activeTab === 'all' && styles.tabTextActive]}>
              전체 ({records.length})
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tabBtn, activeTab === 'surge' && styles.tabBtnSurgeActive]}
            onPress={() => { setActiveTab('surge'); setFilterDate(null); }}
          >
            <Text style={[styles.tabText, activeTab === 'surge' && styles.tabTextSurgeActive]}>
              ⚡ 급등락 ({surgeCount})
            </Text>
          </TouchableOpacity>
        </View>

        {/* 급등락 탭 전용 헤더 */}
        {activeTab === 'surge' && surgeCount > 0 && (
          <>
            <SurgeStatsCard records={records.filter(r => r.sourceType === 'surge')} />
            <TouchableOpacity
              style={[styles.surgeReportBtn, sharingSurge && { opacity: 0.5 }]}
              onPress={handleShareSurgeReport}
              disabled={sharingSurge}
            >
              <Text style={styles.surgeReportBtnText}>
                {sharingSurge ? '생성중...' : '⚡ 급등락 전용 보고서 다운로드'}
              </Text>
            </TouchableOpacity>
          </>
        )}

        {/* 전체 통계 (전체 탭) */}
        {activeTab === 'all' && displayRecords.length > 0 && (
          <View style={styles.statsCard}>
            <View style={styles.statsRow}>
              <StatItem label="총 순수익" value={`${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} USDT`} color={totalPnl >= 0 ? C.green : C.red} />
              <StatItem label="총 수수료" value={`-${totalFee.toFixed(4)} USDT`} color={C.yellow} />
              <StatItem label="승률" value={`${winRate}%`} color={C.teal} />
              <StatItem label="총 거래" value={`${displayRecords.length}건`} color={C.muted} />
            </View>
          </View>
        )}

        {/* 날짜 필터 탭 */}
        {dates.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.dateTabRow}>
            <TouchableOpacity
              style={[styles.dateTab, filterDate === null && styles.dateTabActive]}
              onPress={() => setFilterDate(null)}
            >
              <Text style={[styles.dateTabText, filterDate === null && styles.dateTabTextActive]}>전체</Text>
            </TouchableOpacity>
            {dates.map(d => (
              <TouchableOpacity
                key={d}
                style={[styles.dateTab, filterDate === d && styles.dateTabActive]}
                onPress={() => setFilterDate(d)}
              >
                <Text style={[styles.dateTabText, filterDate === d && styles.dateTabTextActive]}>
                  {formatDate(d)}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}

        {/* 빈 상태 */}
        {displayRecords.length === 0 && !loading && (
          <View style={styles.emptyBox}>
            <Text style={styles.emptyText}>
              {activeTab === 'surge' ? '급등락 매매기록이 없습니다' : '아직 매매기록이 없습니다'}
            </Text>
            <Text style={styles.emptySubText}>
              {activeTab === 'surge'
                ? '⚡ 급등락 섹션에서 종목을 추가하면 여기에 기록됩니다'
                : '자동봇이 청산을 완료하면 여기에 기록됩니다'}
            </Text>
          </View>
        )}

        {/* 날짜별 기록 */}
        {filteredDates.map(date => (
          <View key={date}>
            <DateGroupHeader
              date={date}
              records={grouped[date]}
              onShareReport={handleShareDailyReport}
              sharing={sharingDate === date}
            />
            {grouped[date].map(record => (
              <TradeCard key={record.id} record={record} showSource={activeTab === 'all'} />
            ))}
          </View>
        ))}

        <View style={{ height: 32 }} />
      </ScrollView>
    </ScreenContainer>
  );
}

function StatItem({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={styles.statItem}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, { color }]}>{value}</Text>
    </View>
  );
}

// ─── 스타일 ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  headerTitle: { fontSize: 18, fontWeight: '700', color: C.text },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  refreshBtn: { fontSize: 14, color: C.blue, fontWeight: '600' },
  fullReportBtn: {
    backgroundColor: '#1A2A3A',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.blue,
  },
  fullReportBtnText: { fontSize: 12, color: C.blue, fontWeight: '600' },
  // 탭
  tabRow: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  tabBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 10,
    alignItems: 'center',
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
  },
  tabBtnActive: { backgroundColor: '#1A2A3A', borderColor: C.blue },
  tabBtnSurgeActive: { backgroundColor: '#2A1A0A', borderColor: C.orange },
  tabText: { fontSize: 13, color: C.muted, fontWeight: '600' },
  tabTextActive: { color: C.blue },
  tabTextSurgeActive: { color: C.orange },
  // 급등락 보고서 버튼
  surgeReportBtn: {
    marginHorizontal: 12,
    marginBottom: 8,
    backgroundColor: '#2A1A0A',
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: C.orange,
  },
  surgeReportBtnText: { fontSize: 13, color: C.orange, fontWeight: '700' },
  // 통계
  statsCard: {
    margin: 12,
    backgroundColor: C.surface,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: C.border,
  },
  statsRow: { flexDirection: 'row', justifyContent: 'space-between' },
  statItem: { alignItems: 'center', flex: 1 },
  statLabel: { fontSize: 10, color: C.muted, marginBottom: 3 },
  statValue: { fontSize: 12, fontWeight: '700' },
  // 날짜 필터
  dateTabRow: { paddingHorizontal: 12, marginBottom: 8 },
  dateTab: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    marginRight: 8,
    borderRadius: 20,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
  },
  dateTabActive: { backgroundColor: '#1A3A5A', borderColor: C.blue },
  dateTabText: { fontSize: 13, color: C.muted },
  dateTabTextActive: { color: C.blue, fontWeight: '600' },
  emptyBox: { alignItems: 'center', paddingVertical: 60 },
  emptyText: { fontSize: 16, color: C.muted, marginBottom: 8 },
  emptySubText: { fontSize: 13, color: '#555', textAlign: 'center', paddingHorizontal: 32 },
});

const tradeStyles = StyleSheet.create({
  card: {
    marginHorizontal: 12,
    marginBottom: 8,
    backgroundColor: C.surface,
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: C.border,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  cardLeft: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cardRight: { alignItems: 'flex-end' },
  symbolText: { fontSize: 15, fontWeight: '700', color: C.text },
  dirBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  dirText: { fontSize: 11, fontWeight: '700' },
  leverageText: { fontSize: 12, color: C.muted },
  sourceBadge: { paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4 },
  sourceText: { fontSize: 10, fontWeight: '700' },
  pnlText: { fontSize: 14, fontWeight: '700' },
  pnlPctText: { fontSize: 12, fontWeight: '600' },
  priceRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  priceCol: { flex: 1, alignItems: 'center' },
  priceLabel: { fontSize: 10, color: C.muted, marginBottom: 2 },
  priceValue: { fontSize: 12, fontWeight: '600' },
  feeRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  feeText: { fontSize: 11, color: C.yellow, flex: 1 },
  timeHolder: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  holdingText: { fontSize: 11, color: C.orange },
  timeText: { fontSize: 11, color: C.muted },
  dateHeader: {
    marginHorizontal: 12,
    marginTop: 12,
    marginBottom: 4,
    backgroundColor: '#0F1923',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#1E3A5A',
  },
  dateHeaderTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  dateText: { fontSize: 15, fontWeight: '700', color: C.blue, marginBottom: 2 },
  dateSummaryText: { fontSize: 12, color: C.muted },
  dateHeaderRight: { alignItems: 'flex-end', gap: 6 },
  datePnl: { fontSize: 15, fontWeight: '700' },
  reportBtn: {
    backgroundColor: '#1A2A1A',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.green,
  },
  reportBtnText: { fontSize: 11, color: C.green, fontWeight: '600' },
});

const surgeStyles = StyleSheet.create({
  statsCard: {
    margin: 12,
    marginBottom: 6,
    backgroundColor: '#1A1000',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#F59E0B44',
  },
  statsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  statsTitle: { fontSize: 14, fontWeight: '700', color: C.orange },
  statsCount: { fontSize: 13, color: C.muted },
  statsRow: { flexDirection: 'row', justifyContent: 'space-between' },
  statItem: { alignItems: 'center', flex: 1 },
  statLabel: { fontSize: 10, color: C.muted, marginBottom: 3 },
  statValue: { fontSize: 12, fontWeight: '700' },
  statUnit: { fontSize: 9, color: C.muted },
});
