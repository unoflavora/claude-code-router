/**
 * OAuth token manager — manual refresh only.
 *
 * Requires CLAUDE_OAUTH_REFRESH_TOKEN to be set.
 * Trigger refresh via POST /token/refresh, then sync locally.
 */

const TOKEN_REFRESH_URL = "https://console.anthropic.com/v1/oauth/token";

interface TokenState {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

let tokenState: TokenState | null = null;

export function isTokenManagerActive(): boolean {
  return tokenState !== null;
}

export function initTokenManager(): boolean {
  const refreshToken = process.env.CLAUDE_OAUTH_REFRESH_TOKEN;
  if (!refreshToken) return false;

  tokenState = {
    accessToken: process.env.CLAUDE_CODE_OAUTH_TOKEN || "",
    refreshToken,
    expiresAt: parseInt(process.env.CLAUDE_OAUTH_EXPIRES_AT || "0", 10),
  };

  console.log("[token] Token manager ready (manual refresh)");
  return true;
}

export async function refreshToken(): Promise<{ ok: boolean; error?: string }> {
  if (!tokenState) return { ok: false, error: "Token manager not initialized" };

  try {
    const res = await fetch(TOKEN_REFRESH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokenState.refreshToken,
        client_id: "claude-code",
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return { ok: false, error: `${res.status}: ${errText}` };
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    tokenState.accessToken = data.access_token;
    if (data.refresh_token) tokenState.refreshToken = data.refresh_token;
    if (data.expires_in) tokenState.expiresAt = Date.now() + data.expires_in * 1000;

    process.env.CLAUDE_CODE_OAUTH_TOKEN = tokenState.accessToken;

    console.log("[token] Token refreshed successfully");
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export function getTokenState(): { accessToken: string; expiresAt: number } | null {
  if (!tokenState) return null;
  return { accessToken: tokenState.accessToken, expiresAt: tokenState.expiresAt };
}
