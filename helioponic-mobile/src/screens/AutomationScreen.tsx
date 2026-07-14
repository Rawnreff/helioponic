import React, {useState, useEffect, useCallback} from 'react';
import {View, Text, ScrollView, StyleSheet, TouchableOpacity, Alert, ActivityIndicator, Switch} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import Slider from '@react-native-community/slider';
import {Ionicons} from '@expo/vector-icons';
import {useFocusEffect} from '@react-navigation/native';
import {useAuth} from '../context/AuthContext';
import {configApi, automationApi, nightModeApi} from '../lib/apiClient';
import {useNightModeStore} from '../store/nightModeStore';
import {useSensorStore} from '../store/sensorStore';
import {SectionHeader} from '../components/SectionHeader';
import {Colors, Shadows} from '../context/ThemeContext';

interface ThresholdDraft {jarak_on: number; jarak_off: number; tds_on: number; tds_off: number; ph_min: number; ph_max: number}

// ── Reusable compact threshold slider (internal) ──────────────────────
function ParamSlider({icon, title, subtitle, color, bg, value, min, max, step, displayValue, extraDisplay, onChange, disabled}: {
  icon: string; title: string; subtitle: string; color: string; bg: string;
  value: number; min: number; max: number; step: number; displayValue: string;
  extraDisplay?: string;
  onChange: (v: number) => void; disabled?: boolean;
}) {
  const borderColors = disabled ? (['#E8ECF1', '#E8ECF1'] as const) : ([color + '80', color + '40'] as const);
  return (
    <LinearGradient colors={borderColors} start={{x: 0, y: 0}} end={{x: 1, y: 1}} style={{padding: 2, borderRadius: 20, marginBottom: 10}}>
      <View style={{backgroundColor: Colors.surface, borderRadius: 18, padding: 16}}>
        <View style={{flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12}}>
          <View style={{padding: 8, borderRadius: 12, backgroundColor: bg}}><Ionicons name={icon as any} size={16} color={color} /></View>
          <View style={{flex: 1}}><Text style={{fontSize: 14, fontWeight: '700', color: Colors.textPrimary}}>{title}</Text><Text style={{fontSize: 10, color: Colors.textSecondary, marginTop: 1}}>{subtitle}</Text></View>
          <View style={{paddingHorizontal: 12, paddingVertical: 5, borderRadius: 8, backgroundColor: color + '18', alignItems: 'center'}}>
            <Text style={{fontSize: 13, fontWeight: '800', color}}>{displayValue}</Text>
            {extraDisplay && <Text style={{fontSize: 9, fontWeight: '600', color, marginTop: 1, opacity: 0.8}}>{extraDisplay}</Text>}
          </View>
        </View>
        <Slider style={{width: '100%', height: 40}} minimumValue={min} maximumValue={max} step={step} value={value} onValueChange={onChange} disabled={disabled} minimumTrackTintColor={color} maximumTrackTintColor={color + '20'} thumbTintColor={color} />
        <View style={{flexDirection: 'row', justifyContent: 'space-between'}}><Text style={{fontSize: 9, color: Colors.textHint}}>{min}</Text><Text style={{fontSize: 9, color: Colors.textHint}}>{max}</Text></View>
      </View>
    </LinearGradient>
  );
}

