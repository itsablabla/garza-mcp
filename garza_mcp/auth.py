"""Bearer token authentication middleware for Garza MCP Server."""

from __future__ import annotations

import logging
from collections.abc import Callable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from garza_mcp.config import AUTH_TOKEN

logger = logging.getLogger("garza-mcp.auth")

# Paths that don't require authentication
PUBLIC_PATHS = {"/health", "/healthz", "/ready"}


class BearerAuthMiddleware(BaseHTTPMiddleware):
    """Validates Bearer token on all MCP requests."""

    async def dispatch(self, request: Request, call_next: Callable[..., Response]) -> Response:
        path = request.url.path

        # Skip auth for health checks and OPTIONS (CORS preflight)
        if path in PUBLIC_PATHS or request.method == "OPTIONS":
            return await call_next(request)

        # Validate Authorization header
        auth_header = request.headers.get("authorization", "")
        if not auth_header.startswith("Bearer "):
            logger.warning("Missing Bearer token from %s", request.client.host if request.client else "unknown")
            return JSONResponse(
                status_code=401,
                content={"error": "Missing or invalid Authorization header. Use: Bearer <token>"},
            )

        token = auth_header[7:]  # Strip "Bearer "
        if token != AUTH_TOKEN:
            logger.warning("Invalid token from %s", request.client.host if request.client else "unknown")
            return JSONResponse(
                status_code=403,
                content={"error": "Invalid authentication token"},
            )

        return await call_next(request)
