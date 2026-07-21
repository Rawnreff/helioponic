// ─── API & WebSocket URLs ────────────────────────────
// Priority: 1) app.config.js → Constants.expoConfig.extra (most reliable)
//           2) process.env (babel-plugin-inline-dotenv, for dev workflow)
//           3) Platform default (emulator / localhost — NOT for physical devices)

import Constants from 'expo-constants';
import {Platform} from 'react-native';

function getDefaultHost(): string {
  if (Platform.OS === 'android') return '10.0.2.2';
  return 'localhost';
}

const host = getDefaultHost();

// Primary: app.config.js populates these at Metro start time
const extraApiUrl = Constants.expoConfig?.extra?.apiUrl as string | undefined;
const extraWsUrl = Constants.expoConfig?.extra?.wsUrl as string | undefined;

export const API_URL = extraApiUrl || `http://${host}:8000/api/v1`;
export const WS_URL = extraWsUrl || `ws://${host}:8000/ws/pid`;

export const WS_RECONNECT_DELAY_MS = 3000;
export const DASHBOARD_POLL_MS = 5000;
export const CAMERA_POLL_MS = 3000;

export const DEFAULT_JARAK_ON = 5;         // tank depth = 32cm (configurable)
export const DEFAULT_JARAK_OFF = 2;
export const DEFAULT_TANK_DEPTH = 32;      // cm — default reservoir depth
export const DEFAULT_TDS_ON = 95.0;        // LOW threshold — ON when TDS drops below
export const DEFAULT_TDS_OFF = 105.0;      // HIGH threshold — OFF when TDS rises above
