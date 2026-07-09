import React, {createContext, useContext, useEffect, useRef, useCallback} from 'react';
import {WS_URL, WS_RECONNECT_DELAY_MS} from '../constants';
import {useSensorStore} from '../store/sensorStore';
import {getApiToken} from '../lib/apiClient';
import {SensorReading} from '../types/api';
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
  const resetSensor = useSensorStore((s) => s.reset);
  deviceIdRef.current = activeDeviceId;

  const scheduleReconnect = useCallback(() => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = setTimeout(() => connect(), WS_RECONNECT_DELAY_MS);
  }, []);

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
      ws.onmessage = (event) => {
        try {const data = JSON.parse(event.data) as SensorReading; setLatestReading(data);} catch {}
      };
      ws.onerror = () => {setConnected(false); scheduleReconnect();};
      ws.onclose = () => {setConnected(false); scheduleReconnect();};
    } catch {setConnected(false); scheduleReconnect();}
  }, [setLatestReading, setConnected, scheduleReconnect]);

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
