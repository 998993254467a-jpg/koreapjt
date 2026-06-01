import { useState, useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  AppState,
  AppStateStatus,
  Platform,
} from 'react-native';
import { useKeepAwake } from 'expo-keep-awake';
import { ScreenContainer } from '@/components/screen-container';
import { ChartModal } from '@/components/chart-modal';
import { trpc } from '@/lib/trpc';
import type {
  BotPosition,
  BotLog,
  BotState,
  SectionType,
} from '@/server/server-bot-engine';

// ─── 탭 타입 ─────────────────────────────────────────────────────────────────
type BotTab = 'normal' | 'surge' | 'presurge';

// ─── 색상 팔레트 ──────────────────────────────────────────────────────────────
const C = {
  bg: '#0D1117', surface: '#161B22', border: '#21262D',
  text: '#E6EDF3', muted: '#8B949E', green: '#3FB950',
  red: '#F85149', teal: '#00D4AA', yellow: '#D29922', orange: '#F0883E',
  purple: '#A371F7', pink: '#FF6B9D',
};

// ─── 탭 메타 ─────────────────────────────────────────────────────────────────
const TAB_META: Record<BotTab, {
  label: string; icon: string; color: string; bg: string; activeBg: string;
  desc: string;
}> = {
  normal:   { label: '일반봇',      icon: '📊', color: C.teal,   bg: '#0D2A2A', activeBg: '#0D2A2A', desc: 'TOP7 스캘핑 · 복리 자동관리' },
  surge:    { label: '급등봇',      icon: '⚡', color: C.orange, bg: '#2A1800', activeBg: '#2A1800', desc: '급등락 포착 · 고수익 전략' },
  presurge: { label: '급등직전봇',  icon: '🚀', color: C.pink,   bg: '#2A0A1A', activeBg: '#2A0A1A', desc: '급등 선점 · 초기 진입' },
};

const SOURCE_META: Record<SectionType, { badge: string; color: string; bg: string }> = {
  top7:     { badge: '추', color: C.teal,   bg: '#0A2A2A' },
  surge:    { badge: '급', color: C.orange, bg: '#2A1500' },
  presurge: { badge: '직', color: C.pink,   bg: '#2A0A1A' },
};

// ─── PnL 바 ──────────────────────────────────────────────────────────────────
function PnlBar({ pct }: { pct: number }) {
  const clamped = Math.max(-100, Math.min(100, pct));
  const isPos = clamped >= 0;
  const fillFlex = Math.abs(clamped) / 2;
  const emptyFlex = 50 - fillFlex;
  return (
    <View style={pnlBarSt.track}>
      {isPos ? <View style={{ flex: 50 }} /> : (
        <><View style={{ flex: emptyFlex }} /><View style={[pnlBarSt.fill, { flex: fillFlex, backgroundColor: C.red }]} /></>
      )}
      <View style={pnlBarSt.center} />
      {isPos ? (
        <><View style={[pnlBarSt.fill, { flex: fillFlex, backgroundColor: C.green }]} /><View style={{ flex: emptyFlex }} /></>
      ) : <View style={{ flex: 50 }} />}
    </View>
  );
}
const pnlBarSt = StyleSheet.create({
  track: { height: 4, backgroundColor: '#21262D', borderRadius: 2, flexDirection: 'row', overflow: 'hidden', marginTop: 6, marginBottom: 2 },
  fill: { height: 4 },
  center: { width: 1, height: 4, backgroundColor: '#555' },
});

// ─── 가격 포맷 ────────────────────────────────────────────────────────────────
function formatPrice(n: number): string {
  if (n === 0) return '-';
  if (n >= 10000) return n.toFixed(1);
  if (n >= 100) return n.toFixed(2);
  if (n >= 1) return n.toFixed(3);
  return n.toFixed(5);
}

// ─── 포지션 카드 (급등락 전환 버튼 제거 — 앱 자동 처리) ─────────────────────
function PositionCard({
  pos, excludeList, onExcludeChange,
}: {
  pos: BotPosition;
  excludeList: string[];
  onExcludeChange: () => void;
}) {
  const [chartVisible, setChartVisible] = useState(false);
  const isExcluded = excludeList.includes(pos.bybitSymbol);
  const isLong = pos.side === 'Buy';
  const pnlColor = pos.pnlPct >= 0 ? C.green : C.red;
  const pnlSign = pos.pnlPct >= 0 ? '+' : '';

  const cardBorderColor =
    pos.pnlPct >= 50 ? '#39D353' :
    pos.pnlPct <= -50 ? '#FF3B30' :
    pos.pnlPct > 10 ? C.green :
    pos.pnlPct < -10 ? C.red : C.border;
  const cardBorderWidth = Math.abs(pos.pnlPct) >= 50 ? 3 : 1.5;

  const nextActionPct = pos.nextActionPct ?? 30;
  const absPnl = Math.abs(pos.pnlPct);
  const progressToNext = absPnl >= nextActionPct ? 100 : Math.round((absPnl / nextActionPct) * 100);
  const sourceMeta = SOURCE_META[pos.sourceType ?? 'top7'];

  const addExclude = trpc.bot.addExclude.useMutation({ onSuccess: onExcludeChange, onError: (e) => Alert.alert('오류', e.message) });
  const removeExclude = trpc.bot.removeExclude.useMutation({ onSuccess: onExcludeChange, onError: (e) => Alert.alert('오류', e.message) });
  const removePosition = trpc.bot.removePosition.useMutation({ onSuccess: onExcludeChange, onError: (e) => Alert.alert('오류', e.message) });

  const handleExcludeToggle = () => {
    if (isExcluded) {
      Alert.alert('제외 해제', `${pos.displaySymbol}을(를) 제외 목록에서 해제합니다.`, [
        { text: '취소', style: 'cancel' },
        { text: '해제', onPress: () => removeExclude.mutate(pos.bybitSymbol) },
      ]);
    } else {
      Alert.alert(
        '자동봇 제외',
        `${pos.displaySymbol}을(를) 자동봇에서 제외합니다.\n\n포지션 목록에서 즉시 사라지며, 이후 자동 진입이 차단됩니다.\n\n매매 중인 포지션은 바이비트에서 직접 확인하세요.`,
        [
          { text: '취소', style: 'cancel' },
          { text: '제외', style: 'destructive', onPress: () => {
            addExclude.mutate(pos.bybitSymbol);
            removePosition.mutate(pos.bybitSymbol);
          }},
        ]
      );
    }
  };

  // 강제청산 근접 경고
  const liqWarning: number | null = (() => {
    if (pos.liqPrice <= 0 || pos.markPrice <= 0) return null;
    const distPct = Math.abs(pos.markPrice - pos.liqPrice) / pos.markPrice * 100;
    return distPct < 15 ? distPct : null;
  })();

  return (
    <>
      <ChartModal visible={chartVisible} symbol={pos.bybitSymbol} displaySymbol={pos.displaySymbol} side={pos.side} onClose={() => setChartVisible(false)} />
      <View style={[s.posCard, { borderColor: cardBorderColor, borderWidth: cardBorderWidth }]}>
        {/* 강제청산 경고 배너 */}
        {liqWarning !== null && (
          <View style={s.liqWarnBanner}>
            <Text style={s.liqWarnText}>⚠️ 강제청산까지 {liqWarning.toFixed(1)}% — 앱이 자동 대응 중</Text>
          </View>
        )}

        {/* 헤더 */}
        <View style={s.posHeader}>
          <View style={s.posLeft}>
            <TouchableOpacity onPress={() => setChartVisible(true)} activeOpacity={0.7} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={[s.posSymbol, { textDecorationLine: 'underline', textDecorationColor: C.teal }]}>{pos.displaySymbol}</Text>
              <Text style={{ fontSize: 10, color: C.teal }}>📈</Text>
            </TouchableOpacity>
            <View style={[s.posBadge, { backgroundColor: isLong ? '#1A3A2A' : '#3A1A1A' }]}>
              <Text style={[s.posBadgeText, { color: isLong ? C.green : C.red }]}>{isLong ? '▲ 롱' : '▼ 숏'}</Text>
            </View>
            <Text style={s.posLev}>{pos.leverage}x</Text>
            {pos.sourceType && (
              <View style={[s.posBadge, { backgroundColor: sourceMeta.bg }]}>
                <Text style={[s.posBadgeText, { color: sourceMeta.color }]}>{sourceMeta.badge}</Text>
              </View>
            )}
            {pos.trailingActivated && (
              <View style={[s.posBadge, { backgroundColor: '#1A2A1A' }]}>
                <Text style={[s.posBadgeText, { color: C.green }]}>🔒 트레일</Text>
              </View>
            )}
          </View>
          <View style={{ alignItems: 'flex-end', gap: 4 }}>
            <Text style={[s.posPnlPct, { color: pnlColor }]}>{pnlSign}{pos.pnlPct.toFixed(2)}%</Text>
            <Text style={[s.posPnlUsdt, { color: pnlColor }]}>{pos.unrealisedPnl >= 0 ? '+' : ''}{pos.unrealisedPnl.toFixed(2)} USDT</Text>
          </View>
        </View>

        <PnlBar pct={pos.pnlPct} />

        {/* 다음 액션 진행률 */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <Text style={{ fontSize: 10, color: C.muted }}>
            다음 {pos.pnlPct >= 0 ? '익절' : '손절'} {nextActionPct}%까지
          </Text>
          <View style={{ flex: 1, height: 3, backgroundColor: '#21262D', borderRadius: 2, overflow: 'hidden' }}>
            <View style={{ width: `${progressToNext}%` as `${number}%`, height: 3, backgroundColor: pos.pnlPct >= 0 ? C.green : C.red, borderRadius: 2 }} />
          </View>
          <Text style={{ fontSize: 10, color: C.muted }}>{progressToNext}%</Text>
        </View>

        {/* 가격 그리드 */}
        <View style={s.priceGrid}>
          <PriceItem label="진입가" value={formatPrice(pos.entryPrice)} color={C.text} />
          <PriceItem label="현재가" value={formatPrice(pos.markPrice)} color={pnlColor} highlight />
          <PriceItem label="청산가" value={formatPrice(pos.liqPrice)} color={C.red} />
          <PriceItem label="손절가" value={formatPrice(pos.stopLoss)} color={C.yellow} />
        </View>

        {/* 금액 행 */}
        <View style={s.amountRow}>
          <View style={s.amountItem}><Text style={s.amountLabel}>수량</Text><Text style={s.amountValue}>{pos.size}</Text></View>
          <View style={s.amountDivider} />
          <View style={s.amountItem}><Text style={s.amountLabel}>추가매수</Text><Text style={[s.amountValue, { color: pos.addCount > 0 ? C.yellow : C.muted }]}>{pos.addCount}회</Text></View>
          <View style={s.amountDivider} />
          <View style={s.amountItem}><Text style={s.amountLabel}>신뢰도</Text><Text style={[s.amountValue, { color: (pos.confidence ?? 0) >= 90 ? C.green : C.yellow }]}>{pos.confidence ? `${pos.confidence}%` : '-'}</Text></View>
          <View style={s.amountDivider} />
          <View style={s.amountItem}><Text style={s.amountLabel}>증거금</Text><Text style={s.amountValue}>{pos.initialMarginUsdt ? `${pos.initialMarginUsdt.toFixed(1)}U` : '-'}</Text></View>
        </View>

        {/* 라이브 분석 */}
        {pos.liveSignalDirection && (
          <View style={{ marginTop: 8, backgroundColor: '#0D1F2D', borderRadius: 8, padding: 8 }}>
            <Text style={{ fontSize: 11, color: C.muted }}>
              🔍 라이브: {pos.liveSignalDirection} {pos.liveSignalConfidence}%
              {pos.liveSignalReason ? ` — ${pos.liveSignalReason}` : ''}
            </Text>
          </View>
        )}

        {/* 자동 처리 안내 + 종목 제외 버튼 */}
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, alignItems: 'center' }}>
          <View style={s.autoLabel}>
            <Text style={s.autoLabelText}>🤖 모드전환 자동</Text>
          </View>
          <TouchableOpacity
            style={[s.actionBtn, { borderColor: isExcluded ? C.green : C.red, flex: 1 }]}
            onPress={handleExcludeToggle}
            activeOpacity={0.7}
          >
            <Text style={[s.actionBtnText, { color: isExcluded ? C.green : C.red }]}>
              {isExcluded ? '✓ 제외해제' : '✕ 봇제외'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </>
  );
}

