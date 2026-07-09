import React from 'react';
import {View, Text, StyleSheet} from 'react-native';
import {LinearGradient} from 'expo-linear-gradient';
import {Ionicons} from '@expo/vector-icons';
import {Colors} from '../context/ThemeContext';

interface Props {
  icon: string; colors: readonly [string, string, ...string[]]; title: string;
  badge?: string; dotColor?: string; textColor?: string; bgColor?: string;
}

export function SectionHeader({icon, colors, title, badge, dotColor, textColor, bgColor}: Props) {
  return (
    <View style={styles.sectionHeaderRow}>
      <View style={styles.sectionTitleContainer}>
        <View style={styles.sectionIconBadge}>
          <LinearGradient colors={colors} start={{x: 0, y: 0}} end={{x: 1, y: 1}} style={styles.sectionIconGradient}>
            <Ionicons name={icon as any} size={16} color="#FFF" />
          </LinearGradient>
        </View>
        <Text style={styles.sectionTitle}>{title}</Text>
      </View>
      {badge && (
        <View style={[styles.sectionBadge, {backgroundColor: bgColor || Colors.paleGreen}]}>
          {dotColor && <View style={[styles.sectionBadgeDot, {backgroundColor: dotColor}]} />}
          <Text style={[styles.sectionBadgeText, {color: textColor || Colors.deepGreen}]}>{badge}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  sectionHeaderRow: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16},
  sectionTitleContainer: {flexDirection: 'row', alignItems: 'center', gap: 10},
  sectionIconBadge: {width: 32, height: 32, borderRadius: 16, overflow: 'hidden'},
  sectionIconGradient: {width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center'},
  sectionTitle: {fontSize: 17, fontWeight: '800', color: '#2E3A59', letterSpacing: -0.3},
  sectionBadge: {flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10},
  sectionBadgeDot: {width: 6, height: 6, borderRadius: 3},
  sectionBadgeText: {fontSize: 9, fontWeight: '800', letterSpacing: 1},
});
