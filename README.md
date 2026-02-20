# Another iMessage Client

A simple Bun CLI to read and send iMessages on macOS.

## Prerequisites

- [Bun](https://bun.sh) v1.0+
- macOS (the iMessage database is a macOS-only file)
- **Full Disk Access** granted to your terminal app (System Settings > Privacy & Security > Full Disk Access) — required for reading messages
- **Automation permission** for Messages.app — macOS will prompt on first send

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

#### `send --to <recipient> --text <message> [options]`

Send an iMessage or SMS via the Messages app.

```bash
bun run index.ts send --to "+15551234567" --text "Hello!"
bun run index.ts send --to "+15551234567" --text "Check this out" --file ~/photo.jpg
bun run index.ts send --to "+15551234567" --text "Hey" --service sms
bun run index.ts send --to "iMessage;+;chat123456" --text "Hey group!" --chat
```

| Option | Description |
|---|---|
| `--to <recipient>` | Phone number, email, or chat ID (required) |
| `--text <message>` | Message text (required unless `--file` is provided) |
| `--file <path>` | Path to a file to attach |
| `--service <svc>` | `imessage` (default) or `sms` |
| `--chat` | Treat `--to` as a chat ID (for group chats) |

Sending works by executing AppleScript against the Messages app — no private APIs are used.

#### `help`

Print usage info.

```bash
bun run index.ts help
```

Running with no arguments is equivalent to `recent 25`.

## Tests

```bash
bun test
```

## Releases

Download the `aimc` binary for your Mac from the GitHub Releases page, then verify it:

```bash
shasum -a 256 -c aimc.sha256
```

## How it works

**Reading:** The script reads `~/Library/Messages/chat.db` in **read-only** mode using Bun's built-in `bun:sqlite` driver. No external dependencies are required.

**Sending:** Messages are sent via AppleScript using the Messages.app Scripting Dictionary (`tell application "Messages" to send ...`). Attachments are staged into `~/Library/Messages/Attachments/aimc/` before sending so Messages.app can access them.

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
