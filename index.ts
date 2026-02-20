import { Database } from "bun:sqlite";
import { homedir } from "os";
import { join } from "path";
import {
  type MessageRow,
  type ChatRow,
  type AttachmentInfo,
  appleTimestampToDate,
  formatMessage,
  formatAttachmentLine,
  formatChatRow,
  listChats,
  getChatMessages,
  pollNewMessages,
  getMaxRowid,
  sendMessage,
} from "./lib";

const DB_PATH = join(homedir(), "Library", "Messages", "chat.db");

// ─── Database ────────────────────────────────────────────────────────

function openDatabase(): Database {
  try {
    return new Database(DB_PATH, { readonly: true });
  } catch (err) {
    console.error(`Failed to open iMessage database at ${DB_PATH}`);
    console.error(
      "Make sure your terminal app has Full Disk Access in System Settings > Privacy & Security."
    );
    process.exit(1);
  }
}

// ─── Flag Parsing ────────────────────────────────────────────────────

/** Parse --key value and --flag style arguments from an argv slice. */
function parseFlags(args: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = arg;
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      i++;
    } else {
      // Boolean flag (no value)
      flags.set(key, "");
    }
  }
  return flags;
}

/** Parse a flag value as an integer with a default fallback. */
function flagInt(flags: Map<string, string>, key: string, fallback: number): number {
  const raw = flags.get(key);
  if (raw === undefined) {
    return fallback;
  }
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** Parse an ISO 8601 date string from a flag, or return undefined. */
function flagDate(flags: Map<string, string>, key: string): Date | undefined {
  const raw = flags.get(key);
  if (raw === undefined) {
    return undefined;
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    console.error(`Error: invalid date for ${key}: ${raw}`);
    process.exit(1);
  }
  return date;
}

/** Parse a comma-separated list of participants from a flag. */
function flagList(flags: Map<string, string>, key: string): string[] | undefined {
  const raw = flags.get(key);
  if (raw === undefined) {
    return undefined;
  }
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Parse a debounce value like "250ms" or "1s" into milliseconds. */
function flagDebounce(flags: Map<string, string>, key: string, fallback: number): number {
  const raw = flags.get(key);
  if (raw === undefined) {
    return fallback;
  }
  if (raw.endsWith("ms")) {
    const n = parseInt(raw.slice(0, -2), 10);
    return Number.isNaN(n) ? fallback : n;
  }
  if (raw.endsWith("s")) {
    const n = parseFloat(raw.slice(0, -1));
    return Number.isNaN(n) ? fallback : n * 1000;
  }
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}

// ─── JSON Serialisation ──────────────────────────────────────────────

function chatToJson(chat: ChatRow): Record<string, unknown> {
  return {
    chat_id: chat.chat_id,
    display_name: chat.display_name,
    chat_identifier: chat.chat_identifier,
    service_name: chat.service_name,
    message_count: chat.message_count,
    last_message_date: chat.last_message_date
      ? appleTimestampToDate(chat.last_message_date).toISOString()
      : null,
  };
}

function attachmentToJson(att: AttachmentInfo): Record<string, unknown> {
  return {
    filename: att.filename,
    mime_type: att.mime_type,
    resolved_path: att.resolved_path,
    missing: att.missing,
  };
}

function messageToJson(msg: MessageRow, includeAttachments: boolean): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    rowid: msg.rowid,
    guid: msg.guid,
    date: appleTimestampToDate(msg.date).toISOString(),
    is_from_me: !!msg.is_from_me,
    handle: msg.handle,
    chat: msg.display_name || msg.chat_identifier,
    service: msg.service,
    text: msg.text,
  };
  if (includeAttachments && msg.attachments.length > 0) {
    obj.attachments = msg.attachments.map(attachmentToJson);
  }
  return obj;
}

// ─── Commands ────────────────────────────────────────────────────────

function cmdChats(db: Database, flags: Map<string, string>): void {
  const limit = flagInt(flags, "--limit", 20);
  const json = flags.has("--json");

  const chats = listChats(db, limit);

  if (json) {
    console.log(JSON.stringify(chats.map(chatToJson), null, 2));
    return;
  }

  if (chats.length === 0) {
    console.log("No chats found.");
    return;
  }
  for (const chat of chats) {
    console.log(formatChatRow(chat));
  }
}

function printMessages(
  messages: MessageRow[],
  showAttachments: boolean,
  json: boolean
): void {
  if (json) {
    console.log(JSON.stringify(messages.map((m) => messageToJson(m, showAttachments)), null, 2));
    return;
  }

  if (messages.length === 0) {
    console.log("No messages found.");
    return;
  }
  for (const msg of messages) {
    console.log(formatMessage(msg));
    if (showAttachments && msg.attachments.length > 0) {
      for (const att of msg.attachments) {
        console.log(formatAttachmentLine(att));
      }
    }
  }
}

