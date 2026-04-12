# Garza MCP

Unified MCP (Model Context Protocol) server combining **ProtonMail**, **Proton Drive**, **iCloud Drive**, **Beeper API**, and **Beeper Database** into a single service with 51 tools.

> **ProtonMail IMAP Note:** The server is tuned for a 736 GB mailbox behind Proton Bridge.
> IMAP operations use 60-90 s timeouts, server-side SEARCH (instead of client-side
> filtering), and automatic reconnection with retries to avoid timeouts during
> Proton Bridge sync.

Deployed at: `https://mcp.garzaos.cloud/mcp`

## Tools (51)

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

### Proton Drive (9) — list, read, write, mkdir, delete, move, info, search, stats
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

### iCloud Drive (9) — list, read, write, mkdir, delete, move, info, search, stats
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

## Architecture

```
Client → https://mcp.garzaos.cloud/mcp
         ↓ (Bearer token auth)
       Caddy (SSL termination, ports 80/443)
         ↓
       Auth Proxy (port 3105)
         ↓
       mcp-proxy (port 3104, Streamable HTTP)
         ↓
       Node.js MCP Server (this code)
         ├── SMTP → Proton Bridge (:1025)
         ├── IMAP → Proton Bridge (:1143)
         ├── Proton Drive → local sync folder
         ├── iCloud Drive → local sync folder
         ├── Beeper API → localhost:23373
         └── Beeper DB → SQLite (index.db)
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
  # ... other env vars ...
  -- node dist/index.js
```

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
