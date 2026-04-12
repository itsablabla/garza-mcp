import path from 'node:path';
import { exec, execSync } from 'node:child_process';
import { DriveItem } from '../types/index.js';
import { formatBytes } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';
import mime from 'mime-types';

// Shell-only drive service — avoids Node fs.*Sync calls which can hang
// on macOS CloudStorage / FUSE mounts when running from a LaunchAgent.

function sh(cmd: string, timeout = 30000): string {
  return execSync(cmd, { encoding: 'utf-8', timeout, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function shAsync(cmd: string, timeout = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = exec(cmd, { encoding: 'utf-8', timeout }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

export class DriveService {
  private basePath: string;
  private label: string;

  constructor(basePath: string, label: string = 'Drive') {
    this.basePath = basePath;
    this.label = label;
    // Don't use fs.existsSync — it can hang on CloudStorage mounts from LaunchAgent
    try {
      sh(`test -d "${basePath}" && echo ok`, 5000);
      logger.info(`${label} service initialized at: ${basePath}`, 'DriveService');
    } catch {
      logger.info(`${label} path may not be available yet: ${basePath}`, 'DriveService');
    }
  }

  private resolvePath(relativePath: string): string {
    const cleaned = relativePath.replace(/^\/+/, '').replace(/\.\.+/g, '');
    const resolved = cleaned ? path.join(this.basePath, cleaned) : this.basePath;
    if (!resolved.startsWith(this.basePath)) {
      throw new Error('Path traversal detected — access denied');
    }
    return resolved;
  }

  async listFiles(dirPath: string = '/'): Promise<DriveItem[]> {
    const fullPath = this.resolvePath(dirPath);

    // Use ls -1Ap via shell (no -L to avoid symlink following on FUSE mounts)
    const output = await shAsync(`ls -1Ap "${fullPath}" 2>/dev/null`);
    if (!output) return [];

    const lines = output.split('\n').filter(Boolean);
    const items: DriveItem[] = [];

    for (const line of lines) {
      const name = line.endsWith('/') ? line.slice(0, -1) : line;
      if (name.startsWith('.')) continue;
      const isDir = line.endsWith('/');
      const entryPath = path.join(fullPath, name);

      items.push({
        name,
        path: path.relative(this.basePath, entryPath),
        type: isDir ? 'directory' : 'file',
        size: 0,
        modified: '',
        created: '',
      });
    }

    return items.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  async readFile(filePath: string): Promise<{ content: string; mimeType: string; size: number }> {
    const fullPath = this.resolvePath(filePath);
    const mimeType = mime.lookup(fullPath) || 'application/octet-stream';
    const MAX_SIZE = 1024 * 1024;

    // Use cat with timeout to avoid hanging on CloudStorage files not yet downloaded
    const isText = mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml' || mimeType === 'application/javascript' || fullPath.endsWith('.txt') || fullPath.endsWith('.md') || fullPath.endsWith('.json') || fullPath.endsWith('.csv');

    try {
      if (isText) {
        const content = await shAsync(`cat "${fullPath}" 2>/dev/null | head -c ${MAX_SIZE}`, 15000);
        return { content, mimeType: mimeType || 'text/plain', size: Buffer.byteLength(content) };
      }
      // Binary: try to get size first, then base64 if small
      const sizeStr = await shAsync(`wc -c < "${fullPath}" 2>/dev/null`, 10000);
      const size = parseInt(sizeStr, 10) || 0;
      if (size > MAX_SIZE) {
        return { content: `[Binary file too large: ${formatBytes(size)}. Use info tool for metadata.]`, mimeType, size };
      }
      const content = await shAsync(`base64 "${fullPath}" 2>/dev/null`, 15000);
      return { content: `[base64] ${content}`, mimeType, size };
    } catch (e: any) {
      throw new Error(`Failed to read file (may need cloud download): ${filePath} — ${e.message}`);
    }
  }

  async writeFile(filePath: string, content: string): Promise<{ path: string; size: number }> {
    const fullPath = this.resolvePath(filePath);
    const dir = path.dirname(fullPath);
    await shAsync(`mkdir -p "${dir}"`);
    // Write content via heredoc to handle special chars
    const escaped = content.replace(/'/g, "'\\''");
    await shAsync(`printf '%s' '${escaped}' > "${fullPath}"`);
    const sizeStr = await shAsync(`stat -f '%z' "${fullPath}" 2>/dev/null || echo '0'`);
    const size = parseInt(sizeStr, 10) || 0;
    logger.info(`File written: ${filePath} (${formatBytes(size)})`, 'DriveService');
    return { path: filePath, size };
  }

  async createFolder(folderPath: string): Promise<{ path: string }> {
    const fullPath = this.resolvePath(folderPath);
    const exists = await shAsync(`test -d "${fullPath}" && echo yes || echo no`);
    if (exists === 'yes') throw new Error(`Folder already exists: ${folderPath}`);
    await shAsync(`mkdir -p "${fullPath}"`);
    logger.info(`Folder created: ${folderPath}`, 'DriveService');
    return { path: folderPath };
  }

  async deleteItem(itemPath: string): Promise<{ deleted: string }> {
    const fullPath = this.resolvePath(itemPath);
    const exists = await shAsync(`test -e "${fullPath}" && echo yes || echo no`);
    if (exists !== 'yes') throw new Error(`Item not found: ${itemPath}`);
    await shAsync(`rm -rf "${fullPath}"`);
    logger.info(`Deleted: ${itemPath}`, 'DriveService');
    return { deleted: itemPath };
  }

  async moveItem(sourcePath: string, destPath: string): Promise<{ from: string; to: string }> {
    const fullSource = this.resolvePath(sourcePath);
    const fullDest = this.resolvePath(destPath);
    const exists = await shAsync(`test -e "${fullSource}" && echo yes || echo no`);
    if (exists !== 'yes') throw new Error(`Source not found: ${sourcePath}`);
    const destDir = path.dirname(fullDest);
    await shAsync(`mkdir -p "${destDir}" && mv "${fullSource}" "${fullDest}"`);
    logger.info(`Moved: ${sourcePath} -> ${destPath}`, 'DriveService');
    return { from: sourcePath, to: destPath };
  }

  async getFileInfo(filePath: string): Promise<DriveItem & { mimeType: string; sizeFormatted: string }> {
    const fullPath = this.resolvePath(filePath);
    // Use stat command — macOS stat format
    const info = await shAsync(`stat -f '%z|%m|%B' "${fullPath}" 2>/dev/null || echo 'NOT_FOUND'`);
    if (info === 'NOT_FOUND') throw new Error(`Item not found: ${filePath}`);

    const [sizeStr, mtimeStr, ctimeStr] = info.split('|');
    const size = parseInt(sizeStr, 10) || 0;
    const modified = new Date(parseInt(mtimeStr, 10) * 1000).toISOString();
    const created = new Date(parseInt(ctimeStr, 10) * 1000).toISOString();
    const isDir = (await shAsync(`test -d "${fullPath}" && echo yes || echo no`)) === 'yes';
    const mimeType = isDir ? 'directory' : (mime.lookup(fullPath) || 'application/octet-stream');

    return {
      name: path.basename(fullPath),
      path: path.relative(this.basePath, fullPath),
      type: isDir ? 'directory' : 'file',
      size,
      sizeFormatted: formatBytes(size),
      modified,
      created,
      mimeType,
    };
  }

  async searchFiles(query: string, dirPath: string = '/'): Promise<DriveItem[]> {
    const fullPath = this.resolvePath(dirPath);
    const safeQuery = query.replace(/["`$\\]/g, '');

    try {
      const output = await shAsync(
        `find "${fullPath}" -maxdepth 3 -iname "*${safeQuery}*" -not -name '.*' 2>/dev/null | head -100`,
        30000
      );
      if (!output) return [];

      const lines = output.split('\n').filter(Boolean);
      return lines.map(line => {
        const name = path.basename(line);
        return {
          name,
          path: path.relative(this.basePath, line),
          type: 'file' as const, // we don't check — keeps it fast
          size: 0,
          modified: '',
          created: '',
        };
      });
    } catch {
      return [];
    }
  }

  async getDriveStats(): Promise<{ totalFiles: number; totalFolders: number; totalSize: number; totalSizeFormatted: string }> {
    try {
      // Use -maxdepth 2 to avoid timeouts on large CloudStorage trees
      const [countOut, dirOut, sizeOut] = await Promise.all([
        shAsync(`find "${this.basePath}" -maxdepth 2 -not -name '.*' -not -path '*/.*' 2>/dev/null | wc -l`, 15000),
        shAsync(`find "${this.basePath}" -maxdepth 2 -type d -not -name '.*' -not -path '*/.*' 2>/dev/null | wc -l`, 15000),
        shAsync(`du -sk "${this.basePath}" 2>/dev/null | awk '{print $1}'`, 15000),
      ]);

      const totalItems = parseInt(countOut, 10) || 0;
      const totalFolders = Math.max(0, (parseInt(dirOut, 10) || 0) - 1);
      const totalFiles = Math.max(0, totalItems - totalFolders - 1);
      const totalSize = (parseInt(sizeOut, 10) || 0) * 1024;

      return { totalFiles, totalFolders, totalSize, totalSizeFormatted: formatBytes(totalSize) };
    } catch {
      return { totalFiles: 0, totalFolders: 0, totalSize: 0, totalSizeFormatted: '0 B' };
    }
  }
}
