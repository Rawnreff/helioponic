import React from 'react';
import {View, Text, StyleSheet} from 'react-native';
import Svg, {Path, Defs, LinearGradient, Stop, Rect} from 'react-native-svg';
import {Colors} from '../context/ThemeContext';

interface Props {percentage: number; size?: number; label?: string}

export function WaterWaveWidget({percentage, size = 100, label}: Props) {
  const clampedPct = Math.max(0, Math.min(1, percentage));
  const pad = 8;
  const innerW = size - 2 * pad;
  const innerH = size - 2 * pad;
  const waterH = clampedPct * innerH;
  const waveY = size - pad - waterH;

  const wavePath = `M ${pad} ${waveY + 4} Q ${pad + innerW * 0.15} ${waveY - 6}, ${pad + innerW * 0.3} ${waveY + 4} T ${pad + innerW * 0.6} ${waveY + 4} T ${pad + innerW * 0.9} ${waveY + 4} L ${size - pad} ${waveY + 4} L ${size - pad} ${size - pad} L ${pad} ${size - pad} Z`;

  return (
    <View style={[styles.container, {width: size, height: size}]}>
      <Svg width={size} height={size}>
        <Rect x={pad} y={pad} width={innerW} height={innerH} rx={14} fill="none" stroke={Colors.waterLight} strokeWidth={1.5} />
        {clampedPct > 0 && (
          <>
            <Defs>
              <LinearGradient id="waveGrad" x1="0" y1="1" x2="0" y2="0">
                <Stop offset="0" stopColor={Colors.waterTeal} stopOpacity="0.85" />
                <Stop offset="1" stopColor={Colors.waterTeal} stopOpacity="0.5" />
              </LinearGradient>
            </Defs>
            <Path d={wavePath} fill="url(#waveGrad)" />
          </>
        )}
        {clampedPct > 0.05 && (
          <Path d={`M ${pad + 8} ${waveY + 2} Q ${pad + innerW * 0.25} ${waveY - 3}, ${pad + innerW * 0.4} ${waveY + 2}`} stroke="#fff" strokeWidth={1.5} strokeOpacity={0.4} fill="none" />
        )}
      </Svg>
      <View style={styles.labelContainer}>
        <Text style={[styles.percentage, {fontSize: size * 0.2}]}>{(clampedPct * 100).toFixed(0)}%</Text>
        {label && <Text style={styles.waterLabel}>{label}</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {alignItems: 'center', justifyContent: 'center'},
  labelContainer: {position: 'absolute', alignItems: 'center', justifyContent: 'center'},
  percentage: {fontWeight: '800', color: Colors.waterTeal},
  waterLabel: {fontSize: 9, color: Colors.textSecondary, fontWeight: '500'},
});
