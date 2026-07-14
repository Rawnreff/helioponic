// ─── Auth Types ────────────────────────────────────────
export interface RegisterRequest {
  email: string;
  password: string;
  name: string;
  device_id: string;
  device_name?: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface AuthResponse {
  token: string;
  user: {id: string; email: string; name: string};
}

export interface UpdateProfileRequest {name: string; email: string}
export interface UpdatePasswordRequest {old_password: string; new_password: string}

// ─── Device Types ──────────────────────────────────────
export interface Device {
  id: string; device_id: string; name: string; is_active: boolean; created_at: string;
}

// ─── Sensor Types ──────────────────────────────────────
export interface SensorReading {
  device_id: string; ts: number; jarak_cm: number; tds_value: number;
  current_ph: number; pompa1: 0 | 1; pompa2: 0 | 1;
  auto_enabled?: boolean;
  night_mode?: boolean;
}

export interface SensorRecord {
  id: string; device_id: string; recorded_at: string; jarak_cm: number;
  tds_value: number; current_ph: number; pompa1: 0 | 1; pompa2: 0 | 1;
}

// ─── Water Types ───────────────────────────────────────
export interface WaterSummary {water_level_pct: number; jarak_cm: number}
export interface WaterRecord {id: string; device_id: string; recorded_at: string; jarak_cm: number; water_level_pct: number}

// ─── Device Config Types ───────────────────────────────
export interface DeviceConfig {
  device_id: string; jarak_on: number; jarak_off: number;
  tds_on: number; tds_off: number; ph_min: number; ph_max: number;
  updated_at: string | null;
}
export interface DeviceConfigPayload {
  device_id: string; jarak_on: number; jarak_off: number;
  tds_on: number; tds_off: number; ph_min: number; ph_max: number;
}

// ─── Actuator Types ────────────────────────────────────
export interface ActuatorCommand {pump: string; state: 0 | 1; device_id?: string}
export interface ActuatorResponse {status: string; pump: string; state: number}

// ─── Night Mode Types ────────────────────────────────
export interface NightModeActivateRequest {
  device_id: string;
}

export interface NightModeDeactivateRequest {
  device_id: string;
}

export interface NightModeStatusResponse {
  active: boolean;
  device_id: string;
  activated_at: string | null;
  deactivated_at: string | null;
  saved_thresholds?: {
    jarak_on: number;
    jarak_off: number;
    tds_on: number;
    tds_off: number;
    auto_enabled: boolean;
  } | null;
}

// ─── Notification Types ───────────────────────────────
export type HelioponicNotificationType =
  | 'auto_mode'
  | 'manual_control'
  | 'night_mode'
  | 'water_alarm'
  | 'threshold_settings'
  | 'pump_error'
  | 'tds_warning'
  | 'ph_warning';

export type NotificationPriority = 'low' | 'medium' | 'high';

export interface NotificationData {
  id: string;
  type: HelioponicNotificationType;
  title: string;
  message: string;
  priority: NotificationPriority;
  read: boolean;
  read_at: string | null;
  timestamp: string | null;
  created_at: string | null;
  device_id: string;
}

// Notification type metadata (for UI rendering — icon, gradient, priority)
export const NOTIFICATION_META: Record<HelioponicNotificationType, {
  icon: string;
  gradient: [string, string];
  priority: NotificationPriority;
}> = {
  auto_mode: {icon: 'flash', gradient: ['#0ea5e9', '#06b6d4'], priority: 'medium'},
  manual_control: {icon: 'hand-left', gradient: ['#10b981', '#059669'], priority: 'medium'},
  night_mode: {icon: 'moon', gradient: ['#6366f1', '#4f46e5'], priority: 'medium'},
  water_alarm: {icon: 'alert-circle', gradient: ['#ef4444', '#dc2626'], priority: 'high'},
  threshold_settings: {icon: 'settings', gradient: ['#667eea', '#764ba2'], priority: 'low'},
  pump_error: {icon: 'construct', gradient: ['#f43f5e', '#e11d48'], priority: 'high'},
  tds_warning: {icon: 'flask', gradient: ['#f59e0b', '#d97706'], priority: 'medium'},
  ph_warning: {icon: 'color-palette', gradient: ['#f472b6', '#ec4899'], priority: 'medium'},
};

export interface NotificationsResponse {
  data: NotificationData[];
  count: number;
}

export interface MarkReadResponse {
  status: string;
  notification_id: string;
}

export interface MarkAllReadResponse {
  status: string;
  marked_count: number;
}

// ─── WebSocket Message Types ──────────────────────────
export interface WebSocketSensorMessage {
  type: 'sensor_update';
  device_id: string;
  ts: number;
  jarak_cm: number;
  tds_value: number;
  current_ph: number;
  pompa1: 0 | 1;
  pompa2: 0 | 1;
  water_level_pct?: number;
  auto_enabled?: boolean;
  night_mode?: boolean;
  recorded_at: string;
}

export interface WebSocketStatusMessage {
  type: 'status_update';
  device_id: string;
  status: 'online' | 'offline';
  ts: number;
}

export interface WebSocketAlarmMessage {
  type: 'alarm';
  device_id: string;
  alarm_type: 'water_level' | 'tds_critical' | 'ph_critical';
  message: string;
  ts: number;
}

export type WebSocketMessage = WebSocketSensorMessage | WebSocketStatusMessage | WebSocketAlarmMessage;

// ─── History Types ────────────────────────────────────
export interface SensorHistoryRecord extends SensorRecord {}
export interface WaterHistoryRecord extends WaterRecord {}
