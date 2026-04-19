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

All config via environment variables — see `.env.example`. Client-facing integration spec is `INTEGRATION.md`.

## Deploying to staging (`hcportal@10.1.200.218`)

No git remote on the staging box — the flow is `tar` + `scp` + `docker compose up -d --build`. Staging `.env` and `mcp-dbportal.json` live on the server and **must be preserved**.

```bash
# 1. Package — explicitly exclude secrets and build artifacts.
tar --exclude='./node_modules' --exclude='./dist' --exclude='./.git' \
    --exclude='./.env' --exclude='./mcp-dbportal.json' \
    -czf /tmp/ccr-deploy.tar.gz .

# 2. Ship tarball (mcp-dbportal.json already on the server — don't overwrite).
scp /tmp/ccr-deploy.tar.gz hcportal@10.1.200.218:/tmp/

# 3. On the server: back up .env, extract, rebuild.
ssh hcportal@10.1.200.218 '
  cd ~/claude-code-router &&
  cp .env .env.backup-$(date +%s) &&
  tar -xzf /tmp/ccr-deploy.tar.gz 2>/dev/null &&
  docker compose up -d --build
'
```

Everything in a single one-liner pipeline for quick iteration:

```bash
tar --exclude='./node_modules' --exclude='./dist' --exclude='./.git' --exclude='./.env' --exclude='./mcp-dbportal.json' -czf /tmp/ccr-deploy.tar.gz . && \
  scp /tmp/ccr-deploy.tar.gz hcportal@10.1.200.218:/tmp/ && \
  ssh hcportal@10.1.200.218 'cd ~/claude-code-router && cp .env .env.backup-$(date +%s) && tar -xzf /tmp/ccr-deploy.tar.gz 2>/dev/null && docker compose up -d --build 2>&1 | tail -3'
```

### Verifying the deploy

```bash
# Router auth enabled on staging → must pass Bearer token.
KEY=ccr_...  # ask the deployer
ssh hcportal@10.1.200.218 "curl -s http://localhost:4141/v1/models -H 'Authorization: Bearer $KEY' | head"
ssh hcportal@10.1.200.218 "curl -s -X POST http://localhost:4141/v1/chat/completions -H 'Authorization: Bearer $KEY' -H 'Content-Type: application/json' -d '{\"model\":\"claude-code\",\"messages\":[{\"role\":\"user\",\"content\":\"say hi\"}]}'"
```

### Rollback

```bash
ssh hcportal@10.1.200.218 'cd ~/claude-code-router && ls -t .env.backup-* | head -1 | xargs -I{} cp {} .env && docker compose up -d'
```
There's no image history kept; to roll back *code* you re-ship the previous tarball. Source of truth is the git commit on `origin/main`.

### Conventions

- Never commit `.env` or `mcp-dbportal.json` (both are gitignored).
- Never omit the `.env` exclude from the tar — it overwrites the server's secrets.
- Commit messages: no `Co-Authored-By` trailer.
- Scope guard: `docker compose up -d --build` briefly drops in-flight requests during image rebuild. Staging has no users, so fine there; production would need a different strategy.