// ─── 가격 아이템 ──────────────────────────────────────────────────────────────
function PriceItem({ label, value, color, highlight }: { label: string; value: string; color: string; highlight?: boolean }) {
  return (
    <View style={[s.priceItem, highlight && s.priceItemHighlight]}>
      <Text style={s.priceLabel}>{label}</Text>
      <Text style={[s.priceValue, { color }]}>{value}</Text>
    </View>
  );
}

// ─── 로그 아이템 ──────────────────────────────────────────────────────────────
function LogItem({ log }: { log: BotLog }) {
  const levelColor: Record<string, string> = { INFO: C.muted, WARN: C.yellow, ERROR: C.red, TRADE: C.teal };
  const t = new Date(log.time);
  const ts = `${t.getHours().toString().padStart(2, '0')}:${t.getMinutes().toString().padStart(2, '0')}:${t.getSeconds().toString().padStart(2, '0')}`;
  return (
    <View style={s.logRow}>
      <Text style={s.logTime}>{ts}</Text>
      <Text style={[s.logLevel, { color: levelColor[log.level] ?? C.muted }]}>[{log.level}]</Text>
      <Text style={[s.logMsg, { color: log.level === 'TRADE' ? C.teal : C.text }]} numberOfLines={2}>{log.message}</Text>
    </View>
  );
}

// ─── 요약 카드 ────────────────────────────────────────────────────────────────
function SummaryCard({ label, value, color, sub }: { label: string; value: string; color: string; sub?: string }) {
  return (
    <View style={s.summaryCard}>
      <Text style={s.summaryLabel}>{label}</Text>
      <Text style={[s.summaryValue, { color }]}>{value}</Text>
      {sub ? <Text style={s.summarySub}>{sub}</Text> : null}
    </View>
  );
}

// ─── 위험도 게이지 ────────────────────────────────────────────────────────────
function RiskGauge({ risk }: { risk: number }) {
  const color = risk >= 70 ? C.red : risk >= 50 ? C.yellow : risk >= 30 ? C.orange : C.green;
  const label = risk >= 70 ? '위험' : risk >= 50 ? '주의' : risk >= 30 ? '보통' : '안전';
  return (
    <View style={s.riskGauge}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
        <Text style={s.riskLabel}>강제청산 위험도</Text>
        <Text style={[s.riskValue, { color }]}>{risk}% {label}</Text>
      </View>
      <View style={s.riskTrack}>
        <View style={[s.riskFill, { width: `${Math.min(100, risk)}%` as `${number}%`, backgroundColor: color }]} />
      </View>
    </View>
  );
}

