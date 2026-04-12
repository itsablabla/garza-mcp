import { logger } from '../utils/logger.js';

/**
 * BeeperService — HTTP client for Beeper Desktop API (port 23373).
 * Beeper Desktop exposes a local REST API for all connected messaging
 * platforms (WhatsApp, Telegram, Signal, iMessage, Slack, Discord, etc.).
 */

const DEFAULT_TIMEOUT = 15000;

interface BeeperRequestOptions {
  method?: string;
  body?: unknown;
  params?: Record<string, string>;
}

export class BeeperService {
  private apiUrl: string;
  private token: string;

  constructor(apiUrl: string, token: string) {
    this.apiUrl = apiUrl.replace(/\/+$/, '');
    this.token = token;
    logger.info(`Beeper service initialized: ${this.apiUrl}`, 'BeeperService');
  }

  private async request(path: string, opts: BeeperRequestOptions = {}): Promise<unknown> {
    const { method = 'GET', body, params } = opts;
    let url = `${this.apiUrl}${path}`;
    if (params) {
      const qs = new URLSearchParams(params).toString();
      if (qs) url += `?${qs}`;
    }

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      clearTimeout(timer);
      if (!res.ok) {
        throw new Error(`Beeper API ${res.status}: ${text.slice(0, 300)}`);
      }
      return text ? JSON.parse(text) : {};
    } catch (e: any) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error(`Beeper API timeout: ${path}`);
      throw e;
    }
  }

  // ── Account operations ──────────────────────────────────────────────────

  async listAccounts(): Promise<unknown> {
    return this.request('/v1/accounts');
  }

  // ── Chat operations ─────────────────────────────────────────────────────

  async listChats(opts: { limit?: number; offset?: number; unreadOnly?: boolean; service?: string } = {}): Promise<unknown> {
    const params: Record<string, string> = {};
    if (opts.limit) params.limit = String(opts.limit);
    if (opts.offset) params.offset = String(opts.offset);
    if (opts.unreadOnly) params.unreadOnly = 'true';
    if (opts.service) params.service = opts.service;
    return this.request('/v1/chats', { params });
  }

  async searchChats(query: string): Promise<unknown> {
    return this.request('/v1/chats/search', { params: { q: query } });
  }

  async getChat(chatID: string): Promise<unknown> {
    return this.request(`/v1/chats/${chatID}`);
  }

  async archiveChat(chatID: string, archived: boolean): Promise<unknown> {
    return this.request(`/v1/chats/${chatID}/archive`, {
      method: 'POST',
      body: { archived },
    });
  }

  async createChat(accountID: string, participantIDs: string[], type: string = 'single'): Promise<unknown> {
    return this.request('/v1/chats', {
      method: 'POST',
      body: { accountID, participantIDs, type },
    });
  }

  // ── Message operations ──────────────────────────────────────────────────

  async getMessages(chatID: string, opts: { limit?: number; before?: string } = {}): Promise<unknown> {
    const params: Record<string, string> = {};
    if (opts.limit) params.limit = String(opts.limit);
    if (opts.before) params.before = opts.before;
    return this.request(`/v1/chats/${chatID}/messages`, { params });
  }

  async searchMessages(query: string, limit?: number): Promise<unknown> {
    const params: Record<string, string> = { q: query };
    if (limit) params.limit = String(limit);
    return this.request('/v1/messages/search', { params });
  }

  async sendMessage(chatID: string, text: string, replyTo?: string): Promise<unknown> {
    const body: Record<string, string> = { text };
    if (replyTo) body.replyTo = replyTo;
    return this.request(`/v1/chats/${chatID}/messages`, {
      method: 'POST',
      body,
    });
  }

  async markRead(chatID: string, upToMessageID?: string): Promise<unknown> {
    // Beeper Desktop API: send a read receipt by sending a zero-content message with read marker
    // The API doesn't have a dedicated mark-read endpoint; we read the latest messages instead
    const body: Record<string, any> = { msgtype: 'm.read', relatesTo: { eventId: upToMessageID || '' } };
    return this.request(`/v1/chats/${chatID}/messages`, { method: 'POST', body });
  }

  async addReaction(chatID: string, messageID: string, emoji: string): Promise<unknown> {
    // Beeper Desktop API sends reactions as special messages with m.reaction type
    return this.request(`/v1/chats/${chatID}/messages`, {
      method: 'POST',
      body: { msgtype: 'm.reaction', relatesTo: { eventId: messageID, key: emoji } },
    });
  }

  // ── Contact operations ──────────────────────────────────────────────────

  async searchContacts(accountID: string, query: string): Promise<unknown> {
    return this.request(`/v1/accounts/${accountID}/contacts`, {
      params: { query },
    });
  }

  // ── Reminder ────────────────────────────────────────────────────────────

  async setReminder(chatID: string, remindAt: string): Promise<unknown> {
    // Beeper API expects remindAtMs as epoch milliseconds
    const ms = new Date(remindAt).getTime();
    return this.request(`/v1/chats/${chatID}/reminders`, {
      method: 'POST',
      body: { reminder: { remindAtMs: ms } },
    });
  }

  // ── Unread summary ──────────────────────────────────────────────────────

  async getUnreadSummary(): Promise<{ totalUnread: number; chats: Array<{ name: string; service: string; unread: number; lastMessage: string; chatID: string }> }> {
    const data = await this.request('/v1/chats', { params: { unreadOnly: 'true', limit: '50' } }) as any;
    const chats = Array.isArray(data) ? data : (data?.chats || data?.items || []);
    const summary = chats.map((c: any) => ({
      name: c.name || c.id || 'Unknown',
      service: c.service || c.accountID || 'unknown',
      unread: c.unreadCount || 0,
      lastMessage: (c.lastMessage?.text || '').slice(0, 100),
      chatID: c.id,
    }));
    const totalUnread = summary.reduce((t: number, c: any) => t + c.unread, 0);
    return { totalUnread, chats: summary };
  }
}
