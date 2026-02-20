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

async function cmdSend(args: string[]) {
  // Parse flags: --to <recipient> --text <message> [--file <path>] [--service imessage|sms] [--chat]
  let recipient = "";
  let text = "";
  let file = "";
  let service: "imessage" | "sms" = "imessage";
  let isChat = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--to":
        recipient = args[++i] ?? "";
        break;
      case "--text":
        text = args[++i] ?? "";
        break;
      case "--file":
        file = args[++i] ?? "";
        break;
      case "--service":
        service = (args[++i] ?? "imessage") as "imessage" | "sms";
        break;
      case "--chat":
        isChat = true;
        break;
    }
  }

  if (!recipient) {
    console.error("Error: --to <recipient> is required.\n");
    printUsage();
    process.exit(1);
  }
  if (!text && !file) {
    console.error("Error: at least one of --text or --file is required.\n");
    printUsage();
    process.exit(1);
  }

  try {
    await sendMessage({
      recipient,
      text: text || undefined,
      attachmentPath: file || undefined,
      service,
      isChat,
    });
    console.log(`Message sent to ${recipient}.`);
  } catch (err) {
    console.error(`Failed to send message: ${(err as Error).message}`);
    process.exit(1);
  }
}

function printUsage() {
  console.log(`Usage:
  bun run index.ts recent [limit]           Show recent messages (default: 25)
  bun run index.ts search <term> [limit]    Search messages by keyword (default limit: 50)
  bun run index.ts chats                    List all chats with message counts
  bun run index.ts send --to <recipient> --text <message> [--file <path>] [--service imessage|sms] [--chat]
  bun run index.ts                          Same as 'recent 25'

Send options:
  --to <recipient>       Phone number, email, or chat ID
  --text <message>       Message text to send
  --file <path>          Path to a file to attach
  --service <service>    "imessage" (default) or "sms"
  --chat                 Treat recipient as a chat ID (for group chats)
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
  case "send": {
    await cmdSend(args);
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
