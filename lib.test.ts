import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  appleTimestampToDate,
  formatMessage,
  getRecentMessages,
  searchMessages,
  listChats,
  type MessageRow,
} from "./lib";

// ─── Test Database Setup ─────────────────────────────────────────────

/** Create an in-memory SQLite database that mirrors the iMessage schema. */
function createTestDatabase(): Database {
  const db = new Database(":memory:");

  db.exec(`
    CREATE TABLE handle (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL
    );

    CREATE TABLE chat (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      display_name TEXT,
      chat_identifier TEXT NOT NULL,
      service_name TEXT NOT NULL
    );

    CREATE TABLE message (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      guid TEXT NOT NULL,
      text TEXT,
      handle_id INTEGER,
      service TEXT NOT NULL,
      date INTEGER NOT NULL,
      is_from_me INTEGER NOT NULL DEFAULT 0,
      cache_roomnames TEXT
    );

    CREATE TABLE attachment (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT,
      mime_type TEXT
    );

    CREATE TABLE chat_message_join (
      chat_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL
    );

    CREATE TABLE message_attachment_join (
      message_id INTEGER NOT NULL,
      attachment_id INTEGER NOT NULL
    );
  `);

  return db;
}

/** Convert a JS Date to an Apple nanosecond timestamp (since 2001-01-01). */
function dateToAppleTimestamp(date: Date): number {
  const APPLE_EPOCH_OFFSET = 978307200;
  return (date.getTime() / 1000 - APPLE_EPOCH_OFFSET) * 1e9;
}

function seedBasicData(db: Database) {
  // Handles
  db.exec(`
    INSERT INTO handle (rowid, id) VALUES (1, '+15551234567');
    INSERT INTO handle (rowid, id) VALUES (2, '+15559876543');
  `);

  // Chats
  db.exec(`
    INSERT INTO chat (rowid, display_name, chat_identifier, service_name)
      VALUES (1, 'Family Chat', 'chat123', 'iMessage');
    INSERT INTO chat (rowid, display_name, chat_identifier, service_name)
      VALUES (2, NULL, '+15559876543', 'SMS');
  `);

  const t1 = dateToAppleTimestamp(new Date("2025-01-15T10:00:00Z"));
  const t2 = dateToAppleTimestamp(new Date("2025-01-15T10:05:00Z"));
  const t3 = dateToAppleTimestamp(new Date("2025-01-15T10:10:00Z"));
  const t4 = dateToAppleTimestamp(new Date("2025-01-15T11:00:00Z"));

  // Messages
  db.exec(`
    INSERT INTO message (rowid, guid, text, handle_id, service, date, is_from_me)
      VALUES (1, 'guid-1', 'Hello everyone!', 1, 'iMessage', ${t1}, 0);
    INSERT INTO message (rowid, guid, text, handle_id, service, date, is_from_me)
      VALUES (2, 'guid-2', 'Hey there', 0, 'iMessage', ${t2}, 1);
    INSERT INTO message (rowid, guid, text, handle_id, service, date, is_from_me)
      VALUES (3, 'guid-3', NULL, 2, 'SMS', ${t3}, 0);
    INSERT INTO message (rowid, guid, text, handle_id, service, date, is_from_me)
      VALUES (4, 'guid-4', 'Dinner tonight?', 2, 'SMS', ${t4}, 0);
  `);

  // Link messages to chats
  db.exec(`
    INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1);
    INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 2);
    INSERT INTO chat_message_join (chat_id, message_id) VALUES (2, 3);
    INSERT INTO chat_message_join (chat_id, message_id) VALUES (2, 4);
  `);

  // Attachments for message 3 (the NULL-text message)
  db.exec(`
    INSERT INTO attachment (rowid, filename, mime_type)
      VALUES (1, '~/Library/Messages/Attachments/IMG_001.heic', 'image/heic');
    INSERT INTO attachment (rowid, filename, mime_type)
      VALUES (2, '~/Library/Messages/Attachments/IMG_002.jpg', 'image/jpeg');
    INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (3, 1);
    INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (3, 2);
  `);
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("appleTimestampToDate", () => {
  test("converts nanosecond timestamp correctly", () => {
    // 2025-01-01T00:00:00Z in Apple nanoseconds
    const appleNs = (new Date("2025-01-01T00:00:00Z").getTime() / 1000 - 978307200) * 1e9;
    const result = appleTimestampToDate(appleNs);
    expect(result.toISOString()).toBe("2025-01-01T00:00:00.000Z");
  });

  test("converts second-based timestamp (pre-2017 format)", () => {
    // A small timestamp that would be in seconds, not nanoseconds
    // 978307200 + 0 = Unix epoch for 2001-01-01T00:00:00Z
    const result = appleTimestampToDate(0);
    expect(result.toISOString()).toBe("2001-01-01T00:00:00.000Z");
  });

  test("handles the boundary between seconds and nanoseconds", () => {
    // Just above 1e15 should be treated as nanoseconds
    const nsTimestamp = 1e15 + 1;
    const result = appleTimestampToDate(nsTimestamp);
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).not.toBeNaN();
  });
});

