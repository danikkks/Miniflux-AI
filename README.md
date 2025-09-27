# Miniflux-AI

Automates [Miniflux](https://miniflux.app) feed triage by using OpenAI-powered relevance scoring.

## Quick Start
- Install dependencies: `npm install`
- Create `.env` with the following variables:
  - `OPENAI_API_KEY`: OpenAI key used for entries (articles) filtering.
  - `MINIFLUX_URL`: Base URL of your Miniflux server.
  - `MINIFLUX_AUTH_TOKEN`: Personal access token for Miniflux API calls.
  - `PROCESSING_INTERVAL_CRON`: How often filtering job should run.
  - `PROCESSING_BATCH_SIZE`: Maximum unread entries processed each run.
  - `LOGGING_LEVEL`: Optional verbosity level such as `info` or `debug`.
- Run the script: `npm run start`

## To-Do (prioritized)
- [x] document environment variables
- [ ] document how to create prompt files
- [ ] support more AI providers: Ollama, Claude, etc.
