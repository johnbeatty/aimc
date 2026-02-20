import { Database } from "bun:sqlite";
import { homedir } from "os";
import { join } from "path";

const DB_PATH = join(homedir(), "Library", "Messages", "chat.db");

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
}

/**
 * Apple stores dates as nanoseconds since 2001-01-01.
 * Convert to a JS Date.
 */
function appleTimestampToDate(timestamp: number): Date {
  // Apple epoch is 978307200 seconds after Unix epoch
  const APPLE_EPOCH_OFFSET = 978307200;
  // Timestamps after ~2017 are in nanoseconds; older ones are in seconds
  const seconds =
    timestamp > 1e15 ? timestamp / 1e9 : timestamp;
  return new Date((seconds + APPLE_EPOCH_OFFSET) * 1000);
}

function getRecentMessages(db: Database, limit = 25): MessageRow[] {
  const query = db.query<MessageRow, [number]>(`
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
      c.chat_identifier
    FROM message m
    LEFT JOIN chat_message_join cmj ON cmj.message_id = m.rowid
    LEFT JOIN chat c ON c.rowid = cmj.chat_id
    WHERE m.text IS NOT NULL AND m.text != ''
    ORDER BY m.date DESC
    LIMIT ?
  `);

  return query.all(limit);
}

function formatMessage(msg: MessageRow): string {
  const date = appleTimestampToDate(msg.date);
  const direction = msg.is_from_me ? "→ (sent)" : "← (received)";
  const chat = msg.display_name || msg.chat_identifier || "unknown";
  const text = msg.text?.slice(0, 120) ?? "[no text / attachment]";

  return `[${date.toLocaleString()}] ${direction} ${chat}: ${text}`;
}

// --- Main ---
const db = openDatabase();

console.log(`Reading iMessage database: ${DB_PATH}\n`);

const messages = getRecentMessages(db, 25);

if (messages.length === 0) {
  console.log("No messages found.");
} else {
  console.log(`Last ${messages.length} messages:\n`);
  // Reverse so oldest is first (chronological order)
  for (const msg of messages.reverse()) {
    console.log(formatMessage(msg));
  }
}

db.close();
