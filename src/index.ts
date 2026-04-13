#!/usr/bin/env node

/**
 * Garza MCP — Unified MCP Server
 * Combines ProtonMail (SMTP/IMAP via Proton Bridge), Proton Drive, iCloud Drive,
 * Beeper (unified messaging across WhatsApp, Telegram, Signal, iMessage, etc.),
 * and Fabric AI (memory/notes/search) into a single MCP server exposed over
 * stdio (wrapped by mcp-proxy for HTTP).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { ProtonMailConfig } from './types/index.js';
import { SMTPService } from './services/smtp-service.js';
import { IMAPService } from './services/imap-service.js';
import { DriveService } from './services/drive-service.js';
import { BeeperService } from './services/beeper-service.js';
import { BeeperDbService } from './services/beeper-db-service.js';
import { FabricService } from './services/fabric-service.js';
import { QuoService } from './services/quo-service.js';
import { VoicenotesService } from './services/voicenotes-service.js';
import { NextcloudService } from './services/nextcloud-service.js';
import { logger } from './utils/logger.js';
import { parseEmails } from './utils/helpers.js';

// ── Environment ──────────────────────────────────────────────────────────────
const PROTONMAIL_USERNAME = process.env.PROTONMAIL_USERNAME || '';
const PROTONMAIL_PASSWORD = process.env.PROTONMAIL_PASSWORD || '';
const PROTONMAIL_SMTP_HOST = process.env.PROTONMAIL_SMTP_HOST || '127.0.0.1';
const PROTONMAIL_SMTP_PORT = parseInt(process.env.PROTONMAIL_SMTP_PORT || '1025', 10);
const PROTONMAIL_IMAP_HOST = process.env.PROTONMAIL_IMAP_HOST || '127.0.0.1';
const PROTONMAIL_IMAP_PORT = parseInt(process.env.PROTONMAIL_IMAP_PORT || '1143', 10);
const PROTON_DRIVE_PATH = process.env.PROTON_DRIVE_PATH || '';
const ICLOUD_DRIVE_PATH = process.env.ICLOUD_DRIVE_PATH || '';
const BEEPER_API_URL = process.env.BEEPER_API_URL || 'http://localhost:23373';
const BEEPER_TOKEN = process.env.BEEPER_TOKEN || '';
const BEEPER_DB_PATH = process.env.BEEPER_DB_PATH || '/Users/customer/Library/Application Support/BeeperTexts/index.db';
const FABRIC_API_KEY = process.env.FABRIC_API_KEY || '';
const FABRIC_API_URL = process.env.FABRIC_API_URL || 'https://api.fabric.so';
const QUO_API_KEY = process.env.QUO_API_KEY || '';
const VOICENOTES_TOKEN = process.env.VOICENOTES_TOKEN || '';
const NEXTCLOUD_URL = process.env.NEXTCLOUD_URL || '';
const NEXTCLOUD_USERNAME = process.env.NEXTCLOUD_USERNAME || '';
const NEXTCLOUD_PASSWORD = process.env.NEXTCLOUD_PASSWORD || '';

const DEBUG = process.env.DEBUG === 'true';

logger.setDebugMode(DEBUG);

// Validate
if (!PROTONMAIL_USERNAME || !PROTONMAIL_PASSWORD) {
  console.error('[FATAL] PROTONMAIL_USERNAME and PROTONMAIL_PASSWORD are required');
  process.exit(1);
}
if (!PROTON_DRIVE_PATH) {
  console.error('[FATAL] PROTON_DRIVE_PATH is required');
  process.exit(1);
}
if (!ICLOUD_DRIVE_PATH) {
  console.error('[FATAL] ICLOUD_DRIVE_PATH is required');
  process.exit(1);
}
if (!BEEPER_TOKEN) {
  console.error('[FATAL] BEEPER_TOKEN is required');
  process.exit(1);
}

// ── Config ───────────────────────────────────────────────────────────────────
const mailConfig: ProtonMailConfig = {
  smtp: { host: PROTONMAIL_SMTP_HOST, port: PROTONMAIL_SMTP_PORT, secure: PROTONMAIL_SMTP_PORT === 465, username: PROTONMAIL_USERNAME, password: PROTONMAIL_PASSWORD },
  imap: { host: PROTONMAIL_IMAP_HOST, port: PROTONMAIL_IMAP_PORT, secure: false, username: PROTONMAIL_USERNAME, password: PROTONMAIL_PASSWORD },
  debug: DEBUG,
};

// ── Services ─────────────────────────────────────────────────────────────────
const smtp = new SMTPService(mailConfig);
const imap = new IMAPService(mailConfig);
const drive = new DriveService(PROTON_DRIVE_PATH, 'ProtonDrive');
const icloud = new DriveService(ICLOUD_DRIVE_PATH, 'iCloud');
const beeper = new BeeperService(BEEPER_API_URL, BEEPER_TOKEN);
const beeperDb = new BeeperDbService(BEEPER_DB_PATH);
const fabric = FABRIC_API_KEY ? new FabricService(FABRIC_API_KEY, FABRIC_API_URL) : null;
const quo = QUO_API_KEY ? new QuoService(QUO_API_KEY) : null;
const voicenotes = VOICENOTES_TOKEN ? new VoicenotesService(VOICENOTES_TOKEN) : null;
const nextcloud = (NEXTCLOUD_URL && NEXTCLOUD_USERNAME && NEXTCLOUD_PASSWORD) ? new NextcloudService(NEXTCLOUD_URL, NEXTCLOUD_USERNAME, NEXTCLOUD_PASSWORD) : null;

// ── MCP Server ───────────────────────────────────────────────────────────────
const server = new Server(
  { name: "garza-mcp", version: "6.0.0" },
  { capabilities: { tools: {} } },
);

// ── Helper to generate drive tool defs ───────────────────────────────────────
function driveToolDefs(prefix: string, label: string) {
  return [
    {
      name: `${prefix}_list`,
      description: `List files and folders in ${label}`,
      inputSchema: {
        type: "object" as const,
        properties: { path: { type: "string", description: `Relative path within ${label}`, default: "/" } },
      },
    },
    {
      name: `${prefix}_read`,
      description: `Read a file's contents from ${label}`,
      inputSchema: {
        type: "object" as const,
        properties: { path: { type: "string", description: "Relative file path" } },
        required: ["path"],
      },
    },
    {
      name: `${prefix}_write`,
      description: `Write/create a file in ${label}`,
      inputSchema: {
        type: "object" as const,
        properties: { path: { type: "string", description: "Relative file path" }, content: { type: "string", description: "File content (text)" } },
        required: ["path", "content"],
      },
    },
    {
      name: `${prefix}_mkdir`,
      description: `Create a new folder in ${label}`,
      inputSchema: {
        type: "object" as const,
        properties: { path: { type: "string", description: "Relative folder path" } },
        required: ["path"],
      },
    },
    {
      name: `${prefix}_delete`,
      description: `Delete a file or folder from ${label}`,
      inputSchema: {
        type: "object" as const,
        properties: { path: { type: "string", description: "Relative path to delete" } },
        required: ["path"],
      },
    },
    {
      name: `${prefix}_move`,
      description: `Move/rename a file or folder in ${label}`,
      inputSchema: {
        type: "object" as const,
        properties: { source: { type: "string", description: "Current relative path" }, destination: { type: "string", description: "New relative path" } },
        required: ["source", "destination"],
      },
    },
    {
      name: `${prefix}_info`,
      description: `Get detailed info about a file or folder in ${label}`,
      inputSchema: {
        type: "object" as const,
        properties: { path: { type: "string", description: "Relative path" } },
        required: ["path"],
      },
    },
    {
      name: `${prefix}_search`,
      description: `Search for files/folders by name in ${label}`,
      inputSchema: {
        type: "object" as const,
        properties: { query: { type: "string", description: "Search query (filename match)" }, path: { type: "string", description: "Directory to search in", default: "/" } },
        required: ["query"],
      },
    },
    {
      name: `${prefix}_stats`,
      description: `Get ${label} storage statistics`,
      inputSchema: { type: "object" as const, properties: {} },
    },
  ];
}

// ── Tool Definitions ─────────────────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ═══════════════════════════ MAIL TOOLS ═══════════════════════════
    {
      name: "mail_send",
      description: "Send an email via ProtonMail (SMTP through Proton Bridge)",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient(s), comma-separated" },
          subject: { type: "string", description: "Email subject" },
          body: { type: "string", description: "Email body (text or HTML)" },
          cc: { type: "string", description: "CC recipients" },
          bcc: { type: "string", description: "BCC recipients" },
          isHtml: { type: "boolean", description: "Treat body as HTML", default: false },
          replyTo: { type: "string", description: "Reply-to address" },
          priority: { type: "string", enum: ["high", "normal", "low"] },
        },
        required: ["to", "subject", "body"],
      },
    },
    {
      name: "mail_list",
      description: "List emails in a folder with pagination",
      inputSchema: {
        type: "object",
        properties: {
          folder: { type: "string", description: "Folder name", default: "INBOX" },
          limit: { type: "number", description: "Max emails", default: 20 },
          offset: { type: "number", description: "Offset for pagination", default: 0 },
        },
      },
    },
    {
      name: "mail_read",
      description: "Read a specific email by UID (full body)",
      inputSchema: {
        type: "object",
        properties: {
          emailId: { type: "string", description: "Email UID" },
          folder: { type: "string", description: "Folder", default: "INBOX" },
        },
        required: ["emailId"],
      },
    },
    {
      name: "mail_search",
      description: "Search emails by query (subject/sender match)",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          folder: { type: "string", description: "Folder", default: "INBOX" },
          limit: { type: "number", description: "Max results", default: 20 },
        },
        required: ["query"],
      },
    },
    {
      name: "mail_folders",
      description: "List all email folders",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "mail_mark_read",
      description: "Mark an email as read or unread",
      inputSchema: {
        type: "object",
        properties: {
          emailId: { type: "string", description: "Email UID" },
          isRead: { type: "boolean", description: "True=read, false=unread", default: true },
          folder: { type: "string", default: "INBOX" },
        },
        required: ["emailId"],
      },
    },
    {
      name: "mail_star",
      description: "Star or unstar an email",
      inputSchema: {
        type: "object",
        properties: {
          emailId: { type: "string", description: "Email UID" },
          isStarred: { type: "boolean", default: true },
          folder: { type: "string", default: "INBOX" },
        },
        required: ["emailId"],
      },
    },
    {
      name: "mail_move",
      description: "Move an email to a different folder",
      inputSchema: {
        type: "object",
        properties: {
          emailId: { type: "string", description: "Email UID" },
          targetFolder: { type: "string", description: "Destination folder" },
          folder: { type: "string", default: "INBOX" },
        },
        required: ["emailId", "targetFolder"],
      },
    },
    {
      name: "mail_delete",
      description: "Delete an email permanently",
      inputSchema: {
        type: "object",
        properties: {
          emailId: { type: "string", description: "Email UID" },
          folder: { type: "string", default: "INBOX" },
        },
        required: ["emailId"],
      },
    },
    {
      name: "mail_stats",
      description: "Get inbox statistics (total, unread, folder count)",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "mail_status",
      description: "Check SMTP/IMAP connection status",
      inputSchema: { type: "object", properties: {} },
    },

    // ═══════════════════════════ PROTON DRIVE ═════════════════════════
    ...driveToolDefs("drive", "Proton Drive"),

    // ═══════════════════════════ ICLOUD DRIVE ═════════════════════════
    ...driveToolDefs("icloud", "iCloud Drive"),

    // ═══════════════════════════ BEEPER (MESSAGING + DATABASE) ═════
    {
      name: "beeper_list_accounts",
      description: "List all connected messaging accounts (WhatsApp, Telegram, Signal, iMessage, Slack, Discord, etc.)",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "beeper_list_chats",
      description: "List chats/conversations across all messaging platforms. Supports pagination and unread filter.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max chats to return (default: 30)" },
          offset: { type: "number", description: "Skip N chats for pagination" },
          unreadOnly: { type: "boolean", description: "Only return chats with unread messages" },
          service: { type: "string", description: "Filter by service: whatsapp, telegram, signal, imessage, slack, discord, etc." },
        },
      },
    },
    {
      name: "beeper_search_chats",
      description: "Search for chats/conversations by name or keyword",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "Search query" } },
        required: ["query"],
      },
    },
    {
      name: "beeper_get_chat",
      description: "Get details of a specific chat including participants",
      inputSchema: {
        type: "object",
        properties: { chatID: { type: "string", description: "The chat ID" } },
        required: ["chatID"],
      },
    },
    {
      name: "beeper_get_messages",
      description: "Get messages from a specific chat",
      inputSchema: {
        type: "object",
        properties: {
          chatID: { type: "string", description: "The chat ID" },
          limit: { type: "number", description: "Max messages to return (default: 50)" },
          before: { type: "string", description: "Get messages before this message ID" },
        },
        required: ["chatID"],
      },
    },
    {
      name: "beeper_search_messages",
      description: "Search messages across ALL Beeper networks (WhatsApp, Telegram, Signal, iMessage, etc.)",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          limit: { type: "number", description: "Max results (default: 20)" },
        },
        required: ["query"],
      },
    },
    {
      name: "beeper_send_message",
      description: "Send a text message to a chat on any connected platform",
      inputSchema: {
        type: "object",
        properties: {
          chatID: { type: "string", description: "The chat ID to send to" },
          text: { type: "string", description: "Message text" },
          replyTo: { type: "string", description: "Optional: message ID to reply to" },
        },
        required: ["chatID", "text"],
      },
    },
    {
      name: "beeper_mark_read",
      description: "Mark messages in a chat as read",
      inputSchema: {
        type: "object",
        properties: {
          chatID: { type: "string", description: "The chat ID" },
          upToMessageID: { type: "string", description: "Mark read up to this message ID" },
        },
        required: ["chatID"],
      },
    },
    {
      name: "beeper_add_reaction",
      description: "Add an emoji reaction to a message",
      inputSchema: {
        type: "object",
        properties: {
          chatID: { type: "string", description: "The chat ID" },
          messageID: { type: "string", description: "The message ID" },
          emoji: { type: "string", description: "The emoji to react with" },
        },
        required: ["chatID", "messageID", "emoji"],
      },
    },
    {
      name: "beeper_create_chat",
      description: "Create a new chat on a specific messaging platform",
      inputSchema: {
        type: "object",
        properties: {
          accountID: { type: "string", description: "The account ID (e.g. whatsapp-abc123)" },
          participantIDs: { type: "array", items: { type: "string" }, description: "Phone numbers or user IDs" },
          type: { type: "string", description: "Chat type: 'single' or 'group'", enum: ["single", "group"] },
        },
        required: ["accountID", "participantIDs"],
      },
    },
    {
      name: "beeper_archive_chat",
      description: "Archive or unarchive a chat",
      inputSchema: {
        type: "object",
        properties: {
          chatID: { type: "string", description: "The chat ID" },
          archived: { type: "boolean", description: "true to archive, false to unarchive" },
        },
        required: ["chatID", "archived"],
      },
    },
    {
      name: "beeper_search_contacts",
      description: "Search contacts on a specific account",
      inputSchema: {
        type: "object",
        properties: {
          accountID: { type: "string", description: "The account ID" },
          query: { type: "string", description: "Search query (name or phone)" },
        },
        required: ["accountID", "query"],
      },
    },
    {
      name: "beeper_set_reminder",
      description: "Set a reminder for a chat",
      inputSchema: {
        type: "object",
        properties: {
          chatID: { type: "string", description: "The chat ID" },
          remindAt: { type: "string", description: "ISO 8601 datetime for the reminder" },
        },
        required: ["chatID", "remindAt"],
      },
    },
    {
      name: "beeper_get_unread_summary",
      description: "Get a summary of all unread messages across all networks — perfect for morning briefings",
      inputSchema: { type: "object", properties: {} },
    },

    // ── Beeper Database (local SQLite — 8M+ messages, FTS) ────────────────
    {
      name: "beeper_db_stats",
      description: "Get statistics about the local Beeper chat database (total threads, messages, participants, date range)",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "beeper_db_search",
      description: "Full-text search across 8M+ messages in the local Beeper database — much faster than API search",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query (supports FTS5 syntax)" },
          limit: { type: "number", description: "Max results (default: 20)" },
          chatID: { type: "string", description: "Optional: restrict search to a specific chat" },
        },
        required: ["query"],
      },
    },
    {
      name: "beeper_db_history",
      description: "Get chat message history from the local database — fast access to full conversation history",
      inputSchema: {
        type: "object",
        properties: {
          chatID: { type: "string", description: "The chat/room ID" },
          limit: { type: "number", description: "Max messages (default: 50)" },
          before: { type: "number", description: "Get messages before this timestamp (ms)" },
        },
        required: ["chatID"],
      },
    },
    {
      name: "beeper_db_threads",
      description: "List all chat threads from the local database with message counts",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max threads (default: 50)" },
          accountID: { type: "string", description: "Filter by account (e.g. telegram, whatsapp, slackgo.xxx)" },
        },
      },
    },
    {
      name: "beeper_db_participants",
      description: "Get participants of a specific chat from the local database",
      inputSchema: {
        type: "object",
        properties: {
          chatID: { type: "string", description: "The chat/room ID" },
        },
        required: ["chatID"],
      },
    },
    {
      name: "beeper_db_contacts",
      description: "Search contacts across all chats in the local database by name",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search by name, nickname, or ID" },
          limit: { type: "number", description: "Max results (default: 20)" },
        },
        required: ["query"],
      },
    },
    {
      name: "beeper_db_reactions",
      description: "Get all reactions on a specific message from the local database",
      inputSchema: {
        type: "object",
        properties: {
          chatID: { type: "string", description: "The chat/room ID" },
          eventID: { type: "string", description: "The message event ID" },
        },
        required: ["chatID", "eventID"],
      },
    },
    {
      name: "beeper_db_analytics",
      description: "Get messaging analytics — message counts, top chats, sent vs received, by type",
      inputSchema: {
        type: "object",
        properties: {
          chatID: { type: "string", description: "Optional: analytics for a specific chat" },
          days: { type: "number", description: "Number of days to analyze (default: 30)" },
        },
      },
    },

    // ═══════════════════════════ FABRIC AI (MEMORY/NOTES) ══════════════
    ...(fabric ? [
      {
        name: "fabric_search",
        description: "Semantic search across Fabric AI knowledge base — find memories, notes, and documents",
        inputSchema: {
          type: "object" as const,
          properties: {
            query: { type: "string", description: "Search query" },
            limit: { type: "number", description: "Max results (default: 10)" },
          },
          required: ["query"],
        },
      },
      {
        name: "fabric_add_memory",
        description: "Add a new memory/fact to Fabric AI for future retrieval",
        inputSchema: {
          type: "object" as const,
          properties: {
            content: { type: "string", description: "Memory text content" },
          },
          required: ["content"],
        },
      },
      {
        name: "fabric_recall_memories",
        description: "Recall memories from Fabric AI by semantic search query",
        inputSchema: {
          type: "object" as const,
          properties: {
            query: { type: "string", description: "Search query to recall relevant memories" },
            limit: { type: "number", description: "Max results (default: 20)" },
          },
          required: ["query"],
        },
      },
      {
        name: "fabric_create_note",
        description: "Create a new notepad/document in Fabric AI",
        inputSchema: {
          type: "object" as const,
          properties: {
            text: { type: "string", description: "Markdown content for the note" },
            parentId: { type: "string", description: "Parent folder ID (default: Agent Handoff folder)" },
          },
          required: ["text"],
        },
      },
      {
        name: "fabric_list_notes",
        description: "List notepads/documents in a Fabric AI folder",
        inputSchema: {
          type: "object" as const,
          properties: {
            parentId: { type: "string", description: "Folder ID (default: Agent Handoff folder)" },
          },
        },
      },
      {
        name: "fabric_get_note",
        description: "Get a specific notepad/document from Fabric AI by ID",
        inputSchema: {
          type: "object" as const,
          properties: {
            notepadId: { type: "string", description: "Notepad ID" },
          },
          required: ["notepadId"],
        },
      },
      {
        name: "fabric_update_note",
        description: "Update an existing notepad in Fabric AI",
        inputSchema: {
          type: "object" as const,
          properties: {
            notepadId: { type: "string", description: "Notepad ID" },
            text: { type: "string", description: "New markdown content" },
          },
          required: ["notepadId", "text"],
        },
      },
      {
        name: "fabric_delete_note",
        description: "Delete a notepad from Fabric AI",
        inputSchema: {
          type: "object" as const,
          properties: {
            notepadId: { type: "string", description: "Notepad ID" },
          },
          required: ["notepadId"],
        },
      },
    ] : []),

    // ═══════════════════════════ QUO (PHONE / SMS / CALLS) ═════════════════
    ...(quo ? [
      {
        name: "quo_list_numbers",
        description: "List all phone numbers in the Quo (OpenPhone) workspace",
        inputSchema: { type: "object" as const, properties: {} },
      },
      {
        name: "quo_send_message",
        description: "Send an SMS/text message from a Quo phone number",
        inputSchema: {
          type: "object" as const,
          properties: {
            from: { type: "string", description: "Quo phone number ID to send from" },
            to: { type: "string", description: "Recipient phone number (E.164 format, e.g. +12125551234)" },
            content: { type: "string", description: "Message text" },
          },
          required: ["from", "to", "content"],
        },
      },
      {
        name: "quo_list_messages",
        description: "List text messages between a Quo number and participant(s)",
        inputSchema: {
          type: "object" as const,
          properties: {
            phoneNumberId: { type: "string", description: "Quo phone number ID" },
            participants: { type: "array", items: { type: "string" }, description: "Participant phone numbers (E.164)" },
            maxResults: { type: "number", description: "Max messages to return" },
          },
          required: ["phoneNumberId", "participants"],
        },
      },
      {
        name: "quo_get_message",
        description: "Get a specific text message by ID",
        inputSchema: {
          type: "object" as const,
          properties: {
            messageId: { type: "string", description: "Message ID" },
          },
          required: ["messageId"],
        },
      },
      {
        name: "quo_list_calls",
        description: "List calls between a Quo number and participant(s)",
        inputSchema: {
          type: "object" as const,
          properties: {
            phoneNumberId: { type: "string", description: "Quo phone number ID" },
            participants: { type: "array", items: { type: "string" }, description: "Participant phone numbers (E.164)" },
            maxResults: { type: "number", description: "Max calls to return" },
          },
          required: ["phoneNumberId", "participants"],
        },
      },
      {
        name: "quo_get_call",
        description: "Get details of a specific call by ID",
        inputSchema: {
          type: "object" as const,
          properties: {
            callId: { type: "string", description: "Call ID" },
          },
          required: ["callId"],
        },
      },
      {
        name: "quo_call_summary",
        description: "Get AI-generated summary of a call",
        inputSchema: {
          type: "object" as const,
          properties: {
            callId: { type: "string", description: "Call ID" },
          },
          required: ["callId"],
        },
      },
      {
        name: "quo_call_transcript",
        description: "Get the full transcript of a call",
        inputSchema: {
          type: "object" as const,
          properties: {
            callId: { type: "string", description: "Call ID" },
          },
          required: ["callId"],
        },
      },
      {
        name: "quo_voicemail",
        description: "Get voicemail for a specific call",
        inputSchema: {
          type: "object" as const,
          properties: {
            callId: { type: "string", description: "Call ID" },
          },
          required: ["callId"],
        },
      },
      {
        name: "quo_call_recordings",
        description: "Get recordings for a specific call",
        inputSchema: {
          type: "object" as const,
          properties: {
            callId: { type: "string", description: "Call ID" },
          },
          required: ["callId"],
        },
      },
      {
        name: "quo_list_contacts",
        description: "List contacts in the Quo workspace",
        inputSchema: {
          type: "object" as const,
          properties: {
            page: { type: "number", description: "Page number" },
          },
        },
      },
      {
        name: "quo_get_contact",
        description: "Get a specific contact by ID",
        inputSchema: {
          type: "object" as const,
          properties: {
            contactId: { type: "string", description: "Contact ID" },
          },
          required: ["contactId"],
        },
      },
      {
        name: "quo_create_contact",
        description: "Create a new contact in Quo",
        inputSchema: {
          type: "object" as const,
          properties: {
            firstName: { type: "string", description: "First name" },
            lastName: { type: "string", description: "Last name" },
            company: { type: "string", description: "Company name" },
            role: { type: "string", description: "Role/title" },
            phone: { type: "string", description: "Phone number (E.164)" },
            email: { type: "string", description: "Email address" },
          },
          required: ["firstName"],
        },
      },
      {
        name: "quo_update_contact",
        description: "Update an existing contact in Quo",
        inputSchema: {
          type: "object" as const,
          properties: {
            contactId: { type: "string", description: "Contact ID" },
            firstName: { type: "string", description: "First name" },
            lastName: { type: "string", description: "Last name" },
            company: { type: "string", description: "Company" },
            role: { type: "string", description: "Role/title" },
          },
          required: ["contactId"],
        },
      },
      {
        name: "quo_delete_contact",
        description: "Delete a contact from Quo",
        inputSchema: {
          type: "object" as const,
          properties: {
            contactId: { type: "string", description: "Contact ID" },
          },
          required: ["contactId"],
        },
      },
      {
        name: "quo_list_conversations",
        description: "List conversations (SMS threads) in Quo",
        inputSchema: {
          type: "object" as const,
          properties: {
            phoneNumberId: { type: "string", description: "Filter by Quo phone number ID" },
            maxResults: { type: "number", description: "Max conversations to return" },
          },
        },
      },
      {
        name: "quo_list_users",
        description: "List users in the Quo workspace",
        inputSchema: { type: "object" as const, properties: {} },
      },
    ] : []),

    // ═══════════════════════════ VOICENOTES ═══════════════════════════
    ...(voicenotes ? [
      {
        name: "voicenotes_user",
        description: "Get Voicenotes user/account information",
        inputSchema: { type: "object" as const, properties: {} },
      },
      {
        name: "voicenotes_list",
        description: "List voice note recordings (syncs from Voicenotes.com). Returns recordings with transcripts, tags, and AI creations.",
        inputSchema: {
          type: "object" as const,
          properties: {
            since: { type: "string", description: "ISO timestamp — only return notes updated after this date (optional)" },
          },
        },
      },
      {
        name: "voicenotes_search",
        description: "Search voice notes by keyword across titles, transcripts, tags, and AI creations",
        inputSchema: {
          type: "object" as const,
          properties: {
            query: { type: "string", description: "Search keyword" },
            limit: { type: "number", description: "Max results (default: 20)" },
          },
          required: ["query"],
        },
      },
      {
        name: "voicenotes_audio_url",
        description: "Get a signed download URL for a voice note's audio file",
        inputSchema: {
          type: "object" as const,
          properties: {
            recordingId: { type: "string", description: "Recording ID" },
          },
          required: ["recordingId"],
        },
      },
    ] : []),

    // ═══════════════════════════ NEXTCLOUD ═══════════════════════════
    ...(nextcloud ? [
      // ── Notes ──
      { name: "nc_notes_list", description: "List all Nextcloud notes, optionally filtered by category", inputSchema: { type: "object" as const, properties: { category: { type: "string", description: "Filter by category (optional)" } } } },
      { name: "nc_notes_get", description: "Get a specific Nextcloud note by ID", inputSchema: { type: "object" as const, properties: { noteId: { type: "number", description: "Note ID" } }, required: ["noteId"] } },
      { name: "nc_notes_create", description: "Create a new Nextcloud note", inputSchema: { type: "object" as const, properties: { title: { type: "string", description: "Note title" }, content: { type: "string", description: "Note content (Markdown)" }, category: { type: "string", description: "Category (optional)" } }, required: ["title", "content"] } },
      { name: "nc_notes_update", description: "Update an existing Nextcloud note", inputSchema: { type: "object" as const, properties: { noteId: { type: "number", description: "Note ID" }, title: { type: "string" }, content: { type: "string" }, category: { type: "string" } }, required: ["noteId"] } },
      { name: "nc_notes_delete", description: "Delete a Nextcloud note", inputSchema: { type: "object" as const, properties: { noteId: { type: "number", description: "Note ID" } }, required: ["noteId"] } },
      { name: "nc_notes_search", description: "Search Nextcloud notes by keyword (searches title, content, category)", inputSchema: { type: "object" as const, properties: { query: { type: "string", description: "Search keyword" } }, required: ["query"] } },

      // ── Calendar ──
      { name: "nc_calendar_list", description: "List all Nextcloud calendars", inputSchema: { type: "object" as const, properties: {} } },
      { name: "nc_calendar_get_events", description: "Get calendar events within a date range", inputSchema: { type: "object" as const, properties: { calendarId: { type: "string", description: "Calendar ID (default: personal)" }, startDate: { type: "string", description: "Start date YYYY-MM-DD (default: today)" }, endDate: { type: "string", description: "End date YYYY-MM-DD (default: 30 days from now)" } } } },
      { name: "nc_calendar_create_event", description: "Create a new calendar event", inputSchema: { type: "object" as const, properties: { summary: { type: "string", description: "Event title" }, startDateTime: { type: "string", description: "Start ISO datetime" }, endDateTime: { type: "string", description: "End ISO datetime" }, calendarId: { type: "string", description: "Calendar ID (default: personal)" }, description: { type: "string" }, location: { type: "string" } }, required: ["summary", "startDateTime", "endDateTime"] } },
      { name: "nc_calendar_delete_event", description: "Delete a calendar event", inputSchema: { type: "object" as const, properties: { calendarId: { type: "string", description: "Calendar ID" }, eventUid: { type: "string", description: "Event UID" } }, required: ["calendarId", "eventUid"] } },

      // ── Tasks (VTODO) ──
      { name: "nc_task_lists", description: "List all Nextcloud task lists (CalDAV VTODO-capable calendars)", inputSchema: { type: "object" as const, properties: {} } },
      { name: "nc_task_get_tasks", description: "Get tasks from Nextcloud, optionally filtered by list and status", inputSchema: { type: "object" as const, properties: { listId: { type: "string", description: "Task list ID (default: all lists)" }, status: { type: "string", enum: ["all", "open", "completed"], description: "Filter by status" } } } },
      { name: "nc_task_create", description: "Create a new task in Nextcloud", inputSchema: { type: "object" as const, properties: { summary: { type: "string", description: "Task title" }, listId: { type: "string", description: "Task list (default: personal)" }, description: { type: "string" }, due: { type: "string", description: "Due date YYYY-MM-DD" }, priority: { type: "number", description: "Priority 1-9 (1=highest)" } }, required: ["summary"] } },

      // ── Contacts (CardDAV) ──
      { name: "nc_contacts_list_addressbooks", description: "List all Nextcloud address books", inputSchema: { type: "object" as const, properties: {} } },
      { name: "nc_contacts_list", description: "List contacts from a Nextcloud address book", inputSchema: { type: "object" as const, properties: { addressbookId: { type: "string", description: "Address book ID (default: contacts)" } } } },
      { name: "nc_contacts_create", description: "Create a new contact in Nextcloud", inputSchema: { type: "object" as const, properties: { fullName: { type: "string", description: "Full name" }, addressbookId: { type: "string", description: "Address book (default: contacts)" }, email: { type: "string" }, phone: { type: "string" }, org: { type: "string", description: "Organization" } }, required: ["fullName"] } },
      { name: "nc_contacts_delete", description: "Delete a contact from Nextcloud", inputSchema: { type: "object" as const, properties: { addressbookId: { type: "string", description: "Address book ID" }, contactUid: { type: "string", description: "Contact UID (from .vcf filename)" } }, required: ["addressbookId", "contactUid"] } },
      { name: "nc_contacts_search", description: "Search contacts by name, email, phone, or org", inputSchema: { type: "object" as const, properties: { query: { type: "string", description: "Search query" } }, required: ["query"] } },

      // ── Files (WebDAV) ──
      { name: "nc_files_list", description: "List files and folders in a Nextcloud directory", inputSchema: { type: "object" as const, properties: { path: { type: "string", description: "Directory path (default: /)", default: "/" } } } },
      { name: "nc_files_read", description: "Read a file's content from Nextcloud", inputSchema: { type: "object" as const, properties: { path: { type: "string", description: "File path" } }, required: ["path"] } },
      { name: "nc_files_write", description: "Write/create a file in Nextcloud", inputSchema: { type: "object" as const, properties: { path: { type: "string", description: "File path" }, content: { type: "string", description: "File content" } }, required: ["path", "content"] } },
      { name: "nc_files_mkdir", description: "Create a directory in Nextcloud", inputSchema: { type: "object" as const, properties: { path: { type: "string", description: "Directory path" } }, required: ["path"] } },
      { name: "nc_files_delete", description: "Delete a file or directory in Nextcloud", inputSchema: { type: "object" as const, properties: { path: { type: "string", description: "Path to delete" } }, required: ["path"] } },
      { name: "nc_files_move", description: "Move or rename a file/folder in Nextcloud", inputSchema: { type: "object" as const, properties: { source: { type: "string", description: "Source path" }, destination: { type: "string", description: "Destination path" } }, required: ["source", "destination"] } },
      { name: "nc_files_copy", description: "Copy a file or directory in Nextcloud", inputSchema: { type: "object" as const, properties: { source: { type: "string", description: "Source path" }, destination: { type: "string", description: "Destination path" } }, required: ["source", "destination"] } },
      { name: "nc_files_search", description: "Search for files by name in Nextcloud", inputSchema: { type: "object" as const, properties: { query: { type: "string", description: "Search query (filename match)" }, path: { type: "string", description: "Directory to search in" } }, required: ["query"] } },
      { name: "nc_files_favorites", description: "List favorite files in Nextcloud", inputSchema: { type: "object" as const, properties: {} } },

      // ── Trashbin ──
      { name: "nc_trash_list", description: "List files in the Nextcloud trash bin", inputSchema: { type: "object" as const, properties: {} } },
      { name: "nc_trash_restore", description: "Restore a file from Nextcloud trash", inputSchema: { type: "object" as const, properties: { trashPath: { type: "string", description: "Trash item path" } }, required: ["trashPath"] } },
      { name: "nc_trash_delete", description: "Permanently delete a file from Nextcloud trash", inputSchema: { type: "object" as const, properties: { trashPath: { type: "string", description: "Trash item path" } }, required: ["trashPath"] } },
      { name: "nc_trash_empty", description: "Empty the entire Nextcloud trash bin", inputSchema: { type: "object" as const, properties: {} } },

      // ── Deck (Kanban) ──
      { name: "nc_deck_list_boards", description: "List all Nextcloud Deck boards", inputSchema: { type: "object" as const, properties: {} } },
      { name: "nc_deck_get_board", description: "Get a specific Deck board with details", inputSchema: { type: "object" as const, properties: { boardId: { type: "number", description: "Board ID" } }, required: ["boardId"] } },
      { name: "nc_deck_create_board", description: "Create a new Deck board", inputSchema: { type: "object" as const, properties: { title: { type: "string", description: "Board title" }, color: { type: "string", description: "Hex color (default: 0800fd)" } }, required: ["title"] } },
      { name: "nc_deck_delete_board", description: "Delete a Deck board", inputSchema: { type: "object" as const, properties: { boardId: { type: "number", description: "Board ID" } }, required: ["boardId"] } },
      { name: "nc_deck_list_stacks", description: "List stacks (columns) in a Deck board", inputSchema: { type: "object" as const, properties: { boardId: { type: "number", description: "Board ID" } }, required: ["boardId"] } },
      { name: "nc_deck_create_stack", description: "Create a new stack (column) in a Deck board", inputSchema: { type: "object" as const, properties: { boardId: { type: "number", description: "Board ID" }, title: { type: "string", description: "Stack title" }, order: { type: "number" } }, required: ["boardId", "title"] } },
      { name: "nc_deck_create_card", description: "Create a new card in a Deck stack", inputSchema: { type: "object" as const, properties: { boardId: { type: "number" }, stackId: { type: "number" }, title: { type: "string", description: "Card title" }, description: { type: "string" }, duedate: { type: "string", description: "Due date YYYY-MM-DD" } }, required: ["boardId", "stackId", "title"] } },
      { name: "nc_deck_update_card", description: "Update a Deck card", inputSchema: { type: "object" as const, properties: { boardId: { type: "number" }, stackId: { type: "number" }, cardId: { type: "number" }, title: { type: "string" }, description: { type: "string" }, duedate: { type: "string" } }, required: ["boardId", "stackId", "cardId"] } },
      { name: "nc_deck_delete_card", description: "Delete a Deck card", inputSchema: { type: "object" as const, properties: { boardId: { type: "number" }, stackId: { type: "number" }, cardId: { type: "number" } }, required: ["boardId", "stackId", "cardId"] } },
      { name: "nc_deck_move_card", description: "Move a card to a different stack", inputSchema: { type: "object" as const, properties: { boardId: { type: "number" }, stackId: { type: "number", description: "Current stack" }, cardId: { type: "number" }, targetStackId: { type: "number", description: "Target stack" } }, required: ["boardId", "stackId", "cardId", "targetStackId"] } },
      { name: "nc_deck_assign_label", description: "Assign a label to a Deck card", inputSchema: { type: "object" as const, properties: { boardId: { type: "number" }, stackId: { type: "number" }, cardId: { type: "number" }, labelId: { type: "number" } }, required: ["boardId", "stackId", "cardId", "labelId"] } },
      { name: "nc_deck_assign_user", description: "Assign a user to a Deck card", inputSchema: { type: "object" as const, properties: { boardId: { type: "number" }, stackId: { type: "number" }, cardId: { type: "number" }, userId: { type: "string" } }, required: ["boardId", "stackId", "cardId", "userId"] } },
      { name: "nc_deck_create_label", description: "Create a label on a Deck board", inputSchema: { type: "object" as const, properties: { boardId: { type: "number" }, title: { type: "string" }, color: { type: "string", description: "Hex color" } }, required: ["boardId", "title"] } },

      // ── Tables ──
      { name: "nc_tables_list", description: "List all Nextcloud Tables", inputSchema: { type: "object" as const, properties: {} } },
      { name: "nc_tables_get", description: "Get a specific Nextcloud Table", inputSchema: { type: "object" as const, properties: { tableId: { type: "number" } }, required: ["tableId"] } },
      { name: "nc_tables_get_columns", description: "Get columns/schema of a Nextcloud Table", inputSchema: { type: "object" as const, properties: { tableId: { type: "number" } }, required: ["tableId"] } },
      { name: "nc_tables_get_rows", description: "Get rows from a Nextcloud Table", inputSchema: { type: "object" as const, properties: { tableId: { type: "number" }, limit: { type: "number", default: 50 }, offset: { type: "number", default: 0 } }, required: ["tableId"] } },
      { name: "nc_tables_create_row", description: "Insert a new row into a Nextcloud Table", inputSchema: { type: "object" as const, properties: { tableId: { type: "number" }, data: { type: "object", description: "Column ID to value mapping" } }, required: ["tableId", "data"] } },
      { name: "nc_tables_update_row", description: "Update a row in a Nextcloud Table", inputSchema: { type: "object" as const, properties: { rowId: { type: "number" }, data: { type: "object", description: "Column ID to value mapping" } }, required: ["rowId", "data"] } },
      { name: "nc_tables_delete_row", description: "Delete a row from a Nextcloud Table", inputSchema: { type: "object" as const, properties: { rowId: { type: "number" } }, required: ["rowId"] } },

      // ── Sharing ──
      { name: "nc_shares_list", description: "List file/folder shares in Nextcloud", inputSchema: { type: "object" as const, properties: { path: { type: "string", description: "File/folder path to list shares for (optional)" } } } },
      { name: "nc_shares_get", description: "Get details of a specific share", inputSchema: { type: "object" as const, properties: { shareId: { type: "number" } }, required: ["shareId"] } },
      { name: "nc_shares_create", description: "Create a new share (0=user, 1=group, 3=public link, 4=email, 6=federated)", inputSchema: { type: "object" as const, properties: { path: { type: "string", description: "File/folder path" }, shareType: { type: "number", description: "0=user, 1=group, 3=public, 4=email, 6=federated" }, shareWith: { type: "string", description: "User/group/email to share with" }, permissions: { type: "number", description: "1=read, 2=update, 4=create, 8=delete, 16=share, 31=all" }, password: { type: "string" }, expireDate: { type: "string", description: "YYYY-MM-DD" } }, required: ["path", "shareType"] } },
      { name: "nc_shares_update", description: "Update a share's permissions/password/expiration", inputSchema: { type: "object" as const, properties: { shareId: { type: "number" }, permissions: { type: "number" }, password: { type: "string" }, expireDate: { type: "string" } }, required: ["shareId"] } },
      { name: "nc_shares_delete", description: "Delete a share", inputSchema: { type: "object" as const, properties: { shareId: { type: "number" } }, required: ["shareId"] } },

      // ── Talk (Spreed) ──
      { name: "nc_talk_list_conversations", description: "List all Nextcloud Talk conversations", inputSchema: { type: "object" as const, properties: {} } },
      { name: "nc_talk_get_conversation", description: "Get details of a Talk conversation", inputSchema: { type: "object" as const, properties: { token: { type: "string", description: "Conversation token" } }, required: ["token"] } },
      { name: "nc_talk_create_conversation", description: "Create a new Talk conversation (1=one-to-one, 2=group, 3=public)", inputSchema: { type: "object" as const, properties: { roomType: { type: "number", description: "1=one-to-one, 2=group, 3=public" }, roomName: { type: "string", description: "Conversation name" }, invite: { type: "string", description: "User ID to invite" } }, required: ["roomType", "roomName"] } },
      { name: "nc_talk_get_messages", description: "Get messages from a Talk conversation", inputSchema: { type: "object" as const, properties: { token: { type: "string", description: "Conversation token" }, limit: { type: "number", default: 100 } }, required: ["token"] } },
      { name: "nc_talk_send_message", description: "Send a message in a Talk conversation", inputSchema: { type: "object" as const, properties: { token: { type: "string", description: "Conversation token" }, message: { type: "string" }, replyTo: { type: "number", description: "Message ID to reply to" } }, required: ["token", "message"] } },
      { name: "nc_talk_delete_message", description: "Delete a message from Talk", inputSchema: { type: "object" as const, properties: { token: { type: "string" }, messageId: { type: "number" } }, required: ["token", "messageId"] } },
      { name: "nc_talk_get_participants", description: "Get participants of a Talk conversation", inputSchema: { type: "object" as const, properties: { token: { type: "string" } }, required: ["token"] } },
      { name: "nc_talk_create_poll", description: "Create a poll in a Talk conversation", inputSchema: { type: "object" as const, properties: { token: { type: "string" }, question: { type: "string" }, options: { type: "array", items: { type: "string" }, description: "Poll options" }, maxVotes: { type: "number", default: 1 } }, required: ["token", "question", "options"] } },
      { name: "nc_talk_vote_poll", description: "Vote on a Talk poll", inputSchema: { type: "object" as const, properties: { token: { type: "string" }, pollId: { type: "number" }, optionIds: { type: "array", items: { type: "number" } } }, required: ["token", "pollId", "optionIds"] } },
      { name: "nc_talk_close_poll", description: "Close a Talk poll", inputSchema: { type: "object" as const, properties: { token: { type: "string" }, pollId: { type: "number" } }, required: ["token", "pollId"] } },

      // ── Notifications ──
      { name: "nc_notifications_list", description: "List all Nextcloud notifications", inputSchema: { type: "object" as const, properties: {} } },
      { name: "nc_notifications_dismiss", description: "Dismiss a specific notification", inputSchema: { type: "object" as const, properties: { notificationId: { type: "number" } }, required: ["notificationId"] } },
      { name: "nc_notifications_dismiss_all", description: "Dismiss all notifications", inputSchema: { type: "object" as const, properties: {} } },

      // ── Activity ──
      { name: "nc_activity", description: "Get recent Nextcloud activity feed", inputSchema: { type: "object" as const, properties: { limit: { type: "number", default: 50 }, sinceId: { type: "number", description: "Only activities after this ID" } } } },

      // ── Users ──
      { name: "nc_users_current", description: "Get current Nextcloud user info", inputSchema: { type: "object" as const, properties: {} } },
      { name: "nc_users_list", description: "List Nextcloud users", inputSchema: { type: "object" as const, properties: { search: { type: "string" }, limit: { type: "number" } } } },
      { name: "nc_users_get", description: "Get a specific Nextcloud user's info", inputSchema: { type: "object" as const, properties: { userId: { type: "string" } }, required: ["userId"] } },

      // ── User Status ──
      { name: "nc_status_get", description: "Get a user's status (or your own)", inputSchema: { type: "object" as const, properties: { userId: { type: "string", description: "User ID (optional, default: current user)" } } } },
      { name: "nc_status_set", description: "Set your Nextcloud user status", inputSchema: { type: "object" as const, properties: { statusType: { type: "string", enum: ["online", "away", "dnd", "invisible", "offline"], description: "Status type" }, message: { type: "string", description: "Custom status message" }, icon: { type: "string", description: "Status emoji icon" } }, required: ["statusType"] } },
      { name: "nc_status_clear", description: "Clear your Nextcloud user status", inputSchema: { type: "object" as const, properties: {} } },

      // ── Search ──
      { name: "nc_search_providers", description: "List available Nextcloud search providers", inputSchema: { type: "object" as const, properties: {} } },
      { name: "nc_search", description: "Unified search across Nextcloud (files, calendar, contacts, etc.)", inputSchema: { type: "object" as const, properties: { providerId: { type: "string", description: "Search provider ID (e.g. files, calendar, contacts)" }, query: { type: "string", description: "Search query" }, limit: { type: "number", default: 20 } }, required: ["providerId", "query"] } },

      // ── Mail (Nextcloud Mail app) ──
      { name: "nc_mail_accounts", description: "List Nextcloud Mail accounts", inputSchema: { type: "object" as const, properties: {} } },
      { name: "nc_mail_mailboxes", description: "List mailboxes for a Nextcloud Mail account", inputSchema: { type: "object" as const, properties: { accountId: { type: "number" } }, required: ["accountId"] } },
      { name: "nc_mail_messages", description: "List messages in a mailbox", inputSchema: { type: "object" as const, properties: { accountId: { type: "number" }, folderId: { type: "string", description: "Folder/mailbox ID" }, limit: { type: "number", default: 20 } }, required: ["accountId", "folderId"] } },
      { name: "nc_mail_get_message", description: "Get a specific mail message", inputSchema: { type: "object" as const, properties: { messageId: { type: "number" } }, required: ["messageId"] } },
      { name: "nc_mail_send", description: "Send an email via Nextcloud Mail", inputSchema: { type: "object" as const, properties: { accountId: { type: "number" }, to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, cc: { type: "string" }, bcc: { type: "string" } }, required: ["accountId", "to", "subject", "body"] } },

      // ── Tags ──
      { name: "nc_tags_list", description: "List all Nextcloud system tags", inputSchema: { type: "object" as const, properties: {} } },
      { name: "nc_tags_create", description: "Create a new system tag", inputSchema: { type: "object" as const, properties: { name: { type: "string" }, userVisible: { type: "boolean", default: true }, userAssignable: { type: "boolean", default: true } }, required: ["name"] } },
      { name: "nc_tags_assign", description: "Assign a tag to a file", inputSchema: { type: "object" as const, properties: { fileId: { type: "number" }, tagId: { type: "number" } }, required: ["fileId", "tagId"] } },
      { name: "nc_tags_unassign", description: "Remove a tag from a file", inputSchema: { type: "object" as const, properties: { fileId: { type: "number" }, tagId: { type: "number" } }, required: ["fileId", "tagId"] } },

      // ── Versions ──
      { name: "nc_versions_list", description: "List file versions (revision history)", inputSchema: { type: "object" as const, properties: { fileId: { type: "number" } }, required: ["fileId"] } },
      { name: "nc_versions_restore", description: "Restore a previous file version", inputSchema: { type: "object" as const, properties: { fileId: { type: "number" }, versionId: { type: "string" } }, required: ["fileId", "versionId"] } },

      // ── Comments ──
      { name: "nc_comments_list", description: "List comments on a file", inputSchema: { type: "object" as const, properties: { fileId: { type: "number" } }, required: ["fileId"] } },
      { name: "nc_comments_add", description: "Add a comment to a file", inputSchema: { type: "object" as const, properties: { fileId: { type: "number" }, message: { type: "string" } }, required: ["fileId", "message"] } },

      // ── Apps Management ──
      { name: "nc_apps_list", description: "List installed/enabled Nextcloud apps", inputSchema: { type: "object" as const, properties: { filter: { type: "string", description: "enabled, disabled, or all" } } } },
      { name: "nc_apps_info", description: "Get info about a specific Nextcloud app", inputSchema: { type: "object" as const, properties: { appId: { type: "string" } }, required: ["appId"] } },
      { name: "nc_apps_enable", description: "Enable a Nextcloud app", inputSchema: { type: "object" as const, properties: { appId: { type: "string" } }, required: ["appId"] } },
      { name: "nc_apps_disable", description: "Disable a Nextcloud app", inputSchema: { type: "object" as const, properties: { appId: { type: "string" } }, required: ["appId"] } },

      // ── Forms ──
      { name: "nc_forms_list", description: "List all Nextcloud Forms", inputSchema: { type: "object" as const, properties: {} } },
      { name: "nc_forms_get", description: "Get a specific Nextcloud Form with questions", inputSchema: { type: "object" as const, properties: { formId: { type: "number" } }, required: ["formId"] } },
      { name: "nc_forms_submissions", description: "Get submissions for a Nextcloud Form", inputSchema: { type: "object" as const, properties: { formId: { type: "number", description: "Form ID" } }, required: ["formId"] } },
    ] : []),

  ],
}));

// ── Tool Handlers ────────────────────────────────────────────────────────────

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

// Generic drive handler
async function handleDriveTool(svc: DriveService, label: string, action: string, args: Record<string, unknown>): Promise<ReturnType<typeof ok>> {
  switch (action) {
    case "list": {
      const p = (args.path as string) || '/';
      const items = await svc.listFiles(p);
      if (!items.length) return ok(`Empty directory: ${p}`);
      const lines = items.map(i => {
        const icon = i.type === 'directory' ? '[dir] ' : '      ';
        const size = i.type === 'file' ? ` (${i.size} bytes)` : '';
        return `${icon}${i.name}${size}`;
      });
      return ok(`${label} ${p} (${items.length} items):\n\n${lines.join('\n')}`);
    }
    case "read": {
      const p = args.path as string;
      if (!p) return err("path is required");
      const file = await svc.readFile(p);
      return ok(`File: ${p}\nType: ${file.mimeType}\nSize: ${file.size} bytes\n\n${file.content}`);
    }
    case "write": {
      const p = args.path as string;
      const content = args.content as string;
      if (!p || content === undefined) return err("path and content are required");
      const result = await svc.writeFile(p, content);
      return ok(`Written: ${result.path} (${result.size} bytes)`);
    }
    case "mkdir": {
      const p = args.path as string;
      if (!p) return err("path is required");
      const result = await svc.createFolder(p);
      return ok(`Folder created: ${result.path}`);
    }
    case "delete": {
      const p = args.path as string;
      if (!p) return err("path is required");
      const result = await svc.deleteItem(p);
      return ok(`Deleted: ${result.deleted}`);
    }
    case "move": {
      const source = args.source as string;
      const destination = args.destination as string;
      if (!source || !destination) return err("source and destination are required");
      const result = await svc.moveItem(source, destination);
      return ok(`Moved: ${result.from} -> ${result.to}`);
    }
    case "info": {
      const p = args.path as string;
      if (!p) return err("path is required");
      const info = await svc.getFileInfo(p);
      return ok(`Name: ${info.name}\nType: ${info.type}\nMIME: ${info.mimeType}\nSize: ${info.sizeFormatted}\nModified: ${info.modified}\nCreated: ${info.created}`);
    }
    case "search": {
      const query = args.query as string;
      const p = (args.path as string) || '/';
      if (!query) return err("query is required");
      const results = await svc.searchFiles(query, p);
      if (!results.length) return ok('No matches found.');
      const lines = results.map(i => `${i.type === 'directory' ? '[dir]' : '[file]'} ${i.path}`);
      return ok(`Found ${results.length} matches:\n\n${lines.join('\n')}`);
    }
    case "stats": {
      const stats = await svc.getDriveStats();
      return ok(`${label}: Files: ${stats.totalFiles} | Folders: ${stats.totalFolders} | Total size: ${stats.totalSizeFormatted}`);
    }
    default:
      return err(`Unknown drive action: ${action}`);
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // ─── MAIL ────────────────────────────────────────────────────────
    switch (name) {
      case "mail_send": {
        const { to, subject, body, cc, bcc, replyTo, isHtml, priority } = (args || {}) as any;
        if (!to || !subject || !body) return err("to, subject, and body are required");
        const result = await smtp.sendEmail({
          to: parseEmails(to), subject, body,
          cc: cc ? parseEmails(cc) : undefined,
          bcc: bcc ? parseEmails(bcc) : undefined,
          replyTo, priority,
          htmlBody: isHtml ? body : undefined,
        });
        return ok(`Email sent to ${to}. MessageId: ${result.messageId}`);
      }

      case "mail_list": {
        const folder = (args?.folder as string) || 'INBOX';
        const limit = (args?.limit as number) || 20;
        const offset = (args?.offset as number) || 0;
        const emails = await imap.getEmails(folder, limit, offset);
        if (!emails.length) return ok(`No emails in ${folder}.`);
        const lines = emails.map((e, i) => {
          const read = e.read ? '[read]' : '[unread]';
          const star = e.starred ? '* ' : '';
          return `${i + 1 + offset}. ${read} ${star}[UID:${e.id}]\n   From: ${e.from}\n   Subject: ${e.subject}\n   Date: ${e.date instanceof Date ? e.date.toLocaleString() : e.date}`;
        });
        return ok(`${folder} (${emails.length} emails):\n\n${lines.join('\n\n')}`);
      }

      case "mail_read": {
        const emailId = args?.emailId as string;
        const folder = (args?.folder as string) || 'INBOX';
        if (!emailId) return err("emailId is required");
        const email = await imap.getEmailById(emailId, folder);
        if (!email) return err(`Email UID ${emailId} not found in ${folder}.`);
        return ok([
          `UID: ${email.id}`, `From: ${email.from}`, `To: ${email.to.join(', ')}`,
          `Subject: ${email.subject}`,
          `Date: ${email.date instanceof Date ? email.date.toLocaleString() : email.date}`,
          `Read: ${email.read} | Starred: ${email.starred}`, '', email.body || '(no body)',
        ].join('\n'));
      }

      case "mail_search": {
        const query = (args?.query as string) || '';
        const folder = (args?.folder as string) || 'INBOX';
        const limit = (args?.limit as number) || 20;
        if (!query) return err("query is required");
        const results = await imap.searchEmails(query, folder, limit);
        if (!results.length) return ok('No emails matched.');
        const lines = results.map((e, i) => `${i + 1}. [UID:${e.id}] ${e.subject}\n   From: ${e.from}`);
        return ok(`Found ${results.length} emails:\n\n${lines.join('\n\n')}`);
      }

      case "mail_folders": {
        const folders = await imap.getFolders();
        return ok(`Folders:\n${folders.map(f => `  ${f.path}`).join('\n')}`);
      }

      case "mail_mark_read": {
        const emailId = args?.emailId as string;
        const isRead = args?.isRead !== false;
        const folder = (args?.folder as string) || 'INBOX';
        if (!emailId) return err("emailId is required");
        await imap.markEmailRead(emailId, isRead, folder);
        return ok(`Email ${emailId} marked as ${isRead ? 'read' : 'unread'}.`);
      }

      case "mail_star": {
        const emailId = args?.emailId as string;
        const isStarred = args?.isStarred !== false;
        const folder = (args?.folder as string) || 'INBOX';
        if (!emailId) return err("emailId is required");
        await imap.starEmail(emailId, isStarred, folder);
        return ok(`Email ${emailId} ${isStarred ? 'starred' : 'unstarred'}.`);
      }

      case "mail_move": {
        const emailId = args?.emailId as string;
        const targetFolder = args?.targetFolder as string;
        const folder = (args?.folder as string) || 'INBOX';
        if (!emailId || !targetFolder) return err("emailId and targetFolder are required");
        await imap.moveEmail(emailId, targetFolder, folder);
        return ok(`Email ${emailId} moved to ${targetFolder}.`);
      }

      case "mail_delete": {
        const emailId = args?.emailId as string;
        const folder = (args?.folder as string) || 'INBOX';
        if (!emailId) return err("emailId is required");
        await imap.deleteEmail(emailId, folder);
        return ok(`Email ${emailId} deleted.`);
      }

      case "mail_stats": {
        const stats = await imap.getStats();
        return ok(`Total: ${stats.totalEmails} | Unread: ${stats.unreadEmails} | Folders: ${stats.folders}`);
      }

      case "mail_status": {
        const smtpOk = await smtp.verifyConnection().catch(() => false);
        let imapStatus = 'not connected';
        if (imap.isConnected()) {
          imapStatus = 'connected';
        } else {
          // Attempt reconnection and report result
          try {
            await imap.connect();
            imapStatus = 'reconnected';
          } catch (e: any) {
            imapStatus = `failed: ${(e.message || 'unknown error').slice(0, 80)}`;
          }
        }
        return ok(`SMTP: ${smtpOk ? 'connected' : 'not connected'} | IMAP: ${imapStatus} | User: ${PROTONMAIL_USERNAME}`);
      }
    }

    // ─── DRIVE (Proton) ──────────────────────────────────────────────
    if (name.startsWith('drive_')) {
      const action = name.replace('drive_', '');
      return await handleDriveTool(drive, 'Proton Drive', action, (args || {}) as Record<string, unknown>);
    }

    // ─── ICLOUD ──────────────────────────────────────────────────────
    if (name.startsWith('icloud_')) {
      const action = name.replace('icloud_', '');
      return await handleDriveTool(icloud, 'iCloud Drive', action, (args || {}) as Record<string, unknown>);
    }

    // ─── BEEPER ──────────────────────────────────────────────────────
    if (name.startsWith('beeper_')) {
      const a = (args || {}) as Record<string, any>;
      switch (name) {
        case 'beeper_list_accounts': {
          const data = await beeper.listAccounts();
          return ok(JSON.stringify(data, null, 2));
        }
        case 'beeper_list_chats': {
          const data = await beeper.listChats({ limit: a.limit, offset: a.offset, unreadOnly: a.unreadOnly, service: a.service });
          return ok(JSON.stringify(data, null, 2));
        }
        case 'beeper_search_chats': {
          if (!a.query) return err('query is required');
          const data = await beeper.searchChats(a.query);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'beeper_get_chat': {
          if (!a.chatID) return err('chatID is required');
          const data = await beeper.getChat(a.chatID);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'beeper_get_messages': {
          if (!a.chatID) return err('chatID is required');
          const data = await beeper.getMessages(a.chatID, { limit: a.limit, before: a.before });
          return ok(JSON.stringify(data, null, 2));
        }
        case 'beeper_search_messages': {
          if (!a.query) return err('query is required');
          const data = await beeper.searchMessages(a.query, a.limit);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'beeper_send_message': {
          if (!a.chatID || !a.text) return err('chatID and text are required');
          const data = await beeper.sendMessage(a.chatID, a.text, a.replyTo);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'beeper_mark_read': {
          if (!a.chatID) return err('chatID is required');
          const data = await beeper.markRead(a.chatID, a.upToMessageID);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'beeper_add_reaction': {
          if (!a.chatID || !a.messageID || !a.emoji) return err('chatID, messageID, and emoji are required');
          const data = await beeper.addReaction(a.chatID, a.messageID, a.emoji);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'beeper_create_chat': {
          if (!a.accountID || !a.participantIDs) return err('accountID and participantIDs are required');
          const data = await beeper.createChat(a.accountID, a.participantIDs, a.type || 'single');
          return ok(JSON.stringify(data, null, 2));
        }
        case 'beeper_archive_chat': {
          if (!a.chatID || a.archived === undefined) return err('chatID and archived are required');
          const data = await beeper.archiveChat(a.chatID, a.archived);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'beeper_search_contacts': {
          if (!a.accountID || !a.query) return err('accountID and query are required');
          const data = await beeper.searchContacts(a.accountID, a.query);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'beeper_set_reminder': {
          if (!a.chatID || !a.remindAt) return err('chatID and remindAt are required');
          const data = await beeper.setReminder(a.chatID, a.remindAt);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'beeper_get_unread_summary': {
          const summary = await beeper.getUnreadSummary();
          if (!summary.chats.length) return ok('No unread messages across any network.');
          const lines = summary.chats.map(c => `[${c.service}] ${c.name}: ${c.unread} unread${c.lastMessage ? ` — "${c.lastMessage}"` : ''}`);
          return ok(`Total unread: ${summary.totalUnread}\n\n${lines.join('\n')}`);
        }

        // ─── Beeper Database tools ─────────────────────────────────────
        case 'beeper_db_stats': {
          const data = await beeperDb.getDbStats();
          return ok(JSON.stringify(data, null, 2));
        }
        case 'beeper_db_search': {
          if (!a.query) return err('query is required');
          const data = await beeperDb.searchMessagesDb(a.query, a.limit || 20, a.chatID);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'beeper_db_history': {
          if (!a.chatID) return err('chatID is required');
          const data = await beeperDb.getChatHistory(a.chatID, a.limit || 50, a.before);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'beeper_db_threads': {
          const data = await beeperDb.listThreads(a.limit || 50, a.accountID);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'beeper_db_participants': {
          if (!a.chatID) return err('chatID is required');
          const data = await beeperDb.getParticipants(a.chatID);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'beeper_db_contacts': {
          if (!a.query) return err('query is required');
          const data = await beeperDb.searchContactsDb(a.query, a.limit || 20);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'beeper_db_reactions': {
          if (!a.chatID || !a.eventID) return err('chatID and eventID are required');
          const data = await beeperDb.getReactions(a.chatID, a.eventID);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'beeper_db_analytics': {
          const data = await beeperDb.getChatAnalytics(a.chatID, a.days || 30);
          return ok(JSON.stringify(data, null, 2));
        }
      }
    }

    // ─── FABRIC AI ────────────────────────────────────────────────
    if (name.startsWith('fabric_') && fabric) {
      const a = (args || {}) as Record<string, any>;
      switch (name) {
        case 'fabric_search': {
          if (!a.query) return err('query is required');
          const data = await fabric.search(a.query, a.limit || 10);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'fabric_add_memory': {
          if (!a.content) return err('content is required');
          const data = await fabric.addMemory(a.content);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'fabric_recall_memories': {
          if (!a.query) return err('query is required');
          const data = await fabric.recallMemories(a.query, a.limit || 20);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'fabric_create_note': {
          if (!a.text) return err('text is required');
          const data = await fabric.createNotepad(a.text, undefined, a.parentId);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'fabric_list_notes': {
          const data = await fabric.listNotepads(a.parentId);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'fabric_get_note': {
          if (!a.notepadId) return err('notepadId is required');
          const data = await fabric.getNotepad(a.notepadId);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'fabric_update_note': {
          if (!a.notepadId || !a.text) return err('notepadId and text are required');
          const data = await fabric.updateNotepad(a.notepadId, a.text);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'fabric_delete_note': {
          if (!a.notepadId) return err('notepadId is required');
          const data = await fabric.deleteNotepad(a.notepadId);
          return ok(JSON.stringify(data, null, 2));
        }
      }
    }

    // ─── QUO (PHONE / SMS / CALLS) ─────────────────────────────────────────
    if (name.startsWith('quo_') && quo) {
      const a = (args || {}) as Record<string, any>;
      switch (name) {
        case 'quo_list_numbers': {
          const data = await quo.listPhoneNumbers();
          return ok(JSON.stringify(data, null, 2));
        }
        case 'quo_send_message': {
          if (!a.from || !a.to || !a.content) return err('from, to, and content are required');
          const data = await quo.sendMessage(a.from, a.to, a.content);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'quo_list_messages': {
          if (!a.phoneNumberId || !a.participants) return err('phoneNumberId and participants are required');
          const data = await quo.listMessages(a.phoneNumberId, a.participants, a.maxResults);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'quo_get_message': {
          if (!a.messageId) return err('messageId is required');
          const data = await quo.getMessage(a.messageId);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'quo_list_calls': {
          if (!a.phoneNumberId || !a.participants) return err('phoneNumberId and participants are required');
          const data = await quo.listCalls(a.phoneNumberId, a.participants, a.maxResults);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'quo_get_call': {
          if (!a.callId) return err('callId is required');
          const data = await quo.getCall(a.callId);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'quo_call_summary': {
          if (!a.callId) return err('callId is required');
          const data = await quo.getCallSummary(a.callId);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'quo_call_transcript': {
          if (!a.callId) return err('callId is required');
          const data = await quo.getCallTranscript(a.callId);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'quo_voicemail': {
          if (!a.callId) return err('callId is required');
          const data = await quo.getVoicemail(a.callId);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'quo_call_recordings': {
          if (!a.callId) return err('callId is required');
          const data = await quo.getCallRecordings(a.callId);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'quo_list_contacts': {
          const data = await quo.listContacts(a.page);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'quo_get_contact': {
          if (!a.contactId) return err('contactId is required');
          const data = await quo.getContact(a.contactId);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'quo_create_contact': {
          if (!a.firstName) return err('firstName is required');
          const fields: any = { firstName: a.firstName };
          if (a.lastName) fields.lastName = a.lastName;
          if (a.company) fields.company = a.company;
          if (a.role) fields.role = a.role;
          if (a.phone) fields.phoneNumbers = [{ name: 'main', value: a.phone }];
          if (a.email) fields.emails = [{ name: 'main', value: a.email }];
          const data = await quo.createContact(fields);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'quo_update_contact': {
          if (!a.contactId) return err('contactId is required');
          const fields: any = {};
          if (a.firstName) fields.firstName = a.firstName;
          if (a.lastName) fields.lastName = a.lastName;
          if (a.company) fields.company = a.company;
          if (a.role) fields.role = a.role;
          const data = await quo.updateContact(a.contactId, fields);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'quo_delete_contact': {
          if (!a.contactId) return err('contactId is required');
          const data = await quo.deleteContact(a.contactId);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'quo_list_conversations': {
          const data = await quo.listConversations(a.phoneNumberId, undefined, undefined, a.maxResults);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'quo_list_users': {
          const data = await quo.listUsers();
          return ok(JSON.stringify(data, null, 2));
        }
      }
    }

    // ─── VOICENOTES ──────────────────────────────────────────────────────
    if (name.startsWith('voicenotes_') && voicenotes) {
      const a = (args || {}) as Record<string, any>;
      switch (name) {
        case 'voicenotes_user': {
          const data = await voicenotes.getUserInfo();
          return ok(JSON.stringify(data, null, 2));
        }
        case 'voicenotes_list': {
          const data = await voicenotes.listRecordings(a.since || null);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'voicenotes_search': {
          if (!a.query) return err('query is required');
          const results = await voicenotes.searchNotes(a.query, a.limit || 20);
          return ok(JSON.stringify({ count: results.length, results }, null, 2));
        }
        case 'voicenotes_audio_url': {
          if (!a.recordingId) return err('recordingId is required');
          const data = await voicenotes.getRecordingAudioUrl(a.recordingId);
          return ok(JSON.stringify(data, null, 2));
        }
      }
    }

    // ─── NEXTCLOUD ──────────────────────────────────────────────────────
    if (name.startsWith('nc_') && nextcloud) {
      const a = (args || {}) as Record<string, any>;
      switch (name) {
        // Notes
        case 'nc_notes_list': return ok(JSON.stringify(await nextcloud.notesList(a.category), null, 2));
        case 'nc_notes_get': { if (!a.noteId) return err('noteId required'); return ok(JSON.stringify(await nextcloud.notesGet(a.noteId), null, 2)); }
        case 'nc_notes_create': { if (!a.title || !a.content) return err('title and content required'); return ok(JSON.stringify(await nextcloud.notesCreate(a.title, a.content, a.category), null, 2)); }
        case 'nc_notes_update': { if (!a.noteId) return err('noteId required'); return ok(JSON.stringify(await nextcloud.notesUpdate(a.noteId, a.title, a.content, a.category), null, 2)); }
        case 'nc_notes_delete': { if (!a.noteId) return err('noteId required'); return ok(JSON.stringify(await nextcloud.notesDelete(a.noteId), null, 2)); }
        case 'nc_notes_search': { if (!a.query) return err('query required'); return ok(JSON.stringify(await nextcloud.notesSearch(a.query), null, 2)); }

        // Calendar
        case 'nc_calendar_list': return ok(JSON.stringify(await nextcloud.calendarListCalendars(), null, 2));
        case 'nc_calendar_get_events': return ok(JSON.stringify(await nextcloud.calendarGetEvents(a.calendarId, a.startDate, a.endDate), null, 2));
        case 'nc_calendar_create_event': { if (!a.summary || !a.startDateTime || !a.endDateTime) return err('summary, startDateTime, endDateTime required'); return ok(JSON.stringify(await nextcloud.calendarCreateEvent(a.summary, a.startDateTime, a.endDateTime, a.calendarId, a.description, a.location), null, 2)); }
        case 'nc_calendar_delete_event': { if (!a.calendarId || !a.eventUid) return err('calendarId and eventUid required'); return ok(JSON.stringify(await nextcloud.calendarDeleteEvent(a.calendarId, a.eventUid), null, 2)); }

        // Tasks
        case 'nc_task_lists': return ok(JSON.stringify(await nextcloud.taskListLists(), null, 2));
        case 'nc_task_get_tasks': return ok(JSON.stringify(await nextcloud.taskGetTasks(a.listId, a.status), null, 2));
        case 'nc_task_create': { if (!a.summary) return err('summary required'); return ok(JSON.stringify(await nextcloud.taskCreate(a.summary, a.listId, a.description, a.due, a.priority), null, 2)); }

        // Contacts
        case 'nc_contacts_list_addressbooks': return ok(JSON.stringify(await nextcloud.contactsListAddressbooks(), null, 2));
        case 'nc_contacts_list': return ok(JSON.stringify(await nextcloud.contactsListContacts(a.addressbookId), null, 2));
        case 'nc_contacts_create': { if (!a.fullName) return err('fullName required'); return ok(JSON.stringify(await nextcloud.contactsCreateContact(a.addressbookId || 'contacts', a.fullName, a.email, a.phone, a.org), null, 2)); }
        case 'nc_contacts_delete': { if (!a.addressbookId || !a.contactUid) return err('addressbookId and contactUid required'); return ok(JSON.stringify(await nextcloud.contactsDeleteContact(a.addressbookId, a.contactUid), null, 2)); }
        case 'nc_contacts_search': { if (!a.query) return err('query required'); return ok(JSON.stringify(await nextcloud.contactsSearch(a.query), null, 2)); }

        // Files
        case 'nc_files_list': return ok(JSON.stringify(await nextcloud.filesListDirectory(a.path), null, 2));
        case 'nc_files_read': { if (!a.path) return err('path required'); const content = await nextcloud.filesReadFile(a.path); return ok(typeof content === 'string' ? content : JSON.stringify(content)); }
        case 'nc_files_write': { if (!a.path || a.content === undefined) return err('path and content required'); return ok(JSON.stringify(await nextcloud.filesWriteFile(a.path, a.content), null, 2)); }
        case 'nc_files_mkdir': { if (!a.path) return err('path required'); return ok(JSON.stringify(await nextcloud.filesCreateDirectory(a.path), null, 2)); }
        case 'nc_files_delete': { if (!a.path) return err('path required'); return ok(JSON.stringify(await nextcloud.filesDeleteResource(a.path), null, 2)); }
        case 'nc_files_move': { if (!a.source || !a.destination) return err('source and destination required'); return ok(JSON.stringify(await nextcloud.filesMoveResource(a.source, a.destination), null, 2)); }
        case 'nc_files_copy': { if (!a.source || !a.destination) return err('source and destination required'); return ok(JSON.stringify(await nextcloud.filesCopyResource(a.source, a.destination), null, 2)); }
        case 'nc_files_search': { if (!a.query) return err('query required'); return ok(JSON.stringify(await nextcloud.filesSearch(a.query, a.path), null, 2)); }
        case 'nc_files_favorites': return ok(JSON.stringify(await nextcloud.filesListFavorites(), null, 2));

        // Trashbin
        case 'nc_trash_list': return ok(JSON.stringify(await nextcloud.trashbinList(), null, 2));
        case 'nc_trash_restore': { if (!a.trashPath) return err('trashPath required'); return ok(JSON.stringify(await nextcloud.trashbinRestore(a.trashPath), null, 2)); }
        case 'nc_trash_delete': { if (!a.trashPath) return err('trashPath required'); return ok(JSON.stringify(await nextcloud.trashbinDelete(a.trashPath), null, 2)); }
        case 'nc_trash_empty': return ok(JSON.stringify(await nextcloud.trashbinEmpty(), null, 2));

        // Deck
        case 'nc_deck_list_boards': return ok(JSON.stringify(await nextcloud.deckListBoards(), null, 2));
        case 'nc_deck_get_board': { if (!a.boardId) return err('boardId required'); return ok(JSON.stringify(await nextcloud.deckGetBoard(a.boardId), null, 2)); }
        case 'nc_deck_create_board': { if (!a.title) return err('title required'); return ok(JSON.stringify(await nextcloud.deckCreateBoard(a.title, a.color), null, 2)); }
        case 'nc_deck_delete_board': { if (!a.boardId) return err('boardId required'); return ok(JSON.stringify(await nextcloud.deckDeleteBoard(a.boardId), null, 2)); }
        case 'nc_deck_list_stacks': { if (!a.boardId) return err('boardId required'); return ok(JSON.stringify(await nextcloud.deckListStacks(a.boardId), null, 2)); }
        case 'nc_deck_create_stack': { if (!a.boardId || !a.title) return err('boardId and title required'); return ok(JSON.stringify(await nextcloud.deckCreateStack(a.boardId, a.title, a.order), null, 2)); }
        case 'nc_deck_create_card': { if (!a.boardId || !a.stackId || !a.title) return err('boardId, stackId, title required'); return ok(JSON.stringify(await nextcloud.deckCreateCard(a.boardId, a.stackId, a.title, a.description, a.duedate), null, 2)); }
        case 'nc_deck_update_card': { if (!a.boardId || !a.stackId || !a.cardId) return err('boardId, stackId, cardId required'); return ok(JSON.stringify(await nextcloud.deckUpdateCard(a.boardId, a.stackId, a.cardId, a.title, a.description, a.duedate), null, 2)); }
        case 'nc_deck_delete_card': { if (!a.boardId || !a.stackId || !a.cardId) return err('boardId, stackId, cardId required'); return ok(JSON.stringify(await nextcloud.deckDeleteCard(a.boardId, a.stackId, a.cardId), null, 2)); }
        case 'nc_deck_move_card': { if (!a.boardId || !a.stackId || !a.cardId || !a.targetStackId) return err('boardId, stackId, cardId, targetStackId required'); return ok(JSON.stringify(await nextcloud.deckMoveCard(a.boardId, a.stackId, a.cardId, a.targetStackId), null, 2)); }
        case 'nc_deck_assign_label': { if (!a.boardId || !a.stackId || !a.cardId || !a.labelId) return err('boardId, stackId, cardId, labelId required'); return ok(JSON.stringify(await nextcloud.deckAssignLabel(a.boardId, a.stackId, a.cardId, a.labelId), null, 2)); }
        case 'nc_deck_assign_user': { if (!a.boardId || !a.stackId || !a.cardId || !a.userId) return err('boardId, stackId, cardId, userId required'); return ok(JSON.stringify(await nextcloud.deckAssignUser(a.boardId, a.stackId, a.cardId, a.userId), null, 2)); }
        case 'nc_deck_create_label': { if (!a.boardId || !a.title) return err('boardId and title required'); return ok(JSON.stringify(await nextcloud.deckCreateLabel(a.boardId, a.title, a.color), null, 2)); }

        // Tables
        case 'nc_tables_list': return ok(JSON.stringify(await nextcloud.tablesListTables(), null, 2));
        case 'nc_tables_get': { if (!a.tableId) return err('tableId required'); return ok(JSON.stringify(await nextcloud.tablesGetTable(a.tableId), null, 2)); }
        case 'nc_tables_get_columns': { if (!a.tableId) return err('tableId required'); return ok(JSON.stringify(await nextcloud.tablesGetColumns(a.tableId), null, 2)); }
        case 'nc_tables_get_rows': { if (!a.tableId) return err('tableId required'); return ok(JSON.stringify(await nextcloud.tablesGetRows(a.tableId, a.limit, a.offset), null, 2)); }
        case 'nc_tables_create_row': { if (!a.tableId || !a.data) return err('tableId and data required'); return ok(JSON.stringify(await nextcloud.tablesCreateRow(a.tableId, a.data), null, 2)); }
        case 'nc_tables_update_row': { if (!a.rowId || !a.data) return err('rowId and data required'); return ok(JSON.stringify(await nextcloud.tablesUpdateRow(a.rowId, a.data), null, 2)); }
        case 'nc_tables_delete_row': { if (!a.rowId) return err('rowId required'); return ok(JSON.stringify(await nextcloud.tablesDeleteRow(a.rowId), null, 2)); }

        // Sharing
        case 'nc_shares_list': return ok(JSON.stringify(await nextcloud.sharesList(a.path), null, 2));
        case 'nc_shares_get': { if (!a.shareId) return err('shareId required'); return ok(JSON.stringify(await nextcloud.sharesGet(a.shareId), null, 2)); }
        case 'nc_shares_create': { if (!a.path || a.shareType === undefined) return err('path and shareType required'); return ok(JSON.stringify(await nextcloud.sharesCreate(a.path, a.shareType, a.shareWith, a.permissions, a.password, a.expireDate), null, 2)); }
        case 'nc_shares_update': { if (!a.shareId) return err('shareId required'); return ok(JSON.stringify(await nextcloud.sharesUpdate(a.shareId, a.permissions, a.password, a.expireDate), null, 2)); }
        case 'nc_shares_delete': { if (!a.shareId) return err('shareId required'); return ok(JSON.stringify(await nextcloud.sharesDelete(a.shareId), null, 2)); }

        // Talk
        case 'nc_talk_list_conversations': return ok(JSON.stringify(await nextcloud.talkListConversations(), null, 2));
        case 'nc_talk_get_conversation': { if (!a.token) return err('token required'); return ok(JSON.stringify(await nextcloud.talkGetConversation(a.token), null, 2)); }
        case 'nc_talk_create_conversation': { if (!a.roomType || !a.roomName) return err('roomType and roomName required'); return ok(JSON.stringify(await nextcloud.talkCreateConversation(a.roomType, a.roomName, a.invite), null, 2)); }
        case 'nc_talk_get_messages': { if (!a.token) return err('token required'); return ok(JSON.stringify(await nextcloud.talkGetMessages(a.token, a.limit), null, 2)); }
        case 'nc_talk_send_message': { if (!a.token || !a.message) return err('token and message required'); return ok(JSON.stringify(await nextcloud.talkSendMessage(a.token, a.message, a.replyTo), null, 2)); }
        case 'nc_talk_delete_message': { if (!a.token || !a.messageId) return err('token and messageId required'); return ok(JSON.stringify(await nextcloud.talkDeleteMessage(a.token, a.messageId), null, 2)); }
        case 'nc_talk_get_participants': { if (!a.token) return err('token required'); return ok(JSON.stringify(await nextcloud.talkGetParticipants(a.token), null, 2)); }
        case 'nc_talk_create_poll': { if (!a.token || !a.question || !a.options) return err('token, question, options required'); return ok(JSON.stringify(await nextcloud.talkCreatePoll(a.token, a.question, a.options, a.maxVotes), null, 2)); }
        case 'nc_talk_vote_poll': { if (!a.token || !a.pollId || !a.optionIds) return err('token, pollId, optionIds required'); return ok(JSON.stringify(await nextcloud.talkVotePoll(a.token, a.pollId, a.optionIds), null, 2)); }
        case 'nc_talk_close_poll': { if (!a.token || !a.pollId) return err('token and pollId required'); return ok(JSON.stringify(await nextcloud.talkClosePoll(a.token, a.pollId), null, 2)); }

        // Notifications
        case 'nc_notifications_list': return ok(JSON.stringify(await nextcloud.notificationsList(), null, 2));
        case 'nc_notifications_dismiss': { if (!a.notificationId) return err('notificationId required'); return ok(JSON.stringify(await nextcloud.notificationsDismiss(a.notificationId), null, 2)); }
        case 'nc_notifications_dismiss_all': return ok(JSON.stringify(await nextcloud.notificationsDismissAll(), null, 2));

        // Activity
        case 'nc_activity': return ok(JSON.stringify(await nextcloud.activityGet(a.limit, a.sinceId), null, 2));

        // Users
        case 'nc_users_current': return ok(JSON.stringify(await nextcloud.usersGetCurrent(), null, 2));
        case 'nc_users_list': return ok(JSON.stringify(await nextcloud.usersList(a.search, a.limit), null, 2));
        case 'nc_users_get': { if (!a.userId) return err('userId required'); return ok(JSON.stringify(await nextcloud.usersGet(a.userId), null, 2)); }

        // User Status
        case 'nc_status_get': return ok(JSON.stringify(await nextcloud.userStatusGet(a.userId), null, 2));
        case 'nc_status_set': { if (!a.statusType) return err('statusType required'); return ok(JSON.stringify(await nextcloud.userStatusSet(a.statusType, a.message, a.icon), null, 2)); }
        case 'nc_status_clear': return ok(JSON.stringify(await nextcloud.userStatusClear(), null, 2));

        // Search
        case 'nc_search_providers': return ok(JSON.stringify(await nextcloud.searchProviders(), null, 2));
        case 'nc_search': { if (!a.providerId || !a.query) return err('providerId and query required'); return ok(JSON.stringify(await nextcloud.unifiedSearch(a.providerId, a.query, a.limit), null, 2)); }

        // Mail
        case 'nc_mail_accounts': return ok(JSON.stringify(await nextcloud.mailListAccounts(), null, 2));
        case 'nc_mail_mailboxes': { if (!a.accountId) return err('accountId required'); return ok(JSON.stringify(await nextcloud.mailListMailboxes(a.accountId), null, 2)); }
        case 'nc_mail_messages': { if (!a.accountId || !a.folderId) return err('accountId and folderId required'); return ok(JSON.stringify(await nextcloud.mailListMessages(a.accountId, a.folderId, a.limit), null, 2)); }
        case 'nc_mail_get_message': { if (!a.messageId) return err('messageId required'); return ok(JSON.stringify(await nextcloud.mailGetMessage(a.messageId), null, 2)); }
        case 'nc_mail_send': { if (!a.accountId || !a.to || !a.subject || !a.body) return err('accountId, to, subject, body required'); return ok(JSON.stringify(await nextcloud.mailSend(a.accountId, a.to, a.subject, a.body, a.cc, a.bcc), null, 2)); }

        // Tags
        case 'nc_tags_list': return ok(JSON.stringify(await nextcloud.tagsList(), null, 2));
        case 'nc_tags_create': { if (!a.name) return err('name required'); return ok(JSON.stringify(await nextcloud.tagsCreate(a.name, a.userVisible, a.userAssignable), null, 2)); }
        case 'nc_tags_assign': { if (!a.fileId || !a.tagId) return err('fileId and tagId required'); return ok(JSON.stringify(await nextcloud.tagsAssign(a.fileId, a.tagId), null, 2)); }
        case 'nc_tags_unassign': { if (!a.fileId || !a.tagId) return err('fileId and tagId required'); return ok(JSON.stringify(await nextcloud.tagsUnassign(a.fileId, a.tagId), null, 2)); }

        // Versions
        case 'nc_versions_list': { if (!a.fileId) return err('fileId required'); return ok(JSON.stringify(await nextcloud.versionsList(a.fileId), null, 2)); }
        case 'nc_versions_restore': { if (!a.fileId || !a.versionId) return err('fileId and versionId required'); return ok(JSON.stringify(await nextcloud.versionsRestore(a.fileId, a.versionId), null, 2)); }

        // Comments
        case 'nc_comments_list': { if (!a.fileId) return err('fileId required'); return ok(JSON.stringify(await nextcloud.commentsList(a.fileId), null, 2)); }
        case 'nc_comments_add': { if (!a.fileId || !a.message) return err('fileId and message required'); return ok(JSON.stringify(await nextcloud.commentsAdd(a.fileId, a.message), null, 2)); }

        // Apps
        case 'nc_apps_list': return ok(JSON.stringify(await nextcloud.appsList(a.filter), null, 2));
        case 'nc_apps_info': { if (!a.appId) return err('appId required'); return ok(JSON.stringify(await nextcloud.appsGetInfo(a.appId), null, 2)); }
        case 'nc_apps_enable': { if (!a.appId) return err('appId required'); return ok(JSON.stringify(await nextcloud.appsEnable(a.appId), null, 2)); }
        case 'nc_apps_disable': { if (!a.appId) return err('appId required'); return ok(JSON.stringify(await nextcloud.appsDisable(a.appId), null, 2)); }

        // Forms
        case 'nc_forms_list': return ok(JSON.stringify(await nextcloud.formsList(), null, 2));
        case 'nc_forms_get': { if (!a.formId) return err('formId required'); return ok(JSON.stringify(await nextcloud.formsGet(a.formId), null, 2)); }
        case 'nc_forms_submissions': { if (!a.formId) return err('formId required'); return ok(JSON.stringify(await nextcloud.formsGetSubmissions(a.formId), null, 2)); }
      }
    }

    return err(`Unknown tool: ${name}`);
  } catch (error: any) {
    logger.error(`Tool ${name} failed: ${error?.message || error}`, 'CallTool');
    return err(`Error in ${name}: ${error?.message || String(error)}`);
  }
});

// ── Start ────────────────────────────────────────────────────────────────────
async function main() {
  logger.info('Starting Garza MCP Server v6 (Mail + Drive + iCloud + Beeper + FabricAI + Quo + Voicenotes + Nextcloud)...', 'Main');
  logger.info(`Mail user: ${PROTONMAIL_USERNAME}`, 'Main');
  logger.info(`Proton Drive: ${PROTON_DRIVE_PATH}`, 'Main');
  logger.info(`iCloud Drive: ${ICLOUD_DRIVE_PATH}`, 'Main');
  logger.info(`Beeper API: ${BEEPER_API_URL}`, 'Main');
  logger.info(`Beeper DB: ${BEEPER_DB_PATH}`, 'Main');
  if (fabric) logger.info(`Fabric AI: ${FABRIC_API_URL}`, 'Main');
  if (quo) logger.info('Quo (OpenPhone): connected', 'Main');
  if (voicenotes) logger.info('Voicenotes: connected', 'Main');
  if (nextcloud) logger.info(`Nextcloud: ${NEXTCLOUD_URL}`, 'Main');


  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('Server running on stdio', 'Main');
}

main().catch((error) => {
  console.error('[FATAL]', error);
  process.exit(1);
});

// Graceful shutdown — clean up IMAP connection
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    logger.info(`Received ${sig}, shutting down...`, 'Main');
    const forceExit = setTimeout(() => process.exit(0), 5_000);
    try { await imap.disconnect(); } catch { /* ignore */ }
    clearTimeout(forceExit);
    process.exit(0);
  });
}
