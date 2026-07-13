import React, {useEffect, useState, useCallback} from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  ActivityIndicator, Alert, RefreshControl, Modal,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import {Ionicons} from '@expo/vector-icons';
import {useAuth} from '../context/AuthContext';
import {notificationsApi} from '../lib/apiClient';
import {useNotificationStore} from '../store/notificationStore';
import {SectionHeader} from '../components/SectionHeader';
import {Colors, Shadows} from '../context/ThemeContext';

function formatTime(isoString: string | null): string {
  if (!isoString) return '';
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString('en-US', {month: 'short', day: 'numeric'});
}

function getPriorityColor(priority: string): string {
  switch (priority) {
    case 'high': return Colors.statusRed;
    case 'medium': return Colors.solarAmber;
    case 'low': return Colors.primaryGreen;
    default: return Colors.primaryGreen;
  }
}

function getTypeIcon(type: string): string {
  switch (type) {
    case 'auto_mode': return 'flash';
    case 'alarm': return 'warning';
    case 'info': return 'information-circle';
    default: return 'notifications';
  }
}

function getTypeBg(type: string): string {
  switch (type) {
    case 'auto_mode': return Colors.solarLight;
    case 'alarm': return '#FFEBEE';
    case 'info': return Colors.tempLight;
    default: return Colors.paleGreen;
  }
}

function getTypeColor(type: string): string {
  switch (type) {
    case 'auto_mode': return Colors.solarAmber;
    case 'alarm': return Colors.statusRed;
    case 'info': return Colors.tempBlue;
    default: return Colors.primaryGreen;
  }
}

