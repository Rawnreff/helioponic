import React from 'react';
import {View, Text, StyleSheet, Dimensions} from 'react-native';
import {LineChart} from 'react-native-gifted-charts';
import {Colors} from '../context/ThemeContext';

interface DataPoint {value: number; label?: string; dataPointText?: string}

interface Props {data: DataPoint[]; color?: string; gradientStart?: string; gradientEnd?: string; minY?: number; maxY?: number; unit?: string; height?: number; showAxes?: boolean; yLabelSuffix?: string}

export function HistoryLineChart({data, color = Colors.tempBlue, gradientStart = Colors.tempBlue, gradientEnd = Colors.tempBlue + '00', minY, maxY, unit = '', height = 150, showAxes = false, yLabelSuffix = ''}: Props) {
  if (!data || data.length === 0) {
    return <View style={[styles.empty, {height}]}><Text style={styles.emptyText}>No data yet</Text></View>;
  }

  const values = data.map((d) => d.value);
  const computedMin = minY ?? Math.min(...values) * 0.9;
  const computedMax = maxY ?? Math.max(...values) * 1.1;

  const chartData = data.map((d, i) => ({
    value: d.value,
    label: d.label || (i % Math.max(1, Math.floor(data.length / 5)) === 0 ? d.label : ''),
    dataPointText: d.dataPointText,
  }));

  return (
    <View style={[styles.container, {height}]}>
      <LineChart
        data={chartData}
        color={color}
        thickness={2.5}
        startFillColor={gradientStart}
        endFillColor={gradientEnd}
        startOpacity={0.3}
        endOpacity={0.0}
        isAnimated
        animationDuration={400}
        curved
        curveType={1}
        areaChart
        width={Dimensions.get('window').width - 80}
        height={height - 30}
        initialSpacing={8}
        endSpacing={8}
        maxValue={computedMax}
        noOfSections={3}
        yAxisTextStyle={styles.yLabel}
        xAxisLabelTextStyle={styles.xLabel}
        xAxisColor={Colors.cardBorder}
        yAxisColor={Colors.cardBorder}
        showVerticalLines={false}
        showScrollIndicator={false}
        pointerConfig={{
          pointerStripHeight: height - 40,
          pointerStripColor: color + '40',
          pointerStripWidth: 1,
          pointerColor: color,
          radius: 6,
          pointerLabelWidth: 60,
          pointerLabelHeight: 28,
          activatePointersOnLongPress: true,
          autoAdjustPointerLabelPosition: true,
          pointerLabelComponent: (items: any[]) => {
            if (!items?.length) return null;
            return (
              <View style={[styles.tooltip, {borderColor: color}]}>
                <Text style={[styles.tooltipText, {color}]}>{items[0].value?.toFixed(1)}{unit}</Text>
              </View>
            );
          },
        }}
        dataPointsColor={color}
        dataPointsRadius={2}
        dataPointsWidth={0}
        showDataPointOnFocus
        focusEnabled
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {justifyContent: 'center', paddingRight: 8},
  empty: {justifyContent: 'center', alignItems: 'center'},
  emptyText: {color: Colors.textHint, fontSize: 12},
  yLabel: {fontSize: 9, color: Colors.textHint},
  xLabel: {fontSize: 8, color: Colors.textHint},
  tooltip: {backgroundColor: Colors.surface, borderRadius: 8, borderWidth: 1.5, paddingHorizontal: 8, paddingVertical: 4, shadowColor: '#000', shadowOffset: {width: 0, height: 2}, shadowOpacity: 0.1, shadowRadius: 4, elevation: 4},
  tooltipText: {fontSize: 12, fontWeight: '700', textAlign: 'center'},
});
