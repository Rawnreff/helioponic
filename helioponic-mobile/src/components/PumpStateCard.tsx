import React from 'react';
import {View, Text, StyleSheet, TouchableOpacity} from 'react-native';
import {LinearGradient} from 'expo-linear-gradient';
import {Ionicons} from '@expo/vector-icons';
import {Colors} from '../context/ThemeContext';

interface Props {
  label: string;
  description?: string;
  on: boolean;
  color: string;
  onToggle?: (newState: boolean) => void;
}

export const PumpStateCard = React.memo(function PumpStateCard({label, description, on, color, onToggle}: Props) {
  return (
    <LinearGradient colors={on ? ([color, color] as const) : (['#E8ECF1', '#E8ECF1'] as const)} start={{x: 0, y: 0}} end={{x: 1, y: 1}} style={styles.cardBorderGradient}>
      <View style={[styles.cardInner, {backgroundColor: on ? '#FFFFFF' : '#F8F9FA'}]}>
        <View style={[styles.dot, {backgroundColor: on ? color : '#D0D4D8', shadowColor: on ? color : 'transparent'}]} />
        <Text style={[styles.label, {color: on ? color : Colors.textHint, fontWeight: on ? '700' : '600'}]}>{label}</Text>
        {description && (
          <Text style={[styles.description, {color: on ? color + 'CC' : Colors.textHint}]}>{description}</Text>
        )}
        <Text style={[styles.statusText, {color: on ? color : '#B0B8C5'}]}>{on ? 'ON' : 'OFF'}</Text>
        {onToggle && (
          <TouchableOpacity
            style={[styles.toggleBtn, {backgroundColor: on ? color + '18' : Colors.cardBorder}]}
            onPress={() => onToggle(!on)}
            activeOpacity={0.7}
          >
            <Ionicons name={on ? 'power' : 'power-outline'} size={14} color={on ? color : Colors.textSecondary} />
            <Text style={[styles.toggleText, {color: on ? color : Colors.textSecondary}]}>
              {on ? 'Turn OFF' : 'Turn ON'}
            </Text>
          </TouchableOpacity>
        )}
      </View>
    </LinearGradient>
  );
});

const styles = StyleSheet.create({
  cardBorderGradient: {flex: 1, padding: 2, borderRadius: 16},
  cardInner: {alignItems: 'center', paddingVertical: 14, paddingHorizontal: 8, borderRadius: 14, gap: 4},
  dot: {width: 14, height: 14, borderRadius: 7, shadowOffset: {width: 0, height: 2}, shadowOpacity: 0.4, shadowRadius: 4, elevation: 4},
  label: {fontSize: 12, fontWeight: '700', letterSpacing: -0.2},
  description: {fontSize: 8, fontWeight: '500', textAlign: 'center', letterSpacing: 0.2, lineHeight: 11},
  statusText: {fontSize: 9, fontWeight: '800', letterSpacing: 1, marginTop: 2},
  toggleBtn: {flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 8, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10},
  toggleText: {fontSize: 10, fontWeight: '700', letterSpacing: 0.3},
});
