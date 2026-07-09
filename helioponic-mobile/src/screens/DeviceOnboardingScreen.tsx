import React, {useState} from 'react';
import {View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, ActivityIndicator} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {Ionicons} from '@expo/vector-icons';
import {devicesApi} from '../lib/apiClient';
import {useAuth} from '../context/AuthContext';
import {Colors, Shadows, BorderRadius} from '../context/ThemeContext';

export default function DeviceOnboardingScreen({navigation}: any) {
  const {refreshDevices} = useAuth();
  const [deviceId, setDeviceId] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [loading, setLoading] = useState(false);

  const handleAddDevice = async () => {
    if (!deviceId.trim()) {Alert.alert('Validation', 'Device ID is required'); return;}
    setLoading(true);
    try {
      await devicesApi.add({device_id: deviceId.trim(), name: deviceName.trim() || deviceId.trim()});
      await refreshDevices();
      Alert.alert('Success', 'Device added! You can now switch to it.');
    } catch (err: any) {Alert.alert('Error', err.message || 'Failed to add device');}
    finally {setLoading(false);}
  };

  return (
    <SafeAreaView style={{flex: 1, backgroundColor: Colors.background}} edges={['top']}>
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={() => navigation?.goBack()}><Ionicons name="chevron-back" size={22} color={Colors.primaryGreen} /></TouchableOpacity>
          <Text style={styles.headerTitle}>Add New Device</Text>
        </View>
        <View style={styles.card}>
          <View style={styles.iconContainer}><Ionicons name="hardware-chip" size={40} color={Colors.primaryGreen} /></View>
          <Text style={styles.title}>Add Your Device</Text>
          <Text style={styles.subtitle}>Enter the Device ID from your Helioponic hardware to get started.</Text>
          <TextInput style={styles.input} placeholder="Device ID (e.g. HELIO_001)" placeholderTextColor={Colors.textHint} autoCapitalize="characters" value={deviceId} onChangeText={setDeviceId} />
          <TextInput style={styles.input} placeholder="Device Name (optional)" placeholderTextColor={Colors.textHint} value={deviceName} onChangeText={setDeviceName} />
          <TouchableOpacity style={[styles.button, loading && styles.buttonDisabled]} onPress={handleAddDevice} disabled={loading}>
            {loading ? <ActivityIndicator color="#fff" /> : <><Ionicons name="checkmark-circle" size={18} color="#fff" /><Text style={styles.buttonText}>Register Device</Text></>}
          </TouchableOpacity>
          <TouchableOpacity style={styles.skipBtn} onPress={() => navigation?.goBack()}><Text style={styles.skipText}>I'll do this later</Text></TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: Colors.background},
  header: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8},
  backBtn: {padding: 4},
  headerTitle: {fontSize: 20, fontWeight: '800', color: Colors.textPrimary, letterSpacing: -0.5},
  card: {backgroundColor: Colors.surface, borderRadius: BorderRadius.bento, padding: 32, alignItems: 'center', ...Shadows.card, marginHorizontal: 20, marginTop: 20},
  iconContainer: {width: 80, height: 80, borderRadius: 24, backgroundColor: Colors.paleGreen, alignItems: 'center', justifyContent: 'center', marginBottom: 16},
  title: {fontSize: 22, fontWeight: '800', color: Colors.textPrimary, marginBottom: 8},
  subtitle: {fontSize: 13, color: Colors.textSecondary, textAlign: 'center', marginBottom: 24},
  input: {width: '100%', backgroundColor: Colors.background, borderRadius: BorderRadius.button, paddingHorizontal: 16, paddingVertical: 14, fontSize: 14, color: Colors.textPrimary, marginBottom: 12, borderWidth: 1, borderColor: Colors.cardBorder},
  button: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%', backgroundColor: Colors.primaryGreen, borderRadius: BorderRadius.button, paddingVertical: 14, marginTop: 8},
  buttonDisabled: {opacity: 0.6},
  buttonText: {color: '#fff', fontWeight: '700', fontSize: 15},
  skipBtn: {marginTop: 16, paddingVertical: 8},
  skipText: {fontSize: 13, color: Colors.textHint, fontWeight: '500'},
});
