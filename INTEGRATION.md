# Claude Code Router — System Integration Guide

HTTP proxy that exposes the local `claude` CLI behind OpenAI- and Anthropic-compatible endpoints. Use it when you have an OAuth-authenticated Claude Code setup and want to call it from code that expects the OpenAI or Anthropic SDK.

## Base URLs

| Environment | URL                          | Notes                              |
|-------------|------------------------------|------------------------------------|
| Staging     | `http://10.1.200.218:4141`   | Reachable on Nabati LAN            |
| Local       | `http://localhost:4141`      | `docker compose up -d` in this dir |

## Endpoints

| Method | Path                    | Purpose                         |
|--------|-------------------------|---------------------------------|
| POST   | `/v1/chat/completions`  | OpenAI-compatible chat          |
| POST   | `/v1/messages`          | Anthropic-compatible messages   |
| GET    | `/v1/models`            | Lists the `claude-code` model   |
| GET    | `/health`               | Liveness + token manager status |
| GET    | `/token/current`        | Current OAuth token state       |
| POST   | `/token/refresh`        | Force token refresh             |

Model ID to pass: `claude-code`. The underlying Claude model is whatever `CLAUDE_MODEL` is set to on the server (empty = CLI default).

## Authentication

Router-side auth is optional: set `API_KEYS=key1,key2` on the server to require `Authorization: Bearer <key>`. Empty = no auth.

Upstream auth to Anthropic is via `CLAUDE_CODE_OAUTH_TOKEN` (set server-side). Clients never see it.

## OpenAI-compatible call

```bash
curl -X POST http://10.1.200.218:4141/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "claude-code",
    "messages": [{"role": "user", "content": "hello"}]
  }'
```

With the OpenAI SDK:

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://10.1.200.218:4141/v1",
  apiKey: "unused", // or an API_KEYS value if auth is enabled
});

const resp = await client.chat.completions.create({
  model: "claude-code",
  messages: [{ role: "user", content: "hello" }],
});
```

Streaming (`stream: true`) returns SSE chunks shaped like OpenAI `chat.completion.chunk`.

## Anthropic-compatible call

```bash
curl -X POST http://10.1.200.218:4141/v1/messages \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "claude-code",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "hello"}]
  }'
```

## MCP tools (dbportal)

Staging is configured with the `dbportal` MCP server. Ask the model to call tools by name:

```bash
curl -X POST http://10.1.200.218:4141/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "claude-code",
    "messages": [{
      "role": "user",
      "content": "Use mcp__dbportal__list_connections and return the JSON."
    }]
  }'
```

Allowlisted tools (staging):

- `mcp__dbportal__list_connections`
- `mcp__dbportal__list_tables`
- `mcp__dbportal__describe_table`
- `mcp__dbportal__validate_query`
- `mcp__dbportal__execute_query`

Tools not on the allowlist are blocked at the CLI layer.

## Limitations

- `usage` tokens are always `0` — the CLI wrapper doesn't surface token counts.
- `CLAUDE_MAX_TURNS` caps the number of agent turns per request (default 1, staging uses 5 so MCP tool loops can complete).
- Streaming deltas come from the CLI's `--bare`/plain text output, not the native Anthropic streaming protocol — chunk shape is faithful but there are no tool_use blocks in the response body, only the final text.

## Server configuration

Config is read from environment variables (`.env` or `docker-compose.yml`).

| Var                           | Default                | Purpose                                                                                                  |
|-------------------------------|------------------------|----------------------------------------------------------------------------------------------------------|
| `PORT`                        | `4141`                 | Listen port                                                                                              |
| `HOST`                        | `0.0.0.0`              | Listen address                                                                                           |
| `CLAUDE_BINARY`               | `claude`               | Path to Claude Code CLI                                                                                  |
| `CLAUDE_MODEL`                | *(empty)*              | Pin a specific model (empty = CLI default)                                                               |
| `CLAUDE_MAX_TURNS`            | `1`                    | Max agent turns per request                                                                              |
| `CLAUDE_MODE`                 | `lean`                 | `bare` \| `lean` \| `full`. **Bare rejects OAuth** — needs `ANTHROPIC_API_KEY` or `apiKeyHelper`         |
| `CLAUDE_CODE_OAUTH_TOKEN`     | *(required)*           | OAuth token from `claude setup-token` (works in lean/full only)                                          |
| `CLAUDE_SETTINGS`             | `claude-settings.json` | Path or JSON for `--settings`                                                                            |
| `CLAUDE_SETTING_SOURCES`      | `user`                 | Which setting sources to load in lean mode                                                               |
| `MCP_CONFIG`                  | *(empty)*              | Path (inside container) or JSON for `--mcp-config`                                                       |
| `MCP_STRICT`                  | *(empty)*              | `1` = pass `--strict-mcp-config` (only use servers from `MCP_CONFIG`)                                    |
| `ALLOWED_TOOLS`               | *(empty)*              | Space-separated tool allowlist, e.g. `mcp__dbportal__list_connections Bash`                              |
| `PERMISSION_MODE`             | *(empty)*              | `acceptEdits` \| `auto` \| `bypassPermissions` \| `default` \| `dontAsk` \| `plan`                       |
| `NODE_TLS_REJECT_UNAUTHORIZED`| *(empty)*              | Set `0` when MCP endpoint uses a self-signed cert                                                        |
| `API_KEYS`                    | *(empty)*              | Comma-separated router API keys; empty = no auth                                                         |

## Deploying to staging (`10.1.200.218`)

No git remote — files are shipped with `scp`.

```bash
# From the repo root on your laptop:
tar --exclude=node_modules --exclude=dist --exclude=.git \
    --exclude=.env --exclude=mcp-dbportal.json \
    -czf /tmp/ccr-deploy.tar.gz .

scp /tmp/ccr-deploy.tar.gz mcp-dbportal.json hcportal@10.1.200.218:/tmp/

ssh hcportal@10.1.200.218 '
  cd ~/claude-code-router &&
  cp .env .env.backup-$(date +%s) &&
  tar -xzf /tmp/ccr-deploy.tar.gz &&
  cp /tmp/mcp-dbportal.json ./mcp-dbportal.json &&
  docker compose up -d --build
'
```

`.env` on the server is preserved — add new vars by appending, don't overwrite.

## Troubleshooting

| Symptom                                   | Cause                                                                        |
|-------------------------------------------|------------------------------------------------------------------------------|
| `Invalid API key · Fix external API key`  | `CLAUDE_MODE=bare` with OAuth token. Switch to `lean` or `full`.             |
| `Not logged in · Please run /login`       | No `CLAUDE_CODE_OAUTH_TOKEN` reaching the container                          |
| `tool call was blocked pending permission`| Tool not in `ALLOWED_TOOLS`, or `PERMISSION_MODE` blocks it                  |
| `fetch failed` to MCP URL                 | Self-signed cert — set `NODE_TLS_REJECT_UNAUTHORIZED=0`                      |
| `usage` always `0`                        | Expected — token counts aren't surfaced by the CLI wrapper                   |
| Streaming stops mid-response              | `CLAUDE_MAX_TURNS` too low for the tool loop; bump it                        |
