# Garza MCP

Unified MCP (Model Context Protocol) server combining **ProtonMail**, **Proton Drive**, **iCloud Drive**, **Beeper API**, **Beeper Database**, **Fabric AI**, and **FreeScout Helpdesk** into a single service with 68 tools across 7 services.

Deployed at: `https://mcp.garzaos.cloud/mcp`

## Tools (68)

### ProtonMail (11)
| Tool | Description |
|---|---|
| `mail_status` | Check SMTP/IMAP connection status |
| `mail_send` | Send email via Proton Bridge SMTP |
| `mail_list` | List emails in a folder |
| `mail_read` | Read a specific email by UID |
| `mail_search` | Search emails by subject/sender |
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

### Beeper API (14)
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

### Beeper Database (8)
Direct SQLite queries on the local BeeperTexts database (17GB, 8.3M+ messages).

| Tool | Description |
|---|---|
| `beeper_db_stats` | Database statistics (threads, messages, participants) |
| `beeper_db_search` | Full-text search across all messages |
| `beeper_db_history` | Get chat message history |
| `beeper_db_threads` | List threads/chats from database |
| `beeper_db_participants` | Get chat participants |
| `beeper_db_contacts` | Search contacts across all chats |
| `beeper_db_reactions` | Get emoji reactions for a message |
| `beeper_db_analytics` | Messaging analytics with top chats |

### Fabric AI (8)
Memory, notes, and semantic search via the Fabric AI API. Optional — requires `FABRIC_API_KEY`.

| Tool | Description |
|---|---|
| `fabric_search` | Semantic search across knowledge base |
| `fabric_add_memory` | Add a new memory/fact for future retrieval |
| `fabric_recall_memories` | Recall memories by semantic search query |
| `fabric_create_note` | Create a new notepad/document |
| `fabric_list_notes` | List notepads in a folder |
| `fabric_get_note` | Get a specific notepad by ID |
| `fabric_update_note` | Update an existing notepad |
| `fabric_delete_note` | Delete a notepad |

### FreeScout Helpdesk (9)
Helpdesk ticket management via FreeScout API. Optional — requires `FREESCOUT_URL` and `FREESCOUT_API_KEY`.

| Tool | Description |
|---|---|
| `helpdesk_list_tickets` | List tickets with status filter |
| `helpdesk_get_ticket` | Get full ticket details with threads |
| `helpdesk_create_ticket` | Create a new support ticket |
| `helpdesk_reply` | Reply to or add note on a ticket |
| `helpdesk_update_ticket` | Update ticket status/assignment |
| `helpdesk_list_customers` | List helpdesk customers |
| `helpdesk_search_customers` | Search customers by name/email |
| `helpdesk_list_mailboxes` | List all mailboxes/departments |
| `helpdesk_list_agents` | List all helpdesk agents |

## Architecture

```
Client -> https://mcp.garzaos.cloud/mcp
         | (Bearer token auth)
       Caddy (SSL termination, ports 80/443)
         |
       Auth Proxy (port 3105)
         |
       mcp-proxy (port 3104, Streamable HTTP)
         |
       Node.js MCP Server (this code)
         |-- SMTP -> Proton Bridge (:1025)
         |-- IMAP -> Proton Bridge (:1143)
         |-- Proton Drive -> local sync folder
         |-- iCloud Drive -> local sync folder
         |-- Beeper API -> localhost:23373
         |-- Beeper DB -> SQLite (index.db)
         |-- Fabric AI -> api.fabric.so (HTTPS)
         |-- FreeScout -> support.nomad-os.cloud (HTTPS)
```

## Setup

### Prerequisites
- Node.js >= 18
- Proton Bridge running locally (SMTP :1025, IMAP :1143)
- Proton Drive synced locally
- iCloud Drive mounted
- Beeper Desktop running (API on :23373)
- BeeperTexts SQLite database
- `mcp-proxy` (`pip install mcp-proxy`)

### Environment Variables
```bash
# Required
PROTONMAIL_USERNAME=your@pm.me
PROTONMAIL_PASSWORD=bridge-password
PROTONMAIL_SMTP_HOST=127.0.0.1
PROTONMAIL_SMTP_PORT=1025
PROTONMAIL_IMAP_HOST=127.0.0.1
PROTONMAIL_IMAP_PORT=1143
PROTON_DRIVE_PATH=/path/to/ProtonDrive-folder/
ICLOUD_DRIVE_PATH=/path/to/iCloud-Drive/
BEEPER_API_URL=http://localhost:23373
BEEPER_TOKEN=your-beeper-token
BEEPER_DB_PATH=/path/to/BeeperTexts/index.db

# Optional — Fabric AI
FABRIC_API_KEY=your-fabric-api-key
FABRIC_API_URL=https://api.fabric.so

# Optional — FreeScout Helpdesk
FREESCOUT_URL=https://support.example.com
FREESCOUT_API_KEY=your-freescout-api-key
```

### Build & Run
```bash
npm install
npm run build
npm start
```

### Deploy with mcp-proxy
```bash
mcp-proxy --port 3104 --host 127.0.0.1 --transport streamablehttp \
  -e PROTONMAIL_USERNAME your@pm.me \
  -e PROTONMAIL_PASSWORD bridge-password \
  -e FABRIC_API_KEY your-fabric-key \
  -e FREESCOUT_URL https://support.example.com \
  -e FREESCOUT_API_KEY your-freescout-key \
  # ... other env vars ...
  -- node dist/index.js
```

## CI/CD

GitHub Actions workflows are included:
- **CI** (`.github/workflows/ci.yml`): Runs build + typecheck on Node 18/20/22 for every push and PR
- **Deploy** (`.github/workflows/deploy.yml`): Auto-deploys to the Mac Mini on push to `main`

### Required GitHub Secrets for Deploy
- `MAC_MINI_HOST` — Server IP address
- `MAC_MINI_USER` — SSH username
- `MAC_MINI_PASSWORD` — SSH password

## MCP Client Config
```json
{
  "mcpServers": {
    "garza-mcp": {
      "url": "https://mcp.garzaos.cloud/mcp",
      "headers": {
        "Authorization": "Bearer your-token"
      }
    }
  }
}
```

## License

MIT
