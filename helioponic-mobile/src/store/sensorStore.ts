import {create} from 'zustand';
import type {SensorReading, SensorRecord} from '../types/api';

interface SensorStore {
  latestReading: SensorReading | null;
  history: SensorRecord[];
  isConnected: boolean;
  setLatestReading: (reading: SensorReading) => void;
  setHistory: (records: SensorRecord[]) => void;
  setConnected: (connected: boolean) => void;
  reset: () => void;
}

export const useSensorStore = create<SensorStore>((set) => ({
  latestReading: null,
  history: [],
  isConnected: false,
  setLatestReading: (reading) => set({latestReading: reading}),
  setHistory: (records) => set({history: records}),
  setConnected: (connected) => set({isConnected: connected}),
  reset: () => set({latestReading: null, history: [], isConnected: false}),
}));