// ── Unified parameter card: toggle + sliders + confirm ────────────────
function AutomationParamCard({
  title, subtitle, icon, gradient, accentColor, bgColor,
  ruleEnabled, onToggleRule,
  sliders, hasChanges, saving, onConfirm, confirmDisabled, disabled,
}: {
  title: string; subtitle: string; icon: string; gradient: readonly [string, string, ...string[]];
  accentColor: string; bgColor: string;
  ruleEnabled: boolean; onToggleRule: (v: boolean) => void;
  sliders?: React.ReactNode;
  hasChanges?: boolean; saving?: boolean; onConfirm?: () => void; confirmDisabled?: boolean; disabled?: boolean;
}) {
  const isEffectivelyDisabled = disabled;

  return (
    <View style={[styles.paramCard, isEffectivelyDisabled && {borderColor: Colors.cardBorder, shadowOpacity: 0.05}]}>
      {/* ── Accent bar: grey when disabled ── */}
      <LinearGradient
        colors={isEffectivelyDisabled ? (['#D0D5DD', '#E0E4E8'] as const) : gradient}
        start={{x: 0, y: 0}} end={{x: 1, y: 0}}
        style={styles.paramCardAccent}
      />
      <View style={styles.paramCardInner}>
        {/* ── Header ── */}
        <View style={[styles.paramHeader, {marginBottom: 8}]}>
          <View style={styles.paramHeaderLeft}>
            <View style={[styles.paramIconBadge, {backgroundColor: isEffectivelyDisabled ? '#E8ECF1' : bgColor}]}>
              <Ionicons name={icon as any} size={22} color={isEffectivelyDisabled ? '#9EAAB8' : accentColor} />
            </View>
            <View style={{flex: 1}}>
              <Text style={[styles.paramTitle, isEffectivelyDisabled && {color: '#6B7A8F'}]}>{title}</Text>
              <Text style={[styles.paramSubtitle, isEffectivelyDisabled && {color: '#9EAAB8'}]}>{subtitle}</Text>
            </View>
          </View>
          <View style={styles.paramToggleWrap}>
            <Switch
              value={disabled ? false : ruleEnabled}
              onValueChange={onToggleRule}
              disabled={disabled}
              trackColor={{false: Colors.cardBorder, true: accentColor + '60'}}
              thumbColor={disabled ? '#ccc' : (ruleEnabled ? accentColor : '#ccc')}
            />
          </View>
        </View>

        {/* ── Disabled banner ── */}
        {isEffectivelyDisabled && (
          <View style={styles.disabledBanner}>
            <View style={styles.disabledBannerDot} />
            <Ionicons name="pause-circle" size={14} color="#9EAAB8" />
            <Text style={styles.disabledBannerText}>Auto-Pump is OFF — enable from toggle above</Text>
          </View>
        )}

        {/* ── Sliders (greyscale colors passed via color/bg props) ── */}
        {sliders && (
          <View>
            {sliders}
          </View>
        )}

        {hasChanges && onConfirm && (
          <TouchableOpacity
            style={[styles.paramConfirmBtn, (saving || disabled) && {backgroundColor: '#E0E4E8'}]}
            onPress={onConfirm}
            disabled={saving || confirmDisabled || disabled}
          >
            {saving ? (
              <ActivityIndicator size="small" color={isEffectivelyDisabled ? '#9EAAB8' : '#fff'} />
            ) : (
              <><Ionicons name="checkmark-circle" size={16} color={isEffectivelyDisabled ? '#9EAAB8' : '#fff'} /><Text style={[styles.paramConfirmText, isEffectivelyDisabled && {color: '#6B7A8F'}]}>Confirm & Apply</Text></>
            )}
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

// ── Simple info row for pH card ───────────────────────────────────────
function InfoRow({icon, label, value, color}: {icon: string; label: string; value: string; color: string}) {
  return (
    <View style={styles.infoRow}>
      <View style={[styles.infoIcon, {backgroundColor: color + '15'}]}>
        <Ionicons name={icon as any} size={14} color={color} />
      </View>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={[styles.infoValue, {color}]}>{value}</Text>
    </View>
  );
}

// ============================================================================
// MAIN SCREEN
// ============================================================================

export default function AutomationScreen() {
  const {activeDeviceId} = useAuth();
  const [autoEnabled, setAutoEnabled] = useState(true);
  const [serverThresholds, setServerThresholds] = useState<ThresholdDraft | null>(null);
  const [draft, setDraft] = useState<ThresholdDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingWater, setSavingWater] = useState(false);
  const [savingTds, setSavingTds] = useState(false);
  const [savingPh, setSavingPh] = useState(false);
  const [rules, setRules] = useState({ph: true, tds: true, water: true});
  const nightModeActive = useNightModeStore((s) => s.active);
  const setNightStatus = useNightModeStore((s) => s.setStatus);

  // ── Fetch data on mount & every time screen is focused ────────────────
  // useFocusEffect refetches automation config whenever user comes back to
  // this tab (e.g. after disabling auto-pump from Dashboard).
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        setLoading(true);
        try {
          const data = await configApi.get(activeDeviceId);
          if (cancelled) return;
          const t: ThresholdDraft = {
            jarak_on: data.jarak_on ?? 5, jarak_off: data.jarak_off ?? 2,
            tds_on: data.tds_on ?? 95.0, tds_off: data.tds_off ?? 105.0,
            ph_min: data.ph_min ?? 5.5, ph_max: data.ph_max ?? 6.5,
          };
          setServerThresholds(t); setDraft(t);

          // Fetch automation rules (master toggle + toggles)
          try {
            const rulesData = await automationApi.get(activeDeviceId);
            if (cancelled) return;
            setAutoEnabled(rulesData.auto_enabled);
            setRules({ph: rulesData.rule_ph, tds: rulesData.rule_tds, water: rulesData.rule_water});
          } catch {
            // If automation API fails, keep current state (don't reset to true)
            // autoEnabled & rules retain their existing values
          }
        } catch {
          if (cancelled) return;
          const t: ThresholdDraft = {jarak_on: 5, jarak_off: 2, tds_on: 95.0, tds_off: 105.0, ph_min: 5.5, ph_max: 6.5};
          setServerThresholds(t); setDraft(t);
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
      return () => { cancelled = true; };
    }, [activeDeviceId])
  );

  // Fetch night mode
  useEffect(() => {
    (async () => {
      try {setNightStatus(await nightModeApi.status(activeDeviceId))} catch { /* silent */ }
    })();
  }, [activeDeviceId, setNightStatus]);

  // ── Helpers ───────────────────────────────────────────────────────────
  const hasWaterChanges = useCallback(() => {
    if (!serverThresholds || !draft) return false;
    return draft.jarak_on !== serverThresholds.jarak_on || draft.jarak_off !== serverThresholds.jarak_off;
  }, [serverThresholds, draft]);

  const hasTdsChanges = useCallback(() => {
    if (!serverThresholds || !draft) return false;
    return draft.tds_on !== serverThresholds.tds_on || draft.tds_off !== serverThresholds.tds_off;
  }, [serverThresholds, draft]);

  const hasPhChanges = useCallback(() => {
    if (!serverThresholds || !draft) return false;
    return draft.ph_min !== serverThresholds.ph_min || draft.ph_max !== serverThresholds.ph_max;
  }, [serverThresholds, draft]);

  // ── Save rules ────────────────────────────────────────────────────────
  const saveRules = useCallback(async (newAutoEnabled: boolean, newRules: typeof rules) => {
    try {
      await automationApi.update({
        device_id: activeDeviceId,
        auto_enabled: newAutoEnabled,
        rule_ph: newRules.ph, rule_tds: newRules.tds, rule_water: newRules.water,
      });
      // ⚡ Sync auto_enabled to sensorStore so Dashboard & PID screens
      // immediately reflect the change (AUTO badge & autoNoteRow)
      const storeReading = useSensorStore.getState().latestReading;
      if (storeReading) {
        useSensorStore.getState().setLatestReading({
          ...storeReading,
          auto_enabled: newAutoEnabled,
        });
      }
    } catch { /* silent */ }
  }, [activeDeviceId]);

  // ── Toggle handlers ───────────────────────────────────────────────────
  const handleAutoToggle = useCallback((value: boolean) => {
    setAutoEnabled(value);
    saveRules(value, rules);
  }, [rules, saveRules]);

  // ── Simple rule toggle ─────────────────────────────────────────────
  // Toggle individual rule ON/OFF without affecting auto_enabled or other rules
  const handleRuleToggle = useCallback((rule: 'ph' | 'tds' | 'water', value: boolean) => {
    const newRules = {...rules, [rule]: value};
    setRules(newRules);
    saveRules(autoEnabled, newRules);
  }, [rules, autoEnabled, saveRules]);

  // ── Confirm save: Water thresholds ────────────────────────────────────
  const handleWaterConfirm = useCallback(async () => {
    if (!draft) return;
    const changes: string[] = [];
    if (draft.jarak_on !== serverThresholds?.jarak_on) changes.push(`Jarak ON: ${serverThresholds?.jarak_on} → ${draft.jarak_on} cm`);
    if (draft.jarak_off !== serverThresholds?.jarak_off) changes.push(`Jarak OFF: ${serverThresholds?.jarak_off} → ${draft.jarak_off} cm`);
    Alert.alert('Review Water Level Changes', changes.join('\n'), [
      {text: 'Cancel', style: 'cancel', onPress: () => setDraft(serverThresholds ? {...serverThresholds} : null)},
      {text: 'Confirm', onPress: async () => {
        setSavingWater(true);
        try {
          await configApi.update({
            device_id: activeDeviceId, jarak_on: draft.jarak_on, jarak_off: draft.jarak_off,
            tds_on: serverThresholds?.tds_on ?? draft.tds_on, tds_off: serverThresholds?.tds_off ?? draft.tds_off,
            ph_min: draft.ph_min, ph_max: draft.ph_max,
          });
          setServerThresholds((prev) => prev ? {...prev, jarak_on: draft.jarak_on, jarak_off: draft.jarak_off} : null);
          Alert.alert('Water Level', 'Thresholds synced to hardware');
        } catch (err: any) {Alert.alert('Error', err.message || 'Failed')}
        finally {setSavingWater(false)}
      }},
    ]);
  }, [draft, serverThresholds, activeDeviceId]);

  // ── Confirm save: TDS thresholds ──────────────────────────────────────
  const handleTdsConfirm = useCallback(async () => {
    if (!draft) return;
    const changes: string[] = [];
    if (draft.tds_on !== serverThresholds?.tds_on) changes.push(`TDS ON: ${serverThresholds?.tds_on?.toFixed(0)} → ${draft.tds_on.toFixed(0)} ppm`);
    if (draft.tds_off !== serverThresholds?.tds_off) changes.push(`TDS OFF: ${serverThresholds?.tds_off?.toFixed(0)} → ${draft.tds_off.toFixed(0)} ppm`);
    Alert.alert('Review TDS Changes', changes.join('\n'), [
      {text: 'Cancel', style: 'cancel', onPress: () => setDraft(serverThresholds ? {...serverThresholds} : null)},
      {text: 'Confirm', onPress: async () => {
        setSavingTds(true);
        try {
          await configApi.update({
            device_id: activeDeviceId, jarak_on: serverThresholds?.jarak_on ?? draft.jarak_on,
            jarak_off: serverThresholds?.jarak_off ?? draft.jarak_off,
            tds_on: draft.tds_on, tds_off: draft.tds_off,
            ph_min: draft.ph_min, ph_max: draft.ph_max,
          });
          setServerThresholds((prev) => prev ? {...prev, tds_on: draft.tds_on, tds_off: draft.tds_off} : null);
          Alert.alert('TDS', 'Thresholds synced to hardware');
        } catch (err: any) {Alert.alert('Error', err.message || 'Failed')}
        finally {setSavingTds(false)}
      }},
    ]);
  }, [draft, serverThresholds, activeDeviceId]);

  // ── Confirm save: pH thresholds ───────────────────────────────────────
  const handlePhConfirm = useCallback(async () => {
    if (!draft) return;
    const changes: string[] = [];
    if (draft.ph_min !== serverThresholds?.ph_min) changes.push(`pH Minimum: ${serverThresholds?.ph_min?.toFixed(1)} → ${draft.ph_min.toFixed(1)}`);
    if (draft.ph_max !== serverThresholds?.ph_max) changes.push(`pH Down Threshold: ${serverThresholds?.ph_max?.toFixed(1)} → ${draft.ph_max.toFixed(1)}`);
    Alert.alert('Review pH Changes', (changes.length ? changes.join('\n') : 'No changes') + '\n\n💡 Pompa 2 (pH DOWN) activates when pH exceeds the upper threshold\nand stops only when pH drops to the minimum threshold.', [
      {text: 'Cancel', style: 'cancel', onPress: () => setDraft(serverThresholds ? {...serverThresholds} : null)},
      {text: 'Confirm', onPress: async () => {
        setSavingPh(true);
        try {
          await configApi.update({
            device_id: activeDeviceId, jarak_on: serverThresholds?.jarak_on ?? draft.jarak_on,
            jarak_off: serverThresholds?.jarak_off ?? draft.jarak_off,
            tds_on: serverThresholds?.tds_on ?? draft.tds_on,
            tds_off: serverThresholds?.tds_off ?? draft.tds_off,
            ph_min: draft.ph_min, ph_max: draft.ph_max,
          });
          setServerThresholds((prev) => prev ? {...prev, ph_min: draft.ph_min, ph_max: draft.ph_max} : null);
          Alert.alert('pH Level', 'Thresholds synced to hardware');
        } catch (err: any) {Alert.alert('Error', err.message || 'Failed')}
        finally {setSavingPh(false)}
      }},
    ]);
  }, [draft, serverThresholds, activeDeviceId]);

  // ── Night mode toggle ─────────────────────────────────────────────────
  const handleNightModeToggle = useCallback(async () => {
    if (nightModeActive) {
      try {
        const res = await nightModeApi.deactivate(activeDeviceId);
        if (res.success) setNightStatus({active: false, device_id: activeDeviceId, activated_at: null, deactivated_at: res.deactivated_at, saved_thresholds: null});
      } catch (err: any) {Alert.alert('Night Mode', err.message || 'Failed to deactivate')}
    } else {
      try {
        const res = await nightModeApi.activate(activeDeviceId);
        if (res.success) setNightStatus({active: true, device_id: activeDeviceId, activated_at: res.activated_at, deactivated_at: null, saved_thresholds: null});
      } catch (err: any) {Alert.alert('Night Mode', err.message || 'Failed to activate')}
    }
  }, [nightModeActive, activeDeviceId, setNightStatus]);

  // ── Loading ───────────────────────────────────────────────────────────
  if (loading) return (
    <SafeAreaView style={{flex: 1, backgroundColor: Colors.background}} edges={['top']}>
      <View style={{flex: 1, justifyContent: 'center', alignItems: 'center'}}><ActivityIndicator size="large" color={Colors.primaryGreen} /></View>
    </SafeAreaView>
  );

  const t = draft ?? serverThresholds ?? {jarak_on: 5, jarak_off: 2, tds_on: 105.0, tds_off: 95.0, ph_min: 5.5, ph_max: 6.5};

  // ── Water level pct helpers ───────────────────────────────────────────
  const waterPct = (cm: number) => ((7 - Math.min(cm, 7)) / 7) * 100;
  const waterCannotEdit = savingWater || !autoEnabled || !rules.water;

  // ── Format water percentage for display ──
  const waterDisplay = (cm: number) => {
    const pct = waterPct(cm);
    const rounded = Math.round(pct);
    return pct === rounded ? `${rounded}%` : `${pct.toFixed(1)}%`;
  };

  return (
    <SafeAreaView style={{flex: 1, backgroundColor: Colors.background}} edges={['top']}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* ── Header ── */}
        <View style={styles.header}>
          <View style={styles.headerIcon}>
            <LinearGradient colors={[Colors.primaryGreen, Colors.deepGreen] as const} start={{x: 0, y: 0}} end={{x: 1, y: 1}} style={styles.headerIconGradient}>
              <Ionicons name="options" size={20} color="#fff" />
            </LinearGradient>
          </View>
          <View style={{flex: 1}}><Text style={styles.headerTitle}>Automation</Text><Text style={styles.headerSub}>IF-THEN threshold rules</Text></View>
          <View style={[styles.statusBadge, {backgroundColor: autoEnabled ? Colors.paleGreen : '#FFF3E0'}]}>
            <View style={[styles.statusDot, {backgroundColor: autoEnabled ? Colors.statusGreen : Colors.textHint}]} />
            <Text style={[styles.statusLabel, {color: autoEnabled ? Colors.deepGreen : Colors.textSecondary}]}>{autoEnabled ? 'ACTIVE' : 'OFF'}</Text>
          </View>
        </View>

        {/* ── Master toggle ── */}
        <View style={styles.section}>
          <SectionHeader icon="flash" colors={[Colors.solarAmber, Colors.solarYellow] as const} title="Auto-Pump System" badge={autoEnabled ? 'ACTIVE' : 'OFF'} dotColor={autoEnabled ? Colors.statusGreen : Colors.textHint} textColor={autoEnabled ? Colors.deepGreen : Colors.textSecondary} bgColor={autoEnabled ? Colors.paleGreen : '#FFF3E0'} />
          <View style={styles.masterRow}>
            <View style={styles.masterIconWrap}><Ionicons name="flash" size={24} color={autoEnabled ? Colors.solarAmber : Colors.textHint} /></View>
            <View style={{flex: 1}}>
              <Text style={styles.masterTitle}>{autoEnabled ? 'Pumps trigger automatically' : 'Manual control only'}</Text>
              <Text style={styles.masterSub}>{autoEnabled ? 'Pumps activate when thresholds are breached' : 'All pumps must be controlled manually from Dashboard'}</Text>
            </View>
            <Switch value={autoEnabled} onValueChange={handleAutoToggle} trackColor={{false: Colors.cardBorder, true: Colors.accentGreen + '60'}} thumbColor={autoEnabled ? Colors.accentGreen : '#ccc'} />
          </View>
        </View>

        {/* ════════════════════════════════════════════════════════════
           WATER LEVEL CARD — toggle + jarak sliders + confirm
           ════════════════════════════════════════════════════════════ */}
        <AutomationParamCard
          title="Water Level"
          subtitle="Ultrasonic distance thresholds"
          icon="water"
          gradient={[Colors.waterTeal, Colors.waterLight] as const}
          accentColor={Colors.waterTeal}
          bgColor={Colors.waterBg}
          ruleEnabled={rules.water}
          onToggleRule={(v) => handleRuleToggle('water', v)}
          hasChanges={hasWaterChanges()}
          saving={savingWater}
          onConfirm={handleWaterConfirm}
          disabled={!autoEnabled}
          confirmDisabled={!autoEnabled}
          sliders={
            <>
              <ParamSlider
                icon="arrow-up-circle"
                title="Jarak ON (Refill)"
                subtitle={`Distance > ${t.jarak_on.toFixed(1)}cm → water ${waterDisplay(t.jarak_on)} — activate refill`}
                color={!autoEnabled ? Colors.textHint : (rules.water ? Colors.waterTeal : Colors.textHint)}
                bg={!autoEnabled ? Colors.cardBorder : (rules.water ? Colors.waterBg : Colors.cardBorder)}
                value={t.jarak_on}
                min={0.0}
                max={7.0}
                step={0.1}
                displayValue={`${t.jarak_on.toFixed(1)} cm`}
                extraDisplay={waterDisplay(t.jarak_on)}
                onChange={(v) => setDraft((d) => d ? {...d, jarak_on: Math.round(v * 10) / 10, jarak_off: Math.min(d.jarak_off ?? 2, Math.round((v - 0.3) * 10) / 10)} : null)}
                disabled={waterCannotEdit}
              />
              <ParamSlider
                icon="arrow-down-circle"
                title="Jarak OFF (Stop)"
                subtitle={`Distance < ${t.jarak_off.toFixed(1)}cm → water ${waterDisplay(t.jarak_off)} — stop refill`}
                color={!autoEnabled ? Colors.textHint : (rules.water ? Colors.waterTeal : Colors.textHint)}
                bg={!autoEnabled ? Colors.cardBorder : (rules.water ? Colors.waterBg : Colors.cardBorder)}
                value={t.jarak_off}
                min={0.0}
                max={Math.max(0.1, t.jarak_on - 0.3)}
                step={0.1}
                displayValue={`${t.jarak_off.toFixed(1)} cm`}
                extraDisplay={waterDisplay(t.jarak_off)}
                onChange={(v) => setDraft((d) => d ? {...d, jarak_off: Math.round(v * 10) / 10} : null)}
                disabled={waterCannotEdit}
              />
              <View style={styles.previewRow}>
                <Ionicons name="information-circle" size={12} color={!autoEnabled ? Colors.textHint : Colors.waterTeal} />
                <Text style={styles.previewText}>
                  Refill activates at {waterDisplay(t.jarak_on)} water ({t.jarak_on.toFixed(1)}cm) and stops at {waterDisplay(t.jarak_off)} water ({t.jarak_off.toFixed(1)}cm)
                </Text>
              </View>
            </>
          }
        />

        {/* ════════════════════════════════════════════════════════════
           pH LEVEL CARD — toggle + ph_max slider + confirm
           ════════════════════════════════════════════════════════════
           💡 pH DOWN only: system only has a pH DOWN pump.
             - Pompa 2 ON when pH > pH Down Threshold
             - pH notifcations are sent when pH exceeds the threshold
           ════════════════════════════════════════════════════════════ */}
        <AutomationParamCard
          title="pH Level (DOWN)"
          subtitle="pH DOWN threshold for Pompa 2"
          icon="flask"
          gradient={[Colors.tempBlue, '#42A5F5'] as const}
          accentColor={Colors.tempBlue}
          bgColor={Colors.tempLight}
          ruleEnabled={rules.ph}
          onToggleRule={(v) => handleRuleToggle('ph', v)}
          hasChanges={hasPhChanges()}
          saving={savingPh}
          onConfirm={handlePhConfirm}
          disabled={!autoEnabled}
          confirmDisabled={!autoEnabled}
          sliders={
            <>
              <ParamSlider
                icon="arrow-up-circle"
                title="pH Down Threshold"
                subtitle={`pH > ${t.ph_max.toFixed(1)} → Pompa 2 ON (pH DOWN dosing starts)`}
                color={!autoEnabled ? Colors.textHint : (rules.ph ? Colors.tempBlue : Colors.textHint)}
                bg={!autoEnabled ? Colors.cardBorder : (rules.ph ? Colors.tempLight : Colors.cardBorder)}
                value={t.ph_max}
                min={Math.min(14, t.ph_min + 0.3)}
                max={14}
                step={0.1}
                displayValue={t.ph_max.toFixed(1)}
                onChange={(v) => setDraft((d) => d ? {...d, ph_max: Math.round(v * 10) / 10, ph_min: Math.min(d.ph_min ?? 5.5, Math.round((v - 0.3) * 10) / 10)} : null)}
                disabled={savingPh || !autoEnabled || !rules.ph}
              />
              <ParamSlider
                icon="arrow-down-circle"
                title="pH Minimum (Stop)"
                subtitle={`pH ≤ ${t.ph_min.toFixed(1)} → Pompa 2 OFF (pH sufficiently low)`}
                color={!autoEnabled ? Colors.textHint : (rules.ph ? Colors.tempBlue : Colors.textHint)}
                bg={!autoEnabled ? Colors.cardBorder : (rules.ph ? Colors.tempLight : Colors.cardBorder)}
                value={t.ph_min}
                min={0.3}
                max={Math.max(0.6, t.ph_max - 0.3)}
                step={0.1}
                displayValue={t.ph_min.toFixed(1)}
                onChange={(v) => setDraft((d) => d ? {...d, ph_min: Math.round(v * 10) / 10, ph_max: Math.max(d.ph_max ?? 6.5, Math.round((v + 0.3) * 10) / 10)} : null)}
                disabled={savingPh || !autoEnabled || !rules.ph}
              />
              <View style={styles.previewRow}>
                <Ionicons name="information-circle" size={12} color={!autoEnabled ? Colors.textHint : Colors.tempBlue} />
                <Text style={styles.previewText}>
                  Pompa 2 (pH DOWN) activates when pH exceeds {t.ph_max.toFixed(1)} and stays ON continuously — it stops only when pH drops to ≤ {t.ph_min.toFixed(1)}
                </Text>
              </View>
            </>
          }
        />

        {/* ════════════════════════════════════════════════════════════
           TDS CARD — toggle + tds sliders + confirm
           ════════════════════════════════════════════════════════════ */}
        <AutomationParamCard
          title="TDS (Nutrients)"
          subtitle="Total dissolved solids thresholds"
          icon="flask"
          gradient={[Colors.energyOrange, '#FFA726'] as const}
          accentColor={Colors.energyOrange}
          bgColor="#FFF3E0"
          ruleEnabled={rules.tds}
          onToggleRule={(v) => handleRuleToggle('tds', v)}
          hasChanges={hasTdsChanges()}
          saving={savingTds}
          onConfirm={handleTdsConfirm}
          disabled={!autoEnabled}
          confirmDisabled={!autoEnabled}
          sliders={
            <>
              <ParamSlider
                icon="arrow-down-circle"
                title="TDS ON (Dosing)"
                subtitle={`TDS < ${t.tds_on.toFixed(0)} ppm — nutrients low, activate Pompa 2`}
                color={!autoEnabled ? Colors.textHint : (rules.tds ? Colors.energyOrange : Colors.textHint)}
                bg={!autoEnabled ? Colors.cardBorder : (rules.tds ? '#FFF3E0' : Colors.cardBorder)}
                value={t.tds_on}
                min={0}
                max={Math.max(0, t.tds_off - 5)}
                step={5}
                displayValue={`${t.tds_on.toFixed(0)} ppm`}
                onChange={(v) => setDraft((d) => d ? {...d, tds_on: v, tds_off: Math.max(d.tds_off, v + 5)} : null)}
                disabled={savingTds || !autoEnabled || !rules.tds}
              />
              <ParamSlider
                icon="arrow-up-circle"
                title="TDS OFF (Stop)"
                subtitle={`TDS > ${t.tds_off.toFixed(0)} ppm — nutrients sufficient, stop Pompa 2`}
                color={!autoEnabled ? Colors.textHint : (rules.tds ? Colors.energyOrange : Colors.textHint)}
                bg={!autoEnabled ? Colors.cardBorder : (rules.tds ? '#FFF3E0' : Colors.cardBorder)}
                value={t.tds_off}
                min={t.tds_on + 5}
                max={2000}
                step={5}
                displayValue={`${t.tds_off.toFixed(0)} ppm`}
                onChange={(v) => setDraft((d) => d ? {...d, tds_off: v, tds_on: Math.min(d.tds_on, v - 5)} : null)}
                disabled={savingTds || !autoEnabled || !rules.tds}
              />
              <View style={styles.previewRow}>
                <Ionicons name="information-circle" size={12} color={!autoEnabled ? Colors.textHint : Colors.energyOrange} />
                <Text style={styles.previewText}>
                  Nutrients dosing activates below {t.tds_on.toFixed(0)} ppm and stops above {t.tds_off.toFixed(0)} ppm
                </Text>
              </View>
            </>
          }
        />

        {/* ── Night Mode ── */}
        <View style={styles.section}>
          <SectionHeader icon="moon" colors={['#37474F', '#546E7A'] as const} title="Night Mode" badge={nightModeActive ? 'ACTIVE' : 'OFF'} dotColor={nightModeActive ? Colors.statusGreen : Colors.textHint} textColor={nightModeActive ? Colors.deepGreen : Colors.textSecondary} bgColor={nightModeActive ? '#E8F5E9' : '#FFF3E0'} />
          <View style={styles.masterRow}>
            <View style={[styles.masterIconWrap, {backgroundColor: nightModeActive ? '#37474F' + '20' : Colors.cardBorder}]}>
              <Ionicons name="moon" size={24} color={nightModeActive ? '#37474F' : Colors.textHint} />
            </View>
            <View style={{flex: 1}}>
              <Text style={styles.masterTitle}>{nightModeActive ? 'Night mode active' : 'Night mode inactive'}</Text>
              <Text style={styles.masterSub}>{nightModeActive ? 'All pumps OFF, automation paused. Only manual commands accepted.' : 'Activate to stop all pumps and disable automation (e.g. during dark hours).'}</Text>
            </View>
            <Switch value={nightModeActive} onValueChange={handleNightModeToggle} trackColor={{false: Colors.cardBorder, true: '#546E7A60'}} thumbColor={nightModeActive ? '#37474F' : '#ccc'} />
          </View>
        </View>

        {/* ── Device Status ── */}
        <View style={styles.section}>
          <SectionHeader icon="hardware-chip" colors={[Colors.accentGreen, Colors.primaryGreen] as const} title="Device Status" />
          <View style={styles.deviceRow}>
            <View style={styles.deviceInfo}><Text style={styles.deviceLabel}>Active Device</Text><Text style={styles.deviceValue}>{activeDeviceId}</Text></View>
            <View style={styles.deviceStatusRight}><View style={styles.deviceDot} /><Text style={styles.deviceStatusText}>Connected</Text></View>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// ============================================================================
// STYLES
// ============================================================================

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: Colors.background},
  content: {paddingBottom: 100},

  // Header
  header: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 4, marginBottom: 10},
  headerIcon: {borderRadius: 14, overflow: 'hidden', ...Shadows.subtle},
  headerIconGradient: {width: 44, height: 44, justifyContent: 'center', alignItems: 'center'},
  headerTitle: {fontSize: 22, fontWeight: '800', color: Colors.textPrimary, letterSpacing: -0.5},
  headerSub: {fontSize: 12, color: Colors.textSecondary, marginTop: 2},
  statusBadge: {flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10},
  statusDot: {width: 7, height: 7, borderRadius: 4},
  statusLabel: {fontSize: 10, fontWeight: '800', letterSpacing: 1},

  // Section wrapper (for master toggle, night mode, device status)
  section: {backgroundColor: '#FFFFFF', marginHorizontal: 16, borderRadius: 24, padding: 20, marginBottom: 14, shadowColor: Colors.primaryGreen, shadowOffset: {width: 0, height: 8}, shadowOpacity: 0.1, shadowRadius: 20, elevation: 6, borderWidth: 1, borderColor: 'rgba(46,125,50,0.1)'},
  masterRow: {flexDirection: 'row', alignItems: 'center', gap: 14},
  masterIconWrap: {width: 48, height: 48, borderRadius: 16, backgroundColor: Colors.solarLight, alignItems: 'center', justifyContent: 'center'},
  masterTitle: {fontSize: 15, fontWeight: '700', color: Colors.textPrimary},
  masterSub: {fontSize: 11, color: Colors.textSecondary, marginTop: 2, lineHeight: 16},

  // ── Unified parameter card ──
  paramCard: {marginHorizontal: 16, marginBottom: 14, borderRadius: 24, overflow: 'hidden', backgroundColor: '#FFFFFF', shadowColor: Colors.primaryGreen, shadowOffset: {width: 0, height: 8}, shadowOpacity: 0.1, shadowRadius: 20, elevation: 6, borderWidth: 1, borderColor: 'rgba(46,125,50,0.1)'},
  paramCardAccent: {height: 4},
  paramCardInner: {padding: 20},

  paramHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  paramHeaderLeft: {flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1},
  paramIconBadge: {width: 44, height: 44, borderRadius: 14, justifyContent: 'center', alignItems: 'center'},
  paramTitle: {fontSize: 17, fontWeight: '800', color: Colors.textPrimary, letterSpacing: -0.3},
  paramSubtitle: {fontSize: 10, color: Colors.textSecondary, marginTop: 1},
  paramToggleWrap: {marginLeft: 8},
  paramDivider: {height: 1, backgroundColor: Colors.cardBorder, marginVertical: 16},

  // Confirm button inside card
  paramConfirmBtn: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.primaryGreen, borderRadius: 14, paddingVertical: 14, gap: 8, marginTop: 4},
  paramConfirmText: {fontSize: 14, fontWeight: '700', color: '#FFFFFF', letterSpacing: 0.3},

  // Preview row (info line below sliders)
  previewRow: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4},
  previewText: {fontSize: 10, color: Colors.textSecondary, fontWeight: '500', flex: 1, lineHeight: 14},

  // Disabled banner (shown when auto-pump is OFF)
  disabledBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: 10, paddingHorizontal: 14,
    backgroundColor: '#F8F9FA', borderRadius: 12, marginBottom: 12,
  },
  disabledBannerText: {
    fontSize: 11, color: Colors.textHint, fontWeight: '600', flex: 1, lineHeight: 16,
  },
  disabledBannerDot: {
    width: 6, height: 6, borderRadius: 3, backgroundColor: '#D0D5DD',
  },

  // ── pH info ──
  phInfoContainer: {gap: 10},
  infoRow: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4},
  infoIcon: {width: 28, height: 28, borderRadius: 8, justifyContent: 'center', alignItems: 'center'},
  infoLabel: {fontSize: 12, color: Colors.textSecondary, fontWeight: '500', flex: 1},
  infoValue: {fontSize: 12, fontWeight: '700', textAlign: 'right'},
  phInfoNote: {flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 12, borderRadius: 12, marginTop: 4},
  phInfoNoteText: {fontSize: 11, color: Colors.textSecondary, fontWeight: '500', flex: 1, lineHeight: 16},

  // Device Status (shared with section)
  deviceRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  deviceInfo: {flex: 1},
  deviceLabel: {fontSize: 13, color: Colors.textSecondary, fontWeight: '500'},
  deviceValue: {fontSize: 15, fontWeight: '700', color: Colors.textPrimary, marginTop: 2},
  deviceStatusRight: {flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: Colors.paleGreen, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16},
  deviceDot: {width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.statusGreen},
  deviceStatusText: {fontSize: 11, fontWeight: '700', color: Colors.deepGreen},
});
