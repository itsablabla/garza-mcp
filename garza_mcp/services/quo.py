"""Quo / OpenPhone REST API client."""

from __future__ import annotations

import logging
from typing import Any

import httpx

from garza_mcp.config import QUO_API_KEY, QUO_API_URL

logger = logging.getLogger(__name__)


class QuoService:
    """Async client for the OpenPhone (Quo) API."""

    def __init__(
        self,
        api_url: str = QUO_API_URL,
        api_key: str = QUO_API_KEY,
        timeout: float = 15.0,
    ) -> None:
        self.api_url = api_url.rstrip("/")
        self._client = httpx.AsyncClient(
            base_url=self.api_url,
            headers={"Authorization": api_key, "Content-Type": "application/json"},
            timeout=timeout,
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        resp = await self._client.request(method, path, **kwargs)
        resp.raise_for_status()
        return resp.json() if resp.content else {}

    # ── Phone Numbers ─────────────────────────────────────────────────────
    async def list_phone_numbers(self) -> Any:
        return await self._request("GET", "/phone-numbers")

    # ── Messages ──────────────────────────────────────────────────────────
    async def send_message(self, from_number: str, to: str, content: str) -> Any:
        return await self._request("POST", "/messages", json={"from": from_number, "to": [to], "content": content})

    async def list_messages(self, phone_number_id: str, participants: list[str], max_results: int = 10) -> Any:
        params: list[tuple[str, str]] = [("phoneNumberId", phone_number_id)]
        for p in participants:
            params.append(("participants[]", p))
        params.append(("maxResults", str(max_results)))
        return await self._request("GET", "/messages", params=params)

    async def get_message(self, message_id: str) -> Any:
        return await self._request("GET", f"/messages/{message_id}")

    # ── Calls ─────────────────────────────────────────────────────────────
    async def list_calls(self, phone_number_id: str, participants: list[str], max_results: int = 10) -> Any:
        params: list[tuple[str, str]] = [("phoneNumberId", phone_number_id)]
        for p in participants:
            params.append(("participants[]", p))
        params.append(("maxResults", str(max_results)))
        return await self._request("GET", "/calls", params=params)

    async def get_call(self, call_id: str) -> Any:
        return await self._request("GET", f"/calls/{call_id}")

    async def get_call_summary(self, call_id: str) -> Any:
        return await self._request("GET", f"/calls/{call_id}/summary")

    async def get_call_transcript(self, call_id: str) -> Any:
        return await self._request("GET", f"/calls/{call_id}/transcript")

    async def get_voicemail(self, call_id: str) -> Any:
        return await self._request("GET", f"/calls/{call_id}/voicemail")

    async def get_call_recordings(self, call_id: str) -> Any:
        return await self._request("GET", f"/calls/{call_id}/recordings")

    # ── Contacts ──────────────────────────────────────────────────────────
    async def list_contacts(self, page: int | None = None) -> Any:
        params: dict[str, Any] = {}
        if page is not None:
            params["page"] = page
        return await self._request("GET", "/contacts", params=params)

    async def get_contact(self, contact_id: str) -> Any:
        return await self._request("GET", f"/contacts/{contact_id}")

    async def create_contact(self, fields: dict[str, Any]) -> Any:
        return await self._request("POST", "/contacts", json=fields)

    async def update_contact(self, contact_id: str, fields: dict[str, Any]) -> Any:
        return await self._request("PATCH", f"/contacts/{contact_id}", json=fields)

    async def delete_contact(self, contact_id: str) -> Any:
        return await self._request("DELETE", f"/contacts/{contact_id}")

    # ── Conversations ─────────────────────────────────────────────────────
    async def list_conversations(
        self, phone_number_id: str | None = None, max_results: int | None = None
    ) -> Any:
        params: dict[str, Any] = {}
        if phone_number_id:
            params["phoneNumberId"] = phone_number_id
        if max_results:
            params["maxResults"] = max_results
        return await self._request("GET", "/conversations", params=params)

    # ── Users ─────────────────────────────────────────────────────────────
    async def list_users(self) -> Any:
        return await self._request("GET", "/users")
