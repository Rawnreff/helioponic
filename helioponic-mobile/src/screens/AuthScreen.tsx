import React, {useState, useCallback} from 'react';
import {View, Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator, Alert} from 'react-native';
import {LinearGradient} from 'expo-linear-gradient';
import {useAuth} from '../context/AuthContext';
import {Colors, Shadows, BorderRadius} from '../context/ThemeContext';

export default function AuthScreen() {
  const {login, register} = useAuth();
  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [loading, setLoading] = useState(false);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [regName, setRegName] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regDeviceId, setRegDeviceId] = useState('');

  const handleLogin = useCallback(async () => {
    if (!loginEmail.trim() || !loginPassword) {Alert.alert('Validation', 'Email and password are required'); return;}
    setLoading(true);
    try {await login(loginEmail.trim(), loginPassword);}
    catch (err: any) {Alert.alert('Login Failed', err.message || 'Please check your credentials');}
    finally {setLoading(false);}
  }, [loginEmail, loginPassword, login]);

  const handleRegister = useCallback(async () => {
    if (!regName.trim() || !regEmail.trim() || !regPassword || !regDeviceId.trim()) {Alert.alert('Validation', 'All fields are required'); return;}
    if (regPassword.length < 6) {Alert.alert('Validation', 'Password must be at least 6 characters'); return;}
    setLoading(true);
    try {await register(regName.trim(), regEmail.trim(), regPassword, regDeviceId.trim());}
    catch (err: any) {Alert.alert('Registration Failed', err.message || 'Please try again');}
    finally {setLoading(false);}
  }, [regName, regEmail, regPassword, regDeviceId, register]);

  return (
    <KeyboardAvoidingView style={styles.container} behavior="padding" keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 24}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.logoContainer}>
          <LinearGradient colors={[Colors.primaryGreen, Colors.deepGreen]} start={{x: 0, y: 0}} end={{x: 1, y: 1}} style={styles.logo}>
            <Text style={styles.logoIcon}>🌿</Text>
          </LinearGradient>
          <Text style={styles.appName}>Helioponic</Text>
          <Text style={styles.tagline}>Solar-Powered Smart Hydroponics</Text>
        </View>
        <View style={styles.card}>
          <View style={styles.tabBar}>
            <TouchableOpacity style={[styles.tab, tab === 'login' && styles.tabActive]} onPress={() => setTab('login')}>
              <Text style={[styles.tabText, tab === 'login' && styles.tabTextActive]}>Sign In</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.tab, tab === 'register' && styles.tabActive]} onPress={() => setTab('register')}>
              <Text style={[styles.tabText, tab === 'register' && styles.tabTextActive]}>Register</Text>
            </TouchableOpacity>
          </View>
          {tab === 'login' ? (
            <View style={styles.form}>
              <Text style={styles.formTitle}>Welcome back</Text>
              <Text style={styles.formSubtitle}>Sign in to monitor your crops</Text>
              <TextInput style={styles.input} placeholder="Email" placeholderTextColor={Colors.textHint} keyboardType="email-address" autoCapitalize="none" value={loginEmail} onChangeText={setLoginEmail} />
              <TextInput style={styles.input} placeholder="Password" placeholderTextColor={Colors.textHint} secureTextEntry value={loginPassword} onChangeText={setLoginPassword} />
              <TouchableOpacity style={[styles.button, loading && styles.buttonDisabled]} onPress={handleLogin} disabled={loading}>
                {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign In</Text>}
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.form}>
              <Text style={styles.formTitle}>Create Account</Text>
              <Text style={styles.formSubtitle}>Set up your hydroponic system</Text>
              <TextInput style={styles.input} placeholder="Name" placeholderTextColor={Colors.textHint} value={regName} onChangeText={setRegName} />
              <TextInput style={styles.input} placeholder="Email" placeholderTextColor={Colors.textHint} keyboardType="email-address" autoCapitalize="none" value={regEmail} onChangeText={setRegEmail} />
              <TextInput style={styles.input} placeholder="Password (min 6 chars)" placeholderTextColor={Colors.textHint} secureTextEntry value={regPassword} onChangeText={setRegPassword} />
              <TextInput style={styles.input} placeholder="Device ID (e.g. HELIO_001)" placeholderTextColor={Colors.textHint} autoCapitalize="characters" value={regDeviceId} onChangeText={setRegDeviceId} />
              <TouchableOpacity style={[styles.button, loading && styles.buttonDisabled]} onPress={handleRegister} disabled={loading}>
                {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Create Account</Text>}
              </TouchableOpacity>
            </View>
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: Colors.background},
  scroll: {flexGrow: 1, justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 40},
  logoContainer: {alignItems: 'center', marginBottom: 32},
  logo: {width: 72, height: 72, borderRadius: 24, alignItems: 'center', justifyContent: 'center', marginBottom: 12, ...Shadows.elevated},
  logoIcon: {fontSize: 32},
  appName: {fontSize: 28, fontWeight: '800', color: Colors.textPrimary, letterSpacing: -0.5},
  tagline: {fontSize: 13, color: Colors.textSecondary, marginTop: 4},
  card: {backgroundColor: Colors.surface, borderRadius: BorderRadius.bento, padding: 4, ...Shadows.card},
  tabBar: {flexDirection: 'row', backgroundColor: Colors.background, borderRadius: BorderRadius.chip, padding: 4, margin: 12},
  tab: {flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: BorderRadius.chip - 2},
  tabActive: {backgroundColor: Colors.surface, ...Shadows.subtle},
  tabText: {fontSize: 14, fontWeight: '500', color: Colors.textSecondary},
  tabTextActive: {fontWeight: '700', color: Colors.primaryGreen},
  form: {padding: 20},
  formTitle: {fontSize: 18, fontWeight: '700', color: Colors.textPrimary},
  formSubtitle: {fontSize: 12, color: Colors.textSecondary, marginBottom: 20, marginTop: 4},
  input: {backgroundColor: Colors.background, borderRadius: BorderRadius.button, paddingHorizontal: 16, paddingVertical: 14, fontSize: 14, color: Colors.textPrimary, marginBottom: 12, borderWidth: 1, borderColor: Colors.cardBorder},
  button: {backgroundColor: Colors.primaryGreen, borderRadius: BorderRadius.button, paddingVertical: 14, alignItems: 'center', marginTop: 8},
  buttonDisabled: {opacity: 0.6},
  buttonText: {color: '#fff', fontWeight: '700', fontSize: 15, letterSpacing: 0.3},
});
