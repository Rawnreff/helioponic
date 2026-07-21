import React, {useEffect, useState, useCallback, useMemo, useRef} from 'react';
import {View, Text, ScrollView, StyleSheet, RefreshControl, TouchableOpacity, Animated, Alert, Image} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import {Ionicons} from '@expo/vector-icons';
import {useAuth} from '../context/AuthContext';
import {useSensorStore} from '../store/sensorStore';
import {SensorStatusCard} from '../components/SensorStatusCard';
import {WaterWaveWidget} from '../components/WaterWaveWidget';
import {AnimatedProgressBar} from '../components/AnimatedProgressBar';
import {SectionHeader} from '../components/SectionHeader';
import {waterApi, actuatorApi, notificationsApi, automationApi, sensorsApi} from '../lib/apiClient';
import {Colors, Shadows} from '../context/ThemeContext';
import {useNotificationStore} from '../store/notificationStore';
import {useNightModeStore} from '../store/nightModeStore';
import {nightModeApi} from '../lib/apiClient';
import {DASHBOARD_POLL_MS, API_URL, CAMERA_POLL_MS} from '../constants';

function formatRelativeTime(ts: number): string {
  const now = Date.now() / 1000;
  const diff = now - ts;
  if (diff < 60) return 'Just now';
  if (diff < 120) return '1m ago';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 7200) return '1h ago';
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(ts * 1000).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
}

function computeWaterPct(jarakCm: number, tankDepthCm?: number, wsPct?: number): number {
  // Prefer WebSocket-computed value from backend (single source of truth)
  if (wsPct !== undefined && wsPct !== null && wsPct >= 0 && wsPct <= 100) return wsPct;
  // Fallback: local computation with dynamic tank depth (default 32cm)
  if (jarakCm >= 999 || jarakCm < 0) return 0;
  const depth = tankDepthCm || 32;
  const waterDepth = depth - Math.min(jarakCm, depth);
  return Math.max(0, Math.min(100, (waterDepth / depth) * 100));
}

function getWaterStatus(pct: number): {label: string; color: string; icon: string} {
  if (pct >= 80) return {label: 'Optimal', color: Colors.accentGreen, icon: 'checkmark-circle'};
  if (pct >= 40) return {label: 'Normal', color: Colors.waterTeal, icon: 'water'};
  if (pct >= 15) return {label: 'Low', color: Colors.solarAmber, icon: 'alert-circle'};
  return {label: 'Critical', color: Colors.statusRed, icon: 'warning'};
}

// ── Nutrient Health Assessment (hydroponics-accurate) ────────────

/** Ideal pH range for most hydroponic crops */
const PH_IDEAL_MIN = 5.5;
const PH_IDEAL_MAX = 6.5;
const PH_SAFE_MIN = 4.0;
const PH_SAFE_MAX = 8.0;

function getPhHealth(ph: number | undefined): {
  label: string; color: string; barValue: number; barColor: string;
} {
  if (ph == null || ph <= 0 || ph > 14) {
    return {label: '--', color: Colors.textHint, barValue: 0, barColor: '#E0E4E8'};
  }
  const barValue = Math.max(0, Math.min(100, (ph / 14) * 100));
  if (ph >= PH_IDEAL_MIN && ph <= PH_IDEAL_MAX) {
    return {label: 'Optimal', color: Colors.accentGreen, barValue, barColor: Colors.accentGreen};
  }
  if (ph >= PH_SAFE_MIN && ph <= PH_SAFE_MAX) {
    return {label: 'Warning', color: Colors.solarAmber, barValue, barColor: Colors.solarAmber};
  }
  return {label: 'Critical', color: Colors.statusRed, barValue, barColor: Colors.statusRed};
}

function getTdsHealth(tds: number | undefined): {
  label: string; color: string; barValue: number; barColor: string;
} {
  if (tds == null || tds <= 0) {
    return {label: '--', color: Colors.textHint, barValue: 0, barColor: '#E0E4E8'};
  }
  // Scale TDS up to 500ppm for bar visualization
  const maxTds = 500;
  const barValue = Math.max(0, Math.min(100, (tds / maxTds) * 100));
  if (tds > 100) {
    return {label: 'Sufficient', color: Colors.accentGreen, barValue, barColor: Colors.accentGreen};
  }
  if (tds > 50) {
    return {label: 'Low', color: Colors.solarAmber, barValue, barColor: Colors.solarAmber};
  }
  return {label: 'Critical', color: Colors.statusRed, barValue, barColor: Colors.statusRed};
}

type HealthLevel = 'Optimal' | 'Warning' | 'Critical';

function assessNutrientHealth(ph: number | undefined, tds: number | undefined): {
  level: HealthLevel; color: string; message: string;
} {
  const phOk = ph != null && ph > 0 && ph >= PH_IDEAL_MIN && ph <= PH_IDEAL_MAX;
  const tdsOk = tds != null && tds > 100;
  if (phOk && tdsOk) {
    return {level: 'Optimal', color: Colors.accentGreen, message: 'All nutrients in optimal range'};
  }
  if (!phOk && !tdsOk) {
    return {level: 'Critical', color: Colors.statusRed, message: 'pH & nutrients need immediate attention'};
  }
  return {level: 'Warning', color: Colors.solarAmber, message: 'Some parameters need adjustment'};
}

