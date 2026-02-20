import { Database } from "bun:sqlite";
import { homedir } from "os";
import { join, basename } from "path";
import { existsSync, mkdirSync, copyFileSync } from "fs";
import { randomUUID } from "crypto";

// ─── Types ───────────────────────────────────────────────────────────

export interface MessageRow {
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

export interface ChatRow {
  chat_id: number;
  display_name: string | null;
  chat_identifier: string;
  service_name: string;
  message_count: number;
  last_message_date: number;
}

export interface AttachmentInfo {
  /** Raw filename from the database (may contain ~/). */
  filename: string;
  mime_type: string | null;
  /** Tilde-expanded absolute path. */
  resolved_path: string;
  /** True when the resolved file does not exist on disk. */
  missing: boolean;
}

export interface HistoryOptions {
  /** chat rowid to fetch messages for. */
  chatId: number;
  /** Maximum number of messages to return. */
  limit?: number;
  /** Filter to messages involving these handles (phone/email). */
  participants?: string[];
  /** Only messages on or after this date. */
  start?: Date;
  /** Only messages before this date. */
  end?: Date;
}

export interface WatchOptions {
  /** chat rowid; if omitted, watch all chats. */
  chatId?: number;
  /** Only return messages with rowid greater than this. */
  sinceRowid?: number;
  /** Polling interval in milliseconds. */
  debounce?: number;
  /** Filter to messages involving these handles (phone/email). */
  participants?: string[];
  /** Only messages on or after this date. */
  start?: Date;
  /** Only messages before this date. */
  end?: Date;
}

// ─── Helpers ─────────────────────────────────────────────────────────

const APPLE_EPOCH_OFFSET = 978307200;

/** Apple stores dates as nanoseconds since 2001-01-01. Convert to JS Date. */
export function appleTimestampToDate(timestamp: number): Date {
  const seconds = timestamp > 1e15 ? timestamp / 1e9 : timestamp;
  return new Date((seconds + APPLE_EPOCH_OFFSET) * 1000);
}

/** Convert a JS Date to an Apple nanosecond timestamp (since 2001-01-01). */
export function dateToAppleTimestamp(date: Date): number {
  return (date.getTime() / 1000 - APPLE_EPOCH_OFFSET) * 1e9;
}

export function formatMessage(msg: MessageRow): string {
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

/** Format a single attachment as a metadata line for --attachments output. */
export function formatAttachmentLine(att: AttachmentInfo): string {
  const name = basename(att.resolved_path);
  const mime = att.mime_type ?? "unknown";
  const flag = att.missing ? " [missing]" : "";
  return `  📎 ${name}  (${mime})${flag}  ${att.resolved_path}`;
}

/** Format a ChatRow as a human-readable line. */
export function formatChatRow(chat: ChatRow): string {
  const name = chat.display_name || chat.chat_identifier;
  const lastDate = chat.last_message_date
    ? appleTimestampToDate(chat.last_message_date).toLocaleString()
    : "never";
  return `  [${chat.chat_id}] ${name}  [${chat.service_name}]  ${chat.message_count} messages  (last: ${lastDate})`;
}

// ─── Queries ─────────────────────────────────────────────────────────

/** Marker bytes in NSArchiver-encoded attributedBody preceding the plain text. */
const ATTRIBUTED_BODY_TEXT_MARKER = Buffer.from([0x01, 0x2b]);

/**
 * Extract plain text from the NSArchiver-encoded attributedBody blob.
 *
 * The blob stores an NSAttributedString; the raw text lives after a
 * `\x01\x2B` marker followed by a variable-length byte count:
 *   - count < 0x80 → single byte length
 *   - 0x81         → next 2 bytes (little-endian) are the byte length
 *   - 0x82         → next 3 bytes (little-endian) are the byte length
 *   - 0x83         → next 4 bytes (little-endian) are the byte length
 */
export function extractTextFromAttributedBody(blob: Uint8Array | null): string | null {
  if (!blob || blob.length === 0) {
    return null;
  }

  // Ensure we have a Buffer so we can use indexOf with a multi-byte needle.
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);

  const markerIndex = buf.indexOf(ATTRIBUTED_BODY_TEXT_MARKER);
  if (markerIndex < 0) {
    return null;
  }

  let offset = markerIndex + 2;
  if (offset >= buf.length) {
    return null;
  }

  const firstByte = buf[offset]!;
  let byteLength: number;

  if (firstByte < 0x80) {
    byteLength = firstByte;
    offset += 1;
  } else {
    // High bit set: the low 7 bits + 1 gives the number of following bytes
    // that encode the length in little-endian order.
    const lengthBytes = (firstByte & 0x7f) + 1;
    offset += 1;
    if (offset + lengthBytes > buf.length) {
      return null;
    }
    byteLength = 0;
    for (let i = 0; i < lengthBytes; i++) {
      byteLength |= buf[offset + i]! << (8 * i);
    }
    offset += lengthBytes;
  }

  if (byteLength <= 0 || offset + byteLength > buf.length) {
    return null;
  }

  const text = buf.subarray(offset, offset + byteLength).toString("utf-8");
  return text.length > 0 ? text : null;
}

/**
 * Fill in `text` from `attributedBody` for any message where `text` is null.
 */
function hydrateAttributedBodyText(messages: RawMessageRow[]): MessageRow[] {
  return messages.map((msg) => {
    const { attributed_body, ...rest } = msg;
    const hydrated: MessageRow = { ...rest, attachments: [] };
    if (hydrated.text === null && attributed_body) {
      hydrated.text = extractTextFromAttributedBody(attributed_body);
    }
    return hydrated;
  });
}

/**
 * Raw row type returned by SQL queries that includes the attributedBody blob.
 * This is converted to MessageRow after text hydration.
 */
interface RawMessageRow {
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
  attributed_body: Uint8Array | null;
}

const MESSAGE_SELECT = `
  SELECT
    m.rowid AS rowid,
    m.guid,
    m.text,
    m.handle_id,
    m.service,
    m.date,
    m.is_from_me,
    m.cache_roomnames,
    m.attributedBody AS attributed_body,
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
    const resolvedPath = row.filename.replace(/^~/, homedir());
    const attachments = attachmentsByMessage.get(row.message_id) ?? [];
    attachments.push({
      filename: row.filename,
      mime_type: row.mime_type,
      resolved_path: resolvedPath,
      missing: !existsSync(resolvedPath),
    });
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

/** Hydrate attributedBody text and attach attachments in one pass. */
function processRawMessages(db: Database, rawMessages: RawMessageRow[]): MessageRow[] {
  const messages = hydrateAttributedBodyText(rawMessages);
  return attachAttachments(db, messages);
}

export function getRecentMessages(db: Database, limit: number): MessageRow[] {
  const query = db.query<RawMessageRow, [number]>(`
    ${MESSAGE_SELECT}
    ORDER BY m.date DESC
    LIMIT ?
  `);
  const rawMessages = query.all(limit);
  return processRawMessages(db, rawMessages);
}

export function searchMessages(db: Database, term: string, limit: number): MessageRow[] {
  const query = db.query<RawMessageRow, [string, string, number]>(`
    ${MESSAGE_SELECT}
    WHERE (m.text LIKE ? OR m.attributedBody LIKE ?)
    ORDER BY m.date DESC
    LIMIT ?
  `);
  const rawMessages = query.all(`%${term}%`, `%${term}%`, limit);
  return processRawMessages(db, rawMessages);
}

export function listChats(db: Database, limit?: number): ChatRow[] {
  const sql = `
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
    ${limit !== undefined ? "LIMIT ?" : ""}
  `;
  if (limit !== undefined) {
    return db.query<ChatRow, [number]>(sql).all(limit);
  }
  return db.query<ChatRow, []>(sql).all();
}

/** Fetch messages for a specific chat, with optional filters. */
export function getChatMessages(db: Database, options: HistoryOptions): MessageRow[] {
  const { chatId, limit = 50, participants, start, end } = options;

  const conditions: string[] = ["cmj.chat_id = ?"];
  const params: (number | string)[] = [chatId];

  if (participants && participants.length > 0) {
    const placeholders = participants.map(() => "?").join(", ");
    conditions.push(`h.id IN (${placeholders})`);
    params.push(...participants);
  }

  if (start) {
    conditions.push("m.date >= ?");
    params.push(dateToAppleTimestamp(start));
  }

  if (end) {
    conditions.push("m.date < ?");
    params.push(dateToAppleTimestamp(end));
  }

  const where = conditions.join(" AND ");

  const sql = `
    ${MESSAGE_SELECT}
    WHERE ${where}
    ORDER BY m.date DESC
    LIMIT ?
  `;

  params.push(limit);
  const query = db.query<RawMessageRow, (number | string)[]>(sql);
  const rawMessages = query.all(...params);
  return processRawMessages(db, rawMessages);
}

/**
 * Poll for new messages with rowid > sinceRowid. Returns the new messages.
 *
 * Wraps queries in an explicit BEGIN/COMMIT so the WAL-mode readonly
 * connection picks up writes made by iMessage since the last poll.
 */
export function pollNewMessages(
  db: Database,
  sinceRowid: number,
  options?: {
    chatId?: number;
    participants?: string[];
    start?: Date;
    end?: Date;
  }
): MessageRow[] {
  const conditions: string[] = ["m.rowid > ?"];
  const params: (number | string)[] = [sinceRowid];

  if (options?.chatId !== undefined) {
    conditions.push("cmj.chat_id = ?");
    params.push(options.chatId);
  }

  if (options?.participants && options.participants.length > 0) {
    const placeholders = options.participants.map(() => "?").join(", ");
    conditions.push(`h.id IN (${placeholders})`);
    params.push(...options.participants);
  }

  if (options?.start) {
    conditions.push("m.date >= ?");
    params.push(dateToAppleTimestamp(options.start));
  }

  if (options?.end) {
    conditions.push("m.date < ?");
    params.push(dateToAppleTimestamp(options.end));
  }

  const where = conditions.join(" AND ");

  const sql = `
    ${MESSAGE_SELECT}
    WHERE ${where}
    ORDER BY m.rowid ASC
  `;

  // BEGIN/COMMIT forces SQLite to release the old WAL read-mark and acquire
  // a fresh one, ensuring we see rows written by other processes.
  db.run("BEGIN");
  try {
    const query = db.query<RawMessageRow, (number | string)[]>(sql);
    const rawMessages = query.all(...params);
    db.run("COMMIT");
    return processRawMessages(db, rawMessages);
  } catch (err) {
    db.run("ROLLBACK");
    throw err;
  }
}

/** Get the maximum message rowid in the database. */
export function getMaxRowid(db: Database): number {
  const row = db.query<{ max_rowid: number | null }, []>(
    "SELECT MAX(rowid) AS max_rowid FROM message"
  ).get();
  return row?.max_rowid ?? 0;
}

// ─── Send ────────────────────────────────────────────────────────────

export interface SendOptions {
  /** Phone number, email, or chat ID to send to. */
  recipient: string;
  /** Message text. At least one of text or attachmentPath is required. */
  text?: string;
  /** Path to a file to attach. */
  attachmentPath?: string;
  /** "imessage", "sms", or "auto". Defaults to "imessage". */
  service?: "imessage" | "sms" | "auto";
  /** If true, treat recipient as a chat ID instead of a buddy. */
  isChat?: boolean;
  /** Region hint for phone number formatting (e.g. "US"). Currently informational. */
  region?: string;
}

/**
 * Stage an attachment into ~/Library/Messages/Attachments/aimc/<uuid>/
 * so Messages.app can access it. Returns the staged file path.
 */
export function stageAttachment(sourcePath: string): string {
  const expandedPath = sourcePath.replace(/^~/, homedir());
  if (!existsSync(expandedPath)) {
    throw new Error(`Attachment not found: ${expandedPath}`);
  }

  const stagingDir = join(
    homedir(),
    "Library",
    "Messages",
    "Attachments",
    "aimc",
    randomUUID()
  );
  mkdirSync(stagingDir, { recursive: true });

  const destPath = join(stagingDir, basename(expandedPath));
  copyFileSync(expandedPath, destPath);
  return destPath;
}

/**
 * Build the AppleScript source for sending a message via Messages.app.
 */
export function buildSendAppleScript(options: {
  recipient: string;
  text: string;
  service: string;
  attachmentPath: string;
  useAttachment: boolean;
  chatId: string;
  useChat: boolean;
}): string {
  // All values are passed as arguments to the "on run" handler for safety.
  return `on run argv
  set theRecipient to item 1 of argv
  set theMessage to item 2 of argv
  set theService to item 3 of argv
  set theFilePath to item 4 of argv
  set useAttachment to item 5 of argv
  set chatId to item 6 of argv
  set useChat to item 7 of argv

