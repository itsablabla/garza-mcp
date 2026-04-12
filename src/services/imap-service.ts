import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { ProtonMailConfig, EmailMessage } from '../types/index.js';
import { logger } from '../utils/logger.js';

// ── Timeouts tuned for Proton Bridge with a 736 GB mailbox ──────────────────
// Proton Bridge syncs the entire mailbox locally; during initial sync or after
// a restart, IMAP operations can block for a long time.  We use generous
// timeouts so that tools return a useful error instead of silently hanging.

/** Default per-operation timeout (60 s). */
const OP_TIMEOUT = 60_000;

/** Timeout for the initial IMAP SEARCH command (server-side) — can be slow
 *  on Proton Bridge while it indexes. */
const SEARCH_TIMEOUT = 90_000;

/** Timeout for fetching message envelopes (batch). */
const FETCH_TIMEOUT = 60_000;

/** Maximum number of retries for transient connection failures. */
const MAX_RETRIES = 2;

/** Delay between retries (ms). */
const RETRY_DELAY = 2_000;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Race a promise against a timeout */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `IMAP operation '${label}' timed out after ${ms / 1000}s — ` +
              `Proton Bridge may still be syncing the 736 GB mailbox. ` +
              `Try again in a few minutes or check bridge status.`,
            ),
          ),
        ms,
      ),
    ),
  ]);
}

