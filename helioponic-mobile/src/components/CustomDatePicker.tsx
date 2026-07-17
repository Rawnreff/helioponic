import React, {useState} from 'react';
import {View, Text, StyleSheet, TouchableOpacity, Modal, Platform} from 'react-native';
import {Ionicons} from '@expo/vector-icons';
import {Colors} from '../context/ThemeContext';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

interface Props {
  visible: boolean;
  value: Date;
  onSelect: (date: Date) => void;
  onCancel: () => void;
  maximumDate?: Date;
  /** Array of date strings 'YYYY-MM-DD' that have data in the DB.
   *  If provided, only these dates will be selectable.
   *  If omitted, all dates up to maximumDate are enabled. */
  enabledDates?: string[];
}

export default function CustomDatePicker({visible, value, onSelect, onCancel, maximumDate, enabledDates}: Props) {
  const [viewYear, setViewYear] = useState(value.getFullYear());
  const [viewMonth, setViewMonth] = useState(value.getMonth());
  const today = new Date();
  const maxDate = maximumDate || today;
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const firstDayOfWeek = new Date(viewYear, viewMonth, 1).getDay();

  // Convert enabledDates (YYYY-MM-DD) to a Set for fast lookup
  const enabledSet = enabledDates ? new Set(enabledDates) : null;

  const prevMonth = () => {if (viewMonth === 0) {setViewMonth(11); setViewYear(y => y - 1);} else setViewMonth(m => m - 1);};
  const nextMonth = () => {if (viewMonth === 11) {setViewMonth(0); setViewYear(y => y + 1);} else setViewMonth(m => m + 1);};

  const isDisabled = (day: number) => {
    const d = new Date(viewYear, viewMonth, day);
    d.setHours(23, 59, 59, 999);
    if (d > maxDate) return true;
    if (enabledSet) {
      const dateKey = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return !enabledSet.has(dateKey);
    }
    return false;
  };

  const isSelected = (day: number) => value.getDate() === day && value.getMonth() === viewMonth && value.getFullYear() === viewYear;
  const canGoNext = viewYear < maxDate.getFullYear() || (viewYear === maxDate.getFullYear() && viewMonth < maxDate.getMonth());
  const handleSelect = (day: number) => onSelect(new Date(viewYear, viewMonth, day));

  const grid: (number | null)[] = [];
  for (let i = 0; i < firstDayOfWeek; i++) grid.push(null);
  for (let d = 1; d <= daysInMonth; d++) grid.push(d);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onCancel}>
        <TouchableOpacity style={styles.container} activeOpacity={1} onPress={() => {}}>
          <View style={styles.header}>
            <TouchableOpacity onPress={prevMonth} style={styles.arrowBtn}><Ionicons name="chevron-back" size={20} color={Colors.textPrimary} /></TouchableOpacity>
            <Text style={styles.headerTitle}>{MONTHS[viewMonth]} {viewYear}</Text>
            <TouchableOpacity onPress={canGoNext ? nextMonth : undefined} style={[styles.arrowBtn, !canGoNext && styles.arrowDisabled]}><Ionicons name="chevron-forward" size={20} color={canGoNext ? Colors.textPrimary : Colors.textHint} /></TouchableOpacity>
          </View>
          <View style={styles.weekdayRow}>{WEEKDAYS.map((w) => <Text key={w} style={styles.weekdayText}>{w}</Text>)}</View>
          <View style={styles.grid}>{grid.map((day, i) => day ? (
            <TouchableOpacity key={i} style={[styles.dayBtn, isSelected(day) && styles.daySelected, isDisabled(day) && styles.dayDisabled]} onPress={() => !isDisabled(day) && handleSelect(day)} disabled={isDisabled(day)}>
              <Text style={[styles.dayText, isSelected(day) && styles.dayTextSelected, isDisabled(day) && styles.dayTextDisabled]}>{day}</Text>
            </TouchableOpacity>
          ) : <View key={i} style={styles.dayBtn} />)}</View>
          <TouchableOpacity style={styles.todayBtn} onPress={() => {setViewYear(today.getFullYear()); setViewMonth(today.getMonth()); handleSelect(today.getDate());}}><Ionicons name="today-outline" size={16} color={Colors.primaryGreen} /><Text style={styles.todayText}>Today</Text></TouchableOpacity>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', alignItems: 'center'},
  container: {backgroundColor: '#FFFFFF', borderRadius: 24, padding: 24, width: 320, ...Platform.select({ios: {shadowColor: '#000', shadowOffset: {width: 0, height: 12}, shadowOpacity: 0.2, shadowRadius: 24}, android: {elevation: 16}})},
  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16},
  headerTitle: {fontSize: 17, fontWeight: '700', color: Colors.textPrimary, letterSpacing: -0.3},
  arrowBtn: {padding: 6, borderRadius: 8},
  arrowDisabled: {opacity: 0.4},
  weekdayRow: {flexDirection: 'row', marginBottom: 8},
  weekdayText: {flex: 1, textAlign: 'center', fontSize: 11, fontWeight: '600', color: Colors.textSecondary, paddingVertical: 4},
  grid: {flexDirection: 'row', flexWrap: 'wrap'},
  dayBtn: {width: '14.28%', aspectRatio: 1, justifyContent: 'center', alignItems: 'center', borderRadius: 10},
  daySelected: {backgroundColor: Colors.primaryGreen},
  dayDisabled: {opacity: 0.3},
  dayText: {fontSize: 14, fontWeight: '600', color: Colors.textPrimary},
  dayTextSelected: {color: '#FFFFFF', fontWeight: '800'},
  dayTextDisabled: {color: Colors.textHint},
  todayBtn: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 16, paddingVertical: 10, borderRadius: 12, backgroundColor: '#E8F5E9'},
  todayText: {fontSize: 13, fontWeight: '700', color: Colors.primaryGreen},
});
