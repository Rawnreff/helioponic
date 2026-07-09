import React, {useState, useEffect, useCallback} from 'react';
import {View, Text, ScrollView, StyleSheet, TouchableOpacity, Alert, ActivityIndicator, Switch} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import Slider from '@react-native-community/slider';
import {Ionicons} from '@expo/vector-icons';
import {useAuth} from '../context/AuthContext';
import {configApi, automationApi} from '../lib/apiClient';
import {SectionHeader} from '../components/SectionHeader';
import {Colors, Shadows} from '../context/ThemeContext';

interface ThresholdDraft {jarak_on: number; jarak_off: number; tds_on: number; tds_off: number}

function RuleCard({condition, action, icon, color, bg, active, onToggle}: {
  condition: string; action: string; icon: string; color: string; bg: string; active: boolean; onToggle: (v: boolean) => void;
}) {
  return (
    <LinearGradient colors={active ? ([color, color + '80'] as const) : (['#E8ECF1', '#E8ECF1'] as const)} start={{x: 0, y: 0}} end={{x: 1, y: 1}} style={styles.ruleCardBorderGradient}>
      <View style={[styles.ruleCard, active && {borderColor: color + '40'}]}>
        <View style={styles.ruleHeader}>
          <View style={[styles.ruleIconWrap, {backgroundColor: bg}]}><Ionicons name={icon as any} size={20} color={color} /></View>
          <View style={{flex: 1}}><Text style={styles.ruleTitle}>Automation Rule</Text><Text style={styles.ruleSubtitle}>IF-THEN condition</Text></View>
          <Switch value={active} onValueChange={onToggle} trackColor={{false: Colors.cardBorder, true: color + '60'}} thumbColor={active ? color : '#ccc'} />
        </View>
        <View style={styles.ruleBody}>
          <View style={styles.ruleRow}><View style={[styles.rulePill, {backgroundColor: '#FFF3E0'}]}><Text style={styles.rulePillLabel}>IF</Text></View><Text style={styles.ruleCondition}>{condition}</Text></View>
          <View style={styles.ruleArrow}><View style={styles.ruleLine} /><Ionicons name="chevron-down" size={14} color={Colors.textHint} /></View>
          <View style={styles.ruleRow}><View style={[styles.rulePill, {backgroundColor: Colors.paleGreen}]}><Text style={[styles.rulePillLabel, {color: Colors.deepGreen}]}>THEN</Text></View><Text style={styles.ruleAction}>{action}</Text></View>
        </View>
      </View>
    </LinearGradient>
  );
}

function ThresholdSlider({icon, title, subtitle, color, bg, value, min, max, step, displayValue, onChange, disabled}: {
  icon: string; title: string; subtitle: string; color: string; bg: string; value: number; min: number; max: number; step: number; displayValue: string; onChange: (v: number) => void; disabled?: boolean;
}) {
  const borderColors = disabled ? (['#E8ECF1', '#E8ECF1'] as const) : ([color + '80', color + '40'] as const);
  return (
    <LinearGradient colors={borderColors} start={{x: 0, y: 0}} end={{x: 1, y: 1}} style={styles.sliderBorderGradient}>
      <View style={styles.sliderCard}>
        <View style={styles.sliderHeader}>
          <View style={[styles.sliderIcon, {backgroundColor: bg}]}><Ionicons name={icon as any} size={18} color={color} /></View>
          <View style={{flex: 1}}><Text style={styles.sliderTitle}>{title}</Text><Text style={styles.sliderSub}>{subtitle}</Text></View>
          <View style={[styles.valueBadge, {backgroundColor: color + '18'}]}><Text style={[styles.valueText, {color}]}>{displayValue}</Text></View>
        </View>
        <Slider style={{width: '100%', height: 44}} minimumValue={min} maximumValue={max} step={step} value={value} onValueChange={onChange} disabled={disabled} minimumTrackTintColor={color} maximumTrackTintColor={color + '20'} thumbTintColor={color} />
        <View style={{flexDirection: 'row', justifyContent: 'space-between'}}><Text style={{fontSize: 10, color: Colors.textHint}}>{min}</Text><Text style={{fontSize: 10, color: Colors.textHint}}>{max}</Text></View>
      </View>
    </LinearGradient>
  );
}

