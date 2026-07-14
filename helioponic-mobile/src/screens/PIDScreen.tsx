import React, {useEffect, useState, useCallback} from 'react';
import {View, Text, ScrollView, StyleSheet, Image, Alert} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import {Ionicons} from '@expo/vector-icons';
import {useSensorStore} from '../store/sensorStore';
import {useAuth} from '../context/AuthContext';
import {actuatorApi, automationApi} from '../lib/apiClient';
import {Colors, Shadows} from '../context/ThemeContext';
import {API_URL, CAMERA_POLL_MS} from '../constants';
import {SectionHeader} from '../components/SectionHeader';
import {AnimatedProgressBar} from '../components/AnimatedProgressBar';
import {PumpStateCard} from '../components/PumpStateCard';

// Water level percentage calculator
function computeWaterPct(jarakCm: number): number {
  if (jarakCm >= 999 || jarakCm < 0) return 0;
  const TANK_DEPTH_CM = 7;
  const waterDepth = TANK_DEPTH_CM - Math.min(jarakCm, TANK_DEPTH_CM);
  return Math.max(0, Math.min(100, (waterDepth / TANK_DEPTH_CM) * 100));
}

function HealthIndicator({label, status, value, threshold, color, icon}: {
  label: string; status: 'good' | 'warning' | 'critical' | 'waiting'; value: string; threshold: string; color: string; icon: string;
}) {
  const cfg = {good: {dot: Colors.statusGreen, bg: Colors.paleGreen, lbl: 'Good'}, warning: {dot: Colors.solarAmber, bg: '#FFF8E1', lbl: 'Warning'}, critical: {dot: Colors.statusRed, bg: '#FFEBEE', lbl: 'Critical'}, waiting: {dot: Colors.textHint, bg: Colors.cardBorder, lbl: 'Waiting'}}[status];
  return (
    <View style={diagStyles.healthItem}>
      <View style={[diagStyles.healthIconWrap, {backgroundColor: color + '15'}]}><Ionicons name={icon as any} size={16} color={color} /></View>
      <View style={diagStyles.healthContent}>
        <View style={diagStyles.healthTitleRow}>
          <Text style={diagStyles.healthLabel}>{label}</Text>
          <View style={[diagStyles.healthBadge, {backgroundColor: cfg.bg}]}><View style={[diagStyles.healthDot, {backgroundColor: cfg.dot}]} /><Text style={[diagStyles.healthStatusText, {color: cfg.dot}]}>{cfg.lbl}</Text></View>
        </View>
        <View style={diagStyles.healthValueRow}><Text style={diagStyles.healthValue}>{value}</Text><Text style={diagStyles.healthThreshold}>{threshold}</Text></View>
      </View>
    </View>
  );
}

