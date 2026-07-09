"""WebSocket endpoint for real-time P&ID monitoring & broadcasting.

Migrated from Go (helioponic-backend/internal/handlers/websocket.go).
"""

import json
import logging
from typing import Set, Dict
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query

from app.core.auth import decode_token

logger = logging.getLogger(__name__)
router = APIRouter(tags=["websocket"])


class WebSocketHub:
    """Manages all active WebSocket connections for broadcasting.

    Supports per-device filtering: each client can subscribe to a specific
    device_id via query parameter. Broadcasts are filtered so clients only
    receive data for the device they subscribed to.
    """

    def __init__(self):
        # Map of WebSocket -> subscribed device_id (or "*" for all)
        self._connections: Dict[WebSocket, str] = {}

    async def register(self, ws: WebSocket, device_id: str = ""):
        await ws.accept()
        sub = device_id or "*"
        self._connections[ws] = sub
        logger.info(f"WebSocket client connected (device_id={sub}). Total: {len(self._connections)}")

    async def unregister(self, ws: WebSocket):
        self._connections.pop(ws, None)
        logger.info(f"WebSocket client disconnected. Total: {len(self._connections)}")

    async def broadcast(self, message: dict):
        """Send a JSON message to only the clients subscribed to the matching device_id.

        The message dict must contain a 'device_id' key for filtering.
        Clients subscribed to "*" receive all messages (backward compatibility).
        """
        payload = json.dumps(message)
        msg_device_id = message.get("device_id", "")
        stale = set()
        for ws, subscribed_device in self._connections.items():
            # Only send if client subscribed to this device or to all devices
            if subscribed_device != "*" and subscribed_device != msg_device_id:
                continue
            try:
                await ws.send_text(payload)
            except Exception:
                stale.add(ws)
        for ws in stale:
            await self.unregister(ws)

    @property
    def count(self) -> int:
        return len(self._connections)


# Global WebSocket hub instance
hub = WebSocketHub()


@router.websocket("/ws/pid")
async def pid_websocket(
    ws: WebSocket,
    token: str = Query(""),
    device_id: str = Query(""),
):
    """WebSocket endpoint for real-time P&ID monitoring.

    Query parameters:
      - token: JWT authentication token (optional but recommended)
      - device_id: Subscribe to a specific device's data stream.
                   If empty/omitted, receives data from ALL devices.

    The client sends "ping" to keep the connection alive; server echoes "pong".
    """
    # Validate JWT token if provided
    if token:
        claims = decode_token(token)
        if claims:
            logger.info(f"WebSocket authenticated: user_id={claims.get('user_id')}, device_id={device_id or '*'}")
        else:
            logger.warning("WebSocket connection with invalid token")

    await hub.register(ws, device_id)
    try:
        while True:
            data = await ws.receive_text()
            if data == "ping":
                await ws.send_text("pong")
    except WebSocketDisconnect:
        pass
    finally:
        await hub.unregister(ws)
