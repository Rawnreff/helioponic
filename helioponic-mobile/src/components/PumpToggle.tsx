import React from 'react';
import {View, Text, Switch, StyleSheet} from 'react-native';
import {Colors, Shadows} from '../context/ThemeContext';

interface Props {label: string; icon: string; isActive: boolean; activeColor?: string; onToggle: (value: boolean) => void}

export function PumpToggle({label, icon, isActive, activeColor = Colors.accentGreen, onToggle}: Props) {
  return (
    <View style={styles.card}>
      <Text style={[styles.icon, {color: isActive ? activeColor : Colors.textHint}]}>{icon}</Text>
      <Text style={styles.label} numberOfLines={1}>{label}</Text>
      <Switch value={isActive} onValueChange={onToggle} trackColor={{false: Colors.cardBorder, true: activeColor + '60'}} thumbColor={isActive ? activeColor : '#ccc'} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {backgroundColor: Colors.surface, borderRadius: 20, padding: 12, alignItems: 'center', gap: 6, ...Shadows.subtle},
  icon: {fontSize: 20},
  label: {fontSize: 10, fontWeight: '600', color: Colors.textSecondary, textAlign: 'center'},
});