// ─── 안전 인출 패널 ───────────────────────────────────────────────────────────
function WithdrawalPanel({ state }: { state: BotState }) {
  const ws = state.withdrawalSafety;
  if (!ws) return null;

  const [selectedPct, setSelectedPct] = useState(50);
  const minW = ws.minWithdrawal;
  const maxW = ws.maxWithdrawal;
  const selectedAmount = minW + (maxW - minW) * (selectedPct / 100);

  const steps = [0, 25, 50, 75, 100];
  const stepLabels = ['최소', '25%', '중간', '75%', '최대'];

  return (
    <View style={s.withdrawPanel}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Text style={s.withdrawTitle}>💰 안전 인출 계산기</Text>
        {ws.canWithdraw ? (
          <View style={[s.badge, { backgroundColor: '#1A2A1A', borderColor: C.green }]}>
            <Text style={[s.badgeText, { color: C.green }]}>봇 영향 없음</Text>
          </View>
        ) : (
          <View style={[s.badge, { backgroundColor: '#2A1A1A', borderColor: C.red }]}>
            <Text style={[s.badgeText, { color: C.red }]}>인출 불가</Text>
          </View>
        )}
      </View>

      <View style={s.withdrawGrid}>
        <View style={s.withdrawItem}>
          <Text style={s.withdrawItemLabel}>최소 인출</Text>
          <Text style={[s.withdrawItemValue, { color: ws.canWithdraw ? C.yellow : C.muted }]}>{minW.toFixed(2)} USDT</Text>
        </View>
        <View style={s.withdrawDivider} />
        <View style={s.withdrawItem}>
          <Text style={s.withdrawItemLabel}>최대 인출</Text>
          <Text style={[s.withdrawItemValue, { color: ws.canWithdraw ? C.green : C.muted }]}>{maxW.toFixed(2)} USDT</Text>
        </View>
        <View style={s.withdrawDivider} />
        <View style={s.withdrawItem}>
          <Text style={s.withdrawItemLabel}>최적 잔고</Text>
          <Text style={[s.withdrawItemValue, { color: C.teal }]}>{ws.optimalBalance.toFixed(2)} USDT</Text>
        </View>
      </View>

      {/* 단계 선택 버튼 */}
      {ws.canWithdraw && (
        <View style={{ marginTop: 12 }}>
          <Text style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>인출 금액 선택 (최소 ~ 최대 범위)</Text>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {steps.map((step, i) => (
              <TouchableOpacity
                key={step}
                style={[s.stepBtn, selectedPct === step && { backgroundColor: '#1A3A2A', borderColor: C.green }]}
                onPress={() => setSelectedPct(step)}
                activeOpacity={0.7}
              >
                <Text style={[s.stepBtnText, selectedPct === step && { color: C.green }]}>{stepLabels[i]}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={[s.selectedAmount, { marginTop: 10 }]}>
            <Text style={{ fontSize: 12, color: C.muted }}>선택 금액</Text>
            <Text style={{ fontSize: 20, fontWeight: '800', color: C.teal }}>{selectedAmount.toFixed(2)} USDT</Text>
            <Text style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
              인출 후 예상 가용 잔고: {ws.balanceAfterMax.toFixed(2)} USDT
            </Text>
            <Text style={{ fontSize: 11, color: ws.liqRiskAfterMax >= 50 ? C.red : C.muted, marginTop: 2 }}>
              인출 후 강제청산 위험도: {ws.liqRiskAfterMax}%
            </Text>
          </View>
        </View>
      )}

      {ws.warnings.length > 0 && (
        <View style={{ marginTop: 10, backgroundColor: '#0D1F2D', borderRadius: 8, padding: 8 }}>
          {ws.warnings.map((w, i) => (
            <Text key={i} style={{ fontSize: 11, color: C.yellow, lineHeight: 16 }}>⚠️ {w}</Text>
          ))}
        </View>
      )}
    </View>
  );
}

// ─── 복리 패널 ────────────────────────────────────────────────────────────────
function CompoundPanel({ state }: { state: BotState }) {
  const multiplier = state.compoundMultiplier ?? 1;
  const totalPnlPct = state.totalPnlPctAll ?? 0;
  const dailyPnlPct = state.dailyPnlPct ?? 0;
  const pnlColor = totalPnlPct >= 0 ? C.green : C.red;
  const dailyColor = dailyPnlPct >= 0 ? C.green : C.red;
  const targetPct = state.dailyTargetPct ?? 5;
  const progressPct = Math.min(100, Math.max(0, (dailyPnlPct / targetPct) * 100));
  const dailyMode = state.dailyMode ?? 'AGGRESSIVE';
  const modeColor = dailyMode === 'CONSERVATIVE' ? C.green : dailyMode === 'SPRINT' ? C.orange : C.teal;
  const modeLabel = dailyMode === 'CONSERVATIVE' ? '🎉 보수' : dailyMode === 'SPRINT' ? '⚡ 스프린트' : '🚀 공격';

  return (
    <View style={s.compoundPanel}>
      <Text style={s.compoundTitle}>📈 복리 운용 현황</Text>
      <View style={s.compoundGrid}>
        <View style={s.compoundItem}>
          <Text style={s.compoundLabel}>복리 배수</Text>
          <Text style={[s.compoundValue, { color: multiplier >= 1.5 ? C.green : multiplier >= 1 ? C.teal : C.red }]}>
            {multiplier.toFixed(2)}x
          </Text>
        </View>
        <View style={s.compoundDivider} />
        <View style={s.compoundItem}>
          <Text style={s.compoundLabel}>누적 수익률</Text>
          <Text style={[s.compoundValue, { color: pnlColor }]}>
            {totalPnlPct >= 0 ? '+' : ''}{totalPnlPct.toFixed(1)}%
          </Text>
        </View>
        <View style={s.compoundDivider} />
        <View style={s.compoundItem}>
          <Text style={s.compoundLabel}>오늘 수익</Text>
          <Text style={[s.compoundValue, { color: dailyColor }]}>
            {dailyPnlPct >= 0 ? '+' : ''}{dailyPnlPct.toFixed(1)}%
          </Text>
        </View>
      </View>
      {/* 24시간 일일 목표 진행 바 (AI 검증 v44: 1.5% 안정 / 3% 적극 / 5% 최상) */}
      <View style={{ marginTop: 12 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={[s.badge, { backgroundColor: '#1A1A2A', borderColor: modeColor, paddingHorizontal: 8, paddingVertical: 3 }]}>
              <Text style={[s.badgeText, { color: modeColor, fontSize: 11 }]}>{modeLabel}</Text>
            </View>
            <Text style={{ fontSize: 10, color: C.muted }}>일일 {targetPct}% 목표</Text>
          </View>
          <Text style={{ fontSize: 12, fontWeight: '700', color: progressPct >= 100 ? C.green : C.text }}>
            {dailyPnlPct >= 0 ? '+' : ''}{dailyPnlPct.toFixed(1)}% / {targetPct}%
          </Text>
        </View>
        <View style={{ height: 8, backgroundColor: '#21262D', borderRadius: 4, overflow: 'hidden' }}>
          <View style={{
            width: `${progressPct}%` as `${number}%`,
            height: 8,
            backgroundColor: progressPct >= 100 ? C.green : dailyMode === 'SPRINT' ? C.orange : C.teal,
            borderRadius: 4,
          }} />
        </View>
        {state.dailyModeReason ? (
          <Text style={{ fontSize: 10, color: C.muted, marginTop: 4 }} numberOfLines={1}>{state.dailyModeReason}</Text>
        ) : null}
      </View>

      {/* 8대 요소 조합 점수 */}
      {state.lastComboScore != null && (
        <View style={{ marginTop: 8, backgroundColor: '#0D1F2D', borderRadius: 8, padding: 8, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ fontSize: 11, color: C.muted }}>8대 요소:</Text>
          <View style={[s.badge, {
            backgroundColor: state.lastComboDirection === 'BULLISH' ? '#1A2A1A' : state.lastComboDirection === 'BEARISH' ? '#2A1A1A' : '#1A1A2A',
            borderColor: state.lastComboDirection === 'BULLISH' ? C.green : state.lastComboDirection === 'BEARISH' ? C.red : C.muted,
          }]}>
            <Text style={[s.badgeText, { color: state.lastComboDirection === 'BULLISH' ? C.green : state.lastComboDirection === 'BEARISH' ? C.red : C.muted }]}>
              {state.lastComboDirection === 'BULLISH' ? '🟢 상승' : state.lastComboDirection === 'BEARISH' ? '🔴 하락' : '⚪ 중립'}
            </Text>
          </View>
          {state.lastOptimalComboName ? (
            <Text style={{ fontSize: 11, color: C.teal, flex: 1 }} numberOfLines={1}>{state.lastOptimalComboName}</Text>
          ) : null}
          <Text style={{ fontSize: 13, fontWeight: '700', color: (state.lastComboScore ?? 0) >= 0 ? C.green : C.red }}>
            {(state.lastComboScore ?? 0) >= 0 ? '+' : ''}{state.lastComboScore}
          </Text>
        </View>
      )}

      {(state.consecutiveLosses ?? 0) >= 2 && (
        <View style={[s.badge, { backgroundColor: '#2A1A1A', borderColor: C.red, marginTop: 8, alignSelf: 'flex-start' }]}>
          <Text style={[s.badgeText, { color: C.red }]}>⚠️ {state.lossLevelMessage ?? `연속 손실 ${state.consecutiveLosses}회 — 자동 조정 중`}</Text>
        </View>
      )}
    </View>
  );
}

// ─── 메인 화면 ────────────────────────────────────────────────────────────────
export default function BotScreen() {
  const [activeTab, setActiveTab] = useState<BotTab>('normal');
  const [showWithdrawal, setShowWithdrawal] = useState(false);
  const [showLossAnalysis, setShowLossAnalysis] = useState(false);
  const [showBacktest, setShowBacktest] = useState(false);
  const [backtestResult, setBacktestResult] = useState<{
    symbol: string; totalTrades: number; winRate: number; profitFactor: number;
    sharpeRatio: number; maxDrawdownPct: number; totalNetPnlPct: number;
    avgDailyPnlPct: number; bestRegime: string; worstRegime: string;
    isOverfitted: boolean; recommendation: string;
    optimalRsiRanges: { longMin: number; longMax: number; shortMin: number; shortMax: number };
    validationPeriods: Array<{ periodStart: number; periodEnd: number; totalTrades: number; winRate: number; profitFactor: number; totalNetPnlPct: number; maxDrawdownPct: number; regimeBreakdown: Record<string, { trades: number; winRate: number; pnl: number }> }>;
    note: string;
  } | null>(null);
  const [isInBackground, setIsInBackground] = useState(false);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  // ─── 서버 상태 폴링 ──────────────────────────────────────────────────────
  const { data: serverState, refetch: refetchState } = trpc.bot.getState.useQuery(undefined, {
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  });
  const { data: excludeListData, refetch: refetchExclude } = trpc.bot.getExcludeList.useQuery(undefined, {
    refetchInterval: 10000,
  });
  const { data: stratStats } = trpc.bot.getStrategyStats.useQuery(undefined, {
    refetchInterval: 15000,
  });
  const { data: lossAnalysis } = trpc.bot.getLossAnalysis.useQuery(undefined, {
    refetchInterval: 30000,
    enabled: showLossAnalysis,
  });
  const { data: regimeData } = trpc.backtest.getRegime.useQuery(undefined, {
    refetchInterval: 60000,
  });
  const runBacktest = trpc.backtest.runMockWalkForward.useMutation({
    onSuccess: (res) => setBacktestResult(res),
    onError: (e) => Alert.alert('백테스트 오류', e.message),
  });

  const state: BotState = serverState ?? {
    running: false, normalRunning: false, surgeRunning: false, presurgeRunning: false,
    positions: [], logs: [], lastTickAt: 0, totalPnl: 0, autoEntry: true,
    dailyTargetPct: 1.5, dailyMode: 'AGGRESSIVE' as const, // AI 검증 v44: 1.5% 현실적 목표
  };
  const excludeList = excludeListData ?? [];

  const isAnyBotRunning = state.normalRunning || state.surgeRunning || state.presurgeRunning || state.running;
  useKeepAwake(isAnyBotRunning ? 'bot-running' : 'bot-idle');

  useEffect(() => {
    if (Platform.OS === 'web') return;
    const subscription = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      const prev = appStateRef.current;
      appStateRef.current = nextState;
      if (prev === 'active' && (nextState === 'background' || nextState === 'inactive')) {
        setIsInBackground(true);
      } else if ((prev === 'background' || prev === 'inactive') && nextState === 'active') {
        setIsInBackground(false);
        refetchState();
      }
    });
    return () => subscription.remove();
  }, [refetchState]);

  // ─── 뮤테이션 ────────────────────────────────────────────────────────────
  const startAll = trpc.bot.startNormalBot.useMutation({
    onSuccess: (res) => {
      if (!res.success) Alert.alert('시작 실패', res.message);
      refetchState();
    },
    onError: (e) => Alert.alert('오류', e.message),
  });
  const stopAll = trpc.bot.stopAll.useMutation({
    onSuccess: () => refetchState(),
    onError: (e) => Alert.alert('오류', e.message),
  });
  const manualTick = trpc.bot.manualTick.useMutation({
    onSuccess: (res) => {
      if (!res.success) Alert.alert('분석 실패', res.message);
      refetchState();
    },
    onError: (e) => Alert.alert('오류', e.message),
  });

  // ─── 파생 상태 ───────────────────────────────────────────────────────────
  const normalPositions = state.positions.filter(p => p.sourceType === 'top7' || !p.sourceType);
  const surgePositions  = state.positions.filter(p => p.sourceType === 'surge');
  const presurgePositions = state.positions.filter(p => p.sourceType === 'presurge');

  const tabPositions: Record<BotTab, BotPosition[]> = {
    normal: normalPositions,
    surge: surgePositions,
    presurge: presurgePositions,
  };
  const activePositions = tabPositions[activeTab];

  const totalLivePnl = state.positions.reduce((sum, p) => sum + p.unrealisedPnl, 0);
  const lastTickStr = state.lastTickAt > 0 ? new Date(state.lastTickAt).toLocaleTimeString('ko-KR') : '-';

  const refreshAll = useCallback(() => {
    refetchExclude();
    refetchState();
  }, [refetchExclude, refetchState]);

  const handleStartAll = useCallback(() => {
    Alert.alert(
      '🤖 자동매매 시작',
      '3개 봇(일반/급등/급등직전)이 동시에 시작됩니다.\n\n• 종목 선택: 앱 자동\n• 모드 전환: 앱 자동\n• 복리 운용: 자동\n• 강제청산 방지: 자동\n\n시작하시겠습니까?',
      [
        { text: '취소', style: 'cancel' },
        { text: '시작', onPress: () => startAll.mutate() },
      ]
    );
  }, [startAll]);

  const handleStopAll = useCallback(() => {
    Alert.alert(
      '⏹ 전체 봇 정지',
      '모든 봇을 정지합니다.\n기존 포지션은 바이비트에 유지됩니다.',
      [
        { text: '취소', style: 'cancel' },
        { text: '정지', style: 'destructive', onPress: () => stopAll.mutate() },
      ]
    );
  }, [stopAll]);

  return (
    <ScreenContainer containerClassName="bg-[#0D1117]">
      <ScrollView style={s.scroll} showsVerticalScrollIndicator={false}>

        {/* ── 헤더 ── */}
        <View style={s.header}>
          <View>
            <Text style={s.headerTitle}>🤖 JT POWER 자동매매</Text>
            <Text style={s.headerSub}>완전 자동 · 마지막 분석: {lastTickStr}</Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
            {isAnyBotRunning && (
              <View style={s.keepAwakeBadge}><Text style={s.keepAwakeText}>🔆 화면유지</Text></View>
            )}
            <View style={s.serverBadge}><Text style={s.serverBadgeText}>🖥 서버봇</Text></View>
            {/* 봇 상태 점 */}
            <View style={[s.statusDot, { backgroundColor: state.normalRunning ? C.teal : '#333' }]} />
            <View style={[s.statusDot, { backgroundColor: state.surgeRunning ? C.orange : '#333' }]} />
            <View style={[s.statusDot, { backgroundColor: state.presurgeRunning ? C.pink : '#333' }]} />
          </View>
        </View>

        {/* 백그라운드 배너 */}
        {isInBackground && isAnyBotRunning && (
          <View style={s.bgBanner}>
            <Text style={s.bgBannerText}>✅ 서버 봇 실행 중 — 앱이 꺼져도 24시간 자동매매 계속</Text>
            <Text style={s.bgBannerSub}>다른 앱을 사용하거나 화면을 꺼도 봇이 계속 작동합니다</Text>
          </View>
        )}

        {/* ── 복리 현황 패널 ── */}
        <CompoundPanel state={state} />

        {/* ── 강제청산 위험도 ── */}
        {state.positions.length > 0 && (
          <View style={{ paddingHorizontal: 16, marginBottom: 10 }}>
            <RiskGauge risk={state.portfolioLiqRisk ?? 0} />
          </View>
        )}

        {/* ── 전체 요약 ── */}
        <View style={s.summaryRow}>
          <SummaryCard label="전체 포지션" value={`${state.positions.length}개`} color={C.teal} />
          <SummaryCard
            label="실시간 손익"
            value={`${totalLivePnl >= 0 ? '+' : ''}${totalLivePnl.toFixed(2)}`}
            color={totalLivePnl >= 0 ? C.green : C.red}
            sub="USDT"
          />
          <SummaryCard
            label="오늘 수익"
            value={`${(state.dailyPnlPct ?? 0) >= 0 ? '+' : ''}${(state.dailyPnlPct ?? 0).toFixed(1)}%`}
            color={(state.dailyPnlPct ?? 0) >= 0 ? C.green : C.red}
          />
        </View>

        {/* ── 시장 컨텍스트 패널 ── */}
        {(state.marketPhase || (state.urgentNewsCount ?? 0) > 0) && (
          <View style={[s.marketPanel, {
            borderColor:
              state.marketPhase === 'RISK_OFF' || (state.urgentNewsCount ?? 0) >= 3 ? '#F87171' :
              state.marketPhase === 'RISK_ON' || state.marketPhase === 'BTC_SURGE' ? '#4ADE80' : '#334155'
          }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <Text style={s.marketPhaseTag}>
                {state.marketPhase === 'RISK_ON' ? '🟢 RISK ON' :
                 state.marketPhase === 'RISK_OFF' ? '🔴 RISK OFF' :
                 state.marketPhase === 'BTC_SURGE' ? '🚀 BTC 급등' :
                 state.marketPhase === 'BTC_CRASH' ? '💥 BTC 급락' :
                 state.marketPhase === 'ETH_LEAD' ? '🔷 ETH 주도' :
                 state.marketPhase === 'ALT_SEASON' ? '🌊 알트 시즌' : '⚪ 중립'}
              </Text>
              {(state.urgentNewsCount ?? 0) > 0 && (
                <Text style={s.newsAlert}>⚠️ 긴급뉴스 {state.urgentNewsCount}건</Text>
              )}
              <View style={[s.badge, { backgroundColor: '#1A1A2A', borderColor: '#6366F1' }]}>
                <Text style={[s.badgeText, { color: '#6366F1' }]}>🤖 자동 대응</Text>
              </View>
            </View>
            {state.marketContextSummary ? <Text style={s.marketSummary}>{state.marketContextSummary}</Text> : null}
            {state.marketStrategyReason ? <Text style={s.marketStrategy}>전략: {state.marketStrategyReason}</Text> : null}
            {(state.currentSession || state.currentVolatility) && (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                {state.currentSession && <View style={s.stratBadge}><Text style={s.stratBadgeText}>{state.currentSession}</Text></View>}
                {state.currentVolatility && (
                  <View style={[s.stratBadge, {
                    backgroundColor:
                      state.currentVolatilityLevel === 'LOW' ? '#1a3a2a' :
                      state.currentVolatilityLevel === 'HIGH' ? '#3a2a1a' :
                      state.currentVolatilityLevel === 'EXTREME' ? '#3a1a1a' : '#1e2a3a'
                  }]}>
                    <Text style={s.stratBadgeText}>{state.currentVolatility}</Text>
                  </View>
                )}
                {state.effectiveConfidenceMin != null && (
                  <View style={s.stratBadge}><Text style={s.stratBadgeText}>신뢰도 {state.effectiveConfidenceMin}%+</Text></View>
                )}
                {state.effectivePosMultiplier != null && state.effectivePosMultiplier !== 1 && (
                  <View style={[s.stratBadge, { backgroundColor: '#2a1a3a' }]}>
                    <Text style={s.stratBadgeText}>포지션 {state.effectivePosMultiplier.toFixed(1)}x</Text>
                  </View>
                )}
                {state.allowNewEntryBySession === false && (
                  <View style={[s.stratBadge, { backgroundColor: '#3a1a1a' }]}>
                    <Text style={[s.stratBadgeText, { color: '#F87171' }]}>진입중단</Text>
                  </View>
                )}
              </View>
            )}
          </View>
        )}

        {/* ── 전체 봇 제어 (시작/정지만) ── */}
        <View style={s.controlRow}>
          {!isAnyBotRunning ? (
            <TouchableOpacity
              style={[s.startBtn, startAll.isPending && { opacity: 0.6 }]}
              onPress={handleStartAll}
              disabled={startAll.isPending}
              activeOpacity={0.8}
            >
              {startAll.isPending
                ? <ActivityIndicator size="small" color="#fff" />
                : (
                  <View>
                    <Text style={s.startBtnText}>▶ 자동매매 시작</Text>
                    <Text style={s.startBtnSub}>3개 봇 동시 가동 · 종목/모드/복리 완전 자동</Text>
                  </View>
                )
              }
            </TouchableOpacity>
          ) : (
            <View style={s.runningControls}>
              <TouchableOpacity style={s.stopBtn} onPress={handleStopAll} activeOpacity={0.8}>
                <Text style={s.stopBtnText}>⏹ 전체 정지</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.tickBtn} onPress={() => manualTick.mutate()} activeOpacity={0.8}>
                <Text style={s.tickBtnText}>↻ 즉시 분석</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* ── 봇별 상태 표시 (탭 아님, 정보 표시) ── */}
        <View style={s.botStatusRow}>
          {(['normal', 'surge', 'presurge'] as BotTab[]).map((tab) => {
            const meta = TAB_META[tab];
            const running = tab === 'normal' ? state.normalRunning : tab === 'surge' ? state.surgeRunning : state.presurgeRunning;
            const cnt = tabPositions[tab].length;
            return (
              <View key={tab} style={[s.botStatusCard, running && { borderColor: meta.color }]}>
                <Text style={{ fontSize: 16 }}>{meta.icon}</Text>
                <Text style={[s.botStatusName, { color: running ? meta.color : C.muted }]}>{meta.label}</Text>
                <View style={[s.statusDot, { backgroundColor: running ? meta.color : '#333', marginVertical: 2 }]} />
                <Text style={[s.botStatusCnt, { color: running ? C.text : C.muted }]}>{cnt}개</Text>
              </View>
            );
          })}
        </View>

        {/* ── 3탭 포지션 뷰 ── */}
        <View style={s.tabRow}>
          {(['normal', 'surge', 'presurge'] as BotTab[]).map((tab) => {
            const meta = TAB_META[tab];
            const cnt = tabPositions[tab].length;
            const isActive = activeTab === tab;
            return (
              <TouchableOpacity
                key={tab}
                style={[s.tab, isActive && { backgroundColor: meta.bg, borderColor: meta.color }]}
                onPress={() => setActiveTab(tab)}
                activeOpacity={0.7}
              >
                <Text style={[s.tabText, { color: isActive ? meta.color : C.muted }]}>{meta.icon} {meta.label}</Text>
                <Text style={[s.tabCnt, { color: isActive ? meta.color : C.muted }]}>{cnt}개</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* ── 탭별 포지션 목록 ── */}
        <View style={s.section}>
          <View style={s.sectionHeader}>
            <Text style={s.sectionTitle}>
              {TAB_META[activeTab].icon} {TAB_META[activeTab].label} 포지션 ({activePositions.length}개)
            </Text>
            {activePositions.length > 0 && (
              <Text style={[s.liveTag, { color: TAB_META[activeTab].color }]}>● LIVE</Text>
            )}
          </View>
          <Text style={s.tabDesc}>{TAB_META[activeTab].desc}</Text>

          {activePositions.length === 0 ? (
            <View style={s.emptyBox}>
              <Text style={s.emptyText}>
                {isAnyBotRunning ? '포지션 진입 대기 중...' : '봇을 시작하면 포지션이 자동 생성됩니다'}
              </Text>
              <Text style={[s.emptyText, { fontSize: 11, marginTop: 4 }]}>
                종목 선택 · 모드 전환 · 복리 운용 모두 자동
              </Text>
            </View>
          ) : (
            activePositions.map(pos => (
              <PositionCard
                key={pos.symbol}
                pos={pos}
                excludeList={excludeList}
                onExcludeChange={refreshAll}
              />
            ))
          )}
        </View>

        {/* ── 전략 성과 요약 ── */}
        {stratStats && (
          <View style={s.section}>
            <View style={s.sectionHeader}>
              <Text style={s.sectionTitle}>📊 전략 성과 분석</Text>
              <TouchableOpacity onPress={() => setShowLossAnalysis(v => !v)}>
                <Text style={{ fontSize: 12, color: C.teal }}>{showLossAnalysis ? '▲ 접기' : '▼ 손실 분석'}</Text>
              </TouchableOpacity>
            </View>
            <View style={s.statsGrid}>
              {[
                { label: '전체', stats: stratStats.all, color: C.text },
                { label: '일반봇', stats: stratStats.normal, color: C.teal },
                { label: '급등봇', stats: stratStats.surge, color: C.orange },
                { label: '급등직전', stats: stratStats.presurge, color: C.pink },
              ].map(({ label, stats, color }) => (
                <View key={label} style={s.statsCard}>
                  <Text style={[s.statsLabel, { color }]}>{label}</Text>
                  <Text style={s.statsValue}>{stats.winRate.toFixed(0)}%</Text>
                  <Text style={s.statsSub}>승률</Text>
                  <Text style={[s.statsValue, { color: stats.avgPnlPct >= 0 ? C.green : C.red, fontSize: 12 }]}>
                    {stats.avgPnlPct >= 0 ? '+' : ''}{stats.avgPnlPct.toFixed(1)}%
                  </Text>
                  <Text style={s.statsSub}>평균 수익</Text>
                </View>
              ))}
            </View>

            {/* 자동 조정 로그 */}
            {stratStats.autoAdjusted && stratStats.autoAdjustLog.length > 0 && (
              <View style={{ marginTop: 8, backgroundColor: '#0D1F2D', borderRadius: 8, padding: 10 }}>
                <Text style={{ fontSize: 12, color: C.yellow, fontWeight: '700', marginBottom: 4 }}>🔧 자동 전략 조정 내역</Text>
                {stratStats.autoAdjustLog.slice(0, 3).map((log, i) => (
                  <Text key={i} style={{ fontSize: 11, color: C.muted, lineHeight: 16 }}>• {log}</Text>
                ))}
              </View>
            )}

            {/* 손실 분석 */}
            {showLossAnalysis && lossAnalysis && (
              <View style={{ marginTop: 10, backgroundColor: '#1A0D0D', borderRadius: 10, padding: 12, borderWidth: 1, borderColor: '#3a1a1a' }}>
                <Text style={{ fontSize: 13, fontWeight: '700', color: C.red, marginBottom: 8 }}>🔍 손실 원인 분석 (AI 검증 v44: 복합 원인)</Text>
                {/* 위험 점수 + 연속 손실 */}
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
                  <Text style={{ fontSize: 12, color: C.muted }}>위험 점수 <Text style={{ color: lossAnalysis.riskScore >= 70 ? C.red : lossAnalysis.riskScore >= 40 ? C.yellow : C.green, fontWeight: '700' }}>{lossAnalysis.riskScore}/100</Text></Text>
                  <Text style={{ fontSize: 12, color: C.muted }}>연속 손실 <Text style={{ color: lossAnalysis.consecutiveLosses >= 3 ? C.red : C.yellow, fontWeight: '700' }}>{lossAnalysis.consecutiveLosses}회</Text></Text>
                  <Text style={{ fontSize: 12, color: C.muted }}>손실 <Text style={{ color: C.red, fontWeight: '700' }}>{lossAnalysis.totalLosses}건</Text></Text>
                </View>
                {/* 복합 원인 비중 바 (AI 검증 v44) */}
                {lossAnalysis.reasonScores && lossAnalysis.reasonScores.length > 0 ? (
                  <View style={{ marginBottom: 8 }}>
                    <Text style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>📊 복합 원인 비중 (실전 손실은 복합 원인이 대부분)</Text>
                    {lossAnalysis.reasonScores.slice(0, 4).map((rs, i) => (
                      <View key={i} style={{ marginBottom: 5 }}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 }}>
                          <Text style={{ fontSize: 11, color: i === 0 ? C.red : C.yellow, fontWeight: i === 0 ? '700' : '400' }}>{rs.description}</Text>
                          <Text style={{ fontSize: 11, color: i === 0 ? C.red : C.muted, fontWeight: '700' }}>{rs.score}%</Text>
                        </View>
                        <View style={{ height: 4, backgroundColor: '#2a1a1a', borderRadius: 2 }}>
                          <View style={{ height: 4, borderRadius: 2, backgroundColor: i === 0 ? C.red : C.yellow, width: `${rs.score}%` as any }} />
                        </View>
                      </View>
                    ))}
                  </View>
                ) : (
                  <Text style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>주요 원인: <Text style={{ color: C.yellow, fontWeight: '700' }}>{lossAnalysis.dominantReason}</Text></Text>
                )}
                {/* 자동 개선 제안 */}
                {lossAnalysis.suggestedAdjustments.slice(0, 3).map((adj, i) => (
                  <View key={i} style={{ marginBottom: 6, backgroundColor: '#1e1000', borderRadius: 6, padding: 8 }}>
                    <Text style={{ fontSize: 12, color: C.yellow, fontWeight: '600' }}>{adj.parameter} <Text style={{ color: adj.priority === 'HIGH' ? C.red : C.muted, fontSize: 10 }}>[{adj.priority}]</Text></Text>
                    <Text style={{ fontSize: 11, color: C.muted, lineHeight: 16 }}>{adj.reason}</Text>
                    <Text style={{ fontSize: 11, color: C.teal }}>→ {adj.currentValue} → {adj.suggestedValue}</Text>
                  </View>
                ))}
                {lossAnalysis.suggestedAdjustments.length === 0 && (
                  <Text style={{ fontSize: 12, color: C.green }}>✅ 특이 손실 패턴 없음 — 전략 정상 작동 중</Text>
                )}
              </View>
            )}
          </View>
        )}

        {/* ── 백테스트 결과 패널 ── */}
        <View style={s.section}>
          <TouchableOpacity
            style={s.sectionHeader}
            onPress={() => setShowBacktest(v => !v)}
            activeOpacity={0.7}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={s.sectionTitle}>🧪 백테스트 검증</Text>
              {regimeData && (
                <View style={[s.badge, {
                  backgroundColor:
                    regimeData.regime === 'BULL_TREND' ? '#1A2A1A' :
                    regimeData.regime === 'BEAR_TREND' ? '#2A1A1A' :
                    regimeData.regime === 'CRASH' ? '#3A1A1A' : '#1A1A2A',
                  borderColor:
                    regimeData.regime === 'BULL_TREND' ? C.green :
                    regimeData.regime === 'BEAR_TREND' ? C.red :
                    regimeData.regime === 'CRASH' ? '#F85149' : C.muted,
                }]}>
                  <Text style={[s.badgeText, { color:
                    regimeData.regime === 'BULL_TREND' ? C.green :
                    regimeData.regime === 'BEAR_TREND' ? C.red :
                    regimeData.regime === 'CRASH' ? '#F85149' : C.muted
                  }]}>
                    {regimeData.regime === 'BULL_TREND' ? '🟢 강세장' :
                     regimeData.regime === 'BEAR_TREND' ? '🔴 약세장' :
                     regimeData.regime === 'CRASH' ? '💥 급락장' : '⚪ 횡보장'}
                  </Text>
                </View>
              )}
            </View>
            <Text style={{ fontSize: 12, color: C.teal }}>{showBacktest ? '▲ 접기' : '▼ 펼치기'}</Text>
          </TouchableOpacity>

          {!showBacktest && (
            <Text style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
              모의 Walk-Forward 테스트로 전략 성과를 사전 검증합니다
            </Text>
          )}

          {showBacktest && (
            <View style={{ marginTop: 8 }}>
              {/* 목표 vs 기대 수익률 분리 (3차 AI 검증 반영) */}
              <View style={{ backgroundColor: '#0D1F2D', borderRadius: 10, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: '#1e3a5a' }}>
                <Text style={{ fontSize: 12, fontWeight: '700', color: C.teal, marginBottom: 8 }}>📊 목표 vs 기대 수익률 (3차 AI 검증 반영)</Text>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <View style={{ alignItems: 'center', flex: 1 }}>
                    <Text style={{ fontSize: 10, color: C.muted, marginBottom: 2 }}>일일 목표</Text>
                    <Text style={{ fontSize: 18, fontWeight: '700', color: C.teal }}>{state.dailyTargetPct ?? 1.5}%</Text>
                    <Text style={{ fontSize: 9, color: C.muted }}>최상 시나리오</Text>
                  </View>
                  <View style={{ width: 1, backgroundColor: C.border }} />
                  <View style={{ alignItems: 'center', flex: 1 }}>
                    <Text style={{ fontSize: 10, color: C.muted, marginBottom: 2 }}>현실 기대</Text>
                    <Text style={{ fontSize: 18, fontWeight: '700', color: C.yellow }}>0.3~0.8%</Text>
                    <Text style={{ fontSize: 9, color: C.muted }}>안정적 목표</Text>
                  </View>
                  <View style={{ width: 1, backgroundColor: C.border }} />
                  <View style={{ alignItems: 'center', flex: 1 }}>
                    <Text style={{ fontSize: 10, color: C.muted, marginBottom: 2 }}>연간 기대</Text>
                    <Text style={{ fontSize: 18, fontWeight: '700', color: C.green }}>~200%</Text>
                    <Text style={{ fontSize: 9, color: C.muted }}>복리 기준</Text>
                  </View>
                </View>
                <Text style={{ fontSize: 10, color: C.muted, marginTop: 8, lineHeight: 14 }}>
                  ⚠️ 일일 1.5% 목표는 최상 시나리오입니다. 현실적 기대 수익은 0.3~0.8%이며, 복리 누적 시 연간 약 200% 달성이 목표입니다.
                </Text>
              </View>

              {/* 시장 국면별 전략 */}
              {regimeData && (
                <View style={{ backgroundColor: '#0D1117', borderRadius: 10, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: '#21262D' }}>
                  <Text style={{ fontSize: 12, fontWeight: '700', color: C.text, marginBottom: 8 }}>🗺️ 현재 시장 국면 전략</Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    <View style={s.stratBadge}><Text style={s.stratBadgeText}>신뢰도 {regimeData.strategy.confidenceMin}%+</Text></View>
                    <View style={s.stratBadge}><Text style={s.stratBadgeText}>레버리지 {regimeData.strategy.leverageMultiplier}x</Text></View>
                    <View style={s.stratBadge}><Text style={s.stratBadgeText}>포지션 {regimeData.strategy.positionSizeMultiplier}x</Text></View>
                    {regimeData.strategy.allowLong && <View style={[s.stratBadge, { backgroundColor: '#1a3a2a' }]}><Text style={[s.stratBadgeText, { color: C.green }]}>롱 허용</Text></View>}
                    {regimeData.strategy.allowShort && <View style={[s.stratBadge, { backgroundColor: '#3a1a2a' }]}><Text style={[s.stratBadgeText, { color: C.red }]}>숏 허용</Text></View>}
                    <View style={s.stratBadge}><Text style={s.stratBadgeText}>TP {regimeData.strategy.tpPct}% / SL {regimeData.strategy.slPct}%</Text></View>
                  </View>
                  <Text style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>{regimeData.strategy.description}</Text>
                </View>
              )}

              {/* 백테스트 실행 버튼 */}
              {!backtestResult ? (
                <TouchableOpacity
                  style={[s.startBtn, { backgroundColor: '#1A1A3A', borderColor: C.purple, borderWidth: 1 }, runBacktest.isPending && { opacity: 0.6 }]}
                  onPress={() => runBacktest.mutate({ symbol: 'BTCUSDT', years: 4 })}
                  disabled={runBacktest.isPending}
                  activeOpacity={0.8}
                >
                  {runBacktest.isPending ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <ActivityIndicator size="small" color={C.purple} />
                      <Text style={[s.startBtnText, { color: C.purple }]}>Walk-Forward 백테스트 실행 중...</Text>
                    </View>
                  ) : (
                    <View>
                      <Text style={[s.startBtnText, { color: C.purple }]}>🧪 모의 백테스트 실행 (4년 데이터)</Text>
                      <Text style={[s.startBtnSub, { color: C.muted }]}>⚠️ 모의 데이터 기반 — 실제 Bybit 데이터 검증 권장</Text>
                    </View>
                  )}
                </TouchableOpacity>
              ) : (
                <View style={{ backgroundColor: '#0D1117', borderRadius: 10, padding: 12, borderWidth: 1, borderColor: '#21262D' }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: C.text }}>📈 백테스트 결과 ({backtestResult.symbol})</Text>
                    <View style={[s.badge, { backgroundColor: backtestResult.isOverfitted ? '#2A1A1A' : '#1A2A1A', borderColor: backtestResult.isOverfitted ? C.red : C.green }]}>
                      <Text style={[s.badgeText, { color: backtestResult.isOverfitted ? C.red : C.green }]}>
                        {backtestResult.isOverfitted ? '⚠️ 과최적화 의심' : '✅ 과최적화 없음'}
                      </Text>
                    </View>
                  </View>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                    {[
                      { label: '승률', value: `${backtestResult.winRate.toFixed(0)}%`, color: backtestResult.winRate >= 55 ? C.green : C.yellow },
                      { label: '수익 팩터', value: backtestResult.profitFactor.toFixed(2), color: backtestResult.profitFactor >= 1.5 ? C.green : C.yellow },
                      { label: '샤프 비율', value: backtestResult.sharpeRatio.toFixed(2), color: backtestResult.sharpeRatio >= 1 ? C.green : C.yellow },
                      { label: 'MDD', value: `${backtestResult.maxDrawdownPct.toFixed(1)}%`, color: backtestResult.maxDrawdownPct <= 15 ? C.green : backtestResult.maxDrawdownPct <= 30 ? C.yellow : C.red },
                      { label: '총 수익', value: `${backtestResult.totalNetPnlPct.toFixed(0)}%`, color: backtestResult.totalNetPnlPct >= 0 ? C.green : C.red },
                      { label: '일평균', value: `${backtestResult.avgDailyPnlPct.toFixed(2)}%`, color: backtestResult.avgDailyPnlPct >= 0.3 ? C.green : C.yellow },
                    ].map(({ label, value, color }) => (
                      <View key={label} style={{ backgroundColor: '#161B22', borderRadius: 8, padding: 8, minWidth: 80, alignItems: 'center' }}>
                        <Text style={{ fontSize: 10, color: C.muted, marginBottom: 2 }}>{label}</Text>
                        <Text style={{ fontSize: 14, fontWeight: '700', color }}>{value}</Text>
                      </View>
                    ))}
                  </View>
                  <Text style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>최적 RSI 범위: 롱 {backtestResult.optimalRsiRanges.longMin}~{backtestResult.optimalRsiRanges.longMax} / 숏 {backtestResult.optimalRsiRanges.shortMin}~{backtestResult.optimalRsiRanges.shortMax}</Text>
                  <Text style={{ fontSize: 11, color: C.teal, marginBottom: 4 }}>최고 국면: {backtestResult.bestRegime} / 최악 국면: {backtestResult.worstRegime}</Text>
                  <Text style={{ fontSize: 11, color: C.yellow, lineHeight: 15 }}>{backtestResult.recommendation}</Text>
                  <Text style={{ fontSize: 10, color: C.muted, marginTop: 6, lineHeight: 13 }}>{backtestResult.note}</Text>
                  <TouchableOpacity
                    style={{ marginTop: 8, alignSelf: 'flex-end' }}
                    onPress={() => setBacktestResult(null)}
                    activeOpacity={0.7}
                  >
                    <Text style={{ fontSize: 11, color: C.muted }}>↺ 재실행</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          )}
        </View>

        {/* ── 안전 인출 계산기 ── */}
        <View style={s.section}>
          <TouchableOpacity
            style={s.sectionHeader}
            onPress={() => setShowWithdrawal(v => !v)}
            activeOpacity={0.7}
          >
            <Text style={s.sectionTitle}>💰 안전 인출 계산기</Text>
            <Text style={{ fontSize: 12, color: C.teal }}>{showWithdrawal ? '▲ 접기' : '▼ 펼치기'}</Text>
          </TouchableOpacity>
          {showWithdrawal && <WithdrawalPanel state={state} />}
          {!showWithdrawal && (
            <Text style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
              수익 인출 시 봇 운용에 영향 없는 안전 범위를 계산합니다
            </Text>
          )}
        </View>

        {/* ── 봇 로그 ── */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>📋 봇 로그</Text>
          {state.logs.length === 0 ? (
            <View style={s.emptyBox}><Text style={s.emptyText}>로그 없음</Text></View>
          ) : (
            <View style={s.logBox}>
              {state.logs.slice(0, 50).map((log, i) => <LogItem key={i} log={log} />)}
            </View>
          )}
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </ScreenContainer>
  );
}

// ─── 스타일 ───────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: C.bg },

  // 헤더
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingTop: 16, paddingBottom: 12 },
  headerTitle: { fontSize: 20, fontWeight: '700', color: C.teal },
  headerSub: { fontSize: 11, color: C.muted, marginTop: 2 },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  keepAwakeBadge: { backgroundColor: '#1A2A1A', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 0.5, borderColor: C.green },
  keepAwakeText: { fontSize: 10, color: C.green, fontWeight: '600' },
  serverBadge: { backgroundColor: '#1A1A2A', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 0.5, borderColor: '#6366F1' },
  serverBadgeText: { fontSize: 10, color: '#6366F1', fontWeight: '600' },

  // 배너
  bgBanner: { marginHorizontal: 16, marginBottom: 10, backgroundColor: '#0A2A1A', borderRadius: 10, borderWidth: 1, borderColor: C.green, paddingHorizontal: 14, paddingVertical: 10 },
  bgBannerText: { fontSize: 13, fontWeight: '700', color: C.green, marginBottom: 2 },
  bgBannerSub: { fontSize: 11, color: C.muted },

  // 복리 패널
  compoundPanel: { marginHorizontal: 16, marginBottom: 10, backgroundColor: '#0D1F2D', borderRadius: 12, borderWidth: 1.5, borderColor: '#1e3a5a', padding: 14 },
  compoundTitle: { fontSize: 13, fontWeight: '700', color: C.teal, marginBottom: 10 },
  compoundGrid: { flexDirection: 'row' },
  compoundItem: { flex: 1, alignItems: 'center' },
  compoundDivider: { width: 1, backgroundColor: C.border },
  compoundLabel: { fontSize: 10, color: C.muted, marginBottom: 4 },
  compoundValue: { fontSize: 18, fontWeight: '800' },

  // 위험도 게이지
  riskGauge: { backgroundColor: C.surface, borderRadius: 10, padding: 12, borderWidth: 1, borderColor: C.border },
  riskLabel: { fontSize: 12, color: C.muted },
  riskValue: { fontSize: 13, fontWeight: '700' },
  riskTrack: { height: 6, backgroundColor: '#21262D', borderRadius: 3, overflow: 'hidden' },
  riskFill: { height: 6, borderRadius: 3 },

  // 요약
  summaryRow: { flexDirection: 'row', paddingHorizontal: 16, gap: 8, marginBottom: 12 },
  summaryCard: { flex: 1, backgroundColor: C.surface, borderRadius: 10, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: C.border },
  summaryLabel: { fontSize: 10, color: C.muted, marginBottom: 4 },
  summaryValue: { fontSize: 14, fontWeight: '700' },
  summarySub: { fontSize: 10, color: C.muted, marginTop: 2 },

  // 시장 패널
  marketPanel: { marginHorizontal: 16, marginBottom: 12, borderRadius: 12, backgroundColor: '#0D1F2D', borderWidth: 1.5, padding: 12 },
  marketPhaseTag: { fontSize: 13, fontWeight: '800', color: C.text, backgroundColor: '#1a2a3a', paddingHorizontal: 10, paddingVertical: 3, borderRadius: 8, overflow: 'hidden' },
  newsAlert: { fontSize: 12, fontWeight: '700', color: '#F87171', backgroundColor: '#3a1a1a', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, overflow: 'hidden' },
  marketSummary: { fontSize: 12, color: C.muted, lineHeight: 18, marginTop: 2 },
  marketStrategy: { fontSize: 11, color: '#4ADE80', marginTop: 4, fontStyle: 'italic' },
  stratBadge: { backgroundColor: '#1e2a3a', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 0.5, borderColor: '#334155' },
  stratBadgeText: { fontSize: 11, color: C.muted, fontWeight: '500' },

  // 제어 버튼
  controlRow: { paddingHorizontal: 16, marginBottom: 14 },
  startBtn: { backgroundColor: C.teal, borderRadius: 14, padding: 18, alignItems: 'center' },
  startBtnText: { color: C.bg, fontWeight: '800', fontSize: 16 },
  startBtnSub: { color: '#0D3A3A', fontSize: 11, marginTop: 3, textAlign: 'center' },
  runningControls: { flexDirection: 'row', gap: 10 },
  stopBtn: { flex: 1, backgroundColor: '#2D1B1B', borderRadius: 12, padding: 14, alignItems: 'center', borderWidth: 1, borderColor: C.red },
  stopBtnText: { color: C.red, fontWeight: '700', fontSize: 14 },
  tickBtn: { flex: 1, backgroundColor: C.surface, borderRadius: 12, padding: 14, alignItems: 'center', borderWidth: 1, borderColor: C.border },
  tickBtnText: { color: C.text, fontWeight: '700', fontSize: 14 },

  // 봇 상태 카드
  botStatusRow: { flexDirection: 'row', paddingHorizontal: 16, gap: 8, marginBottom: 12 },
  botStatusCard: { flex: 1, backgroundColor: C.surface, borderRadius: 10, padding: 10, alignItems: 'center', borderWidth: 1.5, borderColor: C.border, gap: 2 },
  botStatusName: { fontSize: 11, fontWeight: '700' },
  botStatusCnt: { fontSize: 12, fontWeight: '600' },

  // 탭
  tabRow: { flexDirection: 'row', marginHorizontal: 16, marginBottom: 12, gap: 6 },
  tab: { flex: 1, backgroundColor: C.surface, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 6, alignItems: 'center', borderWidth: 1.5, borderColor: C.border },
  tabText: { fontSize: 12, fontWeight: '700' },
  tabCnt: { fontSize: 11, fontWeight: '600', marginTop: 2 },
  tabDesc: { fontSize: 11, color: C.muted, marginBottom: 8, paddingHorizontal: 2 },

  // 섹션
  section: { paddingHorizontal: 16, marginBottom: 8 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  sectionTitle: { fontSize: 14, fontWeight: '700', color: C.text },
  liveTag: { fontSize: 11, fontWeight: '700' },

  // 포지션 카드
  posCard: { backgroundColor: C.surface, borderRadius: 12, padding: 14, marginBottom: 10, borderWidth: 1.5 },
  posHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 },
  posLeft: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', flex: 1 },
  posSymbol: { fontSize: 18, fontWeight: '800', color: C.text },
  posBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  posBadgeText: { fontSize: 11, fontWeight: '700' },
  posLev: { fontSize: 12, color: C.teal, fontWeight: '700' },
  posPnlPct: { fontSize: 22, fontWeight: '800', lineHeight: 26 },
  posPnlUsdt: { fontSize: 13, fontWeight: '600', marginTop: 2 },
  liqWarnBanner: { backgroundColor: '#3A1A1A', borderRadius: 8, padding: 8, marginBottom: 8, borderWidth: 1, borderColor: C.red },
  liqWarnText: { fontSize: 12, color: C.red, fontWeight: '700' },
  autoLabel: { backgroundColor: '#1A1A2A', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderColor: '#334155' },
  autoLabelText: { fontSize: 11, color: C.muted, fontWeight: '600' },

  // 가격 그리드
  priceGrid: { flexDirection: 'row', gap: 6, marginTop: 10 },
  priceItem: { flex: 1, backgroundColor: '#0D1117', borderRadius: 8, padding: 8, alignItems: 'center' },
  priceItemHighlight: { backgroundColor: '#0D2020', borderWidth: 1, borderColor: '#00D4AA33' },
  priceLabel: { fontSize: 9, color: C.muted, marginBottom: 3 },
  priceValue: { fontSize: 12, fontWeight: '700' },

  // 금액 행
  amountRow: { flexDirection: 'row', marginTop: 10, backgroundColor: '#0D1117', borderRadius: 8, padding: 10 },
  amountItem: { flex: 1, alignItems: 'center' },
  amountDivider: { width: 1, backgroundColor: C.border },
  amountLabel: { fontSize: 9, color: C.muted, marginBottom: 3 },
  amountValue: { fontSize: 11, fontWeight: '700', color: C.text },

  // 액션 버튼
  actionBtn: { borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12, alignItems: 'center', borderWidth: 1, backgroundColor: '#0D1117' },
  actionBtnText: { fontSize: 12, fontWeight: '700' },

  // 전략 성과
  statsGrid: { flexDirection: 'row', gap: 6, marginBottom: 8 },
  statsCard: { flex: 1, backgroundColor: C.surface, borderRadius: 10, padding: 10, alignItems: 'center', borderWidth: 1, borderColor: C.border },
  statsLabel: { fontSize: 10, fontWeight: '700', marginBottom: 4 },
  statsValue: { fontSize: 16, fontWeight: '800', color: C.text },
  statsSub: { fontSize: 9, color: C.muted, marginTop: 1, marginBottom: 4 },

  // 안전 인출
  withdrawPanel: { backgroundColor: '#0D1F2D', borderRadius: 12, padding: 14, borderWidth: 1.5, borderColor: '#1e3a5a' },
  withdrawTitle: { fontSize: 14, fontWeight: '700', color: C.teal },
  withdrawGrid: { flexDirection: 'row', backgroundColor: '#0D1117', borderRadius: 10, padding: 12 },
  withdrawItem: { flex: 1, alignItems: 'center' },
  withdrawDivider: { width: 1, backgroundColor: C.border },
  withdrawItemLabel: { fontSize: 10, color: C.muted, marginBottom: 4 },
  withdrawItemValue: { fontSize: 15, fontWeight: '800' },
  stepBtn: { flex: 1, backgroundColor: C.surface, borderRadius: 8, paddingVertical: 8, alignItems: 'center', borderWidth: 1, borderColor: C.border },
  stepBtnText: { fontSize: 11, color: C.muted, fontWeight: '600' },
  selectedAmount: { backgroundColor: '#0D1117', borderRadius: 10, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: C.border },

  // 배지
  badge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 0.5 },
  badgeText: { fontSize: 11, fontWeight: '600' },

  // 로그
  logBox: { backgroundColor: C.surface, borderRadius: 10, padding: 10, borderWidth: 1, borderColor: C.border },
  logRow: { flexDirection: 'row', gap: 6, paddingVertical: 4, borderBottomWidth: 0.5, borderBottomColor: C.border },
  logTime: { fontSize: 10, color: C.muted, width: 56, flexShrink: 0 },
  logLevel: { fontSize: 10, fontWeight: '700', width: 50, flexShrink: 0 },
  logMsg: { fontSize: 11, flex: 1, lineHeight: 16 },
  emptyBox: { alignItems: 'center', paddingVertical: 24 },
  emptyText: { color: C.muted, fontSize: 13 },
});
