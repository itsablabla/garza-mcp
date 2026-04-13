# Garza MCP

Unified MCP (Model Context Protocol) server combining **ProtonMail**, **Proton Drive**, **iCloud Drive**, **Beeper**, **Fabric AI**, **Quo/OpenPhone**, **Voicenotes**, and **Nextcloud** into a single service with **178 tools across 9 services**.

Built with **Python FastMCP** — native Streamable HTTP transport, built-in Bearer token auth, per-tool timeouts, and crash protection. No stdio/mcp-proxy chain needed.

Deployed at: `https://mcp.garzaos.cloud/sse`

## Tools (178)

### ProtonMail (11)
| Tool | Description |
|---|---|
| `mail_status` | Check SMTP/IMAP connection status |
| `mail_send` | Send email via Proton Bridge SMTP |
| `mail_list` | List emails in a folder |
| `mail_read` | Read a specific email by UID |
| `mail_search` | Search emails (server-side IMAP SEARCH) |
| `mail_folders` | List all mail folders |
| `mail_stats` | Get mailbox statistics |
| `mail_mark_read` | Mark email as read/unread |
| `mail_star` | Star/unstar an email |
| `mail_move` | Move email to another folder |
| `mail_delete` | Delete an email |

### Proton Drive (9)
| Tool | Description |
|---|---|
| `drive_list` | List files/folders in Proton Drive |
| `drive_read` | Read file contents |
| `drive_write` | Write/create a file |
| `drive_mkdir` | Create a directory |
| `drive_delete` | Delete a file/folder |
| `drive_move` | Move/rename a file |
| `drive_info` | Get file/folder metadata |
| `drive_search` | Search files by name |
| `drive_stats` | Get drive usage statistics |

### iCloud Drive (9)
| Tool | Description |
|---|---|
| `icloud_list` | List files/folders in iCloud Drive |
| `icloud_read` | Read file contents |
| `icloud_write` | Write/create a file |
| `icloud_mkdir` | Create a directory |
| `icloud_delete` | Delete a file/folder |
| `icloud_move` | Move/rename a file |
| `icloud_info` | Get file/folder metadata |
| `icloud_search` | Search files by name |
| `icloud_stats` | Get drive usage statistics |

### Beeper (22)
Beeper Desktop API + local SQLite database (17GB, 8.3M+ messages).

| Tool | Description |
|---|---|
| `beeper_list_accounts` | List connected messaging accounts |
| `beeper_list_chats` | List chats with filters |
| `beeper_search_chats` | Search chats by name |
| `beeper_get_chat` | Get chat details + participants |
| `beeper_get_messages` | Get messages from a chat |
| `beeper_search_messages` | Search messages across all networks |
| `beeper_send_message` | Send a message to any chat |
| `beeper_mark_read` | Mark messages as read |
| `beeper_add_reaction` | Add emoji reaction |
| `beeper_create_chat` | Create new chat on any platform |
| `beeper_archive_chat` | Archive/unarchive a chat |
| `beeper_search_contacts` | Search contacts on an account |
| `beeper_set_reminder` | Set chat reminder |
| `beeper_get_unread_summary` | Unread summary across all networks |
| `beeper_db_stats` | Database statistics |
| `beeper_db_search` | Full-text search across all messages |
| `beeper_db_history` | Get chat message history |
| `beeper_db_threads` | List threads/chats from database |
| `beeper_db_participants` | Get chat participants |
| `beeper_db_contacts` | Search contacts across all chats |
| `beeper_db_reactions` | Get emoji reactions for a message |
| `beeper_db_analytics` | Messaging analytics |

### Fabric AI (8)
| Tool | Description |
|---|---|
| `fabric_search` | Semantic search across knowledge base |
| `fabric_add_memory` | Add a new memory/fact |
| `fabric_recall_memories` | Recall memories by query |
| `fabric_create_note` | Create a new notepad |
| `fabric_list_notes` | List notepads in a folder |
| `fabric_get_note` | Get a notepad by ID |
| `fabric_update_note` | Update a notepad |
| `fabric_delete_note` | Delete a notepad |

### Quo / OpenPhone (17)
| Tool | Description |
|---|---|
| `quo_list_numbers` | List phone numbers |
| `quo_send_message` | Send SMS |
| `quo_list_messages` | List messages |
| `quo_get_message` | Get a message |
| `quo_list_calls` | List calls |
| `quo_get_call` | Get call details |
| `quo_call_summary` | Get call summary |
| `quo_call_transcript` | Get call transcript |
| `quo_voicemail` | Get voicemail |
| `quo_call_recordings` | Get call recordings |
| `quo_list_contacts` | List contacts |
| `quo_get_contact` | Get a contact |
| `quo_create_contact` | Create a contact |
| `quo_update_contact` | Update a contact |
| `quo_delete_contact` | Delete a contact |
| `quo_list_conversations` | List conversations |
| `quo_list_users` | List users |

