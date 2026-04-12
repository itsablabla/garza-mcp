/**
 * Voicenotes Service — Voice note recordings, transcripts, AI summaries
 * API Docs: https://github.com/openclaw/skills/tree/main/skills/shawnhansen/voicenotes
 * Base URL: https://api.voicenotes.com/api/integrations/obsidian-sync
 * Auth: Authorization: Bearer {token} + X-API-KEY: {token}
 */

import { logger } from '../utils/logger.js';

export class VoicenotesService {
  private baseUrl = 'https://api.voicenotes.com/api/integrations/obsidian-sync';

  constructor(private token: string) {}

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
    logger.debug(`Voicenotes ${method} ${url}`, 'Voicenotes');
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.token}`,
      'X-API-KEY': this.token,
      'Accept': 'application/json',
    };
    const opts: RequestInit = { method, headers };
    if (body && (method === 'POST' || method === 'PATCH' || method === 'PUT')) {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const text = await res.text();
    if (!res.ok) throw new Error(`Voicenotes API ${res.status}: ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : ({} as T);
  }

  // ── User ───────────────────────────────────────────────────────────

  async getUserInfo(): Promise<any> {
    return this.req('GET', '/user/info');
  }

  // ── Recordings ─────────────────────────────────────────────────────

  async listRecordings(cursor?: string, limit?: number): Promise<any> {
    const query: Record<string, string> = {};
    if (cursor) query.cursor = cursor;
    if (limit) query.per_page = String(limit);
    return this.req('POST', '/recordings', undefined, query);
  }

  async getRecordingAudioUrl(recordingId: string): Promise<any> {
    return this.req('POST', `/recordings/${recordingId}/signed-url`);
  }

  // ── Search (client-side through fetched notes) ─────────────────────

  async searchNotes(query: string, limit: number = 20): Promise<any[]> {
    const q = query.toLowerCase();
    const results: any[] = [];
    let cursor: string | undefined;
    let pages = 0;
    const maxPages = 10;

    while (pages < maxPages && results.length < limit) {
      const response = await this.listRecordings(cursor, 50);
      const data = response?.data || [];
      if (!data.length) break;

      for (const note of data) {
        const title = (note.title || '').toLowerCase();
        const transcript = (note.transcript || '').toLowerCase();
        const tags = (note.tags || []).map((t: any) => (typeof t === 'string' ? t : t.name || '').toLowerCase());
        const creations = (note.creations || []).map((c: any) => (c.text || c.content || '').toLowerCase());

        if (title.includes(q) || transcript.includes(q) || tags.some((t: string) => t.includes(q)) || creations.some((c: string) => c.includes(q))) {
          results.push(note);
          if (results.length >= limit) break;
        }
      }

      cursor = response?.links?.next || response?.meta?.next_cursor;
      if (!cursor) break;
      pages++;
    }

    return results;
  }
}
