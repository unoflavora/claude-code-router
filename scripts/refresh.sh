#!/bin/bash
# Refresh token on the router, then sync to local keychain.
# Usage: ./scripts/refresh.sh [router-url]

set -e
ROUTER_URL="${1:-http://10.1.200.218:4141}"

echo "1. Refreshing token on router..."
RESULT=$(curl -sf -X POST "${ROUTER_URL}/token/refresh")
OK=$(echo "$RESULT" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('ok', False))")
if [ "$OK" != "True" ]; then
  echo "Refresh failed: $RESULT"
  exit 1
fi
echo "   Done."

echo "2. Fetching new token..."
TOKEN_DATA=$(curl -sf "${ROUTER_URL}/token/current")
NEW_TOKEN=$(echo "$TOKEN_DATA" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['accessToken'])")
EXPIRES_AT=$(echo "$TOKEN_DATA" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['expiresAt'])")
echo "   Expires at: $(python3 -c "import datetime; print(datetime.datetime.fromtimestamp($EXPIRES_AT/1000))")"

echo "3. Updating keychain..."
CURRENT=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null)
UPDATED=$(echo "$CURRENT" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
d['claudeAiOauth']['accessToken'] = '${NEW_TOKEN}'
d['claudeAiOauth']['expiresAt'] = ${EXPIRES_AT}
print(json.dumps(d))
")
security delete-generic-password -s "Claude Code-credentials" >/dev/null 2>&1
security add-generic-password -s "Claude Code-credentials" -a "Claude Code" -w "$UPDATED"
echo "   Keychain updated."

echo ""
echo "Done. Your local session and router are both using the new token."
