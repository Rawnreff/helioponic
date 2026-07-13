import React, {createContext, useContext, useEffect, useRef, useCallback} from 'react';
import {WS_URL, WS_RECONNECT_DELAY_MS} from '../constants';
import {useSensorStore} from '../store/sensorStore';
import {getApiToken} from '../lib/apiClient';
import type {WebSocketMessage, WebSocketSensorMessage} from '../types/api';
import {useAuth} from './AuthContext';

interface WebSocketContextValue {isConnected: boolean}
const WebSocketContext = createContext<WebSocketContextValue>({isConnected: false});

export function WebSocketProvider({children}: {children: React.ReactNode}) {
  const {activeDeviceId} = useAuth();
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deviceIdRef = useRef(activeDeviceId);
  const setLatestReading = useSensorStore((s) => s.setLatestReading);
  const setConnected = useSensorStore((s) => s.setConnected);
  const setDeviceStatus = useSensorStore((s) => s.setDeviceStatus);
  const setAlarm = useSensorStore((s) => s.setAlarm);
  const resetSensor = useSensorStore((s) => s.reset);
  deviceIdRef.current = activeDeviceId;

  const scheduleReconnect = useCallback(() => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = setTimeout(() => connect(), WS_RECONNECT_DELAY_MS);
  }, []);

  const handleMessage = useCallback((raw: string) => {
    try {
      const msg: WebSocketMessage = JSON.parse(raw);

      // Type discrimination based on 'type' field
      switch (msg.type) {
        case 'sensor_update': {
          const sensorMsg = msg as WebSocketSensorMessage;
          setLatestReading({
            device_id: sensorMsg.device_id,
            ts: sensorMsg.ts,
            jarak_cm: sensorMsg.jarak_cm,
            tds_value: sensorMsg.tds_value,
            current_ph: sensorMsg.current_ph,
            pompa1: sensorMsg.pompa1,
            pompa2: sensorMsg.pompa2,
          });
          break;
        }
        case 'status_update':
          setDeviceStatus(msg.status);
          break;
        case 'alarm':
          setAlarm({
            type: msg.alarm_type,
            message: msg.message,
            ts: msg.ts,
          });
          break;
        default:
          // Legacy format without 'type' field — treat as sensor data
          const legacyReading = JSON.parse(raw);
          if (legacyReading.jarak_cm !== undefined) {
            setLatestReading({
              device_id: legacyReading.device_id || '',
              ts: legacyReading.ts || 0,
              jarak_cm: legacyReading.jarak_cm,
              tds_value: legacyReading.tds_value || 0,
              current_ph: legacyReading.current_ph || 0,
              pompa1: legacyReading.pompa1 ?? 0,
              pompa2: legacyReading.pompa2 ?? 0,
            });
          }
      }
    } catch {
      // Ignore malformed messages
    }
  }, [setLatestReading, setDeviceStatus, setAlarm]);

  const connect = useCallback(() => {
    if (wsRef.current) {wsRef.current.close(); wsRef.current = null;}
    const token = getApiToken();
    const params = new URLSearchParams();
    if (token) params.set('token', token);
    if (deviceIdRef.current) params.set('device_id', deviceIdRef.current);
    const url = `${WS_URL}?${params.toString()}`;
    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onmessage = (event) => handleMessage(event.data);
      ws.onerror = () => {setConnected(false); scheduleReconnect();};
      ws.onclose = () => {setConnected(false); scheduleReconnect();};
    } catch {setConnected(false); scheduleReconnect();}
  }, [setConnected, scheduleReconnect, handleMessage]);

  const disconnect = useCallback(() => {
    if (reconnectTimerRef.current) {clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null;}
    if (wsRef.current) {wsRef.current.close(); wsRef.current = null;}
    setConnected(false);
  }, [setConnected]);

  useEffect(() => {resetSensor(); connect(); return () => disconnect();}, [activeDeviceId, connect, disconnect, resetSensor]);

  const isConnected = useSensorStore((s) => s.isConnected);
  return <WebSocketContext.Provider value={{isConnected}}>{children}</WebSocketContext.Provider>;
}

export function useWebSocket(): WebSocketContextValue {return useContext(WebSocketContext)}
