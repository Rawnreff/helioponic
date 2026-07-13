import {API_URL} from '../constants';

let _token: string | null = null;

export function setApiToken(token: string | null): void {_token = token}
export function getApiToken(): string | null {return _token}

interface RequestOptions {
  method?: string; body?: unknown; headers?: Record<string, string>;
  params?: Record<string, string | number | undefined>; timeout?: number;
}

async function request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
  const {method = 'GET', body, headers = {}, params, timeout = 10000} = options;
  let url = `${API_URL}${endpoint}`;
  if (params) {
    const filtered = Object.entries(params).filter(([_, v]) => v !== undefined);
    if (filtered.length > 0) {
      url += '?' + filtered.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
    }
  }
  const finalHeaders: Record<string, string> = {'Content-Type': 'application/json', ...headers};
  if (_token) finalHeaders['Authorization'] = `Bearer ${_token}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {method, headers: finalHeaders, body: body ? JSON.stringify(body) : undefined, signal: controller.signal});
    clearTimeout(timeoutId);
    if (response.status === 204) return {} as T;
    const data = await response.json();
    if (!response.ok) throw new ApiError(data?.detail || data?.message || `HTTP ${response.status}`, response.status);
    return data as T;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof ApiError) throw error;
    if ((error as Error).name === 'AbortError') throw new ApiError('Request timeout', 408);
    throw new ApiError('Network error — is the backend running?', 0);
  }
}

export class ApiError extends Error {
  constructor(message: string, public code: number) {super(message); this.name = 'ApiError'}
}

export const authApi = {
  register: (data: {email: string; password: string; name: string; device_id: string; device_name?: string}) =>
    request<{token: string; user: {id: string; email: string; name: string}}>('/auth/register', {method: 'POST', body: data}),
  login: (data: {email: string; password: string}) =>
    request<{token: string; user: {id: string; email: string; name: string}}>('/auth/login', {method: 'POST', body: data}),
  updateProfile: (data: {name: string; email: string}) =>
    request<{id: string; email: string; name: string}>('/auth/profile', {method: 'PUT', body: data}),
  updatePassword: (data: {old_password: string; new_password: string}) =>
    request<{status: string; message: string}>('/auth/password', {method: 'PUT', body: data}),
  deleteAccount: () => request<{status: string; message: string}>('/auth/account', {method: 'DELETE'}),
};

export const devicesApi = {
  list: () => request<{devices: {id: string; device_id: string; name: string; is_active: boolean}[]; count: number}>('/devices'),
  add: (data: {device_id: string; name: string}) => request<{message: string}>('/devices', {method: 'POST', body: data}),
  remove: (deviceId: string) => request<{status: string; message: string; device_id: string}>(`/devices/${deviceId}`, {method: 'DELETE'}),
};

export const configApi = {
  get: (deviceId?: string) =>
    request<{device_id: string; jarak_on: number; jarak_off: number; tds_on: number; tds_off: number; updated_at: string | null}>('/devices/config', {params: {device_id: deviceId}}),
  update: (data: {device_id: string; jarak_on: number; jarak_off: number; tds_on: number; tds_off: number}) =>
    request<{status: string; device_id: string; jarak_on: number; jarak_off: number; tds_on: number; tds_off: number; updated_at: string}>('/devices/config', {method: 'PUT', body: data}),
};

export const sensorsApi = {
  latest: (deviceId?: string) =>
    request<{id: string; device_id: string; recorded_at: string; jarak_cm: number; tds_value: number; current_ph: number; pompa1: 0 | 1; pompa2: 0 | 1}>('/sensors/latest', {params: {device_id: deviceId}}),
  history: (from: string, to: string, deviceId?: string, limit = 200) =>
    request<{data: any[]; count: number}>('/sensors/history', {params: {from_date: from, to_date: to, limit, device_id: deviceId}}),
  postReading: (data: {device_id: string; ts: number; jarak_cm: number; tds_value: number; current_ph: number; pompa1: 0 | 1; pompa2: 0 | 1}) =>
    request<{status: string; message: string; pumps_reported: {pompa1: number; pompa2: number}}>('/sensors/reading', {method: 'POST', body: data}),
};

export const energyApi = {
  summary: (deviceId?: string) => request<{pompa1_wh: number; pompa2_wh: number; total_wh: number}>('/energy/summary', {params: {device_id: deviceId}}),
  history: (from: string, to: string, deviceId?: string, limit = 200) =>
    request<{data: any[]; count: number}>('/energy/history', {params: {from_date: from, to_date: to, limit, device_id: deviceId}}),
};

export const waterApi = {
  summary: (deviceId?: string) => request<{water_level_pct: number; jarak_cm: number}>('/water/summary', {params: {device_id: deviceId}}),
  history: (from: string, to: string, deviceId?: string, limit = 200) =>
    request<{data: any[]; count: number}>('/water/history', {params: {from_date: from, to_date: to, limit, device_id: deviceId}}),
};

export const actuatorApi = {
  controlPump: (pump: string, state: 0 | 1, deviceId?: string) =>
    request<{status: string; pump: string; state: number}>('/actuators/pump', {method: 'POST', body: {pump, state, device_id: deviceId}}),
};

// ─── Automation Rules API ────────────────────────────
export const automationApi = {
  get: (deviceId?: string) =>
    request<{device_id: string; auto_enabled: boolean; rule_ph: boolean; rule_tds: boolean; rule_water: boolean; updated_at: string | null}>('/devices/automation', {params: {device_id: deviceId}}),
  update: (data: {device_id: string; auto_enabled: boolean; rule_ph: boolean; rule_tds: boolean; rule_water: boolean}) =>
    request<{device_id: string; auto_enabled: boolean; rule_ph: boolean; rule_tds: boolean; rule_water: boolean; updated_at: string}>('/devices/automation', {method: 'PUT', body: data}),
};

// ─── Night Mode API ───────────────────────────────────
export const nightModeApi = {
  activate: (deviceId: string) =>
    request<{success: boolean; message: string; device_id: string; activated_at: string}>(
      '/night-mode/activate',
      {method: 'POST', body: {device_id: deviceId}},
    ),
  deactivate: (deviceId: string) =>
    request<{success: boolean; message: string; device_id: string; deactivated_at: string}>(
      '/night-mode/deactivate',
      {method: 'POST', body: {device_id: deviceId}},
    ),
  status: (deviceId: string) =>
    request<import('../types/api').NightModeStatusResponse>(
      '/night-mode/status',
      {params: {device_id: deviceId}},
    ),
};

// ─── Notifications API ────────────────────────────────
export const notificationsApi = {
  list: (deviceId?: string, unreadOnly?: boolean, limit?: number) =>
    request<{data: import('../types/api').NotificationData[]; count: number}>('/notifications', {
      params: {device_id: deviceId, unread_only: unreadOnly ? 'true' : undefined, limit},
    }),
  markRead: (notificationId: string) =>
    request<{status: string; notification_id: string}>(`/notifications/${notificationId}/read`, {method: 'PATCH'}),
  markAllRead: (deviceId?: string) =>
    request<{status: string; marked_count: number}>('/notifications/read-all', {
      method: 'PATCH',
      params: {device_id: deviceId},
    }),
};
