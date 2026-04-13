"""Beeper SQLite database service — queries the local BeeperTexts index.db."""

from __future__ import annotations

import asyncio
import json
import logging
import tempfile
from typing import Any

from garza_mcp.config import BEEPER_DB_PATH

logger = logging.getLogger(__name__)

QUERY_TIMEOUT = 45


class BeeperDbService:
    """Async wrapper around sqlite3 CLI for the Beeper database."""

    def __init__(self, db_path: str = BEEPER_DB_PATH, timeout: int = QUERY_TIMEOUT) -> None:
        self.db_path = db_path
        self.timeout = timeout

    async def _query(self, sql: str) -> str:
        """Execute a SQL query via sqlite3 CLI and return raw output."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".sql", delete=False) as f:
            f.write(sql)
            sql_file = f.name

        cmd = f'sqlite3 -header -separator "|" "{self.db_path}" < "{sql_file}"'
        proc = await asyncio.create_subprocess_shell(
            cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=self.timeout)
        except asyncio.TimeoutError:
            proc.kill()
            raise TimeoutError(f"Query timed out after {self.timeout}s")
        if proc.returncode != 0:
            err_text = stderr.decode().strip() if stderr else "unknown error"
            raise RuntimeError(f"sqlite3 error: {err_text}")
        return stdout.decode().strip()

    async def _query_json(self, sql: str) -> list[dict[str, Any]]:
        """Execute a SQL query via sqlite3 CLI and return parsed JSON rows."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".sql", delete=False) as f:
            f.write(f".mode json\n{sql}")
            sql_file = f.name

        cmd = f'sqlite3 "{self.db_path}" < "{sql_file}"'
        proc = await asyncio.create_subprocess_shell(
            cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=self.timeout)
        except asyncio.TimeoutError:
            proc.kill()
            raise TimeoutError(f"Query timed out after {self.timeout}s")
        if proc.returncode != 0:
            err_text = stderr.decode().strip() if stderr else "unknown error"
            raise RuntimeError(f"sqlite3 error: {err_text}")
        text = stdout.decode().strip()
        if not text:
            return []
        return json.loads(text)

    async def get_db_stats(self) -> dict[str, Any]:
        """Fast scalar queries for DB stats."""
        total = await self._query("SELECT MAX(ROWID) FROM message;")
        count = await self._query("SELECT COUNT(*) FROM message;")
        threads = await self._query("SELECT COUNT(DISTINCT chat_guid) FROM message;")
        return {"totalMessages": total, "messageCount": count, "threadCount": threads}

    async def search_messages(self, query: str, limit: int = 20, chat_id: str | None = None) -> list[dict[str, Any]]:
        """FTS5 full-text search across messages."""
        where = ""
        if chat_id:
            safe_id = chat_id.replace("'", "''")
            where = f"AND m.chat_guid = '{safe_id}'"
        sql = f"""
            SELECT m.ROWID as id, m.chat_guid, m.sender, m.text,
                   datetime(m.timestamp/1000, 'unixepoch') as date
            FROM message m
            JOIN message_fts f ON f.ROWID = m.ROWID
            WHERE message_fts MATCH '{query.replace("'", "''")}'
            {where}
            ORDER BY m.timestamp DESC
            LIMIT {limit};
        """
        return await self._query_json(sql)

    async def get_chat_history(self, chat_id: str, limit: int = 50, before: str | None = None) -> list[dict[str, Any]]:
        """Get message history for a chat thread."""
        where_before = ""
        if before:
            where_before = f"AND m.timestamp < {int(before)}"
        sql = f"""
            SELECT m.ROWID as id, m.sender, m.text,
                   datetime(m.timestamp/1000, 'unixepoch') as date
            FROM message m
            WHERE m.chat_guid = '{chat_id.replace("'", "''")}'
            {where_before}
            ORDER BY m.timestamp DESC
            LIMIT {limit};
        """
        return await self._query_json(sql)

    async def list_threads(self, limit: int = 50, account_id: str | None = None) -> list[dict[str, Any]]:
        """List chat threads (avoids expensive subqueries)."""
        where = ""
        if account_id:
            safe_id = account_id.replace("'", "''")
            where = f"WHERE chat_guid LIKE '{safe_id}%'"
        sql = f"""
            SELECT chat_guid, COUNT(*) as message_count,
                   MAX(datetime(timestamp/1000, 'unixepoch')) as last_message
            FROM message
            {where}
            GROUP BY chat_guid
            ORDER BY MAX(timestamp) DESC
            LIMIT {limit};
        """
        return await self._query_json(sql)

    async def get_participants(self, chat_id: str) -> list[dict[str, Any]]:
        sql = f"""
            SELECT DISTINCT sender, COUNT(*) as message_count
            FROM message
            WHERE chat_guid = '{chat_id.replace("'", "''")}'
            GROUP BY sender
            ORDER BY message_count DESC;
        """
        return await self._query_json(sql)

    async def search_contacts(self, query: str, limit: int = 20) -> list[dict[str, Any]]:
        sql = f"""
            SELECT DISTINCT sender, COUNT(*) as message_count
            FROM message
            WHERE sender LIKE '%{query.replace("'", "''")}%'
            GROUP BY sender
            ORDER BY message_count DESC
            LIMIT {limit};
        """
        return await self._query_json(sql)

    async def get_reactions(self, chat_id: str, event_id: str) -> list[dict[str, Any]]:
        sql = f"""
            SELECT * FROM reaction
            WHERE chat_guid = '{chat_id.replace("'", "''")}'
            AND rel_event_id = '{event_id.replace("'", "''")}'
            ORDER BY timestamp DESC;
        """
        return await self._query_json(sql)

    async def get_chat_analytics(self, chat_id: str | None = None, days: int = 30) -> list[dict[str, Any]]:
        where = ""
        if chat_id:
            safe_id = chat_id.replace("'", "''")
            where = f"AND chat_guid = '{safe_id}'"
        sql = f"""
            SELECT date(timestamp/1000, 'unixepoch') as day,
                   COUNT(*) as messages,
                   COUNT(DISTINCT sender) as unique_senders
            FROM message
            WHERE timestamp > (strftime('%s', 'now', '-{days} days') * 1000)
            {where}
            GROUP BY day
            ORDER BY day DESC;
        """
        return await self._query_json(sql)
