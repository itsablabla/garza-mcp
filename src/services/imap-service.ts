import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { ProtonMailConfig, EmailMessage } from '../types/index.js';
import { logger } from '../utils/logger.js';

// ── Timeouts tuned for Proton Bridge with a 736GB mailbox ───────────────────
// Proton Bridge syncs the entire mailbox locally; during initial sync or after
// a restart, IMAP operations can block for a long time.

/** Timeout for establishing the IMAP connection. */
const CONNECT_TIMEOUT = 20_000;

/** Timeout for lightweight ops (status, list folders, flag changes). */
const LIGHT_TIMEOUT = 30_000;

/** Timeout for heavy ops (fetch envelopes, read full messages). */
const HEAVY_TIMEOUT = 60_000;

/** Timeout for server-side IMAP SEARCH (can be slow while Bridge indexes). */
const SEARCH_TIMEOUT = 90_000;

/** Timeout to acquire a mailbox lock. */
const LOCK_TIMEOUT = 30_000;

/** Seconds of idle before we probe the connection with NOOP. */
const STALE_THRESHOLD_MS = 60_000;

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Race a promise against a timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `IMAP operation '${label}' timed out after ${ms / 1000}s — ` +
              `Proton Bridge may still be syncing. Try again in a few minutes.`,
            ),
          ),
        ms,
      ),
    ),
  ]);
}

