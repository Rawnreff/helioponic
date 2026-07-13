// Dynamic Expo config — reads .env at Metro start time and populates
// Constants.expoConfig.extra so the mobile app always has the correct
// API_URL and WS_URL without relying on babel inlining.
const fs = require('fs');
const path = require('path');

function loadEnv(filePath) {
  const vars = {};
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx === -1) continue;
      const key = trimmed.substring(0, idx).trim();
      const value = trimmed.substring(idx + 1).trim();
      if (key) vars[key] = value;
    }
  } catch { /* .env missing — use fallback */ }
  return vars;
}

const env = loadEnv(path.join(__dirname, '.env'));

// Default host fallback — update if your LAN IP changes
const DEFAULT_HOST = '192.168.100.16';

// Extend the static app.json with runtime-resolved extra fields
const base = require('./app.json');

module.exports = {
  expo: {
    ...base.expo,
    extra: {
      apiUrl: env.API_URL || `http://${DEFAULT_HOST}:8000/api/v1`,
      wsUrl: env.WS_URL || `ws://${DEFAULT_HOST}:8000/ws/pid`,
    },
  },
};
