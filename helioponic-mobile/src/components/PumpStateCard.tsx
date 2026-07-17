import React, {useEffect, useRef} from 'react';
import {View, Text, StyleSheet, Animated, TouchableOpacity} from 'react-native';
import {LinearGradient} from 'expo-linear-gradient';
import {Ionicons} from '@expo/vector-icons';
import {Colors, Shadows} from '../context/ThemeContext';

interface Props {
  label: string;
  description?: string;
  on: boolean;
  color: string;
  onToggle?: (newState: boolean) => void;
}

export const PumpStateCard = React.memo(function PumpStateCard({label, description, on, color, onToggle}: Props) {
  // Animated values
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const accentWidth = useRef(new Animated.Value(on ? 1 : 0.3)).current;

  // Trigger bounce on state change
  useEffect(() => {
    // Scale bounce
    Animated.sequence([
      Animated.spring(scaleAnim, {toValue: 0.97, useNativeDriver: true, friction: 8, tension: 100}),
      Animated.spring(scaleAnim, {toValue: 1, useNativeDriver: true, friction: 5, tension: 80}),
    ]).start();

    // Accent bar opacity
    Animated.timing(accentWidth, {
      toValue: on ? 1 : 0.3,
      duration: 300,
      useNativeDriver: false,
    }).start();
  }, [on, scaleAnim, accentWidth]);

  return (
    <Animated.View style={[styles.outerCard, on && {borderColor: color + '30'}, {transform: [{scale: scaleAnim}]}]}>
      {/* Colored top accent bar */}
      <Animated.View style={{opacity: accentWidth}}>
        <LinearGradient
          colors={on ? ([color, color + '80'] as const) : (['#D0D5DD', '#E0E4E8'] as const)}
          start={{x: 0, y: 0}} end={{x: 1, y: 0}}
          style={styles.accentBar}
        />
      </Animated.View>

      {/* Card body */}
      <View style={[styles.body, {backgroundColor: on ? '#FFFFFF' : '#F8F9FA'}]}>
        {/* Top: icon + label (full width) + toggle button (absolute) */}
        <View style={styles.topSection}>
          <View style={[styles.iconCircle, {backgroundColor: on ? color + '18' : '#E8ECF1'}]}>
            <Ionicons
              name={on ? 'flash' : 'flash-outline'}
              size={18}
              color={on ? color : Colors.textHint}
            />
          </View>
          <View style={styles.labelArea}>
            {/* right padding so text doesn't go under the floating toggle button */}
            <View style={{paddingRight: 36}}>
              <Text style={[styles.pumpName, {color: on ? color : Colors.textPrimary}]} numberOfLines={1}>
                {label}
              </Text>
              {description && (
                <Text style={[styles.pumpDesc, {color: on ? color + 'AA' : Colors.textHint}]} numberOfLines={1}>
                  {description}
                </Text>
              )}
            </View>
          </View>
          {/* Simple small toggle button — position absolute so label gets full width */}
          {onToggle && (
            <TouchableOpacity
              style={[styles.toggleBtn, {backgroundColor: on ? color : '#E8ECF1', position: 'absolute', right: 0, top: 0}]}
              onPress={() => onToggle(!on)}
              activeOpacity={0.7}
              hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
            >
              <Ionicons
                name={on ? 'power' : 'power-outline'}
                size={13}
                color={on ? '#FFFFFF' : '#B0B8C5'}
              />
            </TouchableOpacity>
          )}
        </View>
      </View>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  outerCard: {
    borderRadius: 18,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: Colors.cardBorder,
    overflow: 'hidden',
    ...Shadows.subtle,
  },
  accentBar: {
    height: 4,
  },
  body: {
    paddingVertical: 10,
    paddingHorizontal: 11,
  },
  topSection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    position: 'relative',
  },
  labelArea: {
    flex: 1,
  },
  iconCircle: {
    width: 30,
    height: 30,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pumpName: {
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: -0.2,
  },
  pumpDesc: {
    fontSize: 10,
    fontWeight: '500',
    marginTop: 1,
    letterSpacing: 0.1,
  },
  toggleBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
