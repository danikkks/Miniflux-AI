# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm install        # install dependencies
npm run build      # compile TypeScript (src/ -> project root)
npm run start      # build + run
npm test           # build + run integration tests
./docker-build.sh  # build Docker image
./docker-run.sh    # run Docker container (reads .env)
```

## Architecture

This is a TypeScript/Node.js ESM service that polls Miniflux for unread feed entries and uses an AI model to classify them, marking irrelevant ones as read automatically.

```
src/
  core.ts           -- domain types, interfaces (ports), run() pipeline, makeReviewService()
  miniflux.ts       -- Miniflux REST API client
  ai-classifier.ts  -- IAIClassifier implementations (Ollama + OpenAI)
  web-ui.ts         -- inbound adapter: htmx review UI (node:http), depends on IReviewService
  sqlite-database.ts -- IDatabase implementation (node:sqlite)
  ai-summarizer.ts  -- IGroupSummarizer implementation (Ollama generate)
  b2-feed-publisher.ts -- IFeedPublisher implementation (builds the RSS xml, uploads it to Backblaze B2 via S3 api)
  prompt-loader.ts  -- IPromptLoader implementation (reads custom-prompt-*.md)
  bootstrap.ts      -- entry point: wires providers, runs the loop
test/
  integration.test.ts  -- black-box integration tests
  mockserver.ts        -- MockServer helpers (startServer, waitFor, json)
  fixtures.ts          -- shared test data
