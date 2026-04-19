export const config = {
  port: parseInt(process.env.PORT || "4141", 10),
  host: process.env.HOST || "0.0.0.0",

  // Claude CLI settings
  claudeBinary: process.env.CLAUDE_BINARY || "claude",
  claudeModel: process.env.CLAUDE_MODEL || "", // empty = use CLI default
  // Max agent turns per request. 0 = no limit (don't pass --max-turns).
  // Default is generous enough for multi-step analyst loops; lower if you want hard caps.
  maxTurnCount: parseInt(process.env.CLAUDE_MAX_TURNS || "20", 10),

  // Startup mode: "lean" (--setting-sources) or "full" (no flags, loads everything).
  // Both support CLAUDE_CODE_OAUTH_TOKEN. Bare mode was removed because it
  // rejects OAuth tokens (requires ANTHROPIC_API_KEY or apiKeyHelper).
  claudeMode: (process.env.CLAUDE_MODE || "lean") as "lean" | "full",
  // Path or JSON string for --settings. Empty = don't pass the flag.
  // Default is empty because the bundled claude-settings.json only provides
  // apiKeyHelper (for bare mode), which would submit the OAuth token as an
  // api key — Anthropic intermittently rejects that, producing the misleading
  // "Invalid API key · Fix external API key" response. Leaving it unset lets
  // the CLI use CLAUDE_CODE_OAUTH_TOKEN via the proper OAuth path.
  claudeSettings: process.env.CLAUDE_SETTINGS || "",
  claudeSettingSources: process.env.CLAUDE_SETTING_SOURCES || "user", // which config sources to load in lean mode

  // MCP: path or JSON for --mcp-config. When strict, only these MCP servers are loaded.
  mcpConfig: process.env.MCP_CONFIG || "",
  strictMcpConfig: process.env.MCP_STRICT === "1" || process.env.MCP_STRICT === "true",

  // Tool permissions: comma/space-separated allowlist (e.g. "mcp__dbportal__list_connections Bash")
  allowedTools: process.env.ALLOWED_TOOLS || "",
  // Comma/space-separated denylist. Defaults to blocking ToolSearch so MCP tool schemas
  // are used directly instead of being deferred behind a discovery tool (saves a turn).
  disallowedTools: process.env.DISALLOWED_TOOLS ?? "ToolSearch",
  // Built-in tools available to the model (--tools). Unlike allowedTools which gates
  // *permission* to execute, --tools controls whether the tool is even visible in
  // context. "" (default) hides all built-ins so MCP-only services don't see the
  // model reach for Bash/Read/Grep. "default" = all built-ins. Or comma-separated list.
  // Per-request `tools` in the request body overrides this.
  claudeTools: process.env.CLAUDE_TOOLS ?? "",

  // Reasoning effort (--effort). low | medium | high | max. Empty = CLI default.
  // Per-request `effort` overrides.
  claudeEffort: process.env.CLAUDE_EFFORT || "",
  // Fallback model used when the primary is overloaded (--fallback-model). Empty = no fallback.
  claudeFallbackModel: process.env.CLAUDE_FALLBACK_MODEL || "",
  // Comma-separated allowlist of models clients may request via body.model.
  // Empty = only the server-pinned CLAUDE_MODEL is honored (request `model` ignored).
  // Aliases (sonnet/opus/haiku) and tier presets (fast/balanced/deep) are always accepted.
  allowedModels: (process.env.ALLOWED_MODELS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // One of: acceptEdits, auto, bypassPermissions, default, dontAsk, plan
  permissionMode: process.env.PERMISSION_MODE || "",

  // Appended to Claude Code's built-in system prompt (via --append-system-prompt).
  // Default nudges the model to acknowledge the user before firing tool calls,
  // so clients see text immediately instead of silent seconds before tool_use events.
  claudeAppendSystemPrompt:
    process.env.CLAUDE_APPEND_SYSTEM_PROMPT ||
    "Before making any tool call, first respond to the user in one short sentence describing what you're about to do. Then proceed with the tool call.",

  // SSE heartbeat interval (ms) while streaming. 0 = disabled. Keeps proxies
  // and clients from closing connections during long MCP tool waits.
  sseHeartbeatMs: parseInt(process.env.SSE_HEARTBEAT_MS || "10000", 10),

  // Max transparent retries on upstream Anthropic transient errors
  // (the "Invalid API key · Fix external API key" assistant-text rejection).
  // 0 disables retry; error is surfaced as-is.
  upstreamRetryMax: parseInt(process.env.UPSTREAM_RETRY_MAX || "2", 10),

  // Allowed API keys (comma-separated). Empty = no auth required.
  apiKeys: process.env.API_KEYS ? process.env.API_KEYS.split(",").map((k) => k.trim()) : [],
};
