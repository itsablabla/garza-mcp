"""Voicenotes REST API client (Obsidian Sync API)."""

from __future__ import annotations

import logging
from typing import Any

import httpx

from garza_mcp.config import VOICENOTES_API_URL, VOICENOTES_TOKEN

logger = logging.getLogger(__name__)

MAX_PAGES = 10


class VoicenotesService:
    """Async client for the Voicenotes Obsidian Sync API."""

    def __init__(
        self,
        api_url: str = VOICENOTES_API_URL,
        token: str = VOICENOTES_TOKEN,
        timeout: float = 15.0,
    ) -> None:
        self.api_url = api_url.rstrip("/")
        self._client = httpx.AsyncClient(
            base_url=self.api_url,
            headers={
                "Authorization": f"Bearer {token}",
                "X-API-KEY": token,
                "Content-Type": "application/json",
            },
            timeout=timeout,
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        resp = await self._client.request(method, path, **kwargs)
        resp.raise_for_status()
        return resp.json() if resp.content else {}

    async def get_user_info(self) -> Any:
        return await self._request("GET", "/api/integrations/obsidian-sync/user/info")

    async def list_recordings(self, since: str | None = None) -> Any:
        body: dict[str, Any] = {
            "obsidian_deleted_recording_ids": [],
            "last_synced_note_updated_at": since,
        }
        return await self._request("POST", "/api/integrations/obsidian-sync/recordings", json=body)

    async def get_next_page(self, url: str) -> Any:
        resp = await self._client.post(url, json={})
        resp.raise_for_status()
        return resp.json()

    async def get_recording_audio_url(self, recording_id: str) -> Any:
        return await self._request("GET", f"/api/integrations/obsidian-sync/recordings/{recording_id}/signed-url")

    async def delete_recording(self, recording_id: str) -> Any:
        return await self._request("DELETE", f"/api/integrations/obsidian-sync/recordings/{recording_id}")

    async def search_notes(self, query: str, limit: int = 20) -> list[dict[str, Any]]:
        """Client-side search by paginating through all recordings."""
        results: list[dict[str, Any]] = []
        query_lower = query.lower()

        data = await self.list_recordings()
        page = 0
        while data and page < MAX_PAGES:
            recordings = data.get("data", data.get("recordings", []))
            if isinstance(recordings, list):
                for rec in recordings:
                    title = str(rec.get("title", "")).lower()
                    transcript = str(rec.get("transcript", "")).lower()
                    if query_lower in title or query_lower in transcript:
                        results.append(rec)
                        if len(results) >= limit:
                            return results

            next_url = None
            links = data.get("links", {})
            if isinstance(links, dict):
                next_url = links.get("next")
            if not next_url:
                break
            data = await self.get_next_page(next_url)
            page += 1

        return results
