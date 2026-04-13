/**
 * Quo (OpenPhone) Service — Phone, SMS, Calls, Contacts, Conversations
 * API Docs: https://www.quo.com/docs/mdx/api-reference/introduction
 * Base URL: https://api.openphone.com
 * Auth: Authorization: {apiKey}  (no Bearer prefix)
 */

import { logger } from '../utils/logger.js';

export class QuoService {
  private baseUrl = 'https://api.openphone.com';

  constructor(private apiKey: string) {}

  private async req<T = any>(method: string, path: string, body?: Record<string, any>, query?: Record<string, string>): Promise<T> {
    let url = `${this.baseUrl}${path}`;
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') params.append(k, v);
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }
    logger.debug(`Quo ${method} ${url}`, 'Quo');
    const opts: RequestInit = {
      method,
      headers: {
        'Authorization': this.apiKey,
        'Content-Type': 'application/json',
      },
    };
    if (body && (method === 'POST' || method === 'PATCH' || method === 'PUT')) {
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const text = await res.text();
    if (!res.ok) throw new Error(`Quo API ${res.status}: ${text}`);
    return text ? JSON.parse(text) : ({} as T);
  }

  // ── Phone Numbers ──────────────────────────────────────────────────

  async listPhoneNumbers(): Promise<any> {
    return this.req('GET', '/v1/phone-numbers');
  }

  async getPhoneNumber(phoneNumberId: string): Promise<any> {
    return this.req('GET', `/v1/phone-numbers/${phoneNumberId}`);
  }

  // ── Messages ───────────────────────────────────────────────────────

  async sendMessage(from: string, to: string, content: string): Promise<any> {
    return this.req('POST', '/v1/messages', { from, to, content });
  }

  async listMessages(phoneNumberId: string, participants: string[], maxResults?: number, after?: string): Promise<any> {
    const query: Record<string, string> = { phoneNumberId };
    participants.forEach((p, i) => { query[`participants[${i}]`] = p; });
    if (maxResults) query.maxResults = String(maxResults);
    if (after) query.after = after;
    return this.req('GET', '/v1/messages', undefined, query);
  }

  async getMessage(messageId: string): Promise<any> {
    return this.req('GET', `/v1/messages/${messageId}`);
  }

  // ── Calls ──────────────────────────────────────────────────────────

  async listCalls(phoneNumberId: string, participants: string[], maxResults?: number, after?: string): Promise<any> {
    const query: Record<string, string> = { phoneNumberId };
    participants.forEach((p, i) => { query[`participants[${i}]`] = p; });
    if (maxResults) query.maxResults = String(maxResults);
    if (after) query.after = after;
    return this.req('GET', '/v1/calls', undefined, query);
  }

  async getCall(callId: string): Promise<any> {
    return this.req('GET', `/v1/calls/${callId}`);
  }

  async getCallSummary(callId: string): Promise<any> {
    return this.req('GET', `/v1/calls/${callId}/summary`);
  }

  async getCallTranscript(callId: string): Promise<any> {
    return this.req('GET', `/v1/calls/${callId}/transcript`);
  }

  async getVoicemail(callId: string): Promise<any> {
    return this.req('GET', `/v1/calls/${callId}/voicemail`);
  }

  async getCallRecordings(callId: string): Promise<any> {
    return this.req('GET', `/v1/calls/${callId}/recordings`);
  }

  // ── Contacts ───────────────────────────────────────────────────────

  async listContacts(page?: number, externalIds?: string[], sources?: string[]): Promise<any> {
    const query: Record<string, string> = {};
    if (page) query.pageToken = String(page);
    if (externalIds) externalIds.forEach((id, i) => { query[`externalIds[${i}]`] = id; });
    if (sources) sources.forEach((s, i) => { query[`sources[${i}]`] = s; });
    return this.req('GET', '/v1/contacts', undefined, query);
  }

  async getContact(contactId: string): Promise<any> {
    return this.req('GET', `/v1/contacts/${contactId}`);
  }

  async createContact(fields: { firstName: string; lastName?: string; company?: string; role?: string; phoneNumbers?: { name: string; value: string }[]; emails?: { name: string; value: string }[] }): Promise<any> {
    return this.req('POST', '/v1/contacts', { defaultFields: fields });
  }

  async updateContact(contactId: string, fields: Record<string, any>): Promise<any> {
    return this.req('PATCH', `/v1/contacts/${contactId}`, { defaultFields: fields });
  }

  async deleteContact(contactId: string): Promise<any> {
    return this.req('DELETE', `/v1/contacts/${contactId}`);
  }

  // ── Conversations ──────────────────────────────────────────────────

  async listConversations(phoneNumberId?: string, userId?: string, after?: string, maxResults?: number): Promise<any> {
    const query: Record<string, string> = {};
    if (phoneNumberId) query.phoneNumberId = phoneNumberId;
    if (userId) query.userId = userId;
    if (after) query.after = after;
    if (maxResults) query.maxResults = String(maxResults);
    return this.req('GET', '/v1/conversations', undefined, query);
  }

  // ── Users ──────────────────────────────────────────────────────────

  async listUsers(): Promise<any> {
    return this.req('GET', '/v1/users');
  }

  async getUser(userId: string): Promise<any> {
    return this.req('GET', `/v1/users/${userId}`);
  }
}