custom-prompt-*.md -- user-defined prompts (placed at project root alongside compiled JS)
```

### Data flow

`bootstrap.ts` builds concrete implementations of the interfaces defined in `core.ts`, then delegates to `run()` and serves the review UI:

1. Load `custom-prompt-<category>.md` files from the compiled output directory
2. Fetch Miniflux categories; keep only those whose titles contain a prompt's `<category>` (case-insensitive substring)
3. Fetch unread entries for matching feeds, skip already-processed IDs, apply `PROCESSING_BATCH_SIZE`
4. Classify each entry via AI; response "no" (exact, trimmed) -> mark as read, "yes" -> leave unread
5. Save all decisions (yes and no) to the database, then add all decided entry IDs to the in-memory `processedIds` list to prevent re-processing

### Grouping

When `GROUPING_CATEGORIES` is set and the Ollama decision api is on (`OLLAMA_DECISION_API=true`, and `OLLAMA_SUMMARY_MODEL` set; otherwise grouping is skipped with a warning), `bootstrap.ts` runs `runGrouping()` in its own loop, in parallel with `run()` (races on Miniflux are accepted), or, with `RUN_SEQUENTIALLY=true`, before `run()` in a single loop. For each unread entry of those categories (and their "Parent / Child" subcategories), the classifier is asked, one group at a time, per open group (updated within `GROUPING_WINDOW_HOURS`) whether the entry is about the same story as the group's first entry; first "yes" wins, otherwise a new group starts. Entries the classifier calls a digest (several separate stories) are skipped: not grouped, not marked read, remembered in memory. Once all decisions of a run are done, groups whose member count changed get a generated title and description (`ai-summarizer.ts`, Ollama `generate` with `OLLAMA_SUMMARY_MODEL`); the title also replaces the first article's title in later same-story questions. Each entry is marked as read right after it is stored and a failing entry is only logged and retried next run (grouped entries still unread are re-marked first). Grouped entries are marked as read, groups live in the same SQLite file, and the whole feed (one item per group, guid `group-<id>`) is uploaded to B2 when it changed. Miniflux subscribes to the public object URL.

### Review UI

`web-ui.ts` serves an htmx UI on `WEB_PORT`. Step 1 lists all unreviewed decisions; the user ticks the wrong ones. Step 2 stores verdicts (`correct`/`wrong`) and shows, per parent category ("Parent / Child" titles roll up into "Parent"), a copyable prompt built from the last 1000 verdicts in that parent category and its subcategories (not only the just-reviewed batch); pressing its copy button sets the `reviewed` flag on those decisions (until then they stay in the list with their verdicts pre-ticked) asking a stronger model to improve `custom-prompt-<category>.md` based on the reviewed decisions. The user applies the result to the prompt file manually.

### Interfaces (`core.ts`)

| Interface | Implemented by |
|---|---|
| `IFeedReader` | `makeMinifluxClient()` in `miniflux.ts` |
| `IEntryUpdater` | `makeMinifluxClient()` in `miniflux.ts` |
| `IAIClassifier` | `makeAIClassifier()` in `ai-classifier.ts` |
| `IDatabase` | `makeSqliteDatabase()` in `sqlite-database.ts` |
| `IReviewService` | `makeReviewService()` in `core.ts`, consumed by `web-ui.ts` |
| `IGroupStore` | `makeSqliteGroupStore()` in `sqlite-database.ts` |
| `IGroupSummarizer` | `makeAISummarizer()` in `ai-summarizer.ts` |
| `IFeedPublisher` | `makeB2FeedPublisher()` in `b2-feed-publisher.ts` |
| `IPromptLoader` | `promptLoader` in `prompt-loader.ts` |

### AI providers

Controlled by `AI_PROVIDER` env var:
- `OPENAI` - uses `openai` SDK, model `gpt-5-nano`
- anything else (default) - uses `ollama` SDK with `OLLAMA_BASE_URL` and `OLLAMA_MODEL`

### Custom prompts

Files named `custom-prompt-<category>.md` placed in the project root (where JS is compiled). The `<category>` part must be a case-insensitive substring of a Miniflux category title. The file content is sent as the AI system prompt/instruction; the entry title and content are the input.


## Testing

### Philosophy

- Write integration tests only — never unit tests unless explicitly asked
- Tests must be black-box: spawn the compiled `bootstrap.js` as a child process, configure it via environment variables, and assert on observable HTTP behavior. No imports from `src/`
- Mock external HTTP APIs (Miniflux, Ollama) with a real mock HTTP server — not SDK mocks or in-process stubs
- Each test sets up its own mock expectations independently, even at the cost of some duplication. Shared stubs reduce flexibility

### Stack

- **Runner**: `node:test` (built-in) + `tsx` to execute TypeScript test files directly
- **Mock server**: `mockserver-node` + `mockserver-client` (analogous to WireMock in Java)
  - Uses the binary bundle (`runBinary` from `mockserver-node/downloadBinary`) — no Java or Docker needed
  - Do not use `start_mockserver` from `mockserver-node/index.js`; it requires a system Java installation
  - On first run the binary is downloaded and cached (~60s); subsequent runs take ~5s total
- **Single shared MockServer instance** on port 18080 for all mocks — Miniflux (`/v1/*`) and Ollama (`/api/*`) paths don't overlap, so one server handles both. Avoids running two JVM processes simultaneously on memory-constrained hardware (Raspberry Pi)

### Structure

```
test/
  fixtures.ts          -- shared constants (PROMPT, CATEGORY, FEED, ENTRY)
  mockserver.ts        -- helpers: startServer, createClient, waitFor, json
  integration.test.ts  -- test cases
```

### Conventions

- Use `before` / `beforeEach` / `after` hooks for MockServer and child process lifecycle
- Each test registers its own mock expectations independently
- Pass `PROCESSING_INTERVAL_SECONDS=999` to the child so only one run loop iteration fires per test
- Use `waitFor` to synchronise on recorded requests before asserting

### Environment variables


| Variable | Required | Default | Description |
|---|---|---|---|
| `MINIFLUX_URL` | yes | - | Miniflux base URL |
| `MINIFLUX_AUTH_TOKEN` | yes | - | Miniflux personal access token |
| `AI_PROVIDER` | no | Ollama | Set to `OPENAI` to use OpenAI |
| `OPENAI_API_KEY` | if OPENAI | - | OpenAI API key |
| `OLLAMA_BASE_URL` | if Ollama | - | Ollama server URL |
| `OLLAMA_MODEL` | if Ollama | - | Ollama model name |
| `PROCESSING_INTERVAL_SECONDS` | no | 300 | Seconds between runs |
| `PROCESSING_BATCH_SIZE` | no | unlimited | Max entries processed per run |
| `DATABASE_PATH` | no | miniflux-ai.db | SQLite database file |
| `WEB_PORT` | no | 3000 | Port of the review UI |
| `GROUPING_CATEGORIES` | no | - | Comma-separated category titles to group; enables grouping |
| `B2_ENDPOINT` / `B2_REGION` / `B2_BUCKET` / `B2_KEY_ID` / `B2_APPLICATION_KEY` | if grouping | - | Backblaze B2 S3-compatible settings |
| `OLLAMA_SUMMARY_MODEL` | if grouping | - | Ollama model generating group titles and descriptions |
| `RUN_SEQUENTIALLY` | no | false | `true` runs grouping, summaries, then filtering in one loop instead of parallel loops |
| `GROUPED_FEED_KEY` | no | grouped.xml | Object name of the published feed |
| `GROUPED_FEED_TITLE` | no | Grouped articles | Feed title |
| `GROUPING_WINDOW_HOURS` | no | 48 | Hours a group stays open and in the feed |
| `LOGGING_LEVEL` | no | - | `info` or `debug` |
