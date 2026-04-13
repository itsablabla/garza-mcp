"""ProtonMail IMAP + SMTP service with server-side search and auto-reconnect."""

from __future__ import annotations

import asyncio
import email
import email.header
import logging
import ssl
from typing import Any

import aiosmtplib

from garza_mcp.config import (
    IMAP_HOST,
    IMAP_PORT,
    PROTONMAIL_PASSWORD,
    PROTONMAIL_USERNAME,
    SMTP_HOST,
    SMTP_PORT,
)

logger = logging.getLogger(__name__)

# Tiered timeouts (seconds)
CONNECT_TIMEOUT = 20
LIGHT_TIMEOUT = 30
HEAVY_TIMEOUT = 60
SEARCH_TIMEOUT = 90
KEEPALIVE_INTERVAL = 60


class ImapService:
    """Async IMAP client with server-side SEARCH, auto-reconnect, and NOOP keepalive."""

    def __init__(
        self,
        host: str = IMAP_HOST,
        port: int = IMAP_PORT,
        username: str = PROTONMAIL_USERNAME,
        password: str = PROTONMAIL_PASSWORD,
    ) -> None:
        self.host = host
        self.port = port
        self.username = username
        self.password = password
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._tag_counter = 0
        self._connected = False
        self._last_activity = 0.0
        self._lock = asyncio.Lock()

    def _next_tag(self) -> str:
        self._tag_counter += 1
        return f"A{self._tag_counter:04d}"

    async def _send(self, command: str, timeout: float = LIGHT_TIMEOUT) -> list[str]:
        """Send an IMAP command and collect response lines until tagged OK/NO/BAD."""
        if not self._writer or not self._reader:
            raise ConnectionError("Not connected to IMAP server")

        tag = self._next_tag()
        self._writer.write(f"{tag} {command}\r\n".encode())
        await self._writer.drain()

        lines: list[str] = []
        try:
            while True:
                raw = await asyncio.wait_for(self._reader.readline(), timeout=timeout)
                line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                if line.startswith(f"{tag} "):
                    status = line[len(tag) + 1 :]
                    if status.startswith("NO") or status.startswith("BAD"):
                        raise RuntimeError(f"IMAP error: {status}")
                    lines.append(line)
                    break
                lines.append(line)
        except asyncio.TimeoutError:
            raise TimeoutError(f"IMAP command timed out after {timeout}s: {command[:60]}")

        self._last_activity = asyncio.get_event_loop().time()
        return lines

    async def connect(self) -> None:
        """Connect and authenticate to the IMAP server (acquires lock)."""
        async with self._lock:
            await self._connect_unlocked()

    async def _connect_unlocked(self) -> None:
        """Internal connect without acquiring the lock."""
        if self._connected:
            return
        try:
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE

            self._reader, self._writer = await asyncio.wait_for(
                asyncio.open_connection(self.host, self.port, ssl=ctx),
                timeout=CONNECT_TIMEOUT,
            )
            # Read greeting
            greeting = await asyncio.wait_for(self._reader.readline(), timeout=CONNECT_TIMEOUT)
            logger.debug("IMAP greeting: %s", greeting.decode().strip())

            # Login — escape backslash and double-quote per RFC 3501
            safe_user = self.username.replace('\\', '\\\\').replace('"', '\\"')
            safe_pass = self.password.replace('\\', '\\\\').replace('"', '\\"')
            await self._send(f'LOGIN "{safe_user}" "{safe_pass}"', timeout=CONNECT_TIMEOUT)
            self._connected = True
            self._last_activity = asyncio.get_event_loop().time()
            logger.info("IMAP connected to %s:%d as %s", self.host, self.port, self.username)
        except Exception:
            self._connected = False
            if self._writer:
                self._writer.close()
            raise

    async def disconnect(self) -> None:
        """Cleanly disconnect from the IMAP server."""
        if self._writer:
            try:
                await self._send("LOGOUT", timeout=5)
            except Exception:
                pass
            self._writer.close()
        self._connected = False
        self._reader = None
        self._writer = None

    def is_connected(self) -> bool:
        return self._connected

    async def _ensure_connected_unlocked(self) -> None:
        """Auto-reconnect if needed, with NOOP keepalive probe (no lock)."""
        if not self._connected:
            await self._connect_unlocked()
            return

        now = asyncio.get_event_loop().time()
        if now - self._last_activity > KEEPALIVE_INTERVAL:
            try:
                await self._send("NOOP", timeout=10)
            except Exception:
                logger.warning("NOOP failed, reconnecting...")
                self._connected = False
                if self._writer:
                    self._writer.close()
                self._writer = None
                self._reader = None
                await self._connect_unlocked()

    async def _with_reconnect(self, coro_fn: Any) -> Any:
        """Wrapper that serializes IMAP operations and retries on transient errors."""
        async with self._lock:
            try:
                await self._ensure_connected_unlocked()
                return await coro_fn()
            except (ConnectionError, TimeoutError, OSError, RuntimeError) as e:
                err_msg = str(e).lower()
                transient = any(k in err_msg for k in ["socket", "timeout", "reset", "broken pipe", "not connected"])
                if transient:
                    logger.warning("Transient IMAP error, reconnecting: %s", e)
                    self._connected = False
                    if self._writer:
                        self._writer.close()
                    self._writer = None
                    self._reader = None
                    await self._connect_unlocked()
                    return await coro_fn()
                raise

    async def _select_folder(self, folder: str) -> None:
        await self._send(f'SELECT "{folder}"', timeout=LIGHT_TIMEOUT)

    def _parse_envelope(self, fetch_data: str) -> dict[str, Any]:
        """Parse minimal fields from a FETCH response."""
        result: dict[str, Any] = {
            "id": "",
            "subject": "",
            "from": "",
            "to": [],
            "date": "",
            "read": False,
            "starred": False,
            "body": "",
        }

        # Extract UID
        import re

        uid_match = re.search(r"UID (\d+)", fetch_data)
        if uid_match:
            result["id"] = uid_match.group(1)

        # Extract FLAGS
        flags_match = re.search(r"FLAGS \(([^)]*)\)", fetch_data)
        if flags_match:
            flags = flags_match.group(1)
            result["read"] = "\\Seen" in flags
            result["starred"] = "\\Flagged" in flags

        return result

    def _parse_email_bytes(self, raw: bytes, uid: str) -> dict[str, Any]:
        """Parse a raw email message."""
        msg = email.message_from_bytes(raw)

        # Decode subject
        subject = ""
        raw_subject = msg.get("Subject", "")
        if raw_subject:
            decoded = email.header.decode_header(raw_subject)
            parts = []
            for part, charset in decoded:
                if isinstance(part, bytes):
                    parts.append(part.decode(charset or "utf-8", errors="replace"))
                else:
                    parts.append(str(part))
            subject = " ".join(parts)

        # Get body
        body = ""
        if msg.is_multipart():
            for part in msg.walk():
                ct = part.get_content_type()
                if ct == "text/plain":
                    payload = part.get_payload(decode=True)
                    if payload:
                        body = payload.decode("utf-8", errors="replace")
                    break
        else:
            payload = msg.get_payload(decode=True)
            if payload:
                body = payload.decode("utf-8", errors="replace")

        # Parse addresses
        from_addr = msg.get("From", "")
        to_raw = msg.get("To", "")
        to_list = [a.strip() for a in to_raw.split(",")] if to_raw else []

        return {
            "id": uid,
            "subject": subject,
            "from": from_addr,
            "to": to_list,
            "date": msg.get("Date", ""),
            "body": body,
            "read": False,
            "starred": False,
        }

    async def get_emails(self, folder: str = "INBOX", limit: int = 20, offset: int = 0) -> list[dict[str, Any]]:
        async def _do() -> list[dict[str, Any]]:
            await self._select_folder(folder)

            # Get message count from EXISTS response
            lines = await self._send("UID SEARCH ALL", timeout=HEAVY_TIMEOUT)
            uids: list[str] = []
            for line in lines:
                if line.startswith("* SEARCH"):
                    uids = line.split()[2:]
                    break

            if not uids:
                return []

            # Get the requested range (newest first)
            uids.reverse()
            selected = uids[offset : offset + limit]
            if not selected:
                return []

            uid_list = ",".join(selected)
            fetch_lines = await self._send(
                f"UID FETCH {uid_list} (UID FLAGS BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE)])",
                timeout=HEAVY_TIMEOUT,
            )

            results: list[dict[str, Any]] = []
            current_uid = ""
            current_flags = ""
            header_bytes = b""
            in_header = False

            for line in fetch_lines:
                import re

                uid_m = re.search(r"UID (\d+)", line)
                if uid_m:
                    if current_uid and header_bytes:
                        parsed = self._parse_email_bytes(header_bytes, current_uid)
                        parsed["read"] = "\\Seen" in current_flags
                        parsed["starred"] = "\\Flagged" in current_flags
                        results.append(parsed)
                    current_uid = uid_m.group(1)
                    flags_m = re.search(r"FLAGS \(([^)]*)\)", line)
                    current_flags = flags_m.group(1) if flags_m else ""
                    header_bytes = b""
                    in_header = True
                elif in_header and line.startswith(")"):
                    in_header = False
                elif in_header:
                    header_bytes += (line + "\r\n").encode()

            if current_uid and header_bytes:
                parsed = self._parse_email_bytes(header_bytes, current_uid)
                parsed["read"] = "\\Seen" in current_flags
                parsed["starred"] = "\\Flagged" in current_flags
                results.append(parsed)

            return results

        return await self._with_reconnect(_do)

    async def get_email_by_id(self, uid: str, folder: str = "INBOX") -> dict[str, Any] | None:
        async def _do() -> dict[str, Any] | None:
            await self._select_folder(folder)
            lines = await self._send(f"UID FETCH {uid} (UID FLAGS BODY[])", timeout=HEAVY_TIMEOUT)

            raw_bytes = b""
            in_body = False
            flags = ""
            for line in lines:
                import re

                flags_m = re.search(r"FLAGS \(([^)]*)\)", line)
                if flags_m:
                    flags = flags_m.group(1)

                if "BODY[]" in line:
                    in_body = True
                    # Content may start on same line after the literal count
                    brace_idx = line.find("}")
                    if brace_idx >= 0 and brace_idx + 1 < len(line):
                        raw_bytes += line[brace_idx + 1 :].encode()
                    continue
                if in_body:
                    if line.startswith(")") or (line.startswith("A") and " OK" in line):
                        in_body = False
                        continue
                    raw_bytes += (line + "\r\n").encode()

            if not raw_bytes:
                return None

            result = self._parse_email_bytes(raw_bytes, uid)
            result["read"] = "\\Seen" in flags
            result["starred"] = "\\Flagged" in flags
            return result

        return await self._with_reconnect(_do)

    async def search_emails(self, query: str, folder: str = "INBOX", limit: int = 20) -> list[dict[str, Any]]:
        """Server-side IMAP SEARCH (OR subject/from), NOT client-side scan."""

        async def _do() -> list[dict[str, Any]]:
            await self._select_folder(folder)

            # Server-side search: OR subject/from
            safe_query = query.replace('"', '\\"')
            try:
                lines = await self._send(
                    f'UID SEARCH OR SUBJECT "{safe_query}" FROM "{safe_query}"',
                    timeout=SEARCH_TIMEOUT,
                )
            except RuntimeError:
                # Fallback to subject-only
                lines = await self._send(f'UID SEARCH SUBJECT "{safe_query}"', timeout=SEARCH_TIMEOUT)

            uids: list[str] = []
            for line in lines:
                if line.startswith("* SEARCH"):
                    uids = line.split()[2:]
                    break

            if not uids:
                return []

            uids.reverse()
            selected = uids[:limit]
            uid_list = ",".join(selected)

            fetch_lines = await self._send(
                f"UID FETCH {uid_list} (UID FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])",
                timeout=HEAVY_TIMEOUT,
            )

            results: list[dict[str, Any]] = []
            import re

            current_uid = ""
            header_bytes = b""
            in_header = False

            for line in fetch_lines:
                uid_m = re.search(r"UID (\d+)", line)
                if uid_m:
                    if current_uid and header_bytes:
                        parsed = self._parse_email_bytes(header_bytes, current_uid)
                        results.append(parsed)
                    current_uid = uid_m.group(1)
                    header_bytes = b""
                    in_header = True
                elif in_header and line.startswith(")"):
                    in_header = False
                elif in_header:
                    header_bytes += (line + "\r\n").encode()

            if current_uid and header_bytes:
                parsed = self._parse_email_bytes(header_bytes, current_uid)
                results.append(parsed)

            return results

        return await self._with_reconnect(_do)

    async def _list_folders_unlocked(self) -> list[dict[str, str]]:
        """Internal folder listing without lock — for use within _with_reconnect."""
        lines = await self._send('LIST "" "*"', timeout=HEAVY_TIMEOUT)
        import re

        folders: list[dict[str, str]] = []
        for line in lines:
            m = re.search(r'"([^"]*)"$', line)
            if m:
                folders.append({"path": m.group(1)})
            elif line.startswith("* LIST"):
                parts = line.split()
                if parts:
                    folders.append({"path": parts[-1].strip('"')})
        return folders

    async def get_folders(self) -> list[dict[str, str]]:
        async def _do() -> list[dict[str, str]]:
            return await self._list_folders_unlocked()

        return await self._with_reconnect(_do)

    async def mark_email_read(self, uid: str, is_read: bool = True, folder: str = "INBOX") -> None:
        async def _do() -> None:
            await self._select_folder(folder)
            action = "+FLAGS" if is_read else "-FLAGS"
            await self._send(f"UID STORE {uid} {action} (\\Seen)", timeout=LIGHT_TIMEOUT)

        await self._with_reconnect(_do)

    async def star_email(self, uid: str, is_starred: bool = True, folder: str = "INBOX") -> None:
        async def _do() -> None:
            await self._select_folder(folder)
            action = "+FLAGS" if is_starred else "-FLAGS"
            await self._send(f"UID STORE {uid} {action} (\\Flagged)", timeout=LIGHT_TIMEOUT)

        await self._with_reconnect(_do)

    async def move_email(self, uid: str, target_folder: str, folder: str = "INBOX") -> None:
        async def _do() -> None:
            await self._select_folder(folder)
            await self._send(f'UID COPY {uid} "{target_folder}"', timeout=LIGHT_TIMEOUT)
            await self._send(f"UID STORE {uid} +FLAGS (\\Deleted)", timeout=LIGHT_TIMEOUT)
            await self._send("EXPUNGE", timeout=LIGHT_TIMEOUT)

        await self._with_reconnect(_do)

    async def delete_email(self, uid: str, folder: str = "INBOX") -> None:
        async def _do() -> None:
            await self._select_folder(folder)
            await self._send(f"UID STORE {uid} +FLAGS (\\Deleted)", timeout=LIGHT_TIMEOUT)
            await self._send("EXPUNGE", timeout=LIGHT_TIMEOUT)

        await self._with_reconnect(_do)

    async def get_stats(self) -> dict[str, Any]:
        async def _do() -> dict[str, Any]:
            # Get folder list (unlocked — we're already inside _with_reconnect)
            folders = await self._list_folders_unlocked()

            # Get INBOX stats
            await self._select_folder("INBOX")
            total_lines = await self._send("SEARCH ALL", timeout=HEAVY_TIMEOUT)
            unread_lines = await self._send("SEARCH UNSEEN", timeout=HEAVY_TIMEOUT)

            total = 0
            unread = 0
            for line in total_lines:
                if line.startswith("* SEARCH"):
                    total = len(line.split()) - 2
            for line in unread_lines:
                if line.startswith("* SEARCH"):
                    unread = len(line.split()) - 2

            return {"totalEmails": total, "unreadEmails": unread, "folders": len(folders)}

        return await self._with_reconnect(_do)