const WaterCard = React.memo(function WaterCard({reading}: {reading: any}) {
  const pct = reading ? computeWaterPct(reading.jarak_cm, reading.tank_depth_cm, reading.water_level_pct) : 0;
  const status = getWaterStatus(pct);
  return (
    <View style={styles.waterFullCard}>
      {/* Top accent bar */}
      <LinearGradient colors={[Colors.waterTeal, Colors.waterLight]} start={{x: 0, y: 0}} end={{x: 1, y: 0}} style={styles.waterAccentBar} />
      
      {/* Header row */}
      <View style={styles.halfCardHeader}>
        <View style={[styles.waterIconWrap, {backgroundColor: Colors.waterTeal + '18'}]}>
          <Ionicons name="water" size={18} color={Colors.waterTeal} />
        </View>
        <View style={{flex: 1}}>
          <Text style={styles.waterCardTitle}>Water Level</Text>
          <Text style={styles.waterCardSub}>Ultrasonic tank monitoring</Text>
        </View>
        <View style={[styles.waterStatusBadge, {backgroundColor: status.color + '18'}]}>
          <Ionicons name={status.icon as any} size={11} color={status.color} />
          <Text style={[styles.waterStatusText, {color: status.color}]}>{status.label}</Text>
        </View>
      </View>

      {/* Wave widget + percentage */}
      <View style={styles.waveContainer}>
        <WaterWaveWidget percentage={pct / 100} size={130} />
      </View>

      {/* Stats grid */}
      <View style={styles.waterStatsGrid}>
        <View style={[styles.waterStatItem, {backgroundColor: Colors.waterBg}]}>
          <View style={styles.waterStatIconWrap}><Ionicons name="resize" size={12} color={Colors.waterTeal} /></View>
          <View>
            <Text style={styles.waterStatLabel}>Tank Depth</Text>
            <Text style={styles.waterStatValue}>7 cm</Text>
          </View>
        </View>
        <View style={[styles.waterStatItem, {backgroundColor: Colors.waterBg}]}>
          <View style={styles.waterStatIconWrap}><Ionicons name="speedometer" size={12} color={Colors.waterTeal} /></View>
          <View>
            <Text style={styles.waterStatLabel}>Distance</Text>
            <Text style={styles.waterStatValue}>{reading ? `${reading.jarak_cm.toFixed(1)} cm` : '--'}</Text>
          </View>
        </View>
        <View style={[styles.waterStatItem, {backgroundColor: status.color + '12'}]}>
          <View style={[styles.waterStatIconWrap, {backgroundColor: status.color + '20'}]}><Ionicons name="water" size={12} color={status.color} /></View>
          <View>
            <Text style={styles.waterStatLabel}>Fill Level</Text>
            <Text style={[styles.waterStatValue, {color: status.color}]}>{reading ? `${Math.round(pct)}%` : '--'}</Text>
          </View>
        </View>
      </View>

      {/* Mini water level bar */}
      <AnimatedProgressBar
        value={pct}
        height={4}
        color={pct > 15 ? (pct > 40 ? Colors.waterTeal : Colors.solarAmber) : Colors.statusRed}
        style={{marginHorizontal: 16, marginBottom: 16}}
      />
    </View>
  );
});

// ── Dashboard compact pump card (dedicated for 2-column grid) ──
const DashboardPumpCard = React.memo(function DashboardPumpCard({label, on, color, onToggle}: {
  label: string;
  on: boolean;
  color: string;
  onToggle: (v: boolean) => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.dashPumpCard, on && {borderColor: color + '30'}]}
      onPress={() => onToggle(!on)}
      activeOpacity={0.75}
    >
      <LinearGradient
        colors={on ? ([color, color + '80'] as const) : (['#D0D5DD', '#E0E4E8'] as const)}
        start={{x: 0, y: 0}} end={{x: 1, y: 0}}
        style={styles.dashPumpAccent}
      />
      <View style={[styles.dashPumpBody, {backgroundColor: on ? '#FFFFFF' : '#F8F9FA'}]}>
        <Ionicons
          name={on ? 'flash' : 'flash-outline'}
          size={14}
          color={on ? color : '#B0B8C5'}
          style={{marginRight: 6}}
        />
        <Text style={[styles.dashPumpText, {color: on ? color : Colors.textPrimary}]} numberOfLines={1}>
          {label}
        </Text>
        <View style={[styles.dashPumpBtn, {backgroundColor: on ? color : '#E8ECF1'}]}>
          <Ionicons
            name={on ? 'power' : 'power-outline'}
            size={10}
            color={on ? '#FFFFFF' : '#B0B8C5'}
          />
        </View>
      </View>
    </TouchableOpacity>
  );
});

