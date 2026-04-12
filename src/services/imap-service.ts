import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { ProtonMailConfig, EmailMessage } from '../types/index.js';
import { logger } from '../utils/logger.js';

// Timeouts tuned for Proton Bridge with a 736GB mailbox
const CONNECT_TIMEOUT = 20000;   // 20s to establish connection
const LIGHT_TIMEOUT   = 30000;   // 30s for lightweight ops (status, list, flags)
const HEAVY_TIMEOUT   = 60000;   // 60s for heavy ops (fetch, search on large folders)
const LOCK_TIMEOUT    = 30000;   // 30s to acquire mailbox lock

/** Race a promise against a timeout */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`IMAP operation '${label}' timed out after ${ms / 1000}s — Proton Bridge may still be syncing the mailbox.`)), ms)
    ),
  ]);
}

export class IMAPService {
  private client: ImapFlow | null = null;
  private config: ProtonMailConfig;
  private connected = false;
  private lastActivity = 0;

  constructor(config: ProtonMailConfig) {
    this.config = config;
  }

  private createClient(): ImapFlow {
    return new ImapFlow({
      host: this.config.imap.host,
      port: this.config.imap.port,
      secure: false,
      // Proton Bridge on localhost: STARTTLS negotiation hangs — use plain IMAP
      disableAutoIdle: true,
      auth: { user: this.config.imap.username, pass: this.config.imap.password },
      logger: false,
      tls: { rejectUnauthorized: false },
      greetingTimeout: 15000,
      socketTimeout: 30000,   // Raised from 15s for large mailbox
    });
  }

