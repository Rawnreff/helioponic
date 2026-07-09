import {create} from 'zustand';
import type {EnergySummary, EnergyRecord} from '../types/api';

type Period = '24h' | '7d' | '30d';

interface EnergyStore {
  summary: EnergySummary | null;
  history: EnergyRecord[];
  period: Period;
  setSummary: (summary: EnergySummary) => void;
  setHistory: (records: EnergyRecord[]) => void;
  setPeriod: (period: Period) => void;
  reset: () => void;
}

export const useEnergyStore = create<EnergyStore>((set) => ({
  summary: null, history: [], period: '24h',
  setSummary: (summary) => set({summary}),
  setHistory: (records) => set({history: records}),
  setPeriod: (period) => set({period}),
  reset: () => set({summary: null, history: [], period: '24h'}),
}));
