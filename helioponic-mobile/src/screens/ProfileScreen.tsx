import React, {useState} from 'react';
import {View, Text, ScrollView, StyleSheet, TouchableOpacity, Alert, TextInput, ActivityIndicator, Modal} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import {Ionicons} from '@expo/vector-icons';
import {useAuth} from '../context/AuthContext';
import {devicesApi, authApi} from '../lib/apiClient';
import {SectionHeader} from '../components/SectionHeader';
import {Colors} from '../context/ThemeContext';

type EditMode = 'none' | 'profile' | 'password';

export default function ProfileScreen({navigation}: any) {
  const {state, logout, switchDevice, refreshDevices, updateProfileData} = useAuth();
  const [editMode, setEditMode] = useState<EditMode>('none');
  const [name, setName] = useState(state.name || '');
  const [email, setEmail] = useState(state.email || '');
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showOldPw, setShowOldPw] = useState(false);
  const [showNewPw, setShowNewPw] = useState(false);
  const [showConfirmPw, setShowConfirmPw] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showDeletePrompt, setShowDeletePrompt] = useState(false);
  const [deleteInput, setDeleteInput] = useState('');
  const [showDeviceDeleteModal, setShowDeviceDeleteModal] = useState(false);
  const [deleteDevice, setDeleteDevice] = useState<{deviceId: string; name: string} | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');

  const handleSaveProfile = async () => {
    if (!name.trim()) {Alert.alert('Validation', 'Name is required'); return;}
    if (!email.trim() || !email.includes('@')) {Alert.alert('Validation', 'Valid email is required'); return;}
    setSaving(true);
    try {await authApi.updateProfile({name: name.trim(), email: email.trim()}); updateProfileData(name.trim(), email.trim()); Alert.alert('Success', 'Profile updated successfully'); setEditMode('none');}
    catch (err: any) {Alert.alert('Error', err.message || 'Failed to update profile');}
    finally {setSaving(false);}
  };

  const handleSavePassword = async () => {
    if (!oldPassword) {Alert.alert('Validation', 'Current password is required'); return;}
    if (newPassword.length < 6) {Alert.alert('Validation', 'New password must be at least 6 characters'); return;}
    if (newPassword !== confirmPassword) {Alert.alert('Validation', 'Passwords do not match'); return;}
    setSaving(true);
    try {await authApi.updatePassword({old_password: oldPassword, new_password: newPassword}); Alert.alert('Success', 'Password updated successfully'); setEditMode('none'); setOldPassword(''); setNewPassword(''); setConfirmPassword('');}
    catch (err: any) {Alert.alert('Error', err.message || 'Failed to update password');}
    finally {setSaving(false);}
  };

  const handleDeleteAccount = () => {
    if (deleteInput.trim().toLowerCase() !== 'delete my account') {Alert.alert('Confirmation Required', 'Please type "delete my account" exactly to confirm.'); return;}
    Alert.alert('Final Warning', 'This action is irreversible. All your devices, sensor data, water history, and thresholds will be permanently erased.', [
      {text: 'Cancel', style: 'cancel', onPress: () => {setShowDeletePrompt(false); setDeleteInput('');}},
      {text: 'Permanently Delete', style: 'destructive', onPress: async () => {
        setDeleting(true);
        try {await authApi.deleteAccount(); Alert.alert('Account Deleted', 'Your account has been permanently removed.'); logout();}
        catch (err: any) {Alert.alert('Error', err.message || 'Failed to delete account');}
        finally {setDeleting(false); setShowDeletePrompt(false); setDeleteInput('');}
      }},
    ]);
  };

  const initiateDeviceDeletion = (deviceId: string, deviceName: string) => {setDeleteDevice({deviceId, name: deviceName}); setDeleteConfirmText(''); setShowDeviceDeleteModal(true);};

  const confirmDeviceDeletion = async () => {
    if (!deleteDevice) return;
    const expected = `delete_${deleteDevice.name || deleteDevice.deviceId}`;
    if (deleteConfirmText.trim() !== expected) {Alert.alert('Incorrect', `Type "${expected}" exactly to confirm deletion.`); return;}
    try {
      await devicesApi.remove(deleteDevice.deviceId);
      if (deleteDevice.deviceId === state.activeDeviceId) {const remaining = state.devices.filter((d) => d.deviceId !== deleteDevice.deviceId); if (remaining.length > 0) switchDevice(remaining[0].deviceId);}
      await refreshDevices(); setShowDeviceDeleteModal(false); setDeleteDevice(null); Alert.alert('Removed', 'Device deleted successfully.');
    } catch (err: any) {Alert.alert('Error', err.message || 'Failed to remove device');}
  };

  const handleLogout = () => {Alert.alert('Sign Out', 'Are you sure?', [{text: 'Cancel', style: 'cancel'}, {text: 'Sign Out', style: 'destructive', onPress: () => logout()}]);};

  const initials = (state.name || state.email || 'U').split(' ').map((s) => s[0]).join('').toUpperCase().slice(0, 2);

  return (
    <SafeAreaView style={{flex: 1, backgroundColor: Colors.background}} edges={['top']}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={() => navigation?.goBack()}><Ionicons name="chevron-back" size={22} color={Colors.primaryGreen} /></TouchableOpacity>
          <View style={styles.headerIcon}><LinearGradient colors={[Colors.primaryGreen, Colors.deepGreen] as const} start={{x: 0, y: 0}} end={{x: 1, y: 1}} style={styles.headerIconGradient}><Ionicons name="person" size={20} color="#fff" /></LinearGradient></View>
          <Text style={styles.headerTitle}>Profile & Devices</Text>
        </View>

        <View style={styles.section}>
          <View style={styles.avatarRow}>
            <LinearGradient colors={[Colors.primaryGreen, Colors.deepGreen] as const} start={{x: 0, y: 0}} end={{x: 1, y: 1}} style={styles.avatar}><Text style={styles.avatarText}>{initials || 'U'}</Text></LinearGradient>
            <View style={styles.avatarInfo}><Text style={styles.userName}>{state.name || 'User'}</Text><Text style={styles.userEmail}>{state.email}</Text><TouchableOpacity style={styles.editProfileBtn} onPress={() => setEditMode(editMode === 'profile' ? 'none' : 'profile')}><Ionicons name={editMode === 'profile' ? 'close' : 'create-outline'} size={14} color={Colors.primaryGreen} /><Text style={styles.editProfileText}>{editMode === 'profile' ? 'Cancel' : 'Edit Profile'}</Text></TouchableOpacity></View>
          </View>
        </View>

        {editMode === 'profile' && (
          <View style={styles.section}>
            <Text style={styles.formTitle}>Edit Profile</Text>
            <View style={styles.inputGroup}><Text style={styles.inputLabel}>Name</Text><TextInput style={styles.input} value={name} onChangeText={setName} placeholder="Your name" placeholderTextColor={Colors.textHint} /></View>
            <View style={styles.inputGroup}><Text style={styles.inputLabel}>Email</Text><TextInput style={styles.input} value={email} onChangeText={setEmail} placeholder="email@example.com" placeholderTextColor={Colors.textHint} keyboardType="email-address" autoCapitalize="none" /></View>
            <TouchableOpacity style={[styles.saveBtn, saving && {opacity: 0.6}]} onPress={handleSaveProfile} disabled={saving}>{saving ? <ActivityIndicator size="small" color="#FFF" /> : <Text style={styles.saveBtnText}>Save Changes</Text>}</TouchableOpacity>
          </View>
        )}

        {editMode === 'password' && (
          <View style={styles.section}>
            <Text style={styles.formTitle}>Change Password</Text>
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Current Password</Text>
              <View style={styles.pwContainer}>
                <TextInput style={styles.pwInput} value={oldPassword} onChangeText={setOldPassword} placeholder="Enter current password" placeholderTextColor={Colors.textHint} secureTextEntry={!showOldPw} />
                <TouchableOpacity style={styles.pwToggle} onPress={() => setShowOldPw(!showOldPw)}>
                  <Ionicons name={showOldPw ? 'eye-off' : 'eye'} size={20} color={Colors.textHint} />
                </TouchableOpacity>
              </View>
            </View>
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>New Password</Text>
              <View style={styles.pwContainer}>
                <TextInput style={styles.pwInput} value={newPassword} onChangeText={setNewPassword} placeholder="Min. 6 characters" placeholderTextColor={Colors.textHint} secureTextEntry={!showNewPw} />
                <TouchableOpacity style={styles.pwToggle} onPress={() => setShowNewPw(!showNewPw)}>
                  <Ionicons name={showNewPw ? 'eye-off' : 'eye'} size={20} color={Colors.textHint} />
                </TouchableOpacity>
              </View>
            </View>
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Confirm New Password</Text>
              <View style={styles.pwContainer}>
                <TextInput style={styles.pwInput} value={confirmPassword} onChangeText={setConfirmPassword} placeholder="Repeat new password" placeholderTextColor={Colors.textHint} secureTextEntry={!showConfirmPw} />
                <TouchableOpacity style={styles.pwToggle} onPress={() => setShowConfirmPw(!showConfirmPw)}>
                  <Ionicons name={showConfirmPw ? 'eye-off' : 'eye'} size={20} color={Colors.textHint} />
                </TouchableOpacity>
              </View>
            </View>
            <TouchableOpacity style={[styles.saveBtn, saving && {opacity: 0.6}]} onPress={handleSavePassword} disabled={saving}>{saving ? <ActivityIndicator size="small" color="#FFF" /> : <Text style={styles.saveBtnText}>Update Password</Text>}</TouchableOpacity>
          </View>
        )}

        {editMode === 'none' && (
          <View style={styles.section}><TouchableOpacity style={styles.signOutRow} onPress={() => setEditMode('password')}><View style={[styles.signOutIconWrap, {backgroundColor: Colors.tempBlue + '18'}]}><Ionicons name="lock-closed" size={20} color={Colors.tempBlue} /></View><Text style={[styles.signOutText, {color: Colors.tempBlue}]}>Change Password</Text><Ionicons name="chevron-forward" size={18} color={Colors.textHint} /></TouchableOpacity></View>
        )}

        <View style={styles.section}>
          <SectionHeader icon="hardware-chip" colors={[Colors.accentGreen, Colors.primaryGreen] as const} title={`My Devices (${state.devices.length})`} />
          {state.devices.map((device) => (
            <TouchableOpacity key={device.deviceId} style={[styles.deviceRow, device.deviceId === state.activeDeviceId && styles.deviceRowActive]} onPress={() => {switchDevice(device.deviceId); navigation?.goBack();}}>
              <View style={[styles.deviceDot, {backgroundColor: device.isActive ? Colors.statusGreen : Colors.textHint}]} />
              <View style={{flex: 1}}><Text style={styles.deviceName}>{device.name || device.deviceId}</Text><Text style={styles.deviceIdText}>{device.deviceId}</Text></View>
              <View style={{flexDirection: 'row', alignItems: 'center', gap: 8}}>
                {device.deviceId === state.activeDeviceId && <Ionicons name="checkmark-circle" size={20} color={Colors.primaryGreen} />}
                <TouchableOpacity style={styles.deleteBtn} onPress={() => initiateDeviceDeletion(device.deviceId, device.name)}><Ionicons name="trash-outline" size={16} color={Colors.statusRed} /></TouchableOpacity>
              </View>
            </TouchableOpacity>
          ))}
          <TouchableOpacity style={styles.addDeviceBtn} onPress={() => navigation?.navigate('DeviceOnboarding')}><Ionicons name="add-circle" size={20} color={Colors.primaryGreen} /><Text style={styles.addDeviceText}>Add New Device</Text></TouchableOpacity>
        </View>

        <View style={styles.section}><TouchableOpacity style={styles.signOutRow} onPress={handleLogout}><View style={styles.signOutIconWrap}><Ionicons name="log-out" size={20} color={Colors.statusRed} /></View><Text style={styles.signOutText}>Sign Out</Text><Ionicons name="chevron-forward" size={18} color={Colors.textHint} /></TouchableOpacity></View>

        <View style={styles.section}><TouchableOpacity style={styles.signOutRow} onPress={() => setShowDeletePrompt(true)}><View style={[styles.signOutIconWrap, {backgroundColor: Colors.statusRed + '18'}]}><Ionicons name="trash" size={20} color={Colors.statusRed} /></View><Text style={[styles.signOutText, {color: Colors.statusRed}]}>Delete Account</Text><Ionicons name="chevron-forward" size={18} color={Colors.textHint} /></TouchableOpacity></View>

        <View style={{height: 40}} />
      </ScrollView>

      <Modal visible={showDeviceDeleteModal} transparent animationType="fade">
        <View style={styles.overlay}>
          <View style={styles.modal}>
            <View style={styles.modalHeader}><View style={[styles.modalIcon, {backgroundColor: Colors.statusRed + '18'}]}><Ionicons name="warning" size={24} color={Colors.statusRed} /></View></View>
            <Text style={styles.modalTitle}>Remove Device</Text>
            <Text style={styles.modalDesc}>This will permanently delete all sensor data and water history for this device.</Text>
            <Text style={styles.modalHint}>Type <Text style={{fontWeight: '800'}}>delete_{deleteDevice?.name || deleteDevice?.deviceId}</Text> to confirm:</Text>
            <TextInput style={styles.modalInput} value={deleteConfirmText} onChangeText={setDeleteConfirmText} placeholder={`delete_${deleteDevice?.name || deleteDevice?.deviceId}`} placeholderTextColor={Colors.textHint} autoCapitalize="none" />
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalCancel} onPress={() => {setShowDeviceDeleteModal(false); setDeleteDevice(null);}}><Text style={styles.modalCancelText}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity style={[styles.modalConfirm, {opacity: deleteConfirmText.trim() === `delete_${deleteDevice?.name || deleteDevice?.deviceId}` ? 1 : 0.4}]} onPress={confirmDeviceDeletion} disabled={deleteConfirmText.trim() !== `delete_${deleteDevice?.name || deleteDevice?.deviceId}`}><Text style={styles.modalConfirmText}>Delete</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={showDeletePrompt} transparent animationType="fade">
        <View style={styles.overlay}>
          <View style={styles.modal}>
            <View style={styles.modalHeader}><View style={[styles.modalIcon, {backgroundColor: Colors.statusRed + '18'}]}><Ionicons name="warning" size={24} color={Colors.statusRed} /></View></View>
            <Text style={styles.modalTitle}>Delete Account</Text>
            <Text style={styles.modalDesc}>This permanently removes your account, all devices, sensor readings, and water history. This cannot be undone.</Text>
            <Text style={styles.modalHint}>Type <Text style={{fontWeight: '800'}}>delete my account</Text> to confirm:</Text>
            <TextInput style={styles.modalInput} value={deleteInput} onChangeText={setDeleteInput} placeholder="delete my account" placeholderTextColor={Colors.textHint} autoCapitalize="none" />
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalCancel} onPress={() => {setShowDeletePrompt(false); setDeleteInput('');}}><Text style={styles.modalCancelText}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity style={[styles.modalConfirmDanger, {opacity: deleteInput.trim().toLowerCase() === 'delete my account' ? 1 : 0.4}]} onPress={handleDeleteAccount} disabled={deleteInput.trim().toLowerCase() !== 'delete my account' || deleting}>{deleting ? <ActivityIndicator size="small" color="#FFF" /> : <Text style={styles.modalConfirmText}>Delete Forever</Text>}</TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: Colors.background},
  content: {paddingBottom: 100},
  header: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8},
  backBtn: {padding: 4},
  headerIcon: {borderRadius: 12, overflow: 'hidden'},
  headerIconGradient: {width: 36, height: 36, justifyContent: 'center', alignItems: 'center'},
  headerTitle: {fontSize: 20, fontWeight: '800', color: Colors.textPrimary, letterSpacing: -0.5},
  section: {backgroundColor: '#FFFFFF', marginHorizontal: 16, borderRadius: 24, padding: 20, marginBottom: 14, shadowColor: Colors.primaryGreen, shadowOffset: {width: 0, height: 8}, shadowOpacity: 0.1, shadowRadius: 20, elevation: 6, borderWidth: 1, borderColor: 'rgba(46,125,50,0.1)'},
  avatarRow: {flexDirection: 'row', alignItems: 'center', gap: 16},
  avatar: {width: 68, height: 68, borderRadius: 34, alignItems: 'center', justifyContent: 'center', shadowColor: Colors.primaryGreen, shadowOffset: {width: 0, height: 6}, shadowOpacity: 0.3, shadowRadius: 12, elevation: 8},
  avatarText: {fontSize: 28, fontWeight: '800', color: '#fff'},
  avatarInfo: {flex: 1},
  userName: {fontSize: 20, fontWeight: '700', color: Colors.textPrimary, letterSpacing: -0.3},
  userEmail: {fontSize: 13, color: Colors.textSecondary, marginTop: 4},
  editProfileBtn: {flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 8},
  editProfileText: {fontSize: 12, fontWeight: '600', color: Colors.primaryGreen},
  formTitle: {fontSize: 16, fontWeight: '700', color: Colors.textPrimary, marginBottom: 16, letterSpacing: -0.3},
  inputGroup: {marginBottom: 14},
  inputLabel: {fontSize: 12, fontWeight: '600', color: Colors.textSecondary, marginBottom: 6},
  input: {backgroundColor: '#F8F9FA', borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14, fontSize: 15, fontWeight: '500', color: Colors.textPrimary, borderWidth: 1, borderColor: Colors.cardBorder},
  pwContainer: {flexDirection: 'row', alignItems: 'center', backgroundColor: '#F8F9FA', borderRadius: 14, borderWidth: 1, borderColor: Colors.cardBorder},
  pwInput: {flex: 1, paddingHorizontal: 16, paddingVertical: 14, fontSize: 15, fontWeight: '500', color: Colors.textPrimary},
  pwToggle: {paddingHorizontal: 14, paddingVertical: 10},
  saveBtn: {backgroundColor: Colors.primaryGreen, borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginTop: 8, shadowColor: Colors.primaryGreen, shadowOffset: {width: 0, height: 4}, shadowOpacity: 0.2, shadowRadius: 8, elevation: 4},
  saveBtnText: {fontSize: 15, fontWeight: '700', color: '#FFF', letterSpacing: 0.3},
  deviceRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, paddingHorizontal: 14, borderRadius: 14, marginBottom: 8},
  deviceRowActive: {backgroundColor: Colors.paleGreen},
  deviceDot: {width: 10, height: 10, borderRadius: 5},
  deviceName: {fontSize: 14, fontWeight: '600', color: Colors.textPrimary},
  deviceIdText: {fontSize: 11, color: Colors.textHint, marginTop: 2},
  deleteBtn: {width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.statusRed + '18'},
  addDeviceBtn: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, borderRadius: 14, marginTop: 4, borderWidth: 1.5, borderColor: Colors.primaryGreen + '30', borderStyle: 'dashed'},
  addDeviceText: {fontSize: 14, fontWeight: '600', color: Colors.primaryGreen},
  signOutRow: {flexDirection: 'row', alignItems: 'center', gap: 12},
  signOutIconWrap: {width: 36, height: 36, borderRadius: 12, backgroundColor: Colors.statusRed + '18', alignItems: 'center', justifyContent: 'center'},
  signOutText: {flex: 1, fontSize: 16, fontWeight: '700', color: Colors.statusRed},
  overlay: {flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 24},
  modal: {backgroundColor: '#FFFFFF', borderRadius: 28, padding: 28, width: '100%', maxWidth: 360, shadowColor: '#000', shadowOffset: {width: 0, height: 12}, shadowOpacity: 0.2, shadowRadius: 28, elevation: 16},
  modalHeader: {alignItems: 'center', marginBottom: 12},
  modalIcon: {width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center'},
  modalTitle: {fontSize: 20, fontWeight: '800', color: Colors.textPrimary, textAlign: 'center', letterSpacing: -0.5},
  modalDesc: {fontSize: 13, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20, marginTop: 8, marginBottom: 16},
  modalHint: {fontSize: 12, color: Colors.textHint, marginBottom: 8},
  modalInput: {backgroundColor: '#F8F9FA', borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14, fontSize: 14, fontWeight: '500', color: Colors.textPrimary, borderWidth: 1, borderColor: Colors.cardBorder, marginBottom: 20},
  modalActions: {flexDirection: 'row', gap: 12},
  modalCancel: {flex: 1, paddingVertical: 14, borderRadius: 14, backgroundColor: '#F1F3F5', alignItems: 'center'},
  modalCancelText: {fontSize: 14, fontWeight: '700', color: Colors.textSecondary},
  modalConfirm: {flex: 1, paddingVertical: 14, borderRadius: 14, backgroundColor: Colors.statusRed, alignItems: 'center'},
  modalConfirmDanger: {flex: 1, paddingVertical: 14, borderRadius: 14, backgroundColor: Colors.statusRed, alignItems: 'center'},
  modalConfirmText: {fontSize: 14, fontWeight: '700', color: '#FFF'},
});
