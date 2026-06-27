# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm install        # install dependencies
npm run build      # compile TypeScript (src/ -> project root)
npm run start      # build + run
./docker-build.sh  # build Docker image
./docker-run.sh    # run Docker container (reads .env)
```

There are no tests configured.

## Architecture

This is a TypeScript/Node.js ESM service that polls Miniflux for unread feed entries and uses an AI model to classify them, marking irrelevant ones as read automatically.

```
src/
  core.ts         -- domain interfaces + run() pipeline
  miniflux.ts     -- Miniflux REST API client
  miniflux-ai.ts  -- entry point: wires providers, runs the loop
custom-prompt-*.md -- user-defined prompts (placed at project root alongside compiled JS)
```

### Data flow

`miniflux-ai.ts` builds concrete implementations of the interfaces defined in `core.ts`, then delegates to `run()`:

1. Load `custom-prompt-<category>.md` files from the compiled output directory
2. Fetch Miniflux categories; keep only those whose titles contain a prompt's `<category>` (case-insensitive substring)
3. Fetch unread entries for matching feeds, skip already-processed IDs, apply `PROCESSING_BATCH_SIZE`
4. Classify each entry via AI; response containing "no" -> mark as read, "yes" -> leave unread
5. Add all decided entry IDs to the in-memory `processedIds` list to prevent re-processing

### Interfaces (`core.ts`)

| Interface | Implemented by |
|---|---|
| `IFeedReader` | `makeMinifluxClient()` |
| `IEntryUpdater` | `makeMinifluxClient()` |
| `IAIClassifier` | `makeAIClassifier()` in entry point |
| `IPromptLoader` | `promptLoader` literal in entry point |

### AI providers

Controlled by `AI_PROVIDER` env var:
- `OPENAI` - uses `openai` SDK, model `gpt-5-nano`
- anything else (default) - uses `ollama` SDK with `OLLAMA_BASE_URL` and `OLLAMA_MODEL`

### Custom prompts

Files named `custom-prompt-<category>.md` placed in the project root (where JS is compiled). The `<category>` part must be a case-insensitive substring of a Miniflux category title. The file content is sent as the AI system prompt/instruction; the entry title and content are the input.

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
