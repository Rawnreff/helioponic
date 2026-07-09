import React from 'react';
import {View, Text, StyleSheet} from 'react-native';
import {LinearGradient} from 'expo-linear-gradient';
import {Colors} from '../context/ThemeContext';

interface Props {label: string; on: boolean; color: string}

export const PumpStateCard = React.memo(function PumpStateCard({label, on, color}: Props) {
  return (
    <LinearGradient colors={on ? ([color, color] as const) : (['#E8ECF1', '#E8ECF1'] as const)} start={{x: 0, y: 0}} end={{x: 1, y: 1}} style={styles.cardBorderGradient}>
      <View style={[styles.cardInner, {backgroundColor: on ? '#FFFFFF' : '#F8F9FA'}]}>
        <View style={[styles.dot, {backgroundColor: on ? color : '#D0D4D8', shadowColor: on ? color : 'transparent'}]} />
        <Text style={[styles.label, {color: on ? color : Colors.textHint, fontWeight: on ? '700' : '600'}]}>{label}</Text>
        <Text style={[styles.statusText, {color: on ? color : '#B0B8C5'}]}>{on ? 'ON' : 'OFF'}</Text>
      </View>
    </LinearGradient>
  );
});

const styles = StyleSheet.create({
  cardBorderGradient: {flex: 1, padding: 2, borderRadius: 16},
  cardInner: {alignItems: 'center', paddingVertical: 14, paddingHorizontal: 6, borderRadius: 14, gap: 6},
  dot: {width: 14, height: 14, borderRadius: 7, shadowOffset: {width: 0, height: 2}, shadowOpacity: 0.4, shadowRadius: 4, elevation: 4},
  label: {fontSize: 12, fontWeight: '700', letterSpacing: -0.2},
  statusText: {fontSize: 9, fontWeight: '800', letterSpacing: 1},
});
