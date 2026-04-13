/**
 * Voicenotes Service — Voice note recordings, transcripts, AI summaries
 * Based on the official Obsidian Sync plugin: github.com/voicenotes-community/voicenotes-sync
 * Base URL: https://api.voicenotes.com/api/integrations/obsidian-sync
 * Auth: Authorization: Bearer {token} + X-API-KEY: {token}
 */

import { logger } from '../utils/logger.js';

export class VoicenotesService {
  private baseUrl = 'https://api.voicenotes.com/api/integrations/obsidian-sync';

  constructor(private token: string) {}

  private async req<T = any>(method: string, path: string, body?: Record<string, any>): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    logger.debug(`Voicenotes ${method} ${url}`, 'Voicenotes');

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.token}`,
      'X-API-KEY': `${this.token}`,
    };
    const opts: RequestInit = { method, headers };
    if (body && (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE')) {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    opts.signal = controller.signal;

    try {
      const res = await fetch(url, opts);
      clearTimeout(timeout);
      const text = await res.text();

      if (res.status === 401) {
        throw new Error('Voicenotes: Authentication failed — token invalid or expired. Regenerate at https://voicenotes.com/app?obsidian=true#settings');
      }
      if (res.status === 429) {
        throw new Error('Voicenotes: Rate limited. Try again in a few seconds.');
      }
      if (!res.ok) {
        throw new Error(`Voicenotes API ${res.status}: ${text.slice(0, 300)}`);
      }
      return text ? JSON.parse(text) : ({} as T);
    } catch (e: any) {
      clearTimeout(timeout);
      if (e.name === 'AbortError') throw new Error('Voicenotes: Request timed out after 30s');
      throw e;
    }
  }

  // ── User ───────────────────────────────────────────────────────────

  async getUserInfo(): Promise<any> {
    return this.req('GET', '/user/info');
  }

  // ── Recordings ─────────────────────────────────────────────────────
  // Matches official Obsidian plugin: POST /recordings with sync body

  async listRecordings(lastSyncedAt?: string | null): Promise<any> {
    return this.req('POST', '/recordings', {
      obsidian_deleted_recording_ids: [],
      last_synced_note_updated_at: lastSyncedAt ?? null,
    });
  }

  async getNextPage(nextLink: string): Promise<any> {
    return this.req('POST', nextLink);
  }

  async getRecordingAudioUrl(recordingId: string): Promise<any> {
    return this.req('GET', `/recordings/${recordingId}/signed-url`);
  }

  async deleteRecording(recordingId: string): Promise<any> {
    return this.req('DELETE', `/recordings/${recordingId}`);
  }

  // ── Search (client-side through fetched notes) ─────────────────────

  async searchNotes(query: string, limit: number = 20): Promise<any[]> {
    const q = query.toLowerCase();
    const results: any[] = [];
    let nextLink: string | undefined;
    let pages = 0;
    const maxPages = 10;

    // First page
    const first = await this.listRecordings(null);
    const firstData = first?.data || [];
    for (const note of firstData) {
      if (this.matchesQuery(note, q)) {
        results.push(note);
        if (results.length >= limit) return results;
      }
    }
    nextLink = first?.links?.next;
    pages++;

    // Subsequent pages via pagination link
    while (nextLink && pages < maxPages && results.length < limit) {
      const page = await this.getNextPage(nextLink);
      const data = page?.data || [];
      if (!data.length) break;

      for (const note of data) {
        if (this.matchesQuery(note, q)) {
          results.push(note);
          if (results.length >= limit) return results;
        }
      }
      nextLink = page?.links?.next;
      pages++;
    }

    return results;
  }

  private matchesQuery(note: any, q: string): boolean {
    const title = (note.title || '').toLowerCase();
    const transcript = (note.transcript || '').toLowerCase();
    const tags = (note.tags || []).map((t: any) => (typeof t === 'string' ? t : t.name || '').toLowerCase());
    const creations = (note.creations || []).map((c: any) => (c.markdown_content || c.text || c.content || '').toLowerCase());
    return title.includes(q) || transcript.includes(q) || tags.some((t: string) => t.includes(q)) || creations.some((c: string) => c.includes(q));
  }
}
