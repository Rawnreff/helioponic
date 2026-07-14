import React, {useRef, useEffect, useState} from 'react';
import {View, Text, Animated, Easing, StyleSheet} from 'react-native';
import Svg, {Rect, Line} from 'react-native-svg';
import {Colors} from '../context/ThemeContext';

interface Props {percentage: number; size?: number; label?: string}

export function WaterWaveWidget({percentage, size = 100, label}: Props) {
  const clampedPct = Math.max(0, Math.min(1, percentage));

  // ── Tank geometry (side view of a plastic rectangular tote) ──
  const tankW = size * 0.74;
  const tankH = size * 0.80;
  const tankX = (size - tankW) / 2;
  const tankY = (size - tankH) / 2;
  const corner = 8;
  const wall = 3;
  const innerW = tankW - wall * 2;
  const innerH = tankH - wall * 2;
  const innerX = tankX + wall;
  const innerY = tankY + wall;

  const targetWaterH = Math.max(0, clampedPct * innerH);
  const targetWaterY = innerY + innerH - targetWaterH;

  // ── Animated water height (smooth transition) ──
  const waterAnim = useRef(new Animated.Value(targetWaterH)).current;
  const [displayWaterY, setDisplayWaterY] = useState(targetWaterY);

  // Sync SVG water surface line position with the animated height
  useEffect(() => {
    const id = waterAnim.addListener(({value}) => {
      setDisplayWaterY(innerY + innerH - value);
    });
    return () => waterAnim.removeListener(id);
  }, [waterAnim, innerY, innerH]);

  // Animate water height smoothly when clampedPct changes
  useEffect(() => {
    Animated.timing(waterAnim, {
      toValue: targetWaterH,
      duration: 500,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: false,
    }).start();
  }, [targetWaterH, waterAnim]);

  // Rim geometry
  const rimW = tankW + 12;
  const rimH = 6;
  const rimX = (size - rimW) / 2;
  const rimY = tankY - rimH + 2;
  const emptyColor = '#F0F7F5';

  return (
    <View style={{width: size, height: size, alignItems: 'center', justifyContent: 'center'}}>
      {/* ── Tank body ── */}
      <View style={{
        width: tankW,
        height: tankH,
        borderTopLeftRadius: corner,
        borderTopRightRadius: corner,
        borderBottomLeftRadius: 3,
        borderBottomRightRadius: 3,
        overflow: 'hidden',
        backgroundColor: emptyColor,
      }}>
        {/* Water fill (animated height) */}
        {targetWaterH > 0 && (
          <Animated.View style={{
            position: 'absolute',
            bottom: wall,
            left: wall,
            right: wall,
            height: waterAnim,
            backgroundColor: Colors.waterTeal,
            borderTopLeftRadius: 5,
            borderTopRightRadius: 5,
          }}>
            {/* Surface light band */}
            <View style={{
              height: 4,
              backgroundColor: 'rgba(255,255,255,0.25)',
              borderTopLeftRadius: 4,
              borderTopRightRadius: 4,
            }} />
          </Animated.View>
        )}
      </View>

      {/* ── SVG overlay ── */}
      <Svg width={size} height={size} style={{position: 'absolute'}}>
        <Rect x={rimX} y={rimY} width={rimW} height={rimH} rx={3} fill={Colors.waterTeal + '40'} />
        <Rect x={rimX + 4} y={rimY + 1.5} width={rimW - 8} height={rimH - 3} rx={1.5} fill={emptyColor} />

        <Rect x={tankX} y={tankY} width={tankW} height={tankH}
          rx={corner} fill="none" stroke={Colors.waterTeal + '45'} strokeWidth={1.5} />
        <Rect x={tankX + wall} y={tankY + wall} width={innerW} height={innerH}
          rx={corner - 2} fill="none" stroke={Colors.waterTeal + '20'} strokeWidth={0.5} />

        {[0.25, 0.5, 0.75].map((pct) => {
          const my = innerY + innerH * (1 - pct);
          return (
            <React.Fragment key={pct.toString()}>
              <Line x1={tankX + 8} y1={my} x2={tankX + 16} y2={my}
                stroke={Colors.textHint} strokeWidth={1} strokeOpacity={0.4} />
              <Line x1={tankX + tankW - 8} y1={my} x2={tankX + tankW - 16} y2={my}
                stroke={Colors.textHint} strokeWidth={1} strokeOpacity={0.4} />
            </React.Fragment>
          );
        })}

        {/* Water surface highlight (synced to animated value) */}
        {targetWaterH > 0 && (
          <Line x1={tankX + wall + 1} y1={displayWaterY} x2={tankX + tankW - wall - 1} y2={displayWaterY}
            stroke="rgba(255,255,255,0.55)" strokeWidth={1.5} />
        )}

        <Line x1={tankX + 4} y1={tankY + tankH} x2={tankX + tankW - 4} y2={tankY + tankH}
          stroke={Colors.waterTeal + '35'} strokeWidth={1.5} />
      </Svg>

      {/* ── Percentage text ── */}
      <View style={StyleSheet.absoluteFill}>
        <View style={styles.textCenter}>
          <Text style={[styles.percentage, {fontSize: size * 0.20}]}>
            {(clampedPct * 100).toFixed(0)}%
          </Text>
          {label && (
            <Text style={[styles.waterLabel, {fontSize: size * 0.085}]}>{label}</Text>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  textCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  percentage: {
    fontWeight: '900',
    color: '#FFFFFF',
    textShadowColor: 'rgba(0,0,0,0.4)',
    textShadowOffset: {width: 0, height: 2},
    textShadowRadius: 8,
    letterSpacing: -0.5,
  },
  waterLabel: {
    color: 'rgba(255,255,255,0.9)',
    fontWeight: '600',
    marginTop: 2,
    textShadowColor: 'rgba(0,0,0,0.25)',
    textShadowOffset: {width: 0, height: 1},
    textShadowRadius: 4,
  },
});
