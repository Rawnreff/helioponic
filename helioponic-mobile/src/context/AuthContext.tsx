import React, {createContext, useContext, useEffect, useReducer, useCallback} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {authApi, devicesApi, setApiToken} from '../lib/apiClient';

interface DeviceInfo {id: string; deviceId: string; name: string; isActive: boolean}
interface AuthState {
  isLoading: boolean; token: string | null; userId: string | null; email: string | null;
  name: string | null; devices: DeviceInfo[]; activeDeviceId: string | null; error: string | null;
}

const initialState: AuthState = {
  isLoading: true, token: null, userId: null, email: null, name: null,
  devices: [], activeDeviceId: null, error: null,
};

type AuthAction =
  | {type: 'RESTORE_TOKEN'; token: string; userId: string; email: string; name: string; devices: DeviceInfo[]; activeDeviceId: string}
  | {type: 'LOGIN_SUCCESS'; token: string; userId: string; email: string; name: string; devices: DeviceInfo[]; activeDeviceId: string}
  | {type: 'UPDATE_PROFILE'; name: string; email: string}
  | {type: 'LOGOUT'} | {type: 'SET_LOADING'; isLoading: boolean} | {type: 'SET_ERROR'; error: string}
  | {type: 'SET_DEVICES'; devices: DeviceInfo[]; activeDeviceId: string} | {type: 'SWITCH_DEVICE'; deviceId: string};

function authReducer(state: AuthState, action: AuthAction): AuthState {
  switch (action.type) {
    case 'RESTORE_TOKEN': case 'LOGIN_SUCCESS':
      return {...state, isLoading: false, token: action.token, userId: action.userId, email: action.email, name: action.name, devices: action.devices, activeDeviceId: action.activeDeviceId, error: null};
    case 'LOGOUT': return {...initialState, isLoading: false};
    case 'UPDATE_PROFILE': return {...state, name: action.name, email: action.email};
    case 'SET_LOADING': return {...state, isLoading: action.isLoading};
    case 'SET_ERROR': return {...state, isLoading: false, error: action.error};
    case 'SET_DEVICES': return {...state, devices: action.devices, activeDeviceId: action.activeDeviceId};
    case 'SWITCH_DEVICE': return {...state, activeDeviceId: action.deviceId};
    default: return state;
  }
}

interface AuthContextValue {
  state: AuthState;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string, deviceId: string) => Promise<void>;
  logout: () => Promise<void>;
  switchDevice: (deviceId: string) => void;
  refreshDevices: () => Promise<void>;
  updateProfileData: (name: string, email: string) => void;
  activeDeviceId: string;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const STORAGE_KEY_TOKEN = '@helioponic_token';
const STORAGE_KEY_USER = '@helioponic_user';

export function AuthProvider({children}: {children: React.ReactNode}) {
  const [state, dispatch] = useReducer(authReducer, initialState);

  useEffect(() => {
    (async () => {
      try {
        const token = await AsyncStorage.getItem(STORAGE_KEY_TOKEN);
        const userJson = await AsyncStorage.getItem(STORAGE_KEY_USER);
        if (token && userJson) {
          const user = JSON.parse(userJson);
          setApiToken(token);
          try {
            const devicesRes = await devicesApi.list();
            const devices: DeviceInfo[] = devicesRes.devices.map((d) => ({id: d.id, deviceId: d.device_id, name: d.name, isActive: d.is_active}));
            const active = devices.length > 0 ? devices[0].deviceId : user.deviceId;
            dispatch({type: 'RESTORE_TOKEN', token, userId: user.userId, email: user.email, name: user.name, devices, activeDeviceId: active});
          } catch {
            await AsyncStorage.removeItem(STORAGE_KEY_TOKEN); await AsyncStorage.removeItem(STORAGE_KEY_USER);
            setApiToken(null); dispatch({type: 'LOGOUT'});
          }
        } else dispatch({type: 'SET_LOADING', isLoading: false});
      } catch {dispatch({type: 'SET_LOADING', isLoading: false})}
    })();
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    dispatch({type: 'SET_LOADING', isLoading: true});
    try {
      const result = await authApi.login({email, password});
      setApiToken(result.token);
      const devicesRes = await devicesApi.list();
      const devices: DeviceInfo[] = devicesRes.devices.map((d) => ({id: d.id, deviceId: d.device_id, name: d.name, isActive: d.is_active}));
      const activeDeviceId = devices.length > 0 ? devices[0].deviceId : '';
      await AsyncStorage.setItem(STORAGE_KEY_TOKEN, result.token);
      await AsyncStorage.setItem(STORAGE_KEY_USER, JSON.stringify({userId: result.user.id, email: result.user.email, name: result.user.name}));
      dispatch({type: 'LOGIN_SUCCESS', token: result.token, userId: result.user.id, email: result.user.email, name: result.user.name, devices, activeDeviceId});
    } catch (error: any) {dispatch({type: 'SET_ERROR', error: error.message || 'Login failed'}); throw error;}
  }, []);

  const register = useCallback(async (name: string, email: string, password: string, deviceId: string) => {
    dispatch({type: 'SET_LOADING', isLoading: true});
    try {
      const result = await authApi.register({name, email, password, device_id: deviceId});
      setApiToken(result.token);
      const device: DeviceInfo = {id: result.user.id, deviceId, name, isActive: true};
      await AsyncStorage.setItem(STORAGE_KEY_TOKEN, result.token);
      await AsyncStorage.setItem(STORAGE_KEY_USER, JSON.stringify({userId: result.user.id, email: result.user.email, name: result.user.name}));
      dispatch({type: 'LOGIN_SUCCESS', token: result.token, userId: result.user.id, email: result.user.email, name: result.user.name, devices: [device], activeDeviceId: deviceId});
    } catch (error: any) {dispatch({type: 'SET_ERROR', error: error.message || 'Registration failed'}); throw error;}
  }, []);

  const logout = useCallback(async () => {
    setApiToken(null); await AsyncStorage.removeItem(STORAGE_KEY_TOKEN); await AsyncStorage.removeItem(STORAGE_KEY_USER); dispatch({type: 'LOGOUT'});
  }, []);

  const switchDevice = useCallback((deviceId: string) => dispatch({type: 'SWITCH_DEVICE', deviceId}), []);
  const refreshDevices = useCallback(async () => {
    try {
      const devicesRes = await devicesApi.list();
      const devices: DeviceInfo[] = devicesRes.devices.map((d) => ({id: d.id, deviceId: d.device_id, name: d.name, isActive: d.is_active}));
      const active = devices.length > 0 ? devices[0].deviceId : state.activeDeviceId;
      dispatch({type: 'SET_DEVICES', devices, activeDeviceId: active || ''});
    } catch (err) {console.warn('[Auth] refreshDevices failed:', (err as any)?.message || err)}
  }, [state.activeDeviceId]);

  const updateProfileData = useCallback((name: string, email: string) => dispatch({type: 'UPDATE_PROFILE', name, email}), []);
  const activeDeviceId = state.activeDeviceId || '';

  return (
    <AuthContext.Provider value={{state, login, register, logout, switchDevice, refreshDevices, updateProfileData, activeDeviceId}}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
