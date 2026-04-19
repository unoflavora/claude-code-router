# Claude Code Router — System Integration Guide

HTTP proxy that exposes the local `claude` CLI behind OpenAI- and Anthropic-compatible endpoints. Use it when you have an OAuth-authenticated Claude Code setup and want to call it from code that expects the OpenAI or Anthropic SDK.

## Base URLs

| Environment | URL                          | Notes                              |
|-------------|------------------------------|------------------------------------|
| Staging     | `http://10.1.200.218:4141`   | Reachable on Nabati LAN            |
| Local       | `http://localhost:4141`      | `docker compose up -d` in this dir |

## Endpoints

| Method | Path                    | Auth | Purpose                                                                   |
|--------|-------------------------|:----:|---------------------------------------------------------------------------|
| POST   | `/v1/chat/completions`  |  ✅  | OpenAI-compatible chat (streaming + non-streaming)                        |
| POST   | `/v1/messages`          |  ✅  | Anthropic-compatible messages (streaming + non-streaming)                 |
| GET    | `/v1/models`            |  ✅  | Lists the single model `claude-code`                                      |
| GET    | `/`                     |  —   | Service index — name, version, endpoint map                               |
| GET    | `/health`               |  —   | Liveness probe. Returns `{status, tokenManager}`                          |
| GET    | `/token/current`        |  —   | Current OAuth token state. `404` when token manager is inactive (normal)  |
| POST   | `/token/refresh`        |  —   | Force OAuth refresh — no-op unless token manager is active                |

`Auth ✅` means the endpoint requires the router API key when `API_KEYS` is set on the server. `/health`, `/token/*` and `/` are always unauthenticated (used for probes).

See `GET /v1/models` for the list clients may pass as `model`. Beyond `claude-code` (router default), the router accepts the aliases `sonnet`/`opus`/`haiku`, the tier presets `fast`/`balanced`/`deep`, and any full model ID listed in `ALLOWED_MODELS` on the server. If a request `model` isn't recognized, the server-pinned `CLAUDE_MODEL` is used.

### Choosing model, effort, and tier

Three request-body fields control routing and reasoning depth. All are optional.

| Field   | Values                                          | Maps to                    |
|---------|-------------------------------------------------|----------------------------|
| `model` | `claude-code`, `sonnet`, `opus`, `haiku`, or any ID in `ALLOWED_MODELS` | `--model`         |
| `effort`| `low` \| `medium` \| `high` \| `max`            | `--effort`                 |
| `tier`  | `fast` \| `balanced` \| `deep`                  | `(model, effort)` preset   |

Tier presets (applied only when `model`/`effort` aren't explicitly set):

| Tier       | Model   | Effort  | Use case                                     |
|------------|---------|---------|-----------------------------------------------|
| `fast`     | haiku   | low     | Classification, short replies, high volume    |
| `balanced` | sonnet  | medium  | Default — most chat and tool-calling work     |
| `deep`     | opus    | high    | Longer chains of thought, harder problems     |

Examples:

```bash
# Tier preset — fastest tier for a short classification
curl ... -d '{"model":"claude-code","tier":"fast","messages":[...]}'

# Explicit model + effort — overrides any tier choice
curl ... -d '{"model":"opus","effort":"high","messages":[...]}'

# Built-in alias only
curl ... -d '{"model":"haiku","messages":[...]}'
```

Set `CLAUDE_FALLBACK_MODEL=sonnet` on the server for automatic fallback when the primary is overloaded.

### `POST /v1/chat/completions`

OpenAI Chat Completions-compatible. Accepts the usual body:

```json
{
  "model": "claude-code",
  "messages": [{"role": "user", "content": "hello"}],
  "stream": false
}
```

Non-streaming response — includes `tool_calls` when the agent invoked MCP or built-in tools:

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Here are the 4 connections...",
      "tool_calls": [
        { "index": 0, "id": "toolu_...", "type": "function",
          "function": { "name": "mcp__dbportal__list_connections", "arguments": "{}" } }
      ]
    },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```

Streaming (`stream: true`) emits SSE `chat.completion.chunk` events. Each event is either a text delta, a tool_calls delta, or the terminator:

```
data: {"choices":[{"delta":{"content":"Let me check..."}}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"toolu_...","type":"function","function":{"name":"mcp__dbportal__list_connections","arguments":"{}"}}]}}]}

