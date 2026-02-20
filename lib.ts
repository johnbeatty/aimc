import { Database } from "bun:sqlite";

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
