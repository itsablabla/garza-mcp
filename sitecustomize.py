"""Runtime patch for Garza MCP.

This module is imported automatically by Python when present on the import path.
We use it to add CORS support to the FastMCP SSE app without touching the
application entrypoint, so the browser-based MCPX UI can reach the server from
its own origin.
"""

from __future__ import annotations

import os


def _patch_fastmcp_cors() -> None:
    try:
        from mcp.server.fastmcp import FastMCP
        from starlette.middleware.cors import CORSMiddleware
    except Exception:
        return

    if getattr(FastMCP, "_garza_cors_patched", False):
        return

    origins = [
        origin.strip()
        for origin in os.getenv(
            "CORS_ORIGINS",
            "https://mcpx-ui.garza.online,https://mcpx-ui-garza.fly.dev",
        ).split(",")
        if origin.strip()
    ]
    if not origins:
        origins = ["*"]

    original_sse_app = FastMCP.sse_app

    def sse_app_with_cors(self, *args, **kwargs):
        app = original_sse_app(self, *args, **kwargs)
        return CORSMiddleware(
            app,
            allow_origins=origins,
            allow_methods=["GET", "POST", "OPTIONS"],
            allow_headers=["*"],
            allow_credentials=False,
        )

    FastMCP.sse_app = sse_app_with_cors
    FastMCP._garza_cors_patched = True


_patch_fastmcp_cors()
