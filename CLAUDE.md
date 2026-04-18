# Claude Code Router

API proxy that routes OpenAI and Anthropic-compatible requests through the local `claude` CLI.

## Architecture

```
Client (OpenAI SDK / Anthropic SDK / curl)
  │
  ▼
Hono HTTP Server (src/index.ts)
  ├── POST /v1/chat/completions  →  OpenAI compat  (src/routes/openai.ts)
  ├── POST /v1/messages          →  Anthropic compat (src/routes/anthropic.ts)
  └── GET  /v1/models            →  Model listing
  │
  ▼
Message converter (src/convert.ts)  →  flattens messages into a single prompt
  │
  ▼
Claude CLI executor (src/claude.ts) →  spawns `claude -p --output-format stream-json`
```

## Dev commands

- `npm run dev` — start with hot reload (tsx watch)
- `npm run build` — compile to dist/
- `npm start` — run compiled build

## Config

All config via environment variables — see `.env.example`.
