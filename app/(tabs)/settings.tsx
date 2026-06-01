import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TextInput, TouchableOpacity,
  Switch, StyleSheet, Alert, ActivityIndicator,
} from 'react-native';
import { ScreenContainer } from '@/components/screen-container';
import {
  loadCredentials, saveCredentials, type ApiCredentials,
} from '@/lib/trading-service';
import {
  loadBotExcludeList, removeFromBotExcludeList,
  loadConfig, saveConfig, type BotConfig,
} from '@/lib/bot-engine';
import { trpc } from '@/lib/trpc';

const C = {
  bg: '#0D1117', surface: '#161B22', border: '#21262D',
  text: '#E6EDF3', muted: '#8B949E', green: '#3FB950',
  red: '#F85149', teal: '#00D4AA', yellow: '#D29922',
};

const DEFAULT_CREDS: ApiCredentials = {
  apiKey: '', secretKey: '', isTestnet: false,
  positionSizePct: 5, leverageMin: 5, leverageMax: 100,
};

export default function SettingsScreen() {
  const [creds, setCreds] = useState<ApiCredentials>(DEFAULT_CREDS);
  const [showSecret, setShowSecret] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [balance, setBalance] = useState<{ total: number; available: number } | null>(null);
  const [excludeList, setExcludeList] = useState<string[]>([]);
  const [excludeLoading, setExcludeLoading] = useState(false);
  const [botConfig, setBotConfig] = useState<BotConfig>({
    maxPositions: 10,
    slThreshold: 30,
    slStep: 10,
    slForceThreshold: 100,
    surgeLeverage: 10,
    defaultLeverage: 10,
  });
  const [configSaving, setConfigSaving] = useState(false);

  useEffect(() => {
    loadCredentials().then(c => { if (c) setCreds(c); });
    loadBotExcludeList().then(setExcludeList);
    loadConfig().then((cfg: BotConfig) => {
      setBotConfig(cfg);
    });
  }, []);

  // 서버 동기화 뮤테이션
  const serverSetCredentials = trpc.bot.setCredentials.useMutation();
  const serverUpdateConfig = trpc.bot.updateConfig.useMutation();
  const serverRemoveExclude = trpc.bot.removeExclude.useMutation();
  const serverTestConnection = trpc.bot.testConnection.useMutation();

  const handleSaveBotConfig = useCallback(async () => {
    setConfigSaving(true);
    try {
      await saveConfig(botConfig);
      // 서버에도 동기화
      serverUpdateConfig.mutate(botConfig);
      Alert.alert('저장 완료', '레버리지 설정이 저장되었습니다.');
    } catch {
      Alert.alert('저장 실패', '설정 저장에 실패했습니다.');
    } finally {
      setConfigSaving(false);
    }
  }, [botConfig, serverUpdateConfig]);

  const handleRemoveExclude = useCallback(async (symbol: string) => {
    Alert.alert(
      '제외 해제',
      `${symbol.replace('USDT', '')}을(를) 제외 목록에서 제거합니다. 이후 자동봇이 이 종목을 다시 매매할 수 있습니다.`,
      [
        { text: '취소', style: 'cancel' },
        {
          text: '해제',
          onPress: async () => {
            setExcludeLoading(true);
            await removeFromBotExcludeList(symbol);
            const updated = await loadBotExcludeList();
            setExcludeList(updated);
            setExcludeLoading(false);
          },
        },
      ]
    );
  }, []);

  const handleClearAllExclude = useCallback(() => {
    if (excludeList.length === 0) return;
    Alert.alert(
      '전체 해제',
      `제외 목록의 종목 ${excludeList.length}개를 모두 해제합니다.`,
      [
        { text: '취소', style: 'cancel' },
        {
          text: '전체 해제',
          style: 'destructive',
          onPress: async () => {
            setExcludeLoading(true);
            for (const sym of excludeList) {
              await removeFromBotExcludeList(sym);
            }
            setExcludeList([]);
            setExcludeLoading(false);
          },
        },
      ]
    );
  }, [excludeList]);

  const handleTest = useCallback(async () => {
    if (!creds.apiKey || !creds.secretKey) {
      Alert.alert('입력 오류', 'API Key와 Secret Key를 모두 입력하세요.');
      return;
    }
    // 먼저 자격증명을 서버에 저장 후 서버 측에서 잔고 조회
    // (서버 IP를 통해 Bybit API 호출 → IP 허용 목록 문제 해결)
    setTesting(true);
    setBalance(null);
    try {
      // 서버에 자격증명 동기화 (테스트 전 필수)
      await new Promise<void>((resolve, reject) => {
        serverSetCredentials.mutate(creds, {
          onSuccess: () => resolve(),
          onError: (e) => reject(e),
        });
      });
      // 서버 측에서 잔고 조회
      const result = await new Promise<{ success: boolean; balance: { totalBalance: number; availableBalance: number } }>((resolve, reject) => {
        serverTestConnection.mutate(undefined, {
          onSuccess: (data) => resolve(data),
          onError: (e) => reject(e),
        });
      });
      const bal = result.balance;
      setBalance({ total: bal.totalBalance, available: bal.availableBalance });
      Alert.alert('연결 성공 ✅', `총 잔고: ${bal.totalBalance.toFixed(2)} USDT\n사용 가능: ${bal.availableBalance.toFixed(2)} USDT\n\n서버(IP: 18.141.170.17)를 통해 연결되었습니다.`);
    } catch (e) {
      Alert.alert('연결 실패 ❌', e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  }, [creds, serverSetCredentials, serverTestConnection]);

  const handleSave = useCallback(async () => {
    if (!creds.apiKey || !creds.secretKey) {
      Alert.alert('입력 오류', 'API Key와 Secret Key를 모두 입력하세요.');
      return;
    }
    setSaving(true);
    try {
      await saveCredentials(creds);
      // 서버에도 자격증명 동기화 (서버 봇이 API 키를 사용할 수 있도록)
      serverSetCredentials.mutate(creds);
      Alert.alert('저장 완료', '설정이 저장되었습니다.\n\n폰이 꺼져 있어도 서버 봇이 자동매매를 계속합니다.');
    } catch {
      Alert.alert('저장 실패', '설정 저장에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  }, [creds, serverSetCredentials]);

  const LevBtn = ({ val, field }: { val: number; field: 'leverageMin' | 'leverageMax' }) => (
    <TouchableOpacity
      style={[styles.chip, creds[field] === val && { backgroundColor: C.teal, borderColor: C.teal }]}
      onPress={() => setCreds(p => ({ ...p, [field]: val }))}
    >
      <Text style={[styles.chipText, creds[field] === val && { color: C.bg }]}>{val}x</Text>
    </TouchableOpacity>
  );

  const PctBtn = ({ val }: { val: number }) => (
    <TouchableOpacity
      style={[styles.chip, creds.positionSizePct === val && { backgroundColor: C.teal, borderColor: C.teal }]}
      onPress={() => setCreds(p => ({ ...p, positionSizePct: val }))}
    >
      <Text style={[styles.chipText, creds.positionSizePct === val && { color: C.bg }]}>{val}%</Text>
    </TouchableOpacity>
  );

  return (
    <ScreenContainer containerClassName="bg-[#0D1117]">
      <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Text style={styles.headerTitle}>⚙️ 설정</Text>
        </View>

        {/* API 키 */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>바이비트 API 키</Text>
          <Text style={styles.desc}>바이비트 계정의 API 키를 입력하세요. 선물 거래 권한이 필요합니다.</Text>

          <Text style={styles.label}>API Key</Text>
          <TextInput
            style={styles.input}
            value={creds.apiKey}
            onChangeText={v => setCreds(p => ({ ...p, apiKey: v.trim() }))}
            placeholder="API Key 입력"
            placeholderTextColor={C.muted}
            autoCapitalize="none"
            autoCorrect={false}
          />

          <View style={styles.labelRow}>
            <Text style={styles.label}>Secret Key</Text>
            <TouchableOpacity onPress={() => setShowSecret(p => !p)}>
              <Text style={{ color: C.teal, fontSize: 13 }}>{showSecret ? '숨기기' : '보기'}</Text>
            </TouchableOpacity>
          </View>
          <TextInput
            style={styles.input}
            value={creds.secretKey}
            onChangeText={v => setCreds(p => ({ ...p, secretKey: v.trim() }))}
            placeholder="Secret Key 입력"
            placeholderTextColor={C.muted}
            secureTextEntry={!showSecret}
            autoCapitalize="none"
            autoCorrect={false}
          />

          <View style={styles.switchRow}>
            <Text style={styles.label}>테스트넷 사용</Text>
            <Switch
              value={creds.isTestnet}
              onValueChange={v => setCreds(p => ({ ...p, isTestnet: v }))}
              trackColor={{ false: C.border, true: C.teal }}
              thumbColor={creds.isTestnet ? '#fff' : C.muted}
            />
          </View>

          {balance && (
            <View style={styles.balanceBox}>
              <Text style={styles.balanceText}>총 잔고: <Text style={{ color: C.teal }}>{balance.total.toFixed(2)} USDT</Text></Text>
              <Text style={styles.balanceText}>사용 가능: <Text style={{ color: C.green }}>{balance.available.toFixed(2)} USDT</Text></Text>
            </View>
          )}

          <TouchableOpacity style={[styles.testBtn, testing && { opacity: 0.6 }]} onPress={handleTest} disabled={testing}>
            {testing ? <ActivityIndicator size="small" color={C.bg} /> : <Text style={styles.testBtnText}>연결 테스트</Text>}
          </TouchableOpacity>
        </View>

        {/* 포지션 크기 */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>포지션 크기 (잔고 대비 %)</Text>
          <Text style={styles.desc}>종목당 잔고의 몇 %를 투자할지 설정합니다 (기본: 5%)</Text>
          <View style={styles.chipRow}>
            {[1, 3, 5, 10, 15, 20].map(v => <PctBtn key={v} val={v} />)}
          </View>
        </View>

        {/* 레버리지 */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>최소 레버리지</Text>
          <View style={styles.chipRow}>
            {[3, 5, 10, 20].map(v => <LevBtn key={v} val={v} field="leverageMin" />)}
          </View>
          <Text style={[styles.cardTitle, { marginTop: 12 }]}>최대 레버리지</Text>
          <View style={styles.chipRow}>
            {[20, 50, 75, 100].map(v => <LevBtn key={v} val={v} field="leverageMax" />)}
          </View>
        </View>

        {/* 일반봇 설정 */}
        <View style={[styles.card, { borderColor: '#00D4AA33', borderWidth: 1.5 }]}>
          <Text style={[styles.cardTitle, { color: '#00D4AA' }]}>📊 일반봇 설정</Text>
          <Text style={styles.desc}>TOP7 스캘핑 신호 기반 자동매매. 목표가 도달 시 신뢰도에 따라 유지 또는 청산을 자동 판단합니다.</Text>

          {/* 일반봇 목표가 */}
          <View style={[styles.levRow, { marginTop: 8 }]}>
            <View>
              <Text style={styles.levLabel}>🎯 목표가 (수익률)</Text>
              <Text style={[styles.desc, { marginTop: 2, marginBottom: 0 }]}>도달 시 신뢰도 85%+ 유지 | 미만 청산</Text>
            </View>
            <Text style={[styles.levValue, { color: '#D29922' }]}>{botConfig.normalTakeProfitPct ?? 50}%</Text>
          </View>
          <View style={styles.chipRow}>
            {[20, 30, 50, 75, 100, 150].map(v => (
              <TouchableOpacity
                key={v}
                style={[styles.chip, (botConfig.normalTakeProfitPct ?? 50) === v && { backgroundColor: '#D29922', borderColor: '#D29922' }]}
                onPress={() => setBotConfig(p => ({ ...p, normalTakeProfitPct: v }))}
              >
                <Text style={[styles.chipText, (botConfig.normalTakeProfitPct ?? 50) === v && { color: '#000' }]}>{v}%</Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* 일반봇 레버리지 */}
          <View style={[styles.levRow, { marginTop: 16 }]}>
            <Text style={styles.levLabel}>일반 기본 레버리지</Text>
            <Text style={styles.levValue}>{botConfig.defaultLeverage ?? 10}x</Text>
          </View>
          <View style={styles.chipRow}>
            {[5, 10, 15, 20, 30, 50].map(v => (
              <TouchableOpacity
                key={v}
                style={[styles.chip, (botConfig.defaultLeverage ?? 10) === v && { backgroundColor: C.teal, borderColor: C.teal }]}
                onPress={() => setBotConfig(p => ({ ...p, defaultLeverage: v }))}
              >
                <Text style={[styles.chipText, (botConfig.defaultLeverage ?? 10) === v && { color: C.bg }]}>{v}x</Text>
              </TouchableOpacity>
            ))}
          </View>

          <TouchableOpacity
            style={[styles.testBtn, { marginTop: 14, backgroundColor: '#00D4AA' }, configSaving && { opacity: 0.6 }]}
            onPress={handleSaveBotConfig}
            disabled={configSaving}
          >
            {configSaving
              ? <ActivityIndicator size="small" color={C.bg} />
              : <Text style={styles.testBtnText}>일반봇 설정 저장</Text>
            }
          </TouchableOpacity>
        </View>

        {/* 급등봇 설정 */}
        <View style={[styles.card, { borderColor: '#F9731633', borderWidth: 1.5 }]}>
          <Text style={[styles.cardTitle, { color: '#F97316' }]}>⚡ 급등봇 설정</Text>
          <Text style={styles.desc}>급등락+급등직전 신호 기반 자동매매. 고레버리지로 빠른 수익을 목표로 합니다.</Text>

          {/* 급등봇 레버리지 */}
          <View style={styles.levRow}>
            <Text style={styles.levLabel}>급등락 레버리지</Text>
            <Text style={[styles.levValue, { color: '#F97316' }]}>{botConfig.surgeLeverage ?? 10}x</Text>
          </View>
          <View style={styles.chipRow}>
            {[3, 5, 7, 10, 15, 20].map(v => (
              <TouchableOpacity
                key={v}
                style={[styles.chip, (botConfig.surgeLeverage ?? 10) === v && { backgroundColor: '#F97316', borderColor: '#F97316' }]}
                onPress={() => setBotConfig(p => ({ ...p, surgeLeverage: v }))}
              >
                <Text style={[styles.chipText, (botConfig.surgeLeverage ?? 10) === v && { color: '#000' }]}>{v}x</Text>
              </TouchableOpacity>
            ))}
          </View>

          <TouchableOpacity
            style={[styles.testBtn, { marginTop: 14, backgroundColor: '#F97316' }, configSaving && { opacity: 0.6 }]}
            onPress={handleSaveBotConfig}
            disabled={configSaving}
          >
            {configSaving
              ? <ActivityIndicator size="small" color={C.bg} />
              : <Text style={styles.testBtnText}>급등봇 설정 저장</Text>
            }
          </TouchableOpacity>
        </View>

        {/* 안내 */}
        <View style={styles.infoCard}>
          <Text style={styles.infoTitle}>⚠️ 매매 규칙 안내 (v8)</Text>
          {[
            'Cross 마진 모드 | 시장가(Market) 주문',
            '신뢰도 80%+ 진입 | 95%+ 슬롯 초과여도 강제진입 (1.5배 크기)',
            '슬롯 10개 | 종목당 2% | BTC 급락(-3%) 시 신규 진입 전면 중단',
            '켈리 공식 적용 | 신뢰도 반영 동적 포지션 크기 결정',
            'ATR 동적 손절 | 손실 30%부터 10% 단위 추세 분석',
            '추세 반전 시: 손절 후 역방향 진입 | 역방향 최대 2회 제한',
            '추가매수: 최대 2회 | 30분 쿨다운 | 신뢰도 75%+ | TF 일치 | 보유량 20%',
            '피라미딩: +10%/+20% 수익 구간에 추가매수 (20%/10%)',
            '1차 TP 도달 후 손익분기점 이동 + 트레일링 스탭 자동 활성화',
            '트레일링: 일반 5% | 급등 5% | 급등직전 8% (최고점 대비 하락 시 청산)',
            'MMR 80% 초과 시 수익률 하위부터 자동 청산',
            '제외 목록 종목: 모든 진입/추가매수/손절 전면 차단',
            '일일 목표 30% 달성 시 보수모드 (신뢰도 90%+, 최대 5개)',
          ].map((t, i) => (
            <Text key={i} style={styles.infoText}>• {t}</Text>
          ))}
        </View>

        {/* 제외 종목 관리 */}
        <View style={styles.card}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <Text style={styles.cardTitle}>자동봇 제외 종목 관리</Text>
            {excludeList.length > 0 && (
              <TouchableOpacity onPress={handleClearAllExclude} disabled={excludeLoading}>
                <Text style={{ color: C.red, fontSize: 12, fontWeight: '600' }}>전체 해제</Text>
              </TouchableOpacity>
            )}
          </View>
          <Text style={styles.desc}>자동봇에서 제외된 종목 목록입니다. 종목을 탭하면 제외를 해제할 수 있습니다.</Text>
          {excludeLoading ? (
            <ActivityIndicator size="small" color={C.teal} style={{ marginVertical: 8 }} />
          ) : excludeList.length === 0 ? (
            <View style={{ paddingVertical: 16, alignItems: 'center' }}>
              <Text style={{ color: C.muted, fontSize: 13 }}>제외된 종목이 없습니다</Text>
            </View>
          ) : (
            <View style={{ gap: 8 }}>
              {excludeList.map(sym => (
                <View key={sym} style={styles.excludeRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.excludeSymbol}>{sym.replace('USDT', '').replace('PERP', '')}</Text>
                    <Text style={styles.excludeSubtext}>{sym}</Text>
                  </View>
                  <TouchableOpacity
                    style={styles.excludeUnbtn}
                    onPress={() => handleRemoveExclude(sym)}
                  >
                    <Text style={styles.excludeUnbtnText}>해제</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}
        </View>

        {/* 저장 */}
        <View style={styles.saveRow}>
          <TouchableOpacity style={[styles.saveBtn, saving && { opacity: 0.6 }]} onPress={handleSave} disabled={saving}>
            {saving ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.saveBtnText}>설정 저장</Text>}
          </TouchableOpacity>
        </View>

        <View style={{ height: 32 }} />
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: C.bg },
  header: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  headerTitle: { fontSize: 20, fontWeight: '700', color: C.teal },
  card: { marginHorizontal: 16, marginBottom: 12, backgroundColor: C.surface, borderRadius: 12, padding: 16, borderWidth: 1, borderColor: C.border },
  cardTitle: { fontSize: 14, fontWeight: '700', color: C.text, marginBottom: 8 },
  desc: { fontSize: 12, color: C.muted, marginBottom: 12, lineHeight: 18 },
  label: { fontSize: 13, color: C.muted, marginBottom: 6 },
  labelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  input: { backgroundColor: C.bg, borderRadius: 10, padding: 12, color: C.text, fontSize: 14, borderWidth: 1, borderColor: C.border, marginBottom: 12 },
  switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  balanceBox: { backgroundColor: '#0D2818', borderRadius: 8, padding: 10, marginBottom: 12, borderWidth: 1, borderColor: '#1A4A2A' },
  balanceText: { fontSize: 13, color: C.text, marginBottom: 2 },
  testBtn: { backgroundColor: C.teal, borderRadius: 10, padding: 12, alignItems: 'center' },
  testBtnText: { color: C.bg, fontWeight: '700', fontSize: 14 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, borderWidth: 1, borderColor: C.border, backgroundColor: C.bg },
  chipText: { color: C.text, fontSize: 13, fontWeight: '600' },
  infoCard: { marginHorizontal: 16, marginBottom: 12, backgroundColor: '#1A1F2A', borderRadius: 12, padding: 16, borderWidth: 1, borderColor: '#2A3A4A' },
  infoTitle: { fontSize: 13, fontWeight: '700', color: C.yellow, marginBottom: 10 },
  infoText: { fontSize: 12, color: C.muted, marginBottom: 4, lineHeight: 18 },
  saveRow: { paddingHorizontal: 16, marginBottom: 8 },
  saveBtn: { backgroundColor: C.green, borderRadius: 12, padding: 16, alignItems: 'center' },
  saveBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  excludeRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.bg, borderRadius: 10, padding: 12, borderWidth: 1, borderColor: C.border },
  excludeSymbol: { fontSize: 14, fontWeight: '700', color: C.text },
  excludeSubtext: { fontSize: 11, color: C.muted, marginTop: 2 },
  excludeUnbtn: { backgroundColor: '#2A1A1A', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: C.red },
  excludeUnbtnText: { color: C.red, fontSize: 12, fontWeight: '600' },
  levRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  levLabel: { fontSize: 13, color: C.muted, fontWeight: '600' },
  levValue: { fontSize: 16, color: C.teal, fontWeight: '800' },
});
