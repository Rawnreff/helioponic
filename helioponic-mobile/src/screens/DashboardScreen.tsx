import React, {useEffect, useState, useCallback, useMemo, useRef} from 'react';
import {View, Text, ScrollView, StyleSheet, RefreshControl, TouchableOpacity, Animated} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import {Ionicons} from '@expo/vector-icons';
import {useAuth} from '../context/AuthContext';
import {useSensorStore} from '../store/sensorStore';
import {SensorStatusCard} from '../components/SensorStatusCard';
import {PumpToggle} from '../components/PumpToggle';
import {EnergyDonutChart} from '../components/EnergyDonutChart';
import {WaterWaveWidget} from '../components/WaterWaveWidget';
import {SectionHeader} from '../components/SectionHeader';
import {energyApi, waterApi, actuatorApi} from '../lib/apiClient';
import {Colors, Shadows} from '../context/ThemeContext';

function computeWaterPct(jarakCm: number): number {
  if (jarakCm >= 400 || jarakCm <= 0) return 0;
  // Match backend WaterCalculator: tank height 30cm
  // water_level_pct = ((TANK_HEIGHT_CM - jarak_cm) / TANK_HEIGHT_CM) * 100
  const TANK_HEIGHT_CM = 30;
  const waterDepth = TANK_HEIGHT_CM - Math.min(jarakCm, TANK_HEIGHT_CM);
  return Math.max(0, Math.min(100, (waterDepth / TANK_HEIGHT_CM) * 100));
}

const EnergyWaterCards = React.memo(function EnergyWaterCards({activeDeviceId, reading}: {activeDeviceId: string; reading: any}) {
  const [energy, setEnergy] = useState<any>(null);
  const [water, setWater] = useState<any>(null);
  const fetchSummaries = useCallback(async () => {
    try {const [e, w] = await Promise.all([energyApi.summary(activeDeviceId), waterApi.summary(activeDeviceId)]); setEnergy(e); setWater(w);} catch {}
  }, [activeDeviceId]);
  useEffect(() => {fetchSummaries(); const interval = setInterval(fetchSummaries, 5000); return () => clearInterval(interval);}, [fetchSummaries]);

  return (
    <View style={styles.dualRow}>
      <View style={[styles.halfCard, {backgroundColor: Colors.solarLight}]}>
        <View style={styles.halfCardHeader}>
          <View style={[styles.miniIcon, {backgroundColor: Colors.solarYellow + '30'}]}><Ionicons name="sunny" size={14} color={Colors.solarAmber} /></View>
          <Text style={styles.halfCardTitle}>Energy</Text>
        </View>
        <View style={styles.chartContainer}>
          <EnergyDonutChart
            pompa1Wh={energy?.pompa1_wh ?? 0}
            pompa2Wh={energy?.pompa2_wh ?? 0}
            totalWh={energy?.total_wh ?? 0}
            size={110}
          />
        </View>
        <View style={styles.halfCardFooter}>
          <Text style={styles.footerLabel}>Pump 1 (Circ)</Text>
          <Text style={styles.footerValue}>{(energy?.pompa1_wh ?? 0).toFixed(3)} Wh</Text>
        </View>
      </View>
      <View style={[styles.halfCard, {backgroundColor: Colors.waterBg}]}>
        <View style={styles.halfCardHeader}>
          <View style={[styles.miniIcon, {backgroundColor: Colors.waterTeal + '25'}]}><Ionicons name="water" size={14} color={Colors.waterTeal} /></View>
          <Text style={styles.halfCardTitle}>Water</Text>
        </View>
        <View style={styles.waveContainer}>
          <WaterWaveWidget percentage={computeWaterPct(reading?.jarak_cm ?? 999)} size={100} />
        </View>
        {water && (
          <View style={styles.waterStats}>
            <View style={styles.waterStatRow}><Text style={styles.waterStatLabel}>Water Level</Text><Text style={styles.waterStatValue}>{water.water_level_pct?.toFixed(0) ?? '0'}%</Text></View>
            <View style={styles.waterStatRow}><Text style={styles.waterStatLabel}>Distance</Text><Text style={styles.waterStatValue}>{water.jarak_cm ?? 0} cm</Text></View>
          </View>
        )}
      </View>
    </View>
  );
});

