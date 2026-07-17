import React, {useState, useMemo, useCallback} from 'react';
import {View, Text, ScrollView, StyleSheet, LayoutChangeEvent, TouchableOpacity} from 'react-native';
import {LineChart} from 'react-native-gifted-charts';
import {Colors} from '../context/ThemeContext';

interface DataPoint {value: number; label?: string; dataPointText?: string}

interface Props {
  data: DataPoint[];
  color?: string;
  gradientStart?: string;
  gradientEnd?: string;
  minY?: number;
  maxY?: number;
  unit?: string;
  height?: number;
  yLabelSuffix?: string;
  chartWidth?: number;
  roundY?: boolean;
  minRange?: number;
  /** When true, the chart uses fixed spacing and becomes horizontally scrollable */
  scrollable?: boolean;
}

// ── Virtual window: max data points rendered at once ──
const PAGE_SIZE = 60;


export const HistoryLineChart = React.memo(function HistoryLineChart({
  data, color = Colors.tempBlue, gradientStart = Colors.tempBlue,
  gradientEnd = Colors.tempBlue + '00', minY, maxY, unit = '',
  height = 150, yLabelSuffix = '', chartWidth, roundY = false, minRange = 2,
  scrollable = false,
}: Props) {
  const [containerWidth, setContainerWidth] = useState(0);
  const [page, setPage] = useState(0);

  const onLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (w > 0 && w !== containerWidth) setContainerWidth(w);
  };

  // ── Memoize computed values ────────────────────────────
  const {chartData, computedMax, xLabels, totalPages} = useMemo(() => {
    if (!data || data.length === 0) {
      return {chartData: [], computedMax: 100, xLabels: [], totalPages: 0};
    }

    const values = data.map((d) => d.value);
    let rawMin = minY ?? Math.min(...values);
    let rawMax = maxY ?? Math.max(...values);
    if (rawMax - rawMin < minRange) {
      const mid = (rawMax + rawMin) / 2;
      rawMin = mid - minRange / 2;
      rawMax = mid + minRange / 2;
    }

    const chartData = data.map((d) => ({
      value: d.value,
      label: d.label || '',
      dataPointText: d.dataPointText,
    }));

    const xLabels = data.map((d) => d.label || '');

    // Compute pages for virtualized rendering
    const totalPages = scrollable ? Math.max(1, Math.ceil(chartData.length / PAGE_SIZE)) : 1;

    return {
      chartData,
      computedMax: rawMax * 1.1,
      xLabels,
      totalPages,
    };
  }, [data, minY, maxY, minRange, scrollable]);

  const width = chartWidth || containerWidth || 280;

  // ── Virtual window: slice data to current page ────
  const windowedData = useMemo(() => {
    if (!scrollable || totalPages <= 1) return chartData;
    const start = page * PAGE_SIZE;
    return chartData.slice(start, start + PAGE_SIZE);
  }, [chartData, page, scrollable, totalPages]);

  const windowedLabels = useMemo(() => {
    if (!scrollable || totalPages <= 1) return xLabels;
    const start = page * PAGE_SIZE;
    return xLabels.slice(start, start + PAGE_SIZE);
  }, [xLabels, page, scrollable, totalPages]);

  // ── Page navigation ───────────────────────────────────
  const goPrev = useCallback(() => setPage((p) => Math.max(0, p - 1)), []);
  const goNext = useCallback(() => setPage((p) => Math.min(totalPages - 1, p + 1)), [totalPages]);

  // ── Empty state ────────────────────────────────────────
  if (!data || data.length === 0) {
    return (
      <View style={[styles.empty, {height}]}>
        <Text style={styles.emptyText}>No data yet</Text>
      </View>
    );
  }

  // ── Spacing between data points ────────────────────────
  // 14px — compact but readable, ~4-5 horizontal swipes for 168 points
  const SPACING_PX = 14;
  const spacing = scrollable
    ? SPACING_PX
    : windowedData.length > 1
      ? (width - 48) / Math.max(windowedData.length - 1, 1)
      : width / 2;

  return (
    <View style={[styles.container, {height: height + (scrollable && totalPages > 1 ? 20 : 0)}]} onLayout={chartWidth ? undefined : onLayout}>
      {/* ── Navigation toolbar (virtual pages) ── */}
      {scrollable && totalPages > 1 && (
        <View style={styles.navBar}>
          <TouchableOpacity onPress={goPrev} disabled={page === 0} style={[styles.navBtn, page === 0 && styles.navBtnDisabled]}>
            <Text style={[styles.navArrow, page === 0 && styles.navArrowDisabled]}>{'◀'}</Text>
          </TouchableOpacity>

          <View style={styles.pageDots}>
            {Array.from({length: Math.min(totalPages, 7)}).map((_, i) => {
              // Show dots near current page
              const offset = Math.max(0, Math.min(page - 3, totalPages - 7));
              const dotIdx = offset + i;
              if (dotIdx >= totalPages) return null;
              return (
                <TouchableOpacity
                  key={dotIdx}
                  onPress={() => setPage(dotIdx)}
                  style={[
                    styles.pageDot,
                    dotIdx === page && styles.pageDotActive,
                    {backgroundColor: dotIdx === page ? color : '#D1D5DB'},
                  ]}
                />
              );
            })}
          </View>

          <TouchableOpacity onPress={goNext} disabled={page >= totalPages - 1} style={[styles.navBtn, page >= totalPages - 1 && styles.navBtnDisabled]}>
            <Text style={[styles.navArrow, page >= totalPages - 1 && styles.navArrowDisabled]}>{'▶'}</Text>
          </TouchableOpacity>

          <Text style={styles.pageLabel}>{page + 1}/{totalPages}</Text>
        </View>
      )}

      {/* ── Scroll hint (only when no pagination) ── */}
      {scrollable && totalPages <= 1 && chartData.length > 8 && (
        <View style={styles.scrollHint}>
          <Text style={styles.scrollHintText}>SWIPE {'→'}</Text>
        </View>
      )}

      {width > 0 && windowedData.length > 0 && (
        <LineChart
          data={windowedData}
          color={color}
          thickness={3}
          startFillColor={gradientStart}
          endFillColor={gradientEnd}
          startOpacity={0.3}
          endOpacity={0.02}
          isAnimated
          animationDuration={600}
          curved
          curveType={1}
          areaChart
          width={width - 16}
          height={height - 30}
          initialSpacing={10}
          endSpacing={10}
          spacing={spacing}
          maxValue={computedMax}
          noOfSections={3}
          // ── X-Axis labels ──
          xAxisLabelTexts={windowedLabels}
          xAxisLabelsHeight={18}
          xAxisLabelsVerticalShift={4}
          xAxisLabelTextStyle={styles.xLabel}
          xAxisThickness={0}
          xAxisColor="#E8ECF1"
          // ── Y-Axis ──
          yAxisTextStyle={styles.yLabel}
          yAxisColor="#E8ECF1"
          yAxisThickness={1}
          yAxisTextNumberOfLines={1}
          yAxisLabelSuffix={yLabelSuffix}
          formatYLabel={(val: string) => {
            const num = parseFloat(val);
            if (num >= 1000) return (num / 1000).toFixed(roundY ? 0 : 1) + 'k';
            return roundY ? num.toFixed(0) : num.toFixed(1);
          }}
          // ── Grid & rules ──
          showVerticalLines
          verticalLinesColor="#F1F3F5"
          verticalLinesThickness={1}
          verticalLinesStrokeDashArray={[3, 4]}
          rulesColor="#F1F3F5"
          rulesType="dashed"
          // ── Data points ──
          dataPointsColor={color}
          dataPointsRadius={3}
          dataPointsWidth={2}
          dataPointsShape="circle"
          showDataPointOnFocus
          focusEnabled
          // ── Pointer ──
          pointerConfig={{
            pointerStripHeight: height - 50,
            pointerStripColor: color + '40',
            pointerStripWidth: 1,
            pointerColor: color,
            radius: 6,
            pointerLabelWidth: 80,
            pointerLabelHeight: 40,
            activatePointersOnLongPress: true,
            autoAdjustPointerLabelPosition: true,
            pointerLabelComponent: (items: any[]) => {
              if (!items?.length) return null;
              const item = items[0];
              const idx = items[0]?.index ?? -1;
              const label = idx >= 0 && idx < windowedData.length ? windowedData[idx].label : '';
              return (
                <View style={[styles.tooltip, {borderColor: color}]}>
                  <Text style={[styles.tooltipValue, {color}]}>
                    {roundY ? item.value?.toFixed(0) : item.value?.toFixed(1)}{unit}
                  </Text>
                  {label ? (
                    <Text style={styles.tooltipLabel}>{label}</Text>
                  ) : null}
                </View>
              );
            },
          }}
          scrollToEnd={false}
        />
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {justifyContent: 'center', overflow: 'hidden'},
  empty: {justifyContent: 'center', alignItems: 'center'},
  emptyText: {color: Colors.textHint, fontSize: 12},
  yLabel: {fontSize: 10, color: Colors.textHint, fontWeight: '600'},
  xLabel: {fontSize: 9, color: Colors.textSecondary, fontWeight: '600', marginBottom: 2},
  tooltip: {
    backgroundColor: Colors.surface,
    borderRadius: 8,
    borderWidth: 1.5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 2},
    shadowOpacity: 0.15,
    shadowRadius: 6,
    elevation: 6,
    alignItems: 'center',
  },
  tooltipValue: {fontSize: 13, fontWeight: '800', textAlign: 'center'},
  tooltipLabel: {fontSize: 8, color: Colors.textHint, fontWeight: '600', marginTop: 2},
  scrollHint: {
    position: 'absolute',
    top: 0,
    right: 0,
    backgroundColor: '#E8ECF1',
    borderBottomLeftRadius: 10,
    borderTopRightRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 3,
    zIndex: 10,
  },
  scrollHintText: {
    fontSize: 8,
    fontWeight: '800',
    color: '#90A4AE',
    letterSpacing: 1,
  },
  // ── Virtual pagination bar ──
  navBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  navBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#F1F3F5',
    alignItems: 'center',
    justifyContent: 'center',
  },
  navBtnDisabled: {opacity: 0.3},
  navArrow: {fontSize: 10, color: Colors.textSecondary},
  navArrowDisabled: {color: '#D1D5DB'},
  pageDots: {flexDirection: 'row', gap: 5, alignItems: 'center'},
  pageDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  pageDotActive: {
    width: 9,
    height: 9,
    borderRadius: 5,
  },
  pageLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: Colors.textHint,
    minWidth: 28,
    textAlign: 'center',
  },
});
