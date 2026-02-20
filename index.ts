import { Database } from "bun:sqlite";
import { homedir } from "os";
import { join } from "path";
import {
  type MessageRow,
  appleTimestampToDate,
  formatMessage,
  getRecentMessages,
  searchMessages,
  listChats,
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

// ─── Commands ────────────────────────────────────────────────────────

function printMessages(messages: MessageRow[]) {
  if (messages.length === 0) {
    console.log("No messages found.");
    return;
  }
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
