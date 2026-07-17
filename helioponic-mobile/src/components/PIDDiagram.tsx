import React, {useEffect, useRef} from 'react';
import {View, Text, Animated, Easing, StyleSheet} from 'react-native';
import Svg, {
  Rect,
  Circle,
  Line,
  Text as SvgText,
  G,
  Defs,
  LinearGradient,
  Stop,
  Filter,
  FeDropShadow,
  Path,
} from 'react-native-svg';
import {useSensorStore} from '../store/sensorStore';
import {Colors} from '../context/ThemeContext';
import * as d3 from 'd3';

// ─── Layout Constants (SVG viewBox: 0 0 360 360) ────────────────────
const SVG_W = 360;
const SVG_H = 360;

// Solar panel
const SOLAR_X = 226;
const SOLAR_Y = 8;
const SOLAR_W = 120;
const SOLAR_H = 46;

// Pump row
const PUMP_ROW_TOP = 78;    // pumps start here
const PUMP_W = 60;
const PUMP_H = 48;
const PUMP_GAP = 14;

const PUMPS = [
  {id: 'pompa-1', label: 'P1', sub: 'Circulation', color: Colors.waterTeal, cx: 24},
  {id: 'pompa-2', label: 'P2', sub: 'pH Down', color: Colors.tempBlue, cx: 24 + PUMP_W + PUMP_GAP},
  {id: 'pompa-3', label: 'P3', sub: 'Nutrient A', color: Colors.energyOrange, cx: 24 + 2 * (PUMP_W + PUMP_GAP)},
  {id: 'pompa-4', label: 'P4', sub: 'Nutrient B', color: '#7B1FA2', cx: 24 + 3 * (PUMP_W + PUMP_GAP)},
];

// Header pipe (collector) – flows into main down pipe
const HEADER_Y = 175;
const HEADER_LEFT = PUMPS[0].cx + PUMP_W / 2;   // 54
const HEADER_RIGHT = PUMPS[3].cx + PUMP_W / 2;   // 282
const HEADER_CENTER_X = (HEADER_LEFT + HEADER_RIGHT) / 2; // 168

// Sensors
const SENSOR_PH_Y = 215;
const SENSOR_TDS_Y = 245;

// Tank (bottom)
const TANK_X = 90;
const TANK_Y = 285;
const TANK_W = 180;
const TANK_H = 55;
const TANK_CENTER_X = TANK_X + TANK_W / 2; // 180

// ─── Color constants ────────────────────────────────────────────────
const activeColor = '#00d2ff';
const inactiveColor = '#4a4a4a';

// ─── Water level calculator ──────────────────────────────────────────
function computeWaterPct(jarakCm: number): number {
  if (jarakCm >= 999 || jarakCm < 0) return 0;
  const TANK_DEPTH_CM = 7;
  const waterDepth = TANK_DEPTH_CM - Math.min(jarakCm, TANK_DEPTH_CM);
  return Math.max(0, Math.min(100, (waterDepth / TANK_DEPTH_CM) * 100));
}

// ─── Fluid Flow Pipe Component (animated dash for flowing direction) ─
const FluidPipe = React.memo(function FluidPipe({
  x1, y1, x2, y2, active, dashAnim,
}: {
  x1: number; y1: number; x2: number; y2: number;
  active: boolean;
  dashAnim: Animated.Value;
}) {
  const dashOffset = dashAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -36],
  });

  return (
    <AnimatedSvgLine
      x1={x1} y1={y1} x2={x2} y2={y2}
      stroke={active ? activeColor : inactiveColor}
      strokeWidth={3.5}
      strokeLinecap="round"
      strokeDasharray={active ? '10, 6' : '0'}
      strokeDashoffset={active ? dashOffset : (0 as any)}
      opacity={active ? 1 : 0.35}
    />
  );
});

const AnimatedSvgLine = Animated.createAnimatedComponent(Line);

// ─── Flow Direction Arrow (small triangle pointing in flow direction) ─
function FlowArrow({cx, cy, dir = 'down', active}: {cx: number; cy: number; dir?: 'down' | 'right'; active: boolean}) {
  if (dir === 'down') {
    return (
      <Path
        d={`M${cx - 5},${cy - 4} L${cx + 5},${cy - 4} L${cx},${cy + 4} Z`}
        fill={active ? activeColor : inactiveColor}
        opacity={active ? 0.8 : 0.25}
      />
    );
  }
  // right arrow
  return (
    <Path
      d={`M${cx - 4},${cy - 5} L${cx - 4},${cy + 5} L${cx + 4},${cy} Z`}
      fill={active ? activeColor : inactiveColor}
      opacity={active ? 0.8 : 0.25}
    />
  );
}

