"""Shell-based file operations for FUSE mounts (Proton Drive / iCloud Drive).

Avoids Python's os.stat() which can hang on CloudStorage FUSE mounts.
All operations use async subprocess shell commands with timeouts.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shlex
from typing import Any

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 30


def _format_bytes(n: int) -> str:
    if n == 0:
        return "0 B"
    k = 1024
    sizes = ["B", "KB", "MB", "GB", "TB"]
    i = 0
    val = float(n)
    while val >= k and i < len(sizes) - 1:
        val /= k
        i += 1
    return f"{val:.2f} {sizes[i]}"


class DriveService:
    """Async shell-based file operations for a FUSE mount directory."""

    def __init__(self, base_path: str, timeout: int = DEFAULT_TIMEOUT) -> None:
        self.base_path = base_path
        self.timeout = timeout

    def _resolve(self, path: str) -> str:
        """Resolve a relative path against base_path, preventing traversal."""
        if not path or path == "/":
            return self.base_path
        clean = os.path.normpath(path).lstrip("/")
        full = os.path.normpath(os.path.join(self.base_path, clean))
        norm_base = os.path.normpath(self.base_path)
        if full != norm_base and not full.startswith(norm_base + os.sep):
            raise ValueError(f"Path traversal detected: {path}")
        return full

    async def _run(self, cmd: str, timeout: int | None = None) -> str:
        """Run a shell command with timeout, return stdout."""
        t = timeout or self.timeout
        proc = await asyncio.create_subprocess_shell(
            cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=t)
        except asyncio.TimeoutError:
            proc.kill()
            raise TimeoutError(f"Command timed out after {t}s: {cmd[:80]}")
        if proc.returncode != 0:
            err = stderr.decode().strip() if stderr else ""
            # Some commands return non-zero but still produce output
            if stdout:
                return stdout.decode().strip()
            raise RuntimeError(f"Command failed (rc={proc.returncode}): {err}")
        return stdout.decode().strip()

    async def list_files(self, path: str = "/") -> list[dict[str, Any]]:
        """List files using shell glob to avoid stat() hangs on FUSE."""
        target = self._resolve(path)
        # Shell glob loop avoids stat() on every entry
        cmd = f'''cd {shlex.quote(target)} 2>/dev/null && for f in * .*; do
            [ "$f" = "." ] || [ "$f" = ".." ] || [ "$f" = "*" ] || [ "$f" = ".*" ] && continue
            if [ -d "$f" 2>/dev/null ]; then echo "[dir] $f"
            else echo "[file] $f"; fi
        done'''
        try:
            output = await self._run(cmd)
        except Exception:
            # Fallback to ls
            output = await self._run(f'ls -1Ap {shlex.quote(target)} 2>/dev/null || echo ""')

        items: list[dict[str, Any]] = []
        for line in output.splitlines():
            line = line.strip()
            if not line:
                continue
            if line.startswith("[dir] "):
                items.append({"name": line[6:], "type": "directory", "path": os.path.join(path, line[6:])})
            elif line.startswith("[file] "):
                items.append({"name": line[7:], "type": "file", "path": os.path.join(path, line[7:])})
            elif line.endswith("/"):
                name = line.rstrip("/")
                items.append({"name": name, "type": "directory", "path": os.path.join(path, name)})
            else:
                items.append({"name": line, "type": "file", "path": os.path.join(path, line)})
        return items

    async def read_file(self, path: str) -> str:
        """Read file contents via cat with timeout."""
        target = self._resolve(path)
        return await self._run(f'cat {shlex.quote(target)}', timeout=15)

    async def write_file(self, path: str, content: str) -> dict[str, str]:
        """Write content to a file."""
        target = self._resolve(path)
        # Use printf to handle special characters
        escaped = content.replace("'", "'\\''")
        await self._run(f"printf '%s' '{escaped}' > {shlex.quote(target)}")
        return {"path": path, "status": "written"}

    async def create_folder(self, path: str) -> dict[str, str]:
        target = self._resolve(path)
        await self._run(f'mkdir -p {shlex.quote(target)}')
        return {"path": path, "status": "created"}

    async def delete_item(self, path: str) -> dict[str, str]:
        target = self._resolve(path)
        await self._run(f'rm -rf {shlex.quote(target)}')
        return {"deleted": path}

    async def move_item(self, source: str, destination: str) -> dict[str, str]:
        src = self._resolve(source)
        dst = self._resolve(destination)
        await self._run(f'mv {shlex.quote(src)} {shlex.quote(dst)}')
        return {"from": source, "to": destination}

    async def get_file_info(self, path: str) -> dict[str, Any]:
        """Get file info using stat command (macOS compatible)."""
        target = self._resolve(path)
        # macOS stat format: -f with format string
        output = await self._run(
            f'stat -f "%N|%z|%Sm|%Sb|%HT" {shlex.quote(target)}',
            timeout=10,
        )
        parts = output.split("|")
        name = os.path.basename(parts[0]) if parts else os.path.basename(path)
        size = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
        return {
            "name": name,
            "type": "directory" if "directory" in output.lower() or "Directory" in output else "file",
            "mimeType": "inode/directory" if "directory" in output.lower() else "application/octet-stream",
            "size": size,
            "sizeFormatted": _format_bytes(size),
            "modified": parts[2] if len(parts) > 2 else "unknown",
            "created": parts[3] if len(parts) > 3 else "unknown",
        }

    async def search_files(self, query: str, path: str = "/") -> list[dict[str, Any]]:
        """Search for files using find with maxdepth to avoid timeouts."""
        target = self._resolve(path)
        safe_query = shlex.quote(f"*{query}*")
        output = await self._run(f'find {shlex.quote(target)} -maxdepth 3 -iname {safe_query} 2>/dev/null | head -100', timeout=30)
        results: list[dict[str, Any]] = []
        for line in output.splitlines():
            line = line.strip()
            if not line:
                continue
            rel = os.path.relpath(line, self.base_path)
            is_dir = line.endswith("/")
            results.append({
                "name": os.path.basename(line),
                "path": f"/{rel}",
                "type": "directory" if is_dir else "file",
            })
        return results

    async def get_drive_stats(self) -> dict[str, Any]:
        """Get drive stats with limited depth to avoid timeouts."""
        # Count files and dirs separately with maxdepth
        files_output = await self._run(
            f'find {shlex.quote(self.base_path)} -maxdepth 2 -type f 2>/dev/null | wc -l', timeout=60
        )
        dirs_output = await self._run(
            f'find {shlex.quote(self.base_path)} -maxdepth 2 -type d 2>/dev/null | wc -l', timeout=60
        )
        size_output = await self._run(
            f'du -sk {shlex.quote(self.base_path)} 2>/dev/null | cut -f1', timeout=60
        )

        total_files = int(files_output.strip()) if files_output.strip().isdigit() else 0
        total_folders = int(dirs_output.strip()) if dirs_output.strip().isdigit() else 0
        size_kb = int(size_output.strip()) if size_output.strip().isdigit() else 0

        return {
            "totalFiles": total_files,
            "totalFolders": total_folders,
            "totalSize": size_kb * 1024,
            "totalSizeFormatted": _format_bytes(size_kb * 1024),
        }
