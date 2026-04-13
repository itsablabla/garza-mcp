/**
 * Fabric AI Service — Memory, Notes & Search
 *
 * Integrates with the Fabric AI API (api.fabric.so) to provide
 * memory storage, notepad management, and semantic search.
 *
 * API docs: https://developers.fabric.so
 */

import { logger } from '../utils/logger.js';

const DEFAULT_API_URL = 'https://api.fabric.so';
const DEFAULT_PARENT_ID = '89cd201a-0be0-47f2-a25e-bdc1f85c1ef8'; // GARZA OS — Agent Handoff

export class FabricService {
  private apiUrl: string;
  private apiKey: string;
  private parentId: string;

  constructor(apiKey: string, apiUrl?: string, parentId?: string) {
    this.apiKey = apiKey;
    this.apiUrl = apiUrl || DEFAULT_API_URL;
    this.parentId = parentId || DEFAULT_PARENT_ID;
    logger.info(`FabricAI service initialized: ${this.apiUrl}`, 'FabricAI');
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = `${this.apiUrl}${path}`;
    const headers: Record<string, string> = {
      'X-Api-Key': this.apiKey,
      'Content-Type': 'application/json',
    };

    const opts: RequestInit = { method, headers };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);
    const text = await res.text();

    if (!res.ok) {
      throw new Error(`Fabric API ${res.status}: ${text.slice(0, 300)}`);
    }

    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }

  // ── Search ──────────────────────────────────────────────────────────────

  async search(query: string, limit: number = 10): Promise<unknown> {
    return this.request('POST', '/v2/search', {
      queries: [{ mode: 'hybrid', text: query }],
      pagination: { page: 1, pageSize: limit },
    });
  }

  // ── Memories ────────────────────────────────────────────────────────────

  async addMemory(content: string, source: string = 'text'): Promise<unknown> {
    return this.request('POST', '/v2/memories', { source, content });
  }

  async recallMemories(query: string, limit: number = 20): Promise<unknown> {
    // Memories are recalled via semantic search
    return this.request('POST', '/v2/search', {
      queries: [{ mode: 'hybrid', text: query }],
      pagination: { page: 1, pageSize: limit },
    });
  }

  // ── Notepads (via resources/filter) ────────────────────────────────────

  async createNotepad(text: string, name?: string, parentId?: string): Promise<unknown> {
    const body: Record<string, unknown> = {
      parentId: parentId || this.parentId,
      text,
    };
    if (name) body.name = name;
    return this.request('POST', '/v2/notepads', body);
  }

  async listNotepads(parentId?: string, limit: number = 20): Promise<unknown> {
    const pid = parentId || this.parentId;
    return this.request('POST', '/v2/resources/filter', {
      parentId: pid,
      limit,
      order: { property: 'modifiedAt', direction: 'DESC' },
    });
  }

  async getNotepad(notepadId: string): Promise<unknown> {
    return this.request('GET', `/v2/notepads/${notepadId}`);
  }

  async updateNotepad(notepadId: string, text: string): Promise<unknown> {
    return this.request('PATCH', `/v2/notepads/${notepadId}`, { text });
  }

  async deleteNotepad(notepadId: string): Promise<unknown> {
    return this.request('DELETE', `/v2/notepads/${notepadId}`);
  }
}
