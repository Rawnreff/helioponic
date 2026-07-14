import React, {useRef, useEffect} from 'react';
import {Animated, Easing, View} from 'react-native';

interface Props {
  /** 0–100 percentage value to animate to */
  value: number;
  /** Bar height in px (default: 4) */
  height?: number;
  /** Fill color (default: Colors.accentGreen fallback) */
  color?: string;
  /** Track background color (default: '#E8ECF1') */
  backgroundColor?: string;
  /** Border radius for both track & fill (default: 2) */
  borderRadius?: number;
  /** Extra styles applied to the outer track container */
  style?: any;
}

export function AnimatedProgressBar({
  value,
  height = 4,
  color = '#66BB6A',
  backgroundColor = '#E8ECF1',
  borderRadius = 2,
  style,
}: Props) {
  const anim = useRef(new Animated.Value(value)).current;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: value,
      duration: 500,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: false,
    }).start();
  }, [value, anim]);

  const widthInterp = anim.interpolate({
    inputRange: [0, 100],
    outputRange: ['0%', '100%'],
  });

  return (
    <View style={[{height, backgroundColor, borderRadius, overflow: 'hidden'}, style]}>
      <Animated.View
        style={{
          height: '100%',
          width: widthInterp,
          backgroundColor: color,
          borderRadius,
        }}
      />
    </View>
  );
}
