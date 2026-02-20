# imessage_client

A simple Bun script to read the local macOS iMessage database (`chat.db`).

## Prerequisites

- [Bun](https://bun.sh) v1.0+
- macOS (the iMessage database is a macOS-only file)
- **Full Disk Access** granted to your terminal app (System Settings > Privacy & Security > Full Disk Access)

## Setup

```bash
bun install
```

## Usage

```bash
bun run index.ts <command> [options]
```

### Commands

#### `recent [limit]`

Show the most recent messages. Defaults to 25.

```bash
bun run index.ts recent       # last 25 messages
bun run index.ts recent 100   # last 100 messages
```

#### `search <term> [limit]`

Search messages by keyword (case-insensitive substring match). Defaults to 50 results.

```bash
bun run index.ts search "dinner"
bun run index.ts search "football" 100
```

#### `chats`

List all conversations with service type, message count, and last activity date.

```bash
bun run index.ts chats
```

#### `help`

Print usage info.

```bash
bun run index.ts help
```

Running with no arguments is equivalent to `recent 25`.

## How it works

The script reads `~/Library/Messages/chat.db` in **read-only** mode using Bun's built-in `bun:sqlite` driver. No external dependencies are required.

It joins across the core iMessage tables:

| Table | Purpose |
|---|---|
| `message` | Message text, timestamps, direction |
| `handle` | Phone numbers / email addresses |
| `chat` | Conversation names and identifiers |
| `attachment` | File attachments (images, videos, etc.) |
| `chat_message_join` | Links messages to chats |
| `message_attachment_join` | Links messages to attachments |

Apple timestamps are stored as nanoseconds since 2001-01-01 and are converted to JS `Date` objects for display.

## Notes

- The local `chat.db` may contain a limited subset of your messages if "Messages in iCloud" is enabled. Most history lives on Apple's servers and is fetched on-demand by the Messages app.
- Contact names are **not** available in `chat.db`. The script shows phone numbers/emails from the `handle` table. Contact resolution would require reading the separate Contacts database.
