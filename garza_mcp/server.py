"""Garza MCP Server v7 — Full Python FastMCP rewrite.

Native Streamable HTTP transport, built-in auth, per-tool timeouts.
Replaces: TypeScript MCP server + mcp-proxy + auth_proxy.py
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP

from garza_mcp.config import (
    AUTH_TOKEN,
    BEEPER_DB_PATH,
    DEBUG,
    FABRIC_API_KEY,
    ICLOUD_DRIVE_PATH,
    NEXTCLOUD_URL,
    NEXTCLOUD_PASSWORD,
    PROTON_DRIVE_PATH,
    PROTONMAIL_USERNAME,
    QUO_API_KEY,
    SERVER_HOST,
    SERVER_PORT,
    VOICENOTES_TOKEN,
    get_timeout,
)
from garza_mcp.services.beeper_api import BeeperApiService
from garza_mcp.services.beeper_db import BeeperDbService
from garza_mcp.services.drive import DriveService
from garza_mcp.services.fabric import FabricService
from garza_mcp.services.mail import ImapService, SmtpService
from garza_mcp.services.nextcloud import NextcloudService
from garza_mcp.services.quo import QuoService
from garza_mcp.services.voicenotes import VoicenotesService

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.DEBUG if DEBUG else logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger("garza-mcp")

# ── FastMCP Server ────────────────────────────────────────────────────────────
mcp = FastMCP(
    "garza-mcp",
    instructions="Garza MCP Server v7 — 178 tools across 9 services",
    host=SERVER_HOST,
    port=SERVER_PORT,
)

# ── Service Instances ─────────────────────────────────────────────────────────
imap = ImapService()
smtp = SmtpService()
drive = DriveService(PROTON_DRIVE_PATH)
icloud = DriveService(ICLOUD_DRIVE_PATH)
beeper_api = BeeperApiService()
beeper_db = BeeperDbService(BEEPER_DB_PATH)
fabric = FabricService() if FABRIC_API_KEY else None
quo = QuoService() if QUO_API_KEY else None
voicenotes = VoicenotesService() if VOICENOTES_TOKEN else None
nextcloud = NextcloudService() if NEXTCLOUD_URL and NEXTCLOUD_PASSWORD else None


# ── Helpers ───────────────────────────────────────────────────────────────────

def _ok(text: str) -> str:
    return text


def _err(text: str) -> str:
    return f"ERROR: {text}"


def _json(data: Any) -> str:
    return json.dumps(data, indent=2, default=str)


async def _with_timeout(tool_name: str, coro: Any) -> Any:
    """Wrap a coroutine with a per-tool timeout."""
    timeout = get_timeout(tool_name)
    try:
        return await asyncio.wait_for(coro, timeout=timeout)
    except asyncio.TimeoutError:
        return _err(f"{tool_name} timed out after {timeout}s")
    except Exception as e:
        logger.error("Tool %s failed: %s", tool_name, e)
        return _err(f"{tool_name} failed: {e}")


def _parse_emails(s: str) -> list[str]:
    return [e.strip() for e in s.split(",") if e.strip()]


# ══════════════════════════════════════════════════════════════════════════════
# MAIL TOOLS (11)
# ══════════════════════════════════════════════════════════════════════════════

@mcp.tool()
async def mail_send(
    to: str, subject: str, body: str,
    cc: str | None = None, bcc: str | None = None,
    replyTo: str | None = None, isHtml: bool = False, priority: str | None = None,
) -> str:
    """Send an email via ProtonMail SMTP."""
    async def _do() -> str:
        result = await smtp.send_email(
            to=_parse_emails(to), subject=subject, body=body,
            cc=_parse_emails(cc) if cc else None,
            bcc=_parse_emails(bcc) if bcc else None,
            reply_to=replyTo, priority=priority,
            html_body=body if isHtml else None,
        )
        return _ok(f"Email sent to {to}. MessageId: {result.get('messageId', 'unknown')}")
    return await _with_timeout("mail_send", _do())


@mcp.tool()
async def mail_list(folder: str = "INBOX", limit: int = 20, offset: int = 0) -> str:
    """List emails in a folder."""
    async def _do() -> str:
        emails = await imap.get_emails(folder, limit, offset)
        if not emails:
            return _ok(f"No emails in {folder}.")
        lines = []
        for i, e in enumerate(emails):
            read = "[read]" if e.get("read") else "[unread]"
            star = "* " if e.get("starred") else ""
            lines.append(f"{i + 1 + offset}. {read} {star}[UID:{e['id']}]\n   From: {e['from']}\n   Subject: {e['subject']}\n   Date: {e.get('date', '')}")
        return _ok(f"{folder} ({len(emails)} emails):\n\n" + "\n\n".join(lines))
    return await _with_timeout("mail_list", _do())


@mcp.tool()
async def mail_read(emailId: str, folder: str = "INBOX") -> str:
    """Read a specific email by UID."""
    async def _do() -> str:
        e = await imap.get_email_by_id(emailId, folder)
        if not e:
            return _err(f"Email UID {emailId} not found in {folder}.")
        return _ok(f"UID: {e['id']}\nFrom: {e['from']}\nTo: {', '.join(e.get('to', []))}\nSubject: {e['subject']}\nDate: {e.get('date', '')}\nRead: {e.get('read')} | Starred: {e.get('starred')}\n\n{e.get('body', '(no body)')}")
    return await _with_timeout("mail_read", _do())


@mcp.tool()
async def mail_search(query: str, folder: str = "INBOX", limit: int = 20) -> str:
    """Search emails using server-side IMAP SEARCH."""
    async def _do() -> str:
        results = await imap.search_emails(query, folder, limit)
        if not results:
            return _ok("No emails matched.")
        lines = [f"{i + 1}. [UID:{e['id']}] {e['subject']}\n   From: {e['from']}" for i, e in enumerate(results)]
        return _ok(f"Found {len(results)} emails:\n\n" + "\n\n".join(lines))
    return await _with_timeout("mail_search", _do())


@mcp.tool()
async def mail_folders() -> str:
    """List all IMAP folders."""
    async def _do() -> str:
        folders = await imap.get_folders()
        return _ok("Folders:\n" + "\n".join(f"  {f['path']}" for f in folders))
    return await _with_timeout("mail_folders", _do())


@mcp.tool()
async def mail_mark_read(emailId: str, isRead: bool = True, folder: str = "INBOX") -> str:
    """Mark an email as read/unread."""
    async def _do() -> str:
        await imap.mark_email_read(emailId, isRead, folder)
        return _ok(f"Email {emailId} marked as {'read' if isRead else 'unread'}.")
    return await _with_timeout("mail_mark_read", _do())


@mcp.tool()
async def mail_star(emailId: str, isStarred: bool = True, folder: str = "INBOX") -> str:
    """Star or unstar an email."""
    async def _do() -> str:
        await imap.star_email(emailId, isStarred, folder)
        return _ok(f"Email {emailId} {'starred' if isStarred else 'unstarred'}.")
    return await _with_timeout("mail_star", _do())


@mcp.tool()
async def mail_move(emailId: str, targetFolder: str, folder: str = "INBOX") -> str:
    """Move an email to another folder. targetFolder is the destination (alias: destination)."""
    async def _do() -> str:
        await imap.move_email(emailId, targetFolder, folder)
        return _ok(f"Email {emailId} moved to {targetFolder}.")
    return await _with_timeout("mail_move", _do())


@mcp.tool()
async def mail_delete(emailId: str, folder: str = "INBOX") -> str:
    """Delete an email."""
    async def _do() -> str:
        await imap.delete_email(emailId, folder)
        return _ok(f"Email {emailId} deleted.")
    return await _with_timeout("mail_delete", _do())


@mcp.tool()
async def mail_stats() -> str:
    """Get mailbox statistics."""
    async def _do() -> str:
        stats = await imap.get_stats()
        return _ok(f"Total: {stats['totalEmails']} | Unread: {stats['unreadEmails']} | Folders: {stats['folders']}")
    return await _with_timeout("mail_stats", _do())


@mcp.tool()
async def mail_status() -> str:
    """Check IMAP and SMTP connection status."""
    async def _do() -> str:
        smtp_ok = await smtp.verify_connection()
        imap_status = "not connected"
        if imap.is_connected():
            imap_status = "connected"
        else:
            try:
                await imap.connect()
                imap_status = "reconnected"
            except Exception as e:
                imap_status = f"failed: {str(e)[:80]}"
        return _ok(f"SMTP: {'connected' if smtp_ok else 'not connected'} | IMAP: {imap_status} | User: {PROTONMAIL_USERNAME}")
    return await _with_timeout("mail_status", _do())


# ══════════════════════════════════════════════════════════════════════════════
# DRIVE TOOLS — shared handler for Proton Drive + iCloud Drive
# ══════════════════════════════════════════════════════════════════════════════

async def _handle_drive(svc: DriveService, label: str, action: str, **kwargs: Any) -> str:
    tool_name = f"{'drive' if 'Proton' in label else 'icloud'}_{action}"

    async def _do() -> str:
        if action == "list":
            items = await svc.list_files(kwargs.get("path", "/"))
            if not items:
                return _ok(f"{label}: Empty directory.")
            lines = [f"{'[dir]' if i['type'] == 'directory' else '[file]'} {i['name']}" for i in items]
            return _ok(f"{label} ({len(items)} items):\n\n" + "\n".join(lines))

        elif action == "read":
            path = kwargs.get("path", "")
            if not path:
                return _err("path is required")
            content = await svc.read_file(path)
            return _ok(content)

        elif action == "write":
            path = kwargs.get("path", "")
            content = kwargs.get("content", "")
            if not path or content is None:
                return _err("path and content are required")
            result = await svc.write_file(path, content)
            return _ok(f"Written: {result['path']}")

        elif action == "mkdir":
            path = kwargs.get("path", "")
            if not path:
                return _err("path is required")
            result = await svc.create_folder(path)
            return _ok(f"Folder created: {result['path']}")

        elif action == "delete":
            path = kwargs.get("path", "")
            if not path:
                return _err("path is required")
            result = await svc.delete_item(path)
            return _ok(f"Deleted: {result['deleted']}")

        elif action == "move":
            source = kwargs.get("source", "")
            destination = kwargs.get("destination", "")
            if not source or not destination:
                return _err("source and destination are required")
            result = await svc.move_item(source, destination)
            return _ok(f"Moved: {result['from']} -> {result['to']}")

        elif action == "info":
            path = kwargs.get("path", "")
            if not path:
                return _err("path is required")
            info = await svc.get_file_info(path)
            return _ok(f"Name: {info['name']}\nType: {info['type']}\nMIME: {info['mimeType']}\nSize: {info['sizeFormatted']}\nModified: {info['modified']}\nCreated: {info['created']}")

        elif action == "search":
            query = kwargs.get("query", "")
            path = kwargs.get("path", "/")
            if not query:
                return _err("query is required")
            results = await svc.search_files(query, path)
            if not results:
                return _ok("No matches found.")
            lines = [f"{'[dir]' if i['type'] == 'directory' else '[file]'} {i['path']}" for i in results]
            return _ok(f"Found {len(results)} matches:\n\n" + "\n".join(lines))

        elif action == "stats":
            stats = await svc.get_drive_stats()
            return _ok(f"{label}: Files: {stats['totalFiles']} | Folders: {stats['totalFolders']} | Total size: {stats['totalSizeFormatted']}")

        return _err(f"Unknown drive action: {action}")

    return await _with_timeout(tool_name, _do())


# ── Proton Drive (9 tools) ───────────────────────────────────────────────────

@mcp.tool()
async def drive_list(path: str = "/") -> str:
    """List files in Proton Drive."""
    return await _handle_drive(drive, "Proton Drive", "list", path=path)

@mcp.tool()
async def drive_read(path: str) -> str:
    """Read a file from Proton Drive."""
    return await _handle_drive(drive, "Proton Drive", "read", path=path)

@mcp.tool()
async def drive_write(path: str, content: str) -> str:
    """Write a file to Proton Drive."""
    return await _handle_drive(drive, "Proton Drive", "write", path=path, content=content)

@mcp.tool()
async def drive_mkdir(path: str) -> str:
    """Create a folder in Proton Drive."""
    return await _handle_drive(drive, "Proton Drive", "mkdir", path=path)

@mcp.tool()
async def drive_delete(path: str) -> str:
    """Delete a file or folder in Proton Drive."""
    return await _handle_drive(drive, "Proton Drive", "delete", path=path)

@mcp.tool()
async def drive_move(source: str, destination: str) -> str:
    """Move a file or folder in Proton Drive."""
    return await _handle_drive(drive, "Proton Drive", "move", source=source, destination=destination)

@mcp.tool()
async def drive_info(path: str) -> str:
    """Get file info from Proton Drive."""
    return await _handle_drive(drive, "Proton Drive", "info", path=path)

@mcp.tool()
async def drive_search(query: str, path: str = "/") -> str:
    """Search files in Proton Drive."""
    return await _handle_drive(drive, "Proton Drive", "search", query=query, path=path)

@mcp.tool()
async def drive_stats() -> str:
    """Get Proton Drive statistics."""
    return await _handle_drive(drive, "Proton Drive", "stats")


# ── iCloud Drive (9 tools) ──────────────────────────────────────────────────

@mcp.tool()
async def icloud_list(path: str = "/") -> str:
    """List files in iCloud Drive."""
    return await _handle_drive(icloud, "iCloud Drive", "list", path=path)

@mcp.tool()
async def icloud_read(path: str) -> str:
    """Read a file from iCloud Drive."""
    return await _handle_drive(icloud, "iCloud Drive", "read", path=path)

@mcp.tool()
async def icloud_write(path: str, content: str) -> str:
    """Write a file to iCloud Drive."""
    return await _handle_drive(icloud, "iCloud Drive", "write", path=path, content=content)

@mcp.tool()
async def icloud_mkdir(path: str) -> str:
    """Create a folder in iCloud Drive."""
    return await _handle_drive(icloud, "iCloud Drive", "mkdir", path=path)

@mcp.tool()
async def icloud_delete(path: str) -> str:
    """Delete a file or folder in iCloud Drive."""
    return await _handle_drive(icloud, "iCloud Drive", "delete", path=path)

@mcp.tool()
async def icloud_move(source: str, destination: str) -> str:
    """Move a file or folder in iCloud Drive."""
    return await _handle_drive(icloud, "iCloud Drive", "move", source=source, destination=destination)

@mcp.tool()
async def icloud_info(path: str) -> str:
    """Get file info from iCloud Drive."""
    return await _handle_drive(icloud, "iCloud Drive", "info", path=path)

@mcp.tool()
async def icloud_search(query: str, path: str = "/") -> str:
    """Search files in iCloud Drive."""
    return await _handle_drive(icloud, "iCloud Drive", "search", query=query, path=path)

@mcp.tool()
async def icloud_stats() -> str:
    """Get iCloud Drive statistics."""
    return await _handle_drive(icloud, "iCloud Drive", "stats")


# ══════════════════════════════════════════════════════════════════════════════
# BEEPER API TOOLS (14)
# ══════════════════════════════════════════════════════════════════════════════

_BEEPER_OFFLINE = _json({"error": "Beeper Desktop is not running on the server", "hint": "Start Beeper Desktop on the Mac Mini (requires GUI login)"})

async def _beeper_call(coro: Any) -> str:
    """Wrap Beeper API calls with health check for offline Desktop app."""
    try:
        return _json(await coro)
    except (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout):
        return _BEEPER_OFFLINE

@mcp.tool()
async def beeper_list_accounts() -> str:
    """List Beeper messaging accounts."""
    return await _beeper_call(beeper_api.list_accounts())

@mcp.tool()
async def beeper_list_chats(limit: int | None = None, offset: int | None = None, unreadOnly: bool = False, service: str | None = None) -> str:
    """List Beeper chats."""
    return await _beeper_call(beeper_api.list_chats(limit=limit, offset=offset, unread_only=unreadOnly, service=service))

@mcp.tool()
async def beeper_search_chats(query: str) -> str:
    """Search Beeper chats."""
    return await _beeper_call(beeper_api.search_chats(query))

@mcp.tool()
async def beeper_get_chat(chatID: str) -> str:
    """Get a specific Beeper chat."""
    return await _beeper_call(beeper_api.get_chat(chatID))

@mcp.tool()
async def beeper_get_messages(chatID: str, limit: int | None = None, before: str | None = None) -> str:
    """Get messages from a Beeper chat."""
    return await _beeper_call(beeper_api.get_messages(chatID, limit=limit, before=before))

@mcp.tool()
async def beeper_search_messages(query: str, limit: int | None = None) -> str:
    """Search Beeper messages."""
    return await _beeper_call(beeper_api.search_messages(query, limit=limit))

@mcp.tool()
async def beeper_send_message(chatID: str, text: str, replyTo: str | None = None) -> str:
    """Send a Beeper message."""
    return await _beeper_call(beeper_api.send_message(chatID, text, reply_to=replyTo))

@mcp.tool()
async def beeper_mark_read(chatID: str, upToMessageID: str | None = None) -> str:
    """Mark a Beeper chat as read."""
    return await _beeper_call(beeper_api.mark_read(chatID, up_to_message_id=upToMessageID))

@mcp.tool()
async def beeper_add_reaction(chatID: str, messageID: str, emoji: str) -> str:
    """Add a reaction to a Beeper message."""
    return await _beeper_call(beeper_api.add_reaction(chatID, messageID, emoji))

@mcp.tool()
async def beeper_create_chat(accountID: str, participantIDs: list[str], type: str = "single") -> str:
    """Create a new Beeper chat."""
    return await _beeper_call(beeper_api.create_chat(accountID, participantIDs, chat_type=type))

@mcp.tool()
async def beeper_archive_chat(chatID: str, archived: bool) -> str:
    """Archive or unarchive a Beeper chat."""
    return await _beeper_call(beeper_api.archive_chat(chatID, archived))

@mcp.tool()
async def beeper_search_contacts(accountID: str, query: str) -> str:
    """Search Beeper contacts."""
    return await _beeper_call(beeper_api.search_contacts(accountID, query))

@mcp.tool()
async def beeper_set_reminder(chatID: str, remindAt: str) -> str:
    """Set a reminder for a Beeper chat."""
    return await _beeper_call(beeper_api.set_reminder(chatID, remindAt))

@mcp.tool()
async def beeper_get_unread_summary() -> str:
    """Get unread message summary across all Beeper networks."""
    try:
        summary = await beeper_api.get_unread_summary()
    except (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout):
        return _BEEPER_OFFLINE
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            return _BEEPER_OFFLINE
        raise
    if not summary["chats"]:
        return _ok("No unread messages across any network.")
    lines = []
    for c in summary["chats"]:
        msg = c.get("lastMessage", "")
        suffix = f' — "{msg}"' if msg else ""
        lines.append(f"[{c['service']}] {c['name']}: {c['unread']} unread{suffix}")
    return _ok(f"Total unread: {summary['totalUnread']}\n\n" + "\n".join(lines))


# ══════════════════════════════════════════════════════════════════════════════
# BEEPER DATABASE TOOLS (8)
# ══════════════════════════════════════════════════════════════════════════════

@mcp.tool()
async def beeper_db_stats() -> str:
    """Get Beeper database statistics."""
    return await _with_timeout("beeper_db_stats", asyncio.coroutine(lambda: _json(beeper_db.get_db_stats()))() if False else _do_db_stats())

async def _do_db_stats() -> str:
    return _json(await beeper_db.get_db_stats())

@mcp.tool()
async def beeper_db_search(query: str, limit: int = 20, chatID: str | None = None) -> str:
    """Search messages in the Beeper database (FTS5)."""
    async def _do() -> str:
        return _json(await beeper_db.search_messages(query, limit, chatID))
    return await _with_timeout("beeper_db_search", _do())

@mcp.tool()
async def beeper_db_history(chatID: str, limit: int = 50, before: str | None = None) -> str:
    """Get chat history from the Beeper database."""
    async def _do() -> str:
        return _json(await beeper_db.get_chat_history(chatID, limit, before))
    return await _with_timeout("beeper_db_history", _do())

@mcp.tool()
async def beeper_db_threads(limit: int = 50, accountID: str | None = None) -> str:
    """List chat threads from the Beeper database."""
    async def _do() -> str:
        return _json(await beeper_db.list_threads(limit, accountID))
    return await _with_timeout("beeper_db_threads", _do())

@mcp.tool()
async def beeper_db_participants(chatID: str) -> str:
    """Get participants of a Beeper chat."""
    return _json(await beeper_db.get_participants(chatID))

@mcp.tool()
async def beeper_db_contacts(query: str, limit: int = 20) -> str:
    """Search contacts in the Beeper database."""
    return _json(await beeper_db.search_contacts(query, limit))

@mcp.tool()
async def beeper_db_reactions(chatID: str, eventID: str) -> str:
    """Get reactions for a message in the Beeper database."""
    return _json(await beeper_db.get_reactions(chatID, eventID))

@mcp.tool()
async def beeper_db_analytics(chatID: str | None = None, days: int = 30) -> str:
    """Get chat analytics from the Beeper database."""
    async def _do() -> str:
        return _json(await beeper_db.get_chat_analytics(chatID, days))
    return await _with_timeout("beeper_db_analytics", _do())


# ══════════════════════════════════════════════════════════════════════════════
# FABRIC AI TOOLS (8)
# ══════════════════════════════════════════════════════════════════════════════

@mcp.tool()
async def fabric_search(query: str, limit: int = 10) -> str:
    """Search Fabric AI knowledge base."""
    if not fabric:
        return _err("Fabric AI not configured")
    return _json(await fabric.search(query, limit))

@mcp.tool()
async def fabric_add_memory(content: str) -> str:
    """Add a memory to Fabric AI."""
    if not fabric:
        return _err("Fabric AI not configured")
    return _json(await fabric.add_memory(content))

@mcp.tool()
async def fabric_recall_memories(query: str, limit: int = 20) -> str:
    """Recall memories from Fabric AI."""
    if not fabric:
        return _err("Fabric AI not configured")
    if not query:
        return _err("query is required")
    return _json(await fabric.recall_memories(query, limit))

@mcp.tool()
async def fabric_create_note(text: str, parentId: str | None = None) -> str:
    """Create a notepad in Fabric AI."""
    if not fabric:
        return _err("Fabric AI not configured")
    return _json(await fabric.create_notepad(text, parent_id=parentId))

@mcp.tool()
async def fabric_list_notes(parentId: str | None = None) -> str:
    """List notepads in Fabric AI."""
    if not fabric:
        return _err("Fabric AI not configured")
    return _json(await fabric.list_notepads(parentId))

@mcp.tool()
async def fabric_get_note(notepadId: str) -> str:
    """Get a notepad from Fabric AI."""
    if not fabric:
        return _err("Fabric AI not configured")
    return _json(await fabric.get_notepad(notepadId))

@mcp.tool()
async def fabric_update_note(notepadId: str, text: str) -> str:
    """Update a notepad in Fabric AI."""
    if not fabric:
        return _err("Fabric AI not configured")
    return _json(await fabric.update_notepad(notepadId, text))

@mcp.tool()
async def fabric_delete_note(notepadId: str) -> str:
    """Delete a notepad from Fabric AI."""
    if not fabric:
        return _err("Fabric AI not configured")
    return _json(await fabric.delete_notepad(notepadId))


# ══════════════════════════════════════════════════════════════════════════════
# QUO / OPENPHONE TOOLS (17)
# ══════════════════════════════════════════════════════════════════════════════

@mcp.tool()
async def quo_list_numbers() -> str:
    """List phone numbers from Quo/OpenPhone."""
    if not quo:
        return _err("Quo not configured")
    return _json(await quo.list_phone_numbers())

@mcp.tool()
async def quo_send_message(from_number: str, to: str, content: str) -> str:
    """Send an SMS via Quo/OpenPhone."""
    if not quo:
        return _err("Quo not configured")
    return _json(await quo.send_message(from_number, to, content))

@mcp.tool()
async def quo_list_messages(phoneNumberId: str, participants: list[str] | None = None, maxResults: int | None = None) -> str:
    """List messages for a phone number. Participants is optional list of phone numbers to filter by."""
    if not quo:
        return _err("Quo not configured")
    return _json(await quo.list_messages(phoneNumberId, participants or [], maxResults))

@mcp.tool()
async def quo_get_message(messageId: str) -> str:
    """Get a specific message."""
    if not quo:
        return _err("Quo not configured")
    return _json(await quo.get_message(messageId))

@mcp.tool()
async def quo_list_calls(phoneNumberId: str, participants: list[str] | None = None, maxResults: int | None = None) -> str:
    """List calls for a phone number. Participants is optional list of phone numbers to filter by."""
    if not quo:
        return _err("Quo not configured")
    return _json(await quo.list_calls(phoneNumberId, participants or [], maxResults))

@mcp.tool()
async def quo_get_call(callId: str) -> str:
    """Get a specific call."""
    if not quo:
        return _err("Quo not configured")
    return _json(await quo.get_call(callId))

@mcp.tool()
async def quo_call_summary(callId: str) -> str:
    """Get call summary."""
    if not quo:
        return _err("Quo not configured")
    return _json(await quo.get_call_summary(callId))

@mcp.tool()
async def quo_call_transcript(callId: str) -> str:
    """Get call transcript."""
    if not quo:
        return _err("Quo not configured")
    return _json(await quo.get_call_transcript(callId))

@mcp.tool()
async def quo_voicemail(callId: str) -> str:
    """Get voicemail for a call."""
    if not quo:
        return _err("Quo not configured")
    return _json(await quo.get_voicemail(callId))

@mcp.tool()
async def quo_call_recordings(callId: str) -> str:
    """Get call recordings."""
    if not quo:
        return _err("Quo not configured")
    return _json(await quo.get_call_recordings(callId))

@mcp.tool()
async def quo_list_contacts(page: int | None = None) -> str:
    """List contacts."""
    if not quo:
        return _err("Quo not configured")
    return _json(await quo.list_contacts(page))

@mcp.tool()
async def quo_get_contact(contactId: str) -> str:
    """Get a specific contact."""
    if not quo:
        return _err("Quo not configured")
    return _json(await quo.get_contact(contactId))

@mcp.tool()
async def quo_create_contact(firstName: str, lastName: str | None = None, company: str | None = None, role: str | None = None, phone: str | None = None, email: str | None = None) -> str:
    """Create a contact."""
    if not quo:
        return _err("Quo not configured")
    default_fields: dict[str, Any] = {"firstName": firstName}
    if lastName:
        default_fields["lastName"] = lastName
    if company:
        default_fields["company"] = company
    if role:
        default_fields["role"] = role
    if phone:
        default_fields["phoneNumbers"] = [{"name": "main", "value": phone}]
    if email:
        default_fields["emails"] = [{"name": "main", "value": email}]
    return _json(await quo.create_contact({"defaultFields": default_fields}))

@mcp.tool()
async def quo_update_contact(contactId: str, firstName: str | None = None, lastName: str | None = None, company: str | None = None, role: str | None = None) -> str:
    """Update a contact."""
    if not quo:
        return _err("Quo not configured")
    fields: dict[str, Any] = {}
    if firstName:
        fields["firstName"] = firstName
    if lastName:
        fields["lastName"] = lastName
    if company:
        fields["company"] = company
    if role:
        fields["role"] = role
    return _json(await quo.update_contact(contactId, {"defaultFields": fields}))

@mcp.tool()
async def quo_delete_contact(contactId: str) -> str:
    """Delete a contact."""
    if not quo:
        return _err("Quo not configured")
    return _json(await quo.delete_contact(contactId))

@mcp.tool()
async def quo_list_conversations(phoneNumberId: str | None = None, maxResults: int | None = None) -> str:
    """List conversations."""
    if not quo:
        return _err("Quo not configured")
    return _json(await quo.list_conversations(phoneNumberId, maxResults))

@mcp.tool()
async def quo_list_users() -> str:
    """List users."""
    if not quo:
        return _err("Quo not configured")
    return _json(await quo.list_users())


# ══════════════════════════════════════════════════════════════════════════════
# VOICENOTES TOOLS (4)
# ══════════════════════════════════════════════════════════════════════════════

@mcp.tool()
async def voicenotes_user() -> str:
    """Get Voicenotes user info."""
    if not voicenotes:
        return _err("Voicenotes not configured")
    return _json(await voicenotes.get_user_info())

@mcp.tool()
async def voicenotes_list(since: str | None = None) -> str:
    """List Voicenotes recordings."""
    if not voicenotes:
        return _err("Voicenotes not configured")
    async def _do() -> str:
        return _json(await voicenotes.list_recordings(since))
    return await _with_timeout("voicenotes_list", _do())

@mcp.tool()
async def voicenotes_search(query: str, limit: int = 20) -> str:
    """Search Voicenotes recordings."""
    if not voicenotes:
        return _err("Voicenotes not configured")
    results = await voicenotes.search_notes(query, limit)
    return _json({"count": len(results), "results": results})

@mcp.tool()
async def voicenotes_audio_url(recordingId: str) -> str:
    """Get audio URL for a Voicenotes recording."""
    if not voicenotes:
        return _err("Voicenotes not configured")
    return _json(await voicenotes.get_recording_audio_url(recordingId))


# ══════════════════════════════════════════════════════════════════════════════
# NEXTCLOUD TOOLS (98)
# ══════════════════════════════════════════════════════════════════════════════

def _nc() -> NextcloudService:
    if not nextcloud:
        raise RuntimeError("Nextcloud not configured")
    return nextcloud


# ── Notes (6) ─────────────────────────────────────────────────────────────────

@mcp.tool()
async def nc_notes_list(category: str | None = None) -> str:
    """List Nextcloud notes."""
    async def _do() -> str:
        return _json(await _nc().notes_list(category))
    return await _with_timeout("nc_notes_list", _do())

@mcp.tool()
async def nc_notes_get(noteId: int) -> str:
    """Get a Nextcloud note by ID."""
    async def _do() -> str:
        return _json(await _nc().notes_get(noteId))
    return await _with_timeout("nc_notes_get", _do())

@mcp.tool()
async def nc_notes_create(title: str, content: str, category: str | None = None) -> str:
    """Create a Nextcloud note."""
    async def _do() -> str:
        return _json(await _nc().notes_create(title, content, category))
    return await _with_timeout("nc_notes_create", _do())

@mcp.tool()
async def nc_notes_update(noteId: int, title: str | None = None, content: str | None = None, category: str | None = None) -> str:
    """Update a Nextcloud note."""
    async def _do() -> str:
        return _json(await _nc().notes_update(noteId, title, content, category))
    return await _with_timeout("nc_notes_update", _do())

@mcp.tool()
async def nc_notes_delete(noteId: int) -> str:
    """Delete a Nextcloud note."""
    async def _do() -> str:
        return _json(await _nc().notes_delete(noteId))
    return await _with_timeout("nc_notes_delete", _do())

@mcp.tool()
async def nc_notes_search(query: str) -> str:
    """Search Nextcloud notes."""
    async def _do() -> str:
        return _json(await _nc().notes_search(query))
    return await _with_timeout("nc_notes_search", _do())


# ── Calendar (4) ──────────────────────────────────────────────────────────────

@mcp.tool()
async def nc_calendar_list() -> str:
    """List Nextcloud calendars."""
    return _json(await _nc().calendar_list())

@mcp.tool()
async def nc_calendar_get_events(calendarId: str | None = None, startDate: str | None = None, endDate: str | None = None) -> str:
    """Get events from a Nextcloud calendar."""
    return _json(await _nc().calendar_get_events(calendarId, startDate, endDate))

@mcp.tool()
async def nc_calendar_create_event(summary: str, startDateTime: str, endDateTime: str, calendarId: str | None = None, description: str | None = None, location: str | None = None) -> str:
    """Create a Nextcloud calendar event."""
    return _json(await _nc().calendar_create_event(summary, startDateTime, endDateTime, calendarId, description, location))

@mcp.tool()
async def nc_calendar_delete_event(calendarId: str, eventUid: str) -> str:
    """Delete a Nextcloud calendar event."""
    return _json(await _nc().calendar_delete_event(calendarId, eventUid))


# ── Tasks (3) ─────────────────────────────────────────────────────────────────

@mcp.tool()
async def nc_task_lists() -> str:
    """List Nextcloud task lists (VTODO-capable calendars)."""
    return _json(await _nc().task_list_lists())

@mcp.tool()
async def nc_task_get_tasks(listId: str | None = None, status: str | None = None) -> str:
    """Get tasks from a Nextcloud task list."""
    return _json(await _nc().task_get_tasks(listId, status))

@mcp.tool()
async def nc_task_create(summary: str, listId: str | None = None, description: str | None = None, due: str | None = None, priority: int | None = None) -> str:
    """Create a Nextcloud task."""
    return _json(await _nc().task_create(summary, listId, description, due, priority))


# ── Contacts (5) ──────────────────────────────────────────────────────────────

@mcp.tool()
async def nc_contacts_list_addressbooks() -> str:
    """List Nextcloud address books."""
    return _json(await _nc().contacts_list_addressbooks())

@mcp.tool()
async def nc_contacts_list(addressbookId: str | None = None) -> str:
    """List contacts from a Nextcloud address book."""
    return _json(await _nc().contacts_list(addressbookId))

@mcp.tool()
async def nc_contacts_create(fullName: str, addressbookId: str = "contacts", email: str | None = None, phone: str | None = None, org: str | None = None) -> str:
    """Create a Nextcloud contact."""
    return _json(await _nc().contacts_create(addressbookId, fullName, email, phone, org))

@mcp.tool()
async def nc_contacts_delete(addressbookId: str, contactUid: str) -> str:
    """Delete a Nextcloud contact."""
    return _json(await _nc().contacts_delete(addressbookId, contactUid))

@mcp.tool()
async def nc_contacts_search(query: str) -> str:
    """Search Nextcloud contacts."""
    return _json(await _nc().contacts_search(query))


# ── Files (9) ─────────────────────────────────────────────────────────────────

@mcp.tool()
async def nc_files_list(path: str | None = None) -> str:
    """List files in Nextcloud."""
    return _json(await _nc().files_list(path))

@mcp.tool()
async def nc_files_read(path: str) -> str:
    """Read a file from Nextcloud."""
    content = await _nc().files_read(path)
    return content if isinstance(content, str) else _json(content)

@mcp.tool()
async def nc_files_write(path: str, content: str) -> str:
    """Write a file to Nextcloud."""
    return _json(await _nc().files_write(path, content))

@mcp.tool()
async def nc_files_mkdir(path: str) -> str:
    """Create a directory in Nextcloud."""
    return _json(await _nc().files_mkdir(path))

@mcp.tool()
async def nc_files_delete(path: str) -> str:
    """Delete a file or directory in Nextcloud."""
    return _json(await _nc().files_delete(path))

@mcp.tool()
async def nc_files_move(source: str, destination: str) -> str:
    """Move a file or directory in Nextcloud."""
    return _json(await _nc().files_move(source, destination))

@mcp.tool()
async def nc_files_copy(source: str, destination: str) -> str:
    """Copy a file or directory in Nextcloud."""
    return _json(await _nc().files_copy(source, destination))

@mcp.tool()
async def nc_files_search(query: str, path: str | None = None) -> str:
    """Search files in Nextcloud."""
    return _json(await _nc().files_search(query, path))

@mcp.tool()
async def nc_files_favorites() -> str:
    """List favorite files in Nextcloud."""
    return _json(await _nc().files_list_favorites())


# ── Trashbin (4) ──────────────────────────────────────────────────────────────

@mcp.tool()
async def nc_trash_list() -> str:
    """List items in Nextcloud trashbin."""
    return _json(await _nc().trashbin_list())

@mcp.tool()
async def nc_trash_restore(trashPath: str) -> str:
    """Restore an item from Nextcloud trashbin."""
    return _json(await _nc().trashbin_restore(trashPath))

@mcp.tool()
async def nc_trash_delete(trashPath: str) -> str:
    """Permanently delete an item from Nextcloud trashbin."""
    return _json(await _nc().trashbin_delete(trashPath))

@mcp.tool()
async def nc_trash_empty() -> str:
    """Empty the Nextcloud trashbin."""
    return _json(await _nc().trashbin_empty())


# ── Deck (13) ─────────────────────────────────────────────────────────────────

_DECK_NOT_INSTALLED = _json({"error": "Deck app not installed on this Nextcloud instance", "hint": "Install via: occ app:install deck"})

async def _deck_call(coro: Any, is_app_check: bool = False) -> str:
    """Wrap Deck API calls. Only treat 404 as 'not installed' for listing endpoints."""
    try:
        return _json(await coro)
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404 and is_app_check:
            return _DECK_NOT_INSTALLED
        raise

@mcp.tool()
async def nc_deck_list_boards() -> str:
    """List Nextcloud Deck boards."""
    return await _deck_call(_nc().deck_list_boards(), is_app_check=True)

@mcp.tool()
async def nc_deck_get_board(boardId: int) -> str:
    """Get a Nextcloud Deck board."""
    return await _deck_call(_nc().deck_get_board(boardId))

@mcp.tool()
async def nc_deck_create_board(title: str, color: str | None = None) -> str:
    """Create a Nextcloud Deck board."""
    return await _deck_call(_nc().deck_create_board(title, color))

@mcp.tool()
async def nc_deck_delete_board(boardId: int) -> str:
    """Delete a Nextcloud Deck board."""
    return await _deck_call(_nc().deck_delete_board(boardId))

@mcp.tool()
async def nc_deck_list_stacks(boardId: int) -> str:
    """List stacks in a Nextcloud Deck board."""
    return await _deck_call(_nc().deck_list_stacks(boardId), is_app_check=True)

@mcp.tool()
async def nc_deck_create_stack(boardId: int, title: str, order: int | None = None) -> str:
    """Create a stack in a Nextcloud Deck board."""
    return await _deck_call(_nc().deck_create_stack(boardId, title, order))

@mcp.tool()
async def nc_deck_create_card(boardId: int, stackId: int, title: str, description: str | None = None, duedate: str | None = None) -> str:
    """Create a card in a Nextcloud Deck stack."""
    return await _deck_call(_nc().deck_create_card(boardId, stackId, title, description, duedate))

@mcp.tool()
async def nc_deck_update_card(boardId: int, stackId: int, cardId: int, title: str | None = None, description: str | None = None, duedate: str | None = None) -> str:
    """Update a card in a Nextcloud Deck stack."""
    return await _deck_call(_nc().deck_update_card(boardId, stackId, cardId, title, description, duedate))

@mcp.tool()
async def nc_deck_delete_card(boardId: int, stackId: int, cardId: int) -> str:
    """Delete a card from a Nextcloud Deck stack."""
    return await _deck_call(_nc().deck_delete_card(boardId, stackId, cardId))

@mcp.tool()
async def nc_deck_move_card(boardId: int, stackId: int, cardId: int, targetStackId: int) -> str:
    """Move a card to another stack."""
    return await _deck_call(_nc().deck_move_card(boardId, stackId, cardId, targetStackId))

@mcp.tool()
async def nc_deck_assign_label(boardId: int, stackId: int, cardId: int, labelId: int) -> str:
    """Assign a label to a Deck card."""
    return await _deck_call(_nc().deck_assign_label(boardId, stackId, cardId, labelId))

@mcp.tool()
async def nc_deck_assign_user(boardId: int, stackId: int, cardId: int, userId: str) -> str:
    """Assign a user to a Deck card."""
    return await _deck_call(_nc().deck_assign_user(boardId, stackId, cardId, userId))

@mcp.tool()
async def nc_deck_create_label(boardId: int, title: str, color: str | None = None) -> str:
    """Create a label for a Deck board."""
    return await _deck_call(_nc().deck_create_label(boardId, title, color))


# ── Tables (7) ────────────────────────────────────────────────────────────────

@mcp.tool()
async def nc_tables_list() -> str:
    """List Nextcloud Tables."""
    return _json(await _nc().tables_list())

@mcp.tool()
async def nc_tables_get(tableId: int) -> str:
    """Get a Nextcloud Table."""
    return _json(await _nc().tables_get(tableId))

@mcp.tool()
async def nc_tables_get_columns(tableId: int) -> str:
    """Get columns for a Nextcloud Table."""
    return _json(await _nc().tables_get_columns(tableId))

@mcp.tool()
async def nc_tables_get_rows(tableId: int, limit: int | None = None, offset: int | None = None) -> str:
    """Get rows from a Nextcloud Table."""
    return _json(await _nc().tables_get_rows(tableId, limit, offset))

@mcp.tool()
async def nc_tables_create_row(tableId: int, data: dict[str, Any]) -> str:
    """Create a row in a Nextcloud Table."""
    return _json(await _nc().tables_create_row(tableId, data))

@mcp.tool()
async def nc_tables_update_row(rowId: int, data: dict[str, Any]) -> str:
    """Update a row in a Nextcloud Table."""
    return _json(await _nc().tables_update_row(rowId, data))

@mcp.tool()
async def nc_tables_delete_row(rowId: int) -> str:
    """Delete a row from a Nextcloud Table."""
    return _json(await _nc().tables_delete_row(rowId))


# ── Sharing (5) ───────────────────────────────────────────────────────────────

@mcp.tool()
async def nc_shares_list(path: str | None = None) -> str:
    """List Nextcloud shares."""
    return _json(await _nc().shares_list(path))

@mcp.tool()
async def nc_shares_get(shareId: int) -> str:
    """Get a Nextcloud share."""
    return _json(await _nc().shares_get(shareId))

@mcp.tool()
async def nc_shares_create(path: str, shareType: int, shareWith: str | None = None, permissions: int | None = None, password: str | None = None, expireDate: str | None = None) -> str:
    """Create a Nextcloud share."""
    return _json(await _nc().shares_create(path, shareType, shareWith, permissions, password, expireDate))

@mcp.tool()
async def nc_shares_update(shareId: int, permissions: int | None = None, password: str | None = None, expireDate: str | None = None) -> str:
    """Update a Nextcloud share."""
    return _json(await _nc().shares_update(shareId, permissions, password, expireDate))

@mcp.tool()
async def nc_shares_delete(shareId: int) -> str:
    """Delete a Nextcloud share."""
    return _json(await _nc().shares_delete(shareId))


# ── Talk (10) ─────────────────────────────────────────────────────────────────

@mcp.tool()
async def nc_talk_list_conversations() -> str:
    """List Nextcloud Talk conversations."""
    return _json(await _nc().talk_list_conversations())

@mcp.tool()
async def nc_talk_get_conversation(token: str) -> str:
    """Get a Nextcloud Talk conversation."""
    return _json(await _nc().talk_get_conversation(token))

@mcp.tool()
async def nc_talk_create_conversation(roomType: int, roomName: str, invite: str | None = None) -> str:
    """Create a Nextcloud Talk conversation."""
    return _json(await _nc().talk_create_conversation(roomType, roomName, invite))

@mcp.tool()
async def nc_talk_get_messages(token: str, limit: int | None = None) -> str:
    """Get messages from a Nextcloud Talk conversation."""
    return _json(await _nc().talk_get_messages(token, limit))

@mcp.tool()
async def nc_talk_send_message(token: str, message: str, replyTo: int | None = None) -> str:
    """Send a message in a Nextcloud Talk conversation."""
    return _json(await _nc().talk_send_message(token, message, replyTo))

@mcp.tool()
async def nc_talk_delete_message(token: str, messageId: int) -> str:
    """Delete a message from a Nextcloud Talk conversation."""
    return _json(await _nc().talk_delete_message(token, messageId))

@mcp.tool()
async def nc_talk_get_participants(token: str) -> str:
    """Get participants of a Nextcloud Talk conversation."""
    return _json(await _nc().talk_get_participants(token))

@mcp.tool()
async def nc_talk_create_poll(token: str, question: str, options: list[str], maxVotes: int | None = None) -> str:
    """Create a poll in a Nextcloud Talk conversation."""
    return _json(await _nc().talk_create_poll(token, question, options, maxVotes))

@mcp.tool()
async def nc_talk_vote_poll(token: str, pollId: int, optionIds: list[int]) -> str:
    """Vote on a Nextcloud Talk poll."""
    return _json(await _nc().talk_vote_poll(token, pollId, optionIds))

@mcp.tool()
async def nc_talk_close_poll(token: str, pollId: int) -> str:
    """Close a Nextcloud Talk poll."""
    return _json(await _nc().talk_close_poll(token, pollId))


# ── Notifications (3) ─────────────────────────────────────────────────────────

@mcp.tool()
async def nc_notifications_list() -> str:
    """List Nextcloud notifications."""
    return _json(await _nc().notifications_list())

@mcp.tool()
async def nc_notifications_dismiss(notificationId: int) -> str:
    """Dismiss a Nextcloud notification."""
    return _json(await _nc().notifications_dismiss(notificationId))

@mcp.tool()
async def nc_notifications_dismiss_all() -> str:
    """Dismiss all Nextcloud notifications."""
    return _json(await _nc().notifications_dismiss_all())


# ── Activity (1) ──────────────────────────────────────────────────────────────

@mcp.tool()
async def nc_activity(limit: int | None = None, sinceId: int | None = None) -> str:
    """Get Nextcloud activity feed."""
    return _json(await _nc().activity_get(limit, sinceId))


# ── Users (3) ─────────────────────────────────────────────────────────────────

@mcp.tool()
async def nc_users_current() -> str:
    """Get current Nextcloud user."""
    return _json(await _nc().users_get_current())

@mcp.tool()
async def nc_users_list(search: str | None = None, limit: int | None = None) -> str:
    """List Nextcloud users."""
    return _json(await _nc().users_list(search, limit))

@mcp.tool()
async def nc_users_get(userId: str) -> str:
    """Get a Nextcloud user."""
    return _json(await _nc().users_get(userId))


# ── User Status (3) ──────────────────────────────────────────────────────────

@mcp.tool()
async def nc_status_get(userId: str | None = None) -> str:
    """Get user status."""
    return _json(await _nc().user_status_get(userId))

@mcp.tool()
async def nc_status_set(statusType: str, message: str | None = None, icon: str | None = None) -> str:
    """Set user status."""
    return _json(await _nc().user_status_set(statusType, message, icon))

@mcp.tool()
async def nc_status_clear() -> str:
    """Clear user status."""
    return _json(await _nc().user_status_clear())


# ── Search (2) ────────────────────────────────────────────────────────────────

@mcp.tool()
async def nc_search_providers() -> str:
    """List Nextcloud search providers."""
    return _json(await _nc().search_providers())

@mcp.tool()
async def nc_search(query: str, providerId: str = "files", limit: int | None = None) -> str:
    """Unified search across Nextcloud. Use nc_search_providers to see available providers (e.g. 'files', 'fulltextsearch')."""
    return _json(await _nc().unified_search(providerId, query, limit))


# ── Mail (5) ──────────────────────────────────────────────────────────────────

@mcp.tool()
async def nc_mail_accounts() -> str:
    """List Nextcloud Mail accounts."""
    return _json(await _nc().mail_list_accounts())

@mcp.tool()
async def nc_mail_mailboxes(accountId: int) -> str:
    """List mailboxes for a Nextcloud Mail account."""
    return _json(await _nc().mail_list_mailboxes(accountId))

@mcp.tool()
async def nc_mail_messages(accountId: int, folderId: int, limit: int | None = None) -> str:
    """List messages in a Nextcloud Mail folder."""
    return _json(await _nc().mail_list_messages(accountId, folderId, limit))

@mcp.tool()
async def nc_mail_get_message(messageId: int) -> str:
    """Get a Nextcloud Mail message."""
    return _json(await _nc().mail_get_message(messageId))

@mcp.tool()
async def nc_mail_send(accountId: int, to: str, subject: str, body: str, cc: str | None = None, bcc: str | None = None) -> str:
    """Send an email via Nextcloud Mail."""
    return _json(await _nc().mail_send(accountId, to, subject, body, cc, bcc))


# ── Tags (4) ──────────────────────────────────────────────────────────────────

@mcp.tool()
async def nc_tags_list() -> str:
    """List Nextcloud tags."""
    return _json(await _nc().tags_list())

@mcp.tool()
async def nc_tags_create(name: str, userVisible: bool = True, userAssignable: bool = True) -> str:
    """Create a Nextcloud tag."""
    return _json(await _nc().tags_create(name, userVisible, userAssignable))

@mcp.tool()
async def nc_tags_assign(fileId: int, tagId: int) -> str:
    """Assign a tag to a file."""
    return _json(await _nc().tags_assign(fileId, tagId))

@mcp.tool()
async def nc_tags_unassign(fileId: int, tagId: int) -> str:
    """Unassign a tag from a file."""
    return _json(await _nc().tags_unassign(fileId, tagId))


# ── Versions (2) ──────────────────────────────────────────────────────────────

@mcp.tool()
async def nc_versions_list(fileId: int) -> str:
    """List file versions in Nextcloud."""
    return _json(await _nc().versions_list(fileId))

@mcp.tool()
async def nc_versions_restore(fileId: int, versionId: str) -> str:
    """Restore a file version in Nextcloud."""
    return _json(await _nc().versions_restore(fileId, versionId))


# ── Comments (2) ──────────────────────────────────────────────────────────────

@mcp.tool()
async def nc_comments_list(fileId: int) -> str:
    """List comments on a Nextcloud file."""
    return _json(await _nc().comments_list(fileId))

@mcp.tool()
async def nc_comments_add(fileId: int, message: str) -> str:
    """Add a comment to a Nextcloud file."""
    return _json(await _nc().comments_add(fileId, message))


# ── Apps (4) ──────────────────────────────────────────────────────────────────

@mcp.tool()
async def nc_apps_list(filter: str | None = None) -> str:
    """List Nextcloud apps."""
    return _json(await _nc().apps_list(filter))

@mcp.tool()
async def nc_apps_info(appId: str) -> str:
    """Get info about a Nextcloud app."""
    return _json(await _nc().apps_get_info(appId))

@mcp.tool()
async def nc_apps_enable(appId: str) -> str:
    """Enable a Nextcloud app."""
    return _json(await _nc().apps_enable(appId))

@mcp.tool()
async def nc_apps_disable(appId: str) -> str:
    """Disable a Nextcloud app."""
    return _json(await _nc().apps_disable(appId))


# ── Forms (3) ─────────────────────────────────────────────────────────────────

@mcp.tool()
async def nc_forms_list() -> str:
    """List Nextcloud forms."""
    return _json(await _nc().forms_list())

@mcp.tool()
async def nc_forms_get(formId: int) -> str:
    """Get a Nextcloud form."""
    return _json(await _nc().forms_get(formId))

@mcp.tool()
async def nc_forms_submissions(formId: int) -> str:
    """Get submissions for a Nextcloud form."""
    return _json(await _nc().forms_get_submissions(formId))


# ══════════════════════════════════════════════════════════════════════════════
# SERVER ENTRY POINT
# ══════════════════════════════════════════════════════════════════════════════

def _create_app():
    """Create the ASGI app with auth middleware wrapping the FastMCP SSE app."""
    import json as _json_mod

    from starlette.applications import Starlette
    from starlette.requests import Request
    from starlette.responses import JSONResponse
    from starlette.routing import Mount, Route

    # Health endpoint (no auth)
    async def health_handler(request: Request) -> JSONResponse:
        try:
            tool_count = len(mcp._tool_manager._tools)
        except Exception:
            tool_count = -1
        return JSONResponse({"status": "ok", "tools": tool_count, "version": "7.0.0"})

    # Get the inner SSE app from FastMCP
    inner_sse_app = mcp.sse_app()

    # Build a wrapping ASGI app that checks auth before forwarding
    async def auth_wrapper(scope, receive, send):
        if scope["type"] == "lifespan":
            # Pass lifespan events through
            await inner_sse_app(scope, receive, send)
            return

        # Extract path and method
        path = scope.get("path", "")
        method = scope.get("method", "GET")

        # Skip auth for health checks and OPTIONS
        if path in {"/health", "/healthz", "/ready"}:
            # Handle health directly
            request = Request(scope, receive)
            response = await health_handler(request)
            await response(scope, receive, send)
            return

        if method == "OPTIONS":
            await inner_sse_app(scope, receive, send)
            return

        # Check Authorization header
        headers = dict(scope.get("headers", []))
        auth_header = headers.get(b"authorization", b"").decode("utf-8", errors="ignore")

        if not auth_header.startswith("Bearer "):
            response = JSONResponse(
                status_code=401,
                content={"error": "Missing Authorization header. Use: Bearer <token>"},
            )
            await response(scope, receive, send)
            return

        token = auth_header[7:]
        if not AUTH_TOKEN or token != AUTH_TOKEN:
            response = JSONResponse(
                status_code=403,
                content={"error": "Invalid authentication token"},
            )
            await response(scope, receive, send)
            return

        # Auth passed — forward to inner SSE app
        await inner_sse_app(scope, receive, send)

    return auth_wrapper


def main() -> None:
    """Start the Garza MCP Server with native HTTP transport."""
    import anyio
    import uvicorn

    logger.info("Starting Garza MCP Server v7 (Python FastMCP)")
    logger.info("Mail user: %s", PROTONMAIL_USERNAME)
    logger.info("Proton Drive: %s", PROTON_DRIVE_PATH)
    logger.info("iCloud Drive: %s", ICLOUD_DRIVE_PATH)
    if fabric:
        logger.info("Fabric AI: connected")
    if quo:
        logger.info("Quo (OpenPhone): connected")
    if voicenotes:
        logger.info("Voicenotes: connected")
    if nextcloud:
        logger.info("Nextcloud: %s", NEXTCLOUD_URL)

    try:
        tool_count = len(mcp._tool_manager._tools)
        logger.info("Registered %d tools", tool_count)
    except Exception:
        logger.info("Tools registered (count unavailable)")
    logger.info("Starting SSE transport on %s:%d", SERVER_HOST, SERVER_PORT)

    app = _create_app()

    async def _serve() -> None:
        config = uvicorn.Config(
            app,
            host=SERVER_HOST,
            port=SERVER_PORT,
            log_level="info",
        )
        server = uvicorn.Server(config)
        await server.serve()

    anyio.run(_serve)


if __name__ == "__main__":
    main()
