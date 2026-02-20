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
  filename: string;
  mime_type: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Apple stores dates as nanoseconds since 2001-01-01. Convert to JS Date. */
export function appleTimestampToDate(timestamp: number): Date {
  const APPLE_EPOCH_OFFSET = 978307200;
  const seconds = timestamp > 1e15 ? timestamp / 1e9 : timestamp;
  return new Date((seconds + APPLE_EPOCH_OFFSET) * 1000);
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

export function getRecentMessages(db: Database, limit: number): MessageRow[] {
  const query = db.query<MessageRow, [number]>(`
    ${MESSAGE_SELECT}
    ORDER BY m.date DESC
    LIMIT ?
  `);
  const messages = query.all(limit);
  return attachAttachments(db, messages);
}

export function searchMessages(db: Database, term: string, limit: number): MessageRow[] {
  const query = db.query<MessageRow, [string, number]>(`
    ${MESSAGE_SELECT}
    WHERE m.text LIKE ?
    ORDER BY m.date DESC
    LIMIT ?
  `);
  const messages = query.all(`%${term}%`, limit);
  return attachAttachments(db, messages);
}

export function listChats(db: Database): ChatRow[] {
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

// ─── Send ────────────────────────────────────────────────────────────

export interface SendOptions {
  /** Phone number, email, or chat ID to send to. */
  recipient: string;
  /** Message text. At least one of text or attachmentPath is required. */
  text?: string;
  /** Path to a file to attach. */
  attachmentPath?: string;
  /** "imessage" or "sms". Defaults to "imessage". */
  service?: "imessage" | "sms";
  /** If true, treat recipient as a chat ID instead of a buddy. */
  isChat?: boolean;
}

/**
 * Stage an attachment into ~/Library/Messages/Attachments/imsg/<uuid>/
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
    "imsg",
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
  const { recipient, text, attachmentPath, service = "imessage", isChat = false } = options;

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
