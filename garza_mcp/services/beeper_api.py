"""Beeper Desktop REST API client."""

from __future__ import annotations

import logging
from typing import Any

import httpx

from garza_mcp.config import BEEPER_API_URL, BEEPER_TOKEN

logger = logging.getLogger(__name__)


class BeeperApiService:
    """Async client for the Beeper Desktop local API."""

    def __init__(
        self,
        api_url: str = BEEPER_API_URL,
        token: str = BEEPER_TOKEN,
        timeout: float = 15.0,
    ) -> None:
        self.api_url = api_url.rstrip("/")
        headers: dict[str, str] = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        self._client = httpx.AsyncClient(base_url=self.api_url, headers=headers, timeout=timeout)

    async def close(self) -> None:
        await self._client.aclose()

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        resp = await self._client.request(method, path, **kwargs)
        resp.raise_for_status()
        return resp.json() if resp.content else {}

    async def list_accounts(self) -> Any:
        return await self._request("GET", "/accounts")

    async def list_chats(
        self,
        limit: int | None = None,
        offset: int | None = None,
        unread_only: bool = False,
        service: str | None = None,
    ) -> Any:
        params: dict[str, Any] = {}
        if limit:
            params["limit"] = limit
        if offset:
            params["offset"] = offset
        if unread_only:
            params["unreadOnly"] = True
        if service:
            params["service"] = service
        return await self._request("GET", "/chats", params=params)

    async def search_chats(self, query: str) -> Any:
        return await self._request("GET", "/chats/search", params={"query": query})

    async def get_chat(self, chat_id: str) -> Any:
        return await self._request("GET", f"/chats/{chat_id}")

    async def get_messages(self, chat_id: str, limit: int | None = None, before: str | None = None) -> Any:
        params: dict[str, Any] = {}
        if limit:
            params["limit"] = limit
        if before:
            params["before"] = before
        return await self._request("GET", f"/chats/{chat_id}/messages", params=params)

    async def search_messages(self, query: str, limit: int | None = None) -> Any:
        params: dict[str, Any] = {"query": query}
        if limit:
            params["limit"] = limit
        return await self._request("GET", "/messages/search", params=params)

    async def send_message(self, chat_id: str, text: str, reply_to: str | None = None) -> Any:
        body: dict[str, Any] = {"text": text}
        if reply_to:
            body["replyTo"] = reply_to
        return await self._request("POST", f"/chats/{chat_id}/messages", json=body)

    async def mark_read(self, chat_id: str, up_to_message_id: str | None = None) -> Any:
        body: dict[str, Any] = {}
        if up_to_message_id:
            body["upToMessageID"] = up_to_message_id
        return await self._request("POST", f"/chats/{chat_id}/read", json=body)

    async def add_reaction(self, chat_id: str, message_id: str, emoji: str) -> Any:
        return await self._request(
            "POST", f"/chats/{chat_id}/messages/{message_id}/reactions", json={"emoji": emoji}
        )

    async def create_chat(self, account_id: str, participant_ids: list[str], chat_type: str = "single") -> Any:
        return await self._request(
            "POST", "/chats", json={"accountID": account_id, "participantIDs": participant_ids, "type": chat_type}
        )

    async def archive_chat(self, chat_id: str, archived: bool) -> Any:
        return await self._request("PUT", f"/chats/{chat_id}/archive", json={"archived": archived})

    async def search_contacts(self, account_id: str, query: str) -> Any:
        return await self._request("GET", f"/accounts/{account_id}/contacts/search", params={"query": query})

    async def set_reminder(self, chat_id: str, remind_at: str) -> Any:
        return await self._request("POST", f"/chats/{chat_id}/reminder", json={"remindAt": remind_at})

    async def get_unread_summary(self) -> dict[str, Any]:
        """Aggregate unread counts across all chats."""
        data = await self.list_chats(unread_only=True)
        chats_list = data if isinstance(data, list) else data.get("chats", [])
        total = 0
        chats: list[dict[str, Any]] = []
        for c in chats_list:
            unread = c.get("unreadCount", 0)
            if unread > 0:
                total += unread
                chats.append({
                    "name": c.get("name", "Unknown"),
                    "service": c.get("service", "unknown"),
                    "unread": unread,
                    "lastMessage": c.get("lastMessage", {}).get("text", ""),
                })
        return {"totalUnread": total, "chats": chats}