export default function AutomationScreen() {
  const {activeDeviceId} = useAuth();
  const [autoEnabled, setAutoEnabled] = useState(true);
  const [serverThresholds, setServerThresholds] = useState<ThresholdDraft | null>(null);
  const [draft, setDraft] = useState<ThresholdDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rules, setRules] = useState({ph: true, tds: true, water: true});

  useEffect(() => {
    (async () => {
      try {
        // Fetch thresholds
        const data = await configApi.get(activeDeviceId);
        const t: ThresholdDraft = {jarak_on: data.jarak_on ?? 105, jarak_off: data.jarak_off ?? 95, tds_on: data.tds_on ?? 105.0, tds_off: data.tds_off ?? 95.0};
        setServerThresholds(t); setDraft(t);

        // Fetch automation rules from backend
        try {
          const rulesData = await automationApi.get(activeDeviceId);
          setAutoEnabled(rulesData.auto_enabled);
          setRules({ph: rulesData.rule_ph, tds: rulesData.rule_tds, water: rulesData.rule_water});
        } catch {
          // Rules endpoint might not exist yet for older devices — use defaults
        }
      } catch {const t: ThresholdDraft = {jarak_on: 105, jarak_off: 95, tds_on: 105.0, tds_off: 95.0}; setServerThresholds(t); setDraft(t);}
      finally {setLoading(false);}
    })();
  }, [activeDeviceId]);

  const hasChanges = useCallback(() => {
    if (!serverThresholds || !draft) return false;
    return draft.jarak_on !== serverThresholds.jarak_on || draft.jarak_off !== serverThresholds.jarak_off || draft.tds_on !== serverThresholds.tds_on || draft.tds_off !== serverThresholds.tds_off;
  }, [serverThresholds, draft]);

  const pendingChanges = useCallback(() => {
    if (!serverThresholds || !draft) return [];
    const changes: any[] = [];
    if (draft.jarak_on !== serverThresholds.jarak_on) changes.push({label: 'Jarak ON', from: `${serverThresholds.jarak_on}`, to: `${draft.jarak_on}`, color: Colors.waterTeal});
    if (draft.jarak_off !== serverThresholds.jarak_off) changes.push({label: 'Jarak OFF', from: `${serverThresholds.jarak_off}`, to: `${draft.jarak_off}`, color: Colors.waterTeal});
    if (draft.tds_on !== serverThresholds.tds_on) changes.push({label: 'TDS ON', from: `${serverThresholds.tds_on.toFixed(0)} ppm`, to: `${draft.tds_on.toFixed(0)} ppm`, color: Colors.energyOrange});
    if (draft.tds_off !== serverThresholds.tds_off) changes.push({label: 'TDS OFF', from: `${serverThresholds.tds_off.toFixed(0)} ppm`, to: `${draft.tds_off.toFixed(0)} ppm`, color: Colors.energyOrange});
    return changes;
  }, [serverThresholds, draft]);

  // ── Save automation rules to backend on toggle change ──────────────
  const saveRules = useCallback(async (newAutoEnabled: boolean, newRules: typeof rules) => {
    try {
      await automationApi.update({
        device_id: activeDeviceId,
        auto_enabled: newAutoEnabled,
        rule_ph: newRules.ph,
        rule_tds: newRules.tds,
        rule_water: newRules.water,
      });
    } catch {
      // Silently fail — rules are non-critical, will sync on next mount
    }
  }, [activeDeviceId]);

  const handleAutoToggle = useCallback((value: boolean) => {
    setAutoEnabled(value);
    saveRules(value, rules);
  }, [rules, saveRules]);

  const handleRuleToggle = useCallback((rule: 'ph' | 'tds' | 'water', value: boolean) => {
    const newRules = {...rules, [rule]: value};
    setRules(newRules);
    saveRules(autoEnabled, newRules);
  }, [rules, autoEnabled, saveRules]);

  const handleConfirm = useCallback(async () => {
    if (!draft) return;
    const changes = pendingChanges();
    if (changes.length === 0) return;
    const summary = changes.map((c) => `• ${c.label}: ${c.from} → ${c.to}`).join('\n');
    Alert.alert('Review Changes', `Confirm the following threshold updates:\n\n${summary}`, [
      {text: 'Cancel', style: 'cancel', onPress: () => setDraft(serverThresholds)},
      {text: 'Confirm', onPress: async () => {
        setSaving(true);
        try {
          await configApi.update({device_id: activeDeviceId, jarak_on: draft.jarak_on, jarak_off: draft.jarak_off, tds_on: draft.tds_on, tds_off: draft.tds_off});
          setServerThresholds({...draft}); Alert.alert('Success', 'Thresholds synced to hardware');
        } catch (err: any) {Alert.alert('Error', err.message || 'Failed');}
        finally {setSaving(false);}
      }},
    ]);
  }, [draft, serverThresholds, pendingChanges, activeDeviceId]);

  if (loading) return <SafeAreaView style={{flex: 1, backgroundColor: Colors.background}} edges={['top']}><View style={{flex: 1, justifyContent: 'center', alignItems: 'center'}}><ActivityIndicator size="large" color={Colors.primaryGreen} /></View></SafeAreaView>;

  const t = draft ?? serverThresholds ?? {jarak_on: 105, jarak_off: 95, tds_on: 105.0, tds_off: 95.0};
  const changed = hasChanges();

  return (
    <SafeAreaView style={{flex: 1, backgroundColor: Colors.background}} edges={['top']}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <View style={styles.headerIcon}><LinearGradient colors={[Colors.primaryGreen, Colors.deepGreen] as const} start={{x: 0, y: 0}} end={{x: 1, y: 1}} style={styles.headerIconGradient}><Ionicons name="options" size={20} color="#fff" /></LinearGradient></View>
          <View style={{flex: 1}}><Text style={styles.headerTitle}>Automation</Text><Text style={styles.headerSub}>IF-THEN threshold rules</Text></View>
          <View style={[styles.statusBadge, {backgroundColor: autoEnabled ? Colors.paleGreen : '#FFF3E0'}]}><View style={[styles.statusDot, {backgroundColor: autoEnabled ? Colors.statusGreen : Colors.textHint}]} /><Text style={[styles.statusLabel, {color: autoEnabled ? Colors.deepGreen : Colors.textSecondary}]}>{autoEnabled ? 'ACTIVE' : 'OFF'}</Text></View>
        </View>

        <View style={styles.section}>
          <SectionHeader icon="flash" colors={[Colors.solarAmber, Colors.solarYellow] as const} title="Auto-Pump System" badge={autoEnabled ? 'ACTIVE' : 'OFF'} dotColor={autoEnabled ? Colors.statusGreen : Colors.textHint} textColor={autoEnabled ? Colors.deepGreen : Colors.textSecondary} bgColor={autoEnabled ? Colors.paleGreen : '#FFF3E0'} />
          <View style={styles.masterRow}>
            <View style={styles.masterIconWrap}><Ionicons name="flash" size={24} color={autoEnabled ? Colors.solarAmber : Colors.textHint} /></View>
            <View style={{flex: 1}}><Text style={styles.masterTitle}>{autoEnabled ? 'Pumps trigger automatically' : 'Manual control only'}</Text><Text style={styles.masterSub}>{autoEnabled ? 'Pumps activate when thresholds are breached' : 'All pumps must be controlled manually from Dashboard'}</Text></View>
            <Switch value={autoEnabled} onValueChange={handleAutoToggle} trackColor={{false: Colors.cardBorder, true: Colors.accentGreen + '60'}} thumbColor={autoEnabled ? Colors.accentGreen : '#ccc'} />
          </View>
        </View>

        <View style={styles.section}>
          <SectionHeader icon="flask" colors={[Colors.tempBlue, '#42A5F5'] as const} title="Automation Rules" />
          <Text style={styles.sectionSubtitle}>Conditions that trigger pump actions automatically</Text>
          <RuleCard condition="pH is outside target ±0.3" action="Activate pH Dosing Pump until pH returns to range" icon="flask" color={Colors.tempBlue} bg={Colors.tempLight} active={rules.ph} onToggle={(v) => handleRuleToggle('ph', v)} />
          <RuleCard condition="TDS drops below target -50 ppm" action="Activate Nutrient Pumps A & B until TDS recovers" icon="water" color={Colors.energyOrange} bg="#FFF3E0" active={rules.tds} onToggle={(v) => handleRuleToggle('tds', v)} />
          <RuleCard condition="Water Level falls below minimum threshold" action="Activate Raw Water Pump until level reaches maximum" icon="water" color={Colors.waterTeal} bg={Colors.waterBg} active={rules.water} onToggle={(v) => handleRuleToggle('water', v)} />
        </View>

        <View style={styles.section}>
          <SectionHeader icon="options" colors={[Colors.primaryGreen, Colors.deepGreen] as const} title="Threshold Boundaries" />
          <Text style={styles.sectionSubtitle}>Adjust the trigger points for each automation rule</Text>
          <ThresholdSlider icon="water" title="Jarak ON" subtitle="Distance (cm) to turn pump ON" color={rules.ph ? Colors.waterTeal : Colors.textHint} bg={rules.ph ? Colors.waterBg : Colors.cardBorder} value={t.jarak_on} min={0} max={400} step={1} displayValue={`${t.jarak_on} cm`} onChange={(v) => setDraft((d) => d ? {...d, jarak_on: v} : null)} disabled={saving || !autoEnabled || !rules.ph} />
          <ThresholdSlider icon="water" title="Jarak OFF" subtitle="Distance (cm) to turn pump OFF" color={rules.ph ? Colors.waterTeal : Colors.textHint} bg={rules.ph ? Colors.waterBg : Colors.cardBorder} value={t.jarak_off} min={0} max={400} step={1} displayValue={`${t.jarak_off} cm`} onChange={(v) => setDraft((d) => d ? {...d, jarak_off: v} : null)} disabled={saving || !autoEnabled || !rules.ph} />
          <ThresholdSlider icon="flask" title="TDS ON" subtitle="TDS (ppm) to turn pump ON" color={rules.tds ? Colors.energyOrange : Colors.textHint} bg={rules.tds ? '#FFF3E0' : Colors.cardBorder} value={t.tds_on} min={0} max={2000} step={5} displayValue={`${t.tds_on.toFixed(0)} ppm`} onChange={(v) => setDraft((d) => d ? {...d, tds_on: v} : null)} disabled={saving || !autoEnabled || !rules.tds} />
          <ThresholdSlider icon="flask" title="TDS OFF" subtitle="TDS (ppm) to turn pump OFF" color={rules.tds ? Colors.energyOrange : Colors.textHint} bg={rules.tds ? '#FFF3E0' : Colors.cardBorder} value={t.tds_off} min={0} max={2000} step={5} displayValue={`${t.tds_off.toFixed(0)} ppm`} onChange={(v) => setDraft((d) => d ? {...d, tds_off: v} : null)} disabled={saving || !autoEnabled || !rules.tds} />
        </View>

        {changed && (
          <TouchableOpacity style={[styles.confirmBtn, saving && {opacity: 0.5}]} onPress={handleConfirm} disabled={saving}>
            {saving ? <ActivityIndicator color={Colors.textPrimary} /> : <><Ionicons name="checkmark-circle" size={20} color={Colors.textPrimary} /><Text style={styles.confirmText}>Confirm & Apply Changes</Text></>}
          </TouchableOpacity>
        )}

        <View style={styles.section}>
          <SectionHeader icon="hardware-chip" colors={[Colors.accentGreen, Colors.primaryGreen] as const} title="Device Status" />
          <View style={styles.deviceRow}><View style={styles.deviceInfo}><Text style={styles.deviceLabel}>Active Device</Text><Text style={styles.deviceValue}>{activeDeviceId}</Text></View><View style={styles.deviceStatusRight}><View style={styles.deviceDot} /><Text style={styles.deviceStatusText}>Connected</Text></View></View>
        </View>
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
  statusBadge: {flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10},
  statusDot: {width: 7, height: 7, borderRadius: 4},
  statusLabel: {fontSize: 10, fontWeight: '800', letterSpacing: 1},
  section: {backgroundColor: '#FFFFFF', marginHorizontal: 16, borderRadius: 24, padding: 20, marginBottom: 14, shadowColor: Colors.primaryGreen, shadowOffset: {width: 0, height: 8}, shadowOpacity: 0.1, shadowRadius: 20, elevation: 6, borderWidth: 1, borderColor: 'rgba(46,125,50,0.1)'},
  sectionSubtitle: {fontSize: 11, color: Colors.textSecondary, marginBottom: 14},
  masterRow: {flexDirection: 'row', alignItems: 'center', gap: 14},
  masterIconWrap: {width: 48, height: 48, borderRadius: 16, backgroundColor: Colors.solarLight, alignItems: 'center', justifyContent: 'center'},
  masterTitle: {fontSize: 15, fontWeight: '700', color: Colors.textPrimary},
  masterSub: {fontSize: 11, color: Colors.textSecondary, marginTop: 2, lineHeight: 16},
  ruleCardBorderGradient: {padding: 2, borderRadius: 24, marginBottom: 10},
  ruleCard: {backgroundColor: Colors.surface, borderRadius: 22, padding: 20, borderWidth: 1, borderColor: Colors.cardBorder},
  ruleHeader: {flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16},
  ruleIconWrap: {width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center'},
  ruleTitle: {fontSize: 15, fontWeight: '700', color: Colors.textPrimary},
  ruleSubtitle: {fontSize: 10, color: Colors.textHint, marginTop: 1},
  ruleBody: {gap: 6, paddingLeft: 4},
  ruleRow: {flexDirection: 'row', alignItems: 'center', gap: 10},
  rulePill: {paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6},
  rulePillLabel: {fontSize: 11, fontWeight: '800', color: '#BF360C', letterSpacing: 0.5},
  ruleCondition: {fontSize: 13, fontWeight: '500', color: Colors.textPrimary, flex: 1},
  ruleAction: {fontSize: 13, fontWeight: '500', color: Colors.textPrimary, flex: 1},
  ruleArrow: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 6},
  ruleLine: {width: 2, height: 14, backgroundColor: Colors.cardBorder, marginLeft: 16, borderRadius: 1},
  sliderBorderGradient: {padding: 2, borderRadius: 24, marginBottom: 10},
  sliderCard: {backgroundColor: Colors.surface, borderRadius: 22, padding: 20},
  sliderHeader: {flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16},
  sliderIcon: {padding: 10, borderRadius: 14},
  sliderTitle: {fontSize: 15, fontWeight: '700', color: Colors.textPrimary},
  sliderSub: {fontSize: 11, color: Colors.textSecondary, marginTop: 1},
  valueBadge: {paddingHorizontal: 14, paddingVertical: 6, borderRadius: 10},
  valueText: {fontSize: 14, fontWeight: '800'},
  confirmBtn: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.solarYellow, borderRadius: 16, paddingVertical: 16, gap: 8, marginHorizontal: 16, marginBottom: 14, shadowColor: Colors.solarAmber, shadowOffset: {width: 0, height: 4}, shadowOpacity: 0.3, shadowRadius: 8, elevation: 4},
  confirmText: {fontSize: 15, fontWeight: '700', color: Colors.textPrimary, letterSpacing: 0.3},
  deviceRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  deviceInfo: {flex: 1},
  deviceLabel: {fontSize: 13, color: Colors.textSecondary, fontWeight: '500'},
  deviceValue: {fontSize: 15, fontWeight: '700', color: Colors.textPrimary, marginTop: 2},
  deviceStatusRight: {flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: Colors.paleGreen, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16},
  deviceDot: {width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.statusGreen},
  deviceStatusText: {fontSize: 11, fontWeight: '700', color: Colors.deepGreen},
});