export default function PIDScreen() {
  const latestReading = useSensorStore((s) => s.latestReading);
  const isConnected = useSensorStore((s) => s.isConnected);
  const setLatestReading = useSensorStore((s) => s.setLatestReading);
  const overridePumps = useSensorStore((s) => s.overridePumps);
  const setOverridePump = useSensorStore((s) => s.setOverridePump);
  const {activeDeviceId} = useAuth();
  const [cameraTick, setCameraTick] = useState(0);
  const [cameraError, setCameraError] = useState(false);

  useEffect(() => {const timer = setInterval(() => {setCameraTick((t) => t + 1); setCameraError(false);}, CAMERA_POLL_MS); return () => clearInterval(timer);}, []);

  const doToggle = useCallback(async (pump: string, s: 0 | 1) => {
    // ⚠️  Use SHARED store overridePumps — all screens see the same state
    setOverridePump(pump, s);
    try {
      await actuatorApi.controlPump(pump, s, activeDeviceId);
      // Also update latestReading immediately
      const current = useSensorStore.getState().latestReading;
      if (current) setLatestReading({...current, [pump]: s});
    } catch (err: any) {
      // Revert on failure
      setOverridePump(pump, s === 1 ? 0 : 1);
      Alert.alert('Pump Control', `Failed to toggle ${pump}: ${err?.message || 'Unknown error'}`);
    }
  }, [activeDeviceId, setLatestReading, setOverridePump]);

  const handlePumpToggle = useCallback(async (pump: string, newState: boolean) => {
    const s = (newState ? 1 : 0) as 0 | 1;
    // ── If auto-pump is ON, warn user that automation will be disabled ──
    const currentReading = useSensorStore.getState().latestReading;
    if (currentReading?.auto_enabled === true) {
      Alert.alert(
        'Automation Active',
        'Manual override will disable the Auto-Pump System. Pumps will no longer trigger automatically until you re-enable it from the Automation screen.',
        [
          {text: 'Cancel', style: 'cancel'},
          {text: 'Override & Disable Auto', style: 'destructive', onPress: async () => {
              // 1. Disable automation first
              try {
                await automationApi.update({
                  device_id: activeDeviceId,
                  auto_enabled: false,
                  rule_ph: true, rule_tds: true, rule_water: true,
                });
                // ⚡ Immediately reflect auto_enabled=false in local store
                // so the AUTO badge disappears right away (no need to wait for WebSocket)
                const storeReading = useSensorStore.getState().latestReading;
                if (storeReading) {
                  useSensorStore.getState().setLatestReading({
                    ...storeReading,
                    auto_enabled: false,
                  });
                }
              } catch { /* silent */ }
              // 2. Then toggle pump
              doToggle(pump, s);
          }},
        ],
      );
    } else {
      doToggle(pump, s);
    }
  }, [activeDeviceId, doToggle]);

  const reading = latestReading;
  const effectiveP1 = overridePumps.pompa1 ?? reading?.pompa1 ?? 0;
  const effectiveP2 = overridePumps.pompa2 ?? reading?.pompa2 ?? 0;
  return (
    <SafeAreaView style={{flex: 1, backgroundColor: Colors.background}} edges={['top']}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <View style={styles.headerIcon}><LinearGradient colors={[Colors.primaryGreen, Colors.deepGreen] as const} start={{x: 0, y: 0}} end={{x: 1, y: 1}} style={styles.headerIconGradient}><Ionicons name="information-circle" size={20} color="#fff" /></LinearGradient></View>
          <View style={{flex: 1}}><Text style={styles.headerTitle}>Diagnostics Hub</Text><Text style={styles.headerSub}>System health & calibration</Text></View>
          <View style={[styles.liveBadge, {backgroundColor: isConnected ? Colors.paleGreen : '#FFF3E0'}]}>
            <View style={[styles.liveDot, {backgroundColor: isConnected ? Colors.statusGreen : Colors.statusOrange}]} />
            <Text style={[styles.liveLabel, {color: isConnected ? Colors.deepGreen : '#BF360C'}]}>{isConnected ? 'LIVE' : 'OFF'}</Text>
          </View>
        </View>

        <View style={styles.section}>
          <SectionHeader icon="speedometer" colors={[Colors.tempBlue, '#42A5F5'] as const} title="Sensor Dashboard" badge={isConnected ? 'LIVE' : undefined} dotColor={isConnected ? Colors.statusGreen : undefined} textColor={isConnected ? Colors.deepGreen : undefined} bgColor={isConnected ? Colors.paleGreen : undefined} />
          
          {/* ── Dashboard Grid ── */}
          <View style={styles.dashGrid}>
            {/* pH Sensor */}
            <View style={[styles.dashCard, {borderTopColor: '#1976D2'}]}>
              <View style={[styles.dashIconWrap, {backgroundColor: '#1976D2' + '15'}]}>
                <Ionicons name="flask" size={20} color="#1976D2" />
              </View>
              <Text style={styles.dashLabel}>pH Level</Text>
              <Text style={[styles.dashValue, {color: '#1976D2'}]}>{reading?.current_ph?.toFixed(1) ?? '--'}</Text>
              <AnimatedProgressBar
                value={Math.min(100, ((reading?.current_ph ?? 7) / 14) * 100)}
                height={4}
                color="#1976D2"
                style={{marginTop: 8, width: '80%'}}
              />
              <Text style={styles.dashRange}>Safe: 4.0 – 8.0</Text>
              <View style={[styles.dashStatusBadge, {backgroundColor: reading && reading.current_ph >= 4 && reading.current_ph <= 8 ? '#1976D2' + '12' : '#E53935' + '12'}]}>
                <View style={[styles.dashStatusDot, {backgroundColor: reading && reading.current_ph >= 4 && reading.current_ph <= 8 ? '#1976D2' : '#E53935'}]} />
                <Text style={[styles.dashStatusText, {color: reading && reading.current_ph >= 4 && reading.current_ph <= 8 ? '#1976D2' : '#E53935'}]}>
                  {!reading ? 'Waiting' : reading.current_ph >= 4 && reading.current_ph <= 8 ? 'Good' : 'Critical'}
                </Text>
              </View>
            </View>

            {/* TDS Sensor */}
            <View style={[styles.dashCard, {borderTopColor: '#EF6C00'}]}>
              <View style={[styles.dashIconWrap, {backgroundColor: '#EF6C00' + '15'}]}>
                <Ionicons name="water" size={20} color="#EF6C00" />
              </View>
              <Text style={styles.dashLabel}>TDS</Text>
              <View style={styles.dashValueRow}>
                <Text style={[styles.dashValue, {color: '#EF6C00'}]}>{reading?.tds_value?.toFixed(0) ?? '--'}</Text>
                <Text style={styles.dashUnit}>ppm</Text>
              </View>
              <AnimatedProgressBar
                value={Math.min(100, ((reading?.tds_value ?? 0) / 2000) * 100)}
                height={4}
                color="#EF6C00"
                style={{marginTop: 8, width: '80%'}}
              />
              <Text style={styles.dashRange}>Target: 0 – 2000 ppm</Text>
              <View style={[styles.dashStatusBadge, {backgroundColor: reading && (reading.tds_value ?? 0) > 0 ? '#EF6C00' + '12' : '#E53935' + '12'}]}>
                <View style={[styles.dashStatusDot, {backgroundColor: reading && (reading.tds_value ?? 0) > 0 ? '#EF6C00' : '#E53935'}]} />
                <Text style={[styles.dashStatusText, {color: reading && (reading.tds_value ?? 0) > 0 ? '#EF6C00' : '#E53935'}]}>
                  {!reading ? 'Waiting' : (reading.tds_value ?? 0) > 0 ? 'Active' : 'No Data'}
                </Text>
              </View>
            </View>

            {/* Water Level Sensor */}
            <View style={[styles.dashCard, {borderTopColor: '#00897B'}]}>
              <View style={[styles.dashIconWrap, {backgroundColor: '#00897B' + '15'}]}>
                <Ionicons name="water" size={20} color="#00897B" />
              </View>
              <Text style={styles.dashLabel}>Water Level</Text>
              <View style={styles.dashValueRow}>
                <Text style={[styles.dashValue, {color: '#00897B'}]}>{reading ? Math.round(computeWaterPct(reading.jarak_cm)) : '--'}</Text>
                <Text style={styles.dashUnit}>%</Text>
              </View>
              <AnimatedProgressBar
                value={reading ? Math.round(computeWaterPct(reading.jarak_cm)) : 0}
                height={4}
                color="#00897B"
                style={{marginTop: 8, width: '80%'}}
              />
              <Text style={styles.dashRange}>Tank depth: 7 cm</Text>
              <View style={[styles.dashStatusBadge, {backgroundColor: reading && reading.jarak_cm < 999 && reading.jarak_cm >= 0 ? '#00897B' + '12' : '#E53935' + '12'}]}>
                <View style={[styles.dashStatusDot, {backgroundColor: reading && reading.jarak_cm < 999 && reading.jarak_cm >= 0 ? '#00897B' : '#E53935'}]} />
                <Text style={[styles.dashStatusText, {color: reading && reading.jarak_cm < 999 && reading.jarak_cm >= 0 ? '#00897B' : '#E53935'}]}>
                  {!reading ? 'Waiting' : reading.jarak_cm < 999 && reading.jarak_cm >= 0 ? 'OK' : 'Error'}
                </Text>
              </View>
            </View>
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.pumpSectionHeader}>
            <SectionHeader icon="options" colors={[Colors.accentGreen, Colors.primaryGreen] as const} title="Pump Control" />
            {reading?.auto_enabled === true && (
              <View style={[styles.pumpAutoBadge, {backgroundColor: Colors.solarYellow + '25'}]}>
                <Ionicons name="flash" size={10} color={Colors.solarAmber} />
                <Text style={styles.pumpAutoBadgeText}>AUTO</Text>
              </View>
            )}
          </View>
          <View style={styles.pumpGrid}>
            <PumpStateCard
              label="Pompa 1"
              description="Circulation & Nutrition"
              on={effectiveP1 === 1}
              color={Colors.accentGreen}
              onToggle={(v) => handlePumpToggle('pompa1', v)}
            />
            <PumpStateCard
              label="Pompa 2"
              description="pH Down / Dosing"
              on={effectiveP2 === 1}
              color={Colors.tempBlue}
              onToggle={(v) => handlePumpToggle('pompa2', v)}
            />
          </View>
          {reading?.auto_enabled === true && (
            <View style={styles.autoNoteRow}>
              <Ionicons name="information-circle" size={12} color={Colors.solarAmber} />
              <Text style={styles.autoNoteText}>Auto-pump is active — manual overrides are temporary (30s cooldown)</Text>
            </View>
          )}
        </View>

        <View style={styles.section}>
          <SectionHeader icon="pulse" colors={[Colors.primaryGreen, Colors.deepGreen] as const} title="Component Health" />
          <HealthIndicator label="pH Sensor" status={!reading ? 'waiting' : reading.current_ph >= 4 && reading.current_ph <= 8 ? 'good' : 'critical'} value={reading ? `${reading.current_ph?.toFixed(1) ?? '--'}` : 'Waiting'} threshold="Range: 4.0 - 8.0" color={Colors.tempBlue} icon="flask" />
          <HealthIndicator label="TDS Sensor" status={!reading ? 'waiting' : reading.tds_value > 0 ? 'good' : 'warning'} value={reading ? `${reading.tds_value?.toFixed(0) ?? '--'} ppm` : 'Waiting'} threshold="Target: 0 - 2000 ppm" color={Colors.energyOrange} icon="water" />
          <HealthIndicator label="Ultrasonic" status={!reading ? 'waiting' : reading.jarak_cm < 999 && reading.jarak_cm >= 0 ? 'good' : 'critical'} value={reading ? `${Math.round(computeWaterPct(reading.jarak_cm))}%` : 'Waiting'} threshold="Tank depth: 7 cm" color={Colors.waterTeal} icon="water" />
          <HealthIndicator label="Relay Pumps" status={!reading ? 'waiting' : 'good'} value={`P1:${effectiveP1 === 1 ? 'ON' : 'OFF'} / P2:${effectiveP2 === 1 ? 'ON' : 'OFF'}`} threshold="2/2 relays responding" color={Colors.accentGreen} icon="options" />
        </View>

        <View style={styles.section}>
          <SectionHeader icon="camera" colors={[Colors.primaryGreen, Colors.deepGreen] as const} title="AI Vision Feed" badge={cameraError ? 'Offline' : 'Streaming'} dotColor={cameraError ? Colors.statusRed : Colors.statusGreen} textColor={cameraError ? Colors.statusRed : Colors.deepGreen} bgColor={cameraError ? '#FFEBEE' : Colors.tempLight} />
          <View style={styles.cameraFrame}>
            <Image source={{uri: `${API_URL}/camera/live?t=${cameraTick}`}} style={styles.cameraImage} onError={() => setCameraError(true)} />
            {cameraError && (
              <View style={styles.cameraFallback}><Ionicons name="videocam-off" size={40} color={Colors.textHint} /><Text style={{fontSize: 15, fontWeight: '700', color: Colors.textPrimary}}>Camera Offline</Text><Text style={{fontSize: 11, color: Colors.textSecondary}}>Unable to connect to AI camera feed</Text></View>
            )}
          </View>
          <View style={{flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 8}}><Ionicons name="refresh" size={10} color={Colors.textHint} /><Text style={{fontSize: 10, color: Colors.textHint, flex: 1}}>Refreshing every {(CAMERA_POLL_MS / 1000).toFixed(0)}s</Text></View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const diagStyles = StyleSheet.create({
  healthItem: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 14, marginBottom: 8, backgroundColor: '#F8F9FA', borderWidth: 1, borderColor: 'rgba(0,0,0,0.04)'},
  healthIconWrap: {width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center'},
  healthContent: {flex: 1},
  healthTitleRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4},
  healthLabel: {fontSize: 13, fontWeight: '700', color: Colors.textPrimary},
  healthBadge: {flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8},
  healthDot: {width: 6, height: 6, borderRadius: 3},
  healthStatusText: {fontSize: 9, fontWeight: '800', letterSpacing: 0.5},
  healthValueRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  healthValue: {fontSize: 12, fontWeight: '600', color: Colors.textPrimary},
  healthThreshold: {fontSize: 10, color: Colors.textHint, fontWeight: '500'},
});

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: Colors.background},
  content: {paddingBottom: 100},
  header: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 4, marginBottom: 10},
  headerIcon: {borderRadius: 14, overflow: 'hidden', ...Shadows.subtle},
  headerIconGradient: {width: 44, height: 44, justifyContent: 'center', alignItems: 'center'},
  headerTitle: {fontSize: 22, fontWeight: '800', color: Colors.textPrimary, letterSpacing: -0.5},
  headerSub: {fontSize: 12, color: Colors.textSecondary, marginTop: 2},
  liveBadge: {flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10},
  liveDot: {width: 7, height: 7, borderRadius: 4},
  liveLabel: {fontSize: 10, fontWeight: '800', letterSpacing: 1},
  section: {backgroundColor: '#FFFFFF', marginHorizontal: 16, borderRadius: 24, padding: 20, marginBottom: 14, shadowColor: Colors.primaryGreen, shadowOffset: {width: 0, height: 8}, shadowOpacity: 0.1, shadowRadius: 20, elevation: 6, borderWidth: 1, borderColor: 'rgba(46,125,50,0.1)'},
  /* ─── Dashboard Grid (redesigned) ─── */
  dashGrid: {flexDirection: 'row', gap: 8, marginTop: 4},
  dashCard: {
    flex: 1, backgroundColor: '#FAFBFC', borderRadius: 16, paddingVertical: 14, paddingHorizontal: 10,
    borderTopWidth: 3, alignItems: 'center',
    shadowColor: '#000', shadowOffset: {width: 0, height: 2}, shadowOpacity: 0.04, shadowRadius: 8, elevation: 2,
  },
  dashIconWrap: {width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginBottom: 8},
  dashLabel: {fontSize: 10, color: Colors.textSecondary, fontWeight: '600', letterSpacing: 0.3, textTransform: 'uppercase', marginBottom: 4},
  dashValue: {fontSize: 22, fontWeight: '900', letterSpacing: -1},
  dashValueRow: {flexDirection: 'row', alignItems: 'baseline', gap: 2},
  dashUnit: {fontSize: 10, color: Colors.textHint, fontWeight: '600', marginLeft: 1},
  dashBarOuter: {height: 4, backgroundColor: '#E8ECF1', borderRadius: 2, overflow: 'hidden', marginTop: 8, width: '80%'},
  dashBarInner: {height: '100%', borderRadius: 2},
  dashRange: {fontSize: 8, color: Colors.textHint, fontWeight: '500', marginTop: 4},
  dashStatusBadge: {flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, marginTop: 6},
  dashStatusDot: {width: 5, height: 5, borderRadius: 2.5},
  dashStatusText: {fontSize: 8, fontWeight: '800', letterSpacing: 0.3},
  pumpSectionHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  pumpAutoBadge: {flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8},
  pumpAutoBadgeText: {fontSize: 9, fontWeight: '800', color: Colors.solarAmber, letterSpacing: 1},
  autoNoteRow: {flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: Colors.cardBorder},
  autoNoteText: {fontSize: 10, color: Colors.textHint, fontWeight: '500', flex: 1, lineHeight: 14},
  pumpGrid: {flexDirection: 'row', gap: 8},
  cameraFrame: {borderRadius: 16, overflow: 'hidden', aspectRatio: 16 / 9, backgroundColor: Colors.background, position: 'relative'},
  cameraImage: {width: '100%', height: '100%', resizeMode: 'cover'},
  cameraFallback: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: Colors.background},
});