describe("formatMessage", () => {
  test("formats a received text message", () => {
    const msg: MessageRow = {
      rowid: 1,
      guid: "guid-1",
      text: "Hello world",
      handle_id: 1,
      service: "iMessage",
      date: dateToAppleTimestamp(new Date("2025-06-01T12:00:00Z")),
      is_from_me: 0,
      cache_roomnames: null,
      display_name: "Family Chat",
      chat_identifier: "chat123",
      handle: "+15551234567",
      attachments: [],
    };
    const result = formatMessage(msg);
    expect(result).toContain("←");
    expect(result).toContain("Family Chat");
    expect(result).toContain("+15551234567");
    expect(result).toContain("Hello world");
  });

  test("formats a sent message", () => {
    const msg: MessageRow = {
      rowid: 2,
      guid: "guid-2",
      text: "Sent message",
      handle_id: 0,
      service: "iMessage",
      date: dateToAppleTimestamp(new Date("2025-06-01T12:00:00Z")),
      is_from_me: 1,
      cache_roomnames: null,
      display_name: "Family Chat",
      chat_identifier: "chat123",
      handle: null,
      attachments: [],
    };
    const result = formatMessage(msg);
    expect(result).toContain("→");
    expect(result).toContain("(me)");
  });

  test("truncates long text at 120 characters", () => {
    const longText = "A".repeat(200);
    const msg: MessageRow = {
      rowid: 1,
      guid: "guid-1",
      text: longText,
      handle_id: 1,
      service: "iMessage",
      date: dateToAppleTimestamp(new Date("2025-06-01T12:00:00Z")),
      is_from_me: 0,
      cache_roomnames: null,
      display_name: "Chat",
      chat_identifier: "chat1",
      handle: "+1555",
      attachments: [],
    };
    const result = formatMessage(msg);
    expect(result).toContain("A".repeat(120) + "...");
    expect(result).not.toContain("A".repeat(121));
  });

  test("formats a single attachment", () => {
    const msg: MessageRow = {
      rowid: 1,
      guid: "guid-1",
      text: null,
      handle_id: 1,
      service: "iMessage",
      date: dateToAppleTimestamp(new Date("2025-06-01T12:00:00Z")),
      is_from_me: 0,
      cache_roomnames: null,
      display_name: "Chat",
      chat_identifier: "chat1",
      handle: "+1555",
      attachments: [{ filename: "/path/to/IMG_001.heic", mime_type: "image/heic" }],
    };
    const result = formatMessage(msg);
    expect(result).toContain("[attachment: IMG_001.heic (image/heic)]");
  });

  test("formats multiple attachments", () => {
    const msg: MessageRow = {
      rowid: 1,
      guid: "guid-1",
      text: null,
      handle_id: 1,
      service: "iMessage",
      date: dateToAppleTimestamp(new Date("2025-06-01T12:00:00Z")),
      is_from_me: 0,
      cache_roomnames: null,
      display_name: "Chat",
      chat_identifier: "chat1",
      handle: "+1555",
      attachments: [
        { filename: "/path/to/IMG_001.heic", mime_type: "image/heic" },
        { filename: "/path/to/IMG_002.jpg", mime_type: "image/jpeg" },
      ],
    };
    const result = formatMessage(msg);
    expect(result).toContain("[attachments:");
    expect(result).toContain("IMG_001.heic (image/heic)");
    expect(result).toContain("IMG_002.jpg (image/jpeg)");
  });

  test("shows fallback when no text and no attachments", () => {
    const msg: MessageRow = {
      rowid: 1,
      guid: "guid-1",
      text: null,
      handle_id: 1,
      service: "iMessage",
      date: dateToAppleTimestamp(new Date("2025-06-01T12:00:00Z")),
      is_from_me: 0,
      cache_roomnames: null,
      display_name: null,
      chat_identifier: null,
      handle: null,
      attachments: [],
    };
    const result = formatMessage(msg);
    expect(result).toContain("[no text / unknown attachment]");
    expect(result).toContain("(unknown)");
  });
});

