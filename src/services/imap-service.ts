import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { ProtonMailConfig, EmailMessage } from '../types/index.js';
import { logger } from '../utils/logger.js';

const OP_TIMEOUT = 20000; // 20s per IMAP operation

/** Race a promise against a timeout */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`IMAP operation '${label}' timed out after ${ms / 1000}s — Proton Bridge may still be syncing.`)), ms)
    ),
  ]);
}

export class IMAPService {
  private client: ImapFlow | null = null;
  private config: ProtonMailConfig;
  private connected = false;

  constructor(config: ProtonMailConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    if (this.connected && this.client) return;
    this.client = new ImapFlow({
      host: this.config.imap.host,
      port: this.config.imap.port,
      secure: false,
      // Proton Bridge on localhost: STARTTLS negotiation hangs — use plain IMAP
      disableAutoIdle: true,
      auth: { user: this.config.imap.username, pass: this.config.imap.password },
      logger: false,
      tls: { rejectUnauthorized: false },
      greetingTimeout: 15000,
      socketTimeout: 15000,
    });

    try {
      await withTimeout(this.client.connect(), 15000, 'connect');
      this.connected = true;
      logger.info('IMAP connected', 'IMAPService');
    } catch (e) {
      this.client = null;
      this.connected = false;
      throw e;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  async ensureConnected(): Promise<void> {
    if (!this.connected) await this.connect();
  }

  async getEmails(folder: string = 'INBOX', limit: number = 20, offset: number = 0): Promise<EmailMessage[]> {
    await this.ensureConnected();
    if (!this.client) throw new Error('IMAP not connected');

    const lock = await withTimeout(this.client.getMailboxLock(folder), OP_TIMEOUT, 'getMailboxLock');
    try {
      const status = await withTimeout(this.client.status(folder, { messages: true }), OP_TIMEOUT, 'status');
      const total = status.messages || 0;
      if (total === 0) return [];

      const start = Math.max(1, total - offset - limit + 1);
      const end = Math.max(1, total - offset);
      const range = `${start}:${end}`;

      const messages: EmailMessage[] = [];
      // Collect messages with a timeout wrapper
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
      await withTimeout(fetchPromise, OP_TIMEOUT, 'fetch');
      return messages.reverse();
    } finally {
      lock.release();
    }
  }

  async getEmailById(emailId: string, folder: string = 'INBOX'): Promise<EmailMessage | null> {
    await this.ensureConnected();
    if (!this.client) throw new Error('IMAP not connected');

    const lock = await withTimeout(this.client.getMailboxLock(folder), OP_TIMEOUT, 'getMailboxLock');
    try {
      const uid = parseInt(emailId, 10);
      const msg = await withTimeout(
        this.client.fetchOne(String(uid), { envelope: true, flags: true, source: true }, { uid: true }),
        OP_TIMEOUT, 'fetchOne'
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
  }

  async searchEmails(query: string, folder: string = 'INBOX', limit: number = 20): Promise<EmailMessage[]> {
    await this.ensureConnected();
    if (!this.client) throw new Error('IMAP not connected');

    const lock = await withTimeout(this.client.getMailboxLock(folder), OP_TIMEOUT, 'getMailboxLock');
    try {
      const results: EmailMessage[] = [];
      let count = 0;

      const fetchPromise = (async () => {
        for await (const msg of this.client!.fetch('1:*', { envelope: true, flags: true })) {
          if (count >= limit) break;
          const subject = msg.envelope?.subject || '';
          const from = msg.envelope?.from?.[0]?.address || '';
          if (subject.toLowerCase().includes(query.toLowerCase()) || from.toLowerCase().includes(query.toLowerCase())) {
            results.push({
              id: String(msg.uid || msg.seq),
              subject,
              from: msg.envelope?.from?.[0] ? `${msg.envelope.from[0].name || ''} <${msg.envelope.from[0].address || ''}>`.trim() : 'unknown',
              to: (msg.envelope?.to || []).map((a: any) => a.address || ''),
              date: msg.envelope?.date || new Date(),
              body: '',
              folder,
              read: msg.flags?.has('\\Seen') || false,
              starred: msg.flags?.has('\\Flagged') || false,
            });
            count++;
          }
        }
      })();
      await withTimeout(fetchPromise, OP_TIMEOUT, 'search-fetch');
      return results;
    } finally {
      lock.release();
    }
  }

  async getFolders(): Promise<Array<{ name: string; path: string }>> {
    await this.ensureConnected();
    if (!this.client) throw new Error('IMAP not connected');

    const list = await withTimeout(this.client.list(), OP_TIMEOUT, 'list');
    const folders: Array<{ name: string; path: string }> = [];
    for (const item of list) {
      folders.push({ name: item.name, path: item.path });
    }
    return folders;
  }

  async markEmailRead(emailId: string, isRead: boolean, folder: string = 'INBOX'): Promise<void> {
    await this.ensureConnected();
    if (!this.client) throw new Error('IMAP not connected');

    const lock = await withTimeout(this.client.getMailboxLock(folder), OP_TIMEOUT, 'getMailboxLock');
    try {
      const uid = parseInt(emailId, 10);
      if (isRead) {
        await withTimeout(this.client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }), OP_TIMEOUT, 'flagsAdd');
      } else {
        await withTimeout(this.client.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true }), OP_TIMEOUT, 'flagsRemove');
      }
    } finally {
      lock.release();
    }
  }