  async connect(): Promise<void> {
    if (this.connected && this.client) return;

    // Clean up any stale client
    if (this.client) {
      try { this.client.close(); } catch {}
      this.client = null;
      this.connected = false;
    }

    this.client = this.createClient();

    // Listen for unexpected disconnects
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

  /** Ensure we have a live IMAP connection, reconnecting if stale or dead */
  async ensureConnected(): Promise<void> {
    // If we think we're connected, verify with a NOOP if it's been > 60s
    if (this.connected && this.client) {
      const staleMs = Date.now() - this.lastActivity;
      if (staleMs > 60000) {
        try {
          await withTimeout(this.client.noop(), 5000, 'noop-keepalive');
          this.lastActivity = Date.now();
          return;
        } catch {
          logger.warn('IMAP connection stale, reconnecting...', 'IMAPService');
          this.connected = false;
          try { this.client.close(); } catch {}
          this.client = null;
        }
      } else {
        return;
      }
    }
    await this.connect();
  }

  /** Reconnect and retry once on connection failures */
  private async withReconnect<T>(fn: () => Promise<T>, label: string): Promise<T> {
    try {
      return await fn();
    } catch (e: any) {
      const msg = e?.message || '';
      // Reconnect on connection-related errors, not on genuine IMAP errors
      if (msg.includes('not connected') || msg.includes('closed') || msg.includes('ECONNRESET') || msg.includes('socket') || msg.includes('timed out')) {
        logger.warn(`IMAP ${label} failed (${msg.slice(0, 80)}), reconnecting...`, 'IMAPService');
        this.connected = false;
        try { this.client?.close(); } catch {}
        this.client = null;
        await this.connect();
        return await fn();
      }
      throw e;
    }
  }

  async getEmails(folder: string = 'INBOX', limit: number = 20, offset: number = 0): Promise<EmailMessage[]> {
    return this.withReconnect(async () => {
      await this.ensureConnected();
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
          for await (const msg of this.client!.fetch(range, { envelope: true, flags: true, uid: true })) {
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
    }, 'getEmails');
  }

  async getEmailById(emailId: string, folder: string = 'INBOX'): Promise<EmailMessage | null> {
    return this.withReconnect(async () => {
      await this.ensureConnected();
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
    }, 'getEmailById');
  }

  async searchEmails(query: string, folder: string = 'INBOX', limit: number = 20): Promise<EmailMessage[]> {
    return this.withReconnect(async () => {
      await this.ensureConnected();
      if (!this.client) throw new Error('IMAP not connected');

      const lock = await withTimeout(this.client.getMailboxLock(folder), LOCK_TIMEOUT, 'getMailboxLock');
      try {
        // Use server-side IMAP SEARCH instead of fetching all messages.
        // Try OR(SUBJECT, FROM) search — Proton Bridge supports standard IMAP SEARCH.
        let uids: number[] = [];
        try {
          const searchResult = await withTimeout(
            this.client.search({
              or: [
                { subject: query },
                { from: query },
              ],
            }, { uid: true }),
            HEAVY_TIMEOUT,
            'search'
          );
          uids = (searchResult as number[]) || [];
        } catch (searchErr: any) {
          // Fallback: if OR search not supported, try subject-only search
          logger.warn(`OR search failed (${searchErr.message?.slice(0, 60)}), trying subject-only`, 'IMAPService');
          const searchResult = await withTimeout(
            this.client.search({ subject: query }, { uid: true }),
            HEAVY_TIMEOUT,
            'search-fallback'
          );
          uids = (searchResult as number[]) || [];
        }

        if (uids.length === 0) return [];

        // Take the most recent UIDs up to the limit
        const recentUids = uids.slice(-limit);
        const uidRange = recentUids.join(',');

        const results: EmailMessage[] = [];
        const fetchPromise = (async () => {
          for await (const msg of this.client!.fetch(uidRange, { envelope: true, flags: true, uid: true }, { uid: true })) {
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
        // Return most recent first
        return results.reverse();
      } finally {
        lock.release();
      }
    }, 'searchEmails');
  }

  async getFolders(): Promise<Array<{ name: string; path: string }>> {
    return this.withReconnect(async () => {
      await this.ensureConnected();
      if (!this.client) throw new Error('IMAP not connected');

      const list = await withTimeout(this.client.list(), LIGHT_TIMEOUT, 'list');
      const folders: Array<{ name: string; path: string }> = [];
      for (const item of list) {
        folders.push({ name: item.name, path: item.path });
      }
      this.lastActivity = Date.now();
      return folders;
    }, 'getFolders');
  }

  async markEmailRead(emailId: string, isRead: boolean, folder: string = 'INBOX'): Promise<void> {
    return this.withReconnect(async () => {
      await this.ensureConnected();
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
    }, 'markEmailRead');
  }

  async starEmail(emailId: string, isStarred: boolean, folder: string = 'INBOX'): Promise<void> {
    return this.withReconnect(async () => {
      await this.ensureConnected();
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
    }, 'starEmail');
  }

  async moveEmail(emailId: string, targetFolder: string, folder: string = 'INBOX'): Promise<void> {
    return this.withReconnect(async () => {
      await this.ensureConnected();
      if (!this.client) throw new Error('IMAP not connected');

      const lock = await withTimeout(this.client.getMailboxLock(folder), LOCK_TIMEOUT, 'getMailboxLock');
      try {
        const uid = parseInt(emailId, 10);
        await withTimeout(this.client.messageMove(String(uid), targetFolder, { uid: true }), LIGHT_TIMEOUT, 'messageMove');
        this.lastActivity = Date.now();
      } finally {
        lock.release();
      }
    }, 'moveEmail');
  }

  async deleteEmail(emailId: string, folder: string = 'INBOX'): Promise<void> {
    return this.withReconnect(async () => {
      await this.ensureConnected();
      if (!this.client) throw new Error('IMAP not connected');

      const lock = await withTimeout(this.client.getMailboxLock(folder), LOCK_TIMEOUT, 'getMailboxLock');
      try {
        const uid = parseInt(emailId, 10);
        await withTimeout(this.client.messageFlagsAdd(String(uid), ['\\Deleted'], { uid: true }), LIGHT_TIMEOUT, 'flagsAdd');
        await withTimeout(this.client.messageDelete(String(uid), { uid: true }), LIGHT_TIMEOUT, 'messageDelete');
        this.lastActivity = Date.now();
      } finally {
        lock.release();
      }
    }, 'deleteEmail');
  }

  async getStats(folder: string = 'INBOX'): Promise<{ totalEmails: number; unreadEmails: number; folders: number }> {
    return this.withReconnect(async () => {
      await this.ensureConnected();
      if (!this.client) throw new Error('IMAP not connected');

      const status = await withTimeout(this.client.status(folder, { messages: true, unseen: true }), LIGHT_TIMEOUT, 'status');
      const folderList = await withTimeout(this.client.list(), LIGHT_TIMEOUT, 'list');
      this.lastActivity = Date.now();
      return {
        totalEmails: status.messages || 0,
        unreadEmails: status.unseen || 0,
        folders: folderList.length,
      };
    }, 'getStats');
  }
}