describe("getRecentMessages", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDatabase();
    seedBasicData(db);
  });

  afterEach(() => {
    db.close();
  });

  test("returns messages ordered by date descending", () => {
    const messages = getRecentMessages(db, 10);
    expect(messages.length).toBe(4);
    // First result is the most recent (highest date)
    expect(messages[0].text).toBe("Dinner tonight?");
  });

  test("respects the limit parameter", () => {
    const messages = getRecentMessages(db, 2);
    expect(messages.length).toBe(2);
  });

  test("includes handle information", () => {
    const messages = getRecentMessages(db, 10);
    const hello = messages.find((m) => m.text === "Hello everyone!")!;
    expect(hello).toBeDefined();
    expect(hello.handle).toBe("+15551234567");
  });

  test("includes chat display name", () => {
    const messages = getRecentMessages(db, 10);
    const hello = messages.find((m) => m.text === "Hello everyone!")!;
    expect(hello).toBeDefined();
    expect(hello.display_name).toBe("Family Chat");
  });

  test("loads attachments for messages", () => {
    const messages = getRecentMessages(db, 10);
    const attachmentMsg = messages.find((m) => m.guid === "guid-3")!;
    expect(attachmentMsg).toBeDefined();
    expect(attachmentMsg.attachments.length).toBe(2);
    expect(attachmentMsg.attachments[0].mime_type).toBe("image/heic");
    expect(attachmentMsg.attachments[1].mime_type).toBe("image/jpeg");
  });

  test("does not duplicate messages with multiple attachments", () => {
    const messages = getRecentMessages(db, 10);
    const guid3Count = messages.filter((m) => m.guid === "guid-3").length;
    expect(guid3Count).toBe(1);
  });

  test("returns empty array when no messages exist", () => {
    const emptyDb = createTestDatabase();
    const messages = getRecentMessages(emptyDb, 10);
    expect(messages.length).toBe(0);
    emptyDb.close();
  });
});

describe("searchMessages", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDatabase();
    seedBasicData(db);
  });

  afterEach(() => {
    db.close();
  });

  test("finds messages matching the search term", () => {
    const results = searchMessages(db, "Hello", 50);
    expect(results.length).toBe(1);
    expect(results[0].text).toBe("Hello everyone!");
  });

  test("search is case-insensitive", () => {
    const results = searchMessages(db, "hello", 50);
    expect(results.length).toBe(1);
  });

  test("matches partial words", () => {
    const results = searchMessages(db, "inner", 50);
    expect(results.length).toBe(1);
    expect(results[0].text).toBe("Dinner tonight?");
  });

  test("returns empty array for no matches", () => {
    const results = searchMessages(db, "nonexistent", 50);
    expect(results.length).toBe(0);
  });

  test("respects the limit parameter", () => {
    const results = searchMessages(db, "e", 1);
    expect(results.length).toBe(1);
  });

  test("does not match NULL text messages", () => {
    const results = searchMessages(db, "IMG", 50);
    expect(results.length).toBe(0);
  });
});

describe("listChats", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDatabase();
    seedBasicData(db);
  });

  afterEach(() => {
    db.close();
  });

  test("returns all chats", () => {
    const chats = listChats(db);
    expect(chats.length).toBe(2);
  });

  test("orders chats by last message date descending", () => {
    const chats = listChats(db);
    // SMS chat has the most recent message (Dinner tonight?)
    expect(chats[0].chat_identifier).toBe("+15559876543");
    expect(chats[1].display_name).toBe("Family Chat");
  });

  test("counts messages per chat correctly", () => {
    const chats = listChats(db);
    const familyChat = chats.find((c) => c.display_name === "Family Chat");
    const smsChat = chats.find((c) => c.chat_identifier === "+15559876543");
    expect(familyChat?.message_count).toBe(2);
    expect(smsChat?.message_count).toBe(2);
  });

  test("includes service name", () => {
    const chats = listChats(db);
    const familyChat = chats.find((c) => c.display_name === "Family Chat");
    expect(familyChat?.service_name).toBe("iMessage");
  });

  test("returns empty array when no chats exist", () => {
    const emptyDb = createTestDatabase();
    const chats = listChats(emptyDb);
    expect(chats.length).toBe(0);
    emptyDb.close();
  });
});
