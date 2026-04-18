# Claude Code Router — Plan

## What it is

API proxy that routes OpenAI and Anthropic-compatible requests through the Claude CLI, using OAuth tokens for auth.

## Current state

- **OpenAI route** (`POST /v1/chat/completions`) — converts messages to flat prompt, spawns `claude -p --bare`, returns OpenAI-format response. Supports streaming.
- **Anthropic route** (`POST /v1/messages`) — same CLI path, returns Anthropic-format response. Supports streaming.
- **Auth** — `CLAUDE_CODE_OAUTH_TOKEN` env var, mapped to `ANTHROPIC_API_KEY` for the CLI (CLI handles OAuth Bearer internally).
- **Docker** — runs on production at `10.1.200.218:4141`.

## Problem

Tool calling doesn't work. The CLI only supports built-in tools (Bash, Read, Edit) and MCP-registered tools. Anthropic tool definitions in the request body are ignored because the CLI receives a flattened text prompt.

## Plan: MCP-based tool support

### Architecture

```
Service A (HR)              Service B (Weather)          Service C (...)
  MCP server (SSE)            MCP server (SSE)             MCP server (SSE)
  http://hr:3000/mcp          http://weather:3000/mcp      http://...:3000/mcp
        │                           │                            │
        └───────────────┬───────────┴────────────────────────────┘
                        ▼
               ┌─────────────────┐
               │  mcp-config.json │  ← static config listing MCP servers
               └────────┬────────┘
                        ▼
               Claude Code Router
               ┌─────────────────┐
               │  Hono HTTP      │
               │  CLI executor   │ → claude -p --bare --mcp-config mcp.json --allowedTools ...
               │  Stream parser  │ → parses stream-json output
               └─────────────────┘
                        │
                   Port 4141
                        │
              ┌─────────┴──────────┐
              ▼                    ▼
        OpenAI clients      Anthropic clients
```

### How it works

1. Services run their own MCP servers using SSE/HTTP transport (using `@modelcontextprotocol/sdk` or equivalent).
2. Router has a static `mcp-config.json` listing all MCP server URLs.
3. On every CLI invocation, router passes `--mcp-config mcp.json` and `--allowedTools` with all MCP tool names.
4. CLI discovers tools from MCP servers, uses them when the model decides to.
5. Router parses `--output-format stream-json` output to extract the final response.

### Key benefits

- **Separation of concerns** — each service owns its tools, no tool definitions in the router.
- **No per-request overhead** — MCP servers are persistent, CLI connects to them per request.
- **No custom bridging** — standard MCP protocol, SDKs available in every language.
- **Adding a service** = add one line to `mcp-config.json`.

### Implementation steps

1. [ ] Switch CLI executor to use `--output-format stream-json --verbose` and parse structured output instead of raw text.
2. [ ] Add `--mcp-config` support to CLI args in `claude.ts` (read from `MCP_CONFIG` env var or default path).
3. [ ] Add `--allowedTools` support to auto-allow all MCP tools (or configure via env).
4. [ ] Parse `stream-json` output to extract tool_use events, tool results, and final text for proper Anthropic/OpenAI response formatting.
5. [ ] Update Docker image to support MCP config mounting.
6. [ ] Create example MCP server for reference.
7. [ ] Test end-to-end: service → MCP → router → CLI → tool call → response.

### Config

```bash
# .env
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
MCP_CONFIG=mcp-config.json    # path to MCP servers config
MCP_ALLOWED_TOOLS=*           # or comma-separated list
```

```json
// mcp-config.json
{
  "mcpServers": {
    "hr-system": { "url": "http://hr-service:3000/mcp" },
    "weather": { "url": "http://weather-service:3000/mcp" },
    "inventory": { "url": "http://inventory:8080/mcp" }
  }
}
```
