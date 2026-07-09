import React, {useEffect, useRef} from 'react';
import {View, Text, StyleSheet, Animated} from 'react-native';
import {LinearGradient} from 'expo-linear-gradient';
import {Ionicons} from '@expo/vector-icons';

interface Props {
  title: string; value: string; unit?: string; icon: string; colors: readonly [string, string, ...string[]];
}

export const SensorStatusCard = React.memo(function SensorStatusCard({title, value, unit, icon, colors}: Props) {
  const fadeAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {Animated.timing(fadeAnim, {toValue: 1, duration: 600, useNativeDriver: true}).start();}, []);

  return (
    <Animated.View style={[styles.card, {opacity: fadeAnim}]}>
      <LinearGradient colors={colors as any} start={{x: 0, y: 0}} end={{x: 1, y: 1}} style={styles.cardBorderGradient}>
        <View style={styles.cardInner}>
          <View style={styles.cardGlow} />
          <View style={styles.cardIconBadge}>
            <LinearGradient colors={[...colors].reverse() as any} start={{x: 0, y: 0}} end={{x: 1, y: 1}} style={styles.cardIconBadgeGradient}>
              <Ionicons name={icon as any} size={24} color="#FFF" />
            </LinearGradient>
          </View>
          <View style={styles.cardContent}>
            <View style={styles.cardHeader}><Text style={styles.cardTitle}>{title}</Text></View>
            <View style={styles.cardValueContainer}>
              <Text style={styles.cardValue}>{value}</Text>
              {unit !== undefined && unit !== '' && <Text style={styles.cardUnit}>{unit}</Text>}
            </View>
            <LinearGradient colors={[...colors, 'transparent'] as any} start={{x: 0, y: 0}} end={{x: 1, y: 0}} style={styles.cardDecorativeLine} />
          </View>
        </View>
      </LinearGradient>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  card: {width: '47%', marginBottom: 4},
  cardBorderGradient: {padding: 2, borderRadius: 24},
  cardInner: {backgroundColor: '#FFFFFF', borderRadius: 22, padding: 18, minHeight: 120, position: 'relative', overflow: 'hidden', shadowColor: '#000', shadowOffset: {width: 0, height: 8}, shadowOpacity: 0.12, shadowRadius: 20, elevation: 8},
  cardGlow: {position: 'absolute', top: -50, right: -50, width: 120, height: 120, borderRadius: 60, backgroundColor: 'rgba(46,125,50,0.08)'},
  cardIconBadge: {width: 44, height: 44, borderRadius: 22, overflow: 'hidden', marginBottom: 12, shadowColor: '#000', shadowOffset: {width: 0, height: 4}, shadowOpacity: 0.2, shadowRadius: 8, elevation: 6},
  cardIconBadgeGradient: {width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center'},
  cardContent: {position: 'relative', zIndex: 1},
  cardHeader: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4},
  cardTitle: {fontSize: 12, color: '#8F9BB3', fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase'},
  cardValueContainer: {flexDirection: 'row', alignItems: 'baseline', marginBottom: 8},
  cardValue: {fontSize: 28, fontWeight: '900', color: '#2E3A59', letterSpacing: -1.5},
  cardUnit: {fontSize: 14, color: '#8F9BB3', fontWeight: '700', marginLeft: 4},
  cardDecorativeLine: {height: 3, width: '40%', borderRadius: 2, marginTop: 4},
});