  tell application "Messages"
    if useChat is "1" then
      set targetChat to chat id chatId
      if theMessage is not "" then
        send theMessage to targetChat
      end if
      if useAttachment is "1" then
        set theFile to POSIX file theFilePath as alias
        send theFile to targetChat
      end if
    else
      if theService is "sms" then
        set targetService to first service whose service type is SMS
      else
        set targetService to first service whose service type is iMessage
      end if
      set targetBuddy to buddy theRecipient of targetService
      if theMessage is not "" then
        send theMessage to targetBuddy
      end if
      if useAttachment is "1" then
        set theFile to POSIX file theFilePath as alias
        send theFile to targetBuddy
      end if
    end if
  end tell
end run`;
}

/**
 * Send an iMessage/SMS using Messages.app via AppleScript.
 */
export async function sendMessage(options: SendOptions): Promise<void> {
  const { recipient, text, attachmentPath, service: rawService = "imessage", isChat = false } = options;

  // "auto" resolves to "imessage" -- AppleScript will fall back to SMS if needed
  const service = rawService === "auto" ? "imessage" : rawService;

  if (!text && !attachmentPath) {
    throw new Error("At least one of text or attachmentPath is required.");
  }

  // Stage attachment if provided
  let stagedPath = "";
  if (attachmentPath) {
    stagedPath = stageAttachment(attachmentPath);
  }

  const useAttachment = stagedPath !== "";
  const scriptSource = buildSendAppleScript({
    recipient,
    text: text ?? "",
    service,
    attachmentPath: stagedPath,
    useAttachment,
    chatId: isChat ? recipient : "",
    useChat: isChat,
  });

  const args = [
    recipient,
    text ?? "",
    service,
    stagedPath,
    useAttachment ? "1" : "0",
    isChat ? recipient : "",
    isChat ? "1" : "0",
  ];

  // Execute via osascript
  const proc = Bun.spawn(
    ["/usr/bin/osascript", "-", ...args],
    {
      stdin: new TextEncoder().encode(scriptSource),
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`AppleScript failed (exit ${exitCode}): ${stderr.trim()}`);
  }
}
