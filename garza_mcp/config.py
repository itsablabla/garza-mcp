"""Environment configuration for Garza MCP Server."""

from __future__ import annotations

import os

from dotenv import load_dotenv

load_dotenv()


# ── Auth ──────────────────────────────────────────────────────────────────────
AUTH_TOKEN = os.getenv("MCP_AUTH_TOKEN", "")

# ── ProtonMail (IMAP/SMTP via Proton Bridge) ─────────────────────────────────
PROTONMAIL_USERNAME = os.getenv("PROTONMAIL_USERNAME", "jadengarza@pm.me")
PROTONMAIL_PASSWORD = os.getenv("PROTONMAIL_PASSWORD", "")
IMAP_HOST = os.getenv("IMAP_HOST", "127.0.0.1")
IMAP_PORT = int(os.getenv("IMAP_PORT", "1143"))
SMTP_HOST = os.getenv("SMTP_HOST", "127.0.0.1")
SMTP_PORT = int(os.getenv("SMTP_PORT", "1025"))

# ── Proton Drive (FUSE mount) ────────────────────────────────────────────────
PROTON_DRIVE_PATH = os.getenv("PROTON_DRIVE_PATH", "/Users/customer/Library/CloudStorage/ProtonDrive-jadengarza@pm.me")

# ── iCloud Drive (FUSE mount) ────────────────────────────────────────────────
ICLOUD_DRIVE_PATH = os.getenv("ICLOUD_DRIVE_PATH", "/Users/customer/Library/Mobile Documents/com~apple~CloudDocs")

# ── Beeper API ────────────────────────────────────────────────────────────────
BEEPER_API_URL = os.getenv("BEEPER_API_URL", "http://localhost:23373")
BEEPER_TOKEN = os.getenv("BEEPER_TOKEN", "")

# ── Beeper Database (SQLite) ─────────────────────────────────────────────────
BEEPER_DB_PATH = os.getenv("BEEPER_DB_PATH", "/Users/customer/Library/Application Support/BeeperTexts/index.db")

# ── Fabric AI ─────────────────────────────────────────────────────────────────
FABRIC_API_URL = os.getenv("FABRIC_API_URL", "https://api.fabric.so")
FABRIC_API_KEY = os.getenv("FABRIC_API_KEY", "")
FABRIC_DEFAULT_PARENT = os.getenv("FABRIC_DEFAULT_PARENT", "89cd201a-0be0-47f2-a25e-bdc1f85c1ef8")

# ── Quo / OpenPhone ──────────────────────────────────────────────────────────
QUO_API_KEY = os.getenv("QUO_API_KEY", "")
QUO_API_URL = os.getenv("QUO_API_URL", "https://api.openphone.com/v1")

# ── Voicenotes ────────────────────────────────────────────────────────────────
VOICENOTES_TOKEN = os.getenv("VOICENOTES_TOKEN", "")
VOICENOTES_API_URL = os.getenv("VOICENOTES_API_URL", "https://api.voicenotes.com")

# ── Nextcloud ─────────────────────────────────────────────────────────────────
NEXTCLOUD_URL = os.getenv("NEXTCLOUD_URL", "https://next.garzaos.online")
NEXTCLOUD_USERNAME = os.getenv("NEXTCLOUD_USERNAME", "admin")
NEXTCLOUD_PASSWORD = os.getenv("NEXTCLOUD_PASSWORD", "")

# ── Server ────────────────────────────────────────────────────────────────────
SERVER_HOST = os.getenv("SERVER_HOST", "0.0.0.0")
SERVER_PORT = int(os.getenv("SERVER_PORT", "3104"))
DEBUG = os.getenv("DEBUG", "false").lower() == "true"

# ── Timeouts (seconds) ───────────────────────────────────────────────────────
TOOL_TIMEOUTS: dict[str, int] = {
    # IMAP — tiered (Proton Bridge is slow with 736GB mailbox)
    "mail_list": 180,
    "mail_search": 180,
    "mail_folders": 180,
    "mail_stats": 180,
    "mail_read": 120,
    "mail_mark_read": 120,
    "mail_star": 120,
    "mail_move": 120,
    "mail_delete": 120,
    "mail_status": 30,
    # SMTP
    "mail_send": 30,
    # Drive / iCloud (listing large storage trees is slow)
    "drive_list": 120,
    "drive_search": 120,
    "drive_stats": 120,
    "drive_read": 30,
    "icloud_list": 120,
    "icloud_search": 120,
    "icloud_stats": 120,
    "icloud_read": 30,
    # Beeper DB (large SQLite database)
    "beeper_db_search": 90,
    "beeper_db_history": 60,
    "beeper_db_analytics": 90,
    "beeper_db_threads": 60,
    "beeper_db_stats": 30,
    # Nextcloud Notes (slow on this instance)
    "nc_notes_list": 120,
    "nc_notes_create": 60,
    "nc_notes_search": 120,
    "nc_notes_get": 60,
    "nc_notes_update": 60,
    "nc_notes_delete": 60,
    # Voicenotes
    "voicenotes_list": 90,
    # Default
    "_default": 30,
}


def get_timeout(tool_name: str) -> int:
    """Get the timeout for a tool, falling back to default."""
    return TOOL_TIMEOUTS.get(tool_name, TOOL_TIMEOUTS["_default"])
