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
}

export interface SensorRecord {
  id: string; device_id: string; recorded_at: string; jarak_cm: number;
  tds_value: number; current_ph: number; pompa1: 0 | 1; pompa2: 0 | 1;
}

// ─── Energy Types ──────────────────────────────────────
export interface EnergySummary {pompa1_wh: number; pompa2_wh: number; total_wh: number}
export interface EnergyRecord {id: string; recorded_at: string; pompa1_wh: number; pompa2_wh: number; total_wh: number}

// ─── Water Types ───────────────────────────────────────
export interface WaterSummary {water_level_pct: number; jarak_cm: number}
export interface WaterRecord {id: string; device_id: string; recorded_at: string; jarak_cm: number; water_level_pct: number}

// ─── Device Config Types ───────────────────────────────
export interface DeviceConfig {
  device_id: string; jarak_on: number; jarak_off: number;
  tds_on: number; tds_off: number; updated_at: string | null;
}
export interface DeviceConfigPayload {
  device_id: string; jarak_on: number; jarak_off: number; tds_on: number; tds_off: number;
}

// ─── Actuator Types ────────────────────────────────────
export interface ActuatorCommand {pump: string; state: 0 | 1; device_id?: string}
export interface ActuatorResponse {status: string; pump: string; state: number}

// ─── History Types ────────────────────────────────────
export interface SensorHistoryRecord extends SensorRecord {}
export interface EnergyHistoryRecord extends EnergyRecord {}
export interface WaterHistoryRecord extends WaterRecord {}
