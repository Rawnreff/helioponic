import {create} from 'zustand';
import type {SensorReading, SensorRecord} from '../types/api';

interface DeviceAlarm {
  type: 'water_level' | 'tds_critical' | 'ph_critical';
  message: string;
  ts: number;
}

interface SensorStore {
  latestReading: SensorReading | null;
  history: SensorRecord[];
  isConnected: boolean;
  deviceStatus: 'online' | 'offline';
  activeAlarm: DeviceAlarm | null;
  /**
   * Shared optimistic pump override states — works ACROSS all screens.
   * When user toggles a pump on Dashboard, PID screen sees the same state.
   * Automatically cleared by WebSocketContext when WS confirms actual state.
   */
  overridePumps: Record<string, 0 | 1>;
  /** Set an optimistic pump override (shared across all screens) */
  setOverridePump: (pump: string, state: 0 | 1) => void;
  /** Clear a specific pump override when WS confirms the state */
  clearOverridePump: (pump: string) => void;
  setLatestReading: (reading: SensorReading) => void;
  setHistory: (records: SensorRecord[]) => void;
  setConnected: (connected: boolean) => void;
  setDeviceStatus: (status: 'online' | 'offline') => void;
  setAlarm: (alarm: DeviceAlarm) => void;
  clearAlarm: () => void;
  reset: () => void;
}

export const useSensorStore = create<SensorStore>((set, get) => ({
  latestReading: null,
  history: [],
  isConnected: false,
  deviceStatus: 'offline',
  activeAlarm: null,
  overridePumps: {},

  setOverridePump: (pump, state) => set((prev) => ({
    overridePumps: {...prev.overridePumps, [pump]: state},
  })),

  clearOverridePump: (pump) => set((prev) => {
    const newPumps = {...prev.overridePumps};
    delete newPumps[pump];
    return {overridePumps: newPumps};
  }),

  setLatestReading: (reading) => set({latestReading: reading}),
  setHistory: (records) => set({history: records}),
  setConnected: (connected) => set({isConnected: connected, deviceStatus: connected ? 'online' : 'offline'}),
  setDeviceStatus: (deviceStatus) => set({deviceStatus, isConnected: deviceStatus === 'online'}),
  setAlarm: (activeAlarm) => set({activeAlarm}),
  clearAlarm: () => set({activeAlarm: null}),
  reset: () => set({latestReading: null, history: [], isConnected: false, deviceStatus: 'offline', activeAlarm: null, overridePumps: {}}),
}));