// ─── Solar Panel Sub-component ──────────────────────────────────────
function SolarPanel() {
  const rows = 3;
  const cols = 4;
  const cellW = (SOLAR_W - 10) / cols;
  const cellH = (SOLAR_H - 8) / rows;
  const cells: {cx: number; cy: number}[] = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({
        cx: SOLAR_X + 5 + c * cellW + cellW / 2,
        cy: SOLAR_Y + 4 + r * cellH + cellH / 2,
      });
    }
  }

  return (
    <G id="solar-panel">
      {/* Sun rays behind the panel */}
      <Circle cx={SOLAR_X + SOLAR_W + 18} cy={SOLAR_Y - 4} r={10} fill="#FFD54F" opacity={0.6} />
      {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => {
        const rad = (angle * Math.PI) / 180;
        const len = 14;
        return (
          <Line
            key={angle}
            x1={SOLAR_X + SOLAR_W + 18 + Math.cos(rad) * 12}
            y1={SOLAR_Y - 4 + Math.sin(rad) * 12}
            x2={SOLAR_X + SOLAR_W + 18 + Math.cos(rad) * (12 + len)}
            y2={SOLAR_Y - 4 + Math.sin(rad) * (12 + len)}
            stroke="#FFD54F"
            strokeWidth={2}
            opacity={0.7}
            strokeLinecap="round"
          />
        );
      })}
      {/* Sun center */}
      <Circle cx={SOLAR_X + SOLAR_W + 18} cy={SOLAR_Y - 4} r={7} fill="#FFC107" />

      {/* Panel frame */}
      <Rect
        x={SOLAR_X} y={SOLAR_Y}
        width={SOLAR_W} height={SOLAR_H}
        rx={5} ry={5}
        fill="#E3F2FD"
        stroke="#90A4AE"
        strokeWidth={1.5}
      />
      {/* Solar cells grid */}
      {cells.map((cell, i) => (
        <Rect
          key={i}
          x={cell.cx - cellW / 2 + 1}
          y={cell.cy - cellH / 2 + 1}
          width={cellW - 2}
          height={cellH - 2}
          rx={1.5}
          ry={1.5}
          fill="#BBDEFB"
          stroke="#64B5F6"
          strokeWidth={0.5}
          opacity={0.85}
        />
      ))}
      {/* Cell divider lines (horizontal) */}
      {[1, 2].map((r) => (
        <Line
          key={`h-${r}`}
          x1={SOLAR_X + 5}
          y1={SOLAR_Y + 4 + r * cellH}
          x2={SOLAR_X + SOLAR_W - 5}
          y2={SOLAR_Y + 4 + r * cellH}
          stroke="#90CAF9"
          strokeWidth={0.5}
        />
      ))}
      {/* Cell divider lines (vertical) */}
      {[1, 2, 3].map((c) => (
        <Line
          key={`v-${c}`}
          x1={SOLAR_X + 5 + c * cellW}
          y1={SOLAR_Y + 4}
          x2={SOLAR_X + 5 + c * cellW}
          y2={SOLAR_Y + SOLAR_H - 4}
          stroke="#90CAF9"
          strokeWidth={0.5}
        />
      ))}
      {/* Panel label */}
      <SvgText
        x={SOLAR_X + SOLAR_W / 2}
        y={SOLAR_Y + SOLAR_H + 12}
        textAnchor="middle"
        fontSize={7.5}
        fontWeight="700"
        fill="#546E7A"
        letterSpacing={0.5}
      >
        SOLAR PANEL 100W
      </SvgText>

      {/* Power wire from solar panel to pumps */}
      <Path
        d={`M${SOLAR_X + SOLAR_W / 2},${SOLAR_Y + SOLAR_H}
            L${SOLAR_X + SOLAR_W / 2},${SOLAR_Y + SOLAR_H + 10}
            Q${SOLAR_X + SOLAR_W / 2},${PUMP_ROW_TOP - 8}
            ${HEADER_CENTER_X - 20},${PUMP_ROW_TOP - 8}
            L${HEADER_CENTER_X - 20},${PUMP_ROW_TOP}`}
        fill="none"
        stroke="#FFA726"
        strokeWidth={1.5}
        strokeDasharray="4,3"
        opacity={0.6}
      />
      {/* Power dot at end */}
      <Circle cx={HEADER_CENTER_X - 20} cy={PUMP_ROW_TOP} r={2.5} fill="#FFA726" opacity={0.7} />
      {/* Lightning bolt icon near wire */}
      <Path
        d="M5,5 L8,12 L4,12 L7,19"
        fill="none"
        stroke="#FFA726"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.5}
        transform={`translate(${HEADER_CENTER_X - 26}, ${PUMP_ROW_TOP - 14}) scale(0.7)`}
      />
    </G>
  );
}