data: {"choices":[{"delta":{"content":"4 connections: ..."}}]}

data: {"choices":[{"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

`finish_reason` is always `"stop"`. The SSE stream also emits `: heartbeat` comment lines every `SSE_HEARTBEAT_MS` while idle.

### `POST /v1/messages`

Anthropic Messages-compatible. Request body:

```json
{
  "model": "claude-code",
  "max_tokens": 512,
  "messages": [{"role": "user", "content": "hello"}],
  "stream": false
}
```

Non-streaming response — `content` is an interleaved list of `text` and `tool_use` blocks in the order the agent produced them:

```json
{
  "id": "msg_...",
  "type": "message",
  "role": "assistant",
  "model": "claude-code",
  "content": [
    { "type": "text", "text": "Let me check the connections." },
    { "type": "tool_use", "id": "toolu_...", "name": "mcp__dbportal__list_connections", "input": {} },
    { "type": "text", "text": "There are 4 connections: ..." }
  ],
  "stop_reason": "end_turn",
  "usage": { "input_tokens": 0, "output_tokens": 0 }
}
```

Streaming emits the full Anthropic event protocol: `message_start`, `content_block_start`/`delta`/`stop` per block, `message_delta`, `message_stop`, plus `ping` events every `SSE_HEARTBEAT_MS`. Tool args arrive as a single `input_json_delta` (no partial-argument streaming).

`stop_reason` is always `"end_turn"` — see *Limitations* below.

### `GET /v1/models`

Returns the set of values acceptable in the request-body `model` field:

```json
{
  "object": "list",
  "data": [
    { "id": "claude-code", "object": "model", "owned_by": "claude-code-router" },
    { "id": "sonnet",      "object": "model", "owned_by": "claude-code-router" },
    { "id": "opus",        "object": "model", "owned_by": "claude-code-router" },
    { "id": "haiku",       "object": "model", "owned_by": "claude-code-router" },
    { "id": "fast",        "object": "model", "owned_by": "claude-code-router" },
    { "id": "balanced",    "object": "model", "owned_by": "claude-code-router" },
    { "id": "deep",        "object": "model", "owned_by": "claude-code-router" }
  ]
}
```

Additional full model IDs appear when `ALLOWED_MODELS` lists them on the server.

### `GET /health`

```json
{ "status": "ok", "tokenManager": false }
```

`tokenManager: false` is expected unless `CLAUDE_OAUTH_REFRESH_TOKEN` is configured (auto-refresh feature, off by default).

### `GET /token/current`

`404 {"error":"Token manager not active"}` when the auto-refresh token manager isn't enabled. This is **not** a bug — the router uses `CLAUDE_CODE_OAUTH_TOKEN` from env, and this endpoint only returns data when `CLAUDE_OAUTH_REFRESH_TOKEN` is also set.

When active, returns `{ expiresAt, refreshedAt, ... }` describing the live token.

### `POST /token/refresh`

Forces an OAuth refresh round-trip. Returns `{ok: true}` on success, `500 {ok: false, error}` otherwise. No-op (but still responds) when the token manager is inactive.

## Authentication

**Router-side** — set `API_KEYS=key1,key2,...` on the server to require callers to present a matching key on every `/v1/*` request. Accepts either header:

```bash
# Preferred — OpenAI/Anthropic SDKs send this by default
curl -H 'Authorization: Bearer <your-key>' ...

# Also accepted
curl -H 'x-api-key: <your-key>' ...
```

Missing/wrong key returns `401 {"error":{"message":"Invalid API key","type":"authentication_error","code":401}}`. Health and token endpoints bypass auth.

**Upstream (to Anthropic)** — handled by the router using `CLAUDE_CODE_OAUTH_TOKEN`. Clients never see this value.

Staging (`10.1.200.218`) currently has auth **enabled**. Ask the deployer for a key.

## Client examples

### curl

```bash
curl -X POST http://10.1.200.218:4141/v1/chat/completions \
  -H 'Authorization: Bearer <your-key>' \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-code","messages":[{"role":"user","content":"hello"}]}'
```

### OpenAI SDK

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://10.1.200.218:4141/v1",
  apiKey: process.env.CCR_API_KEY,
});

const resp = await client.chat.completions.create({
  model: "claude-code",
  messages: [{ role: "user", content: "hello" }],
});
```

### Anthropic SDK

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "http://10.1.200.218:4141",
  authToken: process.env.CCR_API_KEY, // sent as Bearer
});

const resp = await client.messages.create({
  model: "claude-code",
  max_tokens: 512,
  messages: [{ role: "user", content: "hello" }],
});
```

## MCP tools (dbportal)

Staging is configured with the `dbportal` MCP server. Ask the model to call tools by name:

```bash
curl -X POST http://10.1.200.218:4141/v1/chat/completions \
  -H 'Authorization: Bearer <your-key>' \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-code","messages":[{"role":"user","content":"Use mcp__dbportal__list_connections and return the JSON."}]}'
```

Server-wide allowlist on staging:

- `mcp__dbportal__list_connections`
- `mcp__dbportal__list_tables`
- `mcp__dbportal__describe_table`
- `mcp__dbportal__validate_query`
- `mcp__dbportal__execute_query`

## Scoping tools per request

Both endpoints accept a `tools` field in the request body (OpenAI or Anthropic shape). When present, it **overrides** the server defaults for this request — only the listed tools are available, no built-ins bleed through.

Three effective modes:

| Request `tools` field         | Built-ins available | MCP servers loaded          |
|-------------------------------|:-------------------:|:----------------------------|
| Omitted                       | per `CLAUDE_TOOLS`  | yes, if `MCP_CONFIG` set    |
| `[]` (empty array)            | none                | **no** (MCP config skipped) |
| `[{name: "mcp__dbportal__..."}]` | none             | yes                         |
| `[{name: "Read"}, {name: "Grep"}]` | Read + Grep only | no                         |
| `[{name: "mcp__..."}, {name: "Read"}]` | Read only     | yes                         |

Any tool name starting with `mcp__` keeps the configured MCP config loaded; anything else is treated as a built-in. Tools the server doesn't know about are simply ignored by the CLI.

Example — OpenAI shape, MCP-only:

```bash
curl -X POST http://10.1.200.218:4141/v1/chat/completions \
  -H 'Authorization: Bearer <your-key>' -H 'Content-Type: application/json' \
  -d '{
    "model": "claude-code",
    "messages": [{"role": "user", "content": "list db connections"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "mcp__dbportal__list_connections",
        "description": "list DB connections",
        "parameters": {"type": "object"}
      }
    }]
  }'
```

Example — Anthropic shape, built-ins only (no MCP):

```bash
curl -X POST http://10.1.200.218:4141/v1/messages \
  -H 'Authorization: Bearer <your-key>' -H 'Content-Type: application/json' \
  -d '{
    "model": "claude-code",
    "max_tokens": 512,
    "messages": [{"role": "user", "content": "read /etc/hosts"}],
    "tools": [{"name": "Read", "description": "", "input_schema": {"type":"object"}}]
  }'
```

Example — pure text answer, no tools:

```bash
curl ... -d '{ "model":"claude-code", "messages":[...], "tools": [] }'
```

Note: the *permission* allowlist (`ALLOWED_TOOLS` server env) still gates execution even for per-request tools. For MCP tools to actually run, they must also be listed there.

## Limitations

- `usage` tokens are always `0` — the CLI wrapper doesn't surface token counts.
- `CLAUDE_MAX_TURNS` caps the number of agent turns per request (default 20, staging uses 30 for deeper analyst loops).
- `stop_reason` / `finish_reason` is always `end_turn` / `stop`. Tool calls are resolved server-side by the CLI, so `tool_use` / `tool_calls` blocks are informational — clients shouldn't try to round-trip them.

## Server configuration

Config is read from environment variables (`.env` or `docker-compose.yml`).

| Var                           | Default                | Purpose                                                                                                  |
|-------------------------------|------------------------|----------------------------------------------------------------------------------------------------------|
| `PORT`                        | `4141`                 | Listen port                                                                                              |
| `HOST`                        | `0.0.0.0`              | Listen address                                                                                           |
| `CLAUDE_BINARY`               | `claude`               | Path to Claude Code CLI                                                                                  |
| `CLAUDE_MODEL`                | *(empty)*              | Pin a specific model (empty = CLI default, currently Sonnet 4.6)                                         |
| `CLAUDE_EFFORT`               | *(empty)*              | Reasoning effort. `low` \| `medium` \| `high` \| `max`                                                   |
| `CLAUDE_FALLBACK_MODEL`       | *(empty)*              | Model to fall back to when the primary is overloaded                                                     |
| `ALLOWED_MODELS`              | *(empty)*              | Comma-separated full model IDs clients may pass. Aliases + tiers always allowed                          |
| `CLAUDE_MAX_TURNS`            | `20`                   | Max agent turns per request. `0` = no cap                                                                |
| `CLAUDE_MODE`                 | `lean`                 | `lean` (recommended) \| `full`. Both support OAuth tokens                                                |
| `CLAUDE_CODE_OAUTH_TOKEN`     | *(required)*           | OAuth token from `claude setup-token`                                                                    |
| `CLAUDE_SETTINGS`             | `claude-settings.json` | Path or JSON for `--settings`                                                                            |
| `CLAUDE_SETTING_SOURCES`      | `user`                 | Which setting sources to load in lean mode                                                               |
| `CLAUDE_APPEND_SYSTEM_PROMPT` | *(sensible default)*   | Appended to default system prompt; default nudges model to ack before tool calls                        |
| `MCP_CONFIG`                  | *(empty)*              | Path (inside container) or JSON for `--mcp-config`                                                       |
| `MCP_STRICT`                  | *(empty)*              | `1` = pass `--strict-mcp-config` (only use servers from `MCP_CONFIG`)                                    |
| `ALLOWED_TOOLS`               | *(empty)*              | Space-separated tool allowlist, e.g. `mcp__dbportal__list_connections Bash`                              |
| `DISALLOWED_TOOLS`            | `ToolSearch`           | Denylist. Default blocks the tool-discovery indirection; set `""` to allow                               |
| `CLAUDE_TOOLS`                | `""` (none)            | Built-ins visible to the model (`--tools`). `""` = none; `default` = all; or a list like `Read,Grep`    |
| `PERMISSION_MODE`             | *(empty)*              | `acceptEdits` \| `auto` \| `bypassPermissions` \| `default` \| `dontAsk` \| `plan`                       |
| `NODE_TLS_REJECT_UNAUTHORIZED`| *(empty)*              | Set `0` when MCP endpoint uses a self-signed cert                                                        |
| `SSE_HEARTBEAT_MS`            | `10000`                | SSE keepalive interval during streaming. `0` disables                                                    |
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

| Symptom                                    | Cause / fix                                                                                                      |
|--------------------------------------------|------------------------------------------------------------------------------------------------------------------|
| `401 Invalid API key` from router          | Missing / wrong `Authorization: Bearer` header. Check `API_KEYS` on the server                                   |
| `Invalid API key · Fix external API key`   | Upstream Anthropic error. Most often: `CLAUDE_CODE_OAUTH_TOKEN` expired (rotate via `claude setup-token`), or org hit the 5-hour overage cap (look for `rate_limit_event` in the CLI output). |
| `Not logged in · Please run /login`        | No `CLAUDE_CODE_OAUTH_TOKEN` reaching the container. Verify `docker exec ... env \| grep OAUTH`                   |
| `/token/current` returns 404               | Expected when the auto-refresh token manager isn't configured (`CLAUDE_OAUTH_REFRESH_TOKEN` unset). Not a bug    |
| `tool call was blocked pending permission` | Tool not in `ALLOWED_TOOLS`, or `PERMISSION_MODE` blocks it                                                      |
| `fetch failed` to MCP URL                  | Self-signed cert — set `NODE_TLS_REJECT_UNAUTHORIZED=0`                                                          |
| `usage` always `0`                         | Expected — token counts aren't surfaced by the CLI wrapper                                                       |
| Streaming stops mid-response               | `CLAUDE_MAX_TURNS` too low for the tool loop; bump it or set `0`                                                 |
| Agent wastes a turn on `ToolSearch`        | `DISALLOWED_TOOLS=ToolSearch` (default). If you overrode it, add `ToolSearch` back                               |
