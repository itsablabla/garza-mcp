import { execSync, execFileSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { logger } from '../utils/logger.js';

/**
 * BeeperDbService — Direct SQLite queries on the local BeeperTexts database.
 * 17GB database with 8.3M+ messages, 2K+ threads, full-text search index.
 * Path: ~/Library/Application Support/BeeperTexts/index.db
 *
 * This provides fast local access to chat history, message search, participants,
 * reactions, and analytics without going through the Beeper Desktop REST API.
 */

const DB_PATH = '/Users/customer/Library/Application Support/BeeperTexts/index.db';
const QUERY_TIMEOUT = 45000; // 45s for large queries

export class BeeperDbService {
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || DB_PATH;
    logger.info(`BeeperDB service initialized: ${this.dbPath}`, 'BeeperDB');
  }

  /** Run a SQL query via sqlite3, writing SQL to a temp file to avoid shell escaping issues */
  private query(sql: string): string {
    const tmpFile = join(tmpdir(), `beeper_query_${Date.now()}.sql`);
    try {
      // Collapse multiline SQL to single line for cleanliness
      const cleanSql = sql.replace(/\s+/g, ' ').trim();
      writeFileSync(tmpFile, cleanSql, 'utf-8');
      const result = execSync(
        `sqlite3 -json "${this.dbPath}" < "${tmpFile}"`,
        { timeout: QUERY_TIMEOUT, maxBuffer: 10 * 1024 * 1024, encoding: 'utf-8', shell: '/bin/bash' }
      );
      return result.trim();
    } catch (e: any) {
      const stderr = e.stderr?.toString?.() || '';
      const msg = stderr || e.message || '';
      // If -json flag is not supported, retry without it
      if (msg.includes('-json') || msg.includes('unknown option')) {
        try {
          const result = execSync(
            `sqlite3 "${this.dbPath}" < "${tmpFile}"`,
            { timeout: QUERY_TIMEOUT, maxBuffer: 10 * 1024 * 1024, encoding: 'utf-8', shell: '/bin/bash' }
          );
          return result.trim();
        } catch (e2: any) {
          throw new Error(`SQLite error: ${(e2.stderr?.toString?.() || e2.message || '').slice(0, 300)}`);
        }
      }
      throw new Error(`SQLite error: ${msg.slice(0, 300)}`);
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
  }

  private queryJson(sql: string): any[] {
    const raw = this.query(sql);
    if (!raw) return [];
    try {
      return JSON.parse(raw);
    } catch {
      // Parse pipe-delimited fallback
      return raw.split('\n').filter(Boolean).map(line => ({ raw: line }));
    }
  }

  /** Run a simple scalar query (returns first value) */
  private queryScalar(sql: string): string {
    const tmpFile = join(tmpdir(), `beeper_scalar_${Date.now()}.sql`);
    try {
      const cleanSql = sql.replace(/\s+/g, ' ').trim();
      writeFileSync(tmpFile, cleanSql, 'utf-8');
      const result = execSync(
        `sqlite3 "${this.dbPath}" < "${tmpFile}"`,
        { timeout: QUERY_TIMEOUT, maxBuffer: 1024 * 1024, encoding: 'utf-8', shell: '/bin/bash' }
      );
      return result.trim();
    } catch (e: any) {
      throw new Error(`SQLite error: ${(e.stderr?.toString?.() || e.message || '').slice(0, 300)}`);
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
  }

  // ── Database Stats ──────────────────────────────────────────────────────

  async getDbStats(): Promise<unknown> {
    // Individual fast queries - avoid combining subqueries that each scan large tables
    // MAX(id) is instant (uses index), COUNT on small tables is fast
    const msgMax = this.queryScalar("SELECT MAX(id) FROM mx_room_messages;");
    const threads = this.queryScalar("SELECT COUNT(*) FROM threads;");
    const participants = this.queryScalar("SELECT COUNT(*) FROM participants WHERE full_name IS NOT NULL;");

    return {
      threads: parseInt(threads) || 0,
      messagesApprox: parseInt(msgMax) || 0,
      participants: parseInt(participants) || 0,
    };
  }

  // ── Full-Text Search ───────────────────────────────────────────────────

  async searchMessagesDb(query: string, limit: number = 20, chatID?: string): Promise<unknown> {
    const escaped = query.replace(/'/g, "''").replace(/"/g, '""');
    const chatFilter = chatID
      ? `AND m.roomID = '${chatID.replace(/'/g, "''")}'`
      : '';

    const sql = `SELECT m.id, m.roomID, m.eventID, m.senderContactID, m.timestamp, m.type, m.isSentByMe, json_extract(m.message, '$.text') as text, json_extract(m.message, '$.senderID') as senderID FROM mx_room_messages m JOIN mx_room_messages_fts fts ON fts.rowid = m.id WHERE mx_room_messages_fts MATCH '"${escaped}"' ${chatFilter} ORDER BY m.timestamp DESC LIMIT ${limit};`;

    const results = this.queryJson(sql);
    return {
      query,
      count: results.length,
      messages: results.map((r: any) => ({
        id: r.id,
        chatID: r.roomID,
        eventID: r.eventID,
        sender: r.senderContactID || r.senderID,
        timestamp: r.timestamp ? new Date(parseInt(r.timestamp)).toISOString() : null,
        type: r.type,
        isSentByMe: r.isSentByMe === 1 || r.isSentByMe === '1',
        text: (r.text || '').slice(0, 500),
      })),
    };
  }

  // ── Chat History ───────────────────────────────────────────────────────

  async getChatHistory(chatID: string, limit: number = 50, before?: number): Promise<unknown> {
    const escaped = chatID.replace(/'/g, "''");
    const beforeFilter = before ? `AND m.timestamp < ${before}` : '';

    const sql = `SELECT m.id, m.eventID, m.senderContactID, m.timestamp, m.type, m.isSentByMe, json_extract(m.message, '$.text') as text, json_extract(m.message, '$.senderID') as senderID, json_extract(m.message, '$.attachments') as attachments FROM mx_room_messages m WHERE m.roomID = '${escaped}' AND m.type != 'HIDDEN' ${beforeFilter} ORDER BY m.timestamp DESC LIMIT ${limit};`;

    const messages = this.queryJson(sql);

    const threadSql = `SELECT threadID, accountID, json_extract(thread, '$.title') as title, json_extract(thread, '$.type') as type FROM threads WHERE threadID = '${escaped}';`;
    const threadInfo = this.queryJson(threadSql);

    return {
      chatID,
      thread: threadInfo[0] || null,
      count: messages.length,
      messages: messages.map((r: any) => ({
        id: r.id,
        eventID: r.eventID,
        sender: r.senderContactID || r.senderID,
        timestamp: r.timestamp ? new Date(parseInt(r.timestamp)).toISOString() : null,
        type: r.type,
        isSentByMe: r.isSentByMe === 1 || r.isSentByMe === '1',
        text: (r.text || '').slice(0, 1000),
        hasAttachments: r.attachments && r.attachments !== '[]',
      })),
    };
  }

  // ── Thread/Chat List from DB ───────────────────────────────────────────

  async listThreads(limit: number = 50, accountID?: string): Promise<unknown> {
    const acctFilter = accountID
      ? `WHERE t.accountID = '${accountID.replace(/'/g, "''")}'`
      : '';

    // Avoid the expensive subquery counting all messages per thread - just list threads
    const sql = `SELECT t.threadID, t.accountID, t.timestamp, json_extract(t.thread, '$.title') as title, json_extract(t.thread, '$.type') as type FROM threads t ${acctFilter} ORDER BY t.timestamp DESC LIMIT ${limit};`;

    const threads = this.queryJson(sql);
    return {
      count: threads.length,
      threads: threads.map((t: any) => ({
        chatID: t.threadID,
        accountID: t.accountID,
        title: t.title || '(untitled)',
        type: t.type,
        lastActivity: t.timestamp ? new Date(parseInt(t.timestamp)).toISOString() : null,
      })),
    };
  }

  // ── Participants ───────────────────────────────────────────────────────

  async getParticipants(chatID: string): Promise<unknown> {
    const escaped = chatID.replace(/'/g, "''");

    const sql = `SELECT p.account_id, p.id, p.full_name, p.nickname, p.is_self, p.is_admin, p.is_network_bot FROM participants p WHERE p.room_id = '${escaped}' AND p.has_exited IS NOT 1;`;

    const participants = this.queryJson(sql);
    return {
      chatID,
      count: participants.length,
      participants: participants.map((p: any) => ({
        id: p.id,
        accountID: p.account_id,
        name: p.full_name || p.nickname || p.id,
        isSelf: p.is_self === 1 || p.is_self === '1',
        isAdmin: p.is_admin === 1 || p.is_admin === '1',
        isBot: p.is_network_bot === 1 || p.is_network_bot === '1',
      })),
    };
  }

  // ── Search Contacts across all chats ────────────────────────────────────

  async searchContactsDb(query: string, limit: number = 20): Promise<unknown> {
    const escaped = query.replace(/'/g, "''");

    const sql = `SELECT DISTINCT p.id, p.full_name, p.nickname, p.account_id FROM participants p WHERE (p.full_name LIKE '%${escaped}%' OR p.nickname LIKE '%${escaped}%' OR p.id LIKE '%${escaped}%') AND p.has_exited IS NOT 1 AND p.is_network_bot IS NOT 1 LIMIT ${limit};`;

    const contacts = this.queryJson(sql);
    return {
      query,
      count: contacts.length,
      contacts: contacts.map((c: any) => ({
        id: c.id,
        name: c.full_name || c.nickname || c.id,
        accountID: c.account_id,
      })),
    };
  }

  // ── Reactions on a message ──────────────────────────────────────────────

  async getReactions(chatID: string, eventID: string): Promise<unknown> {
    const roomEsc = chatID.replace(/'/g, "''");
    const eventEsc = eventID.replace(/'/g, "''");

    const sql = `SELECT senderID, description, timestamp, isSentByMe FROM mx_reactions WHERE roomID = '${roomEsc}' AND eventID = '${eventEsc}' AND isDeleted = 0 ORDER BY timestamp DESC;`;

    const reactions = this.queryJson(sql);
    return {
      chatID,
      eventID,
      count: reactions.length,
      reactions: reactions.map((r: any) => ({
        sender: r.senderID,
        emoji: r.description,
        timestamp: r.timestamp ? new Date(parseInt(r.timestamp)).toISOString() : null,
        isSentByMe: r.isSentByMe === 1 || r.isSentByMe === '1',
      })),
    };
  }

  // ── Analytics ──────────────────────────────────────────────────────────

  async getChatAnalytics(chatID?: string, days: number = 30): Promise<unknown> {
    const cutoff = Date.now() - (days * 86400000);
    const chatFilter = chatID
      ? `AND m.roomID = '${chatID.replace(/'/g, "''")}'`
      : '';

    // Use a very tight rowid range to stay under timeout on 8.3M rows
    const idFilter = `AND m.id > (SELECT MAX(id) - 100000 FROM mx_room_messages)`;

    const totalSql = `SELECT COUNT(*) as total, SUM(CASE WHEN isSentByMe = 1 THEN 1 ELSE 0 END) as sent, SUM(CASE WHEN isSentByMe = 0 THEN 1 ELSE 0 END) as received FROM mx_room_messages m WHERE m.timestamp > ${cutoff} ${chatFilter} ${idFilter} AND m.type != 'HIDDEN';`;

    const totals = this.queryJson(totalSql);

    const result: any = {
      period: `Last ${days} days (recent messages sample)`,
      totals: totals[0] || { total: 0, sent: 0, received: 0 },
    };

    if (!chatID) {
      const topChatsSql = `SELECT m.roomID, json_extract(t.thread, '$.title') as title, t.accountID, COUNT(*) as msgCount FROM mx_room_messages m LEFT JOIN threads t ON t.threadID = m.roomID WHERE m.timestamp > ${cutoff} ${idFilter} AND m.type != 'HIDDEN' GROUP BY m.roomID ORDER BY msgCount DESC LIMIT 10;`;
      result.topChats = this.queryJson(topChatsSql).map((c: any) => ({
        chatID: c.roomID,
        title: c.title || '(untitled)',
        accountID: c.accountID,
        messageCount: parseInt(c.msgCount) || 0,
      }));
    }

    return result;
  }
}
