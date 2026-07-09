import {create} from 'zustand';
import type {WaterSummary, WaterRecord} from '../types/api';

type Period = '24h' | '7d' | '30d';

interface WaterStore {
  summary: WaterSummary | null;
  history: WaterRecord[];
  period: Period;
  setSummary: (summary: WaterSummary) => void;
  setHistory: (records: WaterRecord[]) => void;
  setPeriod: (period: Period) => void;
  reset: () => void;
}

export const useWaterStore = create<WaterStore>((set) => ({
  summary: null, history: [], period: '24h',
  setSummary: (summary) => set({summary}),
  setHistory: (records) => set({history: records}),
  setPeriod: (period) => set({period}),
  reset: () => set({summary: null, history: [], period: '24h'}),
}));
