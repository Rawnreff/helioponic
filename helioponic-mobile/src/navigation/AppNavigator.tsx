import React from 'react';
import {View, Text, StyleSheet, Platform, Dimensions} from 'react-native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import {LinearGradient} from 'expo-linear-gradient';
import {Ionicons} from '@expo/vector-icons';
import {useAuth} from '../context/AuthContext';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {Colors} from '../context/ThemeContext';
import {RootStackParamList, MainTabParamList} from '../types/navigation';
import {WebSocketProvider} from '../context/WebSocketContext';
import {useNotificationStore} from '../store/notificationStore';

import AuthScreen from '../screens/AuthScreen';
import DashboardScreen from '../screens/DashboardScreen';
import PIDScreen from '../screens/PIDScreen';
import AutomationScreen from '../screens/AutomationScreen';
import AnalyticsScreen from '../screens/AnalyticsScreen';
import ProfileScreen from '../screens/ProfileScreen';
import NotificationsScreen from '../screens/NotificationsScreen';
import DeviceOnboardingScreen from '../screens/DeviceOnboardingScreen';

const {width: screenWidth} = Dimensions.get('window');
const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<MainTabParamList>();
const isSmallScreen = screenWidth < 375;
const tabBarH = isSmallScreen ? 72 : 78;
const iconContainerSize = isSmallScreen ? 40 : 44;

function MainTabs() {
  const insets = useSafeAreaInsets();
  const bottomInset = Math.max(insets.bottom, 8);
  const unreadCount = useNotificationStore((s) => s.unreadCount);

  return (
    <Tab.Navigator
      screenOptions={({route}) => ({
        headerShown: false,
        tabBarStyle: {
          position: 'absolute', bottom: bottomInset,
          left: screenWidth < 375 ? 12 : 16, right: screenWidth < 375 ? 12 : 16,
          height: tabBarH, backgroundColor: 'transparent', borderTopWidth: 0,
          borderRadius: 40, overflow: 'hidden',
          paddingBottom: 8, paddingTop: 10, paddingHorizontal: 4,
          shadowColor: '#000', shadowOffset: {width: 0, height: 12},
          shadowOpacity: 0.12, shadowRadius: 32, elevation: 25,
        },
        tabBarActiveTintColor: Colors.primaryGreen,
        tabBarInactiveTintColor: '#7A8798',
        tabBarLabelStyle: {fontSize: isSmallScreen ? 10 : 11, fontWeight: '700', marginTop: isSmallScreen ? 4 : 6, letterSpacing: 0.2},
        tabBarBackground: () => (
          <View style={styles.tabBarBackground}>
            <LinearGradient colors={['rgba(255,255,255,0.95)', 'rgba(255,255,255,0.85)', 'rgba(255,255,255,0.75)', 'rgba(255,255,255,0.8)']}
              start={{x: 0, y: 0}} end={{x: 0, y: 1}} style={styles.glassGradient} />
            <LinearGradient colors={['rgba(255,255,255,0.5)', 'rgba(255,255,255,0.1)', 'transparent']}
              start={{x: 0, y: 0}} end={{x: 0, y: 0.4}} style={styles.glassHighlight} />
            <View style={styles.glassBorder} />
          </View>
        ),
        tabBarIcon: ({focused, color, size}) => {
          let iconName: keyof typeof Ionicons.glyphMap = 'help-outline';
          if (route.name === 'Dashboard') iconName = focused ? 'home' : 'home-outline';
          else if (route.name === 'PID') iconName = focused ? 'git-branch' : 'git-branch-outline';
          else if (route.name === 'Automation') iconName = focused ? 'options' : 'options-outline';
          else if (route.name === 'Analytics') iconName = focused ? 'bar-chart' : 'bar-chart-outline';
          return (
            <View style={[styles.iconContainer, focused && styles.iconContainerActive]}>
              <Ionicons name={iconName} size={focused ? size + 2 : size} color={focused ? '#FFFFFF' : color} />
              {route.name === 'Dashboard' && unreadCount > 0 && (
                <View style={styles.tabBadge}>
                  <Text style={styles.tabBadgeText}>
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </Text>
                </View>
              )}
            </View>
          );
        },
      })}>
      <Tab.Screen name="Dashboard" component={DashboardScreen} />
      <Tab.Screen name="PID" component={PIDScreen} />
      <Tab.Screen name="Automation" component={AutomationScreen} />
      <Tab.Screen name="Analytics" component={AnalyticsScreen} />
    </Tab.Navigator>
  );
}

export default function AppNavigator() {
  const {state} = useAuth();
  return (
    <Stack.Navigator screenOptions={{headerShown: false}}>
      {state.isLoading ? (
        <Stack.Screen name="Auth" component={AuthScreen} />
      ) : state.token && !state.activeDeviceId ? (
        <Stack.Screen name="DeviceOnboarding" component={DeviceOnboardingScreen} />
      ) : state.token ? (
        <>
          <Stack.Screen name="MainTabs">{() => <WebSocketProvider><MainTabs /></WebSocketProvider>}</Stack.Screen>
          <Stack.Screen name="Profile" component={ProfileScreen} options={{headerShown: false, presentation: 'modal'}} />
          <Stack.Screen name="Notifications" component={NotificationsScreen} options={{headerShown: false, presentation: 'modal'}} />
          <Stack.Screen name="DeviceOnboarding" component={DeviceOnboardingScreen} />
        </>
      ) : (
        <Stack.Screen name="Auth" component={AuthScreen} />
      )}
    </Stack.Navigator>
  );
}

const styles = StyleSheet.create({
  tabBarBackground: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 40, overflow: 'hidden'},
  glassGradient: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 40},
  glassHighlight: {position: 'absolute', top: 0, left: 0, right: 0, height: '45%', borderRadius: 40, borderTopLeftRadius: 40, borderTopRightRadius: 40},
  glassBorder: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 40, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.5)'},
  iconContainer: {width: iconContainerSize, height: iconContainerSize, borderRadius: iconContainerSize / 2, justifyContent: 'center', alignItems: 'center', backgroundColor: 'transparent', position: 'relative'},
  iconContainerActive: {backgroundColor: Colors.primaryGreen, shadowColor: Colors.primaryGreen, shadowOffset: {width: 0, height: 4}, shadowOpacity: 0.4, shadowRadius: 8, elevation: 8},
  tabBadge: {position: 'absolute', top: -2, right: -2, minWidth: 16, height: 16, borderRadius: 8, backgroundColor: Colors.statusRed, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: '#FFFFFF'},
  tabBadgeText: {fontSize: 8, fontWeight: '800', color: '#fff', lineHeight: 10},
});
