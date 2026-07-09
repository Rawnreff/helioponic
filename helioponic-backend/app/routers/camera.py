"""
Camera endpoint — provides a placeholder live feed for the AI Vision Feed in PIDScreen.

Mobile accesses: GET /api/v1/camera/live?t={cameraTick}
Returns a minimal SVG placeholder image showing camera status.
"""

import logging
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

logger = logging.getLogger(__name__)
router = APIRouter(tags=["camera"])

# ─── Static placeholder SVG ──────────────────────────────────────────────

PLACEHOLDER_SVG = """<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#1B5E20;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#2E7D32;stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect width="640" height="360" fill="url(#bgGrad)" rx="8" />
  <!-- Camera body -->
  <rect x="270" y="120" width="100" height="70" rx="12" fill="rgba(255,255,255,0.15)" stroke="rgba(255,255,255,0.3)" stroke-width="2" />
  <!-- Lens -->
  <circle cx="320" cy="155" r="22" fill="rgba(255,255,255,0.1)" stroke="rgba(255,255,255,0.4)" stroke-width="2" />
  <circle cx="320" cy="155" r="10" fill="rgba(255,255,255,0.2)" />
  <!-- Recording dot -->
  <circle cx="310" cy="135" r="4" fill="#E53935" />
  <!-- Status text -->
  <text x="320" y="215" text-anchor="middle" font-family="monospace" font-size="14" font-weight="bold" fill="rgba(255,255,255,0.8)">AI CAMERA FEED</text>
  <text x="320" y="235" text-anchor="middle" font-family="monospace" font-size="11" fill="rgba(255,255,255,0.5)">Placeholder — Camera connected</text>
</svg>"""


@router.get("/camera/live")
async def camera_live():
    """Return a placeholder camera feed image.

    This is a static placeholder SVG. In production, this endpoint would
    stream frames from an AI camera module connected to the backend or
    fetch the latest frame from the ESP32-CAM module.

    The mobile app polls this endpoint every CAMERA_POLL_MS (3 seconds)
    to display the live feed in the AI Vision Feed section of PIDScreen.
    """
    return Response(
        content=PLACEHOLDER_SVG,
        media_type="image/svg+xml",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )
