import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { config } from "./config.js";
import { authMiddleware } from "./auth.js";
import { openai } from "./routes/openai.js";
import { anthropic } from "./routes/anthropic.js";
import { initTokenManager, getTokenState, isTokenManagerActive, refreshToken } from "./token.js";

const app = new Hono();

// Middleware
app.use("*", logger());
app.use("*", cors());
app.use("/v1/*", authMiddleware);

// Routes
app.route("/", openai);
app.route("/", anthropic);

// Health check
app.get("/health", (c) => c.json({ status: "ok", tokenManager: isTokenManagerActive() }));

// Token management — manual refresh + sync
app.post("/token/refresh", async (c) => {
  const result = await refreshToken();
  return c.json(result, result.ok ? 200 : 500);
});

app.get("/token/current", (c) => {
  const state = getTokenState();
  if (!state) return c.json({ error: "Token manager not active" }, 404);
  return c.json(state);
});

app.get("/", (c) =>
  c.json({
    name: "claude-code-router",
    version: "1.0.0",
    endpoints: {
      openai: "POST /v1/chat/completions",
      anthropic: "POST /v1/messages",
      models: "GET /v1/models",
      health: "GET /health",
      tokenSync: "GET /token/current",
    },
  })
);

// Init token manager (only activates if CLAUDE_OAUTH_REFRESH_TOKEN is set)
initTokenManager();

// Start server
console.log(`claude-code-router listening on ${config.host}:${config.port}`);
serve({ fetch: app.fetch, hostname: config.host, port: config.port });
