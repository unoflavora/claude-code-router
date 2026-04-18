import type { Context, Next } from "hono";
import { config } from "./config.js";

/**
 * Bearer token auth middleware.
 * If API_KEYS is not set, all requests are allowed.
 */
export async function authMiddleware(c: Context, next: Next) {
  if (config.apiKeys.length === 0) {
    return next();
  }

  const authHeader = c.req.header("Authorization") || "";
  const apiKey = c.req.header("x-api-key") || "";

  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : apiKey;

  if (!token || !config.apiKeys.includes(token)) {
    return c.json(
      { error: { message: "Invalid API key", type: "authentication_error", code: 401 } },
      401
    );
  }

  return next();
}