/** Sleep helper for retries. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Service ──────────────────────────────────────────────────────────────────

export class IMAPService {
  private client: ImapFlow | null = null;
  private config: ProtonMailConfig;
  private connected = false;
  /** Prevents concurrent connect() calls. */
  private connecting: Promise<void> | null = null;

  constructor(config: ProtonMailConfig) {
    this.config = config;
  }

  // ── Connection management ────────────────────────────────────────────────

  async connect(): Promise<void> {
    // Deduplicate concurrent connect() calls
    if (this.connecting) return this.connecting;

    this.connecting = this._doConnect();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async _doConnect(): Promise<void> {
    // Tear down any stale client first
    if (this.client) {
      try { this.client.close(); } catch { /* ignore */ }
      this.client = null;
      this.connected = false;
    }

    this.client = new ImapFlow({
      host: this.config.imap.host,
      port: this.config.imap.port,
      secure: false,
      // Proton Bridge on localhost: STARTTLS negotiation hangs — use plain IMAP
      disableAutoIdle: true,
      auth: {
        user: this.config.imap.username,
        pass: this.config.imap.password,
      },
      logger: false,
      tls: { rejectUnauthorized: false },
      // Generous greeting/socket timeouts for Proton Bridge during sync
      greetingTimeout: 30_000,
      socketTimeout: 60_000,
    });

    // Listen for unexpected disconnects so we can reconnect transparently
    this.client.on('close', () => {
      logger.warn('IMAP connection closed unexpectedly', 'IMAPService');
      this.connected = false;
    });
    this.client.on('error', (err: Error) => {
      logger.error(`IMAP error: ${err.message}`, 'IMAPService');
      this.connected = false;
    });

    try {
      await withTimeout(this.client.connect(), 30_000, 'connect');
      this.connected = true;
      logger.info('IMAP connected', 'IMAPService');
    } catch (e) {
      this.client = null;
      this.connected = false;
      throw e;
    }
  }

  isConnected(): boolean {
    return this.connected && this.client !== null;
  }

  async ensureConnected(): Promise<void> {
    if (!this.connected || !this.client) {
      await this.connect();
    }
  }

  /** Wrap an IMAP operation with automatic reconnect on failure. */
  private async withReconnect<T>(label: string, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.ensureConnected();
        return await fn();
      } catch (e: any) {
        const isTransient =
          /closed|reset|timeout|ECONNR|socket/i.test(e.message || '');
        if (isTransient && attempt < MAX_RETRIES) {
          logger.warn(
            `IMAP transient error (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${e.message} — reconnecting...`,
            'IMAPService',
          );
          this.connected = false;
          await sleep(RETRY_DELAY * (attempt + 1));
          continue;
        }
        throw e;
      }
    }
    // Unreachable, but satisfies the compiler
    throw new Error(`IMAP operation '${label}' failed after ${MAX_RETRIES + 1} attempts`);
  }

  // ── Public API ───────────────────────────────────────────────────────────

  async getEmails(
    folder: string = 'INBOX',
    limit: number = 20,
    offset: number = 0,
  ): Promise<EmailMessage[]> {
    return this.withReconnect('getEmails', async () => {
      if (!this.client) throw new Error('IMAP not connected');

      const lock = await withTimeout(
        this.client.getMailboxLock(folder),
        OP_TIMEOUT,
        'getMailboxLock',
      );
      try {
        const status = await withTimeout(
          this.client.status(folder, { messages: true }),
          OP_TIMEOUT,
          'status',
        );
        const total = status.messages || 0;
        if (total === 0) return [];

        const start = Math.max(1, total - offset - limit + 1);
        const end = Math.max(1, total - offset);
        const range = `${start}:${end}`;

        const messages: EmailMessage[] = [];
        const fetchPromise = (async () => {
          for await (const msg of this.client!.fetch(range, {
            envelope: true,
            flags: true,
            bodyStructure: true,
            source: false,
          })) {
            const email: EmailMessage = {
              id: String(msg.uid || msg.seq),
              messageId: msg.envelope?.messageId,
              subject: msg.envelope?.subject || '(no subject)',
              from: msg.envelope?.from?.[0]
                ? `${msg.envelope.from[0].name || ''} <${msg.envelope.from[0].address || ''}>`.trim()
                : 'unknown',
              to: (msg.envelope?.to || []).map((a: any) => a.address || ''),
              date: msg.envelope?.date || new Date(),
              body: '',
              folder,
              read: msg.flags?.has('\\Seen') || false,
              starred: msg.flags?.has('\\Flagged') || false,
            };
            messages.push(email);
          }
        })();
        await withTimeout(fetchPromise, FETCH_TIMEOUT, 'fetch');
        return messages.reverse();
      } finally {
        lock.release();
      }
    });
  }

  async getEmailById(
    emailId: string,
    folder: string = 'INBOX',
  ): Promise<EmailMessage | null> {
    return this.withReconnect('getEmailById', async () => {
      if (!this.client) throw new Error('IMAP not connected');

      const lock = await withTimeout(
        this.client.getMailboxLock(folder),
        OP_TIMEOUT,
        'getMailboxLock',
      );
      try {
        const uid = parseInt(emailId, 10);
        const msg = await withTimeout(
          this.client.fetchOne(
            String(uid),
            { envelope: true, flags: true, source: true },
            { uid: true },
          ),
          FETCH_TIMEOUT,
          'fetchOne',
        );
        if (!msg) return null;

        let body = '';
        if (msg.source) {
          const parsed = await simpleParser(msg.source);
          body = parsed.text || parsed.html || '';
        }

        return {
          id: emailId,
          messageId: msg.envelope?.messageId,
          subject: msg.envelope?.subject || '(no subject)',
          from: msg.envelope?.from?.[0]
            ? `${msg.envelope.from[0].name || ''} <${msg.envelope.from[0].address || ''}>`.trim()
            : 'unknown',
          to: (msg.envelope?.to || []).map((a: any) => a.address || ''),
          date: msg.envelope?.date || new Date(),
          body,
          folder,
          read: msg.flags?.has('\\Seen') || false,
          starred: msg.flags?.has('\\Flagged') || false,
        };
      } finally {
        lock.release();
      }
    });
  }

  /**
   * Search emails using **server-side IMAP SEARCH** instead of downloading
   * every envelope.  This is critical for the 736 GB mailbox — the old
   * approach of fetching `1:*` and filtering locally would time out or OOM.
   *
   * ImapFlow's `client.search()` translates our criteria into a native IMAP
   * SEARCH command that runs on Proton Bridge, returning only matching UIDs.
   * We then fetch envelopes only for those UIDs.
   */
  async searchEmails(
    query: string,
    folder: string = 'INBOX',
    limit: number = 20,
  ): Promise<EmailMessage[]> {
    return this.withReconnect('searchEmails', async () => {
      if (!this.client) throw new Error('IMAP not connected');

      const lock = await withTimeout(
        this.client.getMailboxLock(folder),
        OP_TIMEOUT,
        'getMailboxLock',
      );
      try {
        // Use IMAP SEARCH with OR (subject, from) — runs on the server
        const searchCriteria = {
          or: [
            { subject: query },
            { from: query },
          ],
        };

        let uids: number[];
        try {
          uids = await withTimeout(
            this.client.search(searchCriteria, { uid: true }) as Promise<number[]>,
            SEARCH_TIMEOUT,
            'search',
          );
        } catch (searchErr: any) {
          // Proton Bridge may not support OR search — fall back to subject-only
          logger.warn(
            `IMAP SEARCH with OR failed (${searchErr.message}), falling back to subject-only search`,
            'IMAPService',
          );
          uids = await withTimeout(
            this.client.search({ subject: query }, { uid: true }) as Promise<number[]>,
            SEARCH_TIMEOUT,
            'search-fallback',
          );
        }

        if (!uids.length) return [];

        // Take the most recent `limit` UIDs (highest UIDs = newest)
        const sorted = uids.sort((a, b) => b - a).slice(0, limit);
        const uidSet = sorted.join(',');

        const results: EmailMessage[] = [];
        const fetchPromise = (async () => {
          for await (const msg of this.client!.fetch(uidSet, {
            envelope: true,
            flags: true,
          }, { uid: true })) {
            results.push({
              id: String(msg.uid || msg.seq),
              subject: msg.envelope?.subject || '(no subject)',
              from: msg.envelope?.from?.[0]
                ? `${msg.envelope.from[0].name || ''} <${msg.envelope.from[0].address || ''}>`.trim()
                : 'unknown',
              to: (msg.envelope?.to || []).map((a: any) => a.address || ''),
              date: msg.envelope?.date || new Date(),
              body: '',
              folder,
              read: msg.flags?.has('\\Seen') || false,
              starred: msg.flags?.has('\\Flagged') || false,
            });
          }
        })();
        await withTimeout(fetchPromise, FETCH_TIMEOUT, 'search-fetch');

        // Sort newest-first
        return results.sort((a, b) => {
          const da = a.date instanceof Date ? a.date.getTime() : new Date(a.date).getTime();
          const db = b.date instanceof Date ? b.date.getTime() : new Date(b.date).getTime();
          return db - da;
        });
      } finally {
        lock.release();
      }
    });
  }

  async getFolders(): Promise<Array<{ name: string; path: string }>> {
    return this.withReconnect('getFolders', async () => {
      if (!this.client) throw new Error('IMAP not connected');

      const list = await withTimeout(this.client.list(), OP_TIMEOUT, 'list');
      const folders: Array<{ name: string; path: string }> = [];
      for (const item of list) {
        folders.push({ name: item.name, path: item.path });
      }
      return folders;
    });
  }

  async markEmailRead(
    emailId: string,
    isRead: boolean,
    folder: string = 'INBOX',
  ): Promise<void> {
    return this.withReconnect('markEmailRead', async () => {
      if (!this.client) throw new Error('IMAP not connected');

      const lock = await withTimeout(
        this.client.getMailboxLock(folder),
        OP_TIMEOUT,
        'getMailboxLock',
      );
      try {
        const uid = parseInt(emailId, 10);
        if (isRead) {
          await withTimeout(
            this.client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }),
            OP_TIMEOUT,
            'flagsAdd',
          );
        } else {
          await withTimeout(
            this.client.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true }),
            OP_TIMEOUT,
            'flagsRemove',
          );
        }
      } finally {
        lock.release();
      }
    });
  }

  async starEmail(
    emailId: string,
    isStarred: boolean,
    folder: string = 'INBOX',
  ): Promise<void> {
    return this.withReconnect('starEmail', async () => {
      if (!this.client) throw new Error('IMAP not connected');

      const lock = await withTimeout(
        this.client.getMailboxLock(folder),
        OP_TIMEOUT,
        'getMailboxLock',
      );
      try {
        const uid = parseInt(emailId, 10);
        if (isStarred) {
          await withTimeout(
            this.client.messageFlagsAdd(String(uid), ['\\Flagged'], { uid: true }),
            OP_TIMEOUT,
            'flagsAdd',
          );
        } else {
          await withTimeout(
            this.client.messageFlagsRemove(String(uid), ['\\Flagged'], { uid: true }),
            OP_TIMEOUT,
            'flagsRemove',
          );
        }
      } finally {
        lock.release();
      }
    });
  }

  async moveEmail(
    emailId: string,
    targetFolder: string,
    folder: string = 'INBOX',
  ): Promise<void> {
    return this.withReconnect('moveEmail', async () => {
      if (!this.client) throw new Error('IMAP not connected');

      const lock = await withTimeout(
        this.client.getMailboxLock(folder),
        OP_TIMEOUT,
        'getMailboxLock',
      );
      try {
        const uid = parseInt(emailId, 10);
        await withTimeout(
          this.client.messageMove(String(uid), targetFolder, { uid: true }),
          OP_TIMEOUT,
          'messageMove',
        );
      } finally {
        lock.release();
      }
    });
  }

  async deleteEmail(emailId: string, folder: string = 'INBOX'): Promise<void> {
    return this.withReconnect('deleteEmail', async () => {
      if (!this.client) throw new Error('IMAP not connected');

      const lock = await withTimeout(
        this.client.getMailboxLock(folder),
        OP_TIMEOUT,
        'getMailboxLock',
      );
      try {
        const uid = parseInt(emailId, 10);
        await withTimeout(
          this.client.messageFlagsAdd(String(uid), ['\\Deleted'], { uid: true }),
          OP_TIMEOUT,
          'flagsAdd',
        );
        await withTimeout(
          this.client.messageDelete(String(uid), { uid: true }),
          OP_TIMEOUT,
          'messageDelete',
        );
      } finally {
        lock.release();
      }
    });
  }

  async getStats(
    folder: string = 'INBOX',
  ): Promise<{ totalEmails: number; unreadEmails: number; folders: number }> {
    return this.withReconnect('getStats', async () => {
      if (!this.client) throw new Error('IMAP not connected');

      const status = await withTimeout(
        this.client.status(folder, { messages: true, unseen: true }),
        OP_TIMEOUT,
        'status',
      );
      const folders = await withTimeout(
        this.client.list(),
        OP_TIMEOUT,
        'list',
      );
      return {
        totalEmails: status.messages || 0,
        unreadEmails: status.unseen || 0,
        folders: folders.length,
      };
    });
  }

  /** Graceful shutdown */
  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.logout();
      } catch { /* ignore */ }
      this.client = null;
      this.connected = false;
      logger.info('IMAP disconnected', 'IMAPService');
    }
  }
}
