import React, {useEffect, useState, useCallback, useMemo} from 'react';
import {View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator, RefreshControl, LayoutChangeEvent, Alert} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import {Ionicons} from '@expo/vector-icons';
import {File, Paths} from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import {useAuth} from '../context/AuthContext';
import {useSensorStore} from '../store/sensorStore';
import {HistoryLineChart} from '../components/HistoryLineChart';
import {sensorsApi} from '../lib/apiClient';
import {SectionHeader} from '../components/SectionHeader';
import {Colors, Shadows} from '../context/ThemeContext';

type Period = 'day' | 'week' | 'month';

// ─── Data aggregation ────────────────────────────────

interface AggregatedPoint {
  value: number;
  label: string;
  /** Raw timestamp (ms) for sorting / dedup */
  ts: number;
}

/**
 * Aggregate raw sensor records into evenly-spaced averaged points.
 *
 * Divides the chronological records into N equal chunks, then averages
 * each chunk to produce one chart point. This is simpler and more robust
 * than time-bucketing — no date-parsing edge cases, no Map iteration issues.
 *
 * Day   → ~144 points (6 data per hour × 24h) — scrollable, every ~10 min
 * Week  → ~168 points (24 data per day × 7d) — scrollable, every ~1 hour
 * Month → ~168 points (42 data per week × 4w) — scrollable, every ~4 hours
 *
 * These counts provide fine-grained resolution while keeping charts
 * performant and horizontally scrollable.
 */
function aggregateRecords(
  records: any[],
  period: Period,
  extractValue: (r: any) => number,
): AggregatedPoint[] {
  if (!records.length) return [];

  // Work on a chronological (oldest-first) copy
  // Cap raw input at 9000 to handle 30 days × 288 records/day = 8640, with margin
  const chronological = [...records].reverse().slice(0, 9000);

  // Target number of output points per period
  const targetCount =
    period === 'day' ? 144 :
    period === 'week' ? 168 :
    168;

  // If we have fewer records than target, use all of them
  if (chronological.length <= targetCount) {
    return chronological.map((r) => {
      const d = new Date(normalizeIso(r.recorded_at));
      return {
        value: extractValue(r),
        label: formatChartLabel(d.toISOString(), period),
        ts: d.getTime(),
      };
    });
  }

  // Chunk size: how many consecutive records to merge into one point
  const chunkSize = Math.ceil(chronological.length / targetCount);
  const result: AggregatedPoint[] = [];

  for (let i = 0; i < chronological.length; i += chunkSize) {
    const chunk = chronological.slice(i, i + chunkSize);
    let sum = 0;
    let count = 0;
    let lastTs = 0;
    for (const r of chunk) {
      const val = extractValue(r);
      sum += val;
      count++;
      // Use the LAST record's timestamp in the chunk for the label
      const dateStr = r.recorded_at;
      if (dateStr) {
        const d = new Date(normalizeIso(dateStr));
        if (!isNaN(d.getTime())) {
          lastTs = d.getTime();
        }
      }
    }
    if (count > 0) {
      const midDate = new Date(lastTs);
      result.push({
        value: sum / count,
        label: formatChartLabel(midDate.toISOString(), period),
        ts: lastTs,
      });
    }
  }

  return result;
}


// ─── Helpers ──────────────────────────────────────────

function computeWaterPct(jarakCm: number): number {
  if (jarakCm >= 999 || jarakCm < 0) return 0;
  const TANK_DEPTH_CM = 7;
  const waterDepth = TANK_DEPTH_CM - Math.min(jarakCm, TANK_DEPTH_CM);
  return Math.max(0, Math.min(100, (waterDepth / TANK_DEPTH_CM) * 100));
}

function getTimeRange(period: Period): {from: Date; to: Date} {
  // Safe UTC date generation — never mutate shared Date objects.
  // All MongoDB timestamps are stored in UTC, so use UTC methods
  // (setUTCHours, setUTCDate) to avoid timezone shifts.
  const to = new Date();
  to.setUTCHours(23, 59, 59, 999);
  let from = new Date();

  if (period === 'day') {
    from.setUTCHours(0, 0, 0, 0);
  } else if (period === 'week') {
    from.setUTCDate(to.getUTCDate() - 7);
    from.setUTCHours(0, 0, 0, 0);
  } else {
    from.setUTCDate(to.getUTCDate() - 30);
    from.setUTCHours(0, 0, 0, 0);
  }
  return {from, to};
}

