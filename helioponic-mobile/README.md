# Helioponic Mobile — React Native Expo App

> Mobile dashboard for the Helioponic hydroponic monitoring & automation system.
> **Stack:** React Native (Expo) + TypeScript + Zustand + WebSocket

---

## Features

- **Real-time Dashboard** — Live sensor cards (jarak_cm, TDS, pH) updated every 1 second via WebSocket
- **P&ID Diagram** — Interactive piping diagram with animated water flow
- **Pump Control** — Manual ON/OFF toggle for Pompa 1 & Pompa 2
- **Automation Settings** — Threshold sliders (jarak_on/off, tds_on/off) synced to ESP32 via MQTT
- **Water Level Widget** — Animated water wave visualization
- **History Charts** — Time-series line charts for TDS, pH, and water level
- **Night Mode** — Toggle to force all pumps OFF
- **Notifications** — Auto-mode pump state change alerts
- **Multi-Device** — Register and switch between multiple Helioponic devices
- **Auth** — JWT-based login/register with persistent session

---

## Screens

| Screen | Route | Description |
|--------|-------|-------------|
| Auth | `Auth` | Login / Register |
| Dashboard | `Dashboard` | Live sensor cards, pump toggles, water level |
| P&ID | `PID` | Interactive piping diagram |
| Analytics | `Analytics` | History graphs (pH, TDS, water level) |
| Automation | `Automation` | Threshold sliders, auto-mode toggles |
| Notifications | `Notifications` | Pump state change alerts |
| Profile | `Profile` | User info, device list, logout |
| Device Onboarding | `DeviceOnboarding` | Add new device |

---

## Quick Start

```bash
# 1. Install dependencies
cd helioponic-mobile
npm install

# 2. Update API URL (edit src/lib/apiClient.ts)
#    Set API_BASE_URL to your backend's IP address, e.g.:
#    export const API_BASE_URL = 'http://192.168.1.100:8000/api/v1';

# 3. Start the app
npx expo start

# 4. Scan QR code with Expo Go (Android) or Camera (iOS)
```

> **Important:** The mobile app connects to your backend server via WiFi.
> Use your computer's **local IP address** (not `localhost`) in `apiClient.ts`.
> Find it with: `ipconfig | findstr "IPv4"` (Windows) or `ifconfig` (Mac/Linux).

---

## Project Structure

```
helioponic-mobile/
├── App.tsx                          # Entry point — providers & navigation
├── src/
│   ├── lib/
│   │   └── apiClient.ts             # Axios HTTP client with JWT interceptor
│   ├── context/
│   │   ├── AuthContext.tsx           # JWT token management & auth state
│   │   ├── ThemeContext.tsx          # Dark / light theme
│   │   └── WebSocketContext.tsx      # WebSocket connection for live data
│   ├── store/
│   │   ├── sensorStore.ts            # Zustand — sensor readings
│   │   ├── waterStore.ts             # Zustand — water level history
│   │   ├── nightModeStore.ts         # Zustand — night mode state
│   │   └── notificationStore.ts      # Zustand — notifications
│   ├── screens/
│   │   ├── AuthScreen.tsx            # Login / Register form
│   │   ├── DashboardScreen.tsx       # Live sensor dashboard
│   │   ├── PIDScreen.tsx             # Piping & instrumentation diagram
│   │   ├── AnalyticsScreen.tsx       # Charts & history
│   │   ├── AutomationScreen.tsx      # Threshold & rule configuration
│   │   ├── NotificationsScreen.tsx   # Pump state alerts
│   │   ├── ProfileScreen.tsx         # User profile & devices
│   │   └── DeviceOnboardingScreen.tsx# Add new device
│   ├── components/
│   │   ├── SensorStatusCard.tsx      # Sensor reading card
│   │   ├── PumpToggle.tsx            # Pump ON/OFF button
│   │   ├── PumpStateCard.tsx         # Pump state display card
│   │   ├── WaterWaveWidget.tsx       # Animated water level visualization
│   │   ├── HistoryLineChart.tsx      # Time-series line chart
│   │   ├── CustomDatePicker.tsx      # Date range picker
│   │   └── SectionHeader.tsx         # Screen section header
│   ├── navigation/
│   │   └── AppNavigator.tsx          # Stack + Tab navigation
│   ├── types/
│   │   ├── api.ts                    # TypeScript interfaces for API
│   │   └── navigation.ts            # Navigation type definitions
│   └── constants.ts                  # App-wide constants
├── assets/                           # Icons, splash screen, fonts
├── package.json
├── app.json                          # Expo configuration
├── tsconfig.json
└── babel.config.js
```

---

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | 18+ | JavaScript runtime |
| Expo CLI | latest | Development server |
| Expo Go | latest | Physical device testing |
| Backend | running | FastAPI on `http://<ip>:8000` |

---

## API Configuration

Edit `src/lib/apiClient.ts`:

```typescript
// For physical device testing (phone on same WiFi)
export const API_BASE_URL = 'http://192.168.1.100:8000/api/v1';

// For emulator (Android)
// export const API_BASE_URL = 'http://10.0.2.2:8000/api/v1';

// For iOS simulator
// export const API_BASE_URL = 'http://localhost:8000/api/v1';
```

### WebSocket URL

WebSocket connection is configured in `src/context/WebSocketContext.tsx`:

```typescript
const WS_URL = `ws://192.168.1.100:8000/ws/pid`;
```

---

## State Management (Zustand)

The app uses **Zustand** for client-side state management:

| Store | Data | Persisted? |
|-------|------|:----------:|
| `sensorStore` | Live sensor readings (jarak_cm, tds, ph, pompa states) | No |
| `waterStore` | Water level history & summary | No |
| `nightModeStore` | Night mode toggle state | No |
| `notificationStore` | Notifications list & unread count | No |

---

## Backend Dependencies

The mobile app requires the Helioponic backend running:

```bash
# Start backend + MongoDB + Mosquitto
docker compose up -d

# Or run locally
cd helioponic-backend
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

See [helioponic-backend](../helioponic-backend/README.md) and the `guides/` folder for detailed setup instructions.

---

## Testing with Simulated Data

```bash
# Start the sensor simulation script (sends data via MQTT every 1 second)
bash tools/simulate.sh
```

The simulation script generates realistic sensor readings (jarak_cm, TDS, pH) and cycles pump states. The mobile app will display live updates via WebSocket.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `Network request failed` | Check API URL — must use computer's LAN IP, not `localhost` |
| WebSocket won't connect | Verify `WS_URL` matches the backend IP and port `8000` |
| `JWT expired` | Log out and log in again |
| Blank screen | Run `npx expo start --clear` to clear Metro cache |
| Data not updating | Ensure `bash tools/simulate.sh` or MQTT data is flowing |
| Expo Go can't find project | Phone and computer must be on the same WiFi network |
| TypeScript errors | Run `npx tsc --noEmit` to check types |
