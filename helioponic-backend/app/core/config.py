"""Helioponic Backend — Pydantic Settings & Environment Configuration."""

from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import Optional


class Settings(BaseSettings):
    # ── Server ──────────────────────────────────────────────────────────
    server_port: int = 8000
    log_level: str = "info"

    # ── MongoDB ─────────────────────────────────────────────────────────
    mongo_uri: str = "mongodb://localhost:27017"
    mongo_db: str = "helioponic"

    # ── MQTT (Mosquitto Broker) ─────────────────────────────────────────
    mqtt_broker: str = "localhost"
    mqtt_port: int = 1883
    mqtt_client_id: str = "helioponic_backend"
    mqtt_username: Optional[str] = None
    mqtt_password: Optional[str] = None
    mqtt_qos: int = 0

    # ── JWT ─────────────────────────────────────────────────────────────
    jwt_secret: str = "change-me-in-production"
    jwt_expiration_hours: int = 72

    # ── Hardware / Pump Power Ratings (watts) ───────────────────────────
    pompa1_watts: float = 15.0
    pompa2_watts: float = 15.0

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


settings = Settings()
