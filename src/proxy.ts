/**
 * Proxy requests to the Anthropic Messages API.
 * Injects auth token from CLAUDE_CODE_OAUTH_TOKEN env var or helper script.
 */
import { execSync } from "node:child_process";

const ANTHROPIC_API_URL = "https://api.anthropic.com";

let cachedToken: string | null = null;

export function getToken(): string {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }

  if (!cachedToken) {
    try {
      cachedToken = execSync("bash scripts/get-oauth-token.sh", {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
    } catch {
      throw new Error("No auth token available — set CLAUDE_CODE_OAUTH_TOKEN or configure scripts/get-oauth-token.sh");
    }
  }

  return cachedToken;
}

/** Clear cached token (e.g. on 401) so next call re-fetches */
export function clearTokenCache() {
  cachedToken = null;
}

/**
 * Forward a request to the Anthropic API.
 */
export async function proxyToAnthropic(
  path: string,
  method: string,
  headers: Record<string, string>,
  body?: string
): Promise<Response> {
  const token = getToken();
  const url = `${ANTHROPIC_API_URL}${path}`;

  const isOAuth = token.startsWith("sk-ant-oat");
  const proxyHeaders: Record<string, string> = {
    "content-type": headers["content-type"] || "application/json",
    "anthropic-version": headers["anthropic-version"] || "2023-06-01",
  };
  if (isOAuth) {
    proxyHeaders["authorization"] = `Bearer ${token}`;
  } else {
    proxyHeaders["x-api-key"] = token;
  }

  // Forward anthropic-specific headers
  for (const [key, value] of Object.entries(headers)) {
    if (key.startsWith("anthropic-") && key !== "anthropic-version") {
      proxyHeaders[key] = value;
    }
  }

  return fetch(url, {
    method,
    headers: proxyHeaders,
    body: method !== "GET" ? body : undefined,
  });
}
