/**
 * ChartModal
 * 종목명 클릭 시 TradingView 실시간 차트를 인앱 브라우저로 표시
 * expo-web-browser 사용 (react-native-webview 불필요)
 */

import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Linking,
} from 'react-native';
// expo-web-browser 제거 - Linking으로 대체

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
};

interface ChartModalProps {
  visible: boolean;
  symbol: string;        // Bybit 심볼 (예: BTCUSDT)
  displaySymbol: string; // 표시용 심볼 (예: BTC)
  side?: 'Buy' | 'Sell' | 'LONG' | 'SHORT';
  onClose: () => void;
}

/**
 * Bybit 심볼을 TradingView 심볼로 변환
 * BTCUSDT → BYBIT:BTCUSDT.P (무기한 선물)
 */
function toTradingViewSymbol(bybitSymbol: string): string {
  const base = bybitSymbol.replace(/USDT$/, '').replace(/PERP$/, '');
  return `BYBIT:${base}USDT.P`;
}

/**
 * TradingView 차트 URL 생성
 * 모바일 최적화된 미니 차트 URL 사용
 */
function buildChartUrl(bybitSymbol: string, interval = '15'): string {
  const tvSymbol = toTradingViewSymbol(bybitSymbol);
  // TradingView 모바일 차트 페이지
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSymbol)}&interval=${interval}`;
}

export function ChartModal({ visible, symbol, displaySymbol, side, onClose }: ChartModalProps) {
  const [loading, setLoading] = useState(false);

  const isLong = side === 'Buy' || side === 'LONG';
  const isShort = side === 'Sell' || side === 'SHORT';
  const sideColor = isLong ? C.green : isShort ? C.red : C.teal;
  const sideLabel = isLong ? '▲ LONG' : isShort ? '▼ SHORT' : '';

  const intervals = [
    { label: '1분', value: '1' },
    { label: '5분', value: '5' },
    { label: '15분', value: '15' },
    { label: '1시간', value: '60' },
    { label: '4시간', value: '240' },
    { label: '1일', value: 'D' },
  ];

  const openChart = async (interval: string) => {
    setLoading(true);
    try {
      const url = buildChartUrl(symbol, interval);
      Linking.openURL(url);
    } catch {
      // 오류 시 기본 브라우저로 폴백
      const url = buildChartUrl(symbol, interval);
      Linking.openURL(url);
    } finally {
      setLoading(false);
    }
  };

  const openBybitChart = async () => {
    setLoading(true);
    try {
      const base = symbol.replace(/USDT$/, '').replace(/PERP$/, '');
      const url = `https://www.bybit.com/trade/usdt/${base}USDT`;
      Linking.openURL(url);
    } catch {
      const base = symbol.replace(/USDT$/, '').replace(/PERP$/, '');
      Linking.openURL(`https://www.bybit.com/trade/usdt/${base}USDT`);
    } finally {
      setLoading(false);
    }
  };

  if (!visible) return null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.container}>
          {/* 헤더 */}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <Text style={styles.symbolText}>{displaySymbol}</Text>
              {sideLabel ? (
                <View style={[styles.sideBadge, { backgroundColor: isLong ? '#1A3A2A' : '#3A1A1A' }]}>
                  <Text style={[styles.sideText, { color: sideColor }]}>{sideLabel}</Text>
                </View>
              ) : null}
            </View>
            <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
              <Text style={styles.closeBtnText}>✕</Text>
            </TouchableOpacity>
          </View>

          {/* 설명 */}
          <Text style={styles.desc}>
            차트 시간대를 선택하면 TradingView에서 실시간 차트가 열립니다.
          </Text>

          {/* 시간대 버튼 그리드 */}
          <View style={styles.intervalGrid}>
            {intervals.map(iv => (
              <TouchableOpacity
                key={iv.value}
                style={styles.intervalBtn}
                onPress={() => openChart(iv.value)}
                disabled={loading}
              >
                {loading ? (
                  <ActivityIndicator size="small" color={C.teal} />
                ) : (
                  <Text style={styles.intervalBtnText}>{iv.label}</Text>
                )}
              </TouchableOpacity>
            ))}
          </View>

          {/* 구분선 */}
          <View style={styles.divider} />

          {/* 바이비트 차트 버튼 */}
          <TouchableOpacity
            style={styles.bybitBtn}
            onPress={openBybitChart}
            disabled={loading}
          >
            <Text style={styles.bybitBtnText}>
              {loading ? '로딩 중...' : '📊 바이비트에서 직접 보기'}
            </Text>
          </TouchableOpacity>

          {/* 취소 */}
          <TouchableOpacity style={styles.cancelBtn} onPress={onClose}>
            <Text style={styles.cancelBtnText}>닫기</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ─── 종목명 클릭 가능한 래퍼 컴포넌트 ────────────────────────────────────────

interface ClickableSymbolProps {
  symbol: string;        // Bybit 심볼 (BTCUSDT)
  displaySymbol: string; // 표시용 (BTC)
  side?: 'Buy' | 'Sell' | 'LONG' | 'SHORT';
  style?: object;
  textStyle?: object;
  children: React.ReactNode;
}

export function ClickableSymbol({ symbol, displaySymbol, side, style, textStyle, children }: ClickableSymbolProps) {
  const [chartVisible, setChartVisible] = useState(false);

  return (
    <>
      <TouchableOpacity
        style={[{ flexDirection: 'row', alignItems: 'center' }, style]}
        onPress={() => setChartVisible(true)}
        activeOpacity={0.7}
      >
        {children}
      </TouchableOpacity>
      <ChartModal
        visible={chartVisible}
        symbol={symbol}
        displaySymbol={displaySymbol}
        side={side}
        onClose={() => setChartVisible(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'flex-end',
  },
  container: {
    backgroundColor: C.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    paddingBottom: 36,
    borderTopWidth: 1,
    borderColor: C.border,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  symbolText: {
    fontSize: 24,
    fontWeight: '800',
    color: C.text,
  },
  sideBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  sideText: {
    fontSize: 13,
    fontWeight: '700',
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#21262D',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeBtnText: {
    color: C.muted,
    fontSize: 14,
    fontWeight: '700',
  },
  desc: {
    fontSize: 12,
    color: C.muted,
    marginBottom: 16,
    lineHeight: 18,
  },
  intervalGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 16,
  },
  intervalBtn: {
    flex: 1,
    minWidth: 70,
    backgroundColor: '#0D1117',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: C.teal,
  },
  intervalBtnText: {
    color: C.teal,
    fontSize: 13,
    fontWeight: '700',
  },
  divider: {
    height: 1,
    backgroundColor: C.border,
    marginBottom: 12,
  },
  bybitBtn: {
    backgroundColor: '#1A2A3A',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#58A6FF',
    marginBottom: 10,
  },
  bybitBtnText: {
    color: '#58A6FF',
    fontSize: 14,
    fontWeight: '700',
  },
  cancelBtn: {
    backgroundColor: '#21262D',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  cancelBtnText: {
    color: C.muted,
    fontSize: 14,
    fontWeight: '600',
  },
});
