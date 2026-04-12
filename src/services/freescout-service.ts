/**
 * FreeScout Helpdesk Service
 *
 * Integrates with FreeScout API to manage helpdesk tickets,
 * customers, and conversations.
 */

import { logger } from '../utils/logger.js';

export class FreeScoutService {
  private apiUrl: string;
  private apiKey: string;

  constructor(apiUrl: string, apiKey: string) {
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    logger.info(`FreeScout service initialized: ${this.apiUrl}`, 'FreeScout');
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = `${this.apiUrl}/api${path}`;
    const headers: Record<string, string> = {
      'X-FreeScout-API-Key': this.apiKey,
      'Content-Type': 'application/json',
    };

    const opts: RequestInit = { method, headers };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);
    const text = await res.text();

    if (!res.ok) {
      throw new Error(`FreeScout API ${res.status}: ${text.slice(0, 300)}`);
    }

    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }

  // ── Conversations (Tickets) ─────────────────────────────────────────────

  async listConversations(mailboxId?: number, status: string = 'active', page: number = 1): Promise<unknown> {
    let path = `/conversations?page=${page}&status=${status}`;
    if (mailboxId) path += `&mailboxId=${mailboxId}`;
    return this.request('GET', path);
  }

  async getConversation(conversationId: number): Promise<unknown> {
    return this.request('GET', `/conversations/${conversationId}`);
  }

  async createConversation(params: {
    type: 'email' | 'phone' | 'chat';
    mailboxId: number;
    subject: string;
    customer: { email?: string; firstName?: string; lastName?: string };
    threads: Array<{ type: 'customer' | 'note' | 'reply'; body: string; }>;
    status?: 'active' | 'pending' | 'closed' | 'spam';
  }): Promise<unknown> {
    return this.request('POST', '/conversations', params);
  }

  async replyToConversation(conversationId: number, body: string, type: 'reply' | 'note' = 'reply'): Promise<unknown> {
    return this.request('POST', `/conversations/${conversationId}/threads`, {
      type,
      body,
    });
  }

  async updateConversation(conversationId: number, updates: {
    status?: 'active' | 'pending' | 'closed' | 'spam';
    assignTo?: number;
    subject?: string;
  }): Promise<unknown> {
    return this.request('PUT', `/conversations/${conversationId}`, updates);
  }

  // ── Customers ───────────────────────────────────────────────────────────

  async listCustomers(page: number = 1): Promise<unknown> {
    return this.request('GET', `/customers?page=${page}`);
  }

  async getCustomer(customerId: number): Promise<unknown> {
    return this.request('GET', `/customers/${customerId}`);
  }

  async searchCustomers(query: string): Promise<unknown> {
    return this.request('GET', `/customers?query=${encodeURIComponent(query)}`);
  }

  // ── Mailboxes ───────────────────────────────────────────────────────────

  async listMailboxes(): Promise<unknown> {
    return this.request('GET', '/mailboxes');
  }

  // ── Users (Agents) ─────────────────────────────────────────────────────

  async listUsers(): Promise<unknown> {
    return this.request('GET', '/users');
  }
}
