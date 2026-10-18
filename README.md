# Miniflux-AI

Use AI to remove the noise from your [Miniflux](https://miniflux.app) feeds so only important news reach you.

## Quick Start
- Install dependencies: `npm install`
- Create `.env` with the following variables:
  - `OPENAI_API_KEY`: OpenAI key used for entries (articles) filtering.
  - `MINIFLUX_URL`: Base URL of your Miniflux server.
  - `MINIFLUX_AUTH_TOKEN`: Personal access token for Miniflux API calls.
  - `PROCESSING_INTERVAL_SECONDS`: How often filtering job should run (default: 300).
  - `PROCESSING_BATCH_SIZE`: Maximum unread entries processed each run (default: unlimited).
  - `DATABASE_PATH`: Optional SQLite file path for persisted data such as AI decisions on articles (default: `miniflux-ai.db`).
  - `WEB_PORT`: Optional port of the decision review UI (default: 3000).
  - `LOGGING_LEVEL`: Optional verbosity level such as `info` or `debug`.
  - `OLLAMA_DECISION_API`: Set to `true` to classify entries with Ollama's decision api (`ollama.systemone`) instead of `generate`. Requires a model whose `ollama show` capabilities include `decision`.
  - `GROUPING_CATEGORIES`: Optional comma-separated Miniflux category titles (exact, case-insensitive). Subcategories named "Parent / Child" count as their parent. Their unread entries are grouped by story and published as one RSS feed to Backblaze B2. Subscribe Miniflux to the published feed and attach a filtering prompt to its category.
  - `B2_ENDPOINT`, `B2_REGION`, `B2_BUCKET`, `B2_KEY_ID`, `B2_APPLICATION_KEY`: Backblaze B2 S3-compatible settings (e.g. `https://s3.us-west-004.backblazeb2.com`, `us-west-004`). Required with `GROUPING_CATEGORIES`; the bucket must be public. Grouping only runs with `OLLAMA_DECISION_API=true` and `OLLAMA_SUMMARY_MODEL`.
  - `OLLAMA_SUMMARY_MODEL`: Required with `GROUPING_CATEGORIES`. Ollama model that generates each group's title and description. It runs only after all grouping decisions of a run, so the decision model is idle by then.
  - `RUN_SEQUENTIALLY`: Set to `true` to run, in one loop per interval, grouping, then group title and description generation, then filtering, so Ollama holds one model at a time. By default grouping and filtering run in parallel loops.
  - `GROUPED_FEED_KEY`: Optional object name of the feed (default: `grouped.xml`).
  - `GROUPED_FEED_TITLE`: Optional feed title (default: `Grouped articles`).
  - `GROUPING_WINDOW_HOURS`: Optional time after its last article during which a group still accepts new ones, and stays in the feed (default: 48).
- Run the script: `npm run start`

## Prompt files
Filtering is driven by prompt files in the working directory (the project root for `npm run start`, `/app` in Docker):
- Name each file `custom-prompt-<category>.md`, e.g. `custom-prompt-tech.md`.
- `<category>` is matched as a case-insensitive substring of Miniflux category titles, so `tech` also covers a category "Tech News". Categories matching no prompt file are ignored.
- The file content is sent to the AI as the system prompt; the entry title and content are the input. Describe which entries to keep and tell the model to answer only `yes` (keep unread) or `no` (mark as read). Any other answer is logged and the entry is retried next run.
- Prompt files are read on each run, so no restart is needed after editing one.

Example `custom-prompt-tech.md`:
```
You filter tech news. Answer "yes" if the article covers a major product launch,
a security incident or a significant industry change. Answer "no" for opinion
pieces, deals, rumors and tutorials. Answer with only yes or no.
```

## To-Do (prioritized)
- [x] document environment variables
- [x] document how to create prompt files
- [ ] support more AI providers: Ollama, Claude, etc.
