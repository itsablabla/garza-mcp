#!/usr/bin/env node

/**
 * Garza MCP — Unified MCP Server
 * Combines ProtonMail (SMTP/IMAP via Proton Bridge), Proton Drive, iCloud Drive,
 * Beeper (unified messaging across WhatsApp, Telegram, Signal, iMessage, etc.),
 * Fabric AI (memory/notes/search), and FreeScout (helpdesk) into a single MCP
 * server exposed over stdio (wrapped by mcp-proxy for HTTP).
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
import { FreeScoutService } from './services/freescout-service.js';
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
const FREESCOUT_URL = process.env.FREESCOUT_URL || '';
const FREESCOUT_API_KEY = process.env.FREESCOUT_API_KEY || '';
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
const freescout = (FREESCOUT_URL && FREESCOUT_API_KEY) ? new FreeScoutService(FREESCOUT_URL, FREESCOUT_API_KEY) : null;

// ── MCP Server ───────────────────────────────────────────────────────────────
const server = new Server(
  { name: "garza-mcp", version: "5.0.0" },
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

    // ═══════════════════════════ BEEPER (MESSAGING) ══════════════════
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

    // ── Beeper Database Tools (local SQLite — 8M+ messages, FTS) ──────────
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
        name: "fabric_list_memories",
        description: "List recent memories stored in Fabric AI",
        inputSchema: {
          type: "object" as const,
          properties: {
            limit: { type: "number", description: "Max results (default: 20)" },
          },
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

    // ═══════════════════════════ FREESCOUT (HELPDESK) ══════════════════
    ...(freescout ? [
      {
        name: "helpdesk_list_tickets",
        description: "List helpdesk tickets/conversations with optional status filter",
        inputSchema: {
          type: "object" as const,
          properties: {
            mailboxId: { type: "number", description: "Filter by mailbox ID" },
            status: { type: "string", enum: ["active", "pending", "closed", "spam"], description: "Filter by status (default: active)" },
            page: { type: "number", description: "Page number for pagination" },
          },
        },
      },
      {
        name: "helpdesk_get_ticket",
        description: "Get full details of a specific helpdesk ticket including conversation threads",
        inputSchema: {
          type: "object" as const,
          properties: {
            conversationId: { type: "number", description: "Conversation/ticket ID" },
          },
          required: ["conversationId"],
        },
      },
      {
        name: "helpdesk_create_ticket",
        description: "Create a new helpdesk ticket/conversation",
        inputSchema: {
          type: "object" as const,
          properties: {
            mailboxId: { type: "number", description: "Mailbox ID to create in" },
            subject: { type: "string", description: "Ticket subject" },
            customerEmail: { type: "string", description: "Customer email address" },
            customerFirstName: { type: "string", description: "Customer first name" },
            body: { type: "string", description: "Initial message body (HTML)" },
            status: { type: "string", enum: ["active", "pending", "closed"], description: "Initial status" },
          },
          required: ["mailboxId", "subject", "customerEmail", "body"],
        },
      },
      {
        name: "helpdesk_reply",
        description: "Reply to or add a note on a helpdesk ticket",
        inputSchema: {
          type: "object" as const,
          properties: {
            conversationId: { type: "number", description: "Conversation/ticket ID" },
            body: { type: "string", description: "Reply body (HTML)" },
            type: { type: "string", enum: ["reply", "note"], description: "Thread type (default: reply)" },
          },
          required: ["conversationId", "body"],
        },
      },
      {
        name: "helpdesk_update_ticket",
        description: "Update ticket status, assignment, or subject",
        inputSchema: {
          type: "object" as const,
          properties: {
            conversationId: { type: "number", description: "Conversation/ticket ID" },
            status: { type: "string", enum: ["active", "pending", "closed", "spam"] },
            assignTo: { type: "number", description: "User ID to assign to" },
            subject: { type: "string", description: "New subject" },
          },
          required: ["conversationId"],
        },
      },
      {
        name: "helpdesk_list_customers",
        description: "List helpdesk customers with pagination",
        inputSchema: {
          type: "object" as const,
          properties: {
            page: { type: "number", description: "Page number" },
          },
        },
      },
      {
        name: "helpdesk_search_customers",
        description: "Search helpdesk customers by name or email",
        inputSchema: {
          type: "object" as const,
          properties: {
            query: { type: "string", description: "Search query (name or email)" },
          },
          required: ["query"],
        },
      },
      {
        name: "helpdesk_list_mailboxes",
        description: "List all helpdesk mailboxes/departments",
        inputSchema: { type: "object" as const, properties: {} },
      },
      {
        name: "helpdesk_list_agents",
        description: "List all helpdesk agents/users",
        inputSchema: { type: "object" as const, properties: {} },
      },
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
        const imapOk = imap.isConnected();
        return ok(`SMTP: ${smtpOk ? 'connected' : 'not connected'} | IMAP: ${imapOk ? 'connected' : 'not connected'} | User: ${PROTONMAIL_USERNAME}`);
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
        case 'fabric_list_memories': {
          const data = await fabric.listMemories(a.limit || 20);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'fabric_create_note': {
          if (!a.text) return err('text is required');
          const data = await fabric.createNotepad(a.text, a.parentId);
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

    // ─── FREESCOUT HELPDESK ───────────────────────────────────────────
    if (name.startsWith('helpdesk_') && freescout) {
      const a = (args || {}) as Record<string, any>;
      switch (name) {
        case 'helpdesk_list_tickets': {
          const data = await freescout.listConversations(a.mailboxId, a.status || 'active', a.page || 1);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'helpdesk_get_ticket': {
          if (!a.conversationId) return err('conversationId is required');
          const data = await freescout.getConversation(a.conversationId);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'helpdesk_create_ticket': {
          if (!a.mailboxId || !a.subject || !a.customerEmail || !a.body) return err('mailboxId, subject, customerEmail, and body are required');
          const data = await freescout.createConversation({
            type: 'email',
            mailboxId: a.mailboxId,
            subject: a.subject,
            customer: { email: a.customerEmail, firstName: a.customerFirstName },
            threads: [{ type: 'customer', body: a.body }],
            status: a.status,
          });
          return ok(JSON.stringify(data, null, 2));
        }
        case 'helpdesk_reply': {
          if (!a.conversationId || !a.body) return err('conversationId and body are required');
          const data = await freescout.replyToConversation(a.conversationId, a.body, a.type || 'reply');
          return ok(JSON.stringify(data, null, 2));
        }
        case 'helpdesk_update_ticket': {
          if (!a.conversationId) return err('conversationId is required');
          const data = await freescout.updateConversation(a.conversationId, {
            status: a.status,
            assignTo: a.assignTo,
            subject: a.subject,
          });
          return ok(JSON.stringify(data, null, 2));
        }
        case 'helpdesk_list_customers': {
          const data = await freescout.listCustomers(a.page || 1);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'helpdesk_search_customers': {
          if (!a.query) return err('query is required');
          const data = await freescout.searchCustomers(a.query);
          return ok(JSON.stringify(data, null, 2));
        }
        case 'helpdesk_list_mailboxes': {
          const data = await freescout.listMailboxes();
          return ok(JSON.stringify(data, null, 2));
        }
        case 'helpdesk_list_agents': {
          const data = await freescout.listUsers();
          return ok(JSON.stringify(data, null, 2));
        }
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
  logger.info('Starting Garza MCP Server v5 (Mail + Drive + iCloud + Beeper + BeeperDB + FabricAI + FreeScout)...', 'Main');
  logger.info(`Mail user: ${PROTONMAIL_USERNAME}`, 'Main');
  logger.info(`Proton Drive: ${PROTON_DRIVE_PATH}`, 'Main');
  logger.info(`iCloud Drive: ${ICLOUD_DRIVE_PATH}`, 'Main');
  logger.info(`Beeper API: ${BEEPER_API_URL}`, 'Main');
  logger.info(`Beeper DB: ${BEEPER_DB_PATH}`, 'Main');
  if (fabric) logger.info(`Fabric AI: ${FABRIC_API_URL}`, 'Main');
  if (freescout) logger.info(`FreeScout: ${FREESCOUT_URL}`, 'Main');

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('Server running on stdio', 'Main');
}

main().catch((error) => {
  console.error('[FATAL]', error);
  process.exit(1);
});
