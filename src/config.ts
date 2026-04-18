export const config = {
  port: parseInt(process.env.PORT || "4141", 10),
  host: process.env.HOST || "0.0.0.0",

  // Claude CLI settings
  claudeBinary: process.env.CLAUDE_BINARY || "claude",
  claudeModel: process.env.CLAUDE_MODEL || "", // empty = use CLI default
  maxTurnCount: parseInt(process.env.CLAUDE_MAX_TURNS || "1", 10),

  // Startup mode: "bare" (fastest, requires ANTHROPIC_API_KEY or --settings apiKeyHelper; OAuth/keychain not read),
  // "lean" (--setting-sources, supports CLAUDE_CODE_OAUTH_TOKEN), "full" (no flags, loads everything)
  claudeMode: (process.env.CLAUDE_MODE || "lean") as "bare" | "lean" | "full",
  claudeSettings: process.env.CLAUDE_SETTINGS || "claude-settings.json", // path or JSON string for --settings
  claudeSettingSources: process.env.CLAUDE_SETTING_SOURCES || "user", // which config sources to load in lean mode

  // MCP: path or JSON for --mcp-config. When strict, only these MCP servers are loaded.
  mcpConfig: process.env.MCP_CONFIG || "",
  strictMcpConfig: process.env.MCP_STRICT === "1" || process.env.MCP_STRICT === "true",

  // Tool permissions: comma/space-separated allowlist (e.g. "mcp__dbportal__list_connections Bash")
  allowedTools: process.env.ALLOWED_TOOLS || "",
  // One of: acceptEdits, auto, bypassPermissions, default, dontAsk, plan
  permissionMode: process.env.PERMISSION_MODE || "",

  // Allowed API keys (comma-separated). Empty = no auth required.
  apiKeys: process.env.API_KEYS ? process.env.API_KEYS.split(",").map((k) => k.trim()) : [],
};
