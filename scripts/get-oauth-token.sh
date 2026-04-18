#!/bin/bash
# Resolve Claude auth token: env var > keychain (macOS)
if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
  echo "$CLAUDE_CODE_OAUTH_TOKEN"
elif command -v security &>/dev/null; then
  security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null \
    | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['claudeAiOauth']['accessToken'])"
else
  echo "ERROR: No CLAUDE_CODE_OAUTH_TOKEN or keychain available" >&2
  exit 1
fi