function cmdHistory(db: Database, flags: Map<string, string>): void {
  if (!flags.has("--chat-id")) {
    console.error("Error: --chat-id is required for history.\n");
    printUsage();
    process.exit(1);
  }

  const chatId = flagInt(flags, "--chat-id", 0);
  const limit = flagInt(flags, "--limit", 50);
  const showAttachments = flags.has("--attachments");
  const json = flags.has("--json");
  const participants = flagList(flags, "--participants");
  const start = flagDate(flags, "--start");
  const end = flagDate(flags, "--end");

  const messages = getChatMessages(db, { chatId, limit, participants, start, end });
  // getChatMessages returns DESC; reverse for chronological display
  printMessages([...messages].reverse(), showAttachments, json);
}

async function cmdWatch(db: Database, flags: Map<string, string>): Promise<void> {
  const chatId = flags.has("--chat-id") ? flagInt(flags, "--chat-id", 0) : undefined;
  const debounce = flagDebounce(flags, "--debounce", 250);
  const showAttachments = flags.has("--attachments");
  const json = flags.has("--json");
  const debug = flags.has("--debug");
  const participants = flagList(flags, "--participants");
  const start = flagDate(flags, "--start");
  const end = flagDate(flags, "--end");

  let sinceRowid = flags.has("--since-rowid")
    ? flagInt(flags, "--since-rowid", 0)
    : getMaxRowid(db);

  if (!json) {
    console.log(`Watching for new messages (since rowid ${sinceRowid}, polling every ${debounce}ms)...`);
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const messages = pollNewMessages(db, sinceRowid, {
      chatId,
      participants,
      start,
      end,
    });

    if (debug) {
      const maxRowid = getMaxRowid(db);
      const lastRowid = messages.length > 0 ? messages[messages.length - 1]!.rowid : "-";
      console.error(
        `[debug] since=${sinceRowid} max=${maxRowid} batch=${messages.length} last=${lastRowid}`
      );
    }

    if (messages.length > 0) {
      if (json) {
        // In JSON mode emit one JSON array per batch (newline-delimited)
        console.log(JSON.stringify(messages.map((m) => messageToJson(m, showAttachments))));
      } else {
        for (const msg of messages) {
          console.log(formatMessage(msg));
          if (showAttachments && msg.attachments.length > 0) {
            for (const att of msg.attachments) {
              console.log(formatAttachmentLine(att));
            }
          }
        }
      }
      // Advance cursor to the highest rowid we've seen
      sinceRowid = messages[messages.length - 1]!.rowid;
    }

    await Bun.sleep(debounce);
  }
}

async function cmdSend(flags: Map<string, string>): Promise<void> {
  const recipient = flags.get("--to") ?? "";
  const text = flags.get("--text") ?? "";
  const file = flags.get("--file") ?? "";
  const rawService = flags.get("--service") ?? "imessage";
  const region = flags.get("--region");

  if (!recipient) {
    console.error("Error: --to <handle> is required.\n");
    printUsage();
    process.exit(1);
  }
  if (!text && !file) {
    console.error("Error: at least one of --text or --file is required.\n");
    printUsage();
    process.exit(1);
  }

  const service = rawService as "imessage" | "sms" | "auto";

  try {
    await sendMessage({
      recipient,
      text: text || undefined,
      attachmentPath: file || undefined,
      service,
      region,
    });
    console.log(`Message sent to ${recipient}.`);
  } catch (err) {
    console.error(`Failed to send message: ${(err as Error).message}`);
    process.exit(1);
  }
}

function printUsage(): void {
  console.log(`Usage:
  aimc chats [--limit 20] [--json]
  aimc history --chat-id <id> [--limit 50] [--attachments]
               [--participants +15551234567,...] [--start <ISO>] [--end <ISO>] [--json]
  aimc watch [--chat-id <id>] [--since-rowid <n>] [--debounce 250ms]
             [--attachments] [--participants ...] [--start <ISO>] [--end <ISO>] [--json] [--debug]
  aimc send --to <handle> [--text "hi"] [--file /path/img.jpg]
            [--service imessage|sms|auto] [--region US]

Examples:
  aimc chats --limit 5
  aimc chats --limit 5 --json
  aimc history --chat-id 1 --limit 10 --attachments
  aimc history --chat-id 1 --start 2025-01-01T00:00:00Z --json
  aimc watch --chat-id 1 --attachments --debounce 250ms
  aimc send --to "+14155551212" --text "hi" --file ~/Desktop/pic.jpg --service imessage
`);
}

// ─── Main ────────────────────────────────────────────────────────────

const [command, ...args] = process.argv.slice(2);
const flags = parseFlags(args);

switch (command) {
  case "chats": {
    const db = openDatabase();
    cmdChats(db, flags);
    db.close();
    break;
  }
  case "history": {
    const db = openDatabase();
    cmdHistory(db, flags);
    db.close();
    break;
  }
  case "watch": {
    const db = openDatabase();
    await cmdWatch(db, flags);
    // watch runs forever; db.close() is unreachable but placed for completeness
    db.close();
    break;
  }
  case "send": {
    await cmdSend(flags);
    break;
  }
  case "help":
  case "--help":
  case "-h": {
    printUsage();
    break;
  }
  default: {
    printUsage();
    break;
  }
}
