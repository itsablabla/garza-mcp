"""Fabric AI REST API client."""

from __future__ import annotations

import logging
from typing import Any

import httpx

from garza_mcp.config import FABRIC_API_KEY, FABRIC_API_URL, FABRIC_DEFAULT_PARENT

logger = logging.getLogger(__name__)


class FabricService:
    """Async client for the Fabric AI API."""

    def __init__(
        self,
        api_url: str = FABRIC_API_URL,
        api_key: str = FABRIC_API_KEY,
        default_parent: str = FABRIC_DEFAULT_PARENT,
        timeout: float = 15.0,
    ) -> None:
        self.api_url = api_url.rstrip("/")
        self.api_key = api_key
        self.default_parent = default_parent
        self._client = httpx.AsyncClient(
            base_url=self.api_url,
            headers={"X-Api-Key": self.api_key, "Content-Type": "application/json"},
            timeout=timeout,
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        resp = await self._client.request(method, path, **kwargs)
        resp.raise_for_status()
        return resp.json() if resp.content else {}

    async def search(self, query: str, limit: int = 10) -> Any:
        return await self._request("POST", "/v2/search", json={"query": query, "limit": limit})

    async def add_memory(self, content: str) -> Any:
        return await self._request("POST", "/v2/memories", json={"source": "text", "content": content})

    async def recall_memories(self, query: str, limit: int = 20) -> Any:
        # Fabric API uses search for memory recall
        return await self._request("POST", "/v2/search", json={"query": query, "limit": limit})

    async def create_notepad(self, text: str, name: str | None = None, parent_id: str | None = None) -> Any:
        body: dict[str, Any] = {"text": text, "parentId": parent_id or self.default_parent}
        if name:
            body["name"] = name
        return await self._request("POST", "/v2/notepads", json=body)

    async def list_notepads(self, parent_id: str | None = None) -> Any:
        # Fabric API doesn't support GET listing; use search to list notepads
        # Note: parent_id filtering is not supported by the search endpoint
        if parent_id:
            logger.warning("parent_id filtering not supported by Fabric search API — returning all notepads")
        return await self._request("POST", "/v2/search", json={"query": "*", "limit": 50})

    async def get_notepad(self, notepad_id: str) -> Any:
        return await self._request("GET", f"/v2/notepads/{notepad_id}")

    async def update_notepad(self, notepad_id: str, text: str) -> Any:
        return await self._request("PATCH", f"/v2/notepads/{notepad_id}", json={"text": text})

    async def delete_notepad(self, notepad_id: str) -> Any:
        return await self._request("DELETE", f"/v2/notepads/{notepad_id}")