export default function NotificationsScreen({navigation}: any) {
  const {activeDeviceId} = useAuth();
  const {
    notifications, unreadCount, isLoading,
    setNotifications, setLoading, markAsRead, markAllAsRead,
  } = useNotificationStore();
  const [refreshing, setRefreshing] = useState(false);

  const fetchNotifications = useCallback(async (showLoader = true) => {
    if (showLoader) setLoading(true);
    try {
      const res = await notificationsApi.list(activeDeviceId, undefined, 50);
      setNotifications(res.data || []);
    } catch {
      // Silently fail — will retry on refresh
    } finally {
      if (showLoader) setLoading(false);
    }
  }, [activeDeviceId, setNotifications, setLoading]);

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchNotifications(false);
    setRefreshing(false);
  }, [fetchNotifications]);

  const handleMarkRead = useCallback(async (notificationId: string) => {
    // Optimistic UI update
    markAsRead(notificationId);
    try {
      await notificationsApi.markRead(notificationId);
    } catch {
      // Revert on failure — re-fetch
      fetchNotifications(false);
    }
  }, [markAsRead, fetchNotifications]);

  const handleMarkAllRead = useCallback(async () => {
    if (unreadCount === 0) return;
    Alert.alert(
      'Mark All as Read',
      `Mark all ${unreadCount} unread notifications as read?`,
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Mark Read',
          onPress: async () => {
            markAllAsRead();
            try {
              await notificationsApi.markAllRead(activeDeviceId);
            } catch {
              // Revert — re-fetch
              fetchNotifications(false);
            }
          },
        },
      ],
    );
  }, [unreadCount, markAllAsRead, activeDeviceId, fetchNotifications]);

  const handleTapMarkRead = useCallback((notificationId: string, title: string) => {
    Alert.alert('Mark as Read', `Mark "${title}" as read?`, [
      {text: 'Cancel', style: 'cancel'},
      {text: 'Read', onPress: () => handleMarkRead(notificationId)},
    ]);
  }, [handleMarkRead]);

  return (
    <SafeAreaView style={{flex: 1, backgroundColor: Colors.background}} edges={['top']}>
      <View style={styles.container}>
        {/* ── Header ─────────────────────────────── */}
        <View style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={() => navigation?.goBack()}>
            <Ionicons name="chevron-back" size={22} color={Colors.primaryGreen} />
          </TouchableOpacity>
          <View style={styles.headerIcon}>
            <LinearGradient
              colors={[Colors.solarAmber, Colors.solarYellow] as const}
              start={{x: 0, y: 0}} end={{x: 1, y: 1}}
              style={styles.headerIconGradient}
            >
              <Ionicons name="notifications" size={20} color="#fff" />
            </LinearGradient>
          </View>
          <View style={{flex: 1}}>
            <Text style={styles.headerTitle}>Notifications</Text>
            <Text style={styles.headerSub}>
              {unreadCount > 0 ? `${unreadCount} unread` : 'All caught up'}
            </Text>
          </View>
          {unreadCount > 0 && (
            <TouchableOpacity style={styles.markAllBtn} onPress={handleMarkAllRead}>
              <Ionicons name="checkmark-done" size={16} color={Colors.primaryGreen} />
              <Text style={styles.markAllText}>Mark all read</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* ── Loading ─────────────────────────────── */}
        {isLoading && notifications.length === 0 && (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={Colors.primaryGreen} />
            <Text style={styles.loadingText}>Loading notifications...</Text>
          </View>
        )}

        {/* ── Empty State ─────────────────────────── */}
        {!isLoading && notifications.length === 0 && (
          <View style={styles.emptyContainer}>
            <View style={styles.emptyIcon}>
              <Ionicons name="notifications-off-outline" size={56} color={Colors.textHint} />
            </View>
            <Text style={styles.emptyTitle}>No Notifications</Text>
            <Text style={styles.emptyDesc}>
              You'll see notifications here when{'\n'}
              pump states change automatically.
            </Text>
          </View>
        )}

        {/* ── Notification List ───────────────────── */}
        {notifications.length > 0 && (
          <ScrollView
            style={styles.list}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={Colors.primaryGreen}
                colors={[Colors.primaryGreen]}
              />
            }
          >
            {/* Unread Section */}
            {notifications.filter((n) => !n.read).length > 0 && (
              <View style={styles.sectionHeader}>
                <View style={styles.sectionDot} />
                <Text style={styles.sectionTitle}>New</Text>
                <View style={styles.sectionBadge}>
                  <Text style={styles.sectionBadgeText}>
                    {notifications.filter((n) => !n.read).length}
                  </Text>
                </View>
              </View>
            )}

            {notifications
              .filter((n) => !n.read)
              .map((notif) => (
                <TouchableOpacity
                  key={notif.id}
                  style={styles.notifCard}
                  activeOpacity={0.7}
                  onPress={() => handleTapMarkRead(notif.id, notif.title)}
                  onLongPress={() => handleMarkRead(notif.id)}
                >
                  <View style={styles.notifUnreadBar} />
                  <View style={[styles.notifIcon, {backgroundColor: getTypeBg(notif.type)}]}>
                    <Ionicons
                      name={getTypeIcon(notif.type) as any}
                      size={20}
                      color={getTypeColor(notif.type)}
                    />
                  </View>
                  <View style={styles.notifContent}>
                    <View style={styles.notifTitleRow}>
                      <Text style={styles.notifTitle} numberOfLines={1}>{notif.title}</Text>
                      <View style={[styles.priorityDot, {backgroundColor: getPriorityColor(notif.priority)}]} />
                    </View>
                    <Text style={styles.notifMessage} numberOfLines={2}>{notif.message}</Text>
                    <View style={styles.notifFooter}>
                      <Ionicons name="time-outline" size={10} color={Colors.textHint} />
                      <Text style={styles.notifTime}>{formatTime(notif.created_at)}</Text>
                      {notif.device_id && (
                        <>
                          <Ionicons name="hardware-chip" size={10} color={Colors.textHint} />
                          <Text style={styles.notifDevice}>{notif.device_id}</Text>
                        </>
                      )}
                    </View>
                  </View>
                  <TouchableOpacity
                    style={styles.readBtn}
                    onPress={() => handleMarkRead(notif.id)}
                    hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
                  >
                    <Ionicons name="checkmark-circle-outline" size={20} color={Colors.primaryGreen} />
                  </TouchableOpacity>
                </TouchableOpacity>
              ))}

            {/* Read Section (shown if there are read notifications) */}
            {notifications.filter((n) => n.read).length > 0 && (
              <View style={[styles.sectionHeader, {marginTop: 8}]}>
                <View style={[styles.sectionDot, {backgroundColor: Colors.textHint}]} />
                <Text style={[styles.sectionTitle, {color: Colors.textHint}]}>History</Text>
                <Text style={styles.sectionSub}>
                  {notifications.filter((n) => n.read).length} read
                </Text>
              </View>
            )}

            {notifications
              .filter((n) => n.read)
              .slice(0, 20)
              .map((notif) => (
                <TouchableOpacity
                  key={notif.id}
                  style={[styles.notifCard, styles.notifRead]}
                  activeOpacity={0.7}
                >
                  <View style={[styles.notifIcon, {backgroundColor: getTypeBg(notif.type)}]}>
                    <Ionicons
                      name={getTypeIcon(notif.type) as any}
                      size={18}
                      color={getTypeColor(notif.type) + '80'}
                    />
                  </View>
                  <View style={styles.notifContent}>
                    <View style={styles.notifTitleRow}>
                      <Text style={[styles.notifTitle, styles.notifReadText]} numberOfLines={1}>
                        {notif.title}
                      </Text>
                    </View>
                    <Text style={[styles.notifMessage, styles.notifReadText]} numberOfLines={1}>
                      {notif.message}
                    </Text>
                    <View style={styles.notifFooter}>
                      <Ionicons name="time-outline" size={10} color={Colors.textHint} />
                      <Text style={styles.notifTime}>{formatTime(notif.created_at)}</Text>
                    </View>
                  </View>
                  <Ionicons name="checkmark" size={16} color={Colors.textHint} />
                </TouchableOpacity>
              ))}

            <View style={{height: 40}} />
          </ScrollView>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: Colors.background},
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8,
  },
  backBtn: {padding: 4},
  headerIcon: {borderRadius: 12, overflow: 'hidden'},
  headerIconGradient: {width: 36, height: 36, justifyContent: 'center', alignItems: 'center'},
  headerTitle: {fontSize: 20, fontWeight: '800', color: Colors.textPrimary, letterSpacing: -0.5},
  headerSub: {fontSize: 11, color: Colors.textHint, marginTop: 2},
  markAllBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: Colors.paleGreen, paddingHorizontal: 10, paddingVertical: 8,
    borderRadius: 10, borderWidth: 1, borderColor: Colors.primaryGreen + '30',
  },
  markAllText: {fontSize: 11, fontWeight: '700', color: Colors.primaryGreen},
  loadingContainer: {alignItems: 'center', justifyContent: 'center', paddingVertical: 80},
  loadingText: {fontSize: 13, color: Colors.textHint, fontWeight: '500', marginTop: 12},
  emptyContainer: {alignItems: 'center', justifyContent: 'center', paddingVertical: 80, paddingHorizontal: 32},
  emptyIcon: {width: 96, height: 96, borderRadius: 48, backgroundColor: '#F1F3F5', alignItems: 'center', justifyContent: 'center', marginBottom: 16},
  emptyTitle: {fontSize: 20, fontWeight: '700', color: Colors.textPrimary, marginBottom: 8},
  emptyDesc: {fontSize: 13, color: Colors.textHint, fontWeight: '500', textAlign: 'center', lineHeight: 20},
  list: {flex: 1},
  listContent: {paddingHorizontal: 16, paddingTop: 12},
  sectionHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginBottom: 8, paddingHorizontal: 4,
  },
  sectionDot: {width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.solarAmber},
  sectionTitle: {fontSize: 13, fontWeight: '800', color: Colors.textPrimary, letterSpacing: 0.3},
  sectionBadge: {
    backgroundColor: Colors.solarAmber, borderRadius: 8,
    paddingHorizontal: 7, paddingVertical: 2,
  },
  sectionBadgeText: {fontSize: 10, fontWeight: '800', color: '#fff'},
  sectionSub: {fontSize: 11, color: Colors.textHint, fontWeight: '500', flex: 1, textAlign: 'right'},
  notifCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#FFFFFF', borderRadius: 18, padding: 14,
    marginBottom: 8, borderWidth: 1, borderColor: 'rgba(0,0,0,0.05)',
    shadowColor: Colors.primaryGreen, shadowOffset: {width: 0, height: 4},
    shadowOpacity: 0.08, shadowRadius: 12, elevation: 3,
    position: 'relative', overflow: 'hidden',
  },
  notifRead: {opacity: 0.75, backgroundColor: '#F8F9FA'},
  notifUnreadBar: {
    position: 'absolute', left: 0, top: 0, bottom: 0,
    width: 3, backgroundColor: Colors.primaryGreen,
    borderTopLeftRadius: 18, borderBottomLeftRadius: 18,
  },
  notifIcon: {width: 40, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center'},
  notifContent: {flex: 1},
  notifTitleRow: {flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 3},
  notifTitle: {fontSize: 14, fontWeight: '700', color: Colors.textPrimary, flex: 1},
  notifReadText: {color: Colors.textSecondary},
  priorityDot: {width: 6, height: 6, borderRadius: 3},
  notifMessage: {fontSize: 12, color: Colors.textSecondary, lineHeight: 16, marginBottom: 6},
  notifFooter: {flexDirection: 'row', alignItems: 'center', gap: 4},
  notifTime: {fontSize: 10, color: Colors.textHint, fontWeight: '500'},
  notifDevice: {fontSize: 10, color: Colors.textHint, fontWeight: '500'},
  readBtn: {padding: 4},
});
