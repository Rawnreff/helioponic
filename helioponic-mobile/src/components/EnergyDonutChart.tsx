import React from 'react';
import {View, Text, StyleSheet} from 'react-native';
import Svg, {Path, G, Text as SvgText} from 'react-native-svg';
import {Colors} from '../context/ThemeContext';

interface Props {pompa1Wh: number; pompa2Wh: number; totalWh: number; size?: number}

export function EnergyDonutChart({pompa1Wh, pompa2Wh, totalWh, size = 120}: Props) {
  const total = pompa1Wh + pompa2Wh;
  const p1Ratio = total > 0 ? pompa1Wh / total : 0.5;
  const p2Ratio = total > 0 ? pompa2Wh / total : 0.5;
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.38;
  const strokeW = size * 0.1;
  const circumference = 2 * Math.PI * r;
  const gap = 4;

  return (
    <View style={[styles.container, {width: size + 40}]}>
      <View style={{width: size, height: size, alignItems: 'center', justifyContent: 'center'}}>
        <Svg width={size} height={size}>
          <Path d={`M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r}`} stroke={Colors.cardBorder} strokeWidth={strokeW} fill="none" />
          <G rotation="-90" origin={`${cx}, ${cy}`}>
            <Path d={`M ${cx} ${cy - r} A ${r} ${r} 0 ${p1Ratio > 0.5 ? 1 : 0} 1 ${cx} ${cy + r}`} stroke={Colors.accentGreen} strokeWidth={strokeW} strokeLinecap="round" fill="none" strokeDasharray={`${circumference * p1Ratio - gap} ${circumference - circumference * p1Ratio + gap}`} />
            <Path d={`M ${cx} ${cy + r} A ${r} ${r} 0 ${p2Ratio > 0.5 ? 1 : 0} 1 ${cx} ${cy - r}`} stroke={Colors.tempBlue} strokeWidth={strokeW} strokeLinecap="round" fill="none" strokeDasharray={`${circumference * p2Ratio - gap} ${circumference - circumference * p2Ratio + gap}`} />
          </G>
          <SvgText x={cx} y={cy - 4} textAnchor="middle" fontSize={size * 0.16} fontWeight="800" fill={Colors.textPrimary}>{totalWh.toFixed(3)}</SvgText>
          <SvgText x={cx} y={cy + size * 0.1} textAnchor="middle" fontSize={size * 0.07} fill={Colors.textHint}>Wh</SvgText>
        </Svg>
      </View>
      <View style={styles.legend}>
        <View style={styles.legendRow}><View style={[styles.dot, {backgroundColor: Colors.accentGreen}]} /><Text style={styles.legendText}>Pompa 1</Text><Text style={styles.legendValue}>{pompa1Wh.toFixed(3)} Wh</Text></View>
        <View style={styles.legendRow}><View style={[styles.dot, {backgroundColor: Colors.tempBlue}]} /><Text style={styles.legendText}>Pompa 2</Text><Text style={styles.legendValue}>{pompa2Wh.toFixed(3)} Wh</Text></View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {alignItems: 'center', justifyContent: 'center'},
  legend: {marginTop: 8, gap: 4},
  legendRow: {flexDirection: 'row', alignItems: 'center', gap: 6},
  dot: {width: 8, height: 8, borderRadius: 4},
  legendText: {fontSize: 11, color: Colors.textSecondary, fontWeight: '500', flex: 1},
  legendValue: {fontSize: 11, color: Colors.textPrimary, fontWeight: '700'},
});