// ─── Main Component ─────────────────────────────────────────────────
export default function PIDDiagram() {
  const latestReading = useSensorStore((s) => s.latestReading);
  const overridePumps = useSensorStore((s) => s.overridePumps);

  // Effective pump states (override > actual > default OFF)
  const p1 = overridePumps.pompa1 ?? latestReading?.pompa1 ?? 0;
  const p2 = overridePumps.pompa2 ?? latestReading?.pompa2 ?? 0;
  const p3 = overridePumps.pompa3 ?? latestReading?.pompa3 ?? 0;
  const p4 = overridePumps.pompa4 ?? latestReading?.pompa4 ?? 0;
  const abActive = p3 === 1 || p4 === 1;

  const ph = latestReading?.current_ph;
  const tds = latestReading?.tds_value;
  const jarak = latestReading?.jarak_cm;
  const waterPct = jarak != null ? Math.round(computeWaterPct(jarak)) : 0;
  const hasData = latestReading != null;

  // ── D3-based fluid flow animations ─────────────────────────────────
  const flowAnims = useRef<PipeAnimRefs>({
    'pipa-sirkulasi': new Animated.Value(0),
    'pipa-ph': new Animated.Value(0),
    'pipa-nutrisi-a': new Animated.Value(0),
    'pipa-nutrisi-b': new Animated.Value(0),
    'pipa-main': new Animated.Value(0),
  });

  useEffect(() => {
    const anyActive = p1 === 1 || p2 === 1 || abActive;

    const pipes: [string, boolean][] = [
      ['pipa-sirkulasi', p1 === 1],
      ['pipa-ph', p2 === 1],
      ['pipa-nutrisi-a', abActive],
      ['pipa-nutrisi-b', abActive],
      ['pipa-main', anyActive],
    ];

    pipes.forEach(([pipeId, shouldFlow]) => {
      const anim = flowAnims.current[pipeId];
      anim.stopAnimation();
      if (shouldFlow) {
        Animated.loop(
          Animated.timing(anim, {
            toValue: 1,
            duration: 1200,
            easing: Easing.linear,
            useNativeDriver: true,
          }),
          {iterations: -1},
        ).start();
      } else {
        anim.setValue(0);
      }
    });

    return () => {
      Object.values(flowAnims.current).forEach((a) => a.stopAnimation());
    };
  }, [p1, p2, p3, p4, abActive]);

  // ── Pump fill colors using D3.js interpolation ────────────────────
  const p1Color = d3.interpolateRgb('#546E7A', Colors.waterTeal)(p1);
  const p2Color = d3.interpolateRgb('#546E7A', Colors.tempBlue)(p2);
  const p3Color = d3.interpolateRgb('#546E7A', Colors.energyOrange)(p3);
  const p4Color = d3.interpolateRgb('#546E7A', '#7B1FA2')(p4);

  return (
    <View style={styles.wrapper}>
      {/* Header row */}
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>P&ID</Text>
          </View>
          <Text style={styles.title}>Piping & Instrumentation</Text>
        </View>
        {hasData && (
          <View style={[styles.liveDot, {backgroundColor: Colors.statusGreen}]} />
        )}
      </View>

      {/* SVG P&ID Diagram */}
      <Svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} width="100%" height={SVG_H * 0.75}>
        <Defs>
          <Filter id="pump-glow">
            <FeDropShadow dx={0} dy={0} stdDeviation={5} floodColor="#00d2ff" floodOpacity={0.7} />
          </Filter>
          <LinearGradient id="water-grad" x1="0%" y1="0%" x2="0%" y2="100%">
            <Stop offset="0%" stopColor="#4FC3F7" stopOpacity={0.8} />
            <Stop offset="100%" stopColor="#0288D1" stopOpacity={0.9} />
          </LinearGradient>
          <LinearGradient id="pump-body" x1="0%" y1="0%" x2="100%" y2="100%">
            <Stop offset="0%" stopColor="#ECEFF1" stopOpacity={1} />
            <Stop offset="100%" stopColor="#CFD8DC" stopOpacity={1} />
          </LinearGradient>
          <LinearGradient id="tank-grad" x1="0%" y1="0%" x2="0%" y2="100%">
            <Stop offset="0%" stopColor="#ECEFF1" stopOpacity={1} />
            <Stop offset="100%" stopColor="#E0E0E0" stopOpacity={1} />
          </LinearGradient>
        </Defs>

        {/* ═══════════════════════ SOLAR PANEL ═══════════════════════ */}
        <SolarPanel />

        {/* ═══════════════════════ PUMPS ═══════════════════════ */}
        {PUMPS.map((pump) => {
          const isActive = pump.id === 'pompa-1'
            ? p1 === 1
            : pump.id === 'pompa-2'
              ? p2 === 1
              : abActive;

          const fillColor = pump.id === 'pompa-1'
            ? p1Color
            : pump.id === 'pompa-2'
              ? p2Color
              : pump.id === 'pompa-3'
                ? p3Color
                : p4Color;

          return (
            <G key={pump.id} id={pump.id}>
              {/* Pump body */}
              <Rect
                x={pump.cx}
                y={PUMP_ROW_TOP}
                width={PUMP_W}
                height={PUMP_H}
                rx={8}
                ry={8}
                fill="url(#pump-body)"
                stroke={isActive ? fillColor : '#546E7A'}
                strokeWidth={isActive ? 1.5 : 1}
                opacity={isActive ? 1 : 0.6}
                filter={isActive ? 'url(#pump-glow)' : undefined}
              />
              {/* Motor circle */}
              <Circle
                cx={pump.cx + PUMP_W / 2}
                cy={PUMP_ROW_TOP + PUMP_H / 2}
                r={10}
                fill={isActive ? fillColor : '#B0BEC5'}
                opacity={isActive ? 1 : 0.5}
              />
              {/* Impeller chevron */}
              {isActive && (
                <Path
                  d={`M${pump.cx + PUMP_W / 2 - 4},${PUMP_ROW_TOP + PUMP_H / 2 - 4}
                      L${pump.cx + PUMP_W / 2 + 4},${PUMP_ROW_TOP + PUMP_H / 2}
                      L${pump.cx + PUMP_W / 2 - 4},${PUMP_ROW_TOP + PUMP_H / 2 + 4}`}
                  fill="none"
                  stroke="#FFFFFF"
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
              {/* Label */}
              <SvgText
                x={pump.cx + PUMP_W / 2}
                y={PUMP_ROW_TOP + PUMP_H + 11}
                textAnchor="middle"
                fontSize={9}
                fontWeight="800"
                fill={isActive ? fillColor : '#546E7A'}
                letterSpacing={0.5}
              >
                {pump.label}
              </SvgText>
              <SvgText
                x={pump.cx + PUMP_W / 2}
                y={PUMP_ROW_TOP + PUMP_H + 21}
                textAnchor="middle"
                fontSize={6.5}
                fontWeight="600"
                fill={isActive ? fillColor : '#78909C'}
                opacity={0.7}
              >
                {pump.sub}
              </SvgText>
              {/* Status dot */}
              <Circle
                cx={pump.cx + PUMP_W - 8}
                cy={PUMP_ROW_TOP + 10}
                r={4}
                fill={isActive ? fillColor : '#B0BEC5'}
                opacity={isActive ? 1 : 0.4}
              />
            </G>
          );
        })}

        {/* ═══════════════════════ VERTICAL PIPES: PUMP → HEADER ══════════ */}
        {/* Each pump has an outflow pipe going DOWN to the header */}
        {PUMPS.map((pump, i) => {
          const pumpCenterX = pump.cx + PUMP_W / 2;
          const pumpBottom = PUMP_ROW_TOP + PUMP_H;
          const pipeId = i === 0 ? 'pipa-sirkulasi' : i === 1 ? 'pipa-ph' : i === 2 ? 'pipa-nutrisi-a' : 'pipa-nutrisi-b';
          const isActive = i === 0 ? p1 === 1 : i === 1 ? p2 === 1 : abActive;

          return (
            <G key={`pipe-${pump.id}`} id={pipeId}>
              {/* Outflow pipe from pump bottom to header */}
              <FluidPipe
                x1={pumpCenterX} y1={pumpBottom}
                x2={pumpCenterX} y2={HEADER_Y}
                active={isActive}
                dashAnim={flowAnims.current[pipeId]}
              />
              {/* Flow direction arrow */}
              <FlowArrow cx={pumpCenterX} cy={(pumpBottom + HEADER_Y) / 2} dir="down" active={isActive} />
            </G>
          );
        })}

        {/* ═══════════════════════ HORIZONTAL HEADER PIPE ═══════════════════ */}
        {/* Header pipe collects from all pumps */}
        <G id="pipa-main">
          <FluidPipe
            x1={HEADER_LEFT} y1={HEADER_Y}
            x2={HEADER_RIGHT} y2={HEADER_Y}
            active={p1 === 1 || p2 === 1 || abActive}
            dashAnim={flowAnims.current['pipa-main']}
          />
          {/* Flow arrows along header (right → center, left → center) */}
          {[HEADER_LEFT + 20, HEADER_CENTER_X - 20].map((cx) => (
            <FlowArrow key={cx} cx={cx} cy={HEADER_Y} dir="right" active={p1 === 1 || p2 === 1 || abActive} />
          ))}
          {[HEADER_CENTER_X + 10, HEADER_RIGHT - 10].map((cx) => (
            <FlowArrow key={cx} cx={cx} cy={HEADER_Y} dir="right" active={abActive || p2 === 1} />
          ))}
        </G>

        {/* ═══════════════════════ MAIN DOWN PIPE (HEADER → TANK) ════════ */}
        {/* Junction at header center going down to tank */}
        <G>
          <FluidPipe
            x1={HEADER_CENTER_X} y1={HEADER_Y}
            x2={HEADER_CENTER_X} y2={SENSOR_PH_Y - 8}
            active={p1 === 1 || p2 === 1 || abActive}
            dashAnim={flowAnims.current['pipa-main']}
          />
          {/* Junction dot */}
          <Circle cx={HEADER_CENTER_X} cy={HEADER_Y} r={4} fill={p1 === 1 || p2 === 1 || abActive ? activeColor : inactiveColor} opacity={0.7} />
        </G>

        {/* ═══════════════════════ pH SENSOR ═══════════════════════ */}
        <G id="sensor-ph">
          {/* Sensor body (inline circle) */}
          <Circle
            cx={HEADER_CENTER_X}
            cy={SENSOR_PH_Y}
            r={9}
            fill={ph != null && ph > 0 && ph >= 4 && ph <= 8 ? '#00897B' : '#E53935'}
            stroke="#FFFFFF"
            strokeWidth={2}
            opacity={0.9}
          />
          {/* pH label ribbon */}
          <Rect x={HEADER_CENTER_X - 18} y={SENSOR_PH_Y - 24} width={36} height={15} rx={4} fill="#ECEFF1" />
          <SvgText
            x={HEADER_CENTER_X}
            y={SENSOR_PH_Y - 14}
            textAnchor="middle"
            fontSize={7.5}
            fontWeight="800"
            fill="#546E7A"
          >
            pH
          </SvgText>
        </G>

        {/* Pipe segment: pH → TDS */}
        <FluidPipe
          x1={HEADER_CENTER_X} y1={SENSOR_PH_Y + 9}
          x2={HEADER_CENTER_X} y2={SENSOR_TDS_Y - 9}
          active={p1 === 1 || p2 === 1 || abActive}
          dashAnim={flowAnims.current['pipa-main']}
        />

        {/* ═══════════════════════ TDS SENSOR ═══════════════════════ */}
        <G id="sensor-tds">
          <Circle
            cx={HEADER_CENTER_X}
            cy={SENSOR_TDS_Y}
            r={9}
            fill={tds != null && tds > 0 ? '#EF6C00' : '#E53935'}
            stroke="#FFFFFF"
            strokeWidth={2}
            opacity={0.9}
          />
          {/* TDS label ribbon */}
          <Rect x={HEADER_CENTER_X - 20} y={SENSOR_TDS_Y - 24} width={40} height={15} rx={4} fill="#ECEFF1" />
          <SvgText
            x={HEADER_CENTER_X}
            y={SENSOR_TDS_Y - 14}
            textAnchor="middle"
            fontSize={7.5}
            fontWeight="800"
            fill="#546E7A"
          >
            TDS
          </SvgText>
        </G>

        {/* Pipe segment: TDS → Tank (final segment) */}
        <FluidPipe
          x1={HEADER_CENTER_X} y1={SENSOR_TDS_Y + 9}
          x2={HEADER_CENTER_X} y2={TANK_Y - 2}
          active={p1 === 1 || p2 === 1 || abActive}
          dashAnim={flowAnims.current['pipa-main']}
        />

        {/* Flow arrows on main pipe */}
        <FlowArrow cx={HEADER_CENTER_X} cy={(HEADER_Y + SENSOR_PH_Y) / 2} dir="down" active={p1 === 1 || p2 === 1 || abActive} />
        <FlowArrow cx={HEADER_CENTER_X} cy={(SENSOR_PH_Y + SENSOR_TDS_Y) / 2} dir="down" active={p1 === 1 || p2 === 1 || abActive} />
        <FlowArrow cx={HEADER_CENTER_X} cy={(SENSOR_TDS_Y + TANK_Y) / 2} dir="down" active={p1 === 1 || p2 === 1 || abActive} />

        {/* ═══════════════════════ HYDROPONIC TANK (BAK HIDROPONIK) ═══════ */}
        <G id="water-tank">
          {/* Tank body */}
          <Rect
            x={TANK_X} y={TANK_Y}
            width={TANK_W} height={TANK_H}
            rx={8} ry={8}
            fill="url(#tank-grad)"
            stroke="#546E7A"
            strokeWidth={1.5}
          />
          {/* Water fill inside tank */}
          {hasData && waterPct > 0 && (
            <Rect
              x={TANK_X + 3}
              y={TANK_Y + TANK_H - 5 - (waterPct / 100) * (TANK_H - 8)}
              width={TANK_W - 6}
              height={Math.max(5, (waterPct / 100) * (TANK_H - 8))}
              rx={4} ry={4}
              fill="url(#water-grad)"
              opacity={0.8}
            />
          )}
          {/* Water surface wave */}
          {hasData && waterPct > 0 && (
            <Path
              d={`M${TANK_X + 3},${TANK_Y + TANK_H - 5 - (waterPct / 100) * (TANK_H - 8) + 2}
                  Q${TANK_X + TANK_W / 4},${TANK_Y + TANK_H - 5 - (waterPct / 100) * (TANK_H - 8) - 2}
                  ${TANK_X + TANK_W / 2},${TANK_Y + TANK_H - 5 - (waterPct / 100) * (TANK_H - 8) + 2}
                  Q${TANK_X + 3 * TANK_W / 4},${TANK_Y + TANK_H - 5 - (waterPct / 100) * (TANK_H - 8) + 6}
                  ${TANK_X + TANK_W - 3},${TANK_Y + TANK_H - 5 - (waterPct / 100) * (TANK_H - 8) + 2}`}
              fill="none"
              stroke="#81D4FA"
              strokeWidth={1.5}
              opacity={0.6}
            />
          )}
          {/* Water level text */}
          {hasData && (
            <SvgText
              x={TANK_CENTER_X}
              y={TANK_Y + TANK_H - 16}
              textAnchor="middle"
              fontSize={13}
              fontWeight="900"
              fill="#01579B"
              opacity={0.85}
            >
              {waterPct}%
            </SvgText>
          )}
          {/* Water inlet point (top-center) */}
          <Circle cx={HEADER_CENTER_X} cy={TANK_Y} r={4} fill="#546E7A" />
          {/* Inlet arrow into tank */}
          <Path
            d={`M${HEADER_CENTER_X - 5},${TANK_Y - 8} L${HEADER_CENTER_X + 5},${TANK_Y - 8} L${HEADER_CENTER_X},${TANK_Y - 2} Z`}
            fill={p1 === 1 || p2 === 1 || abActive ? activeColor : inactiveColor}
            opacity={p1 === 1 || p2 === 1 || abActive ? 0.9 : 0.3}
          />
          {/* Tank label */}
          <SvgText
            x={TANK_CENTER_X}
            y={TANK_Y + 14}
            textAnchor="middle"
            fontSize={8}
            fontWeight="700"
            fill="#546E7A"
            letterSpacing={0.5}
          >
            HYDROPONIC TANK
          </SvgText>
        </G>

        {/* ═══════════════════════ INLINE TEXT LABELS ═══════════════════ */}
        {/* Dynamic pH value */}
        <G id="text-ph">
          <Rect x={HEADER_CENTER_X + 16} y={SENSOR_PH_Y - 8} width={48} height={19} rx={6} fill="#ECEFF1" opacity={0.9} />
          <SvgText
            x={HEADER_CENTER_X + 40}
            y={SENSOR_PH_Y + 5}
            textAnchor="middle"
            fontSize={10}
            fontWeight="800"
            fill={hasData && ph != null && ph > 0 ? '#00897B' : '#90A4AE'}
          >
            {hasData && ph != null ? `${ph.toFixed(1)}` : '--'}
          </SvgText>
        </G>

        {/* Dynamic TDS value */}
        <G id="text-tds">
          <Rect x={HEADER_CENTER_X + 16} y={SENSOR_TDS_Y - 8} width={56} height={19} rx={6} fill="#ECEFF1" opacity={0.9} />
          <SvgText
            x={HEADER_CENTER_X + 44}
            y={SENSOR_TDS_Y + 5}
            textAnchor="middle"
            fontSize={10}
            fontWeight="800"
            fill={hasData && tds != null && tds > 0 ? '#EF6C00' : '#90A4AE'}
          >
            {hasData && tds != null ? `${tds.toFixed(0)}ppm` : '--'}
          </SvgText>
        </G>

        {/* Water level label on tank */}
        <G id="text-water-level">
          <SvgText
            x={TANK_CENTER_X}
            y={TANK_Y + TANK_H + 14}
            textAnchor="middle"
            fontSize={8}
            fontWeight="700"
            fill="#546E7A"
            letterSpacing={0.3}
          >
            {hasData ? `${waterPct}% Full` : '--'}
          </SvgText>
        </G>
      </Svg>

      {/* ── Legend ── */}
      <View style={styles.legend}>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, {backgroundColor: Colors.waterTeal}]} />
          <Text style={styles.legendLabel}>Circulation</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, {backgroundColor: Colors.tempBlue}]} />
          <Text style={styles.legendLabel}>pH Down</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, {backgroundColor: Colors.energyOrange}]} />
          <Text style={styles.legendLabel}>Nutrient A</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, {backgroundColor: '#7B1FA2'}]} />
          <Text style={styles.legendLabel}>Nutrient B</Text>
        </View>
        <View style={styles.legendSpacer} />
        <View style={styles.legendItem}>
          <View style={[styles.legendPulse, {backgroundColor: activeColor}]} />
          <Text style={[styles.legendLabel, {color: activeColor}]}>Flow</Text>
        </View>
        <View style={styles.legendSpacer} />
        <View style={styles.legendItem}>
          <Path d="M0,0 L4,-6 L8,0 Z" fill="#FFA726" opacity={0.7} />
          <Text style={styles.legendLabel}>Solar Panel</Text>
        </View>
      </View>
    </View>
  );
}

// ─── Types ──────────────────────────────────────────────────────────
type PipeAnimRefs = Record<string, Animated.Value>;

// ─── Styles ─────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  wrapper: {
    backgroundColor: '#F8F9FA',
    borderRadius: 20,
    padding: 12,
    paddingBottom: 8,
    borderWidth: 1,
    borderColor: '#E0E4E8',
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 4},
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 4,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
    paddingHorizontal: 4,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  badge: {
    backgroundColor: '#00d2ff',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  badgeText: {
    fontSize: 9,
    fontWeight: '900',
    color: '#FFFFFF',
    letterSpacing: 0.5,
  },
  title: {
    fontSize: 12,
    fontWeight: '700',
    color: '#546E7A',
    letterSpacing: 0.2,
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legend: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 6,
    gap: 4,
    flexWrap: 'wrap',
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  legendDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  legendPulse: {
    width: 8,
    height: 4,
    borderRadius: 2,
    opacity: 0.8,
  },
  legendLabel: {
    fontSize: 8,
    fontWeight: '700',
    color: '#546E7A',
    letterSpacing: 0.3,
  },
  legendSpacer: {
    width: 1,
    height: 12,
    backgroundColor: '#CFD8DC',
    marginHorizontal: 2,
  },
});
