import {create} from 'zustand';
import type {NightModeStatusResponse} from '../types/api';

interface NightModeStore {
  active: boolean;
  activatedAt: string | null;
  isLoading: boolean;
  setStatus: (status: NightModeStatusResponse) => void;
  setActive: (active: boolean) => void;
  setActivatedAt: (activatedAt: string | null) => void;
  setLoading: (loading: boolean) => void;
  reset: () => void;
}

export const useNightModeStore = create<NightModeStore>((set) => ({
  active: false,
  activatedAt: null,
  isLoading: false,

  setStatus: (status) =>
    set({
      active: status.active,
      activatedAt: status.activated_at,
      isLoading: false,
    }),

  setActive: (active) => set({active}),
  setActivatedAt: (activatedAt) => set({activatedAt}),
  setLoading: (isLoading) => set({isLoading}),

  reset: () => set({active: false, activatedAt: null, isLoading: false}),
}));
