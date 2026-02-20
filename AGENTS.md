# AGENTS.md

Guidelines for AI coding agents working in this repository.

## Project Overview

A macOS CLI tool for reading and sending iMessages. Built with **Bun** and **TypeScript** (strict mode). Reads `~/Library/Messages/chat.db` via `bun:sqlite`; sends via AppleScript/`osascript`. Zero external runtime dependencies.

**Architecture:** Two source files plus tests, all at the root level.

| File | Role |
|------|------|
| `lib.ts` | Core library: types, helpers, DB queries, send logic |
| `index.ts` | CLI entry point: arg parsing, command dispatch, output |
| `lib.test.ts` | Test suite using `bun:test` with in-memory SQLite |

## Build / Test / Run Commands

```bash
bun install              # Install dependencies
bun run build            # Compile to standalone binary: ./imessage-client
bun test                 # Run all tests
bun test --only          # Run only tests marked with test.only(...)
bun test --timeout 10000 # Override default test timeout (ms)
```

There is no linter or formatter configured. No CI/CD pipeline exists.

To run a **single test**, use Bun's filter flag:

```bash
bun test --filter "converts nanosecond timestamp"   # Matches test description substring
bun test --filter "formatMessage"                    # Matches describe block name
```

## Code Style

### Formatting

- **2-space indentation**, no tabs
- **Semicolons** always
- **Double quotes** for all strings and imports
- **Trailing commas** on multiline constructs
- **K&R braces** (opening `{` on same line)
- Keep lines under ~100 characters
- Single blank line between functions; no double blank lines
- Arrow functions: always wrap params in parens `(x) => ...`
- Template literals for string interpolation and multi-line SQL

### Imports

Order: Bun builtins (`bun:sqlite`, `bun:test`) -> Node stdlib (`os`, `path`, `fs`, `crypto`) -> local modules (`./lib`). Use named imports with destructuring. No default imports, no wildcard/namespace imports.

Use inline `type` modifier for type-only imports (required by `verbatimModuleSyntax`):

```ts
import { type MessageRow, formatMessage } from "./lib";
```

### Types

- **`interface`** for all structured types (no `type` aliases)
- **Explicit return types** on all functions (exported and internal)
- **Generic type parameters** with `db.query<Row, Params>(...)`
- Use `| null` for nullable DB fields; `?` for optional function params
- **No `any`** -- use `(err as Error).message` in catch blocks if needed
- No `as any` casts; minimize type assertions overall
- Non-null assertion `!` only in test code, never in production

### Naming

| Element | Convention | Examples |
|---------|------------|---------|
| Functions | camelCase | `getRecentMessages`, `cmdSend` |
| Interfaces | PascalCase | `MessageRow`, `SendOptions` |
| Module-level constants | UPPER_SNAKE_CASE | `APPLE_EPOCH_OFFSET`, `DB_PATH` |
| Local variables/params | camelCase | `stagedPath`, `messageIds` |
| DB-facing interface fields | snake_case | `is_from_me`, `handle_id` |
| CLI command functions | `cmd` prefix | `cmdRecent`, `cmdSearch` |
| SQL aliases | single lowercase letter | `m`, `c`, `h`, `a` |

### SQL Style

- Keywords in UPPERCASE: `SELECT`, `FROM`, `LEFT JOIN`, `WHERE`, `ORDER BY`, `LIMIT`
- Multi-line template literals with consistent indentation
- Table aliases as single lowercase letters

### Exports

- **Named exports only** -- no default exports anywhere
- Privacy by omission: don't export internal helpers
- Keep types co-located with the functions that use them

### Error Handling

- `lib.ts`: throw `new Error(...)` with descriptive messages including context (paths, exit codes)
- `index.ts`: `try/catch` at the CLI boundary, `console.error(...)` then `process.exit(1)`
- No Result/Either types or error callbacks -- simple throw/catch pattern
- Include actionable context in error messages (file paths, exit codes, permission hints)

### Async

- `async/await` exclusively -- no `.then()` chains or callbacks
- Only the send functionality is async; DB reads are synchronous (`db.query().all()`)
- Top-level `await` is used in `index.ts` (ESM module)

### File Organization

Sections within files are delimited by decorative banner comments:

```ts
// ─── Types ───────────────────────────────────────────────────────────
// ─── Helpers ─────────────────────────────────────────────────────────
// ─── Queries ─────────────────────────────────────────────────────────
```

Within `lib.ts`: Types at top, then helpers, then queries, then send logic.
Within `index.ts`: Database setup, then command handlers, then main dispatch.

### Comments and Documentation

- **Section banners** using `─` (U+2500) box-drawing chars, padded to ~72 chars
- **JSDoc** on exported functions and interface properties
- **Inline comments** explain "why" not "what"; keep them terse
- Simple query functions rely on names + types as self-documentation

### Other Conventions

- `??` for null/undefined fallback; `||` when empty string should also fall through
- Destructure with defaults: `const { service = "imessage" } = options;`
- `switch` cases wrapped in braces `{ }` for block scoping
- Tests use `describe`/`test` (not `it`); descriptions are lowercase verb phrases
- Test setup via `beforeEach`/`afterEach` with in-memory SQLite databases

## TypeScript Configuration (key flags)

- `"strict": true` with `noUncheckedIndexedAccess` and `noFallthroughCasesInSwitch`
- `"verbatimModuleSyntax": true` -- requires `import { type Foo }` syntax
- `"module": "Preserve"`, `"moduleResolution": "bundler"`
- `"noEmit": true` -- Bun handles compilation, not `tsc`

## Dependencies

- **Runtime:** None (zero external packages)
- **Dev:** `@types/bun` only
- **Bun built-ins used:** `bun:sqlite`, `bun:test`, `Bun.spawn()`, `Bun.build()`
- **Node stdlib used:** `os`, `path`, `fs`, `crypto`
