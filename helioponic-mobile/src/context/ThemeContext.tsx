import React, {createContext, useContext} from 'react';
import {StyleSheet} from 'react-native';

export const Colors = {
  primaryGreen: '#2E7D32', accentGreen: '#66BB6A', deepGreen: '#1B5E20',
  lightGreen: '#C8E6C9', paleGreen: '#E8F5E9',
  solarYellow: '#FFB300', solarAmber: '#FF8F00', solarLight: '#FFF8E1', energyOrange: '#EF6C00',
  waterTeal: '#1E88E5', waterLight: '#BBDEFB', waterBg: '#E3F2FD', tempBlue: '#00897B', tempLight: '#B2DFDB',
  statusGreen: '#43A047', statusYellow: '#FDD835', statusRed: '#E53935', statusOrange: '#FF7043',
  background: '#F4F6F9', surface: '#FFFFFF', cardBorder: '#E8ECF1',
  textPrimary: '#1A1A2E', textSecondary: '#5A6A7E', textHint: '#9EAAB8', glassBorder: 'rgba(255,255,255,0.1)',
};

export const Shadows = {
  card: {shadowColor: '#000', shadowOffset: {width: 0, height: 4}, shadowOpacity: 0.06, shadowRadius: 16, elevation: 4},
  elevated: {shadowColor: '#000', shadowOffset: {width: 0, height: 10}, shadowOpacity: 0.10, shadowRadius: 24, elevation: 10},
  subtle: {shadowColor: '#000', shadowOffset: {width: 0, height: 2}, shadowOpacity: 0.04, shadowRadius: 8, elevation: 2},
};

export const BorderRadius = {card: 20, bento: 24, chip: 12, button: 14};

export const Typography = StyleSheet.create({
  h1: {fontSize: 28, fontWeight: '800', color: Colors.textPrimary, letterSpacing: -0.5},
  h2: {fontSize: 22, fontWeight: '700', color: Colors.textPrimary, letterSpacing: -0.3},
  h3: {fontSize: 16, fontWeight: '600', color: Colors.textPrimary, letterSpacing: -0.2},
  subtitle: {fontSize: 12, fontWeight: '500', color: Colors.textSecondary},
  body: {fontSize: 14, color: Colors.textSecondary},
  label: {fontSize: 10, fontWeight: '500', color: Colors.textHint},
  metricValue: {fontSize: 18, fontWeight: '800'},
});

const ThemeContext = createContext({Colors, Shadows, BorderRadius, Typography});
export function ThemeProvider({children}: {children: React.ReactNode}) {
  return <ThemeContext.Provider value={{Colors, Shadows, BorderRadius, Typography}}>{children}</ThemeContext.Provider>;
}
export function useTheme() {return useContext(ThemeContext)}
