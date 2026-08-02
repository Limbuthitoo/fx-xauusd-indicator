#!/usr/bin/env bash
set -euo pipefail

OUTPUT_PATH="${1:-nginx/cloudflare-real-ip.conf}"
TMP_PATH="$(mktemp)"

{
  echo "# Cloudflare origin real-IP restoration."
  echo "# Source: https://www.cloudflare.com/ips/"
  echo "# Generated at: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo
  curl -fsSL https://www.cloudflare.com/ips-v4 | sed 's/^/set_real_ip_from /; s/$/;/'
  echo
  curl -fsSL https://www.cloudflare.com/ips-v6 | sed 's/^/set_real_ip_from /; s/$/;/'
  echo
  echo "real_ip_header CF-Connecting-IP;"
} > "$TMP_PATH"

mv "$TMP_PATH" "$OUTPUT_PATH"
echo "Updated $OUTPUT_PATH"
