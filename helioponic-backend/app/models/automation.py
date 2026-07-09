"""
Pydantic schemas for automation rules configuration.

Stores the per-device state of automation rule toggles so that
the mobile app's UI state (Auto-Pump master toggle + individual
IF-THEN rule toggles) persists across app restarts.

Persisted in the device_configs collection alongside threshold values.
Field names match the mobile AutomationScreen.tsx state keys exactly.
"""

from pydantic import BaseModel, Field
from datetime import datetime, UTC


class AutomationRules(BaseModel):
    """Automation rule toggle state for a device.

    These fields are stored in the device_configs collection alongside
    the threshold values (jarak_on, jarak_off, tds_on, tds_off).
    """
    device_id: str = "HELIO_001"
    auto_enabled: bool = True       # Master toggle — enable/disable auto-pump
    rule_ph: bool = True            # pH rule toggle
    rule_tds: bool = True           # TDS rule toggle
    rule_water: bool = True         # Water level rule toggle
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class AutomationRulesPayload(BaseModel):
    """API request/response payload for automation rules."""
    device_id: str = "HELIO_001"
    auto_enabled: bool = True
    rule_ph: bool = True
    rule_tds: bool = True
    rule_water: bool = True


class AutomationRulesResponse(BaseModel):
    """API response for automation rules."""
    device_id: str
    auto_enabled: bool
    rule_ph: bool
    rule_tds: bool
    rule_water: bool
    updated_at: str