/** Ensure ISO string always has timezone info (Z for UTC) so JS Date parses correctly */
function normalizeIso(dateStr: string): string {
  if (!dateStr) return dateStr;
  if (dateStr.endsWith('Z') || /[+\-]\d{2}:\d{2}$/.test(dateStr)) return dateStr;
  return dateStr + 'Z';
}

/**
 * Format a chart x-axis label.
 * Labels are kept deliberately short so they fit in tight spacing
 * when all data points are shown on-screen (fit mode).
 *
 * Day   → "14h"
 * Week  → "Thu"
 * Month → "15/7"
 */
function formatChartLabel(dateStr: string, period: Period): string {
  const d = new Date(normalizeIso(dateStr));
  if (period === 'day') {
    return `${d.getHours()}h`;
  } else if (period === 'week') {
    const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    return days[d.getDay()];
  }
  // Month: day/month
  return `${d.getDate()}/${d.getMonth()+1}`;
}

function formatPeriodRange(period: Period): string {
  const now = new Date();
  if (period === 'day') return `Today, ${now.toLocaleDateString('en-US', {month: 'long', day: 'numeric'})}`;
  if (period === 'week') return `Last 7 days – ${now.toLocaleDateString('en-US', {month: 'short', day: 'numeric'})}`;
  return `Last 30 days – ${now.toLocaleDateString('en-US', {month: 'short', day: 'numeric'})}`;
}

/** Compute number of data points to skip for label display.
 *  Shows ~4-5 labels evenly spaced across the chart. */
function labelStep(total: number): number {
  if (total <= 6) return 1;
  return Math.max(1, Math.floor(total / 4));
}

// ─── Enhanced Stat Card ──────────────────────────────

const StatCard = React.memo(function StatCard({
  label, icon, color, latest, min, max, avg, unit,
}: {
  label: string; icon: string; color: string;
  latest: string; min: string; max: string; avg: string; unit?: string;
}) {
  return (
    <LinearGradient colors={[color + '40', color + '20'] as const} start={{x: 0, y: 0}} end={{x: 1, y: 1}} style={styles.statBorder}>
      <View style={styles.statInner}>
        <View style={styles.statHeader}>
          <View style={[styles.statIconWrap, {backgroundColor: color + '15'}]}>
            <Ionicons name={icon as any} size={14} color={color} />
          </View>
          <Text style={[styles.statLabel, {color: color + 'CC'}]}>{label}</Text>
        </View>
        <Text style={[styles.statLatest, {color}]}>{latest}<Text style={styles.statUnit}>{unit || ''}</Text></Text>
        <View style={styles.statGrid}>
          <View style={styles.statItem}>
            <Text style={styles.statItemLabel}>Min</Text>
            <Text style={[styles.statItemValue, {color}]}>{min}</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <Text style={styles.statItemLabel}>Max</Text>
            <Text style={[styles.statItemValue, {color}]}>{max}</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <Text style={styles.statItemLabel}>Avg</Text>
            <Text style={[styles.statItemValue, {color}]}>{avg}</Text>
          </View>
        </View>
      </View>
    </LinearGradient>
  );
});

// ─── Chart Card (memoized) ──────────────────────────

const ChartCard = React.memo(function ChartCard({
  title, icon, color, colors, data, latestValue, chartWidth, unit, roundY, minRange,
}: {
  title: string; icon: string; color: string; colors: readonly [string, string];
  data: {value: number; label?: string}[];
  latestValue?: string | null; chartWidth: number;
  unit?: string; roundY?: boolean; minRange?: number;
}) {
  return (
    <LinearGradient colors={colors} start={{x: 0, y: 0}} end={{x: 1, y: 1}} style={styles.chartBorder}>
      <View style={styles.chartCard}>
        <SectionHeader
          icon={icon}
          colors={[color, color + 'CC'] as const}
          title={title}
          badge={latestValue || undefined}
          bgColor={latestValue ? color + '18' : undefined}
        />
        <HistoryLineChart
          data={data}
          color={color}
          gradientStart={color}
          height={140}
          chartWidth={chartWidth}
          unit={unit || ''}
          roundY={roundY}
          minRange={minRange}
          scrollable
        />
      </View>
    </LinearGradient>
  );
});

// ─── Main Screen ─────────────────────────────────────

export default function AnalyticsScreen() {
  const {activeDeviceId} = useAuth();
  const [period, setPeriod] = useState<Period>('day');
  const [sensorHistory, setSensorHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chartWidth, setChartWidth] = useState(0);

  const [exporting, setExporting] = useState(false);

  // ── Real-time WebSocket data ───────────────────────
  const latestReading = useSensorStore((s) => s.latestReading);

  // ── Merge real-time latest reading into history data ──
  // This way charts update INSTANTLY when WebSocket pushes new data,
  // not just every 30s when the REST poll completes.
  const combinedHistory = useMemo(() => {
    if (!latestReading) return sensorHistory;
    if (sensorHistory.length === 0) {
      // No REST data yet — use the latest reading as a standalone record
      const rt: any = {
        recorded_at: latestReading.ts ? new Date(latestReading.ts * 1000).toISOString() : new Date().toISOString(),
        current_ph: latestReading.current_ph,
        tds_value: latestReading.tds_value,
        jarak_cm: latestReading.jarak_cm,
        pompa1: latestReading.pompa1,
        pompa2: latestReading.pompa2,
        pompa3: latestReading.pompa3,
        pompa4: latestReading.pompa4,
      };
      return [rt];
    }

    // Check if the latestReading is newer than the newest history record
    const newestHistory = sensorHistory[0];
    const historyTs = newestHistory?.recorded_at
      ? new Date(normalizeIso(newestHistory.recorded_at)).getTime()
      : 0;
    const wsTs = latestReading.ts ? latestReading.ts * 1000 : 0;

    if (wsTs <= historyTs) {
      // WebSocket data is not newer — history is already up to date
      return sensorHistory;
    }

    // WebSocket data IS newer — prepend it to history
    const freshRecord: any = {
      recorded_at: new Date(wsTs).toISOString(),
      current_ph: latestReading.current_ph,
      tds_value: latestReading.tds_value,
      jarak_cm: latestReading.jarak_cm,
      pompa1: latestReading.pompa1,
      pompa2: latestReading.pompa2,
      pompa3: latestReading.pompa3,
      pompa4: latestReading.pompa4,
    };
    return [freshRecord, ...sensorHistory];
  }, [latestReading, sensorHistory]);

  // ── Fetch data ─────────────────────────────────────
  const fetchHistory = useCallback(async (p: Period, silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const {from, to} = getTimeRange(p);
      const limit = 25000;
      const sensorRes = await sensorsApi.history(from.toISOString(), to.toISOString(), activeDeviceId, limit);
      setSensorHistory(sensorRes.data || []);
    } catch (err: any) {
      if (!silent) {
        console.warn('[Analytics] fetchHistory failed:', err?.message || err);
        setError(err?.message || 'Failed to load analytics data');
      }
      setSensorHistory([]);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [activeDeviceId]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchHistory(period);
    setRefreshing(false);
  }, [period, fetchHistory]);

  // Auto-refresh every 30 seconds (silent — no loading spinner)
  useEffect(() => {
    fetchHistory(period);
    const timer = setInterval(() => fetchHistory(period, true), 30000);
    return () => clearInterval(timer);
  }, [period, fetchHistory]);

  // ── Aggregated chart data (uses combinedHistory for real-time updates) ───
  const pHChartData = useMemo(() => {
    if (!combinedHistory.length) return [];
    const points = aggregateRecords(combinedHistory, period, (r) => r.current_ph ?? 0);
    const step = labelStep(points.length);
    return points.map((p, i) => ({
      value: p.value,
      label: i % step === 0 || i === points.length - 1 ? p.label : '',
    }));
  }, [combinedHistory, period]);

  const tdsChartData = useMemo(() => {
    if (!combinedHistory.length) return [];
    const points = aggregateRecords(combinedHistory, period, (r) => r.tds_value ?? 0);
    const step = labelStep(points.length);
    return points.map((p, i) => ({
      value: p.value,
      label: i % step === 0 || i === points.length - 1 ? p.label : '',
    }));
  }, [combinedHistory, period]);

  const waterChartData = useMemo(() => {
    if (!combinedHistory.length) return [];
    const points = aggregateRecords(combinedHistory, period, (r) => computeWaterPct(r.jarak_cm || 999));
    const step = labelStep(points.length);
    return points.map((p, i) => ({
      value: p.value,
      label: i % step === 0 || i === points.length - 1 ? p.label : '',
    }));
  }, [combinedHistory, period]);

  // Stats computation — uses combinedHistory so latest reading is reflected
  const stats = useMemo(() => {
    if (!combinedHistory.length) return null;

    const phVals = combinedHistory.map((s) => s.current_ph).filter((v: number) => v > 0);
    const tdsVals = combinedHistory.map((s) => s.tds_value).filter((v: number) => v > 0);
    const waterVals = combinedHistory.map((s) => computeWaterPct(s.jarak_cm || 999));

    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / (arr.length || 1);
    const latest = (key: string) => combinedHistory[0]?.[key] ?? null;
    const latestWater = () => computeWaterPct(combinedHistory[0]?.jarak_cm ?? 999);

    return {
      ph: {
        latest: phVals.length ? latest('current_ph') : null,
        min: phVals.length ? Math.min(...phVals) : null,
        max: phVals.length ? Math.max(...phVals) : null,
        avg: phVals.length ? avg(phVals) : null,
      },
      tds: {
        latest: tdsVals.length ? latest('tds_value') : null,
        min: tdsVals.length ? Math.min(...tdsVals) : null,
        max: tdsVals.length ? Math.max(...tdsVals) : null,
        avg: tdsVals.length ? avg(tdsVals) : null,
      },
      water: {
        latest: waterVals.length ? latestWater() : null,
        min: waterVals.length ? Math.min(...waterVals) : null,
        max: waterVals.length ? Math.max(...waterVals) : null,
        avg: waterVals.length ? avg(waterVals) : null,
      },
    };
  }, [combinedHistory]);

  // ── Chart width measurement ─────────────────────────
  const onChartCardLayout = useCallback((e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width - 40;
    if (w > 0 && w !== chartWidth) setChartWidth(w);
  }, [chartWidth]);

  // ── Export to CSV (aggregated, downsampled) ──
  const handleExportCSV = useCallback(async () => {
    const {from, to} = getTimeRange(period);
    const csvRange: 'daily' | 'weekly' | 'monthly' =
      period === 'day' ? 'daily' : period === 'week' ? 'weekly' : 'monthly';

    console.log('[Analytics] Exporting', period, 'range:', csvRange,
      '| from:', from.toISOString(), '| to:', to.toISOString(),
      '| device:', activeDeviceId);

    setExporting(true);
    try {
      // Pass explicit from_date/to_date so export range matches chart period
      const csvContent = await sensorsApi.exportCsv(
        csvRange, activeDeviceId,
        from.toISOString(), to.toISOString(),
      );

      // Belt-and-suspenders: backend returns empty body when 0 records,
      // but also check for header-only CSV (single line) as a safety net.
      const trimmed = csvContent.trim();
      if (!trimmed || trimmed.split('\n').length <= 1) {
        Alert.alert('No Data', 'No sensor data found for this period.');
        return;
      }

      const label = period;
      const fileName = `helioponic_${label}_${new Date().toISOString().slice(0, 10)}.csv`;
      const file = new File(Paths.cache, fileName);
      file.write(csvContent);

      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(file.uri, {
          mimeType: 'text/csv',
          dialogTitle: 'Export Helioponic Sensor Data',
          UTI: 'public.comma-separated-values-text',
        });
      } else {
        Alert.alert('File Saved', `CSV saved to: ${file.uri}`);
      }
    } catch (err: any) {
      console.warn('[Analytics] export failed:', err);
      Alert.alert('Export Failed', err?.message || 'Could not export data');
    } finally {
      setExporting(false);
    }
  }, [period, activeDeviceId]);

  // ── Time range context string ─────────────────────
  const timeRangeLabel = formatPeriodRange(period);

  // ── Render ─────────────────────────────────────────
  const periods: {key: Period; label: string}[] = [
    {key: 'day', label: 'Day'},
    {key: 'week', label: 'Week'},
    {key: 'month', label: 'Month'},
  ];

  return (
    <SafeAreaView style={{flex: 1, backgroundColor: Colors.background}} edges={['top']}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={Colors.primaryGreen}
            colors={[Colors.primaryGreen]}
          />
        }
      >
        {/* ── Header ───────────────────────────────── */}
        <View style={styles.header}>
          <View style={styles.headerIcon}>
            <LinearGradient colors={[Colors.primaryGreen, Colors.deepGreen] as const} start={{x: 0, y: 0}} end={{x: 1, y: 1}} style={styles.headerIconGradient}>
              <Ionicons name="analytics" size={20} color="#fff" />
            </LinearGradient>
          </View>
          <View style={{flex: 1}}>
            <Text style={styles.headerTitle}>Analytics</Text>
            <Text style={styles.headerSub}>{timeRangeLabel}</Text>
          </View>
          {/* Export CSV Button */}
          <TouchableOpacity
            style={styles.exportBtn}
            onPress={handleExportCSV}
            disabled={exporting || loading}
            activeOpacity={0.7}
          >
            <Ionicons
              name={exporting ? 'sync-outline' : 'download-outline'}
              size={18}
              color={exporting ? Colors.textHint : Colors.primaryGreen}
            />
            <Text style={[styles.exportText, {color: exporting ? Colors.textHint : Colors.primaryGreen}]}>
              {exporting ? '…' : 'CSV'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* ── Period bar ───────────────────────────── */}
        <View style={styles.periodBar}>
          {periods.map((p) => (
            <TouchableOpacity
              key={p.key}
              style={[styles.periodBtn, period === p.key && styles.periodBtnActive]}
              onPress={() => setPeriod(p.key)}
            >
              <Text style={[styles.periodText, period === p.key && styles.periodTextActive]}>
                {p.label}
              </Text>
            </TouchableOpacity>
          ))}

        </View>



        {/* ── Error banner ─────────────────────────── */}
        {error && (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle" size={18} color={Colors.statusRed} />
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity onPress={() => fetchHistory(period)}>
              <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Loading ──────────────────────────────── */}
        {loading && (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={Colors.primaryGreen} />
            <Text style={styles.loadingText}>Loading sensor data...</Text>
          </View>
        )}

        {/* ── Empty state (no history AND no real-time data) ── */}
        {!loading && sensorHistory.length === 0 && !latestReading && (
          <View style={styles.loadingContainer}>
            <View style={styles.emptyIcon}>
              <Ionicons name="analytics-outline" size={48} color={Colors.textHint} />
            </View>
            <Text style={styles.emptyTitle}>No Data Available</Text>
            <Text style={styles.emptyDesc}>
              No sensor readings found for this period.{'\n'}Try selecting a different time range.
            </Text>
          </View>
        )}

        {/* ── Summary Stats ────────────────────────── */}
        {!loading && stats && (
          <View style={styles.summaryRow}>
            <StatCard
              label="pH"
              icon="flask"
              color={Colors.tempBlue}
              latest={stats.ph.latest?.toFixed(1) ?? '--'}
              min={stats.ph.min?.toFixed(1) ?? '--'}
              max={stats.ph.max?.toFixed(1) ?? '--'}
              avg={stats.ph.avg?.toFixed(1) ?? '--'}
            />
            <StatCard
              label="TDS"
              icon="water"
              color={Colors.energyOrange}
              latest={stats.tds.latest?.toFixed(0) ?? '--'}
              min={stats.tds.min?.toFixed(0) ?? '--'}
              max={stats.tds.max?.toFixed(0) ?? '--'}
              avg={stats.tds.avg?.toFixed(0) ?? '--'}
              unit="ppm"
            />
            <StatCard
              label="Water"
              icon="water"
              color={Colors.waterTeal}
              latest={stats.water.latest != null ? `${Math.round(stats.water.latest)}%` : '--'}
              min={stats.water.min != null ? `${Math.round(stats.water.min)}%` : '--'}
              max={stats.water.max != null ? `${Math.round(stats.water.max)}%` : '--'}
              avg={stats.water.avg != null ? `${Math.round(stats.water.avg)}%` : '--'}
            />
          </View>
        )}

        {/* ── Charts ───────────────────────────────── */}
        {!loading && (sensorHistory.length > 0 || latestReading) && (
          <>
            <View onLayout={onChartCardLayout}>
              <ChartCard
                title="pH Level"
                icon="flask"
                color={Colors.tempBlue}
                colors={['#00897B', '#4DB6AC'] as const}
                data={pHChartData}
                latestValue={stats?.ph.latest?.toFixed(1) ?? null}
                chartWidth={chartWidth}
                minRange={1}
              />
            </View>
            <ChartCard
              title="TDS (ppm)"
              icon="water"
              color={Colors.energyOrange}
              colors={['#EF6C00', '#FFA726'] as const}
              data={tdsChartData}
              latestValue={stats?.tds.latest?.toFixed(0) ?? null}
              chartWidth={chartWidth}
              unit=" ppm"
              roundY
              minRange={50}
            />
            <ChartCard
              title="Water Level (%)"
              icon="water"
              color={Colors.waterTeal}
              colors={['#1E88E5', '#42A5F5'] as const}
              data={waterChartData}
              latestValue={stats?.water.latest != null ? `${Math.round(stats.water.latest)}%` : null}
              chartWidth={chartWidth}
              unit="%"
              roundY
              minRange={10}
            />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ──────────────────────────────────────────

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: Colors.background},
  content: {paddingBottom: 100},
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 20, paddingTop: 16, paddingBottom: 4,
  },
  headerIcon: {borderRadius: 14, overflow: 'hidden', ...Shadows.subtle},
  headerIconGradient: {width: 44, height: 44, justifyContent: 'center', alignItems: 'center'},
  headerTitle: {fontSize: 22, fontWeight: '800', color: Colors.textPrimary, letterSpacing: -0.5},
  headerSub: {fontSize: 11, color: Colors.textHint, fontWeight: '500', marginTop: 2},
  exportBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: Colors.paleGreen, paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: 12, borderWidth: 1, borderColor: Colors.primaryGreen + '30',
  },
  exportText: {fontSize: 12, fontWeight: '700'},
  periodBar: {
    flexDirection: 'row', marginHorizontal: 16, marginTop: 16, marginBottom: 8,
    backgroundColor: '#E8ECF1', borderRadius: 14, padding: 4, gap: 4,
  },
  periodBtn: {flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 12},

  periodBtnActive: {
    backgroundColor: '#FFFFFF',
    shadowColor: '#000', shadowOffset: {width: 0, height: 2},
    shadowOpacity: 0.08, shadowRadius: 8, elevation: 4,
  },
  periodText: {fontSize: 13, fontWeight: '600', color: Colors.textSecondary},
  periodTextActive: {fontWeight: '800', color: Colors.primaryGreen},
  // ── Stat Cards ──
  summaryRow: {flexDirection: 'row', gap: 8, marginHorizontal: 16, marginBottom: 16},
  statBorder: {flex: 1, padding: 1.5, borderRadius: 20},
  statInner: {
    flex: 1, backgroundColor: '#FFFFFF', borderRadius: 18,
    padding: 14, gap: 4,
  },
  statHeader: {flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4},
  statIconWrap: {width: 26, height: 26, borderRadius: 8, alignItems: 'center', justifyContent: 'center'},
  statLabel: {fontSize: 10, fontWeight: '700'},
  statLatest: {fontSize: 20, fontWeight: '900', letterSpacing: -0.5},
  statUnit: {fontSize: 10, fontWeight: '600'},
  statGrid: {flexDirection: 'row', alignItems: 'center', marginTop: 4},
  statItem: {flex: 1, alignItems: 'center'},
  statItemLabel: {fontSize: 8, color: Colors.textHint, fontWeight: '600', marginBottom: 1},
  statItemValue: {fontSize: 12, fontWeight: '800'},
  statDivider: {width: 1, height: 14, backgroundColor: '#E8ECF1'},
  // ── Chart Cards ──
  chartBorder: {padding: 2, borderRadius: 24, marginHorizontal: 16, marginBottom: 12},
  chartCard: {backgroundColor: '#FFFFFF', borderRadius: 22, padding: 20, overflow: 'hidden'},
  // ── Error ──
  errorBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    marginHorizontal: 16, marginBottom: 12,
    backgroundColor: '#FFF5F5', borderRadius: 14, padding: 14,
    borderWidth: 1, borderColor: '#FFCDD2',
  },
  errorText: {flex: 1, fontSize: 13, color: Colors.statusRed, fontWeight: '500'},
  retryText: {fontSize: 13, fontWeight: '700', color: Colors.primaryGreen},
  // ── Loading & Empty ──
  loadingContainer: {alignItems: 'center', justifyContent: 'center', paddingVertical: 48, marginHorizontal: 16},
  loadingText: {fontSize: 13, color: Colors.textHint, fontWeight: '500', marginTop: 12},
  emptyIcon: {width: 72, height: 72, borderRadius: 36, backgroundColor: '#F1F3F5', alignItems: 'center', justifyContent: 'center', marginBottom: 12},
  emptyTitle: {fontSize: 18, fontWeight: '700', color: Colors.textPrimary, marginBottom: 8},
  emptyDesc: {fontSize: 13, color: Colors.textHint, fontWeight: '500', textAlign: 'center', lineHeight: 20},
});