### Voicenotes (4)
| Tool | Description |
|---|---|
| `voicenotes_user` | Get user info |
| `voicenotes_list` | List recordings |
| `voicenotes_search` | Search recordings |
| `voicenotes_audio_url` | Get audio URL for a recording |

### Nextcloud (98)
Full Nextcloud integration covering 16 apps: Notes, Calendar, Tasks, Contacts, Files, Deck, Tables, Sharing, Talk, Notifications, Activity, Users, Status, Search, Mail, Tags, Apps, Forms, Comments, Versions, Trashbin.

| Category | Tools | Description |
|---|---|---|
| Notes | 6 | CRUD + search |
| Calendar | 4 | List calendars, events, create/delete events |
| Tasks | 3 | VTODO-capable calendar detection, create tasks |
| Contacts | 5 | CardDAV address books, CRUD + search |
| Files | 9 | WebDAV filesystem, search, favorites |
| Trashbin | 4 | List, restore, delete, empty |
| Deck | 13 | Boards, stacks, cards, labels, assignments |
| Tables | 7 | Tables, columns, rows CRUD |
| Sharing | 5 | Create/manage shares |
| Talk | 10 | Conversations, messages, polls |
| Notifications | 3 | List, dismiss |
| Activity | 1 | Activity feed |
| Users | 3 | User management |
| Status | 3 | User status get/set/clear |
| Search | 2 | Providers + unified search |
| Mail | 5 | Accounts, mailboxes, messages |
| Tags | 4 | Create, assign, unassign |
| Versions | 2 | List, restore |
| Comments | 2 | List, add |
| Apps | 4 | List, info, enable, disable |
| Forms | 3 | List, get, submissions |

## Architecture

```
Client -> https://mcp.garzaos.cloud/sse
         | (Bearer token auth — built-in middleware)
       Caddy (SSL termination, ports 80/443)
         |
       Python FastMCP Server (port 3104, native SSE transport)
         |-- SMTP -> Proton Bridge (:1025)
         |-- IMAP -> Proton Bridge (:1143)
         |-- Proton Drive -> FUSE mount (shell ops)
         |-- iCloud Drive -> FUSE mount (shell ops)
         |-- Beeper API -> localhost:23373
         |-- Beeper DB -> SQLite FTS5 (subprocess)
         |-- Fabric AI -> api.fabric.so (HTTPS)
         |-- Quo API -> api.openphone.com (HTTPS)
         |-- Voicenotes -> api.voicenotes.com (HTTPS)
         |-- Nextcloud -> next.garzaos.online (WebDAV/CalDAV/OCS)
```

**Key improvements over TypeScript version:**
- Native HTTP/SSE transport (no more stdio -> mcp-proxy -> auth_proxy chain)
- Built-in Bearer token auth middleware (no separate auth_proxy.py)
- Per-tool timeouts via `asyncio.wait_for` (prevents cascading 502s)
- Async throughout with httpx (no blocking I/O)
- Shell-based FUSE operations (avoids os.stat() hangs on CloudStorage mounts)
- Server-side IMAP SEARCH (no client-side scan of 736GB mailbox)

## Setup

### Prerequisites
- Python 3.11+
- [uv](https://astral.sh/uv) package manager
- Proton Bridge running locally (SMTP :1025, IMAP :1143)
- Proton Drive synced locally
- iCloud Drive mounted
- Beeper Desktop running (API on :23373)
- BeeperTexts SQLite database

### Install & Run
```bash
uv sync
uv run python -m garza_mcp.server
```

### Environment Variables
Create a `.env` file:
```bash
# Auth
MCP_AUTH_TOKEN=your-bearer-token

# ProtonMail
PROTONMAIL_USERNAME=your@pm.me
PROTONMAIL_PASSWORD=bridge-password
IMAP_HOST=127.0.0.1
IMAP_PORT=1143
SMTP_HOST=127.0.0.1
SMTP_PORT=1025

# Drive (FUSE mounts)
PROTON_DRIVE_PATH=/path/to/ProtonDrive-folder
ICLOUD_DRIVE_PATH=/path/to/iCloud-Drive

# Beeper
BEEPER_API_URL=http://localhost:23373
BEEPER_TOKEN=your-beeper-token
BEEPER_DB_PATH=/path/to/BeeperTexts/index.db

# Fabric AI (optional)
FABRIC_API_KEY=your-fabric-key
FABRIC_API_URL=https://api.fabric.so

# Quo / OpenPhone (optional)
QUO_API_KEY=your-quo-key

# Voicenotes (optional)
VOICENOTES_TOKEN=your-voicenotes-token

# Nextcloud (optional)
NEXTCLOUD_URL=https://your-nextcloud.example.com
NEXTCLOUD_USERNAME=admin
NEXTCLOUD_PASSWORD=your-password

# Server
SERVER_HOST=0.0.0.0
SERVER_PORT=3104
```

## MCP Client Config
```json
{
  "mcpServers": {
    "garza-mcp": {
      "url": "https://mcp.garzaos.cloud/sse",
      "headers": {
        "Authorization": "Bearer your-token"
      }
    }
  }
}
```

## License

MIT
