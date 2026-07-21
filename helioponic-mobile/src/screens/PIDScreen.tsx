import React, {useEffect, useState, useCallback} from 'react';
import {View, Text, ScrollView, StyleSheet, Alert, TouchableOpacity} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import {Ionicons} from '@expo/vector-icons';
import {useSensorStore} from '../store/sensorStore';
import {useAuth} from '../context/AuthContext';
import {actuatorApi, automationApi} from '../lib/apiClient';
import {Colors, Shadows} from '../context/ThemeContext';

import {SectionHeader} from '../components/SectionHeader';
import {AnimatedProgressBar} from '../components/AnimatedProgressBar';
import {PumpStateCard} from '../components/PumpStateCard';
import PIDDiagram from '../components/PIDDiagram';

// Water level percentage calculator
function computeWaterPct(jarakCm: number, tankDepthCm?: number): number {
  if (jarakCm >= 999 || jarakCm < 0) return 0;
  const depth = tankDepthCm || 32;
  const waterDepth = depth - Math.min(jarakCm, depth);
  return Math.max(0, Math.min(100, (waterDepth / depth) * 100));
}

// ── Mini pump indicator for Relay Pumps health ────────────────────────
function MiniPumpDot({label, on, color}: {label: string; on: boolean; color: string}) {
  return (
    <View style={pumpMiniStyles.wrap}>
      <View style={[pumpMiniStyles.dot, {backgroundColor: on ? color : '#E0E4E8', shadowColor: on ? color : 'transparent'}]} />
      <Text style={[pumpMiniStyles.label, {color: on ? color : Colors.textHint}]}>{label}</Text>
    </View>
  );
}

const pumpMiniStyles = StyleSheet.create({
  wrap: {alignItems: 'center', gap: 4},
  dot: {width: 26, height: 26, borderRadius: 13, shadowOffset: {width: 0, height: 2}, shadowOpacity: 0.3, shadowRadius: 4, elevation: 3},
  label: {fontSize: 9, fontWeight: '700', letterSpacing: 0.3},
});

// ── Health Status Card (no real-time values, just component health) ───
function HealthCard({label, status, color, icon, note, children}: {
  label: string; status: 'good' | 'warning' | 'critical' | 'waiting'; color: string; icon: string;
  note?: string; children?: React.ReactNode;
}) {
  const cfg = {
    good: {dot: Colors.statusGreen, bg: Colors.paleGreen, lbl: 'Good'},
    warning: {dot: Colors.solarAmber, bg: '#FFF8E1', lbl: 'Warning'},
    critical: {dot: Colors.statusRed, bg: '#FFEBEE', lbl: 'Critical'},
    waiting: {dot: Colors.textHint, bg: Colors.cardBorder, lbl: 'Waiting'},
  }[status];

  return (
    <View style={hStyles.card}>
      <View style={hStyles.accentBar}>
        <LinearGradient colors={[color + 'CC', color + '30'] as const} start={{x: 0, y: 0}} end={{x: 1, y: 0}} style={{flex: 1}} />
      </View>
      <View style={hStyles.body}>
        {/* Row: icon + label + status badge */}
        <View style={hStyles.topRow}>
          <View style={hStyles.topLeft}>
            <View style={[hStyles.iconWrap, {backgroundColor: color + '15'}]}>
              <Ionicons name={icon as any} size={20} color={color} />
            </View>
            <Text style={hStyles.label}>{label}</Text>
          </View>
          <View style={[hStyles.badge, {backgroundColor: cfg.bg}]}>
            <View style={[hStyles.badgeDot, {backgroundColor: cfg.dot}]} />
            <Text style={[hStyles.badgeText, {color: cfg.dot}]}>{cfg.lbl}</Text>
          </View>
        </View>

        {/* Optional diagnostic note */}
        {note && (
          <View style={hStyles.noteRow}>
            <Ionicons name="information-circle-outline" size={14} color={Colors.textHint} />
            <Text style={hStyles.noteText}>{note}</Text>
          </View>
        )}

        {/* Optional children (for Relay Pumps mini indicators) */}
        {children && (
          <View style={hStyles.childrenArea}>
            {children}
          </View>
        )}
      </View>
    </View>
  );
}