export default function DashboardScreen({navigation}: any) {
  const {state, activeDeviceId, switchDevice} = useAuth();
  const latestReading = useSensorStore((s) => s.latestReading);
  const isConnected = useSensorStore((s) => s.isConnected);
  const [refreshing, setRefreshing] = useState(false);
  const [deviceDropdown, setDeviceDropdown] = useState(false);
  const [controlExpanded, setControlExpanded] = useState(false);
  const [optimisticPumps, setOptimisticPumps] = useState<Record<string, number>>({});
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {Animated.timing(fadeAnim, {toValue: 1, duration: 800, useNativeDriver: true}).start();}, []);

  const onRefresh = useCallback(async () => {setRefreshing(true); await new Promise((r) => setTimeout(r, 800)); setRefreshing(false);}, []);

  const handlePumpToggle = useCallback(async (pump: string, s: 0 | 1) => {
    setOptimisticPumps((prev) => ({...prev, [pump]: s}));
    try {await actuatorApi.controlPump(pump, s, activeDeviceId);} catch {setOptimisticPumps((prev) => ({...prev, [pump]: s === 1 ? 0 : 1}));}
  }, [activeDeviceId]);

  const reading = latestReading;
  const effectivePumps = {pompa1: optimisticPumps.pompa1 ?? reading?.pompa1 ?? 0, pompa2: optimisticPumps.pompa2 ?? reading?.pompa2 ?? 0};

  useEffect(() => {
    if (reading) setOptimisticPumps((prev) => {const merged = {...prev}; if (prev.pompa1 !== undefined && prev.pompa1 === reading.pompa1) delete merged.pompa1; if (prev.pompa2 !== undefined && prev.pompa2 === reading.pompa2) delete merged.pompa2; return merged;});
  }, [reading?.pompa1, reading?.pompa2]);

  const hour = useMemo(() => new Date().getHours(), []);
  const greeting = hour < 12 ? 'Good Morning' : hour < 17 ? 'Good Afternoon' : 'Good Evening';
  const currentTime = new Date().toLocaleTimeString('en-US', {hour: '2-digit', minute: '2-digit'});

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primaryGreen} colors={[Colors.primaryGreen]} />}>
        
        <View style={styles.heroSection}>
          <LinearGradient colors={[Colors.primaryGreen, Colors.deepGreen]} start={{x: 0, y: 0}} end={{x: 1, y: 1}} style={styles.heroGradient}>
            <View style={styles.heroDecorativeCircle1} /><View style={styles.heroDecorativeCircle2} />
            <View style={styles.heroHeaderBar}>
              <TouchableOpacity style={styles.deviceSelector} onPress={() => setDeviceDropdown(!deviceDropdown)}>
                <Ionicons name="hardware-chip" size={14} color="rgba(255,255,255,0.7)" />
                <Text style={styles.deviceText} numberOfLines={1}>{state.devices.find((d) => d.deviceId === activeDeviceId)?.name || activeDeviceId}</Text>
                <Ionicons name={deviceDropdown ? 'chevron-up' : 'chevron-down'} size={14} color="#fff" />
              </TouchableOpacity>
              <TouchableOpacity style={styles.profileBtn} onPress={() => navigation?.navigate('Profile')}><Ionicons name="person" size={18} color="#fff" /></TouchableOpacity>
            </View>
            {deviceDropdown && state.devices.length > 1 && (
              <View style={styles.dropdown}>
                {state.devices.map((d) => (
                  <TouchableOpacity key={d.deviceId} style={[styles.dropdownItem, d.deviceId === activeDeviceId && styles.dropdownItemActive]} onPress={() => {switchDevice(d.deviceId); setDeviceDropdown(false);}}>
                    <Ionicons name="hardware-chip" size={16} color={d.deviceId === activeDeviceId ? Colors.primaryGreen : Colors.textHint} />
                    <Text style={[styles.dropdownText, d.deviceId === activeDeviceId && {color: Colors.primaryGreen, fontWeight: '700'}]}>{d.name || d.deviceId}</Text>
                    {d.deviceId === activeDeviceId && <Ionicons name="checkmark-circle" size={16} color={Colors.primaryGreen} />}
                  </TouchableOpacity>
                ))}
              </View>
            )}
            <View style={styles.heroContent}>
              <View style={styles.heroGreetingContainer}>
                <View style={styles.heroGreetingBadge}><Text style={styles.heroGreeting}>{greeting}</Text></View>
                <Text style={styles.heroTime}>{currentTime}</Text>
              </View>
              <Text style={styles.heroTitle}>Helioponic{"\n"}Control</Text>
              <View style={styles.heroSubtitleContainer}>
                <View style={styles.heroIconBadge}><Ionicons name="leaf" size={16} color="#FFFFFF" /></View>
                <Text style={styles.heroSubtitle}>Smart hydroponic monitoring</Text>
              </View>
            </View>
            <View style={styles.heroBadgeRow}>
              <View style={[styles.heroBadge, {backgroundColor: isConnected ? 'rgba(102,187,106,0.3)' : 'rgba(255,112,67,0.3)'}]}>
                <View style={[styles.heroBadgeDot, {backgroundColor: isConnected ? Colors.statusGreen : Colors.statusOrange}]} />
                <Text style={styles.heroBadgeText}>{isConnected ? 'System Online' : 'Offline'}</Text>
              </View>
            </View>
          </LinearGradient>
        </View>

        <Animated.View style={[styles.mainStatusCard, {opacity: fadeAnim}]}>
          <View style={styles.mainStatusHeader}>
            <View>
              <Text style={styles.mainStatusLabel}>Nutrient Health</Text>
              <Text style={styles.mainStatusValue}>{reading ? `${reading.current_ph?.toFixed(1) ?? '--'} pH / ${reading.tds_value?.toFixed(0) ?? '--'} ppm` : 'Waiting for data...'}</Text>
            </View>
            <View style={[styles.statusBadge, {backgroundColor: isConnected ? Colors.paleGreen : '#FFF3E0'}]}>
              <View style={[styles.statusBadgeDot, {backgroundColor: isConnected ? Colors.statusGreen : Colors.statusOrange}]} />
              <Text style={[styles.statusBadgeText, {color: isConnected ? Colors.deepGreen : '#BF360C'}]}>{isConnected ? 'Active' : 'Standby'}</Text>
            </View>
          </View>
          {reading && (
            <View style={styles.progressContainer}>
              <View style={styles.progressBar}>
                <LinearGradient colors={[Colors.accentGreen, Colors.primaryGreen]} start={{x: 0, y: 0}} end={{x: 1, y: 0}} style={[styles.progressFill, {width: `${Math.min(100, ((reading.current_ph ?? 7) / 14) * 100)}%`}]} />
              </View>
              <Text style={styles.progressText}>pH {reading.current_ph?.toFixed(1) ?? '--'} — Jarak {reading.jarak_cm ?? '--'} cm</Text>
            </View>
          )}
        </Animated.View>

        <View style={styles.sensorGrid}>
          <SensorStatusCard title="pH Level" value={reading?.current_ph?.toFixed(1) ?? '--'} icon="flask" colors={['#1976D2', '#42A5F5'] as const} />
          <SensorStatusCard title="TDS" value={reading?.tds_value?.toFixed(0) ?? '--'} unit="ppm" icon="water" colors={['#EF6C00', '#FFA726'] as const} />
          <SensorStatusCard title="Distance" value={reading ? String(reading.jarak_cm) : '--'} unit="cm" icon="water-outline" colors={['#00897B', '#26A69A'] as const} />
        </View>

        <EnergyWaterCards activeDeviceId={activeDeviceId} reading={reading} />

        <View style={styles.controlsSection}>
          <TouchableOpacity style={styles.sectionHeader} onPress={() => setControlExpanded(!controlExpanded)}>
            <View style={styles.sectionTitleContainer}>
              <View style={styles.sectionIconBadge}><Ionicons name="options" size={18} color={Colors.primaryGreen} /></View>
              <Text style={styles.sectionTitle}>Quick Controls</Text>
            </View>
            <View style={styles.viewAllButton}><Ionicons name={controlExpanded ? 'chevron-up' : 'chevron-down'} size={16} color={Colors.primaryGreen} /></View>
          </TouchableOpacity>
          {controlExpanded && (
            <View style={styles.pumpsSection}>
              <Text style={styles.pumpsSectionHint}>Tap a pump to toggle ON/OFF</Text>
              <View style={styles.pumpsGrid}>
                <PumpToggle label="Pompa 1 (Circ)" icon="🔄" isActive={effectivePumps.pompa1 === 1} activeColor={Colors.accentGreen} onToggle={(v) => handlePumpToggle('pompa1', v ? 1 : 0)} />
                <PumpToggle label="Pompa 2 (pH)" icon="💧" isActive={effectivePumps.pompa2 === 1} activeColor={Colors.tempBlue} onToggle={(v) => handlePumpToggle('pompa2', v ? 1 : 0)} />
              </View>
            </View>
          )}
        </View>

        <View style={styles.activitySection}>
          <SectionHeader icon="time-outline" colors={[Colors.accentGreen, Colors.primaryGreen] as const} title="Recent Activity" />
          <TouchableOpacity activeOpacity={0.7} style={styles.activityItem} onPress={() => navigation?.navigate('PID')}>
            <View style={styles.activityIcon}><LinearGradient colors={[Colors.accentGreen, Colors.primaryGreen] as const} start={{x: 0, y: 0}} end={{x: 1, y: 1}} style={styles.activityIconGradient}><Ionicons name="leaf" size={16} color="#FFF" /></LinearGradient></View>
            <View style={styles.activityContent}>
              <View style={styles.activityTitleRow}><Text style={styles.activityTitle}>{isConnected ? 'System monitoring active' : 'System offline'}</Text><View style={[styles.activityStatusBadge, {backgroundColor: (isConnected ? Colors.statusGreen : Colors.statusOrange) + '20'}]}><View style={[styles.activityStatusDot, {backgroundColor: isConnected ? Colors.statusGreen : Colors.statusOrange}]} /></View></View>
              <View style={styles.activityTimeRow}><Ionicons name="time-outline" size={12} color="#8F9BB3" /><Text style={styles.activityTime}>{reading?.ts ? new Date(reading.ts * 1000).toLocaleTimeString() : 'Just now'}</Text></View>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#B0B8C5" />
          </TouchableOpacity>
          <TouchableOpacity activeOpacity={0.7} style={styles.activityItem} onPress={() => navigation?.navigate('PID')}>
            <View style={styles.activityIcon}><LinearGradient colors={[Colors.tempBlue, '#42A5F5'] as const} start={{x: 0, y: 0}} end={{x: 1, y: 1}} style={styles.activityIconGradient}><Ionicons name="flask" size={16} color="#FFF" /></LinearGradient></View>
            <View style={styles.activityContent}>
              <View style={styles.activityTitleRow}><Text style={styles.activityTitle}>{reading ? `pH ${reading.current_ph?.toFixed(1) ?? '--'} | TDS ${reading.tds_value?.toFixed(0) ?? '--'} ppm` : 'Waiting for sensor data'}</Text><View style={[styles.activityStatusBadge, {backgroundColor: Colors.tempBlue + '20'}]}><View style={[styles.activityStatusDot, {backgroundColor: Colors.tempBlue}]} /></View></View>
              <View style={styles.activityTimeRow}><Ionicons name="time-outline" size={12} color="#8F9BB3" /><Text style={styles.activityTime}>{reading?.ts ? new Date(reading.ts * 1000).toLocaleTimeString() : 'Recently'}</Text></View>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#B0B8C5" />
          </TouchableOpacity>
          <TouchableOpacity activeOpacity={0.7} style={styles.activityItem} onPress={() => navigation?.navigate('Analytics')}>
            <View style={styles.activityIcon}><LinearGradient colors={[Colors.waterTeal, Colors.waterLight] as const} start={{x: 0, y: 0}} end={{x: 1, y: 1}} style={styles.activityIconGradient}><Ionicons name="water" size={16} color="#FFF" /></LinearGradient></View>
            <View style={styles.activityContent}>
              <View style={styles.activityTitleRow}><Text style={styles.activityTitle}>Distance {reading?.jarak_cm ?? '--'}cm</Text><View style={[styles.activityStatusBadge, {backgroundColor: Colors.waterTeal + '20'}]}><View style={[styles.activityStatusDot, {backgroundColor: Colors.waterTeal}]} /></View></View>
              <View style={styles.activityTimeRow}><Ionicons name="time-outline" size={12} color="#8F9BB3" /><Text style={styles.activityTime}>{reading?.ts ? new Date(reading.ts * 1000).toLocaleTimeString() : 'Recently'}</Text></View>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#B0B8C5" />
          </TouchableOpacity>
        </View>

        <View style={styles.lastUpdateContainer}>
          <View style={[styles.updateDot, {backgroundColor: isConnected ? Colors.statusGreen : Colors.statusOrange}]} />
          <Text style={styles.lastUpdateText}>Last synced: {reading?.ts ? new Date(reading.ts * 1000).toLocaleTimeString() : 'Just now'}</Text>
        </View>
        <View style={{height: 100}} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {flex: 1, backgroundColor: Colors.primaryGreen},
  container: {flex: 1, backgroundColor: '#F8F9FA'},
  content: {paddingBottom: 32},
  heroSection: {marginHorizontal: 16, marginTop: 8, marginBottom: 24, borderRadius: 28, overflow: 'hidden', shadowColor: Colors.primaryGreen, shadowOffset: {width: 0, height: 12}, shadowOpacity: 0.4, shadowRadius: 24, elevation: 12},
  heroGradient: {padding: 20, paddingTop: 12, paddingBottom: 28, position: 'relative'},
  heroDecorativeCircle1: {position: 'absolute', width: 200, height: 200, borderRadius: 100, backgroundColor: 'rgba(255,255,255,0.1)', top: -80, right: -60},
  heroDecorativeCircle2: {position: 'absolute', width: 120, height: 120, borderRadius: 60, backgroundColor: 'rgba(255,255,255,0.08)', bottom: -40, left: -30},
  heroHeaderBar: {flexDirection: 'row', alignItems: 'center', gap: 10, zIndex: 10},
  deviceSelector: {flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8},
  deviceText: {color: '#fff', fontSize: 13, fontWeight: '600', flex: 1},
  profileBtn: {width: 34, height: 34, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.2)', alignItems: 'center', justifyContent: 'center'},
  dropdown: {backgroundColor: Colors.surface, borderRadius: 16, padding: 4, marginTop: 4, ...Shadows.card, zIndex: 20},
  dropdownItem: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 12},
  dropdownItemActive: {backgroundColor: Colors.paleGreen},
  dropdownText: {fontSize: 14, fontWeight: '500', color: Colors.textPrimary, flex: 1},
  heroContent: {position: 'relative', zIndex: 1, marginTop: 8},
  heroGreetingContainer: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12},
  heroGreetingBadge: {backgroundColor: 'rgba(255,255,255,0.2)', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)'},
  heroGreeting: {fontSize: 13, color: '#FFFFFF', fontWeight: '700', letterSpacing: 0.5},
  heroTime: {fontSize: 13, color: 'rgba(255,255,255,0.9)', fontWeight: '600', letterSpacing: 1},
  heroTitle: {fontSize: 34, fontWeight: '900', color: '#FFFFFF', marginBottom: 12, letterSpacing: -1.5, lineHeight: 40},
  heroSubtitleContainer: {flexDirection: 'row', alignItems: 'center', gap: 8},
  heroIconBadge: {width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.2)', justifyContent: 'center', alignItems: 'center'},
  heroSubtitle: {fontSize: 15, color: 'rgba(255,255,255,0.95)', fontWeight: '600', letterSpacing: 0.3},
  heroBadgeRow: {flexDirection: 'row', gap: 8, marginTop: 16},
  heroBadge: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16},
  heroBadgeDot: {width: 6, height: 6, borderRadius: 3},
  heroBadgeText: {fontSize: 11, fontWeight: '700', color: '#fff', letterSpacing: 0.3},
  mainStatusCard: {backgroundColor: '#FFFFFF', marginHorizontal: 16, borderRadius: 24, padding: 24, marginBottom: 24, shadowColor: Colors.primaryGreen, shadowOffset: {width: 0, height: 8}, shadowOpacity: 0.15, shadowRadius: 24, elevation: 8},
  mainStatusHeader: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20},
  mainStatusLabel: {fontSize: 14, color: '#8F9BB3', fontWeight: '600', marginBottom: 6, letterSpacing: 0.3},
  mainStatusValue: {fontSize: 18, fontWeight: '800', color: '#2E3A59', letterSpacing: -0.3},
  statusBadge: {flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20},
  statusBadgeDot: {width: 8, height: 8, borderRadius: 4, marginRight: 6},
  statusBadgeText: {fontSize: 12, fontWeight: '700'},
  progressContainer: {marginBottom: 4},
  progressBar: {height: 8, backgroundColor: '#F1F3F5', borderRadius: 4, overflow: 'hidden', marginBottom: 8},
  progressFill: {height: '100%', borderRadius: 4},
  progressText: {fontSize: 12, color: '#8F9BB3', fontWeight: '600'},
  sensorGrid: {flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 16, marginBottom: 20, gap: 12},
  dualRow: {flexDirection: 'row', gap: 12, marginHorizontal: 16, marginBottom: 16},
  halfCard: {flex: 1, padding: 16, borderRadius: 24, ...Shadows.card},
  halfCardHeader: {flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12},
  miniIcon: {padding: 8, borderRadius: 10},
  halfCardTitle: {fontSize: 14, fontWeight: '700', color: Colors.textPrimary},
  chartContainer: {alignItems: 'center', marginVertical: 4},
  halfCardFooter: {flexDirection: 'row', justifyContent: 'space-between', marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: Colors.cardBorder},
  footerLabel: {fontSize: 10, fontWeight: '500', color: Colors.textSecondary},
  footerValue: {fontSize: 11, fontWeight: '700', color: Colors.textPrimary},
  waveContainer: {alignItems: 'center', marginVertical: 8},
  waterStats: {marginTop: 8, gap: 4, paddingTop: 8, borderTopWidth: 1, borderTopColor: Colors.cardBorder},
  waterStatRow: {flexDirection: 'row', justifyContent: 'space-between'},
  waterStatLabel: {fontSize: 10, color: Colors.textSecondary, fontWeight: '500'},
  waterStatValue: {fontSize: 11, fontWeight: '700', color: Colors.textPrimary},
  controlsSection: {backgroundColor: '#FFFFFF', marginHorizontal: 16, borderRadius: 24, padding: 20, marginBottom: 16, shadowColor: Colors.primaryGreen, shadowOffset: {width: 0, height: 8}, shadowOpacity: 0.1, shadowRadius: 20, elevation: 6, borderWidth: 1, borderColor: 'rgba(46,125,50,0.1)'},
  sectionHeader: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
  sectionTitleContainer: {flexDirection: 'row', alignItems: 'center', gap: 10},
  sectionIconBadge: {width: 32, height: 32, borderRadius: 16, backgroundColor: Colors.paleGreen, justifyContent: 'center', alignItems: 'center'},
  sectionTitle: {fontSize: 17, fontWeight: '800', color: '#2E3A59', letterSpacing: -0.3},
  viewAllButton: {flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: Colors.paleGreen, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 16},
  pumpsSection: {marginTop: 16},
  pumpsSectionHint: {fontSize: 10, color: Colors.textHint, fontWeight: '500', marginBottom: 12},
  pumpsGrid: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  activitySection: {backgroundColor: '#FFFFFF', marginHorizontal: 16, borderRadius: 24, padding: 20, marginBottom: 16, shadowColor: Colors.primaryGreen, shadowOffset: {width: 0, height: 8}, shadowOpacity: 0.1, shadowRadius: 20, elevation: 6, borderWidth: 1, borderColor: 'rgba(46,125,50,0.1)'},
  activityItem: {flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 12, borderRadius: 16, marginBottom: 8, backgroundColor: '#F8F9FA', borderWidth: 1, borderColor: 'rgba(0,0,0,0.05)'},
  activityIcon: {width: 40, height: 40, borderRadius: 20, overflow: 'hidden', shadowColor: '#000', shadowOffset: {width: 0, height: 4}, shadowOpacity: 0.15, shadowRadius: 8, elevation: 4},
  activityIconGradient: {width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center'},
  activityContent: {flex: 1, marginLeft: 12},
  activityTitleRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4},
  activityTitle: {fontSize: 13, fontWeight: '700', color: '#2E3A59', letterSpacing: -0.2, flex: 1},
  activityStatusBadge: {width: 22, height: 22, borderRadius: 11, justifyContent: 'center', alignItems: 'center', marginLeft: 8},
  activityStatusDot: {width: 8, height: 8, borderRadius: 4},
  activityTimeRow: {flexDirection: 'row', alignItems: 'center', gap: 4},
  activityTime: {fontSize: 12, color: '#8F9BB3', fontWeight: '600', letterSpacing: 0.2},
  lastUpdateContainer: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 16, marginHorizontal: 16},
  updateDot: {width: 6, height: 6, borderRadius: 3, marginRight: 8},
  lastUpdateText: {fontSize: 13, color: '#8F9BB3', fontWeight: '600'},
});
