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
  core.ts           -- domain interfaces + run() pipeline
  miniflux.ts       -- Miniflux REST API client
  ai-classifier.ts  -- IAIClassifier implementations (Ollama + OpenAI)
  prompt-loader.ts  -- IPromptLoader implementation (reads custom-prompt-*.md)
  bootstrap.ts      -- entry point: wires providers, runs the loop
test/
  integration.test.ts  -- black-box integration tests
  mockserver.ts        -- MockServer helpers (startServer, waitFor, json)
  fixtures.ts          -- shared test data
custom-prompt-*.md -- user-defined prompts (placed at project root alongside compiled JS)
```

### Data flow

`bootstrap.ts` builds concrete implementations of the interfaces defined in `core.ts`, then delegates to `run()`:

1. Load `custom-prompt-<category>.md` files from the compiled output directory
2. Fetch Miniflux categories; keep only those whose titles contain a prompt's `<category>` (case-insensitive substring)
3. Fetch unread entries for matching feeds, skip already-processed IDs, apply `PROCESSING_BATCH_SIZE`
4. Classify each entry via AI; response "no" (exact, trimmed) -> mark as read, "yes" -> leave unread
5. Add all decided entry IDs to the in-memory `processedIds` list to prevent re-processing

### Interfaces (`core.ts`)

| Interface | Implemented by |
|---|---|
| `IFeedReader` | `makeMinifluxClient()` in `miniflux.ts` |
| `IEntryUpdater` | `makeMinifluxClient()` in `miniflux.ts` |
| `IAIClassifier` | `makeAIClassifier()` in `ai-classifier.ts` |
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
| `PROCESSING_BATCH_SIZE` | no | - | Max entries processed per run |
| `LOGGING_LEVEL` | no | - | `info` or `debug` |