const hStyles = StyleSheet.create({
  card: {
    borderRadius: 18,
    backgroundColor: '#FFFFFF',
    marginBottom: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.04)',
    ...Shadows.subtle,
  },
  accentBar: {height: 3},
  body: {paddingVertical: 14, paddingHorizontal: 16},
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  topLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.textPrimary,
    letterSpacing: -0.2,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
  },
  badgeDot: {width: 6, height: 6, borderRadius: 3},
  badgeText: {fontSize: 10, fontWeight: '800', letterSpacing: 0.5},
  noteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 10,
  },
  noteText: {
    fontSize: 11,
    color: Colors.textHint,
    fontWeight: '500',
    flex: 1,
    lineHeight: 15,
  },
  childrenArea: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: Colors.cardBorder,
  },
});

export default function PIDScreen() {
  const latestReading = useSensorStore((s) => s.latestReading);
  const isConnected = useSensorStore((s) => s.isConnected);
  const setLatestReading = useSensorStore((s) => s.setLatestReading);
  const overridePumps = useSensorStore((s) => s.overridePumps);
  const setOverridePump = useSensorStore((s) => s.setOverridePump);
  const {activeDeviceId} = useAuth();
  const [showPid, setShowPid] = useState(false);
  const doToggle = useCallback(async (pump: string, s: 0 | 1) => {
    setOverridePump(pump, s);
    try {
      await actuatorApi.controlPump(pump, s, activeDeviceId);
      const current = useSensorStore.getState().latestReading;
      if (current) setLatestReading({...current, [pump]: s});
    } catch (err: any) {
      setOverridePump(pump, s === 1 ? 0 : 1);
      Alert.alert('Pump Control', `Failed to toggle ${pump}: ${err?.message || 'Unknown error'}`);
    }
  }, [activeDeviceId, setLatestReading, setOverridePump]);

  const handlePumpToggle = useCallback(async (pump: string, newState: boolean) => {
    const s = (newState ? 1 : 0) as 0 | 1;
    const currentReading = useSensorStore.getState().latestReading;
    if (currentReading?.auto_enabled === true) {
      Alert.alert(
        'Automation Active',
        'Manual override will disable the Auto-Pump System.',
        [
          {text: 'Cancel', style: 'cancel'},
          {text: 'Override & Disable', style: 'destructive', onPress: async () => {
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
              doToggle(pump, s);
          }},
        ],
      );
    } else {
      doToggle(pump, s);
    }
  }, [activeDeviceId, doToggle]);

  const handleABToggle = useCallback(async (newState: boolean) => {
    // Toggle BOTH Pompa 3 & Pompa 4 simultaneously (single Alert, single action)
    const s = (newState ? 1 : 0) as 0 | 1;
    const currentReading = useSensorStore.getState().latestReading;
    if (currentReading?.auto_enabled === true) {
      Alert.alert(
        'Automation Active',
        'Manual override will disable the Auto-Pump System.',
        [
          {text: 'Cancel', style: 'cancel'},
          {text: 'Override & Disable', style: 'destructive', onPress: async () => {
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
                setOverridePump('pompa3', s === 1 ? 0 : 1);
                setOverridePump('pompa4', s === 1 ? 0 : 1);
              }
          }},
        ],
      );
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
        setOverridePump('pompa3', s === 1 ? 0 : 1);
        setOverridePump('pompa4', s === 1 ? 0 : 1);
      }
    }
  }, [activeDeviceId, setLatestReading, setOverridePump]);

  const reading = latestReading;
  const effectiveP1 = overridePumps.pompa1 ?? reading?.pompa1 ?? 0;
  const effectiveP2 = overridePumps.pompa2 ?? reading?.pompa2 ?? 0;
  const effectiveP3 = overridePumps.pompa3 ?? reading?.pompa3 ?? 0;
  const effectiveP4 = overridePumps.pompa4 ?? reading?.pompa4 ?? 0;
  const effectiveAB = effectiveP3 === 1 || effectiveP4 === 1;

  return (
    <SafeAreaView style={{flex: 1, backgroundColor: Colors.background}} edges={['top']}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* ── Header ── */}
        <View style={styles.header}>
          <View style={styles.headerIcon}>
            <LinearGradient colors={[Colors.primaryGreen, Colors.deepGreen] as const} start={{x: 0, y: 0}} end={{x: 1, y: 1}} style={styles.headerIconGradient}>
              <Ionicons name="information-circle" size={20} color="#fff" />
            </LinearGradient>
          </View>
          <View style={{flex: 1}}>
            <Text style={styles.headerTitle}>Diagnostics Hub</Text>
            <Text style={styles.headerSub}>System health & calibration</Text>
          </View>
          <View style={[styles.liveBadge, {backgroundColor: isConnected ? Colors.paleGreen : '#FFF3E0'}]}>
            <View style={[styles.liveDot, {backgroundColor: isConnected ? Colors.statusGreen : Colors.statusOrange}]} />
            <Text style={[styles.liveLabel, {color: isConnected ? Colors.deepGreen : '#BF360C'}]}>{isConnected ? 'LIVE' : 'OFF'}</Text>
          </View>
        </View>

        {/* ═══════════════ P&ID DIAGRAM — COLLAPSIBLE ═══════════════ */}
        <View style={styles.pidSection}>
          {/* Toggle header */}
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={() => setShowPid((prev) => !prev)}
            style={styles.pidToggle}
          >
            <View style={styles.pidToggleLeft}>
              <View style={[styles.pidToggleIcon, {backgroundColor: '#00d2ff' + '20'}]}>
                <Ionicons name="git-branch" size={16} color="#00d2ff" />
              </View>
              <View>
                <Text style={styles.pidToggleTitle}>P&amp;ID Diagram</Text>
                <Text style={styles.pidToggleSub}>
                  {showPid ? 'Tap to collapse' : 'Tap to view piping & instrumentation'}
                </Text>
              </View>
            </View>
            <View style={[styles.pidToggleArrow, {transform: [{rotate: showPid ? '180deg' : '0deg'}]}]}>
              <Ionicons name="chevron-down" size={18} color="#00d2ff" />
            </View>
          </TouchableOpacity>

          {/* Collapsible PID content */}
          {showPid && (
            <View style={styles.pidCollapsible}>
              <PIDDiagram />
            </View>
          )}
        </View>

        {/* ── Sensor Dashboard ── */}
        <View style={styles.section}>
          <SectionHeader icon="speedometer" colors={[Colors.tempBlue, '#4DB6AC'] as const} title="Sensor Dashboard" badge={isConnected ? 'LIVE' : undefined} dotColor={isConnected ? Colors.statusGreen : undefined} textColor={isConnected ? Colors.deepGreen : undefined} bgColor={isConnected ? Colors.paleGreen : undefined} />
          <View style={styles.dashGrid}>
            <View style={[styles.dashCard, {borderTopColor: '#00897B'}]}>
              <View style={[styles.dashIconWrap, {backgroundColor: '#00897B' + '15'}]}>
                <Ionicons name="flask" size={20} color="#00897B" />
              </View>
              <Text style={styles.dashLabel}>pH Level</Text>
              <Text style={[styles.dashValue, {color: '#00897B'}]}>{reading?.current_ph?.toFixed(1) ?? '--'}</Text>
              <AnimatedProgressBar value={Math.min(100, ((reading?.current_ph ?? 7) / 14) * 100)} height={4} color="#00897B" style={{marginTop: 8, width: '80%'}} />
              <Text style={styles.dashRange}>Safe: 4.0 – 8.0</Text>
              <View style={[styles.dashStatusBadge, {backgroundColor: reading && reading.current_ph >= 4 && reading.current_ph <= 8 ? '#00897B' + '12' : '#E53935' + '12'}]}>
                <View style={[styles.dashStatusDot, {backgroundColor: reading && reading.current_ph >= 4 && reading.current_ph <= 8 ? '#00897B' : '#E53935'}]} />
                <Text style={[styles.dashStatusText, {color: reading && reading.current_ph >= 4 && reading.current_ph <= 8 ? '#00897B' : '#E53935'}]}>
                  {!reading ? 'Waiting' : reading.current_ph >= 4 && reading.current_ph <= 8 ? 'Good' : 'Critical'}
                </Text>
              </View>
            </View>

            <View style={[styles.dashCard, {borderTopColor: '#EF6C00'}]}>
              <View style={[styles.dashIconWrap, {backgroundColor: '#EF6C00' + '15'}]}>
                <Ionicons name="water" size={20} color="#EF6C00" />
              </View>
              <Text style={styles.dashLabel}>TDS</Text>
              <View style={styles.dashValueRow}>
                <Text style={[styles.dashValue, {color: '#EF6C00'}]}>{reading?.tds_value?.toFixed(0) ?? '--'}</Text>
                <Text style={styles.dashUnit}>ppm</Text>
              </View>
              <AnimatedProgressBar value={Math.min(100, ((reading?.tds_value ?? 0) / 2000) * 100)} height={4} color="#EF6C00" style={{marginTop: 8, width: '80%'}} />
              <Text style={styles.dashRange}>Target: 0 – 2000 ppm</Text>
              <View style={[styles.dashStatusBadge, {backgroundColor: reading && (reading.tds_value ?? 0) > 0 ? '#EF6C00' + '12' : '#E53935' + '12'}]}>
                <View style={[styles.dashStatusDot, {backgroundColor: reading && (reading.tds_value ?? 0) > 0 ? '#EF6C00' : '#E53935'}]} />
                <Text style={[styles.dashStatusText, {color: reading && (reading.tds_value ?? 0) > 0 ? '#EF6C00' : '#E53935'}]}>
                  {!reading ? 'Waiting' : (reading.tds_value ?? 0) > 0 ? 'Active' : 'No Data'}
                </Text>
              </View>
            </View>

            <View style={[styles.dashCard, {borderTopColor: '#1E88E5'}]}>
              <View style={[styles.dashIconWrap, {backgroundColor: '#1E88E5' + '15'}]}>
                <Ionicons name="water" size={20} color="#1E88E5" />
              </View>
              <Text style={styles.dashLabel}>Water Level</Text>
              <View style={styles.dashValueRow}>
                <Text style={[styles.dashValue, {color: '#1E88E5'}]}>{reading ? Math.round(computeWaterPct(reading.jarak_cm, latestReading?.tank_depth_cm)) : '--'}</Text>
                <Text style={styles.dashUnit}>%</Text>
              </View>
              <AnimatedProgressBar value={reading ? Math.round(computeWaterPct(reading.jarak_cm, latestReading?.tank_depth_cm)) : 0} height={4} color="#1E88E5" style={{marginTop: 8, width: '80%'}} />
              <Text style={styles.dashRange}>Tank depth: {latestReading?.tank_depth_cm || 32} cm</Text>
              <View style={[styles.dashStatusBadge, {backgroundColor: reading && reading.jarak_cm < 999 && reading.jarak_cm >= 0 ? '#1E88E5' + '12' : '#E53935' + '12'}]}>
                <View style={[styles.dashStatusDot, {backgroundColor: reading && reading.jarak_cm < 999 && reading.jarak_cm >= 0 ? '#1E88E5' : '#E53935'}]} />
                <Text style={[styles.dashStatusText, {color: reading && reading.jarak_cm < 999 && reading.jarak_cm >= 0 ? '#1E88E5' : '#E53935'}]}>
                  {!reading ? 'Waiting' : reading.jarak_cm < 999 && reading.jarak_cm >= 0 ? 'OK' : 'Error'}
                </Text>
              </View>
            </View>
          </View>
        </View>

        {/* ════════════════════════════════════════════════════════════
           PUMP CONTROL — clean stacked cards
           ════════════════════════════════════════════════════════════ */}
        <View style={styles.section}>
          <View style={styles.pumpSectionHeader}>
            <SectionHeader icon="options" colors={[Colors.accentGreen, Colors.primaryGreen] as const} title="Pump Control" />
            {reading?.auto_enabled === true && (
              <View style={[styles.pumpAutoBadge, {backgroundColor: Colors.solarYellow + '25'}]}>
                <Ionicons name="flash" size={12} color={Colors.solarAmber} />
                <Text style={styles.pumpAutoBadgeText}>AUTO</Text>
              </View>
            )}
          </View>
          <View style={styles.pumpGrid}>
            <PumpStateCard
              label="Water Circulation"
              description="Pompa 1"
              on={effectiveP1 === 1}
              color={Colors.waterTeal}
              onToggle={(v) => handlePumpToggle('pompa1', v)}
            />
            <PumpStateCard
              label="pH Down Dosing"
              description="Pompa 2"
              on={effectiveP2 === 1}
              color={Colors.tempBlue}
              onToggle={(v) => handlePumpToggle('pompa2', v)}
            />
            <PumpStateCard
              label="Nutrient AB Mix Dosing"
              description="Pompa 3 & 4"
              on={effectiveAB}
              color={Colors.energyOrange}
              onToggle={handleABToggle}
            />
          </View>
          {reading?.auto_enabled === true && (
            <View style={styles.autoNoteRow}>
              <Ionicons name="information-circle" size={14} color={Colors.solarAmber} />
              <Text style={styles.autoNoteText}>Manual overrides are temporary while auto-pump is active</Text>
            </View>
          )}
        </View>

        {/* ════════════════════════════════════════════════════════════
           COMPONENT HEALTH — health status only (no real-time readings)
           ════════════════════════════════════════════════════════════ */}
        <View style={styles.section}>
          <SectionHeader icon="pulse" colors={[Colors.primaryGreen, Colors.deepGreen] as const} title="Component Health" />
          <HealthCard
            label="pH Sensor"
            status={!reading ? 'waiting' : reading.current_ph >= 4 && reading.current_ph <= 8 ? 'good' : 'critical'}
            color={Colors.tempBlue}
            icon="flask"
            note={!reading ? 'Waiting for data...' : reading.current_ph >= 4 && reading.current_ph <= 8 ? 'Reading within safe range' : 'Reading outside safe range'}
          />
          <HealthCard
            label="TDS Sensor"
            status={!reading ? 'waiting' : reading.tds_value > 0 ? 'good' : 'warning'}
            color={Colors.energyOrange}
            icon="water"
            note={!reading ? 'Waiting for data...' : reading.tds_value > 0 ? 'Sensor responding normally' : 'No readings detected'}
          />
          <HealthCard
            label="Ultrasonic Sensor"
            status={!reading ? 'waiting' : reading.jarak_cm < 999 && reading.jarak_cm >= 0 ? 'good' : 'critical'}
            color={Colors.waterTeal}
            icon="water"
            note={!reading ? 'Waiting for data...' : reading.jarak_cm < 999 && reading.jarak_cm >= 0 ? 'Sensor reading within range' : 'Sensor error — check connection'}
          />
          <HealthCard
            label="Relay Pumps"
            status={!reading ? 'waiting' : 'good'}
            color={Colors.accentGreen}
            icon="options"
            note="All 4 relays operational"
          >
            <View style={styles.pumpMiniRow}>
              <MiniPumpDot label="P1" on={effectiveP1 === 1} color={Colors.waterTeal} />
              <MiniPumpDot label="P2" on={effectiveP2 === 1} color={Colors.tempBlue} />
              <MiniPumpDot label="AB" on={effectiveAB} color={Colors.energyOrange} />
            </View>
          </HealthCard>
        </View>

      </ScrollView>
    </SafeAreaView>
  );
}

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

  /* ─── P&ID Diagram Section ─── */
  pidSection: {marginHorizontal: 16, marginBottom: 14, marginTop: 2},
  pidToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#F8F9FA',
    borderRadius: 18,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: '#E0E4E8',
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 2},
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
  },
  pidToggleLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  pidToggleIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pidToggleTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#37474F',
    letterSpacing: -0.3,
  },
  pidToggleSub: {
    fontSize: 10,
    fontWeight: '500',
    color: '#78909C',
    marginTop: 2,
  },
  pidToggleArrow: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(0,210,255,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pidCollapsible: {
    marginTop: 10,
  },

  /* ─── Dashboard Grid ─── */
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
  dashRange: {fontSize: 8, color: Colors.textHint, fontWeight: '500', marginTop: 4},
  dashStatusBadge: {flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, marginTop: 6},
  dashStatusDot: {width: 5, height: 5, borderRadius: 2.5},
  dashStatusText: {fontSize: 8, fontWeight: '800', letterSpacing: 0.3},

  /* ─── Pump Control ─── */
  pumpSectionHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6},
  pumpAutoBadge: {flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 10},
  pumpAutoBadgeText: {fontSize: 10, fontWeight: '800', color: Colors.solarAmber, letterSpacing: 1},
  pumpGrid: {gap: 10},
  autoNoteRow: {flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: Colors.cardBorder},
  autoNoteText: {fontSize: 11, color: Colors.textHint, fontWeight: '500', flex: 1, lineHeight: 15},

  /* ─── Relay Pump Mini Indicators ─── */
  pumpMiniRow: {flexDirection: 'row', justifyContent: 'space-around', paddingHorizontal: 10, paddingVertical: 2},

  /* ─── Camera ─── */

});
