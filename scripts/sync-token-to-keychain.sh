#!/bin/bash
# Fetch the latest token from the router and update the local macOS keychain.
# Run this as a cron/launchd job to keep your local session in sync after refresh.
#
# Usage: ./scripts/sync-token-to-keychain.sh [router-url]

ROUTER_URL="${1:-http://10.1.200.218:4141}"

TOKEN_DATA=$(curl -sf "${ROUTER_URL}/token/current" 2>/dev/null)
if [ -z "$TOKEN_DATA" ]; then
  echo "Token manager not active or router unreachable"
  exit 1
fi

NEW_TOKEN=$(echo "$TOKEN_DATA" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['accessToken'])")
if [ -z "$NEW_TOKEN" ]; then
  echo "Failed to parse token"
  exit 1
fi

# Read current keychain data, update the access token, write back
CURRENT=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null)
if [ -z "$CURRENT" ]; then
  echo "No keychain entry found"
  exit 1
fi

UPDATED=$(echo "$CURRENT" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
d['claudeAiOauth']['accessToken'] = '$NEW_TOKEN'
print(json.dumps(d))
")

# Update keychain
security delete-generic-password -s "Claude Code-credentials" 2>/dev/null
security add-generic-password -s "Claude Code-credentials" -a "Claude Code" -w "$UPDATED"

echo "Keychain updated with new token"
