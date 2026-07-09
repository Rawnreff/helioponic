import React, {useEffect, useState, useCallback} from 'react';
import {View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import {Ionicons} from '@expo/vector-icons';
import CustomDatePicker from '../components/CustomDatePicker';
import {useAuth} from '../context/AuthContext';
import {HistoryLineChart} from '../components/HistoryLineChart';
import {sensorsApi, waterApi} from '../lib/apiClient';
import {SectionHeader} from '../components/SectionHeader';
import {Colors, Shadows} from '../context/ThemeContext';

type Period = '24h' | '7d' | '30d';

function getTimeRange(period: Period): {from: Date; to: Date} {
  const to = new Date(); const from = new Date();
  if (period === '24h') from.setHours(from.getHours() - 24);
  else if (period === '7d') from.setDate(from.getDate() - 7);
  else from.setDate(from.getDate() - 30);
  return {from, to};
}

function MiniStat({label, value, avg: avgStr, color, icon}: {label: string; value: string; avg: string; color: string; icon: string}) {
  return (
    <LinearGradient colors={[color + '40', color + '20'] as const} start={{x: 0, y: 0}} end={{x: 1, y: 1}} style={styles.miniStatBorderGradient}>
      <View style={styles.miniStat}>
        <View style={[styles.miniStatIcon, {backgroundColor: color + '15'}]}><Ionicons name={icon as any} size={14} color={color} /></View>
        <Text style={[styles.miniStatValue, {color}]}>{value}</Text>
        <Text style={[styles.miniStatLabel, {color: color + 'CC'}]}>{label}</Text>
        <Text style={styles.miniStatAvg}>Avg {avgStr}</Text>
      </View>
    </LinearGradient>
  );
}

function ChartCard({title, icon, color, colors, data, latestValue}: {
  title: string; icon: string; color: string; colors: readonly [string, string, ...string[]]; data: any[]; latestValue?: string | null;
}) {
  return (
    <LinearGradient colors={colors} start={{x: 0, y: 0}} end={{x: 1, y: 1}} style={styles.chartBorderGradient}>
      <View style={styles.chartCard}>
        <SectionHeader icon={icon} colors={[color, color + 'CC'] as const} title={title} badge={latestValue || undefined} bgColor={latestValue ? color + '18' : undefined} />
        <HistoryLineChart data={data} color={color} gradientStart={color} height={140} />
      </View>
    </LinearGradient>
  );
}

export default function AnalyticsScreen() {
  const {activeDeviceId} = useAuth();
  const [period, setPeriod] = useState<Period>('24h');
  const [sensorHistory, setSensorHistory] = useState<any[]>([]);
  const [waterHistory, setWaterHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [customFrom, setCustomFrom] = useState<Date | null>(null);
  const [customTo, setCustomTo] = useState<Date | null>(null);
  const [showCustom, setShowCustom] = useState(false);
  const [showPicker, setShowPicker] = useState<'from' | 'to' | null>(null);

  const resetToToday = useCallback(() => {const now = new Date(); setCustomFrom(new Date(now.getFullYear(), now.getMonth(), now.getDate())); setCustomTo(now);}, []);

  const fetchHistory = useCallback(async (p: Period) => {
    setLoading(true);
    try {
      const {from, to} = getTimeRange(p);
      const [sensorRes, waterRes] = await Promise.all([sensorsApi.history(from.toISOString(), to.toISOString(), activeDeviceId, 200), waterApi.history(from.toISOString(), to.toISOString(), activeDeviceId, 200)]);
      setSensorHistory(sensorRes.data || []); setWaterHistory(waterRes.data || []);
    } catch {setSensorHistory([]); setWaterHistory([]);}
    finally {setLoading(false);}
  }, [activeDeviceId]);

  useEffect(() => {fetchHistory(period);}, [period, fetchHistory]);

  const fetchCustomRange = useCallback(async () => {
    if (!customFrom || !customTo) return;
    setLoading(true);
    try {
      const [sensorRes, waterRes] = await Promise.all([sensorsApi.history(customFrom.toISOString(), customTo.toISOString(), activeDeviceId, 500), waterApi.history(customFrom.toISOString(), customTo.toISOString(), activeDeviceId, 500)]);
      setSensorHistory(sensorRes.data || []); setWaterHistory(waterRes.data || []);
    } finally {setLoading(false);}
  }, [customFrom, customTo, activeDeviceId]);

  const periods: {key: Period; label: string}[] = [{key: '24h', label: 'Day'}, {key: '7d', label: 'Week'}, {key: '30d', label: 'Month'}];
  const buildChartData = (records: any[], key: string) => records.map((r, i) => ({value: r[key] ?? 0, label: i % Math.max(1, Math.floor(records.length / 5)) === 0 ? new Date(r.recorded_at).getHours() + 'h' : ''}));
  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / (arr.length || 1);
  const latest = (arr: any[], key: string) => arr.length > 0 ? arr[arr.length - 1][key] : null;

  return (
    <SafeAreaView style={{flex: 1, backgroundColor: Colors.background}} edges={['top']}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <View style={styles.headerIcon}><LinearGradient colors={[Colors.primaryGreen, Colors.deepGreen] as const} start={{x: 0, y: 0}} end={{x: 1, y: 1}} style={styles.headerIconGradient}><Ionicons name="analytics" size={20} color="#fff" /></LinearGradient></View>
          <View style={{flex: 1}}><Text style={styles.headerTitle}>Analytics</Text><Text style={styles.headerSub}>Historical sensor trends</Text></View>
        </View>

        <View style={styles.periodBar}>
          {periods.map((p) => (<TouchableOpacity key={p.key} style={[styles.periodBtn, period === p.key && styles.periodBtnActive]} onPress={() => {setPeriod(p.key); setShowCustom(false);}}><Text style={[styles.periodText, period === p.key && styles.periodTextActive]}>{p.label}</Text></TouchableOpacity>))}
          <TouchableOpacity style={[styles.periodBtn, showCustom && styles.periodBtnActive]} onPress={() => setShowCustom(!showCustom)}><Ionicons name="calendar" size={16} color={showCustom ? Colors.primaryGreen : Colors.textSecondary} /></TouchableOpacity>
        </View>

        {showCustom && (
          <View style={styles.section}>
            <Text style={styles.customTitle}>Custom Date Range</Text>
            <View style={styles.customRow}>
              <View style={styles.dateField}><Text style={styles.dateLabel}>From</Text><TouchableOpacity style={styles.datePicker} onPress={() => setShowPicker('from')}><Ionicons name="calendar-outline" size={16} color={Colors.primaryGreen} /><Text style={styles.dateText}>{customFrom ? customFrom.toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric'}) : 'Select date'}</Text></TouchableOpacity></View>
              <View style={styles.dateField}><Text style={styles.dateLabel}>To</Text><TouchableOpacity style={styles.datePicker} onPress={() => setShowPicker('to')}><Ionicons name="calendar-outline" size={16} color={Colors.primaryGreen} /><Text style={styles.dateText}>{customTo ? customTo.toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric'}) : 'Select date'}</Text></TouchableOpacity></View>
            </View>
            <TouchableOpacity style={[styles.applyBtn, {opacity: customFrom && customTo ? 1 : 0.5}]} onPress={() => {if (customFrom && customTo) fetchCustomRange();}} disabled={!customFrom || !customTo}><Ionicons name="search" size={16} color="#FFF" /><Text style={styles.applyText}>Apply Range</Text></TouchableOpacity>
            <TouchableOpacity style={styles.todayBtn} onPress={resetToToday}><Ionicons name="today-outline" size={16} color={Colors.primaryGreen} /><Text style={styles.todayText}>Today</Text></TouchableOpacity>
          </View>
        )}

        {showPicker && <CustomDatePicker visible={true} value={showPicker === 'from' ? (customFrom || new Date(Date.now() - 7 * 86400000)) : (customTo || new Date())} maximumDate={new Date()} onSelect={(d: Date) => {if (showPicker === 'from') setCustomFrom(d); else setCustomTo(d); setShowPicker(null);}} onCancel={() => setShowPicker(null)} />}

        {loading && <View style={styles.loadingContainer}><ActivityIndicator size="large" color={Colors.primaryGreen} /><Text style={styles.loadingText}>Loading sensor data...</Text></View>}

        {!loading && sensorHistory.length === 0 && (
          <View style={styles.loadingContainer}><View style={styles.emptyIcon}><Ionicons name="analytics-outline" size={48} color={Colors.textHint} /></View><Text style={styles.emptyTitle}>No Data Available</Text><Text style={styles.emptyDesc}>No sensor readings found for this period.{'\n'}Try selecting a different time range.</Text></View>
        )}

        {!loading && sensorHistory.length > 0 && (
          <View style={styles.summaryRow}>
            <MiniStat label="pH" value={latest(sensorHistory, 'current_ph')?.toFixed(1) ?? '--'} avg={avg(sensorHistory.map(s => s.current_ph)).toFixed(1)} color={Colors.tempBlue} icon="flask" />
            <MiniStat label="TDS" value={latest(sensorHistory, 'tds_value')?.toFixed(0) ?? '--'} avg={avg(sensorHistory.map(s => s.tds_value)).toFixed(0)} color={Colors.energyOrange} icon="water" />
            <MiniStat label="Jarak" value={latest(sensorHistory, 'jarak_cm') ?? '--'} avg={avg(sensorHistory.map(s => s.jarak_cm || 0)).toFixed(0)} color={Colors.waterTeal} icon="water" />
          </View>
        )}

        {!loading && sensorHistory.length > 0 && (
          <>
            <ChartCard title="pH Level" icon="flask" color={Colors.tempBlue} colors={['#1976D2', '#42A5F5'] as const} data={buildChartData(sensorHistory, 'current_ph')} latestValue={latest(sensorHistory, 'current_ph')?.toFixed(1)} />
            <ChartCard title="TDS (ppm)" icon="water" color={Colors.energyOrange} colors={['#EF6C00', '#FFA726'] as const} data={buildChartData(sensorHistory, 'tds_value')} latestValue={latest(sensorHistory, 'tds_value')?.toFixed(0)} />
            <ChartCard title="Distance (cm)" icon="water" color={Colors.waterTeal} colors={['#00897B', '#4DB6AC'] as const} data={buildChartData(waterHistory, 'jarak_cm')} latestValue={latest(waterHistory, 'jarak_cm')?.toFixed(0)} />
            <ChartCard title="Energy (Wh)" icon="sunny" color={Colors.solarAmber} colors={['#FFB300', '#FFD54F'] as const} data={[]} latestValue={null} />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: Colors.background},
  content: {paddingBottom: 32},
  header: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 4},
  headerIcon: {borderRadius: 14, overflow: 'hidden', ...Shadows.subtle},
  headerIconGradient: {width: 44, height: 44, justifyContent: 'center', alignItems: 'center'},
  headerTitle: {fontSize: 22, fontWeight: '800', color: Colors.textPrimary, letterSpacing: -0.5},
  headerSub: {fontSize: 12, color: Colors.textSecondary, marginTop: 2},
  periodBar: {flexDirection: 'row', marginHorizontal: 16, marginTop: 16, marginBottom: 16, backgroundColor: '#E8ECF1', borderRadius: 14, padding: 4, gap: 4},
  periodBtn: {flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 12},
  periodBtnActive: {backgroundColor: '#FFFFFF', shadowColor: '#000', shadowOffset: {width: 0, height: 2}, shadowOpacity: 0.08, shadowRadius: 8, elevation: 4},
  periodText: {fontSize: 13, fontWeight: '600', color: Colors.textSecondary},
  periodTextActive: {fontWeight: '800', color: Colors.primaryGreen},
  summaryRow: {flexDirection: 'row', gap: 10, marginHorizontal: 16, marginBottom: 16},
  miniStatBorderGradient: {flex: 1, padding: 1.5, borderRadius: 20},
  miniStat: {flex: 1, backgroundColor: '#FFFFFF', borderRadius: 18, padding: 14, alignItems: 'center', gap: 4},
  miniStatIcon: {padding: 8, borderRadius: 10, marginBottom: 4},
  miniStatValue: {fontSize: 18, fontWeight: '800'},
  miniStatLabel: {fontSize: 10, fontWeight: '600'},
  miniStatAvg: {fontSize: 9, color: Colors.textHint, fontWeight: '500'},
  chartBorderGradient: {padding: 2, borderRadius: 24, marginHorizontal: 16, marginBottom: 12},
  chartCard: {backgroundColor: '#FFFFFF', borderRadius: 22, padding: 20},
  section: {backgroundColor: '#FFFFFF', marginHorizontal: 16, borderRadius: 24, padding: 20, marginBottom: 14, shadowColor: Colors.primaryGreen, shadowOffset: {width: 0, height: 8}, shadowOpacity: 0.1, shadowRadius: 20, elevation: 6, borderWidth: 1, borderColor: 'rgba(46,125,50,0.1)'},
  customTitle: {fontSize: 16, fontWeight: '700', color: Colors.textPrimary, marginBottom: 12, letterSpacing: -0.3},
  customRow: {flexDirection: 'row', gap: 12, marginBottom: 14},
  dateField: {flex: 1},
  dateLabel: {fontSize: 11, fontWeight: '600', color: Colors.textSecondary, marginBottom: 6},
  datePicker: {flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#F8F9FA', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 12, borderWidth: 1, borderColor: Colors.cardBorder},
  dateText: {fontSize: 13, fontWeight: '500', color: Colors.textPrimary, flex: 1},
  applyBtn: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: Colors.primaryGreen, borderRadius: 14, paddingVertical: 14, shadowColor: Colors.primaryGreen, shadowOffset: {width: 0, height: 4}, shadowOpacity: 0.2, shadowRadius: 8, elevation: 4},
  applyText: {fontSize: 14, fontWeight: '700', color: '#FFF'},
  todayBtn: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: '#E8F5E9', borderRadius: 14, paddingVertical: 14, marginTop: 8, borderWidth: 1, borderColor: Colors.primaryGreen + '40'},
  todayText: {fontSize: 14, fontWeight: '700', color: Colors.primaryGreen},
  loadingContainer: {alignItems: 'center', justifyContent: 'center', paddingVertical: 48, marginHorizontal: 16},
  loadingText: {fontSize: 13, color: Colors.textHint, fontWeight: '500', marginTop: 12},
  emptyIcon: {width: 72, height: 72, borderRadius: 36, backgroundColor: '#F1F3F5', alignItems: 'center', justifyContent: 'center', marginBottom: 12},
  emptyTitle: {fontSize: 18, fontWeight: '700', color: Colors.textPrimary, marginBottom: 8},
  emptyDesc: {fontSize: 13, color: Colors.textHint, fontWeight: '500', textAlign: 'center', lineHeight: 20},
});
