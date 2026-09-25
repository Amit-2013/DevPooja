"""Runtime configuration. Every deployment value comes from the environment with
the same names the Node server uses, so Render env vars can be copied 1:1."""
from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # --- database ---------------------------------------------------------
    # Point DATABASE_URL at your Supabase pooled connection string
    # (postgresql+asyncpg://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:6543/postgres)
    # to switch from local SQLite to Supabase — no code changes.
    database_url: str = "sqlite+aiosqlite:///./data/app.db"

    # --- auth -------------------------------------------------------------
    jwt_secret: str = "dev-only-secret-change-me"
    jwt_algorithm: str = "HS256"
    token_expire_hours: int = 48          # Node parity: 48h access tokens

    # --- storage ----------------------------------------------------------
    upload_dir: str = "./uploads"
    max_upload_mb: int = 40               # Node parity: media limit 40 MB

    # --- behaviour flags --------------------------------------------------
    demo_mode: bool = True
    environment: str = "development"

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()
