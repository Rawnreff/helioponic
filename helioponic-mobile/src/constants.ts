// ─── API & WebSocket URLs ────────────────────────────
// Priority: 1) .env (babel-plugin-inline-dotenv) 2) app.json extra 3) Platform default

import Constants from 'expo-constants';
import {Platform} from 'react-native';

function getDefaultHost(): string {
  if (Platform.OS === 'android') return '10.0.2.2';
  return 'localhost';
}

const host = getDefaultHost();
const envApiUrl: string | undefined = (process as any).env?.API_URL;
const envWsUrl: string | undefined = (process as any).env?.WS_URL;
const extraApiUrl = Constants.expoConfig?.extra?.apiUrl as string | undefined;
const extraWsUrl = Constants.expoConfig?.extra?.wsUrl as string | undefined;

export const API_URL = envApiUrl || extraApiUrl || `http://${host}:8000/api/v1`;
export const WS_URL = envWsUrl || extraWsUrl || `ws://${host}:8000/ws/pid`;

export const WS_RECONNECT_DELAY_MS = 3000;
export const DASHBOARD_POLL_MS = 5000;
export const CAMERA_POLL_MS = 3000;

export const DEFAULT_JARAK_ON = 105;
export const DEFAULT_JARAK_OFF = 95;
export const DEFAULT_TDS_ON = 105.0;
export const DEFAULT_TDS_OFF = 95.0;