export default function DashboardScreen({navigation}: any) {
  const {state, activeDeviceId} = useAuth();
  const latestReading = useSensorStore((s) => s.latestReading);
  const isConnected = useSensorStore((s) => s.isConnected);
  const setLatestReading = useSensorStore((s) => s.setLatestReading);
  const overridePumps = useSensorStore((s) => s.overridePumps);
  const setOverridePump = useSensorStore((s) => s.setOverridePump);
  const [refreshing, setRefreshing] = useState(false);
  const [controlExpanded, setControlExpanded] = useState(false);
  const [cameraTick, setCameraTick] = useState(0);
  const [cameraError, setCameraError] = useState(false);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const setUnreadCount = useNotificationStore((s) => s.setUnreadCount);
  const nightModeActive = useNightModeStore((s) => s.active);
  const setNightStatus = useNightModeStore((s) => s.setStatus);

  useEffect(() => {
    Animated.timing(fadeAnim, {toValue: 1, duration: 800, useNativeDriver: true}).start();
  }, []);

  // Camera poll timer (AI Vision Feed)
  useEffect(() => {
    const timer = setInterval(() => {setCameraTick((t) => t + 1); setCameraError(false);}, CAMERA_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  // Fetch latest sensor reading via REST (fallback if WebSocket delayed/disconnected)
  useEffect(() => {
    const fetchLatestReading = async () => {
      try {
        // Only fetch via REST if store has NO data OR WebSocket is disconnected
        // (avoids overwriting real-time WebSocket updates)
        const current = useSensorStore.getState().latestReading;
        const connected = useSensorStore.getState().isConnected;
        if (current && connected) return;

        const res = await sensorsApi.latest(activeDeviceId);
        if (res && 'jarak_cm' in res) {
          useSensorStore.getState().setLatestReading({
            device_id: res.device_id,
            ts: res.recorded_at ? new Date(res.recorded_at).getTime() / 1000 : 0,
            jarak_cm: res.jarak_cm,
            tds_value: res.tds_value,
            current_ph: res.current_ph,
            pompa1: res.pompa1,
            pompa2: res.pompa2,
            pompa3: res.pompa3,
            pompa4: res.pompa4,
            auto_enabled: current?.auto_enabled ?? true,
            night_mode: current?.night_mode ?? false,
          });
        }
      } catch (err) {
        // Silently fail — WebSocket will provide data when connected
      }
    };
    // Fetch immediately on mount + poll periodically
    fetchLatestReading();
    const interval = setInterval(fetchLatestReading, DASHBOARD_POLL_MS);
    return () => clearInterval(interval);
  }, [activeDeviceId]);

  // Fetch notification unread count + night mode status periodically
  useEffect(() => {
    const fetchStatuses = async () => {
      try {
        const [notifCountRes, nmStatus] = await Promise.all([
          notificationsApi.unreadCount(activeDeviceId),
          nightModeApi.status(activeDeviceId),
        ]);
        setUnreadCount(notifCountRes.unread_count);
        setNightStatus(nmStatus);
      } catch (err) { console.warn('[Dashboard] status fetch failed:', (err as any)?.message || err) }
    };
    fetchStatuses();
    const interval = setInterval(fetchStatuses, 30000);
    return () => clearInterval(interval);
  }, [activeDeviceId, setUnreadCount, setNightStatus]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await new Promise((r) => setTimeout(r, 800));
    setRefreshing(false);
  }, []);

  // ── doToggle (the actual pump toggle logic) must be defined BEFORE handlePumpToggle ──
  const doToggle = useCallback(async (pump: string, s: 0 | 1) => {
    // ⚠️  Use SHARED store overridePumps — all screens see the same state
    setOverridePump(pump, s);
    
    try {
      await actuatorApi.controlPump(pump, s, activeDeviceId);
      // Also update latestReading immediately so UI is responsive
      const current = useSensorStore.getState().latestReading;
      if (current) setLatestReading({...current, [pump]: s});
    } catch (err) {
      console.warn('[Dashboard] pump toggle failed:', (err as any)?.message || err);
      // Revert: toggle back
      setOverridePump(pump, s === 1 ? 0 : 1);
    }
  }, [activeDeviceId, setLatestReading, setOverridePump]);

  const handleABMixToggle = useCallback(async (s: 0 | 1) => {
    // Toggle BOTH Pompa 3 & Pompa 4 simultaneously (tandem AB mix)
    const currentReading = useSensorStore.getState().latestReading;
    if (currentReading?.auto_enabled === true) {
      return new Promise<void>((resolve) => {
        Alert.alert(
          'Automation Active',
          'Manual override will disable the Auto-Pump System. Pumps will no longer trigger automatically until you re-enable it from the Automation screen.',
          [
            {text: 'Cancel', style: 'cancel', onPress: () => resolve()},
            {text: 'Override & Disable Auto', style: 'destructive', onPress: async () => {
                try {
                  await automationApi.update({
                    device_id: activeDeviceId,
                    auto_enabled: false,
                    rule_ph: true, rule_tds: true, rule_water: true,
                  });
                  const storeReading = useSensorStore.getState().latestReading;
                  if (storeReading) {
                    useSensorStore.getState().setLatestReading({...storeReading, auto_enabled: false});
                  }
                } catch { /* silent */ }
                // Toggle both pumps
                setOverridePump('pompa3', s);
                setOverridePump('pompa4', s);
                try {
                  await Promise.all([
                    actuatorApi.controlPump('pompa3', s, activeDeviceId),
                    actuatorApi.controlPump('pompa4', s, activeDeviceId),
                  ]);
                  const store = useSensorStore.getState().latestReading;
                  if (store) setLatestReading({...store, pompa3: s, pompa4: s});
                } catch (err) {
                  console.warn('[Dashboard] AB mix toggle failed:', (err as any)?.message || err);
                  setOverridePump('pompa3', s === 1 ? 0 : 1);
                  setOverridePump('pompa4', s === 1 ? 0 : 1);
                }
                resolve();
            }},
          ],
        );
      });
    } else {
      setOverridePump('pompa3', s);
      setOverridePump('pompa4', s);
      try {
        await Promise.all([
          actuatorApi.controlPump('pompa3', s, activeDeviceId),
          actuatorApi.controlPump('pompa4', s, activeDeviceId),
        ]);
        const current = useSensorStore.getState().latestReading;
        if (current) setLatestReading({...current, pompa3: s, pompa4: s});
      } catch (err) {
        console.warn('[Dashboard] AB mix toggle failed:', (err as any)?.message || err);
        setOverridePump('pompa3', s === 1 ? 0 : 1);
        setOverridePump('pompa4', s === 1 ? 0 : 1);
      }
    }
  }, [activeDeviceId, setLatestReading, setOverridePump]);

  const handlePumpToggle = useCallback(async (pump: string, s: 0 | 1) => {
    // ── If auto-pump is ON, warn user that automation will be disabled ──
    const currentReading = useSensorStore.getState().latestReading;
    if (currentReading?.auto_enabled === true) {
      return new Promise<void>((resolve) => {
        Alert.alert(
          'Automation Active',
          'Manual override will disable the Auto-Pump System. Pumps will no longer trigger automatically until you re-enable it from the Automation screen.',
          [
            {text: 'Cancel', style: 'cancel', onPress: () => resolve()},
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
                resolve();
            }},
          ],
        );
      });
    } else {
      doToggle(pump, s);
    }
  }, [activeDeviceId, doToggle]);

  const reading = latestReading;
  const effectivePumps = {
    pompa1: overridePumps.pompa1 ?? reading?.pompa1 ?? 0,
    pompa2: overridePumps.pompa2 ?? reading?.pompa2 ?? 0,
    pompa3: overridePumps.pompa3 ?? reading?.pompa3 ?? 0,
    pompa4: overridePumps.pompa4 ?? reading?.pompa4 ?? 0,
  };

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
              <View style={styles.deviceSelector}>
                <Ionicons name="hardware-chip" size={14} color="rgba(255,255,255,0.7)" />
                <Text style={styles.deviceText} numberOfLines={1}>{state.devices.find((d) => d.deviceId === activeDeviceId)?.name || activeDeviceId}</Text>
              </View>
              <TouchableOpacity
                  style={styles.notifBtn}
                  onPress={() => navigation?.navigate('Notifications')}
                >
                  <Ionicons name="notifications-outline" size={18} color="#fff" />
                  {unreadCount > 0 && (
                    <View style={styles.notifBadge}>
                      <Text style={styles.notifBadgeText}>
                        {unreadCount > 99 ? '99+' : unreadCount}
                      </Text>
                    </View>
                  )}
                </TouchableOpacity>
                <TouchableOpacity style={styles.profileBtn} onPress={() => navigation?.navigate('Profile')}><Ionicons name="person" size={18} color="#fff" /></TouchableOpacity>
            </View>

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
              {nightModeActive && (
                <View style={[styles.heroBadge, {backgroundColor: 'rgba(55,71,79,0.4)'}]}>
                  <Ionicons name="moon" size={12} color="#fff" />
                  <Text style={styles.heroBadgeText}>Night Mode</Text>
                </View>
              )}
            </View>
          </LinearGradient>
        </View>

        <Animated.View style={[styles.mainStatusCard, {opacity: fadeAnim}]}>
          <View style={styles.mainStatusHeader}>
            <View style={{flexDirection: 'row', alignItems: 'center', gap: 10}}>
              <View style={[styles.nutrientIconWrap, {backgroundColor: Colors.primaryGreen + '15'}]}>
                <Ionicons name="leaf" size={18} color={Colors.primaryGreen} />
              </View>
              <View>
                <Text style={styles.mainStatusLabel}>Nutrient Health</Text>
                {reading ? (() => {
                  const health = assessNutrientHealth(reading.current_ph, reading.tds_value);
                  return (
                    <View style={[styles.nutrientBadge, {backgroundColor: health.color + '15'}]}>
                      <View style={[styles.nutrientBadgeDot, {backgroundColor: health.color}]} />
                      <Text style={[styles.nutrientBadgeText, {color: health.color}]}>{health.level}</Text>
                    </View>
                  );
                })() : (
                  <Text style={styles.mainStatusSub}>Waiting for sensor data...</Text>
                )}
              </View>
            </View>
            <View style={[styles.statusBadge, {backgroundColor: isConnected ? Colors.paleGreen : '#FFF3E0'}]}>
              <View style={[styles.statusBadgeDot, {backgroundColor: isConnected ? Colors.statusGreen : Colors.statusOrange}]} />
              <Text style={[styles.statusBadgeText, {color: isConnected ? Colors.deepGreen : '#BF360C'}]}>{isConnected ? 'Active' : 'Standby'}</Text>
            </View>
          </View>

          {reading && (
            <View style={styles.nutrientParams}>
              {/* ── pH Row ── */}
              {(() => {
                const ph = getPhHealth(reading.current_ph);
                return (
                  <View style={styles.nutrientRow}>
                    <View style={styles.nutrientRowHeader}>
                      <View style={{flexDirection: 'row', alignItems: 'center', gap: 6}}>
                        <Ionicons name="flask" size={14} color={ph.color} />
                        <Text style={styles.nutrientParamLabel}>pH</Text>
                        <Text style={[styles.nutrientParamValue, {color: ph.color}]}>{reading.current_ph?.toFixed(1) ?? '--'}</Text>
                      </View>
                      <Text style={[styles.nutrientParamStatus, {color: ph.color}]}>{ph.label}</Text>
                    </View>
                    <AnimatedProgressBar
                      value={ph.barValue}
                      height={5}
                      color={ph.barColor}
                      backgroundColor="#F0F2F5"
                      borderRadius={3}
                    />
                    <Text style={styles.nutrientRangeText}>Ideal: {PH_IDEAL_MIN} – {PH_IDEAL_MAX}</Text>
                  </View>
                );
              })()}

              {/* ── TDS Row ── */}
              {(() => {
                const tds = getTdsHealth(reading.tds_value);
                return (
                  <View style={styles.nutrientRow}>
                    <View style={styles.nutrientRowHeader}>
                      <View style={{flexDirection: 'row', alignItems: 'center', gap: 6}}>
                        <Ionicons name="water" size={14} color={tds.color} />
                        <Text style={styles.nutrientParamLabel}>TDS</Text>
                        <Text style={[styles.nutrientParamValue, {color: tds.color}]}>{reading.tds_value?.toFixed(0) ?? '--'} ppm</Text>
                      </View>
                      <Text style={[styles.nutrientParamStatus, {color: tds.color}]}>{tds.label}</Text>
                    </View>
                    <AnimatedProgressBar
                      value={tds.barValue}
                      height={5}
                      color={tds.barColor}
                      backgroundColor="#F0F2F5"
                      borderRadius={3}
                    />
                    <Text style={styles.nutrientRangeText}>Target: {reading.tds_value > 100 ? 'Sufficient' : reading.tds_value > 50 ? 'Add nutrients' : 'Needs dosing'}</Text>
                  </View>
                );
              })()}

              {/* ── Health Summary ── */}
              {(() => {
                const health = assessNutrientHealth(reading.current_ph, reading.tds_value);
                return (
                  <View style={[styles.nutrientSummary, {backgroundColor: health.color + '08', borderColor: health.color + '20'}]}>
                    <Ionicons
                      name={health.level === 'Optimal' ? 'checkmark-circle' : health.level === 'Warning' ? 'alert-circle' : 'warning'}
                      size={14}
                      color={health.color}
                    />
                    <Text style={[styles.nutrientSummaryText, {color: health.color}]}>{health.message}</Text>
                  </View>
                );
              })()}
            </View>
          )}
        </Animated.View>

        <View style={styles.sensorGrid}>
          <SensorStatusCard title="pH Level" value={reading?.current_ph?.toFixed(1) ?? '--'} icon="flask" colors={['#00897B', '#4DB6AC'] as const} />
          <SensorStatusCard title="TDS" value={reading?.tds_value?.toFixed(0) ?? '--'} unit="ppm" icon="water" colors={['#EF6C00', '#FFA726'] as const} />
        </View>

        <WaterCard reading={reading} />

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
              <View style={styles.pumpsSectionHeader}>
                <Text style={styles.pumpsSectionHint}>Tap a pump to toggle ON/OFF</Text>
                {reading?.auto_enabled === true && (
                  <View style={styles.autoBadge}>
                    <Ionicons name="flash" size={10} color={Colors.solarAmber} />
                    <Text style={styles.autoBadgeText}>AUTO</Text>
                  </View>
                )}
              </View>
              <View style={styles.pumpsGrid}>
                <DashboardPumpCard label="Water Circulation" on={effectivePumps.pompa1 === 1} color={Colors.waterTeal} onToggle={(v) => handlePumpToggle('pompa1', v ? 1 : 0)} />
                <View style={styles.pumpSpacer} />
                <DashboardPumpCard label="pH Down Dosing" on={effectivePumps.pompa2 === 1} color={Colors.tempBlue} onToggle={(v) => handlePumpToggle('pompa2', v ? 1 : 0)} />
                <View style={styles.pumpSpacer} />
                <DashboardPumpCard label="Nutrient AB Mix Dosing" on={effectivePumps.pompa3 === 1 || effectivePumps.pompa4 === 1} color={Colors.energyOrange} onToggle={(v) => handleABMixToggle(v ? 1 : 0)} />
              </View>
              {reading?.auto_enabled === true && (
                <View style={styles.autoNoteRow}>
                  <Ionicons name="information-circle" size={12} color={Colors.solarAmber} />
                  <Text style={styles.autoNoteText}>Auto-pump is active — manual overrides are temporary (30s cooldown)</Text>
                </View>
              )}
            </View>
          )}
        </View>

        {/* ── AI Vision Feed ── */}
        <View style={styles.cameraSectionCard}>
          <SectionHeader icon="camera" colors={[Colors.primaryGreen, Colors.deepGreen] as const} title="AI Vision Feed" badge={cameraError ? 'Offline' : 'Streaming'} dotColor={cameraError ? Colors.statusRed : Colors.statusGreen} textColor={cameraError ? Colors.statusRed : Colors.deepGreen} bgColor={cameraError ? '#FFEBEE' : Colors.tempLight} />
          <View style={styles.cameraFrame}>
            <Image source={{uri: `${API_URL}/camera/live?t=${cameraTick}`}} style={styles.cameraImage} onError={() => setCameraError(true)} />
            {cameraError && (
              <View style={styles.cameraFallback}>
                <Ionicons name="videocam-off" size={40} color={Colors.textHint} />
                <Text style={{fontSize: 15, fontWeight: '700', color: Colors.textPrimary}}>Camera Offline</Text>
                <Text style={{fontSize: 11, color: Colors.textSecondary}}>Unable to connect to AI camera feed</Text>
              </View>
            )}
          </View>
          <View style={{flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 8}}>
            <Ionicons name="refresh" size={10} color={Colors.textHint} />
            <Text style={{fontSize: 10, color: Colors.textHint, flex: 1}}>Refreshing every {(CAMERA_POLL_MS / 1000).toFixed(0)}s</Text>
          </View>
        </View>

        {/* ═══════════════ RECENT ACTIVITY — REDESIGNED ═══════════════ */}
        <View style={styles.activitySection}>
          <SectionHeader icon="time-outline" colors={[Colors.accentGreen, Colors.primaryGreen] as const} title="Recent Activity"
            badge={reading ? 'Live' : undefined}
            dotColor={isConnected ? Colors.statusGreen : Colors.statusOrange}
            textColor={isConnected ? Colors.deepGreen : '#BF360C'}
            bgColor={isConnected ? Colors.paleGreen : '#FFF3E0'}
          />

          {/* ── Activity Timeline ── */}
          <View style={styles.timeline}>
            {/* Activity 1: System Status */}
            <View style={styles.timelineItem}>
              <View style={styles.timelineTrack}>
                <LinearGradient colors={isConnected ? [Colors.accentGreen, Colors.primaryGreen] as const : [Colors.statusOrange, '#FF8A65'] as const} style={styles.timelineDot}>
                  <Ionicons name={isConnected ? 'checkmark-circle' : 'close-circle'} size={12} color="#FFF" />
                </LinearGradient>
                <View style={styles.timelineLine} />
              </View>
              <TouchableOpacity activeOpacity={0.7} style={styles.timelineCard} onPress={() => navigation?.navigate('PID')}>
                <View style={styles.timelineCardRow}>
                  <View style={styles.timelineCardLeft}>
                    <Text style={styles.timelineTitle}>{isConnected ? 'System Online' : 'System Offline'}</Text>
                    <View style={styles.timelineMetaRow}>
                      <Ionicons name="pulse" size={11} color={isConnected ? Colors.accentGreen : Colors.statusOrange} />
                      <Text style={styles.timelineMeta}>{isConnected ? 'All sensors reporting' : 'No sensor data'}</Text>
                    </View>
                  </View>
                  <View style={styles.timelineCardRight}>
                    <View style={[styles.timelineChip, {backgroundColor: isConnected ? Colors.paleGreen : '#FFF3E0'}]}>
                      <Text style={[styles.timelineChipText, {color: isConnected ? Colors.deepGreen : '#BF360C'}]}>{reading?.ts ? formatRelativeTime(reading.ts) : 'Just now'}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={14} color="#D0D5DD" />
                  </View>
                </View>
              </TouchableOpacity>
            </View>

            {/* Activity 2: pH & TDS Reading */}
            {reading && (
              <View style={styles.timelineItem}>
                <View style={styles.timelineTrack}>
                  <LinearGradient colors={[Colors.tempBlue, '#4DB6AC'] as const} style={styles.timelineDot}>
                    <Ionicons name="flask" size={11} color="#FFF" />
                  </LinearGradient>
                  <View style={styles.timelineLine} />
                </View>
                <TouchableOpacity activeOpacity={0.7} style={styles.timelineCard} onPress={() => navigation?.navigate('Analytics')}>
                  <View style={styles.timelineCardRow}>
                    <View style={styles.timelineCardLeft}>
                      <Text style={styles.timelineTitle}>pH {reading.current_ph?.toFixed(1) ?? '--'} · TDS {reading.tds_value?.toFixed(0) ?? '--'} ppm</Text>
                      <AnimatedProgressBar
                        value={Math.min(100, ((reading.current_ph ?? 7) / 14) * 100)}
                        height={4}
                        color={Colors.tempBlue}
                        style={{marginTop: 2, width: 120}}
                      />
                    </View>
                    <View style={styles.timelineCardRight}>
                      <View style={[styles.timelineChip, {backgroundColor: Colors.tempLight}]}>
                        <Text style={[styles.timelineChipText, {color: Colors.tempBlue}]}>{reading.ts ? formatRelativeTime(reading.ts) : ''}</Text>
                      </View>
                      <Ionicons name="chevron-forward" size={14} color="#D0D5DD" />
                    </View>
                  </View>
                </TouchableOpacity>
              </View>
            )}

            {/* Activity 3: Water Level */}
            {reading && (
              <View style={styles.timelineItem}>
                <View style={styles.timelineTrack}>
                  <LinearGradient colors={[Colors.waterTeal, '#42A5F5'] as const} style={styles.timelineDot}>
                    <Ionicons name="water" size={11} color="#FFF" />
                  </LinearGradient>
                  <View style={styles.timelineLine} />
                </View>
                <TouchableOpacity activeOpacity={0.7} style={styles.timelineCard} onPress={() => navigation?.navigate('Analytics')}>
                  <View style={styles.timelineCardRow}>
                    <View style={styles.timelineCardLeft}>
                      <Text style={styles.timelineTitle}>Water Level {Math.round(computeWaterPct(reading.jarak_cm, reading.tank_depth_cm, reading.water_level_pct))}%</Text>
                      <View style={styles.timelineMetaRow}>
                        <Ionicons name="resize" size={11} color={Colors.waterTeal} />
                        <Text style={styles.timelineMeta}>Tank {reading.jarak_cm.toFixed(1)}cm · {Math.round(computeWaterPct(reading.jarak_cm, reading.tank_depth_cm, reading.water_level_pct))}% full</Text>
                      </View>
                    </View>
                    <View style={styles.timelineCardRight}>
                      <View style={[styles.timelineChip, {backgroundColor: Colors.waterBg}]}>
                        <Text style={[styles.timelineChipText, {color: Colors.waterTeal}]}>{reading.ts ? formatRelativeTime(reading.ts) : ''}</Text>
                      </View>
                      <Ionicons name="chevron-forward" size={14} color="#D0D5DD" />
                    </View>
                  </View>
                  {/* mini water bar */}
                  <AnimatedProgressBar
                    value={Math.round(computeWaterPct(reading.jarak_cm, reading.tank_depth_cm, reading.water_level_pct))}
                    height={3}
                    color={Colors.waterTeal}
                    backgroundColor="transparent"
                    borderRadius={2}
                    style={{marginTop: 6, opacity: 0.3}}
                  />
                </TouchableOpacity>
              </View>
            )}

            {/* Activity 4: Pump Status (only when active) */}
            {(effectivePumps.pompa1 === 1 || effectivePumps.pompa2 === 1 || effectivePumps.pompa3 === 1 || effectivePumps.pompa4 === 1) && (
              <View style={styles.timelineItem}>
                <View style={styles.timelineTrack}>
                  <LinearGradient colors={[Colors.solarAmber, Colors.solarYellow] as const} style={styles.timelineDot}>
                    <Ionicons name="flash" size={11} color="#FFF" />
                  </LinearGradient>
                  <View style={styles.timelineLineLast} />
                </View>
                <TouchableOpacity activeOpacity={0.7} style={styles.timelineCard} onPress={() => navigation?.navigate('Automation')}>
                  <View style={styles.timelineCardRow}>
                    <View style={styles.timelineCardLeft}>
                      <Text style={styles.timelineTitle}>Pumps Running</Text>
                      <View style={styles.timelinePumpRow}>
                        {effectivePumps.pompa1 === 1 && <View style={[styles.pumpActiveDot, {backgroundColor: Colors.waterTeal}]} />}
                        {effectivePumps.pompa2 === 1 && <View style={[styles.pumpActiveDot, {backgroundColor: Colors.tempBlue}]} />}
                        {(effectivePumps.pompa3 === 1 || effectivePumps.pompa4 === 1) && <View style={[styles.pumpActiveDot, {backgroundColor: Colors.energyOrange}]} />}
                        <Text style={styles.pumpActiveCount}>({Object.values(effectivePumps).filter(Boolean).length} active)</Text>
                      </View>
                    </View>
                    <View style={styles.timelineCardRight}>
                      <Ionicons name="chevron-forward" size={14} color="#D0D5DD" />
                    </View>
                  </View>
                </TouchableOpacity>
              </View>
            )}

            {/* Activity 5: Night Mode (when active) */}
            {nightModeActive && (
              <View style={styles.timelineItem}>
                <View style={styles.timelineTrack}>
                  <LinearGradient colors={['#6366f1', '#4f46e5'] as const} style={styles.timelineDot}>
                    <Ionicons name="moon" size={11} color="#FFF" />
                  </LinearGradient>
                  <View style={styles.timelineLineLast} />
                </View>
                <TouchableOpacity activeOpacity={0.7} style={styles.timelineCard} onPress={() => navigation?.navigate('Analytics')}>
                  <View style={styles.timelineCardRow}>
                    <View style={styles.timelineCardLeft}>
                      <Text style={styles.timelineTitle}>Night Mode Active</Text>
                      <View style={styles.timelineMetaRow}>
                        <Ionicons name="bed" size={11} color="#6366f1" />
                        <Text style={styles.timelineMeta}>Pumps & alerts silenced</Text>
                      </View>
                    </View>
                    <View style={styles.timelineCardRight}>
                      <View style={[styles.timelineChip, {backgroundColor: '#EEF2FF'}]}>
                        <View style={[styles.timelineActiveDot, {backgroundColor: '#6366f1'}]} />
                        <Text style={[styles.timelineChipText, {color: '#4f46e5', marginLeft: 3}]}>On</Text>
                      </View>
                      <Ionicons name="chevron-forward" size={14} color="#D0D5DD" />
                    </View>
                  </View>
                </TouchableOpacity>
              </View>
            )}
          </View>

          {/* View All Button */}
          <TouchableOpacity style={styles.timelineFooter} onPress={() => navigation?.navigate('Notifications')}>
            <LinearGradient colors={[Colors.paleGreen, '#FFFFFF'] as const} start={{x: 0, y: 0}} end={{x: 1, y: 0}} style={styles.timelineFooterGradient}>
              <Text style={styles.timelineFooterText}>View All Activity</Text>
              <Ionicons name="arrow-forward" size={14} color={Colors.primaryGreen} />
            </LinearGradient>
          </TouchableOpacity>
        </View>

        <View style={styles.lastUpdateContainer}>
          <View style={[styles.updateDot, {backgroundColor: isConnected ? Colors.statusGreen : Colors.statusOrange}]} />
          <Text style={styles.lastUpdateText}>Last synced: {reading?.ts ? new Date(reading.ts * 1000).toLocaleTimeString() : 'Just now'}</Text>
        </View>
        <View style={{height: 40}} />
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
  heroContent: {position: 'relative', zIndex: 1, marginTop: 8},
  heroGreetingContainer: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7, marginTop: 3},
  heroGreetingBadge: {backgroundColor: 'rgba(255,255,255,0.2)', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)'},
  heroGreeting: {fontSize: 13, color: '#FFFFFF', fontWeight: '700', letterSpacing: 0.5},
  heroTime: {fontSize: 13, color: 'rgba(255,255,255,0.9)', fontWeight: '600', letterSpacing: 1},
  heroTitle: {fontSize: 34, fontWeight: '900', color: '#FFFFFF', marginBottom: 12, letterSpacing: -1.5, lineHeight: 40},
  heroSubtitleContainer: {flexDirection: 'row', alignItems: 'center', gap: 8},
  heroIconBadge: {width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.2)', justifyContent: 'center', alignItems: 'center'},
  heroSubtitle: {fontSize: 15, color: 'rgba(255,255,255,0.95)', fontWeight: '600', letterSpacing: 0.3},
  notifBtn: {
    width: 34, height: 34, borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center', justifyContent: 'center',
    position: 'relative',
  },
  notifBadge: {
    position: 'absolute', top: -4, right: -4,
    minWidth: 18, height: 18, borderRadius: 9,
    backgroundColor: Colors.statusRed,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: Colors.primaryGreen,
  },
  notifBadgeText: {fontSize: 9, fontWeight: '800', color: '#fff', lineHeight: 12},
  heroBadgeRow: {flexDirection: 'row', gap: 8, marginTop: 16},
  heroBadge: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16},
  heroBadgeDot: {width: 6, height: 6, borderRadius: 3},
  heroBadgeText: {fontSize: 11, fontWeight: '700', color: '#fff', letterSpacing: 0.3},
  mainStatusCard: {backgroundColor: '#FFFFFF', marginHorizontal: 16, borderRadius: 24, padding: 24, marginBottom: 24, shadowColor: Colors.primaryGreen, shadowOffset: {width: 0, height: 8}, shadowOpacity: 0.15, shadowRadius: 24, elevation: 8},
  mainStatusHeader: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16},
  mainStatusLabel: {fontSize: 14, color: '#8F9BB3', fontWeight: '600', marginBottom: 8, letterSpacing: 0.3},
  mainStatusSub: {fontSize: 12, color: '#8F9BB3', fontWeight: '500', marginTop: 4},
  statusBadge: {flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20},
  statusBadgeDot: {width: 8, height: 8, borderRadius: 4, marginRight: 6},
  statusBadgeText: {fontSize: 12, fontWeight: '700'},
  /* Nutrient Health styles */
  nutrientIconWrap: {width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center'},
  nutrientBadge: {flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10, alignSelf: 'flex-start'},
  nutrientBadgeDot: {width: 7, height: 7, borderRadius: 3.5},
  nutrientBadgeText: {fontSize: 11, fontWeight: '800', letterSpacing: 0.5},
  nutrientParams: {gap: 16},
  nutrientRow: {gap: 6},
  nutrientRowHeader: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
  nutrientParamLabel: {fontSize: 12, color: '#8F9BB3', fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase'},
  nutrientParamValue: {fontSize: 15, fontWeight: '800', letterSpacing: -0.3},
  nutrientParamStatus: {fontSize: 10, fontWeight: '800', letterSpacing: 0.3},
  nutrientRangeText: {fontSize: 9, color: '#A0ABB8', fontWeight: '500'},
  nutrientSummary: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingHorizontal: 14, borderRadius: 12, borderWidth: 1},
  nutrientSummaryText: {fontSize: 12, fontWeight: '700', flex: 1},
  progressContainer: {marginBottom: 4},
  progressBar: {height: 8, backgroundColor: '#F1F3F5', borderRadius: 4, overflow: 'hidden', marginBottom: 8},
  progressFill: {height: '100%', borderRadius: 4},
  progressText: {fontSize: 12, color: '#8F9BB3', fontWeight: '600'},
  sensorGrid: {flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 16, marginBottom: 20, gap: 12},
  /* ─── WaterCard (Redesigned) ─── */
  waterFullCard: {marginHorizontal: 16, borderRadius: 24, marginBottom: 16, backgroundColor: '#FFFFFF', overflow: 'hidden', ...Shadows.card, borderWidth: 1, borderColor: Colors.waterLight},
  waterAccentBar: {height: 4, width: '100%'},
  halfCardHeader: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 16},
  waterIconWrap: {width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center'},
  waterCardTitle: {fontSize: 16, fontWeight: '800', color: Colors.textPrimary, letterSpacing: -0.3},
  waterCardSub: {fontSize: 10, color: Colors.textHint, fontWeight: '500', marginTop: 1},
  waterStatusBadge: {flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 10},
  waterStatusText: {fontSize: 10, fontWeight: '800', letterSpacing: 0.3},
  waveContainer: {alignItems: 'center', marginVertical: 12},
  /* Stats grid */
  waterStatsGrid: {flexDirection: 'row', gap: 8, paddingHorizontal: 16, marginBottom: 12},
  waterStatItem: {flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingHorizontal: 10, borderRadius: 14},
  waterStatIconWrap: {width: 26, height: 26, borderRadius: 8, backgroundColor: Colors.waterTeal + '15', alignItems: 'center', justifyContent: 'center'},
  waterStatLabel: {fontSize: 9, color: Colors.textSecondary, fontWeight: '500'},
  waterStatValue: {fontSize: 12, fontWeight: '800', color: Colors.textPrimary},
  /* Mini progress bar at bottom */
  waterMiniBarOuter: {height: 4, backgroundColor: '#E8ECF1', marginHorizontal: 16, marginBottom: 16, borderRadius: 2, overflow: 'hidden'},
  waterMiniBarInner: {height: '100%', borderRadius: 2},
  controlsSection: {backgroundColor: '#FFFFFF', marginHorizontal: 16, borderRadius: 24, padding: 20, marginBottom: 16, shadowColor: Colors.primaryGreen, shadowOffset: {width: 0, height: 8}, shadowOpacity: 0.1, shadowRadius: 20, elevation: 6, borderWidth: 1, borderColor: 'rgba(46,125,50,0.1)'},
  sectionHeader: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
  sectionTitleContainer: {flexDirection: 'row', alignItems: 'center', gap: 10},
  sectionIconBadge: {width: 32, height: 32, borderRadius: 16, backgroundColor: Colors.paleGreen, justifyContent: 'center', alignItems: 'center'},
  sectionTitle: {fontSize: 17, fontWeight: '800', color: '#2E3A59', letterSpacing: -0.3},
  viewAllButton: {flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: Colors.paleGreen, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 16},
  pumpsSection: {marginTop: 16},
  pumpsSectionHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12},
  pumpsSectionHint: {fontSize: 10, color: Colors.textHint, fontWeight: '500'},
  autoBadge: {flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, backgroundColor: Colors.solarYellow + '25'},
  autoBadgeText: {fontSize: 9, fontWeight: '800', color: Colors.solarAmber, letterSpacing: 1},
  autoNoteRow: {flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: Colors.cardBorder},
  autoNoteText: {fontSize: 10, color: Colors.textHint, fontWeight: '500', flex: 1, lineHeight: 14},
  pumpsGrid: {},
  pumpSpacer: {height: 8},
  dashPumpCard: {
    borderRadius: 14,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: Colors.cardBorder,
    overflow: 'hidden',
    ...Shadows.subtle,
  },
  dashPumpAccent: {height: 3},
  dashPumpBody: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 10,
  },
  dashPumpText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  dashPumpBtn: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 6,
  },
  /* ─── Activity Timeline (Redesigned) ─── */
  activitySection: {backgroundColor: '#FFFFFF', marginHorizontal: 16, borderRadius: 24, padding: 20, paddingBottom: 4, marginBottom: 16, shadowColor: Colors.primaryGreen, shadowOffset: {width: 0, height: 8}, shadowOpacity: 0.1, shadowRadius: 20, elevation: 6, borderWidth: 1, borderColor: 'rgba(46,125,50,0.1)'},
  
  /* Timeline layout */
  timeline: {paddingLeft: 2},
  timelineItem: {flexDirection: 'row', marginBottom: 6},
  timelineTrack: {width: 28, alignItems: 'center', paddingTop: 4},
  timelineDot: {width: 24, height: 24, borderRadius: 12, justifyContent: 'center', alignItems: 'center', shadowColor: '#000', shadowOffset: {width: 0, height: 2}, shadowOpacity: 0.12, shadowRadius: 4, elevation: 3},
  timelineLine: {width: 2, flex: 1, backgroundColor: '#E8ECF1', marginTop: 2, minHeight: 20},
  timelineLineLast: {width: 2, flex: 1, backgroundColor: 'transparent', marginTop: 2, minHeight: 12},
  
  /* Timeline cards */
  timelineCard: {flex: 1, backgroundColor: '#F8F9FA', borderRadius: 14, paddingVertical: 10, paddingHorizontal: 14, marginLeft: 8, marginBottom: 4, borderWidth: 1, borderColor: 'rgba(0,0,0,0.04)'},
  timelineCardRow: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
  timelineCardLeft: {flex: 1, marginRight: 8},
  timelineCardRight: {flexDirection: 'row', alignItems: 'center', gap: 4},
  
  /* Card content */
  timelineTitle: {fontSize: 13, fontWeight: '700', color: '#2E3A59', letterSpacing: -0.2, marginBottom: 4},
  timelineMetaRow: {flexDirection: 'row', alignItems: 'center', gap: 4},
  timelineMeta: {fontSize: 11, color: Colors.textSecondary, fontWeight: '500'},
  
  /* Time chip */
  timelineChip: {flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8},
  timelineChipText: {fontSize: 9, fontWeight: '700', letterSpacing: 0.2},
  timelineActiveDot: {width: 5, height: 5, borderRadius: 2.5},
  
  /* ─── Camera / AI Vision Feed ─── */
  cameraSectionCard: {backgroundColor: '#FFFFFF', marginHorizontal: 16, borderRadius: 24, padding: 20, marginBottom: 16, shadowColor: Colors.primaryGreen, shadowOffset: {width: 0, height: 8}, shadowOpacity: 0.1, shadowRadius: 20, elevation: 6, borderWidth: 1, borderColor: 'rgba(46,125,50,0.1)'},
  cameraFrame: {borderRadius: 16, overflow: 'hidden', aspectRatio: 16 / 9, backgroundColor: Colors.background, position: 'relative'},
  cameraImage: {width: '100%', height: '100%', resizeMode: 'cover'},
  cameraFallback: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: Colors.background},

  /* Mini progress bars */
  timelineMiniBar: {height: 4, backgroundColor: '#F1F3F5', borderRadius: 2, overflow: 'hidden', marginTop: 2, width: 120},
  timelineMiniBarFill: {height: '100%', borderRadius: 2},
  waterMiniBar: {height: 3, backgroundColor: Colors.waterTeal, borderRadius: 2, marginTop: 6, opacity: 0.3},
  
  /* Pump status dots in timeline */
  timelinePumpRow: {flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2},
  pumpActiveDot: {width: 8, height: 8, borderRadius: 4},
  pumpActiveCount: {fontSize: 11, color: Colors.textSecondary, fontWeight: '600', marginLeft: 2},
  
  /* Timeline footer — View All */
  timelineFooter: {marginTop: 8, marginBottom: 12, borderRadius: 14, overflow: 'hidden'},
  timelineFooterGradient: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, borderRadius: 14, borderWidth: 1, borderColor: Colors.cardBorder},
  timelineFooterText: {fontSize: 13, fontWeight: '700', color: Colors.primaryGreen, letterSpacing: 0.3},
  lastUpdateContainer: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 16, marginHorizontal: 16, marginBottom: 30},
  updateDot: {width: 6, height: 6, borderRadius: 3, marginRight: 8},
  lastUpdateText: {fontSize: 13, color: '#8F9BB3', fontWeight: '600'},
});
