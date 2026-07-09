import React, {useEffect, useState} from 'react';
import {View, Text, ScrollView, StyleSheet, Image} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import {Ionicons} from '@expo/vector-icons';
import {useSensorStore} from '../store/sensorStore';
import {Colors, Shadows} from '../context/ThemeContext';
import {WS_URL, CAMERA_POLL_MS} from '../constants';
import {SectionHeader} from '../components/SectionHeader';
import {SensorStatusCard} from '../components/SensorStatusCard';
import {PumpStateCard} from '../components/PumpStateCard';

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
  const [cameraTick, setCameraTick] = useState(0);
  const [cameraError, setCameraError] = useState(false);
  useEffect(() => {const timer = setInterval(() => {setCameraTick((t) => t + 1); setCameraError(false);}, CAMERA_POLL_MS); return () => clearInterval(timer);}, []);

  const reading = latestReading;
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
          <View style={styles.sensorGrid}>
            <SensorStatusCard title="pH Level" value={reading?.current_ph?.toFixed(1) ?? '--'} icon="flask" colors={['#1976D2', '#42A5F5'] as const} />
            <SensorStatusCard title="TDS" value={reading?.tds_value?.toFixed(0) ?? '--'} unit="ppm" icon="water" colors={['#EF6C00', '#FFA726'] as const} />
            <SensorStatusCard title="Distance" value={reading ? `${reading.jarak_cm} cm` : '--'} unit="0-400cm" icon="water" colors={['#00897B', '#4DB6AC'] as const} />
          </View>
        </View>

        <View style={styles.section}>
          <SectionHeader icon="options" colors={[Colors.accentGreen, Colors.primaryGreen] as const} title="Pump States" />
          <View style={styles.pumpGrid}>
            <PumpStateCard label="Pompa 1" on={reading?.pompa1 === 1} color={Colors.accentGreen} />
            <PumpStateCard label="Pompa 2" on={reading?.pompa2 === 1} color={Colors.tempBlue} />
          </View>
        </View>

        <View style={styles.section}>
          <SectionHeader icon="pulse" colors={[Colors.primaryGreen, Colors.deepGreen] as const} title="Component Health" />
          <HealthIndicator label="pH Sensor" status={!reading ? 'waiting' : reading.current_ph >= 4 && reading.current_ph <= 8 ? 'good' : 'critical'} value={reading ? `${reading.current_ph?.toFixed(1) ?? '--'}` : 'Waiting'} threshold="Range: 4.0 - 8.0" color={Colors.tempBlue} icon="flask" />
          <HealthIndicator label="TDS Sensor" status={!reading ? 'waiting' : reading.tds_value > 0 ? 'good' : 'warning'} value={reading ? `${reading.tds_value?.toFixed(0) ?? '--'} ppm` : 'Waiting'} threshold="Target: 0 - 2000 ppm" color={Colors.energyOrange} icon="water" />
          <HealthIndicator label="Ultrasonic" status={!reading ? 'waiting' : reading.jarak_cm < 400 && reading.jarak_cm > 0 ? 'good' : 'critical'} value={reading ? `${reading.jarak_cm ?? '--'} cm` : 'Waiting'} threshold="Range: 2 - 400 cm" color={Colors.waterTeal} icon="water" />
          <HealthIndicator label="Relay Pumps" status={!reading ? 'waiting' : 'good'} value={`P1:${reading?.pompa1 ?? '?'} P2:${reading?.pompa2 ?? '?'}`} threshold="2/2 relays responding" color={Colors.accentGreen} icon="options" />
        </View>

        <View style={styles.section}>
          <SectionHeader icon="camera" colors={[Colors.primaryGreen, Colors.deepGreen] as const} title="AI Vision Feed" badge={cameraError ? 'Offline' : 'Streaming'} dotColor={cameraError ? Colors.statusRed : Colors.statusGreen} textColor={cameraError ? Colors.statusRed : Colors.deepGreen} bgColor={cameraError ? '#FFEBEE' : Colors.tempLight} />
          <View style={styles.cameraFrame}>
            <Image source={{uri: `${WS_URL.replace('/ws/pid', '/api/v1')}/camera/live?t=${cameraTick}`}} style={styles.cameraImage} onError={() => setCameraError(true)} />
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
  content: {paddingBottom: 32},
  header: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 4},
  headerIcon: {borderRadius: 14, overflow: 'hidden', ...Shadows.subtle},
  headerIconGradient: {width: 44, height: 44, justifyContent: 'center', alignItems: 'center'},
  headerTitle: {fontSize: 22, fontWeight: '800', color: Colors.textPrimary, letterSpacing: -0.5},
  headerSub: {fontSize: 12, color: Colors.textSecondary, marginTop: 2},
  liveBadge: {flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10},
  liveDot: {width: 7, height: 7, borderRadius: 4},
  liveLabel: {fontSize: 10, fontWeight: '800', letterSpacing: 1},
  section: {backgroundColor: '#FFFFFF', marginHorizontal: 16, borderRadius: 24, padding: 20, marginBottom: 14, shadowColor: Colors.primaryGreen, shadowOffset: {width: 0, height: 8}, shadowOpacity: 0.1, shadowRadius: 20, elevation: 6, borderWidth: 1, borderColor: 'rgba(46,125,50,0.1)'},
  sensorGrid: {flexDirection: 'row', flexWrap: 'wrap', gap: 12},
  pumpGrid: {flexDirection: 'row', gap: 8},
  cameraFrame: {borderRadius: 16, overflow: 'hidden', aspectRatio: 16 / 9, backgroundColor: Colors.background, position: 'relative'},
  cameraImage: {width: '100%', height: '100%', resizeMode: 'cover'},
  cameraFallback: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: Colors.background},
});
