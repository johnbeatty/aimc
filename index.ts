import { Database } from "bun:sqlite";
import { homedir } from "os";
import { join } from "path";

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

// ─── Types ───────────────────────────────────────────────────────────

interface MessageRow {
  rowid: number;
  guid: string;
  text: string | null;
  handle_id: number;
  service: string;
  date: number;
  is_from_me: number;
  cache_roomnames: string | null;
  display_name: string | null;
  chat_identifier: string | null;
  handle: string | null;
  attachments: AttachmentInfo[];
}

interface ChatRow {
  chat_id: number;
  display_name: string | null;
  chat_identifier: string;
  service_name: string;
  message_count: number;
  last_message_date: number;
}

interface AttachmentInfo {
  filename: string;
  mime_type: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Apple stores dates as nanoseconds since 2001-01-01. Convert to JS Date. */
function appleTimestampToDate(timestamp: number): Date {
  const APPLE_EPOCH_OFFSET = 978307200;
  const seconds = timestamp > 1e15 ? timestamp / 1e9 : timestamp;
  return new Date((seconds + APPLE_EPOCH_OFFSET) * 1000);
}

function formatMessage(msg: MessageRow): string {
  const date = appleTimestampToDate(msg.date);
  const direction = msg.is_from_me ? "→" : "←";
  const sender = msg.is_from_me ? "me" : (msg.handle ?? "unknown");
  const chat = msg.display_name || msg.chat_identifier || msg.handle || "unknown";

  let body: string;
  if (msg.text) {
    body = msg.text.length > 120 ? msg.text.slice(0, 120) + "..." : msg.text;
  } else if (msg.attachments.length > 0) {
    const formatted = msg.attachments.map((attachment) => {
      const name = attachment.filename.split("/").pop() ?? attachment.filename;
      const mime = attachment.mime_type ?? "unknown type";
      return `${name} (${mime})`;
    });
    if (formatted.length === 1) {
      body = `[attachment: ${formatted[0]}]`;
    } else {
      body = `[attachments: ${formatted.join(", ")}]`;
    }
  } else {
    body = "[no text / unknown attachment]";
  }

  return `[${date.toLocaleString()}] ${direction} ${chat} (${sender}): ${body}`;
}

// ─── Queries ─────────────────────────────────────────────────────────

const MESSAGE_SELECT = `
  SELECT
    m.rowid,
    m.guid,
    m.text,
    m.handle_id,
    m.service,
    m.date,
    m.is_from_me,
    m.cache_roomnames,
    c.display_name,
    c.chat_identifier,
    h.id AS handle
  FROM message m
  LEFT JOIN chat_message_join cmj ON cmj.message_id = m.rowid
  LEFT JOIN chat c ON c.rowid = cmj.chat_id
  LEFT JOIN handle h ON h.rowid = m.handle_id
`;

interface AttachmentRow {
  message_id: number;
  filename: string | null;
  mime_type: string | null;
}

function loadAttachments(
  db: Database,
  messageIds: number[]
): Map<number, AttachmentInfo[]> {
  const attachmentsByMessage = new Map<number, AttachmentInfo[]>();

  if (messageIds.length === 0) {
    return attachmentsByMessage;
  }

  const placeholders = messageIds.map(() => "?").join(", ");
  const query = db.query<AttachmentRow, number[]>(`
    SELECT
      maj.message_id AS message_id,
      a.filename AS filename,
      a.mime_type AS mime_type
    FROM message_attachment_join maj
    INNER JOIN attachment a ON a.rowid = maj.attachment_id
    WHERE maj.message_id IN (${placeholders})
  `);

  const rows = query.all(...messageIds);

  for (const row of rows) {
    if (!row.filename) {
      continue;
    }
    const attachments = attachmentsByMessage.get(row.message_id) ?? [];
    attachments.push({ filename: row.filename, mime_type: row.mime_type });
    attachmentsByMessage.set(row.message_id, attachments);
  }

  return attachmentsByMessage;
}

function attachAttachments(db: Database, messages: MessageRow[]): MessageRow[] {
  const messageIds = messages.map((message) => message.rowid);
  const attachmentsByMessage = loadAttachments(db, messageIds);

  for (const message of messages) {
    message.attachments = attachmentsByMessage.get(message.rowid) ?? [];
  }

  return messages;
}

function getRecentMessages(db: Database, limit: number): MessageRow[] {
  const query = db.query<MessageRow, [number]>(`
    ${MESSAGE_SELECT}
    ORDER BY m.date DESC
    LIMIT ?
  `);
  const messages = query.all(limit);
  return attachAttachments(db, messages);
}

function searchMessages(db: Database, term: string, limit: number): MessageRow[] {
  const query = db.query<MessageRow, [string, number]>(`
    ${MESSAGE_SELECT}
    WHERE m.text LIKE ?
    ORDER BY m.date DESC
    LIMIT ?
  `);
  const messages = query.all(`%${term}%`, limit);
  return attachAttachments(db, messages);
}

function listChats(db: Database): ChatRow[] {
  const query = db.query<ChatRow, []>(`
    SELECT
      c.rowid AS chat_id,
      c.display_name,
      c.chat_identifier,
      c.service_name,
      COUNT(cmj.message_id) AS message_count,
      MAX(m.date) AS last_message_date
    FROM chat c
    LEFT JOIN chat_message_join cmj ON cmj.chat_id = c.rowid
    LEFT JOIN message m ON m.rowid = cmj.message_id
    GROUP BY c.rowid
    ORDER BY last_message_date DESC
  `);
  return query.all();
}

// ─── Commands ────────────────────────────────────────────────────────

function printMessages(messages: MessageRow[]) {
  if (messages.length === 0) {
    console.log("No messages found.");
    return;
  }
  // Reverse to chronological order (oldest first)
  for (const msg of [...messages].reverse()) {
    console.log(formatMessage(msg));
  }
}

function cmdRecent(db: Database, limit: number) {
  console.log(`Last ${limit} messages:\n`);
  const messages = getRecentMessages(db, limit);
  printMessages(messages);
}

function cmdSearch(db: Database, term: string, limit: number) {
  console.log(`Searching for "${term}" (limit ${limit}):\n`);
  const messages = searchMessages(db, term, limit);
  console.log(`Found ${messages.length} result(s).\n`);
  printMessages(messages);
}

function cmdChats(db: Database) {
  const chats = listChats(db);
  if (chats.length === 0) {
    console.log("No chats found.");
    return;
  }
  console.log(`Found ${chats.length} chat(s):\n`);
  for (const chat of chats) {
    const name = chat.display_name || chat.chat_identifier;
    const lastDate = chat.last_message_date
      ? appleTimestampToDate(chat.last_message_date).toLocaleString()
      : "never";
    console.log(
      `  ${name}  [${chat.service_name}]  ${chat.message_count} messages  (last: ${lastDate})`
    );
  }
}

function printUsage() {
  console.log(`Usage:
  bun run index.ts recent [limit]     Show recent messages (default: 25)
  bun run index.ts search <term> [limit]  Search messages by keyword (default limit: 50)
  bun run index.ts chats              List all chats with message counts
  bun run index.ts                    Same as 'recent 25'
`);
}

// ─── Main ────────────────────────────────────────────────────────────

const db = openDatabase();
console.log(`iMessage database: ${DB_PATH}\n`);

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "recent": {
    const limit = parseInt(args[0] ?? "25") || 25;
    cmdRecent(db, limit);
    break;
  }
  case "search": {
    if (!args[0]) {
      console.error("Error: search requires a term.\n");
      printUsage();
      process.exit(1);
    }
    const term = args[0];
    const limit = parseInt(args[1] ?? "50") || 50;
    cmdSearch(db, term, limit);
    break;
  }
  case "chats": {
    cmdChats(db);
    break;
  }
  case "help":
  case "--help":
  case "-h": {
    printUsage();
    break;
  }
  default: {
    cmdRecent(db, 25);
    break;
  }
}

db.close();