/** Sleep helper for retry back-off. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Service ─────────────────────────────────────────────────────────────────

export class IMAPService {
  private client: ImapFlow | null = null;
  private config: ProtonMailConfig;
  private connected = false;
  private lastActivity = 0;

  constructor(config: ProtonMailConfig) {
    this.config = config;
  }

  // ── Connection management ───────────────────────────────────────────────

  private createClient(): ImapFlow {
    return new ImapFlow({
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
      greetingTimeout: 20_000,
      socketTimeout: 30_000,
    });
  }

  async connect(): Promise<void> {
    // Clean up any stale client first
    if (this.client) {
      try { this.client.close(); } catch { /* ignore */ }
      this.client = null;
      this.connected = false;
    }

    this.client = this.createClient();

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
      await withTimeout(this.client.connect(), CONNECT_TIMEOUT, 'connect');
      this.connected = true;
      this.lastActivity = Date.now();
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

  /** Ensure we have a live IMAP connection, reconnecting if stale or dead. */
  async ensureConnected(): Promise<void> {
    if (this.connected && this.client) {
      // Probe with NOOP if connection has been idle too long
      const staleMs = Date.now() - this.lastActivity;
      if (staleMs > STALE_THRESHOLD_MS) {
        try {
          await withTimeout(this.client.noop(), 5_000, 'noop-keepalive');
          this.lastActivity = Date.now();
          return;
        } catch {
          logger.warn('IMAP connection stale, reconnecting...', 'IMAPService');
          this.connected = false;
          try { this.client.close(); } catch { /* ignore */ }
          this.client = null;
        }
      } else {
        return;
      }
    }
    await this.connect();
  }

  /** Clean disconnect for graceful shutdown. */
  async disconnect(): Promise<void> {
    if (this.client) {
      try { await this.client.logout(); } catch { /* ignore */ }
      try { this.client.close(); } catch { /* ignore */ }
      this.client = null;
      this.connected = false;
      logger.info('IMAP disconnected', 'IMAPService');
    }
  }

  /** Wrap an IMAP operation with automatic reconnect on transient failure. */
  private async withReconnect<T>(label: string, fn: () => Promise<T>): Promise<T> {
    try {
      await this.ensureConnected();
      return await fn();
    } catch (e: any) {
      const msg = e?.message || '';
      const isTransient =
        /closed|reset|timeout|ECONNR|socket|not connected/i.test(msg);
      if (isTransient) {
        logger.warn(
          `IMAP ${label} failed (${msg.slice(0, 80)}), reconnecting...`,
          'IMAPService',
        );
        this.connected = false;
        try { this.client?.close(); } catch { /* ignore */ }
        this.client = null;
        await sleep(1_000);
        await this.connect();
        return await fn();
      }
      throw e;
    }
  }

  // ── Mail operations ─────────────────────────────────────────────────────

  async getEmails(folder: string = 'INBOX', limit: number = 20, offset: number = 0): Promise<EmailMessage[]> {
    return this.withReconnect('getEmails', async () => {
      if (!this.client) throw new Error('IMAP not connected');

      const lock = await withTimeout(this.client.getMailboxLock(folder), LOCK_TIMEOUT, 'getMailboxLock');
      try {
        const status = await withTimeout(this.client.status(folder, { messages: true }), LIGHT_TIMEOUT, 'status');
        const total = status.messages || 0;
        if (total === 0) return [];

        const start = Math.max(1, total - offset - limit + 1);
        const end = Math.max(1, total - offset);
        const range = `${start}:${end}`;

        const messages: EmailMessage[] = [];
        const fetchPromise = (async () => {
          for await (const msg of this.client!.fetch(range, { envelope: true, flags: true, bodyStructure: true, source: false })) {
            const email: EmailMessage = {
              id: String(msg.uid || msg.seq),
              messageId: msg.envelope?.messageId,
              subject: msg.envelope?.subject || '(no subject)',
              from: msg.envelope?.from?.[0] ? `${msg.envelope.from[0].name || ''} <${msg.envelope.from[0].address || ''}>`.trim() : 'unknown',
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
        await withTimeout(fetchPromise, HEAVY_TIMEOUT, 'fetch');
        this.lastActivity = Date.now();
        return messages.reverse();
      } finally {
        lock.release();
      }
    });
  }

  async getEmailById(emailId: string, folder: string = 'INBOX'): Promise<EmailMessage | null> {
    return this.withReconnect('getEmailById', async () => {
      if (!this.client) throw new Error('IMAP not connected');

      const lock = await withTimeout(this.client.getMailboxLock(folder), LOCK_TIMEOUT, 'getMailboxLock');
      try {
        const uid = parseInt(emailId, 10);
        const msg = await withTimeout(
          this.client.fetchOne(String(uid), { envelope: true, flags: true, source: true }, { uid: true }),
          HEAVY_TIMEOUT, 'fetchOne'
        );
        if (!msg) return null;

        let body = '';
        if (msg.source) {
          const parsed = await simpleParser(msg.source);
          body = parsed.text || parsed.html || '';
        }

        this.lastActivity = Date.now();
        return {
          id: emailId,
          messageId: msg.envelope?.messageId,
          subject: msg.envelope?.subject || '(no subject)',
          from: msg.envelope?.from?.[0] ? `${msg.envelope.from[0].name || ''} <${msg.envelope.from[0].address || ''}>`.trim() : 'unknown',
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

  async searchEmails(query: string, folder: string = 'INBOX', limit: number = 20): Promise<EmailMessage[]> {
    return this.withReconnect('searchEmails', async () => {
      if (!this.client) throw new Error('IMAP not connected');

      const lock = await withTimeout(this.client.getMailboxLock(folder), LOCK_TIMEOUT, 'getMailboxLock');
      try {
        // Use server-side IMAP SEARCH instead of fetching all messages client-side.
        // This is critical for the 736GB mailbox — client-side scan would never finish.
        let uids: number[] = [];
        try {
          // Try OR(SUBJECT, FROM) search first
          const searchResult = await withTimeout(
            this.client.search({ or: [{ subject: query }, { from: query }] }, { uid: true }),
            SEARCH_TIMEOUT, 'imap-search'
          );
          uids = searchResult as number[];
        } catch (searchErr: any) {
          // Fallback: Proton Bridge may not support OR — try subject-only
          logger.warn(
            `OR search failed (${(searchErr.message || '').slice(0, 60)}), falling back to subject-only`,
            'IMAPService',
          );
          try {
            const subjectResult = await withTimeout(
              this.client.search({ subject: query }, { uid: true }),
              SEARCH_TIMEOUT, 'imap-search-subject'
            );
            uids = subjectResult as number[];
          } catch {
            // If even subject search fails, return empty
            logger.warn('Subject-only search also failed, returning empty results', 'IMAPService');
            return [];
          }
        }

        if (uids.length === 0) return [];

        // Take the most recent UIDs up to the limit
        const selectedUids = uids.slice(-limit);
        const uidRange = selectedUids.join(',');

        const results: EmailMessage[] = [];
        const fetchPromise = (async () => {
          for await (const msg of this.client!.fetch(uidRange, { envelope: true, flags: true }, { uid: true })) {
            results.push({
              id: String(msg.uid || msg.seq),
              subject: msg.envelope?.subject || '(no subject)',
              from: msg.envelope?.from?.[0] ? `${msg.envelope.from[0].name || ''} <${msg.envelope.from[0].address || ''}>`.trim() : 'unknown',
              to: (msg.envelope?.to || []).map((a: any) => a.address || ''),
              date: msg.envelope?.date || new Date(),
              body: '',
              folder,
              read: msg.flags?.has('\\Seen') || false,
              starred: msg.flags?.has('\\Flagged') || false,
            });
          }
        })();
        await withTimeout(fetchPromise, HEAVY_TIMEOUT, 'search-fetch');
        this.lastActivity = Date.now();
        return results;
      } finally {
        lock.release();
      }
    });
  }

  async getFolders(): Promise<Array<{ name: string; path: string }>> {
    return this.withReconnect('getFolders', async () => {
      if (!this.client) throw new Error('IMAP not connected');

      const list = await withTimeout(this.client.list(), LIGHT_TIMEOUT, 'list');
      this.lastActivity = Date.now();
      const folders: Array<{ name: string; path: string }> = [];
      for (const item of list) {
        folders.push({ name: item.name, path: item.path });
      }
      return folders;
    });
  }

  async markEmailRead(emailId: string, isRead: boolean, folder: string = 'INBOX'): Promise<void> {
    return this.withReconnect('markEmailRead', async () => {
      if (!this.client) throw new Error('IMAP not connected');

      const lock = await withTimeout(this.client.getMailboxLock(folder), LOCK_TIMEOUT, 'getMailboxLock');
      try {
        const uid = parseInt(emailId, 10);
        if (isRead) {
          await withTimeout(this.client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }), LIGHT_TIMEOUT, 'flagsAdd');
        } else {
          await withTimeout(this.client.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true }), LIGHT_TIMEOUT, 'flagsRemove');
        }
        this.lastActivity = Date.now();
      } finally {
        lock.release();
      }
    });
  }

  async starEmail(emailId: string, isStarred: boolean, folder: string = 'INBOX'): Promise<void> {
    return this.withReconnect('starEmail', async () => {
      if (!this.client) throw new Error('IMAP not connected');

      const lock = await withTimeout(this.client.getMailboxLock(folder), LOCK_TIMEOUT, 'getMailboxLock');
      try {
        const uid = parseInt(emailId, 10);
        if (isStarred) {
          await withTimeout(this.client.messageFlagsAdd(String(uid), ['\\Flagged'], { uid: true }), LIGHT_TIMEOUT, 'flagsAdd');
        } else {
          await withTimeout(this.client.messageFlagsRemove(String(uid), ['\\Flagged'], { uid: true }), LIGHT_TIMEOUT, 'flagsRemove');
        }
        this.lastActivity = Date.now();
      } finally {
        lock.release();
      }
    });
  }

  async moveEmail(emailId: string, targetFolder: string, folder: string = 'INBOX'): Promise<void> {
    return this.withReconnect('moveEmail', async () => {
      if (!this.client) throw new Error('IMAP not connected');

      const lock = await withTimeout(this.client.getMailboxLock(folder), LOCK_TIMEOUT, 'getMailboxLock');
      try {
        const uid = parseInt(emailId, 10);
        await withTimeout(this.client.messageMove(String(uid), targetFolder, { uid: true }), HEAVY_TIMEOUT, 'messageMove');
        this.lastActivity = Date.now();
      } finally {
        lock.release();
      }
    });
  }

  async deleteEmail(emailId: string, folder: string = 'INBOX'): Promise<void> {
    return this.withReconnect('deleteEmail', async () => {
      if (!this.client) throw new Error('IMAP not connected');

      const lock = await withTimeout(this.client.getMailboxLock(folder), LOCK_TIMEOUT, 'getMailboxLock');
      try {
        const uid = parseInt(emailId, 10);
        await withTimeout(this.client.messageFlagsAdd(String(uid), ['\\Deleted'], { uid: true }), LIGHT_TIMEOUT, 'flagsAdd');
        await withTimeout(this.client.messageDelete(String(uid), { uid: true }), HEAVY_TIMEOUT, 'messageDelete');
        this.lastActivity = Date.now();
      } finally {
        lock.release();
      }
    });
  }

  async getStats(folder: string = 'INBOX'): Promise<{ totalEmails: number; unreadEmails: number; folders: number }> {
    return this.withReconnect('getStats', async () => {
      if (!this.client) throw new Error('IMAP not connected');

      const status = await withTimeout(this.client.status(folder, { messages: true, unseen: true }), LIGHT_TIMEOUT, 'status');
      const folders = await withTimeout(this.client.list(), LIGHT_TIMEOUT, 'list');
      this.lastActivity = Date.now();
      return {
        totalEmails: status.messages || 0,
        unreadEmails: status.unseen || 0,
        folders: folders.length,
      };
    });
  }
}