  async starEmail(emailId: string, isStarred: boolean, folder: string = 'INBOX'): Promise<void> {
    await this.ensureConnected();
    if (!this.client) throw new Error('IMAP not connected');

    const lock = await withTimeout(this.client.getMailboxLock(folder), OP_TIMEOUT, 'getMailboxLock');
    try {
      const uid = parseInt(emailId, 10);
      if (isStarred) {
        await withTimeout(this.client.messageFlagsAdd(String(uid), ['\\Flagged'], { uid: true }), OP_TIMEOUT, 'flagsAdd');
      } else {
        await withTimeout(this.client.messageFlagsRemove(String(uid), ['\\Flagged'], { uid: true }), OP_TIMEOUT, 'flagsRemove');
      }
    } finally {
      lock.release();
    }
  }

  async moveEmail(emailId: string, targetFolder: string, folder: string = 'INBOX'): Promise<void> {
    await this.ensureConnected();
    if (!this.client) throw new Error('IMAP not connected');

    const lock = await withTimeout(this.client.getMailboxLock(folder), OP_TIMEOUT, 'getMailboxLock');
    try {
      const uid = parseInt(emailId, 10);
      await withTimeout(this.client.messageMove(String(uid), targetFolder, { uid: true }), OP_TIMEOUT, 'messageMove');
    } finally {
      lock.release();
    }
  }

  async deleteEmail(emailId: string, folder: string = 'INBOX'): Promise<void> {
    await this.ensureConnected();
    if (!this.client) throw new Error('IMAP not connected');

    const lock = await withTimeout(this.client.getMailboxLock(folder), OP_TIMEOUT, 'getMailboxLock');
    try {
      const uid = parseInt(emailId, 10);
      await withTimeout(this.client.messageFlagsAdd(String(uid), ['\\Deleted'], { uid: true }), OP_TIMEOUT, 'flagsAdd');
      await withTimeout(this.client.messageDelete(String(uid), { uid: true }), OP_TIMEOUT, 'messageDelete');
    } finally {
      lock.release();
    }
  }

  async getStats(folder: string = 'INBOX'): Promise<{ totalEmails: number; unreadEmails: number; folders: number }> {
    await this.ensureConnected();
    if (!this.client) throw new Error('IMAP not connected');

    const status = await withTimeout(this.client.status(folder, { messages: true, unseen: true }), OP_TIMEOUT, 'status');
    const folders = await withTimeout(this.client.list(), OP_TIMEOUT, 'list');
    return {
      totalEmails: status.messages || 0,
      unreadEmails: status.unseen || 0,
      folders: folders.length,
    };
  }
}
