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
  setLatestReading: (reading: SensorReading) => void;
  setHistory: (records: SensorRecord[]) => void;
  setConnected: (connected: boolean) => void;
  setDeviceStatus: (status: 'online' | 'offline') => void;
  setAlarm: (alarm: DeviceAlarm) => void;
  clearAlarm: () => void;
  reset: () => void;
}

export const useSensorStore = create<SensorStore>((set) => ({
  latestReading: null,
  history: [],
  isConnected: false,
  deviceStatus: 'offline',
  activeAlarm: null,
  setLatestReading: (reading) => set({latestReading: reading}),
  setHistory: (records) => set({history: records}),
  setConnected: (connected) => set({isConnected: connected, deviceStatus: connected ? 'online' : 'offline'}),
  setDeviceStatus: (deviceStatus) => set({deviceStatus, isConnected: deviceStatus === 'online'}),
  setAlarm: (activeAlarm) => set({activeAlarm}),
  clearAlarm: () => set({activeAlarm: null}),
  reset: () => set({latestReading: null, history: [], isConnected: false, deviceStatus: 'offline', activeAlarm: null}),
}));
