export const config = {
  port: parseInt(process.env.PORT || "4141", 10),
  host: process.env.HOST || "0.0.0.0",

  // Claude CLI settings
  claudeBinary: process.env.CLAUDE_BINARY || "claude",
  claudeModel: process.env.CLAUDE_MODEL || "", // empty = use CLI default
  maxTurnCount: parseInt(process.env.CLAUDE_MAX_TURNS || "1", 10),

  // Startup mode: "bare" (fastest, needs CLAUDE_CODE_OAUTH_TOKEN), "lean" (--setting-sources), "full" (no flags)
  claudeMode: (process.env.CLAUDE_MODE || "bare") as "bare" | "lean" | "full",
  claudeSettings: process.env.CLAUDE_SETTINGS || "claude-settings.json", // path or JSON string for --settings
  claudeSettingSources: process.env.CLAUDE_SETTING_SOURCES || "user", // which config sources to load in lean mode

  // Allowed API keys (comma-separated). Empty = no auth required.
  apiKeys: process.env.API_KEYS ? process.env.API_KEYS.split(",").map((k) => k.trim()) : [],
};