class SmtpService:
    """Async SMTP client for sending emails via Proton Bridge."""

    def __init__(
        self,
        host: str = SMTP_HOST,
        port: int = SMTP_PORT,
        username: str = PROTONMAIL_USERNAME,
        password: str = PROTONMAIL_PASSWORD,
    ) -> None:
        self.host = host
        self.port = port
        self.username = username
        self.password = password

    async def send_email(
        self,
        to: list[str],
        subject: str,
        body: str,
        cc: list[str] | None = None,
        bcc: list[str] | None = None,
        reply_to: str | None = None,
        priority: str | None = None,
        html_body: str | None = None,
    ) -> dict[str, str]:
        """Send an email via SMTP."""
        from email.mime.multipart import MIMEMultipart
        from email.mime.text import MIMEText

        msg = MIMEMultipart("alternative") if html_body else MIMEMultipart()
        msg["From"] = self.username
        msg["To"] = ", ".join(to)
        msg["Subject"] = subject

        if cc:
            msg["Cc"] = ", ".join(cc)
        if reply_to:
            msg["Reply-To"] = reply_to
        if priority == "high":
            msg["X-Priority"] = "1"
        elif priority == "low":
            msg["X-Priority"] = "5"

        msg.attach(MIMEText(body, "plain"))
        if html_body:
            msg.attach(MIMEText(html_body, "html"))

        all_recipients = list(to)
        if cc:
            all_recipients.extend(cc)
        if bcc:
            all_recipients.extend(bcc)

        try:
            async with aiosmtplib.SMTP(
                hostname=self.host,
                port=self.port,
                use_tls=True,
                validate_certs=False,
                timeout=30,
            ) as smtp:
                await smtp.login(self.username, self.password)
                result = await smtp.send_message(msg, recipients=all_recipients)
                return {"messageId": str(result), "status": "sent"}
        except Exception as e:
            raise RuntimeError(f"SMTP send failed: {e}") from e

    async def verify_connection(self) -> bool:
        """Check if SMTP is reachable."""
        try:
            async with aiosmtplib.SMTP(
                hostname=self.host,
                port=self.port,
                use_tls=True,
                validate_certs=False,
                timeout=10,
            ) as smtp:
                await smtp.login(self.username, self.password)
                return True
        except Exception:
            return False
